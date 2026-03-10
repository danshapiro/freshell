# Visible-First Prioritized Transport Completion Test Plan

Date: 2026-03-10  
Source: `/home/user/code/freshell/.worktrees/codex-visible-first-transport-v2/docs/plans/2026-03-10-visible-first-prioritized-transport-completion.md`

## Strategy changes requiring user approval
No approval required.

## Strategy reconciliation

The accepted scenario-first strategy still holds, and the user-approved scope does not need to widen. Four execution-shape adjustments are required after reconciling the old transport test strategy, the completion plan, the existing performance-audit plan, and the current codebase:

1. The shared visible-first harnesses are mandatory first work, not optional test scaffolding. The completion plan depends on them, and the current worktree still lacks `test/helpers/visible-first/**` entirely while many existing tests still encode legacy websocket-first behavior.
2. The existing performance audit pipeline is in scope for this test plan. It already exists under `test/e2e-browser/perf/**`, but its scenario allowlists, route normalization, and expected websocket types still describe the legacy `/api/sessions`, `/api/sessions/search`, `sdk.history`, `terminal.list`, and `terminal.meta.list` transport. The completion plan and machine gate require those audit surfaces to be updated with the product cutover.
3. Differential testing stays limited to trusted audit artifacts and the audit compare/gate tools. The legacy bulk websocket transport is not a behavioral oracle because the spec and machine gate explicitly require deleting it.
4. Several route/store modules named in the completion plan do not exist yet in the worktree, and the current transport side effects are still spread across `App.tsx` and leaf components. The tests therefore need to target the planned route families and user-visible contracts directly rather than coupling themselves to the current file layout.

No paid APIs, external infrastructure, or production deployment are required for the approved strategy. The local `Vitest` + `Testing Library` + `supertest`/`superwstest` stack, the existing `Playwright`/Chromium audit runner, `TestServer`, structured server JSONL logs, and the planned shared harnesses are sufficient.

Named sources of truth used below:

- `USR`: the trycycle transcript, especially the requirements to not narrow the work, to keep `mobile_restricted` as the landing decision rule, and to keep one repeatable machine-readable audit artifact.
- `SPEC`: `docs/plans/2026-03-09-visible-first-prioritized-transport.md`, especially `Strategy Gate`, `End-State Architecture`, `Priority Rules`, `Ownership Rules`, `Cutover Invariants`, and `Heavy Test Program`.
- `COMP`: `docs/plans/2026-03-10-visible-first-prioritized-transport-completion.md`, especially `Strategy Gate`, `Machine Gate`, `Execution Rules`, and `Final Verification Checklist`.
- `WIRE`: `docs/plans/2026-03-10-visible-first-prioritized-transport-completion.md`, section `Wire Contracts That Must Land`.
- `BUDGET`: `docs/plans/2026-03-10-visible-first-prioritized-transport-completion.md`, section `Budgets And Invariants`.
- `AUDIT`: `docs/plans/2026-03-10-visible-first-performance-audit.md` and `docs/plans/2026-03-10-visible-first-performance-audit-test-plan.md`, especially `Fixed Audit Matrix`, `Artifact Contract`, `Failure Policy`, and the accepted profile/scenario list.
- `HARNESS`: `docs/plans/2026-03-10-visible-first-prioritized-transport-completion.md`, `Task 1` and `Task 2`.

## Harness requirements

1. `ProtocolHarness`
   What it does: starts the real websocket handler against fake session, SDK, and terminal publishers and captures the raw transcript end to end.
   Exposes: authenticated and mismatched `hello` helpers, raw websocket transcript capture, close code/reason inspection, targeted invalidation injection, and assertions that forbidden legacy message types never appeared.
   Estimated complexity: medium.
   Tests that depend on it: 11, 14, 15, 17, 23, 27, 28.

2. `ReadModelRouteHarness`
   What it does: mounts auth plus the shell-bootstrap, session-directory, agent-timeline, and terminal-view route families against fake services and a programmable read-model scheduler.
   Exposes: authenticated/unauthenticated HTTP client, response-byte measurement, scheduler lane event capture, controllable abort signals, revision counters, and deterministic fake data for directory/timeline/viewport queries.
   Estimated complexity: high.
   Tests that depend on it: 12, 13, 14, 15, 16, 17, 18, 19, 26, 27.

3. `AppHydrationHarness`
   What it does: renders `App.tsx` with a real Redux store, seeded persisted layout state, gated HTTP promises, and a programmable websocket stub whose `ready` can be delayed independently from HTTP.
   Exposes: request-order log, visible-surface render milestones, store snapshots, seeded active/offscreen tab layouts, per-surface fetch counters, and `ws.connect()` caller tracking.
   Estimated complexity: high.
   Tests that depend on it: 1, 2, 3, 4, 5, 6, 7, 8, 9, 23, 24, 25, 28, 29, 30.

