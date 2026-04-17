# OpenCode Busy/Finished Status Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Freshell reflect OpenCode terminal busy vs finished state reliably by using OpenCode's own localhost status API from spawn time through websocket delivery to the UI.

**Architecture:** Each OpenCode terminal must be launched with an explicit localhost control endpoint that is threaded through `providerSettings.opencodeServer`, not through a new positional `buildSpawnSpec()` parameter. `providerSettings` already flows from async callsites into `buildSpawnSpec()` and then `resolveCodingCliCommand()`, and `resolveCodingCliCommand()` is the only seam that feeds Unix, WSL, `cmd.exe`, and PowerShell launch paths. Server-side tracking should use OpenCode's documented `/global/health`, `/session/status`, and per-instance `/event` SSE stream as the authoritative busy source. Do not parse terminal output for busy or finished state, and do not add heuristic fallbacks.

**Verified upstream contract:**
- OpenCode CLI docs show `--hostname` and `--port` on the TUI entrypoint, which is what Freshell launches for `mode === 'opencode'`: <https://opencode.ai/docs/cli/>
- OpenCode server docs show:
  - `GET /global/health`
  - `GET /session/status`
  - `GET /event`
  - `GET /doc` for the OpenAPI spec
  - `GET /global/event` also exists, but it is the global wrapper stream and is not needed for one Freshell terminal talking to one OpenCode instance: <https://opencode.ai/docs/server/>
- OpenCode's generated SDK types define:
  - `SessionStatus = { type: "idle" } | { type: "retry", ... } | { type: "busy" }`
  - `EventSessionStatus = { type: "session.status", properties: { sessionID, status } }`
  - `EventSessionIdle = { type: "session.idle", properties: { sessionID } }`
  - `EventServerConnected = { type: "server.connected", ... }`
  Source: <https://raw.githubusercontent.com/anomalyco/opencode/refs/heads/dev/packages/sdk/js/src/gen/types.gen.ts>

**Implementation note:** If the launched OpenCode instance's `/doc` output disagrees with the upstream docs above, stop and update this plan plus the contract tests before proceeding.

**Tech Stack:** Node.js, Express, ws, Redux Toolkit, React 18, Vitest, Testing Library, supertest, OpenCode CLI local server endpoints.

---

## File Structure

**Create**
- `server/local-port.ts`
  Async helper that allocates an ephemeral localhost port for OpenCode launch callsites.
- `server/coding-cli/opencode-activity-tracker.ts`
  Server-side monitor that waits for health, snapshots current busy state, consumes the OpenCode SSE event stream, and emits normalized `{ upsert, remove }` changes per terminal.
- `server/coding-cli/opencode-activity-wiring.ts`
  Lifecycle glue between `TerminalRegistry` events and `OpencodeActivityTracker`.
- `src/store/opencodeActivitySlice.ts`
  Redux slice mirroring the snapshot and mutation ordering protections already used by `codexActivity`.
- `test/unit/server/coding-cli/opencode-activity-tracker.test.ts`
  Unit coverage for health wait, snapshot bootstrap, idle removal, reconnect backoff, and terminal teardown.
- `test/server/ws-opencode-activity.test.ts`
  WebSocket protocol coverage for list and update messages.
- `test/unit/client/store/opencodeActivitySlice.test.ts`
  Reducer coverage for stale snapshot ordering, upsert/remove mutation ordering, and reset behavior.

**Modify**
- `server/terminal-registry.ts`
  Extend `ProviderSettings` with `opencodeServer`, require it for OpenCode launches, inject `--hostname` and `--port` inside `resolveCodingCliCommand()`, and store the endpoint on terminal records.
- `server/ws-handler.ts`
  Allocate OpenCode control ports before `registry.create()`, merge them into `providerSettings`, serve `opencode.activity.list`, and broadcast `opencode.activity.updated`.
- `server/agent-api/router.ts`
  Allocate OpenCode control ports for `/tabs`, `/run`, split, and respawn routes before terminal creation and merge them into `providerSettings`.
- `server/index.ts`
  Construct the OpenCode tracker wiring, expose list snapshots to websocket clients, broadcast tracker mutations, and dispose the wiring on shutdown.
- `shared/ws-protocol.ts`
  Add `opencode.activity.list`, `opencode.activity.list.response`, and `opencode.activity.updated` schemas/types.
- `src/store/store.ts`
  Register the new `opencodeActivity` reducer.
