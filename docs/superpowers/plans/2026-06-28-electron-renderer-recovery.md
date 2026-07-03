# Electron Renderer Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a lost Electron renderer from leaving Freshell on a blank white page, and leave enough durable evidence to diagnose the next renderer loss.

**Architecture:** Keep recovery ownership in the Electron main process because it survives renderer crashes and can observe `webContents` lifecycle events. Add a small durable JSONL logger, a focused renderer supervisor helper, and wire both through the existing `startup.ts` dependency-injected path so unit tests can drive lifecycle events without launching Electron. Crash dump capture is explicitly out of scope for this branch because local dumps may contain sensitive memory; the recovery fix must stand on structured logs and reproducible smoke coverage.

**Tech Stack:** Electron 33, TypeScript NodeNext/ESM, Vitest electron config, Playwright Electron e2e.

## Global Constraints

- Work in `.worktrees/renderer-recovery` on branch `fix/electron-renderer-recovery`.
- Do not restart the self-hosted Freshell server unless the user says `APPROVED`.
- Keep Electron imports out of unit-testable DI modules unless the module is Electron-entry-only.
- Server-side and Electron-side TypeScript uses NodeNext/ESM; relative imports include `.js` extensions.
- Durable main-process logs are JSONL with `timestamp`, `severity`, `component`, and `event`.
- Never log auth tokens. URLs written to logs must redact `token` query parameters, and fields with token-bearing names must be replaced with `[REDACTED]`.
- Recovery must reload/recover only the Electron window renderer. It must not stop or restart the Freshell server.
- Renderer recovery must be bounded with backoff/circuit-breaker behavior so a crash loop does not spin forever.
- Tests must prove user-observable recovery, not only implementation details.

---

## File Structure

- Create `electron/main-process-logger.ts`: JSONL logger for Electron main process events and token redaction.
- Create `test/unit/electron/main-process-logger.test.ts`: logger file creation, JSONL shape, token-bearing key redaction, URL token redaction, fallback stderr logging.
- Create `electron/renderer-recovery.ts`: attaches `webContents` event handlers, logs renderer loss/load failures/hangs, schedules bounded recovery.
- Create `test/unit/electron/renderer-recovery.test.ts`: unit coverage for `render-process-gone`, `did-fail-load`, `unresponsive`/`responsive`, backoff, circuit breaker.
- Modify `electron/startup.ts`: extend `BrowserWindowLike` with the minimal `webContents` shape, accept an optional main-process logger, and call the renderer supervisor when the main window is created.
- Modify `test/unit/electron/startup.test.ts`: ensure startup wires the supervisor, reloads the same authenticated URL after renderer loss, and does not invoke server start/stop during recovery.
- Modify `electron/entry.ts`: create the main-process logger and pass it into `runStartup`.
- Modify `test/e2e-electron/electron-app.test.ts`: add an Electron smoke test in its own describe block with an isolated disposable server that force-crashes the main renderer and verifies Freshell UI returns, privileged IPC still works, and the durable log records recovery.

### Task 1: Durable Electron Main Logging

**Files:**
- Create: `electron/main-process-logger.ts`
- Create: `test/unit/electron/main-process-logger.test.ts`

**Interfaces:**
- Produces: `type ElectronMainLogSeverity = 'debug' | 'info' | 'warn' | 'error'`
- Produces: `interface ElectronMainLogEntry { severity: ElectronMainLogSeverity; event: string; [key: string]: unknown }`
- Produces: `interface ElectronMainLogger { log(entry: ElectronMainLogEntry): void }`
- Produces: `createElectronMainLogger(options: { configDir: string; now?: () => Date; pid?: number }): ElectronMainLogger`
- Produces: `redactUrlForLog(value: string): string`

- [ ] **Step 1: Write failing logger tests**

Add tests with these cases:

```ts
it('writes structured JSONL events under configDir/logs', () => {
  const logger = createElectronMainLogger({
    configDir,
    now: () => new Date('2026-06-28T20:58:50.000Z'),
    pid: 1234,
  })

  logger.log({
    severity: 'warn',
    event: 'main_window_renderer_gone',
    url: 'http://localhost:3001/?token=secret-token&tab=one',
    reason: 'crashed',
  })

  const files = fs.readdirSync(path.join(configDir, 'logs'))
  expect(files).toEqual(['electron-main.1234.jsonl'])
  const [line] = fs.readFileSync(path.join(configDir, 'logs', files[0]), 'utf8').trim().split('\n')
  expect(JSON.parse(line)).toEqual({
    timestamp: '2026-06-28T20:58:50.000Z',
    severity: 'warn',
    component: 'electron-main',
    event: 'main_window_renderer_gone',
    url: 'http://localhost:3001/?token=[REDACTED]&tab=one',
    reason: 'crashed',
  })
})

it('falls back to stderr when the log file cannot be written', () => {
  const error = new Error('EACCES')
  const appendFileSync = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw error })
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

  const logger = createElectronMainLogger({ configDir, pid: 1234 })
  logger.log({ severity: 'error', event: 'main_window_recovery_failed', error })

  expect(appendFileSync).toHaveBeenCalled()
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"event":"main_window_recovery_failed"'))
})

it('redacts token-bearing keys, URL token parameters, and token-like string fragments', () => {
  const logger = createElectronMainLogger({
    configDir,
    now: () => new Date('2026-06-28T20:58:50.000Z'),
    pid: 1234,
  })

  logger.log({
    severity: 'warn',
    event: 'token_redaction_probe',
    remoteToken: 'plain-secret',
    nested: {
      authToken: 'nested-secret',
      url: 'http://localhost:3001/?token=query-secret',
    },
    error: new Error('failed for token=message-secret'),
  })

  const line = fs.readFileSync(path.join(configDir, 'logs', 'electron-main.1234.jsonl'), 'utf8').trim()
  expect(line).not.toContain('plain-secret')
  expect(line).not.toContain('nested-secret')
  expect(line).not.toContain('query-secret')
  expect(line).not.toContain('message-secret')
  expect(JSON.parse(line)).toMatchObject({
    remoteToken: '[REDACTED]',
    nested: {
      authToken: '[REDACTED]',
      url: 'http://localhost:3001/?token=[REDACTED]',
    },
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/main-process-logger.test.ts --run`

Expected: FAIL because `electron/main-process-logger.ts` does not exist.

- [ ] **Step 3: Implement the logger**

Implement `electron/main-process-logger.ts` with `fs.mkdirSync(logDir, { recursive: true })`, `fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8')`, token redaction through the standard `URL` API, token-bearing key redaction, token-like string fragment redaction, and safe error serialization:

```ts
function normalizeString(value: string): string {
  const redactedUrl = looksLikeUrl(value) ? redactUrlForLog(value) : value
  return redactedUrl.replace(/([?&]?(?:token|authorization|password|secret)=)[^\s&]+/gi, '$1[REDACTED]')
}

function isTokenBearingKey(key: string): boolean {
  return /token|authorization|password|secret/i.test(key)
}

function normalizeValue(value: unknown, key?: string): unknown {
  if (key && isTokenBearingKey(key)) return '[REDACTED]'
  if (typeof value === 'string') return normalizeString(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: normalizeString(value.message),
      stack: value.stack ? normalizeString(value.stack) : undefined,
    }
  }
  if (Array.isArray(value)) return value.map((nested) => normalizeValue(nested))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nested]) => [nestedKey, normalizeValue(nested, nestedKey)]))
  }
  return value
}
```

