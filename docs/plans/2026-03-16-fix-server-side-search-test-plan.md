# Test Plan: Fix Server-Side Search

## Strategy Reconciliation

The implementation plan matches the testing strategy assumptions well. Key observations:

- **Harnesses are available.** The existing `service.test.ts` (unit, node env) and `session-directory-router.test.ts` (integration, node env with supertest) provide the two primary server-side test harnesses. The existing `Sidebar.test.tsx` (component, jsdom env) and `api.test.ts` / `sessionsThunks.test.ts` (unit, jsdom env) provide the client-side harnesses.
- **No external dependencies.** The search feature is entirely local -- it reads JSONL files from disk. No paid APIs or external services.
- **The `searchSessionFile` function is already well-tested** in `test/unit/server/session-search.test.ts` for both Claude and Codex providers. We can rely on it as a proven building block and focus new tests on the integration with the session-directory service.
- **The `Sidebar.test.tsx` already has search tier UI tests** (tier selector rendering, hiding, default value, loading state). These exist and cover the UI surface. We will extend them for the tier-forwarding behavior.
- **No strategy changes required.** The plan uses existing test infrastructure throughout and does not need paid services, new infrastructure, or material scope changes.

## Harness Requirements

No new harnesses need to be built. All tests use existing infrastructure:

| Harness | File(s) | What it exposes | Tests that depend on it |
|---------|---------|-----------------|------------------------|
| **Session-directory service unit harness** | `test/unit/server/session-directory/service.test.ts` | Direct calls to `querySessionDirectory()` with in-memory `ProjectGroup[]` and real temp JSONL files. Node environment. | Tests 1-8 |
| **Session-directory router integration harness** | `test/integration/server/session-directory-router.test.ts` | Express app with `createSessionsRouter()` exercised via supertest HTTP requests. Node environment. | Tests 9-13 |
| **Client API unit harness** | `test/unit/client/lib/api.test.ts` | Mocked `global.fetch`, direct calls to `searchSessions()` and `getSessionDirectoryPage()`. jsdom environment. | Tests 14-16 |
| **Client thunks unit harness** | `test/unit/client/store/sessionsThunks.test.ts` | Mocked `searchSessions`/`fetchSidebarSessionsSnapshot`, Redux store with `sessionsReducer`. jsdom environment. | Tests 17-18 |
| **Sidebar component harness** | `test/unit/client/components/Sidebar.test.tsx` | Full React component rendered with Provider, mocked API layer, Testing Library queries. jsdom environment. | Tests 19-22 |
| **Shared schema unit harness** | `test/unit/shared/` (new file in existing directory) | Direct Zod schema `.parse()` calls. jsdom environment. | Tests 23-27 |

---

## Test Plan

### 1. userMessages tier finds matches in user messages via the session-directory service

- **Type:** integration
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** A temp JSONL file containing a user message with "authentication" and an assistant message without it. A `ProjectGroup` with one session pointing to this file via `sourceFile`.
- **Actions:** Call `querySessionDirectory({ projects, terminalMeta: [], providers: [claudeProvider], query: { priority: 'visible', query: 'authentication', tier: 'userMessages' } })`.
- **Expected outcome:** `page.items` has length 1. `page.items[0].matchedIn` equals `'userMessage'`. `page.items[0].snippet` contains `'authentication'`. Source of truth: implementation plan contract 2 ("userMessages tier streams each JSONL session file, searching only message.user events").
- **Interactions:** Exercises `searchSessionFile` from `session-search.ts` and the Claude provider's `parseEvent`.

### 2. userMessages tier does NOT match assistant messages

- **Type:** integration
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** A temp JSONL file where "authentication" appears only in an assistant message, not in user messages. A `ProjectGroup` with one session pointing to this file.
- **Actions:** Call `querySessionDirectory({ ..., query: { priority: 'visible', query: 'authentication', tier: 'userMessages' } })`.
- **Expected outcome:** `page.items` has length 0. Source of truth: implementation plan contract 2 (searches "only `message.user` events").
- **Interactions:** Same as test 1.

### 3. fullText tier finds matches in assistant messages

