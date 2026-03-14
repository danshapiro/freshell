# Fix SDK Resume History Hydration Lane 1 Test Plan

Source: `/home/user/code/freshell/.worktrees/codex-fix-sdk-resume-history/docs/plans/2026-03-14-fix-sdk-resume-history-hydration-test-plan.md`

Strategy reconciliation: no changes are required. The implementation plan matches the approved strategy: the fix remains client-owned, the observable contracts are the `sdk.created` / `sdk.session.snapshot` / `sdk.session.init` websocket messages plus the agent timeline HTTP routes, no paid or external services are required, and the repo's existing jsdom, reducer, thunk, pane, and websocket harnesses are sufficient. The only refinement is emphasis: the concrete tests must verify that timeline hydration targets `resumeSessionId` until `sdk.session.init` provides the durable CLI identity, because that is the public seam where the reviewed regression becomes visible.

## Harness requirements

No new harnesses need to be built for this lane. Reuse the existing harnesses below.

### Existing harnesses to reuse

1. **AgentChat reactive jsdom flow harness**
   - **What it does:** Renders `AgentChatView` with a real Redux store, a reactive pane wrapper backed by `panesSlice`, mocked websocket transport, mocked timeline API calls, and the real `src/lib/sdk-message-handler.ts` dispatch path.
   - **What it exposes:** Visible chat UI assertions, outbound `sdk.create` / `sdk.attach` / `sdk.kill` capture, real `handleSdkMessage()` delivery, and store-state inspection after pane updates.
   - **Estimated complexity to build:** None; reuse the patterns already present in `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`, `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`, and `test/e2e/agent-chat-polish-flow.test.tsx`.
   - **Tests that depend on it:** 1, 2, 3.

2. **AgentChat thunk harness**
   - **What it does:** Dispatches `loadAgentTimelineWindow` and `loadAgentTurnBody` against a real `agentChat` reducer with mocked `getAgentTimelinePage()` and `getAgentTurnBody()` implementations.
   - **What it exposes:** Requested session IDs, turn IDs, reducer state after hydration, and cancellation-safe async dispatch behavior.
   - **Estimated complexity to build:** None; reuse `test/unit/client/store/agentChatThunks.test.ts`.
   - **Tests that depend on it:** 4.

3. **Pane close cleanup harness**
   - **What it does:** Renders `PaneContainer` with a real store, mocked websocket client, and preloaded `agentChat` / `panes` state so close-button behavior can be observed end to end.
   - **What it exposes:** Pane close interactions, outbound `sdk.kill`, `pendingCreates` cleanup, and orphaned session removal from Redux.
   - **Estimated complexity to build:** None; reuse `test/unit/client/components/panes/PaneContainer.test.tsx`.
   - **Tests that depend on it:** 5, 6.

4. **Authenticated WS handler harness**
   - **What it does:** Starts an in-process HTTP server with `WsHandler`, authenticates a real websocket client, and records server messages for a single `sdk.create` flow.
   - **What it exposes:** Ordered websocket transcripts, mocked `sdkBridge.createSession()`, mocked `loadSessionHistory()`, and exact server message ordering assertions.
   - **Estimated complexity to build:** None; reuse `test/unit/server/ws-handler-sdk.test.ts`.
   - **Tests that depend on it:** 7.

5. **Reducer contract harness**
   - **What it does:** Exercises `agentChatReducer` directly with pure action sequences.
   - **What it exposes:** Pending-create state transitions, `historyLoaded` gating, and safe fallback behavior for unexpected `sdk.created`.
   - **Estimated complexity to build:** None; reuse `test/unit/client/agentChatSlice.test.ts`.
   - **Tests that depend on it:** 8.

### Named sources of truth

