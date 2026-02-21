# Router Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract all route handlers from `server/index.ts` into factory-function router modules so tests can import real routers instead of duplicating handlers.

**Architecture:** Each route group becomes a `createXxxRouter(deps)` factory that returns an Express Router. Schemas co-locate with their router. Tests import the factory and pass mock deps. `server/index.ts` becomes pure orchestration.

**Tech Stack:** Express Router factories, Zod schemas, Vitest with mock deps

**Design doc:** `docs/plans/2026-02-21-router-extraction-design.md`

---

### Task 1: Create server/utils.ts with cleanString

**Files:**
- Create: `server/utils.ts`
- Modify: `server/index.ts` (remove inline `cleanString`, add import)
- Test: `test/unit/server/utils.test.ts`

**Step 1: Write the failing test**

Create `test/unit/server/utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { cleanString } from '../../../server/utils.js'

describe('cleanString', () => {
  it('returns trimmed string for non-empty input', () => {
    expect(cleanString('  hello  ')).toBe('hello')
  })

  it('returns undefined for empty string', () => {
    expect(cleanString('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only string', () => {
    expect(cleanString('   ')).toBeUndefined()
  })

  it('returns undefined for null', () => {
    expect(cleanString(null)).toBeUndefined()
  })

  it('returns undefined for undefined', () => {
    expect(cleanString(undefined)).toBeUndefined()
  })

  it('returns trimmed string for non-empty with whitespace', () => {
    expect(cleanString('  test value  ')).toBe('test value')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/utils.test.ts`
Expected: FAIL (module not found)

**Step 3: Write the implementation**

Create `server/utils.ts`:

```typescript
/** Normalize nullable string overrides: null/empty/whitespace → undefined */
export const cleanString = (value: string | null | undefined): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : value
  return trimmed ? trimmed : undefined
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/utils.test.ts`
Expected: PASS

**Step 5: Update server/index.ts to import cleanString**

In `server/index.ts`:
- Add: `import { cleanString } from './utils.js'` at the top imports
- Remove the inline `cleanString` definition (lines 319-323)

**Step 6: Run full tests to verify no regression**

Run: `npm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add server/utils.ts test/unit/server/utils.test.ts server/index.ts
git commit -m "refactor: extract cleanString to server/utils.ts"
```

---

### Task 2: Extract platform-router.ts

Simplest router — pure function deps, 2 routes, no schemas.

**Files:**
- Create: `server/platform-router.ts`
- Modify: `server/index.ts` (remove routes, mount router)
- Modify: `test/integration/server/platform-api.test.ts` (use real router)

**Step 1: Write the failing test**

The existing `test/integration/server/platform-api.test.ts` has duplicated route handlers. Rewrite it to use the factory. First, read the existing test to understand what's being tested, then replace the route setup with:

```typescript
import { createPlatformRouter } from '../../../server/platform-router.js'

// In beforeAll/setup:
app.use('/api', createPlatformRouter({
  detectPlatform: vi.fn().mockResolvedValue('linux'),
  detectAvailableClis: vi.fn().mockResolvedValue({ claude: true, codex: false }),
  detectHostName: vi.fn().mockResolvedValue('test-host'),
  checkForUpdate: vi.fn().mockResolvedValue({ available: false }),
  appVersion: '1.0.0-test',
}))
```

Remove the inline route handler duplication.

Run: `npx vitest run test/integration/server/platform-api.test.ts`
Expected: FAIL (module not found)

**Step 2: Write the router**

Create `server/platform-router.ts`:

```typescript
import { Router } from 'express'
import { logger } from './logger.js'

const log = logger.child({ component: 'platform-router' })

export interface PlatformRouterDeps {
  detectPlatform: () => Promise<string>
  detectAvailableClis: () => Promise<Record<string, boolean>>
  detectHostName: () => Promise<string>
  checkForUpdate: (currentVersion: string) => Promise<any>
  appVersion: string
}

export function createPlatformRouter(deps: PlatformRouterDeps): Router {
  const { detectPlatform, detectAvailableClis, detectHostName, checkForUpdate, appVersion } = deps
  const router = Router()

  router.get('/platform', async (_req, res) => {
    const [platform, availableClis, hostName] = await Promise.all([
      detectPlatform(),
      detectAvailableClis(),
      detectHostName(),
    ])
    res.json({ platform, availableClis, hostName })
  })

  router.get('/version', async (_req, res) => {
    try {
      const updateCheck = await checkForUpdate(appVersion)
      res.json({ currentVersion: appVersion, updateCheck })
    } catch (err) {
      log.warn({ err }, 'Version check failed')
      res.json({ currentVersion: appVersion, updateCheck: null })
    }
  })

  return router
}
```

**Step 3: Update server/index.ts**

