# Codex Spawn EAGAIN Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex app-server spawn failures, especially retryable `spawn codex EAGAIN`, leave enough structured evidence to diagnose resource pressure without restarting Freshell.

**Architecture:** Keep the change server-only and diagnostic-only. Codex runtime startup failures become self-diagnostic for every launch path, while the WebSocket `terminal.create` boundary adds registry-owned terminal and Codex sidecar counts to the structured failure log without changing the client protocol.

**Tech Stack:** Node.js 22, TypeScript/ESM, Vitest server config, pino structured logs, existing `TerminalRegistry` and `CodexAppServerRuntime`.

## Global Constraints

- Work in `.worktrees/codex-spawn-eagain-diagnostics` on branch `fix/codex-spawn-eagain-diagnostics`.
- Do not restart the self-hosted Freshell server.
- Keep changes server-only; no user-facing docs update is required for diagnostic-only behavior.
- Preserve NodeNext relative imports with `.js` extensions.
- Keep the WebSocket protocol unchanged: continue sending `code: 'PTY_SPAWN_FAILED'` for non-config terminal-create spawn failures.
- Keep the client error clear but compact; put full diagnostic details in structured server logs.
- Runtime diagnostics must be read-only and best-effort. A failed diagnostic probe must not mask the original Codex launch failure.
- Sidecar metadata diagnostics must be bounded and labeled as metadata-record counts, not live sidecar counts.
- Registry diagnostics must mean registry-owned terminals and registry-owned Codex sidecars, not planner-owned pre-adoption sidecars or metadata records.
- WebSocket tests that mock `server/logger` must preserve every logger export consumed during `ws-handler` module load, including `sessionLifecycleLogger`, because `session-observability.ts` captures that logger in a module-level sink.
- Baseline: after installing dev dependencies in the worktree, `FRESHELL_TEST_SUMMARY='baseline retry after local dev dependency install for codex spawn diagnostics worktree' npm test` passed.

---

## Load-Bearing Validation Results

- Process/resource diagnostics are available read-only on this WSL/Linux host through Node and `/proc`: fd count, process count, `/proc/self/limits`, `/proc/meminfo`, `/proc/loadavg`, `process.resourceUsage()`, and `process.memoryUsage()`.
- Sidecar metadata records are useful only as bounded metadata-record counts. The default directory currently exists and is small, but implementation must use a real cap and partial-result fields rather than reading every file unbounded.
- Custom error fields do not survive all wrapper paths automatically. The runtime must attach diagnostics to the final startup wrapper error, and helper extraction must walk `cause` so later wrappers still expose useful launch details.
- `TerminalRegistry` is the right boundary for registry-owned terminal and Codex terminal-sidecar counts because it owns `terminals` and `sidecarShutdowns`.
- Other Codex launch paths exist beyond WebSocket `terminal.create` (REST agent routes and fresh-agent Codex runtime). Runtime self-diagnostics are therefore required; WebSocket adds terminal counts only where it has the registry boundary.
- The client already displays the error `message` for request-scoped terminal-create failures. Structured retry fields in `shared/ws-protocol.ts` are unnecessary for this diagnostic-only scope.
- Importing launch-error helpers from `runtime.ts` into `ws-handler.ts` is safe as long as the new runtime helpers do not import `ws-handler.ts` or `terminal-registry.ts`.

## File Structure

- Modify `server/coding-cli/codex-app-server/runtime.ts`
  - Adds retryable spawn classification, read-only process/resource diagnostics, bounded sidecar metadata diagnostics, injectable spawn function for focused tests, cause-aware launch-error detail extraction, and a diagnostic final startup error.
- Modify `server/terminal-registry.ts`
  - Adds `TerminalRegistry.getDiagnosticCounts()` for registry-owned terminal totals, status counts, per-mode counts, Codex sidecar counts, recovery counts, and sidecar shutdown counts.
- Modify `server/ws-handler.ts`
  - Adds terminal-create failure diagnostic logging with request fields, registry counts, current process/resource diagnostics, and cause-aware launch error metadata.
- Modify `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
  - Adds a focused `EAGAIN` spawn failure regression test.
- Modify `test/server/ws-protocol.test.ts`
  - Adds a complete logger mock, fake registry diagnostic counts, and a focused WebSocket failure-log regression test proving terminal counts and retryable classification reach structured logs.

## Task 1: Runtime Retryable Spawn Diagnostics

**Files:**
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`