- **UTR:** The trycycle transcript goal for this lane: resumed SDK-created FreshClaude sessions must not skip durable history hydration.
- **PLAN-S1:** Implementation plan section `S1 Fresh create contract`: a brand-new SDK session must not show `Restoring session...` after `sdk.created`.
- **PLAN-S2:** Implementation plan section `S2 Resumed create contract`: a resumed SDK session stays in restore mode until the first timeline page lands or `sdk.session.snapshot.latestTurnId === null` proves there is no durable backlog.
- **PLAN-S3:** Implementation plan section `S3 Timeline identity contract`: before `sdk.session.init` arrives, timeline hydration must still target the supplied `resumeSessionId`.
- **PLAN-S4:** Implementation plan section `S4 Pending-create cleanup contract`: closing a pane before pane content mirrors `sessionId` must still kill the SDK session and clear orphaned Redux state.
- **PLAN-S5:** Implementation plan section `S5 Server contract relied on by this lane`: resumed `sdk.create` sends `sdk.created`, then `sdk.session.snapshot`, then preliminary `sdk.session.init`.
- **TASK1-FB:** Implementation plan Task 1, Step 3: unexpected `sdk.created` with no registered pending request must keep the current fresh-create fallback behavior.
- **API-TL:** The public agent timeline read-model contract in `shared/read-models.ts`, `server/agent-timeline/router.ts`, and `server/agent-timeline/service.ts`: `/api/agent-sessions/:sessionId/timeline` returns recent-first windows for a session ID and `/api/agent-sessions/:sessionId/turns/:turnId` hydrates a specific turn body on demand.
- **WIRE-SDK:** The public websocket protocol messages in `shared/ws-protocol.ts`: `sdk.created`, `sdk.session.snapshot`, `sdk.session.init`, and `sdk.killed` are the observable server-to-client contracts for SDK session lifecycle.

## Test plan

1. **Name:** Resuming a FreshClaude pane hydrates durable history before restore mode clears
   - **Type:** scenario
   - **Harness:** AgentChat reactive jsdom flow harness
   - **Preconditions:** A pane layout exists with `kind: 'agent-chat'`, `provider: 'freshclaude'`, `createRequestId: 'req-resume'`, `status: 'creating'`, and `resumeSessionId: 'cli-session-1'`; the timeline route is stubbed to return a recent-first page containing `turn-2` plus a matching turn body; no SDK session exists in Redux yet.
   - **Actions:**
     1. Render the reactive pane wrapper so `AgentChatView` sends the real `sdk.create`.
     2. Verify the outbound websocket message contains `type: 'sdk.create'`, `requestId: 'req-resume'`, and `resumeSessionId: 'cli-session-1'`.
     3. In a single `act()` block, deliver `sdk.created` and `sdk.session.snapshot { latestTurnId: 'turn-2', status: 'idle' }` through `handleSdkMessage()`.
     4. Wait for the first timeline page and newest-turn body to hydrate.
   - **Expected outcome:**
     - After the resumed create is acknowledged but before the timeline page lands, the pane shows `Restoring session...` instead of behaving like a fresh empty session. `[UTR, PLAN-S2]`
     - The first timeline page request and newest-turn body request target `cli-session-1`, because `resumeSessionId` remains the durable identity until `sdk.session.init` arrives. `[PLAN-S3, API-TL]`
     - The durable historical message becomes visible and the restoring indicator disappears only after the timeline page has landed. `[UTR, PLAN-S2, API-TL]`
   - **Interactions:** `AgentChatView`, `sdk-message-handler`, `agentChatSlice`, `panesSlice`, `loadAgentTimelineWindow`, `loadAgentTurnBody`, and the agent timeline HTTP route family.

2. **Name:** Creating a brand-new FreshClaude session never flashes restore mode
   - **Type:** scenario
   - **Harness:** AgentChat reactive jsdom flow harness
   - **Preconditions:** A pane layout exists with `kind: 'agent-chat'`, `provider: 'freshclaude'`, `createRequestId: 'req-fresh'`, and `status: 'creating'`; no `resumeSessionId` is present.
   - **Actions:**
     1. Render the pane and capture the outbound `sdk.create`.
     2. Deliver `sdk.created { requestId: 'req-fresh', sessionId: 'sdk-fresh-1' }` through `handleSdkMessage()`.
   - **Expected outcome:**
     - The outbound create request omits `resumeSessionId`, confirming the pane is on the fresh-create path rather than a resume path. `[PLAN-S1, PLAN-S3]`
     - After `sdk.created`, the pane does not render `Restoring session...`; the fresh-create UX remains in effect. `[PLAN-S1]`
   - **Interactions:** `AgentChatView` create effect, pending-create intent registration, websocket create acknowledgement, and reducer-to-view restore gating.