- **Type:** integration
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** Same JSONL file as test 2 (match only in assistant message).
- **Actions:** Call `querySessionDirectory({ ..., query: { priority: 'visible', query: 'authentication', tier: 'fullText' } })`.
- **Expected outcome:** `page.items` has length 1. `page.items[0].matchedIn` equals `'assistantMessage'`. Source of truth: implementation plan contract 3 ("fullText tier streams each JSONL session file, searching both message.user and message.assistant events").
- **Interactions:** Same as test 1.

### 4. title tier works without file I/O and does not require providers

- **Type:** regression
- **Disposition:** extend (extends existing "searches titles and snippets on the server" test)
- **Harness:** Session-directory service unit harness
- **Preconditions:** Sessions with metadata but no `sourceFile`. No `providers` in input.
- **Actions:** Call `querySessionDirectory({ projects, terminalMeta: [], query: { priority: 'visible', query: 'deploy', tier: 'title' } })`. (Note: no `providers` field.)
- **Expected outcome:** Returns matching sessions with `matchedIn` in `['title', 'summary', 'firstUserMessage']`. Snippet is non-empty and bounded at 140 chars. Source of truth: implementation plan contract 1 ("title tier searches title, summary, and firstUserMessage metadata fields only -- no file I/O").
- **Interactions:** None beyond existing metadata search.

### 5. file-based search skips sessions without sourceFile

- **Type:** boundary
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** A `ProjectGroup` with a session that has no `sourceFile`.
- **Actions:** Call `querySessionDirectory({ ..., providers: [claudeProvider], query: { priority: 'visible', query: 'anything', tier: 'userMessages' } })`.
- **Expected outcome:** `page.items` has length 0. No errors thrown. Source of truth: implementation plan boundary condition ("Sessions without sourceFile are skipped in file-based tiers").
- **Interactions:** None (the search should not reach `searchSessionFile`).

### 6. file-based search handles missing files gracefully

- **Type:** boundary
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** A session whose `sourceFile` is `/nonexistent/path.jsonl`.
- **Actions:** Call `querySessionDirectory({ ..., query: { priority: 'visible', query: 'anything', tier: 'fullText' } })`.
- **Expected outcome:** `page.items` has length 0. No exception thrown. Source of truth: implementation plan boundary condition ("File read errors... don't abort the entire search").
- **Interactions:** Exercises OS-level file open error path.

### 7. file-based search respects abort signals

- **Type:** boundary
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** A valid JSONL session file. An `AbortController` that is aborted before the call.
- **Actions:** Call `querySessionDirectory({ ..., tier: 'userMessages', signal: controller.signal })` with a pre-aborted signal.
- **Expected outcome:** The promise rejects with an error matching `/aborted/i`. Source of truth: implementation plan contract 7 ("Abort signals propagate through to file streaming").
- **Interactions:** Exercises abort signal checking in the service layer.

### 8. file-based search respects page limit and provides cursor for pagination

- **Type:** integration
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** 5 sessions, each with a JSONL file containing "needle" in a user message.
- **Actions:** Call `querySessionDirectory({ ..., query: { priority: 'visible', query: 'needle', tier: 'userMessages', limit: 2 } })`.
- **Expected outcome:** `page.items` has length 2. `page.nextCursor` is truthy. Source of truth: implementation plan contract 6 ("Cursor pagination works for all tiers").
- **Interactions:** Exercises the scan budget and cursor encoding for file-based tiers.

### 9. HTTP route forwards tier=userMessages and returns file-based matches

- **Type:** integration
- **Disposition:** new
- **Harness:** Session-directory router integration harness
- **Preconditions:** Express app with `createSessionsRouter()` configured with projects containing JSONL session files and `codingCliProviders: [claudeProvider]`.
- **Actions:** `GET /api/session-directory?priority=visible&query=authentication&tier=userMessages` via supertest.
- **Expected outcome:** HTTP 200. `res.body.items` contains session with `matchedIn: 'userMessage'`. Source of truth: implementation plan Task 2 (plumb tier through HTTP route) and contract 2.
- **Interactions:** Exercises the router parsing `tier` from query string, the Zod schema validation, and the full service call path.

