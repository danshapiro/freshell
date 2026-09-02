# Electron Multi-Profile Support Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Two or more Freshell desktop clients can run on one machine at the
same time, each pinned to its own profile (own settings, storage, window
state, possibly different servers), with a picker at launch when a text-file
registry defines more than one choice.

**Architecture:** A new pure `electron/profile.ts` resolves the active profile
from `--profile=<id>` / `FRESHELL_PROFILE` (precedence: argv > env > picker >
default) and derives per-profile paths: config dir `~/.freshell-<id>` and
Electron userData `<appData>/<AppName>-<id>` (the default profile keeps
today's exact paths). `entry.ts` resolves the profile at module top and calls
`app.setPath('userData', ...)` for named profiles before `app.whenReady()` —
which also re-keys Electron's single-instance lock per profile for free. The
instance lock is acquired early (new `acquireInstanceLock`), before any side
effects. A machine-global registry `~/.freshell/profiles.json` (zod-validated)
lists named profiles; when at least one exists and no explicit profile was
given, a new profile-picker window (built and packaged exactly like the
launch chooser) lets the user pick the default profile (continues in-process)
or a named profile (relaunches with `--profile=<id>`). App-bound spawned
servers receive `FRESHELL_CONFIG_DIR` whose support is added to
`server/freshell-home.ts`.

**Tech Stack:** Electron (main process ESM/NodeNext), React 18 + Vite (picker
renderer), Zod, Vitest, Playwright `_electron`.

## User Request

> Run two electron clients on the same machine pointed at different servers: fix the blockers (single-instance lock, namespaced userData + config dir per profile) plus a profile picker at launch when more than one profile is configured in a text file. Implement with the-usual.

## Global Constraints

- **Backward-compat invariant:** with no `--profile`, no `FRESHELL_PROFILE`,
  and no registry file, behavior is identical to today: same paths
  (`~/.freshell`, default Electron userData), same boot flow, same windows. The
  default profile never calls `app.setPath('userData', ...)` at all.
- Profile id grammar: `^[a-z0-9][a-z0-9-]{0,31}$`; id `default` is reserved
  (means today's un-namespaced environment). The registry is machine-global
  and always lives at `~/.freshell/profiles.json` (never inside a profile dir).
- An explicit named profile id need NOT be present in the registry; unlisted
  ids simply start with a fresh, empty profile. The picker lists `Default`
  first, then the registry entries.
- Server code is NodeNext/ESM; relative imports must include `.js` extensions.
  New electron modules follow the DI convention (logic in `electron/*.js`
  modules, unit-testable without importing `electron`), zod at every file/IPC
  boundary.
- Picker UI is accessible: semantic buttons with visible names, heading, and
  `role="alert"` for errors (repo a11y requirements).
- Focused test commands go through the repo-owned path:
  `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts <files> --run`
  for electron tests, and `npm run test:vitest -- run <file>` for
  auto-routed client/server unit tests. Electron tests always run locally.
- Picker dev-server port: **5179** (5173/5174/5175 are taken by the main app,
  wizard, and launch chooser; 5176 is referenced by demo tooling).
- Do not restart or kill the self-hosted Freshell server. Never use broad
  pkill patterns. Do not touch daemon service definitions (daemon mode stays
  a machine-global singleton; documented as a limitation).
- Conventional commit messages; focused commits per task.
- `AGENTS.md`/`docs/index.html` do not describe desktop-app internals; no
  changes needed there. End-user documentation goes in `README.md`.

---

### Task 1: Config-dir seam in `desktop-config` and `window-state`

`desktop-config.ts` currently hardcodes `~/.freshell` in module-private
helpers and serializes ALL writes through one module-level mutex. Profiles
require: an optional per-call `configDir` override (default unchanged) and a
per-directory mutex so two profiles never block each other. `window-state.ts`
must pass a `configDir` through. Existing tests (which mock `os.homedir` and
call without the new arg) must keep passing UNCHANGED.

**Files:**
- Modify: `electron/desktop-config.ts` (whole-file rewrite shown below)
- Modify: `electron/window-state.ts` (`createWindowStatePersistence(configDir?)`)
- Test: `test/unit/electron/desktop-config.profiles.test.ts` (new)
- Test: `test/unit/electron/window-state.configdir.test.ts` (new)

**Interfaces:**
- Consumes: `electron/types.ts` `DesktopConfigSchema` (unchanged).
- Produces: `readDesktopConfig(configDir?)`, `writeDesktopConfig(config, configDir?)`,
  `patchDesktopConfig(patch, configDir?)`, `_resetMutexForTesting()`;
  `createWindowStatePersistence(configDir?)` — all defaults identical to today.

- [ ] **Step 1: Write the failing behavioral test**

SAFETY: these tests must mock `os.homedir` (same `vi.hoisted` + `vi.mock('os')`
pattern as the existing `test/unit/electron/desktop-config.test.ts:8-22`).
Without the mock, a red-phase run (production code ignoring the new arg) would
write to the REAL `~/.freshell/desktop.json` on the dev machine. The mock
keeps every fallback path inside a per-test temp dir.

```ts
// test/unit/electron/desktop-config.profiles.test.ts
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockState = vi.hoisted(() => ({ homeDir: '' }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    default: { ...actual, homedir: () => mockState.homeDir },
    homedir: () => mockState.homeDir,
  }
})

import {
  getDefaultDesktopConfig,
  patchDesktopConfig,
  readDesktopConfig,
  writeDesktopConfig,
  _resetMutexForTesting,
} from '../../../electron/desktop-config.js'

// NOTE: `os.tmpdir()` still resolves to the REAL temp dir because the mock
// spreads `importOriginal` — only `homedir()` is overridden.

describe('desktop-config with explicit configDir', () => {
  let homeDir: string
  let dirA: string
  let dirB: string

  beforeEach(async () => {
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-home-'))
    mockState.homeDir = homeDir
    dirA = path.join(homeDir, '.freshell-work')
    dirB = path.join(homeDir, '.freshell-home')
    _resetMutexForTesting()
  })

  afterEach(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true })
    _resetMutexForTesting()
  })

  it('readDesktopConfig returns null when the given dir has no config', async () => {
    expect(await readDesktopConfig(dirA)).toBeNull()
  })

  it('write then read roundtrips inside the given dir only', async () => {
    const config = {
      ...getDefaultDesktopConfig(),
      setupCompleted: true,
      serverMode: 'remote' as const,
      remoteUrl: 'http://a.example',
    }
    await writeDesktopConfig(config, dirA)
    expect(await readDesktopConfig(dirA)).toEqual(config)
    expect(await readDesktopConfig(dirB)).toBeNull()
  })

  it('patched state stays within its own directory', async () => {
    await patchDesktopConfig({ globalHotkey: 'CommandOrControl+1' }, dirA)
    await patchDesktopConfig({ globalHotkey: 'CommandOrControl+2' }, dirB)
    expect((await readDesktopConfig(dirA))?.globalHotkey).toBe('CommandOrControl+1')
    expect((await readDesktopConfig(dirB))?.globalHotkey).toBe('CommandOrControl+2')
  })

  it('concurrent patches on the same dir are serialized and both apply', async () => {
    await Promise.all([
      patchDesktopConfig({ serverMode: 'remote', remoteUrl: 'http://a.example' }, dirA),
      patchDesktopConfig({ globalHotkey: 'CommandOrControl+9' }, dirA),
    ])
    const config = await readDesktopConfig(dirA)
    expect(config?.serverMode).toBe('remote')
    expect(config?.globalHotkey).toBe('CommandOrControl+9')
  })
})
```

`window-state.configdir.test.ts` uses the same mock pattern. Note the worktree
`os` mock MUST preserve `tmpdir()` (real temp dir) — the spread of
`importOriginal` above does that:

```ts
// test/unit/electron/window-state.configdir.test.ts
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockState = vi.hoisted(() => ({ homeDir: '' }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    default: { ...actual, homedir: () => mockState.homeDir },
    homedir: () => mockState.homeDir,
  }
})

import { createWindowStatePersistence } from '../../../electron/window-state.js'
import { readDesktopConfig, _resetMutexForTesting } from '../../../electron/desktop-config.js'

describe('window-state with explicit configDir', () => {
  let homeDir: string
  let dir: string

  beforeEach(async () => {
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-profile-'))
    mockState.homeDir = homeDir
    dir = path.join(homeDir, '.freshell-work')
    _resetMutexForTesting()
  })

  afterEach(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true })
    _resetMutexForTesting()
  })

  it('loads defaults when the dir has no config', async () => {
    const persistence = createWindowStatePersistence(dir)
    expect(await persistence.load()).toEqual({ width: 1200, height: 800, maximized: false })
  })

  it('saves window state into the given dir', async () => {
    const persistence = createWindowStatePersistence(dir)
    await persistence.save({ x: 1, y: 2, width: 1000, height: 700, maximized: true })
    const config = await readDesktopConfig(dir)
    expect(config?.windowState).toEqual({ x: 1, y: 2, width: 1000, height: 700, maximized: true })
  })
})
```

Red-phase expectation detail: with the mock installed, a NO-param call falls
back to `<mocked home>/.freshell` (a temp dir), so the red failure is an
assertion mismatch inside temp space — never a write outside the sandbox.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/desktop-config.profiles.test.ts test/unit/electron/window-state.configdir.test.ts --run`

Expected: FAIL because the current signatures have no `configDir`/`dir`
parameter — calls fall back to the (mocked, temp) default `~/.freshell`, so
the cross-directory isolation assertions fail (e.g. dirB unexpectedly sees
dirA's config). The TypeScript call sites also surface excess-argument errors
once typechecked.

- [ ] **Step 3: Add the minimal production implementation**

Rewrite `electron/desktop-config.ts` as:

```ts
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { DesktopConfigSchema, type DesktopConfig } from './types.js'

const DESKTOP_CONFIG_FILENAME = 'desktop.json'

function defaultConfigDir(): string {
  return path.join(os.homedir(), '.freshell')
}

function resolveConfigDir(configDir?: string): string {
  return configDir ?? defaultConfigDir()
}

function getConfigPath(configDir?: string): string {
  return path.join(resolveConfigDir(configDir), DESKTOP_CONFIG_FILENAME)
}

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

export async function readDesktopConfig(configDir?: string): Promise<DesktopConfig | null> {
  const configPath = getConfigPath(configDir)
  try {
    const content = await fsp.readFile(configPath, 'utf-8')
    const parsed = JSON.parse(content)
    const result = DesktopConfigSchema.safeParse(parsed)
    if (!result.success) {
      return null
    }
    return result.data
  } catch {
    return null
  }
}

export async function writeDesktopConfig(config: DesktopConfig, configDir?: string): Promise<void> {
  const dir = resolveConfigDir(configDir)
  await fsp.mkdir(dir, { recursive: true })

  const configPath = getConfigPath(dir)
  const tmpPath = configPath + '.tmp'
  await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2))
  await fsp.rename(tmpPath, configPath)
}