Token-bearing keys are any case-insensitive key that contains `token`, `authorization`, `password`, or `secret`. When a non-URL string contains a token-like fragment such as `token=...`, redact that fragment before writing it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/main-process-logger.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add electron/main-process-logger.ts test/unit/electron/main-process-logger.test.ts
git commit -m "feat(electron): add durable main process logging"
```

### Task 2: Renderer Lifecycle Supervisor

**Files:**
- Create: `electron/renderer-recovery.ts`
- Create: `test/unit/electron/renderer-recovery.test.ts`

**Interfaces:**
- Consumes: `ElectronMainLogger` from `electron/main-process-logger.ts`
- Produces: `interface RecoverableBrowserWindow { loadURL(url: string): Promise<void>; show(): void; focus(): void; isDestroyed?: () => boolean; webContents?: RecoverableWebContents }`
- Produces: `interface RecoverableWebContents { on(event: string, callback: (...args: any[]) => void): void; getURL?: () => string; isDestroyed?: () => boolean; reload?: () => void; forcefullyCrashRenderer?: () => void }`
- Produces: `registerRendererRecovery(options: RendererRecoveryOptions): void`

- [ ] **Step 1: Write failing supervisor tests**

Add tests with an event-emitting fake window. Cover:

```ts
it('reloads the crashed renderer when the renderer process is gone', async () => {
  const window = createRecoverableWindow()
  const verifyRecovered = vi.fn().mockResolvedValue(undefined)
  registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout, verifyRecovered })

  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
  await timers.runOnlyPendingTimersAsync()

  expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  expect(window.loadURL).not.toHaveBeenCalled()
  expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
    severity: 'warn',
    event: 'main_window_renderer_gone',
    reason: 'crashed',
    exitCode: 133,
  }))
  expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
    severity: 'info',
    event: 'main_window_recovery_succeeded',
  }))
})

it('recovers clean renderer exits while the main window is expected to stay alive', () => {
  window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
  expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
    event: 'main_window_renderer_gone',
    reason: 'clean-exit',
    willRecover: true,
  }))
})

it('logs did-fail-load and retries only main-frame non-abort failures', async () => {
  window.webContents.emit('did-fail-load', {}, -102, 'CONNECTION_REFUSED', loadUrl, true)
  await timers.runOnlyPendingTimersAsync()
  expect(window.loadURL).toHaveBeenCalledWith(loadUrl)

  window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', loadUrl, true)
  expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
    event: 'main_window_navigation_failed',
    errorCode: -3,
    willRecover: false,
  }))
})

it('recovers after a sustained unresponsive renderer and cancels when responsive returns', async () => {
  window.webContents.emit('unresponsive')
  window.webContents.emit('responsive')
  await timers.advanceTimersByTimeAsync(15_000)
  expect(window.loadURL).not.toHaveBeenCalled()

  window.webContents.emit('unresponsive')
  await timers.advanceTimersByTimeAsync(15_000)
  expect(window.webContents.forcefullyCrashRenderer).toHaveBeenCalled()
  expect(window.webContents.reload).toHaveBeenCalledTimes(1)
})

it('stops retrying after the crash-loop circuit breaker opens', async () => {
  for (let i = 0; i < 4; i += 1) {
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await timers.runOnlyPendingTimersAsync()
  }
  expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
    severity: 'error',
    event: 'main_window_recovery_circuit_open',
  }))
})

it('coalesces duplicate failure events while one recovery attempt is in flight', async () => {
  const verifyRecovered = vi.fn().mockReturnValue(new Promise(() => {}))
  registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout, verifyRecovered })

  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
  window.webContents.emit('did-fail-load', {}, -102, 'CONNECTION_REFUSED', loadUrl, true)
  await timers.runOnlyPendingTimersAsync()

  expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  expect(window.loadURL).not.toHaveBeenCalled()
  expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
    event: 'main_window_recovery_skipped',
    reason: 'recovery-in-flight',
  }))
})

