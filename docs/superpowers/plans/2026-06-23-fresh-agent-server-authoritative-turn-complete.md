# Server-authoritative fresh-agent turn completion

## Problem

Fresh-agent panes (freshclaude, kilroy, freshcodex, freshopencode) drove the
GREEN / needs-attention highlight and the idle chime by **re-deriving the
turn-complete edge on the client** — `useAgentSessionTurnCompletion` watched the
Redux busy *level* (`isFreshAgentBusy`) and fired `recordTurnComplete` on a
busy→idle transition.

Differentiating a level to recover an edge is inherently fragile: it must observe
both sides, in order, exactly once, with no bounce. That produced the three
reported symptoms:

- **Premature / flicker chimes** — a transient idle blip (snapshot clobber,
  stream gap) read as a completed turn.
- **Missed chimes** — a fast turn whose busy onset was never observed, or a turn
  that completed while the client was differentiating stale snapshot levels.
- **Wrong color** — green derived from a level that disagreed with the real
  outcome (e.g. an interrupt looks just like a completion at the level).

Terminal-mode CLIs do not have this problem: they use a **server-authoritative
discrete completion event** (`terminal.turn.complete`). Fresh-agent panes had no
server completion event at all.

## Approach

Give fresh-agent panes the same server-authoritative model: each provider adapter
emits a **discrete `freshAgent.turn.complete` edge only on a positive
completion**, and the client folds it into the existing GREEN/SOUND pipeline.
Delete the client-side busy→idle derivation.

### Server emit points (positive completion only)

Validated empirically against the real binaries before implementing:

- **freshclaude / kilroy** (`server/sdk-bridge.ts`): the SDK `result` message with
  `subtype === 'success'`. In streaming-input mode an interrupt sends a
  `control_response` ACK and yields **no** result message; kill → `sdk.exit`;
  stream error → `sdk.error` + `sdk.status idle`. So `subtype === 'success'` is a
  clean, unambiguous positive edge.
- **freshopencode** (`server/fresh-agent/adapters/opencode/adapter.ts`): the
  success-only `emitStatus(state, 'idle')` path after `await idle` resolves, gated on a
  per-session `turnAborted` flag. `onceIdle` resolves on *any* idle — including the
  idle that an interrupt's abort triggers (it does **not** reject) — so `interrupt()`
  sets `turnAborted` before aborting and the send suppresses its chime when that idle
  resolves; each new turn resets the flag. The catch path (sidecar loss / timeout) and
  the serve SSE idle relay also never chime.
- **freshcodex** (`server/fresh-agent/adapters/codex/adapter.ts`): the app-server
  `turn/completed` notification. **Empirical finding:** `turn/completed` fires for
  interrupts too, and carries the authoritative outcome inline at
  `params.turn.status` (`'completed' | 'interrupted' | 'failed'`). We register
  `onTurnCompleted` in `subscribe` and chime only on a positive completion — no extra
  read-back round-trip. The authoritative status appears either inline at
  `params.turn.status` (codex-cli 0.142.0, probed live) **or** flat at `params.status`
  (the shape the app-server client tests model), so we read
  `params.turn?.status ?? params.status` and require `=== 'completed'`; either shape is
  detected and interrupts/failures at either location are excluded. The protocol schema
  (`CodexTurnCompletedNotificationSchema`) declares both the inline `turn.status` and the
  flat `status` contract.

### Transport

Adapters emit `sdk.turn.complete { sessionId, at }`;
`normalizeFreshAgentProviderEvent` maps it to `freshAgent.turn.complete`. It rides
the existing `freshAgent.event` envelope, so it inherits per-client authorization,
the subscription lifecycle, and the materialization locator remap for free (the
envelope re-stamps the real `sessionId`, so opencode's placeholder-id emit arrives
correctly keyed).

### Client

`handleFreshAgentTransportEvent` routes `freshAgent.turn.complete` to a new
`applyFreshAgentCompletion` thunk, which resolves the owning tab/pane from the
`provider:sessionId` session key and dispatches `recordTurnComplete`.

**Identity matching (the runtime-handle gotcha).** The server keys the event by the
runtime handle it subscribed with (`provider:content.sessionId`). For Claude/kilroy
that runtime handle is the bridge `nanoid`, which differs from the durable Claude
UUID persisted in `content.sessionRef` — and `resolveFreshAgentSessionKey` *prefers*
`sessionRef`. So `findFreshAgentPaneBySessionKey` matches the event against the
runtime handle **and** the resolved (sessionRef-preferred) key; matching only the
latter silently dropped every chime on restored Claude sessions. OpenCode and Codex
keep `content.sessionId === sessionRef.sessionId`, so they were unaffected (which is
why the original OpenCode-only test missed it).

