/**
 * IDE Platform Detector & Manager
 *
 * Auto-detects which IDE is running and provides the correct platform
 * provider.  Detection order:
 *
 *   1. `vscode.env.appName` (most reliable)
 *   2. Process executable path
 *   3. Environment variables
 *
 * The detected provider is a singleton — cached after first detection.
 */

import * as vscode from 'vscode';
import { IDEPlatformProvider, IDEPlatformKey } from './types';
import { VSCodeProvider } from './providers/vscode-provider';
import { CursorProvider } from './providers/cursor-provider';
import { AntigravityProvider } from './providers/antigravity-provider';

// ─── All known providers ──────────────────────────────────────────────────────

const ALL_PROVIDERS: IDEPlatformProvider[] = [
    new VSCodeProvider(),
    new CursorProvider(),
    new AntigravityProvider(),
];

// ─── Singleton ────────────────────────────────────────────────────────────────

let activeProvider: IDEPlatformProvider | null = null;

/**
 * Detect which IDE is running and return the matching provider.
 * Call this once during extension activation.
 */
export function detectPlatform(): IDEPlatformProvider {
    if (activeProvider) { return activeProvider; }

    const detected = detectIDEKey();
    activeProvider = ALL_PROVIDERS.find(p => p.key === detected)
        || ALL_PROVIDERS[0]; // fallback to VS Code

    console.log(`[Platform] Detected: ${activeProvider.displayName} (${activeProvider.key})`);
    return activeProvider;
}

/**
 * Returns the active platform provider.
 * Auto-detects if not already initialised.
 */
export function getPlatform(): IDEPlatformProvider {
    if (!activeProvider) {
        return detectPlatform();
    }
    return activeProvider;
}

/**
 * Returns ALL known providers (for cross-IDE usage scanning).
 */
export function getAllProviders(): IDEPlatformProvider[] {
    return ALL_PROVIDERS;
}

/**
 * Returns a provider by its IDE key.
 */
export function getProviderByKey(key: IDEPlatformKey): IDEPlatformProvider | undefined {
    return ALL_PROVIDERS.find(p => p.key === key);
}

// ─── Detection logic ──────────────────────────────────────────────────────────

function detectIDEKey(): IDEPlatformKey {
    // 1. Check vscode.env.appName (most reliable)
    try {
        const appName = (vscode.env.appName || '').toLowerCase();

        if (appName.includes('antigravity')) { return 'antigravity'; }
        if (appName.includes('cursor'))      { return 'cursor'; }
        if (appName.includes('visual studio code') || appName.includes('vs code') || appName.includes('vscode')) {
            return 'vscode';
        }
    } catch { /* vscode API may not be available in tests */ }

    // 2. Check process executable path
    try {
        const execPath = process.execPath.toLowerCase();
        if (execPath.includes('antigravity')) { return 'antigravity'; }
        if (execPath.includes('cursor'))      { return 'cursor'; }
        if (execPath.includes('code'))        { return 'vscode'; }
    } catch { /* ignore */ }

    // 3. Check environment variables
    if (process.env.ANTIGRAVITY_DEV || process.env.ANTIGRAVITY_HOME || process.env.ANTIGRAVITY_AGENT || process.env.ANTIGRAVITY_CLI_ALIAS) {
        return 'antigravity';
    }
    if (process.env.CURSOR_DEV || process.env.CURSOR_HOME) {
        return 'cursor';
    }

    // 4. Check secondary paths in environment (like git askpass node)
    try {
        const askpassNode = (process.env.VSCODE_GIT_ASKPASS_NODE || '').toLowerCase();
        if (askpassNode.includes('antigravity')) { return 'antigravity'; }
        if (askpassNode.includes('cursor'))      { return 'cursor'; }
    } catch { /* ignore */ }

    // 5. Default to VS Code
    return 'vscode';
}
