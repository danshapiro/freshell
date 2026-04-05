# FreshClaude Restore Audit Test Plan

> Superseded on April 3, 2026 by `2026-04-03-freshclaude-robust-restore-redesign-test-plan.md`. Use the April 3 redesign test plan as the authoritative restore direction because it removes split ownership and fallback-style restore semantics.

The transcript does not add a separate testing strategy beyond "comprehensive audit and fix." Reconciled against the implementation plan, that still holds: the change surface is the existing FreshClaude restore flow over WebSocket snapshots, HTTP timeline reads, persisted pane/tab state, and indexed Claude metadata. No external services, paid APIs, or new infrastructure are required. The only adjustment is emphasis: because the implementation centralizes restore truth in a shared server history source, the plan must be led by rendered reload/create/attach scenarios and only use unit tests to pin merge and store contracts underneath them.

Root-cause note:

- The restore bug class here is not "JSONL reads commonly throw and need a handler fallback." Ordinary durable-history lookup failures already collapse to empty/missing results in the loader layer.
- The real failure was architectural drift: `WsHandler` still fabricated a local live-only snapshot when the shared history resolver rejected, so two layers appeared to own restore degradation.
- Tests and reviews should therefore enforce the corrected split:
  - `AgentHistorySource` owns recoverable durable/live degradation.
  - `WsHandler` translates unexpected resolver rejection into `sdk.error` and does not invent replacement history.

## Harness requirements

No new harnesses need to be built. The existing harnesses already cover the required surfaces.

- `component-scenario-rtl`: React Testing Library with the real Redux reducers, reactive pane wrappers, mocked WS client, and mocked HTTP helpers. Exposes rendered DOM, store dispatch, pane-content inspection, and captured outbound WS/API calls. Estimated complexity: existing. Depends: tests 1, 3, 4, 5.
- `rendered-app-e2e`: RTL rendering of `App`, `TabBar`, and `PaneContainer` with store state plus mocked WS/API bootstrapping. Exposes visible header/activity UI and tab/pane chrome. Estimated complexity: existing. Depends: tests 6, 7.
- `server-ws-integration`: real `WsHandler` on an in-process HTTP/WebSocket server with mocked `SdkBridge` and injected history dependencies. Exposes browser-visible outbound WS message ordering and payloads. Estimated complexity: existing. Depends: test 8.
- `server-route-integration`: Express router plus `supertest` for `/api/agent-sessions/...` requests. Exposes HTTP status, JSON payload, and route-to-service parameter pass-through. Estimated complexity: existing. Depends: test 9.
- `server-unit-di`: direct Vitest coverage of merge/service/bridge helpers with injected durable and live history sources. Exposes deterministic function return values plus logged divergence hooks. Estimated complexity: existing. Depends: tests 10, 12.
- `client-store-unit`: direct Vitest coverage of `api.ts`, reducers, thunks, and the SDK message handler. Exposes serialized request URLs, reducer state, and thunk side effects. Estimated complexity: existing. Depends: test 11.

## Test plan

1. **Name:** Reloading a persisted FreshClaude pane restores the newest turn and in-progress reply without a blank "Running..." gap
   - **Type:** scenario
   - **Disposition:** new
   - **Harness:** `component-scenario-rtl`
   - **Preconditions:** A persisted FreshClaude pane exists with a live SDK `sessionId`; Redux has not loaded history yet; the server emits `sdk.session.snapshot` with `latestTurnId`, canonical `timelineSessionId`, `revision`, `status: running`, `streamingActive: true`, and partial `streamingText`; the first visible timeline page returns inline bodies for the newest turn.
   - **Actions:** Mount `AgentChatView`; simulate the attach-path snapshot; allow the first visible timeline window load to complete; inspect rendered output and captured API calls.
   - **Expected outcome:** Per the implementation plan's `Restore Contract` ("the first visible restore page must arrive with bodies inline," "mid-stream reconnects must restore enough state to show work in progress") and the README FreshClaude promise of "full session persistence," the component fetches `/api/agent-sessions/<timelineSessionId>/timeline` with `priority=visible&includeBodies=true`, renders the newest restored turn body from that first page, does not immediately call `getAgentTurnBody` for the same newest turn, shows the partial assistant text while running, and clears the restoring placeholder once the page lands.
   - **Interactions:** `sdk.session.snapshot` handling, `agentChatThunks`, `api.ts`, `agentChatSlice`, streaming render path, pane restore gating.

