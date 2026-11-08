# eaw7 — fresh-agent `statusSeq` for snapshot status-clobber: test coverage, e2e, and documentation surfaces

Read-only exploration report for kata freshell#eaw7. All citations verified in worktree
`/home/dan/.local/state/darkforge/freshell-fb808e79f4/worktrees/eaw7`.

Key orientation facts up front:

- `statusSeq` is confirmed absent: `rg "statusSeq" src/ crates/ server/ shared/` → zero matches (exit=1). The kata's premise holds.
- The closest existing client concept is `FreshAgentSessionState.statusVersion` (`src/store/freshAgentTypes.ts:55`,
  `src/store/freshAgentSlice.ts:67,84`) — a **client-side-only in-memory** freshness counter bumping on every
  `writeSessionStatus` (slice lines 82-85). It never crosses the wire, so it cannot guard a stale wire frame.
  Provenance: `docs/superpowers/plans/2026-06-25-freshcodex-bounce-and-recovery.md:27` "add a monotonic per-session
  status freshness field" and `:48` "Produces: `FreshAgentSessionState.statusVersion`, a monotonic in-memory status
  freshness counter that increments on every reducer-driven status write, including same-value writes."
- TWO snapshot fold sites matter (the kata names only one):
  - `sessionSnapshotReceived` (`src/store/freshAgentSlice.ts:278-317`, `writeSessionStatus` at `:304`) — the **live** WS
    fold, dispatched from `handleFreshAgentTransportEvent` on `freshAgent.session.snapshot`
    (`src/lib/fresh-agent-ws.ts:205-215`).
  - `freshAgentSnapshotReceived` (`src/store/freshAgentSlice.ts:363-393`, `writeSessionStatus` at `:376`) — the kata's
    cited site; its own comment says "This reducer is currently production-dormant (no dispatch site); the line is
    armor for any future HTTP-snapshot fold." (`:372-373`). Verified: only export site is the barrel at `:634`.
  - Status frames fold through `freshAgent.status` → `setSessionStatus` (`src/lib/fresh-agent-ws.ts:236-241` → slice `:395-405`).
- The production server is Rust (port 3001): snapshot/status frames are stamped in `crates/freshell-freshagent/`
  (`claude.rs:1913` `status_snapshot_frame`, emits at `:1227`,`:1414`; `opencode_ws.rs:1723` and snapshot-status folds
  at `:3359`,`:3443`; `codex.rs:3993,4009,5229,7633`). `nextMonotonicTurnCompleteAt` is Node-only
  (`server/fresh-agent/turn-complete-clock.ts`); a server-authoritative `statusSeq` must spec Rust-side stamping too,
  or the plan must scope explicitly to "server stamps when present, client guards when present".

---

## 1. The deferred source and the documentation anchors

### 1a. The deferral (verbatim)

`docs/superpowers/plans/2026-06-23-fresh-agent-status-authoritative-followups.md:798-804`:

> ```
> ## Deliberately out of scope (further follow-ups)
>
> These were NOT part of the two suggested next steps and are intentionally excluded to preserve scope:
> - A codex turn-activity deadman/timeout for a *wedged-but-alive* sidecar (different failure mode than a crash; `onExit` covers the crash/disconnect case fully).
> - snapshot status-clobber / provider-agnostic `statusSeq` for BLUE correctness on reconnect.
> - Centralizing GREEN/BLUE render precedence across TabItem / PaneHeader / Sidebar.
> ```

The same deferral first appears in the parent plan
`docs/superpowers/plans/2026-06-23-fresh-agent-server-authoritative-turn-complete.md:203-208`:

> - freshcodex `onExit` self-heal for a crashed sidecar (stuck-blue gap).
> - snapshot status-clobber / provider-agnostic `statusSeq` for BLUE correctness.
> - Centralizing GREEN/BLUE render precedence across TabItem / PaneHeader / Sidebar.
> - Making the waiting-for-approval edge server-authoritative too (delete the hook).

(Note: both neighboring items — onExit self-heal and the server-authoritative waiting edge — have since landed;
`statusSeq` is the last surviving deferral on that list, plus the render-precedence centralization item.)

### 1b. The `at`-monotonic clock regime description (sibling-of-which the statusSeq docs must live)

The fullest prose is `docs/superpowers/plans/2026-06-23-fresh-agent-server-authoritative-turn-complete.md:100-128`:

> **Dedupe regime: `at`-monotonic (no `completionSeq`).** A wall-clock `at` avoids the counter "restart-swallow":
> a per-session counter resets to 0 on restart while the client's dedupe state survives, so a resumed *durable*
> fresh-agent session (same `sessionId` after a deploy) would swallow real completions. ... The discrete edge is
> never re-derived from a snapshot level, so a reconnect cannot re-green, and a replayed/stale event with an
> older-or-equal `at` is dropped.
>
> Wall-clock `at` is *not* unconditionally monotonic across a restart, though ... the client **clears the
> per-terminal `at` baselines on a real server restart** (`resetCompletionDedupeBaselines`, dispatched from the
> bootId-change branch in `App.tsx`). ...
>
> **Server-side per-session monotonic clamp.** ... each emit site clamps its session's `at` to be strictly greater
> than the previous one via the shared `nextMonotonicTurnCompleteAt` helper. ... The clamp state must live on
> **per-session** server state, never per-subscription ...

Critically for eaw7: this section explicitly explains why a per-session counter was rejected *for the discrete
edge* (“never re-derived from a snapshot level”), and the deferral reserves `statusSeq` precisely for the snapshot
level where that invariant does not hold. The statusSeq design must address the same restart-swallow analysis
(counter resets vs. wall-clock regression) — and the repo already has the reset mechanism precedent
(`resetCompletionDedupeBaselines` at `src/store/turnCompletionSlice.ts:119-150`, dispatched on bootId change at
`src/App.tsx:1052`) **and** an instance-nonce-gated sequence precedent for session-directory reads:
`src/lib/api.ts:592-599` — “`revision` ... NOT monotonic — see snapshotSeq”, “`snapshotSeq` ... monotonic
per-instance page sequence — the ordering key for competing usage writes”, “`bootId` ... snapshotSeq ordering is
trusted only within the same instance+boot.” See also `shared/read-models.ts:124`.

The followups doc carries the short-form regime summary at
`docs/superpowers/plans/2026-06-23-fresh-agent-status-authoritative-followups.md:18-19`:

> - The discrete edge stamps a per-session strictly-monotonic wall-clock `at` via `nextMonotonicTurnCompleteAt(...)` (`server/fresh-agent/turn-complete-clock.ts`). Each new edge type keeps its OWN per-session `last*At` field.
> - The client dedupes each edge by `terminalId` via the `at`-monotonic regime in `recordTurnComplete`. ...

### 1c. AGENTS.md anchor (the canonical "documented alongside the turn-complete clock" location)

`AGENTS.md:239`, the **Agent Status Indicators** paragraph (exact sentence on the regime):