**Dedupe regime: `at`-monotonic (no `completionSeq`).** This is the key
restart-safety decision. A wall-clock `at` is inherently monotonic across a server
restart, so a resumed *durable* fresh-agent session (same `sessionId` after a
deploy) cannot swallow real completions — unlike a per-session counter, which
resets to 0 on restart while the client's persisted `lastApplied` survives
(the "restart-swallow" failure). Terminals avoid that by getting a fresh
`nanoid` terminalId on restart; fresh-agent sessions keep their durable id, so the
counter approach is unsafe here. The discrete edge is never re-derived from a
snapshot level, so a reconnect cannot re-green, and a replayed/stale event with an
older-or-equal `at` is dropped.

**Server-side per-session monotonic clamp.** Raw `Date.now()` is not a reliable
per-turn identity: two genuine completions can land in the same millisecond, and the
system clock can step backwards (NTP correction) — both would make a real later
completion look `<= last` and be dropped as a replay, recreating the missed-chime
class. So each emit site (`sdk-bridge`, opencode adapter, codex subscription) clamps
its session's `at` to be strictly greater than the previous one via the shared
`nextMonotonicTurnCompleteAt` helper. This keeps the wall-clock-seeded value (so
restart monotonicity still holds — a new process's `Date.now()` is already past any
pre-restart `at`) while guaranteeing distinct turns never collide or regress within a
process.

### What was deleted

`useAgentSessionTurnCompletion` no longer derives turn completion from the busy
level. It retains only the "waiting-for-approval" edge (a 0→≥1 pending
permission/question transition), which is a distinct attention concern. That edge
records under a **distinct dedupe namespace** (`provider:sessionId#waiting`): it is
stamped with the *client* clock, and for opencode/codex it would otherwise share the
server completion's `provider:sessionId` entry — letting an approval stamped ahead of
the server clock (common on a remote client) swallow the real completion via the
monotonic `at <= last` guard.

## Spike findings (empirical, real binaries)

- **Claude SDK** (`@anthropic-ai/claude-agent-sdk` 2.1.186): result subtype enum is
  `success | error_during_execution | error_max_turns | error_max_budget_usd |
  error_max_structured_output_retries`. Interrupt in streaming-input mode yields no
  result. One result per user turn (no `parent_tool_use_id` on results).
- **Codex app-server** (codex-cli 0.142.0, probed live): `turn/completed` params
  are `{ threadId, turn: { id, status, error, startedAt, completedAt, durationMs } }`
  — status is inline. Interrupt produces `turn/completed` with
  `turn.status === 'interrupted'` (no separate `turn/aborted`). The runtime exposes
  `onExit` (not yet wired into the freshcodex adapter — a separate stuck-blue gap).
- **OpenCode**: single success-only completion point already existed; owns an
  explicit `ses_` id, immune to ambiguous-ownership.

## Test coverage

- Unit: transport normalize; claude bridge (success emits, non-success does not);
  opencode (exactly one on success, none on abort); codex adapter (only
  `turn.status === 'completed'`, scoped to the subscribed thread); client thunk +
  transport routing + `at`-monotonic dedupe; hook no longer fires on busy→idle.
- Unit (review follow-ups, round 1): client routes a Claude completion keyed by the
  runtime handle when the pane carries a durable `sessionRef` (identity match);
  `nextMonotonicTurnCompleteAt` clamps same-ms/backward-clock; each emit site
  (claude/opencode/codex) stamps a strictly-increasing `at` across successive
  same-millisecond completions.
- Unit (review follow-ups, round 2): opencode does not chime on an interrupt even
  though `onceIdle` resolves, and resumes chiming on the next clean turn; codex chimes
  on a flat `params.status` completion and skips a flat `interrupted`; the
  waiting-for-approval edge does not swallow a later server completion (separate dedupe
  namespace).
- e2e: WS `freshAgent.turn.complete` → `handleFreshAgentMessage` →
  `applyFreshAgentCompletion` → `useTurnCompletionNotifications` chimes once +
  highlights, ignores replays, re-chimes on the next real turn.

## Deliberately out of scope (follow-ups)

- freshcodex `onExit` self-heal for a crashed sidecar (stuck-blue gap).
- snapshot status-clobber / provider-agnostic `statusSeq` for BLUE correctness.
- Centralizing GREEN/BLUE render precedence across TabItem / PaneHeader / Sidebar.
- Making the waiting-for-approval edge server-authoritative too (delete the hook).