### 10. HTTP route forwards tier=fullText and finds assistant message matches

- **Type:** integration
- **Disposition:** new
- **Harness:** Session-directory router integration harness
- **Preconditions:** Same as test 9 but with a keyword that appears only in an assistant message.
- **Actions:** `GET /api/session-directory?priority=visible&query=secret_keyword&tier=fullText` via supertest.
- **Expected outcome:** HTTP 200. `res.body.items` contains session with `matchedIn: 'assistantMessage'`. Source of truth: contract 3.
- **Interactions:** Same as test 9.

### 11. HTTP route defaults to title tier when tier parameter is omitted

- **Type:** regression
- **Disposition:** extend (extends existing "searches through the same route family" test)
- **Harness:** Session-directory router integration harness
- **Preconditions:** Standard projects fixture (no JSONL files needed).
- **Actions:** `GET /api/session-directory?priority=visible&query=deploy` (no `tier` param) via supertest.
- **Expected outcome:** HTTP 200. Results match based on title/summary/firstUserMessage metadata, same as current behavior. Source of truth: implementation plan ("Adding tier as an optional field with default('title') ... is backward-compatible").
- **Interactions:** Confirms backward compatibility of the schema change.

### 12. HTTP route rejects unknown tier values with 400

- **Type:** boundary
- **Disposition:** new
- **Harness:** Session-directory router integration harness
- **Preconditions:** Standard app fixture.
- **Actions:** `GET /api/session-directory?priority=visible&tier=bogus` via supertest.
- **Expected outcome:** HTTP 400 with error details. Source of truth: Zod enum validation on the `tier` field.
- **Interactions:** Exercises schema validation in the router.

### 13. HTTP route passes providers to querySessionDirectory for file-based search

- **Type:** integration
- **Disposition:** new
- **Harness:** Session-directory router integration harness
- **Preconditions:** App fixture with a custom `readModelScheduler` spy that captures the `run` function arguments. Projects with sessions that have `sourceFile`.
- **Actions:** `GET /api/session-directory?priority=visible&query=test&tier=userMessages` via supertest.
- **Expected outcome:** The scheduler's `run` callback receives `providers` in its input. Source of truth: implementation plan Task 3 step 2c ("Update sessions-router.ts to pass providers").
- **Interactions:** Validates the router-to-service wiring for providers.

### 14. Client searchSessions includes tier in the session-directory URL

- **Type:** unit
- **Disposition:** new
- **Harness:** Client API unit harness
- **Preconditions:** Mocked `global.fetch` returning a valid session-directory page.
- **Actions:** Call `searchSessions({ query: 'test', tier: 'fullText' })`.
- **Expected outcome:** `fetch` was called with a URL containing `tier=fullText`. Source of truth: implementation plan Task 2 ("Pass tier to getSessionDirectoryPage in the searchSessions function").
- **Interactions:** Exercises the `getSessionDirectoryPage` URL building.

### 15. Client searchSessions omits tier from URL when tier is 'title' (the default)

- **Type:** unit
- **Disposition:** new
- **Harness:** Client API unit harness
- **Preconditions:** Mocked `global.fetch`.
- **Actions:** Call `searchSessions({ query: 'test', tier: 'title' })`.
- **Expected outcome:** `fetch` was called with a URL that does NOT contain `tier=`. Source of truth: implementation plan Task 2 note ("we omit tier from the URL when it equals title ... to keep URLs clean").
- **Interactions:** Same as test 14.

### 16. Client searchSessions defaults tier to 'title' when not specified

- **Type:** unit
- **Disposition:** extend (extends existing "preserves search visibility metadata" test)
- **Harness:** Client API unit harness
- **Preconditions:** Mocked `global.fetch`.
- **Actions:** Call `searchSessions({ query: 'test' })` without specifying tier.
- **Expected outcome:** `fetch` was called with a URL that does NOT contain `tier=`. The response `tier` field defaults to `'title'`. Source of truth: implementation plan ("tier defaults to title").
- **Interactions:** Same as test 14.

### 17. Redux thunk passes tier to searchSessions when a query is active