- Add import: `import { createPlatformRouter } from './platform-router.js'`
- Remove the `app.get('/api/platform', ...)` handler (lines 449-456)
- Remove the `app.get('/api/version', ...)` handler (lines 458-466)
- Add mount after auth middleware: `app.use('/api', createPlatformRouter({ detectPlatform, detectAvailableClis, detectHostName, checkForUpdate, appVersion: APP_VERSION }))`

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Add version endpoint test**

The existing `platform-api.test.ts` tests `/api/platform` but not `/api/version`. Add a test for the version endpoint and its error fallback:

```typescript
describe('GET /api/version', () => {
  it('returns current version and update check', async () => {
    const res = await request(app)
      .get('/api/version')
      .set('x-auth-token', AUTH_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.currentVersion).toBe('1.0.0-test')
    expect(res.body.updateCheck).toBeDefined()
  })

  it('returns null updateCheck when check fails', async () => {
    deps.checkForUpdate.mockRejectedValueOnce(new Error('network error'))
    const res = await request(app)
      .get('/api/version')
      .set('x-auth-token', AUTH_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.currentVersion).toBe('1.0.0-test')
    expect(res.body.updateCheck).toBeNull()
  })
})
```

**Step 6: Run tests, commit**

```bash
npm test
git add server/platform-router.ts server/index.ts test/integration/server/platform-api.test.ts
git commit -m "refactor: extract platform routes to platform-router.ts"
```

---

### Task 3: Extract proxy-router.ts

Simple — portForwardManager + getRequesterIdentity, 2 routes.

**Files:**
- Create: `server/proxy-router.ts`
- Modify: `server/index.ts`
- Modify: `test/integration/server/port-forward-api.test.ts`

**Step 1: Write the router**

```typescript
import { Router } from 'express'
import { logger } from './logger.js'
import type { PortForwardManager } from './port-forward.js'
import { getRequesterIdentity } from './request-ip.js'

const log = logger.child({ component: 'proxy-router' })

export interface ProxyRouterDeps {
  portForwardManager: PortForwardManager
}

export function createProxyRouter(deps: ProxyRouterDeps): Router {
  const { portForwardManager } = deps
  const router = Router()

  router.post('/forward', async (req, res) => {
    const { port: targetPort } = req.body || {}
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }
    try {
      const requester = getRequesterIdentity(req)
      const result = await portForwardManager.forward(targetPort, requester)
      res.json({ forwardedPort: result.port })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err, targetPort }, 'Port forward failed')
      res.status(500).json({ error: `Failed to create port forward: ${msg}` })
    }
  })

  router.delete('/forward/:port', (req, res) => {
    const targetPort = parseInt(req.params.port, 10)
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }
    try {
      const requester = getRequesterIdentity(req)
      portForwardManager.close(targetPort, requester.key)
      res.json({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err, targetPort }, 'Port forward close failed')
      res.status(500).json({ error: `Failed to close port forward: ${msg}` })
    }
  })

  return router
}
```

**Step 2: Update test to use real router**

In `test/integration/server/port-forward-api.test.ts`, replace inline route definitions with:
```typescript
import { createProxyRouter } from '../../../server/proxy-router.js'
// ...
// NOTE: This test uses a REAL PortForwardManager (not a mock) with an echo server
// for true integration testing. Pass the real manager through the factory.
app.use('/api/proxy', createProxyRouter({ portForwardManager: manager }))
```

Remove all duplicated route handler code. Keep the real PortForwardManager and echo server setup.

**Step 3: Update server/index.ts**

- Add import: `import { createProxyRouter } from './proxy-router.js'`
- Remove the `app.post('/api/proxy/forward', ...)` and `app.delete('/api/proxy/forward/:port', ...)` handlers
- Add mount: `app.use('/api/proxy', createProxyRouter({ portForwardManager }))`

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add server/proxy-router.ts server/index.ts test/integration/server/port-forward-api.test.ts
git commit -m "refactor: extract proxy routes to proxy-router.ts"
```

---

### Task 4: Extract local-file-router.ts

Pre-auth route with cookie-based auth. Mounted before rate limiting and API auth.

**Files:**
- Create: `server/local-file-router.ts`
- Modify: `server/index.ts`
- Modify: `test/integration/server/network-api.test.ts` (has `/local-file` tests)

**Step 1: Write the router**

```typescript
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import cookieParser from 'cookie-parser'
import { timingSafeCompare } from './auth.js'

