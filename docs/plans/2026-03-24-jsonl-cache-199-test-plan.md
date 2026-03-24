# Test Plan: Issue #199 -- JSONL Cache & Path Resolution

## Overview

~49 tests across 12 files. Tests emphasize real `.jsonl` files (read-only from `~/.claude` where available), I/O counting proxies that pass through to the real filesystem, adversarial scenarios (file mutation mid-read, deletion between stat-and-read, rapid mtime churn, concurrent invalidation during coalesced reads), stress tests (50 concurrent session opens, writer/reader races, eviction storms), full-stack E2E (WebSocket sdk.create/sdk.attach flows, HTTP timeline requests), and performance assertions (resolver vs scan 5x+ faster, stat budget <50ms for 100 sessions).

All server-side tests run under `vitest.server.config.ts` (node environment). Client-side tests run under the default `vitest.config.ts` (jsdom environment).

---

## Shared Helpers & Utilities

### `createJsonlContent(messages)` helper

A reusable helper function (defined locally in each test file or extracted to a shared location if 3+ files need it) that builds valid `.jsonl` content from an array of `{role, text, timestamp?}` objects. Follows the structured format used by Claude Code session files.

```ts
function createJsonlContent(
  messages: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: string }>,
): string {
  return messages
    .map((m, i) =>
      JSON.stringify({
        type: m.role,
        message: { role: m.role, content: [{ type: 'text', text: m.text }] },
        timestamp: m.timestamp ?? `2026-01-01T00:00:${String(i + 1).padStart(2, '0')}Z`,
      }),
    )
    .join('\n')
}
```

### I/O counting proxy pattern

Used in integration tests to measure filesystem calls without mocking. Wraps real `fsp` functions with counters:

```ts
function createIoCountingProxy() {
  const counts = { readdir: 0, readFile: 0, stat: 0 }
  const originalReaddir = fsp.readdir
  const originalReadFile = fsp.readFile
  const originalStat = fsp.stat

  const proxy = {
    install() {
      vi.spyOn(fsp, 'readdir').mockImplementation((...args: any[]) => {
        counts.readdir++
        return originalReaddir.apply(fsp, args)
      })
      // Similar for readFile, stat
    },
    restore() { vi.restoreAllMocks() },
    counts,
  }
  return proxy
}
```

### Temp directory pattern (from existing codebase)

All tests that touch the filesystem use `fsp.mkdtemp` + cleanup in `afterEach`, matching the convention in `session-history-loader.test.ts` and `session-cache.test.ts`.

### Real `.jsonl` file discovery

Integration tests that want real data use a helper that searches `~/.claude/projects/` for any `.jsonl` file and skips the test if none are found:

```ts
async function findRealJsonlFile(): Promise<string | null> {
  const claudeHome = process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude')
  const projectsDir = path.join(claudeHome, 'projects')
  // breadth-first search for first .jsonl file, return path or null
}
```

---

## Layer 1: Path Resolution

### File: `test/unit/server/session-history-loader-path-resolution.test.ts`

**Config:** `vitest.server.config.ts` (node environment)
**Data:** Synthetic `.jsonl` files in temp directories
**Setup:** `beforeEach` creates temp dir with `fsp.mkdtemp`; `afterEach` cleans up with `fsp.rm`
**Pattern:** Matches existing `session-history-loader.test.ts` structure exactly

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `resolveFilePath returns a path => skips directory scan, reads file directly` | When the resolver returns a valid path, `loadSessionHistory` reads that file without listing directories | `vi.spyOn(fsp, 'readdir')` not called; messages returned correctly from the resolved path |
| 2 | `resolveFilePath returns undefined => falls back to directory scan` | The existing scan behavior still works when the resolver cannot find the session | Set up standard project directory structure; resolver returns `undefined`; messages found via scan |
| 3 | `resolveFilePath returns a path that does not exist => falls back to scan` | When the resolver points to a nonexistent file, the function falls back gracefully | resolver returns `/tmp/.../nonexistent.jsonl`; real file exists in project dir; messages found via scan; no throw |
| 4 | `path traversal protection still applies when resolver is present` | Security validation runs before the resolver is called | `sessionId: '../etc/passwd'` with a resolver spy; returns `null`; resolver spy never called |
| 5 | `resolver path is trusted (reads whatever it points to)` | The function trusts the resolver's path and reads the file at that location | resolver points to file with different content than what scan would find; returned messages match resolver's file |
| 6 | `resolver is not called when sessionId fails validation` | Invalid session IDs short-circuit before resolver invocation | resolver spy; `sessionId: 'foo/bar'`; returns `null`; resolver never called |

