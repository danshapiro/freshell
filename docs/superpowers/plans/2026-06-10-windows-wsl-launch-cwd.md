# Windows WSL Launch Cwd Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Freshell accept Windows and WSL path inputs without passing the wrong cwd flavor to Linux, WSL, or Windows child processes.

**Architecture:** Introduce one shared launch-cwd resolver that converts paths only between equivalent filesystem representations, such as `D:\x` and `/mnt/d/x`. Keep user-facing display paths separate from launch paths, and resolve cwd at the final process-launch boundary based on the child process target runtime. Apply the resolver to existing terminal spawn specs and to the Codex app-server sidecar so Windows paths cannot leak into Linux `spawn(..., { cwd })`.

**Tech Stack:** TypeScript, Node.js `path`/`fs`, Vitest, existing Freshell WebSocket/terminal/Codex app-server runtime.

---

## Scope Check

This change touches one subsystem: cwd resolution for process launch boundaries. It should not change project identity semantics, session grouping, file-picker display behavior, or directory aliases. In particular, `D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck` must not silently map to `/home/dan/code/DirectorDeck`; those are different directories.

The plan includes:
- Shared resolver unit tests for Windows-to-WSL and WSL-to-Windows mechanical conversions.
- Terminal spawn-spec regression tests to preserve current shell behavior.
- Codex app-server runtime regression tests proving the actual sidecar launches from the converted WSL cwd and fails clearly before spawn when the converted cwd is missing.

## File Structure

- Create `server/launch-cwd.ts`
  - Owns target-runtime cwd resolution.
  - Converts only mechanical same-filesystem forms:
    - Windows drive path to WSL mount path for Linux/WSL child processes.
    - WSL drive mount path to Windows drive path for Windows child processes.
  - Returns `undefined` when conversion is not mechanically safe, such as `/home/dan/project` to a Windows cwd.

- Create `test/unit/server/launch-cwd.test.ts`
  - Unit tests for the shared resolver.
  - Covers WSL, native Windows target behavior, custom WSL mount prefixes, and no silent mapping to `/home`.

- Modify `server/terminal-registry.ts`
  - Replace local cwd conversion helpers with wrappers around `resolveLaunchCwd`.
  - Preserve existing `buildSpawnSpec` behavior for shell, cmd, PowerShell, and coding CLI modes.

- Modify `test/unit/server/terminal-registry.test.ts`
  - Add regression assertions that WSL-hosted Linux Codex gets `/mnt/d/...`, and Windows shells get `D:\...`.

- Modify `server/coding-cli/codex-app-server/runtime.ts`
  - Resolve sidecar cwd as `linux-process` before compatibility checks and spawn.
  - Preflight reachable directory checks so invalid cwd errors name the input path and converted launch path instead of surfacing `spawn codex ENOENT`.

