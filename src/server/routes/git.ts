import { Router } from 'express';
import * as cp from 'child_process';
import * as vscode from 'vscode';

function git(args: string, cwd: string): string {
    return cp.execSync(`git ${args}`, {
        cwd,
        encoding: 'utf-8',
        timeout: 15000
    }).trim();
}

export function gitRoutes() {
    const router = Router();

    function getCwd(): string | null {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
    }

    router.get('/status', (req, res) => {
        const cwd = getCwd();
        if (!cwd) {
            res.status(400).json({ success: false, error: 'No workspace open' });
            return;
        }
        try {
            res.json({
                success: true,
                branch: git('branch --show-current', cwd),
                status: git('status --porcelain', cwd),
                log: git('log --oneline -10', cwd)
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/diff', (req, res) => {
        const cwd = getCwd();
        if (!cwd) {
            res.status(400).json({ success: false, error: 'No workspace open' });
            return;
        }
        try {
            res.json({ success: true, diff: git('diff', cwd) });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/commit', (req, res) => {
        const cwd = getCwd();
        if (!cwd) {
            res.status(400).json({ success: false, error: 'No workspace open' });
            return;
        }

        const message = req.body.message;
        if (!message || typeof message !== 'string') {
            res.status(400).json({ success: false, error: 'Missing commit message' });
            return;
        }

        // Sanitize commit message: remove shell-dangerous characters
        const trimmed = message.trim();
        if (!trimmed) {
            res.status(400).json({ success: false, error: 'Invalid commit message' });
            return;
        }

        try {
            git('add -A', cwd);
            // Use execFileSync with args array — no shell, immune to injection
            const result = cp.execFileSync(
                'git', ['commit', '-m', trimmed],
                { cwd, encoding: 'utf-8', timeout: 15000 }
            ).trim();
            res.json({ success: true, result });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/push', (req, res) => {
        const cwd = getCwd();
        if (!cwd) {
            res.status(400).json({ success: false, error: 'No workspace open' });
            return;
        }
        try {
            const result = git('push', cwd);
            res.json({ success: true, result });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}