---

### File: `test/integration/server/session-history-io-reduction.test.ts`

**Config:** `vitest.server.config.ts` (node environment)
**Data:** Synthetic filesystem layout mimicking real `~/.claude/projects/` structure; also tests with real indexer
**Setup:** Creates temp dir with multiple project subdirectories; I/O counting proxy installed in `beforeEach`
**Teardown:** Proxy restored, temp dir cleaned up

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `with resolver: zero readdir calls for known session` | Path resolution completely eliminates directory scanning | Create 10+ project dirs with files; call `loadSessionHistory` with resolver pointing to correct file; `counts.readdir === 0` |
| 2 | `without resolver: N readdir calls (baseline measurement)` | Establishes baseline I/O cost of the scan approach | Same layout; no resolver; `counts.readdir >= projectDirCount` (at least one readdir per project dir) |
| 3 | `resolver reduces wall-clock time by 5x+ for 50-directory layout` | Performance improvement is significant with many directories | Create 50 project directories; session file in the last one; `performance.now()` around both approaches; `scanTime / resolverTime >= 5` |
| 4 | `stat budget: resolving 100 sessions costs < 50ms total` | Bulk resolution stays within performance budget | Create 100 session files in temp dir; resolver returns correct path for each; time 100 sequential `loadSessionHistory` calls; `totalMs < 50` |
| 5 | `resolver works correctly with real CodingCliSessionIndexer` | End-to-end integration with the actual indexer class | Create temp Claude home with project dirs and session files; instantiate real `CodingCliSessionIndexer` with a test provider; wait for indexing; call `loadSessionHistory` with `indexer.getFilePathForSession` as resolver; assert correct messages returned |

---

## Layer 2: Parsed Content Cache

### File: `test/unit/server/session-content-cache.test.ts`

**Config:** `vitest.server.config.ts` (node environment)
**Data:** Synthetic `.jsonl` files in temp directories
**Setup:** `beforeEach` creates temp dir, instantiates `SessionContentCache`; `afterEach` cleans up
**Pattern:** Follows `session-cache.test.ts` structure (the existing `SessionCache` tests)

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `cache hit: second get() returns cached messages without re-reading file` | Cached entries avoid filesystem reads | `vi.spyOn(fsp, 'readFile')`; `cache.get(path)` twice; `readFile` called once; both results deep-equal |
| 2 | `cache miss on mtime change: re-reads file after modification` | Modified files are detected and re-read | `cache.get(path)`; append line to file (wait 100ms for mtime resolution); `cache.get(path)` again; second result includes new message |
| 3 | `cache miss on size change: re-reads when size differs` | Size changes trigger re-reads even if mtime somehow matches | `cache.get(path)`; overwrite file with longer content; `cache.get(path)` again; returns updated messages |
| 4 | `stat error (file deleted): returns null and evicts entry` | Deleted files return null and remove cache entry | `cache.get(path)`; `fsp.unlink(path)`; `cache.get(path)` returns `null`; `cache.stats().entries` decreased |
| 5 | `LRU eviction: oldest entries evicted when over budget` | Memory budget is enforced via LRU eviction | Create cache with `maxBytes: 2048`; add 3 files each ~1KB; assert `cache.stats().entries <= 2`; first file evicted |
| 6 | `size tracking: totalBytes updated on insert and eviction` | `stats().totalBytes` accurately reflects cache contents | Insert entries; check `totalBytes > 0`; trigger eviction; check `totalBytes` decreased |
| 7 | `invalidate() removes specific entry` | Manual invalidation forces re-read on next access | `cache.get(path)`; `cache.invalidate(path)`; `vi.spyOn(fsp, 'readFile')`; `cache.get(path)` reads file again |
| 8 | `clear() removes all entries` | Bulk invalidation works | Add 3 entries; `cache.clear()`; `cache.stats().entries === 0`; `cache.stats().totalBytes === 0` |
| 9 | `empty .jsonl file returns empty array (not null)` | Empty files are valid and cacheable | Create empty file; `cache.get(path)` returns `[]` not `null` |
| 10 | `malformed JSONL caches partial result` | Files with mixed valid/invalid lines cache what they can parse | File with valid line, garbage line, valid line; first `get()` returns 2 messages; second `get()` returns same 2 messages without re-reading |

