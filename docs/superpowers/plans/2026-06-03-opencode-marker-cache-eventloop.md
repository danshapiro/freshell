# OpenCode Listing DB-Change Gate — Stop Blocking the Event Loop Implementation Plan

> **⚠️ STATUS: SUPERSEDED — do not execute as-is.** Live measurement (2026-06-04) showed OpenCode is typically **active** (its `-wal` mtime advances every refresh while the db file is static), so this DB-change gate would re-run the scan every time and save nothing in the condition that actually occurs. The gate only helps fully-idle OpenCode. The converged fix is to run the synchronous query **off the event-loop thread** (kata **wab5**, now P0); a cheap complementary mitigation is to **throttle** OpenCode listing frequency. This document is retained as the record of how three review/measurement passes ruled out the per-session-cache and gate approaches. See kata `xe4t`/`wab5` for the current direction.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Freshell's OpenCode session listing from running a ~180 ms synchronous, event-loop-blocking SQLite content scan on every indexer refresh (~every 5 s) when OpenCode's database has not actually changed — which is the common case that makes all terminals/panes stutter under multi-agent load.

**Architecture:** Leave the existing, correct `listSessionsDirect()` query **completely unchanged**. Add a cheap change-gate in front of it: before opening/querying the database, `stat()` `opencode.db` and `opencode.db-wal`; if their `(size, mtimeMs)` signature is identical to the last successful run, return the cached `CodingCliSession[]` and skip the query entirely. Any write to the SQLite database (WAL append or checkpoint) changes that signature, so a changed DB always re-runs the full, correct query. This removes the redundant scans without altering which sessions are classified `isSubagent`/`isNonInteractive`.

**Tech Stack:** TypeScript (NodeNext/ESM), Node `fs/promises` `stat`, Node built-in `node:sqlite` `DatabaseSync`, Vitest. Server file: `server/coding-cli/providers/opencode.ts`.

---

## Plain-English Problem

`OpencodeProvider.listSessionsDirect()` computes `hasThreeViewsMarker` per session via two correlated `EXISTS` subqueries doing a leading-wildcard `LIKE` over `part.data`/`message.data`. Measured on the live server: **~180 ms, ~432 MB scanned** warm-cache, **synchronous** (`DatabaseSync.all()`), so it blocks the event loop. The indexer calls `listSessionsDirect()` on **every** refresh (~5 s floor under churn), and refreshes are triggered by activity in **any** provider (Claude/Codex too), so the OpenCode scan runs every ~5 s even when OpenCode itself is idle — freezing every terminal ~12×/min. Tracked as kata issue **xe4t** (P0).

## Why a change-gate, not a per-session marker cache (review history)

This plan originally proposed replacing the query with a per-session marker cache keyed by a cheap "change token." Two review passes killed that approach because **no cheap, sound per-session change token exists** for this schema:

- **`session.time_updated` is unsound** (load-bearing, falsified): 173/343 live root sessions have `part.time_created > session.time_updated`; it does not track content.
- **A row-`COUNT` token is unsound** (fresheyes, falsified): count-neutral churn (delete one row + insert a marker row before the next refresh) leaves the count unchanged, so a newly-marked session would be missed.
- **`MAX(id)` is sound but not cheap**: OpenCode `id`s are monotonic ULIDs (verified: ids order with `rowid`), so `MAX(id)` strictly increases on every insert — but `part` has no covering index on `id`, so `SELECT session_id, MAX(id) FROM part GROUP BY session_id` measures **~90 ms** (reads rows). `MAX(rowid)` is cheap (covering, ~20 ms) but `rowid` is **reused** after deleting the max row, reintroducing the count-neutral hole.

So any cheap per-session token is unsound, and the sound one is nearly as expensive as the original scan. The correct move is therefore **not** to make the scan incremental, but to **avoid running it when nothing changed**. The existing query stays byte-for-byte the same (so no marker is ever missed), and a file-stat gate skips it when `opencode.db`/`-wal` are unchanged.

**Why file-stat and not `PRAGMA data_version`:** `data_version` is **connection-local** (verified: two fresh read-only connections each report their own baseline, not comparable), and the provider opens a fresh connection per call. A persistent connection + `data_version` is the stricter alternative but adds handle-lifecycle complexity (stale handle if the DB file is replaced/deleted). `stat()` of the two files is cross-connection-safe, robust to file replacement, and is the same signal kata **wab5** proposed.

## File Structure

- Modify: `server/coding-cli/providers/opencode.ts`
  - Add private cache fields: the last `(size, mtimeMs)` signature of `[db, wal]` and the last returned `CodingCliSession[]`.
  - Add a public instrumentation counter `listQueryCount` (number of times the heavy listing query actually ran).
  - Add a private `readDbSignature()` that `stat`s `getWatchedDatabasePaths()` and returns a comparable string (missing file ⇒ a sentinel).
  - At the top of `listSessionsDirect()`, compute the signature; if it equals the cached one and a cached result exists, return the cached result. Otherwise run the existing query unchanged, then store `{ signature, result }`.
