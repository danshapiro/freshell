# Electron Launch Connection Chooser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows-friendly Electron launch flow that can detect existing Freshell servers, connect to remote/VPN servers, start a new bundled local server, and optionally always ask before choosing.

**Architecture:** Keep `electron/startup.ts` responsible for orchestration, but extract detection and selection into focused modules so startup does not grow into a policy sink. Treat servers as one of three ownership classes: detected local server, Electron-owned server, or remote server; never manage a detected or remote process. Add a small launcher renderer for ambiguous or forced-choice startup, while preserving the current setup wizard for first-time installation.

**Tech Stack:** Electron main process, React/Vite launcher UI, TypeScript, Zod config schema, Vitest Electron unit tests, Playwright Electron e2e tests.

---

## File Structure

- Create `electron/launch-discovery.ts`: Pure helpers for building local candidate URLs, probing `/api/health`, normalizing URLs, and returning typed server candidates.
- Create `electron/token-resolver.ts`: Pure helpers for resolving tokens from saved desktop config, local server `.env`, and local server `config.json` when the candidate is loopback-only.
- Create `electron/launch-policy.ts`: Pure decision engine that receives config, candidates, and token availability, then returns `auto-connect`, `show-chooser`, `start-local`, or `show-setup`.
- Create `electron/launch-chooser/index.html`: Minimal renderer entry page for the chooser window.
- Create `electron/launch-chooser/main.tsx`: React entrypoint for the chooser window.
- Create `electron/launch-chooser/chooser.tsx`: Accessible chooser UI with local server list, remote URL/token form, start-local action, and always-ask setting.
- Create `electron/launch-chooser/chooser-logic.ts`: Pure form validation and choice serialization for tests.
- Modify `electron/types.ts`: Add `alwaysAskOnLaunch`, optional `knownServers`, and typed launch chooser IPC payloads.
- Modify `electron/desktop-config.ts`: Default `alwaysAskOnLaunch` to `false`; preserve and patch the new fields.
- Modify `electron/startup.ts`: Use launch policy before server-mode switching; add a `chooser` startup result; centralize `loadMainWindow`.
- Modify `electron/entry.ts`: Register chooser IPC handlers, show chooser when `runStartup()` requests it, and restart startup after chooser selection.
- Modify `electron/preload.ts`: Expose chooser APIs to the renderer.
- Modify `config/electron-builder.yml`: Include the built launch chooser assets beside existing setup wizard assets.
- Modify `package.json`: Add `build:launch-chooser` and include it in `electron:build` and `electron:build:win`.
- Modify `server/index.ts`: Extend `/api/health` with `instanceId`, `startedAt`, and `requiresAuth` without requiring auth.
- Test `test/unit/electron/launch-discovery.test.ts`.
- Test `test/unit/electron/token-resolver.test.ts`.
- Test `test/unit/electron/launch-policy.test.ts`.
- Test `test/unit/electron/launch-chooser/chooser-logic.test.ts`.
- Modify `test/unit/electron/desktop-config.test.ts`.
- Modify `test/unit/electron/startup.test.ts`.
- Modify `test/unit/electron/preload.test.ts`.
- Modify `test/unit/server/api.test.ts`.
- Modify `test/e2e-electron/electron-app.test.ts`.

## Design Decisions

- `alwaysAskOnLaunch` defaults to `false`. When true, startup shows the chooser even when exactly one saved or detected candidate is valid.
- Detection is local-first and bounded: check the configured port, default port `3001`, saved local URLs, and the small local range `3001-3010`.
- Do not add LAN broadcast discovery in this iteration. Remote/VPN connection is explicit URL entry plus saved history.
- `/api/health` remains unauthenticated and must identify Freshell with `app: "freshell"` and `ok: true`.
- Local token lookup is allowed only for loopback candidates: `localhost`, `127.0.0.1`, and `[::1]`.
- If multiple valid candidates exist, show the chooser.
- If no valid candidate exists and config says `app-bound`, auto-start local unless `alwaysAskOnLaunch` is true.
- If config says `remote` and the saved remote is unreachable, show chooser with the remote option prefilled and an error message.
- Tokens should not be baked into the executable. Installer-time provisioning remains supported; runtime choices update `%USERPROFILE%\.freshell\desktop.json`.

---

### Task 1: Desktop Config Schema

**Files:**
- Modify: `electron/types.ts`
- Modify: `electron/desktop-config.ts`
- Modify: `test/unit/electron/desktop-config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add these tests to `test/unit/electron/desktop-config.test.ts`:

```ts
  describe('launch chooser fields', () => {
    it('defaults alwaysAskOnLaunch to false', () => {
      const config = getDefaultDesktopConfig()
      expect(config.alwaysAskOnLaunch).toBe(false)
    })

    it('schema defaults alwaysAskOnLaunch to false when omitted', () => {
      const result = DesktopConfigSchema.parse({
        serverMode: 'app-bound',
      })
      expect(result.alwaysAskOnLaunch).toBe(false)
    })

    it('preserves known servers from config file', async () => {
      const freshellDir = path.join(tempDir, '.freshell')
      await fsp.mkdir(freshellDir, { recursive: true })
      await fsp.writeFile(
        path.join(freshellDir, 'desktop.json'),
        JSON.stringify({
          serverMode: 'remote',
          port: 3001,
          remoteUrl: 'http://10.0.0.5:3001',
          remoteToken: 'vpn-token',
          knownServers: [
            {
              url: 'http://localhost:3001',
              label: 'Local dev server',
              lastConnectedAt: '2026-05-24T18:00:00.000Z',
            },
          ],
          alwaysAskOnLaunch: true,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        }),
      )

      const config = await readDesktopConfig()
      expect(config).not.toBeNull()
      expect(config!.alwaysAskOnLaunch).toBe(true)
      expect(config!.knownServers).toEqual([
        {
          url: 'http://localhost:3001',
          label: 'Local dev server',
          lastConnectedAt: '2026-05-24T18:00:00.000Z',
        },
      ])
    })

    it('patches alwaysAskOnLaunch and knownServers', async () => {
      await writeDesktopConfig(getDefaultDesktopConfig())

      const patched = await patchDesktopConfig({
        alwaysAskOnLaunch: true,
        knownServers: [
          {
            url: 'http://localhost:3002',
            label: 'Local 3002',
            lastConnectedAt: '2026-05-24T18:05:00.000Z',
          },
        ],
      })

      expect(patched.alwaysAskOnLaunch).toBe(true)
      expect(patched.knownServers).toEqual([
        {
          url: 'http://localhost:3002',
          label: 'Local 3002',
          lastConnectedAt: '2026-05-24T18:05:00.000Z',
        },
      ])
    })
  })
```

- [ ] **Step 2: Run the failing config tests**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/desktop-config.test.ts --run
```

Expected: FAIL because `alwaysAskOnLaunch` and `knownServers` are not in `DesktopConfigSchema`.

- [ ] **Step 3: Add schema fields**

Update `electron/types.ts`:

```ts
import { z } from 'zod'

export const KnownServerSchema = z.object({
  url: z.string().url(),
  label: z.string().optional(),
  lastConnectedAt: z.string().datetime().optional(),
})

export const DesktopConfigSchema = z.object({
  serverMode: z.enum(['daemon', 'app-bound', 'remote']),
  port: z.number().default(3001),
  remoteUrl: z.string().url().optional(),
  remoteToken: z.string().optional(),
  knownServers: z.array(KnownServerSchema).default([]),
  alwaysAskOnLaunch: z.boolean().default(false),
  globalHotkey: z.string().default('CommandOrControl+`'),
  startOnLogin: z.boolean().default(false),
  minimizeToTray: z.boolean().default(true),
  setupCompleted: z.boolean().default(false),
  windowState: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    maximized: z.boolean(),
  }).optional(),
})

