# Show Open-Tab Sessions In Sidebar Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

The agreed strategy still holds: drive the work with TDD, cover the change with unit and integration tests around the new locator and personalization rules, add user-visible scenario coverage in the existing component-e2e style, then run full verification. The only clarification is harness choice: the transport and pagination risk is on the HTTP and WebSocket boundaries, so direct `supertest` and real-`WsHandler` integration tests are required in addition to jsdom component tests. This does not increase scope, require external services, or change the user-visible goal.

## Sources Of Truth
- `S1 User Goal`: The user’s open local coding session must appear in the left sidebar even when it is older than the default first 100 sessions, and foreign copied panes must not count as that same local session.
- `S2 Plan Goal/Architecture`: The server owns personalized first-page sidebar selection for HTTP bootstrap, websocket handshake/broadcast, and `ui.layout.sync` refreshes; `state.sessions.projects` remains the only sidebar data source; no client-side synthetic sidebar rows are allowed.
- `S3 Plan Locality Rules`: The client must preserve exact session locators plus intrinsic id-less local fallbacks until after local-vs-foreign match/open decisions are made; layout-backed and no-layout local fallbacks must work before websocket `ready`; foreign copied panes intentionally stay foreign-only.
- `S4 Plan Pagination Rules`: Only page 1 is personalized; page 2+ must continue from the true page-1 cursor; cursor metadata comes from the primary page window, not forced extras; `hasMore` means at least one unique session is still unseen.
- `S5 Transport Contract`: WebSocket `hello` may carry `sidebarOpenSessions`; `ui.layout.sync.tabs[]` may carry `fallbackSessionRef`; the server/router must accept JSON bodies for locator-bearing requests.
- `S6 Existing State Contract`: The sidebar renders from `state.sessions.projects`; `mergeSnapshotProjects()` may keep an older session visible after its tab closes, and that is acceptable for this feature.

## Harness Requirements
No brand-new harnesses are required. Extend the existing harnesses below first, then write the tests that depend on them.

| Harness | What it does / exposes | Estimated complexity | Tests |
| --- | --- | --- | --- |
| `H1 Client component-e2e harness` | Vitest + React Testing Library with real `App` and/or real `Sidebar`, mocked HTTP and websocket edges, preloaded Redux state, DOM assertions, captured websocket sends, injected inbound websocket messages. | Existing, medium | 1, 2, 3, 5 |
| `H2 Client state/component integration harness` | Vitest + `configureStore` + jsdom component rendering for selector, thunk, middleware, and click-path tests; exposes Redux state inspection and dispatched UI actions. | Existing, low | 8, 9 |
| `H3 Server router integration harness` | Express router under `supertest`; exposes request/response bodies, status codes, and pagination metadata for `/sessions/query`. | Existing, low | 4, 10 |
| `H4 Server websocket integration harness` | Real `http.Server` + real `WsHandler` + `ws` client; exposes actual handshake messages, `sessions.updated` snapshots, per-connection refreshes, and later broadcasts. | Existing, medium | 6, 7 |
| `H5 Pure-function unit harness` | Vitest for helper/selector/pagination normalization logic; exposes direct function inputs/outputs for exact locator collection, schema validation, and forced-key building. | Existing, low | 10, 11, 12 |

## Test Plan
1. **Name:** Older open local session is visible in the sidebar during bootstrap.
   **Type:** scenario
   **Harness:** `H1 Client component-e2e harness`
   **Preconditions:** The store is preloaded with a restored local tab/pane for a session older than the normal first page; the mocked server dataset contains more than 100 sessions; the mocked personalized bootstrap response includes the normal first page plus that older open local session.
   **Actions:** Render `App`; let bootstrap finish; allow the sidebar to render from Redux.
   **Expected outcome:** Per `S1`, `S2`, and `S4`, bootstrap sends the open-session locators needed for personalization, the older open local session appears in the rendered sidebar, the sidebar state comes from `state.sessions.projects` rather than a synthetic client-only row, and pagination metadata reflects the primary page boundary instead of the forced extra.
   **Interactions:** Restored tabs/panes, locator collection, API helper, `/api/sessions/query`, pagination metadata reducers, sidebar rendering.

