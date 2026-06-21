# FreshOpencode Enabled Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static Freshopencode model radio list with a compact settings section that exposes only enabled OpenCode models, supports one-click MRU selection after opening settings, and opens a grouped realtime search modal when the search field is focused.

**Architecture:** Extend the existing fresh-agent model-capability route family with cwd-aware Freshopencode catalog requests. The server fetches OpenCode's enabled, project-scoped provider catalog through an isolated short-lived catalog sidecar, returns only a sanitized allowlisted model shape keyed by stable `providerID/modelID` ids, and never routes catalog failures through live session sidecars. The client renders same-cwd cached MRU metadata immediately, refreshes the enabled catalog when settings opens, and searches/filter-renders client-side without backend calls per keystroke.

**Tech Stack:** React 18, Redux Toolkit, Tailwind CSS, Testing Library, Playwright, Express, Zod, Vitest, existing `opencode serve` sidecar.

## Global Constraints

- Freshopencode settings must expose enabled OpenCode models only.
- The settings gear is the first click; an MRU model tile must be selectable with the second click.
- Focusing or clicking the search field in the settings popover must open the full model modal.
- The model section must be last in the Freshopencode settings popover.
- There is no separate current-model section; the top-left MRU tile is the current model.
- Show 4 MRU tiles when there is room, or 3 when the settings popover is single-column/narrow.
- Collapse the full model list unless and until search opens the modal.
- The modal must group enabled models by OpenCode source, sort sources alphabetically, and sort models alphabetically within each source.
- Do not include a refresh button or Command-K shortcut visual.
- Do not call OpenCode while the user types; search filters the already-fetched catalog in memory.
- Store model selections as stable `providerID/modelID` strings.
- Server responses must not expose raw OpenCode provider/config payloads or credential-shaped fields.
- Freshopencode model capabilities must be scoped to the pane cwd because OpenCode project config can change enabled providers/models.
- Catalog discovery must not use `OpencodeServeManager`'s live session request path; a catalog timeout must not discard active Freshopencode sessions.
- MRU tiles may render before the live refresh only from a same-cwd cached enabled catalog entry that is still inside the local freshness window.

---

## File Structure

