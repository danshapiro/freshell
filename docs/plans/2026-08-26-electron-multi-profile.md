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
today's exact paths). `entry.ts` resolves the profile AND the registry at
module top. Three launcher shapes are possible:

1. **Explicit** (`--profile`/`FRESHELL_PROFILE`, valid): the process namespaced
   userData for the named profile (default keeps today's userData untouched),
   acquires the per-profile instance lock once `whenReady` resolves, and boots
   normally. The lock is userData-keyed (empirically verified on Electron
   33.4.11), so profiles run side by side.
2. **Picker** (no explicit profile AND the registry names ≥1 profile): the
   process namepaces userData to a dedicated **launcher** dir
   (`<appData>/<AppName>-profile-picker`) — NEVER the default userData. This
   is load-bearing: without it, a picker launch while a Default instance is
   resident would have two browser processes sharing one Chromium userData
   dir, which Chromium's process-singleton exists to prevent (storage
   corruption hazard). The launcher takes its own picker-scoped instance lock
   (so a racing flag-less launch focuses the resident picker instead of
   stacking duplicate pickers), shows only the picker window, and on ANY
   choice — Default included — calls `app.relaunch({ args: [...stripProfileArgs(argv), '--profile=<id>'] })`
   and exits. The relaunched process is then an EXPLICIT launch (shape 1),
   so the chosen profile's lock is acquired in a process whose userData
   belongs to exactly that profile.
3. **Plain default** (no explicit profile, no registry profiles): identical
   to today's boot — default userData, default lock, no picker.

A machine-global registry `~/.freshell/profiles.json` (zod-validated) lists
named profiles (the choice set is `[Default, ...profiles]`; "more than one
profile" per the request means the registry makes the choice set exceed one
entry, i.e. ≥1 named profile). App-bound spawned servers receive
`FRESHELL_CONFIG_DIR` whose support is added to `server/freshell-home.ts`,
and the server-side audit (Task 4) routes every profile-scoped state path
through `getFreshellConfigDir` while leaving genuinely machine-level state
(firewall/WSL port bookkeeping, checkout/project-scoped files) deliberately
shared.

**Tech Stack:** Electron (main process ESM/NodeNext), React 18 + Vite (picker
renderer), Zod, Vitest, Playwright `_electron`.

## User Request

> Run two electron clients on the same machine pointed at different servers: fix the blockers (single-instance lock, namespaced userData + config dir per profile) plus a profile picker at launch when more than one profile is configured in a text file. Implement with the-usual.

## Global Constraints

- **Backward-compat invariant:** with no `--profile`, no `FRESHELL_PROFILE`,
  and no registry file, behavior is identical to today: same paths
  (`~/.freshell`, default Electron userData), same boot flow, same windows. The
  default profile never calls `app.setPath('userData', ...)` at all.