// Per-directory mutex chains so two profiles' writes never serialize against
// each other while writes on the SAME directory stay ordered.
const mutexChains = new Map<string, Promise<void>>()

export async function patchDesktopConfig(
  patch: Partial<DesktopConfig>,
  configDir?: string,
): Promise<DesktopConfig> {
  const dir = resolveConfigDir(configDir)
  let result: DesktopConfig

  // Chain onto the existing mutex for THIS directory so concurrent calls on
  // the same dir run sequentially.
  const work = (mutexChains.get(dir) ?? Promise.resolve()).then(async () => {
    const existing = await readDesktopConfig(dir)
    const base = existing ?? getDefaultDesktopConfig()
    const merged = { ...base, ...patch }
    const validated = DesktopConfigSchema.parse(merged)
    await writeDesktopConfig(validated, dir)
    result = validated
  })

  // Update the chain — subsequent calls wait for this one to finish.
  mutexChains.set(dir, work.catch(() => {}))

  await work
  return result!
}

/**
 * Reset the internal mutex chains. Only for use in tests to ensure
 * inter-test isolation — the module-level mutex map holds references from
 * prior calls, which can leak state between test files.
 */
export function _resetMutexForTesting(): void {
  mutexChains.clear()
}
```

And change `electron/window-state.ts` to thread the config dir:

```ts
import { readDesktopConfig, patchDesktopConfig } from './desktop-config.js'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface WindowStatePersistence {
  /** Load persisted state, returning defaults if not found */
  load(): Promise<WindowState>

  /** Save current window state */
  save(state: { x: number; y: number; width: number; height: number; maximized: boolean }): Promise<void>
}

const DEFAULTS: WindowState = {
  width: 1200,
  height: 800,
  maximized: false,
}

export function createWindowStatePersistence(configDir?: string): WindowStatePersistence {
  return {
    async load(): Promise<WindowState> {
      const config = await readDesktopConfig(configDir)
      if (!config?.windowState) {
        return { ...DEFAULTS }
      }
      return {
        x: config.windowState.x,
        y: config.windowState.y,
        width: config.windowState.width ?? DEFAULTS.width,
        height: config.windowState.height ?? DEFAULTS.height,
        maximized: config.windowState.maximized ?? DEFAULTS.maximized,
      }
    },

    async save(state: { x: number; y: number; width: number; height: number; maximized: boolean }): Promise<void> {
      await patchDesktopConfig({ windowState: state }, configDir)
    },
  }
}
```

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/desktop-config.profiles.test.ts test/unit/electron/window-state.configdir.test.ts --run`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — the change is a pure cross-cutting parameter thread (desktop-config keeps
its structure; window-state keeps every line except `configDir` pass-through).

- [ ] **Step 6: Run impacted-test verification**

Impacted: every existing desktop-config / window-state consumer test.

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/desktop-config.test.ts test/unit/electron/window-state.test.ts test/unit/electron/desktop-provisioning.test.ts test/unit/electron/launch-choice-handler.test.ts test/unit/electron/startup.test.ts --run`

Expected: PASS with no modifications to those existing tests (the new params
are optional and defaults are unchanged).

- [ ] **Step 7: Commit the task**

```bash
git add electron/desktop-config.ts electron/window-state.ts \
  test/unit/electron/desktop-config.profiles.test.ts \
  test/unit/electron/window-state.configdir.test.ts \
  docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "refactor(electron): thread configDir through desktop-config and window-state"
```

---

### Task 2: Profile resolution core (`electron/profile.ts`)

Pure, DI-friendly module: no `electron` import, no I/O except via an injected
reader. This is the contract every later task consumes. First run of the new
test must fail because the module does not exist yet.

**Files:**
- Create: `electron/profile.ts`
- Test: `test/unit/electron/profile.test.ts`

**Interfaces:**
- Consumes: nothing repo-internal (only `path`, `zod`).
- Produces: `DEFAULT_PROFILE_ID`, `PROFILE_ID_PATTERN`, `ProfileEntry`,
  `ProfilesRegistrySchema`, `RegistryReadResult`, `ProfileSelection`,
  `ProfileSelectionResult`, `parseProfileArg(argv)`, `stripProfileArgs(argv)`,
  `resolveProfileSelection(argv, env)`, `configDirForProfile(id, homedir)`,
  `userDataDirForProfile(id, appName, appDataDir)`, `registryPathForHome(homedir)`,
  `readProfilesRegistry(path, readFile)`, `shouldShowProfilePicker(selection, registry)`,
  `buildPickerEntries(registry)`.

- [ ] **Step 1: Write the failing behavioral test**

```ts
// test/unit/electron/profile.test.ts
import os from 'os'
import path from 'path'
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROFILE_ID,
  buildPickerEntries,
  configDirForProfile,
  parseProfileArg,
  readProfilesRegistry,
  registryPathForHome,
  resolveProfileSelection,
  shouldShowProfilePicker,
  stripProfileArgs,
  userDataDirForProfile,
} from '../../../electron/profile.js'

describe('parseProfileArg', () => {
  it('parses --profile=<id>', () => {
    expect(parseProfileArg(['app', '--profile=work'])).toBe('work')
  })
  it('parses --profile <id>', () => {
    expect(parseProfileArg(['app', '--profile', 'work'])).toBe('work')
  })
  it('returns undefined when --profile has a flag-like or missing value', () => {
    expect(parseProfileArg(['app', '--profile', '--other'])).toBeUndefined()
    expect(parseProfileArg(['app', '--profile'])).toBeUndefined()
  })
  it('returns undefined when absent', () => {
    expect(parseProfileArg(['app'])).toBeUndefined()
  })
})

describe('stripProfileArgs', () => {
  it('removes both --profile forms and keeps everything else', () => {
    expect(stripProfileArgs(['--profile=work', '--foo', '--profile', 'home', 'bar']))
      .toEqual(['--foo', 'bar'])
  })
  it('drops a trailing bare --profile', () => {
    expect(stripProfileArgs(['--foo', '--profile'])).toEqual(['--foo'])
  })
})

describe('resolveProfileSelection', () => {
  it('defaults to the default profile, non-explicit', () => {
    expect(resolveProfileSelection(['app'], {})).toEqual({
      selection: { id: DEFAULT_PROFILE_ID, explicit: false, source: 'default' },
    })
  })
  it('argv wins over env', () => {
    const r = resolveProfileSelection(['app', '--profile=work'], { FRESHELL_PROFILE: 'home' })
    expect(r.selection).toEqual({ id: 'work', explicit: true, source: 'argv' })
  })
  it('uses FRESHELL_PROFILE when argv is absent', () => {
    const r = resolveProfileSelection(['app'], { FRESHELL_PROFILE: 'home' })
    expect(r.selection).toEqual({ id: 'home', explicit: true, source: 'env' })
  })
  it('treats empty FRESHELL_PROFILE as absent', () => {
    expect(resolveProfileSelection(['app'], { FRESHELL_PROFILE: '  ' }).selection.id)
      .toBe(DEFAULT_PROFILE_ID)
  })
  it('an explicit "default" suppresses the picker', () => {
    const r = resolveProfileSelection(['app', '--profile=default'], {})
    expect(r.selection).toEqual({ id: 'default', explicit: true, source: 'argv' })
    expect(r.error).toBeUndefined()
  })
  it('invalid ids fall back to default with an error', () => {
    const r = resolveProfileSelection(['app', '--profile=../evil'], {})
    expect(r.selection).toEqual({ id: DEFAULT_PROFILE_ID, explicit: false, source: 'default' })
    expect(r.error).toContain('../evil')
  })
})