- **Type:** unit
- **Disposition:** new
- **Harness:** Client thunks unit harness
- **Preconditions:** Store with `setActiveSessionSurface('sidebar')`. `searchSessions` mock.
- **Actions:** Dispatch `fetchSessionWindow({ surface: 'sidebar', priority: 'visible', query: 'needle', searchTier: 'userMessages' })`.
- **Expected outcome:** `searchSessions` was called with `{ query: 'needle', tier: 'userMessages', signal: expect.any(AbortSignal) }`. Source of truth: implementation plan Task 5 ("passes tier to searchSessions when a query is active").
- **Interactions:** Exercises the thunk-to-API bridge.

### 18. Redux thunk defaults searchTier to 'title' when not provided

- **Type:** unit
- **Disposition:** extend (extends existing load test)
- **Harness:** Client thunks unit harness
- **Preconditions:** Store with active surface. `searchSessions` mock.
- **Actions:** Dispatch `fetchSessionWindow({ surface: 'sidebar', priority: 'visible', query: 'needle' })` without `searchTier`.
- **Expected outcome:** `searchSessions` was called with `tier: 'title'`. Source of truth: implementation plan defaults.
- **Interactions:** Same as test 17.

### 19. Sidebar shows tier dropdown when search input has text

- **Type:** scenario
- **Disposition:** existing
- **Harness:** Sidebar component harness
- **Preconditions:** Rendered Sidebar with standard store.
- **Actions:** Query for tier selector -- expect not present. Type "test" into search input.
- **Expected outcome:** Tier selector (combobox with `aria-label="Search tier"`) appears. Source of truth: Sidebar component behavior per implementation plan Task 6.
- **Interactions:** Exercises React state and conditional rendering.

### 20. Sidebar hides tier dropdown when search is cleared

- **Type:** scenario
- **Disposition:** existing
- **Harness:** Sidebar component harness
- **Preconditions:** Sidebar with text in search input.
- **Actions:** Clear the search input.
- **Expected outcome:** Tier selector disappears. Source of truth: same as test 19.
- **Interactions:** Same as test 19.

### 21. Sidebar defaults to title tier

- **Type:** scenario
- **Disposition:** existing
- **Harness:** Sidebar component harness
- **Preconditions:** Rendered Sidebar with standard store.
- **Actions:** Type text into search input. Read the tier selector's value.
- **Expected outcome:** Value is `'title'`. Source of truth: `useState<'title' | 'userMessages' | 'fullText'>('title')` in Sidebar.tsx.
- **Interactions:** None.

### 22. Sidebar dispatches search with the selected tier via fetchSessionWindow

- **Type:** scenario
- **Disposition:** new
- **Harness:** Sidebar component harness
- **Preconditions:** Rendered Sidebar with mocked `searchSessions`. Store with active surface.
- **Actions:** Type "needle" into search input. Change tier selector to `'userMessages'`. Advance timers past the 300ms debounce.
- **Expected outcome:** `searchSessions` mock was called with `expect.objectContaining({ tier: 'userMessages' })`. Source of truth: implementation plan Task 6 ("dispatches search with the selected tier").
- **Interactions:** Exercises the full Sidebar -> dispatch -> thunk -> API mock chain.

### 23. SessionDirectoryQuerySchema accepts 'title' tier

- **Type:** unit
- **Disposition:** new
- **Harness:** Shared schema unit harness
- **Preconditions:** None.
- **Actions:** `SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'title' })`.
- **Expected outcome:** Parses without error. `result.tier` equals `'title'`. Source of truth: implementation plan Task 1 schema change.
- **Interactions:** None.

### 24. SessionDirectoryQuerySchema accepts 'userMessages' tier

- **Type:** unit
- **Disposition:** new
- **Harness:** Shared schema unit harness
- **Preconditions:** None.
- **Actions:** `SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'userMessages' })`.
- **Expected outcome:** Parses without error. `result.tier` equals `'userMessages'`. Source of truth: same as test 23.
- **Interactions:** None.

### 25. SessionDirectoryQuerySchema accepts 'fullText' tier

