## Project Overview

Freshell is a self-hosted, browser-accessible terminal multiplexer and session organizer. It provides multi-tab terminal management with support for terminals and coding CLI's like Claude Code and Codex. Key features include session history browsing, AI-powered summaries (via Google Gemini), and remote access over LAN/VPN with token-based authentication.

## Development Philosophy
- We are working on an infinite schedule with infinite tokens. This is unusual! We do not have time pressure, and can do things correctly.
- We use Red-Green-Refactor TDD for all changes but the most trivial (e.g. doc changes). We never skip the tests, and never skip the refactor.
- We ensure both unit test & e2e coverage of everything.
- Before starting anything, think - what's the most idiomatic solution for the technology we're using?
- We prefer clean architecture and correctness over small patches.
- We fix the system over the symptom.

## Repo Rules
- Always work in a worktree

## Commands

### Development
```bash
npm run dev                 # Run client + server concurrently with hot reload
npm run dev:client          # Vite dev server only (port 5173)
npm run dev:server          # Node with tsx watch for server auto-reload
```

### Building
```bash
npm run build               # Full build (client + server)
npm run build:client        # Vite build → dist/client
npm run build:server        # TypeScript compile → dist/server
```

### Testing
```bash
npm test                    # Run all tests (client + server)
npm run test:coverage       # Generate coverage report
```

## Architecture

### Tech Stack
- **Frontend:** React 18, Redux Toolkit, Vite, Tailwind CSS, shadcn/ui, xterm.js, Zod
- **Backend:** Node.js/Express, node-pty, WebSocket (ws), Chokidar, Vercel AI SDK + Google Generative AI
- **Testing:** Vitest, Testing Library, supertest, superwstest

### Directory Structure
- `src/` - React frontend application
  - `components/` - UI components (TabBar, Sidebar, TerminalView, HistoryView, etc.)
  - `store/` - Redux slices (tabs, connection, sessions, settings, claude)
  - `lib/` - Utilities (api.ts, claude-types.ts)
- `server/` - Node.js/Express backend
  - `index.ts` - HTTP/REST routes and server entry
  - `ws-handler.ts` - WebSocket protocol handler
  - `terminal-registry.ts` - PTY lifecycle management
  - `claude-session.ts` - Claude session discovery & indexing
  - `claude-indexer.ts` - File watcher for ~/.claude directory
- `test/` - Test suites organized by unit/integration and client/server

### Key Architectural Patterns

**WebSocket Protocol:** Schema-validated messages using Zod. Handshake flow: client sends `hello` with token → server validates → sends `ready`. Message types include `terminal.create/input/resize/detach/attach` and broadcasts like `sessions.updated`.

**PTY Lifecycle:** Each terminal has a unique ID. Server maintains 64KB scrollback buffer. On attach, client receives buffer snapshot then streams new output. On detach, process continues running (background session). Configurable idle timeout (180 mins default).

**Claude Session Discovery:** Watches `~/.claude/projects/*/sessions/*.jsonl` for new files. Parses JSONL streams to extract messages, groups by project path.

**Redux State Management:** Slices for tabs, connection, sessions, settings, claude. Persist middleware saves tabs to localStorage. Async thunks for API calls.

**Configuration Persistence:** User config stored at `~/.freshell/config.json`. Atomic writes with temp file + rename. Settings changes POST to `/api/settings` and broadcast via WebSocket.

### Data Flow

1. Browser loads → fetches settings from `/api/settings` and sessions from `/api/sessions`
2. WebSocket connects → client sends `hello` with auth token → server sends `ready`
3. Terminal creation → UI sends `terminal.create` WS message → server spawns PTY → sends back `terminal.created` with initial snapshot
4. Terminal I/O → `terminal.input` WS messages write to PTY stdin → stdout/stderr streams to attached clients

## Path Aliases

- `@/` → `src/`
- `@test/` → `test/`