---

### File: `test/unit/server/session-cache-races.test.ts`

**Config:** `vitest.server.config.ts` (node environment)
**Data:** Synthetic; some tests use controlled mocks to simulate race conditions
**Setup:** Per-test cache instances with small budgets

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `file deleted between stat and read: returns null gracefully` | ENOENT during read after successful stat is handled | `vi.spyOn(fsp, 'stat')` returns valid stat; `vi.spyOn(fsp, 'readFile')` throws `ENOENT`; `cache.get()` returns `null`; no entry cached |
| 2 | `rapid mtime churn: cache correctly invalidates on every change` | Fast consecutive writes all produce correct reads | Write file; `cache.get()`; loop 10 times: append line, wait 10ms, `cache.get()`; each result has correct message count |
| 3 | `concurrent invalidation during coalesced read: next caller gets fresh data` | Invalidation during an inflight read causes the next read to re-fetch | Start a slow read (proxy `readFile` with a 50ms delay); call `cache.get()` to start inflight; call `cache.invalidate()` before it completes; await first result; call `cache.get()` again; assert second read triggers a new `readFile` call |
| 4 | `coalesced read fails: all waiters receive null` | When the shared read throws, all coalesced promises resolve to null | `vi.spyOn(fsp, 'readFile')` throws on first call; fire 5 concurrent `cache.get()` calls; all 5 resolve to `null` |

---

### File: `test/integration/server/session-content-cache-real.test.ts`

**Config:** `vitest.server.config.ts` (node environment)
**Data:** Real `.jsonl` files from `~/.claude` (read-only) + synthetic files in temp dirs
**Setup:** Discovers real `.jsonl` file via helper; creates temp dir for mutation tests
**Skip condition:** Tests using real files skip with `it.skipIf(!realFilePath)` when no real `.jsonl` files exist

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `real .jsonl file from ~/.claude: reads and caches correctly` | Cache works with actual Claude session data | Find real file; `cache.get()` twice; both return same non-null array with `length > 0`; `readFile` spy called once |
| 2 | `concurrent reads coalesce into single file read` | Request coalescing works under real I/O | `Promise.all([cache.get(path), cache.get(path), ...(10 times)])`; `readFile` spy called exactly once; all 10 results deep-equal |
| 3 | `file mutation mid-read: next call sees updated content` | Cache detects changes to files that were previously cached | Copy real file to temp dir; `cache.get(tempCopy)` to populate cache; append a valid JSONL line; `cache.get(tempCopy)` returns array with one more message |
| 4 | `cache respects maxBytes across real session files` | Eviction works correctly with real (potentially large) files | Create cache with `maxBytes: 50_000`; load multiple real files; `cache.stats().totalBytes <= maxBytes * 1.1` (allow 10% overshoot for single-entry granularity) |

---

### File: `test/integration/server/session-cache-stress.test.ts`

**Config:** `vitest.server.config.ts` (node environment)
**Data:** Synthetic `.jsonl` files in temp directories
**Setup:** Creates temp dir; generates batch of files; higher timeout (`vi.setConfig({ testTimeout: 30_000 })`)

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `50 concurrent session opens with cache: all resolve correctly` | Cache handles high concurrency without data corruption | Create 50 temp `.jsonl` files with distinct content; `Promise.all(files.map(f => loadSessionHistoryWithCache(f)))` via resolver + cache; all 50 return correct messages matching their file content |
| 2 | `rapid writer/reader race: reader always gets consistent snapshot` | Concurrent reads during writes never return torn/partial data | Writer appends lines to a file every 5ms; reader calls `cache.get()` every 10ms for 500ms; every non-null result has consistent message count (each message array is a valid prefix of the append-only file) |
| 3 | `eviction storm: 200 unique files exceed budget, cache stays bounded` | Memory budget holds under rapid churn | Create cache with `maxBytes: 10_000`; load 200 files (~200 bytes each); `cache.stats().totalBytes <= 10_000 * 1.1` at all times; final `cache.stats().entries < 200` |
| 4 | `mixed concurrent invalidation and reads: no crashes or deadlocks` | Arbitrary interleaving of operations is safe | `Promise.all([...20 reads, ...20 invalidates, ...10 clears])` on random files; all promises settle without throwing; no unhandled rejections |