4. `SlowNetworkController`
   What it does: holds and releases `critical`, `visible`, and `background` requests independently and delays websocket `ready` independently from HTTP so startup ordering stays testable under the accepted slow profile.
   Exposes: lane hold/release hooks, request timestamps, focused-ready timing probes, and assertions that background work stayed behind focused work.
   Estimated complexity: high.
   Tests that depend on it: 2, 3, 6, 7, 8, 16, 18, 24, 25, 26, 29.

5. `TerminalMirrorFixture`
   What it does: feeds deterministic ANSI output into the server-side terminal mirror and exposes viewport serialization, scrollback windows, search results, `tailSeq`, and replay-overflow cases without a real PTY.
   Exposes: `applyOutput`, viewport snapshots, search and scrollback queries, deterministic runtime metadata, replay-window overflow, and gap cases.
   Estimated complexity: medium.
   Tests that depend on it: 2, 6, 7, 16, 26, 28, 34.

6. `CliCommandHarness`
   What it does: runs CLI commands against either a stubbed `fetch` layer or the in-process route harness so CLI behavior can be asserted end to end without a real external server.
   Exposes: invoked URL/method log, stdout/stderr capture, parsed JSON output, and exit code.
   Estimated complexity: low.
   Tests that depend on it: 10, 19, 31.

7. `VisibleFirstAuditHarness`
   What it does: reuses and tightens the existing audit runner, smoke path, compare helper, and gate helper so the performance characterization remains the landing oracle after the transport cutover.
   Exposes: reduced/full matrix execution, artifact schema parsing, route/type allowlist definitions, compare output, and gate result JSON.
   Estimated complexity: medium to update, low to reuse.
   Tests that depend on it: 20, 21, 22, 35.

The new shared harnesses above are the first TDD task. The existing audit harness is not greenfield, but it must be updated in the same test program because the current artifact contract still encodes legacy transport assumptions.

## Test plan

### Scenario tests

1. **Name**: Opening Freshell without a token stops at the auth-required shell bootstrap state before protected data or websocket hydration begins  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness`  
   **Preconditions**: No authenticated token is present; the shell bootstrap route returns `401`; websocket `ready` is held so the app cannot recover through a socket side path.  
   **Actions**: Render `App`; release the initial bootstrap request with `401`; observe whether any focused-pane hydration, sidebar hydration, or websocket connect occurs afterward.  
   **Expected outcome**: The auth-required UI becomes the focused surface; protected read-model routes are not requested; `ws.connect()` is not called after bootstrap auth failure; no focused-pane hydration request starts. Sources: `USR`; `SPEC`; `COMP`; `AUDIT`.  
   **Interactions**: `App.tsx`, auth middleware, `/api/bootstrap`, websocket ownership.

2. **Name**: Reloading into a focused terminal paints the current viewport before websocket `ready` and then attaches from `tailSeq`  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController` + `TerminalMirrorFixture`  
   **Preconditions**: The persisted active pane is a terminal with a stable `terminalId`; `/api/bootstrap` succeeds; `/api/terminals/:terminalId/viewport` is available; websocket `ready` and replay tail are both delayed.  
   **Actions**: Render `App`; release `/api/bootstrap`; keep websocket `ready` blocked; release the focused terminal viewport; then release websocket `ready` and the short tail.  
   **Expected outcome**: The terminal paints from the HTTP viewport before websocket `ready`; the attach uses `sinceSeq = tailSeq`; the startup path does not request `/api/session-directory`, `terminal.list`, `terminal.meta.list`, or any global terminal snapshot. Sources: `USR`; `SPEC`; `WIRE`; `COMP`; `BUDGET`.  
   **Interactions**: `App.tsx`, `TerminalView.tsx`, terminal viewport route, websocket attach/replay seam.

3. **Name**: Reloading into a focused agent chat shows recent turns first and loads older turn bodies only on demand  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController`  
   **Preconditions**: The persisted active pane is an agent-chat session with recent turn summaries and older collapsed turns available; websocket `ready` is delayed; timeline and turn-body routes are available.  
   **Actions**: Render `App`; release `/api/bootstrap`; release the visible timeline page while holding websocket `ready`; expand an older turn and request an older page; switch sessions once to force request cancellation.  
   **Expected outcome**: Recent turn summaries render before websocket `ready`; older turn bodies are fetched only when expanded or paged into view; session switches abort stale timeline/body requests; no path waits for or consumes `sdk.history`. Sources: `USR`; `SPEC`; `WIRE`; `COMP`.  
   **Interactions**: `App.tsx`, `AgentChatView.tsx`, `/api/agent-sessions/:sessionId/timeline`, `/api/agent-sessions/:sessionId/turns/:turnId`, websocket SDK events.

4. **Name**: Opening the sidebar and searching sessions fetches only the visible session window and query window the user asked for  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness`  
   **Preconditions**: App starts on a terminal tab with the sidebar hidden; the session corpus spans multiple cursor windows; sidebar search query is initially empty.  
   **Actions**: Open the sidebar; type a search query; request load-more; clear the query; reopen the sidebar after hiding it.  
   **Expected outcome**: Session-directory fetches begin only when the sidebar becomes visible; search and load-more operate on the window/cursor contract of `/api/session-directory`; hiding the sidebar stops further visible-window refreshes; no path calls `/api/sessions`, `/api/sessions/search`, or `/api/sessions/query`. Sources: `USR`; `SPEC`; `COMP`; `AUDIT`.  
   **Interactions**: `Sidebar.tsx`, `HistoryView.tsx`, session-directory thunks/selectors, session-directory routes.

