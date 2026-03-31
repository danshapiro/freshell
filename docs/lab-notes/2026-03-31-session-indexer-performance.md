# Session Indexer Performance Investigation

**Issue:** danshapiro/freshell#237 — Session indexer blocks event loop for seconds when scanning thousands of session files.

**User report:** Another user's instance never finished indexing (or was blocked for minutes+) on first launch.

## Scale from the issue

- 8,206 session files (5,573 Claude + 2,633 Codex)
- 6.6GB of session data
- Refresh times: 500ms – 4,400ms
- Event loop blocking: up to 6,895ms
- Server uptime before restart: 20+ hours

## Architecture walkthrough

### Startup flow

1. `codingCliIndexer.start()` calls `this.refresh()` synchronously (awaits it)
2. `refresh()` → `performRefresh()` with `needsFullScan = true`
3. Full scan:
   - For each provider: `listSessionFiles()` → returns all file paths
   - For each file: `updateCacheEntry()` → stat + readSnippet + parse + resolveProjectPath + resolveGitCheckoutRoot
4. Only after ALL files are processed does `.start()` return and watchers begin
5. Server marks `codingCliIndexer` as ready only after start() resolves

### Per-file work in `updateCacheEntry()` (session-indexer.ts:477-565)

For each of the ~8,000 files:
1. `fsp.stat(filePath)` — 1 syscall
2. Check cache by mtime/size (skip if unchanged)
3. `readSessionSnippet(filePath)` — 1 stat + 1-2 file reads (up to 256KB)
4. `provider.parseSessionFile(content, filePath)` — JSON.parse every line of content
   - For Claude: also calls `readClaudeDebugAutocompactSnapshot()` — 1 stat + potential multi-tier reads (128KB → 4MB)
5. `provider.resolveProjectPath()` → `resolveGitRepoRoot(meta.cwd)` — walks filesystem for .git, cached after first hit
6. `resolveGitCheckoutRoot(meta.cwd)` — another filesystem walk, also cached

**Minimum syscalls per uncached Claude session: ~5-8 (stat, read snippet, stat debug, read debug, .git walk)**

### `listSessionFiles()` (claude.ts:523-574)

Sequential directory traversal:
- `readdir(projectsDir)` → list of project dirs
- For each project dir: `stat()` + `readdir()`
- For each entry: check `.jsonl` extension or `stat()` to check if directory
- For each session dir: `readdir(subagentsDir)`

With many project directories and session entries, this alone involves thousands of syscalls.

### Processing model: entirely sequential

```
for (const file of files) {           // 8,206 iterations
  await this.updateCacheEntry(...)    // sequential await per file
}
```

No parallel file processing. Each file blocks the next.

### Yielding: insufficient

`yieldToEventLoop()` every 200 files via `setImmediate`. But:
- Each `updateCacheEntry` is already async (multiple awaits), so the event loop does get yielded during I/O waits
- The real problem isn't event loop blocking between files — it's the **total wall time** of processing all files sequentially
- CPU-bound parsing (`JSON.parse` per JSONL line × thousands of files) does block within each file's processing

## Root causes identified

### 1. No parallelism in file processing (PRIMARY)
Each file is processed one-at-a-time. With ~8,000 files, even fast per-file work adds up. Node.js can handle many concurrent async I/O operations, but we serialize them all.

### 2. Redundant per-session debug file reads
`readClaudeDebugAutocompactSnapshot()` is called for every Claude session during `parseSessionFile()`. With 5,573 Claude sessions, that's 5,573 extra stat() calls minimum, plus actual reads for sessions with debug files. The cache has a 5-second TTL that provides no benefit during a full scan (all files are processed within one scan cycle).

### 3. Git root resolution per session
`resolveGitRepoRoot()` and `resolveGitCheckoutRoot()` are called for every session. While cached by cwd, on first scan with many unique cwds, each triggers filesystem walks up the directory tree.

### 4. `listSessionFiles()` is sequential
Claude provider scans directories one at a time. Could be parallelized across project directories.

### 5. JSONL parsing is CPU-intensive
`parseSessionContent()` calls `JSON.parse()` on every line of the snippet. For 256KB snippets with dense JSON, this is significant CPU work, and it's done 8,000 times.

### 6. No incremental startup
On first launch, there's no persisted cache. Every file must be fully stat'd, read, and parsed. Subsequent refreshes benefit from mtime/size cache hits, but the first scan is always worst-case.

## Things that are NOT root causes (issue may be confused about)

- **Not sync I/O**: The code uses `fsp` (async fs) throughout, not `fs.readFileSync`. The issue mentions "Synchronous file reads" but that's incorrect.
- **Not insufficient yielding per se**: The yielding is fine for the async operations. The problem is sequential processing, not blocking.