**Interfaces:**
- Produces: `isRetryableCodexAppServerLaunchError(error: unknown): boolean`
- Produces: `getCodexAppServerLaunchErrorDetails(error: unknown): CodexAppServerLaunchErrorDetails`
- Produces: `collectCodexAppServerProcessDiagnostics(): Promise<CodexAppServerProcessDiagnostics>`
- Produces: runtime final error properties `{ code?: string; retryable?: boolean; diagnostics?: CodexAppServerLaunchDiagnostics }`

- [ ] **Step 1: Write the failing test**

Add this import in `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`:

```ts
import { EventEmitter } from 'node:events'
```

Add this test near the existing missing-command startup test:

```ts
  it('classifies spawn EAGAIN as retryable and attaches bounded launch diagnostics', async () => {
    const metadataDir = await makeTempDir()
    const spawnError = Object.assign(new Error('spawn codex EAGAIN'), { code: 'EAGAIN' })
    const spawnProcess = vi.fn(() => {
      const fakeChild = new EventEmitter() as any
      fakeChild.stdout = { resume: vi.fn() }
      fakeChild.stderr = { resume: vi.fn() }
      fakeChild.exitCode = null
      fakeChild.signalCode = null
      queueMicrotask(() => fakeChild.emit('error', spawnError))
      return fakeChild
    })
    const runtime = new CodexAppServerRuntime({
      command: 'codex',
      metadataDir,
      spawnProcess: spawnProcess as any,
      startupAttemptLimit: 2,
      startupAttemptTimeoutMs: 100,
    })
    runtimes.add(runtime)

    let caught: unknown
    await runtime.ensureReady().catch((error) => {
      caught = error
    })

    expect(caught).toMatchObject({
      code: 'EAGAIN',
      retryable: true,
      diagnostics: expect.objectContaining({
        process: expect.objectContaining({
          pid: process.pid,
          memory: expect.objectContaining({
            rss: expect.any(Number),
            heapUsed: expect.any(Number),
          }),
          fdCount: expect.any(Number),
          processCount: expect.any(Number),
        }),
        sidecars: expect.objectContaining({
          metadataDir,
          metadataRecords: expect.objectContaining({
            total: 0,
            capReached: false,
          }),
        }),
      }),
    })
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/retryable resource exhaustion.*EAGAIN/i)
    expect(spawnProcess).toHaveBeenCalledTimes(2)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/runtime.test.ts --config config/vitest/vitest.server.config.ts -t "classifies spawn EAGAIN"
```

Expected: FAIL because `spawnProcess` is not a `RuntimeOptions` field and runtime errors do not yet expose retryable diagnostics.

- [ ] **Step 3: Implement runtime diagnostic types and helpers**

In `server/coding-cli/codex-app-server/runtime.ts`, add `Dirent` import support by changing the fs import to include `opendir` use through `fsp`; no new package is required.

Add these constants near the other runtime constants:

```ts
const LAUNCH_DIAGNOSTIC_METADATA_RECORD_CAP = 100
const LAUNCH_DIAGNOSTIC_METADATA_RECORD_MAX_BYTES = 16 * 1024
```

Add these types/helpers near the existing runtime types:

```ts
type SpawnProcess = typeof spawn

export type CodexAppServerProcessDiagnostics = {
  pid: number
  platform: NodeJS.Platform
  uptimeSeconds: number
  memory: NodeJS.MemoryUsage
  resourceUsage?: NodeJS.ResourceUsage
  fdCount?: number
  processCount?: number
  loadavg?: string
  meminfo?: {
    memTotalKb?: number
    memFreeKb?: number
    memAvailableKb?: number
    swapTotalKb?: number
    swapFreeKb?: number
  }
  limits?: {
    maxProcesses?: string
    maxOpenFiles?: string
  }
  probeErrors?: Record<string, string>
}

export type CodexAppServerLaunchDiagnostics = {
  process: CodexAppServerProcessDiagnostics
  runtime: {
    command: string
    startupAttemptLimit: number
    startupAttemptTimeoutMs: number
    status: RuntimeStatus
    hasActiveChild: boolean
    activeChildPid?: number
    activeOwnershipId?: string
  }
  sidecars: {
    metadataDir: string
    metadataRecords: {
      total: number
      currentServer: number
      otherServer: number
      malformed: number
      unreadable: number
      oversized: number
      cap: number
      capReached: boolean
    }
  }
}

export type CodexAppServerLaunchErrorDetails = {
  code?: string
  retryable?: boolean
  diagnostics?: CodexAppServerLaunchDiagnostics
}

class CodexAppServerStartupError extends Error {
  code?: string
  retryable?: boolean
  diagnostics?: CodexAppServerLaunchDiagnostics

  constructor(message: string, details: CodexAppServerLaunchErrorDetails & { cause?: unknown } = {}) {
    super(message, { cause: details.cause })
    this.name = 'CodexAppServerStartupError'
    this.code = details.code
    this.retryable = details.retryable
    this.diagnostics = details.diagnostics
  }
}

function errorCause(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isRetryableSpawnCode(code: string | undefined): boolean {
  return code === 'EAGAIN' || code === 'EMFILE' || code === 'ENFILE' || code === 'ENOMEM'
}

export function getCodexAppServerLaunchErrorDetails(error: unknown): CodexAppServerLaunchErrorDetails {
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const details = current as CodexAppServerLaunchErrorDetails
    const code = typeof details.code === 'string' ? details.code : undefined
    const retryable = typeof details.retryable === 'boolean' ? details.retryable : undefined
    const diagnostics = details.diagnostics
    if (code || retryable !== undefined || diagnostics) {
      return {
        ...(code ? { code } : {}),
        ...(retryable !== undefined ? { retryable } : {}),
        ...(diagnostics ? { diagnostics } : {}),
      }
    }
    current = errorCause(current)
  }
  return {}
}

export function isRetryableCodexAppServerLaunchError(error: unknown): boolean {
  const details = getCodexAppServerLaunchErrorDetails(error)
  if (details.retryable === true) return true
  return isRetryableSpawnCode(details.code)
}
```

Add read-only process diagnostics helpers. Keep every probe best-effort:

```ts
function parseMeminfo(raw: string): CodexAppServerProcessDiagnostics['meminfo'] {
  const values = new Map<string, number>()
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB/.exec(line)
    if (match) values.set(match[1], Number(match[2]))
  }
  return {
    memTotalKb: values.get('MemTotal'),
    memFreeKb: values.get('MemFree'),
    memAvailableKb: values.get('MemAvailable'),
    swapTotalKb: values.get('SwapTotal'),
    swapFreeKb: values.get('SwapFree'),
  }
}

function parseLimits(raw: string): CodexAppServerProcessDiagnostics['limits'] {
  const limits: CodexAppServerProcessDiagnostics['limits'] = {}
  for (const line of raw.split('\n')) {
    if (line.startsWith('Max processes')) limits.maxProcesses = line.trim()
    if (line.startsWith('Max open files')) limits.maxOpenFiles = line.trim()
  }
  return limits
}

async function readTextFile(pathname: string): Promise<string> {
  return fsp.readFile(pathname, 'utf8')
}

async function countDirectoryEntries(pathname: string, cap: number, onlyNumeric = false): Promise<{ count: number; capReached: boolean }> {
  let count = 0
  let capReached = false
  const dir = await fsp.opendir(pathname)
  try {
    for await (const entry of dir) {
      if (onlyNumeric && !/^\d+$/.test(entry.name)) continue
      count += 1
      if (count >= cap) {
        capReached = true
        break
      }
    }
  } finally {
    await dir.close().catch(() => undefined)
  }
  return { count, capReached }
}

export async function collectCodexAppServerProcessDiagnostics(): Promise<CodexAppServerProcessDiagnostics> {
  const probeErrors: Record<string, string> = {}
  const safe = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn()
    } catch (error) {
      probeErrors[name] = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }

  const fdCount = await safe('fdCount', async () => (await countDirectoryEntries('/proc/self/fd', 10_000)).count)
  const processCount = await safe('processCount', async () => (await countDirectoryEntries('/proc', 100_000, true)).count)
  const loadavg = await safe('loadavg', async () => (await readTextFile('/proc/loadavg')).trim())
  const meminfoRaw = await safe('meminfo', async () => readTextFile('/proc/meminfo'))
  const limitsRaw = await safe('limits', async () => readTextFile('/proc/self/limits'))

  return {
    pid: process.pid,
    platform: process.platform,
    uptimeSeconds: process.uptime(),
    memory: process.memoryUsage(),
    resourceUsage: process.resourceUsage?.(),
    ...(fdCount !== undefined ? { fdCount } : {}),
    ...(processCount !== undefined ? { processCount } : {}),
    ...(loadavg ? { loadavg } : {}),
    ...(meminfoRaw ? { meminfo: parseMeminfo(meminfoRaw) } : {}),
    ...(limitsRaw ? { limits: parseLimits(limitsRaw) } : {}),
    ...(Object.keys(probeErrors).length > 0 ? { probeErrors } : {}),
  }
}
```