5. **Name**: Renaming, archiving, and deleting a visible session refreshes only the active window and keeps the user’s selection stable  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness`  
   **Preconditions**: A visible session-directory window is loaded; one session is selected or open; session mutation routes succeed.  
   **Actions**: Rename one visible session, archive another, and delete a third from the UI; observe follow-up fetches and the selected item.  
   **Expected outcome**: Each mutation triggers only the active window’s refetch/invalidation context; the visible selection stays on the expected remaining item or open pane; no mutation flow triggers a full `/api/sessions` reload. Sources: `SPEC`; `COMP`.  
   **Interactions**: `ContextMenuProvider.tsx`, sidebar/history surfaces, session mutation routes, store invalidation flow.

6. **Name**: Reconnecting to a busy terminal shows the current screen first and then only the short missed tail or an explicit gap  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController` + `TerminalMirrorFixture`  
   **Preconditions**: A terminal has a long backlog and a short recent tail; the client reconnects with an older cursor; a replay-overflow case is also available.  
   **Actions**: Reattach to the terminal; release the viewport immediately; hold replay frames; then release the short tail; repeat with a stale cursor that overflows the replay window.  
   **Expected outcome**: The current visible screen paints from the viewport route before replay frames; only the recoverable short tail is applied after attach; overflow produces a visible gap/invalidation path instead of replaying the full backlog or blocking the pane. Sources: `USR`; `SPEC`; `WIRE`; `BUDGET`; `COMP`.  
   **Interactions**: terminal mirror, replay ring, client output queue, `TerminalView.tsx`, websocket replay seam.

7. **Name**: Searching inside a terminal uses the server-owned search route and does not delay terminal input/output  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController` + `TerminalMirrorFixture`  
   **Preconditions**: A terminal pane is visible with searchable content; a terminal search request can be kept pending while live output continues.  
   **Actions**: Open terminal search; submit a query; keep the search request pending; send terminal input and release live output; then complete or cancel the search.  
   **Expected outcome**: Search requests go to `/api/terminals/:terminalId/search`; live terminal input/output remains responsive while search is pending; changing the query or switching panes cancels stale search work; client-side `SearchAddon` is not required for the user-visible search result path. Sources: `SPEC`; `COMP`; `BUDGET`.  
   **Interactions**: `TerminalView.tsx`, terminal search UI, terminal search route, live terminal stream.

8. **Name**: Startup with a focused terminal, a visible sidebar, and an offscreen heavy tab delivers focused work first and leaves offscreen work idle  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController`  
   **Preconditions**: The persisted layout contains a focused terminal pane, a visible sidebar/history surface, and an offscreen heavy agent-chat tab.  
   **Actions**: Render `App`; release `/api/bootstrap`; independently release `critical`, `visible`, and `background` requests; record when the focused pane becomes usable, when sidebar data appears, and when offscreen work starts.  
   **Expected outcome**: Focused-pane `critical` work completes before visible sidebar/history work; visible work completes before any offscreen hydration; the app becomes usable before background work finishes; offscreen work stays at zero until selection or explicit idle-time policy. Sources: `USR`; `SPEC`; `BUDGET`; `COMP`.  
   **Interactions**: `App.tsx`, focused-pane hydration, session-directory window fetches, tab visibility logic.

9. **Name**: Selecting an offscreen heavy tab hydrates only that tab on demand instead of paying for it during startup  
   **Type**: scenario  
   **Harness**: `AppHydrationHarness`  
   **Preconditions**: Startup layout seeds one lightweight active tab and one heavy offscreen tab; the heavy tab has enough chat/terminal data that eager hydration would be visible in the request log.  
   **Actions**: Render the app; let startup complete; select the heavy background tab; then switch back.  
   **Expected outcome**: No offscreen pane hydration occurs before selection; selecting the heavy tab triggers only that pane’s HTTP read-model hydration; switching back does not refetch the previously focused pane unless invalidated. Sources: `USR`; `SPEC`; `COMP`; `AUDIT`.  
   **Interactions**: tab selection state, `TabContent.tsx`, agent timeline or terminal viewport routes.

