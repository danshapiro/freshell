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
- **Speak with the dead** — Resume any Claude, Codex, or OpenCode session from any device (even if you weren't using freshell to run it)
- **Fancy tabs** — Auto-name from terminal content, drag-and-drop reorder, and per-pane type icons so you know what's in each tab
- **Freshclaude** — An interactive alternative to Claude CLI that works with your Anthropic subscription. Rich chat UI with collapsible tool strips, token budget display, and full session persistence.
- **Extension system** — Add new pane types, CLI integrations, and server-side services via manifest-based extensions. Enable and disable from the Extensions management page.
- **Self-configuring workspace** — Just ask Claude or Codex to open a browser in a pane, or create a tab with four subagents. Built-in tmux-like API and skill makes it simple.
- **Live pane headers** — See your active directory, git branch, and context usage in every pane title bar, updating live as you work. Fresh-agent panes carry their context meter in their status strip instead of the header.
- **Host pressure dashboard pane** — CPU, memory, pressure, and I/O at a glance with near-zero overhead (metrics stream only while you're watching). Linux, WSL, and macOS only — not shown on Windows.
- **Activity notifications** — Configurable attention indicators (highlight, pulse, darken) on tabs and pane headers when a coding CLI finishes its turn, with click or type dismiss modes
- **AI-powered session titles** — Right-click any session and generate a Gemini-powered title based on conversation content
- **Progressive sidebar search** — Two-phase search with instant local results followed by deep server-side content search
- **Mobile responsive** — Auto-collapsing sidebar and overlay navigation for phones and tablets
- **Stream Deck** — Drive freshell from an Elgato Stream Deck: tabs on keys with repo icons and status backgrounds (or classic live previews and status rings), press to focus, long-press to approve or stop agents. See [Stream Deck](#stream-deck).

## Quick Start

```bash
# Clone the repository at the latest stable release
git clone --branch v0.7.5 https://github.com/danshapiro/freshell.git
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

`npm run serve` is intended for `main`. If you run it from another branch, Freshell asks for confirmation in an interactive terminal and refuses in non-interactive shells unless `FRESHELL_ALLOW_NON_MAIN_SERVE=1` is set.

## Stream Deck

Freshell can drive an Elgato Stream Deck straight from the browser. Each key shows a tab — by default the **Status icons** style: title on top, centered repo icons, and a status background (green for tabs that want attention), with keys sorted so attention-seeking tabs come first. Press a key to focus that tab; long-press (500 ms) to open an action layer with BACK / APPROVE / STOP keys (it closes itself after 10 s). When you have more tabs than keys, the last key pages through them (wrapping around). On a Stream Deck +, the dials cycle tabs and flip pages and the touch strip shows the active tab plus busy/waiting counts (waiting = tabs that finished a turn or are waiting for approval). The deck dims after a configurable idle timeout and wakes on activity.

**Requirements**

- Chrome or Edge (WebHID). Not supported in the freshell desktop app — use Chrome or Edge instead.
- An Elgato Stream Deck. The Stream Deck Mini is the primary target; other models (including the Stream Deck + dials and touch strip) are driven by their reported capabilities.

**Connecting:** Settings → Stream Deck → turn on **Enable Stream Deck**, click **Connect Stream Deck**, and pick the device in the browser prompt. After that first grant, freshell reconnects automatically — including after unplug/replug and page reloads. Deck settings are stored in the browser (localStorage), so they are per browser profile, not per freshell server.

**Virtual deck:** Settings → Stream Deck → **Show virtual deck** opens an on-screen deck panel that mirrors the keys. It works without any hardware — and in browsers without WebHID.

**Tile style:** Settings → Stream Deck → **Tile style** switches between **Status icons** (the default, described above) and **Terminal previews** — the classic look with a title banner, a live mini terminal preview on each key, and colored status rings (blue busy, green needs-attention, amber waiting for approval), with keys in plain tab-bar order. Switching takes effect immediately, on the hardware deck and the virtual deck alike.

**Linux device permissions (udev):** hidraw device nodes default to root-only, so the browser cannot open the deck until you grant access to the Elgato vendor id (`0fd9`):

```bash
sudo tee /etc/udev/rules.d/50-elgato-stream-deck.rules >/dev/null <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0fd9", TAG+="uaccess"
KERNEL=="hidraw*", ATTRS{idVendor}=="0fd9", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then unplug and replug the deck. Without the rule, the connection status shows "In use by another window or app — or missing device permissions (Linux udev)" — the browser cannot distinguish the two failure causes.

**Chrome Memory Saver:** Chrome's Memory Saver can discard a long-hidden freshell tab even while the deck is connected — the deck goes dark until you revisit the tab. To avoid this, add your freshell URL to Memory Saver's "Always keep this site active" list (`chrome://settings/performance`).

## Keyboard Shortcuts

<!-- Canonical source: src/lib/keyboard-shortcuts.ts -->

| Shortcut | Action |
|----------|--------|
| `Alt+T` | New tab |
| `Alt+W` | Close tab |
| `Alt+H` / `Alt+Shift+T` | Reopen closed tab |
| `Ctrl+Shift+[` / `Alt+[` | Previous tab |
| `Ctrl+Shift+]` / `Alt+]` | Next tab |
| `Ctrl+Shift+ArrowLeft` | Move tab left |
| `Ctrl+Shift+ArrowRight` | Move tab right |
| `Ctrl+Shift+C` | Copy selection (in terminal) |
| `Ctrl+V` / `Ctrl+Shift+V` | Paste (in terminal) |
| `Ctrl+F` | Search (in terminal) |
| `Shift+Enter` | Newline (in terminal) |
| `Cmd/Ctrl+End` | Scroll to bottom (in terminal) |
| `Right-click` / `Shift+F10` | Context menu |

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_TOKEN` | Auto | Authentication token (auto-generated on first run, min 16 chars) |
| `PORT` | No | Server port (default: 3001) |
| `ALLOWED_ORIGINS` | No | Auto-managed CORS origins for the active server bind host and LAN IPs |
| `EXTRA_ALLOWED_ORIGINS` | No | Comma-separated custom CORS origins preserved across runtime origin rebuilds |
| `CLAUDE_HOME` | No | Path to Claude config directory (default: `~/.claude`) |
| `CODEX_HOME` | No | Path to Codex config directory (default: `~/.codex`) |
| `WINDOWS_SHELL` | No | Windows shell: `wsl` (default), `cmd`, or `powershell` |
| `WSL_DISTRO` | No | WSL distribution name (Windows only) |
| `CLAUDE_CMD` | No | Claude CLI command override |
| `CODEX_CMD` | No | Codex CLI command override |
| `OPENCODE_CMD` | No | OpenCode CLI command override |
| `GEMINI_CMD` | No | Gemini CLI command override |
| `KIMI_CMD` | No | Kimi CLI command override |
| `AMPLIFIER_CMD` | No | Amplifier CLI command override |
| `GOOGLE_GENERATIVE_AI_API_KEY` | No | Gemini API key for AI-powered terminal summaries |

### Coding CLI Providers

Freshell indexes local session history and can launch terminals for these coding CLIs:

| Provider | Session history | Launch terminals | Home directory |
|----------|:-:|:-:|----------------|
| **Claude Code** | Yes | Yes | `~/.claude` |
| **Codex** | Yes | Yes | `~/.codex` |
| **OpenCode** | Yes | Yes | `XDG_DATA_HOME/opencode` (or platform default) |
| **Gemini** | — | Yes | — |
| **Kimi** | — | Yes | — |
| **Amplifier** | Yes | Yes | `~/.amplifier` |

Enable/disable providers and set defaults in the Settings UI or via `~/.freshell/config.json`.
OpenCode sessions are discovered directly from OpenCode's local session database, so existing OpenCode work can be resumed from freshell without importing anything manually.

OpenCode permissions are controlled by the OpenCode configuration for the OS user running freshell. Freshell does not set `OPENCODE_PERMISSION` or pass `--dangerously-skip-permissions` for OpenCode sessions; OS filesystem permissions remain the hard boundary.

Amplifier loads the freshell MCP only if its bundle mounts `tool-mcp` (the default `anchors` bundle does not). Add `tool-mcp` to your Amplifier bundle to enable orchestration.

## Tech Stack

- **Frontend**: React 18, Redux Toolkit, Tailwind CSS, xterm.js, Monaco Editor, Zod, lucide-react
- **Backend**: Express, WebSocket (ws), node-pty, Pino, Chokidar, Zod
- **Build**: Vite, TypeScript
- **Testing**: Vitest, Testing Library, supertest, superwstest
- **AI**: Vercel AI SDK with Google Gemini

## Extensions

Freshell supports custom pane types via extensions. Three categories are available:

- **Client** — Static HTML/JS served by freshell (no server needed)
- **Server** — Your own HTTP server, managed by freshell with automatic port allocation
- **CLI** — Any terminal tool wrapped as a pane

Drop a directory with a `freshell.json` manifest into `~/.freshell/extensions/` and restart freshell. See [`examples/extensions/`](examples/extensions/) for working examples of each type.

## Contributing

Contributions are welcome. Start from `origin/main` in a worktree, submit a Pull Request against `main`, and keep behavior changes on PR branches. After a PR merges, update local `main` from `origin/main`. See [docs/development/branch-model.md](docs/development/branch-model.md).

## Community Projects

Projects built by the community around freshell.

- [freshell-container](https://github.com/nkcx/freshell-container) — Docker container packaging freshell with all supported coding CLI providers for self-hosted, multi-device access

## License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Made with terminals and caffeine
</p>
