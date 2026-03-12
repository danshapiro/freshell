# Visible-First Prioritized Transport Test Plan

Date: 2026-03-09  
Source: `/home/user/code/freshell/.worktrees/trycycle-slow-network-architecture-plan/docs/plans/2026-03-09-visible-first-prioritized-transport.md`

## Strategy changes requiring user approval
No approval required.

## Strategy Reconciliation

The heavy scenario-first strategy still holds, but the implementation plan sharpens three assumptions:

1. The legacy bulk websocket architecture is not a differential oracle. The user explicitly wants it removed, and the implementation plan treats `sessions.updated`, `sdk.history`, `terminal.list`, and `terminal.meta.list` as defects to delete, not behavior to preserve.
2. Existing unit and route tests are not enough to prove the new design. The implementation plan introduces cross-lane ordering, viewport-first terminal restore, server-owned agent timelines, and visible-only hydration. Those require deterministic harnesses that can control HTTP timing, websocket timing, aborts, byte budgets, and lane ordering.
3. No paid or external infrastructure is required. The plan relies on local Express/WebSocket fixtures, fake index/search services, `@xterm/headless` plus `@xterm/addon-serialize`, and the repo’s existing Vitest/Testing Library/supertest/superwstest stack.

Named sources of truth used below:

- `USR`: the 2026-03-09 user request in the trycycle transcript.
- `ARCH`: implementation plan sections `End-State Architecture`, `Priority Rules`, and `Ownership Rules`.
- `INV`: implementation plan section `Cutover Invariants`.
- `WIRE`: implementation plan section `Wire Contracts That Must Land`.
- `BUDGET`: implementation plan section `Budgets And Invariants`.
- `HTP`: implementation plan section `Heavy Test Program`.

Differential tests are intentionally excluded. There is no trusted reference implementation for the desired behavior; the old transport is the problem being replaced.

## Harness requirements

1. `ProtocolHarness`
   What it does: starts an in-process HTTP server plus `WsHandler` with fake terminal registry, fake SDK bridge, fake session sync publisher, and programmable message capture.
   Exposes: raw websocket transcript, close code/reason inspection, helper to send `hello`, helper to inject session and terminal invalidations, helper to assert no forbidden message types were emitted.
   Estimated complexity: medium.
   Tests that depend on it: 9, 13, 15, 18, 21, 22, 24, 25.

2. `ReadModelRouteHarness`
   What it does: mounts auth middleware plus the new bootstrap/session-directory/agent-timeline/terminal-view routers against fake services and a programmable read-model scheduler.
   Exposes: authenticated/unauthenticated HTTP client, byte-size measurement, captured scheduler lane events, controllable abort signals, fake revision counters, and fake search/index data.
   Estimated complexity: high.
   Tests that depend on it: 10, 11, 12, 13, 14, 16, 19, 20, 21, 23, 26, 27, 28, 29.

3. `AppHydrationHarness`
   What it does: renders `App.tsx` and visible leaf surfaces with Testing Library, a real Redux store, gated API promises, and a programmable websocket stub whose `ready` event can be delayed independently from HTTP.
   Exposes: request-order log, render milestones, store snapshots, visible layout selection, child `ws.connect` spy detection, and per-surface fetch counters.
   Estimated complexity: high.
   Tests that depend on it: 1, 2, 3, 4, 5, 6, 7, 8, 17, 20, 23, 24, 25, 29.

4. `SlowNetworkController`
   What it does: sits under `AppHydrationHarness` and `ReadModelRouteHarness` to delay individual requests by lane (`critical`, `visible`, `background`) and delay websocket handshake independently.
   Exposes: hold/release hooks per request, elapsed-time capture, interactive-ready probe, and assertions about which work completed before other work was released.
   Estimated complexity: high.
   Tests that depend on it: 2, 4, 5, 6, 7, 8, 19, 20, 22, 23.

5. `TerminalMirrorFixture`
   What it does: feeds deterministic ANSI transcripts and alternate-screen transitions into the server-side terminal mirror and exposes viewport, scrollback, search, and `tailSeq` snapshots without a real PTY.
   Exposes: `applyOutput`, viewport serialization, scrollback page lookup, server-side search results, explicit replay-window overflow cases.
   Estimated complexity: medium.
   Tests that depend on it: 5, 6, 14, 22, 28.