- **Lock timing policy (load-bearing finding LB-02 + plan-review round 3):**
  EVERY browser process holds exactly one userData-keyed instance lock from
  `whenReady()` onward — no lock-free picker phase. The one-profile-in-file
  threshold is **registry names ≥1 named profile**: Default is an
  always-configured choice, so one named entry already makes the configured
  choice set exceed one (matching the User Request's "more than one profile is
  configured"); every plan/test/README line uses this same threshold. A
  non-explicit launch meeting it becomes a **picker launcher**: it sets its
  userData to a dedicated launcher dir (`<appData>/<AppName>-profile-picker`,
  NEVER the default userData — sharing a Chromium userData between the
  launcher and a resident Default instance is a storage-corruption hazard),
  acquires the picker-scoped lock, and shows only the picker. A second
  flag-less launch is turned away at the picker lock and the resident picker
  focuses via `second-instance`. ANY confirmed choice — Default included —
  relaunches the app with an explicit `--profile=<id>` and exits, so the
  profile's own lock is only ever taken in a process whose userData belongs
  to that profile; a choice of a running profile degrades to
  focus-the-resident via the normal explicit-duplicate path.
- **Resident surfacing fix:** the resident's `second-instance` handler must
  `show()` a tray-hidden window before `focus()` (today it only restores a
  minimized window, so a turned-away launch over a tray-hidden Default is a
  silent no-op). This fix is required for the turned-away-launch UX and is
  done in Task 3.
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
- Produces: `DEFAULT_PROFILE_ID`, `PICKER_USERDATA_ID`, `PROFILE_ID_PATTERN`,
  `ProfileEntry`, `ProfilesRegistrySchema`, `RegistryReadResult`,
  `ProfileSelection`, `ProfileSelectionResult`, `parseProfileArg(argv)`,
  `stripProfileArgs(argv)`, `resolveProfileSelection(argv, env)`,
  `configDirForProfile(id, homedir)`, `userDataDirForProfile(id, appName, appDataDir)`,
  `userDataDirForPicker(appName, appDataDir)`, `registryPathForHome(homedir)`,
  `readProfilesRegistry(path, readFile)`, `shouldShowProfilePicker(selection, registry)`,
  `buildPickerEntries(registry)`, `resolveBootShape(argv, env, registry, appName, appDataDir, homedir)`,
  `BootShape`.

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
  resolveBootShape,
  resolveProfileSelection,
  shouldShowProfilePicker,
  stripProfileArgs,
  userDataDirForPicker,
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
  it('keeps a flag that follows bare --profile (no value was consumed)', () => {
    // Mirrors parseProfileArg: `--profile --other` took no value, so --other
    // must survive stripping (it belongs to the relaunched process).
    expect(stripProfileArgs(['--profile', '--other', 'x'])).toEqual(['--other', 'x'])
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
  it('the reserved picker id falls back to default with an error', () => {
    const r = resolveProfileSelection(['app', '--profile=profile-picker'], {})
    expect(r.selection.id).toBe(DEFAULT_PROFILE_ID)
    expect(r.selection.explicit).toBe(false)
    expect(r.error).toContain('profile-picker')
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
  it('a reader that throws (unreadable file) is reported and ignored, not fatal', () => {
    const r = readProfilesRegistry('/x/profiles.json', () => { throw new Error('EACCES: permission denied') })
    expect(r.profiles).toEqual([])
    expect(r.error).toContain('could not be read')
    expect(r.error).toContain('EACCES')
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

describe('resolveBootShape', () => {
  const REG = { profiles: [{ id: 'work' as const }] }
  const NO_REGISTRY = { profiles: [] as const }
  it('explicit named profile: namespaced userData + namespaced config dir', () => {
    expect(resolveBootShape(['app', '--profile=work'], {}, REG, 'Freshell', '/app/data', '/home/u'))
      .toEqual({
        kind: 'explicit',
        profileId: 'work',
        userDataDir: path.join('/app/data', 'Freshell-work'),
        configDir: path.join('/home/u', '.freshell-work'),
      })
  })
  it('explicit default: untouched userData + default config dir, no picker', () => {
    expect(resolveBootShape(['app', '--profile=default'], {}, REG, 'Freshell', '/app/data', '/home/u'))
      .toEqual({
        kind: 'explicit',
        profileId: 'default',
        userDataDir: undefined,
        configDir: path.join('/home/u', '.freshell'),
      })
  })
  it('flag-less launch with a non-empty registry becomes a picker launcher on its OWN userData', () => {
    const shape = resolveBootShape(['app'], {}, REG, 'Freshell', '/app/data', '/home/u')
    expect(shape).toEqual({
      kind: 'picker',
      profileId: 'default',
      userDataDir: path.join('/app/data', 'Freshell-profile-picker'),
      configDir: path.join('/home/u', '.freshell'),
    })
    // The picker userData must never equal a real profile's dir.
    expect(shape.userDataDir).not.toBe(userDataDirForProfile('work', 'Freshell', '/app/data'))
  })
  it('flag-less launch with an empty registry is the plain default boot', () => {
    expect(resolveBootShape(['app'], {}, NO_REGISTRY, 'Freshell', '/app/data', '/home/u'))
      .toEqual({
        kind: 'default',
        profileId: 'default',
        configDir: path.join('/home/u', '.freshell'),
      })
  })
  it('explicitly requesting the reserved picker id falls back to default with an error', () => {
    const shape = resolveBootShape(['app', '--profile=profile-picker'], {}, REG, 'Freshell', '/app/data', '/home/u')
    expect(shape.kind).toBe('default')
    expect(shape.profileId).toBe('default')
    expect(shape.error).toContain('profile-picker')
  })
  it('an invalid explicit id falls back to default (no picker) with the reason preserved', () => {
    const shape = resolveBootShape(['app', '--profile=../evil'], {}, REG, 'Freshell', '/app/data', '/home/u')
    expect(shape.kind).toBe('default')
    expect(shape.userDataDir).toBeUndefined()
    expect(shape.error).toContain('../evil')
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
 * The profile-picker launcher reserves this id: a flag-less launch that is
 * about to show the picker namespaces its userData to
 * `<appData>/<AppName>-profile-picker` so the picker process never shares a
 * Chromium userData dir with a resident Default (or named) instance.
 */
export const PICKER_USERDATA_ID = 'profile-picker'

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
    if (entry.id === PICKER_USERDATA_ID) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `'${PICKER_USERDATA_ID}' is a reserved profile id` })
    }
    if (seen.has(entry.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate profile id '${entry.id}'` })
    }
    seen.add(entry.id)
  }
})

export type ProfileEntry = z.infer<typeof ProfileEntrySchema>

/**
 * Contract note — the built-in Default profile is ALWAYS part of the choice
 * set, so "more than one profile is configured" (per the User Request wording)
 * is satisfied as soon as the registry names ≥1 named profile: the effective
 * choices are `[Default, ...registry.profiles]`. This keeps the registry file
 * minimal (named profiles only) and matches the picker UX.
 */

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

/** Remove every `--profile=<id>` / `--profile <id>` pair from an argv slice.
 * Mirrors parseProfileArg exactly: `--profile` only consumes the next token
 * when it is a non-flag value; `--profile --other` drops just `--profile`
 * (since no value was taken) and keeps `--other`. */
export function stripProfileArgs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--profile=')) continue
    if (arg === '--profile') {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) i++ // consumed a real value
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
  if (raw === PICKER_USERDATA_ID) {
    return {
      selection: { id: DEFAULT_PROFILE_ID, explicit: false, source: 'default' },
      error: `Profile id '${PICKER_USERDATA_ID}' is reserved for the picker launcher; using the default profile.`,
    }
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

/**
 * userData dir for the ephemeral profile-picker launcher process. It MUST NOT
 * be the default profile's userData: when a Default instance is resident, a
 * picker launch that reused Default's userData would put two browser processes
 * on one Chromium profile dir (process-singleton violation, storage hazard).
 * The picker's own userData also re-keys the instance lock, giving one picker
 * at a time with `second-instance` focusing the resident picker.
 */
export function userDataDirForPicker(appName: string, appDataDir: string): string {
  return path.join(appDataDir, `${appName}-${PICKER_USERDATA_ID}`)
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
  let content: string | undefined
  try {
    content = readFile(registryPath)
  } catch (err) {
    // Exists-but-unreadable (EACCES, a directory named profiles.json, a TOCTOU
    // race between existsSync and readFileSync in the caller's reader): warn
    // and fall back to the default profile, exactly like an invalid registry.
    return { profiles: [], error: `Profile registry at ${registryPath} could not be read (${err instanceof Error ? err.message : String(err)}); ignoring it.` }
  }
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

/**
 * The full module-top boot decision for entry.ts. One of:
 * - 'picker': flag-less launch with ≥1 named profiles in the registry —
 *   userData is namespacespaced to the launcher dir and the boot shows ONLY
 *   the picker (configDir stays the default profile dir, since the registry
 *   and the launcher's diagnostic logs live there).
 * - 'explicit': argv/env named a valid profile — namespace userData (except
 *   default) and boot that profile.
 * - 'default': everything else — today's boot, zero behavior change.
 */
export interface BootShape {
  kind: 'picker' | 'explicit' | 'default'
  profileId: string
  userDataDir?: string
  configDir: string
  /** Set when an explicit request was invalid and default was substituted;
   *  entry.ts logs it (warn) so the fallback is visible. */
  error?: string
}

export function resolveBootShape(
  argv: string[],
  env: NodeJS.ProcessEnv,
  registry: RegistryReadResult,
  appName: string,
  appDataDir: string,
  homedir: string,
): BootShape {
  const { selection, error } = resolveProfileSelection(argv, env)
  // An explicitly requested but INVALID profile must NOT surface the picker:
  // the resolver already fell back to default; honor that and surface the
  // reason via `error`.
  if (error) {
    return {
      kind: 'default',
      profileId: DEFAULT_PROFILE_ID,
      configDir: configDirForProfile(DEFAULT_PROFILE_ID, homedir),
      error,
    }
  }
  if (selection.explicit) {
    return {
      kind: 'explicit',
      profileId: selection.id,
      userDataDir: userDataDirForProfile(selection.id, appName, appDataDir),
      configDir: configDirForProfile(selection.id, homedir),
    }
  }
  if (shouldShowProfilePicker(selection, registry)) {
    // The picker launcher is not itself a profile session: it logs to the
    // default config dir but parks its userData in its own dir.
    return {
      kind: 'picker',
      profileId: DEFAULT_PROFILE_ID,
      userDataDir: userDataDirForPicker(appName, appDataDir),
      configDir: configDirForProfile(DEFAULT_PROFILE_ID, homedir),
    }
  }
  return {
    kind: 'default',
    profileId: DEFAULT_PROFILE_ID,
    configDir: configDirForProfile(DEFAULT_PROFILE_ID, homedir),
  }
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

### Task 3: Lock split, hotkey failure logging, tray tooltip, spawn env, resident surfacing fix

Five small DI-module changes that profiles depend on. Default-path behavior
is unchanged for each except the `second-instance` surfacing fix (a deliberate
bug fix — see below). Note: `main.ts` today requests the single-instance
lock at the very END of boot (`entry.ts:662`); Task 5 will acquire it right
after `whenReady()` via the new `acquireInstanceLock` (in whichever userData
the module-top boot shape selected), fixing a pre-existing race where a
second instance booted fully (including server spawn) before being turned
away.

**Files:**
- Modify: `electron/main.ts` (new `acquireInstanceLock`; `initMainProcess` stops requesting the lock; `second-instance` handler shows tray-hidden windows)
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

  it('invokes onDenied BEFORE quitting (so entry.ts can lift the wizard-phase will-quit veto)', () => {
    const app = createMockApp()
    ;(app.requestSingleInstanceLock as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const onDenied = vi.fn()
    expect(acquireInstanceLock(app, onDenied)).toBe(false)
    expect(onDenied.mock.invocationCallOrder[0])
      .toBeLessThan((app.quit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
  })
})
```

Also add a resident-surfacing regression test — the mock app is an
`EventEmitter`, so the registered `second-instance` handler fires via `emit`:

```ts
it('shows a hidden main window before focusing it on second-instance', async () => {
  await initMainProcess(deps)

  app.emit('second-instance')

  expect(mockWindow.show).toHaveBeenCalled()
  expect(mockWindow.focus).toHaveBeenCalled()
  expect(mockWindow.show.mock.invocationCallOrder[0])
    .toBeLessThan(mockWindow.focus.mock.invocationCallOrder[0])
})

it('does not double-register second-instance when an early canonical handler exists', async () => {
  // entry.ts installs its own canonical handler in main() before any window
  // creation; initMainProcess must defer to it.
  app.on('second-instance', () => {})
  await initMainProcess(deps)
  expect(app.listenerCount('second-instance')).toBe(1)
})
```

(A tray-hidden Default window is hidden, not minimized: today the handler only
`restore()`s minimized windows, so `focus()` on a hidden window is a silent
no-op and a turned-away same-profile launch does nothing visible.)

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
  // createDefaultContext() does not provide mainProcessLogger — attach one and
  // keep a direct mock reference (the optional-chain in production code means
  // "no logger" is legal, so the test must supply one explicitly).
  const mainProcessLogger = { log: vi.fn() }
  ;(ctx as { mainProcessLogger?: { log: ReturnType<typeof vi.fn> } }).mainProcessLogger = mainProcessLogger
  ;(ctx.hotkeyManager.register as ReturnType<typeof vi.fn>).mockReturnValue(false)

  const result = await runStartup(ctx)

  expect(result.type).toBe('main')
  expect(mainProcessLogger.log).toHaveBeenCalledWith(
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
 * returns false. `onDenied` (optional) runs immediately BEFORE app.quit() —
 * entry.ts uses it to lift the wizard-phase `will-quit` veto for the denied
 * duplicate, which never enters the wizard.
 */
export function acquireInstanceLock(app: ElectronApp, onDenied?: () => void): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    onDenied?.()
    app.quit()
    return false
  }
  return true
}
```

`initMainProcess` drops its lock block; its header comment gains: "The caller
must hold the instance lock already (see `acquireInstanceLock`)."

Also in `initMainProcess`, fix the `second-instance` handler to surface a
hidden (tray-resident) window, not just a minimized one — and register it only
when no `second-instance` listener exists yet (entry.ts installs a canonical
early handler; see Task 5):

```ts
  // Second instance: surface and focus the existing window. Skipped if entry
  // already installed a canonical early handler.
  if (app.listenerCount('second-instance') === 0) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized?.()) {
          mainWindow.restore?.()
        }
        mainWindow.show?.()
        mainWindow.focus?.()
      }
    })
  }
```

(Pre-existing bug, exposed by per-profile turn-away semantics: with
`minimizeToTray: true` the resident window is hidden — `focus()` alone does
nothing visible. `listenerCount` comes free on the EventEmitter interface the
tests mock; add it to the `ElectronApp` interface too.)

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
- Modify: `server/logger.ts` (three `resolve*LogPath` fns re-routed, `FRESHELL_LOG_DIR` precedence kept)
- Modify: `server/coding-cli/codex-app-server/durability-store.ts` (re-routed, override precedence kept)
- Modify: `server/coding-cli/codex-app-server/runtime.ts` (import-time const → call-time getter, `FRESHELL_CODEX_SIDECAR_DIR` precedence kept)
- Modify: `server/fresh-agent-extras-router.ts` (attachments + checkpoint shadow repo dirs re-routed)
- Modify: `server/fresh-agent/recovery-store.ts` (constructor default re-routed; lazy singleton accepted as-is)
- Test: `test/unit/server/freshell-home.test.ts` (new)
- Test: one behavioral test per re-routed consumer (extend that consumer's existing test file; each pins profile-dir routing + override precedence)

**Interfaces:**
- Consumes: `process.env.FRESHELL_CONFIG_DIR` (absolute or relative path).
- Produces: `getFreshellConfigDir(env?)` honors the override; `runtime.ts`'s
  exported `DEFAULT_CODEX_SIDECAR_METADATA_DIR` const becomes an exported
  call-time getter (e.g. `defaultCodexSidecarMetadataDir()`) — its sole
  consumer (`:358`) is updated. All other public signatures unchanged.

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

Then route the consumer set through the helper, from the PRE-ENUMERATED table
below (load-bearing validation LB-01 replaced ad-hoc auditing; the validators'
file:line evidence is in the run-log directory of the main checkout, at
`<freshell repo main checkout>/.worktrees/.the-usual-logs/electron-multi-profile/reports/load-bearing-validator-lb-01.md`
(i.e. the `.worktrees/.the-usual-logs/` directory; these run artifacts live
OUTSIDE the git worktree and outside git history).

**a) Re-route through `getFreshellConfigDir()` (call-time) — profile-scoped:**

| Site | Change |
|---|---|
| `server/logger.ts:104-105,119-120,138-139` (three `resolve*LogPath` fns) | Route the default through `getFreshellConfigDir` (join `<configDir>/logs/<file>`), KEEPING each `FRESHELL_LOG_DIR` override's precedence unchanged (behavior-preserving when neither var is set). This is an ACCEPTANCE CRITERION of this task — the README's "logs per profile" promise (Task 9) is false without it. Do NOT apply the leave-deliberately hatch here. |
| `server/coding-cli/codex-app-server/durability-store.ts:26-27` | Default `defaultCodexDurabilityStoreDir()` to `path.join(getFreshellConfigDir(), 'codex-durability')`, keeping `FRESHELL_CODEX_DURABILITY_DIR` precedence. |
| `server/coding-cli/codex-app-server/runtime.ts:226` (consumed `:358` via `defaultMetadataDir()`) | Restructure the import-time exported const into a call-time getter (e.g. `defaultCodexSidecarMetadataDir()`), keeping `FRESHELL_CODEX_SIDECAR_DIR` precedence; update the sole consumer. |
| `server/fresh-agent-extras-router.ts:21` (attachments) | Route through `getFreshellConfigDir()`. |
| `server/fresh-agent-extras-router.ts:77` (checkpoint shadow repos) | Route through `getFreshellConfigDir()`. DECISION: profile-scoped (splitting is the lesser evil — the shadow repos track per-client edit sessions). |
| `server/fresh-agent/recovery-store.ts:59` (+ lazy singleton `:152-154`) | Route the constructor default through `getFreshellConfigDir()`. Accept the lazy-singleton binding ("env honored if set before first `get()`" — true for env-at-launch, which is the only way spawn env reaches the server). |

**b) Leave machine-global deliberately (note in commit message):**

| Site | Why machine-global |
|---|---|
| `server/network-manager.ts:67-69` (Windows firewall ports file) | One machine = one firewall; two files = split-brain port bookkeeping. ALSO: this site's `FRESHELL_HOME`-direct shape (no `/.freshell` suffix) diverges from the helper — do NOT mechanically re-route it (that would change behavior for `FRESHELL_HOME`-only deployments). Leave entirely as-is. |
| `server/wsl-port-forward.ts:60` (WSL port-forwards file) | Same one-machine rationale (one WSL VM). |
| `server/index.ts:296` (checkout-scoped extensions dir) | Deliberately cwd/project-scoped, not home state. |
| `server/mcp/config-writer.ts:163,167` (per-project MCP sidecar) | Deliberately project-scoped. |
| `server/config-store.ts:236` | Hardcoded `~/.freshell` in a user-facing warning string — cosmetic drift only, not a resolution site; leave. |

> **As-built reconciliation (post-review):** `config-store.ts:236` was
> revisited by the delta review (Minor: the hint targeted `~/.freshell` paths
> even under a named profile) and the later independent review (Minor: quote
> the rendered paths). The final text logs computed
> `backupPath()`/`configPath()` with shell quoting:
> ``mv "<backupPath>" "<configPath>"``. The exact-file staging list below is
> accordingly amended to include `server/config-store.ts`.

Already-clean call-time consumers (no changes; was the plan's old list):
`bootstrap.ts:168`, `tabs-registry/store.ts:314`, `instance-id.ts:9`,
`index.ts:241`, `cli/config.ts:10`, `get-network-host.ts:45`,
`config-store.ts:80`, and `session-scanner/service.ts:56` (lazy-bound via
`getSessionRepairService` — accepted, env-at-launch).

Sanity greps after the re-route (expect zero NEW hits vs the pre-list above):

Run: `rg -n "getFreshellHomeDir\(" server/ --type ts`
Run: `rg -n -e "\.freshell" server/ --type ts`


- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/server/freshell-home.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The re-routed consumers now call `getFreshellConfigDir()`; the import-time
const at `runtime.ts:226` is a call-time getter.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every server unit touching home/config resolution. The coordinator
classifies mixed targets (`test/unit/server` = server-owned,
`test/unit/vite-config.test.ts` = default-owned) under the DEFAULT vitest
config, which EXCLUDES `test/unit/server/**` — so never combine both in one
command; run them separately, letting the coordinator route each:

Run: `npm run test:vitest -- run test/unit/server`
Run: `npm run test:vitest -- run test/unit/vite-config.test.ts`

Expected: PASS on both (no behavior change when `FRESHELL_CONFIG_DIR` is unset
— every re-routed site's default still lands at `~/.freshell/...`; the
deliberately machine-global sites are untouched, including
`network-manager.ts`'s divergent `FRESHELL_HOME`-direct shape).

- [ ] **Step 7: Commit the task**

```bash
git add server/freshell-home.ts server/logger.ts \
  server/coding-cli/codex-app-server/durability-store.ts \
  server/coding-cli/codex-app-server/runtime.ts \
  server/fresh-agent-extras-router.ts server/fresh-agent/recovery-store.ts \
  server/config-store.ts \
  test/unit/server/freshell-home.test.ts test/unit/server/logger.test.ts \
  test/unit/server/coding-cli/codex-app-server/durability-store.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/server/fresh-agent/recovery-store.test.ts \
  test/server/fresh-agent-extras.test.ts \
  docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "feat(server): honor FRESHELL_CONFIG_DIR for config dir resolution"
```

(Stage EXACTLY these files — never `git add -A`, `-u`, or command-substitution
builts from `git diff`, which can sweep in unrelated concurrent work in this
multi-agent checkout. The test list above covers the re-routed consumers, one
behavioral test each, per the Work-queue convention.)

Commit message MUST additionally carry this rollout caveat (a near-verbatim
version also lands in the README via Task 9):

> **Daemon-unit caveat:** This change makes the Node server honor
> `FRESHELL_CONFIG_DIR`. The shipped daemon templates
> (`installers/systemd/freshell.service.template`, the launchd plist, and the
> Windows task XML) have always contained an (until now inert)
> `FRESHELL_CONFIG_DIR` line — if you previously generated a unit from them by
> hand and substituted a non-default config directory, that value now takes
> effect at the server's next start: config.json, tabs registry, instance id,
> and logs will relocate to (or be created fresh in) that directory, which
> looks like a settings reset. Either delete the `FRESHELL_CONFIG_DIR` line
> from your unit, or move your existing `~/.freshell` contents into the
> directory it names. Units installed with the default `~/.freshell` path are
> unaffected, as are all Rust-server installs (`freshell-rust.service`,
> `launch-rust.sh`), which do not read this variable.
>
> Machine-global by design (unchanged): Windows firewall port bookkeeping
> (`network-manager.ts`), WSL port-forward bookkeeping (`wsl-port-forward.ts`),
> checkout-scoped `server/index.ts` extensions dir, project-scoped MCP sidecars.
> (`load-bearing-validator-lb-01.md`, full consumer table.)

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
- Consumes: Task 2's `resolveBootShape`, `readProfilesRegistry`,
  `registryPathForHome`, `configDirForProfile`, `DEFAULT_PROFILE_ID`; Task 1's
  optional `configDir` params; Task 3's `acquireInstanceLock` and tray
  `appearance`.
- Produces: `activeProfileId`, `isPickerLauncher` + boot-bound `configDir`
  consumed by the rest of the boot; the picker window flow arrives in Task 6.

- [ ] **Step 1: Establish the red gate — profile decision covered by unit tests (Task 2), wiring covered by the sandboxed smoke**

`entry.ts` is excluded from unit tests by repo convention (its header comment).
The profile-selection DECISION is already red-green'd in Task 2 via
`resolveBootShape` unit tests. What remains untested until the wiring lands is
the wiring itself; its behavioral gate is the sandboxed xvfb smoke below
(LB-03-executed procedure). Establish the red state first:

Run the Step-4 smoke NOW, before editing `entry.ts`. Expected red evidence:
`$SMOKE/home/.freshell/logs/electron-main.*.jsonl` exists under the DEFAULT
dir (no `.freshell-smoketest/` dir exists at all) and the first log line has
no `"profile"` field — proving the wiring is absent.

Also establish compile baseline:

Run: `npm run build:electron`

Expected: PASS today (baseline for the diff).

- [ ] **Step 2: Add the wiring**

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

// --- Boot-shape resolution (must run before configDir/logger binding) -------
// One process = one Chromium userData = one instance lock, ALWAYS. Named
// profiles (--profile=<id> or FRESHELL_PROFILE) and the picker launcher each
// get their own userData dir — which also re-keys the single-instance lock —
// so the picker NEVER shares a userData dir with a resident Default instance
// (two browser processes on one profile dir is a Chromium storage hazard).
const registryAtBoot = readProfilesRegistry(
  registryPathForHome(os.homedir()),
  (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : undefined),
)
const bootShape = resolveBootShape(
  process.argv, process.env, registryAtBoot,
  app.getName(), app.getPath('appData'), os.homedir(),
)
if (bootShape.userDataDir) {
  // Electron's doc contract for app.setPath: the target directory must
  // exist. Empirically 33.4.11 does NOT throw for deep nonexistent paths on
  // Linux (load-bearing finder Appendix B.2), but create-first is the
  // documented-correct order and is required at minimum on other platforms.
  fs.mkdirSync(bootShape.userDataDir, { recursive: true })
  app.setPath('userData', bootShape.userDataDir)
}
const activeProfileId = bootShape.profileId
const isPickerLauncher = bootShape.kind === 'picker'
const configDir = bootShape.configDir
const mainProcessLogger = createElectronMainLogger({ configDir })
if (registryAtBoot.error) {
  mainProcessLogger.log({ severity: 'warn', event: 'profiles_registry_invalid', error: registryAtBoot.error })
}
if (bootShape.error) {
  mainProcessLogger.log({ severity: 'warn', component: 'electron-profile', event: 'profile_selection_invalid', error: bootShape.error })
}

/** True once this process holds its (userData-keyed) instance lock;
 *  re-entrant main() calls (wizard completion) must not re-request it. */
let instanceLockHeld = false
```

and update the imports (Task 5 needs these; the picker IPC imports arrive in
Task 6):

```ts
import {
  configDirForProfile,
  readProfilesRegistry,
  registryPathForHome,
  resolveBootShape,
  DEFAULT_PROFILE_ID,
} from './profile.js'
import { acquireInstanceLock, initMainProcess } from './main.js'
```

(remove the old `import { initMainProcess } from './main.js'`.)

(b) In `main()`, immediately after the existing `electron_main_started` log
(before `window-all-closed` registration and before any side effects such as
provisioning or server spawn). Under the round-3-corrected model EVERY process
— explicit profile, plain default, and picker launcher alike — passes this
gate; the only variance is WHICH userData (and therefore which lock) module
top selected. Task 6 will insert the profile-picker block immediately AFTER
this gate for picker launchers only:

```ts
  // Instance lock, acquired BEFORE any side effects (provisioning, server
  // spawn). Keyed to the userData dir chosen at module top: an explicit
  // profile's own dir, the default dir for a plain launch, or the launcher
  // dir for a picker launch. A same-profile duplicate quits here (delivering
  // `second-instance` to the resident, which then shows its window — see
  // Task 3's surfacing fix).
  //
  // The onDenied hook lifts the `will-quit` wizard-phase veto: at this point
  // `wizardPhase` is still true (it only flips false once a chooser/main
  // window is reached), and entry.ts's module-level `will-quit` guard would
  // otherwise preventDefault() this quit, leaving the turned-away duplicate
  // as a headless zombie process. A denied duplicate never enters the wizard,
  // so flipping it is unconditionally correct here.
  if (!instanceLockHeld) {
    if (!acquireInstanceLock(app, () => { wizardPhase = false })) {
      return
    }
    instanceLockHeld = true
  }
```

Immediately after the lock gate, register the CANONICAL `second-instance`
surfacing handler (round-4 finding: `initMainProcess` installs its handler
only at the END of boot — a duplicate arriving during the wizard/chooser
phases would deliver to a resident with NO handler registered and surface
nothing). Covering all phases from here is also what lets the e2e turn-away
spec observe real surfacing rather than tautological visibility:

```ts
  // Canonical duplicate-launch surfacing, registered ONCE, as early as
  // possible: covers the wizard, chooser, and (until initMainProcess's own
  // handler supersedes it for the main window) every intermediate phase.
  if (!app.listenerCount('second-instance')) {
    app.on('second-instance', () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
  }
```

And `initMainProcess` in Task 3 registers its `second-instance` handler ONLY
if none exists yet (`app.listenerCount('second-instance') === 0`), so the
canonical handler wins for early phases and the targeted main-window handler
takes over late-boot; main.test.ts's harness (a bare EventEmitter) supports
`listenerCount`, and a new case there pins the no-double-registration rule.

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

(d) Nothing to clean up for Task 6: a picker launcher RETURNS from main()
after `runProfilePicker` (its IPC handlers die with `app.exit(0)`), and an
explicit/default boot never registers them, so the wizard-driven main()
re-entry has no picker handlers to remove.

- [ ] **Step 3: Verify compile + unit suite + sandboxed dev smoke (green gate)**

Run: `npm run build:electron && npm run test:vitest -- --config config/vitest/vitest.electron.config.ts --run`

Expected: PASS both.

Manual smoke (sandboxed, then discard). This host has no display (`DISPLAY`
unset): without one, Electron dies at ozone init (`Missing X server or
$DISPLAY`, SIGSEGV) **before** `whenReady()`, and the main-process logger only
creates its file lazily on the first `log()` call (which fires after
`whenReady()`), so an un-wrapped run produces no log file at all. The smoke
MUST therefore run under `xvfb-run -a` with a fully throwaway HOME so the real
`~/.freshell*` is never touched (procedure executed and pinned during
load-bearing validation — report in the main checkout's run-log directory:
`<freshell repo main checkout>/.worktrees/.the-usual-logs/electron-multi-profile/reports/load-bearing-validator-lb-03.md`).
From the worktree:

```bash
SMOKE=/tmp/freshell-profile-smoke-$$
mkdir -p "$SMOKE"/{home,xdg,cache,data}
env -u DISPLAY \
  HOME="$SMOKE/home" XDG_CONFIG_HOME="$SMOKE/xdg" \
  XDG_CACHE_HOME="$SMOKE/cache" XDG_DATA_HOME="$SMOKE/data" \
  ELECTRON_DEV=0 timeout 30 xvfb-run -a npx electron . --profile=smoketest \
  > "$SMOKE/boot.log" 2>&1
echo "exit=$?"
```

Expected observable evidence:

1. `exit=124` — timeout killed a process that was still alive at 30 s. Any
   other code (1 = ozone SIGSEGV ⇒ display wrapper missing; anything else ⇒
   crash) fails the smoke. A trailing `FATAL:...Failed to shutdown` + SIGTRAP
   pair at the 30 s mark is the kill artifact, not a failure.
2. `boot.log` contains **no** `Missing X server` line and **no** mention of
   `dist/server`. It DOES contain:
   `electron: Failed to load URL: file://<worktree>/dist/wizard/index.html with error: ERR_FILE_NOT_FOUND`
   — expected, and it is the proof the boot reached the setup-wizard path: a
   fresh HOME has no `desktop.json`, so `setupCompleted:false` routes to the
   wizard (`runStartup` returns `{ type: 'wizard' }` before any server spawn),
   and `build:electron` does not build the wizard bundle (`build:wizard` /
   full `build` do). Optional: run `npm run build:wizard` first to make the
   line disappear; the smoke passes either way. GPU (`viz_main_impl`), DBus
   (`StartServiceByName ... NoReply`), UNDICI proxy, and possibly
   `electron-updater not available` lines are benign noise on this host.
3. `ls "$SMOKE/home/.freshell-smoketest/logs/"` shows
   `electron-main.<pid>.jsonl` whose first line contains
   `"event":"electron_main_started"` and `"profile":"smoketest"`.
   Timing caveat: this file is created lazily by the first log record, which
   fires only after `whenReady()` — its mere existence is the proof the display
   path worked; a no-display boot writes nothing. (The default profile would
   log to `$SMOKE/home/.freshell/logs/` instead — Task 5's namespacing is what
   moves it to `.freshell-smoketest`.)
4. `ls "$SMOKE/xdg/"` shows the profile's userData dir (per Task 2's
   `userDataDirForProfile` layout) — full userData/lock/config isolation
   assertions remain Task 8 e2e's job; this step only checks the sandbox
   captured them.
5. Leak check (must pass): `ls -ld ~/.freshell-smoketest ~/.config/freshell*`
   still says "No such file or directory", and
   `ss -tln | grep -E ':3001 |:517[3-9] '` is unchanged from before the run
   (the wizard path never spawns a server, so no new listener may appear).

Cleanup: `rm -rf "$SMOKE"`.

- [ ] **Step 4: Refactor while green**

None expected.

- [ ] **Step 5: Run impacted-test verification**

Same as Step 3 first command. Include the startup/desktop-config suites:

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts --run`

Expected: PASS

- [ ] **Step 6: Commit the task**

```bash
git add electron/entry.ts docs/plans/2026-08-26-electron-multi-profile.md
git commit -m "feat(electron): boot-time profile wiring (userData namespacing, per-profile lock, launcher-userData boot shape)"
```

---

### Task 6: Profile picker decision flow (IPC handler + preload + `entry.ts` picker)

The picker window runs in a dedicated LAUNCHER process: Task 5's module-top
`resolveBootShape` gives a picker launch its own userData dir
(`<appData>/<AppName>-profile-picker`) and the Task 5 lock gate makes it hold
the launcher-scoped instance lock. Two consequences:

1. A flag-less launch ALWAYS shows the picker when the registry names ≥1
   profile — even while a Default (or named) instance is resident — because
   the launcher never contends for a real profile's userData/lock (Chromium
   never sees two browser processes over one profile dir).
2. A racing second flag-less launch loses the launcher lock, quits at the
   gate, and the resident picker receives `second-instance` (its own handler
   surfaces the picker window — registered in `runProfilePicker` below).

EVERY confirmed choice — Default included — relaunches the app as an explicit
profile (`app.relaunch({ args: [...stripProfileArgs(argv.slice(1)), '--profile=<id>'] })`,
then `app.exit(0)`). Continuing Default in-process is NOT possible because the
launcher's userData is the launcher dir, not the default one; the relaunched
process is an explicit launch that namespaces correctly (default leaves
userData alone) and acquires the chosen profile's lock — turning away (and
surfacing the resident) when that profile is already running, via the normal
explicit-duplicate path. Closing the picker without choosing exits the app.

**Files:**
- Create: `electron/profile-choice-handler.ts`
- Modify: `electron/preload.ts` (two new channels)
- Modify: `electron/entry.ts` (picker step in `main()` + `runProfilePicker`)
- Test: `test/unit/electron/profile-choice-handler.test.ts` (new)
- Test: `test/unit/electron/preload.test.ts` (extend the exact-keys assertion — it pins the API shape and currently lists 12 keys)

**Interfaces:**
- Consumes: Task 2's `PickerEntry`, `buildPickerEntries`, `stripProfileArgs`;
  the Task 5 module-top products `registryAtBoot` and `isPickerLauncher`.
- Produces: `createChooseProfileHandler(deps)`; preload API
  `getProfiles(): Promise<PickerEntry[]>` and `chooseProfile(id): Promise<ProfileChoiceResult>`.

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/electron/preload.test.ts` — its 'has exactly the expected keys'
assertion pins the API surface and will fail until the two new keys are added
to the sorted list:

```ts
    expect(keys).toEqual([
      'chooseLaunchOption',
      'chooseProfile',
      'completeSetup',
      'getLaunchOptions',
      'getProfiles',
      'getServerMode',
      'getServerStatus',
      'installUpdate',
      'isElectron',
      'onUpdateAvailable',
      'onUpdateDownloaded',
      'openExternal',
      'platform',
      'setGlobalHotkey',
    ])
```

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
  })

  it('rejects non-string and unknown ids', async () => {
    const { deps, handler } = harness()
    expect(await handler({}, 42)).toEqual({ ok: false, error: 'Unknown profile.' })
    expect(await handler({}, 'unknown')).toEqual({ ok: false, error: 'Unknown profile.' })
    expect(deps.relaunchWithProfile).not.toHaveBeenCalled()
  })

  it('the default choice relaunches as the explicit default profile', async () => {
    const { deps, handler } = harness()
    expect(await handler({}, 'default')).toEqual({ ok: true })
    expect(deps.relaunchWithProfile).toHaveBeenCalledWith('default')
  })

  it('a named profile relaunches with it', async () => {
    const { deps, handler } = harness()
    expect(await handler({}, 'work')).toEqual({ ok: true })
    expect(deps.relaunchWithProfile).toHaveBeenCalledWith('work')
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/profile-choice-handler.test.ts test/unit/electron/preload.test.ts --run`

Expected: FAIL — `electron/profile-choice-handler.js` does not exist, and
`preload.test.ts`'s exact-keys assertion lacks `getProfiles`/`chooseProfile` in
the exposed API.

- [ ] **Step 3: Add the production implementation**

`electron/profile-choice-handler.ts`:

```ts
import { z } from 'zod'
import type { PickerEntry } from './profile.js'

export interface ChooseProfileHandlerDeps {
  entries: PickerEntry[]
  /** Defense-in-depth: only the picker window may drive this channel. */
  isAllowedSender: (event: unknown) => boolean
  /** Relaunch the app pinned to the chosen profile id, then exit this
   *  launcher process. 'default' is a valid id -- the relaunched process is
   *  an explicit launch of the default profile. */
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
    deps.relaunchWithProfile(parsed.data)
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

`electron/entry.ts` — add imports (Task 5's block already imported
`readProfilesRegistry` / `registryPathForHome` / `resolveBootShape` and defined
`registryAtBoot` / `isPickerLauncher`; extend it):

```ts
import {
  buildPickerEntries,
  stripProfileArgs,
  type PickerEntry,
} from './profile.js'
import { createChooseProfileHandler } from './profile-choice-handler.js'
```

Add the launcher picker function (module level):

```ts
/**
 * Show the profile picker and relaunch into the chosen profile.
 *
 * This launcher process holds the LAUNCHER-scoped instance lock (own
 * userData dir), so a racing flag-less launch is turned away at the lock gate
 * and delivers `second-instance` here, where we surface the existing picker
 * window. Every confirmed choice — Default included — relaunches with an
 * explicit `--profile=<id>` and exits; the relaunched process then takes the
 * chosen profile's own lock. The returned promise simply never settles.
 * Closing the picker without choosing exits the app.
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

  const cleanup = () => {
    app.removeListener('second-instance', onSecondInstance)
    ipcMain.removeHandler('get-profiles')
    ipcMain.removeHandler('choose-profile')
  }

  ipcMain.removeHandler('get-profiles')
  ipcMain.removeHandler('choose-profile')
  ipcMain.handle('get-profiles', () => entries)
  ipcMain.handle('choose-profile', createChooseProfileHandler({
    entries,
    isAllowedSender: (event) =>
      (event as { sender?: { id?: number } }).sender?.id === pickerWebContentsId,
    relaunchWithProfile: (id) => {
      const args = [...stripProfileArgs(process.argv.slice(1)), `--profile=${id}`]
      app.relaunch({ args })
      app.exit(0)
    },
  }))

  pickerWin.on('closed', () => {
    cleanup()
    app.exit(0)
  })

  if (isDev) {
    void pickerWin.loadURL('http://localhost:5179')
  } else {
    const packaged = path.join(process.resourcesPath, 'profile-picker', 'index.html')
    const unpackaged = path.join(app.getAppPath(), 'dist', 'profile-picker', 'index.html')
    void pickerWin.loadFile(fs.existsSync(packaged) ? packaged : unpackaged)
  }
  pickerWin.show()
  return new Promise<void>(() => {
    // Never settles: this launcher exits via app.exit(0) on choice or close.
  })
}
```

And in `main()`, insert the picker block AFTER the Task 5 (b) lock gate (the
gate is where the launcher locks its own userData). A picker launcher never
proceeds past this point into provisioning or startup — it shows the picker
and exits on choice/close:

```ts
  // --- Profile picker -------------------------------------------------------
  // A picker launch (no explicit profile + registry names ≥1 profile) parks
  // its userData in the launcher dir, holds the launcher lock, shows only the
  // picker, and ends here. See resolveBootShape (module top) for the shape
  // decision and runProfilePicker for choice semantics.
  if (isPickerLauncher) {
    await runProfilePicker(buildPickerEntries(registryAtBoot))
    return
  }
```

Keep the rest of `main()` untouched for explicit/default boots — a picker
launcher never reaches provisioning (`patchDesktopConfig`) or server spawn, so
no provisioning can smear onto a config before the choice is final.

- [ ] **Step 4: Run the focused test + compile**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/profile-choice-handler.test.ts test/unit/electron/preload.test.ts --run && npm run build:electron`

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
  test/unit/electron/profile-choice-handler.test.ts test/unit/electron/preload.test.ts \
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
- Packaging verification: executed `electron-builder --dir` staging smoke in Step 6 (no declarative-config test — config-text assertions do not qualify as behavioral coverage per repo policy)

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
import { ProfilePicker } from '../../../../electron/profile-picker/picker.js'

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

  it('surfaces a rejected getProfiles() promise via role="alert" instead of a blank window', async () => {
    window.freshellDesktop = {
      getProfiles: vi.fn().mockRejectedValue(new Error('ipc blew up')),
      chooseProfile: vi.fn(),
    }
    render(<ProfilePicker />)
    expect((await screen.findByRole('alert')).textContent).toContain('ipc blew up')
  })

  it('surfaces a rejected chooseProfile() promise via role="alert"', async () => {
    const chooseProfile = vi.fn().mockRejectedValue(new Error('channel closed'))
    installDesktopApi({ chooseProfile })
    render(<ProfilePicker />)
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    expect((await screen.findByRole('alert')).textContent).toContain('channel closed')
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
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load profiles')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const choose = async (id: string) => {
    setError(null)
    try {
      const result = await window.freshellDesktop?.chooseProfile?.(id)
      if (result && !result.ok) setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to choose profile')
    }
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

- [ ] **Step 6: Verify packaging behaviorally + run impacted tests**

The house convention for config assertions (`electron-builder-config.test.ts`)
is regex-only; repo guidance says config-text assertions do not qualify as
behavioral verification. The real question is whether a packaged build
contains the picker. Verify by staging an actual package layout:

```bash
npm run build && npm run build:electron && npm run build:wizard && \
  npm run build:launch-chooser && npm run build:profile-picker && \
  npm run prepare:bundled-node
npx electron-builder --config config/electron-builder.yml --dir
test -f release/linux-unpacked/resources/profile-picker/index.html && echo "picker staged"
```

(NOTE: `config/electron-builder.yml` sets `directories.output: release` — the
staged layout lands under `release/linux-unpacked/` on Linux, NOT `dist/`,
so the assertion above must use `release/`. Adjust the platform dir segment
for the host OS. `--dir` stages the full packaged layout without building an
installer. If `prepare:bundled-node` is unusually slow, it may be skipped for
THIS check only: extraResources staging does not depend on the bundled
runtime.)

Expected: the file exists (electron-builder copied `dist/profile-picker` into
`resources/profile-picker`). If it does not, the extraResources mapping is
wrong at the electron-builder layer — fix the yml entry, not the assertion.

Then:

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts --run`

Expected: PASS. (No new declarative-config test is added; the `--dir` smoke is
the packaging verification.)

- [ ] **Step 7: Commit the task**

```bash
git add electron/profile-picker/ config/vite/vite.profile-picker.config.ts \
  package.json config/electron-builder.yml tsconfig.electron.json \
  test/unit/electron/profile-picker/picker.test.tsx \
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
  // Sandbox ALL of Electron's per-user dirs, not just HOME: on Linux appData
  // (and thus userData + the single-instance lock key) derives from
  // XDG_CONFIG_HOME, and Chromium also writes XDG_CACHE_HOME/XDG_DATA_HOME.
  // Without these, named profiles and locks could escape into the real home
  // and collide with a live install (evidence: load-bearing-validator-lb-03).
  //
  // Also scrub profile-selection env from the ambient shell: an exported
  // FRESHELL_PROFILE would silently make every "flag-less" spec explicit,
  // and ELECTRON_DEV=1 would point the picker/wizard at dev-server URLs
  // instead of the built dist/ assets these specs assert on.
  const env = { ...process.env }
  delete env.FRESHELL_PROFILE
  delete env.ELECTRON_DEV
  return electron.launch({
    args: [PROJECT_ROOT, ...extraArgs],
    env: {
      ...env,
      HOME: tmpHome,
      XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
      XDG_CACHE_HOME: path.join(tmpHome, '.cache'),
      XDG_DATA_HOME: path.join(tmpHome, '.local', 'share'),
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
      // Hard-exit first (see the as-built reconciliation note at the end of
      // this task's snippet): wizard/picker-phase apps veto app.quit(), so a
      // bare close would hang the worker teardown.
      await app.evaluate(() => process.exit(0)).catch(() => {})
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

  // Every picker choice (Default included) relaunches as an explicit profile:
  // the launcher's userData is the launcher dir, so continuing in-process
  // would leak launcher storage into a real profile. Stub relaunch/exit in
  // the main process before clicking and assert the rebuilt argv.
  test('choosing Default from the picker relaunches as --profile=default', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })
    app = await launchApp(tmpHome)

    await app.evaluate(({ app: electronApp }) => {
      const g = globalThis as Record<string, unknown>
      g.__relaunchCalls = []
      ;(electronApp as unknown as Record<string, unknown>).relaunch = (opts: unknown) => {
        ;(g.__relaunchCalls as unknown[]).push(opts)
      }
      ;(electronApp as unknown as Record<string, unknown>).exit = (code: number) => {
        g.__exitCode = code
      }
    })

    const picker = await app.firstWindow()
    await picker.waitForLoadState('domcontentloaded')
    await picker.getByRole('button', { name: 'Default' }).click()

    await expect.poll(async () => app.evaluate(() => (globalThis as Record<string, unknown>).__exitCode ?? null),
      { timeout: 15_000 }).toBe(0)
    const relaunchCalls = await app.evaluate(() => (globalThis as Record<string, unknown>).__relaunchCalls)
    expect(relaunchCalls).toHaveLength(1)
    expect((relaunchCalls as { args: string[] }[])[0].args).toContain('--profile=default')
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

  // Two DIFFERENT named profiles must boot side by side (independent userData
  // locks), each reading its OWN config and loading its OWN server. The test
  // process hosts two throwaway HTTP stub servers with distinct marker bodies;
  // each profile's remote-mode desktop.json points at one stub. Window URLs
  // then prove the full chain per profile: config-dir read → remote mode →
  // window loaded the seeded server.
  test('two named profiles run concurrently, each loading its own server', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'e2ework' }, { id: 'e2ehome' }] })

    const http = await import('http')
    const stub = (marker: string) => new Promise<{ url: string; server: import('http').Server }>((resolve) => {
      const server = http.createServer((req, res) => {
        res.setHeader('content-type', (req.url ?? '').includes('/api/') ? 'application/json' : 'text/html')
        if ((req.url ?? '').includes('/api/')) {
          res.end(JSON.stringify({ ok: true }))
        } else {
          res.end(`<html><body>MARKER:${marker}</body></html>`)
        }
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') throw new Error('stub listen failed')
        resolve({ url: `http://127.0.0.1:${addr.port}`, server })
      })
    })
    const [s1, s2] = await Promise.all([stub('WORK'), stub('HOME')])

    const seedRemote = (id: string, url: string) => {
      const dir = path.join(tmpHome!, `.freshell-${id}`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'desktop.json'), JSON.stringify({
        serverMode: 'remote', port: 3001,
        remoteUrl: url, remoteToken: 'e2e-token',
        knownServers: [{ url, label: id }],
        alwaysAskOnLaunch: false, globalHotkey: 'CommandOrControl+`',
        startOnLogin: false, minimizeToTray: false, setupCompleted: true,
      }, null, 2))
    }
    seedRemote('e2ework', s1.url)
    seedRemote('e2ehome', s2.url)

    app = await launchApp(tmpHome, ['--profile=e2ework'])
    const app2 = await launchApp(tmpHome, ['--profile=e2ehome'])
    try {
      // Both alive (independent per-profile locks).
      expect(app.process().exitCode).toBeNull()
      expect(app2.process().exitCode).toBeNull()

      const w1 = await app.firstWindow()
      const w2 = await app2.firstWindow()
      // Neither shows the first-run wizard (each read its OWN seeded config).
      await expect.poll(async () => {
        const isWizard = async (w: typeof w1) => (await w.locator('h1:has-text("Welcome to Freshell")').count()) > 0
        return !(await isWizard(w1)) && !(await isWizard(w2))
      }, { timeout: 30_000 }).toBe(true)

      // The core requested-behavior proof: each profile's window navigated to
      // ITS OWN stub server. URL equality per profile = wrong-config wiring
      // would land both windows on the same URL.
      await expect.poll(() => w1.url(), { timeout: 30_000 }).toContain(String(new URL(s1.url).port))
      await expect.poll(() => w2.url(), { timeout: 30_000 }).toContain(String(new URL(s2.url).port))
      await expect(w1.locator('text=MARKER:WORK')).toBeVisible({ timeout: 30_000 })
      await expect(w2.locator('text=MARKER:HOME')).toBeVisible({ timeout: 30_000 })

      const ud1 = await app.evaluate(({ app: a1 }) => a1.getPath('userData'))
      const ud2 = await app2.evaluate(({ app: a2 }) => a2.getPath('userData'))
      expect(path.basename(ud1).toLowerCase()).toBe('freshell-e2ework')
      expect(path.basename(ud2).toLowerCase()).toBe('freshell-e2ehome')

      for (const id of ['e2ework', 'e2ehome']) {
        await expect.poll(() => {
          const d = path.join(tmpHome!, `.freshell-${id}`, 'logs')
          return fs.existsSync(d) && fs.readdirSync(d).some((f) => /^electron-main\..*\.jsonl$/.test(f))
        }, { timeout: 15_000 }).toBe(true)
      }
      // The default profile dir received no logs from either named process.
      expect(fs.existsSync(path.join(tmpHome, '.freshell', 'logs'))).toBe(false)
    } finally {
      await app2.close().catch(() => {})
      s1.server.close()
      s2.server.close()
    }
  })

  // The relaunch path itself must be proven: stub app.relaunch/app.exit in the
  // main process before clicking, then assert the IPC choice rebuilt argv with
  // --profile (an unstubbed relaunch would re-exec and lose the assertion).
  test('choosing a named profile from the picker relaunches with --profile=<id>', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })
    app = await launchApp(tmpHome)

    await app.evaluate(({ app: electronApp }) => {
      const g = globalThis as Record<string, unknown>
      g.__relaunchCalls = []
      ;(electronApp as unknown as Record<string, unknown>).relaunch = (opts: unknown) => {
        ;(g.__relaunchCalls as unknown[]).push(opts)
      }
      ;(electronApp as unknown as Record<string, unknown>).exit = (code: number) => {
        g.__exitCode = code
      }
    })

    const picker = await app.firstWindow()
    await picker.waitForLoadState('domcontentloaded')
    await picker.getByRole('button', { name: 'Work' }).click()

    await expect.poll(async () => app.evaluate(() => (globalThis as Record<string, unknown>).__exitCode ?? null),
      { timeout: 15_000 }).toBe(0)
    const relaunchCalls = await app.evaluate(() => (globalThis as Record<string, unknown>).__relaunchCalls)
    expect(relaunchCalls).toHaveLength(1)
    expect((relaunchCalls as { args: string[] }[])[0].args).toContain('--profile=work')
    // stripProfileArgs must not double-append: exactly one --profile= entry.
    expect((relaunchCalls as { args: string[] }[])[0].args.filter((a) => a.startsWith('--profile='))).toHaveLength(1)
  })

  test('an invalid registry file is ignored and the default profile boots', async () => {
    tmpHome = createTempHomeWithRegistry('not valid json {{{')
    app = await launchApp(tmpHome)

    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect(window.locator('h1:has-text("Welcome to Freshell")')).toBeVisible({ timeout: 30_000 })
  })

  // LB-02 / dedicated-launcher design: a flag-less launch must reach the
  // picker even while a Default-profile instance is resident (the launcher
  // parks in its own userData with its own lock, so Default never blocks it).
  // This is the steady state the feature exists for (minimizeToTray
  // defaults true, so Default typically stays resident).
  test('a flag-less launch while Default is resident still shows the picker', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })

    // First process: an EXPLICIT default launch becomes the resident Default
    // instance (a picker choice would relaunch into a new untracked process).
    app = await launchApp(tmpHome, ['--profile=default'])
    const window1 = await app.firstWindow()
    await window1.waitForLoadState('domcontentloaded')
    await expect(window1.locator('h1:has-text("Welcome to Freshell")'))
      .toBeVisible({ timeout: 30_000 })

    // Second flag-less launch shows the picker: the launcher's userData (and
    // lock) is the dedicated launcher dir, so the resident Default does not
    // contend with it at all.
    const app2 = await launchApp(tmpHome)
    try {
      const picker2 = await app2.firstWindow()
      await picker2.waitForLoadState('domcontentloaded')
      await expect(
        picker2.getByRole('heading', { name: 'Choose a Freshell profile' }),
      ).toBeVisible({ timeout: 30_000 })
    } finally {
      await app2.close().catch(() => {})
    }
  })

  // Racing flag-less launches: the second one loses the launcher lock, exits,
  // and the resident picker receives second-instance (one picker at a time).
  test('a second flag-less launch is turned away and delivers second-instance to the resident picker', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })
    app = await launchApp(tmpHome)
    const picker = await app.firstWindow()
    await picker.waitForLoadState('domcontentloaded')
    await expect(picker.getByRole('heading', { name: 'Choose a Freshell profile' }))
      .toBeVisible({ timeout: 30_000 })

    await app.evaluate(({ app: launcherApp }) => {
      ;(globalThis as Record<string, unknown>).__pickerSecondInstance = 0
      launcherApp.on('second-instance', () => {
        ;(globalThis as Record<string, unknown>).__pickerSecondInstance =
          ((globalThis as Record<string, unknown>).__pickerSecondInstance as number) + 1
      })
    })

    const app2 = await launchApp(tmpHome)
    await expect.poll(() => app2.process().exitCode, { timeout: 30_000 }).not.toBeNull()
    await app2.close().catch(() => {})

    await expect.poll(
      () => app.evaluate(() => (globalThis as Record<string, unknown>).__pickerSecondInstance),
      { timeout: 15_000 },
    ).toBe(1)
    // The resident picker is still there, alive.
    expect(app.process().exitCode).toBeNull()
    await expect(picker.getByRole('heading', { name: 'Choose a Freshell profile' })).toBeVisible()
  })

  // Same-profile turn-away: an explicit duplicate of the resident profile is
  // turned away at the lock gate; the resident's production second-instance
  // handler (installed in main(), not a test listener) surfaces it — proven
  // by hiding the resident's wizard window and asserting it re-appears.
  test('an explicit duplicate of a resident profile quits and the resident surfaces', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })
    app = await launchApp(tmpHome, ['--profile=work'])
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // Named profile, fresh HOME → first-run wizard proves we are resident.
    await expect(window.locator('h1:has-text("Welcome to Freshell")')).toBeVisible({ timeout: 30_000 })

    // Hide the resident's window via the resident's own BrowserWindow API; the
    // surfacing claim only means something if production code is what restores
    // visibility. NB: read NATIVE visibility via isVisible() in the main
    // process — a DOM locator's visibility does not reflect native window show/hide.
    await app.evaluate(({ BrowserWindow: BW }) => {
      const win = BW.getAllWindows().find((w) => !w.isDestroyed())
      win?.hide()
    })
    const isNativeVisible = () => app.evaluate(({ BrowserWindow: BW }) => {
      const win = BW.getAllWindows().find((w) => !w.isDestroyed())
      return win ? win.isVisible() : false
    })
    expect(await isNativeVisible()).toBe(false)

    const app2 = await launchApp(tmpHome, ['--profile=work'])
    await expect.poll(() => app2.process().exitCode, { timeout: 30_000 }).not.toBeNull()
    await app2.close().catch(() => {})

    // Production `second-instance` handler surfaced the resident's window.
    // (The resident's wizard was hidden by the test above; only production
    // surfacing can flip this back on.)
    await expect.poll(isNativeVisible, { timeout: 15_000 }).toBe(true)
    expect(app.process().exitCode).toBeNull()
  })
})
```

> **As-built reconciliation (post-execution):** three places above were revised
> during implementation; the committed file
> (`test/e2e-electron/profile-picker.test.ts`) is authoritative:
>
> 1. `test.afterEach` hard-exits the app before `app.close()`:
>    `await app.evaluate(() => process.exit(0)).catch(() => {})` — wizard/picker
>    phase apps veto `app.quit()` via the `wizardPhase` will-quit guard, so a
>    plain close hangs Playwright's worker teardown (120 s).
> 2. Both turn-away specs (the picker-race one at ~line 2830 and the duplicate
>    one at ~line 2869) spawn the duplicate as a raw `child_process` of the
>    Electron binary via a `spawnDuplicateAndWaitForExit(tmpHome, extraArgs)`
>    helper instead of `electron.launch` — `electron.launch`'s `process()`
>    handle throws (`Cannot read properties of undefined (reading '_object')`)
>    for a short-lived turned-away app; the committed assertions are
>    `expect(await spawnDuplicateAndWaitForExit(tmpHome[, '--profile=work'])).toBe(0)`.
> 3. The Electron binary path is resolved portably via the `electron` package
>    export (`createRequire(import.meta.url)('electron')` as `ELECTRON_BIN`),
>    not the hardcoded Linux `node_modules/electron/dist/electron` path.
>
> These were discovered because the as-drafted specs hung/failed on first run;
> no plan-behavior contract changed.

- [ ] **Step 2: Run the spec and verify it passes against the integrated implementation**

Prereqs (fresh builds the picker's prod load path needs):

Run: `npm run build:electron && npm run build:wizard && npm run build:profile-picker`

Then: `CI=true npx playwright test --config test/e2e-electron/playwright.electron.config.ts profile-picker`

(On this headless Linux box Electron needs a display; if the run fails with
`Missing X server`/`$DISPLAY` errors, re-run as
`CI=true xvfb-run -a npx playwright test --config test/e2e-electron/playwright.electron.config.ts profile-picker`.)

NOTE on red/green honesty: this e2e suite lands LAST, after the implementation
tasks it integrates (Tasks 5-7), so it cannot serve as the red gate for those
tasks — its failure-first evidence lives in the unit tasks of Tasks 2-7 (each
names its red expectation) and in the load-bearing validators' executed
experiments (the `--profile` flag is inert at base_ref, so a checkout at
base_ref necessarily fails the namespacing and picker specs). What Step 2/3
protect is end-to-end integration: if any spec fails here, the wiring across
Tasks 5-7 is wrong — fix the implementation, not the spec.

- [ ] **Step 3: Confirm all nine specs pass**

Run: `CI=true npx playwright test --config test/e2e-electron/playwright.electron.config.ts profile-picker` (with `xvfb-run -a` if needed)

Expected: 9 passed.

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

The README has no dedicated desktop/Electron install section; insert the new
`## Desktop profiles (multiple instances)` section immediately before the
existing `## Usage` section (the desktop app is described inside Features and
Usage, so this placement is adjacent to where desktop usage is documented):

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
(max 32 chars); `default` and `profile-picker` are reserved (the first means
the original un-namespaced environment; the second is the picker launcher's
own storage dir); `label` is optional display text.

