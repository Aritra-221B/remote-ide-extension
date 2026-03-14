import { Router } from 'express';
import * as vscode from 'vscode';
import { CDPClient } from '../cdp';
import { getPlatform } from '../platform';

const cdp = new CDPClient();
let cdpAvailable = false;

async function tryConnectCDP(): Promise<void> {
    if (cdpAvailable) { return; }
    try { cdpAvailable = await cdp.connect(); } catch { cdpAvailable = false; }
}

export function promptRoutes() {
    const router = Router();

    tryConnectCDP().catch(() => {});

    router.post('/send', async (req, res) => {
        const { prompt } = req.body;
        if (!prompt || typeof prompt !== 'string') {
            res.status(400).json({ success: false, error: 'Missing prompt' });
            return;
        }

        await tryConnectCDP();

        if (cdpAvailable) {
            const success = await cdp.sendPrompt(prompt);
            res.json({ success, method: 'cdp' });
            return;
        }

        // Use the platform-specific chat open command
        const platform = getPlatform();
        const chatCommands = platform.getChatCommands();

        try {
            await vscode.commands.executeCommand(chatCommands.openChat, { query: prompt });
            res.json({ success: true, method: 'vscode-command', ide: platform.key });
        } catch {
            res.json({ success: false, error: 'Failed to send prompt' });
        }
    });

    return router;
}
