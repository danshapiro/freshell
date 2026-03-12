# Electron Distribution Bugfix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Fix all bugs preventing the packaged Electron app from completing the setup wizard flow, starting the server, and presenting a working Freshell terminal session.

**Architecture:** The Electron app is a thin wrapper around the existing Freshell web app. The main process (`electron/entry.ts`) orchestrates: wizard display on first run, server spawning, and main window creation. The server runs as a child process using a bundled Node.js binary, with its dependencies in `extraResources`. Bugs exist in (1) Windows path handling for the bundled Node binary, (2) the server's working directory and `.env` resolution when spawned by Electron, (3) duplicate `window-all-closed` handlers causing premature app exit, (4) window state not being saved, and (5) the Electron window loading the server URL without an auth token, causing the user to see a login page instead of the terminal.

**Tech Stack:** Electron, Node.js, TypeScript, Vitest

---

## Task 1: Fix bundled Node binary path on Windows

The server spawner constructs the bundled Node binary path as `path.join(resourcesPath, 'bundled-node', 'bin', 'node')` (in `electron/startup.ts:90`). On Windows, the actual binary is `node.exe`. Node's `child_process.spawn()` does NOT automatically append `.exe` (unlike shell-based execution), so the spawn fails with ENOENT on Windows.

Since `startup.ts` is a pure module that receives all dependencies via `StartupContext` (for testability), we need to add `platform: NodeJS.Platform` to `StartupContext` so the binary name can be computed without importing `process` directly.

**Files:**
- Modify: `electron/startup.ts`
- Modify: `electron/entry.ts`
- Test: `test/unit/electron/startup.test.ts`

**Step 1: Write failing test in startup.test.ts**

Add a test that verifies the node binary path includes `.exe` when `platform` is `'win32'`. The existing test at line 162 asserts `expect(startArgs.spawn.nodeBinary).toContain('/app/resources/bundled-node/bin/node')`, which does not distinguish `node` from `node.exe`. Add a new test:

```typescript
it('uses node.exe on Windows platform', async () => {
  const ctx = createDefaultContext({
    isDev: false,
    resourcesPath: 'C:\\Program Files\\Freshell\\resources',
    platform: 'win32',
  })
  const result = await runStartup(ctx)
  expect(result.type).toBe('main')
  const startArgs = (ctx.serverSpawner.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
  expect(startArgs.spawn.nodeBinary).toMatch(/node\.exe$/)
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: FAIL (property `platform` does not exist on `StartupContext`)

**Step 2: Add platform to StartupContext and fix binary path**

In `electron/startup.ts`:
1. Add `platform: NodeJS.Platform` to the `StartupContext` interface (after `configDir`)
2. In the `app-bound` production case (~line 90), change the `nodeBinary` construction from:
   ```typescript
   nodeBinary: path.join(resourcesPath, 'bundled-node', 'bin', 'node'),
   ```
   to:
   ```typescript
   nodeBinary: path.join(resourcesPath, 'bundled-node', 'bin', ctx.platform === 'win32' ? 'node.exe' : 'node'),
   ```

In `electron/entry.ts`:
1. Add `platform: process.platform` to the `ctx` object (~line 98, inside the `StartupContext` construction)

In `test/unit/electron/startup.test.ts`:
1. Add `platform: 'linux' as NodeJS.Platform` to the `createDefaultContext()` helper (after `configDir`)
2. Add the new Windows test from Step 1

**Step 3: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/electron-distribution
git add electron/startup.ts electron/entry.ts test/unit/electron/startup.test.ts
git commit -m "fix(electron): use .exe extension for bundled node binary on Windows"
```

---

## Task 2: Fix server CWD and .env resolution for Electron-spawned server

When the Electron app spawns the server in production `app-bound` mode, the server process inherits the Electron app's CWD (e.g., `C:\Program Files\Freshell\`). The server's `bootstrap.ts` (line 318) uses `process.cwd()` to locate `.env`, and `dotenv/config` also reads from CWD. This means:
1. The `.env` file gets created in the install directory (often read-only on Windows)
2. Even if it could be created, it's the wrong location -- `~/.freshell/` is where config should live

The fix: the server spawner should set `cwd` to `configDir` (`~/.freshell`) in the `spawn()` call. This ensures `dotenv/config` finds `.env` in `~/.freshell/`, and `bootstrap.ts`'s `resolveProjectRoot()` returns `~/.freshell/` so it creates `.env` there on first run.

**Files:**
- Modify: `electron/server-spawner.ts:124`
- Test: `test/unit/electron/server-spawner.test.ts`

**Step 1: Read the existing test to understand mock structure**

Read `test/unit/electron/server-spawner.test.ts` to understand how `spawn` is mocked and how to assert on the `cwd` option.

**Step 2: Write failing test**