6. `CliCommandHarness`
   What it does: runs CLI commands against either a stubbed `fetch` layer or the `ReadModelRouteHarness` server so command output can be asserted end to end.
   Exposes: invoked URL/method log, stdout/stderr capture, parsed JSON output, and exit code.
   Estimated complexity: low.
   Tests that depend on it: 26.

The harnesses above are the first TDD task. Without them, the highest-value scenario and integration tests cannot be written before implementation.

## Test plan

### Scenario tests

1. **Name**: Opening Freshell without a valid token shows the auth-required recovery path before protected data is consumed  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness`  
   **Preconditions**: No authenticated bootstrap data in the store. `/api/bootstrap` returns `401`. Websocket `ready` is delayed so the app cannot accidentally recover through socket state.  
   **Actions**: Render `App`; allow the initial shell bootstrap request to fail with `401`; observe whether any focused-pane hydration or websocket connect is attempted afterward.  
   **Expected outcome**: The auth-required modal renders; the app does not seed shell/bootstrap state from protected payloads; `ws.connect()` is not called after the auth failure; no focused-pane hydration request is started. Sources: `HTP` token-protected bootstrap requirement; `INV-2`; `INV-4`.  
   **Interactions**: `App.tsx` bootstrap flow, `/api/bootstrap`, auth middleware, websocket owner logic.

2. **Name**: Reloading into a terminal pane shows the current screen before websocket `ready` arrives  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController` + `TerminalMirrorFixture`  
   **Preconditions**: Active tab is a terminal pane with a persisted `terminalId`; `/api/bootstrap` succeeds; `/api/terminals/:terminalId/viewport` is available immediately after bootstrap; websocket handshake is intentionally delayed.  
   **Actions**: Render `App`; release bootstrap; keep websocket `ready` blocked; then release the focused terminal viewport response; finally release websocket `ready` and a short `sinceSeq` tail.  
   **Expected outcome**: The terminal paints the serialized viewport before websocket `ready`; the first attach uses `sinceSeq = tailSeq` from the viewport snapshot; the app does not request `/api/sessions`, `terminal.list`, or `terminal.meta.list` during this path. Sources: `USR`; `ARCH` transport split; `INV-3`; `INV-4`; `INV-9`; `INV-10`; `INV-11`; `WIRE` `TerminalViewportSnapshot`.  
   **Interactions**: `App.tsx`, `TerminalView.tsx`, `/api/bootstrap`, `/api/terminals/:terminalId/viewport`, websocket attach.

3. **Name**: Opening the sidebar fetches only the visible session window and keeps refreshes bounded to that window  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `ReadModelRouteHarness`  
   **Preconditions**: App starts in terminal view with sidebar hidden; session directory has multiple pages and revision changes available.  
   **Actions**: Open the sidebar; type a title search; request load-more; perform rename, archive, and delete actions on items in the visible window; inject `sessions.changed`.  
   **Expected outcome**: The client fetches `GET /api/session-directory` only when the sidebar becomes visible; search and load-more use returned cursor windows; rename/archive/delete trigger refetch or invalidation of only the active window; no flow calls `GET /api/sessions` or `/api/sessions/search`. Sources: `USR`; `ARCH` ownership rules 1, 2, 9, 10; `INV-12`; `INV-13`; `INV-16`; `HTP` client and legacy-cleanup bullets.  
   **Interactions**: `Sidebar.tsx`, `HistoryView.tsx`, context menu mutations, session-directory router, store thunks/selectors.

