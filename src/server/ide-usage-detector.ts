/**
 * IDE Usage Detector
 *
 * Scans the local file system for VS Code, Cursor, and Antigravity workspace
 * storage directories, parses every chat session file found using each IDE's
 * platform provider, and returns per-IDE, per-model usage aggregates.
 *
 * Results are cached for 60 seconds so repeated dashboard refreshes don't
 * hammer the disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAllProviders } from './platform';
import type { IDEPlatformProvider, ParsedChatRequest } from './platform';

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

// ─── Storage scanner ──────────────────────────────────────────────────────────

interface RawRequest {
    model: string;
    inputTokens: number;
    outputTokens: number;
    completed: boolean;
}

interface FileCacheEntry {
    mtime: number;
    size: number;
    requests: RawRequest[];
}
const fileCache = new Map<string, FileCacheEntry>();

/**
 * Scan a workspaceStorage root for chatSessions, and parse each file
 * using the platform provider's parser. Optimized using a memory cache.
 */
function scanWorkspaceStorage(storageRoot: string, provider: IDEPlatformProvider): RawRequest[] {
    const results: RawRequest[] = [];
    const fileExt = provider.chatFileExtension;

    try {
        if (!fs.existsSync(storageRoot)) { return results; }

        for (const wsDir of fs.readdirSync(storageRoot)) {
            const chatDir = path.join(storageRoot, wsDir, 'chatSessions');
            if (!fs.existsSync(chatDir)) { continue; }

            let files: fs.Dirent[];
            try { files = fs.readdirSync(chatDir, { withFileTypes: true }); }
            catch { continue; }

            for (const f of files) {
                const nameLower = f.name.toLowerCase();
                if (!f.isFile() || (!nameLower.endsWith(fileExt.toLowerCase()) && !nameLower.endsWith('.json'))) { continue; }

                try {
                    const filePath = path.join(chatDir, f.name);
                    const stats = fs.statSync(filePath);
                    
                    let parsedRequests: RawRequest[];
                    const cached = fileCache.get(filePath);
                    if (cached && cached.mtime === stats.mtimeMs && cached.size === stats.size) {
                        parsedRequests = cached.requests;
                    } else {
                        if (stats.size > 2 * 1024 * 1024) {
                            // Skip files > 2MB to prevent thread blocking / out-of-memory crashes
                            parsedRequests = [];
                        } else {
                            const content = fs.readFileSync(filePath, 'utf-8');
                            const parsed = provider.parseChatFile(content);
                            parsedRequests = parsed
                                .filter(req => req.completed && req.model)
                                .map(req => ({
                                    model: req.model!,
                                    inputTokens: req.tokens?.prompt ?? 0,
                                    outputTokens: req.tokens?.output ?? 0,
                                    completed: true,
                                }));
                        }
                        fileCache.set(filePath, {
                            mtime: stats.mtimeMs,
                            size: stats.size,
                            requests: parsedRequests,
                        });
                    }
                    
                    results.push(...parsedRequests);
                } catch { /* ignore file read/stat errors */ }
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

// ─── Cache & Manual Usage ────────────────────────────────────────────────────────────

let cache: IDEUsageResult[] | null = null;
let cacheTime = 0;
let isDetecting = false;
const CACHE_TTL_MS = 60_000; // 60 s

export const manualUsage: Array<{ ideKey: string; req: RawRequest }> = [];

export function appendUsageSample(ideKey: string, model: string, inputTokens: number, outputTokens: number) {
    manualUsage.push({
        ideKey,
        req: { model, inputTokens, outputTokens, completed: true }
    });
    // Invalidate cache directly so UI updates
    invalidateIDEUsageCache();
}

/**
 * Returns IDE usage data. If currently detecting, it will return the slightly 
 * stale cache to prevent concurrent thread monopolization.
 */
export function detectIDEUsage(): IDEUsageResult[] {
    const now = Date.now();
    if (cache && (now - cacheTime < CACHE_TTL_MS || isDetecting)) { return cache; }

    isDetecting = true;
    try {
        const providers = getAllProviders();

        const results: IDEUsageResult[] = providers.map(provider => {
        const allRaw: RawRequest[] = [];
        let detected = false;

        for (const p of provider.getChatStoragePaths()) {
            if (fs.existsSync(p)) {
                detected = true;
                allRaw.push(...scanWorkspaceStorage(p, provider));
            }
        }
        
        // Include manually tracked API usage
        const manualForIde = manualUsage.filter(m => m.ideKey === provider.key).map(m => m.req);
        if (manualForIde.length > 0) {
            detected = true;
            allRaw.push(...manualForIde);
        }

        const models = aggregateRequests(allRaw);
        const sorted = Object.entries(models).sort((a, b) => b[1].requests - a[1].requests);
        const topModel = sorted[0]?.[0] ?? null;

        return {
            ide: provider.key,
            displayName: provider.displayName,
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
    } finally {
        isDetecting = false;
    }
}

/** Force the cache to expire on the next call (call after the server stops/starts). */
export function invalidateIDEUsageCache(): void {
    cache = null;
    cacheTime = 0;
}

/** Returns the colour for a given IDE key, for use in the dashboard. */
export function getIDEColor(ideKey: string): string {
    const provider = getAllProviders().find(p => p.key === ideKey);
    return provider?.color ?? '#888';
}

/** Legacy export for backward compatibility */
export const IDE_COLORS: Record<string, string> = Object.fromEntries(
    getAllProviders().map(p => [p.key, p.color])
);