export function createLocalFileRouter(): Router {
  const router = Router()

  router.get('/', cookieParser(), (req, res, next) => {
    const headerToken = typeof req.headers['x-auth-token'] === 'string'
      ? req.headers['x-auth-token']
      : undefined
    const cookieToken = typeof req.cookies?.['freshell-auth'] === 'string'
      ? req.cookies['freshell-auth']
      : undefined
    const token = headerToken || cookieToken
    const expectedToken = process.env.AUTH_TOKEN
    if (!expectedToken || !token || !timingSafeCompare(token, expectedToken)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  }, (req, res) => {
    const filePath = req.query.path as string
    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter required' })
    }
    const resolved = path.resolve(filePath)
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found' })
    }
    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Cannot serve directories' })
    }
    res.sendFile(resolved)
  })

  return router
}
```

**Step 2: Update server/index.ts**

- Add import: `import { createLocalFileRouter } from './local-file-router.js'`
- Replace the inline `/local-file` handler (lines 87-123) with: `app.use('/local-file', createLocalFileRouter())`

**Step 3: Update network-api.test.ts**

The `/local-file` tests in `network-api.test.ts` duplicate the handler. Replace with:
```typescript
import { createLocalFileRouter } from '../../../server/local-file-router.js'
// ...
app.use('/local-file', createLocalFileRouter())
```

Remove the inline `/local-file` route duplication.

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add server/local-file-router.ts server/index.ts test/integration/server/network-api.test.ts
git commit -m "refactor: extract local-file route to local-file-router.ts"
```

---

### Task 5: Extract terminals-router.ts

Medium complexity — configStore, registry, wsHandler deps. Exports `TerminalPatchSchema`.

**Files:**
- Create: `server/terminals-router.ts`
- Modify: `server/index.ts`
- Modify: `test/server/terminals-api.test.ts`

**Step 1: Write the router**

```typescript
import { Router } from 'express'
import { z } from 'zod'
import { cleanString } from './utils.js'
import type { ConfigStore } from './config-store.js'

export const TerminalPatchSchema = z.object({
  titleOverride: z.string().max(500).optional().nullable(),
  descriptionOverride: z.string().max(2000).optional().nullable(),
  deleted: z.boolean().optional(),
})

export interface TerminalsRouterDeps {
  configStore: Pick<ConfigStore, 'snapshot' | 'patchTerminalOverride' | 'deleteTerminal'>
  registry: {
    list: () => any[]
    updateTitle: (id: string, title: string) => void
    updateDescription: (id: string, desc: string) => void
  }
  wsHandler: {
    broadcast: (msg: any) => void
  }
}

export function createTerminalsRouter(deps: TerminalsRouterDeps): Router {
  const { configStore, registry, wsHandler } = deps
  const router = Router()

  router.get('/', async (_req, res) => {
    const cfg = await configStore.snapshot()
    const list = registry.list().filter((t: any) => !cfg.terminalOverrides?.[t.terminalId]?.deleted)
    const merged = list.map((t: any) => {
      const ov = cfg.terminalOverrides?.[t.terminalId]
      return {
        ...t,
        title: ov?.titleOverride || t.title,
        description: ov?.descriptionOverride || t.description,
      }
    })
    res.json(merged)
  })

  router.patch('/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    const parsed = TerminalPatchSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const { titleOverride: rawTitle, descriptionOverride: rawDesc, deleted } = parsed.data
    const titleOverride = rawTitle !== undefined ? cleanString(rawTitle) : undefined
    const descriptionOverride = rawDesc !== undefined ? cleanString(rawDesc) : undefined

    const next = await configStore.patchTerminalOverride(terminalId, {
      titleOverride,
      descriptionOverride,
      deleted,
    })

    if (typeof titleOverride === 'string' && titleOverride.trim()) registry.updateTitle(terminalId, titleOverride.trim())
    if (typeof descriptionOverride === 'string') registry.updateDescription(terminalId, descriptionOverride)

    wsHandler.broadcast({ type: 'terminal.list.updated' })
    res.json(next)
  })

  router.delete('/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    await configStore.deleteTerminal(terminalId)
    wsHandler.broadcast({ type: 'terminal.list.updated' })
    res.json({ ok: true })
  })

  return router
}
```

**Step 2: Update test to use real router**

In `test/server/terminals-api.test.ts`, replace the `createTestApp` function's inline terminal routes with:
```typescript
import { createTerminalsRouter } from '../../server/terminals-router.js'
// ...
app.use('/api/terminals', createTerminalsRouter({
  configStore,
  registry,
  wsHandler: { broadcast: vi.fn() },
}))
```

Remove all inline `TerminalPatchSchema`, `cleanString`, and route handler duplication from the test.

**Step 3: Update server/index.ts**

- Add import: `import { createTerminalsRouter } from './terminals-router.js'`
- Remove `TerminalPatchSchema` definition and terminal route handlers (GET/PATCH/DELETE)
- Add mount: `app.use('/api/terminals', createTerminalsRouter({ configStore, registry, wsHandler }))`

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add server/terminals-router.ts server/index.ts test/server/terminals-api.test.ts
git commit -m "refactor: extract terminal routes to terminals-router.ts"
```

---

### Task 6: Extract project-colors-router.ts

Small — 1 route, exports `ProjectColorSchema`.

**Files:**
- Create: `server/project-colors-router.ts`
- Modify: `server/index.ts`

**Step 1: Write the router**

```typescript
import { Router } from 'express'
import { z } from 'zod'

export const ProjectColorSchema = z.object({
  projectPath: z.string().min(1).max(1024),
  color: z.string().min(1).max(64),
})