- Test:
  - `test/unit/server/coding-cli/opencode-provider.sqlite.test.ts` (real `node:sqlite`): add the perf-contract Red driver (unchanged DB ⇒ query runs once) and a correctness guard (DB changes ⇒ re-query reflects it). Keep the existing marker-detection test green.
  - `test/unit/server/coding-cli/opencode-provider.test.ts` (mock): only a check that existing behavior is preserved — **no mock changes are required** because no new SQL is introduced.

## Scope Check

This plan covers one change: gating `OpencodeProvider.listSessionsDirect()` on a DB-change signal. It does **not** modify the listing/marker SQL, the indexer cadence, the watchers, or the WebSocket/terminal path, and it does **not** move the query off the event loop (still tracked under kata **wab5** as the residual: when OpenCode *is* actively writing, the gate re-runs the 180 ms query per change; running it in a worker removes even that). Session classification is preserved exactly.

> **TDD note:** the gate is observable only via "did the heavy query run again?" — so the genuine Red→Green driver is the `listQueryCount` perf-contract test (Task 1), which fails today because the field doesn't exist and the query runs on every call. The classification-correctness behavior is already covered by the existing marker test and is re-asserted by the change guard (Task 3).

---

## Task 1: Perf-contract test — unchanged DB does not re-run the query (Red driver)

**Files:**
- Test: `test/unit/server/coding-cli/opencode-provider.sqlite.test.ts`

- [ ] **Step 1: Add the test** (inside the existing `describe('OpencodeProvider SQLite marker detection', ...)`; helpers `createOpencodeSchema`, `insertSession`, `insertMessage` already exist):

```ts
  it('does not re-run the listing query when the database is unchanged', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      createOpencodeSchema(db)
      db.prepare(`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES (?, ?, ?, ?, ?)
      `).run('project-1', '/repo/root', 900, 4000, '[]')
      insertSession(db, 'session-a', 'Session A', 2000)
      insertMessage(db, 'message-a', 'session-a', JSON.stringify({ role: 'user', text: 'hello a' }))
    } finally {
      db.close()
    }

    const provider = new OpencodeProvider(tempDir)

    const first = await provider.listSessionsDirect()
    expect(provider.listQueryCount).toBe(1)
    expect(first).toHaveLength(1)

    const second = await provider.listSessionsDirect()
    expect(provider.listQueryCount).toBe(1) // unchanged DB -> served from cache, no new query
    expect(second).toEqual(first)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:vitest -- test/unit/server/coding-cli/opencode-provider.sqlite.test.ts -t "does not re-run the listing query"`
Expected: FAIL — `provider.listQueryCount` is `undefined` today (`undefined` !== `1`), and the query runs on every call. This is the true Red.

---

## Task 2: Implement the DB-change gate (Green)

**Files:**
- Modify: `server/coding-cli/providers/opencode.ts`

- [ ] **Step 1: Add cache fields and the instrumentation counter**

In `class OpencodeProvider`, next to `private sessionSchemaCache?: OpencodeSessionSchema`, add:

```ts
  /** Last `(size:mtimeMs)` signature of [opencode.db, opencode.db-wal] for which
   *  `lastDirectSessions` is valid. `undefined` until the first successful run. */
  private lastDbSignature?: string
  /** Cached result of the most recent successful `listSessionsDirect()` run. */
  private lastDirectSessions?: CodingCliSession[]

  /** Test/perf instrumentation: number of times the heavy listing query actually ran. */
  listQueryCount = 0
```

- [ ] **Step 2: Add the signature reader**

Add this private method (place it directly above `listSessionsDirect()`). It stats both watched files; a missing file contributes a sentinel so its later appearance/disappearance is detected:

```ts
  /**
   * Cheap change-signal for the OpenCode database: the size + mtime of the db
   * file and its -wal sidecar. Any committed write (WAL append) or checkpoint
   * changes one of these, so an unchanged signature means the DB content the
   * listing query would read is unchanged.
   */
  private async readDbSignature(): Promise<string> {
    const parts = await Promise.all(
      this.getWatchedDatabasePaths().map(async (p) => {
        try {
          const st = await fsp.stat(p)
          return `${st.size}:${st.mtimeMs}`
        } catch {
          return 'absent'
        }
      }),
    )
    return parts.join('|')
  }
```

- [ ] **Step 3: Gate the query at the top of `listSessionsDirect()`**

In `listSessionsDirect()`, after the existing `await fsp.access(dbPath)` existence check and before opening the database (`db = new sqlite.DatabaseSync(...)`), add the gate. Insert immediately after the `sqlite = await import('node:sqlite')` block (so we only serve the cache when sqlite is available and the db exists):