2. **Name:** Opening or restoring an older local session after bootstrap refreshes the same sidebar connection even before a pane layout exists.
   **Type:** scenario
   **Harness:** `H1 Client component-e2e harness`
   **Preconditions:** The app has already booted with a normal first page that does not include the target older session; websocket is ready; heavy pane content is mocked so a new tab can remain in the no-layout state long enough to exercise the fallback path.
   **Actions:** Open the local session through the tab/open flow; observe the outbound `ui.layout.sync`; inject the personalized `sessions.updated` refresh that the server should send back.
   **Expected outcome:** Per `S2`, `S3`, `S5`, and `S6`, the mirrored payload includes `tabs[].fallbackSessionRef` for the no-layout local tab, the same websocket connection receives a personalized refresh, and the sidebar updates through the normal sessions state path so the older session becomes visible without a second cache.
   **Interactions:** `openSessionTab`, layout mirror middleware, websocket client, websocket message handling, sessions slice, sidebar rendering.

3. **Name:** Clicking a sidebar session opens or focuses the local session instead of hijacking a foreign copied tab.
   **Type:** scenario
   **Harness:** `H1 Client component-e2e harness`
   **Preconditions:** The sidebar contains a local indexed session; the current workspace already contains a foreign copied pane with the same `provider:sessionId`; local server identity is known.
   **Actions:** Click the sidebar row for the indexed local session.
   **Expected outcome:** Per `S1` and `S3`, the click path does not focus the foreign copied pane as the local session match; it either focuses an existing local match or creates a new local pane/tab, and the resulting active tab/pane reflects local-session semantics rather than the foreign locator.
   **Interactions:** Sidebar click handler, `findPaneForSession`, `openSessionTab`, pane creation, active tab/pane reducers.

4. **Name:** `POST /sessions/query` personalizes only the first page for local open sessions and preserves cursor semantics.
   **Type:** integration
   **Harness:** `H3 Server router integration harness`
   **Preconditions:** The router dataset contains more than 100 sessions, including an older local session outside the primary window, a forced session already inside the primary window, duplicate locator entries, and a foreign-only copied locator for the same `provider:sessionId`.
   **Actions:** `POST /sessions/query` with `openSessions`; then request page 2 using the returned `before` and `beforeId`.
   **Expected outcome:** Per `S2`, `S3`, and `S4`, page 1 includes the older local session exactly once, ignores foreign-only locators, keeps the forced-in-window session unduplicated, reports `oldestIncludedTimestamp` and `oldestIncludedSessionId` from the primary page window, and page 2 starts from that true boundary without reapplying page-1 personalization.
   **Interactions:** Router body validation, local-key normalization, pagination helper, cursor handling.

5. **Name:** The bootstrap sessions API chooses `GET` versus personalized `POST` correctly and loads the result into the sidebar state.
   **Type:** integration
   **Harness:** `H1 Client component-e2e harness`
   **Preconditions:** One case has no open-session locators; another case has mixed exact locators from restored tabs/panes; both cases use the real bootstrap code path in `App`.
   **Actions:** Render `App` in each case and observe the HTTP call made during bootstrap and during the websocket-already-ready recovery path.
   **Expected outcome:** Per `S2` and `S5`, no-open-session bootstrap uses `GET /api/sessions?limit=100`, locator-bearing bootstrap uses `POST /api/sessions/query` with a JSON body instead of query-encoded locator data, and the returned projects populate `state.sessions.projects` for the sidebar.
   **Interactions:** `collectSessionLocatorsFromTabs`, API helper, `App` bootstrap logic, sessions reducers.