export interface ProjectColorsRouterDeps {
  configStore: { setProjectColor: (path: string, color: string) => Promise<void> }
  codingCliIndexer: { refresh: () => Promise<void> }
}

export function createProjectColorsRouter(deps: ProjectColorsRouterDeps): Router {
  const { configStore, codingCliIndexer } = deps
  const router = Router()

  router.put('/project-colors', async (req, res) => {
    const parsed = ProjectColorSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const { projectPath, color } = parsed.data
    await configStore.setProjectColor(projectPath, color)
    await codingCliIndexer.refresh()
    res.json({ ok: true })
  })

  return router
}
```

**Step 2: Update server/index.ts**

- Add import: `import { createProjectColorsRouter } from './project-colors-router.js'`
- Remove `ProjectColorSchema` definition and `app.put('/api/project-colors', ...)` handler
- Add mount: `app.use('/api', createProjectColorsRouter({ configStore, codingCliIndexer }))`

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add server/project-colors-router.ts server/index.ts
git commit -m "refactor: extract project-colors route to project-colors-router.ts"
```

---

### Task 7: Extract sessions-router.ts

Medium — 4 routes, `SessionPatchSchema` defined inline, uses `cleanString`, dynamic imports for search.

**Files:**
- Create: `server/sessions-router.ts`
- Modify: `server/index.ts`
- Modify: `test/integration/server/session-search-api.test.ts`

**Step 1: Write the router**

```typescript
import { Router } from 'express'
import { z } from 'zod'
import { cleanString } from './utils.js'
import { logger } from './logger.js'
import { startPerfTimer } from './perf-logger.js'
import { makeSessionKey, type CodingCliProviderName } from './coding-cli/types.js'

const log = logger.child({ component: 'sessions-router' })

export const SessionPatchSchema = z.object({
  titleOverride: z.string().optional().nullable(),
  summaryOverride: z.string().optional().nullable(),
  deleted: z.coerce.boolean().optional(),
  archived: z.coerce.boolean().optional(),
  createdAtOverride: z.coerce.number().optional(),
})

export interface SessionsRouterDeps {
  configStore: {
    patchSessionOverride: (key: string, data: any) => Promise<any>
    deleteSession: (key: string) => Promise<void>
  }
  codingCliIndexer: {
    getProjects: () => any[]
    refresh: () => Promise<void>
  }
  codingCliProviders: any[]
  perfConfig: { slowSessionRefreshMs: number }
}

export function createSessionsRouter(deps: SessionsRouterDeps): Router {
  const { configStore, codingCliIndexer, codingCliProviders, perfConfig } = deps
  const router = Router()

  // Search must come BEFORE the generic /sessions route
  router.get('/sessions/search', async (req, res) => {
    try {
      const { SearchRequestSchema, searchSessions } = await import('./session-search.js')

      const parsed = SearchRequestSchema.safeParse({
        query: req.query.q,
        tier: req.query.tier || 'title',
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        maxFiles: req.query.maxFiles ? Number(req.query.maxFiles) : undefined,
      })

      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
      }

      const endSearchTimer = startPerfTimer(
        'sessions_search',
        {
          queryLength: parsed.data.query.length,
          tier: parsed.data.tier,
          limit: parsed.data.limit,
        },
        { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
      )

      try {
        const response = await searchSessions({
          projects: codingCliIndexer.getProjects(),
          providers: codingCliProviders,
          query: parsed.data.query,
          tier: parsed.data.tier,
          limit: parsed.data.limit,
          maxFiles: parsed.data.maxFiles,
        })

        endSearchTimer({ resultCount: response.results.length, totalScanned: response.totalScanned })
        res.json(response)
      } catch (err: any) {
        endSearchTimer({ error: true, errorName: err?.name, errorMessage: err?.message })
        throw err
      }
    } catch (err: any) {
      log.error({ err }, 'Session search failed')
      res.status(500).json({ error: 'Search failed' })
    }
  })

  router.get('/sessions', async (_req, res) => {
    res.json(codingCliIndexer.getProjects())
  })

  router.patch('/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
    const parsed = SessionPatchSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const { titleOverride, summaryOverride, deleted, archived, createdAtOverride } = parsed.data
    const next = await configStore.patchSessionOverride(compositeKey, {
      titleOverride: cleanString(titleOverride),
      summaryOverride: cleanString(summaryOverride),
      deleted,
      archived,
      createdAtOverride,
    })
    await codingCliIndexer.refresh()
    res.json(next)
  })

  router.delete('/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
    await configStore.deleteSession(compositeKey)
    await codingCliIndexer.refresh()
    res.json({ ok: true })
  })

  return router
}
```

**Step 2: Update session-search-api.test.ts**

Replace duplicated route handler with:
```typescript
import { createSessionsRouter } from '../../../server/sessions-router.js'
// ...
app.use('/api', createSessionsRouter({
  configStore: mockConfigStore,
  codingCliIndexer: mockIndexer,
  codingCliProviders: mockProviders,
  perfConfig: { slowSessionRefreshMs: 1000 },
}))
```