2. **Name:** Resuming a FreshClaude create restores the durable backlog plus the post-resume live delta under one canonical history
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** `component-scenario-rtl`
   - **Preconditions:** A new pane starts with `resumeSessionId`; `sdk.create` returns a live SDK session id; the server snapshot reveals a canonical durable `timelineSessionId`; the shared history source resolves durable backlog plus post-resume delta; the first visible page includes inline bodies.
   - **Actions:** Mount a resumed-create pane; let it send `sdk.create`; feed `sdk.created` and `sdk.session.snapshot`; complete the first visible timeline fetch.
   - **Expected outcome:** Per the `Restore Contract` ("a resumed FreshClaude session has two distinct history sources," "do not choose between durable and live history by message count alone") the user-visible history contains both the durable backlog and the post-resume live messages in order, the first visible fetch uses the canonical durable id once known, and the newest restored turn is not refetched separately when its body was inline.
   - **Interactions:** create-path WS flow, shared history source, timeline service, thunk/store hydration, visible restore UI.

3. **Name:** A lost restored session recovers using the durable Claude id learned from snapshot even if `sdk.session.init` never arrived
   - **Type:** regression
   - **Disposition:** extend
   - **Harness:** `component-scenario-rtl`
   - **Preconditions:** A persisted pane has a stale SDK `sessionId` and a non-canonical or missing persisted `resumeSessionId`; Redux receives `sdk.session.snapshot` carrying a canonical `timelineSessionId`; `markSessionLost` fires before `sdk.session.init`.
   - **Actions:** Mount the pane; dispatch the snapshot; immediately dispatch the lost-session action; observe pane-content replacement and outbound `sdk.create`.
   - **Expected outcome:** Per the `Restore Contract` ("once a snapshot revealed the durable Claude ID, a later lost-session recovery must be able to re-create the session with that durable ID even if `sdk.session.init` never happened"), the pane clears the dead SDK id, preserves the canonical durable id into recovery state, and sends the replacement `sdk.create` with that durable id rather than the stale named resume or stale SDK id.
   - **Interactions:** lost-session reducer path, recovery effect ordering, pane-content persistence, `sdk.create` request construction.

4. **Name:** Splitting or remounting a FreshClaude pane keeps the first visible restore complete and still lazy-loads older collapsed turns on expansion
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** `component-scenario-rtl`
   - **Preconditions:** A connected FreshClaude pane is remounted after a split/tree restructure; snapshot state says backlog exists; the first visible page returns the newest turn inline and older turns as collapsed summaries.
   - **Actions:** Unmount and remount the same pane; let restore hydration run; then click the "Expand turn" control for an older collapsed turn.
   - **Expected outcome:** Per the `Restore Contract` ("the first visible restore page must arrive with bodies inline" and "the client may still fetch older collapsed turns on demand"), the remounted pane immediately shows the newest turn body from the first page, requests `includeBodies=true` on the first visible fetch, and only calls `getAgentTurnBody` when the user expands an older collapsed turn.
   - **Interactions:** remount attach path, timeline fetch gating, collapsed-turn UI, on-demand turn-body endpoint.

5. **Name:** Hidden restored panes defer history hydration until they become visible
   - **Type:** boundary
   - **Disposition:** extend
   - **Harness:** `component-scenario-rtl`
   - **Preconditions:** A persisted pane has a live or snapshot-backed restore state, but it is mounted hidden or inactive.
   - **Actions:** Mount the pane hidden; verify attach/status ownership behavior; then rerender or activate it so it becomes the visible pane.
   - **Expected outcome:** Per the `Restore Contract` ("Hidden panes should remain cheap: attach for ownership/status, but defer the visible-history fetch until visible"), no timeline HTTP request is issued while hidden, and the first visible transition triggers exactly one visible-priority timeline fetch with inline bodies.
   - **Interactions:** hidden-pane gating, attach ownership path, visibility-driven thunk dispatch.

