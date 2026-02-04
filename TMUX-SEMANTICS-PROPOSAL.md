# Freshell Agent API: tmux-Compatible Semantics

## 1. Background & Motivation

AI coding agents (Claude Code, Codex, Devin, etc.) have converged on **tmux as their
standard interface for terminal multiplexing**. When agents need to run background
processes, monitor servers, orchestrate sub-agents, or manage multiple workstreams,
they reach for tmux commands via their Bash tool.

The ecosystem includes:

- **Direct tmux usage**: Agents call `tmux send-keys`, `tmux capture-pane`, etc.
  through their Bash tool when running inside a tmux session.
- **MCP servers**: Tools like `claude-tmux`, `nickgnd/tmux-mcp`, `lox/tmux-mcp-server`,
  and `t-pane` wrap tmux commands in structured tool interfaces.
- **Orchestration frameworks**: `claude-code-tools`, `codex-orchestrator`,
  `aws-cli-agent-orchestrator`, and `multi-agent-shogun` all build on tmux for
  multi-agent coordination.
- **Claude Code's built-in TeammateTool**: Uses tmux as a spawn backend when
  available, creating panes/windows in a `claude-swarm` session.

Freshell already provides everything tmux does—persistent terminals, panes, tabs,
scrollback buffers, remote access—plus features tmux lacks (browser panes, editor
panes, AI session indexing, rich UI). But agents can't use any of it, because
Freshell doesn't speak the language agents know.

**Goal**: Provide a CLI tool (`freshell`) that agents can use with tmux-like
semantics, so any agent that knows how to use tmux can use Freshell instead—while
also exposing Freshell-unique capabilities that tmux can't offer.

---

## 2. Conceptual Model Mapping

### tmux → Freshell Concept Translation

| tmux Concept | Freshell Equivalent | Notes |
|---|---|---|
| **Server** | Freshell server process | Already persistent, already multiplexing |
| **Session** | The Freshell server itself | tmux sessions are named groups of windows; Freshell is a single always-on session. We flatten this: all tabs are in one "session." |
| **Window** | **Tab** | A named container. Each tab has a pane layout. |
| **Pane** | **Pane** | A leaf in the pane tree. Can be terminal, browser, or editor. |
| **Client** | Browser tab / WebSocket connection | Multiple clients can attach to the same Freshell instance |

### Why Flatten Sessions

tmux's multi-session model exists because tmux is a system utility shared by
multiple users and use cases. Freshell is a single-user application. The "session"
layer adds complexity without value. Instead:

- `tmux new-session -s work` → `freshell new-tab -n work` (a new tab)
- `tmux list-sessions` → `freshell list-tabs`
- `tmux attach -t work` → `freshell select-tab -t work`

If multi-session support becomes needed later, it can be added as a grouping layer
on top of tabs without breaking the command interface.

---

## 3. Command Mapping: tmux → freshell

### 3.1 Session/Window Management (→ Tab Management)

| tmux Command | freshell Command | Behavior |
|---|---|---|
| `tmux new-session -d -s NAME` | `freshell new-tab -n NAME [-d]` | Create a new tab with a shell pane. `-d` creates without switching to it. Returns tab ID. |
| `tmux new-window -t SESSION` | `freshell new-tab [-n NAME]` | Create a new tab (tabs replace windows). |
| `tmux kill-session -t NAME` | `freshell kill-tab -t NAME` | Close tab and kill all its terminals. |
| `tmux kill-window -t SESSION:WINDOW` | `freshell kill-tab -t ID` | Same as above (windows = tabs). |
| `tmux list-sessions` | `freshell list-tabs` | List all tabs with IDs, titles, status, pane count. |
| `tmux list-windows -t SESSION` | `freshell list-tabs` | Same (flattened model). |
| `tmux select-window -t SESSION:WINDOW` | `freshell select-tab -t ID\|NAME` | Switch to tab by ID or name. |
| `tmux rename-window NAME` | `freshell rename-tab -t ID NAME` | Rename a tab. |
| `tmux rename-session NAME` | `freshell rename-tab -t ID NAME` | Same (flattened). |
| `tmux has-session -t NAME` | `freshell has-tab -t NAME` | Exit 0 if tab exists, 1 otherwise. |
| `tmux next-window` | `freshell next-tab` | Switch to next tab. |
| `tmux previous-window` | `freshell prev-tab` | Switch to previous tab. |