> The client folds it in via `applyFreshAgentCompletion` using the `at`-monotonic dedupe regime (wall-clock `at`,
> no per-session counter, so a resumed durable session can't swallow completions across a server restart).

A statusSeq sentence belongs in this same paragraph, adjacent to that sentence — the paragraph already states which
edges are server-authoritative (`freshAgent.turn.complete`, `freshAgent.turn.waiting`) but says nothing about
*sequence/ordering of status bearing frames* (`freshAgent.status`, `freshAgent.session.snapshot`). Task B6 of the
followups plan (`.../2026-06-23-fresh-agent-status-authoritative-followups.md:780-794`) established the precedent of
updating exactly this paragraph.

### 1d. The code comment that is the "turn-complete clock" home

`server/fresh-agent/turn-complete-clock.ts:1-18` (module docstring) is the in-code documentation anchor; a
statusSeq implementation either extends this file or lands a sibling module docstring, and the acceptance bullet
"documented alongside the turn-complete clock" points here. Per-session server clamp state today lives at
`server/sdk-bridge-types.ts:132-135` (`lastTurnCompleteAt?`, `lastWaitingAt?` on `SdkSessionState`) — the natural
neighbors for a per-session `lastStatusSeq`.

---

## 2. Existing unit tests for the freshAgent slice and server status emission

### 2a. Slice reducer tests — `test/unit/client/store/freshAgentSlice.test.ts` (198 lines)

Structure (each `it` verified):
- `describe('freshAgentSlice busy/streaming clearing')` (`:16-44`) — fixtures build state inline via
  `reducer(undefined, sessionSnapshotReceived({...loc, latestTurnId: null, status: 'running', streamingActive: true }))` (`:21`);
  its: `setSessionStatus(idle) clears streamingActive so the pane does not stay blue` (`:24`),
  `sessionError (non-RESTORE) clears streamingActive and resets running -> idle` (`:32`),
  `sessionError (RESTORE_*) does NOT reset running/streaming` (`:39`).
- `describe('freshAgentSlice')` (`:46-154`) — statusVersion pins: `increments statusVersion for same-valued
  setSessionStatus updates` (`:50`), `increments statusVersion for snapshot status events and preserves it across
  identity materialization` (`:60`, dispatches `sessionSnapshotReceived` then `freshAgentSnapshotReceived` with an
  inline fake snapshot object literal at `:69-86` — the fixture pattern for the full-snapshot reducer: `{ ...loc,
  threadId, revision, latestTurnId, status, capabilities, tokenUsage, pendingApprovals: [], pendingQuestions: [],
  worktrees: [], diffs: [], childThreads: [], turns: [], extensions: {} }`). Plus pending-create and materialization tests.
- `describe('freshAgentSlice lost revocation on truth-bearing snapshot evidence')` (`:156-198`) — **the closest
  existing slice-level race pattern**: `lostState()` helper seeds via `setSessionStatus(running)` then
  `markSessionLost`, then asserts both snapshot reducers revoke the stale flag (`:172`, `:177`).

Fake-snapshot fixture conventions: snapshots are plain inline object literals; locators via
`makeFreshAgentSessionKey` from `@shared/fresh-agent`; sessions list empty assertion via `state.sessions`.

### 2b. WS-router / thunk tests (where `at`-monotonic guards are pinned client-side)

- `test/unit/client/lib/fresh-agent-turn-complete.test.ts` (218 lines) — `makeStore()` builds a real
  `configureStore` with `panes`/`tabs` const reducers + `freshAgent` + `turnCompletion` reducers (`:53-62`);
  `turnCompleteMessage(at)` builds the `freshAgent.event` envelope (`:64-72`). Key its:
  - `dedupes a replayed/stale completion by the at-monotonic guard (no premature re-green)` (`:87-99`) — dispatches
    `handleFreshAgentMessage(dispatch, turnCompleteMessage(1000))` twice then `(500)`, asserts one pending event, then `(2000)` is accepted.
  - `drops a malformed completion without a numeric at instead of fabricating Date.now()` (`:101-128`).
  - waiting-edge namespace isolation (`:187-217`, `waitingMessage` builder `:29-34`).
  This is the direct mirror for a client-side "stale snapshot statusSeq dropped after newer status" test.
- `test/unit/client/lib/fresh-agent-ws.test.ts` — `sendEvent` helper pattern (`:412-418`) pushing raw
  `freshAgent.event` frames through `handleFreshAgentMessage`:
  - `projects every fresh-agent provider event carried by freshAgent.event into fresh-agent state` (`:408-476`) —
    exercises `freshAgent.session.snapshot` (`:420`) and `freshAgent.status` (`:423`) folds.
  - `does not let delayed metadata downgrade newer snapshot identity` (`:598-632`) — existing stale-frame guard.
  - `folds freshAgent.question.cancelled into removeQuestion...` (`:478-507`), `handles freshAgent.session.changed
    without mutating idle status` (`:509+`), `deduplicates repeated permission and question requests by request id`
    (`:634-677`).
- `test/unit/client/components/panes/PaneHeader.test.tsx:480` also dispatches `freshAgentSnapshotReceived` directly.
- `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (REST-snapshot path): `clears stale running
  session state when a freshcodex REST snapshot reports idle` (`:2814`), `...statusVersion...isGreaterThan...`
  guard reads at `:2979-2991`, `clears stale opencode busy state from a live-reconciled idle HTTP snapshot`
  (`:3015`), `does NOT clear opencode busy state from an idle snapshot that is not live-reconciled` (`:3073`), and
  `ignores an older same-session snapshot revision after newer history is already rendered` (`:3338`) — the
  revision-gated stale-rejection precedent (but revision gates history, not status). The view's fold logic is at
  `src/components/fresh-agent/FreshAgentView.tsx:1910-2004` (`statusChangedSinceRequest =
  agentSessionStatusVersionRef.current !== requestAgentSessionStatusVersion` at `:1983`, the
  `opencodeStatusFromLiveState` marker gate at `:1988-1997`).

### 2c. Server-side status-emission tests (server vitest config)

- `test/unit/server/sdk-bridge.test.ts` — `describe('stream-end / error idle status')`: `broadcasts sdk.status idle
  to a live subscriber when the stream ends naturally` (`:270`), `resets session status to idle (clearing blue)
  when the stream throws` (`:284`); `emits a server-authoritative sdk.turn.complete edge on a successful result`
  (`:375`); `stamps a strictly-increasing at on successive completions even within the same millisecond` (`:404`) —
  the exact assertion template for "stamps strictly-increasing statusSeq on successive status updates".
- `test/unit/server/fresh-agent/turn-complete-clock.test.ts:4-21` — `nextMonotonicTurnCompleteAt` clamps
  (first/wall/same-ms/backward) — template for a statusSeq generator unit.
- `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts` — `emits exactly one server-authoritative
  sdk.turn.complete on a successful send` (`:223`), status-reconciliation suite (`:622`, `:646`, `:688`, `:717`,
  `:742`, `:852`), central `emitStatus` under test (implementation `server/fresh-agent/adapters/opencode/adapter.ts:507`).
- `test/unit/server/fresh-agent/codex-adapter.test.ts` — `emits a server-authoritative sdk.turn.complete only for a
  completed turn on the subscribed thread` (`:1083`), `stamps a strictly-increasing at ...` (`:1227`), `keeps the
  turn-complete clock monotonic per thread across a re-subscribe (WS reconnect)` (`:1261`), `resets the per-thread
  turn-complete clock on shutdown` (`:1302`) — **the reconnect-preserves-clamp test**, the direct template for a
  per-session statusSeq that must survive subscription teardown.
- `test/unit/server/ws-fresh-agent-contract.test.ts:21-55` — `normalizeFreshAgentProviderEvent` mappings incl.
  `freshAgent.status` passthrough (`:46-55`); normalization spreads (`{ ...providerEvent, type: ... }` in
  `server/fresh-agent/sdk-events.ts:48-83`), so a new field rides through automatically but should be pinned here.
- `test/unit/server/fresh-agent/sdk-events.test.ts:5-25` — turn.complete/waiting normalize tests (add `sdk.status`
  / `sdk.session.snapshot` statusSeq carry tests here).
- `test/unit/server/ws-handler-fresh-agent.test.ts:930` — `attaches a persisted fresh-agent session and forwards
  live adapter events over freshAgent.event`; `:1189` drives `sdk.session.snapshot``{status:'running'}` into the
  attach path — covers the subscribe→snapshot emission lane.
- Rust lanes (production server): `crates/freshell-freshagent/src/claude.rs` inline tests asserting snapshot frames
  (`:2387`,`:2439`,`:2526`...); `crates/freshell-ws/tests/freshagent_claude_attach.rs:370,525,584` (await
  session.snapshot + `freshAgent.status` frame ordering after attach); `crates/freshell-freshagent/src/opencode_ws.rs:3359`
  (folds `status` out of `freshAgent.session.snapshot` frames), `:3882-4262` running→idle ordering assertions;
  `crates/freshell-ws/tests/freshagent_session_lease.rs:784,959,968`.

---

## 3. The "existing turn-complete e2e" and the busy/idle indicator e2e coverage

### 3a. The vitest e2e that must stay green (this is the acceptance bullet's target)

`test/e2e/fresh-agent-turn-complete-notification.test.tsx` (207 lines; runs under the **default** vitest config —
`test/e2e/**` is not in `config/vitest/vitest.config.ts`'s exclude list):

- Harness: `playSound = vi.hoisted(() => vi.fn())` (`:18`) mocked via `@/hooks/useNotificationSound`; `wsMocks`
  hoisted emitter with `onMessage`/`emitMessage` (`:20-32`) and a `@/lib/ws-client` mock (`:38-45`); `Harness`
  component wires `useTurnCompletionNotifications()` + a WS message handler to `handleFreshAgentMessage` (`:73-84`);
  `createStore()` builds the real store with `preloadedState` including
  `turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {}, attentionByPane: {} }`
  (`:86-145`); `turnComplete(at)` / `turnWaiting(at)` inject `freshAgent.event` frames (`:53-71`).
- `describe('fresh-agent server-authoritative turn completion (e2e notification flow)')` (`:147-207`):
  - `chimes once and highlights the agent tab on a server-pushed completion, and ignores replays` (`:166-187`) —
    includes the replay/stale dedupe assertions (`turnComplete(1000)` twice + `turnComplete(500)` → 1 chime;
    `turnComplete(2000)` → 2 chimes).
  - `greens + chimes exactly once when the server pushes freshAgent.turn.waiting` (`:189-206`).
- Per the followups plan, the followup of record is run via:
  `npm run test:vitest -- run test/e2e/fresh-agent-turn-complete-notification.test.tsx -t "freshAgent.turn.waiting"`
  and the full file without `-t` (`.../2026-06-23-fresh-agent-status-authoritative-followups.md:763,770`).

### 3b. Playwright busy(BLUE)/idle surfaces

- `test/e2e-browser/specs/pane-activity-indicator.spec.ts` — `test('freshclaude panes transition from waiting to
  blue running and back to idle', ...)` (`:79`) drives freshAgent state via `window.__FRESHELL_TEST_HARNESS__`
  dispatches + `setFreshAgentNetworkEffectsSuppressed` (`:85-90`) and asserts `.text-blue-500` on tab + pane header
  icons via `expectChromeBlue` (`:19-30`). Also `claude terminals go blue ...` (`:185`). **Cloud-skipped** —
  `test/e2e-browser/playwright.cloud.config.ts:49-50`: `'pane-activity-indicator.spec.ts'` under
  "Environment-sensitive: timing-sensitive status transitions". If eaw7 adds a Playwright lane here, it runs
  locally only unless the skip is revisited.
- `test/e2e-browser/specs/truly-idle-alerting.spec.ts:76` — terminal-lane blue/green + alert edge (claude terminal);
  cloud-skipped (`playwright.cloud.config.ts:59-61`).
- `test/e2e-browser/specs/turn-complete-restart-resume-rust.spec.ts:11-25` — docstring: "across an abrupt server
  restart, a recovered CLI pane's next completed turn must ring EXACTLY once"; rust-only (`RUST_ONLY_SPECS` in
  `test/e2e-browser/playwright.config.ts:207`, `testMatch` `:436`), **not** in CLOUD_SKIP_SPECS (earlier line 4-8).
- `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` — Rust-only (`playwright.config.ts:288`,`:538`), not
  cloud-skipped; includes `kilroy crash mid-turn + restart recover the SAME durable session, never a fabricated
  completion` (`:1140`).
- Other CLOUD_SKIP_SPECS entries adjacent to fresh-agent: `fresh-agent-centralization-smoke.spec.ts`
  (`:45-46`, requires binaries). `fresh-agent.spec.ts` itself is UI/status-strip coverage (chip/meter/picker), not
  busy-state transitions.

---

## 4. Exact focused-test commands for per-task gates

Coordinator: `npm run test:vitest` → `tsx scripts/testing/test-coordinator.ts run test:vitest`
(`package.json:59`), a passthrough lane (`scripts/testing/test-coordinator.ts:153-154`).

- Client unit (default config, jsdom — `config/vitest/vitest.config.ts:27`, aliases `:56-60`; test/e2e + test/unit/client included by default):
  ```
  npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts
  npm run test:vitest -- run test/unit/client/lib/fresh-agent-turn-complete.test.ts
  npm run test:vitest -- run test/unit/client/lib/fresh-agent-ws.test.ts
  npm run test:vitest -- run test/e2e/fresh-agent-turn-complete-notification.test.tsx -t "<it name>"
  ```
- Server side (must pass the server config explicitly — server tests are excluded from the default config,
  `config/vitest/vitest.config.ts:39-41`; included under `config/vitest/vitest.server.config.ts:27-36`):
  ```
  npm run test:vitest -- run test/unit/server/sdk-bridge.test.ts --config config/vitest/vitest.server.config.ts
  npm run test:vitest -- run test/unit/server/fresh-agent/opencode-serve-adapter.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts --config config/vitest/vitest.server.config.ts
  ```
  Precedent for the explicit `--config` form: AGENTS.md's real-provider contracts command
  (`npm run test:vitest -- run test/integration/real/ --config config/vitest/vitest.server.config.ts`).
- Broad suites: `npm run test:unit` (default-config `test/unit`), `npm run test:integration` / `npm run test:server`
  (server-config workload), `npm test` (coordinated both) — all through the coordinator gate.
- Playwright: `npm run test:e2e` (backend per `FRESHELL_E2E_BACKEND`); chromium-project direct form
  `npm run test:e2e:chromium`; rust lanes `playwright test --config test/e2e-browser/playwright.config.ts
  --project=rust-chromium specs/<name>.spec.ts` (precedent:
  `docs/plans/2026-07-25-client-retry-restart-hardening.md:1248-1254`).
- Rust crate tests (if Rust stamping is in scope): `cargo test -p freshell-freshagent` (crate has inline `#[cfg(test)]`
  modules) and the freshell-ws test binaries (`cargo test --test freshagent_claude_attach`).

---

## 5. Protocol/schema documentation surfaces needing a `statusSeq` mention

- No dedicated `docs/` protocol file enumerates freshAgent WS messages (glob `docs/**/*protocol*` → none).
  The canonical enumeration is `AGENTS.md:239` (see 1c).
- Type surfaces:
  - `server/fresh-agent/sdk-events.ts` — `FreshAgentProviderEvent` union; status-bearing frames:
    `freshAgent.session.snapshot` (`:5-14`, has `status: SdkSessionStatus` at `:9`), `freshAgent.status` (`:34`).
    `at`-bearing edges for comparison: `:35-36`. Normalizer `normalizeFreshAgentProviderEvent` spreads (`:48-83`).
  - `shared/fresh-agent-contract.ts` — REST `FreshAgentSnapshotSchema` (`:247-267`, `.strict()` — a new field MUST
    be added explicitly; `status` at `:251`, `revision` at `:249`).
  - `shared/ws-protocol.ts` — `freshAgent.event` envelope is payload-opaque (`:1121` `event: unknown`), so no zod
    change needed for the WS layer.
- Docs surfaces (all verified to enumerate freshAgent frame types or regimes):
  - `docs/plans/2026-07-19-state-sync-cartography.md:136-143` — §2.8 "Fresh-agent session state": "server-authoritative
    discrete edges `freshAgent.turn.complete` (at-monotonic dedupe) and `freshAgent.turn.waiting` (separate dedupe
    namespace) per AGENTS.md". This is a living cartography doc of state-sync invariants — the natural home for the
    statusSeq-vs-at-monotonic ordering rule.
  - `docs/plans/df1/HARNESS-03.md:77` — fake-sidecar protocol table including `sdk.status` fold; update if a fixture
    starts stamping seq.
  - `docs/plans/2026-08-22-reconnect-revive.md:758-795` — documents `ClaudeSession.last_status` (Rust-side snapshot
    status stamping from the last `sdk.status` fold), i.e. where a Rust statusSeq counter must be threaded.
  - `server/fresh-agent/turn-complete-clock.ts:1-18` — the clock module docstring (see 1d).
  - `src/store/turnCompletionThunks.ts:44-54` — `applyFreshAgentCompletion` docstring compressing the regime client-side.

---

## 6. Existing investigation/race test patterns (templates for the RED-first test)

1. **`test/unit/client/lib/fresh-agent-ws.test.ts:598-632`** — `does not let delayed metadata downgrade newer
   snapshot identity`: sends a newer `freshAgent.session.snapshot` then an older `freshAgent.session.metadata`,
   asserts the stale frame loses. Same store/harness shape a stale-status test needs.
2. **`test/unit/client/lib/fresh-agent-turn-complete.test.ts:87-99`** — `dedupes a replayed/stale completion by the
   at-monotonic guard`: dispatch newer edge → replay same → older → assert dropped; then a strictly newer accepted.
   This is THE mirror for `statusSeq` semantics on `freshAgent.status`/`freshAgent.session.snapshot`.
3. **`test/unit/client/store/freshAgentSlice.test.ts:156-198`** — `lost revocation` describe: seed wedge state via a
   helper (`lostState()`), then assert the truth-bearing frame heals it — the "stale A must not clobber newer B"
   helper style at the pure-reducer level.
4. **`test/unit/server/terminal-registry.rebind-metadata-resync.test.ts:147-182`** — `a slow classification for a
   superseded target cannot clobber the newer answer`: deferred-promise stale answer resolved after a newer write,
   asserting `.toBeUndefined()` on the stale field — the async-ordering clobber template.
5. **`test/unit/client/components/fresh-agent/FreshAgentView.test.tsx:3338`** — `ignores an older same-session
   snapshot revision after newer history is already rendered`: stale-vs-newer by explicit monotonic key (`revision`),
   at the REST-snapshot layer.

---

## 7. Closing: concrete files to add/extend + doc anchors

### New/extended test files (recommended test names)

- EXTEND `test/unit/client/store/freshAgentSlice.test.ts` — new describe
  `freshAgentSlice statusSeq ordering` with:
  - `sessionSnapshotReceived drops a snapshot whose statusSeq is older than the session's last status seq (stale
    snapshot after newer status leaves newer state intact)`
  - `sessionSnapshotReceived accepts a snapshot whose statusSeq is newer than the last frame`
  - `setSessionStatus accepts strictly-newer statusSeq / drops equal-or-older`
  - `a missing statusSeq (legacy server) folds unconditionally (no false drop)` — explicit compatibility pin.
- EXTEND `test/unit/client/lib/fresh-agent-ws.test.ts` —
  - in `projects every fresh-agent provider event...` (`:408`) add statusSeq-bearing `freshAgent.status` /
    `freshAgent.session.snapshot` frames; new it:
    `a stale freshAgent.session.snapshot (older statusSeq) does not clobber a newer freshAgent.status (BLUE stays)`
    — the kata's headline investigation-style RED test, mirroring template #2.
- EXTEND `test/unit/server/sdk-bridge.test.ts` — `stamps a strictly-increasing statusSeq on successive sdk.status
  frames even within the same millisecond` (mirror of `:404`), plus a reconnect-scope test: `statusSeq keeps
  climbing across re-subscribe (WS reconnect)` (mirror of codex-adapter `:1261`).
- EXTEND `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts` and
  `test/unit/server/fresh-agent/codex-adapter.test.ts` — per-provider seq-monotonicity tests at the `emitStatus` /
  status-emit seams (`server/fresh-agent/adapters/opencode/adapter.ts:507`; codex adapter status sites
  `server/fresh-agent/adapters/codex/adapter.ts:892,945`; sdk-bridge `server/sdk-bridge.ts:437,494`).
- EXTEND `test/unit/server/fresh-agent/sdk-events.test.ts` — normalize carries `statusSeq` on `sdk.status` →
  `freshAgent.status` and `sdk.session.snapshot` → `freshAgent.session.snapshot`.
- EXTEND `shared/fresh-agent-contract.ts` tests — whatever contract suite pins `FreshAgentSnapshotSchema` strictness
  (see `test/unit/shared/fresh-agent-contract.test.ts`) must accept the new optional field.
- RUN-GREEN guard: `test/e2e/fresh-agent-turn-complete-notification.test.tsx` must stay green unmodified
  (acceptance bullet); targeted via the §4 command.
- Rust scope decision required: if production Rust servers stamp `statusSeq`, mirror the stamp tests in
  `crates/freshell-freshagent` (`claude.rs` inline tests around `:2439+`, `opencode_ws.rs:3359` fold test,
  `codex.rs:5229`) and `crates/freshell-ws/tests/freshagent_claude_attach.rs` (`:370`,`:525`,`:584`). At minimum the
  plan should state the client treats the field as optional so mixed server builds do not wedge (legacy-fold pin above).

### Docs anchors to update

1. `AGENTS.md:239` (Agent Status Indicators paragraph) — add the statusSeq ordering sentence immediately after the
   `applyFreshAgentCompletion ... at-monotonic dedupe regime` sentence.
2. `server/fresh-agent/turn-complete-clock.ts:1-18` docstring (or sibling new module) — document the seq semantics
   where the clock is documented; update clamp-state fields at `server/sdk-bridge-types.ts:132-135`.
3. `docs/plans/2026-07-19-state-sync-cartography.md:141` (§2.8 Replicas + sync row) — add statusSeq to the
   enumerated server-authoritative ordering guarantees.
4. `server/fresh-agent/sdk-events.ts:9,34-36` — union comments noting which frames are seq-bearing.
5. `docs/plans/2026-08-22-reconnect-revive.md:758-795` context if Rust-side `last_status` stamping gains a seq.

