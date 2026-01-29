# Claude Code Session Organizer

A local web app to:
- Run multiple terminal sessions (shell, Claude, Codex) in tabs
- Detach/reattach background terminals
- Index Claude Code sessions from `~/.claude` and browse/search them by project
- Persist UI settings and user overrides (titles, summaries, colors) in `~/.ccso/config.json`
- Optional AI-generated summaries (Gemini, via Vercel AI SDK) when an API key is present

This repo is generated from the implementation plan you provided.

## Prerequisites

- Node.js 18+ (Node 20+ recommended)
- `npm` (or `pnpm`/`yarn` with small script changes)
- On Windows: WSL installed + a working distro (default: `Ubuntu`)

## Setup

```bash
cp .env.example .env
# Edit .env and set AUTH_TOKEN to a long random value.
npm install
```

## Run (development)

Run the server and client in two terminals:

```bash
# Terminal 1
npm run dev:server
```

```bash
# Terminal 2
npm run dev
```

Open:

- Client: `http://localhost:5173/?token=YOUR_AUTH_TOKEN`
- Server: `http://localhost:3001/api/health` (requires `x-auth-token` header)

## Build + run (production)

```bash
npm run build
npm run start
```

Open: `http://localhost:3001/?token=YOUR_AUTH_TOKEN`

## Windows / WSL notes

Claude Code session logs typically live in the Linux home directory inside WSL, so the Node server (running on Windows) **cannot** see them unless you point it at a Windows-accessible path.

Set:

```
CLAUDE_HOME=\\wsl$\Ubuntu\home\your-user\.claude
WSL_DISTRO=Ubuntu
```

The app will watch:

```
%CLAUDE_HOME%\projects\**\sessions\*.jsonl
```

## Security model

- `AUTH_TOKEN` is mandatory. The server refuses to start without it.
- `/api/*` requires `x-auth-token: <AUTH_TOKEN>`.
- WebSocket requires a `hello` message containing the token.
- WebSocket origin is restricted by `ALLOWED_ORIGINS` (defaults to localhost dev/prod).

## Keyboard shortcuts

A simple prefix system is implemented:

- `Ctrl+B` then `T` → New terminal tab
- `Ctrl+B` then `S` → Sessions view
- `Ctrl+B` then `O` → Overview view
- `Ctrl+B` then `,` → Settings

## What’s implemented

Core releases implemented end-to-end:

- Terminal tabs with xterm.js (create/attach/detach/kill, resize, scrollback)
- WebSocket protocol with handshake + message validation (zod)
- Claude session indexing from `~/.claude/projects/**/sessions/*.jsonl` (watcher + API + UI)
- Settings persistence + UI, and server-side safety auto-kill for detached idle terminals
- Overview page with rename/description and optional AI summary generation

## License

MIT (add your own as needed).