export type KnownServer = z.infer<typeof KnownServerSchema>
export type DesktopConfig = z.infer<typeof DesktopConfigSchema>

export type ServerOwnership = 'owned' | 'detected-local' | 'remote'

export interface LaunchServerCandidate {
  id: string
  url: string
  origin: 'configured' | 'known' | 'port-scan' | 'manual'
  ownership: ServerOwnership
  label?: string
  version?: string
  instanceId?: string
  startedAt?: string
  ready?: boolean
  requiresAuth?: boolean
  token?: string
}

export interface LaunchChoice {
  kind: 'connect' | 'remote' | 'start-local'
  url?: string
  token?: string
  port?: number
  alwaysAskOnLaunch: boolean
  remember: boolean
}
```

- [ ] **Step 4: Add config defaults**

Update `getDefaultDesktopConfig()` in `electron/desktop-config.ts`:

```ts
export function getDefaultDesktopConfig(): DesktopConfig {
  return {
    serverMode: 'app-bound',
    port: 3001,
    knownServers: [],
    alwaysAskOnLaunch: false,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: false,
  }
}
```

- [ ] **Step 5: Verify config tests pass**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/desktop-config.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add electron/types.ts electron/desktop-config.ts test/unit/electron/desktop-config.test.ts
git commit -m "feat(electron): add launch chooser config fields"
```

---

### Task 2: Local Server Discovery

**Files:**
- Create: `electron/launch-discovery.ts`
- Create: `test/unit/electron/launch-discovery.test.ts`

- [ ] **Step 1: Write failing discovery tests**

Create `test/unit/electron/launch-discovery.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  buildLocalProbeUrls,
  discoverLocalServers,
  isLoopbackUrl,
  normalizeServerUrl,
} from '../../../electron/launch-discovery.js'
import type { DesktopConfig } from '../../../electron/types.js'

function config(overrides: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverMode: 'app-bound',
    port: 3001,
    knownServers: [],
    alwaysAskOnLaunch: false,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: true,
    ...overrides,
  }
}

describe('launch discovery', () => {
  it('normalizes server URLs by trimming trailing slashes', () => {
    expect(normalizeServerUrl('http://localhost:3001/')).toBe('http://localhost:3001')
    expect(normalizeServerUrl('http://localhost:3001///')).toBe('http://localhost:3001')
  })

  it('recognizes only loopback URLs as local token-readable URLs', () => {
    expect(isLoopbackUrl('http://localhost:3001')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.1:3001')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:3001')).toBe(true)
    expect(isLoopbackUrl('http://10.0.0.5:3001')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
  })

  it('builds unique local probe URLs from config port, defaults, range, and known local servers', () => {
    const urls = buildLocalProbeUrls(config({
      port: 3004,
      knownServers: [
        { url: 'http://localhost:3002', label: 'Known local' },
        { url: 'http://10.0.0.5:3001', label: 'Remote VPN' },
      ],
    }))

    expect(urls[0]).toBe('http://localhost:3004')
    expect(urls).toContain('http://localhost:3001')
    expect(urls).toContain('http://localhost:3010')
    expect(urls).toContain('http://localhost:3002')
    expect(urls).not.toContain('http://10.0.0.5:3001')
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('returns only healthy Freshell servers', async () => {
    const fetchHealth = vi.fn(async (url: string) => {
      if (url === 'http://localhost:3001/api/health') {
        return {
          ok: true,
          app: 'freshell',
          version: '0.7.0',
          ready: true,
          instanceId: 'local-a',
          startedAt: '2026-05-24T18:00:00.000Z',
          requiresAuth: true,
        }
      }
      if (url === 'http://localhost:3002/api/health') {
        return { ok: true, app: 'not-freshell' }
      }
      throw new Error('ECONNREFUSED')
    })

    const candidates = await discoverLocalServers({
      urls: ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
      fetchHealth,
    })

    expect(candidates).toEqual([
      {
        id: 'local-a',
        url: 'http://localhost:3001',
        origin: 'port-scan',
        ownership: 'detected-local',
        label: 'localhost:3001',
        version: '0.7.0',
        ready: true,
        instanceId: 'local-a',
        startedAt: '2026-05-24T18:00:00.000Z',
        requiresAuth: true,
      },
    ])
  })
})
```

- [ ] **Step 2: Run the failing discovery tests**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/launch-discovery.test.ts --run
```

Expected: FAIL because `electron/launch-discovery.ts` does not exist.

- [ ] **Step 3: Implement discovery**

Create `electron/launch-discovery.ts`:

```ts
import type { DesktopConfig, LaunchServerCandidate } from './types.js'

export interface HealthPayload {
  app?: string
  ok?: boolean
  version?: string
  ready?: boolean
  instanceId?: string
  startedAt?: string
  requiresAuth?: boolean
}

export interface DiscoverLocalServersOptions {
  urls: string[]
  fetchHealth?: (url: string) => Promise<HealthPayload>
}

export function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

export function buildLocalProbeUrls(config: DesktopConfig): string[] {
  const urls: string[] = []
  const add = (url: string) => {
    const normalized = normalizeServerUrl(url)
    if (isLoopbackUrl(normalized) && !urls.includes(normalized)) {
      urls.push(normalized)
    }
  }

  add(`http://localhost:${config.port}`)
  add('http://localhost:3001')

  for (let port = 3001; port <= 3010; port += 1) {
    add(`http://localhost:${port}`)
  }

  for (const server of config.knownServers ?? []) {
    add(server.url)
  }

  return urls
}

async function defaultFetchHealth(url: string): Promise<HealthPayload> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 750)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return { ok: false }
    return await response.json() as HealthPayload
  } finally {
    clearTimeout(timer)
  }
}

export async function discoverLocalServers(options: DiscoverLocalServersOptions): Promise<LaunchServerCandidate[]> {
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth
  const results = await Promise.all(options.urls.map(async (url) => {
    const normalized = normalizeServerUrl(url)
    try {
      const health = await fetchHealth(`${normalized}/api/health`)
      if (health.app !== 'freshell' || health.ok !== true) {
        return undefined
      }

      const parsed = new URL(normalized)
      return {
        id: health.instanceId ?? normalized,
        url: normalized,
        origin: 'port-scan' as const,
        ownership: 'detected-local' as const,
        label: `${parsed.hostname}:${parsed.port}`,
        version: health.version,
        ready: health.ready,
        instanceId: health.instanceId,
        startedAt: health.startedAt,
        requiresAuth: health.requiresAuth ?? true,
      }
    } catch {
      return undefined
    }
  }))

  return results.filter((candidate): candidate is LaunchServerCandidate => candidate !== undefined)
}
```

- [ ] **Step 4: Verify discovery tests pass**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/launch-discovery.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add electron/launch-discovery.ts test/unit/electron/launch-discovery.test.ts
git commit -m "feat(electron): discover local Freshell servers"
```

---

### Task 3: Token Resolution

**Files:**
- Create: `electron/token-resolver.ts`
- Create: `test/unit/electron/token-resolver.test.ts`

- [ ] **Step 1: Write failing token resolver tests**

Create `test/unit/electron/token-resolver.test.ts`:

```ts
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  extractTokenFromConfigJson,
  extractTokenFromEnv,
  resolveCandidateToken,
} from '../../../electron/token-resolver.js'
import type { DesktopConfig, LaunchServerCandidate } from '../../../electron/types.js'

function localCandidate(url = 'http://localhost:3001'): LaunchServerCandidate {
  return {
    id: url,
    url,
    origin: 'port-scan',
    ownership: 'detected-local',
    label: url,
    requiresAuth: true,
  }
}

function config(overrides: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverMode: 'app-bound',
    port: 3001,
    knownServers: [],
    alwaysAskOnLaunch: false,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: true,
    ...overrides,
  }
}

describe('token resolver', () => {
  it('extracts AUTH_TOKEN from env content', () => {
    expect(extractTokenFromEnv('AUTH_TOKEN=abc123\nPORT=3001\n')).toBe('abc123')
    expect(extractTokenFromEnv('AUTH_TOKEN=\"quoted-token\"\n')).toBe('quoted-token')
    expect(extractTokenFromEnv('PORT=3001\n')).toBeUndefined()
  })

  it('extracts token from config json using supported keys', () => {
    expect(extractTokenFromConfigJson(JSON.stringify({ authToken: 'config-a' }))).toBe('config-a')
    expect(extractTokenFromConfigJson(JSON.stringify({ token: 'config-b' }))).toBe('config-b')
    expect(extractTokenFromConfigJson('{bad json')).toBeUndefined()
  })

  it('uses matching saved remote token first', async () => {
    const readTextFile = vi.fn()
    const token = await resolveCandidateToken({
      candidate: localCandidate('http://localhost:3001'),
      desktopConfig: config({
        remoteUrl: 'http://localhost:3001',
        remoteToken: 'saved-token',
      }),
      configDir: '/home/user/.freshell',
      readTextFile,
    })

    expect(token).toBe('saved-token')
    expect(readTextFile).not.toHaveBeenCalled()
  })

  it('reads loopback token from .env when no saved token exists', async () => {
    const readTextFile = vi.fn(async (filePath: string) => {
      expect(filePath).toBe(path.join('/home/user/.freshell', '.env'))
      return 'AUTH_TOKEN=env-token\n'
    })

    const token = await resolveCandidateToken({
      candidate: localCandidate('http://127.0.0.1:3001'),
      desktopConfig: config(),
      configDir: '/home/user/.freshell',
      readTextFile,
    })

    expect(token).toBe('env-token')
  })

  it('falls back to config.json for loopback token', async () => {
    const readTextFile = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('.env')) throw new Error('missing env')
      return JSON.stringify({ authToken: 'json-token' })
    })

    const token = await resolveCandidateToken({
      candidate: localCandidate(),
      desktopConfig: config(),
      configDir: '/home/user/.freshell',
      readTextFile,
    })

    expect(token).toBe('json-token')
  })

  it('does not read local token files for remote candidates', async () => {
    const readTextFile = vi.fn(async () => 'AUTH_TOKEN=local-token\n')

    const token = await resolveCandidateToken({
      candidate: {
        ...localCandidate('http://10.0.0.5:3001'),
        ownership: 'remote',
      },
      desktopConfig: config(),
      configDir: '/home/user/.freshell',
      readTextFile,
    })

    expect(token).toBeUndefined()
    expect(readTextFile).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the failing token tests**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/token-resolver.test.ts --run
```

Expected: FAIL because `electron/token-resolver.ts` does not exist.

- [ ] **Step 3: Implement token resolver**

Create `electron/token-resolver.ts`:

```ts
import fsp from 'fs/promises'
import path from 'path'
import { isLoopbackUrl, normalizeServerUrl } from './launch-discovery.js'
import type { DesktopConfig, LaunchServerCandidate } from './types.js'

export interface ResolveCandidateTokenOptions {
  candidate: LaunchServerCandidate
  desktopConfig: DesktopConfig
  configDir: string
  readTextFile?: (filePath: string) => Promise<string>
}

export function extractTokenFromEnv(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^AUTH_TOKEN=(.*)$/)
    if (!match) continue
    const raw = match[1].trim()
    return raw.replace(/^"(.*)"$/, '$1')
  }
  return undefined
}

export function extractTokenFromConfigJson(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { authToken?: unknown; token?: unknown }
    if (typeof parsed.authToken === 'string' && parsed.authToken.length > 0) {
      return parsed.authToken
    }
    if (typeof parsed.token === 'string' && parsed.token.length > 0) {
      return parsed.token
    }
  } catch {
    return undefined
  }
  return undefined
}

async function readOptional(filePath: string, readTextFile: (filePath: string) => Promise<string>): Promise<string | undefined> {
  try {
    return await readTextFile(filePath)
  } catch {
    return undefined
  }
}

export async function resolveCandidateToken(options: ResolveCandidateTokenOptions): Promise<string | undefined> {
  const readTextFile = options.readTextFile ?? ((filePath: string) => fsp.readFile(filePath, 'utf-8'))
  const candidateUrl = normalizeServerUrl(options.candidate.url)
  const remoteUrl = options.desktopConfig.remoteUrl ? normalizeServerUrl(options.desktopConfig.remoteUrl) : undefined

  if (remoteUrl === candidateUrl && options.desktopConfig.remoteToken) {
    return options.desktopConfig.remoteToken
  }

  if (!isLoopbackUrl(candidateUrl)) {
    return undefined
  }

  const envContent = await readOptional(path.join(options.configDir, '.env'), readTextFile)
  const envToken = envContent ? extractTokenFromEnv(envContent) : undefined
  if (envToken) return envToken

  const configContent = await readOptional(path.join(options.configDir, 'config.json'), readTextFile)
  return configContent ? extractTokenFromConfigJson(configContent) : undefined
}
```

- [ ] **Step 4: Verify token tests pass**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/token-resolver.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add electron/token-resolver.ts test/unit/electron/token-resolver.test.ts
git commit -m "feat(electron): resolve launch tokens for local servers"
```

---

### Task 4: Launch Policy

**Files:**
- Create: `electron/launch-policy.ts`
- Create: `test/unit/electron/launch-policy.test.ts`

- [ ] **Step 1: Write failing launch policy tests**

Create `test/unit/electron/launch-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { chooseLaunchAction } from '../../../electron/launch-policy.js'
import type { DesktopConfig, LaunchServerCandidate } from '../../../electron/types.js'

function config(overrides: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverMode: 'app-bound',
    port: 3001,
    knownServers: [],
    alwaysAskOnLaunch: false,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: true,
    ...overrides,
  }
}

function candidate(url: string, token?: string): LaunchServerCandidate {
  return {
    id: url,
    url,
    origin: 'port-scan',
    ownership: 'detected-local',
    label: url,
    ready: true,
    requiresAuth: true,
    token,
  }
}

