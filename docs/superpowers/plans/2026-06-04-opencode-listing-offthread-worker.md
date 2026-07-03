# OpenCode Listing Off-Thread Worker Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with Red-Green-Refactor TDD, committing after each task. Steps use checkbox (`- [ ]`) syntax for tracking. (Note: the superpowers `subagent-driven-development`/`executing-plans` skills are **disabled** in this repo, so do not invoke them; the user selects the execution mechanism. Do not invoke any skill unless the user asks.)

**Goal:** Run the OpenCode `listSessionsDirect` synchronous `node:sqlite` query in a `worker_thread` so the ~180 ms `hasThreeViewsMarker` content scan never blocks Freshell's shared event loop (the cause of terminal stutter while OpenCode agents are active).

**Architecture:** Extract the synchronous DB work into a pure function. A thin worker entry runs that function off the main thread and posts the rows back. The provider keeps its cheap pre-checks (`missing_db`, `sqlite_unavailable`) and async row→session mapping on the main thread, but delegates the heavy open+query to an injectable async *query runner* whose default implementation spawns the worker. Tests inject an in-process runner (real `node:sqlite`, no thread) for behavior coverage and a fake-spawn runner for orchestration coverage; one integration test spawns the real worker and proves the loop stays responsive.

**Tech Stack:** Node.js `node:worker_threads`, `node:sqlite` (`DatabaseSync`, Node ≥ 22.5), TypeScript NodeNext/ESM, Vitest (server config, `pool: 'threads'`).

---

## Background & Validated Constraints (read before starting)

This plan replaces the superseded `2026-06-03-opencode-marker-cache-eventloop.md` (cache/gate approaches were falsified). The root cause is documented in kata `xe4t`/`wab5`: `listSessionsDirect()` runs a leading-wildcard `LIKE` over `part.data`+`message.data` (~180 ms, ~432 MB scanned) synchronously via `DatabaseSync.prepare().all()` on the event loop, re-run every indexer refresh (~7 s) while OpenCode writes its WAL. It cannot be cheaply/soundly incrementalized or gated, so the fix is to move it off-thread.

The following were **empirically validated by spike** on this machine (Node v22.21.1, repo tsx 4.19.x) — the design depends on them:

1. **Dev runtime (`tsx watch server/index.ts`):** A spawned `Worker` inherits `process.execArgv`, which under tsx contains tsx's `--import .../loader.mjs`. So a `.ts` worker entry loads in dev. ✓
2. **Prod runtime (`node dist/server/index.js`):** A compiled `.js` worker loads under plain node. ✓
3. **Test runtime (Vitest server config, `pool: 'threads'`):** `process.execArgv` is `["--conditions","node","--conditions","development"]` (no TS loader). Node 22.21's native type-stripping loads a nested `.ts` worker, and `node:sqlite` works inside it. ✓
4. **`node:sqlite` `DatabaseSync` works inside a worker thread.** ✓
5. **NodeNext `.js`→`.ts` remap FAILS inside a worker** under both plain node and tsx (`Cannot find module './x.js'`). Therefore the worker entry must NOT statically import a relative sibling. Instead the main thread resolves the *exact* sibling URL (`.ts` in dev/test, `.js` in prod — the file that actually exists) and passes it via `workerData`; the worker `await import()`s that exact URL (no remap). This works in all three runtimes. ✓
6. **`import.meta.url.endsWith('.ts')`** reliably distinguishes dev/test (source `.ts`) from prod (compiled `.js`), enabling extension-swap path resolution. ✓
7. **`tsc -p tsconfig.server.json`** has `include: ["server/**/*", ...]`, so new `server/coding-cli/providers/*.ts` files (including the worker) compile to `dist/server/...` automatically — **no build-step change required.** ✓
8. **Electron is a fourth+fifth runtime, and it works (validator-confirmed).** The desktop app reaches this exact code path (`server/index.ts` instantiates `opencodeProvider` + `CodingCliSessionIndexer` identically). Electron **prod** spawns the **compiled** `dist/server/index.js` under a **bundled standalone Node v22.12.0** (`electron/server-spawner.ts`, `scripts/bundled-node-version.json`) — `import.meta.url` ends in `.js`, so the ext-swap picks `.js`; 22.12.0 ≥ 22.5 so `node:sqlite`/`worker_threads` are present; and `config/electron-builder.yml` `extraResources` copies `dist/server/**/*` (including the new `opencode-listing*.js`) onto the real filesystem (not ASAR), so the worker file is loadable. Electron **dev** runs `tsx server/index.ts` (`.ts`, same as constraint §1). The throw-on-failure contract means even a worst-case Electron worker failure degrades to a preserved/empty listing, never a crash. ⚠️ The plan's tests run on the host Node (22.21), not the bundled 22.12.0 binary; Task 6 includes an optional step to run the prod one-off under the bundled binary when present. ✓
9. **Cross-platform path safety.** All worker/query URLs are resolved with `new URL('./sibling.<ext>', import.meta.url).href` and consumed via `await import(url)` / `new Worker(url)` — no raw path-string concatenation — so Windows drive/backslash paths, spaces, and the mandated `.worktrees/...` layout are handled by the URL layer. Windows Electron remains a manual-verify residual (the automated suite runs on Linux). ✓

**Non-goals (keep scope tight):**
- `resolveOpencodeSessionRoots()` stays on the main thread. It is an indexed `id IN (...)` lookup (small result set), not the hot-path bottleneck. Do not touch it.
- No persistent worker pool. Spawn-per-call is simpler and safe here: refreshes are single-flight (`refreshInFlight`) and throttled (≥ 5 s), so at most one listing runs at a time; worker startup (~30–100 ms) happens off the main thread.
- No marker caching / DB-change gating (falsified — see kata `xe4t`).
- No retry inside `listSessionsDirect` (unlike `resolveOpencodeSessionRoots`). With throw-on-failure, a transient `SQLITE_BUSY`/worker hiccup throws → the indexer preserves the prior sidebar → the next scheduled refresh (~7 s) retries. Adding per-call retry is unnecessary.

**Residual risks (accepted / verified at execution):**
- The real-worker integration test (Task 5) is validated standalone; its behavior under the **full shuffled `npm test`** (vitest `pool:'threads'`, `isolate`, `shuffle`) is confirmed by Task 6 Step 4. If a nested-worker/teardown issue appears there, treat it as a real signal (it would also affect production), not a test artifact.
- The non-blocking assertion (`ticks ≥ 10`) has generous margin: a spike measured ~61 main-thread ticks (5 ms) during a 319 ms real-DB worker query; at 10 ms over a 250 ms busy fixture, ~25 ticks are expected. GC pauses won't drop it below 10.
- **Windows Electron** worker spawn + URL resolution is not covered by the Linux CI suite; the URL-based resolution (constraint §9) is cross-platform by construction, but flag a manual verify on the Windows desktop build.
- Spawn-per-call lifecycle: a spike ran 100 spawn/terminate cycles with **zero fd growth**; spawning one worker per ~7 s refresh is safe (no persistent-pool needed).

---

## File Structure

**New files (all under `server/coding-cli/providers/`):**
- `opencode-listing-query.ts` — The DB work. `runOpencodeListingQuery(dbPath, markerPattern)` opens the DB read-only, inspects schema, runs the marker SELECT, returns `{ rows, schemaMissingParentId }`. The DB operations are synchronous (thread-blocking); the function is `async` only because it imports `node:sqlite` lazily (mock-compat — see Lazy import note). Owns the `OpencodeSessionRow` type and `THREE_VIEWS_MARKER_SQL_PATTERN`. Real-sqlite-testable. No worker, no fs-async, no logging.
- `opencode-listing.worker.ts` — Thin worker entry. Reads `workerData = { queryModuleUrl, dbPath, markerPattern }`, dynamically imports the exact `queryModuleUrl`, awaits `runOpencodeListingQuery`, posts `{ ok: true, ...result }` or `{ ok: false, error }`. The message-handling logic is an exported `executeListing(workerData)` (unit-testable in-process); the `parentPort` wiring runs only when `parentPort` is present.
- `opencode-listing-runner.ts` — `createWorkerListingRunner(options?)` returns an async `OpencodeListingQueryRunner`. Resolves the worker URL and query-module URL by extension swap, spawns the worker (injectable `spawn` for tests), enforces a timeout, terminates the worker on every exit path, and returns the rows / schema flag. Owns the `OpencodeListingQueryRunner` and `OpencodeListingResult` types.

