---
name: freshell-orchestration
description: "Use when interacting with Freshell panes, panels, or tabs from the CLI for tmux-style automation and multi-pane workflows, outside external-browser automation tasks."
---

# Freshell tmux-style automation

## Start state

Use the repo-local CLI entrypoint (no build needed):

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

## Mental model

- Freshell CLI is an HTTP client over `/api/*`, not a local tmux socket client.
- Tabs and pane trees live in `layoutStore`.
- Terminal lifecycle + scrollback live in `terminalRegistry`.
- Pane kinds: `terminal`, `editor`, `browser`.
- Typical loop: `new-tab/split-pane` -> `send-keys` -> `wait-for` -> `capture-pane`/`screenshot-*`.

## Command reference

Output behavior:
- Most commands print JSON.
- `list-tabs` and `list-panes` print TSV unless `--json`.
- `capture-pane` and `display` print plain text.

Targets:
- Tab target: tab ID or exact tab title.
- Pane target: pane ID, pane index in active tab, or `tabRef.paneIndex`.
- Omitted target falls back to active pane in active tab when command supports it.

Tab commands:
- `new-tab [-n NAME] [--claude|--codex|--mode MODE] [--shell SHELL] [--cwd DIR] [--browser URL] [--editor FILE] [--resume SESSION_ID] [--prompt TEXT]`
- `list-tabs [--json]`
- `select-tab [TARGET]` or `select-tab -t TARGET`
- `kill-tab [TARGET]` or `kill-tab -t TARGET`
- `rename-tab [TARGET] [NEW_NAME]` or `rename-tab -t TARGET -n NEW_NAME`
- `has-tab TARGET` or `has-tab -t TARGET`
- `next-tab`
- `prev-tab`

Pane/layout commands:
- `split-pane [-t PANE_TARGET] [-v] [--mode MODE] [--shell SHELL] [--cwd DIR] [--browser URL] [--editor FILE]`
- `list-panes [-t TAB_TARGET] [--json]`
- `select-pane PANE_TARGET` or `select-pane -t PANE_TARGET`
- `kill-pane PANE_TARGET` or `kill-pane -t PANE_TARGET`
- `resize-pane PANE_TARGET [--x X_PCT] [--y Y_PCT]`
- `swap-pane PANE_TARGET --other OTHER_PANE_TARGET`
- `respawn-pane PANE_TARGET [--mode MODE] [--shell SHELL] [--cwd DIR]`
- `attach TERMINAL_ID [PANE_TARGET]` or `attach -t TERMINAL_ID -p PANE_TARGET`

Terminal interaction:
- `send-keys [-t PANE_TARGET] [-l] KEYS...`
- `capture-pane [-t PANE_TARGET] [-S START] [-J] [-e]`
- `wait-for [-t PANE_TARGET] [-p PATTERN] [--stable SECONDS] [--exit] [--prompt] [-T TIMEOUT_SECONDS]`
- `display -p FORMAT [-t PANE_TARGET]` or `display FORMAT [PANE_TARGET]`
- `run [--capture|-c] [--detach|-d] [-T TIMEOUT_SECONDS] [-n NAME] [--cwd DIR] COMMAND...`
- `summarize PANE_TARGET` or `summarize -t PANE_TARGET`
- `list-terminals`

Browser/navigation:
- `open-browser URL [-n NAME]`
- `navigate URL [PANE_TARGET]` or `navigate --url URL -t PANE_TARGET`

Screenshot commands:
- `screenshot --scope pane|tab|view --name NAME [--path DIR_OR_FILE] [--overwrite] [-t TARGET]`
- Aliases:
  - `screenshot-pane -t PANE_TARGET --name NAME [--path ...] [--overwrite]`
  - `screenshot-tab -t TAB_TARGET --name NAME [--path ...] [--overwrite]`
  - `screenshot-view --name NAME [--path ...] [--overwrite]`
- `--name` is required.
- `--path` is optional; default output root is OS temp dir.
- Pane/tab scopes resolve target before capture; view scope captures current app viewport.

Session/service:
- `list-sessions`
- `search-sessions QUERY` or `search-sessions -q QUERY`
- `health`
- `lan-info`

tmux-style aliases:
- `new-window`, `new-session` -> `new-tab`
- `list-windows` -> `list-tabs`
- `select-window` -> `select-tab`
- `kill-window` -> `kill-tab`
- `rename-window` -> `rename-tab`
- `next-window` -> `next-tab`
- `previous-window`, `prev-window` -> `prev-tab`
- `split-window` -> `split-pane`
- `display-message` -> `display`
- `screenshot-pane`, `screenshot-tab`, `screenshot-view` -> `screenshot`

## tmux differences

- Transport/auth: tmux uses local socket; Freshell uses HTTP API + token auth.
- Pane types: tmux terminal-only; Freshell supports terminal/editor/browser.
- Target model: tmux session/window/pane grammar vs Freshell ID/title/index resolution.
- Runtime model: tmux TTY-local; Freshell browser-first and remote-friendly.
- Feature model: Freshell adds session indexing/search and AI summary workflows.

## Playbook: open file in editor pane

New tab:

```bash
FILE="/absolute/path/to/file.ts"
$FSH new-tab -n "Edit $(basename "$FILE")" --editor "$FILE"
```

Split current tab:

```bash
FILE="/absolute/path/to/file.ts"
$FSH split-pane --editor "$FILE"
```

## Playbook: parallel Claude panes

```bash
FSH="npx tsx server/cli/index.ts"
CWD="/absolute/path/to/repo"
PROMPT="Implement <task>. Run tests. Summarize tradeoffs."

SEED_JSON="$($FSH new-tab -n 'Claude x4 Eval' --claude --cwd "$CWD")"
P0="$(printf '%s' "$SEED_JSON" | jq -r '.data.paneId')"
J1="$($FSH split-pane -t "$P0" --mode claude --cwd "$CWD")"
P1="$(printf '%s' "$J1" | jq -r '.data.paneId')"
J2="$($FSH split-pane -t "$P0" -v --mode claude --cwd "$CWD")"
P2="$(printf '%s' "$J2" | jq -r '.data.paneId')"
J3="$($FSH split-pane -t "$P1" -v --mode claude --cwd "$CWD")"
P3="$(printf '%s' "$J3" | jq -r '.data.paneId')"

for p in "$P0" "$P1" "$P2" "$P3"; do
  $FSH send-keys -t "$p" -l "$PROMPT"
  $FSH send-keys -t "$p" ENTER
  $FSH wait-for -t "$p" --stable 8 -T 1800
  $FSH capture-pane -t "$p" -S -120 > "/tmp/${p}.txt"
done
```

## Screenshot-specific guidance

- Use a dedicated canary tab when validating screenshot behavior so live project panes are not contaminated.
- Close temporary tabs/panes after verification unless user asked to keep them open.
- Browser panes:
  - Same-origin iframe content is captured best-effort.
  - If iframe content is not capturable (for example cross-origin/security), screenshots intentionally render a placeholder message with source URL context instead of a silent blank region.
  - For assertions, allow either explicit page content or the explicit non-capturable placeholder text depending on origin/security context.

## Gotchas

- Use `send-keys -l` for natural-language prompts.
- `wait-for --stable` is usually more reliable than prompt heuristics across providers.
- If target resolution fails, run `list-tabs` and `list-panes --json`, then retry with explicit IDs.