- Modify `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
  - Add runtime tests with the fake app-server proving Windows cwd inputs launch under the converted WSL mount path.
  - Add a clear-error test for missing converted cwd.

- Documentation
  - No `README.md` change is required because this is a bug fix and launch correctness change, not an end-user feature or workflow change.
  - Do not add docs outside `README.md`.

## Execution Preflight

- [ ] **Step 1: Verify the base before creating the worktree**

Run from `/home/dan/code/freshell`:

```bash
FRESHELL_TEST_SUMMARY="baseline before windows-wsl-launch-cwd worktree" npm run check
```

Expected: PASS. If this fails, stop before creating a worktree and report the failing command plus the failure summary.

- [ ] **Step 2: Create the implementation worktree**

Run from `/home/dan/code/freshell`:

```bash
rg -n '^\.worktrees/' .gitignore
git fetch origin
git worktree add -b windows-wsl-launch-cwd .worktrees/windows-wsl-launch-cwd origin/main
cd .worktrees/windows-wsl-launch-cwd
```

Expected: `rg` finds `.worktrees/` in `.gitignore`, and `git worktree add` creates `.worktrees/windows-wsl-launch-cwd`.

### Task 1: Shared Launch Cwd Resolver

**Files:**
- Create: `server/launch-cwd.ts`
- Create: `test/unit/server/launch-cwd.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Create `test/unit/server/launch-cwd.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import {
  convertWslDrivePathToWindowsPath,
  resolveLaunchCwd,
} from '../../../server/launch-cwd.js'

const originalPlatform = process.platform
const originalEnv = { ...process.env }

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  })
}

function mockWsl(mountPrefix = '/mnt'): void {
  mockPlatform('linux')
  process.env.WSL_DISTRO_NAME = 'Ubuntu'
  process.env.WSL_WINDOWS_SYS32 = `${mountPrefix}/c/Windows/System32`
}

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  })
  process.env = { ...originalEnv }
})

describe('resolveLaunchCwd', () => {
  it('converts a Windows drive cwd to the equivalent WSL mount for Linux processes in WSL', () => {
    mockWsl()

    const result = resolveLaunchCwd(String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`, {
      targetRuntime: 'linux-process',
    })

    expect(result).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`,
      displayCwd: String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`,
      launchCwd: '/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck',
      conversion: 'windows-drive-to-wsl-mount',
    })
  })

  it('does not map a Windows drive cwd to a same-named checkout under /home', () => {
    mockWsl()

    const result = resolveLaunchCwd(String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`, {
      targetRuntime: 'linux-process',
    })

    expect(result.launchCwd).toBe('/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck')
    expect(result.launchCwd).not.toBe('/home/dan/code/DirectorDeck')
  })

  it('respects a custom WSL drive mount prefix for Linux process cwd conversion', () => {
    mockWsl('/win')

    const result = resolveLaunchCwd(String.raw`D:\work\app`, {
      targetRuntime: 'linux-process',
    })

    expect(result.launchCwd).toBe('/win/d/work/app')
    expect(result.conversion).toBe('windows-drive-to-wsl-mount')
  })

  it('keeps POSIX cwd values unchanged for Linux processes', () => {
    mockWsl()

    const result = resolveLaunchCwd('/home/dan/code/DirectorDeck', {
      targetRuntime: 'linux-process',
    })

    expect(result).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: '/home/dan/code/DirectorDeck',
      displayCwd: '/home/dan/code/DirectorDeck',
      launchCwd: '/home/dan/code/DirectorDeck',
      conversion: 'none',
    })
  })

  it('converts a WSL drive mount cwd to a Windows drive cwd for Windows processes in WSL', () => {
    mockWsl()

    const result = resolveLaunchCwd('/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck', {
      targetRuntime: 'windows-process',
    })

    expect(result).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: '/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck',
      displayCwd: '/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck',
      launchCwd: String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`,
      conversion: 'wsl-mount-to-windows-drive',
    })
  })

  it('keeps Windows cwd values unchanged for Windows processes in WSL', () => {
    mockWsl()

    const result = resolveLaunchCwd(String.raw`D:\Users\Dan\workspace`, {
      targetRuntime: 'windows-process',
    })

    expect(result.launchCwd).toBe(String.raw`D:\Users\Dan\workspace`)
    expect(result.conversion).toBe('none')
  })

  it('does not produce a Windows cwd for Linux-only /home paths', () => {
    mockWsl()

    const result = resolveLaunchCwd('/home/dan/code/freshell', {
      targetRuntime: 'windows-process',
    })

    expect(result).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: '/home/dan/code/freshell',
      displayCwd: '/home/dan/code/freshell',
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it('normalizes Windows cwd values for native Windows processes', () => {
    mockPlatform('win32')

    const result = resolveLaunchCwd(String.raw`D:\Users\Dan\workspace\..\\DirectorDeck`, {
      targetRuntime: 'windows-process',
    })

    expect(result.launchCwd).toBe(String.raw`D:\Users\Dan\DirectorDeck`)
    expect(result.conversion).toBe('none')
  })

  it('does not convert native Windows drive cwd values for Linux process targets outside WSL', () => {
    mockPlatform('win32')

    const result = resolveLaunchCwd(String.raw`C:\Users\Dan\repo`, {
      targetRuntime: 'linux-process',
    })

    expect(result).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: String.raw`C:\Users\Dan\repo`,
      displayCwd: String.raw`C:\Users\Dan\repo`,
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it('keeps double-slash paths aligned with terminal registry path semantics', () => {
    mockWsl()

    expect(resolveLaunchCwd('//server/share', { targetRuntime: 'linux-process' })).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: '//server/share',
      displayCwd: '//server/share',
      launchCwd: '//server/share',
      conversion: 'none',
    })
    expect(resolveLaunchCwd('//server/share', { targetRuntime: 'windows-process' })).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: '//server/share',
      displayCwd: '//server/share',
      launchCwd: undefined,
      conversion: 'none',
    })
  })
})