**Step 3: Update server/index.ts**

- Add import: `import { createSessionsRouter } from './sessions-router.js'`
- Remove session route handlers and `SessionPatchSchema`
- Add mount: `app.use('/api', createSessionsRouter({ configStore, codingCliIndexer, codingCliProviders, perfConfig }))`

**Step 4: Run tests, commit**

```bash
npm test
git add server/sessions-router.ts server/index.ts test/integration/server/session-search-api.test.ts
git commit -m "refactor: extract session routes to sessions-router.ts"
```

---

### Task 8: Extract network-router.ts

Medium-high complexity — networkManager, firewall config with child_process, dynamic imports.

**Files:**
- Create: `server/network-router.ts`
- Modify: `server/index.ts`
- Modify: `test/integration/server/network-api.test.ts`
- Modify: `test/integration/server/lan-info-api.test.ts`

**Step 1: Write the router**

Copy the full network route handlers from `server/index.ts` (lines 304-447) into a factory function. The router should include:

- `GET /lan-info` — calls `detectLanIps()`
- `GET /network/status` — calls `networkManager.getStatus()`
- `POST /network/configure` — validates with `NetworkConfigureSchema`, calls `networkManager.configure()`
- `POST /network/configure-firewall` — full firewall config logic with child_process

Export `NetworkConfigureSchema`.

```typescript
import { Router } from 'express'
import { z } from 'zod'
import { logger } from './logger.js'

const log = logger.child({ component: 'network-router' })

export const NetworkConfigureSchema = z.object({
  host: z.enum(['127.0.0.1', '0.0.0.0']),
  configured: z.boolean(),
})

export interface NetworkRouterDeps {
  networkManager: {
    getStatus: () => Promise<any>
    configure: (data: any) => Promise<any>
    getRelevantPorts: () => number[]
    setFirewallConfiguring: (v: boolean) => void
    resetFirewallCache: () => void
  }
  configStore: { getSettings: () => Promise<any> }
  wsHandler: { broadcast: (msg: any) => void }
  detectLanIps: () => string[]
}

export function createNetworkRouter(deps: NetworkRouterDeps): Router {
  const { networkManager, configStore, wsHandler, detectLanIps } = deps
  const router = Router()

  router.get('/lan-info', (_req, res) => {
    res.json({ ips: detectLanIps() })
  })

  router.get('/network/status', async (_req, res) => {
    // ... copy from server/index.ts
  })

  router.post('/network/configure', async (req, res) => {
    // ... copy from server/index.ts
  })

  router.post('/network/configure-firewall', async (_req, res) => {
    // ... copy from server/index.ts (full firewall logic)
  })

  return router
}
```

Note: Copy the **complete** firewall handler code from `server/index.ts` lines 352-447. Do not abbreviate.

**Step 2: Update tests**

In `network-api.test.ts`, replace inline network route handlers with:
```typescript
import { createNetworkRouter } from '../../../server/network-router.js'
app.use('/api', createNetworkRouter({ networkManager: mockNetworkManager, configStore: mockConfigStore, wsHandler: mockWsHandler, detectLanIps: mockDetectLanIps }))
```

**IMPORTANT**: Task 4 already converted the `/local-file` route in this file to use `createLocalFileRouter`. Preserve that mount — only replace the network-specific route handlers. The test app should have both:
```typescript
app.use('/local-file', createLocalFileRouter())  // From Task 4
app.use('/api', createNetworkRouter({ ... }))    // This task
```

In `lan-info-api.test.ts`, replace inline handler with the same router import.

**Step 3: Update server/index.ts, run tests, commit**

```bash
npm test
git add server/network-router.ts server/index.ts test/integration/server/network-api.test.ts test/integration/server/lan-info-api.test.ts
git commit -m "refactor: extract network routes to network-router.ts"
```

---

### Task 9: Extract settings-router.ts (absorbs settings-schema.ts)

High complexity — PATCH/PUT with deep merge, normalizeSettingsPatch, debug logging toggle.

**Files:**
- Create: `server/settings-router.ts`
- Modify: `server/index.ts`
- Delete: `server/settings-schema.ts` (schema moves into router)
- Modify: `test/integration/server/settings-api.test.ts`

**Step 1: Write the router**

The settings router needs:
- `GET /` — returns settings
- `PATCH /` — validates with `SettingsPatchSchema`, normalizes, patches, broadcasts
- `PUT /` — same as PATCH (alias)

Move `SettingsPatchSchema` from `settings-schema.ts` into this file and export it.
Move `normalizeSettingsPatch` into this file.

