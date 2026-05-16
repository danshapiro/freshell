# Plan: Fix OpenCode Ambiguous Session Ownership Warnings

## 1. Problem Statement

### Symptoms

Freshell v0.7.0 (production) emits repeated WARN-level logs from `opencode-activity-tracker`:

```
OpenCode endpoint reported ambiguous session ownership; suppressing durable adoption.
```

Each warning includes `terminalId` and 2–5 `sessionIds` per occurrence. 21+ terminals affected, 500+ warnings in ~2 days. Zero terminals recovered from `ambiguous`. Warnings are not cosmetic — they suppress `turnComplete` events and `requestAssociation`, breaking session completion tracking and durable session binding.

### Timeline

| Date | Event | Source |
|---|---|---|
| May 6, 21:33 PT | `29dc693c` — ownership reducer introduced (19 files, +1278/-129) | `git show 29dc693c --stat` |
| May 7, 00:35 PT | `c1f76b1f` — edge case fixes; ambiguous paths unchanged | `git show c1f76b1f --stat` |
| May 9, 11:15 PT | `dist/server/coding-cli/opencode-ownership-reducer.js` compiled | `stat` on dist file |
| May 9, 11:16 PT | Server restart (PID 2383202) | `ps -p 2383202 -o lstart` |
| May 9, 11:34 PT | First warning (~18 min after restart) | Log: 18:34:47 UTC |
| May 9, 11:34–11:38 PT | 6 warnings across 4 terminals. Terminal `1cj9RGOF70F1OYf-NW4XI` grows 2→3→4 sessionIds in 29s. | Log entries |

### Regression Explanation

- **May 6–9, 11:15 PT**: Code was on `dev` but the running server was from the previous build — `extractBusySessionId` handled multi-busy silently.
- **May 9, 11:16 PT**: Server restart picked up the build containing the ownership reducer.
- **May 9, 11:34 PT**: After ~18 minutes of user/agent activity, OpenCode terminals spawned sub-agents. The reducer saw 2+ concurrent busy sessions and entered `ambiguous`.

---

## 2. Root Cause

### 2.1 OpenCode's Session Model is Parent-Child

OpenCode sessions are stored in SQLite (`~/.local/share/opencode/opencode.db`). The `session` table has a `parent_id` column (nullable FK to `session.id`). **Root sessions have `parent_id = NULL`; child (sub-agent) sessions have a non-null `parent_id`.**

```sql
-- Source: opencode.db (confirmed via sqlite3 queries)
CREATE TABLE session (
  id text PRIMARY KEY,
  parent_id text,     -- NULL = root; non-NULL = child sub-agent
  -- ...
);
```

The OpenCode SDK's `Session` type confirms:
```typescript
// Source: @opencode-ai/sdk/dist/v2/gen/types.gen.d.ts L785-791
export type Session = { id: string; parentID?: string; ... }
```

Sub-agent spawning is routine, not exceptional. Querying the production DB:
```
$ sqlite3 opencode.db "SELECT COUNT(*) FROM session WHERE parent_id IS NOT NULL AND time_updated > unixepoch('now','-1 day')"
→ dozens of child sessions in the last 24 hours
```

Every parent session spawns 2-4 children. Example from the currently-running OpenCode process that triggered these warnings:
```
ses_1f13ee760 → NULL                                       (root — "Scanning for secrets")
ses_1f13ec6a6 → ses_1f13ee760  "Read all repo files (@explore subagent)"
ses_1f13eb2bd → ses_1f13ee760  "Search git history (@explore subagent)"
ses_1f13ea1a9 → ses_1f13ee760  "Search for hidden secrets (@explore subagent)"
```

### 2.2 `/session/status` Returns All Non-Idle Sessions Without Parent Metadata

The HTTP endpoint returns a flat map with only a `type` field:

```json
// Source: confirmed via curl against ports 43135, 41119, 34343
{ "ses_root": {"type": "busy"}, "ses_child": {"type": "busy"} }
```

The tracker's Zod schema confirms this — `{ type: "idle"|"busy"|"retry" }` only:
```typescript
// Source: server/coding-cli/opencode-activity-tracker.ts L58-64
const SessionStatusSchema = z.discriminatedUnion('type', [
  SessionIdleStatusSchema,   // { type: "idle" }
  SessionBusyStatusSchema,   // { type: "busy" }
  SessionRetryStatusSchema,  // { type: "retry", attempt, message, next, action? }
])
```

**No `parentID`, `pid`, or `cwd` in the response.** The tracker cannot distinguish root from child using the HTTP API alone. When a root and its children are all concurrently busy, the status map contains 2+ entries — the reducer interprets this as competing ownership.

### 2.3 The Tracker Drops `session.created` Events

Only three event types are accepted:
```typescript
// Source: server/coding-cli/opencode-activity-tracker.ts L95-99
const KNOWN_OPENCODE_EVENT_TYPES = new Set([
  'server.connected',
  'session.status',
  'session.idle',
])
```

All other events (line 160) are dropped. The `session.created` event, which **includes `parentID` in `info`**, never reaches the reducer:
```typescript
// Source: @opencode-ai/sdk/dist/v2/gen/types.gen.d.ts L818-826
export type EventSessionCreated = {
    type: "session.created";
    properties: { sessionID: string; info: Session };  // Session has parentID
};
```