- **Type:** unit
- **Disposition:** new
- **Harness:** Shared schema unit harness
- **Preconditions:** None.
- **Actions:** `SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'fullText' })`.
- **Expected outcome:** Parses without error. `result.tier` equals `'fullText'`. Source of truth: same as test 23.
- **Interactions:** None.

### 26. SessionDirectoryQuerySchema defaults to 'title' when tier is omitted

- **Type:** unit
- **Disposition:** new
- **Harness:** Shared schema unit harness
- **Preconditions:** None.
- **Actions:** `SessionDirectoryQuerySchema.parse({ priority: 'visible' })`.
- **Expected outcome:** Parses without error. `result.tier` equals `'title'`. Source of truth: implementation plan ("defaults to title").
- **Interactions:** None.

### 27. SessionDirectoryQuerySchema rejects unknown tier values

- **Type:** boundary
- **Disposition:** new
- **Harness:** Shared schema unit harness
- **Preconditions:** None.
- **Actions:** `SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'bogus' })`.
- **Expected outcome:** Throws Zod validation error. Source of truth: Zod enum constraint.
- **Interactions:** None.

### 28. SessionDirectoryItemSchema accepts 'userMessage' matchedIn

- **Type:** unit
- **Disposition:** new
- **Harness:** Shared schema unit harness
- **Preconditions:** None.
- **Actions:** `SessionDirectoryItemSchema.parse({ sessionId: 'test', provider: 'claude', projectPath: '/test', lastActivityAt: 1000, isRunning: false, matchedIn: 'userMessage' })`.
- **Expected outcome:** Parses without error. `result.matchedIn` equals `'userMessage'`. Source of truth: implementation plan contract 8 ("matchedIn enum adds 'userMessage' and 'assistantMessage' variants").
- **Interactions:** None.

### 29. SessionDirectoryItemSchema accepts 'assistantMessage' matchedIn

- **Type:** unit
- **Disposition:** new
- **Harness:** Shared schema unit harness
- **Preconditions:** None.
- **Actions:** Same as test 28 with `matchedIn: 'assistantMessage'`.
- **Expected outcome:** Parses without error. `result.matchedIn` equals `'assistantMessage'`. Source of truth: same as test 28.
- **Interactions:** None.

### 30. SessionDirectoryItemSchema continues to accept existing matchedIn values

- **Type:** regression
- **Disposition:** new
- **Harness:** Shared schema unit harness
- **Preconditions:** None.
- **Actions:** Parse with each of `['title', 'summary', 'firstUserMessage']` as `matchedIn`.
- **Expected outcome:** All parse without error. Source of truth: backward compatibility requirement.
- **Interactions:** None.

### 31. Sort order is preserved for file-based search results

- **Type:** invariant
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** 3 sessions with different `lastActivityAt` values, all matching in user messages. One is archived.
- **Actions:** Call `querySessionDirectory` with `tier: 'userMessages'`.
- **Expected outcome:** Results are ordered: non-archived by `lastActivityAt` descending, then archived by `lastActivityAt` descending. Source of truth: implementation plan contract 4 ("Sort order is canonical").
- **Interactions:** Exercises the ordering logic in `applyFileSearch`.

### 32. file-based search with Codex provider finds user messages

- **Type:** integration
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** A temp JSONL file in Codex format (e.g., `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"auth bug"}]}}`). Session has `provider: 'codex'`.
- **Actions:** Call `querySessionDirectory({ ..., providers: [codexProvider], query: { ..., query: 'auth bug', tier: 'userMessages' } })`.
- **Expected outcome:** `page.items` has length 1. `page.items[0].matchedIn` equals `'userMessage'`. Source of truth: contract 2 + existing `searchSessionFile` Codex test in `session-search.test.ts`.
- **Interactions:** Exercises multi-provider support in the service layer.

### 33. file-based search skips sessions with unknown provider

- **Type:** boundary
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** A session with `provider: 'unknown-cli'` and a valid `sourceFile`. Providers list contains only `claudeProvider`.
- **Actions:** Call `querySessionDirectory({ ..., query: { ..., tier: 'userMessages' } })`.
- **Expected outcome:** `page.items` has length 0. No error thrown. Source of truth: implementation plan boundary condition ("Sessions whose provider is unknown are skipped").
- **Interactions:** Tests the provider lookup map.

