import { Router } from 'express';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import { sseManager } from '../sse';
import { addActivity } from '../activity';

/** Rolling buffer of terminal output lines (capped at 500 lines) */
const outputLines: string[] = [];
const MAX_LINES = 500;

function appendOutput(text: string) {
    const lines = text.split('\n');
    outputLines.push(...lines);
    while (outputLines.length > MAX_LINES) { outputLines.shift(); }
    sseManager.broadcast('terminal-output', { data: text });
}

/**
 * Persistent shell process that maintains cwd/env across commands.
 * This mirrors the VS Code integrated terminal so `cd` and similar
 * stateful commands carry over to subsequent invocations.
 */
let persistentShell: cp.ChildProcess | null = null;

function ensureShell(cwd: string): cp.ChildProcess {
    if (persistentShell && !persistentShell.killed && persistentShell.exitCode === null) {
        return persistentShell;
    }

    const isWin = process.platform === 'win32';
    const shellCmd = isWin ? 'cmd.exe' : 'sh';
    const shellArgs = isWin ? ['/Q'] : [];

    persistentShell = cp.spawn(shellCmd, shellArgs, {
        cwd,
        env: { ...process.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    persistentShell.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        // Filter out shell prompt lines to reduce noise
        const cleaned = isWin
            ? text.replace(/^[A-Z]:\\[^>\n]*>\s*$/gm, '').trim()
            : text.replace(/^\$\s*$/gm, '').trim();
        if (cleaned) { appendOutput(cleaned + '\n'); }
    });

    persistentShell.stderr?.on('data', (chunk: Buffer) => {
        appendOutput(chunk.toString());
    });

    persistentShell.on('close', () => {
        persistentShell = null;
    });

    return persistentShell;
}

export function terminalRoutes() {
    const router = Router();

    router.get('/output', (req, res) => {
        res.json({ success: true, output: outputLines.join('\n') });
    });

    router.post('/execute', async (req, res) => {
        const { command } = req.body;
        if (!command || typeof command !== 'string') {
            res.status(400).json({ success: false, error: 'Missing command' });
            return;
        }

        // Send command to VS Code integrated terminal (the real IDE terminal)
        const terminal = vscode.window.activeTerminal
            || vscode.window.createTerminal('Remote');
        terminal.show();
        terminal.sendText(command);

        // Send to persistent shell for output capture on phone
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        appendOutput(`$ ${command}\n`);
        addActivity('terminal', `$ ${command}`);

        try {
            const shell = ensureShell(cwd);
            const ok = shell.stdin?.write(command + '\r\n') ?? false;
            if (!ok && shell.stdin) {
                // Buffer is full; data is queued — resume after drain
                shell.stdin.once('drain', () => { /* buffer drained */ });
            }
            res.json({ success: true });
        } catch (err: any) {
            appendOutput(`Error: ${err.message}\n`);
            res.json({ success: false, error: err.message });
        }
    });

    router.get('/list', (req, res) => {
        const terminals = vscode.window.terminals.map((t, i) => ({
            index: i,
            name: t.name,
        }));
        res.json({ success: true, terminals });
    });

    return router;
}
