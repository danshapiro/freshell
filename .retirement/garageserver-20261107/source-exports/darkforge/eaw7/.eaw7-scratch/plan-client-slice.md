# eaw7 client-slice exploration — fresh-agent status folding (`statusSeq` groundwork)

Work tree: `/home/dan/.local/state/darkforge/freshell-fb808e79f4/worktrees/eaw7`
All line numbers verified against this checkout (work item text cites `freshAgentSnapshotReceived` at
374-399; in this worktree the reducer is at `src/store/freshAgentSlice.ts:363-393`).
Confirmed precondition: `statusSeq` has ZERO matches in `src/`, `server/`, `crates/`, `shared/` (only two
future-work mentions in `docs/superpowers/plans/2026-06-23-fresh-agent-*.md:206,802`).

## 1. freshAgentSlice: snapshot type, per-session record, the snapshot reducer, dedupe regime

### 1a. `FreshAgentSnapshot` type

The client type is a zod inference of `FreshAgentSnapshotSchema`
(`shared/fresh-agent-contract.ts:247-267`, exported at `:335`):

```ts
export const FreshAgentSnapshotSchema = FreshAgentThreadLocatorSchema.extend({
  sessionId: z.string().min(1).optional(),
  revision: z.number().int().nonnegative(),
  latestTurnId: z.string().nullable().optional(),
  status: z.string().min(1),            // <-- free string, provider-defined, NO statusSeq
  summary: z.string().optional(),
  capabilities: FreshAgentCapabilitiesSchema,
  settings: FreshAgentSettingsSchema.optional(),
  tokenUsage: FreshAgentTokenUsageSchema,
  pendingApprovals: z.array(FreshAgentPendingApprovalSchema).default([]),
  pendingQuestions: z.array(FreshAgentPendingQuestionSchema).default([]),
  worktrees: z.array(FreshAgentWorktreeSchema).default([]),
  diffs: z.array(FreshAgentDiffSummarySchema).default([]),
  childThreads: z.array(FreshAgentChildThreadSchema).default([]),
  turns: z.array(FreshAgentTurnSchema).default([]),
  extensions: FreshAgentExtensionsSchema.default({}),
  commands: z.array(FreshAgentSessionCommandSchema).readonly().optional(),
}).strict()
```

`.strict()` — an unknown key like `statusSeq` currently FAILS parse
(`FreshAgentApiContractError` at `api.ts:439-441`), so the schema must be extended before the server ships it.
`revision` exists but is the transcript/history revision, used for hydration restart
(`freshAgentSlice.ts:292-301`) and display-merge (`FreshAgentView.tsx:198-205`), NOT a status order key.

### 1b. Per-session record shape (client state)

`src/store/freshAgentTypes.ts:51-89` — `FreshAgentSessionState`:

```ts
export type FreshAgentSessionState = FreshAgentSessionLocator & {
  sessionKey: string
  threadId: string
  status: FreshAgentSessionStatus
  statusVersion?: number               // client-local bump-on-write counter (NOT a server seq)
  snapshot?: FreshAgentSnapshot
  latestTurnId?: string | null
  historySessionId?: string
  historyRevision?: number
  cliSessionId?: string
  cwd?: string
  model?: string
  tools?: Array<{ name: string }>
  turns: FreshAgentTurn[]
  historyItems: FreshAgentTurn[]
  historyBodies: Record<string, FreshAgentTurn>
  nextHistoryCursor?: string | null
  historyLoading?: boolean
  historyError?: string
  streamingText: string
  streamingActive: boolean
  pendingPermissions: Record<string, FreshAgentPermissionRequest>
  pendingQuestions: Record<string, FreshAgentQuestionRequest>
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  lastError?: string
  lastErrorCode?: string
  historyLoaded?: boolean
  awaitingDurableHistory?: boolean
  lost?: boolean
  restoreRetryCount?: number
  restoreFailureCode?: string
  restoreFailureMessage?: string
  snapshotRefreshRequestId?: number    // vestigial: only ever RESET (freshAgentSlice.ts:311)
  restoreHydrationRequestId?: number
}
```