**Modified files:**
- `server/coding-cli/providers/opencode.ts` — `OpencodeProvider` gains an injectable `queryRunner` (default: real worker runner). `listSessionsDirect()` keeps `missing_db` + `sqlite_unavailable` pre-checks and the async row→session mapping, but delegates open+query to `this.queryRunner`; it returns `[]` for absent/empty states and **throws** on a worker/read failure (so the indexer preserves the prior sidebar). Removes the inline schema+SELECT (now in the query module). Re-exports `THREE_VIEWS_MARKER_SQL_PATTERN`/`OpencodeSessionRow` from the query module for compatibility. `resolveOpencodeSessionRoots`, `inspectSessionSchema`, logging helpers unchanged.
- `server/coding-cli/session-indexer.ts` (Task 4b) — `refreshDirectProvider`'s catch now preserves the failing provider's existing direct-cache keys (so the full-scan global prune doesn't wipe the sidebar on a transient failure) and logs `{ provider }` at debug instead of `{ err }` at warn (no raw-error re-leak / per-refresh spam).

**Modified tests:**
- `test/unit/server/coding-cli/opencode-provider.test.ts` — Construct the provider with the in-process runner so the `node:sqlite` mock still drives `listSessionsDirect`.
- `test/unit/server/coding-cli/opencode-provider.sqlite.test.ts` — Construct with the in-process runner; keep the end-to-end marker/mapping assertions.

**New tests:**
- `test/unit/server/coding-cli/opencode-listing-query.test.ts` — Pure function, real sqlite.
- `test/unit/server/coding-cli/opencode-listing-runner.test.ts` — Orchestration, fake spawn.
- `test/unit/server/coding-cli/opencode-listing-worker.test.ts` — `executeListing` in-process, real sqlite.
- `test/integration/server/opencode-listing-offthread.test.ts` — Real worker: correctness vs baseline + event-loop-not-blocked.
- `test/integration/server/fixtures/slow-opencode-listing-query.ts` — Fixture query module that busy-sleeps then returns known rows (drives the non-blocking assertion).

---

## Shared Type & Contract Reference (used across tasks)

```ts
// In opencode-listing-query.ts
export type OpencodeSessionRow = {
  sessionId: string
  cwd: string
  title: string
  createdAt: number
  lastActivityAt: number
  projectPath: string | null
  hasThreeViewsMarker?: number | null
}

export type OpencodeListingResult = {
  rows: OpencodeSessionRow[]
  schemaMissingParentId: boolean
}

export const THREE_VIEWS_MARKER_SQL_PATTERN = '%<freshell-session-metadata origin=3-views%'

// Async ONLY because node:sqlite is imported lazily (see "Lazy import" note below).
// The DB operations themselves are synchronous and block the calling thread —
// which is exactly why this runs inside a worker.
export function runOpencodeListingQuery(
  dbPath: string,
  markerPattern: string,
): Promise<OpencodeListingResult>
```

> **Lazy import (load-bearing — validated by spike):** the query module must import `node:sqlite` **lazily** (`const { DatabaseSync } = await import('node:sqlite')` inside the function), NOT with a static top-level `import`. A static import is eagerly triggered when `opencode.ts` is imported, which fires `vi.mock('node:sqlite')`'s hoisted factory **before** the mock test's inline `FakeDatabaseSync` class initializes → `ReferenceError: Cannot access 'FakeDatabaseSync' before initialization`. The current production code already imports `node:sqlite` lazily for this reason. A spike confirmed: lazy `await import('node:sqlite')` in a transitively-imported module IS intercepted by `vi.mock` and avoids the TDZ. This makes `runOpencodeListingQuery` async; the worker and the in-process runner both `await` it.

```ts
// In opencode-listing-runner.ts
import type { OpencodeListingResult } from './opencode-listing-query.js'

export type OpencodeListingQueryInput = { dbPath: string; markerPattern: string }
export type OpencodeListingQueryRunner = (input: OpencodeListingQueryInput) => Promise<OpencodeListingResult>
```

The worker message protocol (posted by `opencode-listing.worker.ts`, consumed by the runner):
```ts
type WorkerListingMessage =
  | { ok: true; rows: OpencodeSessionRow[]; schemaMissingParentId: boolean }
  | { ok: false; error: { name: string; message: string } }
```

**Failure contract (load-bearing — validated, refined after review):** `OpencodeProvider.listSessionsDirect()` returns `[]` ONLY for genuinely-absent/empty states (missing DB file, `node:sqlite` unavailable, zero rows). On a **worker/read failure** (spawn, load, timeout, exit, malformed message, or DB open/query error) it **throws**. The throw is what tells the indexer "this is a transient failure, not 'no sessions'".

For the throw to actually preserve the sidebar, BOTH refresh paths must be handled (this is why Task 4b changes the indexer, not just the provider):
- **Incremental refresh:** `refreshDirectProvider`'s catch returns early *before* its local direct-key prune (session-indexer.ts:918–923), so existing entries survive. ✓ already true.
- **Full scan (periodic safety scan / enabled-set change / root events):** `refreshDirectProvider`'s return value feeds the **global** prune in `performRefresh` (session-indexer.ts:~1273–1317) — any direct cache key NOT in the returned set is deleted. An empty return (the current catch) would let the global prune wipe every OpenCode entry. **Task 4b fixes this:** on failure, `refreshDirectProvider` returns the provider's *existing* direct cache keys, so both the local and global prune preserve them.

Returning `[]` (current behavior) wipes the sidebar on *both* paths; throw + the Task 4b indexer change preserves it on both. The indexer catch also stops logging the raw error (logs `{ provider }` at debug, not `{ err }` at warn) so the rethrown error cannot re-leak paths/messages or spam per-refresh — the sanitized one-time detail already comes from the provider's `logDatabaseStateOnce`.

**Per-spawn warning suppression (load-bearing — validated):** every worker spawn re-emits Node's `ExperimentalWarning` for `node:sqlite` (a fresh module realm). At ~7 s cadence that is log spam. The runner spawns the worker with `execArgv: [...process.execArgv, '--disable-warning=ExperimentalWarning']`. Spike-validated: this keeps tsx's loader (`--import .../loader.mjs`) under `tsx watch` (dev) AND is accepted by plain `node` (prod), while silencing the warning. We append to `process.execArgv` (not replace) precisely so the inherited tsx loader survives in dev.

---

## Task 1: Listing query module (sync DB work, lazy `node:sqlite`)

**Files:**
- Create: `server/coding-cli/providers/opencode-listing-query.ts`
- Test: `test/unit/server/coding-cli/opencode-listing-query.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/server/coding-cli/opencode-listing-query.test.ts
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runOpencodeListingQuery,
  THREE_VIEWS_MARKER_SQL_PATTERN,
} from '../../../../server/coding-cli/providers/opencode-listing-query'

vi.unmock('node:sqlite')

type SqliteModule = typeof import('node:sqlite')
type DatabaseSyncConstructor = SqliteModule['DatabaseSync']
type DatabaseSyncInstance = InstanceType<DatabaseSyncConstructor>

const threeViewsMarker = '<freshell-session-metadata origin=3-views noninteractive=true>'

describe('runOpencodeListingQuery', () => {
  let tempDir: string
  let DatabaseSync: DatabaseSyncConstructor

  beforeAll(async () => {
    DatabaseSync = (await import('node:sqlite')).DatabaseSync
  })
  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-query-'))
  })
  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  function createSchema(db: DatabaseSyncInstance, opts: { parentId?: boolean } = {}): void {
    const parentCol = opts.parentId === false ? '' : 'parent_id text,'
    db.exec(`
      CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
      CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, ${parentCol} slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
      CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    `)
  }
  function seedProject(db: DatabaseSyncInstance) {
    db.prepare(`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)`).run('project-1', '/repo/root', 900, 4000, '[]')
  }
  function seedSession(db: DatabaseSyncInstance, id: string, title: string, timeUpdated: number, parentId: string | null = null, archived: number | null = null) {
    db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, 'project-1', parentId, id, '/repo/root', title, 'test', 1000, timeUpdated, archived)
  }
  // For the parent_id-absent schema: an INSERT that does NOT reference the
  // missing parent_id column (seedSession would fail at bind time otherwise).
  function seedFlatSession(db: DatabaseSyncInstance, id: string, title: string, timeUpdated: number) {
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, 'project-1', id, '/repo/root', title, 'test', 1000, timeUpdated, null)
  }
  function seedMessage(db: DatabaseSyncInstance, id: string, sessionId: string, data: string) {
    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(id, sessionId, 1100, 1100, data)
  }
  function seedPart(db: DatabaseSyncInstance, id: string, messageId: string, sessionId: string, data: string) {
    db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(id, messageId, sessionId, 1100, 1100, data)
  }

  it('flags marker in a part, marker in a message, and leaves a normal session unmarked; sorted by time_updated desc', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      createSchema(db)
      seedProject(db)
      seedSession(db, 'session-part-marker', 'Part marker', 3000)
      seedSession(db, 'session-message-marker', 'Message marker', 2500)
      seedSession(db, 'session-normal', 'Normal', 2000)
      seedMessage(db, 'm-part', 'session-part-marker', JSON.stringify({ role: 'user' }))
      seedPart(db, 'p-marked', 'm-part', 'session-part-marker', JSON.stringify({ type: 'text', text: `hi\n${threeViewsMarker}` }))
      seedMessage(db, 'm-msg', 'session-message-marker', JSON.stringify({ role: 'user', text: `hi\n${threeViewsMarker}` }))
      seedMessage(db, 'm-normal', 'session-normal', JSON.stringify({ role: 'user', text: 'ordinary prompt' }))
    } finally {
      db.close()
    }

    const result = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)

    expect(result.schemaMissingParentId).toBe(false)
    expect(result.rows.map((r) => [r.sessionId, !!r.hasThreeViewsMarker])).toEqual([
      ['session-part-marker', true],
      ['session-message-marker', true],
      ['session-normal', false],
    ])
    expect(result.rows[0]).toMatchObject({ cwd: '/repo/root', title: 'Part marker', createdAt: 1000, lastActivityAt: 3000, projectPath: '/repo/root' })
  })

  it('excludes archived sessions and child sessions (parent_id not null)', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      createSchema(db)
      seedProject(db)
      seedSession(db, 'root', 'Root', 3000)
      seedSession(db, 'child', 'Child', 2900, 'root')
      seedSession(db, 'archived', 'Archived', 2800, null, 5000)
    } finally {
      db.close()
    }
    const result = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(result.rows.map((r) => r.sessionId)).toEqual(['root'])
  })

  it('reports schemaMissingParentId and returns all non-archived sessions when parent_id is absent', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      createSchema(db, { parentId: false })
      seedProject(db)
      seedFlatSession(db, 'a', 'A', 3000)
      seedFlatSession(db, 'b', 'B', 2000)
    } finally {
      db.close()
    }
    const result = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(result.schemaMissingParentId).toBe(true)
    expect(result.rows.map((r) => r.sessionId)).toEqual(['a', 'b'])
  })

  it('degrades to unmarked (no throw) when part/message tables are absent', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      // Only project + session — mirrors the e2e fake-opencode fixture's schema.
      db.exec(`
        CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
        CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
      `)
      seedProject(db)
      seedSession(db, 'only', 'Only', 2000)
    } finally {
      db.close()
    }
    const result = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(result.rows.map((r) => [r.sessionId, !!r.hasThreeViewsMarker])).toEqual([['only', false]])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/opencode-listing-query.test.ts --run`