- `src/App.tsx`
  Bootstrap the OpenCode activity snapshot, handle websocket deltas, and reset stale overlay state on reconnect/disconnect.
- `src/lib/pane-activity.ts`
  Treat exact-match OpenCode busy records as blue activity and include them in busy session-key collection.
- `src/components/panes/PaneContainer.tsx`
  Feed OpenCode activity into per-pane activity resolution.
- `src/components/TabBar.tsx`
  Feed OpenCode activity into busy-tab computation.
- `src/components/TabSwitcher.tsx`
  Feed OpenCode activity into mobile switcher busy badges.
- `src/components/MobileTabStrip.tsx`
  Feed OpenCode activity into the active-tab busy badge.
- `src/components/Sidebar.tsx`
  Feed OpenCode activity into busy session highlighting.
- `test/unit/server/terminal-registry.test.ts`
  Lock the OpenCode launch flags, provider-settings threading, and explicit-endpoint requirement.
- `test/server/agent-tabs-write.test.ts`
  Assert `/api/tabs` allocates and passes an OpenCode control endpoint.
- `test/server/agent-run.test.ts`
  Assert `/api/run` still works when the launched mode is `opencode`.
- `test/unit/client/components/App.ws-bootstrap.test.tsx`
  Cover OpenCode snapshot request, reset-on-ready, reset-on-disconnect, and stale snapshot ordering.
- `test/unit/client/lib/pane-activity.test.ts`
  Cover exact-match OpenCode busy semantics and busy session-key collection.
- `test/unit/client/components/panes/PaneContainer.test.tsx`
  Cover per-pane OpenCode busy resolution where pane runtime activity used to be the only source.
- `test/unit/client/components/TabBar.test.tsx`
  Cover OpenCode blue-tab behavior.
- `test/unit/client/components/TabSwitcher.test.tsx`
  Cover OpenCode busy badges in the switcher.
- `test/unit/client/components/MobileTabStrip.test.tsx`
  Cover OpenCode busy badge on the active mobile tab.
- `test/unit/client/components/Sidebar.test.tsx`
  Cover busy OpenCode session highlighting.
- `test/e2e/pane-activity-indicator-flow.test.tsx`
  Add an OpenCode pane/tab busy-indicator flow.
- `test/e2e/opencode-startup-probes.test.tsx`
  Guard against OpenCode startup regressions after adding control-port launch args.

**Explicit non-goals**
- No terminal-text parsing for busy/finished state.
- No generic multi-provider activity refactor beyond small local helpers needed to avoid repetition.
- No `docs/index.html` update unless the visible UX changes beyond the existing busy-indicator behavior.

## Architectural Guardrails

- OpenCode server state is authoritative. Use:
  - `/global/health` to know when the embedded server is reachable.
  - `/session/status` to seed the current busy snapshot.
  - `/event` to receive live per-instance transitions. Ignore the initial `server.connected` event.
- Do not use `/global/event` for this feature. It wraps events with `directory` and is unnecessary when a Freshell terminal owns exactly one OpenCode instance.
- Normalize every non-idle OpenCode session status into a single UI-facing concept: `busy`.
- Remove activity records when OpenCode reports idle, a resnapshot after reconnect no longer shows a busy session, or the terminal exits.
- Require an explicit OpenCode control endpoint at spawn time. If it is missing, throw a clear error instead of silently falling back.
- Preserve Codex behavior exactly. OpenCode is additive, not a rewrite of the Codex path.
- Use concrete retry policy:
  - health probe: poll every `200ms`, fail startup after `15_000ms`
  - SSE reconnect: exponential backoff starting at `250ms`, doubling to a `5_000ms` cap, with small jitter
  - stop retrying immediately once the terminal exits or the monitor is disposed

## Chunk 1: Server Launch And Activity Authority

### Task 1: Require And Pass An OpenCode Control Endpoint At Spawn Time

**Files:**
- Create: `server/local-port.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/agent-api/router.ts`
- Test: `test/unit/server/terminal-registry.test.ts`
- Test: `test/server/agent-tabs-write.test.ts`
- Test: `test/server/agent-run.test.ts`

- [ ] **Step 1: Write the failing launch-contract tests**