No per-session turn-complete/waiting dedupe keys live here — those are keyed in `turnCompletion` slice
(`turnCompletionSlice.ts:23-25` `lastAtByTerminalId` / `lastIdleAtByTerminalId`). The locator is
`{ sessionType, provider, sessionId }` (`freshAgentTypes.ts:30-34`); state map key is
`makeFreshAgentSessionKey(locator)` = `sessionType:provider:sessionId` (`freshAgentSlice.ts:41-43`).

Root state: `{ sessions, pendingCreates, pendingCreateFailures, availableModels }`
(`freshAgentTypes.ts:91-96`).

### 1c. `freshAgentSnapshotReceived` reducer — VERBATIM (`src/store/freshAgentSlice.ts:363-393`)

```ts
    freshAgentSnapshotReceived(state, action: PayloadAction<{ snapshot: FreshAgentSnapshot }>) {
      const snapshot = action.payload.snapshot
      const session = ensureSession(state, {
        sessionId: snapshot.threadId,
        sessionType: snapshot.sessionType,
        provider: snapshot.provider,
      }, snapshot.status as FreshAgentSessionStatus)
      // Truth-bearing frame: a snapshot answer proves the session exists —
      // revoke a stale `lost` flag from a transient dead-window race
      // (reconnect unwedge). This reducer is currently production-dormant (no
      // dispatch site); the line is armor for any future HTTP-snapshot fold.
      session.lost = false
      session.snapshot = snapshot
      writeSessionStatus(session, snapshot.status as FreshAgentSessionStatus)
      session.latestTurnId = snapshot.latestTurnId
      session.historyRevision = snapshot.revision
      session.turns = snapshot.turns
      session.historyItems = snapshot.turns
      session.historyBodies = Object.fromEntries(snapshot.turns.map((turn) => [turn.turnId, turn]))
      session.pendingPermissions = Object.fromEntries(
        snapshot.pendingApprovals.map((approval) => [String(approval.requestId), approval]),
      )
      session.pendingQuestions = Object.fromEntries(
        snapshot.pendingQuestions.map((question) => [String(question.requestId), question]),
      )
      session.totalInputTokens = snapshot.tokenUsage.inputTokens
      session.totalOutputTokens = snapshot.tokenUsage.outputTokens
      session.totalCostUsd = snapshot.tokenUsage.costUsd ?? 0
      session.historyLoaded = true
      session.awaitingDurableHistory = false
    },
```

`writeSessionStatus` helper (`freshAgentSlice.ts:82-85`) — the single choke point for session.status writes:

```ts
function writeSessionStatus(session: FreshAgentSessionState, status: FreshAgentSessionStatus): void {
  session.status = status
  session.statusVersion = (session.statusVersion ?? 0) + 1
}
```

> IMPORTANT: grep confirms NO production dispatch site for `freshAgentSnapshotReceived` — only tests
> (`test/unit/client/store/freshAgentSlice.test.ts:69,178`, `PaneHeader.test.tsx:480`). The LIVE
> status-bearing snapshot folds are (a) the WS `freshAgent.session.snapshot` event ->
> `sessionSnapshotReceived` (`fresh-agent-ws.ts:205-215` -> reducer `freshAgentSlice.ts:278-317`,
> which unconditionally calls `writeSessionStatus(session, action.payload.status)` at `:304`) and
> (b) REST snapshot status adoption in FreshAgentView (section 2).

### 1d. `applyFreshAgentCompletion` / `applyFreshAgentWaiting` and the `at`-monotonic regime

Both live in `src/store/turnCompletionThunks.ts` (NOT in the freshAgent slice):

```ts
export type ApplyFreshAgentCompletionPayload = {
  provider: string
  sessionId: string
  at: number
}
```
`applyFreshAgentCompletion` (`turnCompletionThunks.ts:55-69`), doc comment `:44-54`: "We resolve the
owning tab/pane from the provider:sessionId session key and fold the event into the GREEN/SOUND
pipeline via the at-monotonic dedupe regime (no completionSeq). ... Across a real server restart the
client clears the per-terminal at baselines (resetCompletionDedupeBaselines)..." It resolves location
via `findFreshAgentPaneBySessionKey` (`:106-149`, matching runtime key `provider:sessionId` OR
`resolveFreshAgentSessionKey(content, session)`), then:

```ts
    dispatch(recordTurnComplete({
      tabId: location.tabId,
      paneId: location.paneId,
      terminalId: sessionKey,                       // `${provider}:${sessionId}`
      at: payload.at,
    }))
```

`applyFreshAgentWaiting` (`turnCompletionThunks.ts:90-104`) is identical except the dedupe namespace:

```ts
      terminalId: `${sessionKey}#waiting`,
```

The guard itself is `recordTurnComplete` in `src/store/turnCompletionSlice.ts:82-95`:

```ts
    recordTurnComplete(state, action: PayloadAction<TurnCompletePayload>) {
      const { terminalId, at } = action.payload
      // Monotonic, replay-safe dedupe: only record a completion strictly newer
      // than the last seen for this terminal. A replayed/stale completion with
      // an older-or-equal `at` is ignored so scrollback replay cannot re-green.
      const last = state.lastAtByTerminalId[terminalId]
      if (last !== undefined && at <= last) return
      state.lastAtByTerminalId[terminalId] = at
      state.seq += 1
      state.pendingEvents.push({ ...action.payload, seq: state.seq })
    },
```

Semantics summary:
- Key namespace: `terminalId`-string map in `turnCompletion.lastAtByTerminalId`. Fresh-agent completion
  uses `${provider}:${sessionId}`; waiting uses `${provider}:${sessionId}#waiting`; terminal-CLI idle
  uses a SEPARATE map `lastIdleAtByTerminalId` (`recordTerminalIdle`, `:100-114`).
- Comparison rule: strictly-greater wall-clock `at` wins; `at <= last` dropped.
- Wall-clock `at` is stamped server-side by `nextMonotonicTurnCompleteAt`
  (`server/fresh-agent/turn-complete-clock.ts:19-21`:
  `return lastAt !== undefined && now <= lastAt ? lastAt + 1 : now`), documented `:1-18` (clamp for
  same-ms/backwards clock within a process; restart gap closed on the client).
- Restart safety: `resetCompletionDedupeBaselines` (`turnCompletionSlice.ts:119-122`) is dispatched from
  `src/App.tsx:1050-1053` on `serverRestarted || instanceChanged || firstReadyBaseline` (bootId /
  serverInstanceId from the `ready` frame, `App.tsx:1019-1053`). Never on plain reconnect. Fires on
  EITHER restart signal.
- Malformed events with no numeric finite `at` are dropped, client never fabricates `Date.now()`
  (`fresh-agent-ws.ts:246-248, 258-260`).
- The "waiting" edge doc notes replay semantics (`turnCompletionThunks.ts:83-89`): server replays
  buffered waiting only to the FIRST subscriber; reconnecting clients get NO replay and rehydrate
  pending approvals from the session snapshot — "a still-pending approval does not spuriously re-green
  on reconnect". This is exactly the snapshot-status analogue the work item targets.

### 1e. Every writer of the per-session `status` field (freshAgentSlice.ts)

All writes go through `writeSessionStatus` except initial creation:

| Site | Line | Status written | Ordering guard today |
|---|---|---|---|
| `createSession` / `ensureSession` | :60-95 | ctor default 'starting' / caller status | none |
| `sessionCreated` | :210-213 | 'connected' (else re-write same) | none |
| `sessionInit` | :246-248 | 'connected' only from creating/starting | phase check |
| `sessionSnapshotReceived` | :304 | snapshot status — UNCONDITIONAL | none (revision only gates hydration restart, :292-301) |
| `freshAgentSnapshotReceived` | :376 | snapshot status — UNCONDITIONAL | none (production-dormant) |
| `setSessionStatus` (WS `freshAgent.status`) | :395-405 | event status — UNCONDITIONAL (+clears streaming on idle/exited, :399-404) | none |
| `sessionError` | :448-455 | 'idle' from running/starting on non-RESTORE errors | none |
| `materializeSession` | :335-345 | spreads previous record (preserves status/statusVersion) | n/a |
| `turnResult` | :546 | 'idle' | none |
| `setStreaming` | :590-597 | 'running' from idle when active | phase check |
| `appendStreamDelta` | :598-606 | 'running' from idle | phase check |
| `sessionExited` | :614-618 | 'exited' | none |

