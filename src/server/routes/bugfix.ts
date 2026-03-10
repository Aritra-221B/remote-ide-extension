import { Router } from 'express';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface BugReport {
    id: string;
    title: string;
    description: string;
    reproSteps: string[];
    status: 'open' | 'fixing' | 'fixed' | 'verified';
    createdAt: number;
    updatedAt: number;
    gitSnapshotBefore?: string;
    gitSnapshotAfter?: string;
    diffSummary?: string;
    promptUsed?: string;
    fixVerified: boolean;
}

const bugs: Map<string, BugReport> = new Map();

function git(args: string, cwd: string): string {
    try {
        return cp.execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15000 }).trim();
    } catch {
        return '';
    }
}

function generateId(): string {
    return `BUG-${Date.now().toString(36).toUpperCase()}`;
}

export function bugfixRoutes() {
    const router = Router();
    const getCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    router.post('/report', (req, res) => {
        const { title, description, reproSteps } = req.body;
        if (!title || typeof title !== 'string') {
            res.status(400).json({ success: false, error: 'Missing title' });
            return;
        }

        const cwd = getCwd();
        const id = generateId();
        const bug: BugReport = {
            id,
            title,
            description: description || '',
            reproSteps: reproSteps || [],
            status: 'open',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            gitSnapshotBefore: cwd ? git('rev-parse HEAD', cwd) : undefined,
            fixVerified: false,
        };
        bugs.set(id, bug);
        res.json({ success: true, bug });
    });

    router.get('/list', (req, res) => {
        const status = req.query.status as string;
        let results = Array.from(bugs.values());
        if (status) {
            results = results.filter(b => b.status === status);
        }
        results.sort((a, b) => b.updatedAt - a.updatedAt);
        res.json({ success: true, bugs: results });
    });

    router.get('/:id', (req, res) => {
        const bug = bugs.get(req.params.id);
        if (!bug) {
            res.status(404).json({ success: false, error: 'Bug not found' });
            return;
        }

        const cwd = getCwd();
        if (bug.gitSnapshotBefore && bug.gitSnapshotAfter && cwd) {
            bug.diffSummary = git(
                `diff --stat ${bug.gitSnapshotBefore}..${bug.gitSnapshotAfter}`,
                cwd
            );
        }
        res.json({ success: true, bug });
    });

    router.patch('/:id', (req, res) => {
        const bug = bugs.get(req.params.id);
        if (!bug) {
            res.status(404).json({ success: false, error: 'Bug not found' });
            return;
        }

        const { status, promptUsed } = req.body;
        if (status) { bug.status = status; }
        if (promptUsed) { bug.promptUsed = promptUsed; }
        bug.updatedAt = Date.now();

        if (status === 'fixed') {
            const cwd = getCwd();
            if (cwd) { bug.gitSnapshotAfter = git('rev-parse HEAD', cwd); }
        }

        bugs.set(bug.id, bug);
        res.json({ success: true, bug });
    });

    router.post('/:id/reproduce', (req, res) => {
        const bug = bugs.get(req.params.id);
        if (!bug) {
            res.status(404).json({ success: false, error: 'Bug not found' });
            return;
        }

        const cwd = getCwd();
        if (!cwd || !bug.gitSnapshotBefore) {
            res.status(400).json({ success: false, error: 'No git snapshot available' });
            return;
        }

        // Sanitize branch name from bug ID
        const branchName = `reproduce/${bug.id.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
        git(`checkout -b ${branchName} ${bug.gitSnapshotBefore}`, cwd);
        res.json({
            success: true,
            message: `Checked out ${branchName}`,
            reproSteps: bug.reproSteps,
        });
    });

    router.post('/:id/verify', async (req, res) => {
        const bug = bugs.get(req.params.id);
        if (!bug) {
            res.status(404).json({ success: false, error: 'Bug not found' });
            return;
        }

        const cwd = getCwd();
        if (!cwd) {
            res.status(400).json({ success: false, error: 'No workspace open' });
            return;
        }

        const diff = bug.gitSnapshotBefore && bug.gitSnapshotAfter
            ? git(`diff ${bug.gitSnapshotBefore}..${bug.gitSnapshotAfter}`, cwd)
            : git('diff', cwd);

        let testResult = 'No test command configured';
        const pkgPath = path.join(cwd, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.scripts?.test) {
                    try {
                        testResult = cp.execSync('npm test', {
                            cwd, encoding: 'utf-8', timeout: 60000
                        });
                    } catch (e: any) {
                        testResult = `Tests failed:\n${e.stdout || e.message}`;
                    }
                }
            } catch {
                testResult = 'Error reading package.json';
            }
        }

        bug.fixVerified = !testResult.includes('failed');
        bug.status = bug.fixVerified ? 'verified' : 'fixing';
        bug.updatedAt = Date.now();
        bugs.set(bug.id, bug);

        res.json({
            success: true,
            fixVerified: bug.fixVerified,
            diff: diff.substring(0, 5000),
            testResult: testResult.substring(0, 3000),
            filesChanged: bug.gitSnapshotBefore && bug.gitSnapshotAfter
                ? git(`diff --name-only ${bug.gitSnapshotBefore}..${bug.gitSnapshotAfter}`, cwd)
                : '',
        });
    });

    return router;
}