- Modify `shared/fresh-agent-model-capabilities.ts`: add optional source metadata to model capabilities while preserving the existing response contract.
- Modify `shared/fresh-agent-models.ts`: keep arbitrary provider-qualified Freshopencode model ids instead of normalizing them back to the static default.
- Modify `src/lib/api.ts`: allow model-capability requests to pass a cwd query for Freshopencode.
- Modify `src/lib/fresh-agent-model-capabilities.ts`: add grouping, filtering, row-capping, and current-selection helpers for large model catalogs.
- Create `src/lib/freshopencode-model-mru.ts`: read/write same-cwd local MRU entries with display metadata and verification timestamps.
- Create `server/fresh-agent/adapters/opencode/model-catalog.ts`: run an isolated short-lived `opencode serve` catalog probe, fetch `/config/providers`, stop only its own PID, and sanitize enabled models.
- Modify `server/fresh-agent/model-capability-registry.ts`: add cwd-aware OpenCode catalog probing/caching independent from Claude and from live session sidecars.
- Modify `server/fresh-agent/model-capabilities-router.ts`: parse and forward optional `cwd` query values for Freshopencode requests.
- Modify `src/components/fresh-agent/FreshAgentView.tsx`: resolve Freshopencode runtime model from `paneContent.model`, `paneContent.modelSelection`, or provider defaults before create/send.
- Create `src/components/fresh-agent/FreshOpencodeModelSettings.tsx`: render the Freshopencode model section, MRU tiles, search entry, and modal.
- Modify `src/components/fresh-agent/FreshAgentSettingsButton.tsx`: render Style/Thinking first and the new Freshopencode model section last for Freshopencode panes; leave non-OpenCode model controls on the existing static path.
- Modify tests:
  - `test/unit/shared/fresh-agent-models.test.ts`
  - `test/unit/client/lib/api.test.ts`
  - `test/unit/client/lib/fresh-agent-model-capabilities.test.ts`
  - `test/unit/client/lib/freshopencode-model-mru.test.ts`
  - `test/unit/server/fresh-agent/opencode-model-catalog.test.ts`
  - `test/unit/server/fresh-agent/model-capability-registry.test.ts`
  - `test/integration/server/fresh-agent-model-capabilities-router.test.ts`
  - `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
  - `test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx`
  - `test/e2e-browser/specs/freshopencode-model-picker.spec.ts`

## Task 1: Shared Catalog Contract And Client Helpers

**Files:**
- Modify: `shared/fresh-agent-model-capabilities.ts`
- Modify: `shared/fresh-agent-models.ts`
- Modify: `src/lib/fresh-agent-model-capabilities.ts`
- Test: `test/unit/shared/fresh-agent-models.test.ts`
- Test: `test/unit/client/lib/fresh-agent-model-capabilities.test.ts`

**Interfaces:**
- Produces: `FreshAgentModelCapability.source?: { id: string; displayName: string }`
- Produces: `groupFreshAgentModelCapabilitiesBySource(capabilities): FreshAgentModelSourceGroup[]`
- Produces: `filterFreshAgentModelCapabilitiesByQuery(groups, query): FreshAgentModelSourceGroup[]`
- Produces: `capFreshAgentModelSourceRows(groups, maxRows): { groups: FreshAgentModelSourceGroup[]; hiddenCount: number }`
- Produces: `resolveFreshOpencodeCapabilityById(capabilities, modelId): FreshAgentModelCapability | undefined`
- Consumes: existing `FreshAgentModelCapabilitiesResponseSchema`, `normalizeFreshAgentModel`, and `normalizeFreshAgentEffort`

- [ ] **Step 1: Write failing shared normalizer tests**

Add these cases to `test/unit/shared/fresh-agent-models.test.ts`:

```ts
it('preserves provider-qualified Freshopencode model ids from the live catalog', () => {
  expect(normalizeFreshAgentModel('freshopencode', 'opencode', 'deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro')
  expect(normalizeFreshAgentModel('freshopencode', 'opencode', 'opencode-go/glm-5.2')).toBe('opencode-go/glm-5.2')
})

it('falls back to the Freshopencode default only for missing or blank model ids', () => {
  expect(normalizeFreshAgentModel('freshopencode', 'opencode', undefined)).toBe(FRESHOPENCODE_DEFAULT_MODEL)
  expect(normalizeFreshAgentModel('freshopencode', 'opencode', '   ')).toBe(FRESHOPENCODE_DEFAULT_MODEL)
})

it('preserves Freshopencode effort for live-catalog models not present in the static fallback list', () => {
  expect(normalizeFreshAgentEffort('freshopencode', 'opencode', 'deepseek/deepseek-v4-pro', 'high')).toBe('high')
  expect(normalizeFreshAgentEffort('freshopencode', 'opencode', 'deepseek/deepseek-v4-pro', undefined)).toBe(FRESHOPENCODE_DEFAULT_EFFORT)
})
```

Expected result:

```bash
npm run test:vitest -- --run test/unit/shared/fresh-agent-models.test.ts
```

The new tests fail because Freshopencode currently accepts only static model options.

- [ ] **Step 2: Write failing client catalog helper tests**

Add these cases to `test/unit/client/lib/fresh-agent-model-capabilities.test.ts`:

```ts
const opencodeCapabilities = {
  sessionType: 'freshopencode',
  runtimeProvider: 'opencode',
  status: 'fresh',
  fetchedAt: 1_234,
  models: [
    {
      id: 'opencode-go/glm-5.2',
      displayName: 'GLM 5.2',
      provider: 'opencode',
      source: { id: 'opencode-go', displayName: 'opencode-go' },
      supportsEffort: true,
      supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'deepseek/deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      provider: 'opencode',
      source: { id: 'deepseek', displayName: 'deepseek' },
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'opencode-go/deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      provider: 'opencode',
      source: { id: 'opencode-go', displayName: 'opencode-go' },
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    },
  ],
} as const

it('groups OpenCode capabilities by source and sorts sources and models alphabetically', () => {
  expect(groupFreshAgentModelCapabilitiesBySource(opencodeCapabilities)).toEqual([
    {
      source: { id: 'deepseek', displayName: 'deepseek' },
      models: [expect.objectContaining({ id: 'deepseek/deepseek-v4-flash' })],
    },
    {
      source: { id: 'opencode-go', displayName: 'opencode-go' },
      models: [
        expect.objectContaining({ id: 'opencode-go/deepseek-v4-pro' }),
        expect.objectContaining({ id: 'opencode-go/glm-5.2' }),
      ],
    },
  ])
})

it('filters grouped OpenCode capabilities by source, display name, and model id', () => {
  const grouped = groupFreshAgentModelCapabilitiesBySource(opencodeCapabilities)

  expect(filterFreshAgentModelCapabilitiesByQuery(grouped, 'glm').flatMap((group) => group.models.map((model) => model.id))).toEqual([
    'opencode-go/glm-5.2',
  ])
  expect(filterFreshAgentModelCapabilitiesByQuery(grouped, 'deepseek').map((group) => group.source.id)).toEqual([
    'deepseek',
    'opencode-go',
  ])
})

it('resolves an OpenCode capability by stable provider-qualified id', () => {
  expect(resolveFreshOpencodeCapabilityById(opencodeCapabilities, 'opencode-go/glm-5.2')).toEqual(
    expect.objectContaining({ displayName: 'GLM 5.2' }),
  )
  expect(resolveFreshOpencodeCapabilityById(opencodeCapabilities, 'glm-5.2')).toBeUndefined()
})

it('caps rendered model rows while preserving source grouping order', () => {
  const grouped = groupFreshAgentModelCapabilitiesBySource({
    ...opencodeCapabilities,
    models: Array.from({ length: 300 }, (_, index) => ({
      id: `opencode-go/model-${String(index).padStart(3, '0')}`,
      displayName: `Model ${String(index).padStart(3, '0')}`,
      provider: 'opencode' as const,
      source: { id: 'opencode-go', displayName: 'opencode-go' },
      supportsEffort: true,
      supportedEffortLevels: ['high'],
      supportsAdaptiveThinking: true,
    })),
  })

  const capped = capFreshAgentModelSourceRows(grouped, 250)

  expect(capped.groups.flatMap((group) => group.models)).toHaveLength(250)
  expect(capped.hiddenCount).toBe(50)
})
```

Expected result:

```bash
npm run test:vitest -- --run test/unit/client/lib/fresh-agent-model-capabilities.test.ts
```

The new tests fail because source metadata and helper functions do not exist.

- [ ] **Step 3: Implement the shared contract and helpers**

In `shared/fresh-agent-model-capabilities.ts`, add this schema before `FreshAgentModelCapabilitySchema`:

```ts
export const FreshAgentModelCapabilitySourceSchema = z.object({
  id: FreshAgentModelCapabilitiesOpaqueStringSchema,
  displayName: FreshAgentModelCapabilitiesOpaqueStringSchema,
}).strict()
```

Add this optional field to `FreshAgentModelCapabilitySchema`:

```ts
source: FreshAgentModelCapabilitySourceSchema.optional(),
```

Add this type export:

```ts
export type FreshAgentModelCapabilitySource = z.infer<typeof FreshAgentModelCapabilitySourceSchema>
```

In `shared/fresh-agent-models.ts`, change OpenCode normalization to:

```ts
if (provider === 'opencode') {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  return trimmed.length > 0 ? trimmed : defaultModelForSession(sessionType)?.value
}
```

In `normalizeFreshAgentEffort`, after resolving `options`, add the OpenCode live-catalog fallback:

```ts
if (provider === 'opencode' && options.length === 0) {
  const normalized = typeof effort === 'string' ? effort.trim() : ''
  return normalized.length > 0 ? normalized : FRESHOPENCODE_DEFAULT_EFFORT
}
```

In `src/lib/fresh-agent-model-capabilities.ts`, add these exports:

```ts
export type FreshAgentModelSourceGroup = {
  source: { id: string; displayName: string }
  models: FreshAgentModelCapability[]
}

function compareModelCapability(a: FreshAgentModelCapability, b: FreshAgentModelCapability): number {
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    || a.id.localeCompare(b.id, undefined, { sensitivity: 'base' })
}

function sourceForCapability(model: FreshAgentModelCapability): { id: string; displayName: string } {
  if (model.source) return model.source
  const sourceId = model.id.includes('/') ? model.id.split('/')[0] : model.provider
  return { id: sourceId, displayName: sourceId }
}

export function groupFreshAgentModelCapabilitiesBySource(
  capabilities: FreshAgentModelCapabilities | undefined,
): FreshAgentModelSourceGroup[] {
  const bySource = new Map<string, FreshAgentModelSourceGroup>()
  for (const model of capabilities?.models ?? []) {
    const source = sourceForCapability(model)
    const key = source.id
    const group = bySource.get(key) ?? { source, models: [] }
    group.models.push(model)
    bySource.set(key, group)
  }
  return [...bySource.values()]
    .map((group) => ({ ...group, models: [...group.models].sort(compareModelCapability) }))
    .sort((a, b) => (
      a.source.displayName.localeCompare(b.source.displayName, undefined, { sensitivity: 'base' })
      || a.source.id.localeCompare(b.source.id, undefined, { sensitivity: 'base' })
    ))
}

export function filterFreshAgentModelCapabilitiesByQuery(
  groups: FreshAgentModelSourceGroup[],
  query: string,
): FreshAgentModelSourceGroup[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return groups
  return groups
    .map((group) => ({
      source: group.source,
      models: group.models.filter((model) => {
        const haystack = [
          model.id,
          model.displayName,
          model.description ?? '',
          group.source.id,
          group.source.displayName,
        ].join(' ').toLocaleLowerCase()
        return tokens.every((token) => haystack.includes(token))
      }),
    }))
    .filter((group) => group.models.length > 0)
}

export function resolveFreshOpencodeCapabilityById(
  capabilities: FreshAgentModelCapabilities | undefined,
  modelId: string | undefined,
): FreshAgentModelCapability | undefined {
  if (!modelId) return undefined
  return capabilities?.models.find((model) => model.id === modelId)
}

export function capFreshAgentModelSourceRows(
  groups: FreshAgentModelSourceGroup[],
  maxRows: number,
): { groups: FreshAgentModelSourceGroup[]; hiddenCount: number } {
  const cappedGroups: FreshAgentModelSourceGroup[] = []
  let remaining = Math.max(0, maxRows)
  let hiddenCount = 0
  for (const group of groups) {
    if (remaining <= 0) {
      hiddenCount += group.models.length
      continue
    }
    const models = group.models.slice(0, remaining)
    hiddenCount += group.models.length - models.length
    remaining -= models.length
    if (models.length > 0) cappedGroups.push({ source: group.source, models })
  }
  return { groups: cappedGroups, hiddenCount }
}
```

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
npm run test:vitest -- --run test/unit/shared/fresh-agent-models.test.ts test/unit/client/lib/fresh-agent-model-capabilities.test.ts
```

Expected: PASS.

Commit:

```bash
git add shared/fresh-agent-model-capabilities.ts shared/fresh-agent-models.ts src/lib/fresh-agent-model-capabilities.ts test/unit/shared/fresh-agent-models.test.ts test/unit/client/lib/fresh-agent-model-capabilities.test.ts
git commit -m "feat: add freshopencode model catalog helpers"
```

## Task 2: Cwd-Aware OpenCode Enabled Catalog On The Server

**Files:**
- Create: `server/fresh-agent/adapters/opencode/model-catalog.ts`
- Modify: `server/fresh-agent/model-capability-registry.ts`
- Modify: `server/fresh-agent/model-capabilities-router.ts`
- Modify: `src/lib/api.ts`
- Test: `test/unit/server/fresh-agent/opencode-model-catalog.test.ts`
- Test: `test/unit/server/fresh-agent/model-capability-registry.test.ts`
- Test: `test/integration/server/fresh-agent-model-capabilities-router.test.ts`
- Test: `test/unit/client/lib/api.test.ts`

**Interfaces:**
- Produces: `OpencodeModelCatalogProvider.getCatalog({ cwd?: string; signal?: AbortSignal }): Promise<unknown>`
- Produces: Freshopencode model capabilities where `id` is `${providerID}/${modelID}` and `source.id` is `providerID`
- Produces: cwd-aware OpenCode cache keys independent from Claude and independent from live session sidecars
- Consumes: OpenCode `GET /config/providers`, not full `GET /provider`, because `/provider` can include thousands of possible models and raw config-bearing fields

- [ ] **Step 1: Write failing isolated catalog-provider tests**

Create `test/unit/server/fresh-agent/opencode-model-catalog.test.ts`:

```ts
// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  createOpencodeModelCatalogProvider,
  normalizeOpencodeEnabledModelCatalog,
} from '../../../../server/fresh-agent/adapters/opencode/model-catalog.js'

function fakeChild() {
  const child = new EventEmitter() as any
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 5555
  child.kill = vi.fn(() => { child.killed = true; queueMicrotask(() => child.emit('close', 0)); return true })
  return child
}

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any
}

describe('OpenCode model catalog provider', () => {
  it('starts an isolated short-lived serve process, fetches cwd-scoped /config/providers, and stops only that child', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/config/providers')) {
        return jsonResponse({
          providers: {
            'opencode-go': {
              id: 'opencode-go',
              name: 'opencode-go',
              models: {
                'glm-5.2': { id: 'glm-5.2', name: 'GLM 5.2' },
              },
            },
          },
          default: { 'opencode-go': 'glm-5.2' },
        })
      }
      return jsonResponse({}, { status: 404 })
    })
    const provider = createOpencodeModelCatalogProvider({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: async () => ({ hostname: '127.0.0.1', port: 48123 }),
      healthTimeoutMs: 100,
      requestTimeoutMs: 100,
    })

    await expect(provider.getCatalog({ cwd: '/repo/project-a' })).resolves.toMatchObject({
      providers: expect.objectContaining({ 'opencode-go': expect.any(Object) }),
    })
    expect(spawnFn).toHaveBeenCalledWith(
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '48123'],
      expect.objectContaining({ cwd: '/repo/project-a' }),
    )
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:48123/config/providers', expect.anything())
    expect(child.kill).toHaveBeenCalled()
  })

  it('sanitizes enabled provider models and does not copy credential-shaped fields or descriptions', () => {
    const models = normalizeOpencodeEnabledModelCatalog({
      providers: {
        deepseek: {
          id: 'deepseek',
          name: 'deepseek',
          apiKey: 'must-not-leak',
          models: {
            'deepseek-v4-pro': {
              id: 'deepseek-v4-pro',
              name: 'DeepSeek V4 Pro',
              description: 'must-not-leak-description',
              options: { apiKey: 'must-not-leak' },
              headers: { authorization: 'must-not-leak' },
            },
          },
        },
        'bad/source': {
          id: 'bad/source',
          models: { one: { id: 'one' } },
        },
      },
    })

    expect(models).toEqual([
      {
        id: 'deepseek/deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        provider: 'opencode',
        source: { id: 'deepseek', displayName: 'deepseek' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
    ])
    expect(JSON.stringify(models)).not.toMatch(/must-not-leak|authorization|apiKey|description/)
  })
})
```

Expected result:

```bash
npm run test:vitest -- --run test/unit/server/fresh-agent/opencode-model-catalog.test.ts
```

The tests fail because the catalog module does not exist.

- [ ] **Step 2: Implement the isolated catalog provider**

Create `server/fresh-agent/adapters/opencode/model-catalog.ts` with:

- A factory `createOpencodeModelCatalogProvider(options = {})`.
- Dependencies matching `OpencodeServeManager` where useful: `command`, `spawnFn`, `fetchFn`, `allocatePort`, `env`, `healthTimeoutMs`, and `requestTimeoutMs`.
- `getCatalog({ cwd, signal })` that:
  - Allocates a loopback port.
  - Spawns `opencode serve --hostname <host> --port <port>` with `cwd` only when provided.
  - Polls `/global/health`.
  - Fetches `/config/providers`.
  - Kills only the child it spawned in `finally`.
  - Does not open `/event`.
  - Does not touch `OpencodeServeManager`, `runningByCwd`, session emitters, or live session routing.

Add this sanitizer in the same module:

```ts
export function normalizeOpencodeEnabledModelCatalog(raw: unknown): FreshAgentModelCapability[] {
  const providers = readProviderMap(raw)
  const models: FreshAgentModelCapability[] = []
  for (const [providerKey, rawProvider] of providers) {
    const provider = readRecord(rawProvider)
    const providerId = readNonEmptyString(provider?.id) ?? providerKey
    if (!providerId || providerId.includes('/')) continue
    const providerDisplayName = cleanDisplayName(readNonEmptyString(provider?.name) ?? providerId)
    for (const [modelKey, rawModel] of readModelEntries(provider)) {
      const model = readRecord(rawModel)
      const modelId = readNonEmptyString(model?.id) ?? modelKey
      if (!modelId) continue
      const displayName = cleanDisplayName(
        readNonEmptyString(model?.name)
          ?? readNonEmptyString(model?.displayName)
          ?? readNonEmptyString(model?.display_name)
          ?? modelId,
      )
      models.push(FreshAgentModelCapabilitySchema.parse({
        id: `${providerId}/${modelId}`,
        displayName,
        provider: 'opencode',
        source: { id: providerId, displayName: providerDisplayName },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      }))
    }
  }
  return models.sort(compareBySourceThenNameThenId)
}
```

Do not copy OpenCode `description`, `options`, `env`, `headers`, `apiKey`, `token`, `secret`, raw provider objects, or raw model objects. Limit display labels to a reasonable maximum length, strip control characters, and fall back to ids when labels are blank.

- [ ] **Step 3: Write failing cwd-aware registry and router tests**

Add these cases to `test/unit/server/fresh-agent/model-capability-registry.test.ts`:

```ts
it('caches OpenCode capabilities by cwd without probing Claude or live session sidecars', async () => {
  const getCatalog = vi.fn(async ({ cwd }: { cwd?: string }) => ({
    providers: {
      [cwd === '/repo/a' ? 'opencode-go' : 'google']: {
        id: cwd === '/repo/a' ? 'opencode-go' : 'google',
        models: {
          [cwd === '/repo/a' ? 'glm-5.2' : 'gemini-3-pro']: {
            id: cwd === '/repo/a' ? 'glm-5.2' : 'gemini-3-pro',
          },
        },
      },
    },
  }))
  const registry = new FreshAgentModelCapabilityRegistry({
    queryFactory,
    now: () => now,
    ttlMs: 5_000,
    opencodeCatalogProvider: { getCatalog },
  })

  await expect(registry.getCapabilities('freshopencode', { cwd: '/repo/a' })).resolves.toMatchObject({
    ok: true,
    models: [expect.objectContaining({ id: 'opencode-go/glm-5.2' })],
  })
  await expect(registry.getCapabilities('freshopencode', { cwd: '/repo/b' })).resolves.toMatchObject({
    ok: true,
    models: [expect.objectContaining({ id: 'google/gemini-3-pro' })],
  })
  await registry.getCapabilities('freshopencode', { cwd: '/repo/a' })

  expect(getCatalog).toHaveBeenCalledTimes(2)
  expect(queryFactory).not.toHaveBeenCalled()
})
```

Add this case to `test/integration/server/fresh-agent-model-capabilities-router.test.ts`:

```ts
it('forwards cwd for Freshopencode capabilities', async () => {
  const response = successResponse('freshopencode', 'opencode')
  const registry = {
    getCapabilities: vi.fn(async () => response),
    refreshCapabilities: vi.fn(async () => response),
  }
  const app = createAppWithRegistry(registry)

  await request(app)
    .get('/api/fresh-agent/model-capabilities/freshopencode')
    .query({ cwd: '/repo/project-a' })
    .expect(200)

  expect(registry.getCapabilities).toHaveBeenCalledWith('freshopencode', { cwd: '/repo/project-a' })
})
```

Add this case to `test/unit/client/lib/api.test.ts`:

```ts
it('passes cwd when fetching Freshopencode model capabilities', async () => {
  mockFetch.mockResolvedValueOnce(mockJson(successCapabilityResponse('freshopencode', 'opencode')))

  await getFreshAgentModelCapabilities('freshopencode', { cwd: '/repo/project-a' })

  expect(mockFetch).toHaveBeenCalledWith(
    '/api/fresh-agent/model-capabilities/freshopencode?cwd=%2Frepo%2Fproject-a',
    expect.objectContaining({ headers: expect.any(Headers) }),
  )
})
```

- [ ] **Step 4: Implement cwd-aware registry, router, and API helper**

In `server/fresh-agent/model-capability-registry.ts`:

- Add `type CapabilityRequestContext = { cwd?: string }`.
- Change `getCapabilities(sessionType)` and `refreshCapabilities(sessionType)` to accept an optional context.
- Keep Claude cache behavior unchanged.
- For Freshopencode, call `opencodeCatalogProvider.getCatalog({ cwd })`, normalize with `normalizeOpencodeEnabledModelCatalog`, and cache by `opencode:${cwd ?? '<default>'}`.
- Coalesce in-flight refreshes by the same cache key.
- Return `ok: true` with empty `models` when OpenCode returns parseable providers but no models.
- Return a retryable failure if the catalog provider times out or cannot start.

In `server/fresh-agent/model-capabilities-router.ts`:

- Pass `{ cwd: req.query.cwd }` only when `typeof req.query.cwd === 'string'`.
- Ignore cwd for non-Freshopencode session types.
- Preserve existing 400 behavior for invalid session types.

In `src/lib/api.ts`:

- Add `cwd?: string` support without breaking existing call sites:

```ts
export async function getFreshAgentModelCapabilities(
  sessionType: string,
  options: ApiRequestOptions & { cwd?: string } = {},
): Promise<FreshAgentModelCapabilitiesResponse> {
  const { cwd, ...requestOptions } = options
  const query = cwd ? `?${new URLSearchParams({ cwd }).toString()}` : ''
  return parseFreshAgentModelCapabilitiesResponse(
    await api.get(`/api/fresh-agent/model-capabilities/${encodeURIComponent(sessionType)}${query}`, requestOptions),
  )
}
```

Apply the same cwd support to `refreshFreshAgentModelCapabilities`.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm run test:vitest -- --run test/unit/server/fresh-agent/opencode-model-catalog.test.ts test/unit/server/fresh-agent/model-capability-registry.test.ts test/integration/server/fresh-agent-model-capabilities-router.test.ts test/unit/client/lib/api.test.ts
```

Expected: PASS.

Commit:

```bash
git add server/fresh-agent/adapters/opencode/model-catalog.ts server/fresh-agent/model-capability-registry.ts server/fresh-agent/model-capabilities-router.ts src/lib/api.ts test/unit/server/fresh-agent/opencode-model-catalog.test.ts test/unit/server/fresh-agent/model-capability-registry.test.ts test/integration/server/fresh-agent-model-capabilities-router.test.ts test/unit/client/lib/api.test.ts
git commit -m "feat: serve cwd-scoped freshopencode model capabilities"
```

## Task 3: Same-Cwd MRU Persistence With Display Metadata

**Files:**
- Create: `src/lib/freshopencode-model-mru.ts`
- Test: `test/unit/client/lib/freshopencode-model-mru.test.ts`

**Interfaces:**
- Produces: `FreshOpencodeModelMruEntry = { id: string; displayName: string; source: { id: string; displayName: string }; cwdKey: string; lastVerifiedAt: number }`
- Produces: `loadFreshOpencodeModelMru(storage?: Storage): FreshOpencodeModelMruEntry[]`
- Produces: `recordFreshOpencodeModelUse(model, cwdKey, now?, storage?): FreshOpencodeModelMruEntry[]`
- Produces: `buildFreshOpencodeVisibleMru({ currentModelId, cwdKey, entries, capabilities, now, maxVisible }): Array<{ model: FreshAgentModelCapability; stale: boolean }>`

- [ ] **Step 1: Write failing MRU tests**

Create `test/unit/client/lib/freshopencode-model-mru.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildFreshOpencodeVisibleMru,
  loadFreshOpencodeModelMru,
  recordFreshOpencodeModelUse,
} from '@/lib/freshopencode-model-mru'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