```ts
    const signature = await this.readDbSignature()
    if (this.lastDirectSessions && this.lastDbSignature === signature) {
      return this.lastDirectSessions
    }
```

- [ ] **Step 4: Count the query run and populate the cache**

In `listSessionsDirect()`, at the start of the `phase = 'query'` section (immediately before `const rows = db.prepare(`), add:

```ts
      this.listQueryCount += 1
```

Then change the success `return sessions` (end of the `try`) to cache first:

```ts
      this.lastDbSignature = signature
      this.lastDirectSessions = sessions
      return sessions
```

(Leave the `catch` returning `[]` and the `finally { db?.close() }` unchanged. On failure we do not update the cache, so the next call retries.)

- [ ] **Step 5: Run the Task 1 test to verify it passes**

Run: `npm run test:vitest -- test/unit/server/coding-cli/opencode-provider.sqlite.test.ts -t "does not re-run the listing query"`
Expected: PASS.

- [ ] **Step 6: Run the whole real-sqlite file to verify classification is preserved**

Run: `npm run test:vitest -- test/unit/server/coding-cli/opencode-provider.sqlite.test.ts`
Expected: PASS (the existing `marks 3-views OpenCode sessions...` test still passes — first call runs the unchanged query and classifies all three sessions correctly).

---

## Task 3: Correctness guard — a changed DB re-runs the query and reflects the change

**Files:**
- Test: `test/unit/server/coding-cli/opencode-provider.sqlite.test.ts`

This guard proves the gate never serves stale data after a real change (including a newly-marked session). It would fail against a gate that cached too aggressively.

- [ ] **Step 1: Add the test**

```ts
  it('re-runs the query and reflects changes after the database is modified', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    let db = new DatabaseSync(dbPath)
    try {
      createOpencodeSchema(db)
      db.prepare(`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES (?, ?, ?, ?, ?)
      `).run('project-1', '/repo/root', 900, 4000, '[]')
      insertSession(db, 'session-normal', 'Normal session', 2000)
      insertMessage(db, 'message-normal', 'session-normal', JSON.stringify({ role: 'user', text: 'ordinary prompt' }))
    } finally {
      db.close()
    }

    const provider = new OpencodeProvider(tempDir)

    const first = await provider.listSessionsDirect()
    expect(first).toHaveLength(1)
    expect(first[0]?.isSubagent).toBeUndefined()
    expect(provider.listQueryCount).toBe(1)

    // Modify the DB: add a brand-new 3-views session (this grows both files, so the
    // stat signature changes and the gate must re-run the query).
    db = new DatabaseSync(dbPath)
    try {
      insertSession(db, 'session-marker', '3-views session', 2500)
      insertMessage(
        db,
        'message-marker',
        'session-marker',
        JSON.stringify({ role: 'user', text: `attached\n${threeViewsMarker}` }),
      )
    } finally {
      db.close()
    }

    const second = await provider.listSessionsDirect()
    expect(provider.listQueryCount).toBe(2) // signature changed -> query re-ran
    expect(second).toHaveLength(2)
    const marked = second.find((s) => s.sessionId === 'session-marker')
    expect(marked?.isSubagent).toBe(true)
    expect(marked?.isNonInteractive).toBe(true)
  })
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npm run test:vitest -- test/unit/server/coding-cli/opencode-provider.sqlite.test.ts -t "re-runs the query and reflects changes"`
Expected: PASS.

---

## Task 4: Typecheck, related suite, commit

- [ ] **Step 1: Typecheck**

Run: `npm run build:server`
Expected: Compiles with no errors.

- [ ] **Step 2: Run the related coding-cli unit tests (all must pass, including the mock-based file which is unchanged)**

Run: `npm run test:vitest -- test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/opencode-provider.sqlite.test.ts test/unit/server/coding-cli/session-indexer-provider-refresh.test.ts`
Expected: PASS. Note `opencode-provider.test.ts` uses `FakeDatabaseSync` and writes a real `opencode.db` placeholder file (`fs.writeFile(dbPath, 'fake sqlite file')`); each test builds a fresh `OpencodeProvider`, so the gate's cache starts empty and the first (only) call runs the query as before. No mock changes are needed because no new SQL is introduced.

- [ ] **Step 3: Commit**

```bash
git add server/coding-cli/providers/opencode.ts \
        test/unit/server/coding-cli/opencode-provider.sqlite.test.ts
git commit -m "perf(opencode): gate listSessionsDirect on a DB-change signal to stop per-refresh 432MB scan

listSessionsDirect ran a ~180ms synchronous LIKE-scan of ~432MB of part/message
content on every indexer refresh (~every 5s), blocking the event loop even when
OpenCode was idle (refreshes are triggered by any provider's activity). Gate the
query on the (size,mtime) signature of opencode.db + -wal: when unchanged, return
the cached session list and skip the query. The listing/marker SQL is unchanged,
so classification is identical; only redundant scans are removed.

Refs kata xe4t."
```