Add a bounded sidecar metadata scan:

```ts
  private async collectSidecarMetadataDiagnostics(): Promise<CodexAppServerLaunchDiagnostics['sidecars']['metadataRecords']> {
    let total = 0
    let currentServer = 0
    let otherServer = 0
    let malformed = 0
    let unreadable = 0
    let oversized = 0
    let capReached = false

    const dir = await fsp.opendir(this.metadataDir).catch(() => null)
    if (!dir) {
      return {
        total,
        currentServer,
        otherServer,
        malformed,
        unreadable,
        oversized,
        cap: LAUNCH_DIAGNOSTIC_METADATA_RECORD_CAP,
        capReached,
      }
    }

    try {
      for await (const entry of dir) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        total += 1
        if (total > LAUNCH_DIAGNOSTIC_METADATA_RECORD_CAP) {
          total = LAUNCH_DIAGNOSTIC_METADATA_RECORD_CAP
          capReached = true
          break
        }

        const filePath = path.join(this.metadataDir, entry.name)
        try {
          const stat = await fsp.stat(filePath)
          if (stat.size > LAUNCH_DIAGNOSTIC_METADATA_RECORD_MAX_BYTES) {
            oversized += 1
            continue
          }
          const raw = await fsp.readFile(filePath, 'utf8')
          const parsed = JSON.parse(raw) as Partial<CodexSidecarOwnershipMetadata>
          if (parsed.schemaVersion !== OWNERSHIP_SCHEMA_VERSION || typeof parsed.serverInstanceId !== 'string') {
            malformed += 1
          } else if (parsed.serverInstanceId === this.serverInstanceId) {
            currentServer += 1
          } else {
            otherServer += 1
          }
        } catch {
          unreadable += 1
        }
      }
    } finally {
      await dir.close().catch(() => undefined)
    }

    return {
      total,
      currentServer,
      otherServer,
      malformed,
      unreadable,
      oversized,
      cap: LAUNCH_DIAGNOSTIC_METADATA_RECORD_CAP,
      capReached,
    }
  }
```

Add `collectLaunchDiagnostics()` using the process and sidecar helpers:

```ts
  private async collectLaunchDiagnostics(): Promise<CodexAppServerLaunchDiagnostics> {
    return {
      process: await collectCodexAppServerProcessDiagnostics(),
      runtime: {
        command: this.command,
        startupAttemptLimit: this.startupAttemptLimit,
        startupAttemptTimeoutMs: this.startupAttemptTimeoutMs,
        status: this.statusValue,
        hasActiveChild: !!this.child,
        ...(this.child?.pid ? { activeChildPid: this.child.pid } : {}),
        ...(this.ownership?.metadata.ownershipId ? { activeOwnershipId: this.ownership.metadata.ownershipId } : {}),
      },
      sidecars: {
        metadataDir: this.metadataDir,
        metadataRecords: await this.collectSidecarMetadataDiagnostics(),
      },
    }
  }
```

- [ ] **Step 4: Wire spawn injection and retryable error metadata**

Extend `RuntimeOptions` and the class:

```ts
  spawnProcess?: SpawnProcess
```

```ts
  private readonly spawnProcess: SpawnProcess
```

```ts
    this.spawnProcess = options.spawnProcess ?? spawn
```

Use `this.spawnProcess(...)` instead of `spawn(...)`.

In `watchChildError`, copy retryable metadata onto the launch error:

```ts
        const code = (base as NodeJS.ErrnoException).code
        ;(launchError as Error & { code?: string; cause?: unknown; retryable?: boolean }).code = code
        ;(launchError as Error & { code?: string; cause?: unknown; retryable?: boolean }).cause = base
        ;(launchError as Error & { code?: string; cause?: unknown; retryable?: boolean }).retryable =
          isRetryableSpawnCode(code)
```