describe('launch policy', () => {
  it('shows setup when setup is incomplete', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({ setupCompleted: false }),
      candidates: [],
      savedRemoteReachable: false,
    })).toEqual({ type: 'show-setup' })
  })

  it('shows chooser when alwaysAskOnLaunch is true even with one candidate', () => {
    const candidates = [candidate('http://localhost:3001', 'token')]
    expect(chooseLaunchAction({
      desktopConfig: config({ alwaysAskOnLaunch: true }),
      candidates,
      savedRemoteReachable: false,
    })).toEqual({
      type: 'show-chooser',
      candidates,
      reason: 'always-ask',
    })
  })

  it('auto-connects to one detected candidate with a token', () => {
    const candidates = [candidate('http://localhost:3001', 'token')]
    expect(chooseLaunchAction({
      desktopConfig: config(),
      candidates,
      savedRemoteReachable: false,
    })).toEqual({
      type: 'auto-connect',
      candidate: candidates[0],
    })
  })

  it('shows chooser for multiple candidates', () => {
    const candidates = [
      candidate('http://localhost:3001', 'token-a'),
      candidate('http://localhost:3002', 'token-b'),
    ]
    expect(chooseLaunchAction({
      desktopConfig: config(),
      candidates,
      savedRemoteReachable: false,
    })).toEqual({
      type: 'show-chooser',
      candidates,
      reason: 'multiple-candidates',
    })
  })

  it('starts local for app-bound config when no candidates exist', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({ serverMode: 'app-bound' }),
      candidates: [],
      savedRemoteReachable: false,
    })).toEqual({ type: 'start-local' })
  })

  it('auto-connects to reachable saved remote config', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({
        serverMode: 'remote',
        remoteUrl: 'http://10.0.0.5:3001',
        remoteToken: 'vpn-token',
      }),
      candidates: [],
      savedRemoteReachable: true,
    })).toEqual({
      type: 'auto-connect',
      candidate: {
        id: 'http://10.0.0.5:3001',
        url: 'http://10.0.0.5:3001',
        origin: 'configured',
        ownership: 'remote',
        label: 'http://10.0.0.5:3001',
        token: 'vpn-token',
      },
    })
  })

  it('shows chooser for unreachable saved remote config', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({
        serverMode: 'remote',
        remoteUrl: 'http://10.0.0.5:3001',
        remoteToken: 'vpn-token',
      }),
      candidates: [],
      savedRemoteReachable: false,
    })).toEqual({
      type: 'show-chooser',
      candidates: [],
      reason: 'saved-remote-unreachable',
    })
  })
})
```

- [ ] **Step 2: Run the failing launch policy tests**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/launch-policy.test.ts --run
```

Expected: FAIL because `electron/launch-policy.ts` does not exist.

- [ ] **Step 3: Implement launch policy**

Create `electron/launch-policy.ts`:

```ts
import { normalizeServerUrl } from './launch-discovery.js'
import type { DesktopConfig, LaunchServerCandidate } from './types.js'

export type LaunchAction =
  | { type: 'show-setup' }
  | { type: 'start-local' }
  | { type: 'auto-connect'; candidate: LaunchServerCandidate }
  | { type: 'show-chooser'; candidates: LaunchServerCandidate[]; reason: 'always-ask' | 'multiple-candidates' | 'missing-token' | 'saved-remote-unreachable' | 'manual-choice' }

export interface ChooseLaunchActionOptions {
  desktopConfig: DesktopConfig
  candidates: LaunchServerCandidate[]
  savedRemoteReachable: boolean
}

export function chooseLaunchAction(options: ChooseLaunchActionOptions): LaunchAction {
  const { desktopConfig, candidates, savedRemoteReachable } = options

  if (!desktopConfig.setupCompleted) {
    return { type: 'show-setup' }
  }

  if (desktopConfig.alwaysAskOnLaunch) {
    return { type: 'show-chooser', candidates, reason: 'always-ask' }
  }

  if (desktopConfig.serverMode === 'remote' && desktopConfig.remoteUrl) {
    if (savedRemoteReachable) {
      const url = normalizeServerUrl(desktopConfig.remoteUrl)
      return {
        type: 'auto-connect',
        candidate: {
          id: url,
          url,
          origin: 'configured',
          ownership: 'remote',
          label: url,
          token: desktopConfig.remoteToken,
        },
      }
    }

    return { type: 'show-chooser', candidates, reason: 'saved-remote-unreachable' }
  }

  if (candidates.length > 1) {
    return { type: 'show-chooser', candidates, reason: 'multiple-candidates' }
  }

  if (candidates.length === 1) {
    if (candidates[0].requiresAuth && !candidates[0].token) {
      return { type: 'show-chooser', candidates, reason: 'missing-token' }
    }
    return { type: 'auto-connect', candidate: candidates[0] }
  }

  if (desktopConfig.serverMode === 'app-bound') {
    return { type: 'start-local' }
  }

  return { type: 'show-chooser', candidates, reason: 'manual-choice' }
}
```

- [ ] **Step 4: Verify launch policy tests pass**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/launch-policy.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add electron/launch-policy.ts test/unit/electron/launch-policy.test.ts
git commit -m "feat(electron): choose launch action from server discovery"
```

---

### Task 5: Startup Integration Without UI

**Files:**
- Modify: `electron/startup.ts`
- Modify: `test/unit/electron/startup.test.ts`

- [ ] **Step 1: Write failing startup integration tests**

Add these tests to `test/unit/electron/startup.test.ts`:

```ts
  describe('launch discovery integration', () => {
    it('returns chooser when alwaysAskOnLaunch is enabled', async () => {
      const ctx = createDefaultContext({
        desktopConfig: {
          serverMode: 'app-bound',
          port: 3001,
          knownServers: [],
          alwaysAskOnLaunch: true,
          globalHotkey: 'CommandOrControl+`',
          startOnLogin: false,
          minimizeToTray: true,
          setupCompleted: true,
        },
        discoverLaunchCandidates: vi.fn().mockResolvedValue([
          {
            id: 'local-a',
            url: 'http://localhost:3001',
            origin: 'port-scan',
            ownership: 'detected-local',
            label: 'localhost:3001',
            token: 'local-token',
            requiresAuth: true,
          },
        ]),
      })

      const result = await runStartup(ctx)

      expect(result).toEqual({
        type: 'chooser',
        candidates: [
          {
            id: 'local-a',
            url: 'http://localhost:3001',
            origin: 'port-scan',
            ownership: 'detected-local',
            label: 'localhost:3001',
            token: 'local-token',
            requiresAuth: true,
          },
        ],
        reason: 'always-ask',
      })
      expect(ctx.serverSpawner.start).not.toHaveBeenCalled()
      expect(ctx.createBrowserWindow).not.toHaveBeenCalled()
    })

    it('auto-connects to one discovered local server without spawning a new server', async () => {
      const ctx = createDefaultContext({
        discoverLaunchCandidates: vi.fn().mockResolvedValue([
          {
            id: 'local-a',
            url: 'http://localhost:3001',
            origin: 'port-scan',
            ownership: 'detected-local',
            label: 'localhost:3001',
            token: 'local-token',
            requiresAuth: true,
          },
        ]),
      })

      const result = await runStartup(ctx)

      expect(ctx.serverSpawner.start).not.toHaveBeenCalled()
      expect(result.type).toBe('main')
      if (result.type === 'main') {
        expect(result.serverUrl).toBe('http://localhost:3001')
      }
      const window = (ctx.createBrowserWindow as ReturnType<typeof vi.fn>).mock.results[0].value
      expect(window.loadURL).toHaveBeenCalledWith('http://localhost:3001?token=local-token')
    })
  })
```

- [ ] **Step 2: Run the failing startup tests**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/startup.test.ts --run
```

Expected: FAIL because `StartupContext` has no `discoverLaunchCandidates`, and `StartupResult` has no `chooser` result.

- [ ] **Step 3: Update startup types**

Modify the imports and interfaces in `electron/startup.ts`:

```ts
import { buildLocalProbeUrls, discoverLocalServers } from './launch-discovery.js'
import { chooseLaunchAction } from './launch-policy.js'
import { resolveCandidateToken } from './token-resolver.js'
import type { DesktopConfig, LaunchServerCandidate } from './types.js'

export interface StartupContext {
  desktopConfig: DesktopConfig
  daemonManager: DaemonManager
  serverSpawner: ServerSpawner
  hotkeyManager: HotkeyManager
  windowStatePersistence: WindowStatePersistence
  updateManager: UpdateManager
  isDev: boolean
  port: number
  resourcesPath?: string
  configDir: string
  platform: NodeJS.Platform
  createBrowserWindow: (options: Record<string, any>) => BrowserWindowLike
  createTray: () => void
  fetchHealthCheck?: (url: string) => Promise<boolean>
  readEnvToken?: (envPath: string) => Promise<string | undefined>
  discoverLaunchCandidates?: () => Promise<LaunchServerCandidate[]>
}

export type StartupResult =
  | { type: 'wizard' }
  | { type: 'chooser'; candidates: LaunchServerCandidate[]; reason: string }
  | { type: 'main'; serverUrl: string; window: BrowserWindowLike; updateCheckTimer: ReturnType<typeof setTimeout> }
```

- [ ] **Step 4: Add candidate discovery helper**

Add this helper in `electron/startup.ts` above `runStartup()`:

```ts
async function defaultDiscoverLaunchCandidates(ctx: StartupContext): Promise<LaunchServerCandidate[]> {
  const urls = buildLocalProbeUrls(ctx.desktopConfig)
  const candidates = await discoverLocalServers({ urls })
  return Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    token: await resolveCandidateToken({
      candidate,
      desktopConfig: ctx.desktopConfig,
      configDir: ctx.configDir,
    }),
  })))
}
```

- [ ] **Step 5: Refactor main window loading into a helper**

Move the existing window creation, token appending, hotkey registration, tray creation, and update timer logic into:

```ts
async function loadMainWindow(
  ctx: StartupContext,
  serverUrl: string,
  authToken: string | undefined,
): Promise<Extract<StartupResult, { type: 'main' }>> {
  const windowState = await ctx.windowStatePersistence.load()
  const window = ctx.createBrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  const loadUrl = authToken ? `${serverUrl}?token=${authToken}` : serverUrl
  await window.loadURL(loadUrl)
  window.show()

  if (windowState.maximized) {
    window.maximize()
  }

  let saveTimeout: ReturnType<typeof setTimeout> | undefined
  const saveState = () => {
    clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => {
      const bounds = window.getBounds?.()
      const maximized = window.isMaximized?.() ?? false
      if (bounds) {
        void ctx.windowStatePersistence.save({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          maximized,
        })
      }
    }, 500)
  }

  window.on('resize', saveState)
  window.on('move', saveState)

  ctx.hotkeyManager.register(ctx.desktopConfig.globalHotkey, () => {
    if (window.isVisible() && window.isFocused()) {
      window.hide()
    } else {
      window.show()
      window.focus()
    }
  })

  try {
    ctx.createTray()
  } catch (err) {
    console.warn('Failed to create system tray:', err)
  }

  const updateCheckTimer = setTimeout(() => {
    void ctx.updateManager.checkForUpdates()
  }, 10_000)

  return { type: 'main', serverUrl, window, updateCheckTimer }
}
```

- [ ] **Step 6: Call policy before the existing server-mode switch**

At the top of `runStartup()`, after the existing setup check, add:

```ts
  const discoverCandidates = ctx.discoverLaunchCandidates ?? (() => defaultDiscoverLaunchCandidates(ctx))
  const candidates = await discoverCandidates()
  const savedRemoteReachable = desktopConfig.serverMode === 'remote' && !!desktopConfig.remoteUrl
    ? await checkRemoteReachable(ctx, desktopConfig.remoteUrl)
    : false
  const launchAction = chooseLaunchAction({ desktopConfig, candidates, savedRemoteReachable })

  if (launchAction.type === 'show-setup') {
    return { type: 'wizard' }
  }

  if (launchAction.type === 'show-chooser') {
    return {
      type: 'chooser',
      candidates: launchAction.candidates,
      reason: launchAction.reason,
    }
  }

  if (launchAction.type === 'auto-connect') {
    return loadMainWindow(ctx, launchAction.candidate.url, launchAction.candidate.token)
  }
```

Add this helper above `runStartup()`:

```ts
async function checkRemoteReachable(ctx: StartupContext, remoteUrl: string): Promise<boolean> {
  const fetchFn = ctx.fetchHealthCheck ?? (async (url: string) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(url, { signal: controller.signal })
      return response.ok
    } finally {
      clearTimeout(timer)
    }
  })

  try {
    return await fetchFn(`${remoteUrl}/api/health`)
  } catch {
    return false
  }
}
```

Then replace the old final window-loading block with:

```ts
  let authToken: string | undefined

  if (desktopConfig.serverMode === 'remote') {
    authToken = desktopConfig.remoteToken
  } else if (ctx.readEnvToken) {
    authToken = await ctx.readEnvToken(path.join(ctx.configDir, '.env'))
  }

  return loadMainWindow(ctx, serverUrl, authToken)
```

- [ ] **Step 7: Verify startup tests pass**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/startup.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add electron/startup.ts test/unit/electron/startup.test.ts
git commit -m "feat(electron): integrate launch discovery into startup"
```

---

### Task 6: Chooser Logic and UI

**Files:**
- Create: `electron/launch-chooser/index.html`
- Create: `electron/launch-chooser/main.tsx`
- Create: `electron/launch-chooser/chooser.tsx`
- Create: `electron/launch-chooser/chooser-logic.ts`
- Create: `test/unit/electron/launch-chooser/chooser-logic.test.ts`
- Modify: `electron/preload.ts`
- Modify: `test/unit/electron/preload.test.ts`

- [ ] **Step 1: Write failing chooser logic tests**

Create `test/unit/electron/launch-chooser/chooser-logic.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildConnectChoice,
  buildRemoteChoice,
  buildStartLocalChoice,
  validateRemoteLaunchUrl,
} from '../../../../electron/launch-chooser/chooser-logic.js'

describe('launch chooser logic', () => {
  it('validates remote launch URLs', () => {
    expect(validateRemoteLaunchUrl('http://10.0.0.5:3001')).toBe('')
    expect(validateRemoteLaunchUrl('https://freshell.internal')).toBe('')
    expect(validateRemoteLaunchUrl('localhost:3001')).toBe('Enter a valid http or https URL')
    expect(validateRemoteLaunchUrl('ftp://example.com')).toBe('Enter a valid http or https URL')
  })

  it('builds a connect choice', () => {
    expect(buildConnectChoice({
      url: 'http://localhost:3001',
      token: 'local-token',
      alwaysAskOnLaunch: true,
      remember: true,
    })).toEqual({
      kind: 'connect',
      url: 'http://localhost:3001',
      token: 'local-token',
      alwaysAskOnLaunch: true,
      remember: true,
    })
  })

  it('builds a remote choice', () => {
    expect(buildRemoteChoice({
      url: 'http://10.0.0.5:3001/',
      token: 'vpn-token',
      alwaysAskOnLaunch: false,
      remember: true,
    })).toEqual({
      kind: 'remote',
      url: 'http://10.0.0.5:3001',
      token: 'vpn-token',
      alwaysAskOnLaunch: false,
      remember: true,
    })
  })

  it('builds a start-local choice', () => {
    expect(buildStartLocalChoice({
      port: 3003,
      alwaysAskOnLaunch: false,
      remember: true,
    })).toEqual({
      kind: 'start-local',
      port: 3003,
      alwaysAskOnLaunch: false,
      remember: true,
    })
  })
})
```

- [ ] **Step 2: Run the failing chooser logic tests**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/launch-chooser/chooser-logic.test.ts --run
```