### 34. fullText tier prefers user message match over assistant when both contain the term

- **Type:** integration
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** A JSONL file where the user message comes first and contains "deploy", followed by an assistant message also containing "deploy".
- **Actions:** Call `querySessionDirectory({ ..., tier: 'fullText', query: 'deploy' })`.
- **Expected outcome:** `page.items[0].matchedIn` equals `'userMessage'` (because `searchSessionFile` returns on first hit, and user message is first in the file). Source of truth: contract 3 ("Returns on first hit per session") combined with JSONL ordering.
- **Interactions:** Validates early-return behavior.

### 35. Sidebar search triggers re-dispatch when tier changes

- **Type:** scenario
- **Disposition:** new
- **Harness:** Sidebar component harness
- **Preconditions:** Sidebar rendered with text in search. First search dispatched with tier='title'. Mock settled.
- **Actions:** Change tier selector to 'fullText'. Advance timers past debounce.
- **Expected outcome:** `searchSessions` mock is called again with `tier: 'fullText'`. Source of truth: Sidebar `useEffect` dependency on `searchTier` (line 243 of Sidebar.tsx).
- **Interactions:** Exercises the debounce re-trigger on tier change.

### 36. Performance: title-tier search completes under 50ms for 1000 sessions

- **Type:** unit
- **Disposition:** new
- **Harness:** Session-directory service unit harness
- **Preconditions:** 1000 in-memory sessions with titles.
- **Actions:** Time `querySessionDirectory({ ..., tier: 'title', query: 'deploy' })`.
- **Expected outcome:** Completes in under 50ms. Source of truth: title tier is metadata-only with no file I/O. A generous 50ms threshold catches catastrophic regressions (O(n^2) sorting, accidental file access) without being flaky on CI.
- **Interactions:** None.

---

## Coverage Summary

### Covered areas

| Area | Tests | Coverage |
|------|-------|----------|
| **Schema changes** (`shared/read-models.ts`) | 23-30 | All new `tier` values, default, rejection, all new `matchedIn` values, backward compat |
| **Service layer: title tier** | 4 | Regression -- unchanged path still works without providers |
| **Service layer: userMessages tier** | 1, 2, 5, 6, 7, 8, 31, 32, 33 | Match, no-match, skip-no-file, skip-missing-file, abort, pagination, sort order, Codex provider, unknown provider |
| **Service layer: fullText tier** | 3, 34 | Match in assistant, first-hit preference |
| **HTTP route** | 9, 10, 11, 12, 13 | Tier forwarding, default, rejection, provider wiring |
| **Client API layer** | 14, 15, 16 | Tier in URL, omission for default, default when unspecified |
| **Redux thunks** | 17, 18 | Tier forwarding, default |
| **Sidebar UI** | 19, 20, 21, 22, 35 | Dropdown show/hide, default, dispatch with tier, re-dispatch on change |
| **Performance** | 36 | Title-tier latency guard |

### Explicitly excluded per strategy

| Area | Reason | Risk |
|------|--------|------|
| **Terminal search** (`TerminalSearchBar`, `searchTerminalView`) | Out of scope per plan | None -- separate feature |
| **Old `searchSessions` orchestrator in `session-search.ts`** | Being deprecated, not deleted. Already has tests. | Low -- existing tests cover it |
| **Client-side `filterSessionItems` in `sidebarSelectors.ts`** | Not modified by this change. Sidebar window bypasses local filter when results exist. | Low |
| **`docs/index.html`** | No changes per scope notes | None |
| **File-based search performance** (userMessages/fullText tiers) | Low risk -- `searchSessionFile` streams JSONL with readline, bounded by scan budget. The `maxScan = limit * 10` ensures bounded I/O. A dedicated perf test would require representative large JSONL files. | Low -- bounded by architecture. If real perf issues surface, add benchmarks later. |
| **WebSocket broadcast of search results** | Search is HTTP-only, not WebSocket-driven | None |
