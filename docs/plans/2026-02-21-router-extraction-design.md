# Router Extraction Design

## Problem

`server/index.ts` contains all route handlers inline. 11+ test files duplicate these route handlers
(including schemas and helpers) to create isolated test Express apps. This means every production
change must be mirrored in test replicas — a maintenance burden and divergence risk.

Three specific symptoms (from PR #85 review):
1. **Test-replica duplication**: Tests copy-paste route handlers instead of importing real ones
2. **Inconsistent helper placement**: `cleanString` is inside `main()` in production but redefined
   inside test route handlers
3. **Scattered schemas**: Zod schemas defined inline next to routes, not organized

## Solution

Extract all route groups from `server/index.ts` into separate router modules using factory functions.
Tests import and mount real routers with mock dependencies — no more replicas.

## Pattern: Router Factory Functions

Each router module exports a factory function that receives dependencies and returns an Express Router:

```typescript
// server/terminals-router.ts
import { Router } from 'express'
import { z } from 'zod'
import { cleanString } from './utils.js'
import type { ConfigStore } from './config-store.js'
import type { TerminalRegistry } from './terminal-registry.js'
import type { WsHandler } from './ws-handler.js'

export const TerminalPatchSchema = z.object({
  titleOverride: z.string().max(500).optional().nullable(),
  descriptionOverride: z.string().max(2000).optional().nullable(),
  deleted: z.boolean().optional(),
})

export interface TerminalsRouterDeps {
  configStore: ConfigStore
  registry: TerminalRegistry
  wsHandler: WsHandler
}

export function createTerminalsRouter(deps: TerminalsRouterDeps): Router {
  const { configStore, registry, wsHandler } = deps
  const router = Router()
  // ... real route handlers ...
  return router
}
```

**In production** (`server/index.ts`): `app.use('/api/terminals', createTerminalsRouter({ configStore, registry, wsHandler }))`

**In tests**:
```typescript
const app = express()
app.use(express.json())
app.use('/api/terminals', createTerminalsRouter({
  configStore: mockConfigStore,
  registry: mockRegistry,
  wsHandler: mockWsHandler,
}))
```

## Router Groups

| Router module | Mount path | Routes | Key dependencies |
|---|---|---|---|
| `local-file-router.ts` | `/local-file` | GET /local-file | cookieParser, timingSafeCompare, fs, path |
| `settings-router.ts` | `/api/settings` | GET /, PATCH /, PUT / | configStore, registry, wsHandler, codingCliIndexer, perfConfig |
| `perf-router.ts` | `/api/perf` | POST / | configStore, registry, wsHandler, perfConfig, logger |
| `network-router.ts` | `/api` | GET /network/status, POST /network/configure, POST /network/configure-firewall, GET /lan-info | networkManager, configStore, wsHandler, detectLanIps |
| `sessions-router.ts` | `/api` | GET /sessions, GET /sessions/search, PATCH /sessions/:id, DELETE /sessions/:id | configStore, codingCliIndexer, perfConfig |
| `project-colors-router.ts` | `/api` | PUT /project-colors | configStore, codingCliIndexer |
| `terminals-router.ts` | `/api/terminals` | GET /, PATCH /:id, DELETE /:id | configStore, registry, wsHandler |
| `ai-router.ts` | `/api/ai` | POST /terminals/:id/summary | registry, perfConfig, AI_CONFIG, PROMPTS |
| `files-router.ts` | `/api/files` | (existing, convert to factory) + candidate-dirs | configStore, codingCliIndexer, registry |
| `proxy-router.ts` | `/api/proxy` | POST /forward, DELETE /forward/:port | portForwardManager |
| `platform-router.ts` | `/api` | GET /platform, GET /version | detectPlatform, detectAvailableClis, detectHostName, checkForUpdate |

### Candidate-dirs note

`GET /api/files/candidate-dirs` is currently in `server/index.ts` (not `files-router.ts`).
It moves into the files router during the factory conversion, since it's semantically a
files-related endpoint. This adds `codingCliIndexer` and `registry` to the files router deps.

## Middleware Ordering and Health Endpoint

The current middleware/route ordering in `server/index.ts` is:

1. `app.get('/local-file', ...)` — cookie-based auth, before rate limiting
2. `app.get('/api/health', ...)` — registered **before** auth middleware
3. `app.use('/api', rateLimit(...))` — rate limiting
4. `app.use('/api', httpAuthMiddleware)` — auth (has exemption for `/api/health` but it's redundant)
5. All other `/api` routes

This ordering is critical. The health endpoint must remain **before** the auth middleware.
After extraction:

1. `app.use('/local-file', createLocalFileRouter(...))` — before `/api` middleware
2. `app.get('/api/health', ...)` — stays inline in index.ts OR health-router is mounted before auth
3. `app.use('/api', rateLimit(...))`
4. `app.use('/api', httpAuthMiddleware)`
5. All authenticated router mounts

**Decision**: The health endpoint (`GET /api/health`) stays inline in `server/index.ts` since it's a
single line and must be positioned before auth middleware. The debug endpoint (`GET /api/debug`) moves
into a dedicated router mounted after auth. This avoids the complexity of splitting a single router
across middleware boundaries.

## Dependency Initialization Order

All dependencies (configStore, registry, wsHandler, codingCliIndexer, etc.) are created inside
`main()` **before** any routers are mounted. The factory pattern makes this natural:

```typescript
async function main() {
  // 1. Create all dependencies
  const registry = new TerminalRegistry(...)
  const server = http.createServer(app)
  const wsHandler = new WsHandler(server, registry, ...)
  const codingCliIndexer = new CodingCliSessionIndexer(...)
  // ... etc

  // 2. Mount pre-auth routes
  app.use('/local-file', createLocalFileRouter(...))
  app.get('/api/health', ...)

  // 3. Apply auth middleware
  app.use('/api', rateLimit(...))
  app.use('/api', httpAuthMiddleware)

  // 4. Mount authenticated routers (order doesn't matter, deps already exist)
  app.use('/api/settings', createSettingsRouter({ configStore, registry, wsHandler, ... }))
  app.use('/api/terminals', createTerminalsRouter({ configStore, registry, wsHandler }))
  // ... etc
}
```

Since all dependencies are created in step 1 and routers mounted in step 4, there is no
initialization-order issue.

## Utility & Schema Organization

- **`server/utils.ts`**: Shared helpers like `cleanString`
- **Schemas co-locate with routers**: Each router exports its own schemas (e.g., `TerminalPatchSchema`
  from `terminals-router.ts`). Tests and other consumers import from the router module.
- **`settings-schema.ts` is removed**: `SettingsPatchSchema` moves into `settings-router.ts`

## server/index.ts After Extraction

Becomes orchestration + the health endpoint:
1. Bootstrap dependencies (configStore, registry, wsHandler, etc.)
2. Create Express app with global middleware (JSON parsing, request logging)
3. Mount `/local-file` router (pre-auth)
4. Register `GET /api/health` inline (pre-auth, single line)
5. Apply rate limiting and auth middleware to `/api`
6. Mount all authenticated routers
7. Set up WebSocket handler
8. Set up lifecycle hooks (codingCliIndexer.onUpdate, etc.)
9. Start listening

The only route handler logic remaining in index.ts is the health check (1 line).

## Test Migration

All test files that currently duplicate route handlers get converted:

| Test file | Currently duplicates | After: imports |
|---|---|---|
| `test/server/terminals-api.test.ts` | Terminal PATCH/DELETE/GET | `createTerminalsRouter` |
| `test/server/api.test.ts` | Health/debug | `createDebugRouter` (health stays inline) |
| `test/integration/server/api-edge-cases.test.ts` | Multiple route groups | Multiple router factories |
| `test/integration/server/network-api.test.ts` | Network routes | `createNetworkRouter` |
| `test/integration/server/settings-api.test.ts` | Settings routes | `createSettingsRouter` |
| `test/integration/server/session-search-api.test.ts` | Session search | `createSessionsRouter` |
| `test/integration/server/lan-info-api.test.ts` | LAN info | `createNetworkRouter` |
| `test/integration/server/platform-api.test.ts` | Platform | `createPlatformRouter` |
| `test/integration/server/candidate-dirs-api.test.ts` | Candidate dirs | `createFilesRouter` |
| `test/integration/server/port-forward-api.test.ts` | Proxy routes | `createProxyRouter` |
| `test/integration/server/pane-picker-cli.test.ts` | Pane picker | (assess during impl) |
| `test/integration/server/files-api.test.ts` | Files routes | `createFilesRouter` |
| `test/unit/server/files-router.test.ts` | Files routes (vi.mock) | `createFilesRouter` |

## Migration Strategy

1. Create `server/utils.ts` with `cleanString` (smallest, no deps, unblocks everything)
2. Extract routers one at a time, simplest first: platform, proxy, local-file
3. For each router: create module → update index.ts to use it → migrate all related tests → run tests
4. Convert existing `filesRouter` to factory pattern, absorb candidate-dirs
5. Work through remaining routers: terminals, sessions, project-colors, network, settings, perf, ai, debug
6. Final cleanup: remove `settings-schema.ts`, verify no inline schemas remain in index.ts

## Success Criteria

- Zero duplicated route handlers in test files
- All schemas exported from their router modules
- `cleanString` in a single shared `server/utils.ts`
- `server/index.ts` contains only orchestration + health check
- All existing tests pass (with updated imports, not duplicated logic)
- No middleware ordering regressions (health unauthenticated, local-file cookie-auth, everything else token-auth)