it('does not log success until the recovery verifier resolves', async () => {
  let resolveVerifier!: () => void
  const verifyRecovered = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolveVerifier = resolve }))
  registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout, verifyRecovered })

  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
  await timers.runOnlyPendingTimersAsync()

  expect(logger.log).not.toHaveBeenCalledWith(expect.objectContaining({
    event: 'main_window_recovery_succeeded',
  }))

  resolveVerifier()
  await Promise.resolve()
  expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
    event: 'main_window_recovery_succeeded',
  }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/renderer-recovery.test.ts --run`

Expected: FAIL because `electron/renderer-recovery.ts` does not exist.

- [ ] **Step 3: Implement the supervisor**

Implement `registerRendererRecovery()` so it:
- Attaches handlers to `webContents` for `render-process-gone`, `did-fail-load`, `unresponsive`, and `responsive`.
- Logs `main_window_renderer_gone`, `main_window_navigation_failed`, `main_window_unresponsive`, `main_window_responsive`, `main_window_recovery_started`, `main_window_recovery_succeeded`, `main_window_recovery_failed`, `main_window_recovery_skipped`, `main_window_recovery_reload_unavailable`, and `main_window_recovery_circuit_open`. Task 3 owns the initial startup `loadURL().catch(...)` path and its `main_window_initial_load_failed` event.
- Runs the first recovery attempt immediately. If recovery fails and another event requests recovery, retry attempts use delays `[250, 1000, 3000]` ms and a window of 60 seconds with at most 3 recovery attempts.
- Calls `window.webContents.reload()` for `render-process-gone` and sustained `unresponsive` recovery because Electron documents reload as the post-crash fresh-renderer path. If `webContents.reload` is unavailable or `webContents` is destroyed, fall back to `window.loadURL(loadUrl)` and log `main_window_recovery_reload_unavailable`.
- Calls `window.loadURL(loadUrl)` for recoverable main-frame `did-fail-load` events because there may not be a successfully loaded current page to reload.
- Calls `window.show()` and `window.focus()` on success.
- Calls an optional `verifyRecovered(): Promise<void>` after the recovery action and before logging `main_window_recovery_succeeded`; the default verifier resolves immediately.
- Uses `forcefullyCrashRenderer()` before reload only for sustained `unresponsive` recovery.
- Recovers `clean-exit` while the main window is expected to remain alive. Intentional app/window shutdown is handled by the existing close/quit lifecycle, not by suppressing renderer recovery.
- Coalesces duplicate lifecycle events while a recovery attempt is in flight.
- Does not call any server lifecycle APIs.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/renderer-recovery.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add electron/renderer-recovery.ts test/unit/electron/renderer-recovery.test.ts
git commit -m "feat(electron): recover lost main renderer"
```

### Task 3: Wire Recovery Through Startup

**Files:**
- Modify: `electron/startup.ts`
- Modify: `test/unit/electron/startup.test.ts`

**Interfaces:**
- Consumes: `registerRendererRecovery()` from `electron/renderer-recovery.ts`
- Consumes: `ElectronMainLogger` from `electron/main-process-logger.ts`
- Produces: `StartupContext.mainProcessLogger?: ElectronMainLogger`
- Produces: `BrowserWindowLike.webContents?: RecoverableWebContents`

- [ ] **Step 1: Write failing startup integration tests**

Update `createMockWindow()` so it can expose evented `webContents`. Add tests:

```ts
it('registers renderer recovery for the main window and reloads the crashed renderer', async () => {
  const mockWindow = createMockWindowWithWebContents()
  const logger = { log: vi.fn() }
  const ctx = createDefaultContext({
    createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
    mainProcessLogger: logger,
    rendererRecoveryVerifier: vi.fn().mockResolvedValue(undefined),
    readEnvToken: vi.fn().mockResolvedValue('env token+with&chars'),
  })

  const result = await runStartup(ctx)
  expect(result.type).toBe('main')

  mockWindow.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
  await vi.runOnlyPendingTimersAsync()

  expect(mockWindow.webContents.reload).toHaveBeenCalledTimes(1)
  expect(ctx.serverSpawner.start).toHaveBeenCalledTimes(1)
  expect(ctx.serverSpawner.stop).not.toHaveBeenCalled()
})

it('reuses the same authenticated URL for recoverable main-frame load failures', async () => {
  const mockWindow = createMockWindowWithWebContents()
  const logger = { log: vi.fn() }
  const ctx = createDefaultContext({
    createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
    mainProcessLogger: logger,
    rendererRecoveryVerifier: vi.fn().mockResolvedValue(undefined),
    readEnvToken: vi.fn().mockResolvedValue('env token+with&chars'),
  })

  const result = await runStartup(ctx)
  expect(result.type).toBe('main')

  mockWindow.webContents.emit('did-fail-load', {}, -102, 'CONNECTION_REFUSED', 'http://localhost:3001/', true)
  await vi.runOnlyPendingTimersAsync()

  expect(mockWindow.loadURL).toHaveBeenLastCalledWith('http://localhost:3001?token=env%20token%2Bwith%26chars')
  expect(ctx.serverSpawner.start).toHaveBeenCalledTimes(1)
  expect(ctx.serverSpawner.stop).not.toHaveBeenCalled()
})

it('logs an explicit warning when recovery cannot attach because webContents is unavailable', async () => {
  const logger = { log: vi.fn() }
  await runStartup(createDefaultContext({ mainProcessLogger: logger }))
  expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
    severity: 'warn',
    event: 'main_window_recovery_unavailable',
  }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/startup.test.ts --run`