```typescript
import { Router } from 'express'
import { logger } from './logger.js'
import { migrateSettingsSortMode } from './settings-migrate.js'
import { withPerfSpan } from './perf-logger.js'

// Move the full SettingsPatchSchema here from settings-schema.ts
export { /* re-export if needed */ }

export interface SettingsRouterDeps {
  configStore: {
    getSettings: () => Promise<any>
    patchSettings: (patch: any) => Promise<any>
  }
  registry: { setSettings: (s: any) => void }
  wsHandler: { broadcast: (msg: any) => void }
  codingCliIndexer: { refresh: () => Promise<void> }
  perfConfig: { slowSessionRefreshMs: number }
  applyDebugLogging: (enabled: boolean, source: string) => void
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  // ... full implementation
}
```

**Step 2: Update settings-api.test.ts**

Replace inline route handlers with router factory import. Remove `SettingsPatchSchema` import from `settings-schema.ts`, import from `settings-router.ts` instead.

**Step 3: Update server/index.ts**

- Remove settings route handlers
- Remove `SettingsPatchSchema` import from `settings-schema.ts`
- Add import from `settings-router.ts`
- Mount: `app.use('/api/settings', createSettingsRouter(...))`

**Step 4: Delete settings-schema.ts**

Only delete after verifying no other files import from it (grep for the import).

**Step 5: Run tests, commit**

```bash
npm test
git add server/settings-router.ts server/index.ts test/integration/server/settings-api.test.ts
git rm server/settings-schema.ts
git commit -m "refactor: extract settings routes to settings-router.ts, absorb settings-schema.ts"
```

---

### Task 10: Extract perf-router.ts

Small — 1 route, POST /perf for debug logging toggle.

**Files:**
- Create: `server/perf-router.ts`
- Modify: `server/index.ts`

**Step 1: Write the router**

```typescript
import { Router } from 'express'
import { migrateSettingsSortMode } from './settings-migrate.js'

export interface PerfRouterDeps {
  configStore: { patchSettings: (patch: any) => Promise<any> }
  registry: { setSettings: (s: any) => void }
  wsHandler: { broadcast: (msg: any) => void }
  applyDebugLogging: (enabled: boolean, source: string) => void
}

export function createPerfRouter(deps: PerfRouterDeps): Router {
  const { configStore, registry, wsHandler, applyDebugLogging } = deps
  const router = Router()

  router.post('/', async (req, res) => {
    const enabled = req.body?.enabled === true
    const updated = await configStore.patchSettings({ logging: { debug: enabled } })
    const migrated = migrateSettingsSortMode(updated)
    registry.setSettings(migrated)
    applyDebugLogging(!!migrated.logging?.debug, 'api')
    wsHandler.broadcast({ type: 'settings.updated', settings: migrated })
    res.json({ ok: true, enabled })
  })

  return router
}
```

**Step 2: Write tests for perf route**

Create `test/server/perf-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createPerfRouter } from '../../server/perf-router.js'

describe('POST /api/perf', () => {
  let app: Express
  const mockConfigStore = { patchSettings: vi.fn() }
  const mockRegistry = { setSettings: vi.fn() }
  const mockWsHandler = { broadcast: vi.fn() }
  const mockApplyDebugLogging = vi.fn()

  beforeAll(() => {
    app = express()
    app.use(express.json())
    app.use('/api/perf', createPerfRouter({
      configStore: mockConfigStore,
      registry: mockRegistry,
      wsHandler: mockWsHandler,
      applyDebugLogging: mockApplyDebugLogging,
    }))
  })

  it('enables debug logging', async () => {
    mockConfigStore.patchSettings.mockResolvedValue({ logging: { debug: true } })
    const res = await request(app)
      .post('/api/perf')
      .send({ enabled: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, enabled: true })
    expect(mockApplyDebugLogging).toHaveBeenCalledWith(true, 'api')
    expect(mockWsHandler.broadcast).toHaveBeenCalled()
  })

  it('disables debug logging', async () => {
    mockConfigStore.patchSettings.mockResolvedValue({ logging: { debug: false } })
    const res = await request(app)
      .post('/api/perf')
      .send({ enabled: false })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, enabled: false })
    expect(mockApplyDebugLogging).toHaveBeenCalledWith(false, 'api')
  })
})
```

**Step 3: Update server/index.ts**

- Remove `app.post('/api/perf', ...)` handler
- Add mount: `app.use('/api/perf', createPerfRouter({ configStore, registry, wsHandler, applyDebugLogging }))`

**Step 4: Run tests, commit**

```bash
npm test
git add server/perf-router.ts test/server/perf-api.test.ts server/index.ts
git commit -m "refactor: extract perf route to perf-router.ts with tests"
```

---

### Task 11: Extract ai-router.ts

Medium — 1 route, AI summary with dynamic imports and fallback heuristic.

**Files:**
- Create: `server/ai-router.ts`
- Modify: `server/index.ts`

**Step 1: Write the router**

Copy the full AI summary handler from `server/index.ts` (lines 697-749) into a factory function.

