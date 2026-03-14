/**
 * IDE Platform Abstraction — Type Definitions
 *
 * Defines the interface every IDE platform provider must implement.
 * This allows the extension to work identically across VS Code, Cursor,
 * Antigravity, and any future VS-Code-based IDE.
 */

// ─── Chat Data ────────────────────────────────────────────────────────────────

export interface ParsedChatRequest {
    prompt: string;
    response: string;
    timestamp: number;
    completed: boolean;
    tokens?: { prompt?: number; output?: number };
    model?: string;
}

// ─── Model Costs ──────────────────────────────────────────────────────────────

export interface ModelCost {
    input: number;   // $/1K tokens
    output: number;  // $/1K tokens
}

// ─── CDP Selectors ────────────────────────────────────────────────────────────

export interface CDPSelectors {
    /** CSS selector for the chat container element */
    chatContainer: string;
    /** CSS selector for the chat input textarea */
    chatInput: string;
    /** Button labels for "accept" action (tried in order) */
    acceptLabels: string[];
    /** Button labels for "reject" action (tried in order) */
    rejectLabels: string[];
}

// ─── VS Code Command IDs ─────────────────────────────────────────────────────

export interface ChatCommands {
    /** Command to open chat with a query/prompt */
    openChat: string;
    /** Commands to fire for "accept" (all fired in parallel) */
    acceptCommands: string[];
    /** Commands to fire for "reject" (all fired in parallel) */
    rejectCommands: string[];
}

// ─── Platform Provider Interface ──────────────────────────────────────────────

export type IDEPlatformKey = 'vscode' | 'cursor' | 'antigravity' | 'unknown';

export interface IDEPlatformProvider {
    /** Unique key for this provider */
    readonly key: IDEPlatformKey;

    /** Human-readable display name */
    readonly displayName: string;

    /** Brand color (hex) for dashboard display */
    readonly color: string;

    // ── Chat Storage ──────────────────────────────────────────────────────

    /**
     * Returns candidate directories where this IDE stores chat session data.
     * The chat-reader will check these paths for JSONL (or other format) files.
     */
    getChatStoragePaths(): string[];

    /**
     * Parse a raw chat session file (JSONL, JSON, etc.) and return structured
     * request data.  Each IDE may use a different format.
     */
    parseChatFile(content: string): ParsedChatRequest[];

    /** File extension for chat session files (e.g. '.jsonl') */
    readonly chatFileExtension: string;

    // ── Model Info ────────────────────────────────────────────────────────

    /**
     * Map of model names → cost per 1K tokens.
     * Used for the usage/cost estimation dashboard.
     */
    getModelCosts(): Record<string, ModelCost>;

    /**
     * VS Code configuration key(s) to check for the user's selected model.
     * Checked in order; first non-empty value wins.
     */
    getModelConfigKeys(): string[];

    /**
     * Vendor string for `vscode.lm.selectChatModels({ vendor })`.
     * Return null if this IDE doesn't support the Language Model API.
     */
    getLMVendor(): string | null;

    // ── Commands ──────────────────────────────────────────────────────────

    /** Command IDs for chat operations */
    getChatCommands(): ChatCommands;

    // ── CDP ───────────────────────────────────────────────────────────────

    /** CSS selectors and button labels for Chrome DevTools Protocol interaction */
    getCDPSelectors(): CDPSelectors;
}