---

## Layer 3: Timeline Response Batching

### File: `test/unit/server/agent-timeline-include-bodies.test.ts`

**Config:** `vitest.server.config.ts` (node environment)
**Data:** Synthetic message arrays via `vi.fn().mockResolvedValue(...)`
**Setup:** Creates `AgentTimelineService` via `createAgentTimelineService()` with mocked `loadSessionHistory`
**Pattern:** Matches existing `test/unit/server/agent-timeline/service.test.ts` structure

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `includeBodies=false (default): no bodies field in response` | Default behavior unchanged | Call `getTimelinePage({ sessionId, priority: 'visible' })` without `includeBodies`; response has `items` array; response does NOT have `bodies` key |
| 2 | `includeBodies=true: bodies map includes all page items` | Bodies are populated when requested | Call with `includeBodies: true`; `Object.keys(response.bodies).length === response.items.length`; each body has full `message.content` array |
| 3 | `bodies map keys match item turnIds` | Keys are consistent between items and bodies | `Object.keys(response.bodies)` equals `response.items.map(i => i.turnId)` (as a set) |
| 4 | `paginated request with includeBodies: only includes bodies for current page` | Bodies are scoped to the page, not the entire session | 5-message session; `limit: 2, includeBodies: true`; `Object.keys(response.bodies).length === 2`; request page 2; bodies only contain that page's items |
| 5 | `getTurnBody still works independently (backward compatible)` | Existing turn body endpoint is unaffected | Call `getTurnBody({ sessionId, turnId })`; returns full message content as before |

---

### File: `test/integration/server/agent-timeline-batched.test.ts`

**Config:** `vitest.server.config.ts` (node environment)
**Data:** Mock `loadSessionHistory` injected into service/router
**Setup:** Express app with auth middleware + `createAgentTimelineRouter`, matching `agent-timeline-router.test.ts` pattern
**Dependencies:** `supertest` for HTTP assertions

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `GET /timeline?includeBodies=true returns bodies in response` | HTTP endpoint passes `includeBodies` through to service | `request(app).get('/api/agent-sessions/s1/timeline?priority=visible&includeBodies=true').set('x-auth-token', token)`; `res.status === 200`; `res.body.bodies` is an object with entries |
| 2 | `GET /timeline without includeBodies: no bodies field` | Default HTTP response omits bodies | Same request without `includeBodies`; `res.body.bodies` is `undefined` |
| 3 | `includeBodies reduces request count for full page render` | Demonstrates the N+1 elimination | Mock service with 10-item page; with `includeBodies=true`: 1 HTTP request serves all data; without: would need 1 + 10 requests; assert bodies map has 10 entries |
| 4 | `includeBodies=true with empty session: empty items and no bodies` | Graceful handling of edge case | Session returns `[]` messages; `res.body.items` is `[]`; `res.body.bodies` is either `{}` or absent |

---

### File: `test/unit/client/store/agentChatThunks-batched.test.ts`

**Config:** Default `vitest.config.ts` (jsdom environment)
**Data:** Mocked `getAgentTimelinePage` and `getAgentTurnBody` via `vi.mock('@/lib/api', ...)`
**Setup:** `configureStore` with `agentChatReducer`, matching existing `agentChatThunks.test.ts` pattern
**Pattern:** Uses `vi.mock` for API module, `configureStore` for Redux store

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `thunk uses inlined bodies when page.bodies is present` | Client skips separate turn body fetch when bodies are inlined | Mock `getAgentTimelinePage` to return `bodies: { 'turn-0': { ... } }`; dispatch `loadAgentTimelineWindow`; `getAgentTurnBody` NOT called; store has correct turn body |
| 2 | `thunk falls back to getAgentTurnBody when page.bodies is absent` | Backward compatibility with servers that don't support `includeBodies` | Mock `getAgentTimelinePage` without `bodies` field; dispatch thunk; `getAgentTurnBody` IS called; store has correct turn body |
| 3 | `thunk passes includeBodies: true in the query` | Client requests inlined bodies | Dispatch thunk; `getAgentTimelinePage` called with second arg containing `includeBodies: true` |

