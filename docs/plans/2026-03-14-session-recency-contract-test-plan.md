# Semantic Session Recency Contract Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

The approved strategy and the execution plan already agree on the fix: this is a contract bug with a rendering symptom, so the test plan stays source-focused rather than adding renderer-only flash tests. The only refinement here is sequencing: the first tests exercise the exact root-cause path end to end (`touch-only file churn -> provider parse -> indexer refresh -> session-directory projection -> sessions.changed`) before the layer-by-layer contract checks.

## Sources Of Truth
- `S1 Semantic recency contract`: The approved transcript and implementation plan require session recency to mean semantic session activity, not filesystem observation time.
- `S2 Monotonic indexer contract`: Append-only reparses of the same resolved session may preserve or extend semantic clocks, but must not regress them; file shrink or resolved-session changes break that carry-forward.
- `S3 Session-directory contract`: The directory projection, service, router, and websocket invalidation boundary are driven only by session-directory-visible fields plus terminal metadata revision.
- `S4 Public session contract`: Shared read-model schemas, HTTP responses, search results, pagination, CLI output, and client API/state must expose `lastActivityAt` and must not leak session-domain `updatedAt`.
- `S5 Client rendering contract`: Sidebar ordering, HistoryView ordering, context-menu metadata, and search/pagination state all render or store semantic recency from `lastActivityAt`.
- `S6 Non-session boundary`: Terminal metadata, codex activity records, tab/device registry records, and other unrelated domains keep their own `updatedAt` fields unchanged.

## Action Space
- Provider semantic clock extraction in `server/coding-cli/providers/claude.ts`, `server/coding-cli/providers/codex.ts`, and direct-provider mapping in `server/coding-cli/providers/opencode.ts`.
- Core session model and cache/index behavior in `server/coding-cli/types.ts` and `server/coding-cli/session-indexer.ts`.
- Server consumers of session recency in `server/session-association-coordinator.ts`, `server/coding-cli/codex-activity-tracker.ts`, and `server/index.ts`.
- Session-directory projection, cursoring, routing, and invalidation in `shared/read-models.ts`, `server/session-directory/*`, `server/sessions-router.ts`, and `server/sessions-sync/*`.
- Search, pagination, and CLI contract surfaces in `server/session-search.ts`, `server/session-pagination.ts`, and `server/cli/index.ts`.
- Client API, state, selectors, and views in `src/lib/api.ts`, `src/store/*`, `src/components/HistoryView.tsx`, `src/components/context-menu/ContextMenuProvider.tsx`, and `src/components/Sidebar.tsx`.
- Websocket handshake and invalidation surfaces in `server/ws-handler.ts` and the read-model bootstrap path.
- Fallout stragglers and fixture updates across targeted unit, integration, e2e, and regression suites.

## Harness Requirements
No new standalone harness is required. The plan reuses existing repo harnesses plus small temp-file fixtures and spies.

| Harness | What it exercises | Notes |
| --- | --- | --- |
| `H1 Server semantic-file scenario harness` | Real provider parse helpers, temp JSONL files, `fsp.utimes`/append/shrink flows, `CodingCliSessionIndexer`, and `SessionsSyncService` with a websocket spy. | Runs under `vitest.server.config.ts`; no live CLI or external services. |
| `H2 Session-directory read-model harness` | Pure server fixtures plus `querySessionDirectory()` and `GET /api/session-directory` integration coverage. | Reuses existing service and router tests. |
| `H3 Websocket invalidation harness` | Real `WsHandler` plus authenticated websocket client for `sessions.changed` and handshake assertions. | Reuses existing ws integration tests; no browser needed. |
| `H4 Public contract harness` | Search, pagination, CLI mappers, and shared schema parsing. | Mix of server Vitest and default-config CLI tests. |
| `H5 Client API and store harness` | Mocked fetch responses, shared schema parsing, Redux store/session-window thunks, and selector outputs. | Reuses existing client Vitest harnesses. |
| `H6 Client UI harness` | RTL/jsdom rendering of `Sidebar`, `HistoryView`, `ContextMenuProvider`, and `App` invalidation flows. | Existing repo “e2e” tests are sufficient; no headed browser harness is required. |
| `H7 Broad verification harness` | Lint, typecheck, focused suites, then coordinated full-suite verification. | Use `npm run test:status` before `npm test`; set `FRESHELL_TEST_SUMMARY`. |

