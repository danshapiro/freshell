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
- Always work in a worktree (in \.worktrees\)
- Before creating a new worktree, ensure the repo-supported test suite is green on the intended base. If the suite is not green, pause before creating the worktree and notify the user with the failing command and failure summary.
- New behavior changes start on a worktree branch from `origin/main` and are submitted as PRs targeting `main`.
- Do not create or open a PR until the user explicitly approves PR creation for that branch/change. Preparing a branch, committing locally, and pushing the branch is fine; stop before `gh pr create` or any equivalent PR creation step unless approval is explicit.
- Use the `dan@danshapiro.com` account when selecting a `gh` CLI account. This is NOT a git identity: never use `dan@danshapiro.com` as a git author/committer email and never write it into `git config` — GitHub rejects pushes exposing it (GH007). Commits must use `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (the repo/global config already provides this; do not override it).
- Everything goes through a PR — never push behavior changes directly to `origin/main`.
- Merge PRs once their required checks pass, then bring `origin/main` down to local `main`. Self-merging your own PRs is the norm. The only exception is a PR the user has said needs someone else to approve it first — leave those unmerged.
- Many agents may be working in the worktree at the same time. If you see activity from other agents (for example test runs or file changes), respect it.
- Specific user instructions override ALL other instructions, including the above, and including superpowers or skills
- Server uses NodeNext/ESM; relative imports must include `.js` extensions
- Always consider checking logs for debugging; server logs (including client console logs) are in the server process stdout/stderr (e.g., `npm run dev`/`npm start`).
- Debug logging toggle (UI Settings → Debugging → Debug logging) enables debug-level logs and perf logging; keep OFF outside perf investigations.
- When adding new user-facing features or making significant UI changes, update `docs/index.html` to reflect them. It's a nonfunctional mock of the default experience, so only major changes need to be added.

## Test Coordination
- Broad repo-supported test runs wait for the shared coordinator gate; if another agent holds it, wait rather than kill a foreign holder.
- Pre-worktree green-base checks (and any broad gate intended to validate `origin/main` itself, as opposed to a branch under test) go through `scripts/base-gate.sh` (e.g. `scripts/base-gate.sh test`), which runs the command from a clean scratch worktree at `origin/main`. The main checkout accumulates untracked litter; the cloud runners treat that as a non-addressable `-dirty` image and pay a ~13 min cold rebuild every time, whereas a clean worktree uses the content-addressed commit tag — built at most once per commit and shared by every later run.
- Set `FRESHELL_TEST_SUMMARY` when you want holder/status output to show a human-meaningful reason for a broad run.
- Use `npm run test:status` to inspect the current holder, recent results, and any advisory reusable baseline.
- Use `npm run test:vitest -- ...` for a repo-owned direct Vitest path. Raw `npx vitest` is not a coordinated workflow.
- `test:unit` is the exact default-config `test/unit` workload, `test:integration` is the exact server-config `test/server` workload, and `test:server` stays watch-capable unless you pass an explicit broad `--run`.

## Destructive Test Sandbox
- Process-kill, config-corruption, and restart-storm suites run inside a disposable Docker sandbox, never directly on host: `scripts/sandbox-test.sh "<command>"` (or `npm run test:sandbox -- "<command>"`).
- See `docs/development/test-sandbox.md` for the safety guarantees, the `--corpus` read-only real-data flag, and cache-volume management.

## Amplifier Skills Deployment (machine note)
- Never symlink a git repo (or anything containing `.git`) into `~/.amplifier/skills/`. Amplifier's skill discovery walks that tree, refuses symlinks that resolve outside it, and spams "Skipping symlink that escapes repository boundary" warnings at every launch. Deploy a skill as a plain copy of its `SKILL.md` into `~/.amplifier/skills/<name>/`; keep the canonical skill in its own repo (e.g. `~/code/skill-parallel-development`) and re-copy on update.

## Kata
- `.kata.toml` is committed project configuration. Always commit it after modifying it.

## Branch Model And Self-Hosting (CRITICAL - Read This)

**Freshell no longer uses a local `dev` integration branch.**

- `main` is the only integration branch. Local `main` should track the merged state of `origin/main`.
- Author changes in dedicated `.worktrees/<slug>` worktrees on feature branches created from `origin/main`.
- Do not commit behavior changes directly to local `main` or push them directly to `origin/main`.
- When a change is ready, push the feature branch, ask the user for explicit approval to create the PR, open a PR targeting `main` only after that approval, wait for required checks, merge the PR, then update local `main` from `origin/main`.
- Update local `main` with a fast-forward pull or merge only. If local `main` has local-only commits, a dirty worktree, or cannot fast-forward, stop and resolve that explicitly instead of creating a local merge commit.
- Delete or retire obsolete local `dev` worktrees/branches after confirming they are not running the self-hosted Freshell process.

## Process Safety (CRITICAL)

- Never use broad kill patterns (for example `pkill -f "tsx watch server/index.ts"`, `pkill -f vite`, `pkill node`).
- Start manual worktree servers on a unique port and record their PID, then stop only that PID.
- Dev mode example (full hot reload — Vite client HMR + tsx-watch server): `NODE_ENV=development PORT=3344 npm run dev > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid`, then open `http://localhost:5173/?token=<AUTH_TOKEN from .env>` (Vite proxies `/api` + `/ws` to the server port).
  - `NODE_ENV=development` is required: a lingering `NODE_ENV=production` in the shell (e.g. left by `npm start`) makes `isDev` false, so the server skips the Vite path and `/` 404s on `client/index.html`.
  - Server-only hot reload (no client UI): `PORT=3344 npm run dev:server ...` instead.
