import { Router } from 'express';
import { CDPClient } from '../cdp';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const cdp = new CDPClient();
let cdpAvailable = false;

async function tryConnectCDP(): Promise<void> {
    if (cdpAvailable) { return; }
    try { cdpAvailable = await cdp.connect(); } catch { cdpAvailable = false; }
}

/** Capture screen using screenshot-desktop (native Windows capture) */
async function nativeScreenshot(): Promise<string | null> {
    try {
        // screenshot-desktop is a JS module, require at runtime
        const screenshot = require('screenshot-desktop');
        const imgBuffer: Buffer = await screenshot({ format: 'jpg' });
        return imgBuffer.toString('base64');
    } catch {
        return null;
    }
}

export function screenshotRoutes() {
    const router = Router();

    tryConnectCDP().catch(() => {});

    router.get('/capture', async (req, res) => {
        // Try CDP first (captures VS Code window only)
        await tryConnectCDP();
        if (cdpAvailable) {
            const data = await cdp.takeScreenshot();
            if (data) {
                res.json({ success: true, image: `data:image/jpeg;base64,${data}` });
                return;
            }
        }

        // Fallback: native screen capture
        const data = await nativeScreenshot();
        if (!data) {
            res.status(500).json({ success: false, error: 'Failed to capture screenshot' });
            return;
        }
        res.json({ success: true, image: `data:image/jpeg;base64,${data}` });
    });

    return router;
}
