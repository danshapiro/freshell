---
name: freshell-automation-tmux-style
description: Use when operating Freshell itself to open files in editor panes, create or split tabs and panes, launch parallel Claude or Codex panes, and drive freshell UI features programmatically.
---

# Using Freshell

## Start State

Use the local CLI entrypoint from the repo so commands work without a build step:

```bash
FSH="npx tsx server/cli/index.ts"
```

Point commands at the running Freshell server:

```bash
export FRESHELL_URL="http://localhost:3001"
export FRESHELL_TOKEN="<auth-token>"
$FSH health
```

Use absolute paths for `--cwd` and `--editor`.

## How Freshell Works

- Freshell is a web app plus server: the UI you see in the browser is backed by an HTTP/WebSocket server process.
- Core state store `layoutStore` tracks tabs, pane trees, active selection, and pane content type.
- Core state store `terminalRegistry` tracks terminal processes, scrollback buffers, and runtime status.
- Pane types are `terminal` (shell/claude/codex), `editor` (file view/edit), and `browser` (URL view).
- The CLI (`npx tsx server/cli/index.ts`) is an HTTP client over `/api/*`, not an in-process tmux client.
- Most automation flows are: create/select tab or pane -> send input (`send-keys`) -> wait (`wait-for`) -> inspect (`capture-pane`).
- Session endpoints (`list-sessions`, `search-sessions`) come from indexed coding-CLI histories (for example Claude/Codex), separate from live terminal buffers.

## Supported Commands

This reference reflects `server/cli/index.ts`.

Output behavior:
- Most commands print JSON.
- `list-tabs` and `list-panes` print tab-separated text unless `--json` is set.
- `capture-pane` and `display` print plain text.

Target behavior:
- Tab targets accept tab id or exact tab title.
- Pane targets accept pane id, pane index in the active tab, or `tabRef.paneIndex`.
- If a pane target is omitted for commands that allow it, Freshell falls back to active pane in active tab.

Tab commands:
- `new-tab`:
  Usage: ``$FSH new-tab [-n NAME] [--claude|--codex|--mode MODE] [--shell SHELL] [--cwd DIR] [--browser URL] [--editor FILE] [--resume SESSION_ID] [--prompt TEXT]``
  Creates a tab. Default is a shell terminal; `--browser` and `--editor` create non-terminal panes.
- `list-tabs`:
  Usage: ``$FSH list-tabs [--json]``
  Lists tab ids, titles, and active pane ids.
- `select-tab`:
  Usage: ``$FSH select-tab [TARGET]`` or ``$FSH select-tab -t TARGET``
  Activates the target tab.
- `kill-tab`:
  Usage: ``$FSH kill-tab [TARGET]`` or ``$FSH kill-tab -t TARGET``
  Closes the target tab.
- `rename-tab`:
  Usage: ``$FSH rename-tab [TARGET] [NEW_NAME]`` or ``$FSH rename-tab -t TARGET -n NEW_NAME``
  Renames a tab.
- `has-tab`:
  Usage: ``$FSH has-tab TARGET`` or ``$FSH has-tab -t TARGET``
  Returns whether target tab exists.
- `next-tab`:
  Usage: ``$FSH next-tab``
  Moves selection forward one tab.
- `prev-tab`:
  Usage: ``$FSH prev-tab``
  Moves selection backward one tab.

Pane/layout commands:
- `split-pane`:
  Usage: ``$FSH split-pane [-t PANE_TARGET] [-v] [--mode MODE] [--shell SHELL] [--cwd DIR] [--browser URL] [--editor FILE]``
  Splits target pane horizontally (default) or vertically (`-v`) and fills new pane.
- `list-panes`:
  Usage: ``$FSH list-panes [-t TAB_TARGET] [--json]``
  Lists pane ids, indexes, kinds, and terminal ids.
- `select-pane`:
  Usage: ``$FSH select-pane PANE_TARGET`` or ``$FSH select-pane -t PANE_TARGET``
  Focuses a pane.
- `kill-pane`:
  Usage: ``$FSH kill-pane PANE_TARGET`` or ``$FSH kill-pane -t PANE_TARGET``
  Closes a pane.
- `resize-pane`:
  Usage: ``$FSH resize-pane PANE_TARGET [--x X_PCT] [--y Y_PCT]``
  Requests resize; percentages are passed to the parent split.
- `swap-pane`:
  Usage: ``$FSH swap-pane PANE_TARGET --other OTHER_PANE_TARGET``
  Swaps pane positions in the same layout tree.
- `respawn-pane`:
  Usage: ``$FSH respawn-pane PANE_TARGET [--mode MODE] [--shell SHELL] [--cwd DIR]``
  Replaces pane content with a newly spawned terminal.
- `attach`:
  Usage: ``$FSH attach TERMINAL_ID [PANE_TARGET]`` or ``$FSH attach -t TERMINAL_ID -p PANE_TARGET``
  Binds an existing terminal id to a pane.

Terminal interaction commands:
- `send-keys`:
  Usage: ``$FSH send-keys [-t PANE_TARGET] [-l] KEYS...``
  Sends input. With `-l`, text is sent literally. Without `-l`, key names like `ENTER`, `C-C`, `UP` are translated.
- `capture-pane`:
  Usage: ``$FSH capture-pane [-t PANE_TARGET] [-S START] [-J] [-e]``
  Dumps pane buffer text. `-S -120` means last ~120 lines. `-J` joins lines. `-e` keeps ANSI escapes.
- `wait-for`:
  Usage: ``$FSH wait-for [-t PANE_TARGET] [-p PATTERN] [--stable SECONDS] [--exit] [--prompt] [-T TIMEOUT_SECONDS]``
  Polls until condition is met. `-p` accepts regex text; `/.../flags` style is supported.
