/**
 * IDE Usage Detector
 *
 * Scans the local file system for VS Code, Cursor, and Antigravity workspace
 * storage directories, parses every Copilot-style chatSessions JSONL found,
 * and returns per-IDE, per-model usage aggregates.
 *
 * Results are cached for 60 seconds so repeated dashboard refreshes don't
 * hammer the disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IDEModelStat {
    requests: number;
    inputTokens: number;
    outputTokens: number;
}

export interface IDEUsageResult {
    ide: string;                                    // key e.g. "vscode"
    displayName: string;                            // human label
    detected: boolean;                              // storage path exists
    models: Record<string, IDEModelStat>;           // keyed by model id
    topModel: string | null;                        // model with most requests
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
}

// ─── IDE storage path catalogue ───────────────────────────────────────────────

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

const IDE_CATALOGUE: Array<{
    key: string;
    displayName: string;
    color: string;        // for the dashboard chip
    storagePaths: string[];
}> = [
    {
        key: 'vscode',
        displayName: 'VS Code',
        color: '#007ACC',
        storagePaths: [
            // Windows
            path.join(appData, 'Code', 'User', 'workspaceStorage'),
            path.join(localAppData, 'Programs', 'Microsoft VS Code', 'resources', 'app', 'extensions'),
            // macOS
            path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
            // Linux
            path.join(home, '.config', 'Code', 'User', 'workspaceStorage'),
        ],
    },
    {
        key: 'cursor',
        displayName: 'Cursor',
        color: '#6B4FBB',
        storagePaths: [
            // Windows
            path.join(appData, 'Cursor', 'User', 'workspaceStorage'),
            // macOS
            path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
            // Linux
            path.join(home, '.config', 'Cursor', 'User', 'workspaceStorage'),
        ],
    },
    {
        key: 'antigravity',
        displayName: 'Antigravity',
        color: '#00BFA5',
        storagePaths: [
            // Windows
            path.join(appData, 'Antigravity', 'User', 'workspaceStorage'),
            path.join(appData, 'Antigravity', 'workspaceStorage'),
            path.join(localAppData, 'Antigravity', 'User', 'workspaceStorage'),
            // macOS
            path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'workspaceStorage'),
            // Linux
            path.join(home, '.config', 'Antigravity', 'User', 'workspaceStorage'),
            path.join(home, '.antigravity', 'workspaceStorage'),
        ],
    },
];

// ─── JSONL parser ─────────────────────────────────────────────────────────────

interface RawRequest {
    model: string;
    inputTokens: number;
    outputTokens: number;
    completed: boolean;
}

function parseJsonlForUsage(filePath: string): RawRequest[] {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        const requests = new Map<number, RawRequest>();
        let nextIndex = 0;

        for (const line of lines) {
            let obj: any;
            try { obj = JSON.parse(line); } catch { continue; }

            const kind: number = obj.kind;
            const k: any[] = obj.k || [];
            const v: any = obj.v;

            // kind=2 k=['requests'] — batch append of new request objects
            if (kind === 2 && k.length === 1 && k[0] === 'requests' && Array.isArray(v)) {
                for (const req of v) {
                    requests.set(nextIndex, {
                        model: req?.model || '',
                        inputTokens: 0,
                        outputTokens: 0,
                        completed: false,
                    });
                    nextIndex++;
                }
            }

            // Field update on a specific request: k=['requests', N, fieldName]
            if (k[0] === 'requests' && typeof k[1] === 'number' && k.length === 3) {
                const idx = k[1];
                const field = k[2];

                if (!requests.has(idx)) {
                    requests.set(idx, { model: '', inputTokens: 0, outputTokens: 0, completed: false });
                }
                const entry = requests.get(idx)!;

                if (field === 'result' && v?.metadata) {
                    if (v.metadata.promptTokens)  { entry.inputTokens  = v.metadata.promptTokens; }
                    if (v.metadata.outputTokens)  { entry.outputTokens = v.metadata.outputTokens; }
                    if (v.metadata.modelId)        { entry.model        = v.metadata.modelId; }
                }

                if (field === 'model' && typeof v === 'string' && v) {
                    entry.model = v;
                }

                if (field === 'modelState' && v?.value === 1) {
                    entry.completed = true;
                }
            }
        }

        // Only count completed requests that have a model name
        return [...requests.values()].filter(r => r.completed && r.model);
    } catch {
        return [];
    }
}

// ─── Storage scanner ──────────────────────────────────────────────────────────

function scanWorkspaceStorage(storageRoot: string): RawRequest[] {
    const results: RawRequest[] = [];
    try {
        if (!fs.existsSync(storageRoot)) { return results; }

        for (const wsDir of fs.readdirSync(storageRoot)) {
            const chatDir = path.join(storageRoot, wsDir, 'chatSessions');
            if (!fs.existsSync(chatDir)) { continue; }

            let files: fs.Dirent[];
            try { files = fs.readdirSync(chatDir, { withFileTypes: true }); }
            catch { continue; }

            for (const f of files) {
                if (!f.isFile() || !f.name.endsWith('.jsonl')) { continue; }
                results.push(...parseJsonlForUsage(path.join(chatDir, f.name)));
            }
        }
    } catch { /* ignore permission errors */ }
    return results;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function aggregateRequests(raw: RawRequest[]): Record<string, IDEModelStat> {
    const models: Record<string, IDEModelStat> = {};
    for (const r of raw) {
        const key = r.model || 'unknown';
        if (!models[key]) { models[key] = { requests: 0, inputTokens: 0, outputTokens: 0 }; }
        models[key].requests++;
        models[key].inputTokens  += r.inputTokens;
        models[key].outputTokens += r.outputTokens;
    }
    return models;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let cache: IDEUsageResult[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 60 s

export function detectIDEUsage(): IDEUsageResult[] {
    const now = Date.now();
    if (cache && now - cacheTime < CACHE_TTL_MS) { return cache; }

    const results: IDEUsageResult[] = IDE_CATALOGUE.map(({ key, displayName, storagePaths }) => {
        const allRaw: RawRequest[] = [];
        let detected = false;

        for (const p of storagePaths) {
            if (fs.existsSync(p)) {
                detected = true;
                allRaw.push(...scanWorkspaceStorage(p));
            }
        }

        const models = aggregateRequests(allRaw);
        const sorted = Object.entries(models).sort((a, b) => b[1].requests - a[1].requests);
        const topModel = sorted[0]?.[0] ?? null;

        return {
            ide: key,
            displayName,
            detected,
            models,
            topModel,
            totalRequests:     allRaw.length,
            totalInputTokens:  allRaw.reduce((s, r) => s + r.inputTokens,  0),
            totalOutputTokens: allRaw.reduce((s, r) => s + r.outputTokens, 0),
        };
    });

    cache = results;
    cacheTime = now;
    return results;
}

/** Force the cache to expire on the next call (call after the server stops/starts). */
export function invalidateIDEUsageCache(): void {
    cache = null;
    cacheTime = 0;
}

/** Returns the colour chip for a given IDE key, for use in the dashboard. */
export const IDE_COLORS: Record<string, string> = Object.fromEntries(
    IDE_CATALOGUE.map(e => [e.key, e.color])
);