describe('path derivation', () => {
  it('default profile keeps ~/.freshell and Electron-default userData', () => {
    expect(configDirForProfile('default', '/home/u')).toBe(path.join('/home/u', '.freshell'))
    expect(userDataDirForProfile('default', 'Freshell', '/app/data')).toBeUndefined()
  })
  it('named profiles get sibling dirs', () => {
    expect(configDirForProfile('work', '/home/u')).toBe(path.join('/home/u', '.freshell-work'))
    expect(userDataDirForProfile('work', 'Freshell', '/app/data'))
      .toBe(path.join('/app/data', 'Freshell-work'))
  })
  it('registry always lives in the default config dir', () => {
    expect(registryPathForHome('/home/u')).toBe(path.join('/home/u', '.freshell', 'profiles.json'))
  })
})

describe('readProfilesRegistry', () => {
  const missing = () => undefined
  const withFile = (content: string) => (_p: string) => content

  it('missing file means no profiles and no error', () => {
    expect(readProfilesRegistry('/x/profiles.json', missing)).toEqual({ profiles: [] })
  })
  it('invalid JSON is reported and ignored', () => {
    const r = readProfilesRegistry('/x/profiles.json', withFile('nope {{{'))
    expect(r.profiles).toEqual([])
    expect(r.error).toContain('not valid JSON')
  })
  it('schema violations are reported and ignored', () => {
    for (const bad of [
      { profiles: [{ id: 'BAD ID' }] },
      { profiles: [{ id: 'default' }] },
      { profiles: [{ id: 'a' }, { id: 'a' }] },
      { profiles: [] },
    ]) {
      const r = readProfilesRegistry('/x/profiles.json', withFile(JSON.stringify(bad)))
      expect(r.profiles).toEqual([])
      expect(r.error).toBeTruthy()
    }
  })
  it('accepts a valid registry', () => {
    const r = readProfilesRegistry('/x/profiles.json',
      withFile(JSON.stringify({ profiles: [{ id: 'work', label: 'Work' }, { id: 'home' }] })))
    expect(r.error).toBeUndefined()
    expect(r.profiles).toEqual([{ id: 'work', label: 'Work' }, { id: 'home' }])
  })
})