---

## E2E / WebSocket Tests

### File: `test/unit/server/ws-sdk-session-history-cache.test.ts`

**Config:** `vitest.server.config.ts` (node environment)
**Data:** Mock `loadSessionHistory` injected as WsHandler 13th constructor parameter
**Setup:** `vi.mock('node-pty', ...)` and `vi.mock('../../../server/session-history-loader.js', ...)`; create `http.Server`, `TerminalRegistry`, `WsHandler` with injected function
**Pattern:** Matches existing `ws-handler-sdk.test.ts` pattern (module-level mocks, `vi.hoisted`)

Note: The implementation plan adds `loadSessionHistoryFn` as the 13th positional param to `WsHandler`. These tests verify that the injected function is actually called by the WsHandler instead of the imported one.

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `sdk.create with resumeSessionId calls injected loadSessionHistory` | WsHandler uses the DI'd function for session resume | Create WsHandler with mock `loadSessionHistoryFn`; send `sdk.create` message with `resumeSessionId`; mock called with correct sessionId; the direct import mock is NOT called |
| 2 | `sdk.attach for durable session calls injected loadSessionHistory` | Attach flow also uses the injected function | Simulate attach to a non-running durable session; injected mock called; snapshot message sent with correct `latestTurnId` |
| 3 | `multiple attaches to same session: loadSessionHistory called per attach (cache handles dedup)` | The WsHandler itself does not cache -- it delegates to the injected function which may be cache-backed | Attach twice to same session; injected mock called twice (cache dedup is the cache's job, not WsHandler's); both attaches receive valid snapshots |

---

### File: `test/integration/server/agent-timeline-cache-integration.test.ts`

**Config:** `vitest.server.config.ts` (node environment)
**Data:** Synthetic `.jsonl` files in temp dirs; service + cache wired together
**Setup:** Create `SessionContentCache`, wire into `loadSessionHistory` with resolver, create `AgentTimelineService`; temp dir with session files

| # | Test name | What it verifies | Key assertions |
|---|-----------|------------------|----------------|
| 1 | `timeline page and turn body share cached file read` | Single file read serves both timeline listing and body hydration | `vi.spyOn(fsp, 'readFile')`; request timeline page; request turn body for an item; `readFile` called once total |
| 2 | `timeline invalidation after file change` | Cache detects file changes between requests | Request timeline page (3 items); append new message to `.jsonl` file; request timeline again; second response has 4 items |
| 3 | `concurrent timeline requests for same session coalesce` | Request coalescing works at the cache level through the service | `Promise.all([service.getTimelinePage(...), ...5 times])`; `readFile` called once |

---

## Test Count Summary

| File | Layer | Tests | Data type | Environment |
|------|-------|-------|-----------|-------------|
| `test/unit/server/session-history-loader-path-resolution.test.ts` | 1 | 6 | Synthetic | node |
| `test/integration/server/session-history-io-reduction.test.ts` | 1 | 5 | Synthetic + real indexer | node |
| `test/unit/server/session-content-cache.test.ts` | 2 | 10 | Synthetic | node |
| `test/unit/server/session-cache-races.test.ts` | 2 | 4 | Synthetic + mocks | node |
| `test/integration/server/session-content-cache-real.test.ts` | 2 | 4 | Real `.jsonl` + synthetic | node |
| `test/integration/server/session-cache-stress.test.ts` | 2 | 4 | Synthetic | node |
| `test/unit/server/agent-timeline-include-bodies.test.ts` | 3 | 5 | Synthetic (mocked) | node |
| `test/integration/server/agent-timeline-batched.test.ts` | 3 | 4 | Synthetic (mocked) | node |
| `test/unit/client/store/agentChatThunks-batched.test.ts` | 3 | 3 | Synthetic (mocked) | jsdom |
| `test/unit/server/ws-sdk-session-history-cache.test.ts` | E2E | 3 | Synthetic (mocked) | node |
| `test/integration/server/agent-timeline-cache-integration.test.ts` | E2E | 3 | Synthetic | node |
| **Total** | | **51** | | |

