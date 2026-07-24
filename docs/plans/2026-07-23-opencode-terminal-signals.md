# OpenCode terminal-mode signals: busy/idle, turn boundaries, queued prompts

**Date:** 2026-07-23
**Status:** Research complete (read-only investigation; no product code)
**Question:** For a plain `opencode` CLI running in a terminal pane (NOT the
freshopencode sidecar), what reliable signals exist for (a) busy vs idle,
(b) turn boundaries, (c) queued user prompts?

**Method:** Ran the real `opencode` CLI (v1.18.3 from PATH) in a throwaway
`HOME`/`XDG_*` root and throwaway project (`/tmp/oc-research/`), both
`opencode run` and the interactive TUI (the latter under `script` to capture
raw output bytes). Inspected everything it wrote to disk, its SQLite schema
and row contents, its process sockets, and its lock files. Sampled the user's
real 4.4 GB `opencode.db` with read-only, `LIMIT`-bounded queries only (never
ran the CLI against real state). Compared with how the freshopencode sidecar
gets its status (`crates/freshell-freshagent/src/opencode_ws.rs`,
`crates/freshell-opencode`).

---

## 1. What opencode writes to disk

opencode 1.18.3 persists **everything in one SQLite database**,
`<XDG_DATA_HOME>/opencode/opencode.db` (WAL mode; the user's real DB is
4.4 GB + 234 MB WAL). The old one-JSON-file-per-session `storage/` layout is
gone (`data_migration` table records the migration). Other artifacts:

| Path | What | Signal value |
|---|---|---|
| `<data>/opencode/opencode.db{,-wal,-shm}` | Sessions, messages, parts, event log, prompt queue | **Primary substrate** (below) |
| `<data>/opencode/log/opencode.log` | Structured text log (`message=loop step=0`, `message=stream`, errors) | Real but format-unstable; per-install not per-session; last resort |
| `<data>/opencode/snapshot/<project>/<sha>/` | Bare git repo for file snapshots | None for status |
| `<state>/opencode/locks/<sha1>.lock/{meta.json,heartbeat}` | `{token, pid, hostname, createdAt}` + empty heartbeat file | **Not usable**: created by `opencode run` one-shots, removed on exit, NOT created by the interactive TUI; contains no port |
| `<config>/opencode/opencode.jsonc` | Config | None |

Relevant tables (schema captured from the throwaway DB, identical in the real
one): `session`, `message`, `part`, `event`, `event_sequence`,
`session_input`, `permission`, `todo`, `project`.

Key columns:

```sql
session ( id, project_id, parent_id, directory, title, agent, model, ...,
          time_created, time_updated, time_compacting, time_archived )
message ( id, session_id, time_created, time_updated, data /* JSON */ )
part    ( id, message_id, session_id, time_created, time_updated, data )
event   ( id, aggregate_id /* = session id */, seq, type, data )
event_sequence ( aggregate_id, seq, owner_id )
session_input  ( id, session_id, prompt, delivery,
                 admitted_seq, promoted_seq, time_created )
```

Observed `message.data` for a completed (errored) assistant turn:

```json
{ "role": "assistant",
  "time": { "created": 1784875581948, "completed": 1784875583641 },
  "error": { "name": "APIError", ... },
  "cost": ..., "tokens": ..., "modelID": ..., "providerID": ..., ... }
```

The `event` table is a persisted per-session event-sourcing log. Recent-400
sample of the real DB shows exactly three persisted types:
`message.part.updated.1` (254), `message.updated.1` (114),
`session.updated.1` (32). **`session.idle` / status events are NOT persisted**
— they exist only on the in-process bus / serve SSE stream.

## 2. Per-question findings

### (a) Busy vs idle

- **No process-level signal.** The standalone TUI opens **no listening
  socket** (verified via `/proc/<pid>/fd` + `ss` while the TUI ran) — there is
  no API to ask. It holds `opencode.db` open directly and writes through it.
- **No lock/heartbeat signal.** The `locks/` heartbeat exists only for
  `opencode run` one-shots and holds no port; the TUI never created one.
- **No bare-BEL signal.** Captured raw TUI output bytes across a full
  prompt→answer turn: 7 BEL bytes, **all** OSC-terminators (title updates),
  0 bare BELs. The existing `shared/turn-complete-signal.ts` pipeline
  (`supportsTurnSignal: mode === 'claude' || 'codex'`) **cannot** be extended
  to opencode — it emits no in-band completion byte.
- **DB is the real signal.** During a turn, `event` rows append at streaming
  cadence (`message.part.updated.1` dominates), `event_sequence.seq` for the
  session increments, and `session.time_updated` bumps. Busy is derivable as:
  latest assistant `message` row in the bound session has
  `json_extract(data,'$.time.completed') IS NULL`; idle when set.

### (b) Turn boundaries

- **Positive edge exists on disk:** the assistant message's
  `data.time.completed` transitions null → epoch-ms when the turn ends.
  Verified for both `opencode run` and TUI turns (including error turns —
  the `error` key is set alongside, so a *positive* completion can be
  distinguished from an errored one by `error` being absent, matching the
  "chime only on positive completion" policy).
