# Sessions Delta Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate repeated ~500KB `sessions.updated` WebSocket broadcasts by switching to incremental session updates (`sessions.patch`) while preserving the existing UX and feature set (live sidebar/history updates, mobile chunking, session overrides, project colors, etc).

**Architecture:** Add capability negotiation in `hello` so new clients can receive incremental `sessions.patch` messages. Server computes a project-level diff between the last and next `ProjectGroup[]` snapshots and broadcasts patches to patch-capable clients, while continuing to send full chunked snapshots to legacy clients and as a fallback when the diff would be too large. Client applies patches via a dedicated reducer that supports upserts and removals and keeps project ordering stable for `HistoryView`.

**Tech Stack:** Node/Express, ws, Zod, React, Redux Toolkit, Vitest

---

## Task 1: Add Server-Side Sessions Diff Helper (Red)

**Files:**
- Create: `server/sessions-sync/diff.ts`
- Test: `test/unit/server/sessions-sync/diff.test.ts`

**Step 1: Write failing diff tests**

Create `test/unit/server/sessions-sync/diff.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { ProjectGroup } from '../../../../server/coding-cli/types.js'
import { diffProjects } from '../../../../server/sessions-sync/diff.js'

function pg(projectPath: string, sessions: ProjectGroup['sessions'], color?: string): ProjectGroup {
  return { projectPath, sessions, ...(color ? { color } : {}) }
}

describe('diffProjects', () => {
  it('upserts newly added projects', () => {
    const prev: ProjectGroup[] = []
    const next: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }]),
    ]

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual([])
    expect(diff.upsertProjects).toEqual(next)
  })

  it('removes deleted projects', () => {
    const prev: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }]),
      pg('/p2', [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', updatedAt: 2 }]),
    ]
    const next: ProjectGroup[] = [
      pg('/p2', [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', updatedAt: 2 }]),
    ]

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual(['/p1'])
    expect(diff.upsertProjects).toEqual([])
  })

  it('upserts projects when a session field changes', () => {
    const prev: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1, title: 'Old' }]),
    ]
    const next: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1, title: 'New' }]),
    ]

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual([])
    expect(diff.upsertProjects).toEqual(next)
  })

  it('does not upsert unchanged projects', () => {
    const prev: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }], '#aaa'),
    ]
    const next: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }], '#aaa'),
    ]

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual([])
    expect(diff.upsertProjects).toEqual([])
  })
})
```

**Step 2: Run the server unit test**

Run:
```bash
npm run test:server -- test/unit/server/sessions-sync/diff.test.ts
```

Expected: FAIL (module not found / `diffProjects` not implemented).

**Step 3: Commit**

```bash
git add test/unit/server/sessions-sync/diff.test.ts
git commit -m "test(server): add sessions diff unit tests"
```

---

## Task 2: Implement Server-Side Sessions Diff Helper (Green)

**Files:**
- Create: `server/sessions-sync/diff.ts`
- Test: `test/unit/server/sessions-sync/diff.test.ts`

**Step 1: Implement `diffProjects`**

Create `server/sessions-sync/diff.ts`:

```ts
import type { ProjectGroup, CodingCliSession } from '../coding-cli/types.js'

export type SessionsProjectsDiff = {
  upsertProjects: ProjectGroup[]
  removeProjectPaths: string[]
}

function sessionsEqual(a: CodingCliSession, b: CodingCliSession): boolean {
  return (
    (a.provider || 'claude') === (b.provider || 'claude') &&
    a.sessionId === b.sessionId &&
    a.projectPath === b.projectPath &&
    a.updatedAt === b.updatedAt &&
    a.createdAt === b.createdAt &&
    a.messageCount === b.messageCount &&
    a.title === b.title &&
    a.summary === b.summary &&
    a.cwd === b.cwd &&
    a.archived === b.archived &&
    a.sourceFile === b.sourceFile
  )
}

function projectEqual(a: ProjectGroup, b: ProjectGroup): boolean {
  if (a.projectPath !== b.projectPath) return false
  if ((a.color || '') !== (b.color || '')) return false
  if (a.sessions.length !== b.sessions.length) return false

  for (let i = 0; i < a.sessions.length; i += 1) {
    if (!sessionsEqual(a.sessions[i]!, b.sessions[i]!)) return false
  }
  return true
}

export function diffProjects(prev: ProjectGroup[], next: ProjectGroup[]): SessionsProjectsDiff {
  const prevByPath = new Map(prev.map((p) => [p.projectPath, p] as const))
  const nextByPath = new Map(next.map((p) => [p.projectPath, p] as const))

  const removeProjectPaths: string[] = []
  for (const key of prevByPath.keys()) {
    if (!nextByPath.has(key)) removeProjectPaths.push(key)
  }

  const upsertProjects: ProjectGroup[] = []
  for (const [projectPath, nextProject] of nextByPath) {
    const prevProject = prevByPath.get(projectPath)
    if (!prevProject || !projectEqual(prevProject, nextProject)) {
      upsertProjects.push(nextProject)
    }
  }

  // Deterministic order makes tests and patch application simpler.
  removeProjectPaths.sort()
  upsertProjects.sort((a, b) => a.projectPath.localeCompare(b.projectPath))

  return { upsertProjects, removeProjectPaths }
}
```

**Step 2: Run the server unit test**

Run:
```bash
npm run test:server -- test/unit/server/sessions-sync/diff.test.ts
```
Expected: PASS

**Step 3: Commit**

```bash
git add server/sessions-sync/diff.ts
git commit -m "feat(server): diff sessions projects for ws patches"
```

---

## Task 3: Add WS Capability Negotiation For Sessions Patches

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/ws-client.ts`
- Test: `test/server/ws-protocol.test.ts`

**Step 1: Add a failing protocol test (hello accepts capabilities)**

In `test/server/ws-protocol.test.ts`, add one new test near the existing auth/hello tests:

```ts
it('accepts hello with capabilities', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))

  ws.send(JSON.stringify({
    type: 'hello',
    token: 'testtoken-testtoken',
    capabilities: { sessionsPatchV1: true },
  }))

  const msg = await waitForMessage(ws, (m) => m.type === 'ready')
  expect(msg.type).toBe('ready')
  await closeWebSocket(ws)
})
```

Run:
```bash
npm run test:integration -- test/server/ws-protocol.test.ts
```

Expected: FAIL (HelloSchema rejects unknown field `capabilities`).

**Step 2: Update server HelloSchema to accept capabilities**

In `server/ws-handler.ts`, extend `HelloSchema`:

```ts
const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
  capabilities: z.object({
    sessionsPatchV1: z.boolean().optional(),
  }).optional(),
  sessions: z.object({
    active: z.string().optional(),
    visible: z.array(z.string()).optional(),
    background: z.array(z.string()).optional(),
  }).optional(),
})
```

**Step 3: Update client hello to advertise patch support**

In `src/lib/ws-client.ts`, modify the hello send inside `onopen`:

```ts
this.ws?.send(JSON.stringify({
  type: 'hello',
  token,
  capabilities: { sessionsPatchV1: true },
  ...extensions,
}))
```

**Step 4: Re-run the protocol test**

Run:
```bash
npm run test:integration -- test/server/ws-protocol.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add server/ws-handler.ts src/lib/ws-client.ts test/server/ws-protocol.test.ts
git commit -m "feat(ws): negotiate sessions.patch capability via hello"
```

---

## Task 4: Add Client Reducer To Apply Sessions Patches (Red)

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Test: `test/unit/client/store/sessionsSlice.test.ts`

**Step 1: Write failing reducer tests**

Add to `test/unit/client/store/sessionsSlice.test.ts`:

```ts
import { applySessionsPatch } from '@/store/sessionsSlice'