Expected: FAIL because chooser logic does not exist.

- [ ] **Step 3: Implement chooser logic**

Create `electron/launch-chooser/chooser-logic.ts`:

```ts
import { normalizeServerUrl } from '../launch-discovery.js'
import type { LaunchChoice } from '../types.js'

export function validateRemoteLaunchUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Enter a valid http or https URL'
    }
    return ''
  } catch {
    return 'Enter a valid http or https URL'
  }
}

export function buildConnectChoice(input: {
  url: string
  token?: string
  alwaysAskOnLaunch: boolean
  remember: boolean
}): LaunchChoice {
  return {
    kind: 'connect',
    url: normalizeServerUrl(input.url),
    token: input.token,
    alwaysAskOnLaunch: input.alwaysAskOnLaunch,
    remember: input.remember,
  }
}

export function buildRemoteChoice(input: {
  url: string
  token: string
  alwaysAskOnLaunch: boolean
  remember: boolean
}): LaunchChoice {
  return {
    kind: 'remote',
    url: normalizeServerUrl(input.url),
    token: input.token,
    alwaysAskOnLaunch: input.alwaysAskOnLaunch,
    remember: input.remember,
  }
}

export function buildStartLocalChoice(input: {
  port: number
  alwaysAskOnLaunch: boolean
  remember: boolean
}): LaunchChoice {
  return {
    kind: 'start-local',
    port: input.port,
    alwaysAskOnLaunch: input.alwaysAskOnLaunch,
    remember: input.remember,
  }
}
```

- [ ] **Step 4: Implement chooser renderer**

Create `electron/launch-chooser/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Freshell Launch</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

Create `electron/launch-chooser/main.tsx`:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import './chooser.css'
import { LaunchChooser } from './chooser.js'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LaunchChooser />
  </React.StrictMode>,
)
```

Create `electron/launch-chooser/chooser.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { LaunchChoice, LaunchServerCandidate } from '../types.js'
import {
  buildConnectChoice,
  buildRemoteChoice,
  buildStartLocalChoice,
  validateRemoteLaunchUrl,
} from './chooser-logic.js'

declare global {
  interface Window {
    freshellDesktop?: {
      getLaunchOptions: () => Promise<{ candidates: LaunchServerCandidate[]; reason: string; alwaysAskOnLaunch: boolean; port: number }>
      chooseLaunchOption: (choice: LaunchChoice) => Promise<void>
    }
  }
}

export function LaunchChooser() {
  const [candidates, setCandidates] = useState<LaunchServerCandidate[]>([])
  const [reason, setReason] = useState('')
  const [port, setPort] = useState(3001)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteToken, setRemoteToken] = useState('')
  const [alwaysAskOnLaunch, setAlwaysAskOnLaunch] = useState(false)
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.freshellDesktop?.getLaunchOptions().then((options) => {
      setCandidates(options.candidates)
      setReason(options.reason)
      setAlwaysAskOnLaunch(options.alwaysAskOnLaunch)
      setPort(options.port)
    })
  }, [])

  const choose = async (choice: LaunchChoice) => {
    setError('')
    await window.freshellDesktop?.chooseLaunchOption(choice)
  }

  const connectRemote = async () => {
    const validation = validateRemoteLaunchUrl(remoteUrl)
    if (validation) {
      setError(validation)
      return
    }
    await choose(buildRemoteChoice({ url: remoteUrl, token: remoteToken, alwaysAskOnLaunch, remember }))
  }

  return (
    <main className="launch-shell">
      <section className="launch-panel" aria-labelledby="launch-title">
        <h1 id="launch-title">Choose Freshell server</h1>
        <p className="launch-reason">{reason}</p>

        <div className="launch-section">
          <h2>Local servers</h2>
          {candidates.length === 0 ? (
            <p>No running local Freshell servers were detected.</p>
          ) : (
            <ul>
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <div>
                    <strong>{candidate.label ?? candidate.url}</strong>
                    <span>{candidate.version ? `Version ${candidate.version}` : candidate.url}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => choose(buildConnectChoice({
                      url: candidate.url,
                      token: candidate.token,
                      alwaysAskOnLaunch,
                      remember,
                    }))}
                  >
                    Connect
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="launch-section">
          <h2>Remote server</h2>
          <label>
            URL
            <input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="http://10.0.0.5:3001" />
          </label>
          <label>
            Token
            <input value={remoteToken} onChange={(event) => setRemoteToken(event.target.value)} type="password" />
          </label>
          <button type="button" onClick={connectRemote}>Connect remote</button>
        </div>

        <div className="launch-section">
          <h2>New local server</h2>
          <label>
            Port
            <input type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} />
          </label>
          <button type="button" onClick={() => choose(buildStartLocalChoice({ port, alwaysAskOnLaunch, remember }))}>
            Start local
          </button>
        </div>

        <div className="launch-options">
          <label>
            <input type="checkbox" checked={alwaysAskOnLaunch} onChange={(event) => setAlwaysAskOnLaunch(event.target.checked)} />
            Always ask on launch
          </label>
          <label>
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Remember this choice
          </label>
        </div>

        {error ? <p role="alert" className="launch-error">{error}</p> : null}
      </section>
    </main>
  )
}
```

Create `electron/launch-chooser/chooser.css`:

```css
body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #101418;
  color: #f4f7fa;
}

.launch-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.launch-panel {
  width: min(720px, 100%);
  border: 1px solid #2f3842;
  border-radius: 8px;
  padding: 24px;
  background: #171d23;
}

.launch-panel h1,
.launch-panel h2 {
  margin: 0 0 12px;
}

.launch-reason {
  color: #b9c3ce;
}

.launch-section {
  border-top: 1px solid #2f3842;
  padding: 16px 0;
}

.launch-section ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.launch-section li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
}

.launch-section span {
  display: block;
  color: #b9c3ce;
  font-size: 13px;
}

label {
  display: grid;
  gap: 6px;
  margin: 10px 0;
}

input {
  min-height: 36px;
  border: 1px solid #3d4854;
  border-radius: 6px;
  padding: 0 10px;
  color: #f4f7fa;
  background: #0f1419;
}

button {
  min-height: 36px;
  border: 1px solid #56616d;
  border-radius: 6px;
  padding: 0 14px;
  color: #f4f7fa;
  background: #244d7a;
}

.launch-options {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.launch-options label {
  display: flex;
  align-items: center;
}

.launch-error {
  color: #ffb4b4;
}
```

- [ ] **Step 5: Expose chooser preload APIs**

Update `electron/preload.ts` so `window.freshellDesktop` includes:

```ts
  getLaunchOptions: () => ipcRenderer.invoke('get-launch-options'),
  chooseLaunchOption: (choice: LaunchChoice) => ipcRenderer.invoke('choose-launch-option', choice),
```

Also import `type { LaunchChoice } from './types.js'`.

- [ ] **Step 6: Add preload test coverage**

Add assertions to `test/unit/electron/preload.test.ts` that the exposed API has `getLaunchOptions` and `chooseLaunchOption`, and that each calls `ipcRenderer.invoke()` with `get-launch-options` and `choose-launch-option`.