3. **Name:** Resuming a session with no durable backlog skips the timeline fetch and exits restore mode immediately
   - **Type:** scenario
   - **Harness:** AgentChat reactive jsdom flow harness
   - **Preconditions:** A pane layout exists with `resumeSessionId: 'cli-empty-1'`; mocked timeline and turn-body functions are present so unexpected calls can be detected; no SDK session exists yet.
   - **Actions:**
     1. Render the pane so it sends `sdk.create`.
     2. Deliver `sdk.created { requestId: 'req-empty', sessionId: 'sdk-empty-1' }`.
     3. Deliver `sdk.session.snapshot { sessionId: 'sdk-empty-1', latestTurnId: null, status: 'idle' }`.
     4. Flush pending microtasks.
   - **Expected outcome:**
     - Restore mode clears as soon as `latestTurnId: null` proves there is no durable backlog to hydrate. `[PLAN-S2]`
     - No timeline-page or turn-body request is issued for the empty resumed session, avoiding an unnecessary visible fetch on the no-history path. `[PLAN-S2, API-TL]`
   - **Interactions:** `sessionSnapshotReceived`, `AgentChatView` restore gating, and the client API layer for agent timeline requests.

4. **Name:** Timeline hydration keeps using the persisted resume session ID until sdk.session.init provides the CLI session ID
   - **Type:** integration
   - **Harness:** AgentChat thunk harness
   - **Preconditions:** The store has an SDK session entry `sdk-sess-1` with `latestTurnId: 'turn-7'`; the visible pane still only knows `resumeSessionId: 'cli-session-1'`; `getAgentTimelinePage()` and `getAgentTurnBody()` are mocked and observable.
   - **Actions:**
     1. Dispatch `loadAgentTimelineWindow({ sessionId: 'sdk-sess-1', timelineSessionId: 'cli-session-1', requestKey: 'tab-1:pane-1' })`.
     2. Wait for the newest-turn body hydration to complete.
   - **Expected outcome:**
     - The timeline page request targets `cli-session-1`, not `sdk-sess-1`. `[PLAN-S3, API-TL]`
     - The newest-turn body request also targets `cli-session-1`, preserving the same durable identity across both HTTP calls. `[PLAN-S3, API-TL]`
     - The visible SDK session is hydrated with the returned summaries and newest body, so the resumed pane receives the durable history it resumed. `[UTR, PLAN-S3, API-TL]`
   - **Interactions:** `agentChatThunks`, API client request building, reducer hydration, and the agent timeline route family.

5. **Name:** Closing a pane after sdk.created but before pane content mirrors sessionId kills the orphaned SDK session and clears local state
   - **Type:** integration
   - **Harness:** Pane close cleanup harness
   - **Preconditions:** `PaneContainer` renders an `agent-chat` leaf with `createRequestId: 'req-close-1'`, no `content.sessionId`, a pending-create record for that request whose `sessionId` is `sdk-sess-1`, and a matching `agentChat.sessions['sdk-sess-1']` entry.
   - **Actions:**
     1. Click the pane close button.
     2. Inspect outbound websocket messages and the resulting Redux state.
   - **Expected outcome:**
     - The close flow sends `sdk.kill { sessionId: 'sdk-sess-1' }`, so the server-owned SDK session is not left running after the pane is gone. `[PLAN-S4, WIRE-SDK]`
     - The pending-create entry for `req-close-1` is removed and the orphaned local session state is deleted, so closed panes cannot later revive stale restore state. `[PLAN-S4]`
   - **Interactions:** `PaneContainer`, websocket client, `agentChatSlice`, and tab/pane close orchestration.

6. **Name:** Closing a pane before sdk.created still kills the late orphan instead of recreating chat state
   - **Type:** regression
   - **Harness:** Pane close cleanup harness
   - **Preconditions:** `PaneContainer` renders an `agent-chat` pane with a `createRequestId` but no `sessionId` and no pending-created SDK session yet; a websocket sink is available for late server messages.
   - **Actions:**
     1. Close the pane before any `sdk.created` message arrives.
     2. Afterwards, deliver `sdk.created { requestId: 'req-late', sessionId: 'sdk-late-1' }` through `handleSdkMessage()` with the websocket sink attached.
   - **Expected outcome:**
     - The late `sdk.created` is translated into `sdk.kill { sessionId: 'sdk-late-1' }` rather than creating a new visible chat session. `[PLAN-S4, WIRE-SDK]`
     - No revived session appears in client state for the already-closed pane. `[PLAN-S4]`
   - **Interactions:** `PaneContainer`, `cancelCreate()`, `sdk-message-handler`, websocket sink, and reducer session creation.