## Potential solutions (ordered by impact/effort)

### A. Parallel file processing with bounded concurrency
Process files in batches (e.g., 20-50 concurrent) instead of sequentially. This is the single highest-impact change.
- Stat + read + parse operations are I/O-bound; Node handles concurrent I/O well
- Must be careful with memory (50 concurrent 256KB reads = 12.8MB, acceptable)
- Use a simple semaphore/pool pattern

### B. Skip debug file reads during full scan
`readClaudeDebugAutocompactSnapshot()` adds meaningful overhead but token usage data isn't critical for initial indexing. Could:
- Defer debug file reads to a second pass after initial scan completes
- Only read debug files for recently-active sessions
- Increase negative TTL during full scans

### C. Parallelize `listSessionFiles()`
Process multiple project directories concurrently in the Claude provider.

### D. Persistent metadata cache
Serialize the file cache (mtime, size, baseSession) to disk on shutdown, load on startup. Files that haven't changed (same mtime/size) skip all I/O. This would make subsequent startups near-instant for stable session histories.

### E. Progressive/streaming startup
Don't block `start()` on completing the full scan. Return immediately with empty state, process files in background, emit updates as batches complete. The UI would show sessions appearing progressively.

### F. Worker thread for JSONL parsing
Offload `parseSessionContent()` to a worker thread to avoid CPU blocking. Higher complexity, moderate impact.

## Recommendations

**Phase 1 (highest impact, moderate effort):**
- A: Parallel file processing — likely 5-10x speedup on the full scan
- C: Parallelize listSessionFiles — moderate speedup

**Phase 2 (good value):**
- B: Defer debug reads — removes ~5,000 unnecessary stat calls from full scan
- E: Progressive startup — eliminates perceived "never finishes" for users

**Phase 3 (polish):**
- D: Persistent cache — makes restarts fast, good for "never finished" user
- F: Worker thread — only if CPU is proven bottleneck after I/O parallelism

---

## Issue #261 — HTTP unresponsive after startup

A second issue from justinchoo9 identifies that the server becomes **completely unresponsive to HTTP** after startup. This adds critical context:

### Second bottleneck: SessionRepairService

`SessionRepairService.start()` (service.ts:77-99) runs **before** the indexer and has its own startup problems:

1. `discoverTopLevelSessions()` — globs `*/*.jsonl` in `~/.claude/projects` (1000+ files)
2. Enqueues ALL discovered files into the repair queue
3. **Queue doesn't start until AFTER discovery completes** (line 96: `this.queue.start()` is after `discoverTopLevelSessions()`)
4. Queue processes items one-at-a-time with `setImmediate` between items (queue.ts:259)

### The startup ordering bug (confirmed)

In service.ts:77-99:
```js
await this.discoverTopLevelSessions()  // blocks — globs all files, enqueues them
this.queue.start()                      // only NOW starts processing
this.initialized = true                 // only NOW marks as initialized
```

If a `waitForSession()` call comes in during discovery, the session IS enqueued (by discovery) but the queue ISN'T running yet. The waiter blocks forever.

### The `setImmediate` starvation insight (partially valid)

Issue #261 claims that `setImmediate` allows microtasks to starve HTTP macrotasks. This is **partially right**:
- `setImmediate` runs in the "check" phase, after I/O poll
- If async I/O completions (from readFile/stat) create new microtasks that themselves trigger more I/O, the effective result can be sustained I/O saturation
- However, `setImmediate` does run after the poll phase, so pure HTTP I/O should get a turn
- The real starvation is more likely from the **volume** of concurrent async operations rather than `setImmediate` vs `setTimeout` semantics
- The `setTimeout(5)` fix is a blunt instrument — it works but adds ~15 seconds of artificial delay

### Redundant work between repair service and indexer

Both services independently:
- Glob/scan `~/.claude/projects`
- Read session files
- Parse JSONL content

The repair service reads **entire files** (not just 256KB snippets). For 1000+ sessions with some large files, this is significant redundant I/O.

### Revised root cause analysis (both issues combined)

**Critical (server unresponsive):**
1. Repair queue doesn't start until after discovery — `waitForSession()` deadlocks
2. Two independent systems doing heavy I/O at startup compete for the event loop
3. Sequential processing in both systems (indexer: per-file await; queue: one-at-a-time + setImmediate)

**Severe (multi-second blocks):**
4. No parallelism in file processing — sequential awaits across 8,000+ files
5. Redundant I/O — repair service and indexer both read the same files

**Moderate (slow first launch):**
6. No persistent metadata cache in the indexer
7. Redundant debug file reads per Claude session

### Revised solution strategy