### 3.2 Pane Management

| tmux Command | freshell Command | Behavior |
|---|---|---|
| `tmux split-window -h` | `freshell split-pane [-t PANE]` | Split active (or specified) pane. Direction follows Freshell's layout algorithm. (See §3.2.1.) |
| `tmux split-window -v` | `freshell split-pane [-t PANE]` | Same command—Freshell chooses optimal direction. |
| `tmux list-panes [-t TAB]` | `freshell list-panes [-t TAB]` | List panes in active or specified tab. Shows pane ID, type (terminal/browser/editor), terminal ID, status, dimensions. |
| `tmux select-pane -t PANE` | `freshell select-pane -t PANE` | Set active pane. |
| `tmux kill-pane -t PANE` | `freshell kill-pane -t PANE` | Close pane (kills its terminal). |
| `tmux resize-pane -t PANE -x W -y H` | `freshell resize-pane -t PANE [-x W] [-y H]` | Resize pane (percentage-based, since Freshell uses flex layout). |
| `tmux swap-pane -s SRC -t DST` | `freshell swap-pane` | Swap the two panes in the current split. |
| `tmux display-panes` | N/A | No equivalent needed (panes are always visible in the UI). |

#### 3.2.1 Split Direction

tmux has explicit `-h` (horizontal) and `-v` (vertical) split flags. Freshell's
pane layout algorithm automatically chooses direction based on pane count and
available space. The `freshell split-pane` command does **not** guarantee a specific
direction.

**Proposed**: Accept optional `-h`/`-v` flags for forward compatibility, but
initially both map to Freshell's default split behavior. A future enhancement
can honor the requested direction when feasible.

### 3.3 Terminal I/O (The Critical Path for Agents)

| tmux Command | freshell Command | Behavior |
|---|---|---|
| `tmux send-keys -t TARGET "text" Enter` | `freshell send-keys -t PANE "text" Enter` | Send keystrokes to a pane's terminal. `Enter`, `C-c`, `C-d`, `Escape`, `Tab`, `Up`, `Down`, etc. are translated to control sequences. |
| `tmux send-keys -t TARGET -l "literal"` | `freshell send-keys -t PANE -l "literal"` | Send literal text (no key translation). |
| `tmux capture-pane -p -t TARGET` | `freshell capture-pane -t PANE` | Print pane's visible content to stdout. |
| `tmux capture-pane -p -t TARGET -S -200` | `freshell capture-pane -t PANE -S -200` | Capture last 200 lines of scrollback. |
| `tmux capture-pane -p -J -t TARGET -S -` | `freshell capture-pane -t PANE -S - [-J]` | Full scrollback, optionally joining wrapped lines. |

#### 3.3.1 send-keys Semantics (Critical)

The `send-keys` command is the most important interface for agents. tmux has a
well-known race condition where `Enter` can be lost if sent too quickly after text.
Freshell's WebSocket protocol doesn't have this issue (input is queued server-side),
but the CLI must match tmux's argument conventions exactly.

**Key name translation table:**

| Key Name | Bytes Sent | tmux Equivalent |
|---|---|---|
| `Enter` | `\r` | `Enter` |
| `C-c` | `\x03` | `C-c` |
| `C-d` | `\x04` | `C-d` |
| `C-z` | `\x1a` | `C-z` |
| `C-l` | `\x0c` | `C-l` |
| `C-a` | `\x01` | `C-a` |
| `Escape` / `C-[` | `\x1b` | `Escape` |
| `Tab` | `\t` | `Tab` |
| `BSpace` | `\x7f` | `BSpace` |
| `Up` | `\x1b[A` | `Up` |
| `Down` | `\x1b[B` | `Down` |
| `Right` | `\x1b[C` | `Right` |
| `Left` | `\x1b[D` | `Left` |
| `Space` | ` ` | `Space` |

