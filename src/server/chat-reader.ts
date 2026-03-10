import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { sseManager } from './sse';

export interface ChatMessage {
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
    requestIndex: number;
    completed?: boolean;
    tokens?: { prompt?: number; output?: number };
}

let chatSessionsDir = '';
let activeSessionFile = '';
let lastFileSize = 0;
let cachedMessages: ChatMessage[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function getChatMessages(): ChatMessage[] {
    return cachedMessages;
}

export function initChatReader(context: vscode.ExtensionContext): void {
    // Find chatSessions directory — check multiple locations
    const candidates: string[] = [];

    // 1. From extension storage URI — go up to workspace storage root
    if (context.storageUri) {
        const wsRoot = path.dirname(context.storageUri.fsPath);
        candidates.push(path.join(wsRoot, 'chatSessions'));
    }

    // 2. Search all workspaceStorage directories for chatSessions
    const appData = process.env.APPDATA || '';
    if (appData) {
        const wsStorageRoot = path.join(appData, 'Code', 'User', 'workspaceStorage');
        try {
            if (fs.existsSync(wsStorageRoot)) {
                for (const d of fs.readdirSync(wsStorageRoot)) {
                    const chatDir = path.join(wsStorageRoot, d, 'chatSessions');
                    if (!candidates.includes(chatDir)) {
                        candidates.push(chatDir);
                    }
                }
            }
        } catch { /* ignore */ }
    }

    // Find a chatSessions directory with JSONL files
    for (const dir of candidates) {
        try {
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
                if (files.length > 0) {
                    chatSessionsDir = dir;
                    break;
                }
            }
        } catch { /* ignore */ }
    }

    if (!chatSessionsDir) {
        console.log('[ChatReader] No chatSessions directory found');
        return;
    }

    console.log(`[ChatReader] Using: ${chatSessionsDir}`);
    selectActiveSession();

    // Poll every 3 seconds for changes (more reliable than fs.watch across platforms)
    pollInterval = setInterval(() => {
        selectActiveSession();
        checkForUpdates();
    }, 3000);
}

/** Pick the most recently modified JSONL file as the active session */
function selectActiveSession(): void {
    try {
        const files = fs.readdirSync(chatSessionsDir)
            .filter(f => f.endsWith('.jsonl'))
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
            console.log(`[ChatReader] Active session: ${path.basename(newest)}`);
            checkForUpdates();
        }
    } catch { /* ignore */ }
}

/** Read new content from the active JSONL and parse incrementally */
function checkForUpdates(): void {
    if (!activeSessionFile) { return; }

    try {
        const stat = fs.statSync(activeSessionFile);
        if (stat.size === lastFileSize) { return; }

        // Read the full file and re-parse (JSONL is an update log, order matters)
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

/** Parse JSONL update log into a list of ChatMessages */
function parseSession(content: string): ChatMessage[] {
    const lines = content.split('\n').filter(l => l.trim());

    // Track requests by index
    const requests: Map<number, {
        prompt: string;
        response: string;
        timestamp: number;
        completed: boolean;
        tokens?: { prompt?: number; output?: number };
    }> = new Map();

    let nextIndex = 0;

    for (const line of lines) {
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }

        const kind: number = obj.kind;
        const k: any[] = obj.k || [];
        const v: any = obj.v;

        // kind=2, k=['requests'] — new request appended
        if (kind === 2 && k.length === 1 && k[0] === 'requests' && Array.isArray(v)) {
            for (const req of v) {
                const text = req?.message?.text || '';
                const ts = req?.timestamp || Date.now();
                requests.set(nextIndex, {
                    prompt: text,
                    response: '',
                    timestamp: ts,
                    completed: false,
                });
                nextIndex++;
            }
        }

        // Fields on a specific request: k=['requests', N, fieldName]
        if (k[0] === 'requests' && typeof k[1] === 'number' && k.length === 3) {
            const idx = k[1];
            const field = k[2];

            if (!requests.has(idx)) {
                requests.set(idx, { prompt: '', response: '', timestamp: 0, completed: false });
            }
            const entry = requests.get(idx)!;

            if (field === 'response' && Array.isArray(v)) {
                // Response content (latest snapshot replaces previous)
                const text = v.map((item: any) =>
                    typeof item === 'string' ? item : (item?.value || '')
                ).join('');
                if (text) { entry.response = text; }
            }

            if (field === 'modelState' && v?.value === 1) {
                entry.completed = true;
            }

            if (field === 'result' && v?.metadata) {
                entry.tokens = {
                    prompt: v.metadata.promptTokens,
                    output: v.metadata.outputTokens,
                };
            }

            if (field === 'message' && v?.text) {
                entry.prompt = v.text;
            }
        }
    }

    // Convert to flat message list
    const messages: ChatMessage[] = [];
    const sorted = [...requests.entries()].sort((a, b) => a[0] - b[0]);

    for (const [idx, req] of sorted) {
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
            });
        }
    }

    return messages;
}

export function disposeChatReader(): void {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}
