# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-03-10

### Added
- VS Code extension with embedded Express server
- Cloudflare Tunnel integration (auto-downloads cloudflared binary)
- Mobile-optimized dashboard with 6 tabs (Chat, Files, Term, Usage, Bugs, Screen)
- GitHub Copilot chat integration — live conversation viewer reading VS Code JSONL session files
- Accept / Reject buttons for Copilot suggestions (CDP + VS Code command fallbacks)
- Persistent terminal shell with dual execution (VS Code terminal + output capture)
- File browser with path traversal protection
- Git operations (status, diff, commit, push)
- Native screenshot capture via screenshot-desktop
- AI usage tracking with model cost estimates
- Bug reporting with git snapshot support
- Real-time IDE bridge — 8 VS Code event listeners broadcasting via SSE
- Activity feed with 7 event types (prompt, action, file-edit, file-save, error, info, terminal)
- Session token authentication (UUID v4, regenerated each launch)
- Optional PIN code for extra security
- QR code display for easy phone connection
- 15 smoke tests with mocked vscode module