4. **Name**: Reloading an agent chat shows recent turns first and older bodies only on demand  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController` + `ReadModelRouteHarness`  
   **Preconditions**: Active pane is an agent chat session with recent turns and older collapsed turns available; websocket handshake is delayed; HTTP timeline page is available.  
   **Actions**: Render `App`; release bootstrap; release the visible timeline page while keeping websocket `ready` delayed; expand a collapsed older turn; scroll to request older pages; inject a live status update and `sdk.session.snapshot`.  
   **Expected outcome**: Recent turn summaries render before websocket `ready`; older turn bodies are fetched only when expanded or paged into view; attach/create flow uses `sdk.session.snapshot` and live events, not `sdk.history`; switching sessions aborts stale timeline/body requests. Sources: `USR`; `ARCH` transport split; `ARCH` ownership rules 4 and 8; `INV-7`; `HTP` agent-chat bullets; `WIRE` `sdk.session.snapshot`.  
   **Interactions**: `AgentChatView.tsx`, agent timeline routes, websocket SDK events, store thunk cancellation.

5. **Name**: Reconnecting to a busy terminal shows the current viewport first and only the short missed tail afterward  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController` + `TerminalMirrorFixture`  
   **Preconditions**: Terminal has a long backlog plus a short recent tail; reconnect occurs after the client cursor is behind the current `tailSeq`.  
   **Actions**: Reattach a terminal pane; release viewport snapshot immediately; keep replay tail gated; then release only the short tail frames and, in a separate run, simulate replay overflow.  
   **Expected outcome**: The current visible screen paints from HTTP before any replay frames; only the short tail is requested over websocket; the overflow case emits an explicit gap/invalidation instead of replaying the full backlog or blocking the pane. Sources: `USR`; `ARCH` transport split; `INV-11`; `BUDGET` realtime queue bound; `WIRE` `tailSeq`; `HTP` slow-network bullets.  
   **Interactions**: terminal mirror, terminal broker, `TerminalView.tsx`, `terminal-attach-seq-state`, websocket replay seam.

6. **Name**: Searching inside a terminal uses the server and does not delay terminal input  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController` + `TerminalMirrorFixture`  
   **Preconditions**: Visible terminal pane has searchable content; a background scrollback/search job can be held open; live terminal input/output is available.  
   **Actions**: Open terminal search; submit a query; keep the search request running; send terminal input and release corresponding live output before the search completes; then complete the search.  
   **Expected outcome**: Search requests go to `/api/terminals/:terminalId/search`; client-side `SearchAddon` is not required for results; terminal input/output remains responsive while search is outstanding; search can be cancelled on query change or pane switch. Sources: `USR`; `ARCH` ownership rule 5; `INV-12`; `HTP` terminal-search and background-work bullets.  
   **Interactions**: `TerminalView.tsx`, `terminal-runtime.ts`, terminal search route, live terminal stream queue.

7. **Name**: A layout with a focused terminal, visible sidebar, and offscreen tabs delivers focused data first  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController`  
   **Preconditions**: Layout contains a focused terminal pane, a visible sidebar/history surface, and at least one offscreen tab with another pane.  
   **Actions**: Render `App`; release bootstrap; hold `critical`, `visible`, and `background` requests independently; record when the focused pane becomes interactive, when sidebar data appears, and when offscreen hydration starts.  
   **Expected outcome**: Focused-pane `critical` hydration completes before visible secondary surfaces; visible secondary surfaces complete before any offscreen/background work; the app becomes interactive before background work completes. Sources: `USR`; `ARCH` priority rules 1-6; `INV-4`; `INV-5`; `BUDGET-3`; `HTP` slow-network bullets.  
   **Interactions**: `App.tsx`, layout-driven hydration thunks, session directory, terminal viewport, background shell tasks.