---

## Manual verification (optional, on the live machine — read-only, no restart)

```bash
DB=~/.local/share/opencode/opencode.db
# The gate's signal: any OpenCode write advances the -wal (or db) size/mtime.
stat -c '%n size=%s mtime=%Y' "$DB" "$DB-wal"
```

No server restart is implied; deploying to the self-hosted server requires explicit user approval per repo rules.

## Load-bearing assumption ledger (outcome)

| Assumption | Verdict | Evidence |
|---|---|---|
| `OpencodeProvider` is a singleton; instance cache fields persist across refreshes | **verified** | `export const opencodeProvider = new OpencodeProvider()` (opencode.ts:412); held by the indexer (index.ts:197); `refreshDirectProvider` calls the same reference (session-indexer.ts:919) |
| The indexer re-queries OpenCode every refresh even when OpenCode is idle (so gating helps) | **verified** | `refreshDirectProvider` runs on full scans and whenever OpenCode is dirty; full scans are triggered by any provider's activity (session-indexer.ts:1274–1279, 1332–1344) |
| Any OpenCode DB write changes the `(size, mtimeMs)` of `opencode.db` or `-wal` | **verified (WAL semantics)** | WAL mode appends committed frames to `-wal` (size/mtime change); checkpoints rewrite `opencode.db` (size/mtime change). Live files: `opencode.db-wal` is 6.27 MB and updates on writes |
| `PRAGMA data_version` is unusable across fresh connections (so file-stat is chosen) | **verified** | Two fresh read-only connections each return their own baseline; SQLite documents `data_version` as connection-local |
| Per-session `time_updated` token | **falsified** (load-bearing) | 173/343 root sessions have `part.time_created > time_updated`; zero triggers |
| Per-session row-`COUNT` token | **falsified** (fresheyes) | Count-neutral churn (delete + insert) leaves the token unchanged → missed marker. Avoided: query is unchanged, no token used |
| The listing/marker SQL is unchanged, so classification is byte-for-byte identical when the query runs | **verified by construction** | Task 2 adds only a pre-query gate and post-query cache assignment; the `db.prepare(...).all(...)` block and the map loop are untouched |
| `isSubagent`/`isNonInteractive` derive solely from the marker; no other consumer affected | **verified** | Set only at opencode.ts:206/215–216 |

### Accepted residual risks

1. **mtime granularity.** If a write left both files' `(size, mtimeMs)` identical to the previous run (e.g. an in-place WAL-frame rewrite within the same `mtimeMs` tick and identical size), the gate would skip a re-query and serve a slightly stale list until the next detected change. This is near-impossible for an append (size changes) and self-heals on the next write; the consequence is a brief stale sidebar entry, not data loss. The stricter alternative (persistent connection + `PRAGMA data_version`) is deferred to wab5.
2. **`projectPath` staleness from cached results.** When `row.projectPath` is null the listing resolves it via `resolveGitRepoRoot(cwd)` (filesystem). A cached result will not re-resolve until the DB changes. Matches the current best-effort behavior; git checkout roots rarely move.
3. **Residual cost while OpenCode is actively writing.** When the DB changes every refresh, the gate re-runs the full ~180 ms query each time. Eliminated by moving the query off the event loop (kata **wab5**); out of scope here. The primary symptom — idle-OpenCode scans blocking other agents' terminals — is fully addressed.

## Self-Review

- **Spec coverage:** (1) stop the redundant per-refresh scan → Task 2 gate. (2) Red-first proof → Task 1 `listQueryCount`. (3) never serve stale data after a change → Task 3. (4) classification unchanged → existing marker test (Task 2 Step 6) + Task 3 marked-session assertion. (5) mock suite stays green with no changes → Task 4 Step 2 (no new SQL). (6) typecheck/full related suite → Task 4.
- **TDD validity:** Task 1 is genuinely Red today (`listQueryCount` undefined; query runs every call). Task 3 asserts re-query on change (`listQueryCount` 1→2) and the new marked session is detected.
- **Soundness:** the listing/marker query is unchanged, so no marker is ever misclassified when the query runs; the only new failure mode is the bounded mtime-granularity staleness in Accepted Residual Risks #1.
- **Placeholder scan:** none — every step has full code and exact commands.
- **Type consistency:** `lastDbSignature?: string`, `lastDirectSessions?: CodingCliSession[]`, `listQueryCount: number` are used consistently; `readDbSignature(): Promise<string>` returns the value compared against `lastDbSignature`; `getWatchedDatabasePaths()` is an existing method (opencode.ts) returning `[db, wal]`.
