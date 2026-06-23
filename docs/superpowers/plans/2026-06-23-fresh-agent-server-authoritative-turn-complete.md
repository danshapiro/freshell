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
  success-only `emitStatus(state, 'idle')` path after `await idle` resolves. The
  catch path (abort / interrupt / sidecar loss) and the serve SSE idle relay
  deliberately do not chime.
- **freshcodex** (`server/fresh-agent/adapters/codex/adapter.ts`): the app-server
  `turn/completed` notification. **Empirical finding:** `turn/completed` fires for
  interrupts too, and carries the authoritative outcome inline at
  `params.turn.status` (`'completed' | 'interrupted' | 'failed'`). We register
  `onTurnCompleted` in `subscribe` and chime only when
  `params.turn.status === 'completed'` — no extra read-back round-trip. The
  protocol schema (`CodexTurnCompletedNotificationSchema`) was extended to declare
  the inline `turn.status` contract.

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

### What was deleted

`useAgentSessionTurnCompletion` no longer derives turn completion from the busy
level. It retains only the "waiting-for-approval" edge (a 0→≥1 pending
permission/question transition), which is a distinct attention concern.

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
- e2e: WS `freshAgent.turn.complete` → `handleFreshAgentMessage` →
  `applyFreshAgentCompletion` → `useTurnCompletionNotifications` chimes once +
  highlights, ignores replays, re-chimes on the next real turn.

## Deliberately out of scope (follow-ups)

- freshcodex `onExit` self-heal for a crashed sidecar (stuck-blue gap).
- snapshot status-clobber / provider-agnostic `statusSeq` for BLUE correctness.
- Centralizing GREEN/BLUE render precedence across TabItem / PaneHeader / Sidebar.
- Making the waiting-for-approval edge server-authoritative too (delete the hook).