describe('picker predicates', () => {
  const registry = { profiles: [{ id: 'work' as const }] }
  it('shows only when selection is not explicit and registry is non-empty', () => {
    expect(shouldShowProfilePicker({ id: 'default', explicit: false, source: 'default' }, registry)).toBe(true)
    expect(shouldShowProfilePicker({ id: 'work', explicit: true, source: 'argv' }, registry)).toBe(false)
    expect(shouldShowProfilePicker({ id: 'default', explicit: false, source: 'default' }, { profiles: [] })).toBe(false)
  })
  it('buildPickerEntries lists Default first and falls back to the id as label', () => {
    expect(buildPickerEntries({ profiles: [{ id: 'work', label: 'Work' }, { id: 'home' }] }))
      .toEqual([
        { id: 'default', label: 'Default' },
        { id: 'work', label: 'Work' },
        { id: 'home', label: 'home' },
      ])
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/profile.test.ts --run`

Expected: FAIL because `../../../electron/profile.js` cannot be resolved (module
does not exist) — not because of a test-file syntax error.

- [ ] **Step 3: Add the minimal production implementation**

```ts
// electron/profile.ts
import path from 'path'
import { z } from 'zod'

export const DEFAULT_PROFILE_ID = 'default'

/**
 * Profile ids become directory names on every supported OS, so keep them
 * conservative: lowercase kebab-case, no path separators or dots (so no
 * '..' traversal), bounded length.
 */
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export const ProfileEntrySchema = z.object({
  id: z.string().regex(PROFILE_ID_PATTERN),
  label: z.string().trim().min(1).max(64).optional(),
})

export const ProfilesRegistrySchema = z.object({
  profiles: z.array(ProfileEntrySchema).min(1),
}).superRefine((value, ctx) => {
  const seen = new Set<string>()
  for (const entry of value.profiles) {
    if (entry.id === DEFAULT_PROFILE_ID) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `'${DEFAULT_PROFILE_ID}' is a reserved profile id` })
    }
    if (seen.has(entry.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate profile id '${entry.id}'` })
    }
    seen.add(entry.id)
  }
})

export type ProfileEntry = z.infer<typeof ProfileEntrySchema>

export type ProfileSource = 'argv' | 'env' | 'default'

export interface ProfileSelection {
  id: string
  explicit: boolean
  source: ProfileSource
}

export interface ProfileSelectionResult {
  selection: ProfileSelection
  /** Set when an explicitly requested id was invalid and default was substituted. */
  error?: string
}

/** Extract `--profile=<id>` or `--profile <id>` from a raw argv slice. */
export function parseProfileArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) return next
      return undefined
    }
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return undefined
}

/** Remove every `--profile=<id>` / `--profile <id>` pair from an argv slice. */
export function stripProfileArgs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--profile=')) continue
    if (arg === '--profile') {
      i++ // also drop its value if present
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * Resolve the active profile. Precedence: `--profile` argv > `FRESHELL_PROFILE`
 * env > (picker, by returning non-explicit default) > default.
 */
export function resolveProfileSelection(
  argv: string[],
  env: NodeJS.ProcessEnv,
): ProfileSelectionResult {
  const fromArgv = parseProfileArg(argv)
  const fromEnv = env.FRESHELL_PROFILE?.trim()
  const raw = fromArgv ?? (fromEnv ? fromEnv : undefined)
  const source: ProfileSource = fromArgv !== undefined ? 'argv' : raw !== undefined ? 'env' : 'default'
  if (raw === undefined) {
    return { selection: { id: DEFAULT_PROFILE_ID, explicit: false, source: 'default' } }
  }
  if (raw === DEFAULT_PROFILE_ID) {
    return { selection: { id: DEFAULT_PROFILE_ID, explicit: true, source } }
  }
  if (!PROFILE_ID_PATTERN.test(raw)) {
    return {
      selection: { id: DEFAULT_PROFILE_ID, explicit: false, source: 'default' },
      error: `Invalid profile id '${raw}' (must match ${PROFILE_ID_PATTERN}); using the default profile.`,
    }
  }
  return { selection: { id: raw, explicit: true, source } }
}

/** Profile config dir: `~/.freshell` for default, `~/.freshell-<id>` for named. */
export function configDirForProfile(id: string, homedir: string): string {
  if (id === DEFAULT_PROFILE_ID) return path.join(homedir, '.freshell')
  return path.join(homedir, `.freshell-${id}`)
}

/**
 * userData dir for a named profile. Returns undefined for the default
 * profile, meaning "leave Electron's default userData untouched".
 */
export function userDataDirForProfile(
  id: string,
  appName: string,
  appDataDir: string,
): string | undefined {
  if (id === DEFAULT_PROFILE_ID) return undefined
  return path.join(appDataDir, `${appName}-${id}`)
}

/** The registry is machine-global and always lives in the default config dir. */
export function registryPathForHome(homedir: string): string {
  return path.join(homedir, '.freshell', 'profiles.json')
}

export interface RegistryReadResult {
  profiles: ProfileEntry[]
  /** Set when a file existed but was unusable; profiles are then empty. */
  error?: string
}

/**
 * Read and validate the profile registry. A missing file is normal (no
 * profiles configured); a present-but-invalid file is an error the caller
 * should surface (log) while booting the default profile.
 */
export function readProfilesRegistry(
  registryPath: string,
  readFile: (p: string) => string | undefined,
): RegistryReadResult {
  const content = readFile(registryPath)
  if (content === undefined) return { profiles: [] }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(content)
  } catch {
    return { profiles: [], error: `Profile registry at ${registryPath} is not valid JSON; ignoring it.` }
  }
  const parsed = ProfilesRegistrySchema.safeParse(parsedJson)
  if (!parsed.success) {
    return { profiles: [], error: `Profile registry at ${registryPath} is invalid; ignoring it.` }
  }
  return { profiles: parsed.data.profiles }
}

/** The picker appears when the choice set (default + named) has >1 entries. */
export function shouldShowProfilePicker(
  selection: ProfileSelection,
  registry: RegistryReadResult,
): boolean {
  return !selection.explicit && registry.profiles.length >= 1
}

export interface PickerEntry {
  id: string
  label: string
}

/** Picker entries: the default profile first, then the registry in file order. */
export function buildPickerEntries(registry: RegistryReadResult): PickerEntry[] {
  return [
    { id: DEFAULT_PROFILE_ID, label: 'Default' },
    ...registry.profiles.map((p) => ({ id: p.id, label: p.label ?? p.id })),
  ]
}
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/profile.test.ts --run`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor expected; the module is already flat and single-purpose.

- [ ] **Step 6: Run impacted-test verification**

New module, no existing consumers. Impacted set = the whole electron unit
suite (cheap, guards against config/alias breakage).

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts --run`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add electron/profile.ts test/unit/electron/profile.test.ts docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "feat(electron): add profile resolution module"
```

---

### Task 3: Lock split, hotkey failure logging, tray tooltip, spawn env

Four small DI-module changes that profiles depend on. Default-path behavior
is unchanged for each. Note: `main.ts` today requests the single-instance
lock at the very END of boot (`entry.ts:662`); Task 5 will acquire it early
via the new `acquireInstanceLock`, fixing a pre-existing race where a second
instance booted fully (including server spawn) before being turned away.

**Files:**
- Modify: `electron/main.ts` (new `acquireInstanceLock`; `initMainProcess` stops requesting the lock)
- Modify: `electron/tray.ts` (optional tooltip override)
- Modify: `electron/server-spawner.ts` (exported `buildSpawnEnv`, `FRESHELL_CONFIG_DIR` in spawn env)
- Modify: `electron/startup.ts` (warn-log on hotkey registration failure)
- Test: `test/unit/electron/main.test.ts` (update)
- Test: `test/unit/electron/tray.test.ts` (add one case)
- Test: `test/unit/electron/server-spawner-env.test.ts` (new)
- Test: `test/unit/electron/startup.test.ts` (add one case)

**Interfaces:**
- Consumes: `ElectronApp` (main.ts), `TrayApi`/`MenuApi` (tray.ts), existing `StartupContext.mainProcessLogger` (startup.ts).
- Produces: `acquireInstanceLock(app): boolean`; `createTray(..., appearance?: TrayAppearance)`;
  `buildSpawnEnv(baseEnv, port, configDir): Record<string, string>`.

- [ ] **Step 1: Write the failing behavioral tests**

`test/unit/electron/main.test.ts` — update the import and replace the
lock-failure test of `initMainProcess` with tests of the new function:

```ts
import { initMainProcess, acquireInstanceLock, type ElectronApp, type MainProcessDeps } from '../../../electron/main.js'
```

Remove the existing `'quits when single instance lock fails'` test (lines
43-48) and add:

```ts
describe('acquireInstanceLock', () => {
  it('returns true without quitting when the lock is acquired', () => {
    const app = createMockApp()
    expect(acquireInstanceLock(app)).toBe(true)
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('quits and returns false when another instance holds the lock', () => {
    const app = createMockApp()
    ;(app.requestSingleInstanceLock as ReturnType<typeof vi.fn>).mockReturnValue(false)
    expect(acquireInstanceLock(app)).toBe(false)
    expect(app.quit).toHaveBeenCalled()
  })
})
```

`test/unit/electron/tray.test.ts` — add inside the existing describe:

```ts
it('uses a profile-aware tooltip when provided', () => {
  createTray(MockTray, mockMenu, '/path/to/icon.png', options, { tooltip: 'Freshell (work)' })
  expect(mockTrayInstance.setToolTip).toHaveBeenCalledWith('Freshell (work)')
})
```

`test/unit/electron/server-spawner-env.test.ts` — new:

```ts
import { describe, it, expect } from 'vitest'
import { buildSpawnEnv } from '../../../electron/server-spawner.js'

const CONFIG_DIR = '/home/user/.freshell-work'

describe('buildSpawnEnv', () => {
  it('inherits the base environment', () => {
    const env = buildSpawnEnv({ PATH: '/bin', CUSTOM: 'x' }, 3001, CONFIG_DIR)
    expect(env.PATH).toBe('/bin')
    expect(env.CUSTOM).toBe('x')
  })

  it('pins PORT to the spawn port', () => {
    expect(buildSpawnEnv({ PORT: '9999' }, 3001, CONFIG_DIR).PORT).toBe('3001')
  })

  it('pins FRESHELL_CONFIG_DIR to the profile config dir, overriding any inherited value', () => {
    expect(buildSpawnEnv({ FRESHELL_CONFIG_DIR: '/elsewhere' }, 3001, CONFIG_DIR).FRESHELL_CONFIG_DIR)
      .toBe(CONFIG_DIR)
  })
})
```

`test/unit/electron/startup.test.ts` — add one case. Mirror the file's
existing main-window test scaffolding (`createDefaultContext()` with a
completed remote-mode `desktopConfig`); adapt to the real helper names if
they differ:

```ts
it('logs a warning when the global hotkey registration fails', async () => {
  const ctx = createDefaultContext()
  ;(ctx.hotkeyManager.register as ReturnType<typeof vi.fn>).mockReturnValue(false)

  const result = await runStartup(ctx)

  expect(result.type).toBe('main')
  expect(ctx.mainProcessLogger?.log).toHaveBeenCalledWith(
    expect.objectContaining({
      severity: 'warn',
      event: 'global_hotkey_registration_failed',
      accelerator: ctx.desktopConfig.globalHotkey,
    }),
  )
})
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/main.test.ts test/unit/electron/tray.test.ts test/unit/electron/server-spawner-env.test.ts test/unit/electron/startup.test.ts --run`

Expected: FAIL because (a) `acquireInstanceLock` is not exported; (b)
`createTray` takes only 4 args and the tooltip stays `'Freshell'`; (c)
`buildSpawnEnv` is not exported (module has no such symbol); (d) no
`global_hotkey_registration_failed` log call exists.

- [ ] **Step 3: Add the minimal production implementation**

`electron/main.ts` — replace the lock block at lines 23-28 with nothing, add
the export, and document the contract:

```ts
/**
 * Acquire the single-instance lock for this process's userData dir. When
 * entry.ts has namespaced userData per profile, each profile holds its own
 * lock. Call BEFORE any boot side effects (provisioning, server spawn).
 * Returns true when the lock is held; on failure the app quits and this
 * returns false.
 */
export function acquireInstanceLock(app: ElectronApp): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }
  return true
}
```

`initMainProcess` drops its lock block; its header comment gains: "The caller
must hold the instance lock already (see `acquireInstanceLock`)."

`electron/tray.ts`:

```ts
export interface TrayAppearance {
  /** Tooltip override; defaults to 'Freshell'. */
  tooltip?: string
}

export function createTray(
  TrayConstructor: TrayApi,
  Menu: MenuApi,
  iconPath: string,
  options: TrayOptions,
  appearance: TrayAppearance = {},
): TrayInstance {
  const tray = new TrayConstructor(iconPath)
  tray.setToolTip(appearance.tooltip ?? 'Freshell')
  // ...rest unchanged...
}
```

`electron/server-spawner.ts` — add the exported helper and use it in
`start()`:

```ts
/** Environment for a spawned server: inherits ours, pinned to the spawn port
 * and to THIS process's Freshell config dir (profile-aware). */
export function buildSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  port: number,
  configDir: string,
): Record<string, string> {
  return {
    ...(baseEnv as Record<string, string>),
    PORT: String(port),
    FRESHELL_CONFIG_DIR: configDir,
  }
}
```

Inside `start()`, replace the inline env object (`const env: Record<string, string> = { ...process.env as..., PORT: ... }`) with:

```ts
const env = buildSpawnEnv(process.env, port, configDir)
```

`electron/startup.ts` — capture the registration result and log on failure:

```ts
const hotkeyRegistered = ctx.hotkeyManager.register(ctx.desktopConfig.globalHotkey, () => {
  if (window.isVisible() && window.isFocused()) {
    window.hide()
  } else {
    window.show()
    window.focus()
  }
})
if (!hotkeyRegistered) {
  ctx.mainProcessLogger?.log({
    severity: 'warn',
    event: 'global_hotkey_registration_failed',
    accelerator: ctx.desktopConfig.globalHotkey,
  })
}
```

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/main.test.ts test/unit/electron/tray.test.ts test/unit/electron/server-spawner-env.test.ts test/unit/electron/startup.test.ts --run`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None expected; the changes are minimal and local.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the entire electron unit suite (initMainProcess signature/behavior
change; shared tray/startup/server-spawner modules). NOTE: `entry.ts` still
calls `initMainProcess` at boot end and no longer acquires the lock anywhere —
between this task and Task 5 the packaged app would not quit same-instance
duplicates. That is exactly why these ship on one branch together; the unit
suite is unaffected because `entry.ts` is not unit-tested by design.

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts --run`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add electron/main.ts electron/tray.ts electron/server-spawner.ts electron/startup.ts \
  test/unit/electron/main.test.ts test/unit/electron/tray.test.ts \
  test/unit/electron/server-spawner-env.test.ts test/unit/electron/startup.test.ts \
  docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "refactor(electron): split instance-lock acquisition, warn on hotkey failure, profile-aware spawn env and tray tooltip"
```

---

### Task 4: Server honors `FRESHELL_CONFIG_DIR`

App-bound profiles must not share server-side state. The server resolves its
config dir via `server/freshell-home.ts` (`FRESHELL_HOME` + `/.freshell`) —
which cannot express `~/.freshell-<id>`. The daemon templates already set a
`FRESHELL_CONFIG_DIR` env var that nothing reads; this task makes it real.
Task 3 already pins the env var on spawned servers, so after this task an
app-bound profile's server writes config.json/logs/tabs-registry/etc. into
the profile's config dir.

**Files:**
- Modify: `server/freshell-home.ts`
- Modify (only if the audit finds manual joiners): any `server/**` file that
  builds `~/.freshell` paths without going through `getFreshellConfigDir()`
- Test: `test/unit/server/freshell-home.test.ts` (new)

**Interfaces:**
- Consumes: `process.env.FRESHELL_CONFIG_DIR` (absolute or relative path).
- Produces: unchanged signatures; `getFreshellConfigDir(env?)` now honors the override.

- [ ] **Step 1: Write the failing behavioral test**

```ts
// test/unit/server/freshell-home.test.ts
import os from 'os'
import path from 'path'
import { describe, it, expect } from 'vitest'
import { getFreshellHomeDir, getFreshellConfigDir } from '../../../server/freshell-home.js'

describe('getFreshellHomeDir', () => {
  it('honors FRESHELL_HOME', () => {
    expect(getFreshellHomeDir({ FRESHELL_HOME: '/tmp/fx-home' })).toBe(path.resolve('/tmp/fx-home'))
  })
  it('falls back to the OS homedir', () => {
    expect(getFreshellHomeDir({})).toBe(os.homedir())
  })
})

describe('getFreshellConfigDir', () => {
  it('defaults to ~/.freshell', () => {
    expect(getFreshellConfigDir({})).toBe(path.join(os.homedir(), '.freshell'))
  })
  it('joins FRESHELL_HOME with .freshell', () => {
    expect(getFreshellConfigDir({ FRESHELL_HOME: '/tmp/fx-home' }))
      .toBe(path.join(path.resolve('/tmp/fx-home'), '.freshell'))
  })
  it('honors FRESHELL_CONFIG_DIR verbatim over FRESHELL_HOME', () => {
    expect(getFreshellConfigDir({ FRESHELL_HOME: '/tmp/fx-home', FRESHELL_CONFIG_DIR: '/tmp/fx-work' }))
      .toBe('/tmp/fx-work')
  })
  it('resolves a relative FRESHELL_CONFIG_DIR to absolute', () => {
    expect(getFreshellConfigDir({ FRESHELL_CONFIG_DIR: 'relative/dir' }))
      .toBe(path.resolve('relative/dir'))
  })
  it('ignores a blank FRESHELL_CONFIG_DIR', () => {
    expect(getFreshellConfigDir({ FRESHELL_CONFIG_DIR: '   ' }))
      .toBe(path.join(os.homedir(), '.freshell'))
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/server/freshell-home.test.ts`

Expected: FAIL because `FRESHELL_CONFIG_DIR` is ignored today (the three
override cases return `.../.freshell` instead).

- [ ] **Step 3: Add the minimal production implementation**

```ts
// server/freshell-home.ts
import os from 'os'
import path from 'path'

export function getFreshellHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FRESHELL_HOME?.trim()
  if (override) return path.resolve(override)
  return os.homedir()
}

/**
 * The Freshell config dir (~/.freshell by default).
 *
 * Resolution order:
 *   1. FRESHELL_CONFIG_DIR — explicit full override. This is how the Electron
 *      app's named profiles (`~/.freshell-<id>`) and the daemon service
 *      templates pin state; FRESHELL_HOME cannot express those paths because
 *      it is the PARENT of '.freshell'.
 *   2. FRESHELL_HOME (or the OS homedir) + '/.freshell'.
 */
export function getFreshellConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configOverride = env.FRESHELL_CONFIG_DIR?.trim()
  if (configOverride) return path.resolve(configOverride)
  return path.join(getFreshellHomeDir(env), '.freshell')
}
```

Then AUDIT for manual joiners and route them through `getFreshellConfigDir`:

Run: `rg -n "getFreshellHomeDir\(" server/ test/ --type ts`
Run: `rg -n -e "\.freshell" server/ --type ts`

For every hit, read the surrounding code. Required outcome: every server-side
`~/.freshell` path resolution flows through `getFreshellConfigDir(env)`
(call-time, not import-time, so `process.env` is honored). Known consumers to
verify: `server/bootstrap.ts` (config path), `server/logger.ts`,
`server/tabs-registry/store.ts`, `server/instance-id.ts`,
`server/index.ts`, `server/session-scanner/service.ts`, `server/cli/config.ts`,
`server/get-network-host.ts`. Do not change behavior of any path that is
deliberately not config-dir-scoped; if such a case exists, leave it and note it
in the commit message.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/server/freshell-home.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the audit found manual joiners, they now call `getFreshellConfigDir()`.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every server unit touching home/config resolution.

Run: `npm run test:vitest -- run test/unit/server test/unit/vite-config.test.ts`

Expected: PASS (no behavior change when `FRESHELL_CONFIG_DIR` is unset).

- [ ] **Step 7: Commit the task**

```bash
git add server/freshell-home.ts test/unit/server/freshell-home.test.ts \
  $(git -C . diff --name-only -- server/ | tr '\n' ' ') \
  docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "feat(server): honor FRESHELL_CONFIG_DIR for config dir resolution"
```

---

### Task 5: Boot-time profile wiring in `entry.ts` (no picker yet)

`entry.ts` is untestable-by-design (imports `electron`); keep this task's
logic minimal glue over Task 2's pure module. After this task: named-profile
boots get their own userData (and thus their own single-instance lock) and
config dir; the lock is acquired before any side effects; tray tooltip shows
the profile; none of this changes the default boot.

**Files:**
- Modify: `electron/entry.ts`

**Interfaces:**
- Consumes: Task 2's `resolveProfileSelection`, `configDirForProfile`,
  `userDataDirForProfile`, `DEFAULT_PROFILE_ID`; Task 1's optional `configDir`
  params; Task 3's `acquireInstanceLock` and tray `appearance`.
- Produces: `activeProfileId` + profile-bound `configDir` consumed by the rest
  of the boot; picker flow arrives in Task 6.

- [ ] **Step 1: Write the failing behavioral test**

entry.ts is excluded from unit tests by repo convention (its header comment).
The verification for this task is compile + the electron unit suite staying
green + the manual smoke in Step 4.

- [ ] **Step 2: Compile check fails first**

Run: `npm run build:electron`

Expected: PASS today (baseline for the diff) — Task 5 is wiring-only; its
proof is Step 4's smoke and later tasks' tests.

- [ ] **Step 3: Add the wiring**

Three edits in `electron/entry.ts`:

(a) Module-top — replace

```ts
const isPortAvailable = createPortAvailabilityCheck()

const isDev = process.env.ELECTRON_DEV === '1'
const configDir = path.join(os.homedir(), '.freshell')
const mainProcessLogger = createElectronMainLogger({ configDir })
```

with

```ts
const isPortAvailable = createPortAvailabilityCheck()

const isDev = process.env.ELECTRON_DEV === '1'

// --- Profile resolution (must run before configDir/logger binding) --------
// A named profile (--profile=<id> or FRESHELL_PROFILE) gets its own Electron
// userData dir — which also re-keys the single-instance lock per profile —
// and its own Freshell config dir (~/.freshell-<id>). The default profile
// keeps today's exact paths and never touches userData.
const profileSelection = resolveProfileSelection(process.argv, process.env)
if (profileSelection.error) {
  console.warn(JSON.stringify({
    severity: 'warn',
    component: 'electron-profile',
    event: 'profile_selection_invalid',
    error: profileSelection.error,
  }))
}
const activeProfileId = profileSelection.selection.id
if (activeProfileId !== DEFAULT_PROFILE_ID) {
  const namespacedUserData = userDataDirForProfile(activeProfileId, app.getName(), app.getPath('appData'))
  if (namespacedUserData) {
    app.setPath('userData', namespacedUserData)
  }
}
const configDir = configDirForProfile(activeProfileId, os.homedir())
const mainProcessLogger = createElectronMainLogger({ configDir })

/** True once this process's profile choice is final (flag/env/picker). The
 *  wizard-driven main() re-entry must not re-run the picker. */
let profileChoiceMade = profileSelection.selection.explicit
/** True once this process holds the instance lock; re-entrant main() calls
 *  (wizard completion) must not re-request it. */
let instanceLockHeld = false
```

and update the imports (Task 5 needs only these; the picker imports arrive in
Task 6):

```ts
import {
  DEFAULT_PROFILE_ID,
  configDirForProfile,
  resolveProfileSelection,
  userDataDirForProfile,
} from './profile.js'
import { acquireInstanceLock, initMainProcess } from './main.js'
```

(remove the old `import { initMainProcess } from './main.js'`.)

(b) In `main()`, immediately after `await app.whenReady()` (before the
`electron_main_started` log, so a lock-loser never writes into the winner's
per-profile log):

```ts
  // Per-profile single-instance lock, acquired BEFORE any side effects
  // (provisioning, server spawn). Keyed to the userData dir, so each profile
  // holds an independent lock and a same-profile duplicate quits here.
  if (!instanceLockHeld) {
    if (!acquireInstanceLock(app)) {
      return
    }
    instanceLockHeld = true
  }
```

Also extend the existing `electron_main_started` log with `profile: activeProfileId`.

(c) Thread `configDir` into every desktop-config / window-state / provisioning
call site in main(): provisioning deps (`patchDesktopConfig: (p) => patchDesktopConfig(p, configDir)`),
boot read (`readDesktopConfig(configDir)`), `complete-setup`
(`patchDesktopConfig({...}, configDir)`), chooser deps
(`patchDesktopConfig: (patch) => patchDesktopConfig(patch, configDir)`), and
`createWindowStatePersistence(configDir)`. Pass the tray tooltip:

```ts
createTray(Tray as any, Menu as any, iconPath, { /* existing callbacks */ },
  { tooltip: activeProfileId === DEFAULT_PROFILE_ID ? 'Freshell' : `Freshell (${activeProfileId})` })
```

(d) In the `ipcMain.removeHandler(...)` block, also remove `'get-profiles'`
and `'choose-profile'` (added in Task 6) so main() re-entry stays clean.

- [ ] **Step 4: Verify compile + unit suite + dev smoke**

Run: `npm run build:electron && npm run test:vitest -- --config config/vitest/vitest.electron.config.ts --run`

Expected: PASS both.

Manual smoke (dev, then discard): `ELECTRON_DEV=0 npx electron . --profile=smoketest` from the worktree
(after `npm run build:electron`) should fail noisily only about missing
dist/server, and `ls ~/.freshell-smoketest/logs` should show an
`electron-main.*.jsonl` mentioning `"profile":"smoketest"`; then
`rm -rf ~/.freshell-smoketest ~/.config/freshell-smoketest`.

- [ ] **Step 5: Refactor while green**

None expected.

- [ ] **Step 6: Run impacted-test verification**

Same as Step 4 first command. Include the startup/desktop-config suites:

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts --run`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add electron/entry.ts docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "feat(electron): boot-time profile wiring (userData namespacing, early per-profile lock)"
```

---

### Task 6: Profile picker decision flow (IPC handler + preload + `entry.ts` picker)

The picker window runs in the LAUNCHER process (default userData, default
config dir) when no explicit profile was given and the registry names ≥1
profile. Choosing **Default** continues this process's boot (no relaunch — the
launcher ALREADY occupies the default environment; relaunching would race the
launcher's just-released lock). Choosing a named profile relaunches with
`--profile=<id>` and exits (the named userData lock is free, so no race).
Closing the picker without choosing exits the app.

**Files:**
- Create: `electron/profile-choice-handler.ts`
- Modify: `electron/preload.ts` (two new channels)
- Modify: `electron/entry.ts` (picker step in `main()` + `runProfilePicker`)
- Test: `test/unit/electron/profile-choice-handler.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `DEFAULT_PROFILE_ID`, `PickerEntry`, `buildPickerEntries`,
  `readProfilesRegistry`, `registryPathForHome`, `shouldShowProfilePicker`,
  `stripProfileArgs`.
- Produces: `createChooseProfileHandler(deps)`; preload API
  `getProfiles(): Promise<PickerEntry[]>` and `chooseProfile(id): Promise<ProfileChoiceResult>`.

- [ ] **Step 1: Write the failing behavioral test**

```ts
// test/unit/electron/profile-choice-handler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createChooseProfileHandler } from '../../../electron/profile-choice-handler.js'

const entries = [
  { id: 'default', label: 'Default' },
  { id: 'work', label: 'Work' },
]

function harness(overrides: Partial<Parameters<typeof createChooseProfileHandler>[0]> = {}) {
  const deps = {
    entries,
    isAllowedSender: vi.fn().mockReturnValue(true),
    continueWithDefault: vi.fn(),
    relaunchWithProfile: vi.fn(),
    ...overrides,
  }
  return { deps, handler: createChooseProfileHandler(deps) }
}

describe('choose-profile handler', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects events from a foreign sender', async () => {
    const { deps, handler } = harness({ isAllowedSender: () => false })
    expect(await handler({}, 'work')).toEqual({ ok: false, error: 'Unexpected profile request.' })
    expect(deps.relaunchWithProfile).not.toHaveBeenCalled()
    expect(deps.continueWithDefault).not.toHaveBeenCalled()
  })

  it('rejects non-string and unknown ids', async () => {
    const { deps, handler } = harness()
    expect(await handler({}, 42)).toEqual({ ok: false, error: 'Unknown profile.' })
    expect(await handler({}, 'unknown')).toEqual({ ok: false, error: 'Unknown profile.' })
    expect(deps.relaunchWithProfile).not.toHaveBeenCalled()
  })

  it('default continues in-process without relaunch', async () => {
    const { deps, handler } = harness()
    expect(await handler({}, 'default')).toEqual({ ok: true })
    expect(deps.continueWithDefault).toHaveBeenCalledTimes(1)
    expect(deps.relaunchWithProfile).not.toHaveBeenCalled()
  })

  it('a named profile relaunches with it', async () => {
    const { deps, handler } = harness()
    expect(await handler({}, 'work')).toEqual({ ok: true })
    expect(deps.relaunchWithProfile).toHaveBeenCalledWith('work')
    expect(deps.continueWithDefault).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/profile-choice-handler.test.ts --run`

Expected: FAIL because `electron/profile-choice-handler.js` does not exist.

- [ ] **Step 3: Add the production implementation**

`electron/profile-choice-handler.ts`:

```ts
import { z } from 'zod'
import { DEFAULT_PROFILE_ID, type PickerEntry } from './profile.js'

export interface ChooseProfileHandlerDeps {
  entries: PickerEntry[]
  /** Defense-in-depth: only the picker window may drive this channel. */
  isAllowedSender: (event: unknown) => boolean
  /** Continue this launch with the default profile, in-process. */
  continueWithDefault: () => void | Promise<void>
  /** Relaunch the app pinned to a named profile, then exit. */
  relaunchWithProfile: (id: string) => void
}

export type ProfileChoiceResult = { ok: true } | { ok: false; error: string }

export function createChooseProfileHandler(deps: ChooseProfileHandlerDeps) {
  const allowed = new Set(deps.entries.map((e) => e.id))
  return async (event: unknown, rawId: unknown): Promise<ProfileChoiceResult> => {
    if (!deps.isAllowedSender(event)) {
      return { ok: false, error: 'Unexpected profile request.' }
    }
    const parsed = z.string().safeParse(rawId)
    if (!parsed.success || !allowed.has(parsed.data)) {
      return { ok: false, error: 'Unknown profile.' }
    }
    if (parsed.data === DEFAULT_PROFILE_ID) {
      await deps.continueWithDefault()
    } else {
      deps.relaunchWithProfile(parsed.data)
    }
    return { ok: true }
  }
}
```

`electron/preload.ts` — extend `FreshellDesktopApi` and the registration:

```ts
export type ProfileChoiceResult = { ok: true } | { ok: false; error: string }
export interface PickerProfileEntry { id: string; label: string }
```

Add to the `FreshellDesktopApi` interface:

```ts
  getProfiles: () => Promise<PickerProfileEntry[]>
  chooseProfile: (id: string) => Promise<ProfileChoiceResult>
```

and to `registerPreloadApi`'s api object:

```ts
    getProfiles: () => ipcRenderer.invoke('get-profiles'),
    chooseProfile: (id: string) => ipcRenderer.invoke('choose-profile', id),
```

`electron/entry.ts` — add imports (Task 5's block already imports
`DEFAULT_PROFILE_ID` etc.; extend it):

```ts
import {
  buildPickerEntries,
  readProfilesRegistry,
  registryPathForHome,
  shouldShowProfilePicker,
  stripProfileArgs,
  type PickerEntry,
} from './profile.js'
import { createChooseProfileHandler } from './profile-choice-handler.js'
```

Add the launcher picker function (module level):

```ts
/**
 * Show the profile picker and resolve the launch's profile.
 *
 * Resolves ONLY when the user picks the default profile (continue in-process);
 * a named choice relaunches with --profile=<id> and this process exits, so the
 * returned promise simply never settles on that path. Closing the picker
 * without choosing exits the app.
 */
async function runProfilePicker(entries: PickerEntry[]): Promise<void> {
  const pickerWin = new BrowserWindow({
    width: 520,
    height: 480,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  const pickerWebContentsId = pickerWin.webContents.id
  const onSecondInstance = () => {
    if (!pickerWin.isDestroyed()) {
      pickerWin.show()
      pickerWin.focus()
    }
  }
  app.on('second-instance', onSecondInstance)

  let continuing = false
  const cleanup = () => {
    app.removeListener('second-instance', onSecondInstance)
    ipcMain.removeHandler('get-profiles')
    ipcMain.removeHandler('choose-profile')
  }

  return new Promise<void>((resolve) => {
    ipcMain.removeHandler('get-profiles')
    ipcMain.removeHandler('choose-profile')
    ipcMain.handle('get-profiles', () => entries)
    ipcMain.handle('choose-profile', createChooseProfileHandler({
      entries,
      isAllowedSender: (event) =>
        (event as { sender?: { id?: number } }).sender?.id === pickerWebContentsId,
      continueWithDefault: () => {
        continuing = true
        profileChoiceMade = true
        cleanup()
        pickerWin.close()
        resolve()
      },
      relaunchWithProfile: (id) => {
        const args = [...stripProfileArgs(process.argv.slice(1)), `--profile=${id}`]
        app.relaunch({ args })
        app.exit(0)
      },
    }))

    pickerWin.on('closed', () => {
      if (!continuing) {
        cleanup()
        app.exit(0)
      }
    })

    if (isDev) {
      void pickerWin.loadURL('http://localhost:5179')
    } else {
      const packaged = path.join(process.resourcesPath, 'profile-picker', 'index.html')
      const unpackaged = path.join(app.getAppPath(), 'dist', 'profile-picker', 'index.html')
      void pickerWin.loadFile(fs.existsSync(packaged) ? packaged : unpackaged)
    }
    pickerWin.show()
  })
}
```

And in `main()`, after the provisioning block and pendingForcedLaunch
consumption, before `const desktopConfig = (await readDesktopConfig(configDir))`:

```ts
  // --- Profile picker -------------------------------------------------------
  // Shown when the launch carried no explicit profile and the machine-global
  // registry (~/.freshell/profiles.json) names at least one profile. Runs in
  // the DEFAULT environment; see runProfilePicker for choice semantics.
  if (!profileChoiceMade) {
    const registry = readProfilesRegistry(registryPathForHome(os.homedir()), (p) =>
      fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : undefined,
    )
    if (registry.error) {
      mainProcessLogger.log({ severity: 'warn', event: 'profiles_registry_invalid', error: registry.error })
    }
    if (shouldShowProfilePicker(profileSelection.selection, registry)) {
      await runProfilePicker(buildPickerEntries(registry))
    }
  }
```

- [ ] **Step 4: Run the focused test + compile**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/profile-choice-handler.test.ts --run && npm run build:electron`

Expected: PASS both. Note: the picker renderer does not exist yet (Task 7), so
a live boot with a registry present will fail to load the picker URL — that is
expected at this task boundary; the flow is fully e2e-proven in Task 8.

- [ ] **Step 5: Refactor while green**

None expected.

- [ ] **Step 6: Run impacted-test verification**

Impacted: full electron unit suite (preload API shape changed).

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts --run`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add electron/profile-choice-handler.ts electron/preload.ts electron/entry.ts \
  test/unit/electron/profile-choice-handler.test.ts \
  docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "feat(electron): profile picker decision flow (choose-profile IPC + launcher picker)"
```

---

### Task 7: Profile picker renderer + build/packaging wiring

The picker UI follows the launch-chooser pattern exactly: its own vite config
(dev port 5179, outDir `dist/profile-picker`, `base: './'`), extraResources
packaging (NOT asar — matches the chooser, which loads from the real fs), and
a React component that declares its own narrow `window.freshellDesktop`
surface in-file.

**Files:**
- Create: `electron/profile-picker/index.html`
- Create: `electron/profile-picker/main.tsx`
- Create: `electron/profile-picker/picker.tsx`
- Create: `electron/profile-picker/picker.css`
- Create: `config/vite/vite.profile-picker.config.ts`
- Modify: `package.json` (3 scripts)
- Modify: `config/electron-builder.yml` (extraResources)
- Modify: `tsconfig.electron.json` (exclude picker tsx/html)
- Test: `test/unit/electron/profile-picker/picker.test.tsx` (new)
- Test: `test/unit/electron/electron-builder-config.test.ts` (add one case)

**Interfaces:**
- Consumes: preload's `getProfiles` / `chooseProfile` (Task 6).
- Produces: `dist/profile-picker/**` build artifact; `build:profile-picker` /
  `dev:profile-picker` scripts; picker bundled into packaged apps.

- [ ] **Step 1: Write the failing behavioral test**

```tsx
// test/unit/electron/profile-picker/picker.test.tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfilePicker } from '../../../electron/profile-picker/picker.js'

function installDesktopApi(options: { chooseProfile?: ReturnType<typeof vi.fn> } = {}) {
  const chooseProfile = options.chooseProfile ?? vi.fn().mockResolvedValue({ ok: true })
  window.freshellDesktop = {
    getProfiles: vi.fn().mockResolvedValue([
      { id: 'default', label: 'Default' },
      { id: 'work', label: 'Work' },
    ]),
    chooseProfile,
  }
  return { chooseProfile }
}

afterEach(() => {
  cleanup()
  delete window.freshellDesktop
})

describe('ProfilePicker', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders an accessible button per profile once loaded', async () => {
    installDesktopApi()
    render(<ProfilePicker />)
    expect(await screen.findByRole('button', { name: 'Default' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Work' })).toBeTruthy()
  })

  it('chooses a profile on click', async () => {
    const { chooseProfile } = installDesktopApi()
    render(<ProfilePicker />)
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    await waitFor(() => expect(chooseProfile).toHaveBeenCalledWith('work'))
  })

  it('surfaces a rejected choice via role="alert"', async () => {
    const chooseProfile = vi.fn().mockResolvedValue({ ok: false, error: 'Unknown profile.' })
    installDesktopApi({ chooseProfile })
    render(<ProfilePicker />)
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/profile-picker/picker.test.tsx --run`

Expected: FAIL because `electron/profile-picker/picker.js` does not exist.

- [ ] **Step 3: Add the production implementation**

`electron/profile-picker/index.html` (mirrors the launch chooser's):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Freshell Profiles</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

`electron/profile-picker/main.tsx`:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import './picker.css'
import { ProfilePicker } from './picker.js'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ProfilePicker />
  </React.StrictMode>,
)
```

`electron/profile-picker/picker.tsx` (local narrow `window.freshellDesktop`
declaration, matching the setup-wizard/launch-chooser convention):

```tsx
import { useEffect, useState } from 'react'

declare global {
  interface Window {
    freshellDesktop?: {
      getProfiles?: () => Promise<{ id: string; label: string }[]>
      chooseProfile?: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>
    }
  }
}

interface PickerEntry {
  id: string
  label: string
}

export function ProfilePicker() {
  const [entries, setEntries] = useState<PickerEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.freshellDesktop?.getProfiles?.().then((list) => {
      if (!cancelled) setEntries(list ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [])

  const choose = async (id: string) => {
    setError(null)
    const result = await window.freshellDesktop?.chooseProfile?.(id)
    if (result && !result.ok) setError(result.error)
  }

  return (
    <main className="picker">
      <h1>Choose a Freshell profile</h1>
      <p className="picker-subtitle">
        This machine has more than one Freshell profile. Each profile keeps its
        own settings and can connect to a different server.
      </p>
      {error ? (
        <p role="alert" className="picker-error">{error}</p>
      ) : null}
      <ul className="picker-list">
        {(entries ?? []).map((entry) => (
          <li key={entry.id}>
            <button type="button" onClick={() => { void choose(entry.id) }}>
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

`electron/profile-picker/picker.css` (imports the wizard's tailwind base via
the config's postcss, same as chooser.css — copy the chooser's import line and
add minimal styles):

```css
@import 'tailwindcss/base';
@import 'tailwindcss/components';
@import 'tailwindcss/utilities';

/* If chooser.css uses different imports, mirror `electron/launch-chooser/chooser.css` exactly and keep only the rules below. */

body {
  margin: 0;
}

.picker {
  max-width: 400px;
  margin: 3rem auto;
  padding: 0 1.5rem;
}

.picker-subtitle {
  font-size: 0.875rem;
  opacity: 0.7;
}

.picker-list {
  list-style: none;
  padding: 0;
  margin: 1.5rem 0 0;
}

.picker-list button {
  width: 100%;
  padding: 0.625rem 1rem;
  margin-bottom: 0.5rem;
  border-radius: 0.5rem;
  cursor: pointer;
}

.picker-error {
  color: #b91c1c;
}
```

`config/vite/vite.profile-picker.config.ts` (mirror the chooser's exactly —
including the top-level-await postcss block — with root `electron/profile-picker`,
outDir `dist/profile-picker`, port **5179**).

`package.json` — add scripts and wire them in:

```json
"build:profile-picker": "vite build --config config/vite/vite.profile-picker.config.ts",
"dev:profile-picker": "vite --config config/vite/vite.profile-picker.config.ts",
```

- `electron:dev`: extend the concurrently list to `-n client,wizard,chooser,picker,electron` and add `"vite --config config/vite/vite.profile-picker.config.ts"`.
- `electron:build` and `electron:build:win`: insert `&& npm run build:profile-picker` right after `npm run build:launch-chooser`.

`config/electron-builder.yml` — add to `extraResources`, right after the
launch-chooser block:

```yaml
  # Profile picker assets (loaded from the real filesystem before connecting)
  - from: dist/profile-picker
    to: profile-picker
    filter:
      - "**/*"
```

`tsconfig.electron.json` — extend `exclude`:

```json
    "electron/profile-picker/**/*.tsx",
    "electron/profile-picker/index.html"
```

- [ ] **Step 4: Run the component test + build smoke**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/profile-picker/picker.test.tsx --run && npm run build:profile-picker && npm run build:electron`

Expected: PASS all; `dist/profile-picker/index.html` exists.

- [ ] **Step 5: Refactor while green**

None expected.

- [ ] **Step 6: Run impacted-test verification**

The electron-builder config declarative test must cover the new resource —
add to `test/unit/electron/electron-builder-config.test.ts`:

```ts
  it('packages profile picker assets as extra resources', () => {
    const config = readText(path.join(PROJECT_ROOT, 'config/electron-builder.yml'))

    expect(config).toMatch(
      /extraResources:\n(?:.*\n)*?  - from: dist\/profile-picker\n    to: profile-picker/,
    )
  })
```

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts --run`

Expected: PASS (including the new packaging assertion).

- [ ] **Step 7: Commit the task**

```bash
git add electron/profile-picker/ config/vite/vite.profile-picker.config.ts \
  package.json config/electron-builder.yml tsconfig.electron.json \
  test/unit/electron/profile-picker/picker.test.tsx \
  test/unit/electron/electron-builder-config.test.ts \
  docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "feat(electron): profile picker window and build packaging"
```

---

### Task 8: Electron e2e coverage (`test/e2e-electron/profile-picker.test.ts`)

End-to-end proof of the user story on the real app: picker shows when a
registry exists, named profiles boot without it and get namespaced
userData + config dir, invalid registries are ignored safely.

**Files:**
- Test: `test/e2e-electron/profile-picker.test.ts` (new)

**Interfaces:**
- Consumes: everything above; the existing e2e harness style in
  `test/e2e-electron/electron-app.test.ts` (temp HOME override, `electron.launch`).

- [ ] **Step 1: Write the failing behavioral test**

```ts
// test/e2e-electron/profile-picker.test.ts
/**
 * Profile picker + namespacing E2E — launches the real Electron app with a
 * temporary HOME containing a profiles.json registry.
 *
 * Requires dist/electron, dist/wizard, and dist/profile-picker to be built
 * (same as the wizard/chooser specs in electron-app.test.ts).
 */

import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..')

function createTempHomeWithRegistry(registry: unknown): string {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-e2e-profiles-'))
  fs.mkdirSync(path.join(tmpHome, '.freshell'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpHome, '.freshell', 'profiles.json'),
    typeof registry === 'string' ? registry : JSON.stringify(registry),
  )
  return tmpHome
}

async function launchApp(tmpHome: string, extraArgs: string[] = []): Promise<ElectronApplication> {
  return electron.launch({
    args: [PROJECT_ROOT, ...extraArgs],
    env: {
      ...process.env,
      HOME: tmpHome,
      NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
    },
    cwd: PROJECT_ROOT,
  })
}

test.describe('Profile picker', () => {
  let app: ElectronApplication | undefined
  let tmpHome: string | undefined

  test.afterEach(async () => {
    if (app) {
      await app.close().catch(() => {})
      app = undefined
    }
    if (tmpHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true })
      tmpHome = undefined
    }
  })

  test('shows the picker with Default first when the registry names profiles', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })
    app = await launchApp(tmpHome)

    const picker = await app.firstWindow()
    await picker.waitForLoadState('domcontentloaded')
    await expect(
      picker.getByRole('heading', { name: 'Choose a Freshell profile' }),
    ).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Default' })).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Work' })).toBeVisible()
  })

  test('choosing Default continues in-process to the first-run wizard', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work' }] })
    app = await launchApp(tmpHome)

    const picker = await app.firstWindow()
    await picker.waitForLoadState('domcontentloaded')
    await picker.getByRole('button', { name: 'Default' }).click()

    // Fresh default home → no desktop.json → setup wizard replaces the picker.
    await expect.poll(async () => {
      for (const win of app!.windows()) {
        if (await win.locator('h1:has-text("Welcome to Freshell")').count() > 0) return true
      }
      return false
    }, { timeout: 30_000 }).toBe(true)
  })

  test('--profile boots the named profile without the picker and namespaces state', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'e2ework' }] })
    app = await launchApp(tmpHome, ['--profile=e2ework'])

    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // The named profile has an empty config dir → first-run wizard proves we booted.
    await expect(window.locator('h1:has-text("Welcome to Freshell")')).toBeVisible({ timeout: 30_000 })

    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    expect(path.basename(userData).toLowerCase()).toBe('freshell-e2ework')

    // The main-process logger is bound to the profile config dir.
    await expect.poll(() => {
      const logsDir = path.join(tmpHome!, '.freshell-e2ework', 'logs')
      return fs.existsSync(logsDir) &&
        fs.readdirSync(logsDir).some((f) => /^electron-main\..*\.jsonl$/.test(f))
    }, { timeout: 15_000 }).toBe(true)

    // The default profile dir received no logs.
    expect(fs.existsSync(path.join(tmpHome, '.freshell', 'logs'))).toBe(false)
  })

  test('an invalid registry file is ignored and the default profile boots', async () => {
    tmpHome = createTempHomeWithRegistry('not valid json {{{')
    app = await launchApp(tmpHome)

    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect(window.locator('h1:has-text("Welcome to Freshell")')).toBeVisible({ timeout: 30_000 })
  })
})
```

- [ ] **Step 2: Run the spec and verify the intended failure**

Prereqs (fresh builds the picker's prod load path needs):

Run: `npm run build:electron && npm run build:wizard && npm run build:profile-picker`

Then: `CI=true npx playwright test --config test/e2e-electron/playwright.electron.config.ts profile-picker`

(On this headless Linux box Electron needs a display; if the run fails with
`Missing X server`/`$DISPLAY` errors, re-run as
`CI=true xvfb-run -a npx playwright test --config test/e2e-electron/playwright.electron.config.ts profile-picker`.)

Expected: FAIL because the picker never appears (no registry handling exists
until Tasks 6-7 are in; on a tree where earlier tasks already landed, the
first spec fails at the heading assertion and the namespacing spec fails at
the `freshell-e2ework` userData assertion).

- [ ] **Step 3: Confirm all four specs pass**

Run: `CI=true npx playwright test --config test/e2e-electron/playwright.electron.config.ts profile-picker` (with `xvfb-run -a` if needed)

Expected: 4 passed.

- [ ] **Step 4: Refactor while green**

Share no helpers with `electron-app.test.ts` (file-local helpers are the file's existing convention).

- [ ] **Step 5: Run impacted-test verification**

The rest of the electron e2e file must stay green (it exercises the default
boot path with no registry — the backward-compat invariant):

Run: `CI=true npx playwright test --config test/e2e-electron/playwright.electron.config.ts` (with `xvfb-run -a` if needed)

Expected: PASS (all specs, existing + new).

- [ ] **Step 6: Commit the task**

```bash
git add test/e2e-electron/profile-picker.test.ts docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "test(e2e): profile picker and per-profile namespacing e2e coverage"
```

---

### Task 9: End-user documentation (README)

The repo's only end-user doc location is `README.md`. Add a new section
(documentation-only task; no test steps — sections render in the GitHub UI;
verify by reading the file after edit).

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the section**

Insert a `## Desktop profiles (multiple instances)` section after the
desktop/Electron portion of the README (place it right after the section that
documents the desktop app install/launch flow):