In `startRuntime`, keep the last launch details before cleanup can wrap an error:

```ts
    let lastError: Error | undefined
    let lastLaunchDetails: CodexAppServerLaunchErrorDetails = {}
```

Inside the `catch` block, immediately after setting `lastError`:

```ts
        const currentDetails = getCodexAppServerLaunchErrorDetails(lastError)
        if (currentDetails.code || currentDetails.retryable !== undefined || currentDetails.diagnostics) {
          lastLaunchDetails = currentDetails
        }
```

At the final throw in `startRuntime`, collect diagnostics and throw `CodexAppServerStartupError`:

```ts
    const diagnostics = await this.collectLaunchDiagnostics()
    const code = lastLaunchDetails.code ?? getErrorCode(lastError)
    const retryable = lastLaunchDetails.retryable ?? isRetryableCodexAppServerLaunchError(lastError)
    const retryablePrefix = retryable && code
      ? ` Last failure was retryable resource exhaustion (${code}).`
      : ''
    logger.warn({
      err: lastError,
      code,
      retryable,
      diagnostics,
    }, 'Codex app-server startup failed after all attempts')
    throw new CodexAppServerStartupError(
      `Failed to start Codex app-server on a loopback endpoint after ${this.startupAttemptLimit} attempts:${retryablePrefix} ${lastError?.message ?? 'unknown error'}`,
      { code, retryable, diagnostics, cause: lastError },
    )
```

- [ ] **Step 5: Run the focused runtime test**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/runtime.test.ts --config config/vitest/vitest.server.config.ts -t "classifies spawn EAGAIN"
```

Expected: PASS.

## Task 2: Terminal-Create Failure Log Diagnostics

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Test: `test/server/ws-protocol.test.ts`

**Interfaces:**
- Produces: `TerminalRegistry.getDiagnosticCounts()`
- Consumes: `getCodexAppServerLaunchErrorDetails(error)` and `collectCodexAppServerProcessDiagnostics()` in `ws-handler.ts`

- [ ] **Step 1: Write the failing WebSocket log test**

In `test/server/ws-protocol.test.ts`, add a hoisted logger mock before importing `ws-handler` dynamically:

```ts
const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return logger
})

vi.mock('../../server/logger', () => ({
  logger: mockLogger,
  sessionLifecycleLogger: mockLogger,
  withLogContext: vi.fn((_ctx: any, fn: () => unknown) => fn()),
}))
```

The `sessionLifecycleLogger` export is required. `server/session-observability.ts` captures it in a module-level sink while `ws-handler.ts` imports session observability, and `terminal.create` records `terminal_create_requested` before the create try/catch.

Reset the logger calls in `beforeEach()`:

```ts
    mockLogger.debug.mockClear()
    mockLogger.info.mockClear()
    mockLogger.warn.mockClear()
    mockLogger.error.mockClear()
    mockLogger.child.mockClear()
    mockLogger.child.mockReturnValue(mockLogger)
```

Add this method to `FakeRegistry`:

```ts
  getDiagnosticCounts() {
    let running = 0
    const byMode: Record<string, { total: number; running: number; exited: number }> = {}
    let codexTotal = 0
    let codexRunning = 0
    let runningWithSidecar = 0
    for (const rec of this.records.values()) {
      const modeCounts = byMode[rec.mode] ?? { total: 0, running: 0, exited: 0 }
      modeCounts.total += 1
      if (rec.status === 'running') {
        running += 1
        modeCounts.running += 1
      } else {
        modeCounts.exited += 1
      }
      byMode[rec.mode] = modeCounts
      if (rec.mode === 'codex') {
        codexTotal += 1
        if (rec.status === 'running') codexRunning += 1
        if (rec.status === 'running' && rec.codexSidecar) runningWithSidecar += 1
      }
    }
    return {
      terminals: {
        total: this.records.size,
        running,
        exited: this.records.size - running,
        byMode,
      },
      codex: {
        total: codexTotal,
        running: codexRunning,
        runningWithSidecar,
        runningWithPublishedSidecar: 0,
        recoveryAttempts: 0,
        recoveryBlocked: 0,
        sidecarShutdownsPending: 0,
        sidecarShutdownsFailed: 0,
      },
    }
  }