### 2.4 The Sidebar Knows to Filter Children — The Tracker Doesn't

Freshell's sidebar lister already excludes child sessions from the session list:
```typescript
// Source: server/coding-cli/providers/opencode.ts L62-76
WHERE s.parent_id IS NULL           // ← filters to root sessions only
  AND s.time_archived IS NULL
```

The tracker is the one subsystem that doesn't apply this filter. It's not a design choice — the tracker has no mechanism to distinguish root from child.

### 2.5 The Reducer's Multi-Busy → Ambiguous Paths

Four code paths trigger `enterAmbiguous` when the reducer sees 2+ busy sessions:

| Path | Lines | State Before | Trigger | When |
|---|---|---|---|---|
| **P1** | `344-361` (reduceSnapshot) | `quiet` with `knownSessionId` | Known session busy + children also busy in snapshot | Resumed terminal, sub-agents active |
| **P2** | `378-379` (reduceSnapshot) | `quiet`, no known session | 2+ busy in snapshot, no known session to prefer | Fresh terminal with sub-agents |
| **P3** | `174-186` (reduceBusy) | `knownBusy` | Different session reports `busy` via SSE | Child sub-agent starts while parent is `knownBusy` |
| **P4** | `293-311` (reduceSnapshot) | `knownBusy` | Known session missing from busy set, or 2+ busy in snapshot | Reconnection while children active |

**P3 is the most frequent trigger:**
```typescript
// Source: server/coding-cli/opencode-ownership-reducer.ts L174-186
if (state.kind === 'knownBusy') {
  if (state.sessionId === observation.sessionId) {
    return { ... /* stay knownBusy */ }
  }
  // Different session = enter ambiguous
  return enterAmbiguous({
    knownSessionId: state.sessionId,
    blockedSessionIds: [state.sessionId, observation.sessionId],
    at: observation.at,
  })
}
```

A child sub-agent's `session.status { type: "busy" }` SSE event causes `knownBusy → ambiguous`. **The child is not competing for the terminal — it is work delegated by the parent.**

### 2.6 The UNION Accumulation Bug Prevents Recovery

Even with correct child filtering, a defective UNION at line 281 traps stale sessions:
```typescript
// Source: server/coding-cli/opencode-ownership-reducer.ts L281
const blockedSessionIds = uniqueSorted([...state.blockedSessionIds, ...busySessionIds])
```

This is a pure UNION — sessions never pruned. If SSE disconnects before idle events arrive for completed children, and a reconnection snapshot shows only the parent as busy, the UNION re-adds completed children from `state.blockedSessionIds`.

**Confirmed via reproducer test (`/tmp/rca-reproduce.ts`):**
- Initial: `blocked = [A, B, C]`
- Disconnect (child B and C complete — idle events lost)
- Reconnect snapshot: `busy = [A, D]`
- Result: `blocked = [A, B, C, D]` — B and C permanently trapped

### 2.7 Why Pre-0.7.0 Had No Warnings

The old `extractBusySessionId` had no state machine and no ambiguity detection:
```typescript
// Source: git show 23f5ca38^:server/coding-cli/opencode-activity-tracker.ts
function extractBusySessionId(snapshot, currentSessionId?) {
  const busySessionIds = Object.entries(snapshot)
    .filter(([, status]) => status.type !== 'idle')
    .map(([id]) => id).sort()
  if (currentSessionId && busySessionIds.includes(currentSessionId)) return currentSessionId
  return busySessionIds[0]  // deterministic pick, no warning
}
```

### 2.8 `--session` Flag Cannot Prevent Multi-Busy

The `--session` flag requires an EXISTING session ID and selects which session the TUI connects to. It does not prevent the server from having other active sessions (children). And it cannot be used for fresh terminals — arbitrary IDs are rejected with "Session not found."

---

## 3. Solution

### Design Principle

**Child sessions are not competing owners. Only root sessions can own a terminal.** The tracker should use OpenCode's actual data model to identify children and filter them out before they reach the ownership reducer. The reducer never sees child sessions — it only sees root sessions.

### 3.1 Track Child Sessions With a Per-Monitor Set

Add `session.created` to `KNOWN_OPENCODE_EVENT_TYPES` and add its Zod schema:

```typescript
// server/coding-cli/opencode-activity-tracker.ts
const SessionCreatedEventSchema = z.object({
  type: z.literal('session.created'),
  properties: z.object({
    sessionID: z.string().min(1),
    info: z.object({
      parentID: z.string().nullable().optional(),  // nullable — SQL NULL serializes to null
    }).passthrough().optional(),  // info may be missing entirely
  }).passthrough(),
}).passthrough()
```

Add to `KNOWN_OPENCODE_EVENT_TYPES`, add to `OpencodeEventSchema` union, and add a handler in `handleOpencodeEvent`. **The existing handler is NOT an if/else chain** — it has one `session.idle` branch and a fall-through that assumes `session.status` (tracker L411–437). The handler must be restructured into explicit branches:

```typescript
// OpencodeEventSchema union — add SessionCreatedEventSchema:
const OpencodeEventSchema = z.discriminatedUnion('type', [
  ServerConnectedEventSchema,
  SessionStatusEventSchema,
  SessionIdleEventSchema,
  SessionCreatedEventSchema,  // NEW
])

// handleOpencodeEvent — restructured with explicit branches:
private handleOpencodeEvent(
  monitor: MonitorState,
  cycleId: number,
  streamId: number,
  event: Exclude<z.infer<typeof OpencodeEventSchema>, { type: 'server.connected' }>,
): void {
  // NEW: register child sessions from session.created events
  if (event.type === 'session.created') {
    if (event.properties.info?.parentID != null) {
      this.registerChildSession(monitor.terminalId, event.properties.sessionID)
    }
    return
  }

  if (event.type === 'session.idle') {
    const children = this.childSessionIds.get(monitor.terminalId)
    if (children?.has(event.properties.sessionID)) {
      children.delete(event.properties.sessionID)
      return
    }
    this.observe(monitor, {
      kind: 'sse', cycleId, streamId,
      sessionId: event.properties.sessionID,
      status: 'idle',
      at: this.now(),
    })
    return
  }

  // session.status — filter children, then observe
  const children = this.childSessionIds.get(monitor.terminalId)
  if (children?.has(event.properties.sessionID)) {
    return  // child session — do not observe (cleanup happens on session.idle)
  }
  this.observe(monitor, {
    kind: 'sse', cycleId, streamId,
    sessionId: event.properties.sessionID,
    status: event.properties.status.type,
    at: this.now(),
  })
}
```

The `session.idle` branch filters children and cleans up the tracking set. The `session.status` branch filters children but does NOT clean up — cleanup happens only via `session.idle` to avoid double-delivery issues if OpenCode emits both event types for the same session. The `session.created` branch only registers children — it does NOT trigger a re-evaluation or snapshot refresh.

```typescript
// server/coding-cli/opencode-activity-tracker.ts (new method)
private childSessionIds = new Map<string, Set<string>>()

private registerChildSession(terminalId: string, sessionID: string): void {
  let children = this.childSessionIds.get(terminalId)
  if (!children) {
    children = new Set()
    this.childSessionIds.set(terminalId, children)
  }
  children.add(sessionID)
}
```

**Ordering race (P3):** If `session.status { busy }` arrives before `session.created` for the same child, the reducer enters `ambiguous`. When `session.created` arrives, the child is registered — but the state stays `ambiguous` until the next snapshot. Recovery happens on reconnection (when `resyncFromDb` runs inside `refreshSnapshot`). If `session.created` is never emitted by OpenCode, this SSE path is dead code — the DB path handles everything.

### 3.2 Identify Children From DB Inside `refreshSnapshot`

The entire complexity of `seedChildSessions`, `resyncChildSessions`, and `extractKnownSessionIds` is eliminated. Instead, `refreshSnapshot` (which is already `async`) queries the DB directly after fetching the HTTP status map. This is the **primary child detection mechanism** — SSE `session.created` events are a best-effort optimization.

```typescript
// server/coding-cli/opencode-activity-tracker.ts — refreshSnapshot (modified)
private async refreshSnapshot(
  monitor: MonitorState,
  cycleId: number,
  streamId: number,
  signal: AbortSignal,
): Promise<void> {
  const response = await this.fetchImpl(this.buildUrl(monitor.endpoint, '/session/status'), {
    signal,
  })
  if (!response.ok) {
    throw new Error(`OpenCode session status request failed with ${response.status}.`)
  }

  const parsed = SessionStatusMapSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error('OpenCode session status response did not match the expected schema.')
  }

  // NEW: identify children from the DB using the active session IDs
  await this.resyncFromDb(monitor, Object.keys(parsed.data))

  // Filter children from the status map
  const children = this.childSessionIds.get(monitor.terminalId)
  const filteredStatuses: Record<string, z.infer<typeof SessionStatusSchema>> = {}
  for (const [sessionId, status] of Object.entries(parsed.data)) {
    if (!children?.has(sessionId)) {
      filteredStatuses[sessionId] = status
    }
  }

  this.observe(monitor, {
    kind: 'snapshot', cycleId, streamId,
    statuses: filteredStatuses,  // children excluded
    at: this.now(),
  })
}
```

