import { Router } from 'express';
import * as vscode from 'vscode';
import { CDPClient } from '../cdp';
import { sseManager } from '../sse';
import { addActivity, getRecentActivity } from '../activity';
import { getChatMessages } from '../chat-reader';

const cdp = new CDPClient();
let cdpAvailable = false;

async function tryConnectCDP() {
    if (cdpAvailable) { return true; }
    cdpAvailable = await cdp.connect();
    return cdpAvailable;
}

export function chatRoutes(context: vscode.ExtensionContext) {
    const router = Router();

    // Try CDP connection once at startup (non-blocking)
    tryConnectCDP().catch(() => {});

    // Poll chat HTML and broadcast via SSE (only if CDP connected)
    let lastChatHTML = '';
    setInterval(async () => {
        if (!cdpAvailable) { return; }
        try {
            const html = await cdp.getChatHTML();
            if (html !== lastChatHTML) {
                lastChatHTML = html;
                sseManager.broadcast('chat-update', { html });
            }
        } catch { /* ignore polling errors */ }
    }, 2000);

    router.get('/html', async (req, res) => {
        await tryConnectCDP();
        if (!cdpAvailable) {
            res.json({
                success: true,
                html: '<p style="color:#8b949e;text-align:center;padding:20px;">Chat view requires launching VS Code with:<br><code style="background:#2d2d2d;padding:4px 8px;border-radius:4px;">code --remote-debugging-port=9222</code><br><br>Prompts and Accept/Reject still work without it.</p>',
                cdpConnected: false
            });
            return;
        }
        const html = await cdp.getChatHTML();
        res.json({ success: true, html, cdpConnected: true });
    });

    router.post('/send', async (req, res) => {
        const { prompt } = req.body;
        if (!prompt || typeof prompt !== 'string') {
            res.status(400).json({ success: false, error: 'Missing prompt' });
            return;
        }

        // Try CDP first, fallback to VS Code command
        if (cdpAvailable) {
            const success = await cdp.sendPrompt(prompt);
            addActivity('prompt', `Prompt: ${prompt.substring(0, 100)}`);
            res.json({ success });
            return;
        }

        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
            addActivity('prompt', `Prompt: ${prompt.substring(0, 100)}`);
            res.json({ success: true, method: 'vscode-command' });
        } catch {
            res.json({ success: false, error: 'Failed to send prompt' });
        }
    });

    router.post('/action', async (req, res) => {
        const { action } = req.body;
        if (action !== 'accept' && action !== 'reject') {
            res.status(400).json({ success: false, error: 'Action must be "accept" or "reject"' });
            return;
        }

        // Try CDP first
        if (cdpAvailable) {
            const success = await cdp.clickAction(action);
            if (success) {
                addActivity('action', `${action === 'accept' ? '\u2705 Accepted' : '\u274c Rejected'} changes`);
                res.json({ success: true, method: 'cdp' });
                return;
            }
        }

        // Fallback: VS Code commands
        try {
            if (action === 'accept') {
                await tryCommand(
                    'chatEditor.action.accept',
                    'inlineChat.acceptChanges',
                    'editor.action.inlineSuggest.commit'
                );
            } else {
                await tryCommand(
                    'chatEditor.action.reject',
                    'inlineChat.discard',
                    'editor.action.inlineSuggest.hide'
                );
            }
            res.json({ success: true, method: 'vscode-command' });
            addActivity('action', `${action === 'accept' ? '✅ Accepted' : '❌ Rejected'} changes`);
        } catch (err: any) {
            res.json({ success: false, error: err.message });
        }
    });

    router.get('/status', (req, res) => {
        res.json({ success: true, cdpConnected: cdpAvailable });
    });

    router.get('/activity', (req, res) => {
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        res.json({ success: true, entries: getRecentActivity(limit) });
    });

    router.get('/messages', (req, res) => {
        const messages = getChatMessages();
        res.json({ success: true, messages });
    });

    return router;
}

async function tryCommand(...commands: string[]) {
    for (const cmd of commands) {
        try {
            await vscode.commands.executeCommand(cmd);
            return;
        } catch { /* try next */ }
    }
}
