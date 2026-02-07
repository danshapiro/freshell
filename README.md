<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js Version">
  <img src="https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-blue" alt="Platform Support">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

<h1 align="center">🐚🔥freshell</h1>

<p align="center">
  Claudes Code, terminals, and other CLI friends in your browser. Speak with the dead, jump to your phone, and lots more
</p>

<p align="center">
  <strong>Run multiple terminals in tabs | Detach & reattach sessions | Browse coding CLI history | What if tmux and Claude fell in love?</strong>
</p>

---

![freshell screenshot](docs/freshell-screenshot.jpg)

## Features

- **Multi-tab terminal sessions** — Run shell, Claude Code, Codex, and other coding CLIs in parallel tabs
- **Flexible workspaces** — Arrange terminals, browsers, and code editors side by side in split panes within each tab
- **Detach/reattach** — Background terminals persist across browser sessions; reconnect from any device
- **Search & browse** — Three-tier search across coding CLI sessions: titles, user messages, and full transcript text
- **Speak with the dead** — Invoke the spirits of ancient Claudes and ask them what they were thinking
- **Keep it tidy** — AI-powered terminal summaries (via Gemini), custom session titles, archiving, and project color-coding
- **Overview dashboard** — See all running and exited terminals at a glance with status, idle time, and AI summaries
- **Dark/light themes** — 8 terminal themes (Dracula, One Dark, Solarized, GitHub, and more) plus system/light/dark app themes
- **Drag-and-drop tabs** — Reorder tabs by dragging, with keyboard and touch support
- **Context menus** — Right-click menus for tabs, terminals, sessions, projects, and messages with 40+ actions
- **Activity notifications** — Audio alert when a terminal finishes while the window is in the background
- **Mobile responsive** — Auto-collapsing sidebar and overlay navigation for phones and tablets
- **Auto-update** — Checks for new releases on startup and offers one-key upgrade

## Quick Start

```bash
# Clone the repository at the latest stable release
git clone --branch v0.3.2 https://github.com/danshapiro/freshell.git
cd freshell

# Install dependencies
npm install

# Build and run
npm run serve
```

On first run, freshell auto-generates a `.env` file with a secure random `AUTH_TOKEN`. The token is printed to the console at startup — open the URL shown to connect.

## Prerequisites

Node.js 18+ (20+ recommended) and platform build tools for native modules (`windows-build-tools` on Windows, Xcode CLI Tools on macOS, `build-essential python3` on Linux).

> **Note:** On native Windows, terminals default to WSL. Set `WINDOWS_SHELL=cmd` or `WINDOWS_SHELL=powershell` to use a native Windows shell instead.

## Usage

```bash
npm run dev     # Development with hot reload
npm run serve   # Production build and run
```

## Auto-Update

Freshell checks for new GitHub releases before starting. Accept the prompt to auto-pull, install, and rebuild. Disable with `SKIP_UPDATE_CHECK=true`.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+[` | Previous tab |
| `Ctrl+Shift+]` | Next tab |
| `Ctrl+Shift+ArrowLeft` | Move tab left |
| `Ctrl+Shift+ArrowRight` | Move tab right |
| `Ctrl+Shift+C` | Copy selection (in terminal) |
| `Ctrl+V` / `Ctrl+Shift+V` | Paste (in terminal) |
| `Right-click` / `Shift+F10` | Context menu |

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_TOKEN` | Auto | Authentication token (auto-generated on first run, min 16 chars) |
| `PORT` | No | Server port (default: 3001) |
| `ALLOWED_ORIGINS` | No | Comma-separated allowed CORS origins (auto-detected from LAN) |
| `CLAUDE_HOME` | No | Path to Claude config directory (default: `~/.claude`) |
| `CODEX_HOME` | No | Path to Codex config directory (default: `~/.codex`) |
| `WINDOWS_SHELL` | No | Windows shell: `wsl` (default), `cmd`, or `powershell` |
| `WSL_DISTRO` | No | WSL distribution name (Windows only) |
| `CLAUDE_CMD` | No | Claude CLI command override |
| `CODEX_CMD` | No | Codex CLI command override |
| `OPENCODE_CMD` | No | OpenCode CLI command override |
| `GEMINI_CMD` | No | Gemini CLI command override |
| `KIMI_CMD` | No | Kimi CLI command override |
| `GOOGLE_GENERATIVE_AI_API_KEY` | No | Gemini API key for AI-powered terminal summaries |

### Windows + WSL

Freshell defaults to WSL for terminals on Windows. If your Claude Code sessions live inside WSL at `~/.claude`, you may need to configure `CLAUDE_HOME` so the server can find them from Windows:

```bash
CLAUDE_HOME=\\wsl$\Ubuntu\home\your-username\.claude
WSL_DISTRO=Ubuntu
```

On WSL2, freshell automatically sets up port forwarding and firewall rules so you can access it from other devices on your LAN.

### Coding CLI Providers

Freshell indexes local session history and can launch terminals for these coding CLIs:

| Provider | Session history | Launch terminals | Home directory |
|----------|:-:|:-:|----------------|
| **Claude Code** | Yes | Yes | `~/.claude` |
| **Codex** | Yes | Yes | `~/.codex` |
| **OpenCode** | — | Yes | — |
| **Gemini** | — | Yes | — |
| **Kimi** | — | Yes | — |

Enable/disable providers and set defaults in the Settings UI or via `~/.freshell/config.json`.

## Security

- **AUTH_TOKEN is mandatory** — Auto-generated on first run (64 hex chars); server refuses to start without one (min 16 chars, rejects known weak values)
- **API authentication** — All `/api/*` routes require `x-auth-token` header (except `/api/health`)
- **WebSocket handshake** — Connections must send a valid token in the `hello` message
- **Origin restriction** — WebSocket and CORS limited to allowed origins (auto-detected from LAN, configurable via `ALLOWED_ORIGINS`)
- **Rate limiting** — API routes are rate-limited to 300 requests per minute

## Tech Stack

- **Frontend**: React 18, Redux Toolkit, Tailwind CSS, xterm.js, Monaco Editor, Zod, lucide-react
- **Backend**: Express, WebSocket (ws), node-pty, Pino, Chokidar, Zod
- **Build**: Vite, TypeScript
- **Testing**: Vitest, Testing Library, supertest, superwstest
- **AI**: Vercel AI SDK with Google Gemini

## Project Structure

```
src/          React frontend (components, Redux store, hooks)
server/       Express backend (PTY management, WebSocket, coding CLI providers, session search, auto-updater)
test/         Vitest suites (unit, integration, e2e)
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Made with terminals and caffeine
</p>