```

Add this test near existing terminal-create failure tests:

```ts
  it('logs terminal and resource diagnostics when Codex terminal.create fails from retryable spawn pressure', async () => {
    const retryableError = Object.assign(new Error('Failed to start Codex app-server on a loopback endpoint after 2 attempts: Last failure was retryable resource exhaustion (EAGAIN). Failed to launch Codex app-server sidecar: spawn codex EAGAIN'), {
      code: 'EAGAIN',
      retryable: true,
      diagnostics: {
        process: {
          pid: process.pid,
          platform: process.platform,
          uptimeSeconds: 123,
          memory: { rss: 111, heapTotal: 222, heapUsed: 333, external: 444, arrayBuffers: 555 },
          fdCount: 9,
          processCount: 99,
        },
        runtime: {
          command: 'codex',
          startupAttemptLimit: 2,
          startupAttemptTimeoutMs: 3000,
          status: 'stopped',
          hasActiveChild: false,
        },
        sidecars: {
          metadataDir: '/tmp/freshell-codex-sidecars-test',
          metadataRecords: {
            total: 7,
            currentServer: 3,
            otherServer: 4,
            malformed: 0,
            unreadable: 0,
            oversized: 0,
            cap: 100,
            capReached: false,
          },
        },
      },
    })
    const originalPlanCreate = codexLaunchPlanner.planCreate.bind(codexLaunchPlanner)
    codexLaunchPlanner.planCreate = vi.fn(async (input: any) => {
      codexLaunchPlanner.planCreateCalls.push(input)
      throw retryableError
    }) as any

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready', 5000)

    try {
      const requestId = 'codex-eagain-diagnostics'
      ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'codex' }))
      const error = await waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.requestId === requestId,
        5000,
      )

      expect(error).toMatchObject({
        type: 'error',
        code: 'PTY_SPAWN_FAILED',
        requestId,
      })
      expect(String(error.message)).toContain('retryable resource exhaustion (EAGAIN)')

      const failureLog = mockLogger.warn.mock.calls.find((call) => call[1] === 'terminal.create failed')
      const diagnosticProcess = failureLog?.[0]?.diagnostics?.process as any
      expect(failureLog?.[0]).toEqual(expect.objectContaining({
        err: retryableError,
        connectionId: expect.any(String),
        requestId,
        mode: 'codex',
        diagnostics: expect.objectContaining({
          launch: expect.objectContaining({
            code: 'EAGAIN',
            retryable: true,
            diagnostics: retryableError.diagnostics,
          }),
          registry: expect.objectContaining({
            terminals: expect.objectContaining({
              total: expect.any(Number),
              running: expect.any(Number),
              byMode: expect.any(Object),
            }),
            codex: expect.objectContaining({
              runningWithSidecar: expect.any(Number),
              sidecarShutdownsPending: expect.any(Number),
            }),
          }),
          process: expect.objectContaining({
            memory: expect.objectContaining({
              rss: expect.any(Number),
              heapUsed: expect.any(Number),
            }),
          }),
        }),
      }))
      if (process.platform === 'linux') {
        expect(diagnosticProcess.fdCount).toEqual(expect.any(Number))
      }
    } finally {
      codexLaunchPlanner.planCreate = originalPlanCreate as any
      await closeWebSocket(ws)
    }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:vitest -- run test/server/ws-protocol.test.ts --config config/vitest/vitest.server.config.ts -t "logs terminal and resource diagnostics"