**Behavior**: Each argument is processed left-to-right. Plain strings are sent as
literal UTF-8 bytes. Recognized key names (case-sensitive) are translated to their
control sequences. This matches tmux's behavior.

#### 3.3.2 capture-pane Output

Freshell's terminal registry maintains a 64KB scrollback buffer per terminal. The
`capture-pane` command reads from this buffer via a new REST endpoint.

**Flags:**

| Flag | Behavior |
|---|---|
| `-p` | Print to stdout (default, always on—there's no paste buffer) |
| `-t PANE` | Target pane (default: active pane in active tab) |
| `-S LINES` | Start from LINES before current position. `-S -` = full scrollback. Default: visible area only. |
| `-J` | Join wrapped lines (strip soft line breaks from terminal width wrapping) |
| `-e` | Include ANSI escape sequences (default: strip them) |

### 3.4 Terminal Lifecycle

| tmux Command | freshell Command | Behavior |
|---|---|---|
| `tmux respawn-pane -t PANE` | `freshell respawn-pane -t PANE` | Kill current terminal in pane and start a new one. |
| N/A | `freshell list-terminals` | List all terminals (including detached/background). Maps to `GET /api/terminals`. |
| N/A | `freshell attach -t TERMINAL` | Attach a background terminal to the active pane. |

### 3.5 Introspection & Display

| tmux Command | freshell Command | Behavior |
|---|---|---|
| `tmux display-message -p '#S'` | `freshell display -p '#{tab_name}'` | Print tab name. |
| `tmux display-message -p '#I'` | `freshell display -p '#{tab_id}'` | Print tab ID. |
| `tmux display-message -p '#P'` | `freshell display -p '#{pane_id}'` | Print active pane ID. |
| `tmux display-message -p '#{pane_current_command}'` | `freshell display -p '#{pane_mode}'` | Print pane mode (shell/claude/codex/etc). |
| `tmux display-message -p '#{pane_pid}'` | `freshell display -p '#{terminal_id}'` | Print pane's terminal ID. |
| N/A | `freshell display -p '#{pane_type}'` | Print pane type (terminal/browser/editor). |

### 3.6 Commands Without Direct Mapping

These tmux commands have no exact Freshell equivalent. Proposed alternatives:

| tmux Command | Status | Proposal |
|---|---|---|
| `tmux attach-session` | **Not applicable** | Freshell is always "attached" (browser-based). No action needed. |
| `tmux detach-client` | **Not applicable** | Agents don't detach from Freshell (they're using CLI, not a GUI session). |
| `tmux copy-mode` | **Not needed** | Scrollback is accessed via `capture-pane`. |
| `tmux set-option` | **Deferred** | Could map to `PATCH /api/settings` for server-wide settings. |
| `tmux bind-key` / `unbind-key` | **Not applicable** | Freshell keybindings are in the browser UI, not relevant to agents. |
| `tmux source-file` | **Not applicable** | No config file to source. |
| `tmux command-prompt` | **Not applicable** | Interactive prompts don't apply to CLI usage. |
| `tmux clock-mode` | **Not applicable** | Novelty. |
| `tmux pipe-pane` | **Deferred** | Could be useful for logging terminal output to a file. Worth considering. |
| `tmux wait-for` | **See §4.2** | Freshell can offer a better version. |
| `tmux run-shell` | **Not needed** | Agents already have Bash. |

---

## 4. Freshell-Unique Features (Beyond tmux)

These are capabilities Freshell offers that tmux cannot. They follow the same CLI
conventions so agents familiar with tmux will find them natural.

### 4.1 Browser Panes