Add a test that verifies the `spawn()` call includes `cwd` set to `options.configDir`:

```typescript
it('sets cwd to configDir when spawning server', async () => {
  // ... spawn the server with configDir: '/home/user/.freshell'
  // ... verify the spawn mock was called with options including { cwd: '/home/user/.freshell' }
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/server-spawner.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 3: Fix server-spawner.ts**

In `electron/server-spawner.ts`, modify the `spawn()` call at line 124 to include `cwd: configDir`:

```typescript
childProcess = spawn(cmd, args, {
  env,
  cwd: configDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
})
```

The `configDir` variable is already destructured from `options` at line 91: `const { spawn: spawnMode, port, configDir } = options`.

**Step 4: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/server-spawner.test.ts --config vitest.electron.config.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/electron-distribution
git add electron/server-spawner.ts test/unit/electron/server-spawner.test.ts
git commit -m "fix(electron): set server CWD to configDir so .env resolves correctly"
```

---

## Task 3: Fix duplicate window-all-closed handlers

`electron/entry.ts` (lines 43-49) registers a no-op `window-all-closed` handler to keep the app alive during the wizard-to-main transition. Then `initMainProcess()` in `electron/main.ts` (lines 74-78) registers another `window-all-closed` handler that calls `app.quit()` on non-macOS. Both handlers fire because Node's EventEmitter allows multiple listeners for the same event.

After the wizard completes and `main()` re-runs, both handlers are registered on non-macOS:
1. The no-op handler runs (does nothing)
2. The quit handler from `initMainProcess` runs (`app.quit()`)

This causes the app to exit when the wizard window closes, before the main window can be created. The wizard's `closed` event fires `void main()`, but the `window-all-closed` handler from the previous `initMainProcess` call races and kills the app first.

The fix: consolidate the `window-all-closed` handler in `entry.ts` with a lifecycle-aware guard, and remove the handler from `initMainProcess`.

**Files:**
- Modify: `electron/entry.ts` (lines 43-49)
- Modify: `electron/main.ts` (lines 74-78)
- Test: `test/unit/electron/main.test.ts`

**Step 1: Read the existing main.test.ts**

Read `test/unit/electron/main.test.ts` to understand the mock structure.

**Step 2: Write failing test**

