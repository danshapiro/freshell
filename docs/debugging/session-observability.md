# Session Observability

Freshell writes a low-volume lifecycle log for terminal/session incidents:

`~/.freshell/logs/session-lifecycle.<mode>.<instance>.jsonl`

If `FRESHELL_LOG_DIR` is set, lifecycle logs are written there instead. If `LOG_SESSION_LIFECYCLE_PATH` is set, that exact file path wins.

Use this log when a pane reports restore unavailable, a terminal id becomes stale, or a coding CLI session was durable in the provider but missing from Freshell pane state.

## Useful Queries

Find all lifecycle events for one terminal:

```bash
rg '"terminalId":"term-id-here"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

Find all events for one durable session:

```bash
rg '"sessionId":"session-id-here"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

Show stale terminal operations:

```bash
rg '"kind":"invalid_terminal_id_without_session_ref"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

Show live-only terminal exits:

```bash
rg '"kind":"terminal_exit_without_durable_session"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

Show panes that rendered restore unavailable:

```bash
rg '"kind":"client_restore_unavailable"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

Find restore-unavailable events for one tab or pane:

```bash
rg '"tabId":"tab-id-here"|"paneId":"pane-id-here"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

## Expected Event Chain For A Healthy New Codex Pane

1. `terminal_create_requested`
2. `terminal_created`
3. `codex_durable_session_observed`
4. `terminal_session_bound`
5. `session_association_broadcast`

If `invalid_terminal_id_without_session_ref` appears after `terminal_created` without the durable-session events, the live terminal disappeared before Freshell persisted a canonical session reference.

If `client_restore_unavailable` appears, use its `tabId`, `paneId`, `terminalId`, and `connectionId` to join the UI failure back to websocket stale-terminal events and terminal lifecycle events.

## OpenCode Fresh Session Binding

Freshell does not preallocate caller-provided `--session` ids for fresh OpenCode terminals in this PR. The durable identity for a fresh OpenCode process comes from OpenCode after launch, and Freshell binds the first unambiguous root session immediately, even while the turn is still busy.

Source/profile evidence for OpenCode 1.14.48 shows `--session <id>` resumes an existing session and hard-fails when the id is missing. Do not invent caller-provided fresh session ids.

The only plausible session-at-birth architecture is to pre-create a session through OpenCode's own server API, then launch the TUI with `--session <created-root-id>`. That is explicitly out of scope for this PR because it changes process startup ownership. This PR relies on provider-confirmed early binding from the terminal's own OpenCode endpoint and SQLite root mapping.

## Data Policy

The lifecycle log may include terminal ids, request ids, connection ids, tab ids, pane ids, providers, durable session ids, process ids, exit codes, and cwd. It must not include terminal input data, auth tokens, process environments, or full command-line arguments.