6. **Name:** FreshClaude pane headers resolve runtime metadata from the canonical durable timeline id during restore gaps
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** `rendered-app-e2e`
   - **Preconditions:** Indexed Claude session metadata exists for the durable Claude id; Redux FreshClaude session has `timelineSessionId` but not yet `cliSessionId`; pane content has no `resumeSessionId` or a stale one.
   - **Actions:** Render the real app shell with the restored pane and indexed sessions; inspect the pane header and tab label metadata before any later `sdk.session.init`.
   - **Expected outcome:** Per the `Restore Contract` ("when `timelineSessionId` exists, every FreshClaude restore consumer that needs the durable Claude identity must prefer it") and the README "Live pane headers" feature promise, the header shows the correct directory/branch/token usage for the canonical durable session and does not regress to stale metadata keyed by an old `resumeSessionId`.
   - **Interactions:** `PaneContainer`, indexed session lookup, tab fallback metadata, pane header rendering.

7. **Name:** FreshClaude activity indicators restore from the canonical durable timeline id and still distinguish waiting from active work
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** `rendered-app-e2e`
   - **Preconditions:** A restored FreshClaude pane is running; Redux session carries `timelineSessionId` and no `cliSessionId`; pane content has no `resumeSessionId`; the session transitions from waiting on permission/question to active running work.
   - **Actions:** Render the pane and tab chrome; inspect icon color while a permission request is pending; clear the waiting item and inspect the icon again.
   - **Expected outcome:** Per the `Restore Contract` canonical-id preference and the README "Activity notifications" feature promise, the pane and tab indicators remain non-blue while waiting for user input, turn blue when actual work is running, and source the busy-session key from the canonical durable id rather than the missing/stale fallback ids.
   - **Interactions:** `pane-activity.ts`, `PaneContainer`, turn-completion chrome, session-key derivation.

8. **Name:** WebSocket restore snapshots are authoritative for create and attach across live, durable-only, and named-resume cases
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** `server-ws-integration`
   - **Preconditions:** `WsHandler` runs on a real in-process WebSocket server with injected `SdkBridge` and shared history source; cases include fresh create, resumed create, live attach, durable-only attach after restart, and named resume targets that are not valid Claude UUIDs.
   - **Actions:** Send `sdk.create` and `sdk.attach` messages for each case; capture outbound WS messages in order.
   - **Expected outcome:** Per the `Restore Contract` ("`timelineSessionId` is optional and never an SDK session id," "named resume targets stay live-only until Claude reveals the durable UUID," "`sdk.attach` with stale SDK ids still errors"), the handler emits `sdk.created -> sdk.session.snapshot -> sdk.session.init` in order for create, emits `sdk.session.snapshot` plus `sdk.status` for attach, populates `timelineSessionId`, `revision`, and stream snapshot fields only when justified, queries restore history by live SDK id for named resumes, returns `INVALID_SESSION_ID` for stale unresolvable SDK ids, and emits `sdk.error` rather than fabricating a local snapshot if the shared resolver itself rejects unexpectedly.
   - **Interactions:** `WsHandler`, `SdkBridge`, shared history source, WebSocket protocol contract, resolver-owned degradation boundary.

9. **Name:** The timeline HTTP route and service preserve canonical session identity and inline-body pass-through
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** `server-route-integration`
   - **Preconditions:** The router is mounted with the timeline service; the service resolves history through the shared history source and may return a canonical durable `timelineSessionId`.
   - **Actions:** Request `/api/agent-sessions/:sessionId/timeline?priority=visible&includeBodies=true`; request `/api/agent-sessions/:sessionId/turns/:turnId`.
   - **Expected outcome:** Per `shared/read-models.ts` and the `Restore Contract`, the router passes `includeBodies=true` through unchanged, the page response uses the canonical durable session id for `page.sessionId`, item `sessionId`, and inline-body `sessionId`, and turn-body reads resolve against the same canonical history rather than the original query id when a durable id is known.
   - **Interactions:** Express query parsing, scheduler lane selection, timeline service page/body generation.

10. **Name:** Canonical history resolution never drops or invents turns when durable and live histories diverge
    - **Type:** invariant
    - **Disposition:** new
    - **Harness:** `server-unit-di`
    - **Preconditions:** The history source receives combinations of durable backlog only, fresh live full transcript, resumed live delta, overlapping durable/live tails, ambiguous repeated prompts with distinct timestamps, and named resume strings that are not valid Claude UUIDs.
    - **Actions:** Resolve history for each case via the shared history source; inspect merged messages, resolved ids, revision, and divergence logging hooks.
    - **Expected outcome:** Per the `Restore Contract` bullets on resumed delta semantics, conservative overlap removal, named-resume handling, and divergence logging, the resolver appends live delta onto durable backlog for resumed sessions, prefers the fuller non-conflicting transcript for fresh sessions, keeps ambiguous repeated prompts when timestamp evidence says they are distinct turns, never sets `timelineSessionId` to an SDK id or named resume string, degrades to live-only only inside the resolver when durable load fails but a live session still exists, and otherwise lets unexpected failure propagate for boundary translation instead of hiding it as alternate history.
    - **Interactions:** durable JSONL loader seam, live session lookup by SDK and durable id, divergence logger.

