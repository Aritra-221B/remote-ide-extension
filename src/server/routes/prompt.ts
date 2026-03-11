import { Router } from 'express';
import * as vscode from 'vscode';
import { CDPClient } from '../cdp';

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

        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
            res.json({ success: true, method: 'vscode-command' });
        } catch {
            res.json({ success: false, error: 'Failed to send prompt' });
        }
    });

    return router;
}