**Phase 0 (fix the deadlock — #261's core issue):**
- Move `this.queue.start()` before `discoverTopLevelSessions()`
- Set `this.initialized = true` before discovery too
- This is a 2-line fix that unblocks `waitForSession()`

**Phase 1 (eliminate starvation):**
- Add `skipDiscovery` to repair service startup — the indexer already discovers all sessions
- Make indexer startup non-blocking — `start()` returns immediately, scan runs in background
- This eliminates the "HTTP never responds" symptom entirely

**Phase 2 (speed up the scan):**
- Parallel file processing with bounded concurrency in the indexer
- Parallel directory listing in `listSessionFiles()`
- Defer debug file reads

**Phase 3 (make restarts fast):**
- Persistent metadata cache for the indexer
- Session data served from cache while background scan validates

---

## Why is the UI blocked? (Matt's question)

### Tracing the full request path

1. **App.tsx bootstrap** (line 875): `loadBootstrapData()` → fetches `/api/bootstrap` (settings, platform info). This works fine — no dependency on indexer.

2. **App.tsx sidebar load** (line 665): `loadInitialSessionsWindow()` → dispatches `fetchSessionWindow({ surface: 'sidebar', priority: 'visible' })`.

3. **sessionsThunks.ts** (line 541): `fetchSidebarSessionsSnapshot()` → calls `getSessionDirectoryPage()` → HTTP GET `/api/session-directory`.

4. **sessions-router.ts** (line 91): The handler calls `codingCliIndexer.getProjects()` — this is a **synchronous read of whatever the indexer has discovered so far**.

5. **Key finding: The API itself is NOT gated on startup.** `codingCliIndexer.getProjects()` returns the current `this.projects` array immediately. If the indexer hasn't finished, it returns whatever partial data exists (or `[]` if nothing is ready yet).

### So why does the user see "Loading sessions..." forever?

**It's NOT because the API blocks on indexer completion.** The API returns immediately with whatever data is available. The problem is:

1. **Event loop starvation (#261)**: Both the repair service and the indexer flood the event loop with I/O at startup. HTTP request callbacks can't get a turn. The request literally hangs in the TCP stack because Express never gets to process it.

2. **Empty initial response**: If HTTP *does* get through before the indexer finishes, `getProjects()` returns `[]`. The sidebar shows empty. Then `sessions.changed` fires when the indexer completes, triggering a refresh. But if the event loop is still saturated, this refresh request also hangs.

3. **The startup state (`startupState`) is cosmetic**: It's only used in the `/api/health` endpoint's `ready` field. The client doesn't gate on it at all. It's purely informational.

### The repair service: why does it exist at startup?

The `SessionRepairService` scans Claude session files to detect and fix corruption (malformed JSONL, missing history entries). Its startup flow:

1. Load cache from disk
2. **Glob ALL session files** (`*/*.jsonl` in `~/.claude/projects`)
3. Enqueue all of them for scanning
4. Start the queue (sequential, one-at-a-time)

This is designed to proactively repair sessions before a user tries to resume them. But it's redundant with the indexer — both discover the same files. And its sequential queue processing adds sustained I/O load alongside the indexer.

### The architecture Matt is asking about already exists — it's just broken

The **design** is actually progressive:
- `codingCliIndexer.getProjects()` returns current state (no blocking)
- `sessions.changed` WS message notifies clients when data updates
- Client re-fetches via HTTP on each `sessions.changed`

This is exactly the "background crawler that progressively updates" model. The problem is that the crawler starves the server so badly that the HTTP requests to *read* the progressive state can't get through.

### What needs to change

The fix isn't architectural — the architecture is right. The fix is operational:

1. **Stop the repair service from competing with the indexer at startup.** The repair service should either:
   - Not do discovery at all (let the indexer handle it, repair on-demand via `waitForSession`)
   - Or defer discovery until after the indexer's first scan completes

2. **The indexer needs to yield properly.** Not `setImmediate` vs `setTimeout` (that's bikeshedding). The real fix is bounded concurrency + cooperative scheduling so that HTTP I/O gets fair access. The simplest approach: process files in small batches with `setTimeout(0)` between batches, which forces a full event loop cycle including the poll phase.

3. **The indexer should emit partial updates during the first scan.** Currently `performRefresh()` only calls `emitUpdate()` once, after ALL files are processed. If it emitted updates every N files, the sidebar would progressively populate during the scan.

### Summary: Matt's instinct is correct

These SHOULD be background crawlers that don't affect the view. The architecture supports it. The implementation just has two bugs:
- The repair service's eager discovery + deferred queue start creates a deadlock
- The indexer's I/O volume starves the event loop, preventing HTTP responses