10. **Name**: Running `list-sessions` and `search-sessions` still returns useful user-facing results while using the new session-directory contract  
   **Type**: scenario  
   **Harness**: `CliCommandHarness` + `ReadModelRouteHarness`  
   **Preconditions**: The in-process server exposes the visible-first session-directory route family with deterministic data; CLI output is captured.  
   **Actions**: Run `list-sessions`; run `search-sessions alpha`; inspect the invoked HTTP paths and the command output.  
   **Expected outcome**: The CLI prints the directory/search results users expect; it uses the session-directory contract family rather than `/api/sessions` or `/api/sessions/search`; failures stay machine-readable through exit code and stderr. Sources: `SPEC`; `COMP`.  
   **Interactions**: `server/cli/index.ts`, HTTP client, session-directory routes.

### Integration tests

11. **Name**: WebSocket v4 rejects mismatched clients and carries only realtime deltas, invalidations, and control messages  
   **Type**: integration  
   **Harness**: `ProtocolHarness`  
   **Preconditions**: One client speaks the accepted websocket protocol version and one speaks an older or mismatched version.  
   **Actions**: Connect the mismatched client and capture the close; connect the accepted client, send `hello`, attach/create terminal and SDK flows, and record the transcript.  
   **Expected outcome**: Mismatched clients close with `4010` and `PROTOCOL_MISMATCH`; successful transcripts carry the surviving v4 messages and omit `sessions.updated`, `sessions.page`, `sessions.patch`, `sessions.fetch`, `sdk.history`, `terminal.list`, `terminal.list.response`, `terminal.list.updated`, `terminal.meta.list`, `terminal.meta.list.response`, `sessionsPatchV1`, and `sessionsPaginationV1`. Sources: `SPEC`; `COMP`; `WIRE`.  
   **Interactions**: `shared/ws-protocol.ts`, server websocket schemas/handler, client websocket client.

12. **Name**: `/api/bootstrap` returns only shell-critical startup state, enforces auth, and stays under the bootstrap budget  
   **Type**: integration  
   **Harness**: `ReadModelRouteHarness`  
   **Preconditions**: Authenticated and unauthenticated requests are available; fake backing data exists for session-directory, timeline, terminal directory, viewport, version, and network status so accidental inclusion is detectable.  
   **Actions**: Call `GET /api/bootstrap` authenticated and unauthenticated; measure payload bytes and inspect included fields.  
   **Expected outcome**: The authenticated response contains only shell-critical state; it excludes session-directory windows, agent timelines, terminal viewports, terminal directories, version data, and network diagnostics; the payload stays under `MAX_BOOTSTRAP_PAYLOAD_BYTES`; unauthenticated requests fail cleanly without protected data. Sources: `SPEC`; `COMP`; `BUDGET`.  
   **Interactions**: bootstrap router, auth middleware, request/perf logging.

13. **Name**: `/api/session-directory` is the sole session read-model authority and validates visible/background window queries  
   **Type**: integration  
   **Harness**: `ReadModelRouteHarness`  
   **Preconditions**: Session data spans multiple pages and includes searchable titles/snippets; multiple revisions are available.  
   **Actions**: Call `GET /api/session-directory` with valid and invalid combinations of `query`, `cursor`, `revision`, `limit`, and `priority`; trigger a revision change.  
   **Expected outcome**: Valid requests return bounded windows plus cursor/revision information; invalid cursor/priority/limit inputs fail cleanly; the route family remains `GET /api/session-directory`; no runtime read-model path exposes `/api/sessions/search` or `/api/sessions/query`. Sources: `SPEC`; `COMP`; `BUDGET`.  
   **Interactions**: session-directory service, router validation, scheduler lane mapping.

14. **Name**: Session mutations and `sessions.changed` revisions cooperate without sending bulk rows or forcing full snapshot reloads  
   **Type**: integration  
   **Harness**: `ProtocolHarness` + `ReadModelRouteHarness` + `AppHydrationHarness`  
   **Preconditions**: The client has one visible directory window loaded; websocket is connected; mutation routes succeed.  
   **Actions**: Rename, archive, and delete sessions; trigger an index revision change; observe websocket and client refresh behavior.  
   **Expected outcome**: Mutations return enough local confirmation or revision data to refresh only the active window; websocket invalidation uses `sessions.changed { revision }` without embedding rows; the client never falls back to `/api/sessions` snapshots. Sources: `SPEC`; `COMP`; `WIRE`.  
   **Interactions**: mutation routes, websocket invalidation, sidebar/history thunks, session-directory route.

15. **Name**: Agent timeline routes and `sdk.session.snapshot` restore chat state without replay arrays  
   **Type**: integration  
   **Harness**: `ProtocolHarness` + `ReadModelRouteHarness`  
   **Preconditions**: An agent session contains many turns, recent summaries, older bodies, and a live websocket attach path.  
   **Actions**: Fetch `/api/agent-sessions/:sessionId/timeline`; fetch `/api/agent-sessions/:sessionId/turns/:turnId`; attach to the session over websocket.  
   **Expected outcome**: Timeline pages are recent-first and cursorable; turn bodies hydrate on demand; websocket attach/create emits `sdk.session.snapshot` plus live status/delta events and never `sdk.history`; no path depends on replay arrays to restore visible chat state. Sources: `SPEC`; `COMP`; `WIRE`.  
   **Interactions**: agent timeline router/service, websocket SDK path, client SDK message handling.