7. **Name:** A resumed sdk.create emits created, snapshot, then init so the client can gate restore correctly
   - **Type:** regression
   - **Harness:** Authenticated WS handler harness
   - **Preconditions:** An authenticated websocket client is connected; `sdkBridge.createSession()` returns `sessionId: 'sdk-sess-1'`; `loadSessionHistory('00000000-0000-4000-8000-000000000241')` returns two durable messages.
   - **Actions:**
     1. Send `sdk.create { requestId: 'req-resume', resumeSessionId: '00000000-0000-4000-8000-000000000241' }`.
     2. Collect the first three lifecycle messages returned by the server.
   - **Expected outcome:**
     - The lifecycle ordering is `sdk.created`, then `sdk.session.snapshot`, then `sdk.session.init`. `[PLAN-S5, WIRE-SDK]`
     - The snapshot reports a non-null `latestTurnId` for the resumed session and the server does not emit `sdk.history`. `[UTR, PLAN-S5]`
   - **Interactions:** `WsHandler`, SDK bridge session creation, durable history loading, and websocket protocol serialization.

8. **Name:** Pending create intent keeps fresh creates loaded, resumed creates restoring, and unexpected creates safe by default
   - **Type:** unit
   - **Harness:** Reducer contract harness
   - **Preconditions:** The reducer starts from its empty initial state.
   - **Actions:**
     1. Register a fresh pending create and dispatch `sessionCreated`.
     2. Register a resumed pending create and dispatch `sessionCreated`.
     3. For the resumed session, dispatch `sessionSnapshotReceived` with `latestTurnId: null`.
     4. Dispatch an unexpected `sessionCreated` with no registered pending create.
   - **Expected outcome:**
     - Fresh creates are marked history-loaded immediately. `[PLAN-S1]`
     - Resumed creates remain not-yet-loaded until durable history is either fetched or explicitly proven empty by `latestTurnId: null`. `[PLAN-S2]`
     - Unexpected `sdk.created` messages without registered intent fall back to the fresh-create behavior instead of trapping the UI in restore mode. `[TASK1-FB]`
   - **Interactions:** `agentChatSlice` reducer state machine only.

## Coverage summary

- **Covered action space:**
  - Creating a FreshClaude session from a brand-new pane.
  - Creating a FreshClaude session that resumes a persisted CLI session.
  - Delivering `sdk.created`, `sdk.session.snapshot`, and `sdk.session.init` through the real message flow.
  - Hydrating the first visible timeline page and newest turn body for a resumed session.
  - Resolving the empty-backlog resume path without unnecessary HTTP work.
  - Closing panes before and after `sdk.created`, including late orphan cleanup.
  - Characterizing the resumed-create websocket ordering the client depends on.

- **Explicit exclusions from the agreed strategy:**
  - No real Claude Code subprocess or paid API run.
    - **Why excluded:** The plan fixes a client/server contract bug using existing mocked websocket and HTTP seams; the agreed strategy does not require live external infrastructure.
    - **Risk carried by exclusion:** CLI-specific timing outside the documented websocket and timeline contracts could still differ in production, but the reviewed regression itself lives at the public contract boundary covered above.
  - No differential test against an older implementation.
    - **Why excluded:** The previous behavior is the defect being fixed, not a trusted oracle.
    - **Risk carried by exclusion:** None material for this lane; the highest-value verification is scenario coverage against the intended contracts.
  - No separate performance benchmark.
    - **Why excluded:** This lane has low performance risk; the only meaningful performance-sensitive behavior is avoiding an unnecessary timeline fetch when `latestTurnId === null`, and Test 3 covers that directly.
    - **Risk carried by exclusion:** Broader timing regressions are not benchmarked, but a catastrophic extra-fetch regression on the changed path will still fail the scenario coverage.
  - No standalone agent-timeline router pagination test in this lane.
    - **Why excluded:** Existing route tests already cover route-family correctness; this lane's unique risk is that the client uses the wrong session identity or exits restore mode too early.
    - **Risk carried by exclusion:** A router pagination bug unrelated to resume identity would rely on the pre-existing route tests rather than this lane's new coverage.

- **Differential coverage:** None planned. The lane has no trusted reference implementation beyond the user-visible contracts and the public websocket and HTTP interfaces named above.