Add/modify test to verify that `initMainProcess` does NOT register a `window-all-closed` handler (it is now `entry.ts`'s responsibility):

```typescript
it('does not register window-all-closed handler', async () => {
  // ... call initMainProcess with mocked app
  // ... verify app.on was not called with 'window-all-closed'
  const windowAllClosedCalls = mockApp.on.mock.calls.filter(
    ([event]: [string]) => event === 'window-all-closed'
  )
  expect(windowAllClosedCalls).toHaveLength(0)
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/main.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 3: Fix main.ts and entry.ts**

In `electron/main.ts`, remove lines 74-78 (the `window-all-closed` handler):
```typescript
// REMOVE this block:
app.on('window-all-closed', () => {
  if (deps.platform !== 'darwin') {
    app.quit()
  }
})
```

In `electron/entry.ts`, update the `window-all-closed` handler (lines 43-49) to be lifecycle-aware. Add a module-level variable `let wizardPhase = true` before the `main()` function. Update the handler:

```typescript
let wizardPhase = true

async function main(): Promise<void> {
  await app.whenReady()

  if (!app.listenerCount('window-all-closed')) {
    app.on('window-all-closed', () => {
      if (wizardPhase) return  // Keep alive during wizard-to-main transition
      if (process.platform !== 'darwin') {
        app.quit()
      }
    })
  }
  // ... rest of main()
```

After `runStartup` returns a `'main'` result (right before calling `initMainProcess`), set `wizardPhase = false`. Before the wizard branch (where `result.type === 'wizard'`), ensure `wizardPhase` remains `true` (it already is by default, and the recursive `main()` call doesn't reset it because the variable is module-level).

**Step 4: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/main.test.ts --config vitest.electron.config.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/electron-distribution
git add electron/entry.ts electron/main.ts test/unit/electron/main.test.ts
git commit -m "fix(electron): consolidate window-all-closed handler in entry.ts to prevent premature exit"
```

---

## Task 4: Fix window state persistence (save on move/resize)

The `WindowStatePersistence` module can load and save state, but nothing in `startup.ts` or `entry.ts` calls `save()` when the window is moved, resized, or maximized. Window state is loaded on startup but never persisted, so the window always opens at default position/size.

**Files:**
- Modify: `electron/startup.ts`
- Test: `test/unit/electron/startup.test.ts`

**Step 1: Write failing test**

Add a test that verifies `windowStatePersistence.save()` is called when the window emits a `resize` event:

```typescript
it('saves window state on resize (debounced)', async () => {
  const mockWindow = createMockWindow()
  // Add getBounds and isMaximized to the mock
  ;(mockWindow as any).getBounds = vi.fn().mockReturnValue({ x: 100, y: 200, width: 800, height: 600 })
  ;(mockWindow as any).isMaximized = vi.fn().mockReturnValue(false)

  const ctx = createDefaultContext({
    createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
  })
  await runStartup(ctx)

  // Find the 'resize' handler registered via window.on
  const onCalls = (mockWindow.on as ReturnType<typeof vi.fn>).mock.calls
  const resizeCall = onCalls.find(([event]: [string]) => event === 'resize')
  expect(resizeCall).toBeDefined()

  // Trigger it
  resizeCall![1]()

  // Advance past debounce timer
  await vi.advanceTimersByTimeAsync(600)

  expect(ctx.windowStatePersistence.save).toHaveBeenCalledWith({
    x: 100, y: 200, width: 800, height: 600, maximized: false,
  })
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 2: Implement window state save handlers**

In `electron/startup.ts`, extend `BrowserWindowLike` to include optional methods:
```typescript
getBounds?(): { x: number; y: number; width: number; height: number }
isMaximized?(): boolean
```

After creating the window and before returning the result, add debounced save handlers:

```typescript
// Save window state on move/resize (debounced to avoid excessive writes)
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
```

**Step 3: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/electron-distribution
git add electron/startup.ts test/unit/electron/startup.test.ts
git commit -m "fix(electron): persist window state on move/resize"
```

---

## Task 5: Fix auth -- pass token as URL query parameter

When the Electron main window loads the server URL (`http://localhost:3001`), it has no auth token. The server's `httpAuthMiddleware` (`server/auth.ts:36-46`) requires the `x-auth-token` HTTP header on every API request, and the WebSocket handler (`server/ws-handler.ts:1145`) requires a `token` field in the `hello` message.

The Freshell client obtains the auth token via the `?token=` URL query parameter: `initializeAuthToken()` in `src/lib/auth.ts:31-49` extracts `?token=` from the URL on page load, stores it in `localStorage`, then strips it from the URL bar. All subsequent API calls send it via the `x-auth-token` header (`src/lib/api.ts:34`), and the WebSocket handshake sends it in the `hello` message.

The correct fix: append `?token=<AUTH_TOKEN>` to the URL passed to `window.loadURL()`. This requires:
- For `app-bound` and `daemon` modes: read `AUTH_TOKEN` from `~/.freshell/.env` (which the server's `bootstrap.ts` creates on first run)
- For `remote` mode: use `desktopConfig.remoteToken` from the wizard config

This replaces the incorrect cookie-based approach. No `setCookie`, `session.cookies`, or cookie-related code is needed.

**Files:**
- Modify: `electron/startup.ts`
- Modify: `electron/entry.ts`
- Test: `test/unit/electron/startup.test.ts`

**Step 1: Write failing tests**

Add three tests to `test/unit/electron/startup.test.ts`:

```typescript
describe('auth token in URL', () => {
  it('appends ?token= to URL for app-bound mode', async () => {
    const mockWindow = createMockWindow()
    const ctx = createDefaultContext({
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      readEnvToken: vi.fn().mockResolvedValue('test-auth-token-abc'),
    })
    await runStartup(ctx)
    expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001?token=test-auth-token-abc')
  })

  it('appends ?token= to URL for daemon mode', async () => {
    const mockWindow = createMockWindow()
    const ctx = createDefaultContext({
      desktopConfig: {
        serverMode: 'daemon',
        globalHotkey: 'CommandOrControl+`',
        startOnLogin: false,
        minimizeToTray: true,
        setupCompleted: true,
      },
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      readEnvToken: vi.fn().mockResolvedValue('daemon-token-xyz'),
    })
    await runStartup(ctx)
    expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001?token=daemon-token-xyz')
  })

  it('appends ?token= to URL for remote mode using remoteToken', async () => {
    const mockWindow = createMockWindow()
    const fetchHealthCheck = vi.fn().mockResolvedValue(true)
    const ctx = createDefaultContext({
      desktopConfig: {
        serverMode: 'remote',
        remoteUrl: 'http://10.0.0.5:3001',
        remoteToken: 'remote-secret-123',
        globalHotkey: 'CommandOrControl+`',
        startOnLogin: false,
        minimizeToTray: true,
        setupCompleted: true,
      },
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      fetchHealthCheck,
    })
    await runStartup(ctx)
    expect(mockWindow.loadURL).toHaveBeenCalledWith('http://10.0.0.5:3001?token=remote-secret-123')
  })

  it('loads URL without token when readEnvToken returns undefined', async () => {
    const mockWindow = createMockWindow()
    const ctx = createDefaultContext({
      createBrowserWindow: vi.fn().mockReturnValue(mockWindow),
      readEnvToken: vi.fn().mockResolvedValue(undefined),
    })
    await runStartup(ctx)
    expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001')
  })
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 2: Add readEnvToken to StartupContext**