```typescript
import { Router } from 'express'
import { logger } from './logger.js'
import { AI_CONFIG, PROMPTS, stripAnsi } from './ai-prompts.js'
import { startPerfTimer } from './perf-logger.js'

const log = logger.child({ component: 'ai-router' })

export interface AiRouterDeps {
  registry: { get: (id: string) => any }
  perfConfig: { slowAiSummaryMs: number }
}

export function createAiRouter(deps: AiRouterDeps): Router {
  const { registry, perfConfig } = deps
  const router = Router()

  router.post('/terminals/:terminalId/summary', async (req, res) => {
    // ... full handler from server/index.ts lines 698-749
  })

  return router
}
```

**Step 2: Write tests for AI summary route**

Create `test/server/ai-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createAiRouter } from '../../server/ai-router.js'

// Mock AI modules to avoid real API calls
vi.mock('ai', () => ({ generateText: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mock-model') }))

describe('POST /api/ai/terminals/:terminalId/summary', () => {
  let app: Express
  const mockBuffer = { snapshot: vi.fn().mockReturnValue('$ npm test\nAll 42 tests passed') }
  const mockRegistry = {
    get: vi.fn().mockReturnValue({ buffer: mockBuffer }),
  }

  beforeAll(() => {
    app = express()
    app.use(express.json())
    app.use('/api/ai', createAiRouter({
      registry: mockRegistry,
      perfConfig: { slowAiSummaryMs: 5000 },
    }))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockRegistry.get.mockReturnValue({ buffer: mockBuffer })
  })

  it('returns 404 for unknown terminal', async () => {
    mockRegistry.get.mockReturnValue(null)
    const res = await request(app)
      .post('/api/ai/terminals/unknown/summary')
    expect(res.status).toBe(404)
  })

  it('returns heuristic summary when AI is not configured', async () => {
    // AI_CONFIG.enabled() returns false by default in test env (no GOOGLE_GENERATIVE_AI_API_KEY)
    const res = await request(app)
      .post('/api/ai/terminals/term_1/summary')
    expect(res.status).toBe(200)
    expect(res.body.source).toBe('heuristic')
    expect(res.body.description).toBeTruthy()
  })
})
```

**Step 3: Update server/index.ts, run tests, commit**

```bash
npm test
git add server/ai-router.ts test/server/ai-api.test.ts server/index.ts
git commit -m "refactor: extract AI routes to ai-router.ts with tests"
```

---

### Task 12: Convert files-router.ts to factory + absorb candidate-dirs

The existing `filesRouter` uses singleton imports. Convert to factory pattern and absorb `GET /api/files/candidate-dirs` from `server/index.ts`.

**Files:**
- Modify: `server/files-router.ts` (convert to factory)
- Modify: `server/index.ts` (remove candidate-dirs, update mount)
- Modify: `test/integration/server/files-api.test.ts`
- Modify: `test/unit/server/files-router.test.ts`
- Modify: `test/integration/server/candidate-dirs-api.test.ts`

**Step 1: Convert files-router.ts to factory**

Change from:
```typescript
export const filesRouter = express.Router()
// ... uses configStore singleton
```

To:
```typescript
export interface FilesRouterDeps {
  configStore: Pick<ConfigStore, 'getSettings' | 'snapshot' | 'pushRecentDirectory'>
  codingCliIndexer?: { getProjects: () => any[] }
  registry?: { list: () => any[] }
}

export function createFilesRouter(deps: FilesRouterDeps): Router {
  const { configStore, codingCliIndexer, registry } = deps
  const router = Router()
  // ... move all existing route handlers, replace singleton configStore with deps.configStore
  // ... add candidate-dirs route at the end
  return router
}
```

Add the `candidate-dirs` route (from `server/index.ts` line 468-479) inside the factory.

**Step 2: Update all test files**

`files-api.test.ts`:
```typescript
import { createFilesRouter } from '../../../server/files-router.js'
app.use('/api/files', createFilesRouter({ configStore: mockConfigStore }))
```

`files-router.test.ts` — update vi.mock() pattern to use factory.

`candidate-dirs-api.test.ts`:
```typescript
import { createFilesRouter } from '../../../server/files-router.js'
app.use('/api/files', createFilesRouter({
  configStore: mockConfigStore,
  codingCliIndexer: mockIndexer,
  registry: mockRegistry,
}))
```

**Step 3: Update server/index.ts**

- Change import: `import { createFilesRouter } from './files-router.js'`
- Remove `app.get('/api/files/candidate-dirs', ...)` handler
- Change mount: `app.use('/api/files', createFilesRouter({ configStore, codingCliIndexer, registry }))`

**Step 4: Run tests, commit**

```bash
npm test
git add server/files-router.ts server/index.ts test/integration/server/files-api.test.ts test/unit/server/files-router.test.ts test/integration/server/candidate-dirs-api.test.ts
git commit -m "refactor: convert files-router to factory, absorb candidate-dirs"
```

---

### Task 13: Extract debug-router.ts

The debug endpoint has many deps. Keep health inline in index.ts (pre-auth).