```markdown
## Desktop profiles (multiple instances)

The desktop app normally runs one instance with one configuration. **Profiles**
let you run multiple independent desktop clients on the same machine at the
same time — for example one connected to your work server and one to a
personal server.

Each named profile gets its own:

- settings, window state, and logs (`~/.freshell-<id>/`; the default profile
  keeps using `~/.freshell/`)
- Electron storage dir (`…/Freshell-<id>`), so cookies and localStorage never
  mix
- single-instance lock: launching the same profile twice focuses the running
  window; different profiles run side by side

### Defining profiles

Create `~/.freshell/profiles.json`:

```json
{
  "profiles": [
    { "id": "work", "label": "Work" },
    { "id": "home" }
  ]
}
```

Rules: `id` is lowercase letters/digits/dashes starting with a letter or digit
(max 32 chars); `default` is reserved (it means the original un-namespaced
environment); `label` is optional display text.

When at least one named profile is defined, launching the app without a
profile shows a picker (the default profile is always listed first). Pin a
launch to a profile with `--profile=<id>` or `FRESHELL_PROFILE=<id>`; named
ids do not have to be listed in `profiles.json` — an unlisted id simply
starts with a fresh configuration.

### Notes and limitations

- Global hotkey: the first instance to register an accelerator keeps it;
  later instances log a warning (`global_hotkey_registration_failed`) and have
  no hotkey. Give each profile a distinct hotkey in its own settings.
- App-bound servers: each profile spawns its own server pinned to that
  profile's config dir (`FRESHELL_CONFIG_DIR`); choose a distinct port per
  profile.
- Daemon services (`freshell.service`, `com.freshell.server`,
  "Freshell Server" task) are machine-global single instances — do not use
  daemon mode in two profiles at once.
- Silent-install provisioning (`desktop.provision`) applies to the default
  profile only.
- Auto-update relaunches the app without `--profile`: after an update, the
  picker shows again (pick your profile back).
- Installing/upgrading on Windows terminates all running Freshell instances.
```

- [ ] **Step 2: Verify rendering**

Read the edited README section and confirm the markdown structure matches the
surrounding document (heading levels, fenced code block language tags).

- [ ] **Step 3: Commit the task**

```bash
git add README.md docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "docs: desktop profiles for multiple instances"
```

---

## Final verification gate

After all tasks: run the coordinated full suite once on HEAD.

Run: `FRESHELL_TEST_SUMMARY='electron-multi-profile final gate' npm run check`

Expected: PASS (green except for any baseline-ledgered pre-existing failures;
there were none at base_ref).
