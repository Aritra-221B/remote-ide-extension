/**
 * Antigravity IDE Platform Provider
 *
 * Antigravity is Google DeepMind's VS Code-based IDE that uses Gemini models.
 * It stores conversation data in its own workspace storage directory.
 *
 * This provider handles Antigravity-specific storage paths, Gemini model costs,
 * and Antigravity-specific chat data format parsing.
 */

import * as path from 'path';
import * as os from 'os';
import {
    IDEPlatformProvider,
    IDEPlatformKey,
    ParsedChatRequest,
    ModelCost,
    ChatCommands,
    CDPSelectors,
} from '../types';
import { parseCopilotJsonl } from './vscode-provider';

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

export class AntigravityProvider implements IDEPlatformProvider {
    readonly key: IDEPlatformKey = 'antigravity';
    readonly displayName = 'Antigravity';
    readonly color = '#00BFA5';
    readonly chatFileExtension = '.jsonl';

    getChatStoragePaths(): string[] {
        return [
            // Windows — Roaming
            path.join(appData, 'Antigravity', 'User', 'workspaceStorage'),
            path.join(appData, 'Antigravity', 'workspaceStorage'),
            // Windows — Local
            path.join(localAppData, 'Antigravity', 'User', 'workspaceStorage'),
            // macOS
            path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'workspaceStorage'),
            // Linux
            path.join(home, '.config', 'Antigravity', 'User', 'workspaceStorage'),
            path.join(home, '.antigravity', 'workspaceStorage'),
        ];
    }

    /**
     * Antigravity may use a Copilot-compatible JSONL format or its own
     * Gemini-specific format. We attempt Copilot JSONL first, then fall
     * back to Antigravity-specific parsing.
     */
    parseChatFile(content: string): ParsedChatRequest[] {
        // Try Copilot-style parsing first (works if Antigravity uses the same format)
        const copilotResult = parseCopilotJsonl(content);
        if (copilotResult.length > 0) {
            return copilotResult;
        }

        // Fall back to Antigravity-specific format parsing
        return parseAntigravityChat(content);
    }

    getModelCosts(): Record<string, ModelCost> {
        return {
            // Gemini models (primary for Antigravity)
            'gemini-2.5-pro':           { input: 0.00125, output: 0.01 },
            'gemini-2.0-flash':         { input: 0.00010, output: 0.00040 },
            'gemini-2.0-flash-lite':    { input: 0.000075, output: 0.0003 },
            'gemini-1.5-pro':           { input: 0.00125, output: 0.005 },
            'gemini-1.5-flash':         { input: 0.000075, output: 0.0003 },
            // Antigravity may also support Claude/GPT via API
            'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
            'claude-3-5-sonnet':        { input: 0.003, output: 0.015 },
            'claude-3-7-sonnet':        { input: 0.003, output: 0.015 },
            'gpt-4o':                   { input: 0.005, output: 0.015 },
            'gpt-4o-mini':              { input: 0.00015, output: 0.0006 },
        };
    }

    getModelConfigKeys(): string[] {
        return [
            'antigravity.model',
            'antigravity.chat.model',
            'google.ai.model',
        ];
    }

    getLMVendor(): string | null {
        // Antigravity uses Google's language model API
        return 'google';
    }

    getChatCommands(): ChatCommands {
        return {
            openChat: 'workbench.action.chat.open',
            acceptCommands: [
                // Antigravity-specific commands
                'antigravity.acceptEdit',
                'antigravity.chat.acceptChanges',
                // Standard VS Code commands (compatible)
                'workbench.action.chat.acceptEditRequest',
                'chatEditor.action.accept',
                'chat.acceptChanges',
                'chat.keepEdit',
                'inlineChat.acceptChanges',
                'inlineChat.accept',
                'editor.action.inlineSuggest.commit',
                'notebook.cell.chat.acceptChanges',
            ],
            rejectCommands: [
                'antigravity.rejectEdit',
                'antigravity.chat.rejectChanges',
                'workbench.action.chat.rejectEditRequest',
                'chatEditor.action.reject',
                'chat.undoChanges',
                'chat.undoEdit',
                'inlineChat.discard',
                'inlineChat.close',
                'editor.action.inlineSuggest.hide',
                'notebook.cell.chat.discard',
            ],
        };
    }

    getCDPSelectors(): CDPSelectors {
        return {
            chatContainer: '.chat-widget, [class*="chat"], [class*="gemini"]',
            chatInput: 'textarea[class*="chat"], .chat-input textarea, textarea[class*="gemini"]',
            acceptLabels: ['Accept', 'Keep', 'Apply'],
            rejectLabels: ['Reject', 'Undo', 'Discard'],
        };
    }
}

// ─── Antigravity-specific Chat Parser ─────────────────────────────────────────

/**
 * Parses Antigravity's native chat data format.
 *
 * Antigravity may store conversations as JSON objects with `conversations`
 * arrays, or as line-delimited JSON with role/content pairs.  This parser
 * handles both common patterns.
 */
function parseAntigravityChat(content: string): ParsedChatRequest[] {
    const results: ParsedChatRequest[] = [];

    // Antigravity might use .json instead of .jsonl, attempt to parse the entire file first
    let objects: any[] = [];
    try {
        const fullObj = JSON.parse(content);
        if (Array.isArray(fullObj)) {
            objects = fullObj;
        } else if (fullObj.conversations) {
            objects = fullObj.conversations;
        } else {
            objects = [fullObj];
        }
    } catch {
        // Fall back to line-by-line JSON parsing (JSONL)
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines) {
            try { objects.push(JSON.parse(line)); } catch { continue; }
        }
    }

    let currentReq: ParsedChatRequest | null = null;

    for (const obj of objects) {
        if (!obj || typeof obj !== 'object') continue;

        const messages = obj.messages || obj.turns || (obj.role ? [obj] : []);
        for (const msg of messages) {
            if (!msg || typeof msg !== 'object') continue;

            const role = msg.role || '';
            const text = msg.content || msg.text || '';
            const ts = msg.timestamp || obj.timestamp || Date.now();
            const model = msg.model || obj.model || undefined;
            
            // Standardise token usage format
            const inputTokens = msg.usage?.prompt_tokens || msg.usage?.inputTokens;
            const outputTokens = msg.usage?.completion_tokens || msg.usage?.outputTokens;
            const tokens = (inputTokens !== undefined || outputTokens !== undefined) 
                ? { prompt: inputTokens, output: outputTokens } 
                : undefined;

            if (role === 'user') {
                if (currentReq) {
                    if (currentReq.response) {
                        results.push(currentReq);
                        currentReq = { prompt: text, response: '', timestamp: ts, completed: false };
                    } else {
                        // Consecutive user prompts: combine them
                        currentReq.prompt += '\n\n' + text;
                    }
                } else {
                    currentReq = { prompt: text, response: '', timestamp: ts, completed: false };
                }
            } else if (role === 'assistant' || role === 'model') {
                if (!currentReq) {
                    currentReq = { prompt: '', response: text, timestamp: ts, completed: true, model, tokens };
                } else {
                    currentReq.response += text;
                    currentReq.completed = true;
                    if (model) currentReq.model = model;
                    if (tokens) currentReq.tokens = tokens;
                }
            }
        }
    }
    
    if (currentReq) {
        results.push(currentReq);
    }

    return results;
}
