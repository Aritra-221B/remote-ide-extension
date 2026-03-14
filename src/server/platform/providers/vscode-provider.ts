/**
 * VS Code + Copilot Platform Provider
 *
 * Handles chat storage paths, Copilot JSONL parsing, model costs,
 * and command IDs specific to VS Code with GitHub Copilot.
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

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

export class VSCodeProvider implements IDEPlatformProvider {
    readonly key: IDEPlatformKey = 'vscode';
    readonly displayName = 'VS Code';
    readonly color = '#007ACC';
    readonly chatFileExtension = '.jsonl';

    getChatStoragePaths(): string[] {
        return [
            // Windows
            path.join(appData, 'Code', 'User', 'workspaceStorage'),
            // macOS
            path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
            // Linux
            path.join(home, '.config', 'Code', 'User', 'workspaceStorage'),
        ];
    }

    parseChatFile(content: string): ParsedChatRequest[] {
        return parseCopilotJsonl(content);
    }

    getModelCosts(): Record<string, ModelCost> {
        return {
            'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
            'claude-3-5-sonnet':        { input: 0.003, output: 0.015 },
            'claude-3-7-sonnet':        { input: 0.003, output: 0.015 },
            'gpt-4o':                   { input: 0.005, output: 0.015 },
            'gpt-4o-mini':              { input: 0.00015, output: 0.0006 },
            'gpt-4.1':                  { input: 0.002, output: 0.008 },
            'gemini-2.0-flash':         { input: 0.00010, output: 0.00040 },
        };
    }

    getModelConfigKeys(): string[] {
        return ['github.copilot.chat.model'];
    }

    getLMVendor(): string | null {
        return 'copilot';
    }

    getChatCommands(): ChatCommands {
        return {
            openChat: 'workbench.action.chat.open',
            acceptCommands: [
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
            chatContainer: '.chat-widget, [class*="chat"]',
            chatInput: 'textarea[class*="chat"], .chat-input textarea',
            acceptLabels: ['Keep', 'Accept'],
            rejectLabels: ['Undo', 'Discard', 'Reject'],
        };
    }
}

// ─── Copilot JSONL Parser ─────────────────────────────────────────────────────

/**
 * Parses the Copilot-style JSONL update log (kind/k/v format) used by
 * both VS Code Copilot and Cursor (which uses the same internal format).
 */
export function parseCopilotJsonl(content: string): ParsedChatRequest[] {
    const lines = content.split('\n').filter(l => l.trim());

    const requests: Map<number, {
        prompt: string;
        response: string;
        timestamp: number;
        completed: boolean;
        tokens?: { prompt?: number; output?: number };
        model?: string;
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
                    model: req?.model || '',
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
                const text = v.map((item: any) =>
                    typeof item === 'string' ? item : (item?.value || '')
                ).join('');
                if (text) { entry.response = text; }
            }

            if (field === 'modelState' && v?.value === 1) {
                entry.completed = true;
            }

            if (field === 'result') {
                entry.completed = true; // Fallback: tokens denote completion
                if (v?.metadata) {
                    entry.tokens = {
                        prompt: v.metadata.promptTokens,
                        output: v.metadata.outputTokens,
                    };
                    if (v.metadata.modelId) {
                        entry.model = v.metadata.modelId;
                    }
                }
            }

            if (field === 'model' && typeof v === 'string') {
                entry.model = v;
            }

            if (field === 'message' && v?.text) {
                entry.prompt = v.text;
            }
        }
    }

    // Convert to flat list
    const sorted = [...requests.entries()].sort((a, b) => a[0] - b[0]);
    return sorted.map(([, req]) => ({
        prompt: req.prompt,
        response: req.response,
        timestamp: req.timestamp,
        completed: req.completed,
        tokens: req.tokens,
        model: req.model,
    }));
}