describe('applySessionsPatch', () => {
  it('upserts projects and removes deleted project paths', () => {
    const starting = sessionsReducer(undefined, setProjects([
      { projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }] },
      { projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', updatedAt: 2 }] },
    ] as any))

    const next = sessionsReducer(starting, applySessionsPatch({
      upsertProjects: [{ projectPath: '/p3', sessions: [{ provider: 'claude', sessionId: 's3', projectPath: '/p3', updatedAt: 3 }] }],
      removeProjectPaths: ['/p1'],
    }))

    expect(next.projects.map((p) => p.projectPath).sort()).toEqual(['/p2', '/p3'])
  })

  it('keeps HistoryView project ordering stable by sorting projects by newest session updatedAt', () => {
    const starting = sessionsReducer(undefined, setProjects([
      { projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 10 }] },
      { projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', updatedAt: 20 }] },
    ] as any))

    const next = sessionsReducer(starting, applySessionsPatch({
      upsertProjects: [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 30 }] }],
      removeProjectPaths: [],
    }))

    expect(next.projects[0]?.projectPath).toBe('/p1')
    expect(next.projects[1]?.projectPath).toBe('/p2')
  })
})
```

**Step 2: Run the client unit test**

Run:
```bash
npm run test:client -- test/unit/client/store/sessionsSlice.test.ts
```
Expected: FAIL (`applySessionsPatch` missing).

**Step 3: Commit**

```bash
git add test/unit/client/store/sessionsSlice.test.ts
git commit -m "test(client): add sessions.patch reducer tests"
```

---

## Task 5: Implement Client Reducer To Apply Sessions Patches (Green)

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Test: `test/unit/client/store/sessionsSlice.test.ts`

**Step 1: Implement `applySessionsPatch` + project sorting**

In `src/store/sessionsSlice.ts`, add:

```ts
function projectNewestUpdatedAt(project: ProjectGroup): number {
  // Sessions are expected sorted by updatedAt desc from the server, but don't rely on it.
  let max = 0
  for (const s of project.sessions || []) {
    if (typeof (s as any).updatedAt === 'number') max = Math.max(max, (s as any).updatedAt)
  }
  return max
}