Also the FreshAgentView REST-snapshot fold dispatches `setSessionStatus` guarded at the COMPONENT
level (see section 2) — reducers themselves are guard-free.

## 2. Where snapshots are fetched and what triggers refetch

### REST fetch (the full `FreshAgentSnapshot` contract payload)

`src/lib/api.ts:422-443` — `getFreshAgentThreadSnapshot(sessionType, provider, threadId, {revision?, cwd?, trigger?})`
issues `GET /api/fresh-agent/threads/{sessionType}/{provider}/{threadId}?revision=&cwd=&trigger=` and
validates with `FreshAgentSnapshotSchema.safeParse` (throws `FreshAgentApiContractError` at `:439-441`).

Driver: the snapshot effect in `src/components/fresh-agent/FreshAgentView.tsx:1886-2147`. Per-pane
component state: `snapshot` useState + `snapshotRef` + `commitSnapshot` (`:659-664`),
`snapshotRefreshNonce` + `snapshotRefreshTriggerRef` (`:666-667`), and
`requestSnapshotRefresh(trigger)` (`:1016-1019`) which just tags the trigger and bumps the nonce.
The fetch goes through the shared per-key scheduler:

```ts
    const key = makeSnapshotKey({ sessionType: requestSessionType, provider, threadId: sessionId, cwd: requestCwd })
    const trigger = snapshotRefreshTriggerRef.current
    void getSnapshotScheduler().schedule(key, trigger, () =>
      getFreshAgentThreadSnapshot(requestSessionType, provider, sessionId, {
        ...(requestCwd ? { cwd: requestCwd } : {}),
        trigger,
      }),
    ).then((outcome) => { ...applySnapshot... })
```
(`FreshAgentView.tsx:2090-2123`)

Scheduler: `src/lib/fresh-agent-snapshot-scheduler.ts` (module singleton, `:182-185`) —
single-flight + trailing coalesce + class-based debounce (`SNAPSHOT_DEBOUNCE_MS = 250`, `:30`;
`DEBOUNCED_TRIGGERS = ['event','send-accepted','reveal','reconnect']`, `:34`) + 429 backoff.

Trigger union (`fresh-agent-snapshot-scheduler.ts:19-21`):

```ts
export type SnapshotTrigger =
  | 'identity' | 'event' | 'send-accepted' | 'materialized'
  | 'manual' | 'poll' | 'reconnect' | 'reveal' | 'idle-incomplete'
```

Trigger sites in FreshAgentView:
- `'reconnect'` — `ws.onReconnect` handler: `:1619` (visible panes). Hidden panes defer via
  `pendingRevealRefreshRef` then refresh as `'reveal'` on un-hidden (`:1624-1630`).
- `'event'` — ws.onMessage: any `freshAgent.event` whose inner type is in
  `SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS` (`:90-101`, INCLUDES `'freshAgent.session.changed'` at :91,
  plus `session.snapshot`, `result`, `turn.complete`, permission/question request/cancel) AND
  `locatorMatchesPane` (`:438-469`) → `requestSnapshotRefresh('event')` (`:1839-1844`).
- `'send-accepted'` `:1783`; `'materialized'` `:1736`; `'manual'` `:1306` and 429-retry `:2116`;
  `'poll'` — busy-poller effect `:2298-2303` (re-fetches while `effectiveStatus` in EARLY_STATES or busy);
  `'idle-incomplete'` `:1954-1965` (bounded re-poll when an idle snapshot lags a just-sent turn).