```bash
# Open a URL in a pane
freshell open-browser -t PANE "https://localhost:3000"

# Open a URL in a new pane (splitting current)
freshell split-pane --browser "https://localhost:3000"

# Open a URL in a new tab
freshell new-tab --browser "https://localhost:3000" -n "Dev Server"

# Get current URL of a browser pane
freshell display -p '#{pane_url}' -t PANE

# Navigate browser pane to new URL
freshell navigate -t PANE "https://localhost:3000/admin"
```

This is a first-class feature no tmux-based tool can offer. Agents that need to
verify web UI behavior (e.g., "open the app and check if the login form renders")
can do so programmatically.

### 4.2 Wait-for-Output (Better than `tmux wait-for`)

tmux's `wait-for` is a channel-based synchronization primitive—useful but low-level.
Freshell can offer output-aware waiting.

```bash
# Wait until pane output matches a pattern (regex)
freshell wait-for -t PANE -p "Server listening on port" [-T 30]

# Wait until pane output stabilizes (no new output for N seconds)
freshell wait-for -t PANE --stable 5 [-T 60]

# Wait until terminal exits
freshell wait-for -t PANE --exit [-T 120]

# Wait until prompt is detected (shell returns to prompt)
freshell wait-for -t PANE --prompt [-T 30]
```

**Flags:**
- `-t PANE` — target pane
- `-p PATTERN` — regex pattern to match against output
- `-T TIMEOUT` — timeout in seconds (default: 30). Exit code 1 on timeout.
- `--stable N` — wait until output hasn't changed for N seconds
- `--exit` — wait until the terminal process exits
- `--prompt` — wait until a shell prompt is detected (heuristic)

This directly addresses the #1 reliability problem in agent-tmux interactions:
**completion detection**. Instead of crude `sleep 90` or polling with
`capture-pane`, agents can use a single blocking call.

### 4.3 Coding CLI Integration

```bash
# Start a Claude Code session in a new tab
freshell new-tab --claude [-n NAME] [--cwd DIR] [--prompt "initial prompt"]

# Start a Codex session
freshell new-tab --codex [-n NAME] [--cwd DIR]

# Start any supported coding CLI
freshell new-tab --coding-cli PROVIDER [-n NAME]

# Resume a previous coding CLI session
freshell new-tab --claude --resume SESSION_ID

# List coding CLI sessions (not just terminals)
freshell list-sessions [--provider claude|codex]

# Search session history
freshell search-sessions "authentication bug fix"
```

### 4.4 Editor Panes

```bash
# Open a file in an editor pane
freshell split-pane --editor "/path/to/file.ts"

# Open a file in a new tab
freshell new-tab --editor "/path/to/file.ts" -n "config"

# Read file content from editor pane
freshell display -p '#{pane_file}' -t PANE
```

### 4.5 AI Summaries

```bash
# Get an AI summary of a terminal's recent output
freshell summarize -t PANE

# Get a summary of a coding CLI session
freshell summarize --session SESSION_ID
```

### 4.6 Server Info

```bash
# Health check
freshell health

# Get LAN IP addresses (for sharing access)
freshell lan-info

# Get server URL
freshell display -p '#{server_url}'
```

### 4.7 Multi-Pane Run (Orchestration Primitive)

```bash
# Run a command in a new pane and wait for it to complete
freshell run -n "tests" "npm test"

# Run in background (new tab, don't switch to it)
freshell run -d -n "server" "npm run dev"

# Run and capture output (blocking, returns stdout)
freshell run --capture "npm test" [-T 120]
```

This combines `new-tab` + `send-keys` + `wait-for --exit` + `capture-pane` into a
single command. It's the pattern agents use most frequently, packaged as a
first-class operation.

---

## 5. Target Addressing

### tmux Target Format

tmux uses `session:window.pane` addressing:
```
my-session:0.0     # session "my-session", window 0, pane 0
:1.2               # current session, window 1, pane 2
```

### Freshell Target Format

Since sessions are flattened, Freshell uses `tab.pane` or just `pane`:

```
-t my-tab.0        # tab named "my-tab", pane 0
-t my-tab           # tab named "my-tab", active pane
-t .0               # active tab, pane 0
-t 0                # active tab, pane 0 (shorthand)
-t abc123           # pane by unique ID (unambiguous)
```

**Resolution rules** (in order):
1. If target matches a pane ID exactly → that pane
2. If target contains `.` → split as `tab.pane` (tab by name or index, pane by index)
3. If target is numeric → pane index in active tab
4. If target matches a tab name → active pane in that tab
5. If target matches a tab ID → active pane in that tab

For backward compatibility with agents that use tmux's `session:window.pane` format,
the parser also accepts colons: `session:window.pane` → ignore session, use window
as tab name, pane as pane index.

---

## 6. Implementation Architecture

### 6.1 CLI Tool (`freshell`)

A standalone Node.js CLI script (or compiled binary via `pkg`/`bun compile`). It
communicates with the Freshell server over its existing REST API and WebSocket
protocol.

```
┌──────────────┐     HTTP/WS      ┌──────────────────┐
│  freshell    │ ◄──────────────► │  Freshell Server  │
│  CLI tool    │                  │  (already running) │
└──────────────┘                  └──────────────────────┘
```

**Discovery**: The CLI finds the server via:
1. `FRESHELL_URL` environment variable
2. `FRESHELL_TOKEN` environment variable
3. `~/.freshell/cli.json` config file (written by server on startup)
4. Default: `http://localhost:3000`

### 6.2 New REST Endpoints Required

The existing REST API covers settings and sessions but lacks terminal control.
New endpoints needed:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/tabs` | GET | List all tabs with pane info |
| `/api/tabs` | POST | Create a new tab |
| `/api/tabs/:id` | DELETE | Kill tab and its terminals |
| `/api/tabs/:id/select` | POST | Switch active tab |
| `/api/panes` | GET | List all panes (or panes for a tab) |
| `/api/panes/:id/split` | POST | Split a pane |
| `/api/panes/:id/close` | POST | Close a pane |
| `/api/panes/:id/select` | POST | Set active pane |
| `/api/panes/:id/send-keys` | POST | Send input to pane's terminal |
| `/api/panes/:id/capture` | GET | Capture pane output |
| `/api/panes/:id/wait-for` | GET | Long-poll until condition met |
| `/api/panes/:id/navigate` | POST | Navigate browser pane |
| `/api/run` | POST | Create tab + send command + wait |

Most of these are thin wrappers around existing WebSocket messages and Redux
actions. The WebSocket protocol already supports `terminal.create`,
`terminal.input`, `terminal.attach`, etc. The REST endpoints formalize these
as stateless request/response operations.

### 6.3 Scrollback Buffer Access

`capture-pane` requires reading the terminal scrollback buffer. Currently, the
buffer is only sent as a snapshot on `terminal.attach`. A new endpoint exposes it
directly:

```
GET /api/terminals/:id/buffer?start=-200&join=true&strip_ansi=true
```

This reads from the existing 64KB ring buffer in `TerminalRegistry`.

### 6.4 MCP Server (Optional, Complementary)

In addition to the CLI tool, an MCP server can expose the same operations as
structured tools. This lets agents use Freshell through their native tool interface
rather than Bash.

```json
{
  "tools": [
    {"name": "freshell_new_tab",      "description": "Create a new tab"},
    {"name": "freshell_send_keys",    "description": "Send keystrokes to a pane"},
    {"name": "freshell_capture_pane", "description": "Read terminal output"},
    {"name": "freshell_wait_for",     "description": "Wait for output pattern"},
    {"name": "freshell_list_tabs",    "description": "List all tabs"},
    {"name": "freshell_list_panes",   "description": "List panes in a tab"},
    {"name": "freshell_open_browser", "description": "Open URL in browser pane"},
    {"name": "freshell_run",          "description": "Run command and capture output"},
    {"name": "freshell_split_pane",   "description": "Split a pane"},
    {"name": "freshell_kill_pane",    "description": "Close a pane"},
    {"name": "freshell_kill_tab",     "description": "Close a tab"},
    {"name": "freshell_summarize",    "description": "AI summary of terminal output"}
  ]
}
```

The MCP server calls the same REST endpoints as the CLI, keeping a single source
of truth.

---

## 7. Agent Discovery & Environment

### 7.1 How Agents Know They're in Freshell

When Freshell spawns a terminal, it should set environment variables:

```bash
FRESHELL=1
FRESHELL_URL=http://localhost:3000
FRESHELL_TOKEN=abc123
FRESHELL_TAB_ID=tab_xyz
FRESHELL_TAB_NAME=my-tab
FRESHELL_PANE_ID=pane_abc
FRESHELL_TERMINAL_ID=term_123
```

Agents (and their skills/tools) can check `FRESHELL=1` to detect they're inside
Freshell, just as they check `TMUX` to detect they're inside tmux.

### 7.2 CLI Auto-Configuration

When `FRESHELL` is set, the CLI reads URL and token from environment variables.
No configuration file needed. The agent simply runs `freshell list-tabs` and it
works.

### 7.3 Compatibility Shim (Optional, Low Priority)

For maximum compatibility, a `tmux` wrapper script could be provided that translates
tmux commands to freshell commands. This would let existing tmux-based agent tools
work without modification:

```bash
#!/bin/bash
# ~/.local/bin/tmux (higher priority than system tmux)
if [ -n "$FRESHELL" ]; then
  exec freshell --tmux-compat "$@"