const capability = (id: string, displayName = id) => ({
  id,
  displayName,
  provider: 'opencode' as const,
  source: { id: id.split('/')[0], displayName: id.split('/')[0] },
  supportsEffort: true,
  supportedEffortLevels: ['high'],
  supportsAdaptiveThinking: true,
})

const capabilities = {
  sessionType: 'freshopencode',
  runtimeProvider: 'opencode',
  status: 'fresh',
  fetchedAt: 1_000,
  models: [
    capability('opencode-go/current', 'Current'),
    capability('opencode-go/a', 'Alpha'),
    capability('opencode-go/b', 'Beta'),
  ],
} as const

describe('freshopencode model MRU', () => {
  it('records unique verified entries with display metadata, cwd scope, and most recent first', () => {
    const storage = memoryStorage()
    recordFreshOpencodeModelUse(capability('opencode-go/a', 'Alpha'), '/repo/a', 1_000, storage)
    recordFreshOpencodeModelUse(capability('opencode-go/b', 'Beta'), '/repo/a', 2_000, storage)
    recordFreshOpencodeModelUse(capability('opencode-go/a', 'Alpha'), '/repo/a', 3_000, storage)

    expect(loadFreshOpencodeModelMru(storage)).toEqual([
      {
        id: 'opencode-go/a',
        displayName: 'Alpha',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        cwdKey: '/repo/a',
        lastVerifiedAt: 3_000,
      },
      {
        id: 'opencode-go/b',
        displayName: 'Beta',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        cwdKey: '/repo/a',
        lastVerifiedAt: 2_000,
      },
    ])
  })

  it('renders same-cwd cached MRU immediately before the live catalog resolves', () => {
    const entries = [
      { id: 'opencode-go/current', displayName: 'Current', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
      { id: 'opencode-go/a', displayName: 'Alpha', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
      { id: 'opencode-go/b', displayName: 'Beta', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/b', lastVerifiedAt: 1_000 },
    ]

    expect(buildFreshOpencodeVisibleMru({
      currentModelId: 'opencode-go/current',
      cwdKey: '/repo/a',
      entries,
      capabilities: undefined,
      now: 1_000,
      maxVisible: 3,
    }).map((entry) => [entry.model.id, entry.stale])).toEqual([
      ['opencode-go/current', true],
      ['opencode-go/a', true],
    ])
  })

  it('uses the live enabled catalog to remove stale cached entries after refresh', () => {
    const entries = [
      { id: 'opencode-go/current', displayName: 'Current', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
      { id: 'missing/model', displayName: 'Missing', source: { id: 'missing', displayName: 'missing' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
    ]

    expect(buildFreshOpencodeVisibleMru({
      currentModelId: 'opencode-go/current',
      cwdKey: '/repo/a',
      entries,
      capabilities,
      now: 2_000,
      maxVisible: 3,
    }).map((entry) => [entry.model.id, entry.stale])).toEqual([
      ['opencode-go/current', false],
    ])
  })
})
```

Expected result:

```bash
npm run test:vitest -- --run test/unit/client/lib/freshopencode-model-mru.test.ts
```

The test fails because the module does not exist.

- [ ] **Step 2: Implement MRU helpers**

Create `src/lib/freshopencode-model-mru.ts` with:

- Storage key `freshopencode.modelMru.v2`.
- A maximum of five stored entries after de-duplication by `(cwdKey, id)`.
- A freshness window matching the model capability TTL.
- Strict parsing that drops corrupt entries, blank ids, blank labels, and entries whose `source.id` is blank.
- `recordFreshOpencodeModelUse` that accepts a live `FreshAgentModelCapability`, stores only allowlisted metadata, and records the cwd key.
- `buildFreshOpencodeVisibleMru` that:
  - Puts the current model first when it is present in the live catalog or same-cwd fresh cached entries.
  - Uses live capabilities when available and marks entries `stale: false`.
  - Before live capabilities resolve, uses only same-cwd cached entries still inside the freshness window and marks them `stale: true`.
  - Drops cached entries not present in the live catalog after refresh.

- [ ] **Step 3: Run focused tests and commit**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/freshopencode-model-mru.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/lib/freshopencode-model-mru.ts test/unit/client/lib/freshopencode-model-mru.test.ts
git commit -m "feat: persist cwd-scoped freshopencode model mru"
```

## Task 4: Canonical Freshopencode Runtime Model Resolution

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `src/components/fresh-agent/FreshAgentSettingsButton.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Produces: `resolveEffectiveFreshAgentModel(content, providerDefaults?): string | undefined`
- Consumes: `paneContent.model`, `paneContent.modelSelection?.modelId`, and `settings.freshAgent.providers[sessionType].modelSelection?.modelId`
- Guarantees: Freshopencode create/send messages include the same selected `providerID/modelID` after reload even when persisted pane content has only `modelSelection`

- [ ] **Step 1: Write failing Freshopencode create/send model-resolution tests**

Add cases to `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` near the existing fresh-agent settings tests:

```ts
it('creates Freshopencode panes with modelSelection when persisted model is absent after reload', async () => {
  const store = createFreshAgentViewStoreWithPane({
    kind: 'fresh-agent',
    sessionType: 'freshopencode',
    provider: 'opencode',
    createRequestId: 'req-reload-opencode-model',
    status: 'creating',
    modelSelection: { kind: 'exact', modelId: 'opencode-go/glm-5.2' },
    effort: 'max',
  })

  renderFreshAgentView(store)

  await waitFor(() => {
    expect(getSentFreshAgentCreateMessages()).toContainEqual(expect.objectContaining({
      type: 'freshAgent.create',
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.2',
      modelSelection: { kind: 'exact', modelId: 'opencode-go/glm-5.2' },
    }))
  })
})

it('sends Freshopencode messages with modelSelection when pane model is absent', async () => {
  const store = createFreshAgentViewStoreWithPane({
    kind: 'fresh-agent',
    sessionType: 'freshopencode',
    provider: 'opencode',
    createRequestId: 'req-send-opencode-model',
    sessionId: 'freshopencode-req-send-opencode-model',
    status: 'idle',
    modelSelection: { kind: 'exact', modelId: 'deepseek/deepseek-v4-pro' },
    effort: 'high',
  })

  renderFreshAgentView(store)
  await typeFreshAgentMessage('hello')

  expect(getSentFreshAgentSendMessages()).toContainEqual(expect.objectContaining({
    type: 'freshAgent.send',
    settings: expect.objectContaining({
      model: 'deepseek/deepseek-v4-pro',
      effort: 'high',
    }),
  }))
})
```

Use the existing helpers in that test file rather than inventing new harness APIs; the important assertions are the emitted WebSocket messages.

- [ ] **Step 2: Implement shared client-side effective model resolution**

In `src/components/fresh-agent/FreshAgentView.tsx`, replace the local `getEffectiveFreshAgentModel(content)` logic with:

```ts
function resolveEffectiveFreshAgentModel(
  content: FreshAgentPaneContent,
  providerDefaults?: { modelSelection?: { modelId: string } },
): string | undefined {
  const configuredModel = content.model
    ?? content.modelSelection?.modelId
    ?? providerDefaults?.modelSelection?.modelId
  return normalizeFreshAgentModel(content.sessionType, content.provider, configuredModel)
}
```

Fetch the same provider defaults already used by `FreshAgentSettingsButton` from Redux in `FreshAgentView`, and pass them when building create/send messages. Keep `modelSelection` on the create message for traceability, but make `model` the runtime-authoritative field because the OpenCode adapter consumes `input.model`.

Apply the same resolver in `FreshAgentSettingsButton.tsx` so the settings popover shows the same effective model that create/send will use.

- [ ] **Step 3: Run focused tests and commit**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx
```

Expected: PASS.

Commit:

```bash
git add src/components/fresh-agent/FreshAgentView.tsx src/components/fresh-agent/FreshAgentSettingsButton.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "fix: resolve freshopencode model selections for runtime"
```

## Task 5: Freshopencode Settings UI

**Files:**
- Create: `src/components/fresh-agent/FreshOpencodeModelSettings.tsx`
- Modify: `src/components/fresh-agent/FreshAgentSettingsButton.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx`

**Interfaces:**
- Consumes: `getFreshAgentModelCapabilities('freshopencode', { cwd })`
- Consumes: MRU helpers from `src/lib/freshopencode-model-mru.ts`
- Produces: accessible MRU model buttons, a search entry that opens `role="dialog"` modal, and model selection persistence through existing `mergePaneContent` and `saveServerSettingsPatch`

- [ ] **Step 1: Write failing component tests**

Extend `test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx` with a mocked API helper:

```ts
const getFreshAgentModelCapabilitiesSpy = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getFreshAgentModelCapabilities: (...args: unknown[]) => getFreshAgentModelCapabilitiesSpy(...args),
  }
})
```

Add a Freshopencode store fixture and this test:

```ts
it('shows Freshopencode MRU in the settings popover and opens grouped search on focus', async () => {
  getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
    ok: true,
    sessionType: 'freshopencode',
    runtimeProvider: 'opencode',
    status: 'fresh',
    fetchedAt: 1_234,
    models: [
      {
        id: 'opencode-go/glm-5.2',
        displayName: 'GLM 5.2',
        provider: 'opencode',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'opencode-go/deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        provider: 'opencode',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'deepseek/deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        provider: 'opencode',
        source: { id: 'deepseek', displayName: 'deepseek' },
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: true,
      },
    ],
  })
  window.localStorage.setItem('freshopencode.modelMru.v2', JSON.stringify([
    {
      id: 'opencode-go/deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      source: { id: 'opencode-go', displayName: 'opencode-go' },
      cwdKey: '/repo/project-a',
      lastVerifiedAt: Date.now(),
    },
    {
      id: 'deepseek/deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      source: { id: 'deepseek', displayName: 'deepseek' },
      cwdKey: '/repo/project-a',
      lastVerifiedAt: Date.now(),
    },
  ]))
  const store = createStore()
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      createRequestId: 'req-opencode-settings',
      sessionId: 'thread-opencode-settings',
      status: 'idle',
      initialCwd: '/repo/project-a',
      model: 'opencode-go/glm-5.2',
      effort: 'max',
    },
  }))

  render(
    <Provider store={store}>
      <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
    </Provider>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

  expect(screen.getByRole('button', { name: /DeepSeek V4 Flash/i })).toBeVisible()
  expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('freshopencode', expect.objectContaining({ cwd: '/repo/project-a' }))
  expect(await screen.findByRole('button', { name: /Current model: GLM 5\.2/i })).toBeVisible()
  expect(screen.getByRole('button', { name: /DeepSeek V4 Flash/i })).toBeVisible()
  expect(screen.queryByRole('button', { name: /DeepSeek V4 Pro/i })).toBeVisible()
  expect(screen.queryByRole('button', { name: /Refresh/i })).not.toBeInTheDocument()
  expect(screen.queryByText(/Command|⌘K/i)).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: /Choose Freshopencode model/i })).not.toBeInTheDocument()

  fireEvent.focus(screen.getByRole('searchbox', { name: /Search enabled models/i }))

  expect(await screen.findByRole('dialog', { name: /Choose Freshopencode model/i })).toBeVisible()
  expect(screen.getByRole('heading', { name: 'deepseek' })).toBeVisible()
  expect(screen.getByRole('heading', { name: 'opencode-go' })).toBeVisible()

  fireEvent.change(screen.getByRole('searchbox', { name: /Filter enabled models/i }), { target: { value: 'pro' } })
  expect(screen.getByRole('button', { name: /DeepSeek V4 Pro/i })).toBeVisible()
  expect(screen.queryByRole('button', { name: /GLM 5\.2/i })).not.toBeInTheDocument()
})
```

Add a selection test:

```ts
it('persists a Freshopencode modal selection as an exact provider-qualified model and updates MRU', async () => {
  getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
    ok: true,
    sessionType: 'freshopencode',
    runtimeProvider: 'opencode',
    status: 'fresh',
    fetchedAt: 1_234,
    models: [
      {
        id: 'opencode-go/glm-5.2',
        displayName: 'GLM 5.2',
        provider: 'opencode',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'deepseek/deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        provider: 'opencode',
        source: { id: 'deepseek', displayName: 'deepseek' },
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: true,
      },
    ],
  })
  const store = createFreshopencodeStoreWithModel('opencode-go/glm-5.2')

  render(
    <Provider store={store}>
      <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
    </Provider>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
  fireEvent.focus(await screen.findByRole('searchbox', { name: /Search enabled models/i }))
  fireEvent.click(await screen.findByRole('button', { name: /DeepSeek V4 Pro/i }))

  await waitFor(() => {
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshopencode: {
            modelSelection: { kind: 'exact', modelId: 'deepseek/deepseek-v4-pro' },
            effort: 'high',
          },
        },
      },
    })
  })
  expect(JSON.parse(window.localStorage.getItem('freshopencode.modelMru.v2') ?? '[]')[0]).toMatchObject({
    id: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
  })
})
```

Expected result:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx
```

The tests fail because the Freshopencode settings UI does not fetch capabilities, render MRU tiles, or open a modal on search focus.

- [ ] **Step 2: Create `FreshOpencodeModelSettings`**

Create `src/components/fresh-agent/FreshOpencodeModelSettings.tsx` with these behaviors:

- Resolve `cwdKey` from `paneContent.initialCwd ?? ''`.
- On mount while the parent popover is open, call `getFreshAgentModelCapabilities('freshopencode', { cwd: paneContent.initialCwd })` once.
- If the response is `ok: true`, keep it in component state.
- When the response is `ok: true`, record/update same-cwd MRU metadata for the current model if it appears in the enabled catalog.
- If the response is unavailable, show a compact unavailable status inside the model section. Do not show selectable fallback model tiles because the UI cannot prove they are enabled.
- Build MRU tiles with `buildFreshOpencodeVisibleMru({ currentModelId: activeModel, cwdKey, entries: loadFreshOpencodeModelMru(), capabilities, now: Date.now(), maxVisible: 4 })`.
- Disable stale cached MRU tiles if the live refresh fails; when live refresh is still pending, allow same-cwd fresh cached tiles so the second click works from the previous verified catalog.
- Render the fourth tile with a narrow-screen hide class so single-column/narrow layouts show three visible MRU tiles.
- Render a search input in the popover. `onFocus` and `onClick` both set `modalOpen` to true.
- Render the full catalog only inside the modal.
- Filter the modal list with `filterFreshAgentModelCapabilitiesByQuery`.
- Render no more than `MAX_RENDERED_MODEL_ROWS = 250` model rows at once. If the filtered result is larger, show a compact "Keep typing to narrow results" status and keep filtering client-side.
- Use `<button>` for all model options.
- Use `role="dialog" aria-modal="true" aria-label="Choose Freshopencode model"` on the modal.
- Close the modal on Escape and outside click.
- On selection, update pane content with `{ model: model.id, modelSelection: { kind: 'exact', modelId: model.id }, effort: nextEffort }`, persist provider defaults, record same-cwd MRU metadata, close the modal, and keep the settings popover open.

Use this effort rule:

```ts
const nextEffort = model.supportedEffortLevels.includes(paneContent.effort ?? '')
  ? paneContent.effort
  : model.supportedEffortLevels.at(-1) ?? paneContent.effort
```

For the current tile accessible name, use:

```tsx
aria-label={`Current model: ${model.displayName}`}
```

For non-current MRU tiles, use:

```tsx
aria-label={`Use model: ${model.displayName}`}
```

- [ ] **Step 3: Move the Freshopencode model section last**

In `src/components/fresh-agent/FreshAgentSettingsButton.tsx`:

- Keep Style first.
- For `paneContent.sessionType === 'freshopencode'`, render Thinking before the model section.
- Render `<FreshOpencodeModelSettings />` after Thinking.
- Do not render the existing static `modelOptions.map(...)` radio fieldset for Freshopencode.
- Keep the existing static model fieldset for Freshcodex and any non-OpenCode session types.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/client/lib/freshopencode-model-mru.test.ts test/unit/client/lib/fresh-agent-model-capabilities.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/components/fresh-agent/FreshOpencodeModelSettings.tsx src/components/fresh-agent/FreshAgentSettingsButton.tsx test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx
git commit -m "feat: add compact freshopencode model picker"
```

## Task 6: Browser Coverage And Final Verification

**Files:**
- Create: `test/e2e-browser/specs/freshopencode-model-picker.spec.ts`

**Interfaces:**
- Consumes: the public UI only: pane picker, settings gear, MRU buttons, search entry, modal buttons.
- Produces: desktop and mobile regression coverage for the approved interaction model.

- [ ] **Step 1: Write the browser test**

Create `test/e2e-browser/specs/freshopencode-model-picker.spec.ts`. Use the existing helpers from `test/e2e-browser/specs/fresh-agent.spec.ts` as the pattern. The test should:

- Route `**/api/fresh-agent/model-capabilities/freshopencode?**` to a fixture with at least six models across `deepseek`, `glm-vast`, and `opencode-go`.
- Assert the request URL includes `cwd=` for the Freshopencode pane cwd.
- Enable fresh clients and OpenCode through the test harness.
- Create or open a Freshopencode pane.
- Open the agent settings popover.
- Assert the model section appears after Style and Thinking by reading visible section labels in order.
- Assert only MRU/current tiles are present before search and no source headings are visible.
- Click an MRU tile and assert the harness stores `freshAgent.providers.freshopencode.modelSelection.modelId`.
- Reopen settings, focus the search input, and assert the modal opens.
- Assert source headings are sorted alphabetically and model names under `opencode-go` are sorted alphabetically.
- Type into the modal search input and assert the result list filters without an extra network request.
- Run the same visibility assertion at a narrow viewport and assert three MRU tiles are visible.

The network-count assertion should be:

```ts
let capabilityRequests = 0
await page.route('**/api/fresh-agent/model-capabilities/freshopencode?**', async (route) => {
  capabilityRequests += 1
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) })
})

await modal.getByRole('searchbox', { name: /Filter enabled models/i }).fill('glm')
await modal.getByRole('searchbox', { name: /Filter enabled models/i }).fill('glm 5.2')
expect(capabilityRequests).toBe(1)
```

- [ ] **Step 2: Run browser coverage**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/freshopencode-model-picker.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck and focused regression tests**

Run:

```bash
npm run typecheck
npm run test:vitest -- --run test/unit/shared/fresh-agent-models.test.ts test/unit/client/lib/api.test.ts test/unit/client/lib/fresh-agent-model-capabilities.test.ts test/unit/client/lib/freshopencode-model-mru.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/server/fresh-agent/opencode-model-catalog.test.ts test/unit/server/fresh-agent/model-capability-registry.test.ts test/integration/server/fresh-agent-model-capabilities-router.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the coordinated suite when the focused tests are green**

Run:

```bash
FRESHELL_TEST_SUMMARY="freshopencode enabled model picker" npm test
```

Expected: coordinated full suite PASS.

- [ ] **Step 5: Commit browser coverage**

Commit:

```bash
git add test/e2e-browser/specs/freshopencode-model-picker.spec.ts
git commit -m "test: cover freshopencode model picker flow"
```

## Performance Notes

- Settings-open fetch: the UI fetches the cwd-scoped enabled catalog when the settings popover opens, not while rendering every pane.
- Server cache: the registry keeps the existing five-minute TTL and coalesces concurrent refreshes, with separate Claude and cwd-scoped OpenCode cache entries.
- Catalog sidecar isolation: catalog fetches use a short-lived probe that stops only its own child process; it must not route through `OpencodeServeManager` or disturb active sessions.
- MRU immediacy: the popover can render recently verified same-cwd MRU metadata immediately, then reconcile against the live enabled catalog as soon as it returns.
- Search: modal search is purely client-side over the cached, sanitized response.
- Render size: the popover renders at most four MRU tiles and one search entry; the modal mounts only on search focus and renders at most 250 matching rows at once.

## Load-Bearing Validation Incorporated

- Local OpenCode 1.17.9 exposes `/config/providers` and `/provider`; `/config/providers` is the safer enabled/configured provider source for this feature.
- OpenCode model availability is cwd/project-specific, so Freshopencode capabilities must include pane cwd.
- Raw OpenCode provider/config responses can contain credential-shaped fields, so the server must return only an allowlisted model shape.
- `/provider` can contain thousands of possible models; the modal must cap rendered rows even though search remains client-side.
- Catalog requests through `OpencodeServeManager` can kill/discard a live sidecar on timeout, so catalog discovery must be isolated.
- Persisted Freshopencode panes can have `modelSelection` without `model`; runtime create/send must resolve `modelSelection.modelId`.
- MRU ids alone cannot satisfy the second-click path on a cold catalog fetch; MRU storage must include same-cwd display metadata from a previously verified enabled catalog.

## Implementation Handoff Checklist

- [ ] Stable model id format is `providerID/modelID`.
- [ ] OpenCode duplicate model names from different sources remain distinct.
- [ ] Capabilities are cwd-scoped and fetched with the pane cwd.
- [ ] Catalog timeouts cannot kill or discard active Freshopencode session sidecars.
- [ ] Saved MRU entries not present in the enabled catalog are removed after live refresh.
- [ ] Current model is the first visible tile when it is still enabled.
- [ ] Freshopencode create/send uses `modelSelection.modelId` after reload when `model` is absent.
- [ ] Selecting a model keeps the settings popover open.
- [ ] No raw provider/config JSON reaches the browser.
- [ ] No refresh button or Command-K visual appears.
