# Remote IDE Extension

> Control your VS Code / Cursor IDE remotely from your phone browser — powered by Cloudflare Tunnel.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-^1.85.0-007ACC.svg)](https://code.visualstudio.com/)

## Overview

Remote IDE Extension embeds a lightweight Express server inside VS Code and exposes it to your phone via a secure Cloudflare Tunnel. A mobile-optimized dashboard lets you:

- **Send prompts** to GitHub Copilot and **Accept / Reject** suggestions
- **View live chat** — see the full Copilot conversation in real-time
- **Run terminal commands** — execute in the IDE terminal with output streamed to your phone
- **Browse & edit files** — navigate the workspace, read and write files
- **Capture screenshots** — take native screenshots of your IDE
- **Track AI usage** — monitor model requests and estimated costs
- **Report & track bugs** — create bug reports with git snapshots
- **Real-time IDE state** — active file, cursor position, diagnostics, and file save notifications

All traffic is end-to-end encrypted through Cloudflare's network. A unique session token is generated each launch — no credentials are ever stored.

## Architecture

```
┌─────────────────┐     Cloudflare Tunnel     ┌─────────────────────┐
│   📱 Phone      │◄──────────────────────────►│  🖥️ VS Code         │
│   (Browser)     │    HTTPS (encrypted)       │    Extension Host   │
│                 │                            │                     │
│  - Mobile Web   │                            │  - Express Server   │
│  - Dashboard UI │                            │  - SSE Events       │
│  - SSE Stream   │                            │  - Chat Reader      │
└─────────────────┘                            │  - IDE Bridge       │
                                               └─────────────────────┘
```

## Quick Start

### Prerequisites

- **VS Code** ≥ 1.85.0 (or Cursor)
- **Node.js** ≥ 18
- A phone on any network (Cloudflare Tunnel handles NAT traversal)

### Install & Run

```bash
# Clone the repository
git clone https://github.com/Aritra-221B/remote-ide-extension.git
cd remote-ide-extension

# Install dependencies
npm install

# Build
npm run build

# Launch in VS Code
# Press F5 to open the Extension Development Host
```

### First Use

1. Press `Ctrl+Shift+R` (or `Cmd+Shift+R` on Mac) to start Remote Control
2. A QR code will appear — scan it with your phone
3. The mobile dashboard opens in your browser, authenticated automatically
4. Start sending prompts, running commands, and controlling your IDE!

## Mobile Dashboard

| Tab | Features |
|-----|----------|
| **Chat** | Live Copilot conversation view, prompt input, Accept/Reject buttons |
| **Files** | Workspace file browser with breadcrumbs, file viewer |
| **Term** | Terminal with command input, real-time output streaming via SSE |
| **Usage** | AI model usage stats, token counts, cost estimates |
| **Bugs** | Bug reporter with git snapshots, status tracking |
| **Screen** | Native IDE screenshot capture |

## Configuration

Open VS Code Settings and search for "Remote Control":

| Setting | Default | Description |
|---------|---------|-------------|
| `remoteControl.pin` | `""` | Optional PIN code (4+ digits) for extra security |
| `remoteControl.tunnelMode` | `"quick"` | `quick` (no account) or `named` (requires token) |
| `remoteControl.tunnelToken` | `""` | Cloudflare tunnel token for named tunnels |

## Project Structure

```
src/
├── extension.ts              # VS Code extension entry point
├── dashboard/                # Mobile web dashboard
│   ├── index.html            # Tab-based mobile UI
│   ├── styles.css            # Dark theme, mobile-first CSS
│   └── app.js                # Client-side JS (SSE, API calls)
├── server/
│   ├── index.ts              # Express server with auth middleware
│   ├── middleware.ts          # Session token + PIN auth
│   ├── tunnel.ts             # Cloudflare Tunnel manager
│   ├── cdp.ts                # Chrome DevTools Protocol client
│   ├── sse.ts                # Server-Sent Events manager
│   ├── ide-bridge.ts         # VS Code event listeners → SSE
│   ├── chat-reader.ts        # Reads VS Code chat session JSONL files
│   ├── activity.ts           # Activity feed system
│   └── routes/
│       ├── auth.ts           # Token validation
│       ├── chat.ts           # Chat HTML, prompts, actions, messages
│       ├── terminal.ts       # Persistent shell + VS Code terminal
│       ├── files.ts          # File listing, reading, writing
│       ├── git.ts            # Git status, diff, commit, push
│       ├── screenshot.ts     # Native screenshot capture
│       ├── prompt.ts         # Send prompts to Copilot
│       ├── ide.ts            # IDE state snapshot
│       ├── usage.ts          # AI usage tracking
│       └── bugfix.ts         # Bug reporting with git snapshots
├── panels/                   # VS Code webview panels
└── types/                    # TypeScript type declarations
test/
└── smoke.js                  # 15 smoke tests with mocked vscode module
```

## Security

- **Session tokens**: A new UUID v4 token is generated each launch — never stored or reused
- **Cloudflare Tunnel**: All traffic is encrypted via Cloudflare's network (HTTPS)
- **Path traversal protection**: File operations are sandboxed to the workspace root
- **Input sanitization**: All user inputs are validated and sanitized
- **No credentials stored**: PIN is optional and stays in VS Code settings

## Development

```bash
# Watch mode (recompile on changes)
npm run watch

# Run tests
node test/smoke.js

# Package as .vsix
npm run package
```

### Adding a New Route

1. Create `src/server/routes/myroute.ts` with a `Router` export
2. Mount it in `src/server/index.ts`
3. Add UI controls in `src/dashboard/app.js`

## Tech Stack

- **TypeScript** — Extension host and server code
- **Express 5** — Embedded HTTP server
- **Cloudflare Tunnel** — Secure public access (auto-downloads `cloudflared`)
- **Server-Sent Events** — Real-time streaming (11+ event types)
- **Chrome DevTools Protocol** — Optional deep IDE integration
- **screenshot-desktop** — Native screen capture

## License

[MIT](LICENSE)

## Author

**Aritra Banerjee** — [@Aritra-221B](https://github.com/Aritra-221B)