In `electron/startup.ts`, add to `StartupContext`:
```typescript
/** Read AUTH_TOKEN from the .env file in configDir. Returns undefined if not found. */
readEnvToken?: (envPath: string) => Promise<string | undefined>
```

**Step 3: Resolve the auth token before loading the URL**

In `electron/startup.ts`, after the `switch` statement (after `serverUrl` is determined) and before `window.loadURL(serverUrl)`, resolve the auth token and append it to the URL:

```typescript
// Resolve auth token for automatic authentication
let authToken: string | undefined

if (desktopConfig.serverMode === 'remote') {
  // Remote mode: use the token from the wizard config
  authToken = desktopConfig.remoteToken
} else if (ctx.readEnvToken) {
  // App-bound / daemon mode: read token from ~/.freshell/.env
  authToken = await ctx.readEnvToken(path.join(ctx.configDir, '.env'))
}

// Build the final URL with auth token
const loadUrl = authToken ? `${serverUrl}?token=${authToken}` : serverUrl
await window.loadURL(loadUrl)
```

Replace the existing `await window.loadURL(serverUrl)` (line 146) with the above code.

**Step 4: Implement readEnvToken in entry.ts**

In `electron/entry.ts`, add `readEnvToken` to the `ctx` object:

```typescript
readEnvToken: async (envPath: string): Promise<string | undefined> => {
  try {
    const fsp = await import('fs/promises')
    const content = await fsp.readFile(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('AUTH_TOKEN=')) {
        const value = trimmed.slice('AUTH_TOKEN='.length).trim()
        // Strip surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          return value.slice(1, -1)
        }
        return value
      }
    }
    return undefined
  } catch {
    return undefined
  }
},
```

**Step 5: Update existing tests that assert on loadURL**

The existing test at line 402 asserts:
```typescript
expect(mockWindow.loadURL).toHaveBeenCalledWith('http://localhost:3001')
```

This test's `createDefaultContext` does not provide `readEnvToken`, so `ctx.readEnvToken` is `undefined`, which means `authToken` will be `undefined` and the URL will remain unchanged. This test should still pass without modification.

However, `createDefaultContext` needs a `platform` field (from Task 1). Also, verify all existing tests still pass with the new code path.

**Step 6: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: PASS

**Step 7: Commit**

```bash
cd /home/user/code/freshell/.worktrees/electron-distribution
git add electron/startup.ts electron/entry.ts test/unit/electron/startup.test.ts
git commit -m "fix(electron): pass auth token as URL query parameter for automatic authentication"
```

---

## Task 6: Run all tests and verify everything passes

**Step 1: Run the electron tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npm run test:electron`
Expected: All tests pass

**Step 2: Run the full test suite**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npm test`
Expected: All tests pass

**Step 3: Final commit if needed**

If any test adjustments were needed, commit them.

---

## Summary of Bugs Fixed

1. **Windows node binary path** (Task 1): `startup.ts` builds the bundled Node.js path without `.exe`, causing `spawn()` to fail with ENOENT on Windows. Fix: add `platform` to `StartupContext`, use it to select `node.exe` vs `node`.

2. **Server CWD** (Task 2): The server spawner does not set `cwd` on the child process. The server's `bootstrap.ts` uses `process.cwd()` to create `.env`, so `.env` ends up in the Electron install directory (often read-only) instead of `~/.freshell/`. Fix: pass `configDir` as `cwd` to `spawn()`.

3. **Duplicate window-all-closed** (Task 3): `entry.ts` registers a no-op handler, then `initMainProcess` registers another that calls `app.quit()`. Both fire on non-macOS, causing the app to exit during wizard-to-main transition. Fix: consolidate the handler in `entry.ts` with a `wizardPhase` guard, remove handler from `main.ts`.

4. **Window state not persisted** (Task 4): `WindowStatePersistence.save()` is never called. State loads on startup but is never updated. Fix: add debounced `resize`/`move` event handlers on the BrowserWindow.

5. **Auth token not passed to server** (Task 5): The Electron window loads the server URL without any authentication. The Freshell client expects the auth token via a `?token=` URL query parameter (processed by `initializeAuthToken()` in `src/lib/auth.ts`), which stores it in `localStorage` for use in `x-auth-token` headers on API calls and the `token` field in WebSocket `hello` messages. Fix: read `AUTH_TOKEN` from `~/.freshell/.env` for local modes (app-bound, daemon) or from `desktopConfig.remoteToken` for remote mode, and append `?token=<value>` to the URL passed to `window.loadURL()`.