8. **Name**: Selecting an offscreen tab hydrates it on demand instead of paying for it at startup  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController`  
   **Preconditions**: Startup layout includes an offscreen agent chat tab and an offscreen terminal tab; both have persisted identifiers that could be hydrated.  
   **Actions**: Render `App`; complete bootstrap and focused-pane hydration; verify offscreen panes remain idle; select the offscreen agent chat tab, then the offscreen terminal tab.  
   **Expected outcome**: Offscreen panes do not prehydrate during startup; selecting a tab triggers only that pane’s timeline or viewport hydration; the earlier focused pane is not refetched unless invalidated. Sources: `USR`; `ARCH` transport split 5; `INV-5`; `BUDGET-3`.  
   **Interactions**: tab switching, layout selectors, agent timeline route, terminal viewport route.

### Integration tests

9. **Name**: WebSocket v4 rejects legacy clients and carries only realtime delta and invalidation messages  
   **Type**: integration  
   **Harness**: `ProtocolHarness`  
   **Preconditions**: Server is running with websocket protocol v4 support; one client speaks the new protocol, one speaks an older version or advertises removed capabilities.  
   **Actions**: Connect the legacy client and capture the close code; connect the v4 client, send `hello`, attach/create session and terminal subscriptions, and observe the message transcript.  
   **Expected outcome**: Protocol mismatches close with `4010` and `PROTOCOL_MISMATCH`; successful v4 transcripts include `ready`, `sessions.changed`, `terminals.changed`, `terminal.runtime.updated`, and `sdk.session.snapshot` where appropriate; they never include `sessions.updated`, `sessions.page`, `sessions.patch`, `sessions.fetch`, `sdk.history`, `terminal.list.updated`, `terminal.list.response`, `terminal.meta.list.response`, or the removed hello capability flags. Sources: `INV-1`; `INV-7`; `INV-8`; `INV-9`; `INV-17`; `WIRE`; `HTP` protocol bullet.  
   **Interactions**: `shared/ws-protocol.ts`, `server/ws-schemas.ts`, `server/ws-handler.ts`, `src/lib/ws-client.ts`.

10. **Name**: `/api/bootstrap` returns shell-only first-paint data and stays under the bootstrap budget  
   **Type**: integration  
   **Harness**: `ReadModelRouteHarness`  
   **Preconditions**: Authenticated request with realistic settings/platform data; session directory, timeline, viewport, and terminal directory data also exist in backing fakes so accidental inclusion is detectable.  
   **Actions**: Call `GET /api/bootstrap`; measure payload bytes; inspect fields present and absent.  
   **Expected outcome**: Response contains only shell-critical settings/platform/feature/auth-shell data; it excludes session-directory rows, agent timelines, terminal viewports, terminal lists, version checks, and network diagnostics; serialized payload remains below `MAX_BOOTSTRAP_PAYLOAD_BYTES`. Sources: `ARCH` transport split 1-4; `INV-2`; `INV-3`; `INV-6`; `BUDGET` bootstrap budget; `HTP` bootstrap-route bullet.  
   **Interactions**: bootstrap router, settings/platform sources, perf logging.

11. **Name**: `/api/session-directory` validates query windows and `sessions.changed` invalidates without bulk payloads  
   **Type**: integration  
   **Harness**: `ReadModelRouteHarness` + `ProtocolHarness`  
   **Preconditions**: Session directory data spans multiple cursor windows; websocket client is connected.  
   **Actions**: Request `GET /api/session-directory` with visible and background priorities, valid and invalid cursors, and a search query; then trigger a session index update.  
   **Expected outcome**: Visible/background priority values are validated; response returns cursorable windows only; invalid cursor/priority requests fail cleanly; the update emits `sessions.changed { revision }` and no bulk row payload. Sources: `ARCH` transport split 3 and 6; `ARCH` priority rules; `INV-12`; `INV-13`; `WIRE` `SessionsChangedMessage`; `HTP` session-directory bullets.  
   **Interactions**: session-directory service, scheduler lane assignment, websocket invalidation path.

12. **Name**: Session rename, archive, and delete refresh only the active directory window  
   **Type**: integration  
   **Harness**: `ReadModelRouteHarness` + `AppHydrationHarness`  
   **Preconditions**: One visible session-directory window is loaded in the client; mutation endpoints are enabled; there are additional off-window sessions that must not be reloaded.  
   **Actions**: Rename a visible session, archive another, delete a third, and inspect client requests and visible window contents after each mutation.  
   **Expected outcome**: Each mutation returns enough information to refresh or invalidate only the active query window; no flow issues `GET /api/sessions`; off-window data is not eagerly refetched. Sources: `ARCH` transport split 6; `INV-13`; `INV-16`; `HTP` client and legacy-cleanup bullets.  
   **Interactions**: session mutation routes, context menu provider, sessions thunks, sidebar/history selectors.

13. **Name**: Agent timeline routes and `sdk.session.snapshot` cooperate to hydrate chat state without replay arrays  
   **Type**: integration  
   **Harness**: `ReadModelRouteHarness` + `ProtocolHarness`  
   **Preconditions**: Agent session contains multiple turns with recent summaries and body content; client attaches to an existing session.  
   **Actions**: Call `GET /api/agent-sessions/:sessionId/timeline`; call `GET /api/agent-sessions/:sessionId/turns/:turnId`; attach to the same session over websocket.  
   **Expected outcome**: Timeline pages are recent-first and cursorable; turn bodies are returned only when requested; websocket attach/create emits `sdk.session.snapshot` plus live status events, never `sdk.history`; no server-side response depends on a full replay array. Sources: `ARCH` transport split 3 and 7; `ARCH` ownership rule 4; `INV-7`; `WIRE` `sdk.session.snapshot`; `HTP` SDK and agent-timeline bullets.  
   **Interactions**: `server/sdk-bridge.ts`, `server/session-history-loader.ts`, agent timeline router, websocket SDK handler.

14. **Name**: Terminal directory, viewport, scrollback, and search routes stay separate and priority-aware  
   **Type**: integration  
   **Harness**: `ReadModelRouteHarness` + `TerminalMirrorFixture`  
   **Preconditions**: Terminal directory data, mirrored viewport state, scrollback, and search hits are all available; scheduler event capture is enabled.  
   **Actions**: Request `GET /api/terminals`; `GET /api/terminals/:terminalId/viewport`; `GET /api/terminals/:terminalId/scrollback`; and `GET /api/terminals/:terminalId/search` under focused, visible, and background conditions.  
   **Expected outcome**: Directory windows, viewport snapshots, scrollback pages, and search results are returned by separate routes; viewport responses include runtime metadata and `tailSeq`; scheduler marks viewport as `critical`, visible directory/search as `visible`, and background scrollback/search as `background`; search is server-side only. Sources: `ARCH` transport split 3 and 7; `ARCH` priority rules; `ARCH` ownership rules 5-7; `INV-9`; `INV-10`; `INV-12`; `WIRE` `TerminalViewportSnapshot`; `HTP` terminal-route bullets.  
   **Interactions**: terminal view service, scheduler, mirror, terminal router, runtime metadata feed.

15. **Name**: Terminal mutations and runtime changes refresh visible chrome through revisions and targeted deltas  
   **Type**: integration  
   **Harness**: `ProtocolHarness` + `ReadModelRouteHarness` + `AppHydrationHarness`  
   **Preconditions**: Client has a visible terminal pane and a visible terminal directory window loaded.  
   **Actions**: Create, patch, delete, and exit terminals; update title/cwd/status for an already visible terminal; capture websocket and client store effects.  
   **Expected outcome**: Directory-affecting mutations emit `terminals.changed { revision }`; already visible terminal chrome updates through `terminal.runtime.updated`; no flow emits `terminal.list.updated` or requires a global metadata snapshot. Sources: `ARCH` transport split 7; `ARCH` ownership rules 6-7; `INV-8`; `INV-10`; `INV-14`; `WIRE` `TerminalsChangedMessage`; `WIRE` `TerminalRuntimeUpdatedMessage`; `HTP` terminal-client bullets.  
   **Interactions**: terminal router, websocket handler, terminal meta cache, visible pane header, sidebar/overview/background surfaces.

16. **Name**: The read-model scheduler runs `critical`, `visible`, and `background` work in the right order and honors aborts  
   **Type**: integration  
   **Harness**: `ReadModelRouteHarness`  
   **Preconditions**: Scheduler is instrumented with queued and running counters; multiple lane jobs can be held and released manually.  
   **Actions**: Queue background jobs first, then visible jobs, then critical jobs; abort queued and running requests from the owning HTTP request; capture scheduler snapshots throughout.  
   **Expected outcome**: Critical work jumps ahead of queued visible/background work; visible work jumps ahead of queued background work; background concurrency is capped; abort cancels queued work and terminates request-bound work cleanly; scheduler snapshots expose queued and running counts per lane. Sources: `ARCH` priority rules 1-6; `HTP` scheduler bullets.  
   **Interactions**: scheduler, request abort helper, all read-model routes that share lane semantics.

17. **Name**: `App.tsx` is the sole websocket owner and leaf surfaces fetch only through store-owned intents  
   **Type**: integration  
   **Harness**: `AppHydrationHarness`  
   **Preconditions**: Rendered app includes sidebar, overview, background terminal surfaces, session view, terminal view, and agent chat surfaces in combinations that previously called `ws.connect()` or built direct transport URLs.  
   **Actions**: Mount the app; open each visible surface; trigger reconnect and invalidation paths; record all direct `ws.connect()` callers and direct route construction from leaf components.  
   **Expected outcome**: Only `App.tsx` calls `ws.connect()`; child components and thunks do not own websocket setup; leaf components dispatch store intents rather than building `/api/terminals` or equivalent URLs inline; visible surfaces still render correctly. Sources: `ARCH` ownership rules 8-10; `INV-18`; `HTP` app-bootstrap and terminal-directory bullets.  
   **Interactions**: `App.tsx`, leaf components, Redux thunks, websocket client singleton.

### Invariant tests

18. **Name**: No runtime path still emits or consumes legacy bulk websocket and snapshot contracts  
   **Type**: invariant  
   **Harness**: `ProtocolHarness` + `AppHydrationHarness`  
   **Preconditions**: App boot, session browsing, terminal restore, agent attach, and reconnect flows are all exercised at least once.  
   **Actions**: Capture the full websocket transcript and the client message handling log across those flows.  
   **Expected outcome**: No runtime path emits or consumes `sessions.updated`, `sessions.page`, `sessions.patch`, `sessions.fetch`, `sdk.history`, `terminal.list`, `terminal.list.response`, `terminal.list.updated`, `terminal.meta.list`, or `terminal.meta.list.response`; hello capabilities do not advertise `sessionsPatchV1` or `sessionsPaginationV1`. Sources: `INV-7`; `INV-8`; `INV-9`; `INV-17`; `HTP` legacy-cleanup bullet.  
   **Interactions**: websocket schemas, client message handler, app bootstrap, terminal directory flow, agent attach flow.

19. **Name**: Payload budgets and queue bounds are enforced and logged at the transport seam  
   **Type**: invariant  
   **Harness**: `ReadModelRouteHarness` + `ProtocolHarness` + `SlowNetworkController`  
   **Preconditions**: Perf logging is enabled; large but legal test fixtures are available; oversize fixtures can also be injected.  
   **Actions**: Request bootstrap, session-directory, agent timeline, viewport, scrollback, and search payloads at boundary sizes; enqueue realtime frames near the websocket budget and beyond it.  
   **Expected outcome**: Bootstrap remains under `MAX_BOOTSTRAP_PAYLOAD_BYTES`; realtime frames respect `MAX_REALTIME_MESSAGE_BYTES`; page/item budgets are enforced; overflow produces gaps or invalidations rather than unbounded buffering; perf logs record payload bytes, durations, lane, queue depth, and dropped bytes. Sources: `BUDGET`; `INV-15`; `HTP` realtime, instrumentation, and slow-network bullets.  
   **Interactions**: perf logger, scheduler, client output queue, websocket handler, read-model routers.

20. **Name**: Background fetches stay abortable and never delay focused paint or live terminal traffic  
   **Type**: invariant  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController`  
   **Preconditions**: Focused terminal pane is visible; sidebar/history and background scrollback/search work are queued simultaneously.  
   **Actions**: Hold background tasks; send terminal input and focused-pane requests; switch panes or change search query to abort the background work.  
   **Expected outcome**: Focused-pane paint and live terminal output complete while background work is still pending; aborted background tasks do not later mutate visible state; terminal input/output latency remains within the harness budget. Sources: `USR`; `ARCH` priority rules 4-6; `BUDGET-2`; `BUDGET-3`; `HTP` slow-network bullets.  
   **Interactions**: scheduler, abort signals, live terminal stream, client thunk cancellation.

