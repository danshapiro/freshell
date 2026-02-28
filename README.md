<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js Version">
  <img src="https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-blue" alt="Platform Support">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

<h1 align="center">🐚🔥freshell</h1>

<p align="center">
  Claudes Code, Codex, shells, and editors in joyful harmony. Speak with the dead, jump to your phone, and more.
</p>

<p align="center">
  <strong>CLIs in tabs and panes | Forever coding agent history | What if tmux and Claude fell in love?</strong>
</p>

---

![freshell screenshot](docs/fresheyes-demo-moog.png)

## Features

- **Tabs and panes** — Organize projects with multiple coding agents, shells, browsers, editors, and more on a tab - and as many tabs as you want. 
- **Desktop, laptop, phone** — Run on your main machine, then work on your project anywhere via VPN or Tailscale.
- **Speak with the dead** — Resume any Claude or Codex session from any device (even if you weren't using freshell to run it)
- **Fancy tabs** — Auto-name from terminal content, drag-and-drop reorder, and per-pane type icons so you know what's in each tab
- **Freshclaude** — An interactive alternative to Claude CLI that works with your Anthropic subscription.
- **Self-configuring workspace** — Just ask Claude or Codex to open a browser in a pane, or create a tab with four subagents. Built-in tmux-like API and skill makes it simple.
- **Live pane headers** — See your active directory, git branch, and context usage in every pane title bar, updating live as you work
- **Activity notifications** — Configurable attention indicators (highlight, pulse, darken) on tabs and pane headers when a coding CLI finishes its turn, with click or type dismiss modes
- **Mobile responsive** — Auto-collapsing sidebar and overlay navigation for phones and tablets

## Quick Start

```bash
# Clone the repository at the latest stable release
git clone --branch v0.6.0 https://github.com/danshapiro/freshell.git
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

## Tech Stack

- **Frontend**: React 18, Redux Toolkit, Tailwind CSS, xterm.js, Monaco Editor, Zod, lucide-react
- **Backend**: Express, WebSocket (ws), node-pty, Pino, Chokidar, Zod
- **Build**: Vite, TypeScript
- **Testing**: Vitest, Testing Library, supertest, superwstest
- **AI**: Vercel AI SDK with Google Gemini

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Made with terminals and caffeine
</p>
