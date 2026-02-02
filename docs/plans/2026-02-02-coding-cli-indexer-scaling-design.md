# Coding CLI Indexer Scaling Design (50k sessions)

## Summary
Scale the Coding CLI session indexer to handle up to ~50,000 sessions without blocking the event loop. The current indexer fully rescans all session files on any refresh and the search endpoint reads full JSONL files into memory, which will stall the event loop at scale. We will add a persistent metadata cache + incremental updates, cap the UI to the newest 10,000 sessions by recency, and introduce a settings-synced "search beyond cap" toggle that uses bounded, streaming scans. Cap metadata and partial-search signals will be surfaced in the API/UI with structured logs for high volume and cap enforcement.

## Goals
- Keep WebSocket input latency responsive (avoid multi-second event-loop stalls).
- Default behavior remains fast for 1-10k sessions and graceful up to 50k.
- Index only the newest 10k sessions across all providers by default.
- Preserve API shape (projects array and /api/sessions) while allowing capped project lists (older projects may be omitted).
- Provide structured logs for high volume and cap enforcement.
- Indicate cap activity and partial search results in UI/API responses.
- Avoid full rescans on single file changes; favor incremental updates and background reconciliation.

## Non-goals
- Full-text search index (FTS) at this stage.
- Real-time streaming search across all files beyond the cap by default.
- Major UI redesign of sessions list.

## Current Usage (why the index exists)
- Initial page load and WS ready payload includes projects for the sidebar.
- Sidebar shows sessions, sorts by activity/recency/project, and supports title-tier filtering locally.
- /api/sessions/search uses metadata for title tier and file scans for user/full-text tiers.
- Settings and session overrides trigger codingCliIndexer.refresh and broadcast sessions.updated.

## Constraints and Observations
- JSONL session logs are append-only or rarely edited after completion.
- Users generally interact with recent sessions; older sessions are accessed via search.
- Full-file scans and full rescan loops currently block the event loop at large scale.
- Node.js runs on a single event loop; long synchronous tasks degrade keystroke latency.
- Current CodingCliSessionIndexer.refresh performs a full provider walk + stat + snippet parse for every refresh, even on single file changes.
- /api/sessions/search reads entire JSONL files into memory for user/full-text tiers.
- Title-tier search is local-only in the Sidebar (no backend search when tier=title).

## Proposed Architecture
### 1) Incremental Metadata Cache (persistent + in-memory)
- Extend the existing in-memory fileCache to a persisted cache on disk (e.g. ~/.freshell/cache/coding-cli-sessions.jsonl) with a schema version and lastReconciledAt.
- Cache entries include: filePath, provider, sessionId, projectPath, updatedAt (mtimeMs), mtimeMs, size, title, summary, cwd, messageCount.
- On startup, load the cache, build projects immediately, and mark cacheState=stale until reconciliation completes.
- Replace full rescan-on-change with per-file upsert/remove from chokidar events; apply overrides at merge time.
- Periodic background reconciliation (async iterator + yielding) verifies cache against disk and updates cacheState.

### 2) Global Cap of Newest Sessions (default 10,000)
- Add settings.codingCli.maxIndexedSessions (default 10000, 0 = unlimited).
- The cap is global across all providers and enforced after metadata collection.
- Use a min-heap of size N to keep only the newest sessions by updatedAt (recency = file mtimeMs).
- This bounds memory and avoids sorting all sessions when counts are large.
- The cap is strict; no more than N sessions are returned in projects.
- Projects with no sessions in the newest N are omitted from the projects array.
- No per-provider minimums (decision). If a single provider dominates, it can consume the cap.

### 3) Search Beyond Cap (explicit, optional)
- New toggle: Search beyond cap (default off), persisted in settings and mirrored in the Sidebar.
- When off: title tier stays local; user/full-text search scans indexed sessions only.
- When on: all tiers route through the backend and can scan uncapped sessions.
- Backend scans use streaming (readline) per file (no full-file read), with scan budgets
  (maxFiles + maxMs) and cooperative yields. If a budget is exceeded, return
  partial=true with partialReason=budget.