16. **Name**: Terminal directory, viewport, scrollback, and search stay separate routes and lane assignments  
   **Type**: integration  
   **Harness**: `ReadModelRouteHarness` + `TerminalMirrorFixture` + `SlowNetworkController`  
   **Preconditions**: Deterministic terminal directory data, mirrored viewport state, search hits, and scrollback are available; scheduler events are captured.  
   **Actions**: Request `GET /api/terminals`; `GET /api/terminals/:terminalId/viewport`; `GET /api/terminals/:terminalId/scrollback`; and `GET /api/terminals/:terminalId/search` under focused, visible, and background conditions.  
   **Expected outcome**: The routes stay separate; viewport responses include `tailSeq` and runtime metadata; scrollback and search remain server-owned; scheduler lanes classify focused viewport reads as `critical`, visible directory/search work as `visible`, and deferred/history work as `background`. Sources: `SPEC`; `COMP`; `WIRE`; `BUDGET`.  
   **Interactions**: terminals router, terminal-view service, scheduler, terminal mirror.

17. **Name**: Terminal mutations invalidate visible windows through `terminals.changed` and refresh visible pane chrome through `terminal.runtime.updated`  
   **Type**: integration  
   **Harness**: `ProtocolHarness` + `ReadModelRouteHarness`  
   **Preconditions**: A client has a visible terminal pane and a visible terminal directory window loaded.  
   **Actions**: Create, patch, delete, exit, and detach terminals; update runtime metadata for an already-hydrated visible terminal.  
   **Expected outcome**: Directory-affecting changes emit `terminals.changed { revision }`; already-hydrated terminals receive `terminal.runtime.updated`; no path requires `terminal.list.updated`, `terminal.meta.list`, or `terminal.meta.list.response`. Sources: `SPEC`; `COMP`; `WIRE`.  
   **Interactions**: terminal routes, websocket handler, visible pane header, directory refresh logic.

18. **Name**: Shared read-model lanes enforce `critical > visible > background` and propagate aborts from the owning HTTP request  
   **Type**: integration  
   **Harness**: `ReadModelRouteHarness` + `SlowNetworkController`  
   **Preconditions**: Multiple queued jobs exist in each lane; request-bound abort signals are visible to the scheduler.  
   **Actions**: Queue background work first, then visible, then critical; abort queued and running requests from their owning HTTP request.  
   **Expected outcome**: Critical work runs ahead of queued visible/background work; visible work runs ahead of queued background work; background concurrency is bounded; abort cancels queued or running background work without leaking late mutations into visible state. Sources: `SPEC`; `COMP`; `BUDGET`.  
   **Interactions**: scheduler, request-abort helper, bootstrap/session-directory/agent-timeline/terminal routes.

19. **Name**: CLI HTTP wiring uses the session-directory route family and not legacy snapshot routes  
   **Type**: integration  
   **Harness**: `CliCommandHarness` + `ReadModelRouteHarness`  
   **Preconditions**: CLI HTTP requests are logged; the route harness exposes both the new route family and rejects legacy routes.  
   **Actions**: Run `list-sessions` and `search-sessions`; inspect the recorded HTTP requests.  
   **Expected outcome**: The CLI hits the visible-first session-directory family only; `/api/sessions` and `/api/sessions/search` are never requested; user-visible output remains stable enough to preserve the command contract. Sources: `SPEC`; `COMP`.  
   **Interactions**: CLI argument parsing, CLI HTTP client, session-directory routes.

20. **Name**: The visible-first audit runner, smoke path, and artifact schema are updated to the new transport contract  
   **Type**: integration  
   **Harness**: `VisibleFirstAuditHarness`  
   **Preconditions**: Reduced and full audit paths are available; scenario/profile definitions are frozen; the new transport contract is the source of truth.  
   **Actions**: Run the reduced smoke path and inspect the accepted scenario definitions, normalized route IDs, and allowed websocket type sets used by the runner.  
   **Expected outcome**: The runner still writes one schema-valid artifact, but the accepted pre-ready transport contract is now `/api/bootstrap` plus the focused-surface HTTP route family for the scenario, and the surviving websocket types are limited to the live-control/delta contract; the audit no longer treats `/api/sessions`, `/api/sessions/search`, `sdk.history`, `sessions.updated`, `sessions.patch`, `terminal.list`, or `terminal.meta.list` as allowed startup work. Sources: `USR`; `SPEC`; `COMP`; `AUDIT`.  
   **Interactions**: audit scenario definitions, route normalization, network recorder, smoke test, sample runner.

### Differential tests