When at least one named profile is defined, launching the app without a
profile shows a picker (the default profile is always listed first; the built-
in default counts, so one named profile in the file already means "more than
one configured"). The picker is a small launcher: whichever profile you pick,
the app relaunches itself pinned to it — you'll see a quick restart, then the
app continues in the chosen profile. Pin a launch to a profile with
`--profile=<id>` or `FRESHELL_PROFILE=<id>`; named ids do not have to be
listed in `profiles.json` — an unlisted id simply starts with a fresh
configuration.

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
- Relaunching while a profile is running: on Linux/Windows, a launch without a
  flag shows the picker again and choosing the running profile focuses its
  window; launching with the same `--profile` as a running instance focuses
  that window (the new process quits). On macOS, relaunching from Finder or
  the Dock while ANY Freshell instance is running just activates the running
  instance (the OS enforces this) and never shows the picker — use
  `--profile=` flags or `FRESHELL_PROFILE` from a terminal, or Quit before
  relaunching to get the picker. Two simultaneous flag-less launches race for
  the picker's launcher slot: the first shows the picker; the second quietly
  exits and brings the existing picker forward.
- Daemon-service caveat for the Node server: the shipped daemon templates have
  always contained an (until now inert) `FRESHELL_CONFIG_DIR` environment
  line; starting with this release the Node server honors it. If you
  hand-generated a daemon unit from those templates with a non-default config
  directory, the value now takes effect at next start (state relocates to that
  directory): remove the line from your unit, or move your existing
  `~/.freshell` contents into the directory it names. Units using the default
  `~/.freshell` path are unaffected; Rust-server installs never read this
  variable.
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

## As-built changes from the post-execution independent review

One behavioral change landed after the original 9 tasks, driven by review:

- **Named app-bound/daemon profiles never adopt a discovery-found server.**
  `chooseLaunchAction` previously auto-connected to a single scanning-based
  localhost candidate before falling through to `start-local`; with one
  profile's server resident, a different app-bound profile would attach to
  the wrong server and config identity. `launch-policy.ts` and `startup.ts`
  now treat `profileId` (passed from `entry.ts`) as an ownership boundary:
  named profiles in `app-bound`/`daemon` mode skip discovery and always
  `start-local`. The default profile's historical discovery behavior is
  unchanged. Regression coverage: `test/unit/electron/launch-policy.test.ts`
  ('named profiles') and `test/unit/electron/startup.test.ts` ('app-bound
  mode').

---

## Final verification gate

After all tasks: run the coordinated full suite once on HEAD.

Run: `FRESHELL_TEST_SUMMARY='electron-multi-profile final gate' npm run check`

Expected: PASS (green except for any baseline-ledgered pre-existing failures;
there were none at base_ref).
