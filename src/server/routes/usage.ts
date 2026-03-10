import { Router } from 'express';
import * as vscode from 'vscode';

interface UsageEntry {
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    action: string;
}

const usageLog: UsageEntry[] = [];

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
    'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
    'gpt-4o': { input: 0.005, output: 0.015 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
};

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
        const filtered = usageLog.filter(e => e.timestamp >= since);

        const byModel: Record<string, {
            requests: number;
            inputTokens: number;
            outputTokens: number;
            estimatedCost: number;
        }> = {};

        for (const entry of filtered) {
            if (!byModel[entry.model]) {
                byModel[entry.model] = { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
            }
            const m = byModel[entry.model];
            m.requests++;
            m.inputTokens += entry.inputTokens;
            m.outputTokens += entry.outputTokens;

            const costs = MODEL_COSTS[entry.model];
            if (costs) {
                m.estimatedCost +=
                    (entry.inputTokens / 1000) * costs.input +
                    (entry.outputTokens / 1000) * costs.output;
            }
        }

        const totalCost = Object.values(byModel).reduce((s, m) => s + m.estimatedCost, 0);

        res.json({
            success: true,
            since: new Date(since).toISOString(),
            totalRequests: filtered.length,
            totalEstimatedCost: `$${totalCost.toFixed(4)}`,
            byModel,
            recentActions: filtered.slice(-20).reverse(),
        });
    });

    router.get('/current-model', (req, res) => {
        const config = vscode.workspace.getConfiguration();
        const model =
            config.get<string>('github.copilot.chat.model') ||
            config.get<string>('cursor.model') ||
            'unknown';
        res.json({ success: true, model });
    });

    return router;
}