```typescript
// NEW: resyncFromDb — query DB for children of active sessions, register them
private async resyncFromDb(monitor: MonitorState, activeSessionIds: string[]): Promise<void> {
  if (!this.dbPath || activeSessionIds.length === 0) return
  let db: InstanceType<typeof import('node:sqlite').DatabaseSync> | undefined
  try {
    const sqlite = await import('node:sqlite')
    db = new sqlite.DatabaseSync(this.dbPath, { readOnly: true })
    const placeholders = activeSessionIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT id, parent_id FROM session WHERE id IN (${placeholders}) AND parent_id IS NOT NULL`
    ).all(...activeSessionIds) as Array<{ id: string; parent_id: string }>
    for (const row of rows) {
      this.registerChildSession(monitor.terminalId, row.id)
    }
  } catch {
    // DB unavailable or node:sqlite not supported — children unfiltered in this snapshot
  } finally {
    db?.close()
  }
}
```

**Why this works for all scenarios:**
- **Fresh terminal (P2):** The first snapshot contains all busy sessions (root + children). `resyncFromDb` queries the DB for all of them, finds which have `parent_id IS NOT NULL`, registers them as children, and filters them from the snapshot. The reducer sees only the root session.
- **Ordering race (P3):** If `session.status { busy }` arrives before `session.created`, the reducer enters `ambiguous`. On the next snapshot (on reconnection), `resyncFromDb` catches the child via DB query and filters it. Recovery happens on reconnection — not mid-stream.
- **Historical sessions:** The query `WHERE id IN (...)` only matches sessions that are currently in the status map, so historical sessions are never returned.

### 3.3 Reconnection Resync

`refreshSnapshot` is called once per stream connection (on `server.connected`). When the stream disconnects and `runMonitor` reconnects, `refreshSnapshot` fires again — automatically re-querying the DB. No separate resync mechanism is needed.

**Important: `refreshSnapshot` is NOT periodic.** It only fires on initial connection and reconnection. Children spawned while the stream is open are detected via `session.created` SSE events (if OpenCode emits them — unverified). If OpenCode does not emit `session.created`, children accumulate undetected until the next reconnection. This is a known limitation — the DB resync catches them eventually.

**Startup seeding from `trackTerminal`:** For resumed terminals with a `sessionId`, kick off an async DB seed so children are known before the first snapshot:

```typescript
// In trackTerminal, after creating the monitor:
if (input.sessionId) {
  void this.seedFromDb(monitor, [input.sessionId])
}