## Test Plan
### Scenario Tests
1. **Name:** Touch-only Claude file churn is projection-invisible end to end.
   **Type:** scenario
   **Harness:** `H1`
   **Preconditions:** A temp Claude session file has an initial semantic transcript and has already been indexed and published once.
   **Actions:** Touch the file or append only Claude housekeeping records such as usage-only assistant payloads or `file-history-snapshot`, then refresh the indexer and republish the projects.
   **Expected outcome:** `lastActivityAt` does not change, the session-directory comparable snapshot is unchanged, and the websocket spy sees no second `sessions.changed`. Source of truth: `S1`, `S2`, `S3`.
   **Interactions:** `parseSessionContent()` -> `CodingCliSessionIndexer.refresh()` -> session-directory projection -> `SessionsSyncService.publish()`.

2. **Name:** Touch-only Codex file churn is projection-invisible end to end.
   **Type:** scenario
   **Harness:** `H1`
   **Preconditions:** A temp Codex session file has an initial semantic transcript and has already been indexed and published once.
   **Actions:** Append only observation records such as `token_count` and `turn_context`, then refresh the indexer and republish the projects.
   **Expected outcome:** `lastActivityAt` does not move, ordering stays stable, and no extra `sessions.changed` is broadcast. Source of truth: `S1`, `S2`, `S3`.
   **Interactions:** `parseCodexSessionContent()` -> `CodingCliSessionIndexer.refresh()` -> session-directory projection -> `SessionsSyncService.publish()`.

3. **Name:** Semantic transcript progress advances recency and emits exactly one invalidation.
   **Type:** scenario
   **Harness:** `H1`
   **Preconditions:** A baseline session snapshot has already been indexed and published.
   **Actions:** Append one user-visible semantic record to the session file, refresh the indexer, and publish the refreshed projects.
   **Expected outcome:** `lastActivityAt` increases, the session can reorder if recency requires it, and one additional `sessions.changed` is broadcast for the semantic change. Source of truth: `S1`, `S2`, `S3`.
   **Interactions:** Provider semantic-clock extraction -> indexer sort path -> session-directory projection -> sessions sync invalidation.

4. **Name:** Touch-only churn leaves the visible directory page and client sidebar snapshot stable.
   **Type:** scenario
   **Harness:** `H2`, `H5`
   **Preconditions:** A known session-directory page and grouped sidebar snapshot have been fetched from baseline data.
   **Actions:** Perform a touch-only refresh, query `/api/session-directory`, and map the response through `fetchSidebarSessionsSnapshot()`.
   **Expected outcome:** The page order, cursor window, grouped projects, and session timestamps are unchanged because only observation time moved. Source of truth: `S3`, `S4`, `S5`.
   **Interactions:** `querySessionDirectory()` -> shared schema parse -> `fetchSidebarSessionsSnapshot()` grouping.

### Integration Tests
5. **Name:** Session-directory service and router expose `lastActivityAt`, stable cursors, and correct revision semantics.
   **Type:** integration
   **Harness:** `H2`
   **Preconditions:** Fixtures include tied timestamps, search hits, archived and non-archived sessions, and running terminal metadata.
   **Actions:** Query the service and router for a normal page, a search page, a follow-up page using a cursor, and an invalid cursor request.
   **Expected outcome:** Items expose `lastActivityAt`, cursor payloads key off `lastActivityAt`, ordering remains deterministic, and revision stays `max(session.lastActivityAt, terminalMeta.updatedAt)` while invalid cursors fail deterministically. Source of truth: `S3`, `S4`, `S6`.
   **Interactions:** `shared/read-models.ts`, `server/session-directory/service.ts`, `server/sessions-router.ts`.

6. **Name:** Search, pagination, and CLI output cut over to `lastActivityAt` without changing container-level pagination names.
   **Type:** integration
   **Harness:** `H4`
   **Preconditions:** Project fixtures include equal-recency ties across providers and searchable title/summary content.
   **Actions:** Run title and content search, paginate with `before` and `beforeId`, and map a session-directory page through the CLI list/search helpers.
   **Expected outcome:** Search results and paginated sessions expose `lastActivityAt`, ordering remains stable, and legacy container names like `oldestIncludedTimestamp` and `before` remain unchanged. Source of truth: `S4`.
   **Interactions:** `server/session-search.ts`, `server/session-pagination.ts`, `server/cli/index.ts`.