**Files:**
- Create: `server/debug-router.ts`
- Modify: `server/index.ts`
- Modify: `test/server/api.test.ts`

**Step 1: Write the router**

```typescript
import { Router } from 'express'

export interface DebugRouterDeps {
  appVersion: string
  configStore: { snapshot: () => Promise<any> }
  wsHandler: { connectionCount: () => number }
  codingCliIndexer: { getProjects: () => any[] }
  tabsRegistryStore: { count: () => number; listDevices: () => any[] }
  registry: { list: () => any[] }
}

export function createDebugRouter(deps: DebugRouterDeps): Router {
  const { appVersion, configStore, wsHandler, codingCliIndexer, tabsRegistryStore, registry } = deps
  const router = Router()

  router.get('/debug', async (_req, res) => {
    const cfg = await configStore.snapshot()
    res.json({
      version: 1,
      appVersion,
      wsConnections: wsHandler.connectionCount(),
      settings: cfg.settings,
      sessionsProjects: codingCliIndexer.getProjects(),
      tabsRegistry: {
        recordCount: tabsRegistryStore.count(),
        deviceCount: tabsRegistryStore.listDevices().length,
      },
      terminals: registry.list(),
      time: new Date().toISOString(),
    })
  })

  return router
}
```

**Step 2: Update api.test.ts**

Replace inline debug route with:
```typescript
import { createDebugRouter } from '../../server/debug-router.js'
app.use('/api', createDebugRouter({ ... }))
```

Keep the health endpoint test as-is (health stays inline in index.ts — tests can define it inline since it's 1 line).

**Step 3: Update server/index.ts, run tests, commit**

```bash
npm test
git add server/debug-router.ts server/index.ts test/server/api.test.ts
git commit -m "refactor: extract debug route to debug-router.ts"
```

---

### Task 14: Migrate api-edge-cases.test.ts

This is the largest test file (1322 lines) and duplicates routes from multiple groups. After all routers are extracted, convert it to import real routers.

**Files:**
- Modify: `test/integration/server/api-edge-cases.test.ts`

**Step 1: Replace all inline route handlers**

The test currently duplicates:
- Session PATCH/DELETE → `createSessionsRouter`
- Terminal PATCH → `createTerminalsRouter`
- Project-colors PUT → `createProjectColorsRouter`
- Settings GET/PATCH/PUT → `createSettingsRouter`

Replace the `createTestApp()` function to mount real routers with mock deps instead of duplicated handlers.

**Step 2: Remove all duplicated schemas and helpers**

Remove inline `TerminalPatchSchema`, `ProjectColorSchema`, `cleanString`, `normalizeSettingsPatch` — these are now in the router modules.

**Step 3: Verify all edge-case tests still pass**

Run: `npx vitest run test/integration/server/api-edge-cases.test.ts`
Expected: All tests pass

**Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add test/integration/server/api-edge-cases.test.ts
git commit -m "refactor: migrate api-edge-cases.test.ts to use real routers"
```

---

### Task 15: Migrate pane-picker-cli.test.ts

This test has its own terminal creation logic that may or may not map cleanly to the extracted routers (it tests WebSocket-based terminal creation, not REST). Assess and migrate as appropriate.

**Files:**
- Modify: `test/integration/server/pane-picker-cli.test.ts`

**Step 1: Read and assess**

Read the test file. Determine which route handlers it duplicates vs which are WebSocket-specific.

**Step 2: Replace REST route duplicates with router imports**

If it duplicates any REST endpoints that are now in routers, replace them.

**Step 3: Run tests, commit**

```bash
npm test
git add test/integration/server/pane-picker-cli.test.ts
git commit -m "refactor: migrate pane-picker-cli.test.ts to use real routers where applicable"
```

---

### Task 16: Final verification and cleanup

**Files:**
- Modify: `server/index.ts` (verify it's orchestration-only)

**Step 1: Verify no inline schemas remain in server/index.ts**

Search for `z.object` in server/index.ts — should find zero results.

**Step 2: Verify no duplicated route handlers in test files**

Search test files for inline `app.get`, `app.post`, `app.patch`, `app.put`, `app.delete` definitions that duplicate production routes. The only acceptable inline routes are the health check (1 line, stays in index.ts) and any WebSocket-only test setups.

**Step 3: Verify cleanString has a single definition**

Search for `cleanString` across the codebase — should only appear in `server/utils.ts` (definition) and imports.

**Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 5: Run typecheck**

Run: `npm run check`
Expected: No type errors

**Step 6: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "refactor: final cleanup — verify zero test-replica duplication"
```

---

## Execution Notes

- **Order matters**: Tasks 1-13 should be done sequentially (each builds on the previous)
- **Task 14-15** can be done after all routers are extracted
- **Test after every task**: Run `npm test` before committing
- **Type interfaces**: Use `Pick<>` and structural types for deps to avoid importing heavy classes in tests
- **ESM imports**: All relative imports must include `.js` extension per project rules
- **Don't break main**: All work happens in the worktree branch