21. **Name**: Comparing two trusted audit artifacts reports only scenario/profile/metric deltas and returns zero deltas for identical inputs  
   **Type**: differential  
   **Harness**: `VisibleFirstAuditHarness`  
   **Preconditions**: One pair of identical trusted artifacts and one pair with known per-scenario/per-profile metric differences are available.  
   **Actions**: Run the compare helper and compare CLI against both pairs.  
   **Expected outcome**: Identical artifacts produce zero deltas; changed artifacts produce JSON-only deltas grouped by scenario ID and profile ID; the compare tool does not invent extra samples or reorder the accepted matrix. Sources: `USR`; `COMP`; `AUDIT`.  
   **Interactions**: audit compare helper, audit schema parser, CLI output path.

22. **Name**: The machine gate passes only trusted artifacts with no mobile or offscreen regressions and fails on every prohibited delta  
   **Type**: differential  
   **Harness**: `VisibleFirstAuditHarness`  
   **Preconditions**: Trusted base and candidate artifacts are available, including fixtures with positive and zero deltas for the gated metrics.  
   **Actions**: Run the gate helper/CLI on an identical pair, then on candidate artifacts with positive `mobile_restricted.focusedReadyMs`, positive `mobile_restricted.terminalInputToFirstOutputMs` for the two terminal scenarios, and positive offscreen-before-ready deltas.  
   **Expected outcome**: The identical pair passes; any candidate with one of the prohibited deltas fails with a non-zero result and machine-readable violations; untrusted artifacts fail before metric comparison. Sources: `USR`; `COMP`; `AUDIT`; `HARNESS`.  
   **Interactions**: audit gate helper, audit schema parser, compare inputs, CLI exit behavior.

### Invariant tests

23. **Name**: No production or runtime path still uses legacy bulk session or terminal transport, and no production code imports `SearchAddon`  
   **Type**: invariant  
   **Harness**: `ProtocolHarness` + `AppHydrationHarness`  
   **Preconditions**: App boot, session browsing, agent-chat restore, terminal restore, and reconnect flows are all exercised at least once; production-code grep proofs run on the same tree.  
   **Actions**: Capture the runtime websocket transcript and request log for those flows; run the planned cleanup grep proofs against `shared`, `server`, and `src`.  
   **Expected outcome**: No runtime or production path emits or consumes `sessions.updated`, `sessions.page`, `sessions.patch`, `sessions.fetch`, `sdk.history`, `terminal.list`, `terminal.list.response`, `terminal.list.updated`, `terminal.meta.list`, `terminal.meta.list.response`, `sessionsPatchV1`, or `sessionsPaginationV1`; no production code imports or instantiates `SearchAddon`; no production path still uses `/api/sessions/search` or `/api/sessions/query`. Sources: `SPEC`; `COMP`.  
   **Interactions**: websocket protocol, request routing, terminal search UI/runtime, static cleanup proofs.

24. **Name**: `App.tsx` is the sole websocket owner, and focused-pane HTTP hydration starts before websocket `ready` while version/network remain background work  
   **Type**: invariant  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController`  
   **Preconditions**: App is rendered with a focused pane, delayed websocket `ready`, and delayed version/network requests.  
   **Actions**: Render `App`; inspect `ws.connect()` callers; release bootstrap and focused-pane HTTP while holding websocket `ready`, `/api/version`, and network diagnostics.  
   **Expected outcome**: Only `App.tsx` calls `ws.connect()`; focused-pane HTTP starts immediately after bootstrap and completes before websocket `ready`; `/api/version` and network diagnostics stay background work and do not gate first paint. Sources: `SPEC`; `COMP`.  
   **Interactions**: `App.tsx`, child components, websocket client, background shell requests.

25. **Name**: Offscreen tabs and hidden panes do not prehydrate before visibility or explicit selection  
   **Type**: invariant  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController`  
   **Preconditions**: Layout contains hidden or offscreen terminal and agent-chat panes with enough data that prehydration would be visible in the request log.  
   **Actions**: Render `App`; complete bootstrap and focused/visible work; keep offscreen surfaces unselected; then select them one by one.  
   **Expected outcome**: Hidden/offscreen panes make no startup read-model requests before selection; selecting a pane starts only that pane’s hydration; background idle-time work does not start before the visible window is rendered and budgeted. Sources: `USR`; `SPEC`; `BUDGET`; `COMP`.  
   **Interactions**: persisted layout state, tab selection, focused/visible/background request scheduling.

26. **Name**: Payload ceilings, realtime queue bounds, and audit-facing instrumentation are enforced at the transport seams  
   **Type**: invariant  
   **Harness**: `ReadModelRouteHarness` + `ProtocolHarness` + `SlowNetworkController`  
   **Preconditions**: Large but valid payload fixtures, oversize fixtures, and queue pressure cases are available; server and client perf logging are enabled.  
   **Actions**: Request bootstrap, directory, timeline, viewport, scrollback, and search payloads near their limits; enqueue live and recovering frames near and beyond the websocket budget; capture request/perf logs.  
   **Expected outcome**: Bootstrap and realtime payloads respect the shared ceilings; overflow degrades through gap/invalidation rather than unbounded buffering; live terminal traffic outranks recovering/background work; request and perf logs expose lane, payload bytes, duration, queue depth, and dropped bytes. Sources: `SPEC`; `COMP`; `BUDGET`; `AUDIT`.  
   **Interactions**: request logger, perf logger, websocket boundary, client output queue, scheduler.