```ts
expect(buildSpawnSpec(
  'opencode',
  '/repo/app',
  'system',
  undefined,
  {
    opencodeServer: { hostname: '127.0.0.1', port: 43123 },
  },
  undefined,
  'term-oc',
).args).toEqual(expect.arrayContaining([
  '--hostname', '127.0.0.1',
  '--port', '43123',
]))

await request(app)
  .post('/api/tabs')
  .send({ mode: 'opencode', name: 'OpenCode' })

expect(registry.create).toHaveBeenCalledWith(expect.objectContaining({
  mode: 'opencode',
  providerSettings: expect.objectContaining({
    opencodeServer: {
      hostname: '127.0.0.1',
      port: expect.any(Number),
    },
  }),
}))
```

- [ ] **Step 2: Run the focused server tests and verify they fail**

Run: `npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/server/agent-tabs-write.test.ts test/server/agent-run.test.ts`

Expected: FAIL because OpenCode launch args do not include `--hostname`/`--port`, and OpenCode callsites do not pass `providerSettings.opencodeServer`.

- [ ] **Step 3: Implement the minimal launch-path changes**

```ts
export type OpencodeServerEndpoint = {
  hostname: '127.0.0.1'
  port: number
}

type ProviderSettings = {
  permissionMode?: string
  model?: string
  sandbox?: string
  opencodeServer?: OpencodeServerEndpoint
}

if (mode === 'opencode') {
  if (!providerSettings?.opencodeServer) {
    throw new Error('OpenCode launch requires an allocated localhost control endpoint.')
  }
  settingsArgs.push(
    '--hostname', providerSettings.opencodeServer.hostname,
    '--port', String(providerSettings.opencodeServer.port),
  )
}
```

Implementation notes:
- Keep `TerminalRegistry.create()` synchronous by allocating ports in async callsites before `registry.create(...)`.
- Do not add a new positional parameter to `buildSpawnSpec()`.
- Inject the OpenCode launch flags inside `resolveCodingCliCommand()`, because that command spec is what flows through Unix, WSL, `cmd.exe`, and PowerShell paths today.
- Keep the hostname pinned to the IPv4 loopback literal `'127.0.0.1'` intentionally. Do not broaden this to `localhost` or `::1` without an explicit design change, because the goal here is a private, consistent, single-stack control endpoint across all shell launch paths.
- Route callsites should merge the endpoint into existing provider settings, not replace them:

```ts
const providerSettings = await resolveProviderSettings(mode, configStore, overrides)
const finalProviderSettings = mode === 'opencode'
  ? { ...providerSettings, opencodeServer: await allocateLocalhostPort() }
  : providerSettings
```

- Update direct OpenCode test fixtures that call `registry.create({ mode: 'opencode' })` or `buildSpawnSpec('opencode', ...)` to pass a stub endpoint under `providerSettings.opencodeServer`.

- [ ] **Step 4: Run the focused server tests and verify they pass**

Run: `npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/server/agent-tabs-write.test.ts test/server/agent-run.test.ts`

Expected: PASS with OpenCode routes explicitly allocating and forwarding a control endpoint through `providerSettings`.

- [ ] **Step 5: Commit**

```bash
git add server/local-port.ts server/terminal-registry.ts server/ws-handler.ts server/agent-api/router.ts test/unit/server/terminal-registry.test.ts test/server/agent-tabs-write.test.ts test/server/agent-run.test.ts
git commit -m "feat: launch opencode with explicit control endpoint"
```

### Task 2: Track OpenCode Busy And Finished State From Its Own Server API

**Files:**
- Create: `server/coding-cli/opencode-activity-tracker.ts`
- Create: `server/coding-cli/opencode-activity-wiring.ts`
- Modify: `server/index.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Test: `test/unit/server/coding-cli/opencode-activity-tracker.test.ts`
- Test: `test/server/ws-opencode-activity.test.ts`

- [ ] **Step 1: Write the failing tracker and websocket protocol tests**

```ts
expect(changes).toContainEqual({
  upsert: [{
    terminalId: 'term-oc',
    sessionId: 'session-oc',
    phase: 'busy',
    updatedAt: expect.any(Number),
  }],
  remove: [],
})

