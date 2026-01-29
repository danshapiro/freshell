<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js Version">
  <img src="https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-blue" alt="Platform Support">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

<h1 align="center">🐚freshell</h1>

<p align="center">
  Claudes Code, terminals, and other CLI friends in your browser. Speak with the dead, jump to your phone, and lots more
</p>

<p align="center">
  <strong>Run multiple terminals in tabs | Detach & reattach sessions | Browse Claude Code history | What if tmux and Claude fell in love?</strong>
</p>

---

![freshell screenshot](docs/freshell-screenshot.jpg)

## Features

- **Multi-tab terminal sessions** — Run shell, Claude Code, and Codex in parallel tabs
- **Split panes** — Divide any tab into independent terminal panes (horizontal/vertical)
- **Detach/reattach** — Background terminals persist across browser sessions
- **Search & browse** — Filter Claude sessions by project, date, or content
- **Speak with the dead** — Invoke the spirits of ancient Claudes and ask them what they were thinking
- **Keep it tidy** — AI (or your pedantic self) names, summarizes, and organizes
- **Dark/light themes** — Are we savages?
- **Keyboard-driven** — tmux-style prefix shortcuts for power users

## Quick Start

```bash
# Clone the repository
git clone https://github.com/danshapiro/freshell.git
cd freshell

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and set AUTH_TOKEN to a secure random value

# Start development servers
npm run dev
```

Open http://localhost:5173/?token=YOUR_AUTH_TOKEN

## Prerequisites

| Platform | Requirements |
|----------|-------------|
| **All** | Node.js 18+ (20+ recommended), npm |
| **Windows** | Build tools for native modules (see below) |
| **macOS** | Xcode Command Line Tools |
| **Linux** | build-essential, python3 |

> **Note:** WSL is optional on Windows. The app defaults to `cmd.exe` for terminals. Set `WINDOWS_SHELL=wsl` or `WINDOWS_SHELL=powershell` to change. WSL is only needed if your Claude sessions live inside the Linux filesystem.

### Platform-Specific Setup

<details>
<summary><strong>Windows</strong></summary>

1. Install [Node.js](https://nodejs.org/) (LTS version)
2. Install build tools for native modules:
   ```powershell
   npm install -g windows-build-tools
   ```
3. **(Optional)** Install [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) if you want Linux terminals or need to access Claude sessions stored in WSL:
   ```powershell
   wsl --install -d Ubuntu
   ```
   Then set `WINDOWS_SHELL=wsl` in your `.env` file.

</details>

<details>
<summary><strong>macOS</strong></summary>

1. Install Xcode Command Line Tools:
   ```bash
   xcode-select --install
   ```
2. Install Node.js via Homebrew:
   ```bash
   brew install node
   ```

</details>

<details>
<summary><strong>Linux (Debian/Ubuntu)</strong></summary>

```bash
# Install build dependencies
sudo apt update
sudo apt install -y build-essential python3

# Install Node.js (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

</details>

## Installation

```bash
# Clone
git clone https://github.com/yourusername/freshell.git
cd freshell

# Install dependencies
npm install

# Create environment file
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Required: secure random token (min 16 characters)
AUTH_TOKEN=your-secure-random-token-here

# Optional: server port (default 3001)
PORT=3001

# Windows only: shell type (cmd, powershell, or wsl). Default: cmd
# WINDOWS_SHELL=cmd

# Windows/WSL: path to Claude home (use WSL path if using WSL)
CLAUDE_HOME=\\wsl$\Ubuntu\home\your-user\.claude
WSL_DISTRO=Ubuntu

# Optional: Gemini API key for AI summaries
GOOGLE_GENERATIVE_AI_API_KEY=your-api-key
```

## Usage

### Development

Run the client and server with hot reload:

```bash
npm run dev
```

Or run them separately:

```bash
# Terminal 1 - Server
npm run dev:server

# Terminal 2 - Client
npm run dev:client
```

### Production

```bash
# Build both client and server
npm run build

# Start production server
npm start
```

Access the app at http://localhost:3001/?token=YOUR_AUTH_TOKEN

## Keyboard Shortcuts

freshell uses a tmux-style prefix system. Press `Ctrl+B` followed by a command key:

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` `T` | New terminal tab |
| `Ctrl+B` `W` | Close current tab |
| `Ctrl+B` `S` | Sessions view |
| `Ctrl+B` `O` | Overview view |
| `Ctrl+B` `,` | Settings |

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_TOKEN` | Yes | Authentication token for API and WebSocket |
| `PORT` | No | Server port (default: 3001) |
| `ALLOWED_ORIGINS` | No | Comma-separated allowed CORS origins |
| `CLAUDE_HOME` | No | Path to Claude config directory |
| `WINDOWS_SHELL` | No | Windows shell: `cmd` (default), `powershell`, or `wsl` |
| `WSL_DISTRO` | No | WSL distribution name (Windows only) |
| `CLAUDE_CMD` | No | Claude CLI command override |
| `CODEX_CMD` | No | Codex CLI command override |
| `GOOGLE_GENERATIVE_AI_API_KEY` | No | Gemini API key for AI summaries |

### Windows + WSL (Optional)

If your Claude Code sessions live inside WSL at `~/.claude`, configure access from Windows:

```bash
WINDOWS_SHELL=wsl
CLAUDE_HOME=\\wsl$\Ubuntu\home\your-username\.claude
WSL_DISTRO=Ubuntu
```

The server will watch `CLAUDE_HOME/projects/**/sessions/*.jsonl` for new sessions.

## Security

- **AUTH_TOKEN is mandatory** — The server refuses to start without it
- **API authentication** — All `/api/*` routes require `x-auth-token` header
- **WebSocket handshake** — Connections must send a valid token in the `hello` message
- **Origin restriction** — WebSocket connections limited to allowed origins

## Testing

```bash
# Run all tests
npm test

# Run with UI
npm run test:ui

# Run specific test suites
npm run test:unit          # Unit tests only
npm run test:server        # Server tests only
npm run test:client        # Client tests only
npm run test:coverage      # With coverage report
```

## Tech Stack

- **Frontend**: React 18, Redux Toolkit, Tailwind CSS, xterm.js
- **Backend**: Express, WebSocket (ws), node-pty
- **Build**: Vite, TypeScript
- **AI**: Vercel AI SDK with Google Gemini

## Project Structure

```
freshell/
├── src/                  # Frontend source
│   ├── components/       # React components
│   ├── store/            # Redux store & slices
│   ├── lib/              # Utilities & API client
│   └── hooks/            # Custom React hooks
├── server/               # Backend source
│   ├── index.ts          # Server entry point
│   ├── ws-handler.ts     # WebSocket handling
│   └── claude-session.ts # Session indexer
├── test/                 # Test suites
└── dist/                 # Build output
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