function sortProjectsByRecency(projects: ProjectGroup[]): ProjectGroup[] {
  return [...projects].sort((a, b) => {
    const aTime = projectNewestUpdatedAt(a)
    const bTime = projectNewestUpdatedAt(b)
    if (aTime !== bTime) return bTime - aTime
    return a.projectPath.localeCompare(b.projectPath)
  })
}
```

Then add a new reducer:

```ts
applySessionsPatch: (
  state,
  action: PayloadAction<{ upsertProjects: ProjectGroup[]; removeProjectPaths: string[] }>
) => {
  const remove = new Set(action.payload.removeProjectPaths || [])
  const incoming = normalizeProjects(action.payload.upsertProjects)

  const projectMap = new Map(state.projects.map((p) => [p.projectPath, p]))

  for (const key of remove) projectMap.delete(key)
  for (const project of incoming) projectMap.set(project.projectPath, project)

  state.projects = sortProjectsByRecency(Array.from(projectMap.values()))
  state.lastLoadedAt = Date.now()

  const valid = new Set(state.projects.map((p) => p.projectPath))
  state.expandedProjects = new Set(Array.from(state.expandedProjects).filter((k) => valid.has(k)))
},
```

Export it:

```ts
export const { /* ... */, applySessionsPatch } = sessionsSlice.actions
```

**Step 2: Run the client unit test**

Run:
```bash
npm run test:client -- test/unit/client/store/sessionsSlice.test.ts
```
Expected: PASS

**Step 3: Commit**

```bash
git add src/store/sessionsSlice.ts
git commit -m "feat(client): apply sessions.patch updates incrementally"
```

---

## Task 6: Handle `sessions.patch` Messages In The App (Client)

**Files:**
- Modify: `src/App.tsx`
- Test: `test/unit/client/components/App.test.tsx`

**Step 1: Add a failing App WS handling test**

In `test/unit/client/components/App.test.tsx` inside “App WS message handling”, add:

```ts
it('applies sessions.patch messages (upsert + remove) without clearing all sessions', async () => {
  let handler: ((msg: any) => void) | null = null
  mockOnMessage.mockImplementation((cb: (msg: any) => void) => {
    handler = cb
    return () => { handler = null }
  })

  const store = createTestStore()
  renderApp(store)
  await waitFor(() => expect(handler).not.toBeNull())

  // Seed state via a full snapshot (existing behavior).
  handler!({
    type: 'sessions.updated',
    projects: [
      { projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', updatedAt: 1 }] },
      { projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', updatedAt: 2 }] },
    ],
  })

  handler!({
    type: 'sessions.patch',
    upsertProjects: [{ projectPath: '/p3', sessions: [{ provider: 'claude', sessionId: 's3', updatedAt: 3 }] }],
    removeProjectPaths: ['/p1'],
  })

  await waitFor(() => {
    expect(store.getState().sessions.projects.map((p: any) => p.projectPath).sort()).toEqual(['/p2', '/p3'])
  })
})
```

Run:
```bash
npm run test:client -- test/unit/client/components/App.test.tsx
```
Expected: FAIL (`sessions.patch` ignored).

**Step 2: Implement sessions.patch handling in `src/App.tsx`**

In `src/App.tsx`, import and handle:

```ts
import { setProjects, clearProjects, mergeProjects, applySessionsPatch } from '@/store/sessionsSlice'
```

Add:

```ts
if (msg.type === 'sessions.patch') {
  dispatch(applySessionsPatch({
    upsertProjects: msg.upsertProjects || [],
    removeProjectPaths: msg.removeProjectPaths || [],
  }))
}
```

**Step 3: Re-run the test**

Run:
```bash
npm run test:client -- test/unit/client/components/App.test.tsx
```
Expected: PASS

**Step 4: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.test.tsx
git commit -m "feat(client): handle ws sessions.patch messages"
```

---

## Task 7: Broadcast `sessions.patch` From The Server WS Layer

**Files:**
- Modify: `server/ws-handler.ts`
- Test: `test/server/ws-handshake-snapshot.test.ts`
- Create: `test/server/ws-sessions-patch.test.ts`

**Step 1: Add a failing server WS test for sessions.patch broadcast**

Create `test/server/ws-sessions-patch.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'

const TEST_TIMEOUT_MS = 30_000
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS })

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (typeof addr === 'object' && addr) resolve(addr.port)
  }))
}

function waitFor(ws: WebSocket, type: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === type) {
        clearTimeout(t)
        resolve(msg)
      }
    })
  })
}

class FakeRegistry { detach() {} }

describe('ws sessions.patch broadcast', () => {
  let server: http.Server
  let port: number
  let handler: any

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'

    const { WsHandler } = await import('../../server/ws-handler.js')

    server = http.createServer()
    handler = new WsHandler(
      server,
      new FakeRegistry() as any,
      undefined,
      undefined,
      async () => ({
        projects: [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }] }],
      }),
    )
    port = await listen(server)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('sends sessions.patch only to clients advertising capability and after snapshot', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    ws.send(JSON.stringify({
      type: 'hello',
      token: 'testtoken-testtoken',
      capabilities: { sessionsPatchV1: true },
    }))

    await waitFor(ws, 'ready')
    await waitFor(ws, 'sessions.updated')

    const patchPromise = waitFor(ws, 'sessions.patch')
    handler.broadcastSessionsPatch({
      type: 'sessions.patch',
      upsertProjects: [{ projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', updatedAt: 2 }] }],
      removeProjectPaths: ['/p1'],
    })

    const msg = await patchPromise
    expect(msg.removeProjectPaths).toEqual(['/p1'])
    ws.terminate()
  })
})
```

Run:
```bash
npm run test:integration -- test/server/ws-sessions-patch.test.ts
```
Expected: FAIL (no `broadcastSessionsPatch`, no capability tracking, or snapshot-done gating).

**Step 2: Track capability + snapshot completion in `ClientState`**

In `server/ws-handler.ts`, extend `ClientState`:

```ts
type ClientState = {
  // ...
  supportsSessionsPatchV1: boolean
  sessionsSnapshotSent: boolean
  // ...
}
```

Initialize defaults on connection:
- `supportsSessionsPatchV1: false`
- `sessionsSnapshotSent: false`

When handling `hello`, set:

```ts
state.supportsSessionsPatchV1 = !!m.capabilities?.sessionsPatchV1
```

Change `scheduleHandshakeSnapshot` / `sendHandshakeSnapshot` to accept `state` and set:

```ts
state.sessionsSnapshotSent = true
```
after `await this.sendChunkedSessions(ws, snapshot.projects)`.

**Step 3: Implement `broadcastSessionsPatch`**

In `server/ws-handler.ts`, add:

```ts
broadcastSessionsPatch(msg: { type: 'sessions.patch'; upsertProjects: ProjectGroup[]; removeProjectPaths: string[] }): void {
  for (const ws of this.connections) {
    if (ws.readyState !== WebSocket.OPEN) continue
    const state = this.clientStates.get(ws)
    if (!state?.authenticated) continue
    if (!state.supportsSessionsPatchV1) continue
    if (!state.sessionsSnapshotSent) continue
    this.safeSend(ws, msg)
  }
}
```

**Step 4: Re-run server integration tests**

Run:
```bash
npm run test:integration -- test/server/ws-sessions-patch.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add server/ws-handler.ts test/server/ws-sessions-patch.test.ts
git commit -m "feat(ws): broadcast sessions.patch to patch-capable clients"
```

---

## Task 8: Add Server Sessions Sync Service + Wire It Into Server Index

**Files:**
- Create: `server/sessions-sync/service.ts`
- Modify: `server/index.ts`
- Test: `test/unit/server/sessions-sync/service.test.ts`

**Step 1: Add a failing service test**

Create `test/unit/server/sessions-sync/service.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { SessionsSyncService } from '../../../../server/sessions-sync/service.js'
import type { ProjectGroup } from '../../../../server/coding-cli/types.js'

describe('SessionsSyncService', () => {
  it('broadcasts only diffs via sessions.patch', () => {
    const ws = {
      broadcastSessionsPatch: vi.fn(),
      broadcastSessionsUpdatedToLegacy: vi.fn(),
      broadcastSessionsUpdated: vi.fn(),
    }

    const svc = new SessionsSyncService(ws as any)

    const a: ProjectGroup[] = [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }] }]
    const b: ProjectGroup[] = [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 2 }] }]

    svc.publish(a)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(1)

    svc.publish(b)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(2)
    expect(ws.broadcastSessionsUpdated).not.toHaveBeenCalled()
  })
})
```

Run:
```bash
npm run test:server -- test/unit/server/sessions-sync/service.test.ts
```
Expected: FAIL (service missing).

**Step 2: Implement `SessionsSyncService`**

Create `server/sessions-sync/service.ts`:

```ts
import type { ProjectGroup } from '../coding-cli/types.js'
import { diffProjects } from './diff.js'

export class SessionsSyncService {
  private last: ProjectGroup[] = []
  private hasLast = false

  constructor(
    private ws: {
      broadcastSessionsPatch: (msg: { type: 'sessions.patch'; upsertProjects: ProjectGroup[]; removeProjectPaths: string[] }) => void
      broadcastSessionsUpdatedToLegacy: (projects: ProjectGroup[]) => void
      broadcastSessionsUpdated: (projects: ProjectGroup[]) => void
    }
  ) {}

  publish(next: ProjectGroup[]): void {
    const prev = this.hasLast ? this.last : []
    const diff = diffProjects(prev, next)

    this.last = next
    this.hasLast = true

    // No changes.
    if (diff.upsertProjects.length === 0 && diff.removeProjectPaths.length === 0) return

    // Patch-first: send diffs to capable clients; snapshots only to legacy clients.
    // If we later find patch messages can become too large, we can add a size guard
    // that falls back to broadcastSessionsUpdated(next).
    this.ws.broadcastSessionsPatch({
      type: 'sessions.patch',
      upsertProjects: diff.upsertProjects,
      removeProjectPaths: diff.removeProjectPaths,
    })
    this.ws.broadcastSessionsUpdatedToLegacy(next)
  }
}
```

**Step 3: Add `broadcastSessionsUpdatedToLegacy` to WsHandler**

In `server/ws-handler.ts`, add:

```ts
broadcastSessionsUpdatedToLegacy(projects: ProjectGroup[]): void {
  for (const ws of this.connections) {
    if (ws.readyState !== WebSocket.OPEN) continue
    const state = this.clientStates.get(ws)
    if (!state?.authenticated) continue
    if (state.supportsSessionsPatchV1 && state.sessionsSnapshotSent) continue
    void this.sendChunkedSessions(ws, projects)
  }
}
```

**Step 4: Wire into `server/index.ts`**

In `server/index.ts`:
- Import `SessionsSyncService` from `./sessions-sync/service.js`
- After creating `wsHandler`, create `const sessionsSync = new SessionsSyncService(wsHandler)`
- Replace every `wsHandler.broadcastSessionsUpdated(...)` call that’s part of indexer refresh / settings / session override flows with `sessionsSync.publish(...)`.

Specifically update:
- `codingCliIndexer.onUpdate((projects) => { ... })`: replace `wsHandler.broadcastSessionsUpdated(projects)` with `sessionsSync.publish(projects)`.
- `/api/settings` PATCH+PUT handlers: replace `wsHandler.broadcastSessionsUpdated(codingCliIndexer.getProjects())` with `sessionsSync.publish(codingCliIndexer.getProjects())`.
- `/api/sessions/:sessionId` PATCH+DELETE handlers: same.
- `/api/project-colors` handler: same.

**Step 5: Re-run tests**

Run:
```bash
npm run test:server -- test/unit/server/sessions-sync/service.test.ts
npm run test:integration
npm run test:client
```
Expected: PASS

**Step 6: Commit**

```bash
git add server/sessions-sync/service.ts server/ws-handler.ts server/index.ts test/unit/server/sessions-sync/service.test.ts
git commit -m "feat(server): broadcast sessions updates as ws patches"
```

---

## Task 9: Add A Patch Size Guard + Fallback To Snapshot (Hardening)

**Files:**
- Modify: `server/sessions-sync/service.ts`
- Test: `test/unit/server/sessions-sync/service.test.ts`

**Step 1: Add a failing test for fallback**

Add a test that forces a “large diff” (e.g., many projects) and expects `broadcastSessionsUpdated(next)` to be used.

**Step 2: Implement size guard**

In `server/sessions-sync/service.ts`, estimate payload bytes:

```ts
function estimateBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}
```

If the patch estimate exceeds `MAX_WS_CHUNK_BYTES` (match env var default `500 * 1024`), call `broadcastSessionsUpdated(next)` instead of `broadcastSessionsPatch`.

**Step 3: Run tests and commit**

Run:
```bash
npm run test:server -- test/unit/server/sessions-sync/service.test.ts
```

Commit:
```bash
git add server/sessions-sync/service.ts test/unit/server/sessions-sync/service.test.ts
git commit -m "feat(server): fallback to snapshot when sessions.patch is too large"
```

---

## Task 10: Manual Verification (Perf Regression Guard)

**Step 1: Run dev server and reproduce original perf issue**

Run:
```bash
npm run dev
```

Open Freshell in 2-3 tabs; ensure sessions are updating (active CLI sessions appending).

**Step 2: Verify logs no longer show periodic `ws_send_large` for `sessions.updated` during steady-state**

Watch:
- `~/.freshell/logs/server-debug.jsonl`

Expected:
- `sessions.updated` appears primarily at handshake / reconnect.
- Steady state uses `sessions.patch` (and `ws_send_large` warnings should largely disappear).

**Step 3: Verify UX parity**
- Sidebar sessions list continues to update while a session is running.
- HistoryView project ordering remains correct (recent project bubbles up as its sessions update).
- Mobile chunking behavior still works on initial connect.

---

## Execution Handoff

Plan saved to `docs/plans/2026-02-07-sessions-delta-sync.md`.

Two execution options:
1. Subagent-Driven (this session): implement task-by-task with review checkpoints
2. Parallel Session (separate): open a new session in this worktree using `superpowers:executing-plans`