ws.send(JSON.stringify({ type: 'opencode.activity.list', requestId: 'req-oc-1' }))
const response = await waitForMessage(ws, (msg) => (
  msg.type === 'opencode.activity.list.response' && msg.requestId === 'req-oc-1'
))
expect(response.terminals).toEqual(sampleActivity)
```

Add tracker cases for:
- health endpoint not ready yet, then becoming healthy within `15_000ms`
- startup timeout when `/global/health` never becomes healthy
- initial `/session/status` showing one busy session
- ignoring the initial `server.connected` SSE event
- `session.status` with `busy` or `retry` upserting the record
- `session.idle` or `session.status` with `idle` removing the record
- `session.idle` for a different `sessionID` not clearing the currently tracked session
- SSE disconnect followed by reconnect, backoff, resnapshot, and resubscribe
- terminal exit removing monitor state and cancelling retry timers

- [ ] **Step 2: Run the focused tracker tests and verify they fail**

Run: `npm run test:vitest -- test/unit/server/coding-cli/opencode-activity-tracker.test.ts test/server/ws-opencode-activity.test.ts`

Expected: FAIL because no OpenCode tracker, websocket message types, or broadcasts exist.

- [ ] **Step 3: Implement the tracker, wiring, and websocket contract**

```ts
type OpencodeActivityRecord = {
  terminalId: string
  sessionId?: string
  phase: 'busy'
  updatedAt: number
}

const HEALTH_POLL_MS = 200
const HEALTH_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 5_000

if (event.type === 'session.status' && event.properties.status.type !== 'idle') {
  this.upsertBusy(terminalId, event.properties.sessionID, now())
}

if (event.type === 'session.idle' || (
  event.type === 'session.status' && event.properties.status.type === 'idle'
)) {
  this.removeBusy(terminalId)
}
```

Implementation notes:
- Use one tracker monitor per OpenCode terminal record.
- Start monitoring from `terminal.created` when `record.mode === 'opencode'` and `record.providerSettings?.opencodeServer` or equivalent stored endpoint data exists.
- If current terminal records do not already retain provider settings, store only the endpoint data needed for runtime monitoring.
- Validate the OpenCode SSE payload boundary with local Zod schemas before mutating tracker state. Unknown or malformed payloads should be logged and ignored, not trusted.
- On reconnect, re-run `/session/status` before resubscribing to `/event`.
- Back off reconnect attempts with capped exponential backoff plus jitter. Do not spin in a tight loop if OpenCode exits or crashes.
- Only clear a busy record on idle if the event's `sessionID` matches the currently tracked session id, unless no session id is recorded yet.
- Add websocket types:
  - client: `opencode.activity.list`
  - server: `opencode.activity.list.response`
  - server: `opencode.activity.updated`
- Mirror the existing Codex list/broadcast path instead of inventing a second transport pattern.
- Log clear tracker failures with terminal id and endpoint, but do not invent a fallback busy detector.

- [ ] **Step 4: Run the focused tracker tests and verify they pass**

Run: `npm run test:vitest -- test/unit/server/coding-cli/opencode-activity-tracker.test.ts test/server/ws-opencode-activity.test.ts`

Expected: PASS with authenticated websocket updates, bounded reconnect behavior, and tracker removal on idle/exit.

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/opencode-activity-tracker.ts server/coding-cli/opencode-activity-wiring.ts server/index.ts shared/ws-protocol.ts server/ws-handler.ts test/unit/server/coding-cli/opencode-activity-tracker.test.ts test/server/ws-opencode-activity.test.ts
git commit -m "feat: track opencode activity from server events"
```

## Chunk 2: Client Activity Overlay And Busy Projection

### Task 3: Add A Client-Side OpenCode Activity Overlay

**Files:**
- Create: `src/store/opencodeActivitySlice.ts`
- Modify: `src/store/store.ts`
- Modify: `src/App.tsx`
- Test: `test/unit/client/store/opencodeActivitySlice.test.ts`
- Test: `test/unit/client/components/App.ws-bootstrap.test.tsx`

- [ ] **Step 1: Write the failing client-store and websocket-bootstrap tests**

```ts
store.dispatch(setOpencodeActivitySnapshot({
  terminals: [{ terminalId: 'term-oc', sessionId: 'session-oc', phase: 'busy', updatedAt: 20 }],
  requestSeq: 3,
}))
expect(store.getState().opencodeActivity.byTerminalId['term-oc']?.phase).toBe('busy')

expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
  type: 'opencode.activity.list',
}))
```

Add bootstrap cases for:
- requesting `opencode.activity.list` after `ready`
- clearing stale OpenCode activity when bootstrapping onto an already-ready socket
- clearing OpenCode activity on disconnect
- ignoring stale `opencode.activity.list.response` snapshots that arrive after newer mutations

- [ ] **Step 2: Run the focused client bootstrap tests and verify they fail**