Expected: FAIL — cannot resolve `opencode-listing-query` / `runOpencodeListingQuery is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/coding-cli/providers/opencode-listing-query.ts
export type OpencodeSessionRow = {
  sessionId: string
  cwd: string
  title: string
  createdAt: number
  lastActivityAt: number
  projectPath: string | null
  hasThreeViewsMarker?: number | null
}

export type OpencodeListingResult = {
  rows: OpencodeSessionRow[]
  schemaMissingParentId: boolean
}

export const THREE_VIEWS_MARKER_SQL_PATTERN = '%<freshell-session-metadata origin=3-views%'

const OPENCODE_DB_BUSY_TIMEOUT_MS = 5000

/**
 * OpenCode session listing query. Opens the DB read-only, inspects whether the
 * session table exposes parent_id, runs the root-session listing (including the
 * hasThreeViewsMarker LIKE subqueries), and returns the raw rows.
 *
 * The DB work is the heavy, thread-blocking part (~180 ms on a 531 MB DB) — which
 * is exactly why this runs inside a worker thread. The function is `async` ONLY
 * because it imports `node:sqlite` LAZILY: a static top-level import would be
 * eagerly triggered when opencode.ts loads and fire vi.mock('node:sqlite')'s
 * hoisted factory before the mock test's inline FakeDatabaseSync class is
 * initialized (TDZ ReferenceError). Lazy `await import('node:sqlite')` is the
 * same pattern the current production code uses and is intercepted correctly by
 * vi.mock (spike-validated). No logging, no fs-async — trivially worker-portable.
 */
export async function runOpencodeListingQuery(
  dbPath: string,
  markerPattern: string,
): Promise<OpencodeListingResult> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCODE_DB_BUSY_TIMEOUT_MS}`)
    const columns = db.prepare('PRAGMA table_info(session)').all() as Array<{ name?: unknown }>
    const hasParentId = columns.some((c) => c.name === 'parent_id')
    const rootFilter = hasParentId ? 'AND s.parent_id IS NULL' : ''
    // The 3-views marker lives in part.data / message.data. Older/partial schemas
    // (and the e2e fake-opencode fixture, which has only project+session) may lack
    // those tables; degrade gracefully to "no marker" instead of throwing
    // "no such table: part". When absent, every session is simply unmarked.
    const tableNames = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: unknown }>)
        .map((row) => row.name),
    )
    const canDetectMarker = tableNames.has('part') && tableNames.has('message')
    const markerExpr = canDetectMarker
      ? `(
          EXISTS (SELECT 1 FROM part pa WHERE pa.session_id = s.id AND pa.data LIKE ?)
          OR EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.data LIKE ?)
        )`
      : '0'
    const rows = db.prepare(`
      SELECT
        s.id AS sessionId,
        s.directory AS cwd,
        s.title AS title,
        s.time_created AS createdAt,
        s.time_updated AS lastActivityAt,
        p.worktree AS projectPath,
        ${markerExpr} AS hasThreeViewsMarker
      FROM session s
      LEFT JOIN project p ON p.id = s.project_id
      WHERE s.time_archived IS NULL
        ${rootFilter}
      ORDER BY s.time_updated DESC
    `).all(...(canDetectMarker ? [markerPattern, markerPattern] : [])) as OpencodeSessionRow[]
    return { rows, schemaMissingParentId: !hasParentId }
  } finally {
    db.close()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/opencode-listing-query.test.ts --run`
Expected: PASS (4 tests: part-marker/message-marker/normal ordering, archived+child exclusion, parent_id-absent flat roots, missing part/message degrades to unmarked).

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/providers/opencode-listing-query.ts test/unit/server/coding-cli/opencode-listing-query.test.ts
git commit -m "feat(opencode): extract pure synchronous session-listing query"
```

---

## Task 2: Worker entry

**Files:**
- Create: `server/coding-cli/providers/opencode-listing.worker.ts`
- Test: `test/unit/server/coding-cli/opencode-listing-worker.test.ts`

- [ ] **Step 1: Write the failing test** (tests `executeListing` in-process — no real thread)

```ts
// test/unit/server/coding-cli/opencode-listing-worker.test.ts
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeListing, OPENCODE_LISTING_WORKER_KIND } from '../../../../server/coding-cli/providers/opencode-listing.worker'
import { THREE_VIEWS_MARKER_SQL_PATTERN } from '../../../../server/coding-cli/providers/opencode-listing-query'

vi.unmock('node:sqlite')

const queryModuleUrl = new URL('../../../../server/coding-cli/providers/opencode-listing-query.ts', import.meta.url).href

describe('opencode listing worker executeListing', () => {
  let tempDir: string
  beforeEach(async () => { tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-worker-')) })
  afterEach(async () => { await fsp.rm(tempDir, { recursive: true, force: true }) })

  it('dynamically imports the query module and returns its result', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
        CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
        CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
        CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      `)
      db.prepare(`INSERT INTO project VALUES (?, ?, ?, ?, ?)`).run('project-1', '/repo/root', 900, 4000, '[]')
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('s1', 'project-1', null, 's1', '/repo/root', 'Title', 'test', 1000, 2000, null)
    } finally {
      db.close()
    }

    const result = await executeListing({ queryModuleUrl, dbPath, markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN })
    expect(result.schemaMissingParentId).toBe(false)
    expect(result.rows.map((r) => r.sessionId)).toEqual(['s1'])
  })

  it('does not auto-run on import under the threaded test runtime (sentinel guard)', () => {
    // The server Vitest config uses pool: 'threads', so this test file runs inside
    // a worker thread (parentPort is non-null). Importing the worker module at the
    // top of this file must NOT have triggered executeListing against Vitest's
    // workerData — the sentinel guard (workerData.kind !== OPENCODE_LISTING_WORKER_KIND)
    // prevents it. If the guard were broken, the import would have posted to Vitest's
    // parent port and likely corrupted the run; reaching this assertion proves it didn't.
    expect(typeof executeListing).toBe('function')
    expect(OPENCODE_LISTING_WORKER_KIND).toBe('opencode-listing-worker')
    expect(queryModuleUrl).toContain('opencode-listing-query')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/opencode-listing-worker.test.ts --run`
Expected: FAIL — cannot resolve `opencode-listing.worker` / `executeListing` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/coding-cli/providers/opencode-listing.worker.ts
import { parentPort, workerData } from 'node:worker_threads'
import type { OpencodeListingResult } from './opencode-listing-query.js'

/**
 * Sentinel proving this thread was spawned by OUR runner. REQUIRED because the
 * server Vitest config runs test files in worker threads (`pool: 'threads'`), so
 * `parentPort` is non-null when a test imports this module. Without the sentinel,
 * the auto-run block below would fire on import using Vitest's OWN workerData and
 * post a message to Vitest's parent port — corrupting/hanging the test worker.
 * The runner injects this exact value in workerData; Vitest's workerData never has it.
 */
export const OPENCODE_LISTING_WORKER_KIND = 'opencode-listing-worker'

export type WorkerListingInput = {
  kind: typeof OPENCODE_LISTING_WORKER_KIND
  queryModuleUrl: string
  dbPath: string
  markerPattern: string
}

/**
 * Run the listing query by dynamically importing the EXACT resolved query-module
 * URL (.ts in dev/test, .js in prod) provided by the spawning code. We pass the
 * exact URL rather than a static relative import because NodeNext `.js`→`.ts`
 * remapping fails inside a worker thread (validated by spike).
 */
export async function executeListing(
  input: { queryModuleUrl: string; dbPath: string; markerPattern: string },
): Promise<OpencodeListingResult> {
  const mod = await import(input.queryModuleUrl) as typeof import('./opencode-listing-query.js')
  return mod.runOpencodeListingQuery(input.dbPath, input.markerPattern)
}

// Auto-run ONLY when we are a real worker spawned by our runner (parentPort present
// AND our sentinel in workerData). This is import-safe under Vitest's thread pool.
if (parentPort && (workerData as Partial<WorkerListingInput> | undefined)?.kind === OPENCODE_LISTING_WORKER_KIND) {
  const port = parentPort
  executeListing(workerData as WorkerListingInput)
    .then((result) => port.postMessage({ ok: true, rows: result.rows, schemaMissingParentId: result.schemaMissingParentId }))
    .catch((err: unknown) => {
      const error = err instanceof Error ? { name: err.name, message: err.message } : { name: 'Error', message: String(err) }
      port.postMessage({ ok: false, error })
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/opencode-listing-worker.test.ts --run`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/providers/opencode-listing.worker.ts test/unit/server/coding-cli/opencode-listing-worker.test.ts
git commit -m "feat(opencode): add off-thread listing worker entry"
```

---

## Task 3: Off-thread query runner

**Files:**
- Create: `server/coding-cli/providers/opencode-listing-runner.ts`
- Test: `test/unit/server/coding-cli/opencode-listing-runner.test.ts`

The runner spawns the worker, awaits the first message, terminates the worker on every path, and enforces a timeout. `spawn` is injectable so unit tests exercise orchestration with a fake worker (no real OS thread). `queryModuleUrl` is overridable so the integration test can point at a slow fixture.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/server/coding-cli/opencode-listing-runner.test.ts
import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { createWorkerListingRunner } from '../../../../server/coding-cli/providers/opencode-listing-runner'
import { THREE_VIEWS_MARKER_SQL_PATTERN } from '../../../../server/coding-cli/providers/opencode-listing-query'

class FakeWorker extends EventEmitter {
  terminated = 0
  postedData: unknown
  execArgv: string[]
  constructor(public url: URL, public options: { workerData: unknown; execArgv: string[] }) {
    super()
    this.postedData = options.workerData
    this.execArgv = options.execArgv
  }
  terminate() { this.terminated += 1; return Promise.resolve(0) }
  // helpers
  emitMessage(msg: unknown) { this.emit('message', msg) }
  emitError(err: Error) { this.emit('error', err) }
  emitExit(code: number) { this.emit('exit', code) }
}

function makeRunner(overrides: Partial<Parameters<typeof createWorkerListingRunner>[0]> = {}) {
  const workers: FakeWorker[] = []
  const spawn = vi.fn((url: URL, options: { workerData: unknown; execArgv: string[] }) => {
    const w = new FakeWorker(url, options)
    workers.push(w)
    return w
  })
  const runner = createWorkerListingRunner({ spawn: spawn as any, timeoutMs: 50, ...overrides })
  return { runner, workers, spawn }
}

const input = { dbPath: '/tmp/opencode.db', markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN }

describe('createWorkerListingRunner', () => {
  it('resolves rows from an ok message and terminates the worker', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitMessage({ ok: true, rows: [{ sessionId: 's1' }], schemaMissingParentId: false })
    const result = await promise
    expect(result.rows).toEqual([{ sessionId: 's1' }])
    expect(result.schemaMissingParentId).toBe(false)
    expect(workers[0].terminated).toBe(1)
  })

  it('passes dbPath, markerPattern and a queryModuleUrl in workerData, and suppresses the experimental warning via execArgv', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    const data = workers[0].postedData as any
    expect(data.dbPath).toBe(input.dbPath)
    expect(data.markerPattern).toBe(THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(String(data.queryModuleUrl)).toContain('opencode-listing-query')
    expect(data.kind).toBe('opencode-listing-worker') // sentinel that gates the worker auto-run
    // Appended to process.execArgv so the tsx loader (dev) survives AND the
    // per-spawn node:sqlite ExperimentalWarning is silenced.
    expect(workers[0].execArgv).toEqual([...process.execArgv, '--disable-warning=ExperimentalWarning'])
    workers[0].emitMessage({ ok: true, rows: [], schemaMissingParentId: false })
    await promise
  })

  it('ignores a late exit event after a successful message (no double-settle)', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitMessage({ ok: true, rows: [{ sessionId: 's1' }], schemaMissingParentId: false })
    // A real Worker emits 'exit' after terminate(); the settled guard must swallow it.
    workers[0].emitExit(0)
    await expect(promise).resolves.toMatchObject({ rows: [{ sessionId: 's1' }] })
    expect(workers[0].terminated).toBe(1)
  })

  it('rejects on an error message and terminates', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitMessage({ ok: false, error: { name: 'SqliteError', message: 'boom' } })
    await expect(promise).rejects.toThrow(/boom/)
    expect(workers[0].terminated).toBe(1)
  })

  it.each([
    ['ok:true without rows', { ok: true, schemaMissingParentId: false }],
    ['ok:true with non-array rows', { ok: true, rows: 'nope', schemaMissingParentId: false }],
    ['ok:true without schemaMissingParentId', { ok: true, rows: [] }],
    ['ok:false without error', { ok: false }],
    ['no ok key', { rows: [] }],
  ])('rejects a malformed message (%s) instead of resolving undefined', async (_label, msg) => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitMessage(msg)
    await expect(promise).rejects.toThrow(/malformed|failed/i)
    expect(workers[0].terminated).toBe(1)
  })

  it('rejects on a worker error event and terminates', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitError(new Error('worker crashed'))
    await expect(promise).rejects.toThrow(/worker crashed/)
    expect(workers[0].terminated).toBe(1)
  })

  it('rejects when the worker exits before sending a message', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitExit(1)
    await expect(promise).rejects.toThrow(/exit/i)
  })

  it('rejects and terminates on timeout', async () => {
    vi.useFakeTimers()
    try {
      const { runner, workers } = makeRunner({ timeoutMs: 25 })
      const promise = runner(input)
      await Promise.resolve()
      const expectation = expect(promise).rejects.toThrow(/timed out/i)
      await vi.advanceTimersByTimeAsync(30)
      await expectation
      expect(workers[0].terminated).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/opencode-listing-runner.test.ts --run`
Expected: FAIL — `createWorkerListingRunner` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/coding-cli/providers/opencode-listing-runner.ts
import { Worker } from 'node:worker_threads'
import type { OpencodeListingResult, OpencodeSessionRow } from './opencode-listing-query.js'
// Importing the worker module on the MAIN thread (or a Vitest worker) is safe:
// its auto-run is sentinel-guarded, so this import never spawns/posts anything.
import { OPENCODE_LISTING_WORKER_KIND } from './opencode-listing.worker.js'

export type OpencodeListingQueryInput = { dbPath: string; markerPattern: string }
export type OpencodeListingQueryRunner = (input: OpencodeListingQueryInput) => Promise<OpencodeListingResult>

type WorkerLike = {
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number> | void
}

export type WorkerSpawnOptions = { workerData: unknown; execArgv: string[] }

export type CreateWorkerListingRunnerOptions = {
  /** Injectable for unit tests; default spawns a real worker_threads Worker. */
  spawn?: (workerUrl: URL, options: WorkerSpawnOptions) => WorkerLike
  /** Override the query-module URL (used by the off-thread integration fixture). */
  queryModuleUrl?: string
  /** Hard timeout for a single listing query. Default 15 s (the real query is ~180 ms). */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
// import.meta.url ends with `.ts` in dev/test (tsx / native strip-types) and
// `.js` in prod (compiled dist). Resolve siblings with the matching extension.
const SELF_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
// Append to process.execArgv (do NOT replace) so tsx's `--import .../loader.mjs`
// is inherited in dev; the flag silences node:sqlite's per-spawn ExperimentalWarning.
const WORKER_EXECARGV = [...process.execArgv, '--disable-warning=ExperimentalWarning']

function defaultWorkerUrl(): URL {
  return new URL(`./opencode-listing.worker${SELF_EXT}`, import.meta.url)
}
function defaultQueryModuleUrl(): string {
  return new URL(`./opencode-listing-query${SELF_EXT}`, import.meta.url).href
}
function defaultSpawn(workerUrl: URL, options: WorkerSpawnOptions): WorkerLike {
  return new Worker(workerUrl, options)
}

type OkMessage = { ok: true; rows: OpencodeSessionRow[]; schemaMissingParentId: boolean }
type ErrMessage = { ok: false; error: { name: string; message: string } }

// Validate the FULL shape, not just the presence of `ok` — a truncated/garbled
// message like `{ ok: true }` must NOT resolve `{ rows: undefined }`.
function isOkMessage(value: unknown): value is OkMessage {
  return typeof value === 'object' && value !== null
    && (value as { ok?: unknown }).ok === true
    && Array.isArray((value as { rows?: unknown }).rows)
    && typeof (value as { schemaMissingParentId?: unknown }).schemaMissingParentId === 'boolean'
}
function isErrMessage(value: unknown): value is ErrMessage {
  if (typeof value !== 'object' || value === null) return false
  if ((value as { ok?: unknown }).ok !== false) return false
  const error = (value as { error?: unknown }).error
  return typeof error === 'object' && error !== null
    && typeof (error as { message?: unknown }).message === 'string'
}

export function createWorkerListingRunner(
  options: CreateWorkerListingRunnerOptions = {},
): OpencodeListingQueryRunner {
  const spawn = options.spawn ?? defaultSpawn
  const queryModuleUrl = options.queryModuleUrl ?? defaultQueryModuleUrl()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const workerUrl = defaultWorkerUrl()

  return (input: OpencodeListingQueryInput): Promise<OpencodeListingResult> => {
    return new Promise<OpencodeListingResult>((resolve, reject) => {
      const worker = spawn(workerUrl, { workerData: { ...input, queryModuleUrl, kind: OPENCODE_LISTING_WORKER_KIND }, execArgv: WORKER_EXECARGV })
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        try { void worker.terminate() } catch { /* ignore */ }
      }
      const settleResolve = (result: OpencodeListingResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const settleReject = (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }

      timer = setTimeout(() => settleReject(new Error(`OpenCode listing worker timed out after ${timeoutMs}ms`)), timeoutMs)
      if (typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref()

      worker.on('message', (value: unknown) => {
        if (isOkMessage(value)) {
          settleResolve({ rows: value.rows, schemaMissingParentId: value.schemaMissingParentId })
        } else if (isErrMessage(value)) {
          const err = new Error(value.error.message || 'OpenCode listing worker failed')
          err.name = value.error.name ?? 'Error'
          settleReject(err)
        } else {
          settleReject(new Error('OpenCode listing worker sent a malformed message'))
        }
      })
      worker.on('error', (err: Error) => settleReject(err))
      worker.on('exit', (code: number) => settleReject(new Error(`OpenCode listing worker exited (code ${code}) before responding`)))
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/opencode-listing-runner.test.ts --run`
Expected: PASS (all runner orchestration cases: ok→resolve+terminate, workerData+execArgv, late-exit-after-success, error message, malformed messages, error event, early exit, timeout).

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/providers/opencode-listing-runner.ts test/unit/server/coding-cli/opencode-listing-runner.test.ts
git commit -m "feat(opencode): add worker-backed listing query runner"
```

---

## Task 4: Wire the provider to the off-thread runner

**Files:**
- Modify: `server/coding-cli/providers/opencode.ts`
- Modify: `test/unit/server/coding-cli/opencode-provider.test.ts`
- Modify: `test/unit/server/coding-cli/opencode-provider.sqlite.test.ts`

The provider keeps `missing_db` / `sqlite_unavailable` pre-checks and the async row→session mapping, but delegates open+query to `this.queryRunner`, returning `[]` for absent/empty states and throwing on a worker/read failure. Existing tests inject an **in-process runner** so the `node:sqlite` mock and real-sqlite paths run without a thread.

- [ ] **Step 1 (Red): Add the in-process runner seam and update existing tests to use it**

First, define an exported in-process runner so tests (and any non-worker callers) can opt out of the thread. Add to `opencode-listing-runner.ts`:

```ts
import { runOpencodeListingQuery } from './opencode-listing-query.js'

/** Runs the listing query on the caller's thread (no worker). For tests and fallbacks. */
export const inProcessListingRunner: OpencodeListingQueryRunner = (input) =>
  runOpencodeListingQuery(input.dbPath, input.markerPattern)
```

Update `test/unit/server/coding-cli/opencode-provider.sqlite.test.ts` — change construction to inject the in-process runner:

```ts
import { inProcessListingRunner } from '../../../../server/coding-cli/providers/opencode-listing-runner'
// ...
const provider = new OpencodeProvider(tempDir, { queryRunner: inProcessListingRunner })
const sessions = await provider.listSessionsDirect()
// (assertions unchanged)
```

Update `test/unit/server/coding-cli/opencode-provider.test.ts`:

- Add the import:
  ```ts
  import { inProcessListingRunner } from '../../../../server/coding-cli/providers/opencode-listing-runner'
  ```
- Every construction whose test calls `listSessionsDirect()` becomes `new OpencodeProvider(<dir>, { queryRunner: inProcessListingRunner })`. Concretely the constructions in: `'lists root sessions from the OpenCode database'` (~L194), `'logs an empty OpenCode database as empty'` (~L268), `'logs OpenCode database read failures distinctly'` (~L243), and `'treats an OpenCode schema without parent_id as flat roots'` (~L381). Tests that only call `resolveOpencodeSessionRoots` (root-mapping ~L311, retry ~L348) or neither (`'watches...'` ~L214, `'logs missing OpenCode database'` ~L224 — `access()` fails before the runner) work either way; injecting everywhere is harmless and consistent, so inject in all of them.
- **Change this test (two intentional changes).** In `'logs OpenCode database read failures distinctly from an empty database'` (~L239–259):
  1. **Return contract:** a read failure now **throws** (preserving the sidebar). Change the body from `await expect(provider.listSessionsDirect()).resolves.toEqual([])` to `await expect(provider.listSessionsDirect()).rejects.toThrow()`.
  2. **Classification:** the open now happens inside the worker, so the main thread can no longer distinguish open/schema/query phases — they collapse to a single `read_error` class. Change the asserted `messageClass` from `'sqlite_open_failed'` to `'read_error'`:
  ```ts
  expect(loggerMock.warn).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'opencode',
    dbPathLabel: '<opencode-data>/opencode.db',
    dbFile: 'opencode.db',
    pathSanitized: true,
    errorName: 'Error',
    messageClass: 'read_error',
  }), 'Failed to read OpenCode sessions database')
  ```
  The test's intent is preserved: a read failure is logged **distinctly from `empty_db`**, and the raw error message (`'bad sqlite'`) and paths still must not leak from the **logs** (those `loggerMock.warn` assertions stay). `FakeDatabaseSync.failOpenOnce` makes the constructor throw inside `runOpencodeListingQuery`; the in-process runner rejects; the provider logs `read_error` passing only `{ error }` (so `errorName: 'Error'` is logged but the message is not) and then re-throws — the thrown error's message is not a log, so the no-leak assertions are unaffected.

Add a new behavior test to `opencode-provider.test.ts` asserting the provider **throws** (preserving the sidebar via the indexer's no-prune-on-throw) when the injected runner rejects, and logs `read_error`:

```ts
it('throws (does not return []) when the listing runner fails, and logs read_error', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-fail-'))
  await fsp.writeFile(path.join(dir, 'opencode.db'), '') // make access() succeed
  const failingRunner = vi.fn().mockRejectedValue(new Error('worker exploded'))
  const provider = new OpencodeProvider(dir, { queryRunner: failingRunner })
  await expect(provider.listSessionsDirect()).rejects.toThrow('worker exploded')
  expect(failingRunner).toHaveBeenCalledOnce()
  expect(loggerMock.warn).toHaveBeenCalledWith(
    expect.objectContaining({ messageClass: 'read_error' }),
    'Failed to read OpenCode sessions database',
  )
  await fsp.rm(dir, { recursive: true, force: true })
})

it('still returns [] (not throw) for a genuinely empty database', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-empty-'))
  await fsp.writeFile(path.join(dir, 'opencode.db'), '')
  const emptyRunner = vi.fn().mockResolvedValue({ rows: [], schemaMissingParentId: false })
  const provider = new OpencodeProvider(dir, { queryRunner: emptyRunner })
  await expect(provider.listSessionsDirect()).resolves.toEqual([])
  await fsp.rm(dir, { recursive: true, force: true })
})
```

> The in-provider single-flight coalescing considered in an earlier draft was **dropped** (YAGNI): the load-bearing pass confirmed `listSessionsDirect`'s only production caller is `refreshDirectProvider`, and the indexer's `refreshInFlight` gate already serializes every production call — so coalescing in the provider is provably unreachable in production. Less surface, fewer failure modes.

> Note: the mock test file calls `vi.mock('node:sqlite', () => ({ DatabaseSync: FakeDatabaseSync }))`, which replaces `node:sqlite` for the whole module graph of that test file — including the lazily-imported `node:sqlite` inside `opencode-listing-query.ts`. So `inProcessListingRunner` → `runOpencodeListingQuery` → `await import('node:sqlite')` → `new DatabaseSync(dbPath, { readOnly: true })` resolves to `FakeDatabaseSync`. The fake's `exec()` (no-op) satisfies the `PRAGMA busy_timeout`, its `prepare('PRAGMA table_info(session)').all()` returns the column list (so `hasParentId` resolves), and its listing-query `all()` returns seeded rows without a `hasThreeViewsMarker` field (so `isSubagent`/`isNonInteractive` stay undefined — matching the existing assertions). The lazy import is essential: a static `import node:sqlite` would trip `vi.mock` hoisting (TDZ) — see the Lazy import note in the shared contract section.

- [ ] **Step 2 (Red): Run the existing + new provider tests — expect failures**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/opencode-provider.sqlite.test.ts --run`
Expected: FAIL — `OpencodeProvider` constructor does not accept a second `{ queryRunner }` argument; `listSessionsDirect` ignores it.

- [ ] **Step 3 (Green): Implement the provider wiring**

Edit `server/coding-cli/providers/opencode.ts`:

1. Replace the local `OpencodeSessionRow` type and `THREE_VIEWS_MARKER_SQL_PATTERN` with imports from the query module (re-export for any external importers):

```ts
import { createWorkerListingRunner, type OpencodeListingQueryRunner } from './opencode-listing-runner.js'
import { THREE_VIEWS_MARKER_SQL_PATTERN, type OpencodeSessionRow } from './opencode-listing-query.js'
export { THREE_VIEWS_MARKER_SQL_PATTERN } from './opencode-listing-query.js'
export type { OpencodeSessionRow } from './opencode-listing-query.js'
```

2. Add the constructor option:

```ts
export type OpencodeProviderOptions = { queryRunner?: OpencodeListingQueryRunner }

export class OpencodeProvider implements CodingCliProvider {
  // ...existing fields...
  private readonly queryRunner: OpencodeListingQueryRunner

  constructor(
    readonly homeDir: string = defaultOpencodeDataHome(),
    options: OpencodeProviderOptions = {},
  ) {
    this.queryRunner = options.queryRunner ?? createWorkerListingRunner()
  }
```

3. Rewrite `listSessionsDirect()` to keep pre-checks + mapping and delegate the query. Return `[]` for genuinely-absent/empty states; **throw** on a worker/read failure so the indexer preserves the prior sidebar (see Failure contract above):

```ts
  async listSessionsDirect(): Promise<CodingCliSession[]> {
    const dbPath = this.getDatabasePath()
    try {
      await fsp.access(dbPath)
    } catch {
      this.logDatabaseStateOnce('info', 'missing_db', 'OpenCode sessions database is not available')
      return []
    }

    try {
      await import('node:sqlite')
    } catch (err) {
      this.logDatabaseStateOnce('warn', 'sqlite_unavailable', 'node:sqlite unavailable — OpenCode sessions will not appear. Upgrade to Node 22.5+ to enable.', {
        error: err,
        extra: { nodeVersion: process.version },
      })
      return []
    }

    let result
    try {
      result = await this.queryRunner({ dbPath, markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN })
    } catch (err) {
      // A worker/read failure is transient infrastructure failure, NOT "no sessions".
      // Log once and re-throw: refreshDirectProvider catches this and returns early
      // WITHOUT pruning, preserving the previously-listed OpenCode sessions. Returning
      // [] here would make the indexer prune the entire OpenCode sidebar.
      this.logDatabaseStateOnce('warn', 'read_error', 'Failed to read OpenCode sessions database', { error: err })
      throw err
    }

    if (result.schemaMissingParentId) {
      this.logDatabaseStateOnce('warn', 'schema_missing_parent_id', 'OpenCode session schema does not expose parent_id; treating sessions as flat roots')
    }
    if (result.rows.length === 0) {
      this.logDatabaseStateOnce('info', 'empty_db', 'OpenCode sessions database has no active root sessions', { extra: { rowCount: 0 } })
    }

    const sessions: CodingCliSession[] = []
    for (const row of result.rows) {
      if (typeof row.cwd !== 'string' || !row.cwd) continue
      const projectPath = row.projectPath || await resolveGitRepoRoot(row.cwd)
      const isThreeViewsSession = toSqliteBoolean(row.hasThreeViewsMarker)
      sessions.push({
        provider: this.name,
        sessionId: row.sessionId,
        projectPath,
        cwd: row.cwd,
        title: typeof row.title === 'string' ? row.title : undefined,
        lastActivityAt: toValidTimestamp(row.lastActivityAt) ?? Date.now(),
        createdAt: toValidTimestamp(row.createdAt),
        isSubagent: isThreeViewsSession || undefined,
        isNonInteractive: isThreeViewsSession || undefined,
      })
    }
    return sessions
  }
```

4. Delete the now-unused inline open/schema/SELECT in the old `listSessionsDirect` body and the local `OpencodeSessionRow` type declaration. Keep `inspectSessionSchema`, `sessionSchemaCache`, `configureReadOnlyDatabase`, and `resolveOpencodeSessionRoots` (still used by root resolution). Keep `toSqliteBoolean`, `toValidTimestamp`, `OPENCODE_DB_BUSY_TIMEOUT_MS` (root resolution uses the busy timeout). If `THREE_VIEWS_MARKER_SQL_PATTERN`/`toSqliteBoolean` become referenced only here, that's fine.

> The module singleton `export const opencodeProvider = new OpencodeProvider()` now defaults to the worker runner. No change needed at the call site in `server/index.ts`.

- [ ] **Step 4 (Green): Run the provider tests**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/opencode-provider.sqlite.test.ts --run`
Expected: PASS (existing assertions + new throw-on-failure and empty-db tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:server`
Expected: PASS (no unused-symbol or type errors).

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/providers/opencode.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/opencode-provider.sqlite.test.ts server/coding-cli/providers/opencode-listing-runner.ts
git commit -m "feat(opencode): run session listing off the event loop via worker"
```

---

## Task 4b: Preserve the sidebar when a direct provider fails (indexer)

**Files:**
- Modify: `server/coding-cli/session-indexer.ts` (`refreshDirectProvider`)
- Modify: `test/unit/server/coding-cli/session-indexer-provider-refresh.test.ts`

`listSessionsDirect()` now throws on failure (Task 4). For that to preserve the OpenCode sidebar on a **full scan** (not just incremental), `refreshDirectProvider` must, on failure, return the provider's existing direct-cache keys (so the global prune keeps them) and stop logging the raw error.

- [ ] **Step 1: Write the failing regression test**

Add to `test/unit/server/coding-cli/session-indexer-provider-refresh.test.ts`. Mock the logger so we can assert the catch no longer warns with the raw error, and drive a second **full scan** by changing `enabledProviders` (an enabled-set change forces `needsFullScan`), which avoids needing watchers/timers:

```ts
// add near the top, after the existing config-store mock:
const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() }))
loggerMock.child.mockReturnValue(loggerMock)
vi.mock('../../../../server/logger', () => ({ logger: loggerMock, sessionLifecycleLogger: loggerMock }))

import { configStore } from '../../../../server/config-store'
```

```ts
it('preserves cached direct-provider sessions (and does not warn-log the raw error) when listSessionsDirect throws during a full scan', async () => {
  vi.useRealTimers() // this test drives refresh() directly, no timers needed
  loggerMock.warn.mockClear()
  // First refresh: opencode enabled. Second refresh: enabled-set changes
  // (add 'claude') -> enabledKey changes -> needsFullScan -> full-scan path.
  vi.mocked(configStore.snapshot)
    .mockResolvedValueOnce({ settings: { codingCli: { enabledProviders: ['opencode'], providers: {} } } } as never)
    .mockResolvedValueOnce({ settings: { codingCli: { enabledProviders: ['opencode', 'claude'], providers: {} } } } as never)

  const sessions = [{ provider: 'opencode', sessionId: 's1', projectPath: '/repo', cwd: '/repo', lastActivityAt: 2000, createdAt: 1000 }]
  const listSessionsDirect = vi.fn()
    .mockResolvedValueOnce(sessions)                         // full scan #1 succeeds -> s1 cached
    .mockRejectedValue(new Error('worker exploded at /secret/path'))  // full scan #2 throws
  const provider = { ...makeDirectProvider(), listSessionsDirect }
  const indexer = new CodingCliSessionIndexer([provider])

  await indexer.refresh() // full scan #1 (needsFullScan defaults true)
  expect(indexer.getProjects().flatMap((g) => g.sessions).map((s) => s.sessionId)).toEqual(['s1'])

  await indexer.refresh() // full scan #2 (enabled-set changed) — listSessionsDirect throws
  // The cached session must survive the global full-scan prune.
  expect(indexer.getProjects().flatMap((g) => g.sessions).map((s) => s.sessionId)).toEqual(['s1'])

  // The catch must NOT warn-log the failure (it logs debug now), and NO warn/debug
  // payload may carry a raw `err`/Error. NOTE: do NOT assert via JSON.stringify —
  // Error objects serialize to "{}", so a leaked `{ err: new Error('/secret/path') }`
  // would pass a string check. Inspect the call args STRUCTURALLY.
  expect(loggerMock.warn).not.toHaveBeenCalledWith(expect.anything(), 'Could not list provider sessions directly')
  const allLogCalls = [...loggerMock.warn.mock.calls, ...loggerMock.debug.mock.calls]
  for (const [payload] of allLogCalls) {
    if (payload && typeof payload === 'object') {
      expect(Object.prototype.hasOwnProperty.call(payload, 'err')).toBe(false)
      expect(Object.values(payload).some((v) => v instanceof Error)).toBe(false)
    }
  }
  // Assert the exact intended debug call shape (provider only, no error).
  expect(loggerMock.debug).toHaveBeenCalledWith(
    { provider: 'opencode' },
    'Direct provider listing failed; preserving cached sessions',
  )
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/session-indexer-provider-refresh.test.ts --run`
Expected: FAIL — after the second (full-scan) refresh, `getProjects()` is empty (the global prune deleted `s1`), and/or `loggerMock.warn` was called with the raw error.

- [ ] **Step 3: Implement the indexer fix**

In `server/coding-cli/session-indexer.ts`, change the `refreshDirectProvider` catch block (currently ~lines 918–923):

```ts
    try {
      sessions = await provider.listSessionsDirect()
    } catch (err) {
      // A direct-listing failure is transient (e.g. the off-thread worker failed),
      // NOT "no sessions". Preserve this provider's existing direct-cache entries so
      // neither the local prune (below) nor the full-scan global prune deletes them.
      // Log at debug with only the provider name — the provider already emitted a
      // sanitized one-time detail via logDatabaseStateOnce, and logging `err` here
      // would re-leak paths/messages and spam once per failed refresh.
      logger.debug({ provider: provider.name }, 'Direct provider listing failed; preserving cached sessions')
      for (const cacheKey of this.fileCache.keys()) {
        if (this.isDirectCacheKey(cacheKey) && this.fileCache.get(cacheKey)?.provider === provider.name) {
          seenKeys.add(cacheKey)
        }
      }
      return seenKeys
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/session-indexer-provider-refresh.test.ts --run`
Expected: PASS (existing coalescing test + new preservation test).

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/session-indexer.ts test/unit/server/coding-cli/session-indexer-provider-refresh.test.ts
git commit -m "fix(indexer): preserve direct-provider sessions on listing failure (full scan + incremental)"
```

---

## Task 5: Integration test — real worker proves off-thread + non-blocking

**Files:**
- Create: `test/integration/server/fixtures/slow-opencode-listing-query.ts`
- Create: `test/integration/server/opencode-listing-offthread.test.ts`

This is the user-story test: it spawns the **real** worker via the default runner and proves (a) it returns the same rows as the synchronous baseline, and (b) the main event loop keeps ticking while the worker runs a deliberately slow query.

- [ ] **Step 1: Write the slow fixture query module**

```ts
// test/integration/server/fixtures/slow-opencode-listing-query.ts
// Drop-in replacement for opencode-listing-query's runOpencodeListingQuery that
// blocks its OWN (worker) thread for a fixed duration, then returns known rows.
// Used to prove the main event loop is not blocked while the worker runs.
// (Returns synchronously; the worker awaits it, so a non-Promise return is fine.)
import type { OpencodeListingResult } from '../../../../server/coding-cli/providers/opencode-listing-query.js'

const SLEEP_MS = 250

export function runOpencodeListingQuery(_dbPath: string, _markerPattern: string): OpencodeListingResult {
  const end = Date.now() + SLEEP_MS
  while (Date.now() < end) { /* busy-block this worker thread */ }
  return {
    rows: [{ sessionId: 'slow-1', cwd: '/repo/root', title: 'Slow', createdAt: 1000, lastActivityAt: 2000, projectPath: '/repo/root', hasThreeViewsMarker: 0 }],
    schemaMissingParentId: false,
  }
}
```

- [ ] **Step 2: Write the failing integration test**

```ts
// test/integration/server/opencode-listing-offthread.test.ts
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkerListingRunner } from '../../../server/coding-cli/providers/opencode-listing-runner'
import { runOpencodeListingQuery, THREE_VIEWS_MARKER_SQL_PATTERN } from '../../../server/coding-cli/providers/opencode-listing-query'

vi.unmock('node:sqlite')

const threeViewsMarker = '<freshell-session-metadata origin=3-views noninteractive=true>'
// Exact (.ts in dev/test) URL of the slow fixture — same resolution strategy as the runner.
const slowQueryModuleUrl = new URL('./fixtures/slow-opencode-listing-query.ts', import.meta.url).href

describe('OpenCode listing off-thread (real worker)', () => {
  let tempDir: string
  beforeEach(async () => { tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-offthread-')) })
  afterEach(async () => { await fsp.rm(tempDir, { recursive: true, force: true }) })

  it('returns the same rows as the synchronous baseline', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
        CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
        CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
        CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      `)
      db.prepare(`INSERT INTO project VALUES (?, ?, ?, ?, ?)`).run('project-1', '/repo/root', 900, 4000, '[]')
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('marked', 'project-1', null, 'marked', '/repo/root', 'Marked', 'test', 1000, 3000, null)
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('plain', 'project-1', null, 'plain', '/repo/root', 'Plain', 'test', 1000, 2000, null)
      db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run('m1', 'marked', 1100, 1100, JSON.stringify({ role: 'user', text: threeViewsMarker }))
      db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run('m2', 'plain', 1100, 1100, JSON.stringify({ role: 'user', text: 'ordinary' }))
    } finally {
      db.close()
    }

    const runner = createWorkerListingRunner()
    const result = await runner({ dbPath, markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN })
    const baseline = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(result.rows).toEqual(baseline.rows)
    expect(result.rows.map((r) => [r.sessionId, !!r.hasThreeViewsMarker])).toEqual([['marked', true], ['plain', false]])
  })

  it('does not block the event loop while the worker runs a slow query', async () => {
    const runner = createWorkerListingRunner({ queryModuleUrl: slowQueryModuleUrl })
    let ticks = 0
    const interval = setInterval(() => { ticks += 1 }, 10)
    try {
      const result = await runner({ dbPath: path.join(tempDir, 'unused.db'), markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN })
      expect(result.rows.map((r) => r.sessionId)).toEqual(['slow-1'])
      // The worker busy-blocks its OWN thread for ~250 ms. If the main loop were
      // blocked, the interval could not fire. We expect many ticks (>= ~10).
      expect(ticks).toBeGreaterThanOrEqual(10)
    } finally {
      clearInterval(interval)
    }
  })
})
```

- [ ] **Step 3: Run to verify it fails, then passes**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/integration/server/opencode-listing-offthread.test.ts --run`
Expected before Tasks 1–3 exist: FAIL (imports unresolved). After Tasks 1–4: PASS (2 tests). The non-blocking test confirms the main loop ticked ≥ 10 times during a 250 ms worker query.

> If this test reveals the real worker cannot load in the vitest runtime on some machine (e.g. Node < 22.18 without native strip-types), that is a genuine failure of the production path on that runtime — do not paper over it. The spike validated Node 22.21; if CI uses an older Node, gate the real-worker test behind a `node:sqlite`-availability + Node-version check and add a `tsx`-run smoke (`scripts/`) instead. Record the decision in the PR.

- [ ] **Step 4: Commit**

```bash
git add test/integration/server/opencode-listing-offthread.test.ts test/integration/server/fixtures/slow-opencode-listing-query.ts
git commit -m "test(opencode): integration coverage for off-thread listing (correctness + non-blocking)"
```

---

## Task 5b: Server-side discovery proof (real worker through provider + indexer)

**Files:**
- Create: `test/integration/server/opencode-listing-discovery.test.ts`

Task 5 spawns the worker via the runner in isolation. This proves the **production discovery path** — the real `OpencodeProvider` (DEFAULT worker runner, no injection) feeding the real `CodingCliSessionIndexer`, which is the source of the `/api/sessions` project state — actually runs the off-thread worker and surfaces sessions with correct marker classification. This is the meaningful "session discovery populated from a DB after refresh" gate (the existing browser e2e does NOT exercise `listSessionsDirect`).

- [ ] **Step 1: Write the test**

```ts
// test/integration/server/opencode-listing-discovery.test.ts
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:sqlite')
vi.mock('../../../server/config-store', () => ({
  configStore: {
    getProjectColors: vi.fn().mockResolvedValue({}),
    snapshot: vi.fn().mockResolvedValue({ settings: { codingCli: { enabledProviders: ['opencode'], providers: {} } } }),
  },
}))

import { OpencodeProvider } from '../../../server/coding-cli/providers/opencode'
import { CodingCliSessionIndexer } from '../../../server/coding-cli/session-indexer.js'

const marker = '<freshell-session-metadata origin=3-views noninteractive=true>'

describe('OpenCode discovery via the off-thread worker (provider + indexer)', () => {
  let home: string
  beforeEach(async () => { home = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-discovery-')) })
  afterEach(async () => { await fsp.rm(home, { recursive: true, force: true }) })

  it('surfaces DB sessions (with marker→isSubagent) through a full refresh using the real worker', async () => {
    const dbPath = path.join(home, 'opencode.db')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
        CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
        CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
        CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      `)
      db.prepare(`INSERT INTO project VALUES (?, ?, ?, ?, ?)`).run('p', '/repo/root', 900, 4000, '[]')
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('marked', 'p', null, 'marked', '/repo/root', 'Marked', 'v', 1000, 3000, null)
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('normal', 'p', null, 'normal', '/repo/root', 'Normal', 'v', 1000, 2000, null)
      db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run('m1', 'marked', 1100, 1100, JSON.stringify({ role: 'user', text: marker }))
      db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run('m2', 'normal', 1100, 1100, JSON.stringify({ role: 'user', text: 'ordinary' }))
    } finally {
      db.close()
    }

    // DEFAULT runner = the real off-thread worker (no injection).
    const provider = new OpencodeProvider(home)
    const indexer = new CodingCliSessionIndexer([provider])
    await indexer.refresh()

    const sessions = indexer.getProjects().flatMap((g) => g.sessions)
    const marked = sessions.find((s) => s.sessionId === 'marked')
    const normal = sessions.find((s) => s.sessionId === 'normal')
    expect(marked).toBeDefined()
    expect(marked?.isSubagent).toBe(true)
    expect(marked?.isNonInteractive).toBe(true)
    expect(normal).toBeDefined()
    expect(normal?.isSubagent).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/integration/server/opencode-listing-discovery.test.ts --run`
Expected before Tasks 1–4: FAIL (imports/behavior). After Tasks 1–4: PASS — the real worker spawned by the default runner discovered both sessions and classified the marker one as subagent, end-to-end through the indexer.

- [ ] **Step 3: Commit**

```bash
git add test/integration/server/opencode-listing-discovery.test.ts
git commit -m "test(opencode): prove off-thread worker discovery through provider + indexer"
```

---

## Task 6: Production-path verification & full suite

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole server**

Run: `npm run typecheck:server`
Expected: PASS.

- [ ] **Step 2: Build the server and verify the worker compiled to dist**

Run (from this worktree, which is safe to build — not the live-served checkout):
```bash
npm run build:server
ls dist/server/coding-cli/providers/opencode-listing.worker.js dist/server/coding-cli/providers/opencode-listing-query.js dist/server/coding-cli/providers/opencode-listing-runner.js
```
Expected: all three `.js` files exist (confirms `tsc` compiled the new files; the prod extension-swap will resolve them).

- [ ] **Step 3: Prove the compiled (prod) worker path runs against a real DB**

Write the check to a file (reused verbatim by Step 3b), then run it with the host `node` (prod resolution — `import.meta.url` ends in `.js`):
```bash
cat > /tmp/oc-prod-check.mjs <<'EOF'
import os from 'os'; import path from 'path'; import fsp from 'fs/promises';
import { pathToFileURL } from 'url';
// Resolve dist absolutely from the cwd (where `node` is invoked = the worktree
// root). A relative './dist' import would resolve against /tmp where this file
// lives, not the repo. Run this from the worktree root.
const distBase = pathToFileURL(path.join(process.cwd(), 'dist', 'server', 'coding-cli', 'providers') + path.sep).href;
const { createWorkerListingRunner } = await import(distBase + 'opencode-listing-runner.js');
const { THREE_VIEWS_MARKER_SQL_PATTERN } = await import(distBase + 'opencode-listing-query.js');
const { DatabaseSync } = await import('node:sqlite');
const dir = await fsp.mkdtemp(path.join(os.tmpdir(),'oc-prod-')); const dbPath = path.join(dir,'opencode.db');
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL); CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer); CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL); CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);');
db.prepare('INSERT INTO project VALUES (?,?,?,?,?)').run('p','/repo',900,4000,'[]');
db.prepare('INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated,time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)').run('s','p',null,'s','/repo','T','v',1000,2000,null);
db.close();
const runner = createWorkerListingRunner();
const r = await runner({ dbPath, markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN });
console.log('PROD_WORKER_OK', JSON.stringify(r.rows.map(x=>x.sessionId)));
await fsp.rm(dir,{recursive:true,force:true});
EOF
node /tmp/oc-prod-check.mjs
```
Expected: `PROD_WORKER_OK ["s"]` (proves the compiled worker spawns and resolves `.js` siblings under plain `node`).

- [ ] **Step 3b (optional): Prove the Electron bundled Node (v22.12.0) spawns the worker**

The desktop app runs the compiled server under a bundled standalone Node (v22.12.0, `scripts/bundled-node-version.json`), not the host Node. If a bundled binary is present locally, run the **same** `/tmp/oc-prod-check.mjs` from Step 3 with it:
```bash
BN=$(find . node_modules -path '*bundled-node*/bin/node' -type f 2>/dev/null | head -1)
if [ -n "$BN" ]; then echo "bundled node: $("$BN" --version)"; "$BN" /tmp/oc-prod-check.mjs; else echo "no bundled node locally — skip (covered by 22.12>=22.5 floor + extraResources)"; fi
```
Expected: `PROD_WORKER_OK ["s"]` under v22.12.0, or a clean skip. This is belt-and-suspenders — `node:sqlite` (≥22.5) and `worker_threads` are guaranteed present in 22.12.0, the binary is byte-for-byte from nodejs.org, and the throw-on-failure contract degrades gracefully if it ever regressed.

- [ ] **Step 4: Run the full coordinated suite**

Run: `FRESHELL_TEST_SUMMARY="opencode off-thread listing worker" npm test`
Expected: green (default + server configs). Investigate any failure; do not proceed with a red suite.

- [ ] **Step 4b: OpenCode browser e2e regression guard**

Where coverage actually lives (don't overclaim the browser spec):
- **Worker discovery** (the changed behavior — a DB session surfacing via `listSessionsDirect`→worker into the project state that feeds `/api/sessions`) is proven by **Task 5b** (real worker through provider+indexer) and **Task 5** (real worker correctness + non-blocking). **Marker detection** is proven by Task 1 + Task 5 against the real schema. The browser `fake-opencode.cjs` fixture has only `project`+`session` (no `part`/`message`), so it does NOT exercise marker detection.
- The browser recovery spec is a **regression guard** for the UI recovery/`sessionRef` flow. It does NOT assert the worker's output (OpenCode sidebar sessions originate from `listSessionsDirect`, but the spec checks tab recovery, not the sidebar list), so it is not the worker-discovery proof — Task 5b is. Run it to confirm the off-thread change doesn't regress recovery:
```bash
npm run test:e2e -- specs/opencode-restart-recovery.spec.ts
```
Expected: PASS. (Do **not** cite `fresh-agent.spec.ts` — it only toggles client harness state and checks pane-picker visibility; it does not exercise `listSessionsDirect`.)

> Behavior-change to watch: before this change, `listSessionsDirect` threw against the fixture (no `part` table) and contributed nothing; now (Task 1 robustness) it returns the fixture's root session (unmarked), deduped by `makeSessionKey(provider, sessionId)`. If the recovery spec's assertions shift because the root session now also arrives via the direct path, reconcile them; do not weaken the spec.
> If the e2e harness is unavailable in this environment, record that and ensure CI runs it; do not silently skip.

- [ ] **Step 5: Commit any incidental fixes, then update kata**

If Step 4 surfaced fixes, commit them. Then mark kata `wab5` in-progress/closed with a pointer to the branch/PR (kata is local-first, not a code change):
```bash
kata comment wab5 -m "Implemented off-thread listing worker on branch perf/opencode-marker-cache (plan: docs/superpowers/plans/2026-06-04-opencode-listing-offthread-worker.md). Validated dev(tsx)/prod(dist)/test(vitest) runtimes."
```

---

## Self-Review

**1. Spec coverage**
- "Run the query off the event loop" → Tasks 2–4 (worker entry, runner, provider wiring); Task 5 proves non-blocking.
- "Preserve `isSubagent`/`isNonInteractive` from the marker, titles, ordering, archived/child filtering, missing_db/sqlite_unavailable/empty_db logging" → Task 1 (query correctness), Task 4 (mapping + pre-checks preserved), existing sqlite/mock tests retained.
- "Don't block the loop on a large/cold scan" → Task 5 non-blocking test.
- "No build-step change / works in dev, prod, test" → validated constraints §1–7; Task 6 builds dist and runs the compiled worker.
- "Failure contract: `[]` for absent/empty, **throw** on worker/read failure" → Task 4 throw-on-failure + empty-db tests.
- "Throw actually preserves the sidebar on BOTH incremental and full-scan refresh, with no error re-leak/spam" → **Task 4b** indexer fix + full-scan preservation regression test (cross-checked against `refreshDirectProvider` + `performRefresh` global prune).
- "Malformed worker message rejects (not resolve-undefined)" → Task 3 `isOkMessage`/`isErrMessage` + malformed-message `it.each`.
- "Worker auto-run is import-safe under Vitest's thread pool" → Task 2 sentinel guard (`OPENCODE_LISTING_WORKER_KIND`) + the import-safety test; runner injects the sentinel (Task 3).
- "Query degrades to unmarked (no throw) on a schema without `part`/`message`" → Task 1 missing-tables test.
- "The real worker runs through the PRODUCTION discovery path (provider default runner → indexer → project state that feeds `/api/sessions`)" → **Task 5b** (asserts a DB session, marker→isSubagent, surfaces after a refresh using the real worker).
- "e2e coverage (AGENTS.md)" → worker discovery is proven by Task 5b + Task 5 (server-side, real worker). Task 6 Step 4b runs the browser recovery spec as a regression guard for the UI recovery flow (it does not itself assert the worker output). Marker detection is covered by Task 1 + Task 5 against the real schema (the browser fixture lacks `part`/`message`).

**2. Placeholder scan** — No TBD/TODO/"add error handling"; every code step is complete and runnable. The prod-path check is written to `/tmp/oc-prod-check.mjs` and reused by Step 3 and Step 3b (no `<same script…>` placeholder). `node:sqlite` is imported **lazily** in the query module (required for `vi.mock` compatibility — see the Lazy import note).

**3. Type consistency** — `OpencodeSessionRow`, `OpencodeListingResult`, `OpencodeListingQueryInput`, `OpencodeListingQueryRunner`, `WorkerSpawnOptions`, `WorkerListingInput`, message shape `{ ok, rows, schemaMissingParentId } | { ok, error }` are used identically across Tasks 1–5. `runOpencodeListingQuery(dbPath, markerPattern): Promise<OpencodeListingResult>` (async, lazy `node:sqlite`) is awaited everywhere it is called (query test, worker, in-process runner, integration baseline). The runner's injectable `spawn(url, { workerData, execArgv })` signature is identical in the unit test fake and `defaultSpawn`. The provider's `queryRunner` is typed `OpencodeListingQueryRunner` and returns `OpencodeListingResult`, mapped to `CodingCliSession[]`.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-04-opencode-listing-offthread-worker.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.

**2. Inline Execution** — execute tasks in this session with checkpoints.
