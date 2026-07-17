import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { sseManager } from './sse';
import { getPlatform } from './platform';

function logDebug(msg: string) {
    try {
        fs.appendFileSync('i:\\remote-ide-extension\\extension_run_debug.log', `[${new Date().toISOString()}] [ChatReader] ${msg}\n`);
    } catch {}
}

export interface ChatMessage {
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
    requestIndex: number;
    completed?: boolean;
    tokens?: { prompt?: number; output?: number };
    model?: string;
}

export interface UsageSample {
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
}

let chatSessionsDir = '';
let activeSessionFile = '';
let lastFileSize = 0;
let cachedMessages: ChatMessage[] = [];
let cachedUsageSamples: UsageSample[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;
let fileWatcher: fs.FSWatcher | null = null;
let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function getChatMessages(): ChatMessage[] {
    return cachedMessages;
}

export function getChatUsageSamples(): UsageSample[] {
    return cachedUsageSamples;
}

/** Called externally (e.g. right after /chat/send) to check the JSONL immediately. */
export function triggerImmediateCheck(): void {
    selectActiveSession();
    checkForUpdates();
}

/** Attach fs.watch to the active session file for near-instant detection. */
function watchActiveFile(filepath: string): void {
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
    try {
        fileWatcher = fs.watch(filepath, { persistent: false }, () => {
            // Debounce: IDE may fire multiple rapid writes during streaming.
            if (watchDebounceTimer) { clearTimeout(watchDebounceTimer); }
            watchDebounceTimer = setTimeout(() => { checkForUpdates(); }, 80);
        });
    } catch { /* fs.watch not available on all platforms — poll covers it */ }
}

export function initChatReader(context: vscode.ExtensionContext): void {
    const platform = getPlatform();
    const fileExt = platform.chatFileExtension;

    // Build candidate directories — platform-specific + context-derived
    const candidates: string[] = [];

    // 1. From extension storage URI — go up to workspace storage root
    if (context.storageUri) {
        const wsRoot = path.dirname(context.storageUri.fsPath);
        candidates.push(path.join(wsRoot, 'chatSessions'));
    }

    // 2. Platform-specific chat storage paths
    for (const storagePath of platform.getChatStoragePaths()) {
        try {
            if (fs.existsSync(storagePath)) {
                for (const d of fs.readdirSync(storagePath)) {
                    const chatDir = path.join(storagePath, d, 'chatSessions');
                    if (!candidates.includes(chatDir)) {
                        candidates.push(chatDir);
                    }
                }
            }
        } catch { /* ignore */ }
    }

    // Find a chatSessions directory with matching files
    for (const dir of candidates) {
        try {
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir).filter(f => f.endsWith(fileExt));
                if (files.length > 0) {
                    chatSessionsDir = dir;
                    break;
                }
            }
        } catch { /* ignore */ }
    }


    if (!chatSessionsDir) {
        logDebug(`No chatSessions directory found for ${platform.displayName}`);
        return;
    }

    logDebug(`Using chat directory: ${chatSessionsDir} (${platform.displayName})`);
    selectActiveSession();

    // 800 ms safety-net poll — catches anything fs.watch misses
    pollInterval = setInterval(() => {
        selectActiveSession();
        checkForUpdates();
    }, 800);
}

/** Pick the most recently modified chat file as the active session */
function selectActiveSession(): void {
    const platform = getPlatform();
    const fileExt = platform.chatFileExtension;

    try {
        const files = fs.readdirSync(chatSessionsDir)
            .filter(f => f.endsWith(fileExt) || f.endsWith('.json'))
            .map(f => {
                const full = path.join(chatSessionsDir, f);
                const stat = fs.statSync(full);
                return { path: full, mtime: stat.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);

        if (files.length === 0) { return; }

        const newest = files[0].path;
        if (newest !== activeSessionFile) {
            // Session changed — full re-parse
            activeSessionFile = newest;
            lastFileSize = 0;
            cachedMessages = [];
            logDebug(`Active session changed to: ${path.basename(newest)}`);
            watchActiveFile(newest);
            checkForUpdates();
        }
    } catch { /* ignore */ }
}

/** Read new content from the active session file and parse via platform provider */
function checkForUpdates(): void {
    if (!activeSessionFile) { return; }

    try {
        const stat = fs.statSync(activeSessionFile);
        if (stat.size === lastFileSize) { return; }

        // Read the full file and re-parse via the platform provider
        const content = fs.readFileSync(activeSessionFile, 'utf-8');
        lastFileSize = stat.size;

        const prevCount = cachedMessages.length;
        cachedMessages = parseSession(content);

        // Broadcast new messages via SSE
        if (cachedMessages.length > prevCount) {
            const newMsgs = cachedMessages.slice(prevCount);
            for (const msg of newMsgs) {
                sseManager.broadcast('chat-message', msg);
            }
        } else if (cachedMessages.length > 0) {
            // Last message may have been updated (e.g., streaming response)
            const last = cachedMessages[cachedMessages.length - 1];
            sseManager.broadcast('chat-message-update', last);
        }
    } catch { /* ignore read errors */ }
}

/** Parse session file content using the platform provider's parser */
function parseSession(content: string): ChatMessage[] {
    const platform = getPlatform();
    const parsed = platform.parseChatFile(content);

    // Convert ParsedChatRequest[] to ChatMessage[] and build usage samples
    const messages: ChatMessage[] = [];
    const samples: UsageSample[] = [];

    parsed.forEach((req, idx) => {
        if (req.prompt) {
            messages.push({
                role: 'user',
                text: req.prompt,
                timestamp: req.timestamp,
                requestIndex: idx,
            });
        }
        if (req.response) {
            messages.push({
                role: 'assistant',
                text: req.response,
                timestamp: req.timestamp,
                requestIndex: idx,
                completed: req.completed,
                tokens: req.tokens,
                model: req.model,
            });
        }

        // Build usage samples from completed requests with token data
        if (req.completed && req.tokens?.prompt !== undefined && req.tokens?.output !== undefined) {
            samples.push({
                timestamp: req.timestamp,
                model: req.model || 'unknown',
                inputTokens: req.tokens.prompt ?? 0,
                outputTokens: req.tokens.output ?? 0,
            });
        }
    });

    cachedUsageSamples = samples;
    return messages;
}

export function disposeChatReader(): void {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
    if (watchDebounceTimer) { clearTimeout(watchDebounceTimer); watchDebounceTimer = null; }
}