Run: `npm run test:vitest -- test/unit/client/store/opencodeActivitySlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx`

Expected: FAIL because the store has no `opencodeActivity` slice and `App.tsx` does not request or process OpenCode activity messages.

- [ ] **Step 3: Implement the client overlay**

```ts
const opencodeActivitySlice = createSlice({
  name: 'opencodeActivity',
  initialState: createInitialState(),
  reducers: {
    setOpencodeActivitySnapshot,
    upsertOpencodeActivity,
    removeOpencodeActivity,
    resetOpencodeActivity,
  },
})

ws.send({ type: 'opencode.activity.list', requestId })

if (msg.type === 'opencode.activity.updated') {
  dispatch(upsertOpencodeActivity({ terminals: msg.upsert ?? [], mutationSeq }))
  dispatch(removeOpencodeActivity({ terminalIds: msg.remove ?? [], mutationSeq }))
}
```

Implementation notes:
- Mirror the ordering protections from `codexActivitySlice.ts` instead of sharing provider state.
- It is acceptable to extract a small local helper inside `src/App.tsx` to avoid copy-pasting the request/reset/snapshot bookkeeping for Codex and OpenCode.
- Reset OpenCode overlay state in the same places Codex resets today: on `ready`, on explicit disconnect, and when bootstrapping onto a pre-ready socket.

- [ ] **Step 4: Run the focused client bootstrap tests and verify they pass**

Run: `npm run test:vitest -- test/unit/client/store/opencodeActivitySlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx`

Expected: PASS with deterministic snapshot ordering and prompt reset behavior.

- [ ] **Step 5: Commit**

```bash
git add src/store/opencodeActivitySlice.ts src/store/store.ts src/App.tsx test/unit/client/store/opencodeActivitySlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "feat: add opencode activity client overlay"
```

### Task 4: Feed OpenCode Activity Into The Existing Busy Indicators

**Files:**
- Modify: `src/lib/pane-activity.ts`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/TabSwitcher.tsx`
- Modify: `src/components/MobileTabStrip.tsx`
- Modify: `src/components/Sidebar.tsx`
- Test: `test/unit/client/lib/pane-activity.test.ts`
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Test: `test/unit/client/components/TabBar.test.tsx`
- Test: `test/unit/client/components/TabSwitcher.test.tsx`
- Test: `test/unit/client/components/MobileTabStrip.test.tsx`
- Test: `test/unit/client/components/Sidebar.test.tsx`
- Test: `test/e2e/pane-activity-indicator-flow.test.tsx`
- Test: `test/e2e/opencode-startup-probes.test.tsx`

- [ ] **Step 1: Write the failing busy-indicator tests**

```ts
expect(resolvePaneActivity({
  paneId: 'pane-oc',
  content: {
    kind: 'terminal',
    createRequestId: 'req-oc',
    status: 'running',
    mode: 'opencode',
    shell: 'system',
    terminalId: 'term-oc',
    resumeSessionId: 'session-oc',
  },
  tabMode: 'opencode',
  isOnlyPane: true,
  codexActivityByTerminalId: {},
  opencodeActivityByTerminalId: {
    'term-oc': { terminalId: 'term-oc', sessionId: 'session-oc', phase: 'busy', updatedAt: 10 },
  },
  paneRuntimeActivityByPaneId: {},
  agentChatSessions: {},
})).toMatchObject({ isBusy: true, source: 'opencode' })
```

Add UI assertions for:
- blue pane and tab icons for a busy OpenCode pane
- busy badge in `PaneContainer`
- busy badge in `TabSwitcher`
- busy badge in `MobileTabStrip`
- blue highlight for the matching OpenCode session in `Sidebar`
- no false positives for shell or other providers
- no selector-instability warnings when `opencodeActivity` state is absent

- [ ] **Step 2: Run the focused UI tests and verify they fail**

Run: `npm run test:vitest -- test/unit/client/lib/pane-activity.test.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/Sidebar.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/opencode-startup-probes.test.tsx`

Expected: FAIL because the busy-indicator pipeline only reads Codex activity today.

- [ ] **Step 3: Implement the busy-projection changes**

```ts
type PaneActivitySource =
  | 'codex'
  | 'opencode'
  | 'claude-terminal'
  | 'agent-chat'
  | 'browser'