7. **Name:** Server session consumers follow `lastActivityAt` while non-session `updatedAt` stays separate.
   **Type:** integration
   **Harness:** `H1`
   **Preconditions:** Session fixtures and terminal candidates exist around the association age boundary; Codex sessions include task activity.
   **Actions:** Advance session recency, run association checks, and feed updated sessions through the Codex activity tracker.
   **Expected outcome:** Association eligibility and watermarks compare against `lastActivityAt`, tracker state records the latest session semantic recency, and terminal/codex activity `updatedAt` fields remain untouched as unrelated domains. Source of truth: `S2`, `S6`.
   **Interactions:** `server/session-association-coordinator.ts`, `server/coding-cli/codex-activity-tracker.ts`, `server/index.ts`.

8. **Name:** Projection-driven invalidation stays narrow while full project diff stays strict.
   **Type:** integration
   **Harness:** `H1`, `H2`
   **Preconditions:** Pairs of project snapshots differ first by invisible metadata only and then by directory-visible fields.
   **Actions:** Compare the snapshots through `hasSessionDirectorySnapshotChange()`, `SessionsSyncService.publish()`, and `diffProjects()`.
   **Expected outcome:** Projection-invisible deltas do not broadcast `sessions.changed`, but the full diff still reports internal metadata changes for indexer consumers. Source of truth: `S2`, `S3`.
   **Interactions:** `server/session-directory/projection.ts`, `server/sessions-sync/service.ts`, `server/sessions-sync/diff.ts`.

9. **Name:** Client API, session-window state, and selectors preserve semantic recency through fetch, search, and pagination.
   **Type:** integration
   **Harness:** `H5`
   **Preconditions:** Mocked session-directory pages and search responses use `lastActivityAt` and include search/pagination metadata.
   **Actions:** Call the API helpers, dispatch session-window thunks for initial load, search, and append pagination, and read selector output.
   **Expected outcome:** Grouped projects, oldest cursor state, search regrouping, and sidebar selector timestamps all use `lastActivityAt` consistently. Source of truth: `S4`, `S5`.
   **Interactions:** `src/lib/api.ts`, `src/store/sessionsSlice.ts`, `src/store/sessionsThunks.ts`, `src/store/selectors/sidebarSelectors.ts`.

10. **Name:** HistoryView, context-menu metadata, and Sidebar “Last used” display render from `lastActivityAt`.
    **Type:** integration
    **Harness:** `H6`
    **Preconditions:** Loaded client state includes session fixtures, active tabs, and context-menu targets.
    **Actions:** Render the views, inspect ordering and displayed timestamps, and trigger copied session metadata.
    **Expected outcome:** Rendered and copied “Last used”/`endDate` values derive from `lastActivityAt`, and no session UI still expects `updatedAt`. Source of truth: `S5`.
    **Interactions:** `src/components/HistoryView.tsx`, `src/components/context-menu/ContextMenuProvider.tsx`, `src/components/Sidebar.tsx`.

### Differential Tests
11. **Name:** Claude semantic and housekeeping records produce different recency outcomes.
    **Type:** differential
    **Harness:** `H1`
    **Preconditions:** Two Claude transcript fixtures are identical except that the final record is semantic in one fixture and housekeeping-only in the other.
    **Actions:** Parse both fixtures with `parseSessionContent()`.
    **Expected outcome:** Only the semantic variant advances `lastActivityAt`; both preserve existing title, summary, and token extraction behavior. Source of truth: `S1`, `S2`.
    **Interactions:** Claude parser helper predicates and timestamp extraction.

12. **Name:** Codex semantic and observation-only records produce different recency outcomes.
    **Type:** differential
    **Harness:** `H1`
    **Preconditions:** Two Codex transcript fixtures are identical except for the final record type.
    **Actions:** Parse both fixtures with `parseCodexSessionContent()`.
    **Expected outcome:** `session_meta`, visible response items, and allowed event messages advance `lastActivityAt`; `token_count` and `turn_context` do not. Source of truth: `S1`, `S2`.
    **Interactions:** Codex semantic allowlists, timestamp parser, task-event aggregation.