- Production mode example (built dist): `PORT=3344 npm start > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid`
  - **NEVER run `node dist/server/index.js` directly** — use `npm start` which sets `NODE_ENV=production`; without it the server prints the Vite port (5173) in the startup URL even though Vite isn't running
- Example stop: `kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid`
- Before stopping any process, verify it belongs to the worktree (`ps -fp <pid>` and confirm cwd/path includes `.worktrees/...`).
- **The self-hosted Freshell server must never be restarted without explicit user approval (the word "APPROVED").** Building is fine; deploying (stop + start) is not. The user's current Freshell session depends on it, and an unapproved restart will disconnect them mid-operation. As of July 2026 the live self-hosted server is the RUST server on port 3001 (see below), not the Node server.

## Rust Server (Self-Hosted Production)

The production self-hosted Freshell is the Rust server (`target/release/freshell-server`, workspace crate `freshell-server`), running on **port 3001** from the main checkout (`.env` sets `PORT=3001`; the launcher script's built-in default is 3002, so always confirm the live port via `ls ~/.freshell/rust-server-*.pid` or `ss -tlnp`). The Node server (`npm start`) still exists but is not what the user runs day-to-day.

**Canonical launcher: `scripts/launch-rust.sh`** — use this instead of hand-rolled build/launch commands:

```bash
scripts/launch-rust.sh                 # build client + Rust server, start on port 3002
scripts/launch-rust.sh --port 3499     # any other port (e.g. testing from a worktree)
scripts/launch-rust.sh --client-only   # rebuild dist/client ONLY (no restart needed)
scripts/launch-rust.sh --skip-build    # start without rebuilding
scripts/launch-rust.sh --restart       # stop the pid-file-verified instance, then start
scripts/launch-rust.sh --stop          # stop the pid-file-verified instance
```

Key facts:

- **Client is served from disk.** The Rust server serves `dist/client` from the filesystem (SPA + fallback routing), so `--client-only` + a browser hard-refresh deploys client-side changes **without a server restart** (and therefore without needing "APPROVED"). Server-side (Rust) changes DO require a restart.
- **Restarting the live 3001 server still requires the user's explicit "APPROVED"** — `--restart`/`--stop` exist for approved deploys and for scratch instances on other ports, not as a license to bounce production.
- The script is safe by construction: it only ever kills PIDs from its own pid file, after verifying the process is this repo's `freshell-server` binary (cwd + args match); if the port is held by anything else it refuses. Logs go to `~/.freshell/logs/rust-server-<port>.log`, pid to `~/.freshell/rust-server-<port>.pid`.
- The server loads `.env` from its cwd (env vars win over the file) and refuses to start without `AUTH_TOKEN`. Note `.env`'s `PORT` may differ from the live port — the launcher passes `PORT` explicitly.
- The startup log line self-identifies the binary that produced it: `[<ISO-8601 UTC timestamp>] freshell-server listening on http://0.0.0.0:<port> (ws://0.0.0.0:<port>/ws) [pid <pid>] [commit <sha>] [dirty <true|false|unknown>]`. Use it (or `~/.freshell/logs/rust-server-3001.log`) to check what the running server was built from when asking "are we running change X?".
- Health check: `curl http://127.0.0.1:<port>/api/health` (unauthenticated, rate-limit exempt).
- **Detached launch:** `scripts/launch-rust.sh` starts the server in its own
  session (`setsid`, stdin from `/dev/null`). Closing the launching shell
  does NOT stop the server or its child agent terminals (this fixed the
  SIGTERM/SIGHUP cascades visible as `shutdown_forensics` events). Stop it
  only via `scripts/launch-rust.sh --stop [--port N]`. CAVEAT: WSL2 shuts
  the whole VM down shortly after the LAST console/interop handle closes —
  no launcher-side detachment survives that.
- **systemd user unit (recommended for unattended operation):** install
  `installers/systemd/freshell-rust.service` (see its header for the
  `/etc/wsl.conf` requirement and `loginctl enable-linger`). It cannot keep
  the WSL VM alive either, but it restores the server at the next distro
  boot and supervises restarts. systemd is NOT required — the setsid
  launcher remains the default, dependency-free path.

## Codex Agent in CMD Instructions (Codex agents only; only when running in CMD on windows; all other agents must ignore)
- Prefer bash/WSL over PowerShell; Windows paths map like `D:\\...` -> `/mnt/d/...`.
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
# `npm run serve` prompts before serving from a non-main branch; use
# `FRESHELL_ALLOW_NON_MAIN_SERVE=1 npm run serve` only when intentional.
# Note: `npm run build` is guarded — it will refuse to overwrite dist/
# if a production server is detected on the configured PORT. Use
# `npm run check` for safe verification, or build from a worktree.
```

**On WSL machines, "the desktop app" means the Windows app.** Always build, install, and launch the Windows Electron app (`npm run electron:build:win` + the NSIS installer) — never a Linux AppImage/deb under WSLg. The Windows build must run as a native Windows process (WSL cannot compile `node-pty` for win32); drive it from WSL by rsyncing to a Windows-local dir and running Windows npm via `cmd.exe` — see [docs/development/windows-electron-build.md](docs/development/windows-electron-build.md).

### Testing
Backend fallback policy: never silently fall back from the configured cloud test backend to local — if the cloud path fails, fix it; a local-backend run may substitute only when the cloud path cannot be fixed AND the user explicitly approves.

```bash
npm test                    # Coordinated full suite (default + server configs)
npm run check               # Typecheck, then coordinated full suite
npm run verify              # Build, then coordinated full suite
npm run test:coverage       # Coordinated default-config coverage run
npm run test:status         # Show active holder, latest results, and advisory baseline info
npm run test:vitest -- ...  # Repo-owned direct Vitest path for focused passthrough work
```

External provider contract tests (`test/integration/real/`) spawn real `claude`, `codex`, and `opencode` binaries to verify external provider behavior, not Freshell code. They are opt-in and skipped by default to avoid blocking the coordinated suite on environment-dependent flakiness:
```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- \
  run test/integration/real/ --config config/vitest/vitest.server.config.ts
```

### Vitest Test Backend (Cloud Run Jobs)

Vitest unit/server test suites can run locally or on Google Cloud Run Jobs. The `FRESHELL_VITEST_BACKEND` environment variable controls the default:
- **Unset or `"local"`**: run locally (the safe default for new clones)
- **`"cloud"`**: run on Cloud Run Jobs (4 shards, ~2-3 min wall time vs ~5 min local, ~$0.02/run)

```bash
npm run test:cloud          # Run vitest on Cloud Run Jobs (client + server suites)
npm run test:cloud:build    # Build and push the Docker image to Artifact Registry
```

**If `FRESHELL_VITEST_BACKEND` is not set, ask the user which way to set it** before running cloud vitest tests. Explain that cloud is faster (parallel shards, ~2-3 min vs ~5 min) but is a paid Google Cloud service (~$0.02/run); local is free but slower. Once the user chooses, set it permanently in their `~/.bashrc` (or equivalent) so agents don't need to ask again.

**Note:** The electron suite always runs locally even in cloud mode (it needs a display and native modules not available in the container).

**Identity:** cloud lanes never require an interactive `gcloud auth login`.
They resolve a gcloud identity lazily, in this order: `--account=` flag >
`FRESHELL_GCP_ACCOUNT` > `GCLOUD_IDENT` > gcloud-robot probe (needs
`GCLOUD_ROBOT_HOME`, the installed gcloud-robot skill directory) > ambient
gcloud (with a one-line stderr note). Provisioning, rotation, and revocation
live in [docs/development/gcloud-robot.md](docs/development/gcloud-robot.md).
`GCLOUD_ROBOT_REQUIRE=1` fails closed when no robot identity resolves.

### E2E Test Backend (Cloud Run Jobs)

Playwright e2e tests can run locally or on Google Cloud Run Jobs. The `FRESHELL_E2E_BACKEND` environment variable controls the default:
- **Unset or `"local"`**: run locally (the safe default for new clones)
- **`"cloud"`**: run on Cloud Run Jobs (4 shards, ~2-3 min wall time vs ~28 min local, ~$0.03/run)

```bash
npm run test:e2e            # Uses FRESHELL_E2E_BACKEND (default: local)
npm run test:e2e:local      # Force local
npm run test:e2e:cloud      # Force cloud
```

**If `FRESHELL_E2E_BACKEND` is not set, ask the user which way to set it** before running e2e tests. Explain that cloud is much faster (parallel shards, ~2-3 min vs ~28 min) but is a paid Google Cloud service (~$0.03/run); local is free but slower. Once the user chooses, set it permanently in their `~/.bashrc` (or equivalent) so agents don't need to ask again.

**Before filing any PR, ensure the affected e2e specs actually pass on the configured `FRESHELL_E2E_BACKEND` backend** — a spec sitting in `CLOUD_SKIP_SPECS` (`test/e2e-browser/playwright.cloud.config.ts`) or a filter that matched no tests is not coverage.

**Identity:** cloud lanes never require an interactive `gcloud auth login`.
They resolve a gcloud identity lazily, in this order: `--account=` flag >
`FRESHELL_GCP_ACCOUNT` > `GCLOUD_IDENT` > gcloud-robot probe (needs
`GCLOUD_ROBOT_HOME`, the installed gcloud-robot skill directory) > ambient
gcloud (with a one-line stderr note). Provisioning, rotation, and revocation
live in [docs/development/gcloud-robot.md](docs/development/gcloud-robot.md).
`GCLOUD_ROBOT_REQUIRE=1` fails closed when no robot identity resolves.

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

**PTY Lifecycle:** Each terminal has a unique ID. Server maintains 64KB scrollback buffer. On attach, client receives buffer snapshot then streams new output. On detach, process continues running (background session). Configurable idle timeout (15 mins default).

**Claude Session Discovery:** Watches `~/.claude/projects/*/sessions/*.jsonl` for new files. Parses JSONL streams to extract messages, groups by project path.

**Redux State Management:** Slices for tabs, panes, connection, sessions, settings, claude. Persist middleware saves tabs and panes to localStorage. Async thunks for API calls.

**Configuration Persistence:** User config stored at `~/.freshell/config.json`. Atomic writes with temp file + rename. Settings changes POST to `/api/settings` and broadcast via WebSocket.

**Pane System:** Tabs contain pane layouts (tree structure of splits). Each pane owns its terminal lifecycle via `createRequestId` and `terminalId`. When splitting panes, each new pane gets its own `createRequestId`, ensuring independent backend terminals. Pane content types: `terminal` (with mode, shell, status) and `browser` (with URL, devtools state).

**Agent Status Indicators:** Blue/busy status is derived from provider activity slices through `resolvePaneActivity`; green/needs-attention and the idle sound flow through `recordTurnComplete` and `useTurnCompletionNotifications`. Turn-complete (green/sound) is server-authoritative everywhere: terminal CLIs via `terminal.turn.complete`, and fresh-agent panes (freshclaude/kilroy/freshcodex/freshopencode) via a discrete `freshAgent.turn.complete` edge emitted only on a positive completion — freshclaude/kilroy on the SDK `result` with `subtype === 'success'`, freshopencode on the success-only `emitStatus(idle)` path, and freshcodex on `turn/completed` only when `params.turn.status === 'completed'` (the notification also fires on interrupt). The client folds it in via `applyFreshAgentCompletion` using the `at`-monotonic dedupe regime (wall-clock `at`, no per-session counter, so a resumed durable session can't swallow completions across a server restart). The waiting-for-approval edge is ALSO server-authoritative: the Claude/kilroy `SdkBridge` emits a discrete `freshAgent.turn.waiting` edge on the 0→≥1 pending permission/question transition (only Claude/kilroy raise approvals/questions), and the client folds it in via `applyFreshAgentWaiting` under a distinct `${provider}:${sessionId}#waiting` dedupe namespace so it can never poison (or be poisoned by) the turn-complete bucket. The fragile client-side busy→idle derivation AND the client-side waiting-edge hook (`useAgentSessionTurnCompletion`) were both removed — all green/sound edges are now server-emitted. freshcodex additionally self-heals a crashed/disconnected codex sidecar by consuming the runtime `onExit` hook in `subscribe()`, emitting `sdk.status:'exited'` to clear BLUE (no chime — a crash is not a positive completion). `freshopencode` still runs on a shared long-lived `opencode serve` sidecar and uses server-pushed `session.idle`/`session.status` events to drive busy. Gemini and Kimi terminal modes are status-in... [truncated] Separately, the sidebar shows cross-device remote status rings around a session row's icon: a green ring means the session is open on another device, a blue ring means it is busy on another device (blue wins over green), and rings are suppressed entirely when the session is open on this device (derived from `tabs.sync` registry snapshots — producing clients stamp pane payloads with `sessionKeys`/`busySessionKeys`, consumers re-query remote snapshots on a 30s interval, and the server partitions same-device records into `sameDeviceOpen`, which never produces rings).

**Fresh-Agent Orchestration:** The REST agent API (`/api/tabs`, `/api/panes/:id/split`, `/api/panes/:id/send-keys`, `/api/panes/:id/capture`, `/api/panes/:id/wait-for`) and the MCP `freshell` tool accept `agent`/`model`/`effort` parameters to create and drive fresh-agent panes (e.g. `agent=opencode`). The orchestration layer dispatches to the registered `FreshAgentRuntimeManager`, so the same external surface works for any fresh-agent provider. On MCP `new-tab`, resume sugar (`resume`/`resumeSessionId`) is honored for `agent: "opencode"` (Rust server). Agent-resume via `sessionRef` is NOT supported for claude/codex/kilroy agents (the Rust server rejects it with a 400; the Node server silently ignores it) — use an explicit `sessionRef` on MODE panes where that path supports it.

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

## Subagent polling policy

When idle-waiting on subagents, always call `wait_agent` with `timeout_ms=3600000` (the 1-hour maximum). `wait_agent` wakes immediately on any subagent message or completion, so long timeouts add no latency — but every wait return (including a no-op timeout) costs a full model turn that re-sends the entire context. Never poll on shorter timeouts. Have workers `send_message` to `/root` at milestones so the parent wakes exactly when there is news.