private async seedFromDb(monitor: MonitorState, parentIds: string[]): Promise<void> {
  if (!this.dbPath || parentIds.length === 0) return
  let db: InstanceType<typeof import('node:sqlite').DatabaseSync> | undefined
  try {
    const sqlite = await import('node:sqlite')
    db = new sqlite.DatabaseSync(this.dbPath, { readOnly: true })
    const placeholders = parentIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT id FROM session WHERE parent_id IN (${placeholders}) AND time_archived IS NULL`
    ).all(...parentIds) as Array<{ id: string }>
    for (const row of rows) {
      this.registerChildSession(monitor.terminalId, row.id)
    }
  } catch {
    // DB unavailable — first snapshot will catch via resyncFromDb
  } finally {
    db?.close()
  }
}
```

**`dbPath` derivation:** The tracker derives the DB path internally using the same logic as `OpencodeProvider.getDatabasePath()` — `defaultOpencodeDataHome()` + `'opencode.db'`. Export `defaultOpencodeDataHome` from `providers/opencode.ts` and import it in the tracker:

```typescript
// providers/opencode.ts — export the existing function:
export function defaultOpencodeDataHome(): string { ... }

// opencode-activity-tracker.ts — import and use:
import { defaultOpencodeDataHome } from './providers/opencode.js'

// In constructor:
private readonly dbPath?: string
constructor(input: {
  // ... existing fields
  homeDir?: string  // NEW — defaults to defaultOpencodeDataHome()
} = {}) {
  // ... existing init
  const homeDir = input.homeDir ?? defaultOpencodeDataHome()
  this.dbPath = path.join(homeDir, 'opencode.db')
}
```

`path` and `os` are no longer needed in the tracker — the path logic lives in the provider. The `homeDir` parameter allows tests to inject a custom path; production callers omit it to use the default.

### 3.5 Fix the UNION Accumulation (Defense-in-Depth)

```typescript
// server/coding-cli/opencode-ownership-reducer.ts L281
// OLD:
const blockedSessionIds = uniqueSorted([...state.blockedSessionIds, ...busySessionIds])
// NEW: the snapshot is authoritative for current state.
const blockedSessionIds = uniqueSorted(busySessionIds)
```

The snapshot represents the complete set of busy sessions at time T. If a session is not in the snapshot, it should not be in `blockedSessionIds`. The UNION was an unnecessary persistence mechanism — the snapshot already contains all relevant state.

**Side effect (correct behavior):** Sessions that completed during an SSE disconnect and are no longer in the snapshot are removed from `blockedSessionIds`. Their lost idle events are irrelevant — the snapshot is authoritative for current state. If an SSE `busy` arrives for a genuine new root session between snapshot request and processing, the snapshot will temporarily drop it; the next SSE re-adds it. This may cause a brief flicker (one extra `warnAmbiguous` then recovery) — acceptable because it's self-correcting and rare.

### 3.6 Impact On Each Ambiguous Path

| Path | Before Fix | After Fix |
|---|---|---|
| **P1** (Quiet, knownSessionId, snapshot with root+children) | Enters `ambiguous` | Stays `knownBusy` — children filtered from snapshot via `resyncFromDb` |
| **P2** (Quiet, fresh terminal, snapshot with children) | Enters `ambiguous` | Candidates the single root session — `resyncFromDb` identifies children from DB using the snapshot's active session IDs |
| **P3** (knownBusy + SSE child busy) | Enters `ambiguous` | If `session.created` fires first: child filtered at event boundary, state stays `knownBusy`. If `session.status` fires first: enters `ambiguous`, recovers on next reconnection via `resyncFromDb` |
| **P4** (knownBusy snapshot with children) | Enters `ambiguous` | Stays `knownBusy` — children filtered from snapshot |
| **UNION** (reconnect snapshot) | Stale sessions trapped | Blocked set recomputed from snapshot; stale sessions dropped |

### 3.7 Edge Cases Addressed

**A. Ordering race (P3):** If `session.status { busy }` arrives before `session.created` for the same child, the reducer enters `ambiguous`. The child is registered when `session.created` arrives, but `refreshSnapshot` is NOT periodic — it only fires on connection/reconnection. Recovery happens on the next reconnection, when `resyncFromDb` identifies the child via DB query and filters it from the snapshot. If `session.created` is never emitted, the DB path catches children on every reconnection.

**B. Deep sub-agent nesting (grandchildren):** `resyncFromDb` queries `WHERE id IN (activeSessionIds) AND parent_id IS NOT NULL` — it catches any child that appears in the status map, regardless of nesting depth. Grandchildren are identified as children (they have a non-null `parent_id`). DB seeding from `trackTerminal` uses `WHERE parent_id IN (knownSessionIds)` which catches direct children of the resumed session.

**C. Root idle + children still busy:** If the root goes idle via SSE while children remain busy, `reduceIdle` for `knownBusy` (L230-241) uses `sameSessionStream` gating — it only processes idle for the exact session that went busy. Children's events are filtered at the event boundary before reaching the reducer (Section 3.1). The snapshot path (L293-311) only fires `activityRemove`, not `turnComplete` — `turnComplete` is SSE-only.

**D. Child session tracking memory:** `childSessionIds` map grows with each sub-agent spawn. Cleaned up on SSE idle for children (Section 3.1 handler) and on `untrackTerminal` (add `this.childSessionIds.delete(input.terminalId)` to the existing cleanup in `untrackTerminal` at tracker L234–248). Memory bounded by active children per terminal (~4–8), ~21 terminals = negligible.

**E. DB unavailable (Node < 22.5):** `resyncFromDb` catches errors silently. Children are unfiltered in the snapshot — behavior regresses to current state. SSE `session.created` path (if available) still handles real-time detection.

**F. `ambiguous` with single known session after filtering:** If child filtering reduces the busy set to exactly one session (the `knownSessionId`), the reducer should transition from `ambiguous` → `knownBusy`. Currently the reducer stays `ambiguous` even when the field clears. Add a transition in `reduceSnapshot`'s `ambiguous` branch (reducer L274-290):

```typescript
// In reduceSnapshot, ambiguous branch, after recomputing blockedSessionIds:
if (blockedSessionIds.length === 1 && blockedSessionIds[0] === state.knownSessionId) {
  // Field cleared — single known owner. Resume normal tracking.
  return {
    state: { kind: 'knownBusy', sessionId: state.knownSessionId, ... },
    actions: [{ kind: 'activityUpsert', sessionId: state.knownSessionId, at: observation.at }],
  }
}
```

### 3.8 Files Changed

| File | Changes | Approx Lines |
|---|---|---|
| `server/coding-cli/opencode-activity-tracker.ts` | Add `childSessionIds` map, `registerChildSession`, `seedFromDb`, `resyncFromDb`. Add `session.created` event schema + handler. Restructure `handleOpencodeEvent` into explicit branches. Filter children from `session.status`/`session.idle` paths. Modify `refreshSnapshot` to call `resyncFromDb` and filter children. Add `untrackTerminal` cleanup for `childSessionIds`. Add `homeDir` constructor param + `dbPath` derivation. Import `defaultOpencodeDataHome` from provider. | ~120 |
| `server/coding-cli/providers/opencode.ts` | Export `defaultOpencodeDataHome` function (already exists, just add `export`). | ~1 |
| `server/coding-cli/opencode-ownership-reducer.ts` | Fix UNION at L281: recompute `blockedSessionIds` from `busySessionIds`. Add `ambiguous` → `knownBusy` transition when filtered snapshot shows single known session. | ~15 |
| `test/unit/server/coding-cli/opencode-ownership-reducer.test.ts` | Tests: UNION recomputation drops stale sessions, `ambiguous` → `knownBusy` transition when field clears. | ~40 |
| `test/unit/server/coding-cli/opencode-activity-tracker.test.ts` | Tests: `session.created` child registration, SSE child filtering, snapshot child filtering via `resyncFromDb`, DB seeding success + failure modes, DB-only fallback path, `untrackTerminal` cleanup, `handleOpencodeEvent` restructuring. | ~150 |

---

## 4. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| `session.created` never emitted by OpenCode v1.14.44 | Medium | SSE child tracking path is dead code | **DB resync inside `refreshSnapshot` is the primary mechanism.** Children are identified on every snapshot (connection + reconnection). SSE `session.created` is an unverified optimization for mid-stream detection. |
| `session.created` emitted with different schema than SDK types | Medium | Zod validation fails, logged as warning per event | `parseOpencodeEvent` catches schema mismatches and logs a warning (tracker L398–404). `.passthrough()` tolerates extra fields. `parentID: z.string().nullable().optional()` accepts both `null` and `undefined`. If the `info` key itself is missing, `.optional()` on `info` prevents rejection. |
| DB unavailable (Node < 22.5) | Low | Children unfiltered in snapshot | `resyncFromDb` catches errors silently. Behavior regresses to current state — not worse than today. |
| Deep nesting → grandchildren not caught by DB seed | Low | Grandchild appears as busy in snapshot, briefly seen as root | `resyncFromDb` queries `WHERE id IN (activeSessionIds)` — catches any child in the status map regardless of nesting depth. |
| Two genuine root sessions concurrently busy | Very Low | `enterAmbiguous` fires correctly | This IS legitimate ambiguous detection. The warning should fire. |
| `ambiguous` stuck after child filtering clears the field | Low | Terminal stays `ambiguous` with single known owner | Fixed: added `ambiguous` → `knownBusy` transition when `blockedSessionIds` reduces to `[knownSessionId]`. |
| Children spawned mid-stream with no `session.created` and no reconnection | Medium | Children accumulate undetected until reconnection | Known limitation. `refreshSnapshot` is not periodic. OpenCode streams may stay open for hours. Accept this as a partial fix — the UNION fix and `ambiguous` → `knownBusy` transition mitigate the impact. |

---

## 5. Alternatives Rejected

| Alternative | Why Rejected |
|---|---|
| Tolerate multi-busy in reducer (no child awareness) | Treats symptom. Fresh-terminal case still broken. Couples reducer to a heuristic. |
| `--session` constraint for fresh terminals | `--session` requires EXISTING session. Fresh terminals have none. |
| `GET /session/status?root=true` | Unverified API parameter. If it exists, it replaces child tracking entirely — but must be tested with OpenCode v1.14.44 first. Can be adopted later as simplification. |
| Redesign for multi-owner tracking | Over-engineered. Single-owner model is correct. Bug is root/child distinction, not model error. |

---

## 6. Verification

### 6.1 Test Reproducer

A test script confirmed all four ambiguous-entry paths (P1-P4) and the UNION bug in the current code. After the fix, the same scenarios should produce:

| Scenario | Expected After Fix |
|---|---|
| P1: Resumed terminal, root + 2 children busy in snapshot | Stays `knownBusy` (1 root after filtering) |
| P2: Fresh terminal, root + 3 children busy in snapshot | Enters `candidate` for root (1 root after filtering) |
| P3: `knownBusy` + SSE child busy | Stays `knownBusy` (child filtered at event boundary) |
| P4: `knownBusy` snapshot with 2 children | Stays `knownBusy` (children filtered) |
| UNION: reconnect after disconnect, children completed | Blocked set = current snapshot only; stale children dropped |

### 6.2 Acceptance Criteria

1. All existing ownership reducer tests pass unchanged (no behavior change for single-session scenarios).
2. New tests pass: child filtering via `session.created` SSE, child filtering from snapshot via `resyncFromDb`, UNION recomputation drops stale sessions, `ambiguous` → `knownBusy` transition when field clears.
3. DB resync tests: `resyncFromDb` identifies children from active session IDs, `node:sqlite` unavailable (falls through silently), DB file missing (falls through silently), empty results (no effect), empty active IDs (early return), `db.close()` called even on query failure.
4. DB-only fallback test: with `session.created` SSE events disabled, children are still detected via `resyncFromDb` inside `refreshSnapshot` — no `warnAmbiguous` emitted.
5. `untrackTerminal` test: `childSessionIds` map is cleaned up when terminal is untracked.
6. `warnAmbiguous` is never emitted when the only extra sessions are children with known `parentID`.
7. `warnAmbiguous` IS still emitted when two genuinely independent root sessions are concurrently busy.
8. `handleOpencodeEvent` test: `session.created` events with `parentID` register children; `session.created` events without `parentID` are ignored; `session.status` and `session.idle` events for known children are filtered out; `session.status` and `session.idle` events for non-children pass through to reducer.

### 6.3 Production Validation

1. Deploy to dev build (with user approval for restart).
2. Monitor for `warnAmbiguous` messages. Expect none caused by parent-child scenarios.
3. If any `warnAmbiguous` fires, capture the raw `/session/status` response and `blockedSessionIds` for root-cause analysis of remaining edge cases.
4. Verify `turnComplete` and `requestAssociation` events resume flowing for previously-affected terminals.

---

## 7. 2026-05-16 Restart Resilience Addendum

This addendum is the handoff for the restart failure observed on dev after the OpenCode resilience work landed. It extends, and in a few places supersedes, the original implementation plan above. The earlier child/root ownership analysis was correct, but the delivered system did not keep that resolver wired through production startup, and the test plan did not exercise the actual restart shape that failed.

Primary evidence is captured in `docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md`, especially the `2026-05-16 dev restart postmortem` section. The short version:

- `server/coding-cli/providers/opencode.ts` has `OpenCodeProvider.resolveOpencodeSessionRoots(...)`.
- `server/coding-cli/opencode-activity-wiring.ts` accepts `resolveOpencodeSessionRoots` and forwards it into `OpencodeActivityTracker`.
- `server/index.ts` currently constructs OpenCode activity with `wireOpencodeActivityTracker({ registry })`, so production uses the tracker's identity resolver instead of the provider-backed root resolver.
- Existing tests cover the tracker/provider behavior and a shell-pane server restart, but not the production composition of `server/index.ts` plus multiple OpenCode panes across server restart.
- The `terminal_exit_without_durable_session` logs seen during the restart are also misleading: `TerminalRegistry.kill()` releases the session binding before calling `recordTerminalExitWithoutDurableSession(...)`, so an already-bound OpenCode terminal can be logged as if it lacked durable identity.

### 7.1 Required Fixes

1. Wire the provider root resolver through production startup.

   Change the production construction path so `server/index.ts` passes:

   ```typescript
   resolveOpencodeSessionRoots: (sessionIds) => opencodeProvider.resolveOpencodeSessionRoots(sessionIds)
   ```

   into `wireOpencodeActivityTracker(...)`.

   Do not add a hidden parallel DB lookup path in the tracker just to compensate for missing wiring. The provider is already the owner of OpenCode database knowledge; the integration layer must pass it through.

2. Remove or constrain silent identity fallback for production.

   The current default resolver in `OpencodeActivityTracker` maps every session to itself. That is useful for narrow reducer tests, but it made the production wiring omission look like a valid configuration. Make the fallback explicit and test-only, for example by requiring callers to provide a resolver unless they pass a clearly named test option such as `allowIdentityRootResolverForTests: true`.

   If the final design keeps a default resolver, the production construction test in this addendum must still fail when `server/index.ts` omits the provider resolver.

3. Fix the false `terminal_exit_without_durable_session` warning.

   In `server/terminal-registry.ts`, record the durable-session warning decision before `releaseBinding(...)` clears `record.resumeSessionId`, or pass the pre-release durable identity state into `recordTerminalExitWithoutDurableSession(...)`.

   This is observability correctness, not the primary restore bug. It still belongs in the implementation because misleading lifecycle logs slowed the investigation and would hide future regressions.

4. Confirm client restart ordering preserves durable OpenCode identity.

   When a browser reconnects after server restart with stale terminal IDs, an OpenCode pane with an existing `sessionRef` must issue a restored `terminal.create` request for the same root session. It must not fall back to a fresh OpenCode launch merely because `terminal.attach`, `terminal.resize`, or inventory cleanup reports `INVALID_TERMINAL_ID`.

### 7.2 Required Test Coverage

The implementation is not complete until these tests exist and fail for the broken production wiring.

1. Production composition test for OpenCode resolver wiring.

   Add or extend a focused test under `test/unit/server/coding-cli/`, preferably by extracting a small production factory from `server/index.ts` instead of importing the side-effectful entrypoint. One acceptable shape:

   - Create `server/coding-cli/opencode-activity-integration.ts`.
   - Export a function that receives `{ registry, opencodeProvider, ...callbacks }`.
   - Inside that function, call `wireOpencodeActivityTracker(...)` with `resolveOpencodeSessionRoots` sourced from the provider.
   - Use that exported function from `server/index.ts`.
   - Test the exported function with a fake provider and fake registry.

   Assertions:

   - The fake provider's `resolveOpencodeSessionRoots(...)` is called when the tracker sees a child session.
   - The terminal binds to the resolved root session, not the child session.
   - Omitting the resolver in this production integration path is not representable or causes a clear failure.

2. Multi-agent browser/server restart test for OpenCode.

   Add a new Playwright spec such as `test/e2e-browser/specs/opencode-restart-recovery.spec.ts`, or extend `test/e2e-browser/specs/server-restart-recovery.spec.ts` with a separate OpenCode describe block. This must use the existing `TestServer` helper so the test starts a real temporary Freshell server, opens the actual browser app, and reconnects the same page to a fresh server process.

   Required scenario:

   - Start `TestServer` with an isolated home and a deterministic test `opencode` executable first on `PATH`.
   - Create at least three OpenCode panes or tabs.
   - Interact with each pane enough for the fake OpenCode process to expose a root session and at least one child session as busy.
   - Wait until each pane has a durable `sessionRef` rooted at the parent OpenCode session.
   - Stop the first server gracefully.
   - Start a second `TestServer` on the same port and token, preserving the same isolated OpenCode data home.
   - Wait for the browser WebSocket to reconnect.
   - Assert each OpenCode pane recreates a terminal with `restore: true`, preserves its original root `sessionRef`, and receives a new live `terminalId`.
   - Assert each fake OpenCode launch used `--session <root-session-id>` or the equivalent restore argument expected by Freshell's OpenCode provider.
   - Assert no pane adopts a child session ID.
   - Assert no `warnAmbiguous` log is emitted for parent/child busy state.
   - Assert `/api/terminals` or the test harness shows restored terminals with attached clients.

   Add restart variations after the graceful baseline passes:

   - Hard kill: add a `TestServer` helper method that terminates the server process with `SIGKILL` without running graceful shutdown, then restarts on the same port and token.
   - Closed pane: close one OpenCode pane before restart and assert it is not resurrected.
   - Mixed panes: include at least one shell pane with the OpenCode panes and assert shell recreation does not mask OpenCode durable restore failures.

   Implementation note: the current `TestServer` creates a fresh temporary home on each `start()` and removes it on `stop()` unless `preserveHomeOnStop` is set. The OpenCode restart test must either extend `TestServer` to reuse an explicit home/app-data directory across the two server processes, or set up stable symlinks from each temp home to a shared OpenCode data directory. Do not re-seed the OpenCode DB after restart in a way that hides whether the first process actually persisted the root/child relationship.

3. Deterministic fake OpenCode executable for e2e-browser tests.

   Do not rely on real network/model activity in default CI. The fake executable should live under `test/e2e-browser/fixtures/` or `test/helpers/` and be installed into a temporary `bin` directory by the test's `setupHome` callback.

   It must emulate only the control surface Freshell needs:

   - Long-running terminal process that accepts stdin and stays alive until killed.
   - Version/help behavior if Freshell's CLI detection asks for it.
   - Local OpenCode server endpoint with `/global/health`, `/session/status`, `/event`, session listing, and any restore endpoint or route Freshell calls.
   - Server-sent events for `server.connected`, `session.status`, `session.idle`, and `session.created`.
   - A persisted `opencode.db` in the isolated `XDG_DATA_HOME` using the real `session.parent_id` shape, so `OpenCodeProvider.resolveOpencodeSessionRoots(...)` reads the same root/child relationship the production code reads.
   - An audit log of launch arguments, session IDs, status responses, and received stdin so the Playwright test can assert restore behavior without scraping terminal text.

   The fake should create stable root IDs per pane and child IDs under those roots. It should be able to report `{ root: busy, child: busy }` at restart time; that is the condition that previously required root resolution.

4. Client restart ordering tests.

   Extend the client-focused restart tests so OpenCode is covered, not just shell or other provider cases.

   Required assertions:

   - A pane with `mode: 'opencode'`, stale `terminalId`, and existing root `sessionRef` handles `INVALID_TERMINAL_ID` by recreating with `restore: true`.
   - The recreate request preserves the original root `sessionRef`.
   - The pane does not enter `fresh_after_restore_unavailable` unless the provider explicitly reports restore unavailable.
   - Inventory cleanup during reconnect cannot erase the durable identity before the restore request is constructed.

   Candidate files:

   - `test/e2e/terminal-restart-recovery.test.tsx`
   - `test/unit/client/components/TerminalView.resumeSession.test.tsx`
   - `test/unit/client/components/TerminalView.lifecycle.test.tsx`

5. Lifecycle logging unit test.

   Add a server-side test proving an OpenCode terminal with a bound durable session does not emit `terminal_exit_without_durable_session` on final close. The test should fail against the current order where `releaseBinding(...)` clears `resumeSessionId` before the warning predicate runs.

   Candidate files:

   - `test/server/session-association.test.ts`
   - `test/unit/server/terminal-registry.codex-sidecar.test.ts`
   - A new focused `test/unit/server/terminal-registry-session-lifecycle.test.ts`

6. Optional real-provider contract probe.

   Keep the existing real provider contract tests as opt-in coverage. They are useful for validating the installed OpenCode binary, but they do not replace the deterministic browser/server restart test because they do not run the Freshell app through process death and WebSocket reconnect.

### 7.3 Acceptance Criteria For The Handoff

The agent implementing this addendum should leave the repo in this state:

1. `server/index.ts` reaches OpenCode activity through a tested integration path that passes `OpenCodeProvider.resolveOpencodeSessionRoots(...)`.
2. The OpenCode activity tracker cannot silently run in production with the identity root resolver because a caller forgot to wire the provider.
3. The new production composition test fails against the current broken `wireOpencodeActivityTracker({ registry })` startup shape.
4. The new browser/server restart test creates multiple OpenCode panes, interacts with them, gracefully restarts the temp server, and proves root-session restore for every surviving pane.
5. A hard-kill restart variation exists, or the plan documents a concrete blocker in `TestServer` with a failing or skipped test that explains what helper is missing.
6. A closed-pane variation proves restart recovery does not resurrect deliberately closed OpenCode panes.
7. Client unit/e2e tests cover `INVALID_TERMINAL_ID` for OpenCode panes with durable `sessionRef`.
8. Lifecycle logging no longer emits `terminal_exit_without_durable_session` for an OpenCode terminal that had a durable binding before final close.
9. Focused unit/integration tests and the OpenCode restart browser spec are run from the worktree before PR handoff. The broader coordinated suite should be run if the implementer changes shared terminal lifecycle or WebSocket reconnect logic.

### 7.4 Suggested Verification Commands

Run focused tests first:

```bash
npm run test:vitest -- test/unit/server/coding-cli/opencode-activity-wiring.test.ts --run
npm run test:vitest -- test/unit/client/components/TerminalView.resumeSession.test.tsx --run
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run
npm run test:vitest -- test/server/session-association.test.ts --run
```

Then build and run the browser restart spec:

```bash
npm run build
npm run test:e2e -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts
```

If the implementation touches shared reconnect behavior, finish with coordinated verification:

```bash
FRESHELL_TEST_SUMMARY="OpenCode restart resilience" npm run test:status
FRESHELL_TEST_SUMMARY="OpenCode restart resilience" npm run check
```

Do not restart the self-hosted dev server for production validation unless the user explicitly approves that restart.
