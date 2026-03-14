/**
 * Platform Module — Public API
 *
 * Re-exports everything needed by the rest of the extension.
 */

export { IDEPlatformProvider, IDEPlatformKey, ParsedChatRequest, ModelCost, ChatCommands, CDPSelectors } from './types';
export { detectPlatform, getPlatform, getAllProviders, getProviderByKey } from './detector';
export { VSCodeProvider, parseCopilotJsonl } from './providers/vscode-provider';
export { CursorProvider } from './providers/cursor-provider';
export { AntigravityProvider } from './providers/antigravity-provider';