### Invariants
13. **Name:** No session-domain public contract surface still exposes `updatedAt`.
    **Type:** invariant
    **Harness:** `H7`
    **Preconditions:** The branch has completed the contract cut.
    **Actions:** Run `rg -n "\\bupdatedAt\\b" shared server src test scripts`, then inspect survivors and run targeted schema/type tests.
    **Expected outcome:** Any remaining `updatedAt` usage belongs only to non-session domains; session contracts expose only `lastActivityAt`. Source of truth: `S4`, `S6`.
    **Interactions:** Shared schemas, server/public contracts, client types, fallout files.

14. **Name:** Directory revision remains the max of session semantic recency and terminal metadata recency.
    **Type:** invariant
    **Harness:** `H2`
    **Preconditions:** One fixture set has terminal metadata newer than all sessions; another has session activity newer than all terminals.
    **Actions:** Query the session directory for both fixture sets.
    **Expected outcome:** Revision tracks the correct cross-domain maximum without reintroducing session `updatedAt`. Source of truth: `S3`, `S6`.
    **Interactions:** `server/session-directory/service.ts`, terminal metadata list, router responses.

### Boundary And Edge Cases
15. **Name:** Append-only truncated reparses are monotonic for `createdAt` and `lastActivityAt`.
    **Type:** boundary
    **Harness:** `H1`
    **Preconditions:** A cached session already has semantic clocks from a fuller parse; the next append-only parse sees only a truncated semantic subset.
    **Actions:** Refresh the same session twice with a growing file size and reduced semantic visibility on the second parse.
    **Expected outcome:** `createdAt` stays the same or moves earlier and `lastActivityAt` stays the same or moves later; neither regresses. Source of truth: `S2`.
    **Interactions:** `CodingCliSessionIndexer.updateCacheEntry()`, provider metadata, cache carry-forward logic.

16. **Name:** File shrink or resolved-session change breaks carry-forward and does not clamp old clocks onto new data.
    **Type:** boundary
    **Harness:** `H1`
    **Preconditions:** A cached session exists and the next refresh either shrinks the file or resolves to a different session identity.
    **Actions:** Refresh after the shrink or identity change.
    **Expected outcome:** Previous semantic clocks are not forced onto the new parse result. Source of truth: `S2`.
    **Interactions:** Size comparison, session identity resolution, cache replacement path.

17. **Name:** Equal-recency cursor ties remain deterministic across pages and providers.
    **Type:** boundary
    **Harness:** `H2`, `H4`
    **Preconditions:** Multiple sessions share the same `lastActivityAt`.
    **Actions:** Page through directory and pagination helpers across multiple pages.
    **Expected outcome:** Sorting remains stable by composite key, cursors do not skip or duplicate sessions, and provider ties behave deterministically. Source of truth: `S3`, `S4`.
    **Interactions:** Directory cursor encoding/decoding, pagination comparator, CLI/client paging helpers.

### Regressions
18. **Name:** OpenCode direct-provider sessions still participate in the unified recency contract.
    **Type:** regression
    **Harness:** `H1`
    **Preconditions:** `listSessionsDirect()` returns OpenCode rows sourced from `time_updated`.
    **Actions:** Index the direct-provider sessions and expose them through projects and public mappers.
    **Expected outcome:** Direct sessions surface `lastActivityAt`, sort correctly, and do not depend on file-based `mtime` fallback. Source of truth: `S2`, `S4`.
    **Interactions:** `server/coding-cli/providers/opencode.ts`, `server/coding-cli/session-indexer.ts`, public contract mappers.

19. **Name:** Visibility metadata and fallback tab timestamps survive the recency rename.
    **Type:** regression
    **Harness:** `H5`, `H6`
    **Preconditions:** Session fixtures include `sessionType`, `firstUserMessage`, `isSubagent`, `isNonInteractive`, plus fallback open-tab session items.
    **Actions:** Fetch/group the sessions, run selectors, and render the Sidebar.
    **Expected outcome:** Visibility filters still honor the same metadata, and fallback tab items still use tab `lastInputAt`/`createdAt` rather than session recency. Source of truth: `S5`, `S6`.
    **Interactions:** `src/lib/api.ts`, `src/store/sessionsThunks.ts`, `src/store/selectors/sidebarSelectors.ts`, `src/components/Sidebar.tsx`.