else
  exec /usr/bin/tmux "$@"
fi
```

This is a stretch goal—most agents should learn to use `freshell` directly via
skills/instructions. But it could enable zero-config compatibility with existing
MCP servers and orchestration tools.

---

## 8. Full Command Reference Summary

### Tab Commands
```
freshell new-tab [-n NAME] [-d] [--shell SHELL] [--cwd DIR]
                 [--claude|--codex|--coding-cli PROVIDER] [--prompt TEXT]
                 [--resume SESSION_ID]
                 [--browser URL] [--editor FILE]
freshell list-tabs
freshell select-tab -t TAB
freshell kill-tab -t TAB
freshell rename-tab -t TAB NAME
freshell has-tab -t TAB
freshell next-tab
freshell prev-tab
```

### Pane Commands
```
freshell split-pane [-t PANE] [-h|-v]
                    [--shell SHELL] [--cwd DIR]
                    [--claude|--codex|--coding-cli PROVIDER]
                    [--browser URL] [--editor FILE]
freshell list-panes [-t TAB]
freshell select-pane -t PANE
freshell kill-pane -t PANE
freshell resize-pane -t PANE [-x WIDTH] [-y HEIGHT]
freshell swap-pane
freshell respawn-pane -t PANE
```

### I/O Commands
```
freshell send-keys -t PANE [-l] [KEYS...]
freshell capture-pane [-t PANE] [-S LINES] [-J] [-e]
freshell wait-for -t PANE [-p PATTERN] [--stable N] [--exit] [--prompt] [-T TIMEOUT]
```

### Browser Commands
```
freshell open-browser -t PANE URL
freshell navigate -t PANE URL
freshell new-tab --browser URL [-n NAME]
freshell split-pane --browser URL [-t PANE]
```

### Coding CLI Commands
```
freshell new-tab --claude [--prompt TEXT] [--cwd DIR] [--resume ID]
freshell new-tab --codex [--cwd DIR]
freshell list-sessions [--provider PROVIDER]
freshell search-sessions QUERY
```

### Utility Commands
```
freshell display -p FORMAT [-t PANE]
freshell run [-d] [-n NAME] [--capture] [-T TIMEOUT] COMMAND
freshell summarize [-t PANE] [--session ID]
freshell health
freshell lan-info
freshell list-terminals
freshell attach -t TERMINAL
```

---

## 9. Priority & Phasing

### Phase 1: Core Agent Operations (MVP)

The minimum viable set for agents to operate Freshell:

1. `send-keys` — send input to terminals
2. `capture-pane` — read terminal output
3. `list-tabs` / `list-panes` — discover what's running
4. `new-tab` — create terminals
5. `kill-tab` / `kill-pane` — clean up
6. `display` — introspection (pane ID, terminal ID, mode)
7. Environment variables (`FRESHELL`, `FRESHELL_URL`, etc.)
8. REST endpoints for the above
9. Scrollback buffer access endpoint

### Phase 2: Reliability & Orchestration

Features that make multi-agent workflows robust:

1. `wait-for` — output pattern matching, stability detection, exit waiting
2. `run` — combined create + execute + wait + capture
3. `split-pane` — multi-pane layouts
4. `select-tab` / `select-pane` — navigation
5. `rename-tab` — labeling for discoverability

### Phase 3: Freshell-Unique Features

Capabilities that differentiate Freshell from tmux:

1. `open-browser` / `navigate` — browser pane control
2. `--claude` / `--codex` — coding CLI integration
3. `summarize` — AI summaries
4. `search-sessions` — session history search
5. `--editor` — editor pane control
6. MCP server

### Phase 4: Compatibility

Polish for ecosystem integration:

1. tmux compatibility shim (`--tmux-compat`)
2. Split direction flags (`-h`/`-v`)
3. `pipe-pane` equivalent for output logging
4. Configurable pane layout algorithms

---

## 10. Design Decisions & Rationale

### Why a CLI tool rather than just REST API / MCP?

Agents' most common tool is Bash. Every agent can run shell commands. Not every
agent has MCP support. The CLI is the universal interface. REST and MCP are
secondary access patterns built on the same endpoints.

### Why flatten tmux sessions?

Freshell is single-user. Adding a session layer would force agents to manage
session names, increasing the API surface without adding value. Tabs are the
natural unit of organization. If multi-user support is added later, sessions
can be introduced as a grouping layer above tabs.

### Why not just implement a tmux compatibility shim from day one?

A shim would provide instant compatibility but would hide Freshell's unique
features (browser panes, coding CLI integration, AI summaries, `wait-for`).
Agents should learn Freshell's native interface through skills/instructions.
The shim is a convenience fallback, not the primary interface.

### Why `wait-for` is the killer feature

The #1 reliability problem in agent-tmux interactions is completion detection.
Every orchestration framework invents its own solution: fixed sleeps, output
polling, marker-based capture, prompt regex. `wait-for` solves this at the
platform level. An agent that can say `freshell wait-for -t 0 -p "Tests passed"
-T 60` instead of writing a polling loop is dramatically more reliable.

### Why server-side implementation over client-side?

Tab/pane state currently lives in the browser (Redux + localStorage). For the
agent API to work, the server must be the source of truth for tab/pane layout.
This requires promoting tab/pane state from client-only to server-managed.
This is the largest architectural change in this proposal, but it's necessary:
agents don't have access to browser localStorage.

---

## 11. Open Questions

1. **Tab/pane state ownership**: Currently client-side (Redux + localStorage).
   Must move server-side for agent API to work. What's the migration path?
   Should the server broadcast layout changes so all clients stay in sync?

2. **Multi-client coordination**: If multiple browser tabs and CLI agents are
   manipulating tabs/panes simultaneously, how do we handle conflicts? Last-write-wins?
   CRDTs? Operational transforms?

3. **Active pane/tab concept for CLI**: tmux has a clear "active" pane per session.
   Freshell's "active" pane is per-browser-tab. Should the server maintain a
   canonical "active" state, or should each CLI invocation specify its target
   explicitly?

4. **CLI distribution**: Should `freshell` be bundled with the server, installed
   separately via npm, or downloaded as a standalone binary? The server could
   serve the CLI at `GET /api/cli` for self-bootstrapping.

5. **Authentication for CLI**: The server uses token auth. Should the CLI support
   short-lived tokens, or use the same long-lived token? Should there be an
   `freshell login` flow?
