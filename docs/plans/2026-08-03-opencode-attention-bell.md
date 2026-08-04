# OpenCode Attention Bell (Node + Rust Terminal Panes) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Extend the codex attention-bell policy (PR #597) to OPENCODE terminal panes on both servers: policy-correct bells on the Node server (abort-silent, failed-rings, permission pauses, death bells) and a complete, from-scratch OpenCode activity lane on the Rust server (tracker + SSE lane + hub wiring) that lights up the client's existing dead code paths with zero client changes.

**Architecture:** OpenCode terminal panes embed an HTTP+SSE server on a freshell-allocated loopback port. On Node we extend the existing SSE tracker (`opencode-activity-tracker.ts`) and pure ownership reducer with per-turn abort gates (session.error + the abort-marked `message.updated` fallback), a root-resolved permission-pause lane (armed under knownBusy AND candidate ownership), a log-once version drift gate, and spontaneous-exit death-bell markers — the already-wired `TrulyIdleEmitter` does the rest. On Rust we build a pure, resolver-free tracker in `crates/freshell-activity/src/opencode.rs` (port of the Node reducer semantics + the new gates), a per-terminal SSE lane in `freshell-ws` reusing `freshell-opencode`'s `SseDecoder`/`parse_serve_event` (two-phase connect that snapshots only after the `server.connected` subscription ack, a lane-level HTTP root resolver for sessions unseen on-stream, the same log-once version gate, and hub-issued attach-generation stamping), and hub wiring (mode arms, `opencode_frames`, generation-guarded lane ingress, death-bell predicate, `opencode.activity.list`).

**Tech Stack:** TypeScript (Node server, zod, vitest), Rust (tokio, reqwest, serde), OpenCode 1.18.11 SSE protocol (empirically spiked — see `/tmp/opencode-spike/`).

## Global Constraints