- Staleness of an in-flight REQUEST: `isStaleSnapshotRequest()` (`:1899-1904`): createRequestId /
  provider / sessionType / threadId identity mismatch vs `paneContentRef`. NOT status-order based.

### How snapshot status lands in the slice (REST path — the actual live clobber surface)

Inside `applySnapshot` (`FreshAgentView.tsx:1911-2036`), guarded dispatch of `setSessionStatus`
(`:1998-2014`):

```ts
      const sessionStatus = nextStatus === 'create-failed' ? null : nextStatus
      const snapshotIsBusy = sessionStatus === 'running' || sessionStatus === 'compacting'
      const statusChangedSinceRequest = agentSessionStatusVersionRef.current !== requestAgentSessionStatusVersion
      const currentSessionStatus = agentSessionStatusRef.current ?? fresh.status
      const wouldRegressStatus = sessionStatus
        ? isStatusRegression(currentSessionStatus, sessionStatus)
        : false
      ...
      const canAdoptSnapshotStatus =
        (provider === 'codex' && requestSessionType === 'freshcodex')
        || (provider === 'opencode' && requestSessionType === 'freshopencode'
          // busy (running) may always be adopted; idle (busy-CLEARING) only when
          // live-reconciled ...
          && (snapshotIsBusy || opencodeStatusFromLiveState))
      if (
        sessionStatus
        && nextSessionId
        && canAdoptSnapshotStatus
        && !wouldRegressStatus
        && (
          snapshotIsBusy
          || (!hasBlockingLocalEchoForSession && !statusChangedSinceRequest)
        )
      ) {
        dispatch(setSessionStatus({ sessionId: nextSessionId, sessionType: requestSessionType, provider, status: sessionStatus }))
      }
```

`statusVersion` guard pieces: `requestAgentSessionStatusVersion` captured at request start (`:1910`),
live refs `agentSessionStatusRef`/`agentSessionStatusVersionRef` (`:643-646` read `agentSession?.statusVersion`
per render). `isStatusRegression` (`:228-230`) uses `EARLY_STATES = new Set(['creating', 'starting'])` (`:75`)
— only forbids dropping INTO an early state from a later one, not bidirectional races.
`opencodeStatusFromLiveState` reads `snapshot.extensions.opencode.statusFromLiveState` (`:1988-1990`).
NOTE: for claude/kilroy providers there is NO REST snapshot status adoption at all (`canAdoptSnapshotStatus`
is codex/freshcodex + opencode/freshopencode only) — claude/kilroy busy flows through WS frames.

### WS-pushed snapshot frame

`src/lib/fresh-agent-ws.ts:205-215`: on `freshAgent.event` with inner `freshAgent.session.snapshot` →
`sessionSnapshotReceived({latestTurnId, status, historySessionId, revision, streamingActive, streamingText})`
→ `freshAgentSlice.ts:304` unconditionally writes status. Server side the frame is the normalized
`sdk.session.snapshot` (`server/fresh-agent/sdk-events.ts:49-50`; payload type `:6-14`, status typed
`SdkSessionStatus`), emitted on (re)subscribe by adapters — e.g. opencode
`server/fresh-agent/adapters/opencode/serve-events.ts:103-106` answers subscribe with a snapshot whose
status may be mid-reconcile ('idle' default at `:103` or live-known at `:106`), and codex
`server/fresh-agent/adapters/codex/adapter.ts:258`. `freshAgent.status` (`sdk.status`) → `setSessionStatus`
(`fresh-agent-ws.ts:236-241`). `freshAgent.session.changed` currently returns true with NO fold
(`fresh-agent-ws.ts:216-217`) — it only drives the REST refetch via the invalidating-events set.

## 3. Busy (BLUE) consumption chain

Source of truth read: `state.freshAgent.sessions[key]` looked up by
`makeFreshAgentSessionKey({sessionType, provider, sessionId: content.sessionId})`
(`pane-activity.ts:194-200` and `:322-332`).