---

## Implementation Order (TDD Phases)

### Phase 1: Layer 1 path resolution tests
1. **RED:** Write `session-history-loader-path-resolution.test.ts` (6 tests fail)
2. **GREEN:** Implement `LoadSessionHistoryDeps` and resolver logic in `session-history-loader.ts`
3. **RED:** Write `session-history-io-reduction.test.ts` (5 tests)
4. **GREEN:** Wire resolver; tests pass

### Phase 2: Layer 2 content cache tests
5. **RED:** Write `session-content-cache.test.ts` (10 tests fail)
6. **GREEN:** Implement `SessionContentCache` class
7. **RED:** Write `session-cache-races.test.ts` (4 tests)
8. **GREEN:** Harden cache for race conditions
9. **RED:** Write `session-content-cache-real.test.ts` (4 tests)
10. **GREEN:** Fix any real-world edge cases
11. **RED:** Write `session-cache-stress.test.ts` (4 tests)
12. **GREEN:** Ensure stress tests pass; wire cache into `loadSessionHistory`

### Phase 3: Layer 3 timeline batching tests
13. **RED:** Write `agent-timeline-include-bodies.test.ts` (5 tests fail)
14. **GREEN:** Add `includeBodies` to service, types, schema
15. **RED:** Write `agent-timeline-batched.test.ts` (4 tests)
16. **GREEN:** Update router to parse `includeBodies`
17. **RED:** Write `agentChatThunks-batched.test.ts` (3 tests fail)
18. **GREEN:** Update client `api.ts` and `agentChatThunks.ts`

### Phase 4: E2E integration tests
19. **RED:** Write `ws-sdk-session-history-cache.test.ts` (3 tests)
20. **GREEN:** Add 13th param to WsHandler constructor; wire in `server/index.ts`
21. **RED:** Write `agent-timeline-cache-integration.test.ts` (3 tests)
22. **GREEN:** Ensure end-to-end cache sharing works

### Phase 5: Refactor pass
23. Review all new code for consistent error handling
24. Ensure graceful degradation (cache disabled = same behavior as before)
25. Add debug logging for cache hits/misses (behind debug flag)
26. Clean up any TODOs

---

## Notes on Testing Strategy Decisions

### Real vs synthetic data
- **Unit tests** use synthetic data exclusively. This keeps them fast, deterministic, and runnable in CI without `~/.claude`.
- **Integration tests** use real `.jsonl` files where possible (with skip-if-not-available guards) to validate against actual Claude session format. Synthetic files are used for mutation and adversarial tests.
- **Stress tests** use synthetic data because they need controlled file sizes and counts.

### I/O counting approach
Tests use `vi.spyOn` on `fsp` methods (readdir, readFile, stat) as passthrough proxies. This avoids mocking the filesystem while still counting calls. The spies delegate to the original implementation, so real I/O occurs. This is preferred over fully mocked tests because it validates actual filesystem behavior.

### Performance assertion thresholds
- `5x faster` for resolver vs scan: conservative; real-world improvement is likely 50-100x with many directories. The 5x threshold avoids flaky failures on slow CI runners.
- `< 50ms for 100 sessions`: generous budget. On modern hardware, 100 `stat()` + `readFile()` calls on cached (OS-level) files should complete in ~10ms. The 50ms threshold accounts for CI variability.
- Stress test timeouts: use the default 30s test timeout from `vitest.server.config.ts`.

### Request coalescing verification
The coalescing tests work by verifying `readFile` call count when multiple `cache.get()` calls run concurrently via `Promise.all`. If coalescing works, `readFile` is called once. If not, it's called N times. This is a behavioral test, not a timing-dependent test.

### WsHandler test approach
The WsHandler tests verify DI by checking that the injected `loadSessionHistoryFn` mock is called and the module-level `loadSessionHistory` mock is NOT called. This is more robust than testing the constructor parameter directly because it validates the actual call path through the WebSocket message handlers.