### Boundary and edge-case tests

21. **Name**: Invalid auth, cursor, priority, search, and viewport inputs fail cleanly without partial state  
   **Type**: boundary  
   **Harness**: `ReadModelRouteHarness` + `ProtocolHarness`  
   **Preconditions**: Routes are mounted with auth and validation; client store starts empty.  
   **Actions**: Submit invalid auth tokens, malformed cursors, unsupported priorities, malformed search queries, and malformed viewport dimensions; also connect a websocket client with the wrong protocol version.  
   **Expected outcome**: HTTP returns clear `4xx` errors without partial state mutation; websocket closes mismatched clients with `4010`; no invalid request leaks rows, timelines, viewport text, or unstable revisions into the client. Sources: `INV-1`; `ARCH` transport split validation expectations; `HTP` protocol and route bullets.  
   **Interactions**: auth middleware, zod schemas, route validation, websocket handshake.

22. **Name**: Replay overflow and stale `sinceSeq` produce explicit gaps instead of duplicate or unbounded replay  
   **Type**: boundary  
   **Harness**: `TerminalMirrorFixture` + `ProtocolHarness`  
   **Preconditions**: Terminal replay ring contains a short tail and the client cursor is far behind or overlaps partially.  
   **Actions**: Attach with stale `sinceSeq`; attach with overlapping `sinceSeq`; overflow the recovering queue while live output is still arriving.  
   **Expected outcome**: The client receives only the recoverable tail; unrecoverable ranges produce explicit gap signals or visible invalidation; live frames are preserved ahead of recovering frames; duplicate overlapping frames are not rendered twice. Sources: `INV-11`; `BUDGET-2`; `WIRE` `tailSeq`; `HTP` realtime queue and terminal restore bullets.  
   **Interactions**: replay ring, client output queue, broker, `terminal-attach-seq-state`, websocket attach path.