- If the client aborts the request, stop scanning immediately; no partial response
  is returned on an aborted HTTP request.

### 4) Event-loop Safety
- Use async directory iteration (opendir) and yield between batches (setImmediate)
  during reconciliation or large scans.
- Replace readSessionSnippet with a streaming meta reader (similar to Claude indexer)
  to avoid synchronous JSON.parse on large buffers.
- Coalesce refresh calls (existing refreshInFlight/refreshQueued) and avoid overlap.
- Optional future enhancement: move indexer work to a worker process.

## Logging and Observability
### Structured log events
- coding_cli_indexer_cap_applied (warn):
  - totalSessions, indexedSessions, droppedSessions, cutoffUpdatedAt,
    cap, providerCounts
- coding_cli_indexer_high_volume (error, startup only if total > 50k):
  - totalSessions, providerCounts, cap, message
- coding_cli_indexer_cache_state (info):
  - cacheState, cacheVersion, lastReconciledAt

### Logging behavior
- Warn when cap state changes (or when cutoffUpdatedAt changes), not on every refresh.
- Error once at startup if total sessions > 50k.

## API / UI Behavior
- /api/sessions returns only the capped session set (unchanged array response).
- New /api/sessions/meta returns cap metadata (cap, totalSessions, indexedSessions,
  cutoffUpdatedAt, cacheState, approximate).
- WS sessions.updated includes { projects, meta } (meta optional for compatibility).
- Projects without indexed sessions are omitted.
- Sidebar shows a subtle indicator when cap is active:
  "Showing newest 10,000 of 37,214 sessions. Older projects are hidden."
- Indicator is actionable: clicking it opens search and enables Search beyond cap.
- Search toggle controls whether backend search can go beyond cap.
- Settings stores the toggle state and cap value (synced with Sidebar toggle).
- Search responses include scope (indexed | all) and partial=true/false with a
  partialReason (budget | io_error). UI shows a "Partial results" badge
  when partial=true.

## Data Flow
1) Startup:
   - Load cache -> build projects -> send ready payload (cacheState=stale).
   - Start chokidar watchers and background reconciliation.
   - If total sessions > 50k, log coding_cli_indexer_high_volume.
2) Change events:
   - On add/change/unlink, update cache entry and recompute affected groups.
   - Apply cap, update projects, broadcast sessions.updated with meta.
3) Search:
   - Title tier: local when toggle=off; backend when toggle=on.
   - User/full-text tiers: respect toggle; beyond-cap scans are cooperative
     and may return partial results when budgets/IO errors occur.

## Testing
- Unit tests for cap behavior and heap selection.
- Unit tests for cache reuse (no re-parse on unchanged files).
- Unit tests for search scope toggle behavior and partial results metadata.
- Unit tests for streaming search scan budgets (partial=true when budget exceeded).
- Integration test: cap warning log emitted when exceeding cap.
- Integration test: /api/sessions/meta returns expected meta.
- Client tests: Sidebar cap indicator + toggle sync with Settings.

## Risks and Mitigations
- Risk: cap hides older sessions unexpectedly.
  - Mitigation: UI indicator + optional search beyond cap.
- Risk: cache drift.
  - Mitigation: background reconciliation, cacheState indicator, watcher error handling.
- Risk: large file scans for search beyond cap.
  - Mitigation: streaming scans, scan budgets, cooperative yielding, partial results UI.

## Implementation Notes (initial improvements)
- /api/sessions/search accepts optional `maxFiles` (budget) and returns `partial` +
  `partialReason=budget` when the scan stops early.
- Missing or unreadable session files set `partialReason=io_error` and continue
  scanning remaining sessions.
- File-based search now streams JSONL line-by-line to avoid full-file reads.
- Indexer refresh yields to the event loop periodically during large refreshes.

## Rollout
- Default cap on (10k).
- Search beyond cap off by default.
- Monitor logs for high volume and cap enforcement.
