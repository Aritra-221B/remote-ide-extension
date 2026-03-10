import { Router } from 'express';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve and validate that the target path stays within workspace root.
 * Prevents path traversal attacks.
 */
function safePath(workspaceRoot: string, requestedPath: string): string | null {
    const resolved = path.resolve(workspaceRoot, requestedPath);
    if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
        return null;
    }
    return resolved;
}

export function fileRoutes() {
    const router = Router();

    router.get('/list', (req, res) => {
        const dir = (req.query.path as string) || '';
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            res.status(400).json({ success: false, error: 'No workspace open' });
            return;
        }

        const targetDir = safePath(workspaceRoot, dir);
        if (!targetDir) {
            res.status(403).json({ success: false, error: 'Path not allowed' });
            return;
        }

        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
            res.status(404).json({ success: false, error: 'Directory not found' });
            return;
        }

        const entries = fs.readdirSync(targetDir, { withFileTypes: true });
        const items = entries
            .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
            .map(e => ({
                name: e.name,
                type: e.isDirectory() ? 'directory' : 'file',
                path: path.join(dir, e.name).replace(/\\/g, '/')
            }));
        res.json({ success: true, items });
    });

    router.get('/read', (req, res) => {
        const filePath = req.query.path as string;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot || !filePath) {
            res.status(400).json({ success: false, error: 'Missing path' });
            return;
        }

        const resolved = safePath(workspaceRoot, filePath);
        if (!resolved) {
            res.status(403).json({ success: false, error: 'Path not allowed' });
            return;
        }

        if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
            res.status(404).json({ success: false, error: 'File not found' });
            return;
        }

        const content = fs.readFileSync(resolved, 'utf-8');
        res.json({ success: true, content, path: filePath });
    });

    router.post('/write', (req, res) => {
        const { path: filePath, content } = req.body;
        if (!filePath || typeof content !== 'string') {
            res.status(400).json({ success: false, error: 'Missing path or content' });
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            res.status(400).json({ success: false, error: 'No workspace open' });
            return;
        }

        const resolved = safePath(workspaceRoot, filePath);
        if (!resolved) {
            res.status(403).json({ success: false, error: 'Path not allowed' });
            return;
        }

        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(resolved, content, 'utf-8');
        res.json({ success: true });
    });

    return router;
}