### Boundary and edge-case tests

27. **Name**: Invalid auth, cursor, priority, query, protocol, and viewport inputs fail cleanly without partial state or data leakage  
   **Type**: boundary  
   **Harness**: `ProtocolHarness` + `ReadModelRouteHarness`  
   **Preconditions**: Auth, route validation, and websocket protocol validation are enabled; the client state starts empty.  
   **Actions**: Send invalid auth tokens, malformed cursors, unsupported priorities, invalid query values, malformed viewport dimensions, and mismatched websocket protocol versions.  
   **Expected outcome**: HTTP returns clear `4xx` errors without partial state mutation or protected payload leakage; websocket protocol mismatches close with `4010`; invalid read-model inputs do not leak rows, timelines, viewport text, or unstable revisions into the client. Sources: `SPEC`; `COMP`; `WIRE`.  
   **Interactions**: auth middleware, route validation, websocket handshake.

28. **Name**: Stale `sinceSeq`, overlapping replay, and replay overflow yield explicit gaps or invalidation instead of duplicate or unbounded replay  
   **Type**: boundary  
   **Harness**: `TerminalMirrorFixture` + `ProtocolHarness` + `AppHydrationHarness`  
   **Preconditions**: The replay ring contains a short recoverable tail and a stale cursor case; overlapping replay frames are available.  
   **Actions**: Attach with a stale `sinceSeq`; attach with overlapping replay coverage; overflow the replay window while live output continues.  
   **Expected outcome**: Recoverable tails replay once; stale or overflowed ranges surface explicit gap/invalidation behavior; overlapping frames are not duplicated; live frames remain prioritized over recovering backlog. Sources: `SPEC`; `WIRE`; `BUDGET`; `COMP`.  
   **Interactions**: replay ring, client output queue, terminal attach sequence state, terminal restore flow.

29. **Name**: Delayed websocket `ready` and delayed background shell requests do not block focused paint or terminal input/output  
   **Type**: boundary  
   **Harness**: `AppHydrationHarness` + `SlowNetworkController`  
   **Preconditions**: Focused-pane HTTP is available; websocket `ready`, `/api/version`, and network diagnostics can be delayed independently; live terminal input/output is observable.  
   **Actions**: Delay websocket `ready` and the background shell calls; release bootstrap and focused-pane hydration; send terminal input before background work completes.  
   **Expected outcome**: The focused surface paints before websocket `ready`; background shell calls do not replace or block the already visible pane; live terminal input/output stays responsive while background work is still pending. Sources: `USR`; `SPEC`; `COMP`; `BUDGET`.  
   **Interactions**: `App.tsx`, focused-pane hydration, websocket readiness, network/version fetches, terminal input path.

### Regression tests

30. **Name**: Mobile sidebar search and pane-header runtime metadata remain correct after removing legacy session snapshots and terminal-meta snapshots  
   **Type**: regression  
   **Harness**: `AppHydrationHarness` + `ReadModelRouteHarness`  
   **Preconditions**: Mobile layout is active; sidebar can open full-width; a visible terminal pane exposes title/status/cwd metadata through the new viewport/runtime-delta contract.  
   **Actions**: Open the mobile sidebar, search, open a result, return to the terminal pane, and trigger a terminal runtime metadata change.  
   **Expected outcome**: Mobile sidebar search still behaves correctly through the session-directory contract; pane-header metadata comes from the viewport payload plus targeted runtime deltas; no flow depends on `/api/sessions` bootstrap snapshots or `terminal.meta.list.response`. Sources: `USR`; `SPEC`; `WIRE`; `COMP`.  
   **Interactions**: mobile sidebar flow, session-directory route, terminal viewport/runtime delta flow, pane header rendering.

### Unit tests

31. **Name**: Shared visible-first harness modules expose the deterministic controls promised by the completion plan  
   **Type**: unit  
   **Harness**: `ProtocolHarness` + `ReadModelRouteHarness` + `AppHydrationHarness` + `SlowNetworkController` + `TerminalMirrorFixture` + `CliCommandHarness`  
   **Preconditions**: The shared harness modules exist and are imported directly.  
   **Actions**: Instantiate each harness in isolation and exercise the control surface promised by the completion plan: raw transcript capture, lane event capture, delayed `ready`, seeded layout hydration, deterministic viewport snapshots, replay overflow, and CLI capture.  
   **Expected outcome**: Each harness exposes the controls and observations listed in `Task 1`/`Task 2`; later scenario and integration tests can reuse them without ad hoc websocket stubs, route fixtures, scheduler fakes, or app boot shims. Sources: `HARNESS`; `COMP`.  
   **Interactions**: shared test modules only.