```

Expected: FAIL because registry counts, process diagnostics, and launch details are not yet added to the warning log.

- [ ] **Step 3: Implement registry count snapshot**

In `server/terminal-registry.ts`, add an exported type near `TerminalRecord`:

```ts
export type TerminalRegistryDiagnosticCounts = {
  terminals: {
    total: number
    running: number
    exited: number
    byMode: Record<string, { total: number; running: number; exited: number }>
  }
  codex: {
    total: number
    running: number
    runningWithSidecar: number
    runningWithPublishedSidecar: number
    recoveryAttempts: number
    recoveryBlocked: number
    sidecarShutdownsPending: number
    sidecarShutdownsFailed: number
  }
}
```

Add this public method before `list()`:

```ts
  getDiagnosticCounts(): TerminalRegistryDiagnosticCounts {
    const byMode: TerminalRegistryDiagnosticCounts['terminals']['byMode'] = {}
    let running = 0
    let exited = 0
    let codexTotal = 0
    let codexRunning = 0
    let runningWithSidecar = 0
    let runningWithPublishedSidecar = 0
    let recoveryAttempts = 0
    let recoveryBlocked = 0

    for (const term of this.terminals.values()) {
      const modeCounts = byMode[term.mode] ?? { total: 0, running: 0, exited: 0 }
      modeCounts.total += 1
      if (term.status === 'running') {
        running += 1
        modeCounts.running += 1
      } else {
        exited += 1
        modeCounts.exited += 1
      }
      byMode[term.mode] = modeCounts

      if (term.mode === 'codex') {
        codexTotal += 1
        if (term.status === 'running') codexRunning += 1
        if (term.status === 'running' && term.codexSidecar) runningWithSidecar += 1
        if (term.status === 'running' && term.codexSidecar && term.codexSidecarLifecyclePublished) {
          runningWithPublishedSidecar += 1
        }
        if (term.codexRecoveryAttempt) recoveryAttempts += 1
        if (term.codexRecoveryBlockedError) recoveryBlocked += 1
      }
    }

    let sidecarShutdownsPending = 0
    let sidecarShutdownsFailed = 0
    for (const entry of this.sidecarShutdowns.values()) {
      if (entry.status === 'pending') sidecarShutdownsPending += 1
      if (entry.status === 'failed') sidecarShutdownsFailed += 1
    }

    return {
      terminals: {
        total: this.terminals.size,
        running,
        exited,
        byMode,
      },
      codex: {
        total: codexTotal,
        running: codexRunning,
        runningWithSidecar,
        runningWithPublishedSidecar,
        recoveryAttempts,
        recoveryBlocked,
        sidecarShutdownsPending,
        sidecarShutdownsFailed,
      },
    }
  }
```

- [ ] **Step 4: Implement WebSocket failure diagnostics**

In `server/ws-handler.ts`, import:

```ts
import {
  collectCodexAppServerProcessDiagnostics,
  getCodexAppServerLaunchErrorDetails,
} from './coding-cli/codex-app-server/runtime.js'
```

Add a local helper near `errorMessage` or other helpers:

```ts
async function buildTerminalCreateFailureDiagnostics(
  registry: TerminalRegistry,
  error: unknown,
): Promise<Record<string, unknown>> {
  return {
    process: await collectCodexAppServerProcessDiagnostics(),
    registry: typeof registry.getDiagnosticCounts === 'function'
      ? registry.getDiagnosticCounts()
      : undefined,
    launch: getCodexAppServerLaunchErrorDetails(error),
  }
}
```

In the terminal.create catch block, compute diagnostics before the warning:

```ts
          const diagnostics = await buildTerminalCreateFailureDiagnostics(this.registry, err)
          log.warn({
            err,
            connectionId: ws.connectionId,
            requestId: m.requestId,
            mode: m.mode,
            cwd: m.cwd,
            terminalId: cleanupTerminalId,
            diagnostics,
          }, 'terminal.create failed')
```

- [ ] **Step 5: Run focused WebSocket test**

Run:

```bash
npm run test:vitest -- run test/server/ws-protocol.test.ts --config config/vitest/vitest.server.config.ts -t "logs terminal and resource diagnostics"
```

Expected: PASS.

- [ ] **Step 6: Run focused affected suites**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/server/ws-protocol.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 7: Run final verification**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add server/coding-cli/codex-app-server/runtime.ts server/terminal-registry.ts server/ws-handler.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/server/ws-protocol.test.ts docs/superpowers/plans/2026-07-01-codex-spawn-eagain-diagnostics.md
git commit -m "fix: add Codex spawn failure diagnostics"
```

## Self-Review

- Spec coverage: The plan implements recommendation #4 by adding retryable spawn classification, process/resource diagnostics, registry-owned terminal counts, registry-owned Codex sidecar counts, bounded sidecar metadata-record counts, and structured failure logs. It does not implement replay retention, settings refresh, or proxy-log rate limiting because those were separate recommendations.
- Placeholder scan: No placeholder steps remain; code snippets include exact file paths, commands, and expected results.
- Type consistency: `TerminalRegistryDiagnosticCounts`, `CodexAppServerLaunchDiagnostics`, `CodexAppServerProcessDiagnostics`, and the WebSocket diagnostic helper names are consistent across tasks.