if (effectiveMode === 'opencode') {
  const record = input.content.terminalId
    ? input.opencodeActivityByTerminalId[input.content.terminalId]
    : undefined
  return record?.phase === 'busy'
    ? { isBusy: true, source: 'opencode' }
    : IDLE_PANE_ACTIVITY
}
```

Implementation notes:
- Keep OpenCode semantics exact-match by `terminalId`, just like Codex.
- Update all three pane-activity entry points, not just `resolvePaneActivity()`:
  - `resolvePaneActivity()`
  - `getBusyPaneIdsForTab()`
  - `collectBusySessionKeys()`
- Thread `opencodeActivityByTerminalId` into every component and selector path that already threads `codexActivityByTerminalId`.
- Use the existing blue busy styles. This is a behavior fix, not a visual redesign.
- `TerminalView.tsx` should remain unchanged unless a test proves a launch/startup regression caused by the new server flags.

- [ ] **Step 4: Run the focused UI tests and verify they pass**

Run: `npm run test:vitest -- test/unit/client/lib/pane-activity.test.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/Sidebar.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/opencode-startup-probes.test.tsx`

Expected: PASS with OpenCode busy panes/tabs/sessions turning blue only while the server reports work in progress.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pane-activity.ts src/components/panes/PaneContainer.tsx src/components/TabBar.tsx src/components/TabSwitcher.tsx src/components/MobileTabStrip.tsx src/components/Sidebar.tsx test/unit/client/lib/pane-activity.test.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/Sidebar.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/opencode-startup-probes.test.tsx
git commit -m "feat: surface opencode busy state in ui"
```

## Chunk 3: Final Verification And Handoff

### Task 5: Refactor, Verify Broadly, And Record Any Residual Risk

**Files:**
- Modify only if needed after refactor/test fallout.
- Verify: `server/*`, `src/*`, `test/*`

- [ ] **Step 1: Refactor any duplicated helper logic that the passing tests exposed**

```ts
function createActivityOverlayController(...) {
  return {
    requestList,
    reset,
    applySnapshot,
    applyMutation,
  }
}
```

Refactor only if it clearly reduces duplication between Codex and OpenCode without changing behavior.

- [ ] **Step 2: Run lint and all focused Vitest suites together**

Run: `npm run lint`

Run: `npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/server/agent-tabs-write.test.ts test/server/agent-run.test.ts test/unit/server/coding-cli/opencode-activity-tracker.test.ts test/server/ws-opencode-activity.test.ts test/unit/client/store/opencodeActivitySlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/lib/pane-activity.test.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/Sidebar.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/opencode-startup-probes.test.tsx`

Expected: PASS.

- [ ] **Step 3: Run the coordinated full suite**

Run: `npm run test:status`

Run: `FRESHELL_TEST_SUMMARY="opencode busy/finished status" npm test`

Expected: PASS across the repo-owned coordinated suite. If the coordinator is busy, wait instead of interrupting it.

- [ ] **Step 4: Inspect for any residual risk and update the implementation notes if necessary**

```md
- Residual risk: the initial `15_000ms` health timeout may need tuning on very slow hosts.
- Residual risk: if OpenCode changes its `/event` payload contract, the tracker should fail loudly in tests before it fails silently in production.
- Residual risk: localhost port allocation still uses the normal bind-to-0 then close pattern, so there is a small TOCTOU race before OpenCode binds the chosen port.
- No fallback path was added; failures should surface as clear launch or tracker errors.
```

If a real residual risk remains, document it in the final implementation summary and keep the error path explicit.

- [ ] **Step 5: Commit the final verified state**

```bash
git add server/local-port.ts server/coding-cli/opencode-activity-tracker.ts server/coding-cli/opencode-activity-wiring.ts server/terminal-registry.ts server/ws-handler.ts server/agent-api/router.ts server/index.ts shared/ws-protocol.ts src/store/opencodeActivitySlice.ts src/store/store.ts src/App.tsx src/lib/pane-activity.ts src/components/panes/PaneContainer.tsx src/components/TabBar.tsx src/components/TabSwitcher.tsx src/components/MobileTabStrip.tsx src/components/Sidebar.tsx test/unit/server/terminal-registry.test.ts test/server/agent-tabs-write.test.ts test/server/agent-run.test.ts test/unit/server/coding-cli/opencode-activity-tracker.test.ts test/server/ws-opencode-activity.test.ts test/unit/client/store/opencodeActivitySlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/lib/pane-activity.test.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/Sidebar.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/opencode-startup-probes.test.tsx
git commit -m "feat: wire opencode busy and finished status end to end"
```