32. **Name**: Read-model API helpers target only the accepted route families and forward abort/query information consistently  
   **Type**: unit  
   **Harness**: direct module tests  
   **Preconditions**: The client API helper module exists with the visible-first helper surface.  
   **Actions**: Call each helper for bootstrap, session-directory, terminal-directory, agent timeline, turn body, terminal viewport, scrollback, and search with representative query params and `AbortSignal`s.  
   **Expected outcome**: The helpers build only the accepted route families; directory helpers encode `cursor`, `revision`, `limit`, and `priority` consistently; every helper forwards `AbortSignal`; no helper is needed for the removed legacy snapshot routes. Sources: `SPEC`; `COMP`; `BUDGET`.  
   **Interactions**: client API helper module, shared read-model query contracts.

33. **Name**: The session-directory service owns canonical ordering, bounded snippets, and deterministic cursor rejection  
   **Type**: unit  
   **Harness**: direct module tests  
   **Preconditions**: The authoritative session-directory service is exercised with deterministic session/project fixtures.  
   **Actions**: Query the service with no cursor, valid cursor, invalid cursor, large limits, and text queries that should match titles/snippets.  
   **Expected outcome**: The service returns canonical server-owned ordering, bounded snippets, bounded window size, joined running metadata required for visible windows, and deterministic rejection of invalid cursors. Sources: `SPEC`; `COMP`; `BUDGET`.  
   **Interactions**: session-directory service/types only.

34. **Name**: Terminal mirror, replay ring, and client output queue stay deterministic and preserve live-over-recovery priority  
   **Type**: unit  
   **Harness**: `TerminalMirrorFixture`  
   **Preconditions**: Deterministic ANSI output, replay windows, gap cases, and mixed live/recovering frames are available.  
   **Actions**: Serialize the viewport, request scrollback/search, build replay windows, enqueue live and recovering frames, and trigger overflow.  
   **Expected outcome**: Viewport serialization and `tailSeq` are deterministic; replay anchors are stable; live frames outrank recovering frames; overflow yields gap data rather than unbounded buffering or duplicate replay. Sources: `SPEC`; `WIRE`; `BUDGET`; `COMP`.  
   **Interactions**: terminal mirror, replay ring, client output queue.

35. **Name**: Audit helpers freeze the accepted IDs, normalize the new route family, and keep compare/gate CLI output machine-readable  
   **Type**: unit  
   **Harness**: `VisibleFirstAuditHarness`  
   **Preconditions**: Audit helper modules are imported directly with representative valid and invalid fixtures.  
   **Actions**: Parse the accepted scenario/profile IDs, normalize dynamic read-model routes, classify websocket frame types, validate artifacts, and run compare/gate helpers with violating and non-violating fixtures.  
   **Expected outcome**: The accepted profile/scenario IDs stay frozen; route normalization reflects the new `/api/bootstrap`, `/api/session-directory`, `/api/agent-sessions/:sessionId/*`, and `/api/terminals/:terminalId/*` family; compare/gate output stays JSON-only and exits non-zero on violations. Sources: `USR`; `COMP`; `AUDIT`; `HARNESS`.  
   **Interactions**: audit schema, route normalizer, compare helper, gate helper.

## Coverage summary

### Covered action space

- Shell bootstrap, auth gating, websocket ownership, and first-paint ordering.
- Visible session browsing, server-side query windows, search, pagination, and targeted mutation refresh.
- Agent-chat reload, recent-turn-first hydration, turn-body on-demand loading, session switching, and session-loss recovery.
- Terminal directory browsing, viewport-first restore, short-tail replay, gap handling, server-side search, scrollback, and runtime metadata updates.
- Offscreen tab selection, hidden-pane non-prehydration, and shared `critical`/`visible`/`background` lane behavior.
- CLI list/search flows that must move off the legacy session snapshot routes.
- Audit runner, reduced smoke path, artifact contract, compare tool, and machine gate for the mobile/offscreen decision rule.
- Deletion guards for the legacy websocket/session snapshot architecture and client-side terminal search path.

### Explicit exclusions

- Production WAN or canary measurement is excluded from the implementation gate. The approved oracle is the deterministic local audit matrix plus the machine gate. Risk: medium. Real-world latency distributions can still expose tuning issues after local gates pass.
- Differential comparison against the legacy bulk websocket transport as a behavioral oracle is excluded. Risk: low. The legacy transport is explicitly the architecture being removed.
- Real upstream CLI binary execution is excluded from gating tests; fixtures and fake services stand in for providers. Risk: low to medium. Provider-specific parsing or event-shape drift can still surface outside the harness fixtures.

### Residual risks if exclusions remain

- Scheduler fairness under production-grade noisy traffic may still need tuning even if deterministic lane tests pass.
- Search quality and snippet relevance are only as good as the deterministic fixture corpus; this plan verifies ownership, windowing, and bounded payloads, not subjective ranking quality.
- Browser rendering differences outside the serialized xterm viewport still rely on the existing component/e2e coverage rather than the terminal mirror itself.
