import { Router } from 'express';
import * as vscode from 'vscode';
import { getChatUsageSamples } from '../chat-reader';
import { detectIDEUsage, IDE_COLORS } from '../ide-usage-detector';

interface UsageEntry {
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    action: string;
}

// Manual log — kept so external callers can still POST entries
const usageLog: UsageEntry[] = [];

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
    'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
    'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
    'claude-3-7-sonnet': { input: 0.003, output: 0.015 },
    'gpt-4o': { input: 0.005, output: 0.015 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-4.1': { input: 0.002, output: 0.008 },
    'gemini-2.0-flash': { input: 0.00010, output: 0.00040 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    // Sort by length descending so more-specific keys win (e.g. 'gpt-4o-mini' before 'gpt-4o')
    const key = Object.keys(MODEL_COSTS)
        .sort((a, b) => b.length - a.length)
        .find(k => model === k || model.startsWith(k));
    if (!key) { return 0; }
    const c = MODEL_COSTS[key];
    return (inputTokens / 1000) * c.input + (outputTokens / 1000) * c.output;
}

export function usageRoutes() {
    const router = Router();

    router.post('/log', (req, res) => {
        const { model, inputTokens, outputTokens, action } = req.body;
        usageLog.push({
            timestamp: Date.now(),
            model: model || 'unknown',
            inputTokens: inputTokens || 0,
            outputTokens: outputTokens || 0,
            action: action || 'chat',
        });
        res.json({ success: true });
    });

    router.get('/summary', (req, res) => {
        const since = Number(req.query.since) || Date.now() - 86400000; // default: last 24h

        // Primary source: real token data parsed from Copilot chat JSONL files
        const chatSamples = getChatUsageSamples().filter(e => e.timestamp >= since);

        // Secondary source: manually logged entries (from external POST /usage/log)
        const manualEntries = usageLog.filter(e => e.timestamp >= since);

        const byModel: Record<string, {
            requests: number;
            inputTokens: number;
            outputTokens: number;
            estimatedCost: number;
        }> = {};

        const addEntry = (model: string, inputTokens: number, outputTokens: number) => {
            if (!byModel[model]) {
                byModel[model] = { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
            }
            const m = byModel[model];
            m.requests++;
            m.inputTokens += inputTokens;
            m.outputTokens += outputTokens;
            m.estimatedCost += estimateCost(model, inputTokens, outputTokens);
        };

        for (const e of chatSamples) {
            addEntry(e.model, e.inputTokens, e.outputTokens);
        }
        for (const e of manualEntries) {
            addEntry(e.model, e.inputTokens, e.outputTokens);
        }

        const totalRequests = chatSamples.length + manualEntries.length;
        const totalCost = Object.values(byModel).reduce((s, m) => s + m.estimatedCost, 0);

        res.json({
            success: true,
            since: new Date(since).toISOString(),
            totalRequests,
            totalEstimatedCost: `$${totalCost.toFixed(4)}`,
            byModel,
            recentSamples: [...chatSamples].reverse().slice(0, 20),
        });
    });

    router.get('/current-model', async (req, res) => {
        // 1. Try VS Code Language Model API (most reliable, works with Copilot 1.85+)
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            if (models.length > 0) {
                const m = models[0];
                res.json({ success: true, model: m.name || m.id, id: m.id, vendor: m.vendor, family: m.family });
                return;
            }
        } catch { /* lm API unavailable */ }

        // 2. Fall back to most-recently-used model from chat JSONL data
        const samples = getChatUsageSamples();
        if (samples.length > 0) {
            const recent = [...samples].sort((a, b) => b.timestamp - a.timestamp)[0];
            res.json({ success: true, model: recent.model });
            return;
        }

        // 3. Last resort: VS Code settings
        const config = vscode.workspace.getConfiguration();
        const model =
            config.get<string>('github.copilot.chat.model') ||
            config.get<string>('cursor.model') ||
            'unknown';
        res.json({ success: true, model });
    });

    /**
     * GET /api/usage/ide-breakdown
     *
     * Returns per-IDE usage stats (VS Code, Cursor, Antigravity) by scanning
     * each IDE's workspaceStorage chatSessions JSONL files.  Results are cached
     * for 60 s.  Each IDE entry includes:
     *   - detected        : whether the storage path exists on this machine
     *   - models          : per-model { requests, inputTokens, outputTokens }
     *   - topModel        : model id with most requests
     *   - totalRequests   : sum across all models
     */
    router.get('/ide-breakdown', (req, res) => {
        const raw = detectIDEUsage();

        const ides = raw.map(ide => {
            // Sort models by request count descending
            const modelsSorted = Object.entries(ide.models)
                .sort((a, b) => b[1].requests - a[1].requests)
                .map(([name, stat]) => ({
                    name,
                    ...stat,
                    estimatedCost: parseFloat(estimateCost(name, stat.inputTokens, stat.outputTokens).toFixed(4)),
                }));

            const totalCost = modelsSorted.reduce((s, m) => s + m.estimatedCost, 0);

            return {
                ide: ide.ide,
                displayName: ide.displayName,
                color: IDE_COLORS[ide.ide] ?? '#888',
                detected: ide.detected,
                totalRequests: ide.totalRequests,
                totalInputTokens: ide.totalInputTokens,
                totalOutputTokens: ide.totalOutputTokens,
                totalEstimatedCost: `$${totalCost.toFixed(4)}`,
                topModel: ide.topModel,
                models: modelsSorted,
            };
        });

        res.json({ success: true, ides });
    });

    return router;
}