describe('convertWslDrivePathToWindowsPath', () => {
  it('converts standard WSL drive mounts to Windows drive paths', () => {
    mockWsl()

    expect(convertWslDrivePathToWindowsPath('/mnt/d/projects/demo')).toBe(String.raw`D:\projects\demo`)
  })

  it('converts custom WSL drive mounts to Windows drive paths', () => {
    mockWsl('/win')

    expect(convertWslDrivePathToWindowsPath('/win/d/projects/demo')).toBe(String.raw`D:\projects\demo`)
  })

  it('returns undefined for Linux-only paths', () => {
    mockWsl()

    expect(convertWslDrivePathToWindowsPath('/home/dan/code/freshell')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the resolver tests and verify they fail**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/launch-cwd.test.ts
```

Expected: FAIL with an import error because `server/launch-cwd.ts` does not exist.

- [ ] **Step 3: Implement the shared resolver**

Create `server/launch-cwd.ts`:

```ts
import path from 'node:path'
import {
  convertWindowsPathToWslPath,
  sanitizeUserPathInput,
} from './path-utils.js'

const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:([\\/]|$)/
const WINDOWS_UNC_PREFIX_RE = /^\\\\[^\\]+\\[^\\]+/
const WINDOWS_ROOTED_PREFIX_RE = /^\\(?!\\)/
const POSIX_ABSOLUTE_PREFIX_RE = /^\//

export type LaunchCwdTargetRuntime = 'linux-process' | 'windows-process'

export type LaunchCwdConversion =
  | 'none'
  | 'windows-drive-to-wsl-mount'
  | 'wsl-mount-to-windows-drive'

export type ResolvedLaunchCwd = {
  targetRuntime: LaunchCwdTargetRuntime
  inputCwd?: string
  displayCwd?: string
  launchCwd?: string
  conversion: LaunchCwdConversion
}

export function isWslRuntime(): boolean {
  return process.platform === 'linux' && (
    !!process.env.WSL_DISTRO_NAME
    || !!process.env.WSL_INTEROP
    || !!process.env.WSLENV
  )
}

function isLinuxPath(input: string): boolean {
  return POSIX_ABSOLUTE_PREFIX_RE.test(input) && !input.startsWith('//')
}

function isWindowsAbsolutePath(input: string): boolean {
  return WINDOWS_DRIVE_PREFIX_RE.test(input)
    || WINDOWS_UNC_PREFIX_RE.test(input)
    || WINDOWS_ROOTED_PREFIX_RE.test(input)
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getWslMountPrefix(): string {
  const sys32 = process.env.WSL_WINDOWS_SYS32
  if (sys32) {
    const normalized = sys32.replace(/\\/g, '/')
    const match = normalized.match(/^(.*)\/[a-zA-Z]\//)
    if (match) return match[1]
  }
  return '/mnt'
}

export function convertWslDrivePathToWindowsPath(input: string): string | undefined {
  const normalized = sanitizeUserPathInput(input).replace(/\\/g, '/')
  if (!normalized) return undefined

  const mountPrefix = getWslMountPrefix()
  const prefixes = new Set([mountPrefix, '/mnt'])

  for (const prefix of prefixes) {
    const match = prefix
      ? normalized.match(new RegExp(`^${escapeRegex(prefix)}/([a-zA-Z])(?:/(.*))?$`))
      : normalized.match(/^\/([a-zA-Z])(?:\/(.*))?$/)
    if (!match) continue

    const drive = `${match[1].toUpperCase()}:`
    const rest = match[2]?.replace(/\//g, '\\')
    return rest ? `${drive}\\${rest}` : `${drive}\\`
  }

  return undefined
}

function resolveLinuxProcessCwd(candidate: string): Pick<ResolvedLaunchCwd, 'launchCwd' | 'conversion'> {
  if (isLinuxPath(candidate)) {
    return { launchCwd: candidate, conversion: 'none' }
  }

  if (isWindowsAbsolutePath(candidate) && isWslRuntime()) {
    const converted = convertWindowsPathToWslPath(candidate)
    if (converted) {
      return { launchCwd: converted, conversion: 'windows-drive-to-wsl-mount' }
    }
  }

  if (isWindowsAbsolutePath(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  return { launchCwd: candidate, conversion: 'none' }
}

function resolveWindowsProcessCwd(candidate: string): Pick<ResolvedLaunchCwd, 'launchCwd' | 'conversion'> {
  if (isLinuxPath(candidate)) {
    const converted = convertWslDrivePathToWindowsPath(candidate)
    if (converted) {
      return { launchCwd: converted, conversion: 'wsl-mount-to-windows-drive' }
    }
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (WINDOWS_UNC_PREFIX_RE.test(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (isWindowsAbsolutePath(candidate) || !isWslRuntime()) {
    return { launchCwd: path.win32.resolve(candidate), conversion: 'none' }
  }

  return { launchCwd: undefined, conversion: 'none' }
}

export function resolveLaunchCwd(
  rawCwd: string | undefined,
  options: { targetRuntime: LaunchCwdTargetRuntime },
): ResolvedLaunchCwd {
  const cleaned = typeof rawCwd === 'string' ? sanitizeUserPathInput(rawCwd) : ''
  if (!cleaned) {
    return {
      targetRuntime: options.targetRuntime,
      launchCwd: undefined,
      conversion: 'none',
    }
  }

  const resolved = options.targetRuntime === 'linux-process'
    ? resolveLinuxProcessCwd(cleaned)
    : resolveWindowsProcessCwd(cleaned)

  return {
    targetRuntime: options.targetRuntime,
    inputCwd: rawCwd,
    displayCwd: cleaned,
    launchCwd: resolved.launchCwd,
    conversion: resolved.conversion,
  }
}
```

- [ ] **Step 4: Run resolver tests and verify they pass**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/launch-cwd.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the resolver**

Run:

```bash
git add server/launch-cwd.ts test/unit/server/launch-cwd.test.ts
git commit -m "feat: add shared launch cwd resolver"
```

Expected: commit succeeds with only the resolver and resolver tests staged.

### Task 2: Use Shared Resolver In Terminal Spawn Specs

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`

- [ ] **Step 1: Add terminal spawn regression tests**

In `test/unit/server/terminal-registry.test.ts`, add this test inside `describe('buildSpawnSpec WSL paths', () => { ... })`, under `describe('coding CLI modes in WSL with Linux shell', () => { ... })` after the existing Windows-cwd-to-WSL Codex test:

```ts
    it('does not map Windows cwd to a same-named /home checkout for codex in WSL system shell', () => {
      mockWsl()
      delete process.env.CODEX_CMD

      const spec = buildSpawnSpec(
        'codex',
        String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`,
        'system',
      )

      expect(spec.file).toBe('codex')
      expect(spec.cwd).toBe('/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck')
      expect(spec.cwd).not.toBe('/home/dan/code/DirectorDeck')
      expect(spec.mcpCwd).toBe('/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck')
    })
```

In the same file, add this test inside `describe('cwd handling for Windows shells in WSL', () => { ... })` after `it('converts standard /mnt drive paths to Windows drive paths for cmd', ...)`:

```ts
    it('does not invent a Windows cwd for Linux-only /home paths in cmd', () => {
      mockWsl()
      process.env.USERPROFILE = 'C:\\Users\\testuser'

      const spec = buildSpawnSpec('shell', '/home/dan/code/freshell', 'cmd')

      expect(spec.cwd).toBeUndefined()
      expect(spec.args.some(arg => arg.includes('cd /d "C:\\Users\\testuser"'))).toBe(true)
      expect(spec.args.some(arg => arg.includes('freshell'))).toBe(false)
      expect(spec.mcpCwd).toBe('/home/dan/code/freshell')
    })
```

In the same file, add this test inside `describe('buildSpawnSpec MCP injection', () => { ... })` after the existing WSL cwd normalization test:

```ts
    it('keeps native Windows cmd OpenCode mcpCwd as a Windows path', async () => {
      mockPlatform('win32')
      const { generateMcpInjection } = await import('../../../server/mcp/config-writer.js')
      vi.mocked(generateMcpInjection).mockClear()

      const spec = buildSpawnSpec(
        'opencode',
        String.raw`C:\Users\Dan\repo`,
        'cmd',
        undefined,
        { opencodeServer: TEST_OPENCODE_SERVER },
        undefined,
        'term-native-win-cmd',
      )

      expect(spec.cwd).toBe(String.raw`C:\Users\Dan\repo`)
      expect(spec.mcpCwd).toBe(String.raw`C:\Users\Dan\repo`)
      expect(generateMcpInjection).toHaveBeenCalledWith(
        'opencode',
        'term-native-win-cmd',
        String.raw`C:\Users\Dan\repo`,
        'windows',
      )
    })
```

- [ ] **Step 2: Run terminal tests and verify they already pass or expose coupling**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/terminal-registry.test.ts -t "buildSpawnSpec WSL paths|buildSpawnSpec MCP injection"
```

Expected: PASS before the refactor. These tests lock behavior before moving conversion code into the shared resolver.

- [ ] **Step 3: Replace local terminal cwd conversion with shared resolver**

In `server/terminal-registry.ts`, add this import near the other server imports:

```ts
import { resolveLaunchCwd } from './launch-cwd.js'
```

Remove the local helper block that starts with:

```ts
function getWslMountPrefix(): string {
```

and ends with:

```ts
function resolveUnixShellCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const candidate = cwd.trim()
  if (!candidate) return undefined

  // In WSL, Linux processes need POSIX paths. Convert Windows-style cwd inputs
  // (e.g. D:\users\dan) to WSL mount paths before passing cwd to node-pty.
  // Skip conversion for paths already in Linux/POSIX format.
  if (isWsl() && !isLinuxPath(candidate)) {
    const converted = convertWindowsPathToWslPath(candidate)
    if (converted) {
      return converted
    }
  }

  return candidate
}
```

Replace that removed block with:

```ts
function resolveWindowsShellCwd(cwd: string | undefined): string | undefined {
  return resolveLaunchCwd(cwd, { targetRuntime: 'windows-process' }).launchCwd
}

function resolveUnixShellCwd(cwd: string | undefined): string | undefined {
  return resolveLaunchCwd(cwd, { targetRuntime: 'linux-process' }).launchCwd
}

function resolveMcpCwd(cwd: string | undefined): string | undefined {
  const targetRuntime = isWindows() ? 'windows-process' : 'linux-process'
  return resolveLaunchCwd(cwd, { targetRuntime }).launchCwd
}
```

Keep the existing `convertWindowsPathToWslPath` import from `server/path-utils.ts` because `buildSpawnSpec` still uses it in the native Windows `wsl.exe` branch.

In the cmd.exe branch, replace:

```ts
mcpCwd: resolveUnixShellCwd(cwd)
```

with:

```ts
mcpCwd: resolveMcpCwd(cwd)
```

for both shell-mode return objects, and replace:

```ts
const cmdMcpCwd = resolveUnixShellCwd(cwd)
```

with:

```ts
const cmdMcpCwd = resolveMcpCwd(cwd)
```

In the PowerShell branch, make the same replacements: use `resolveMcpCwd(cwd)` for shell-mode `mcpCwd` fields and for `const psMcpCwd = ...`.

- [ ] **Step 4: Check for leftover duplicate helper references**

Run:

```bash
rg -n "convertWslDrivePathToWindows|getWslMountPrefix\\(|isWindowsAbsolutePath\\(|WINDOWS_DRIVE_PREFIX_RE|WINDOWS_UNC_PREFIX_RE|WINDOWS_ROOTED_PREFIX_RE|escapeRegex\\(" server/terminal-registry.ts
```

Expected: no output. If output remains, remove only the unused local declarations that were replaced by `server/launch-cwd.ts`.

- [ ] **Step 5: Run terminal tests and verify they pass**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/terminal-registry.test.ts -t "buildSpawnSpec WSL paths|buildSpawnSpec MCP injection"
```

Expected: PASS.

- [ ] **Step 6: Commit the terminal refactor**

Run:

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.test.ts
git commit -m "refactor: share launch cwd resolution in terminal spawns"
```

Expected: commit succeeds with only terminal spawn-spec files staged.

### Task 3: Normalize Codex App-Server Sidecar Cwd

**Files:**
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`

- [ ] **Step 1: Add failing Codex runtime regression tests**

In `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`, add this helper after `createRuntime(...)`:

```ts
function mockWslEnvironment(mountPrefix: string): () => void {
  const originalPlatform = process.platform
  const originalWslDistro = process.env.WSL_DISTRO_NAME
  const originalWslInterop = process.env.WSL_INTEROP
  const originalWslenv = process.env.WSLENV
  const originalWslSys32 = process.env.WSL_WINDOWS_SYS32

  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
  })
  process.env.WSL_DISTRO_NAME = 'Ubuntu'
  delete process.env.WSL_INTEROP
  delete process.env.WSLENV
  process.env.WSL_WINDOWS_SYS32 = `${mountPrefix}/c/Windows/System32`

  return () => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    })
    if (originalWslDistro === undefined) {
      delete process.env.WSL_DISTRO_NAME
    } else {
      process.env.WSL_DISTRO_NAME = originalWslDistro
    }
    if (originalWslInterop === undefined) {
      delete process.env.WSL_INTEROP
    } else {
      process.env.WSL_INTEROP = originalWslInterop
    }
    if (originalWslenv === undefined) {
      delete process.env.WSLENV
    } else {
      process.env.WSLENV = originalWslenv
    }
    if (originalWslSys32 === undefined) {
      delete process.env.WSL_WINDOWS_SYS32
    } else {
      process.env.WSL_WINDOWS_SYS32 = originalWslSys32
    }
  }
}
```

In the same file, add these tests after `it('rejects with a launch error instead of crashing when the command is missing', ...)`:

```ts
  it('normalizes Windows drive cwd to the WSL mount before spawning the Codex app-server sidecar', async () => {
    const metadataDir = await makeTempDir()
    const mountRoot = await makeTempDir()
    const restoreEnv = mockWslEnvironment(mountRoot)
    const fakeSys32 = path.join(mountRoot, 'c', 'Windows', 'System32')
    const launchDir = path.join(
      mountRoot,
      'd',
      'Users',
      'Dan',
      'GoogleDrivePersonal',
      'code',
      'DirectorDeck',
    )
    await fsp.mkdir(fakeSys32, { recursive: true })
    await fsp.mkdir(launchDir, { recursive: true })
    const canonicalLaunchDir = await fsp.realpath(launchDir)

    try {
      const runtime = createRuntime({
        metadataDir,
        serverInstanceId: 'srv-wsl-cwd',
      })

      await runtime.ensureReady(String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`)

      const record = await waitForMetadataRecord(
        metadataDir,
        (candidate) => candidate.wrapperIdentity?.cwd === canonicalLaunchDir,
      )
      expect(record.wrapperIdentity.cwd).toBe(canonicalLaunchDir)
      expect(record.wrapperIdentity.cwd).not.toBe('/home/dan/code/DirectorDeck')
    } finally {
      restoreEnv()
    }
  })

  it('rejects missing converted sidecar cwd before spawning with a clear path-specific error', async () => {
    const metadataDir = await makeTempDir()
    const mountRoot = await makeTempDir()
    const restoreEnv = mockWslEnvironment(mountRoot)
    await fsp.mkdir(path.join(mountRoot, 'c', 'Windows', 'System32'), { recursive: true })

    try {
      const runtime = createRuntime({
        metadataDir,
        serverInstanceId: 'srv-wsl-cwd-missing',
      })

      await expect(
        runtime.ensureReady(String.raw`D:\Users\Dan\GoogleDrivePersonal\code\MissingProject`),
      ).rejects.toThrow(
        /Codex app-server launch cwd is not a reachable directory.*D:\\Users\\Dan\\GoogleDrivePersonal\\code\\MissingProject.*\/d\/Users\/Dan\/GoogleDrivePersonal\/code\/MissingProject/s,
      )

      const entries = await fsp.readdir(metadataDir).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      expect(entries).toEqual([])
    } finally {
      restoreEnv()
    }
  })
```

- [ ] **Step 2: Run Codex runtime tests and verify they fail**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts -t "Windows drive cwd|missing converted sidecar cwd"
```

Expected:
- The first test fails because the sidecar spawn still receives the raw `D:\...` cwd.
- The second test fails with the current `spawn ... ENOENT` launch error instead of the clear path-specific cwd error.

- [ ] **Step 3: Add Codex sidecar cwd resolution helpers**

In `server/coding-cli/codex-app-server/runtime.ts`, add this import:

```ts
import { resolveLaunchCwd, type LaunchCwdConversion } from '../../launch-cwd.js'
```

After `function normalizeLaunchCwd(cwd: string | undefined): string | undefined { ... }`, add:

```ts
type CodexAppServerLaunchCwd = {
  rawCwd?: string
  launchCwd?: string
  conversion: LaunchCwdConversion
}

function resolveCodexAppServerLaunchCwd(rawCwd: string | undefined): CodexAppServerLaunchCwd {
  const resolved = resolveLaunchCwd(rawCwd, { targetRuntime: 'linux-process' })
  if (rawCwd && !resolved.launchCwd) {
    throw new Error(`Codex app-server cannot use cwd "${rawCwd}" for Linux sidecar launch.`)
  }
  return {
    rawCwd,
    launchCwd: resolved.launchCwd,
    conversion: resolved.conversion,
  }
}

async function assertCodexAppServerLaunchCwdReachable(cwd: CodexAppServerLaunchCwd): Promise<void> {
  if (!cwd.launchCwd) return
  try {
    const stat = await fsp.stat(cwd.launchCwd)
    if (!stat.isDirectory()) {
      throw new Error('resolved path is not a directory')
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const conversion = cwd.conversion === 'none' ? 'without conversion' : `using ${cwd.conversion}`
    throw new Error(
      `Codex app-server launch cwd is not a reachable directory: input "${cwd.rawCwd ?? cwd.launchCwd}" resolved to "${cwd.launchCwd}" ${conversion}: ${detail}`,
    )
  }
}
```

- [ ] **Step 4: Resolve sidecar cwd before compatibility checks and spawn**

In `server/coding-cli/codex-app-server/runtime.ts`, replace the entire `ensureReady(cwd?: string): Promise<ReadyState>` method with this implementation:

```ts
  async ensureReady(cwd?: string): Promise<ReadyState> {
    if (this.shutdownRequested) {
      throw new Error('Codex app-server sidecar is shutting down.')
    }
    await this.assertNoBlockedOwnership('ensure Codex app-server sidecar readiness')

    const requestedCwd = normalizeLaunchCwd(cwd) ?? this.defaultCwd
    const launchCwd = resolveCodexAppServerLaunchCwd(requestedCwd)
    if (this.ready) {
      this.assertCompatibleLaunchCwd(launchCwd.launchCwd, this.readyCwd)
      return this.ready
    }
    if (this.ensureReadyPromise) {
      this.assertCompatibleLaunchCwd(launchCwd.launchCwd, this.ensureReadyCwd)
      return this.ensureReadyPromise
    }

    this.ensureReadyCwd = launchCwd.launchCwd
    this.ensureReadyPromise = this.startRuntime(launchCwd).finally(() => {
      this.ensureReadyPromise = null
      this.ensureReadyCwd = undefined
    })

    this.ready = await this.ensureReadyPromise
    this.readyCwd = launchCwd.launchCwd
    this.statusValue = 'running'
    return this.ready
  }
```

Change the `startRuntime` signature from:

```ts
  private async startRuntime(cwd?: string): Promise<ReadyState> {
```

to:

```ts
  private async startRuntime(cwd: CodexAppServerLaunchCwd): Promise<ReadyState> {
```

At the beginning of `startRuntime`, immediately after `await assertProcOwnershipProofAvailable()`, add:

```ts
    await assertCodexAppServerLaunchCwdReachable(cwd)
```

In the `spawn(...)` options, replace:

```ts
        ...(cwd ? { cwd } : {}),
```

with:

```ts
        ...(cwd.launchCwd ? { cwd: cwd.launchCwd } : {}),
```

- [ ] **Step 5: Run Codex runtime tests and verify they pass**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts -t "Windows drive cwd|missing converted sidecar cwd|command is missing"
```

Expected: PASS. The existing missing-command test must still pass, proving cwd validation did not mask binary-not-found errors.

- [ ] **Step 6: Commit Codex runtime cwd normalization**

Run:

```bash
git add server/coding-cli/codex-app-server/runtime.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
git commit -m "fix: normalize Codex sidecar cwd before launch"
```

Expected: commit succeeds with only Codex runtime files staged.

### Task 4: Focused Verification And Full Check

**Files:**
- No source files changed in this task.

- [ ] **Step 1: Run focused server tests for the changed behavior**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/launch-cwd.test.ts test/unit/server/terminal-registry.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck and the coordinated full suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="verify windows-wsl launch cwd normalization" npm run check
```

Expected: PASS.

- [ ] **Step 3: Inspect the final diff for accidental project aliasing**

Run:

```bash
git diff --stat origin/main...HEAD
rg -n "/home/dan/code/DirectorDeck|same-named|silent map|silent mapping" server test docs/superpowers/plans/2026-06-10-windows-wsl-launch-cwd.md
```

Expected:
- `git diff --stat` lists only the planned files.
- `rg` finds only test/plan text proving that silent mapping is rejected; it must not find implementation code mapping a Windows path to `/home/dan/code/DirectorDeck`.

- [ ] **Step 4: Commit verification notes if the plan file changed during execution**

Run:

```bash
git status --short
```

Expected: no unstaged changes. If only this plan file changed due checked-off boxes during execution, commit that plan update:

```bash
git add docs/superpowers/plans/2026-06-10-windows-wsl-launch-cwd.md
git commit -m "docs: track windows wsl launch cwd plan progress"
```

## Manual Smoke Test

- [ ] **Step 1: Start a worktree server on a unique port**

Run from `.worktrees/windows-wsl-launch-cwd`:

```bash
PORT=3347 npm run dev:server > /tmp/freshell-3347.log 2>&1 & echo $! > /tmp/freshell-3347.pid
```

Expected: command returns immediately and writes a PID to `/tmp/freshell-3347.pid`.

- [ ] **Step 2: Confirm the manual server belongs to this worktree**

Run:

```bash
ps -fp "$(cat /tmp/freshell-3347.pid)"
```

Expected: the command path or cwd belongs to `.worktrees/windows-wsl-launch-cwd`.

- [ ] **Step 3: Open the manual server in Windows Chrome**

Run from any Windows cwd:

```bash
cmd.exe /c start "" chrome --new-tab http://localhost:3347
```

Expected: Chrome opens the worktree Freshell server.

- [ ] **Step 4: Verify the user story**

In the manual Freshell UI:
- Create a Codex pane using `D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck` as the starting directory.
- Confirm the pane launches instead of showing `[Launch failed] ... spawn codex ENOENT`.
- Create another Codex pane using `/home/dan/code/DirectorDeck`.
- Confirm it launches as a distinct cwd and is not rewritten to the `D:\...` checkout.

Expected: both launches work when the corresponding directory exists, and neither path is silently mapped to the other checkout.

- [ ] **Step 5: Stop only the manual worktree server**

Run:

```bash
ps -fp "$(cat /tmp/freshell-3347.pid)"
kill "$(cat /tmp/freshell-3347.pid)"
rm -f /tmp/freshell-3347.pid
```

Expected: the verified `.worktrees/windows-wsl-launch-cwd` server stops. Do not restart or stop the self-hosted dev server.

## Self-Review Notes

Spec coverage:
- Windows path from WSL to Linux Codex app-server: covered by Task 3 runtime tests.
- WSL path from WSL to Windows cmd/PowerShell: covered by Task 1 resolver tests and existing Task 2 terminal tests.
- PowerShell/cmd/native Windows server distinction: covered by target-runtime resolver design and Task 1 native Windows test.
- No silent map between `D:\...\DirectorDeck` and `/home/dan/code/DirectorDeck`: covered by Task 1, Task 2, Task 3, and manual smoke test.
- Clear error instead of `spawn codex ENOENT` for invalid cwd: covered by Task 3 missing-cwd test.

Placeholder scan:
- The plan contains concrete file paths, exact test code, exact implementation code snippets, and exact commands.
- There are no placeholder tasks that ask the implementer to invent tests or unspecified error behavior.

Type consistency:
- `LaunchCwdTargetRuntime`, `LaunchCwdConversion`, `ResolvedLaunchCwd`, `resolveLaunchCwd`, and `convertWslDrivePathToWindowsPath` are defined in Task 1 and used consistently in Tasks 2 and 3.
- Codex runtime uses `CodexAppServerLaunchCwd` only after it is defined in Task 3.
