import { Router } from 'express';
import * as vscode from 'vscode';
import { getChatUsageSamples } from '../chat-reader';
import { detectIDEUsage, IDE_COLORS } from '../ide-usage-detector';
import { getPlatform } from '../platform';
import type { ModelCost } from '../platform';

interface UsageEntry {
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    action: string;
}

// Manual log — kept so external callers can still POST entries
const usageLog: UsageEntry[] = [];

/**
 * Estimate cost using the active platform's model cost table.
 * Falls back to zero if the model is unknown.
 */
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const costs = getPlatform().getModelCosts();
    // Sort by key length descending so more-specific keys win (e.g. 'gpt-4o-mini' before 'gpt-4o')
    const key = Object.keys(costs)
        .sort((a, b) => b.length - a.length)
        .find(k => model === k || model.startsWith(k));
    if (!key) { return 0; }
    const c = costs[key];
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

        // Primary source: real token data parsed from chat session files
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

        const platform = getPlatform();
        res.json({
            success: true,
            ide: platform.key,
            ideDisplayName: platform.displayName,
            since: new Date(since).toISOString(),
            totalRequests,
            totalEstimatedCost: `$${totalCost.toFixed(4)}`,
            byModel,
            recentSamples: [...chatSamples].reverse().slice(0, 20),
        });
    });

    router.get('/current-model', async (req, res) => {
        const platform = getPlatform();

        // 1. Try VS Code Language Model API with platform-specific vendor (fallback due to older @types)
        const vendor = platform.getLMVendor();
        const vsLm = (vscode as any).lm;
        if (vendor && vsLm?.selectChatModels) {
            try {
                const models = await vsLm.selectChatModels({ vendor });
                if (models.length > 0) {
                    const m = models[0];
                    res.json({
                        success: true,
                        model: m.name || m.id,
                        id: m.id,
                        vendor: m.vendor,
                        family: m.family,
                        ide: platform.key,
                    });
                    return;
                }
            } catch { /* lm API unavailable */ }
        }

        // 2. Fall back to most-recently-used model from chat session data
        const samples = getChatUsageSamples();
        if (samples.length > 0) {
            const recent = [...samples].sort((a, b) => b.timestamp - a.timestamp)[0];
            res.json({ success: true, model: recent.model, ide: platform.key });
            return;
        }

        // 3. Last resort: check platform-specific config keys
        const config = vscode.workspace.getConfiguration();
        let model = 'unknown';
        for (const configKey of platform.getModelConfigKeys()) {
            const val = config.get<string>(configKey);
            if (val) { model = val; break; }
        }
        res.json({ success: true, model, ide: platform.key });
    });

    router.post('/current-model', async (req, res) => {
        const platform = getPlatform();
        const { model } = req.body;
        if (!model) {
            return res.status(400).json({ success: false, error: 'Model ID required' });
        }
        
        // Find the first valid config key for this platform and update it globally
        const keys = platform.getModelConfigKeys();
        if (keys.length === 0) {
            return res.json({ success: false, error: 'Platform does not support model switching via config keys' });
        }
        
        try {
            const config = vscode.workspace.getConfiguration();
            // Try updating the primary config key
            await config.update(keys[0], model, vscode.ConfigurationTarget.Global);
            res.json({ success: true, model, ide: platform.key });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * GET /api/usage/ide-breakdown
     *
     * Returns per-IDE usage stats by scanning each IDE's storage.
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

    /**
     * GET /api/usage/platform-info
     *
     * Returns information about the detected platform.
     */
    router.get('/platform-info', (req, res) => {
        const platform = getPlatform();
        res.json({
            success: true,
            key: platform.key,
            displayName: platform.displayName,
            color: platform.color,
            supportedModels: Object.keys(platform.getModelCosts()),
            lmVendor: platform.getLMVendor(),
        });
    });

    return router;
}