1. `isFreshAgentBusy(content, session)` — `src/lib/pane-activity.ts:58-78`:
   - no live session (or no `sessionId`) -> NOT busy ("Persisted content.status can be stale after
     reload, so live session state is the source of truth", `:62-64`)
   - `status === 'compacting'` -> busy; any pending permission/question -> NOT busy (waiting, not working);
     `streamingActive` -> busy; else `status === 'running'` (the codex/other branches are identical today).
2. `resolvePaneActivity` fresh-agent branch — `pane-activity.ts:193-204` -> `{ isBusy, source: 'fresh-agent' }`.
3. Per-pane BLUE icon: `src/components/panes/PaneContainer.tsx:492-504` builds the input and passes
   `busy={paneBusy}` into `Pane` (`:532`), into `PaneHeader.tsx:53,188,211` (`text-blue-500` on busy
   icons while `status === 'running'`).
4. Tab-level BLUE dot: `getBusyPaneIdsForTab` (`pane-activity.ts:265-311`) -> `TabBar.tsx:306-315`,
   `:371-380` (`busy={busyPaneIds.length > 0}`) -> `TabItem.tsx:20-24`
   (`<Circle ... busy && 'fill-blue-500 text-blue-500'>`), overflow `+N` blue at `TabItem.tsx:137-152`.
5. Busy badges: `TabSwitcher.tsx:107,134-135` (`bg-blue-500/15 ... text-blue-600`), `MobileTabStrip.tsx:46,102`.
6. Sidebar: `collectBusySessionKeys` (`pane-activity.ts:469-518`) -> `Sidebar.tsx:375-419` (badges/ring
   computation), `Sidebar.tsx:949` (`isBusy -> text-blue-500` icon at `:1068`) and the same per-pane
   `busySessionKeys` are stamped into tab-registry records pushed cross-device (Sidebar remote ring
   `'busy'` -> `border-blue-500`, `:999-1000, 1077`).
7. Other consumers of the same projection: `ContextMenuProvider.tsx:40,837,885`;
   `src/deck/deck-selectors.ts:7,284` (`const { isBusy } = resolvePaneActivity(...)`).

So EVERY BLUE surface collapses to `session.status` (+ `streamingActive`, + pending-approval suppression)
read fresh from `state.freshAgent.sessions` — a fold regression shows up on all surfaces at once.

## 4. Status value domain

Client session-status union (one shared union for ALL providers — no per-provider split in the slice),
`src/store/freshAgentTypes.ts:21-28`:

```ts
export type FreshAgentSessionStatus =
  | 'creating'
  | 'starting'
  | 'connected'
  | 'running'
  | 'idle'
  | 'compacting'
  | 'exited'
```

`SdkSessionStatus` (server + shared wire + pane content) adds exactly one client-only value
'create-failed': `src/store/paneTypes.ts:163`
(`'creating'|'starting'|'connected'|'running'|'idle'|'compacting'|'exited'|'create-failed'`),
mirrored in `server/sdk-bridge-types.ts:44` and `shared/ws-protocol.ts:1109`.
`FreshAgentPaneContent.status` is `SdkSessionStatus` (`paneTypes.ts:197`).

Provider-family emission domains observed server-side:
- claude/kilroy (`server/sdk-bridge.ts`): 'starting' (`:233`), 'idle' (`:437`), 'compacting' (`:494-496`).
- freshcodex (`server/fresh-agent/adapters/codex/adapter.ts`): 'exited' (`:894,945`) plus running/idle via events.
- freshopencode (`server/fresh-agent/adapters/opencode/adapter.ts:473,507`; `serve-events.ts:75,103`):
  narrowed to `'running' | 'idle'` only (both the status broadcast AND the subscribe snapshot).
- The snapshot contract itself carries `status: z.string().min(1)` — free string; any provider string
  parses and is stored.
- Client busy predicate treats busy = `'running' | 'compacting'` consistently
  (`FreshAgentView.tsx:175-177, 1982`; `pane-activity.ts:66-77`).

## 5. Existing tests + runners

### Slice-level (THE file a monotonic-fold test should live in): `test/unit/client/store/freshAgentSlice.test.ts`
- `describe('freshAgentSlice busy/streaming clearing')` (:16) — its at :24 ('setSessionStatus(idle) clears
  streamingActive so the pane does not stay blue'), :32, :39.
- `describe('freshAgentSlice')` (:46) — statusVersion semantics:
  - it 'increments statusVersion for same-valued setSessionStatus updates' (:50-58)
  - it 'increments statusVersion for snapshot status events and preserves it across identity
    materialization' (:60-99) — uses BOTH `sessionSnapshotReceived` (status 'running', :61-67) and
    `freshAgentSnapshotReceived` (status 'idle', :69-88), then `materializeSession` (:90-98).
- `describe('freshAgentSlice lost revocation on truth-bearing snapshot evidence')` (:156) — its at :172
  (`sessionSnapshotReceived`) and :177 (`freshAgentSnapshotReceived`).

### Turn-complete / waiting (the mirror regime): `test/unit/client/lib/fresh-agent-turn-complete.test.ts`
- `describe('server-authoritative fresh-agent turn completion (client)')` (:74):
  it :75 (routes event to recordTurnComplete), :87 ('dedupes a replayed/stale completion by the
  at-monotonic guard (no premature re-green)'), :101 (drops malformed non-numeric `at`), :130, :143.
- `describe('server-authoritative fresh-agent waiting edge (client)')` (:187):
  it :188 (#waiting namespace), :197 ('a waiting edge does NOT suppress a later completion edge
  (separate dedupe namespace)'), :210 (malformed drop).
- Server clock: `test/unit/server/fresh-agent/turn-complete-clock.test.ts`
  (`describe('nextMonotonicTurnCompleteAt')` :4; its :6 first-seed, :10 newer, :16 same-ms clamp+1,
  :22 backwards-clock clamp+1).

### Component-level status-adoption races: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- it 'clears stale running session state when a freshcodex REST snapshot reports idle' (:2814)
- it 'does not clear running session state ... while another pane ... has unresolved local echo' (:2872)
- it 'does not let an older idle REST response overwrite a newer same-valued running session status'
  (:2942-3013) — the statusVersion request/application-time guard in action; asserts the pane content
  became idle but `state.freshAgent.sessions[...].status` stayed 'running' (:3012)
- it 'clears stale opencode busy state from a live-reconciled idle HTTP snapshot' (:3015)
- it 'does NOT clear opencode busy state from an idle snapshot that is not live-reconciled' (:3073)
- describe 'snapshot scheduler integration (zrrj)' (:6094) incl. it 'coalesces a burst of freshopencode
  session.changed events across sibling panes into one snapshot GET' (:6148)
- it 'coalesces owned snapshot invalidations and ignores non-owner or non-snapshot events' (:4255)

### Fold-through-render e2e (jsdom, default config): `test/e2e/fresh-agent-turn-complete-notification.test.tsx`
- `describe('fresh-agent server-authoritative turn completion (e2e notification flow)')` (:147):
  it :166 'chimes once and highlights the agent tab on a server-pushed completion, and ignores replays';
  it :189 'greens + chimes exactly once when the server pushes freshAgent.turn.waiting'.
Related busy-surface e2es: `test/e2e/pane-activity-indicator-flow.test.tsx` (:263), `test/e2e/sidebar-busy-icon-flow.test.tsx` (:214),
`test/e2e/busy-indicator-color-flow.test.tsx` (:72).
Browser playwright: `test/e2e-browser/specs/turn-complete-restart-resume-rust.spec.ts` (restart-resume).

### Runner
Default config `config/vitest/vitest.config.ts` (jsdom, `test/setup/dom.ts`; includes `test/unit/client/**`
AND `test/e2e/**`; excludes `test/unit/server/**`, `test/e2e-browser/**`, etc., `:29-53`). All client tests
above run under it via `npm run test:unit` (package.json:52 = `tsx scripts/testing/test-coordinator.ts run test:unit`)
or focused via `npm run test:vitest -- run <files>`. The server clock test runs under the server config
(`config/vitest/vitest.server.config.ts`, include `test/unit/server/**`) via `npm run test:integration`/`test:server`.

## Implications for statusSeq design

1. The comparator must live in the SLICE, not the component. Today REST-snapshot status is guarded only
   in `FreshAgentView.applySnapshot` (`:1998-2014`) while EVERY WS fold (`sessionSnapshotReceived` :304,
   `setSessionStatus` :398, `freshAgentSnapshotReceived` :376) and `turnResult`/`sessionError`/`sessionExited`
   writes unconditionally at reducer level. A per-session `lastStatusSeq` on `FreshAgentSessionState`
   (next to `status`/`statusVersion` at freshAgentTypes.ts:54-55) + the comparison inside
   `writeSessionStatus` (freshAgentSlice.ts:82-85) — with an explicit escape for writers that carry no
   seq (client-synthesized 'idle' on error / optimistic transitions must decide: bypass or null-seq-always-wins) —
   covers all status frames with one gate.
2. `statusVersion` is NOT that key: it is a client-local bump counter (incremented on every fold, even
   same-value writes — test :50-58), used only for pane-local request-vs-application race detection
   (`FreshAgentView.tsx:1910, 1983`). statusSeq must be a NEW server-authored field stamped identically
   on: (a) `FreshAgentSnapshotSchema` (fresh-agent-contract.ts:247-267), (b) the WS
   `freshAgent.session.snapshot` event type (server/fresh-agent/sdk-events.ts:6-14) and its
   `SdkSessionSnapshot` adaptors (opencode serve-events.ts:75,103-106; codex adapter.ts:258), and (c) the
   `freshAgent.status` / `sdk.status` status frames (sdk-events.ts:34; sdk-bridge.ts:437,494-496).
   Schema is `.strict()` so the field must be added to the contract first, else REST fetches throw
   `FreshAgentApiContractError`.
3. Domains to compare: `statusSeq > lastSeq` strictly-newer fold; equal/older dropped (mirrors
   `recordTurnComplete`'s `at <= last` at turnCompletionSlice.ts:88).
4. Restart/instance handling must pick one of the two existing precedents and document it beside
   `nextMonotonicTurnCompleteAt` (server/fresh-agent/turn-complete-clock.ts:1-18):
   - (A) turn-complete regime: counter-free wall-clock + client `resetCompletionDedupeBaselines` on
     bootId/serverInstanceId change (App.tsx:1019-1053);
   - (B) the STATUS-STRIP `snapshotSeq` regime in sessionsSlice: namespace = `(serverInstance, bootId)`,
     "Higher seq wins within one namespace; lower seq dropped; equal → last write. A changed namespace
     (restart or instance migration) replaces unconditionally" (sessionsSlice.ts:642-651 quote at
     `applyContextUsageExtras`, fields at :164-171, response fields api.ts:592-599).
   (B) is much closer to "provider-agnostic monotonic status sequence per session" and survives
   resumed durable sessions across restarts without client-side reset hooks.
5. Test seams for the red-first investigation test: mirror `freshAgentSlice.test.ts:60-99` — seed
   `freshcodex`/`freshopencode` session via `sessionSnapshotReceived(..., status 'running', seq N)`,
   then dispatch a SECOND snapshot/WS status with seq < N → assert `sessions[key].status` unchanged
   (and via `isFreshAgentBusy`/`resolvePaneActivity` that BLUE stays on). A full client-path variant can
   mirror `FreshAgentView.test.tsx:2942-3013` (deferred REST response resolved after a newer WS status),
   and the WS-frame variant can mirror `fresh-agent-turn-complete.test.ts:87-99`'s replay-drop shape
   (handleFreshAgentMessage twice with out-of-order seqs). Regression-net check: the turn-complete e2e
   (`test/e2e/fresh-agent-turn-complete-notification.test.tsx`) must stay green under `npm run test:unit`.
6. Bonus: folding `statusSeq` into `writeSessionStatus` also fixes the waiting-suppression carve-out in
   `isFreshAgentBusy` (pane-activity.ts:67-71) race "stale busy clears after approval arrives" — but the
   work item's scope is the BLUE correctness fold only; pending-items rehydration order is out of scope.