23. **Name**: Delayed websocket `ready`, delayed `/api/version`, and delayed network diagnostics do not block first paint  
   **Type**: boundary  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController`  
   **Preconditions**: Bootstrap and focused-pane routes are available; websocket handshake, version check, and network status calls can each be delayed independently.  
   **Actions**: Delay `ready`, `/api/version`, and network diagnostics; release bootstrap and focused-pane HTTP; then release the delayed background tasks.  
   **Expected outcome**: Shell bootstrap and focused-pane paint complete before websocket `ready`; version and network diagnostics remain background work; releasing them later does not replace or block the already-visible pane. Sources: `ARCH` transport split 2-4; `INV-4`; `INV-6`; `HTP` app-bootstrap and slow-network bullets.  
   **Interactions**: `App.tsx`, background shell requests, websocket readiness, connection slice.

### Regression tests

24. **Name**: Split-pane remount and session-loss recovery do not rely on `sdk.history` replay fallbacks  
   **Type**: regression  
   **Harness**: `AppHydrationHarness` + `ProtocolHarness`  
   **Preconditions**: Agent chat pane is split, remounted, and later reattached after session loss or reconnect.  
   **Actions**: Mount two panes pointing at the same or related agent session; force remount and reconnect; emit `sdk.session.snapshot`, live status events, and a session-lost error.  
   **Expected outcome**: Recovery works from snapshot plus HTTP timeline/body fetches; session loss still triggers prompt recovery; no test or runtime path waits for `sdk.history`. Sources: `HTP` client bullet about split-pane attach recovery; `INV-7`; `USR`.  
   **Interactions**: `AgentChatView.tsx`, `sdk-message-handler`, agent chat slice, pane persistence/remount behavior.

25. **Name**: Pane-header runtime metadata no longer depends on a global terminal-meta snapshot  
   **Type**: regression  
   **Harness**: `AppHydrationHarness` + `ProtocolHarness` + `ReadModelRouteHarness`  
   **Preconditions**: Visible terminal pane header requires title/status/cwd/pid metadata; no global `terminal.meta.list` route is available.  
   **Actions**: Hydrate a visible terminal viewport; then emit `terminal.runtime.updated` for that terminal; separately mutate a hidden terminal.  
   **Expected outcome**: Visible pane chrome is seeded from the viewport response and updated from targeted runtime deltas; hidden terminals do not force a global metadata fetch; no flow requests `terminal.meta.list`. Sources: `ARCH` transport split 7; `INV-9`; `INV-10`; `WIRE` `TerminalViewportSnapshot.runtime`; `WIRE` `TerminalRuntimeUpdatedMessage`; `HTP` pane-header metadata bullets.  
   **Interactions**: viewport route, terminal meta slice/cache, pane header rendering, websocket runtime delta feed.

26. **Name**: CLI list and search commands use the server-owned directory/search family and keep user-visible output stable  
   **Type**: regression  
   **Harness**: `CliCommandHarness` + `ReadModelRouteHarness`  
   **Preconditions**: Session directory and search fixtures include multiple providers, projects, and titles; legacy `/api/sessions` and `/api/sessions/search` are unavailable.  
   **Actions**: Run `list-sessions` and `search-sessions` from the CLI; capture invoked URLs and stdout/stderr.  
   **Expected outcome**: Commands call the new session-directory/search contract family instead of legacy snapshot routes; output still exposes the project/session information users expect; command exits successfully without compatibility shims. Sources: `INV-16`; `HTP` CLI bullets; `USR` desire for server-side search.  
   **Interactions**: `server/cli/index.ts`, CLI HTTP client, session-directory/search routers, command output formatting.

### Unit tests

27. **Name**: Session-directory query service returns canonical order, bounded snippets, joined running metadata, and deterministic cursor rejection  
   **Type**: unit  
   **Harness**: `ReadModelRouteHarness` service fixture  
   **Preconditions**: Session project fixtures include ties on timestamp, running terminal metadata, title/full-text hits, and malformed cursors.  
   **Actions**: Call the session-directory query service directly with multiple queries and cursors.  
   **Expected outcome**: Results are canonically ordered server-side; snippets are bounded; running terminal metadata is joined into visible items; invalid cursors are rejected deterministically rather than producing partial windows. Sources: `ARCH` ownership rules 1-3; `INV-12`; `HTP` session-directory service bullet.  
   **Interactions**: session search primitive, query shaping layer, cursor codec.

28. **Name**: Server turn normalization and terminal mirror produce deterministic visible-first read models  
   **Type**: unit  
   **Harness**: `TerminalMirrorFixture` + agent-turn normalization fixture  
   **Preconditions**: Mixed live and resumed SDK events plus ANSI-heavy terminal transcripts, including alternate-screen transitions, are available.  
   **Actions**: Normalize resumed and live agent events into turn records; serialize viewport snapshots and short-tail recovery anchors from the terminal mirror.  
   **Expected outcome**: Agent sessions normalize into recent-first turn records without replay arrays; viewport snapshots are deterministic for the same transcript; `tailSeq` advances consistently; alternate-screen output stays correct. Sources: `ARCH` ownership rules 4-5; `INV-11`; `WIRE` `TerminalViewportSnapshot`; `HTP` SDK normalization and terminal mirror bullets.  
   **Interactions**: `server/sdk-bridge.ts`, `server/session-history-loader.ts`, terminal mirror, terminal registry.

29. **Name**: Client read-model API helpers target the new routes and propagate `AbortSignal`  
   **Type**: unit  
   **Harness**: `AppHydrationHarness` fetch stub  
   **Preconditions**: Typed API helper module is loaded with mocked `fetch`.  
   **Actions**: Call `getBootstrap`, session-directory, terminal-directory, timeline, turn-body, viewport, scrollback, and terminal-search helpers with and without `AbortSignal`.  
   **Expected outcome**: Helpers call the new route set, not legacy snapshot routes; each helper forwards `AbortSignal`; cursor and revision parameters are encoded consistently for visible-window refetch behavior. Sources: `ARCH` transport split 1-3; `INV-16`; `HTP` shared-contract bullet.  
   **Interactions**: `src/lib/api.ts`, shared read-model contracts, client thunk cancellation.

## Coverage summary

### Covered action space

- Shell bootstrap, auth gating, websocket ownership, and first-paint ordering.
- Visible session browsing, server-side search, cursor paging, and bounded mutation refresh.
- Agent chat attach/reload, recent-turn-first timeline hydration, turn-body on-demand loading, and session-loss recovery.
- Terminal directory browsing, viewport-first restore, short-tail replay, server-side search, scrollback, and runtime metadata refresh.
- Scheduler lane ordering, abort propagation, realtime queue bounds, payload budgets, and perf instrumentation.
- CLI list/search flows that previously depended on legacy session snapshot routes.
- Deletion guards for the legacy websocket/session snapshot architecture.

### Explicit exclusions

- Production WAN measurement and canary deployment are not part of this test plan. The plan uses deterministic local slow-network harnesses as the gating signal before implementation. Risk: medium. Real-world latency distributions can still expose tuning issues after local tests pass.
- Differential comparison against the legacy bulk websocket architecture is excluded. Risk: low. The legacy behavior is explicitly the defect source, and treating it as authoritative would block the cutover.
- Real CLI binary execution is excluded from gating tests; fixtures and mocked provider/index data stand in for the providers. Risk: low to medium. Provider-specific parsing bugs can still surface if fixtures do not cover a new upstream event shape.

### Residual risks if exclusions remain

- Lane fairness under truly noisy production traffic may still need post-implementation tuning even if the deterministic scheduler tests pass.
- Search relevance quality is only as strong as the fixture corpus. The plan verifies server ownership, bounded payloads, and response shape, not subjective ranking quality beyond canonical ordering.
- The terminal mirror tests catch deterministic serialization and replay behavior, but browser rendering quirks outside the serialized xterm surface still rely on existing component tests to stay covered.