- **Subagent/tool activity is separable.** Subagent sessions are separate
  `session` rows with `parent_id` set; messages/parts/events are keyed by
  session id. Filtering to the pane's bound root session means tool calls
  (`part` rows) and subagent chatter cannot fire a false top-level edge —
  the edge is only the root session's assistant `message.time.completed`.
- **Pane→session binding already exists.** `OpencodeLocator`
  (`crates/freshell-sessions/src/opencode_locator.rs`) binds a fresh opencode
  PTY to its new `session` row by bounded row-diff (cwd + correlation
  window), designed explicitly for the multi-GB DB (indexed,
  `time_created >= floor LIMIT n` reads only). Resumed panes
  (`opencode -s ses_*`) carry the id directly.

### (c) Queued prompts

- The `session_input` table (`prompt`, `delivery`, `admitted_seq`,
  `promoted_seq`) is structurally a prompt queue — a row with
  `promoted_seq IS NULL` would be a queued-but-not-yet-running prompt.
- **Honesty caveat: unverified.** It held 0 rows in the throwaway DB (turns
  fail in ~1.7 s without provider auth — no queue window to observe) and 0
  rows at rest in the user's heavily-used real DB. Rows are evidently
  transient (deleted/promoted on consumption); whether they are visible
  on disk *while* queued was not observable in this investigation. Treat
  queued-prompt detection as **plausible but unproven** until verified
  against an authed, long-running turn.

## 3. Comparison with the freshopencode sidecar

The sidecar path (`freshell-opencode`'s `OpencodeServeManager`, one shared
`opencode serve` child) gets **server-pushed** `session.idle` /
`session.status` over the serve HTTP+SSE surface — ephemeral bus events that
never reach the DB. That source is reachable for terminal mode **only** if
the terminal TUI runs against the same server: `opencode attach <url>`
(supports `--dir`, `--session`, basic auth) attaches a TUI to a running
`opencode serve`. A standalone TUI cannot be attached to after the fact (no
socket). So there are two viable architectures:

1. **DB polling (works with vanilla `opencode` panes):** poll the bound
   session's latest assistant message for the `time.completed` edge, using
   the same bounded-read discipline as `OpencodeLocator`.
2. **Attach mode (server-authoritative, but changes the product):** spawn
   opencode terminal panes as `opencode attach http://127.0.0.1:<sidecar>`;
   sessions then live on the server freshell already subscribes to, and
   terminal panes get the exact same `session.idle` signal freshopencode
   uses. Cost: the pane is no longer a vanilla local opencode (auth
   plumbing, sidecar lifecycle coupling — a sidecar restart severs every
   attached pane — and divergent user expectations).

## 4. Recommendation

**Full truly-idle support via bounded `opencode.db` polling** (option 1),
gated on the pane having a bound session (locator-bound fresh panes or
`-s`-resumed panes):

- Busy: bound session's latest assistant message has `time.completed` null
  (or `event_sequence.seq` advanced within the poll interval).
- Turn-complete (green + chime): `time.completed` null→set **with no
  `error`** — a discrete, positive, server-side edge consistent with the
  `freshAgent.turn.complete` regime. Errored/interrupted turns clear busy
  without a chime.
- Unbound panes stay **status-inert** (like Gemini/Kimi). No grace-window
  heuristics: the signal either comes from the DB edge or not at all — a
  lying bell is worse than no bell.
- Queued-prompt indication: defer; revisit `session_input` with an authed
  long-turn verification before building anything on it.

The attach-mode architecture is worth a separate spike only if
DB-polling latency or DB-size cost proves unacceptable in practice.

**Estimated effort:** 2–4 days. A small poller in the existing sessions/ws
layer (arm on opencode-pane bind, disarm on kill/exit, idle short-circuit
like the locator), two bounded SQL reads per tick, edge dedupe reusing the
`terminal.turn.complete` plumbing, plus unit tests against a synthetic
`opencode.db` (the locator's test harness already builds one) and a real-CLI
contract test in `test/integration/real/` (opt-in, like the existing provider
contracts).

## Appendix: evidence log

- Throwaway run: `HOME=/tmp/oc-research/home ... opencode run "say hi"` →
  created `opencode.db` (+wal/shm), `log/opencode.log`, snapshot repo,
  `locks/<sha1>.lock/{meta.json,heartbeat}`; lock removed on exit.
- TUI run: no lock created; `/proc/<pid>/fd` shows the DB open + sockets,
  `ss -tlnp` shows no LISTEN for the pid.
- Bell capture: `script -q -e -c opencode` over a full turn →
  `total_BEL=7, OSC-terminating=7, bare=0`.
- DB rows: session/message/part/event/event_sequence contents as quoted in
  §1–§2 (throwaway DB); real-DB sample: recent-400 `event.type` counter and
  `session_input` count 0, via read-only `LIMIT` queries.
- Sidecar source: `crates/freshell-freshagent/src/opencode_ws.rs` module doc
  (serve SSE bridge → `freshAgent.event` / status-guarded turn-complete);
  `opencode attach --help` (url, `--dir`, `--session`, basic auth).