11. **Name:** The client store and API contract request inline bodies once, keep canonical ids, and avoid redundant newest-turn fetches
    - **Type:** unit
    - **Disposition:** extend
    - **Harness:** `client-store-unit`
    - **Preconditions:** The timeline API helper, reducer, thunk, and SDK message handler are exercised with a first visible page containing inline bodies plus a snapshot carrying `timelineSessionId`, `revision`, `streamingActive`, and `streamingText`.
    - **Actions:** Serialize `getAgentTimelinePage` with `includeBodies`; dispatch `sessionSnapshotReceived`; dispatch `loadAgentTimelineWindow`; inspect resulting store state and mocked API calls.
    - **Expected outcome:** Per `shared/read-models.ts` and the `Restore Contract`, the first visible request serializes `includeBodies=true`, the thunk dispatches inline bodies into replace-mode state, stale replace-mode bodies are cleared while append-mode bodies are preserved, `timelineSessionId` and `timelineRevision` are stored unchanged, and the newest-turn `getAgentTurnBody` call is skipped when the first page already carried that body.
    - **Interactions:** query serialization, Redux reducers, thunk controller cancellation, SDK message forwarding.

### Streaming-State Decision Note

This audit previously drifted on the meaning of `streamingActive`. The adjudicated contract for all tests and reviews is:

- `streamingActive` means new text deltas are actively arriving.
- `status === 'running'` means the turn is still in progress.
- After `content_block_stop`, the correct state is `streamingActive = false` with the accumulated `streamingText` still preserved until `assistant` or `result`.

Reasoning:

- Restore correctness requires the partial assistant preview to remain visible through reconnects and reloads.
- Semantic correctness requires quiet post-stop gaps to stop counting as active streaming.
- Reviewer guidance should therefore reject only implementations that lose the preview text or collapse to a blank running state, not implementations that mark streaming inactive after `content_block_stop`.

12. **Name:** The SDK bridge preserves reconnect-restorable stream state and durable-id lookups for later attach snapshots
    - **Type:** unit
    - **Disposition:** extend
    - **Harness:** `server-unit-di`
    - **Preconditions:** A live SDK session receives `stream_event` messages that open, extend, and end a text stream; a durable Claude id becomes known through `cliSessionId` or `resumeSessionId`.
    - **Actions:** Drive `SdkBridge` through streamed events; inspect in-memory session state and any lookup helper used by restore.
    - **Expected outcome:** Per the `Restore Contract` requirement that mid-stream reconnects must show work in progress, the bridge preserves accumulated `streamingText` in session state until a terminal assistant/result message closes the stream, while `content_block_stop` ends active streaming by setting `streamingActive = false`; it can also locate the live session by the durable Claude id so later attach snapshots can restore from canonical identity rather than only the transient SDK id.
    - **Interactions:** SDK stream consumption, in-memory session bookkeeping, attach-time history lookup support.

## Coverage summary

- Covered action space:
  Reloaded-pane `sdk.attach`; resumed-pane `sdk.create`; `sdk.session.snapshot` ingestion; `sdk.status` and `INVALID_SESSION_ID` recovery; first visible `/api/agent-sessions/:sessionId/timeline` fetch with `includeBodies=true`; `/api/agent-sessions/:sessionId/turns/:turnId` expansion fetch; hidden-to-visible restore transition; pane split/remount; tab/pane runtime metadata rendering; activity indicator derivation; server merge of durable JSONL plus live SDK history.
- Explicitly excluded:
  Real Anthropic SDK subprocesses, real Claude JSONL files on disk, and browser-playwright network reconnects are not required for this plan because the repo already has high-fidelity in-process WS/RTL/supertest harnesses for the touched surface.
- Exclusion risks:
  Real-process timing or filesystem races beyond the mocked/in-process harnesses could still exist, especially around true WebSocket reconnect timing and Claude JSONL flush latency, but those are outside this implementation plan's stated scope. If regressions appear there later, the next step should be a dedicated browser or end-to-end process harness, not more low-level unit coverage.