6. **Name:** Websocket `hello` personalizes the first snapshot for older local sessions and keeps the real page-1 cursor.
   **Type:** integration
   **Harness:** `H4 Server websocket integration harness`
   **Preconditions:** A real `WsHandler` serves a snapshot with more than 100 sessions; the client `hello` includes mixed local explicit locators, id-less local fallbacks, duplicates, and foreign-only locators.
   **Actions:** Open a websocket, send `hello`, and collect the resulting `ready` plus `sessions.updated` messages.
   **Expected outcome:** Per `S2`, `S3`, `S4`, and `S5`, the first snapshot includes the older local session even when it is outside the normal first page, ignores foreign-only locators, dedupes repeated local evidence, and reports cursor metadata and `hasMore` from the primary page window rather than from the forced extra.
   **Interactions:** Shared websocket schema, hello handling, per-connection personalization, paginated snapshot sending, chunked websocket delivery.

7. **Name:** `ui.layout.sync` refreshes personalized snapshots only when the local open-session key set changes and keeps that personalization across later broadcasts.
   **Type:** integration
   **Harness:** `H4 Server websocket integration harness`
   **Preconditions:** A connected client has already received the normal first page; the target older local session is outside that page; the mirrored UI state can provide both layout-backed locators and tab-level fallback locators for the same local session.
   **Actions:** Send `ui.layout.sync` with a changed local key set; send the same payload again; trigger a later `broadcastSessionsUpdated()` after the personalized state is established.
   **Expected outcome:** Per `S2`, `S3`, `S4`, and `S5`, the first changed key set triggers one refreshed `sessions.updated` snapshot, repeated identical key sets do not cause redundant refreshes, duplicate layout-plus-tab evidence collapses to one local key, agent-chat local sessions normalize as `claude`, foreign-only copied locators do not force inclusion, and later broadcasts still honor the same per-connection personalization.
   **Interactions:** Layout schema/store, websocket layout handling, per-connection snapshot state, later broadcast path.

8. **Name:** Personalized page 1 plus later page fetches preserve unique session coverage without duplicate sidebar rows.
   **Type:** invariant
   **Harness:** `H2 Client state/component integration harness`
   **Preconditions:** The first personalized page includes an older forced session that would otherwise appear naturally on page 2; the client already has the first page in state.
   **Actions:** Append the natural next page through the same `sessions.page` and `appendSessionsPage` path the UI uses for infinite scroll.
   **Expected outcome:** Per `S4` and `S6`, the union of page 1 and page 2 contains each session at most once in sidebar state, no session before the page-2 cursor is skipped because page 1 was personalized, and the sidebar can continue scrolling from the returned cursor without losing older sessions already loaded.
   **Interactions:** Pagination metadata, `appendSessionsPage`, `mergeSnapshotProjects`, sidebar item selection.

9. **Name:** Local session matching works both before websocket `ready` and after `ready`.
   **Type:** boundary
   **Harness:** `H2 Client state/component integration harness`
   **Preconditions:** Test fixtures include a local explicit locator, an intrinsic id-less local fallback, a foreign explicit locator with the same `provider:sessionId`, and cases with `localServerInstanceId` undefined and defined.
   **Actions:** Call `findTabIdForSession` and `findPaneForSession`; dispatch `openSessionTab`; exercise the Sidebar click path against the same fixtures.
   **Expected outcome:** Per `S3`, before `ready` an intrinsic local fallback can still satisfy a local target, after `ready` an explicit local locator outranks the fallback, a foreign-only candidate never satisfies a local target, and an explicit foreign target can still resolve the foreign copy when that is what the caller asked for.
   **Interactions:** Session locator helpers, tabs thunk, sidebar click flow, connection state.