- `display`:
  Usage: ``$FSH display -p FORMAT [-t PANE_TARGET]`` or ``$FSH display FORMAT [PANE_TARGET]``
  Renders tokens like `#S`, `#I`, `#P`, and `#{tab_name}` using resolved tab/pane context.
- `run`:
  Usage: ``$FSH run [--capture|-c] [--detach|-d] [-T TIMEOUT_SECONDS] [-n NAME] [--cwd DIR] COMMAND...``
  Creates a tab, runs command, optionally captures output until sentinel/timeout.
- `summarize`:
  Usage: ``$FSH summarize PANE_TARGET`` or ``$FSH summarize -t PANE_TARGET``
  Requests AI summary for pane terminal.
- `list-terminals`:
  Usage: ``$FSH list-terminals``
  Lists terminal registry entries.

Browser/navigation commands:
- `open-browser`:
  Usage: ``$FSH open-browser URL [-n NAME]``
  Creates a new browser tab and navigates to URL.
- `navigate`:
  Usage: ``$FSH navigate URL [PANE_TARGET]`` or ``$FSH navigate --url URL -t PANE_TARGET``
  Navigates target pane as browser content.

Session commands:
- `list-sessions`:
  Usage: ``$FSH list-sessions``
  Returns indexed coding-CLI sessions.
- `search-sessions`:
  Usage: ``$FSH search-sessions QUERY`` or ``$FSH search-sessions -q QUERY``
  Searches indexed sessions.

Service/diagnostic commands:
- `health`:
  Usage: ``$FSH health``
  Checks server health/readiness.
- `lan-info`:
  Usage: ``$FSH lan-info``
  Shows network binding and LAN access details.

tmux-style aliases supported by this CLI:
- `new-window`, `new-session` -> `new-tab`
- `list-windows` -> `list-tabs`
- `select-window` -> `select-tab`
- `kill-window` -> `kill-tab`
- `rename-window` -> `rename-tab`
- `next-window` -> `next-tab`
- `previous-window`, `prev-window` -> `prev-tab`
- `split-window` -> `split-pane`
- `display-message` -> `display`

## System Differences from tmux

- Transport/auth model: tmux commands talk to a local tmux server socket; Freshell CLI talks to an HTTP API (`FRESHELL_URL`) with token auth (`FRESHELL_TOKEN`).
- UI model: tmux panes are terminal-only; Freshell panes can be terminal, browser, or editor.
- Targeting model: tmux target syntax is session/window/pane style (for example `1:2.0`); Freshell primarily targets tab/pane IDs and resolves friendly forms via the layout API.
- Remote model: tmux is usually local TTY-first; Freshell is browser-first and designed for LAN/remote multi-device access.
- Semantics model: Freshell borrows tmux verbs, but many commands are higher-level workflows over HTTP state (layout store + terminal registry), not direct terminal multiplexer primitives.
- AI/session features: Freshell includes coding-session indexing/search and terminal summarization; tmux has no built-in equivalent.

## Playbook: Open a File in an Editor Pane

Open in a new tab:

```bash
FILE="/absolute/path/to/file.ts"
$FSH new-tab -n "Edit $(basename "$FILE")" --editor "$FILE"
```

Open in the current tab while keeping another pane visible:

```bash
FILE="/absolute/path/to/file.ts"
$FSH split-pane --editor "$FILE"
```

Prefer `new-tab` for isolated tasks. Prefer `split-pane` when the user wants terminal + editor side by side.

## Playbook: Launch 4 Claudes in One Tab and Pick the Best Outcome

```bash
FSH="npx tsx server/cli/index.ts"
CWD="/absolute/path/to/repo"
PROMPT="Implement <task>. Run tests. Summarize tradeoffs."
```

Create the seed pane:

```bash
SEED_JSON="$($FSH new-tab -n 'Claude x4 Eval' --claude --cwd "$CWD")"
P0="$(printf '%s' "$SEED_JSON" | jq -r '.data.paneId')"
```

Split to 4 Claude panes (2x2):

```bash
J1="$($FSH split-pane -t "$P0" --mode claude --cwd "$CWD")"
P1="$(printf '%s' "$J1" | jq -r '.data.paneId')"
J2="$($FSH split-pane -t "$P0" -v --mode claude --cwd "$CWD")"
P2="$(printf '%s' "$J2" | jq -r '.data.paneId')"
J3="$($FSH split-pane -t "$P1" -v --mode claude --cwd "$CWD")"
P3="$(printf '%s' "$J3" | jq -r '.data.paneId')"
PANES=("$P0" "$P1" "$P2" "$P3")
```

Send the same prompt to all panes:

```bash
for p in "${PANES[@]}"; do
  $FSH send-keys -t "$p" -l "$PROMPT"
  $FSH send-keys -t "$p" ENTER
done
```

Wait for output to settle and capture each result:

```bash
for p in "${PANES[@]}"; do
  $FSH wait-for -t "$p" --stable 8 -T 1800
  $FSH capture-pane -t "$p" -S -120 > "/tmp/${p}.txt"
done
```

Choose the winner using this rubric:
- Correctness against the prompt
- Evidence of passing checks (tests/build/lint)
- Smallest safe diff
- Clearest reasoning and risk disclosure

## Gotchas

- Always use `send-keys -l` for natural-language prompts. Without `-l`, spaces are not preserved.
- Prefer `wait-for --stable` for cross-provider reliability; prompt detection can vary by CLI.
- If a target is not resolved, run `list-tabs` and `list-panes --json`, then retry with explicit pane IDs.