- [ ] **Step 7: Verify chooser and preload tests pass**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/launch-chooser/chooser-logic.test.ts test/unit/electron/preload.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add electron/launch-chooser electron/preload.ts test/unit/electron/launch-chooser/chooser-logic.test.ts test/unit/electron/preload.test.ts
git commit -m "feat(electron): add launch chooser renderer"
```

---

### Task 7: Entry IPC and Choice Application

**Files:**
- Modify: `electron/entry.ts`
- Modify: `test/unit/electron/main.test.ts`

- [ ] **Step 1: Write failing entry tests**

Add tests in `test/unit/electron/main.test.ts` or the existing entry test file that verify:

```ts
it('registers launch chooser IPC handlers before showing chooser', async () => {
  const ipcMain = createMockIpcMain()
  await mainWithMocks({
    ipcMain,
    runStartupResult: {
      type: 'chooser',
      candidates: [{ id: 'local-a', url: 'http://localhost:3001', origin: 'port-scan', ownership: 'detected-local' }],
      reason: 'always-ask',
    },
  })

  expect(ipcMain.handle).toHaveBeenCalledWith('get-launch-options', expect.any(Function))
  expect(ipcMain.handle).toHaveBeenCalledWith('choose-launch-option', expect.any(Function))
})

it('persists remote launch choice and restarts startup', async () => {
  const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
  const restartMain = vi.fn().mockResolvedValue(undefined)
  const handler = createChooseLaunchOptionHandler({ patchDesktopConfig, restartMain })

  await handler({}, {
    kind: 'remote',
    url: 'http://10.0.0.5:3001',
    token: 'vpn-token',
    alwaysAskOnLaunch: true,
    remember: true,
  })

  expect(patchDesktopConfig).toHaveBeenCalledWith({
    serverMode: 'remote',
    remoteUrl: 'http://10.0.0.5:3001',
    remoteToken: 'vpn-token',
    alwaysAskOnLaunch: true,
    setupCompleted: true,
  })
  expect(restartMain).toHaveBeenCalled()
})
```

If the current `main.test.ts` does not expose helpers like `mainWithMocks`, first extract pure `createChooseLaunchOptionHandler()` from `electron/entry.ts` and test that function directly.

- [ ] **Step 2: Run the failing entry tests**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/main.test.ts --run
```

Expected: FAIL because chooser IPC is not registered.

- [ ] **Step 3: Implement chooser window and handlers**

In `electron/entry.ts`, remove existing handlers before registration:

```ts
  ipcMain.removeHandler('get-launch-options')
  ipcMain.removeHandler('choose-launch-option')
```

Register:

```ts
  let pendingLaunchChooser: { candidates: LaunchServerCandidate[]; reason: string } | undefined

  ipcMain.handle('get-launch-options', () => ({
    candidates: pendingLaunchChooser?.candidates ?? [],
    reason: pendingLaunchChooser?.reason ?? 'Choose how Freshell should connect.',
    alwaysAskOnLaunch: desktopConfig.alwaysAskOnLaunch,
    port: desktopConfig.port,
  }))

  ipcMain.handle('choose-launch-option', async (_event, choice: LaunchChoice) => {
    if (choice.kind === 'remote') {
      await patchDesktopConfig({
        serverMode: 'remote',
        remoteUrl: choice.url,
        remoteToken: choice.token,
        alwaysAskOnLaunch: choice.alwaysAskOnLaunch,
        setupCompleted: true,
      })
    } else if (choice.kind === 'connect') {
      await patchDesktopConfig({
        serverMode: 'remote',
        remoteUrl: choice.url,
        remoteToken: choice.token,
        alwaysAskOnLaunch: choice.alwaysAskOnLaunch,
        setupCompleted: true,
      })
    } else {
      await patchDesktopConfig({
        serverMode: 'app-bound',
        port: choice.port ?? desktopConfig.port,
        alwaysAskOnLaunch: choice.alwaysAskOnLaunch,
        setupCompleted: true,
      })
    }

    setTimeout(() => {
      main().catch((err) => {
        console.error('Failed to restart after launch choice:', err)
      })
    }, 250)
  })
```

When startup returns chooser:

```ts
  if (result.type === 'chooser') {
    pendingLaunchChooser = {
      candidates: result.candidates,
      reason: result.reason,
    }

    const chooserWin = new BrowserWindow({
      width: 760,
      height: 720,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    if (isDev) {
      await chooserWin.loadURL('http://localhost:5174')
    } else {
      await chooserWin.loadFile(path.join(__dirname, 'launch-chooser', 'index.html'))
    }
    chooserWin.show()
    return
  }
```

- [ ] **Step 4: Verify entry tests pass**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/main.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add electron/entry.ts test/unit/electron/main.test.ts
git commit -m "feat(electron): wire launch chooser IPC"
```

---

### Task 8: Server Health Metadata

**Files:**
- Modify: `server/index.ts`
- Modify: `test/unit/server/api.test.ts`

- [ ] **Step 1: Write failing health metadata test**

Add to `test/unit/server/api.test.ts` in the `/api/health` describe block:

```ts
    it('returns launch discovery metadata without requiring auth', async () => {
      const res = await request(app).get('/api/health')

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        app: 'freshell',
        ok: true,
        requiresAuth: true,
      })
      expect(typeof res.body.version).toBe('string')
      expect(typeof res.body.ready).toBe('boolean')
      expect(typeof res.body.instanceId).toBe('string')
      expect(typeof res.body.startedAt).toBe('string')
    })
```

- [ ] **Step 2: Run the failing server test**

Run:

```bash
CI=true npm run test:vitest -- test/unit/server/api.test.ts --run
```

Expected: FAIL because `instanceId`, `startedAt`, and `requiresAuth` are absent.

- [ ] **Step 3: Add health metadata**

Near server startup state creation in `server/index.ts`, add stable values:

```ts
  const healthStartedAt = new Date().toISOString()
  const healthInstanceId = serverInstanceId
```

Move this after `serverInstanceId` is initialized, or use a local UUID before the route if the route cannot be moved. Then update `/api/health`:

```ts
  app.get('/api/health', (_req, res) => {
    res.json({
      app: 'freshell',
      ok: true,
      version: APP_VERSION,
      ready: startupState.isReady(),
      instanceId: healthInstanceId,
      startedAt: healthStartedAt,
      requiresAuth: true,
    })
  })
```

If `serverInstanceId` is initialized after route registration and moving the route would be invasive, use:

```ts
  const healthStartedAt = new Date().toISOString()
  const healthInstanceId = crypto.randomUUID()
```

and import `crypto` from `node:crypto`.

- [ ] **Step 4: Verify server test passes**

Run:

```bash
CI=true npm run test:vitest -- test/unit/server/api.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add server/index.ts test/unit/server/api.test.ts
git commit -m "feat(server): expose launch metadata in health check"
```

---

### Task 9: Build Wiring

**Files:**
- Modify: `package.json`
- Modify: `config/electron-builder.yml`
- Modify: `test/unit/electron/electron-builder-config.test.ts`

- [ ] **Step 1: Write failing build config tests**

Add to `test/unit/electron/electron-builder-config.test.ts`:

```ts
  it('packages the launch chooser renderer assets', () => {
    const config = loadConfig()
    expect(config.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'dist/launch-chooser',
          to: 'launch-chooser',
        }),
      ]),
    )
  })
```

- [ ] **Step 2: Run failing build config test**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/electron-builder-config.test.ts --run
```

Expected: FAIL because launch chooser assets are not packaged.

- [ ] **Step 3: Wire build scripts**

Modify `package.json` scripts:

```json
"build:launch-chooser": "vite build --config config/vite/vite.launch-chooser.config.ts",
"electron:build": "npm run build && npm run build:electron && npm run build:wizard && npm run build:launch-chooser && npm run prepare:bundled-node && electron-builder",
"electron:build:win": "tsx scripts/assert-native-windows-build.ts && npm run build && npm run build:electron && npm run build:wizard && npm run build:launch-chooser && npm run prepare:bundled-node && electron-builder --win nsis portable --publish never"
```

Create `config/vite/vite.launch-chooser.config.ts` if the existing wizard Vite config cannot be parameterized:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'electron/launch-chooser'),
  build: {
    outDir: path.resolve(__dirname, 'dist/launch-chooser'),
    emptyOutDir: true,
  },
})
```

- [ ] **Step 4: Package launch chooser assets**

Modify `config/electron-builder.yml` `extraResources`:

```yaml
  - from: dist/launch-chooser
    to: launch-chooser
```

- [ ] **Step 5: Verify build config tests pass**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/electron-builder-config.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add package.json package-lock.json config/electron-builder.yml config/vite/vite.launch-chooser.config.ts test/unit/electron/electron-builder-config.test.ts
git commit -m "build(electron): package launch chooser"
```

---

### Task 10: Electron E2E Coverage

**Files:**
- Modify: `test/e2e-electron/electron-app.test.ts`

- [ ] **Step 1: Add e2e test for always-ask chooser**

Add a test that writes desktop config with `alwaysAskOnLaunch: true`, starts the Electron app against the running test server, and asserts the chooser appears instead of the main app:

```ts
test('shows launch chooser when alwaysAskOnLaunch is true', async () => {
  const tmpHome = await createTempHome()
  await writeDesktopConfig(tmpHome, {
    serverMode: 'remote',
    port: 3001,
    remoteUrl: serverInfo.baseUrl,
    remoteToken: getRunningServerToken(),
    knownServers: [],
    alwaysAskOnLaunch: true,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: true,
  })

  const app = await launchElectron({ tmpHome })
  const chooser = await app.firstWindow()

  await expect(chooser.getByRole('heading', { name: 'Choose Freshell server' })).toBeVisible()
  await expect(chooser.getByRole('checkbox', { name: 'Always ask on launch' })).toBeChecked()

  await app.close()
})
```

- [ ] **Step 2: Add e2e test for connecting to existing server**

Add:

```ts
test('connects to an existing server selected from chooser', async () => {
  const tmpHome = await createTempHome()
  await writeDesktopConfig(tmpHome, {
    serverMode: 'app-bound',
    port: 3001,
    knownServers: [{ url: serverInfo.baseUrl, label: 'Test server' }],
    alwaysAskOnLaunch: true,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: true,
  })

  const app = await launchElectron({ tmpHome })
  const chooser = await app.firstWindow()

  await chooser.getByRole('button', { name: 'Connect' }).first().click()
  const mainWindow = await app.waitForEvent('window')

  await expect(mainWindow).toHaveURL(new RegExp(serverInfo.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  await app.close()
})
```

- [ ] **Step 3: Run Electron e2e tests**

Run:

```bash
CI=true npm run test:e2e-electron -- --run
```

Expected: PASS. If this repo does not expose `test:e2e-electron`, use the existing command already used by this file in `package.json`.

- [ ] **Step 4: Commit**

Run:

```bash
git add test/e2e-electron/electron-app.test.ts
git commit -m "test(electron): cover launch chooser startup"
```

---

### Task 11: Final Verification

**Files:**
- No source edits unless verification finds a defect.

- [ ] **Step 1: Run focused Electron unit tests**

Run:

```bash
CI=true npm run test:vitest -- --config config/vitest/vitest.electron.config.ts \
  test/unit/electron/desktop-config.test.ts \
  test/unit/electron/launch-discovery.test.ts \
  test/unit/electron/token-resolver.test.ts \
  test/unit/electron/launch-policy.test.ts \
  test/unit/electron/startup.test.ts \
  test/unit/electron/launch-chooser/chooser-logic.test.ts \
  test/unit/electron/preload.test.ts \
  test/unit/electron/electron-builder-config.test.ts \
  --run
```

Expected: PASS.

- [ ] **Step 2: Run focused server unit test**

Run:

```bash
CI=true npm run test:vitest -- test/unit/server/api.test.ts --run
```

Expected: PASS.

- [ ] **Step 3: Run coordinated check**

Run:

```bash
FRESHELL_TEST_SUMMARY="electron launch connection chooser" CI=true npm run check
```

Expected: PASS. If the coordinator reports another holder, wait and rerun; do not kill the holder.

- [ ] **Step 4: Build Electron assets**

Run:

```bash
CI=true npm run build:electron
CI=true npm run build:wizard
CI=true npm run build:launch-chooser
```

Expected: all commands exit 0.

- [ ] **Step 5: Build Windows artifacts from a Windows-local temp path**

Run the existing native Windows build process from a Windows-local path, not from the WSL UNC path:

```bash
CI=true npm run electron:build:win
```

Expected: `release/Freshell Setup 0.7.0.exe` and `release/Freshell 0.7.0.exe` are produced.

- [ ] **Step 6: Smoke test local startup choices**

Run the packaged app with three configs:

```json
{
  "serverMode": "app-bound",
  "port": 3001,
  "knownServers": [],
  "alwaysAskOnLaunch": false,
  "globalHotkey": "CommandOrControl+`",
  "startOnLogin": false,
  "minimizeToTray": true,
  "setupCompleted": true
}
```

Expected: bundled local server starts and main window appears.

```json
{
  "serverMode": "app-bound",
  "port": 3001,
  "knownServers": [],
  "alwaysAskOnLaunch": true,
  "globalHotkey": "CommandOrControl+`",
  "startOnLogin": false,
  "minimizeToTray": true,
  "setupCompleted": true
}
```

Expected: chooser appears and “Start local” starts the bundled local server.

```json
{
  "serverMode": "remote",
  "port": 3001,
  "remoteUrl": "http://10.0.0.5:3001",
  "remoteToken": "test-token",
  "knownServers": [],
  "alwaysAskOnLaunch": false,
  "globalHotkey": "CommandOrControl+`",
  "startOnLogin": false,
  "minimizeToTray": true,
  "setupCompleted": true
}
```

Expected: reachable remote connects; unreachable remote opens chooser with remote option available.

- [ ] **Step 7: Commit verification fixes or create final commit**

If verification required changes:

```bash
git add <changed-files>
git commit -m "fix(electron): harden launch chooser verification issues"
```

If no changes were required, do not create an empty commit.

---

## Self-Review

- Spec coverage: The plan covers detecting local servers, connecting to one existing server, choosing among multiple local servers, connecting to a remote/VPN server, starting a new local bundled server, and adding a default-false “always ask” setting.
- Token handling: The plan covers saved desktop tokens first, then local loopback-only token lookup from `.env` and `config.json`, then chooser prompt for missing tokens. It explicitly avoids using local tokens for remote URLs.
- Ownership safety: The plan keeps detected local servers as `detected-local`, remote servers as `remote`, and app-bound starts as Electron-owned via existing `serverSpawner`. It does not add process management for detected servers.
- Placeholder scan: No steps rely on “add tests for this” or undefined behavior; each code task includes concrete test or implementation content.
- Type consistency: `alwaysAskOnLaunch`, `knownServers`, `LaunchServerCandidate`, and `LaunchChoice` are introduced in Task 1 and reused consistently in later tasks.