Expected: FAIL because `StartupContext.mainProcessLogger` and recovery wiring do not exist.

- [ ] **Step 3: Implement startup wiring**

In `electron/startup.ts`:
- Import `type ElectronMainLogger` and `registerRendererRecovery`.
- Extend `BrowserWindowLike` with optional `webContents`.
- Extend `StartupContext` with `mainProcessLogger?: ElectronMainLogger`.
- Extend `StartupContext` with `rendererRecoveryVerifier?: () => Promise<void>`.
- After `loadUrl` is computed and before returning the main result, call `registerRendererRecovery({ window, loadUrl, serverUrl, logger: ctx.mainProcessLogger, verifyRecovered: ctx.rendererRecoveryVerifier })` when a logger is present.
- If a logger is present but no `window.webContents` exists, log `main_window_recovery_unavailable`.
- Keep the existing initial `loadURL(loadUrl).catch(...)` path, but route it through `ctx.mainProcessLogger.log({ event: 'main_window_initial_load_failed', ... })` when available.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- --config config/vitest/vitest.electron.config.ts test/unit/electron/startup.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add electron/startup.ts test/unit/electron/startup.test.ts
git commit -m "feat(electron): supervise main renderer during startup"
```

### Task 4: Entry Integration And E2E Crash Recovery Smoke

**Files:**
- Modify: `electron/entry.ts`
- Modify: `test/e2e-electron/electron-app.test.ts`

**Interfaces:**
- Consumes: `createElectronMainLogger()` from `electron/main-process-logger.ts`
- Consumes: `StartupContext.mainProcessLogger`

- [ ] **Step 1: Write failing e2e smoke**

Add a new `Renderer crash recovery` describe outside the existing `Main window with remote server` describe so it does not inherit that describe's `beforeEach` or read the live `.env` token.

Add this import near the other imports:

```ts
import { TestServer } from '../e2e-browser/helpers/test-server.js'
```

```ts
test.describe('Renderer crash recovery', () => {
  let app: ElectronApplication | undefined
  let tmpHome: string | undefined
  let server: TestServer | undefined

  test.afterEach(async () => {
    if (app) await app.close().catch(() => {})
    if (server) await server.stop().catch(() => {})
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  test('recovers the main Freshell UI after the renderer process crashes', async () => {
    server = new TestServer()
    const serverInfo = await server.start()
    tmpHome = createTempHome({
      serverMode: 'remote',
      port: serverInfo.port,
      remoteUrl: serverInfo.baseUrl,
      remoteToken: serverInfo.token,
      knownServers: [],
      alwaysAskOnLaunch: false,
      globalHotkey: 'CommandOrControl+`',
      startOnLogin: false,
      minimizeToTray: true,
      setupCompleted: true,
    })

    app = await launchApp(tmpHome, true)
    const mainPage = await app.firstWindow()
    await mainPage.waitForLoadState('domcontentloaded')
    await expect(mainPage.locator('text=New Tab').first()).toBeVisible({ timeout: 30_000 })

    await app.evaluate(() => {
      const { BrowserWindow } = require('electron')
      const [win] = BrowserWindow.getAllWindows()
      win.webContents.forcefullyCrashRenderer()
    })

    const escapedBaseUrl = serverInfo.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const recovered = await waitForWindowUrl(app, new RegExp(escapedBaseUrl), 60_000)
    await expect(recovered.locator('text=New Tab').first()).toBeVisible({ timeout: 60_000 })

    await app.evaluate(() => {
      const { shell } = require('electron')
      const original = shell.openExternal
      ;(globalThis as any).__testOpenExternal = (url: string) => {
        ;(globalThis as any).__openedUrl = url
        return Promise.resolve()
      }
      ;(globalThis as any).__restoreOpenExternal = () => {
        shell.openExternal = original
      }
      shell.openExternal = (globalThis as any).__testOpenExternal
    })

    await recovered.evaluate(async () => {
      const link = document.createElement('a')
      link.href = 'https://example.com/freshell-recovery-ipc'
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = 'recovery ipc link'
      document.body.appendChild(link)
      link.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }))
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    })

    await expect.poll(async () =>
      app.evaluate(() => (globalThis as any).__openedUrl),
    ).toBe('https://example.com/freshell-recovery-ipc')

    const logDir = path.join(tmpHome, '.freshell', 'logs')
    await expect.poll(() => {
      const file = fs.readdirSync(logDir).find((name) => name.startsWith('electron-main.') && name.endsWith('.jsonl'))
      if (!file) return ''
      return fs.readFileSync(path.join(logDir, file), 'utf8')
    }).toContain('main_window_recovery_succeeded')
  })
})
```

- [ ] **Step 2: Run the focused e2e to verify it fails**

Run: `npm run build:client && npm run build:server && npm run build:electron`

Expected: PASS before the e2e run. `build:client` and `build:server` are required because `TestServer` serves `dist/server` and `dist/client`; `build:electron` is required because Playwright launches the Electron entry from `dist/electron`.

Run: `npm run test:e2e:electron -- --grep "recovers the main Freshell UI after the renderer process crashes"`

Expected: FAIL because entry does not create a logger or pass it to startup, and renderer recovery is not active in the real Electron app.

- [ ] **Step 3: Implement entry wiring**

In `electron/entry.ts`:
- Import `createElectronMainLogger`.
- Create `const mainProcessLogger = createElectronMainLogger({ configDir })` after `configDir`.
- Pass `mainProcessLogger` into the `StartupContext`.
- Log a startup event with app version and `isDev` after `app.whenReady()`.

- [ ] **Step 4: Run focused verification**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.electron.config.ts \
  test/unit/electron/main-process-logger.test.ts \
  test/unit/electron/renderer-recovery.test.ts \
  test/unit/electron/startup.test.ts --run
npm run build:client && npm run build:server && npm run build:electron
npm run test:e2e:electron -- --grep "recovers the main Freshell UI after the renderer process crashes"
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add electron/entry.ts test/e2e-electron/electron-app.test.ts
git commit -m "test(electron): cover renderer crash recovery"
```

