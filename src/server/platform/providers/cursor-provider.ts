/**
 * Cursor IDE Platform Provider
 *
 * Cursor is a VS Code fork that uses its own AI models (Claude, GPT, etc.)
 * but stores chat sessions in a similar Copilot-compatible JSONL format
 * inside its own workspaceStorage directory.
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

export class CursorProvider implements IDEPlatformProvider {
    readonly key: IDEPlatformKey = 'cursor';
    readonly displayName = 'Cursor';
    readonly color = '#6B4FBB';
    readonly chatFileExtension = '.jsonl';

    getChatStoragePaths(): string[] {
        return [
            // Windows
            path.join(appData, 'Cursor', 'User', 'workspaceStorage'),
            // macOS
            path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
            // Linux
            path.join(home, '.config', 'Cursor', 'User', 'workspaceStorage'),
        ];
    }

    /**
     * Cursor uses the same Copilot-compatible JSONL update log format.
     * If Cursor ever diverges, override this method with a custom parser.
     */
    parseChatFile(content: string): ParsedChatRequest[] {
        return parseCopilotJsonl(content);
    }

    getModelCosts(): Record<string, ModelCost> {
        return {
            // Cursor-specific models
            'cursor-small':             { input: 0.0001, output: 0.0004 },
            'cursor-fast':              { input: 0.0005, output: 0.002 },
            // Cursor also supports standard models
            'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
            'claude-3-5-sonnet':        { input: 0.003, output: 0.015 },
            'claude-3-7-sonnet':        { input: 0.003, output: 0.015 },
            'claude-3.5-sonnet':        { input: 0.003, output: 0.015 },
            'gpt-4o':                   { input: 0.005, output: 0.015 },
            'gpt-4o-mini':              { input: 0.00015, output: 0.0006 },
            'gpt-4':                    { input: 0.03, output: 0.06 },
            'gpt-4.1':                  { input: 0.002, output: 0.008 },
            'gemini-2.0-flash':         { input: 0.00010, output: 0.00040 },
        };
    }

    getModelConfigKeys(): string[] {
        return [
            'cursor.model',
            'cursor.chat.model',
            'github.copilot.chat.model',  // Cursor also supports Copilot
        ];
    }

    getLMVendor(): string | null {
        // Cursor may support copilot vendor, try it
        return 'copilot';
    }

    getChatCommands(): ChatCommands {
        return {
            openChat: 'workbench.action.chat.open',
            acceptCommands: [
                // Cursor-specific commands
                'cursor.acceptEdit',
                'cursor.chat.acceptChanges',
                // Standard VS Code Copilot commands (Cursor supports these too)
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
                'cursor.rejectEdit',
                'cursor.chat.rejectChanges',
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
            chatContainer: '.chat-widget, [class*="chat"], [class*="aichat"]',
            chatInput: 'textarea[class*="chat"], .chat-input textarea, textarea[class*="aichat"]',
            acceptLabels: ['Accept', 'Keep', 'Apply'],
            rejectLabels: ['Reject', 'Undo', 'Discard'],
        };
    }
}