10. **Name:** Locator-bearing HTTP and websocket payloads accept the new shapes and reject malformed bodies.
    **Type:** boundary
    **Harness:** `H3 Server router integration harness` + `H5 Pure-function unit harness`
    **Preconditions:** Valid payloads include `openSessions` in `/sessions/query`, `sidebarOpenSessions` in websocket `hello`, and `fallbackSessionRef` in `ui.layout.sync.tabs[]`; invalid payloads use wrong types or missing required fields.
    **Actions:** Submit valid and invalid router bodies; validate mirrored layout payloads against the server schema path used by websocket handling.
    **Expected outcome:** Per `S5`, valid locator-bearing payloads are accepted on the transport boundary, malformed request bodies fail validation with `400` or schema rejection, and the server-side accepted shape matches what the client is expected to send.
    **Interactions:** Zod request validation, shared transport schema, server layout schema.

11. **Name:** `hasTab` stays correct after switching the sidebar to the shared session-ref collector.
    **Type:** regression
    **Harness:** `H5 Pure-function unit harness`
    **Preconditions:** The sidebar projects include valid sessions, invalid Claude IDs, layout-backed panes, and no-layout tab fallbacks.
    **Actions:** Build sidebar items through the selector path that now uses the shared collector.
    **Expected outcome:** Per `S3` and `S6`, valid open sessions still produce `hasTab: true`, invalid Claude IDs are ignored exactly as they are today, and the collector refactor does not change the sidebar’s notion of which sessions are open.
    **Interactions:** `buildSessionItems`, shared collector, validity filtering.

12. **Name:** Exact locator collection preserves local-versus-foreign identity while collapsed display refs stay lossy only for display.
    **Type:** unit
    **Harness:** `H5 Pure-function unit harness`
    **Preconditions:** Pane trees include terminal panes, agent-chat panes, explicit `sessionRef` values, `resumeSessionId` fallbacks, remote copied panes, duplicate exact locators, and invalid Claude IDs.
    **Actions:** Collect exact locators from tabs and pane trees; collect collapsed display refs; normalize sidebar-open keys on the server side.
    **Expected outcome:** Per `S2`, `S3`, and `S5`, the exact helper preserves separate local explicit, intrinsic local fallback, and foreign explicit identities; exact duplicates collapse only by full locator identity; the display-only helper collapses to unique `provider:sessionId` pairs; and invalid Claude IDs or foreign-only keys are ignored where the rules say they should be ignored.
    **Interactions:** Client locator helpers, server local-key normalization helper.

## Coverage Summary
Covered action space:
- HTTP bootstrap with and without open local sessions.
- Websocket handshake personalization, chunked snapshot delivery, and later broadcasts.
- Post-bootstrap local tab/open/restore activity through `ui.layout.sync`, including no-layout tab fallbacks.
- Local-versus-foreign session matching for tab activation, pane focus, and sidebar clicks.
- Server-side first-page personalization, cursor correctness, and `hasMore` semantics.
- Client-side append/dedupe behavior when a personalized first page overlaps with later pagination.
- Transport-schema acceptance for the new locator-bearing payload shapes.

Explicit exclusions:
- No differential tests are planned because there is no independent reference implementation for personalized sidebar selection; the strongest available sources of truth are the user goal plus the implementation plan rules.
- No dedicated performance benchmark is planned. This is a correctness-driven change with existing pagination and websocket chunking infrastructure already in place; the agreed strategy is full-suite verification rather than new performance instrumentation.
- No tests target `server/routes/sessions.ts`; the live HTTP router is `server/sessions-router.ts` per `S2`. If the legacy router is revived later, it could drift unnoticed.

Residual risks carried by the exclusions:
- Without a reference implementation, correctness depends on strong scenario and integration coverage at the transport boundaries; weak unit-only coverage would miss real regressions here.
- Without a dedicated performance benchmark, a severe accidental blow-up in personalized page selection would most likely be caught only by full-suite runtime or manual profiling rather than by a focused performance test.
- If other code paths later bypass `server/sessions-router.ts` for sessions bootstrap, they could miss personalization until separate tests are added for those alternate entry points.

Verification required after implementation:
- Follow red-green-refactor task by task.
- Run the targeted tests introduced for each task before moving on.
- Finish with `npm test` and `npm run check` in this worktree.