20. **Name:** Handshake and invalidation websocket tests remain snapshot-free after the contract cut.
    **Type:** regression
    **Harness:** `H3`
    **Preconditions:** A real websocket client connects through the hello/ready flow with snapshot-producing server fixtures available.
    **Actions:** Complete handshake, observe settings/bootstrap messages, then trigger a session invalidation.
    **Expected outcome:** No `sessions.updated` snapshot is sent during handshake or invalidation; only `settings.updated` and revision-only `sessions.changed` appear. Source of truth: `S3`, `S6`.
    **Interactions:** `server/ws-handler.ts`, websocket protocol, existing handshake and sidebar invalidation tests.

### Unit Tests
21. **Name:** Claude provider semantic clock extraction.
    **Type:** unit
    **Harness:** `H1`
    **Preconditions:** Direct JSONL strings cover init, user, assistant visible content, reasoning/tool/result content, usage-only assistant payloads, and `file-history-snapshot`.
    **Actions:** Call `parseSessionContent()` directly.
    **Expected outcome:** `createdAt` and `lastActivityAt` derive only from semantic records while current title/summary/token behavior stays intact. Source of truth: `S1`, `S2`.
    **Interactions:** `server/coding-cli/providers/claude.ts` helper logic.

22. **Name:** Codex provider semantic clock extraction and task-event coexistence.
    **Type:** unit
    **Harness:** `H1`
    **Preconditions:** Direct JSONL strings cover semantic and non-semantic Codex record types plus task events.
    **Actions:** Call `parseCodexSessionContent()` directly.
    **Expected outcome:** Semantic records set `createdAt`/`lastActivityAt`, non-semantic records do not, and `codexTaskEvents` still populate correctly. Source of truth: `S1`, `S2`.
    **Interactions:** `server/coding-cli/providers/codex.ts` parser helpers and allowlists.

23. **Name:** Session-directory projection comparable field list.
    **Type:** unit
    **Harness:** `H2`
    **Preconditions:** Paired sessions differ by visible and invisible fields.
    **Actions:** Call `toSessionDirectoryComparableItem()` and `hasSessionDirectorySnapshotChange()`.
    **Expected outcome:** Comparable items expose `lastActivityAt`, omit invisible metadata, and treat semantic recency as ordering-visible. Source of truth: `S3`.
    **Interactions:** `server/session-directory/projection.ts`, shared session-directory types.

24. **Name:** Client timestamp mapping smoke tests.
    **Type:** unit
    **Harness:** `H5`, `H6`
    **Preconditions:** Minimal session fixtures use `lastActivityAt`; fallback tab fixtures use `lastInputAt`.
    **Actions:** Run `buildSessionItems()` and render minimal timestamp-bearing UI.
    **Expected outcome:** Session-derived timestamps come from `lastActivityAt`, while fallback items remain tab-timestamp-driven. Source of truth: `S5`, `S6`.
    **Interactions:** `src/store/selectors/sidebarSelectors.ts`, `src/components/HistoryView.tsx`, `src/components/Sidebar.tsx`.

## Coverage Summary
This plan covers the full action space of the change:
- Semantic timestamp extraction for Claude, Codex, and OpenCode providers.
- Session indexer cache semantics, recency ordering, and monotonic carry-forward.
- Server consumers of session recency, including association and Codex activity tracking.
- Session-directory projection, cursoring, routing, revision calculation, and websocket invalidation.
- Search, pagination, CLI output, shared read-model schemas, and client API parsing.
- Client Redux state, selectors, and user-visible “Last used” rendering.
- Fallout and alias prevention so session-domain `updatedAt` does not survive the cut.

The plan intentionally avoids renderer-only flash tests. The root cause is bad session recency data entering the UI contract, so the primary confidence comes from scenario tests that prove touch-only file churn is invisible to the session directory and websocket invalidation layer, plus regression tests that ensure the renamed contract reaches every public and client-facing surface.

Broad verification should finish with:
- `npm run lint`
- `npm run typecheck`
- Focused server and client Vitest packs from the implementation tasks
- `npm run test:status`
- `FRESHELL_TEST_SUMMARY="semantic session recency contract" CI=true npm test`
