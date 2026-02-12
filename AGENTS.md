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
- Always check for and use applicable skills
- This project uses the [superpowers](https://github.com/obra/superpowers) plugin (configured in `.claude/settings.json`). Skills like `superpowers:executing-plans` are referenced throughout plan docs in `docs/plans/`.
- Always work in a worktree (in \.worktrees\)
- Specific user instructions override ALL other instructions, including the above, and including superpowers or skills
- Server uses NodeNext/ESM; relative imports must include `.js` extensions
- Always consider checking logs for debugging; server logs (including client console logs) are in the server process stdout/stderr (e.g., `npm run dev`/`npm start`).
- Debug logging toggle (UI Settings → Debugging → Debug logging) enables debug-level logs and perf logging; keep OFF outside perf investigations.

## Merging to Main (CRITICAL - Read This)

**You are running inside Freshell right now. This session, the terminal you're typing in, is served by the main branch. If you break main, you kill yourself mid-operation and the user has to clean up your mess with a separate agent.**

- Never run `git merge` directly on main - merge conflicts write `<<<<<<< HEAD` markers into source files, which crashes the server instantly
- Always merge main INTO the feature branch in the worktree first, resolve any conflicts there
- Before fast-forwarding main, run `npm test` and confirm all tests pass (not just related tests)
- If you find failing tests, you must stop everything to understand them and make improvements, even if you do not think you were responsible for them.
- Then fast-forward main: `git merge --ff-only feature/branch` - this is atomic (pointer move, no intermediate states)
- If `--ff-only` fails, go back to the worktree and rebase/merge until it can fast-forward

## Codex Agent in CMD Instructions (Codex agents only; only when running in CMD on windows; all other agents must ignore)
- Prefer bash/WSL over PowerShell; Windows paths map like `D:\...` -> `/mnt/d/...`.
- Use `bash -lc "<cmd>"` for non-interactive commands; avoid interactive shells so commands return control.
- Apply_patch expects Windows-style paths.
- If a bash command produces no visible output, rerun with `tty: true` to force output.
- PowerShell may hang for dozens of seconds before starting in this tool; stick to bash unless explicitly required.
- Don't make silly mistakes like installing Linux binaries in node_modules when we're on windows

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
npm run serve               # Build and run production server
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

**Redux State Management:** Slices for tabs, panes, connection, sessions, settings, claude. Persist middleware saves tabs and panes to localStorage. Async thunks for API calls.

**Configuration Persistence:** User config stored at `~/.freshell/config.json`. Atomic writes with temp file + rename. Settings changes POST to `/api/settings` and broadcast via WebSocket.

**Pane System:** Tabs contain pane layouts (tree structure of splits). Each pane owns its terminal lifecycle via `createRequestId` and `terminalId`. When splitting panes, each new pane gets its own `createRequestId`, ensuring independent backend terminals. Pane content types: `terminal` (with mode, shell, status) and `browser` (with URL, devtools state).

### Data Flow

1. Browser loads → fetches settings from `/api/settings` and sessions from `/api/sessions`
2. WebSocket connects → client sends `hello` with auth token → server sends `ready`
3. Terminal creation → Pane content has `createRequestId` → UI sends `terminal.create` WS message with that ID → server spawns PTY → sends back `terminal.created` with `terminalId` → pane content updated
4. Terminal I/O → `terminal.input` WS messages write to PTY stdin → stdout/stderr streams to attached clients

## Accessibility (A11y) Requirements

All components **must** be accessible for browser-use automation and WCAG compliance:

**Semantic HTML:**
- Use `<button>`, `<a>`, `<input>`, `<label>` for interactive elements (not div with onClick)
- Use semantic headers (`<h1>`-`<h6>`), nav, main, aside
- Use proper form structure with labels associated to controls

**ARIA & Labels:**
- Icon-only buttons: `aria-label="Description"` or `<span className="sr-only">`
- Clickable cards/tiles: `role="button"` + `aria-label`
- Custom components: appropriate roles and ARIA props
- Complex widgets: `aria-expanded`, `aria-pressed`, `aria-selected` where applicable

**Browser-use Requirements:**
- All interactive elements must be indexable (semantic HTML or proper roles)
- All interactive elements must be identifiable (visible text or aria-label)
- Never rely on selectors for automation; fix accessibility instead

**Linting:**
- Run `npm run lint` to check a11y violations (eslint-plugin-jsx-a11y)
- Fix with `npm run lint:fix` for auto-fixable issues
- A11y linting is CI requirement before merging

## Path Aliases

- `@/` → `src/`
- `@test/` → `test/`