- **Policy (user-adjudicated, same as codex):** one bell (`terminal.idle`) = "agent stopped making progress for any NON-HUMAN-REQUESTED cause". Ring: completed turns, FAILED turns, spontaneous death while engaged, permission pauses. Silent: Esc/interrupt/abort, freshell-initiated kills/shutdown, idle quits, queued-follow-up turn ends. NO heuristic bells — protocol events only.
- **Zero wire-shape changes.** All opencode wire schemas already exist (`OpencodeActivityRecordSchema` at `shared/ws-protocol.ts:124-129` with `phase: z.literal('busy')`, `opencode.activity.updated` `:140-144`, `opencode.activity.list.response` `:133-138`, provider `'opencode'` in `TerminalTurnCompleteSchema` `:190-197`, provider-agnostic `TerminalIdleSchema` `:222-227`). `terminal.idle.reason` reuses `'grace'` for all new causes. Contract freeze (`npm run test:port`) must show zero drift.
- **Zero client changes.** `src/lib/pane-activity.ts:207` and `src/lib/terminal-output-side-effects.ts:39` already include `'opencode'`; the client is built for this and currently dark on Rust.
- **Fresh-agent `freshopencode` surface (`server/fresh-agent/adapters/opencode/`) is OUT OF SCOPE** — do not touch. Its `turnAborted`/`turnErrored` gating is reference-only.
- **Protocol facts derive from OpenCode 1.18.11** (live spike, `/tmp/opencode-spike/`; ordering/attribution facts — abort error-before-idle, the W1/W2 abort windows, child permission attribution, parent-scoped fan-out aborts, `/event` no-replay, `GET /session/{id}` exposing `parentID` — additionally verified against the opencode v1.18.11 source, validation pass 2026-08-03). Any NEW load-bearing protocol assumption must consult `/tmp/opencode-spike/openapi.json` and carry a "derives from opencode 1.18.11" comment.
- **Never** restart the self-hosted server (build ok, deploy not), touch the production server (port 3002), the user's live opencode processes (pts/9, pts/33, pts/37), or `~/.local/share/opencode`.
- **No PR creation without explicit user approval.** Everything to main via PR eventually.
- Git author must be `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (never `dan@danshapiro.com`). Conventional commits.
- Broad test runs take the shared coordinator gate: set `FRESHELL_TEST_SUMMARY="<reason>"`. Targeted suites preferred. Node targeted runs use the repo-owned path: `npm run test:vitest -- run <file> --config config/vitest/vitest.server.config.ts` (never bare `npx vitest`).
- NodeNext/ESM: relative imports in server code MUST carry `.js`.
- Commit `.kata.toml` if modified (no modification expected).
- Worktree: `/home/dan/code/freshell/.worktrees/opencode-attention-bell`, branch `feat/opencode-attention-bell`, based on `origin/main`.

---

## Design Decisions (shared by all tasks — read before implementing any task)

**D1 — Abort gate lives in the ownership state machine, per-turn.** Abort evidence is `session.error{name:'MessageAbortedError'}` OR a `message.updated` whose message-info error name is `MessageAbortedError` — both on the owned session while busy, and both feeding the SAME `error` observation (the reducer is unchanged; only the tracker/lane vocabulary widens). The second form covers abort window W2: an abort landing between assistant-message creation (processor.create) and LLM stream start emits NO `session.error`, only the abort-marked `message.updated`, always BEFORE idle (derives from opencode 1.18.11, source-verified — validation pass 2026-08-03). Ordering is guaranteed whenever abort evidence is emitted at all: error-before-idle is deterministic (single fiber, FIFO bus→SSE), so the only failure mode is a MISSING error, never a late one. Residual W1: an abort landing between the prompt loop-top and processor.create emits no abort evidence at all — a ms-scale window where the completion bell would ring on a human abort (documented residual, D8(g)). The `error` observation sets a `turnAborted` flag on the `knownBusy`/`candidate` state. The NEXT idle edge consumes it: state clears busy silently (activityRemove, NO turnComplete). The flag clears when consumed or when a new busy begins. All other error names set nothing — the following idle edge completes normally (failed turns ring exactly like completed turns, via the existing turnComplete → grace → `terminal.idle` path). Trailing errors on quiet/idle state are structurally no-ops (the reducer only reads the flag from busy states).

**D2 — Double `session.idle` dedupe is structural.** The first idle observation transitions `knownBusy → quiet`; the second (and the preceding `session.status{idle}` twin, ~7–20ms apart per the spike) lands on `quiet` and produces no actions. Pinned by tests, not by timers.

**D3 — Permission pause maps to record removal + attention boundary.** `permission.asked` arms the pause when its raw sessionID RESOLVES to the pane's owned session via the child→root map (multi-level parent-chain walk; mappings retained for the session's lifetime) — NOT raw equality: children CAN ask, their asks are stamped with the CHILD session id, and the parent turn blocks on them (verified against the opencode v1.18.11 source, validation pass 2026-08-03). Arming covers `knownBusy` AND `candidate` ownership (the single busy unbound session observed on the pane's own per-pane endpoint): a fresh pane is candidate for its ENTIRE first turn by construction on Node, and the most common attention scenario — a first-turn tool-permission ask — must ring. The pause removes the public record (opencode's existing not-busy representation — `phase` stays `'busy'`-only on the wire, NO new phase value) and then emits an attention boundary (codex ordering: demote FIRST, boundary SECOND). Only a newly-inserted permission id arms (duplicate `permission.asked` never re-arms). `permission.replied` (or the session going busy again) restores the busy record immediately — busy re-entry cancels within grace. Mid-pause turn end retires the pause WITHOUT a second bell: a mid-pause completion/failure swallows the turnComplete — INCLUDING the DEFERRED completion a candidate turn mints at association confirm (the pause claim survives into `awaitingAssociation` for exactly that purpose); the pause bell — rung or still in grace — is THE bell for the episode. A mid-pause abort additionally force-emits the removal so the armed grace window is cancelled (human at keyboard → total silence). Death-bell scope (D4) is UNCHANGED by candidate arming.

**D4 — Death-bell engagement is ownership-scoped.** 'Engaged' = knownBusy on the owned root session OR an armed grace deadline OR a non-empty pending-permission set — NEVER `candidate`/`ambiguous` ownership, even when a candidate-armed permission pause is pending (first-turn deaths stay silent — documented residual, D8(i); that noise is exactly why death bells were excluded before; tightening this is the fix). The registry's exit event (`spontaneous: !requestedClose`, computed at `server/terminal-registry.ts:1517`/`:1542` on Node; `ActivityEvent::Exit{spontaneous}` on Rust) is the authoritative discriminator. SSE-drop alone is NEVER a death signal (reconnect churn) — corroboration only. Death bells are immediate (`reason: 'grace'`, no grace window).

**D5 — Child sessions never gate the root's turn edges.** `session.created.properties.info.parentID` builds the child→root map. Child BUSY remaps to the root (keeps the root busy — matches existing behavior and snapshot "busy beats idle" collapsing). Child IDLE is SUPPRESSED (today's Node code remaps child idle onto the root, which falsely completes the root's turn — the live trace shows the child idle landing 921ms before the parent's; this plan fixes that). Child `session.error` is ignored (raw sessionID must equal the owned root): a fan-out abort always emits the parent-scoped abort error too, after the child's (verified against the opencode v1.18.11 source, validation pass 2026-08-03). Child `permission.asked` is NOT ignored — it root-resolves and arms the pause (D3): the parent turn blocks on the child's ask.

**D6 — `retry` status is busy.** `session.status{type:'retry'}` was never observed live but is schema-declared; both servers parse it defensively as busy.

**D7 — Rust gate mapping mirrors the Node emitter mechanism.** `opencode_frames` maps `Changed.remove` → `idle.note_exit` (exactly what the existing `note_changed_to_gate` at `activity.rs:1396-1407` does): the removal clears gate state, and the `TurnComplete`/`AttentionBoundary` that FOLLOWS in the same effect batch re-arms grace-only. This is the same "activityRemove followed by turnComplete" contract documented at `truly-idle-emitter.ts:78-79`. Effect ordering (remove before boundary) is therefore load-bearing everywhere.

**D8 — Accepted residuals (documented in Task 11, kept truthful):** (a) ambiguous ownership → no bells, no death bells; (b) SSE reconnect during a permission pause loses the pending-pause bell (the busy snapshot clears it; `GET /permission` resync is a possible follow-up); (c) child sessions created during an SSE reconnect gap or before a mid-turn lane attach are recovered by the lane's HTTP root-resolver fallback (`GET /session/{id}` exposes `parentID` — derives from opencode 1.18.11; `/event` has no replay); only resolver FAILURE degrades to ambiguous → conservative silence, retried on the next occurrence; (d) `permission.v2.*` / `question.*` event families are schema-declared but unobserved on 1.18.11 — unhandled (bell goes deaf if a future server switches families); (e) the 120s busy deadman is EVENT-SILENCE-keyed — deltas/heartbeats do NOT refresh it, so a single >120s silent tool call trips it mid-turn; ownership survives and the turn's completion still rings — the cost is the dropped busy light plus lost post-deadman death engagement (the removal itself stays silent); (f) pathological TUI quits — worker dispose exceeding the 5s hard-terminate cap, or a raw SIGTERM (no drain path) — can leave engagement set at spontaneous exit → a death bell can ring on those rare human quits (normal quit paths verified to abort+drain: all four quit inputs dispose runners via the abort path before exit; the wire-flush instant is unprovable from code but mitigated upstream by graceful stream termination); (g) abort window W1 — an abort landing between the prompt loop-top and processor.create emits no abort evidence at all → ms-scale risk of a completion bell on an abort (W2 is closed by D1's `message.updated` fallback); (h) opencode protocol drift: `session.idle` is already deprecated upstream and a v1→v2 event/health migration is in progress — the log-once version gate (Rust lane + Node tracker) converts silent drift into a logged warning, and `/session/status` absence==idle is version-derived behavior (1.18.x); (i) first-turn deaths stay silent (D4 keeps candidate excluded, even mid-pause), and on Rust a no-producer bind tail (locator ambiguity + plugin absence) leaves the pane candidate indefinitely — candidate-armed pauses still ring there, but completions and death bells wait for the bind.

**File structure** (created/modified across tasks):

| File | Responsibility |
|---|---|
| `server/coding-cli/opencode-ownership-reducer.ts` (modify) | pure state machine: + error observation, per-turn abort flags |
| `server/coding-cli/opencode-activity-tracker.ts` (modify) | SSE client: + session.error/abort-marked message.updated/permission.* vocabulary, child-idle suppression, root-resolved permission pause lane (knownBusy + candidate), death-bell markers, log-once version gate |
| `server/coding-cli/opencode-activity-wiring.ts` (modify) | + thread `spontaneous` from `terminal.exit` |
| `crates/freshell-activity/src/opencode.rs` (create) | pure Rust tracker (resolver-free — unknown-id recovery is lane-level): ownership machine + gates + permission pause + death predicates |
| `crates/freshell-activity/src/lib.rs` (modify) | + `pub mod opencode;` |
| `crates/freshell-ws/src/activity.rs` (modify) | hub: opencode mode arms, `opencode_frames`, death predicate, list, deadlines, generation-guarded lane registry |
| `crates/freshell-ws/src/opencode_lane.rs` (create) | per-terminal SSE lane: health-wait + version gate → two-phase connect (subscribe on `server.connected`) → snapshot → flush buffered → stream → backoff; HTTP root-resolver fallback; generation stamping; injected IO seams |
| `crates/freshell-ws/src/terminal.rs` (modify) | thread allocated endpoint to hub (create + respawn); swap the `opencode.activity.list` stub |
| `crates/freshell-ws/src/opencode_association.rs` + `opencode_signal.rs` consumers (modify) | notify hub of session binds (identity only — do not conflate) |
| `crates/freshell-server/src/main.rs` (modify) | install production lane deps |
| `crates/freshell-activity/src/idle.rs` (modify) | residuals list truth-up |
| `shared/ws-protocol.ts`, `server/coding-cli/truly-idle-emitter.ts` (modify) | doc-comment truth-up only (no schema changes) |

---

### Task 1: Node reducer — error observation + per-turn abort gates

**Files:**
- Modify: `server/coding-cli/opencode-ownership-reducer.ts`
- Test: `test/unit/server/coding-cli/opencode-ownership-reducer.test.ts`

**Interfaces:**
- Consumes: existing `OpencodeOwnershipState` (5 kinds, `:24-57`), `OpencodeOwnershipAction` (`:59-81`), `sameSessionStream` guard (`:103-110`).
- Produces (used by Task 2's tracker forwarding and Task 6's Rust port):
  - New observation variant: `{ kind: 'error'; cycleId: number; streamId: number; sessionId: string; errorName: string; at: number }`
  - `candidate` and `knownBusy` states gain `turnAborted?: boolean`; `awaitingAssociation` gains `aborted?: boolean`.
  - Semantics: abort-then-idle → `[activityRemove]` only; error-then-idle (non-abort) → unchanged `[activityRemove, turnComplete]`; abort flag cleared by busy re-entry; `confirmOpencodeAssociation` mints nothing when `aborted`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/server/coding-cli/opencode-ownership-reducer.test.ts` (follow the file's existing import/helper style — it imports `createOpencodeOwnershipState`, `reduceOpencodeOwnership`, `confirmOpencodeAssociation` from `'../../../../server/coding-cli/opencode-ownership-reducer.js'`):

```ts
describe('abort gate (session.error MessageAbortedError)', () => {
  const stream = { cycleId: 1, streamId: 1 }

  function busyKnown() {
    // quiet(known) + busy sse -> knownBusy
    const s0 = createOpencodeOwnershipState('ses-root')
    return reduceOpencodeOwnership(s0, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'busy', at: 1000 }).state
  }

  it('abort then idle clears busy silently (no turnComplete)', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'MessageAbortedError', at: 1500 })
    expect(s1.actions).toEqual([])
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1507 })
    expect(s2.actions).toEqual([{ kind: 'activityRemove', at: 1507 }])
    expect(s2.state).toEqual({ kind: 'quiet', knownSessionId: 'ses-root' })
  })

  it('second idle edge after abort is a no-op (double session.idle dedupe)', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'MessageAbortedError', at: 1500 })
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1507 })
    const s3 = reduceOpencodeOwnership(s2.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1527 })
    expect(s3.actions).toEqual([])
  })

  it('non-abort error names do not suppress the completion (failed turns ring)', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'UnknownError', at: 1500 })
    expect(s1.actions).toEqual([])
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1507 })
    expect(s2.actions).toEqual([
      { kind: 'activityRemove', at: 1507 },
      { kind: 'turnComplete', sessionId: 'ses-root', at: 1507 },
    ])
  })

  it('trailing error on quiet state is a no-op (never mint from idle)', () => {
    const quiet = { kind: 'quiet' as const, knownSessionId: 'ses-root' }
    const r = reduceOpencodeOwnership(quiet, { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'UnknownError', at: 2000 })
    expect(r.state).toEqual(quiet)
    expect(r.actions).toEqual([])
  })

  it('a new busy clears the abort flag (per-turn semantics)', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'MessageAbortedError', at: 1500 })
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'busy', at: 1600 })
    const s3 = reduceOpencodeOwnership(s2.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1700 })
    expect(s3.actions).toContainEqual({ kind: 'turnComplete', sessionId: 'ses-root', at: 1700 })
  })

  it('abort from a mismatched cycle/stream is ignored', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', cycleId: 9, streamId: 9, sessionId: 'ses-root', errorName: 'MessageAbortedError', at: 1500 })
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1507 })
    expect(s2.actions).toContainEqual({ kind: 'turnComplete', sessionId: 'ses-root', at: 1507 })
  })

  it('snapshot-empty after abort is silent too', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'MessageAbortedError', at: 1500 })
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'snapshot', ...stream, statuses: {}, at: 1507 })
    expect(s2.actions).toEqual([{ kind: 'activityRemove', at: 1507 }])
  })

  it('aborted candidate turn never mints a completion at association confirm', () => {
    // quiet(no known) + busy -> candidate
    const s0 = createOpencodeOwnershipState()
    const c1 = reduceOpencodeOwnership(s0, { kind: 'sse', ...stream, sessionId: 'ses-x', status: 'busy', at: 1000 })
    const c2 = reduceOpencodeOwnership(c1.state, { kind: 'error', ...stream, sessionId: 'ses-x', errorName: 'MessageAbortedError', at: 1100 })
    const c3 = reduceOpencodeOwnership(c2.state, { kind: 'sse', ...stream, sessionId: 'ses-x', status: 'idle', at: 1200 })
    expect(c3.state.kind).toBe('awaitingAssociation')
    const confirmed = confirmOpencodeAssociation(c3.state, { sessionId: 'ses-x' })
    expect(confirmed.actions).toEqual([])
    expect(confirmed.state).toEqual({ kind: 'quiet', knownSessionId: 'ses-x' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/opencode-attention-bell && npm run test:vitest -- run test/unit/server/coding-cli/opencode-ownership-reducer.test.ts --config config/vitest/vitest.server.config.ts`
Expected: FAIL — TypeScript errors on the `'error'` observation kind (not in the union) and/or completion assertions failing. Compile errors count as RED.

- [ ] **Step 3: Implement the reducer changes**

In `server/coding-cli/opencode-ownership-reducer.ts`:

1. Extend the observation union (after the existing `sse` variant, ~`:15-22`):

```ts
  | {
      kind: 'error'
      cycleId: number
      streamId: number
      sessionId: string
      /** OpenCode error class name, e.g. 'MessageAbortedError' (opencode 1.18.11). */
      errorName: string
      at: number
    }
```

2. Add the per-turn flags to the state union: on `candidate` (~`:29-36`) and `knownBusy` (~`:37-43`) add `turnAborted?: boolean`; on `awaitingAssociation` (~`:44-51`) add `aborted?: boolean`.

3. Widen `sameSessionStream`'s observation parameter (~`:103-110`) from `Extract<OpencodeObservation, { kind: 'sse' }>` to `Extract<OpencodeObservation, { kind: 'sse' | 'error' }>` — the guard only reads `sessionId`/`cycleId`/`streamId`, which both variants carry. Without this widening, `reduceError` below is a TS2345 type error at `npm run check` (Task 12 Step 3) even though esbuild-transpiled vitest runs stay green. Then add `reduceError` (near `reduceIdle`):

```ts
function reduceError(
  state: OpencodeOwnershipState,
  observation: Extract<OpencodeObservation, { kind: 'error' }>,
): OpencodeOwnershipResult {
  // Only a human abort gates the next idle edge. Every other error name
  // (UnknownError, ProviderAuthError, ...) leaves the turn to complete
  // normally: failed turns ring exactly like completed turns.
  if (observation.errorName !== 'MessageAbortedError') return { state, actions: [] }
  if (
    (state.kind === 'knownBusy' || state.kind === 'candidate') &&
    sameSessionStream(state, observation)
  ) {
    return { state: { ...state, turnAborted: true }, actions: [] }
  }
  // Trailing errors on quiet/awaitingAssociation/ambiguous never mint anything.
  return { state, actions: [] }
}
```

4. Dispatch it in `reduceOpencodeOwnership` (~`:427-438`):

```ts
export function reduceOpencodeOwnership(
  state: OpencodeOwnershipState,
  observation: OpencodeObservation,
): OpencodeOwnershipResult {
  if (observation.kind === 'snapshot') return reduceSnapshot(state, observation)
  if (observation.kind === 'error') return reduceError(state, observation)
  if (observation.status === 'idle') return reduceIdle(state, observation)
  return reduceBusy(state, observation)
}
```

5. In `reduceIdle`'s `knownBusy` branch (`:230-242`), gate the completion:

```ts
  if (state.kind === 'knownBusy') {
    if (!sameSessionStream(state, observation)) return { state, actions: [] }
    const actions: OpencodeOwnershipAction[] = [{ kind: 'activityRemove', at: observation.at }]
    if (!state.turnAborted) {
      actions.push({ kind: 'turnComplete', sessionId: state.sessionId, at: observation.at })
    }
    return { state: { kind: 'quiet', knownSessionId: state.sessionId }, actions }
  }
```

6. In `reduceIdle`'s `candidate` branch (`:212-228`), carry the flag into `awaitingAssociation`: add `...(state.turnAborted ? { aborted: true } : {})` to the new state object.

7. In `reduceSnapshot`'s `knownBusy` empty-busy branch (`:322-330`), apply the same gate as (5) (build `actions` conditionally on `state.turnAborted`). In `reduceSnapshot`'s `candidate` empty-busy branch (`:346-361`), carry `aborted` as in (6).

8. In `reduceBusy`, every branch that keeps/refreshes a `candidate` or `knownBusy` state for the SAME session must clear the flag: include `turnAborted: undefined` (or omit via a rebuilt object) in the refreshed state so a new busy begins a clean turn.

9. In `confirmOpencodeAssociation` (`:440-458`): when `state.aborted === true`, return `{ state: { kind: 'quiet', knownSessionId: state.sessionId }, actions: [] }` (bind identity, mint nothing).

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2. Expected: PASS (all new tests + all 15 pre-existing reducer tests).

- [ ] **Step 5: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/opencode-attention-bell
git add server/coding-cli/opencode-ownership-reducer.ts test/unit/server/coding-cli/opencode-ownership-reducer.test.ts
git commit -m "feat(opencode): per-turn abort gate in the ownership reducer"
```

---

### Task 2: Node tracker — session.error/message.updated vocabulary + child-idle suppression + version gate

**Files:**
- Modify: `server/coding-cli/opencode-activity-tracker.ts`
- Test: `test/unit/server/coding-cli/opencode-activity-tracker.test.ts`

**Interfaces:**
- Consumes: Task 1's `error` observation; existing SSE plumbing (`KNOWN_OPENCODE_EVENT_TYPES` `:115-120`, `OpencodeEventSchema` `:104-109`, `handleOpencodeEvent` `:510-568`, `resolveRootForEvent` `:570-591`).
- Produces: tracker recognizes `session.error` AND the abort-marked `message.updated` (W2 fallback, D1 — both forward the same `error` observation); child idle edges are suppressed (raw child id never completes the root); log-once version drift gate in the health path; tracker events unchanged (`'changed'`, `'turn.complete'`, `'association.requested'`).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/server/coding-cli/opencode-activity-tracker.test.ts`, reusing the file's own helpers (`createJsonResponse`, `createSseResponse`, `createControlledSseResponse`, `TEST_ENDPOINT`, fake-timer `beforeEach`/`afterEach` — see `:12-74`). Attach ALL collectors BEFORE the action under test (a prior codex bug was masked by attach-after).

```ts
describe('abort/error episodes (policy: PR #597 extended to opencode)', () => {
  it('Esc/abort stays silent: MessageAbortedError then double idle emits no completion', async () => {
    const sse = createControlledSseResponse()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return createJsonResponse({ healthy: true })
      if (url.endsWith('/session/status')) return createJsonResponse({ 'ses-root': { type: 'busy' } })
      if (url.endsWith('/event')) return sse.response
      throw new Error(`unexpected url ${url}`)
    })
    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
    const completions: unknown[] = []
    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('turn.complete', (e) => completions.push(e))
    tracker.on('changed', (c) => changes.push(c))
    tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-root' })
    await vi.advanceTimersByTimeAsync(0)
    sse.enqueue({ type: 'server.connected', properties: {} })
    await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-root knownBusy
    // live abort trace (events-B.log): error -> status idle -> session.idle -> status idle -> session.idle
    sse.enqueue({ type: 'session.error', properties: { sessionID: 'ses-root', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } })
    sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
    sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
    sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
    sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(completions).toEqual([])
    expect(changes.filter((c) => c.remove.length > 0)).toHaveLength(1) // one demotion, no double-remove
    tracker.dispose()
  })

  it('failed turn rings: UnknownError then idle emits exactly one completion; trailing error is a no-op', async () => {
    // same fixture shape as above; sequence from events-B.log scenario C:
    // busy -> error(UnknownError) -> status idle -> session.idle -> error(UnknownError, stack) AFTER idle
    // assert completions.length === 1 after the whole sequence
  })

  it('child session.idle mid-parent-turn does not complete the root (live trace events-D.log)', async () => {
    // snapshot: { 'ses-parent': busy }; then:
    // session.created { sessionID: 'ses-child', info: { id: 'ses-child', parentID: 'ses-parent' } }
    // session.status  { sessionID: 'ses-child', status: { type: 'busy' } }
    // session.status  { sessionID: 'ses-child', status: { type: 'idle' } }
    // session.idle    { sessionID: 'ses-child' }          <- 921ms before the parent, must be suppressed
    // assert completions === [] and the busy record survives with sessionId 'ses-parent'
    // then: session.status { sessionID: 'ses-parent', status: { type: 'idle' } }
    // assert exactly one completion for 'ses-parent'
  })

  it('child session.error does not abort the root turn', async () => {
    // snapshot: parent busy; session.created child(parentID=parent);
    // session.error { sessionID: 'ses-child', error: { name: 'MessageAbortedError', ... } }
    // session.status { sessionID: 'ses-parent', status: { type: 'idle' } }
    // assert exactly one completion (the parent's turn still rings)
  })

  it('W2 abort marker: message.updated carrying error MessageAbortedError then double idle is silent', async () => {
    // snapshot: { 'ses-root': busy }; then (abort window W2 — derives from opencode 1.18.11:
    // an abort landing between assistant-message creation and LLM stream start emits NO
    // session.error, only the abort-marked message.updated, always BEFORE idle):
    // message.updated { sessionID: 'ses-root', info: { id: 'msg-1', role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } }
    // session.status  { sessionID: 'ses-root', status: { type: 'idle' } }
    // session.idle    { sessionID: 'ses-root' }
    // session.status idle + session.idle again (double edge)
    // assert completions === [] and exactly one remove (same assertions as the session.error abort test)
  })
})

describe('version drift gate (log-once)', () => {
  it('warns once for untested opencode versions and bells stay on', async () => {
    // fixture health returns { healthy: true, version: '9.9.9' }; vi.spyOn(console, 'warn')
    // drive the monitor through TWO health polls (let the stream end once so a
    // reconnect cycle re-polls health); assert exactly ONE warning naming '9.9.9'
    // and the tested 1.18.x range; then busy -> idle still emits one completion
    // (bells stay on — the gate only logs)
  })
})
```

Write the six tests in full (the comment-annotated ones follow the first's fixture pattern verbatim — copy it; the comments above are the exact event sequences to enqueue and the exact assertions to make).

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/opencode-activity-tracker.test.ts --config config/vitest/vitest.server.config.ts`
Expected: FAIL — `session.error` (and abort-marked `message.updated`) events are silently dropped today (abort tests see a completion; child-idle test sees a false root completion); the version-gate test sees no warning.

- [ ] **Step 3: Implement**

In `server/coding-cli/opencode-activity-tracker.ts`:

1. Add the schema (near the other event schemas, ~`:93`):

```ts
const SessionErrorEventSchema = z
  .object({
    type: z.literal('session.error'),
    properties: z
      .object({
        sessionID: z.string().min(1),
        error: z.object({ name: z.string().min(1) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough()
```

2. Add the W2 abort-marker schema next to it (property path verified against the spike traces and the opencode v1.18.11 source — `properties.sessionID` + `properties.info.error.name`):

```ts
const MessageUpdatedEventSchema = z
  .object({
    type: z.literal('message.updated'),
    properties: z
      .object({
        sessionID: z.string().min(1),
        info: z
          .object({ error: z.object({ name: z.string().min(1) }).passthrough().optional() })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough()
```

3. Add `SessionErrorEventSchema` and `MessageUpdatedEventSchema` to the `OpencodeEventSchema` discriminated union (`:104-109`) and `'session.error'` + `'message.updated'` to `KNOWN_OPENCODE_EVENT_TYPES` (`:115-120`). (Both are required or `parseOpencodeEvent:187-189` drops them silently.)

4. In `handleOpencodeEvent` (`:510-568`), before the generic status handling, add:

```ts
    if (event.type === 'session.error') {
      const rawSessionId = event.properties.sessionID
      const rootSessionId = await this.resolveRootForEvent(monitor, rawSessionId)
      // Child or unresolved errors never gate the root's turn (a sub-agent
      // abort must not silence the parent; conservative for unknown ids).
      if (rootSessionId === undefined || rootSessionId !== rawSessionId) return
      this.observe(monitor, {
        kind: 'error',
        cycleId,
        streamId,
        sessionId: rootSessionId,
        errorName: event.properties.error.name,
        at: this.now(),
      })
      return
    }
```

5. W2 abort-marker forwarding — immediately after the `session.error` branch, add (both feed the SAME `error` observation; the reducer is unchanged):

```ts
    if (event.type === 'message.updated') {
      // W2 abort marker (derives from opencode 1.18.11): an abort landing
      // between assistant-message creation and LLM stream start emits NO
      // session.error — only message.updated with info.error.name ===
      // 'MessageAbortedError', always BEFORE the idle edge. Error-less
      // message.updated is routine message churn: no attention signal.
      const errorName = event.properties.info.error?.name
      if (errorName === undefined) return
      const rawSessionId = event.properties.sessionID
      const rootSessionId = await this.resolveRootForEvent(monitor, rawSessionId)
      // Same raw-equality scoping as session.error: child or unresolved
      // markers never gate the root's turn.
      if (rootSessionId === undefined || rootSessionId !== rawSessionId) return
      this.observe(monitor, {
        kind: 'error',
        cycleId,
        streamId,
        sessionId: rootSessionId,
        errorName,
        at: this.now(),
      })
      return
    }
```

6. Child-idle suppression — in the idle branch (`:539-549`), guard before observing:

```ts
      // Child sessions go idle mid-parent-turn (live trace: child idle 921ms
      // before the parent, events-D.log). Remapping a CHILD idle onto the
      // root falsely completes the root's turn — suppress it. The root's own
      // idle (raw id == resolved root) passes through unchanged.
      if (observedSessionId !== undefined && observedSessionId !== event.properties.sessionID) {
        return
      }
```

Busy/retry remapping (`:551-567`) stays exactly as-is (child busy keeps the root busy — matches the snapshot path's "busy beats idle" collapsing at `classifyKnownSnapshotStatuses:829-842`).

7. Version drift gate (log-once, per monitor) — in the health-poll success path (where `GET /global/health` parses `{ healthy: true }`), read the response's `version` field (REQUIRED in the 1.18.11 health schema) and add:

```ts
// derives from opencode 1.18.11: /global/health returns { healthy, version },
// both required. session.idle is already deprecated upstream and a v1->v2
// event/health migration is in progress — warn on untested versions, but keep
// bells ON (best-effort; the gate converts silent drift into a logged warning).
const TESTED_OPENCODE_VERSION_RANGE = '1.18.'
```

If `typeof version === 'string' && !version.startsWith(TESTED_OPENCODE_VERSION_RANGE)` and the monitor has not warned yet (`versionWarned` boolean on the monitor state, reset in `trackTerminal`), `console.warn(...)` once naming the observed version and the tested range, then set the flag. No behavior change otherwise.

- [ ] **Step 4: Run to verify pass**

Run: same as Step 2. Expected: PASS — all 24 pre-existing tests plus the 6 new ones. If a pre-existing test pinned the old child-idle remap behavior, rewrite it with a `// SEMANTIC CHANGE (opencode-attention-bell): child idle is suppressed, not remapped` comment. (The explorer sweep found NO existing test emitting a child idle, so none is expected to break.)

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/opencode-activity-tracker.ts test/unit/server/coding-cli/opencode-activity-tracker.test.ts
git commit -m "feat(opencode): abort vocabulary (session.error + message.updated marker), child-idle suppression, version gate"
```

---

### Task 3: Node tracker — permission pause lane

**Files:**
- Modify: `server/coding-cli/opencode-activity-tracker.ts`
- Test: `test/unit/server/coding-cli/opencode-activity-tracker.test.ts`

**Interfaces:**
- Consumes: Task 2's vocabulary plumbing; the existing root resolver `resolveRootForEvent` (`:570-591` — D3's child→root pause resolution reuses it); codex's approval-pause pattern (`codex-activity-tracker.ts:359-409`: demote via `'changed'` FIRST, `'attention.boundary'` SECOND, newly-inserted-id dedupe).
- Produces (relied on by Task 4 and by the already-wired emitter):
  - Tracker emits `'attention.boundary'` → `{ terminalId: string; at: number }` (the `wireTrulyIdleEmitter` subscription at `truly-idle-emitter.ts:230` already forwards it — ZERO `server/index.ts` changes).
  - `removeRecord(terminalId: string, opts?: { forceEmit?: boolean }): void`
  - Private `pendingPermissions: Map<string, Set<string>>`; `hasPendingPermissions(terminalId: string): boolean` (private helper, read by Task 4).

- [ ] **Step 1: Write the failing tests**

Append to the tracker test file, using the Task 2 fixture pattern and a codex-style multi-stream collector (attach BEFORE acting):

```ts
function collectOpencode(tracker: OpencodeActivityTracker) {
  const collected = {
    changes: [] as Array<{ upsert: unknown[]; remove: string[] }>,
    boundaries: [] as Array<{ terminalId: string; at: number }>,
    completions: [] as unknown[],
  }
  tracker.on('changed', (c) => collected.changes.push(c))
  tracker.on('attention.boundary', (e) => collected.boundaries.push(e))
  tracker.on('turn.complete', (e) => collected.completions.push(e))
  return collected
}

describe('permission pause semantics (codex approval-pause mirror)', () => {
  it('permission.asked on the owned busy session demotes then arms the boundary once', async () => {
    // fixture: snapshot { 'ses-root': busy } -> knownBusy, record present
    // enqueue: { type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-root', permission: 'bash', patterns: ['sleep 60'], metadata: {}, always: [] } }
    // assert: exactly one 'changed' with remove ['term-1'] (demotion),
    //         exactly one boundary { terminalId: 'term-1' },
    //         and the change was emitted BEFORE the boundary
    //         (record the arrival order in a combined log array).
  })
  it('duplicate permission.asked ids never re-arm', async () => {
    // enqueue the same permission.asked twice; assert boundaries.length === 1
  })
  it('permission.replied resumes busy immediately (cancels within grace)', async () => {
    // after the pause, enqueue { type: 'permission.replied', properties: { sessionID: 'ses-root', requestID: 'per-1', reply: 'once' } }
    // assert a busy upsert with sessionId 'ses-root' is emitted
  })
  it('abort mid-pause force-emits the removal and mints nothing', async () => {
    // pause active -> enqueue session.error MessageAbortedError + double idle
    // assert: completions === [], boundaries.length === 1 (no re-arm),
    //         and a SECOND 'changed' remove for term-1 was emitted (the force-emit
    //         that cancels the armed grace window at the emitter)
  })
  it('failure mid-pause retires the pause without a second bell', async () => {
    // pause active -> enqueue session.error UnknownError + idle edges
    // assert: completions === [] (turnComplete swallowed), boundaries.length === 1,
    //         and NO second 'changed' remove was emitted (grace left to fire once)
  })
  it('child permission.asked root-resolves to the owned root and arms the pause', async () => {
    // SEMANTIC CHANGE vs raw-equality scoping: children CAN ask — their asks
    // carry the CHILD sessionID and the parent turn blocks on them (opencode
    // v1.18.11 source, validation pass 2026-08-03).
    // register the child: session.created { info: { id: 'ses-child', parentID: 'ses-root' } }
    // enqueue permission.asked { id: 'per-c1', sessionID: 'ses-child' }
    // assert: one demotion + one boundary for term-1 (same ordering assertion as the first test)
  })
  it('permission.asked for a foreign/unresolvable session is ignored', async () => {
    // enqueue permission.asked with sessionID 'ses-other' (never registered, not the root)
    // assert boundaries === [] and no demotion
  })
  it('candidate-armed pause: a first-turn ask on a fresh pane rings', async () => {
    // fresh-pane fixture WITHOUT a resume session id (trackTerminal({ terminalId, endpoint }))
    // busy for 'ses-new' -> candidate ownership (whole first turn by construction, D3)
    // enqueue permission.asked { id: 'per-1', sessionID: 'ses-new' }
    // assert: demotion + one boundary; then permission.replied restores the busy record
  })
  it('deferred completion after a candidate pause is swallowed at association confirm', async () => {
    // candidate pause (previous test's shape, without the reply) -> idle edge (turn end mid-pause)
    // -> the tracker requests association; confirm it via the tracker's
    //    confirmSessionAssociation path ({ sessionId: 'ses-new' })
    // assert: completions === [] (the deferred turnComplete minted at confirm is
    //         swallowed — the pause bell, rung or still in grace, was THE bell),
    //         boundaries.length === 1, and no force-emitted second remove
  })
})
```

Write all nine tests in full following the comments (they are exact sequences/assertions, same fixture as Task 2).

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/opencode-activity-tracker.test.ts --config config/vitest/vitest.server.config.ts`
Expected: FAIL — `permission.*` events are dropped (no boundaries emitted).

- [ ] **Step 3: Implement**

In `server/coding-cli/opencode-activity-tracker.ts`:

1. Schemas + vocabulary:

```ts
const PermissionAskedEventSchema = z
  .object({
    type: z.literal('permission.asked'),
    properties: z.object({ id: z.string().min(1), sessionID: z.string().min(1) }).passthrough(),
  })
  .passthrough()

const PermissionRepliedEventSchema = z
  .object({
    type: z.literal('permission.replied'),
    properties: z.object({ sessionID: z.string().min(1), requestID: z.string().min(1) }).passthrough(),
  })
  .passthrough()
```

Add both to `OpencodeEventSchema` and `'permission.asked'`/`'permission.replied'` to `KNOWN_OPENCODE_EVENT_TYPES`.

2. Tracker field + helper:

```ts
  private readonly pendingPermissions = new Map<string, Set<string>>()

  private hasPendingPermissions(terminalId: string): boolean {
    return (this.pendingPermissions.get(terminalId)?.size ?? 0) > 0
  }
```

Clear the terminal's entry in `untrackTerminal` and in `trackTerminal`'s early-return reset block.

3. In `handleOpencodeEvent`, before the status handling:

```ts
    if (event.type === 'permission.asked') {
      const ownership = monitor.ownership
      // Root-resolve the asker (D3): children CAN ask — the event is stamped
      // with the CHILD session id and the parent turn blocks on it (opencode
      // v1.18.11 source, validation pass 2026-08-03). Multi-level chain walk;
      // mappings are retained for the session's lifetime.
      const rootSessionId = await this.resolveRootForEvent(monitor, event.properties.sessionID)
      if (rootSessionId === undefined) return
      // Arm under knownBusy OR candidate ownership: a fresh pane is candidate
      // for its ENTIRE first turn by construction (the bind lands only at the
      // first idle edge), and the single busy unbound session on the pane's
      // own per-pane endpoint is this pane's turn — first-turn tool-permission
      // asks are the most common attention scenario and must ring (D3).
      // Ambiguous/quiet stays conservative (no bells).
      if (
        (ownership.kind !== 'knownBusy' && ownership.kind !== 'candidate') ||
        ownership.sessionId !== rootSessionId
      ) {
        return
      }
      const pending = this.pendingPermissions.get(monitor.terminalId) ?? new Set<string>()
      const newlyInserted = !pending.has(event.properties.id)
      pending.add(event.properties.id)
      this.pendingPermissions.set(monitor.terminalId, pending)
      if (!newlyInserted) return // duplicate asked never re-arms
      const at = this.now()
      // Demote FIRST (record removal is opencode's not-busy on the wire),
      // boundary SECOND — the gate must see not-busy before it arms
      // (codex ordering, codex-activity-tracker.ts:377-382).
      this.removeRecord(monitor.terminalId)
      this.emit('attention.boundary', { terminalId: monitor.terminalId, at })
      return
    }
    if (event.type === 'permission.replied') {
      const pending = this.pendingPermissions.get(monitor.terminalId)
      if (!pending?.delete(event.properties.requestID)) return
      if (pending.size > 0) return
      this.pendingPermissions.delete(monitor.terminalId)
      const ownership = monitor.ownership
      // Restore under candidate too — pause mechanics are identical (D3).
      if (ownership.kind !== 'knownBusy' && ownership.kind !== 'candidate') return
      // Resume busy immediately (codex resume_busy_after_approval analog):
      // the reply proves a human is present; busy re-entry cancels the armed
      // grace window without waiting ~1s for the next session.status{busy}.
      this.upsertRecord({
        terminalId: monitor.terminalId,
        sessionId: ownership.sessionId,
        phase: 'busy',
        updatedAt: this.now(),
        lastObservedAt: this.now(),
      })
      return
    }
```

(Match `upsertRecord`'s actual record shape at `:704-724` — it requires `lastObservedAt`.)

4. `removeRecord` force flag (`:726-732`):

```ts
  private removeRecord(terminalId: string, opts?: { forceEmit?: boolean }): void {
    const existed = this.records.delete(terminalId)
    if (!existed && !opts?.forceEmit) return
    this.emit('changed', { upsert: [], remove: [terminalId] } satisfies OpencodeActivityChange)
  }
```

5. Mid-pause coordination in `applyActions` (`:615-652`). Refactor the existing `switch` body into a private `applyAction(terminalId, action)` and wrap (NOTE: applyActions runs AFTER the reducer transition, so `monitor.ownership` is the POST-observation state — that is what distinguishes a knownBusy turn end from a candidate one):

```ts
  private applyActions(terminalId: string, actions: OpencodeOwnershipAction[]): void {
    const ownership = this.monitors.get(terminalId)?.ownership
    const pauseActive = this.hasPendingPermissions(terminalId)
    const idleEdge = actions.some((a) => a.kind === 'activityRemove')
    const completionEdge = actions.some((a) => a.kind === 'turnComplete')
    if (pauseActive && (idleEdge || completionEdge)) {
      // Mid-pause turn end: the pause is THE attention episode for this turn.
      // Never mint a second bell (codex PR #597 mid-pause silent-claim
      // hardening, mirrored). A completion WITHOUT an idle edge is the
      // DEFERRED completion minted at confirmOpencodeAssociation
      // (candidate-armed pauses, D3) — swallowed the same way.
      const awaitingBind = ownership?.kind === 'awaitingAssociation'
      const aborted = awaitingBind && ownership.aborted === true
      if (awaitingBind && !aborted) {
        // Candidate turn end mid-pause: KEEP the pause claim alive so the
        // deferred completion minted at confirm is swallowed on its own pass
        // through this branch. The armed grace window stays live — the pause
        // bell (rung or still in grace) is the episode's bell.
      } else {
        this.pendingPermissions.delete(terminalId)
      }
      if ((!completionEdge && !awaitingBind) || aborted) {
        // Abort mid-pause (knownBusy -> quiet, or aborted candidate ->
        // awaitingAssociation{aborted}): human at keyboard — force-emit the
        // removal so the emitter cancels any still-armed grace window (the
        // record itself was already removed at pause entry).
        this.removeRecord(terminalId, { forceEmit: true })
      }
      for (const action of actions) {
        if (action.kind === 'turnComplete') continue // swallowed: no frame, no ledger entry
        if (action.kind === 'activityRemove') continue // handled above / already removed
        this.applyAction(terminalId, action)
      }
      return
    }
    if (pauseActive && actions.some((a) => a.kind === 'activityUpsert')) {
      this.pendingPermissions.delete(terminalId) // busy resumed out-of-band: pause over
    }
    for (const action of actions) this.applyAction(terminalId, action)
  }
```

- [ ] **Step 4: Run to verify pass**

Run: same command. Expected: PASS (all tracker tests).

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/opencode-activity-tracker.ts test/unit/server/coding-cli/opencode-activity-tracker.test.ts
git commit -m "feat(opencode): permission-pause attention boundary with mid-pause hardening"
```

---

### Task 4: Node death bells — spontaneous-exit discriminator

**Files:**
- Modify: `server/coding-cli/opencode-activity-tracker.ts`, `server/coding-cli/opencode-activity-wiring.ts`
- Test: `test/unit/server/coding-cli/opencode-activity-tracker.test.ts`, `test/unit/server/coding-cli/opencode-activity-wiring.test.ts`, `test/unit/server/coding-cli/truly-idle-emitter.test.ts`

**Interfaces:**
- Consumes: registry exit discriminator (`terminal-registry.ts:1542` emits `spontaneous: !requestedClose`; `kill()` emits `spontaneous: false` at `:4129`); emitter ring condition (`truly-idle-emitter.ts:132`: `spontaneous.has(id) && (engaged || approvalPending.has(id))` where `engaged = (busy && !pending) || graceTimer !== undefined`).
- Produces:
  - `OpencodeActivityChange` gains `spontaneousExitRemovals?: string[]` and `approvalPendingRemovals?: string[]` (internal-only; `ws-handler.broadcastOpencodeActivityUpdated:3872-3885` re-validates through the non-strict zod schema, so the extra fields never reach the wire).
  - `untrackTerminal(input: { terminalId: string; spontaneous?: boolean }): void` — internal callers (`trackTerminal:283`, `dispose:317`) stay flag-less.

- [ ] **Step 1: Write the failing tracker tests**

Append to the tracker test file (Task 2 fixture; collector arrays typed `Array<{ upsert: unknown[]; remove: string[]; spontaneousExitRemovals?: string[]; approvalPendingRemovals?: string[] }>`):

```ts
describe('death-bell markers on spontaneous exit', () => {
  it('spontaneous exit while knownBusy marks the removal', async () => {
    // knownBusy via snapshot; then tracker.untrackTerminal({ terminalId: 'term-1', spontaneous: true })
    // assert last change === { upsert: [], remove: ['term-1'], spontaneousExitRemovals: ['term-1'] }
  })
  it('spontaneous exit during a permission pause marks approvalPendingRemovals and emits despite the absent record', async () => {
    // knownBusy -> permission.asked (record removed) -> untrackTerminal spontaneous
    // assert change === { upsert: [], remove: ['term-1'], spontaneousExitRemovals: ['term-1'], approvalPendingRemovals: ['term-1'] }
  })
  it('spontaneous exit while candidate or ambiguous carries NO marker', async () => {
    // drive ownership to candidate (busy for an unknown session with no resume id);
    // untrackTerminal spontaneous; assert the change has no spontaneousExitRemovals.
    // Repeat WITH a candidate-armed permission.asked pending: still no marker —
    // D4 keeps candidate excluded even mid-pause (residual D8(i)).
  })
  it('freshell-initiated untrack (no flag) behaves exactly as before', async () => {
    // untrackTerminal({ terminalId: 'term-1' }) after knownBusy
    // assert plain { upsert: [], remove: ['term-1'] } with no marker fields
  })
  it('spontaneous exit of a terminal that was never tracked emits NOTHING', async () => {
    // NO trackTerminal call for 'term-9'; tracker.untrackTerminal({ terminalId: 'term-9', spontaneous: true })
    // assert the 'changed' collector saw NO event mentioning 'term-9'.
    // The wiring feeds EVERY registry terminal.exit (bash/claude/codex panes
    // included) through untrackTerminal; untracked terminals must stay as
    // silent as today (removeRecord's existence guard).
  })
})
```

Write the five tests in full per the comments.

- [ ] **Step 2: Write the failing emitter episode test**

Append to `test/unit/server/coding-cli/truly-idle-emitter.test.ts` (its `beforeEach` uses fake timers + `emitter.on('idle', ...)` collectors — follow `:14-25`):

```ts
  it('opencode death while grace is armed rings immediately (post-turn window)', () => {
    // opencode shape: turn end = remove followed by turnComplete, then death
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }] })
    emitter.noteActivityChanged({ remove: ['t1'] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() }) // arms grace
    emitter.noteActivityChanged({ remove: ['t1'], spontaneousExitRemovals: ['t1'] })
    expect(events).toEqual([{ terminalId: 't1', at: Date.now(), reason: 'grace' }])
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS + 1)
    expect(events).toHaveLength(1) // the armed window was cancelled by the removal — no double ring
  })
```

(The busy/approval-pending death cases are already covered generically at `:126-179` and `:329-351`; this pins the opencode-specific remove-then-boundary shape.)

- [ ] **Step 3: Run to verify failure**

Run both files:
`npm run test:vitest -- run test/unit/server/coding-cli/opencode-activity-tracker.test.ts test/unit/server/coding-cli/truly-idle-emitter.test.ts --config config/vitest/vitest.server.config.ts`
Expected: the marker-asserting tracker tests (knownBusy, permission-pause) FAIL (no marker fields; TypeScript may reject `spontaneous` on `untrackTerminal`); the candidate/no-flag/never-tracked pins may already PASS (they pin existing silence); the emitter test may already PASS (the emitter is generic) — note any already-passing pins in the commit message; they are pins, not change drivers.

- [ ] **Step 4: Implement**

1. `OpencodeActivityChange` (`opencode-activity-tracker.ts:37-40`):

```ts
export type OpencodeActivityChange = {
  upsert: OpencodeActivityRecord[]
  remove: string[]
  /**
   * Terminals whose PTY exit was NOT freshell-initiated (registry
   * `spontaneous: !requestedClose`). Internal-only: the ws-handler's zod
   * re-validation strips it from the wire. Death-bell input for the
   * truly-idle emitter.
   */
  spontaneousExitRemovals?: string[]
  /** Terminals with a pending permission pause at exit time (rings even though the record is absent). */
  approvalPendingRemovals?: string[]
}
```

2. `untrackTerminal` (`:296-313`) — read engagement BEFORE teardown (audit-A17 ordering, same as Rust `activity.rs:787-819`):

```ts
  untrackTerminal(input: { terminalId: string; spontaneous?: boolean }): void {
    const monitor = this.monitors.get(input.terminalId)
    // Engagement inputs are captured BEFORE teardown destroys them.
    // candidate/ambiguous ownership never death-rings (D4: that noise is why
    // opencode death bells were excluded before).
    const ownershipKind = monitor?.ownership.kind
    // `monitor !== undefined` gates the whole path: the wiring subscribes to
    // EVERY registry terminal.exit (non-opencode panes included), so a
    // never-tracked terminal must fall through to the silent removeRecord
    // branch exactly as today. A permission pause removes only the record,
    // never the monitor, so paused panes keep their monitor and stay eligible.
    const deathBellEligible =
      monitor !== undefined &&
      input.spontaneous === true &&
      ownershipKind !== 'candidate' &&
      ownershipKind !== 'ambiguous'
    const approvalPending = this.hasPendingPermissions(input.terminalId)
    this.pendingPermissions.delete(input.terminalId)
    // ... existing teardown body unchanged (dispose monitor, abort controller,
    //     clear reconnect timer, delete childSessionIds/sessionRootsByTerminal) ...
    if (deathBellEligible) {
      // Emit UNCONDITIONALLY: the record is usually already gone (turn ended
      // or pause demoted), and the emitter needs the marked removal to reach
      // its armed-grace / approval-pending checks.
      this.records.delete(input.terminalId)
      this.emit('changed', {
        upsert: [],
        remove: [input.terminalId],
        spontaneousExitRemovals: [input.terminalId],
        ...(approvalPending ? { approvalPendingRemovals: [input.terminalId] } : {}),
      } satisfies OpencodeActivityChange)
    } else {
      this.removeRecord(input.terminalId)
    }
  }
```

3. Wiring (`opencode-activity-wiring.ts:86-89`):

```ts
  const onExit = (event: { terminalId?: string; spontaneous?: boolean }) => {
    if (!event.terminalId) return
    tracker.untrackTerminal({ terminalId: event.terminalId, spontaneous: event.spontaneous === true })
  }
```

Add a wiring test in `opencode-activity-wiring.test.ts` (reuse `makeRegistry:29-38`): emit `registry.emit('terminal.exit', { terminalId, spontaneous: true })` and assert the tracker's `'changed'` payload carries `spontaneousExitRemovals` (spy via a collector on the returned `tracker`).

- [ ] **Step 5: Run to verify pass**

Run: the Step 3 command plus `npm run test:vitest -- run test/unit/server/coding-cli/opencode-activity-wiring.test.ts --config config/vitest/vitest.server.config.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/opencode-activity-tracker.ts server/coding-cli/opencode-activity-wiring.ts test/unit/server/coding-cli/
git commit -m "feat(opencode): death bells on spontaneous exit, ownership-scoped engagement"
```

---

### Task 5: Node pins — full live-trace child episode + resolver wiring regression pin

**Files:**
- Test: `test/unit/server/coding-cli/opencode-activity-tracker.test.ts`
- Create test: `test/unit/server/coding-cli/opencode-activity-integration.test.ts`

**Interfaces:**
- Consumes: `createOpencodeActivityIntegration` (`server/coding-cli/opencode-activity-integration.ts:16-22`), `OpencodeRootResolution` (`providers/opencode.ts:32-37`).
- Produces: regression pins only — no production code changes.

- [ ] **Step 1: Write the full live-trace child episode test (events-D.log, exact ordering)**

Append to the tracker test file — this is the codex sub-agent false-green analog, pinned end-to-end:

```ts
  it('full events-D.log episode: child busy/idle mid-parent-turn yields exactly one parent completion and no early removal', async () => {
    // fixture as in Task 2; snapshot { 'ses-parent': { type: 'busy' } }
    // enqueue, in live order (server-derived timings in comments):
    // 21:30:34.304 session.created child (info.parentID = 'ses-parent')
    // 21:30:34.344 session.status child busy
    // 21:30:36.089 session.status child idle
    // 21:30:36.089 session.idle child            <- must NOT remove the record or complete
    // 21:30:37.010 session.status parent idle    <- the real edge
    // 21:30:37.010 session.idle parent           <- deduped
    // assertions:
    //   completions === [ one entry with sessionId 'ses-parent' ]
    //   changes: no remove before the parent idle; exactly one remove total
  })
```

Write it in full.

- [ ] **Step 2: Write the resolver wiring pin test**

Create `test/unit/server/coding-cli/opencode-activity-integration.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpencodeActivityIntegration } from '../../../../server/coding-cli/opencode-activity-integration.js'

function makeRegistry() {
  const registry = new EventEmitter() as any
  registry.list = vi.fn(() => [])
  registry.get = vi.fn(() => undefined)
  registry.bindSession = vi.fn(() => ({ ok: true }))
  registry.rebindSession = vi.fn(() => ({ ok: true }))
  return registry
}

describe('opencode activity integration (resolver regression pin, docs/plans/2026-05-09-fix-opencode-ambiguous-ownership.md)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('injects the provider resolver — construction survives production mode (no identity-resolver fallback)', () => {
    // Outside tests the tracker constructor THROWS unless a real resolver is
    // injected (opencode-activity-tracker.ts:242-246). If index-style wiring
    // ever loses the provider resolver again, this pin goes red.
    vi.stubEnv('NODE_ENV', 'production')
    const resolveOpencodeSessionRoots = vi.fn(async (ids: readonly string[]) => ({
      rootsBySessionId: new Map(ids.map((id) => [id, id])),
      unresolvedSessionIds: new Set<string>(),
    }))
    const integration = createOpencodeActivityIntegration({
      registry: makeRegistry(),
      opencodeProvider: { resolveOpencodeSessionRoots },
    })
    expect(integration.tracker).toBeDefined()
    integration.dispose()
  })
})
```

- [ ] **Step 3: Run to verify (RED where applicable)**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/opencode-activity-tracker.test.ts test/unit/server/coding-cli/opencode-activity-integration.test.ts --config config/vitest/vitest.server.config.ts`
Expected: the child episode test PASSES (Task 2 implemented suppression — this is a pin); the integration test PASSES (pin). If either FAILS, there is a real bug — fix it before proceeding (do not weaken the pin).

- [ ] **Step 4: Commit**

```bash
git add test/unit/server/coding-cli/
git commit -m "test(opencode): pin live-trace child episode and production resolver wiring"
```

---

### Task 6: Rust tracker core — `crates/freshell-activity/src/opencode.rs`

**Files:**
- Create: `crates/freshell-activity/src/opencode.rs`
- Modify: `crates/freshell-activity/src/lib.rs` (add `pub mod opencode;` to the module list at `:27-32`)

**Interfaces:**
- Consumes: `TrackerEffect<R>` (`lib.rs:39-56`), `TurnCompletionLedger` (`ledger.rs`), `freshell_protocol::{OpencodeActivityRecord, OpencodePhase}` (`common.rs:376-384`, `:328-332` — `Busy` is the ONLY phase; not-busy == record absence), `TurnCompletionSnapshot`.
- Produces (used by Tasks 7–10):

```rust
pub const OPENCODE_BUSY_DEADMAN_MS: i64 = 120_000; // mirrors Node OPENCODE_BUSY_DEADMAN_MS

pub type OpencodeEffect = TrackerEffect<OpencodeActivityRecord>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpencodeStatus { Busy, Retry, Idle } // retry is busy everywhere (D6)

pub struct OpencodeActivityTracker { /* states: HashMap<String, TerminalOpencode>, ledger, busy_deadman_ms */ }

impl OpencodeActivityTracker {
    pub fn new() -> Self;
    pub fn set_busy_deadman_ms(&mut self, ms: i64);
    pub fn list(&self) -> Vec<OpencodeActivityRecord>;
    pub fn list_latest_completions(&self) -> Vec<freshell_protocol::TurnCompletionSnapshot>;
    pub fn track_terminal(&mut self, terminal_id: &str, session_id: Option<&str>, at: i64) -> Vec<OpencodeEffect>;
    pub fn bind_session(&mut self, terminal_id: &str, session_id: &str, at: i64) -> Vec<OpencodeEffect>;
    pub fn note_session_created(&mut self, terminal_id: &str, session_id: &str, parent_id: Option<&str>, at: i64) -> Vec<OpencodeEffect>;
    pub fn note_status(&mut self, terminal_id: &str, session_id: &str, status: OpencodeStatus, cycle: u64, stream: u64, at: i64) -> Vec<OpencodeEffect>;
    pub fn note_session_idle(&mut self, terminal_id: &str, session_id: &str, cycle: u64, stream: u64, at: i64) -> Vec<OpencodeEffect>;
    pub fn note_snapshot(&mut self, terminal_id: &str, statuses: &[(String, OpencodeStatus)], cycle: u64, stream: u64, at: i64) -> Vec<OpencodeEffect>;
    pub fn note_exit(&mut self, terminal_id: &str) -> Vec<OpencodeEffect>;
    pub fn expire(&mut self, at: i64) -> Vec<OpencodeEffect>;
    pub fn next_deadline(&self) -> Option<i64>;
}
```

**Semantics to port (this is the Node reducer, `opencode-ownership-reducer.ts`, plus D1–D6; the branch tables below are normative):**

Ownership enum (private):

```rust
#[derive(Debug, Clone, PartialEq)]
enum Ownership {
    Quiet { known_session_id: Option<String> },
    Candidate { session_id: String, previous_known: Option<String>, cycle: u64, stream: u64, turn_aborted: bool },
    KnownBusy { session_id: String, cycle: u64, stream: u64, turn_aborted: bool },
    AwaitingAssociation { session_id: String, previous_known: Option<String>, completed_at: i64, aborted: bool },
    Ambiguous { known_session_id: Option<String>, blocked: Vec<String> },
}
```

Per-terminal state (private):

```rust
#[derive(Debug)]
struct TerminalOpencode {
    terminal_id: String,
    ownership: Ownership,
    /// session id -> root session id (built from session.created parentID; self-mapped roots).
    session_roots: std::collections::HashMap<String, String>,
    /// pending permission ids (Task 7).
    pending_permissions: std::collections::HashSet<String>,
    /// present == busy on the wire (OpencodePhase::Busy is the only phase).
    record: Option<OpencodeActivityRecord>,
    last_observed_at: i64,
}
```

Record helpers (compare like codex `has_public_change:180-185` — phase + session only, so repeated busy events don't spam frames; a deliberate, documented divergence from Node's timestamp-sensitive dedupe):

```rust
fn set_busy_record(state: &mut TerminalOpencode, session_id: Option<String>, at: i64) -> Vec<OpencodeEffect> {
    let next = OpencodeActivityRecord {
        terminal_id: state.terminal_id.clone(),
        phase: freshell_protocol::OpencodePhase::Busy,
        updated_at: at,
        session_id,
    };
    let changed = match &state.record {
        Some(prev) => prev.session_id != next.session_id,
        None => true,
    };
    state.record = Some(next.clone());
    if changed {
        vec![TrackerEffect::Changed { upsert: vec![next], remove: vec![] }]
    } else {
        Vec::new()
    }
}

fn clear_record(state: &mut TerminalOpencode, force: bool) -> Vec<OpencodeEffect> {
    if state.record.take().is_none() && !force {
        return Vec::new();
    }
    vec![TrackerEffect::Changed { upsert: vec![], remove: vec![state.terminal_id.clone()] }]
}
```

Root resolution: `fn resolve_root<'a>(state: &'a TerminalOpencode, session_id: &'a str) -> &'a str` — walk `session_roots` with a seen-set cycle guard; unknown id resolves to itself. The pure tracker stays RESOLVER-FREE (no IO): recovery of ids never seen on-stream is the LANE's job — Task 9's HTTP root-resolver fallback emits synthetic `note_session_created` calls before the triggering event, so by the time an event reaches this tracker the mapping either exists or the conservative-ambiguity rules apply.

`note_status`/`note_session_idle` routing: resolve the root; **child idle (root != raw) is suppressed (D5)**; child busy/retry remaps to the root; then dispatch to the idle/busy reducers below. Every `note_*` updates `last_observed_at = at`.

**Idle-edge reducer** (`session.idle` or `session.status{idle}`), with cycle/stream guards exactly like Node `sameSessionStream`:

| Ownership | Guard | Next state | Effects (in order) |
|---|---|---|---|
| `KnownBusy{session==s, cycle==c, stream==st, turn_aborted}` | id+cycle+stream match | `Quiet{known: Some(s)}` | `clear_record(false)`; then if `!turn_aborted`: `TurnComplete{terminal_id, session_id: Some(s), at, completion_seq: ledger.record_turn_completion(terminal_id, at)}` (Task 7 adds the mid-pause override here) |
| `Candidate{...}` matching | same | `AwaitingAssociation{session_id, previous_known, completed_at: at, aborted: turn_aborted}` | `clear_record(false)` (completion deferred to `bind_session`; Task 7: a candidate-armed pause claim survives into `AwaitingAssociation`) |
| `Ambiguous{blocked}` | session in `blocked` | drop it; empty → `Quiet{known}` | empty → `clear_record(false)`; non-empty → `set_busy_record(None, at)` |
| `Quiet` / `AwaitingAssociation` | — | unchanged | none (this IS the double-idle dedupe, D2) |

**Busy reducer** (busy or retry):

| Ownership | Next state | Effects |
|---|---|---|
| `Quiet{known: Some(k)}`, s == k | `KnownBusy{k, cycle, stream, turn_aborted: false}` | `set_busy_record(Some(k), at)` |
| `Quiet{known: Some(k)}`, s != k | `Candidate{s, previous_known: Some(k), ..., false}` | `set_busy_record(Some(s), at)` |
| `Quiet{known: None}` | `Candidate{s, None, ..., false}` | `set_busy_record(Some(s), at)` |
| `Candidate` same s | refresh cycle/stream, `turn_aborted: false` | `set_busy_record(Some(s), at)` |
| `Candidate` different s | `Ambiguous{known: previous_known, blocked: sorted unique [old, s]}` | `set_busy_record(None, at)` |
| `KnownBusy` same s | refresh cycle/stream, `turn_aborted: false` (Task 7: also clears `pending_permissions` — busy resume) | `set_busy_record(Some(s), at)` |
| `KnownBusy` different s | `Ambiguous{known: Some(own), blocked: [own, s]}` | `set_busy_record(None, at)` |
| `Ambiguous` | add s to `blocked` if new | `set_busy_record(None, at)` |
| `AwaitingAssociation` | unchanged | none (Node `:205` drops it) |

**Snapshot reducer** (`note_snapshot`): collapse the status list onto roots (busy child wins over idle root, mirroring `classifyKnownSnapshotStatuses:829-842`), producing sorted unique `busy_roots: Vec<String>` (busy|retry only — absence == idle per the spike, and a literal `{type:"idle"}` entry is parsed and treated as absent). Then the Node `reduceSnapshot` branch table:

| Ownership | busy_roots | Next state | Effects |
|---|---|---|---|
| `Ambiguous` | empty | `Quiet{known}` | `clear_record(false)` |
| `Ambiguous` | single == known | `KnownBusy{known, cycle, stream, false}` | `set_busy_record(Some(known), at)` |
| `Ambiguous{known: None}` | single | `Candidate{s, None, ..., false}` | none (deliberately silent, Node `:296-307`) |
| `Ambiguous` | otherwise | recompute `blocked` (recompute, not union) | none |
| `KnownBusy` | empty | `Quiet{known: Some(own)}` | `clear_record(false)` + completion gated on `turn_aborted` (same as the idle-edge row) |
| `KnownBusy` | single == own | refresh cycle/stream | `set_busy_record(Some(own), at)` |
| `KnownBusy` | otherwise | `Ambiguous{Some(own), [own ∪ busy_roots]}` | `set_busy_record(None, at)` |
| `Candidate` | empty | `AwaitingAssociation{..., completed_at: at, aborted: turn_aborted}` | `clear_record(false)` |
| `Candidate` | single == own | refresh | `set_busy_record(Some(own), at)` |
| `Candidate` | otherwise | `Ambiguous` | `set_busy_record(None, at)` |
| `AwaitingAssociation` | any | unchanged | none |
| `Quiet` | empty | unchanged | `clear_record(false)` |
| `Quiet{known: Some(k)}` | contains k, single | `KnownBusy{k, ...}` | `set_busy_record(Some(k), at)` |
| `Quiet{known: Some(k)}` | single s, s != k | `Candidate{s, previous_known: Some(k), ..., false}` | `set_busy_record(Some(s), at)` (Node `reduceSnapshot:406-417` — session switched during an SSE reconnect gap, visible only in the snapshot; mirrors the busy reducer's foreign-busy row) |
| `Quiet{known: Some(k)}` | multiple | `Ambiguous{Some(k), busy_roots}` | `set_busy_record(None, at)` |
| `Quiet{known: None}` | exactly one | `Candidate{s, None, ...}` | `set_busy_record(Some(s), at)` |
| `Quiet{known: None}` | multiple | `Ambiguous{None, busy_roots}` | `set_busy_record(None, at)` |

**`bind_session`** (association/rebind identity arriving from the SQLite locator or the TUI rebind plugin — Task 10 wires the producers):
- `AwaitingAssociation{session_id == bound, aborted: false}` → `Quiet{known: Some(bound)}` + `TurnComplete{..., at: completed_at, completion_seq: ledger...}` (deferred completion, Node `confirmOpencodeAssociation:440-458` — note `at` is the STORED `completed_at`; Task 7 adds the mid-pause swallow override here: a surviving candidate-armed pause claim swallows this deferred completion).
- `AwaitingAssociation{session_id == bound, aborted: true}` → `Quiet{known: Some(bound)}`, no effects.
- `AwaitingAssociation{different}` → `Quiet{known: previous_known}`, no effects (reject analog).
- `Ambiguous` → update `known_session_id = Some(bound)` in place (Node's session.created adoption assist; the next snapshot resolves it).
- `Quiet`/`Candidate`/`KnownBusy` → set/replace the known id: `Quiet` → `Quiet{known: Some(bound)}`; `Candidate{session==bound}` → `KnownBusy` (preserve cycle/stream/turn_aborted) + `set_busy_record(Some(bound), at)`; `Candidate{different}` → keep candidate, set `previous_known = Some(bound)`; `KnownBusy` → keep (identity already flowing).
- Also self-map `session_roots.insert(bound.clone(), bound.clone())`.

**`note_session_created`**: if `parent_id` is `Some(p)`: `let root = resolve_root(state, p).to_string()`; insert `p → root` (self-map if unknown) and `session_id → root`. If ownership is `Ambiguous{known: None, ..}` → set `known_session_id = Some(root)` (Node `:520-529` analog; the next snapshot/status resolves). If `parent_id` is `None`: self-map `session_id → session_id`. No effects.

**`track_terminal`**: create-or-reset the state: `ownership = Quiet{known: session_id.map(...)}`, clear maps/sets, `last_observed_at = at`; if a stale record existed → `clear_record(false)` effect. **`note_exit`**: remove the whole state; if a record was present → `Changed{remove}` effect. **`expire(at)`**: any state with `record.is_some() && at - last_observed_at > busy_deadman_ms` → drop the record (`clear_record(false)`, NO completion — deadman swallow is silent, residual (e)). **`next_deadline`**: min over record-holding states of `last_observed_at + busy_deadman_ms`.

- [ ] **Step 1: Write the failing tests**

Create the file with the types above stubbed (`todo!()` bodies are fine for RED) and an in-file `#[cfg(test)] mod tests` (codex style: helpers `fn completions(effects: &[OpencodeEffect]) -> Vec<...>` etc.). Tests to write (all pure, no tokio):

```rust
#[test] fn completed_turn_emits_remove_then_turn_complete() { /* track(Some("ses-r")) -> note_status busy -> note_session_idle; assert effects order: Changed{upsert busy}, then on idle: Changed{remove} BEFORE TurnComplete (D7 ordering) */ }
#[test] fn double_session_idle_is_deduped() { /* second note_session_idle returns no effects */ }
#[test] fn session_status_idle_then_session_idle_yields_one_completion() { /* the spike's 7ms twin */ }
#[test] fn retry_status_counts_as_busy() { /* note_status Retry from quiet(known) -> KnownBusy record upsert */ }
#[test] fn child_idle_is_suppressed_and_child_busy_remaps_to_root() { /* note_session_created(child, parent) -> child busy refreshes root record (session_id stays root) -> child idle: NO effects, record survives -> parent idle: one completion */ }
#[test] fn candidate_completion_defers_to_bind_session() { /* no resume id: busy(ses-x) -> idle -> no TurnComplete; bind_session("ses-x") -> TurnComplete with at == the idle timestamp */ }
#[test] fn ambiguous_is_conservative_no_completions() { /* two different busy sessions -> ambiguous; all idles -> no TurnComplete ever; record ends removed */ }
#[test] fn snapshot_empty_completes_a_known_busy_turn() { /* snapshot path B */ }
#[test] fn snapshot_single_foreign_busy_from_quiet_known_enters_candidate() { /* track(Some("ses-r")) -> note_snapshot([("ses-x", Busy)]): assert Changed{upsert busy, session ses-x} (Quiet{known: Some(k)} + single foreign busy root -> Candidate{s, previous_known: Some(k)}, Node reduceSnapshot:406-417); then a matching idle for ses-x yields NO TurnComplete (candidate defers); bind_session("ses-x") -> TurnComplete (reconnect-gap session switch is not silently dropped) */ }
#[test] fn stale_cycle_idle_is_ignored() { /* idle with wrong cycle/stream leaves KnownBusy intact */ }
#[test] fn deadman_expiry_removes_silently() { /* set_busy_deadman_ms(1000); busy at t=0; expire(t=2000) -> Changed{remove}, no TurnComplete; next_deadline math */ }
```

Write each in full (they are direct method-call sequences with `assert_eq!` on effect vectors).

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/dan/code/freshell/.worktrees/opencode-attention-bell && cargo test -p freshell-activity opencode`
Expected: FAIL (todo! panics / compile errors count as RED).

- [ ] **Step 3: Implement the tracker per the tables above**

Write the full implementation. Keep it a pure, timer-free state machine (no IO, no tokio) — the hub owns time and transport. Doc-comment the module header with the policy line and "protocol facts derive from opencode 1.18.11 (live spike /tmp/opencode-spike/)".

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-activity opencode` — PASS. Then `cargo test -p freshell-activity` — all existing tracker tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-activity/src/opencode.rs crates/freshell-activity/src/lib.rs
git commit -m "feat(activity): pure opencode ownership tracker (Node reducer port)"
```

---

### Task 7: Rust tracker gates — abort, error, permission pause, death predicates

**Files:**
- Modify: `crates/freshell-activity/src/opencode.rs`

**Interfaces:**
- Consumes: Task 6's tracker; codex approval-lane semantics (`codex.rs:762-843`) as the pattern.
- Produces (used by Tasks 8–9):

```rust
impl OpencodeActivityTracker {
    pub fn note_error(&mut self, terminal_id: &str, session_id: &str, error_name: &str, cycle: u64, stream: u64, at: i64) -> Vec<OpencodeEffect>;
    pub fn note_permission_asked(&mut self, terminal_id: &str, session_id: &str, permission_id: &str, at: i64) -> Vec<OpencodeEffect>;
    pub fn note_permission_replied(&mut self, terminal_id: &str, permission_id: &str, at: i64) -> Vec<OpencodeEffect>;
    pub fn has_pending_permissions(&self, terminal_id: &str) -> bool;
    /// candidate/ambiguous ownership never death-rings (D4).
    pub fn blocks_death_bell(&self, terminal_id: &str) -> bool;
}
```

**Semantics:**
- `note_error`: only when `session_id` resolves to itself (raw == root — child errors ignored, D5) AND `error_name == "MessageAbortedError"` AND ownership is `KnownBusy`/`Candidate` with matching id+cycle+stream → set `turn_aborted = true`. No effects, ever. All other names/states: no-op (trailing-error rule). (The W2 abort marker — Task 9's `message.updated` translation — arrives through this same entry point as a `SessionError`-shaped call; nothing extra is needed here.)
- `note_permission_asked`: root-resolve the asker via `resolve_root` (children CAN ask — the event is stamped with the CHILD session id and the parent turn blocks on it; multi-level chain walk, mappings retained for session lifetime — opencode v1.18.11 source, validation pass 2026-08-03). Arm when ownership is `KnownBusy` OR `Candidate` with `session_id == resolved root` (candidate arming, D3: the single busy unbound session on the pane's own per-pane endpoint; first-turn asks must ring). Foreign/unresolvable ids and `Quiet`/`Ambiguous`/`AwaitingAssociation` states: no-op. `let newly_inserted = state.pending_permissions.insert(permission_id.to_string());` — only newly-inserted arms. Effects in order: `clear_record(false)` (demote), then `TrackerEffect::AttentionBoundary { terminal_id, at }`.
- `note_permission_replied`: remove the id (unknown id → no-op). When the set EMPTIES and ownership is `KnownBusy{session}` or `Candidate{session}` → `set_busy_record(Some(session), at)` (immediate resume; busy cancels the armed gate window via `note_phase(Busy)` in the frame mapper).
- Mid-pause hardening — extend the idle-edge completion rows (Task 6, both idle and snapshot-empty paths). With `KnownBusy` ownership: `let pause_was_active = !state.pending_permissions.is_empty();` if `pause_was_active`: clear the set and NEVER mint `TurnComplete` (the pause is the episode's bell); if `turn_aborted` → `clear_record(true)` (force-emit remove → `note_exit` at the gate cancels the armed window → total silence); else → no effects (leave the armed window to fire once, or stay silent if it already rang). With `Candidate` ownership (→ `AwaitingAssociation`): if `turn_aborted` → clear the set + `clear_record(true)` (same total-silence contract); else KEEP `pending_permissions` intact — the pause claim survives into `AwaitingAssociation` so the DEFERRED completion is swallowed at `bind_session` (next bullet).
- `bind_session` mid-pause swallow (extends Task 6's bind rows): on `AwaitingAssociation{session_id == bound, aborted: false}` with `!state.pending_permissions.is_empty()` → clear the set, transition to `Quiet{known: Some(bound)}`, and mint NO deferred `TurnComplete` (mid-pause turn end — the pause was the episode's bell, D3).
- Busy re-entry (`KnownBusy`/`Candidate` same-session refresh) clears `pending_permissions` (out-of-band resume).
- `note_exit` clears `pending_permissions` with the state (the hub reads `has_pending_permissions` BEFORE calling `note_exit` — same audit-A17 ordering as codex).

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn abort_then_idle_clears_silently() { /* busy -> note_error(MessageAbortedError) -> idle: Changed{remove} only, no TurnComplete; second idle: nothing */ }
#[test] fn w2_abort_marker_gates_like_session_error() { /* the message.updated abort marker reaches the tracker through the SAME note_error entry (Task 9's translate maps it to SessionError — derives from opencode 1.18.11, abort window W2): busy -> note_error(MessageAbortedError) sourced from the marker -> idle: Changed{remove} only, no TurnComplete; second idle: nothing */ }
#[test] fn failed_turn_rings_and_trailing_error_is_noop() { /* busy -> note_error(UnknownError) -> idle: TurnComplete present; note_error after idle: no effects, ownership stays Quiet */ }
#[test] fn child_abort_does_not_gate_the_root() { /* child registered; note_error(child, MessageAborted); parent idle still completes */ }
#[test] fn permission_asked_demotes_then_arms_once() { /* busy -> note_permission_asked: [Changed{remove}, AttentionBoundary] in that order; duplicate id: no effects */ }
#[test] fn child_permission_asked_resolves_to_root_and_arms() { /* child registered via note_session_created; note_permission_asked(child id) while the root is KnownBusy: [Changed{remove}, AttentionBoundary]; a foreign unregistered id: no effects */ }
#[test] fn candidate_pause_arms_and_deferred_completion_is_swallowed_at_bind() { /* track with NO session id -> busy(ses-x) = Candidate -> note_permission_asked(ses-x): [Changed{remove}, AttentionBoundary] (candidate arming, D3); idle edge -> AwaitingAssociation with the pause claim intact; bind_session("ses-x"): NO deferred TurnComplete (swallowed), state Quiet{known: Some(ses-x)} */ }
#[test] fn permission_replied_resumes_busy() { /* pause -> note_permission_replied: Changed{upsert busy with owned session}; repeat under Candidate ownership */ }
#[test] fn abort_mid_pause_force_emits_the_cancel() { /* pause -> note_error(abort) -> idle: Changed{remove} EMITTED despite absent record, no TurnComplete, no boundary; repeat from Candidate ownership (aborted candidate -> AwaitingAssociation{aborted}, same force-emit) */ }
#[test] fn completion_mid_pause_mints_nothing() { /* pause -> idle (no error): NO effects at all */ }
#[test] fn death_predicates() { /* blocks_death_bell: false for KnownBusy/Quiet, true for Candidate and Ambiguous — INCLUDING Candidate with a candidate-armed pause pending (D4); has_pending_permissions true during pause, false after replied/exit */ }
```

Write each in full.

- [ ] **Step 2: Run RED**

Run: `cargo test -p freshell-activity opencode` — FAIL.

- [ ] **Step 3: Implement per the semantics above. Step 4: Run GREEN** (`cargo test -p freshell-activity`).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-activity/src/opencode.rs
git commit -m "feat(activity): opencode abort/permission gates and death-bell predicates"
```

---

### Task 8: Rust hub wiring — mode arms, frames, death bell, activity.list

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs`
- Modify: `crates/freshell-ws/src/terminal.rs` (`:929-946` stub only)

**Interfaces:**
- Consumes: Tasks 6–7 tracker; `IdleGate` (`idle.rs`); `note_changed_to_gate` (`activity.rs:1396-1407`), `turn_complete_frame` (`:1409-1423`), `codex_frames` as the template (`:1286-1339`); protocol types `OpencodeActivityUpdated`/`OpencodeActivityListResponse` (`server_messages.rs:449-463`), `AgentProvider::Opencode`.
- Produces (used by Tasks 9–10):

```rust
// activity.rs
enum OpencodeLaneEvent {  // pub(crate); carried by HubEvent
    Snapshot { statuses: Vec<(String, freshell_activity::opencode::OpencodeStatus)> },
    SessionCreated { session_id: String, parent_id: Option<String> },
    Status { session_id: String, status: freshell_activity::opencode::OpencodeStatus },
    SessionIdle { session_id: String },
    SessionError { session_id: String, error_name: String },
    PermissionAsked { session_id: String, permission_id: String },
    PermissionReplied { permission_id: String },
}
// HubEvent variants:
//   OpencodeBind { terminal_id: String, session_id: String },
//   OpencodeLane { terminal_id: String, generation: u64, cycle: u64, stream: u64, event: OpencodeLaneEvent },
// ActivityHub ingress:
pub fn bind_opencode_session(&self, terminal_id: &str, session_id: &str);
pub(crate) fn note_opencode_lane_event(&self, terminal_id: &str, generation: u64, cycle: u64, stream: u64, event: OpencodeLaneEvent);
pub fn opencode_list(&self) -> (Vec<freshell_protocol::OpencodeActivityRecord>, Vec<freshell_protocol::TurnCompletionSnapshot>);
```

(`generation` is the hub-issued attach generation — Task 9's `opencode_lanes` registry issues it; ingress drops mismatches. Hub-level tests register a dummy entry via the `#[cfg(test)]` helper below so their injected events pass the guard.)

- [ ] **Step 1: Write the failing episode tests**

Append to `activity.rs`'s `mod tests` (helpers: `hub()` `:1430`, `observer_send` `:1436`, `next_frame_matching` `:1444`, `next_frame_of_type` `:1468`; all `#[tokio::test(flavor = "multi_thread")]`; model on the codex episodes at `:1713-1841` and `:3560-3804`). Add a local helper:

```rust
async fn busy_opencode_terminal(hub: &ActivityHub, rx: &mut tokio::sync::broadcast::Receiver<String>) {
    observer_send(hub, ActivityEvent::Created {
        terminal_id: "t-oc".into(), mode: "opencode".into(),
        resume_session_id: Some("ses-root".into()), at: 1_000,
    });
    hub.register_opencode_lane_for_tests("t-oc", 1); // dummy lanes-map entry: generation 1 passes ingress
    hub.note_opencode_lane_event("t-oc", 1, 1, 1, OpencodeLaneEvent::Status {
        session_id: "ses-root".into(), status: OpencodeStatus::Busy,
    });
    let frame = next_frame_matching(rx, "opencode.activity.updated", 1_500, |v| {
        v["upsert"][0]["phase"] == "busy"
    }).await;
    assert!(frame.is_some(), "expected the busy upsert");
}
```

(Every episode test that injects lane events registers a test generation first and stamps it — `note_opencode_lane_event(terminal_id, generation, cycle, stream, event)`; `respawn_drops_stale_lane_events` registers generation 2 mid-test to prove the drop.)

Tests (each asserts EXACTLY one `terminal.idle` or none — use `next_frame_of_type(...).await.is_none()` for silence, timeout 1_500ms; ring waits use 3_500ms to cover the 2s grace):

```rust
#[tokio::test(flavor = "multi_thread")] async fn opencode_completed_turn_rings_once_after_grace() { /* busy -> SessionIdle -> expect terminal.turn.complete{provider:"opencode"} then ONE terminal.idle{reason:"grace"}; a second SessionIdle mints nothing further */ }
#[tokio::test(flavor = "multi_thread")] async fn opencode_abort_stays_silent() { /* busy -> SessionError{MessageAbortedError} -> SessionIdle x2 -> NO terminal.turn.complete, NO terminal.idle */ }
#[tokio::test(flavor = "multi_thread")] async fn opencode_failed_turn_rings() { /* busy -> SessionError{UnknownError} -> SessionIdle -> turn.complete + one terminal.idle; trailing SessionError after idle mints nothing */ }
#[tokio::test(flavor = "multi_thread")] async fn opencode_permission_pause_rings_once_and_reply_within_grace_is_silent() { /* two scenarios or two tests: (a) PermissionAsked -> one terminal.idle after grace; (b) PermissionAsked -> PermissionReplied quickly -> silence */ }
#[tokio::test(flavor = "multi_thread")] async fn opencode_child_permission_asked_arms_via_root_resolution() { /* busy root -> SessionCreated{child,parent} -> PermissionAsked{ses-child} -> one terminal.idle after grace (the child's ask root-resolves and pauses the root, D3) */ }
#[tokio::test(flavor = "multi_thread")] async fn opencode_first_turn_permission_pause_rings_under_candidate() { /* Created WITHOUT resume id -> busy for "ses-new" (candidate) -> PermissionAsked{ses-new} -> one terminal.idle after grace (candidate arming, D3); then SessionIdle + hub.bind_opencode_session("t-oc", "ses-new") -> NO terminal.turn.complete (the deferred completion is swallowed mid-pause) */ }
#[tokio::test(flavor = "multi_thread")] async fn opencode_mid_pause_abort_is_fully_silent() { /* PermissionAsked -> SessionError{abort} + SessionIdle -> no bell even after grace elapses */ }
#[tokio::test(flavor = "multi_thread")] async fn opencode_spontaneous_death_while_busy_rings_immediately() { /* busy -> Exit{spontaneous:true} -> terminal.idle arrives fast (no grace) */ }
#[tokio::test(flavor = "multi_thread")] async fn opencode_death_while_candidate_or_idle_is_silent_and_freshell_kill_is_silent() { /* candidate: Created WITHOUT resume id + busy for unknown session -> Exit{spontaneous:true} -> silence; candidate + PermissionAsked (candidate-armed pause pending) -> Exit{spontaneous:true} -> STILL silence (D4, residual D8(i)); idle quiet -> Exit spontaneous -> silence; busy -> Exit{spontaneous:false} -> silence */ }
#[tokio::test(flavor = "multi_thread")] async fn opencode_death_during_pause_rings() { /* knownBusy + PermissionAsked -> Exit{spontaneous:true} -> immediate terminal.idle */ }
#[tokio::test(flavor = "multi_thread")] async fn opencode_child_idle_mid_parent_turn_does_not_ring() { /* SessionCreated{child,parent} -> child busy -> child SessionIdle -> silence + record survives; parent SessionIdle -> one bell */ }
#[tokio::test(flavor = "multi_thread")] async fn respawn_drops_stale_lane_events() { /* register generation 1 + busy via gen-1 events; register generation 2 (the respawn's attach); inject gen-1 Status{busy} + gen-1 SessionIdle: NO upsert, NO terminal.turn.complete, NO terminal.idle (ingress drops stale generations, A6); then a gen-2 Snapshot/turn behaves normally */ }
```

Write each in full following `busy_opencode_terminal` + the codex episode style.

- [ ] **Step 2: Run RED**

Run: `cargo test -p freshell-ws opencode` — FAIL (compile: no variants/methods).

- [ ] **Step 3: Implement**

In `activity.rs`:
1. `HubInner` (`:192-205`): add `opencode: OpencodeActivityTracker,` (one process-wide instance, like codex).
2. `HubEvent` (`:104-157`): add `OpencodeBind` and `OpencodeLane` variants (shapes above); ingress methods `bind_opencode_session` / `note_opencode_lane_event` that only `self.tx.send(...)` (single-emitter invariant, `:334-339`). Add a `#[cfg(test)] fn register_opencode_lane_for_tests(&self, terminal_id: &str, generation: u64)` that inserts `(generation, tokio::spawn(async {}))` into `opencode_lanes` (Task 9's registry) so hub-level episode tests pass the generation guard without spawning real lanes.
3. `handle_event` (`:524-616`): add arms mirroring the codex proxy lane (`:558-614`):

```rust
HubEvent::OpencodeBind { terminal_id, session_id } => {
    let at = now_ms();
    let frames = {
        let mut inner = self.inner.lock().expect("activity hub lock");
        let effects = inner.opencode.bind_session(&terminal_id, &session_id, at);
        opencode_frames(&mut inner.idle, effects)
    };
    self.emit(frames);
}
HubEvent::OpencodeLane { terminal_id, generation, cycle, stream, event } => {
    let at = now_ms();
    let frames = {
        let mut inner = self.inner.lock().expect("activity hub lock");
        // Attach-generation guard (A6): tokio `abort()` is asynchronous and
        // never retracts already-enqueued mpsc messages — a replaced lane can
        // legally enqueue events AFTER its successor's attach. Drop anything
        // not stamped with the CURRENT lane generation (Exit removes the map
        // entry, so post-exit stragglers drop too). cycle/stream still guard
        // intra-lane reconnect staleness inside the tracker.
        if inner.opencode_lanes.get(&terminal_id).map(|(g, _)| *g) != Some(generation) {
            return;
        }
        let effects = match event {
            OpencodeLaneEvent::Snapshot { statuses } => inner.opencode.note_snapshot(&terminal_id, &statuses, cycle, stream, at),
            OpencodeLaneEvent::SessionCreated { session_id, parent_id } => inner.opencode.note_session_created(&terminal_id, &session_id, parent_id.as_deref(), at),
            OpencodeLaneEvent::Status { session_id, status } => inner.opencode.note_status(&terminal_id, &session_id, status, cycle, stream, at),
            OpencodeLaneEvent::SessionIdle { session_id } => inner.opencode.note_session_idle(&terminal_id, &session_id, cycle, stream, at),
            OpencodeLaneEvent::SessionError { session_id, error_name } => inner.opencode.note_error(&terminal_id, &session_id, &error_name, cycle, stream, at),
            OpencodeLaneEvent::PermissionAsked { session_id, permission_id } => inner.opencode.note_permission_asked(&terminal_id, &session_id, &permission_id, at),
            OpencodeLaneEvent::PermissionReplied { permission_id } => inner.opencode.note_permission_replied(&terminal_id, &permission_id, at),
        };
        opencode_frames(&mut inner.idle, effects)
    };
    self.emit(frames);
}
```

4. Mode dispatch — add `"opencode"` arms:
   - Created (`:629-661`): `inner.modes.insert(terminal_id.clone(), mode.clone()); let effects = inner.opencode.track_terminal(&terminal_id, resume_session_id.as_deref(), at); opencode_frames(&mut inner.idle, effects)` (lane attach itself is Task 9/10).
   - Input (`:731-747`) and Output (`:761-776`): `"opencode" => Vec::new()` (SSE-driven; PTY bytes carry no protocol signal — NO heuristic bells).
   - Exit tracker arm (`:820-836`): `"opencode" => opencode_frames(&mut inner.idle, inner.opencode.note_exit(&terminal_id))`.
5. Death-bell predicate (`:792-794`) — extend, reading BEFORE teardown (ordering is audit-A17-pinned):

```rust
// D4: candidate/ambiguous ownership never death-rings — even when a
// candidate-armed permission pause is pending (residual D8(i)).
let opencode_death_eligible = !inner.opencode.blocks_death_bell(&terminal_id);
let ring_death_bell = spontaneous
    && ((inner.idle.is_engaged(&terminal_id) && opencode_death_eligible)
        || inner.codex.has_pending_approvals(&terminal_id)
        || (inner.opencode.has_pending_permissions(&terminal_id) && opencode_death_eligible));
```

(`blocks_death_bell` is `false` for terminals the opencode tracker doesn't know, so claude/codex/amplifier behavior is unchanged — pin that with the existing tests staying green.)
6. Frame mapper, next to `codex_frames` (`:1286`):

```rust
fn opencode_frames(idle: &mut IdleGate, effects: Vec<TrackerEffect<freshell_protocol::OpencodeActivityRecord>>) -> Vec<ServerMessage> {
    let mut frames = Vec::new();
    for effect in effects {
        match effect {
            TrackerEffect::Changed { upsert, remove } => {
                // remove -> note_exit clears gate state; the boundary that FOLLOWS
                // in the same batch re-arms grace-only (D7 — the Node emitter's
                // "activityRemove followed by turnComplete" contract).
                note_changed_to_gate(
                    idle,
                    upsert.iter().map(|r| (r.terminal_id.as_str(), IdleGatePhase::Busy)),
                    &remove,
                );
                frames.push(ServerMessage::OpencodeActivityUpdated(
                    freshell_protocol::OpencodeActivityUpdated { remove, upsert },
                ));
            }
            TrackerEffect::TurnComplete { terminal_id, session_id, at, completion_seq } => {
                idle.note_turn_boundary(&terminal_id, at);
                frames.push(turn_complete_frame(AgentProvider::Opencode, terminal_id, session_id, at, completion_seq));
            }
            TrackerEffect::AttentionBoundary { terminal_id, at } => {
                idle.note_turn_boundary(&terminal_id, at); // arms the bell; no frame
            }
            TrackerEffect::ForceRead { .. } => {}
        }
    }
    frames
}
```

7. `hub_next_deadline` (`:1217-1232`): add `inner.opencode.next_deadline()`. `expire_due` (`:1115-1183`): add `let frames = opencode_frames(&mut inner.idle, inner.opencode.expire(now));` alongside the other trackers.
8. `opencode_list` next to `codex_list` (`:469`): `let inner = ...; (inner.opencode.list(), inner.opencode.list_latest_completions())`.

In `terminal.rs` (`:929-946`): replace the hardcoded empty stub with the hub call, matching the codex sibling at `:895-907`:

```rust
ClientMessage::OpencodeActivityList(list) => {
    let (terminals, latest) = match &state.activity {
        Some(hub) => hub.opencode_list(),
        None => (Vec::new(), Vec::new()),
    };
    send(ws_tx, &ServerMessage::OpencodeActivityListResponse(
        freshell_protocol::OpencodeActivityListResponse {
            request_id: list.request_id.clone(),
            terminals,
            latest_turn_completions: Some(latest),
        })).await
}
```

Search `crates/freshell-ws/` for tests pinning the empty-stub response (`grep -n "OpencodeActivityList" crates/freshell-ws/src/`); if one pins emptiness, rewrite it against the hub with a `// SEMANTIC CHANGE (opencode-attention-bell): list is now hub-backed` comment. `gemini_and_kimi_are_status_inert` (`:1994`) covers only gemini/kimi and stays untouched.

- [ ] **Step 4: Run GREEN**

Run: `cargo test -p freshell-ws` and `cargo test -p freshell-activity`. Expected: PASS (all pre-existing codex/claude/amplifier episodes green — the death predicate extension must not disturb them).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/activity.rs crates/freshell-ws/src/terminal.rs
git commit -m "feat(ws): opencode hub lane — mode arms, frames, death bell, activity.list"
```

---

### Task 9: Rust SSE lane — per-terminal event pump with injected IO

**Files:**
- Create: `crates/freshell-ws/src/opencode_lane.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (add `mod opencode_lane;`), `crates/freshell-ws/src/activity.rs` (lane registry + `OpencodeAttach` HubEvent + deps setter), `crates/freshell-ws/Cargo.toml` (add `reqwest` + `futures` workspace deps if not already present)

**Interfaces:**
- Consumes: `freshell_opencode::{SseDecoder, ParsedServeEvent, parse_serve_event}` (events.rs — NOT feature-gated), Task 8's `note_opencode_lane_event` ingress + `OpencodeLaneEvent`.
- Produces:

```rust
// opencode_lane.rs
pub(crate) const OPENCODE_HEALTH_POLL_MS: u64 = 200;      // mirrors Node :18
pub(crate) const OPENCODE_HEALTH_TIMEOUT_MS: u64 = 15_000; // per cycle, Node :20
pub(crate) const OPENCODE_RECONNECT_BASE_MS: u64 = 250;    // Node :21
pub(crate) const OPENCODE_RECONNECT_MAX_MS: u64 = 5_000;   // Node :22
pub(crate) const OPENCODE_READ_STALL_MS: u64 = 30_000;     // Node :24 (production stream impl)
/// Version drift gate (log-once per lane): prefix match against the REQUIRED
/// `version` field of GET /global/health (derives from opencode 1.18.11:
/// { healthy, version } are both required; session.idle is already deprecated
/// upstream and a v1->v2 event/health migration is in progress — D8(h)).
pub(crate) const TESTED_OPENCODE_VERSION_RANGE: &str = "1.18.";

pub(crate) trait OpencodeLaneHttp: Send + Sync {
    fn get_json<'a>(&'a self, url: &'a str)
        -> futures::future::BoxFuture<'a, Result<(u16, serde_json::Value), String>>;
}
pub(crate) trait OpencodeEventStream: Send + Sync {
    /// Two-phase connect (Node connect-then-snapshot parity, A5): resolves
    /// once the subscription is CONFIRMED — on the FIRST `server.connected`
    /// SSE frame, detected on the raw decoded event BEFORE `parse_serve_event`
    /// (which swallows it). Frames arriving after the ack are BUFFERED by the
    /// returned handle, never dropped.
    fn connect<'a>(&'a self, url: &'a str)
        -> futures::future::BoxFuture<'a, Result<Box<dyn ConnectedOpencodeStream>, String>>;
}
pub(crate) trait ConnectedOpencodeStream: Send {
    /// Deliver the buffered frames in order, then live parsed events, by
    /// sending each into `events_tx` until the stream ends (returns on
    /// disconnect; the sender is dropped on return, which is what lets the
    /// lane's pump loop drain to `None`). The seam is a CHANNEL rather than a
    /// sync callback because per-event handling must AWAIT the lane-level
    /// HTTP root resolver (`OpencodeLaneHttp::get_json` is async) before
    /// forwarding to the hub — that async work lives in the lane's pump loop
    /// (below), which owns `known_sessions` mutably. FIFO channel + one
    /// sequential pump preserves per-stream event ordering.
    fn drive(self: Box<Self>, events_tx: tokio::sync::mpsc::UnboundedSender<freshell_opencode::ParsedServeEvent>)
        -> futures::future::BoxFuture<'static, Result<(), String>>;
}
pub(crate) struct OpencodeLaneDeps { pub http: std::sync::Arc<dyn OpencodeLaneHttp>, pub events: std::sync::Arc<dyn OpencodeEventStream> }
pub(crate) fn spawn_opencode_lane(deps: std::sync::Arc<OpencodeLaneDeps>, hub: crate::activity::ActivityHub, terminal_id: String, base_url: String, generation: u64) -> tokio::task::JoinHandle<()>;
pub(crate) fn translate_serve_event(event: &freshell_opencode::ParsedServeEvent) -> Option<crate::activity::OpencodeLaneEvent>;
// production impls:
pub(crate) struct ReqwestLaneHttp(/* reqwest::Client */);
pub(crate) struct ReqwestLaneStream(/* reqwest::Client */);
// activity.rs additions:
//   HubEvent::OpencodeAttach { terminal_id: String, base_url: String }
//   pub fn attach_opencode_serve(&self, terminal_id: &str, hostname: &str, port: u16)  // base_url = format!("http://{hostname}:{port}")
//   pub fn set_opencode_lane_deps(&self, deps: Arc<OpencodeLaneDeps>)                  // Option'd; tests leave it unset
//   HubInner: opencode_lanes: HashMap<String, (u64 /* attach generation */, tokio::task::JoinHandle<()>)>,
//             opencode_lane_next_generation: u64  // monotonic; bumped on EVERY OpencodeAttach (A6)
```

**Lane loop semantics (Node `runMonitor:321-348` + `consumeEvents:411-471` parity — connect BEFORE snapshot):**

```rust
// inside spawn_opencode_lane's task (generation is hub-issued at attach and
// stamped on EVERY note_opencode_lane_event call):
let mut cycle: u64 = 0;
let mut stream: u64 = 0;
let mut backoff = OPENCODE_RECONNECT_BASE_MS;
let mut warned_version = false;
loop {
    cycle += 1;
    // 1. health-wait: poll GET {base}/global/health every 200ms, up to 15s this cycle.
    //    On timeout: fall through to backoff and start a new cycle.
    //    Version drift gate (log-once per lane): on a healthy response, read the
    //    REQUIRED `version` field (derives from opencode 1.18.11: /global/health
    //    returns { healthy, version }, both required); if
    //    !version.starts_with(TESTED_OPENCODE_VERSION_RANGE) && !warned_version,
    //    tracing::warn! once ("opencode {version} untested for attention-bell
    //    vocabulary (tested: 1.18.x); bells stay on") and set warned_version.
    //    Bells stay ON either way (best-effort; D8(h)).
    // 2. stream += 1; two-phase connect (A5): let conn = deps.events
    //    .connect(&format!("{base}/event")).await — resolves "subscribed" on the
    //    FIRST server.connected frame (detected on the raw decoded SSE event
    //    BEFORE parse_serve_event, which swallows it); frames arriving after the
    //    ack are buffered inside `conn`. On connect error: fall through to backoff.
    // 3. snapshot: GET {base}/session/status -> object map; entries whose
    //    status.type is "busy"/"retry" -> OpencodeStatus::{Busy,Retry};
    //    a literal {"type":"idle"} entry parses as Idle (defensive — the live
    //    server DROPS idle sessions; absence == idle; opencode 1.18.11).
    //    Root-resolve unknown snapshot session ids FIRST (resolver below), then
    //    hub.note_opencode_lane_event(&terminal_id, generation, cycle, stream,
    //        OpencodeLaneEvent::Snapshot { statuses });
    //    Subscription strictly precedes the snapshot, so every transition is
    //    either IN the snapshot or ON the already-open stream — /event has no
    //    replay (derives from opencode 1.18.11).
    // 4. drive + pump (channel seam — per-event handling must AWAIT the async
    //    root resolver, so a sync callback cannot be the seam):
    //      let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    //      let drive_task = tokio::spawn(conn.drive(tx)); // buffered frames IN ORDER, then live
    //      while let Some(parsed) = rx.recv().await {
    //          if let Some(ev) = translate_serve_event(&parsed) {
    //              // root-resolve unknown session ids FIRST (resolver below —
    //              // awaits deps.http HERE in the pump, where &mut known_sessions
    //              // is in scope), then:
    //              hub.note_opencode_lane_event(&terminal_id, generation, cycle, stream, ev);
    //          }
    //      } // rx drains to None only after drive dropped tx on disconnect — no events lost
    //    On a successful streamed cycle (drive_task.await == Ok(Ok(()))), reset backoff to base.
    // 5. sleep(backoff); backoff = (backoff * 2).min(OPENCODE_RECONNECT_MAX_MS);
}
```

**Lane-level HTTP root resolver (A4 — the Node `resolveRootForEvent`/`classifySnapshotStatuses` seam, ported to HTTP):** the lane owns a lane-lifetime `known_sessions: std::collections::HashSet<String>`; `SessionCreated` events (streamed or synthetic) insert their session (and parent) ids. Before forwarding any `Status`/`SessionIdle`/`SessionError`/`PermissionAsked` event — or noting a snapshot entry — whose session id is NOT in the set, the lane fetches `GET {base}/session/{id}` via the existing `OpencodeLaneHttp` seam (short timeout — the production impl's 2s default) and emits a synthetic `SessionCreated { session_id, parent_id }` to the hub BEFORE the triggering event, first walking the `parentID` chain while the parent is itself unknown (deepest ancestor first, so every mapping lands before its dependents). On resolve failure (non-200, timeout, shape mismatch): forward the triggering event anyway — the tracker's conservative-ambiguity behavior stands, and the next unknown-id occurrence retries. The resolver runs in the lane task itself — for streamed events inside the step-4 pump loop (never inside `drive`, which only feeds the channel), and for snapshot entries inline in step 3 — so every `deps.http.get_json` await happens where `&mut known_sessions` is directly in scope, and the sequential pump preserves the emit-before-trigger ordering. Carry the comment: `// derives from opencode 1.18.11: GET /session/{id} exposes parentID; /event has no replay`.

`translate_serve_event` (kinds and property paths are verbatim from the spike — `/tmp/opencode-spike/vocabulary.md`):

```rust
pub(crate) fn translate_serve_event(event: &freshell_opencode::ParsedServeEvent) -> Option<OpencodeLaneEvent> {
    let props = &event.properties;
    match event.kind.as_str() {
        "session.created" => {
            let info = props.get("info")?.as_object()?;
            let session_id = info.get("id")?.as_str()?.to_string();
            let parent_id = info.get("parentID").and_then(|v| v.as_str()).map(str::to_string);
            Some(OpencodeLaneEvent::SessionCreated { session_id, parent_id })
        }
        "session.status" => {
            let session_id = props.get("sessionID")?.as_str()?.to_string();
            let status = match props.get("status")?.get("type")?.as_str()? {
                "idle" => OpencodeStatus::Idle,
                "retry" => OpencodeStatus::Retry, // schema-declared, never observed live (opencode 1.18.11) — busy-equivalent
                _ => OpencodeStatus::Busy,
            };
            Some(OpencodeLaneEvent::Status { session_id, status })
        }
        "session.idle" => Some(OpencodeLaneEvent::SessionIdle {
            session_id: props.get("sessionID")?.as_str()?.to_string(),
        }),
        "session.error" => Some(OpencodeLaneEvent::SessionError {
            session_id: props.get("sessionID")?.as_str()?.to_string(),
            error_name: props.get("error").and_then(|e| e.get("name")).and_then(|n| n.as_str()).unwrap_or("UnknownError").to_string(),
        }),
        "permission.asked" => Some(OpencodeLaneEvent::PermissionAsked {
            session_id: props.get("sessionID")?.as_str()?.to_string(),
            permission_id: props.get("id")?.as_str()?.to_string(),
        }),
        "permission.replied" => Some(OpencodeLaneEvent::PermissionReplied {
            permission_id: props.get("requestID")?.as_str()?.to_string(),
        }),
        "message.updated" => {
            // W2 abort marker (derives from opencode 1.18.11): an abort landing
            // between assistant-message creation and LLM stream start emits NO
            // session.error — only message.updated with info.error.name ===
            // "MessageAbortedError", always BEFORE idle. Error-less
            // message.updated is routine message churn -> None. Both abort
            // signals feed the same SessionError lane event (D1).
            let session_id = props.get("sessionID")?.as_str()?.to_string();
            let error_name = props
                .get("info")?
                .get("error")?
                .get("name")?
                .as_str()?
                .to_string();
            Some(OpencodeLaneEvent::SessionError { session_id, error_name })
        }
        _ => None, // message.part.*, message.removed, session.updated, session.diff, plugin.added, ... are activity-irrelevant
    }
}
```

(`ParsedServeEvent.properties` is a `serde_json::Map<String, Value>` — adjust accessor chaining to `props.get("x")` returning `Option<&Value>` accordingly. `parse_serve_event` swallows `server.connected`/`server.heartbeat` — which is exactly why the two-phase connect detects the subscription ack on the RAW decoded event before parsing; the per-cycle snapshot is loss-free only because it happens AFTER that ack (Node snapshot-on-`server.connected` parity, A5).)

Production impls: `ReqwestLaneHttp::get_json` = `client.get(url).timeout(2s).send() -> (status, json)`; `ReqwestLaneStream::connect` = GET with `accept: text/event-stream`, then a chunk loop with a 30s per-chunk `tokio::time::timeout` (read-stall watchdog — heartbeats arrive every ~10s) and a `Vec<u8>` pending buffer for partial UTF-8 (copy the shape of `freshell_opencode::transport::consume_events:145-198`, WITHOUT its internal reconnect loop — the lane owns cycles), feeding `SseDecoder::push_str` until the FIRST decoded event whose raw JSON `type` is `"server.connected"`; resolve with a handle owning the response body, the decoder, and any frames already decoded past the ack. `ConnectedOpencodeStream::drive` = flush those buffered frames through `parse_serve_event` into `events_tx` in order, then continue the same chunk loop live, sending each parsed event; return (dropping `events_tx`) on stream end, read-stall timeout, or transport error.

`OpencodeAttach` handling in `handle_event`: bump `opencode_lane_next_generation` (monotonic, hub-issued — A6) and take the new value as this lane's generation; abort any existing lane for the terminal (`opencode_lanes.insert(terminal_id, (generation, handle))` returning the old entry → `.abort()` — respawn re-allocates a NEW port, so replacement is the contract); if deps are set, `spawn_opencode_lane(deps, hub, terminal_id, base_url, generation)` and store `(generation, handle)`. The ingress guard (Task 8) then drops any `OpencodeLane` event whose stamped generation doesn't match the current map entry. Exit arm (Task 8 site): `if let Some((_, handle)) = inner.opencode_lanes.remove(&terminal_id) { handle.abort(); }` — removal makes post-exit stragglers fail the generation match too.

- [ ] **Step 1: Write the failing lane tests** (in `opencode_lane.rs` `mod tests`, with fake impls of the two traits — model on `crates/freshell-opencode/tests/serve_health_bounded.rs`'s `FakeHttp`/`FakeAllocator` style):

```rust
#[test] fn translate_covers_the_attention_vocabulary() { /* feed verbatim spike JSON (session.status busy/idle/retry, session.idle, session.error abort+unknown, permission.asked/replied, session.created child+root, message.updated WITH info.error MessageAbortedError -> SessionError, message.updated WITHOUT an error -> None) through freshell_opencode::SseDecoder + parse_serve_event + translate_serve_event; assert each OpencodeLaneEvent; assert message.part.delta and session.diff translate to None */ }
#[test] fn version_gate_matches_only_the_tested_range() { /* pure prefix check against TESTED_OPENCODE_VERSION_RANGE: "1.18.11" passes; "1.19.0" and "2.0.0" fail (the lane logs once and keeps bells on) */ }
#[tokio::test(flavor = "multi_thread")] async fn lane_gates_on_health_then_snapshots_then_streams() { /* FakeHttp: health returns 500 twice then 200 (version "1.18.11"); FakeStream::connect resolves "subscribed" with one BUFFERED session.idle frame; /session/status returns {"ses-r":{"type":"busy"}}; a recording hub (real ActivityHub + broadcast rx, test lane generation registered) plus FakeHttp's recorded call order assert: connect precedes the /session/status GET; Snapshot is noted BEFORE the buffered SessionIdle; all with generation=1, cycle=1, stream=1 */ }
#[tokio::test(flavor = "multi_thread")] async fn reconnect_bumps_stream_and_resnapshots() { /* FakeStream: connect resolves + drive returns Ok(()) immediately, twice; assert two Snapshot events with (cycle 1, stream 1) then (cycle 2, stream 2), each noted after its own connect */ }
#[tokio::test(flavor = "multi_thread")] async fn unmapped_session_is_resolved_via_http_before_forwarding() { /* FakeStream delivers Status{ses-child, busy} with ses-child NOT in known_sessions; FakeHttp serves GET /session/ses-child -> {"id":"ses-child","parentID":"ses-root"} and GET /session/ses-root -> {"id":"ses-root"}; assert the hub sees SessionCreated{ses-root, None} then SessionCreated{ses-child, Some(ses-root)} BEFORE Status{ses-child}; failure variant: 404 on GET /session/{id} -> Status forwarded anyway (conservative ambiguity stands, next occurrence retries) */ }
```

Write in full. Also a hub-level test in `activity.rs`: `opencode_attach_replaces_the_lane_and_exit_tears_it_down` — set fake deps via `set_opencode_lane_deps`, `attach_opencode_serve` twice + `Exit`, assert the lanes map (expose `#[cfg(test)] fn opencode_lane_count(&self) -> usize` and `#[cfg(test)] fn opencode_lane_generation(&self, terminal_id: &str) -> Option<u64>`, asserting the generation bumps on the second attach).

- [ ] **Step 2: Run RED** — `cargo test -p freshell-ws opencode_lane` fails to compile.

- [ ] **Step 3: Implement per the semantics above. Step 4: Run GREEN** — `cargo test -p freshell-ws`.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/opencode_lane.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/src/activity.rs crates/freshell-ws/Cargo.toml Cargo.lock
git commit -m "feat(ws): per-terminal opencode SSE lane with injected IO seams"
```

---

### Task 10: Rust threading — endpoint to hub, identity binds, production deps

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (create `:2380-2505` region, respawn `:3214-3283` region)
- Modify: `crates/freshell-ws/src/opencode_association.rs` (`drain_and_associate`, `:86+`)
- Modify: the `OpencodeSignal` rebind consumer (find it: `grep -rn "OpencodeDrainOutcome\|rebinds" crates/freshell-ws/src/ --include="*.rs"` — one drain call site applies rebind signals to the registry)
- Modify: `crates/freshell-server/src/main.rs` (hub construction block, `:495-513`)

**Interfaces:**
- Consumes: `opencode_endpoint` locals (`terminal.rs:2384`, `:3216`), `hub.attach_opencode_serve` / `hub.bind_opencode_session` / `hub.set_opencode_lane_deps` (Tasks 8–9).
- Produces: a live production path — create/respawn attaches the lane; association/rebind feeds identity; main.rs installs `ReqwestLaneHttp`/`ReqwestLaneStream`.

- [ ] **Step 1: Write the failing test**

In `activity.rs` tests (hub-level, since terminal.rs's handlers need a full WS harness): `resume_created_opencode_terminal_binds_identity_via_bind_ingress` — `Created` with `resume_session_id: None`, busy for `ses-x` (candidate), idle (awaitingAssociation), then `hub.bind_opencode_session("t-oc", "ses-x")` → expect `terminal.turn.complete{provider:"opencode"}` then one `terminal.idle`. (This pins the deferred-completion bind lane the association producers will drive. Register a test lane generation first — `hub.register_opencode_lane_for_tests("t-oc", 1)` — and stamp the busy/idle lane events with `generation: 1`, as in Task 8's helper.) Write it in full following the Task 8 episode style.

- [ ] **Step 2: Run RED if the bind arm is incomplete; otherwise this is a pin** — `cargo test -p freshell-ws opencode`.

- [ ] **Step 3: Implement the threading**

1. `terminal.rs` create path: immediately after the launch resolves and the terminal is successfully registered (after the `CliLaunchInputs` consumption at `:2499-2505`, at the point where `handle_create` has a definitive terminal id and the spawn succeeded — co-locate with the existing `opencode_association::maybe_arm(...)` call at `:2809`):

```rust
if let (Some(hub), Some(ep)) = (&state.activity, opencode_endpoint.as_ref()) {
    hub.attach_opencode_serve(&terminal_id, &ep.hostname, ep.port);
}
```

2. Respawn path: same two lines co-located with the respawn's `maybe_arm` at `:3502` (the respawn re-allocated a fresh port at `:3216-3224`; `attach_opencode_serve` replaces the old lane by contract).
3. `opencode_association.rs` `drain_and_associate`: at the point a rebind/bind succeeds against the registry (where it broadcasts `terminal.session.associated`), add:

```rust
if let Some(hub) = &state.activity {
    hub.bind_opencode_session(&terminal_id, &session_id);
}
```

4. Same one-liner at the `OpencodeSignal` rebind consumer (the in-TUI session-switch path).
5. `main.rs`, next to `set_codex_rollout_locator` (`:511-513`):

```rust
activity_hub.set_opencode_lane_deps(std::sync::Arc::new(freshell_ws::opencode_lane::OpencodeLaneDeps {
    http: std::sync::Arc::new(freshell_ws::opencode_lane::ReqwestLaneHttp::new()),
    events: std::sync::Arc::new(freshell_ws::opencode_lane::ReqwestLaneStream::new()),
}));
```

(Adjust visibility: `opencode_lane` module + deps/impl types need `pub` reachability from `freshell-server`; widen from `pub(crate)` where required.)

- [ ] **Step 4: Run GREEN + build**

Run: `cargo test -p freshell-ws && cargo build -p freshell-server`
Expected: PASS + clean build. Do NOT deploy/restart anything.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/opencode_association.rs crates/freshell-ws/src/opencode_lane.rs crates/freshell-ws/src/activity.rs crates/freshell-server/src/main.rs
git commit -m "feat(ws): thread opencode endpoint and identity binds into the activity hub"
```

(If the signal-consumer edit touched a different file, add it too.)

---

### Task 11: Docs + residuals truth-up

**Files:**
- Modify: `crates/freshell-activity/src/idle.rs` (residuals block `:35-54`)
- Modify: `shared/ws-protocol.ts` (doc comment `:199-221` ONLY — no schema tokens)
- Modify: `server/coding-cli/truly-idle-emitter.ts` (doc comments `:78-79` context and the `:222-227` "codex-only" note)

- [ ] **Step 1: Rewrite `idle.rs` Accepted Residual 6** (currently: `6. Node opencode death bells: deliberately excluded (noisy busy proxy) — follow-up. Rust opencode: no hub tracker exists — N/A.`) to reflect reality, and append the new opencode residuals (D8):

```
//! 6. Opencode death bells now ring on both servers, ownership-scoped:
//!    candidate/ambiguous ownership never death-rings (the old noisy-busy-proxy
//!    problem, now excluded by construction). Consequences kept deliberate:
//!    first-turn deaths stay silent (candidate covers the whole first turn on
//!    Node — even with a candidate-armed permission pause pending), and a Rust
//!    pane whose bind producers all fail (locator ambiguity + plugin absence)
//!    stays candidate indefinitely — candidate-armed pauses still ring there,
//!    but completions and death bells wait for the bind.
//! 8. Opencode: an SSE reconnect during a permission pause loses the pending
//!    pause bell (the busy snapshot clears it; GET /permission resync is a
//!    possible follow-up). Ambiguous ownership stays bell-free. Child sessions
//!    unseen on-stream (reconnect gap, mid-turn attach) are recovered by the
//!    lane's HTTP root resolver (GET /session/{id} exposes parentID); only
//!    resolver FAILURE degrades to ambiguous (conservative silence), retried
//!    on the next occurrence.
//! 9. Opencode protocol drift: permission.v2.* / question.* event families
//!    (schema-declared, unobserved on 1.18.11) are unhandled — the pause bell
//!    goes deaf if a future server switches families. session.idle is already
//!    deprecated upstream and a v1->v2 event/health migration is in progress;
//!    the log-once version gate (Rust lane + Node tracker) converts silent
//!    drift into a logged warning, and /session/status absence==idle is
//!    version-derived behavior (1.18.x).
//! 10. Opencode abort window W1: an abort landing between the prompt loop-top
//!    and processor.create emits NO abort evidence at all before idle — a
//!    ms-scale window where a completion bell can ring on a human abort
//!    (window W2 is closed by the abort-marked message.updated fallback).
//! 11. Pathological opencode TUI quits — worker dispose exceeding the 5s
//!    hard-terminate cap, or a raw SIGTERM (no drain path) — can leave
//!    engagement set at spontaneous exit, so a death bell can ring on those
//!    rare human quits. Normal quit paths verified to abort+drain (all four
//!    quit inputs dispose runners via the abort path before exit); the
//!    wire-flush instant is unprovable from code but mitigated upstream by
//!    graceful SSE stream termination.
//! 12. The opencode 120s busy deadman is EVENT-SILENCE-keyed (deltas and
//!    heartbeats do not refresh it): a single >120s silent tool call trips it
//!    mid-turn. Ownership survives and the turn's completion still rings —
//!    the cost is the dropped busy light plus lost post-deadman death
//!    engagement (the removal itself stays silent).
```

(Keep existing entries 1–5 and 7 verbatim; renumber only if the file's style demands it.)

- [ ] **Step 2: Update the `terminal.idle` normative doc comment** at `shared/ws-protocol.ts:199-221`: the approval-pause bullet currently says "(managed codex only)" — change to "(managed codex; opencode permission pauses)". Update `truly-idle-emitter.ts:222-227`'s `onAttentionBoundary` comment ("codex-only, no-op for others") to name codex + opencode. Comment-only edits.

- [ ] **Step 3: Verify zero wire drift**

Run: `npm run test:port` (the freeze test lives at `test/unit/port/ws-contract-freeze.test.ts`, matched ONLY by `config/vitest/vitest.port.config.ts` — the server config does not include `test/unit/port/`, so never run it under `vitest.server.config.ts`).
Expected: PASS with NO regenerated JSON (comments don't feed the contract). If it fails, the edit touched schema tokens — revert and re-apply as pure comments.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-activity/src/idle.rs shared/ws-protocol.ts server/coding-cli/truly-idle-emitter.ts
git commit -m "docs(idle): truth-up accepted residuals and attention-bell contract notes for opencode"
```

---

### Task 12: Verification sweep

**Files:** none (verification only; fix-forward commits if anything is red).

- [ ] **Step 1: Rust gates**

```bash
cd /home/dan/code/freshell/.worktrees/opencode-attention-bell
cargo fmt --all -- --check
cargo clippy -p freshell-activity -p freshell-ws -p freshell-opencode -- -D warnings
cargo test -p freshell-activity -p freshell-ws -p freshell-opencode
```

Expected: all clean/green. Fix and amend/commit as needed (`fix(...)`/`test(...)` commits).

- [ ] **Step 2: Node targeted suites**

```bash
npm run test:vitest -- run test/unit/server/coding-cli/ --config config/vitest/vitest.server.config.ts
npm run test:port
```

Expected: BOTH commands PASS. (Two separate runs on purpose: the contract-freeze test is only matched by the port config — folding it into the server-config invocation silently skips it.)

- [ ] **Step 3: Full gate (coordinator-gated)**

```bash
FRESHELL_TEST_SUMMARY="opencode attention bell: full check before review" npm run check
```

Expected: PASS (typecheck + coordinated full suite). Never kill a foreign coordinator holder; wait or retry.

- [ ] **Step 4: Hygiene**

```bash
git status --short   # expect clean; .kata.toml untouched
git log --oneline origin/main..HEAD
```

Confirm: no wire-contract JSON churn in the diff (`git diff origin/main --stat -- port/contract/` is empty), no changes under `server/fresh-agent/adapters/opencode/`, no PR opened. Commit any stragglers.

- [ ] **Step 5: Final commit (if any hygiene fixes)**

```bash
git add -A && git commit -m "chore(opencode): verification sweep fixes"   # only if needed
```

---

## Self-Review Record

**1. Spec coverage** — each spec requirement → covering task:
- Completed turn rings after 2s grace, busy re-entry cancels, double-idle dedupe → Node: already-live path + Tasks 1–2 pins; Rust: Tasks 6, 8.
- Abort/Esc silent, per-turn flag, W2 abort-marked `message.updated` fallback → Tasks 1–2 (Node), 7–9 (Rust); W1 no-evidence window documented as residual (D8(g), Task 11).
- Failed turn rings, trailing error no-op → Tasks 1–2, 7–8.
- Permission pause: boundary, replied/busy resume, mid-pause hardening (incl. the deferred-completion swallow at association confirm/bind), duplicate dedupe, busy-only wire record, root-resolved CHILD asks, candidate arming (first-turn asks ring) → Tasks 3 (Node), 7–8 (Rust).
- Spontaneous death while engaged (knownBusy ∨ armed grace ∨ pending permissions; never candidate/ambiguous — even with a candidate-armed pause pending), freshell kills silent, exit-while-idle silent, SSE-drop non-signal → Tasks 4 (Node), 7–8 (Rust); D4/D8 documented in Task 11.
- Child-session scoping + live-trace pins → Tasks 2, 5 (Node), 6, 8 (Rust).
- Reconnect-gap / mid-turn-attach child recovery: lane-level HTTP root resolver (`GET /session/{id}` → parentID, synthetic SessionCreated before the triggering event; pure tracker stays resolver-free) → Task 9 (`unmapped_session_is_resolved_via_http_before_forwarding`); D8(c) narrowed to resolver failure → Task 11.
- Lane/stream loss-free ordering: two-phase connect (subscribe on `server.connected` → snapshot → flush buffered → drive) → Task 9 (`lane_gates_on_health_then_snapshots_then_streams` pins connect-before-snapshot and snapshot-before-buffered-event).
- Respawn stale-event immunity: hub-issued attach generations, generation-guarded ingress, Exit removes the entry → Tasks 8–9 (`respawn_drops_stale_lane_events`); cycle/stream keep guarding intra-lane staleness.
- Version drift gate (log-once, bells stay on, `TESTED_OPENCODE_VERSION_RANGE`) → Tasks 2 (Node tracker health path), 9 (Rust lane); drift residuals (D8(h)) → Task 11.
- Ambiguous conservative + residuals truth-up (idle.rs entries 6/8–12) → Tasks 6–8, 11.
- Rust parity: pure tracker in freshell-activity, SSE lane reusing freshell-opencode decoder, hub wiring (Created/Exit/IdleGate/death/updated/list/turn.complete), endpoint threading, reconnect+health constants mirrored, zero client changes → Tasks 6–10.
- opencode.activity.list answered from the hub (codex-mirror routing) → Task 8.
- resolveOpencodeSessionRoots wiring pin → Task 5.
- Testing expectations (Rust pure + hub episode + lane fakes; Node mirrors with collectors-before-action; deliberate pinned-test rewrites with SEMANTIC CHANGE comments; contract freeze green; fmt/clippy; targeted suites) → Tasks 1–10 test steps + Task 12.

**1b. No silent deferrals** — every requirement lands as production behavior with a test naming the observable outcome (frames on the broadcast channel / tracker events), not stubs: the Rust lane's injected IO seams are test seams, and Task 10 installs the reqwest production impls in `main.rs` (built by `cargo build -p freshell-server`); hub episode tests prove the end-to-end frame behavior the client consumes. Every validation-pass fix ships as production code with a named test in the same task: W2 marker (Task 2 W2 test; Task 7 `w2_abort_marker_gates_like_session_error`; Task 9 translate coverage), candidate/child pause arming (Task 3 tests; Task 7 `child_permission_asked_resolves_to_root_and_arms` + `candidate_pause_arms_and_deferred_completion_is_swallowed_at_bind`; Task 8 episode tests), HTTP root resolver (Task 9 `unmapped_session_is_resolved_via_http_before_forwarding`), two-phase connect ordering (Task 9 order pins), generation guard (Task 8 `respawn_drops_stale_lane_events`), version gate (Task 2 warn-once test; Task 9 `version_gate_matches_only_the_tested_range`). No stub survives without its production replacement task. The only residualized items are those explicitly adjudicated by the validation pass (W1 window, first-turn death silence, pathological quits, Rust bind tails, drift facts, deadman characterization) — documented in D8/Task 11, not silently dropped. **No unresolved coverage gaps.**

**2. Placeholder scan** — Tasks 2, 3, 5, 7, 8, 9 use comment-annotated test skeletons that specify exact event sequences and assertions with a "write in full" instruction plus a complete worked example in the same task; no TBD/TODO/"handle edge cases" items remain (re-verified after the validation-pass edits).

**3. Type consistency** — checked: `OpencodeActivityChange` marker fields match `TrulyIdleActivityChange` (`spontaneousExitRemovals`/`approvalPendingRemovals`, `:34`/`:41`); `untrackTerminal({ terminalId, spontaneous? })` matches the wiring call; Rust `OpencodeStatus`/`OpencodeLaneEvent` names match between Tasks 6–9; `opencode_frames` signature matches `claude_frames`' single-return shape (no force-reads); `blocks_death_bell`/`has_pending_permissions` names consistent across Tasks 7–8; `attach_opencode_serve(terminal_id, hostname, port)` consistent between Tasks 9–10; reducer `error` observation field names identical in Tasks 1–2 (and fed by both `session.error` and `message.updated`); `note_opencode_lane_event(terminal_id, generation, cycle, stream, event)` and `HubEvent::OpencodeLane{terminal_id, generation, cycle, stream, event}` consistent across Tasks 8–10 (helper, episode tests, lane loop, ingress guard, bind-lane test); `spawn_opencode_lane(..., generation: u64)` matches the `OpencodeAttach` arm; `opencode_lanes: HashMap<String, (u64, JoinHandle<()>)>` + `opencode_lane_next_generation` consistent between Tasks 8–9; two-phase `OpencodeEventStream::connect`/`ConnectedOpencodeStream::drive` names consistent across the trait, `ReqwestLaneStream` description, and lane tests; Rust root resolution is `resolve_root` (pure tracker, Tasks 6–8) with the lane-level HTTP fallback in Task 9, while Node reuses the existing `resolveRootForEvent` (Tasks 2–3); `TESTED_OPENCODE_VERSION_RANGE` named identically in the Node tracker and the Rust lane.
