import { Router } from 'express';
import { CDPClient } from '../cdp';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const cdp = new CDPClient();
let cdpAvailable = false;

async function tryConnectCDP(): Promise<void> {
    if (cdpAvailable) { return; }
    try { cdpAvailable = await cdp.connect(); } catch { cdpAvailable = false; }
}

function logDebug(msg: string) {
    try {
        fs.appendFileSync('i:\\remote-ide-extension\\extension_run_debug.log', `[${new Date().toISOString()}] [Screenshot] ${msg}\n`);
    } catch {}
}

/**
 * Capture the full (virtual) screen via PowerShell + System.Drawing.
 * More reliable on Windows than screenshot-desktop, which depends on
 * compiling a .NET helper exe with csc.exe at runtime.
 */
function powershellScreenshot(): Promise<string | null> {
    return new Promise((resolve) => {
        const tmpFile = path.join(os.tmpdir(), `remote-ide-shot-${Date.now()}.jpg`);
        const script = [
            'Add-Type -AssemblyName System.Windows.Forms;',
            'Add-Type -AssemblyName System.Drawing;',
            '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
            '$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height);',
            '$g = [System.Drawing.Graphics]::FromImage($bmp);',
            '$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size);',
            `$bmp.Save('${tmpFile}', [System.Drawing.Imaging.ImageFormat]::Jpeg);`,
            '$g.Dispose(); $bmp.Dispose();',
        ].join(' ');

        cp.execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
            { windowsHide: true, timeout: 15000 },
            (err) => {
                if (err) {
                    logDebug(`powershellScreenshot failed: ${err.message}`);
                    resolve(null);
                    return;
                }
                try {
                    const buf = fs.readFileSync(tmpFile);
                    fs.unlink(tmpFile, () => {});
                    resolve(buf.toString('base64'));
                } catch (readErr: any) {
                    logDebug(`powershellScreenshot read failed: ${readErr.message}`);
                    resolve(null);
                }
            }
        );
    });
}

/** Capture screen using screenshot-desktop (cross-platform fallback) */
async function nativeScreenshot(): Promise<string | null> {
    try {
        // screenshot-desktop is a JS module, require at runtime
        const screenshot = require('screenshot-desktop');
        const imgBuffer: Buffer = await screenshot({ format: 'jpg' });
        return imgBuffer.toString('base64');
    } catch (err: any) {
        logDebug(`nativeScreenshot failed: ${err.message}\nStack: ${err.stack}`);
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

        // Windows: PowerShell capture is the most reliable native path
        let data: string | null = null;
        if (process.platform === 'win32') {
            data = await powershellScreenshot();
        }

        // Fallback: screenshot-desktop
        if (!data) {
            data = await nativeScreenshot();
        }

        if (!data) {
            res.status(500).json({ success: false, error: 'Failed to capture screenshot' });
            return;
        }
        res.json({ success: true, image: `data:image/jpeg;base64,${data}` });
    });

    router.post('/send-keys', (req, res) => {
        const { keys, raw, appendEnter } = req.body;
        if (!keys) {
            return res.status(400).json({ success: false, error: 'Keys required' });
        }

        let keysToSend = keys;
        if (raw) {
            keysToSend = escapeSendKeys(keys);
        }
        if (appendEnter) {
            keysToSend += '{ENTER}';
        }

        const escapedKeys = keysToSend.replace(/'/g, "''");
        const cmd = `powershell -Command "[void] [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.SendKeys]::SendWait('${escapedKeys}')"`;
        cp.exec(cmd, (err) => {
            if (err) {
                res.json({ success: false, error: err.message });
            } else {
                res.json({ success: true });
            }
        });
    });

    return router;
}

function escapeSendKeys(text: string): string {
    let escaped = '';
    for (const char of text) {
        if ('+^%~()[]{}'.indexOf(char) !== -1) {
            escaped += `{${char}}`;
        } else {
            escaped += char;
        }
    }
    return escaped;
}

export function cleanupScreenshots() {
    const tmpDir = os.tmpdir();
    try {
        const files = fs.readdirSync(tmpDir);
        for (const f of files) {
            if (f.startsWith('remote-ide-shot-')) {
                try {
                    fs.unlinkSync(path.join(tmpDir, f));
                } catch { /* ignore error unlinking file */ }
            }
        }
    } catch { /* ignore directory read errors */ }
}