### Task 5: Full Verification

**Files:**
- No new implementation files.

**Interfaces:**
- Consumes all prior tasks.
- Produces a verified branch suitable for review.

- [ ] **Step 1: Run coordinated Electron unit suite**

Run: `npm run test:electron`

Expected: PASS.

- [ ] **Step 2: Run Electron e2e suite**

Run:

```bash
npm run build:client && npm run build:server && npm run build:electron
npm run test:e2e:electron
```

Expected: PASS. If unrelated pre-existing Electron e2e failures appear, capture exact failures and rerun the focused renderer recovery smoke to separate regression from environment.

- [ ] **Step 3: Run full coordinated check**

Run: `FRESHELL_TEST_SUMMARY="electron renderer recovery branch verification" npm run check`

Expected: PASS. If the shared coordinator is held by another agent, wait for the gate rather than killing the holder.

- [ ] **Step 4: Commit any final test or refactor changes**

Run:

```bash
git status --short
git add <only-files-touched-for-this-change>
git commit -m "chore(electron): verify renderer recovery"
```

Only run the final commit if Step 1-3 required additional changes.

## Self-Review

- Spec coverage: The plan addresses the observed failure mode (lost renderer), the observed recovery gap (no main-process lifecycle supervision), durable structured logs, bounded recovery, and user-visible e2e coverage. Local crash reporting is intentionally excluded because it needs a separate privacy review.
- Placeholder scan: No unresolved placeholder text or unspecified tests are present. Each task names exact files, functions, commands, and expected outcomes.
- Type consistency: `ElectronMainLogger`, `StartupContext.mainProcessLogger`, `BrowserWindowLike.webContents`, and `registerRendererRecovery()` are defined once and reused consistently across tasks.
