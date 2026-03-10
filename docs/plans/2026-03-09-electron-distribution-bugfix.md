# Electron Distribution Bugfix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Fix all bugs preventing the packaged Electron app from completing the setup wizard flow, starting the server, and presenting a working Freshell terminal session.

**Architecture:** The Electron app is a thin wrapper around the existing Freshell web app. The main process (`electron/entry.ts`) orchestrates: wizard display on first run, server spawning, and main window creation. The server runs as a child process using a bundled Node.js binary, with its dependencies in `extraResources`. Bugs exist in (1) Windows path handling for the bundled Node binary, (2) the server's working directory and `.env` resolution when spawned by Electron, (3) duplicate `window-all-closed` handlers causing premature app exit, (4) the server spawner ignoring the `envFile` option, (5) window state not being saved, and (6) the ASAR including the full `node_modules` instead of only electron main-process dependencies.

**Tech Stack:** Electron, Node.js, TypeScript, Vitest

---

## Task 1: Fix bundled Node binary path on Windows

The server spawner constructs the bundled Node binary path as `path.join(resourcesPath, 'bundled-node', 'bin', 'node')`. On Windows, the actual binary is `node.exe`. Node's `child_process.spawn()` does NOT automatically append `.exe` (unlike `execFile`), so the spawn fails with ENOENT on Windows.

**Files:**
- Modify: `electron/startup.ts:90`
- Modify: `electron/server-spawner.ts:100-101`
- Test: `test/unit/electron/startup.test.ts`
- Test: `test/unit/electron/server-spawner.test.ts`

**Step 1: Write failing test in startup.test.ts**

Add a test that verifies the node binary path includes `.exe` on Windows:

```typescript
it('uses .exe extension for node binary on Windows', async () => {
  // Set platform to win32 in test context
  const ctx = buildCtx({ platform: 'win32' })
  // ... verify that the nodeBinary passed to serverSpawner.start() ends with 'node.exe'
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 2: Fix the node binary path in startup.ts**

In `startup.ts`, around line 90, change:
```typescript
nodeBinary: path.join(resourcesPath, 'bundled-node', 'bin', 'node'),
```
to:
```typescript
nodeBinary: path.join(resourcesPath, 'bundled-node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
```

But since `startup.ts` is pure/testable and doesn't import `process` directly (it receives `ctx`), we need to either:
- Add `platform` to the `StartupContext` interface, or
- Determine the binary name based on `resourcesPath` contents, or
- Use a helper function

The cleanest approach: add `platform: NodeJS.Platform` to `StartupContext`. The entry point already knows the platform.

In `startup.ts`:
1. Add `platform: NodeJS.Platform` to `StartupContext`
2. Compute the binary name: `const nodeBinaryName = ctx.platform === 'win32' ? 'node.exe' : 'node'`
3. Use it in the path

In `entry.ts`:
1. Add `platform: process.platform` to the ctx object

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

When the Electron app spawns the server in production `app-bound` mode, the server process inherits the Electron app's CWD (e.g., `C:\Program Files\Freshell\`). The server's `bootstrap.ts` uses `process.cwd()` to locate `.env`, and `dotenv/config` also reads from CWD. This means:
1. The `.env` file gets created in the install directory (often read-only)
2. Even if it could be created, it's the wrong location

The fix: the server spawner should set `cwd` to `configDir` (`~/.freshell`), and the server spawner should use the `envFile` option (currently ignored) to pass the `.env` path via an environment variable.

Additionally, the server should support an `ENV_FILE` environment variable to override the `.env` file location, and a `FRESHELL_CWD` variable to tell bootstrap where to create `.env`.

**Files:**
- Modify: `electron/server-spawner.ts:124` (add `cwd` to spawn options)
- Test: `test/unit/electron/server-spawner.test.ts`

**Step 1: Write failing test**

Add a test that verifies the spawn call includes `cwd` set to `configDir`:

```typescript
it('sets cwd to configDir in production mode', async () => {
  // ... verify spawn was called with { cwd: options.configDir }
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/server-spawner.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 2: Fix server-spawner.ts**

In `server-spawner.ts`, modify the `spawn()` call at line 124 to include `cwd`:

```typescript
childProcess = spawn(cmd, args, {
  env,
  cwd: configDir,  // Server looks for .env in cwd via dotenv
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
})
```

This ensures that:
- `dotenv/config` finds `.env` in `~/.freshell/`
- `bootstrap.ts`'s `resolveProjectRoot()` returns `~/.freshell/`
- The server creates `.env` in `~/.freshell/` on first run

**Step 3: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/server-spawner.test.ts --config vitest.electron.config.ts`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/electron-distribution
git add electron/server-spawner.ts test/unit/electron/server-spawner.test.ts
git commit -m "fix(electron): set server CWD to configDir so .env resolves correctly"
```

---

## Task 3: Fix duplicate window-all-closed handlers

`entry.ts` registers a no-op `window-all-closed` handler to keep the app alive during the wizard-to-main transition. Then `initMainProcess()` in `main.ts` registers another `window-all-closed` handler that calls `app.quit()` on non-macOS. Both handlers fire (Node EventEmitter allows multiple listeners), but the second one (from `initMainProcess`) tries to quit the app, which conflicts with the first one's intent during the wizard flow.

After the wizard completes and `main()` re-runs, both handlers are still registered. On non-macOS, this means:
1. The no-op handler runs (does nothing)
2. The quit handler runs (quits the app)

The fix: `initMainProcess` should not register its own `window-all-closed` handler. Instead, entry.ts should update the handler behavior based on whether we're in wizard or main mode. Or simpler: remove the handler from entry.ts and let initMainProcess handle it, but guard against the wizard phase by tracking state.

The cleanest fix: remove the `window-all-closed` handler from `entry.ts` entirely and instead pass a flag to `initMainProcess` or handle the lifecycle differently. Since `entry.ts` re-runs `main()` on wizard close, and the wizard window closing would trigger `window-all-closed` before `main()` is called again, we need to prevent `app.quit()` during that gap.

Best approach:
1. In `entry.ts`, register a `window-all-closed` handler that checks a module-level `isInWizardPhase` flag
2. Remove the handler from `initMainProcess` and have it managed solely by `entry.ts`

**Files:**
- Modify: `electron/entry.ts` (lines 43-49)
- Modify: `electron/main.ts` (lines 74-78)
- Test: `test/unit/electron/main.test.ts`

**Step 1: Write failing test**

Add/modify test to verify that `initMainProcess` does not register a `window-all-closed` handler (it's now entry.ts's responsibility):

```typescript
it('does not register its own window-all-closed handler', () => {
  // verify app.on was not called with 'window-all-closed'
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/main.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 2: Fix main.ts and entry.ts**

In `main.ts`, remove the `window-all-closed` handler (lines 74-78). This is entry.ts's responsibility.

In `entry.ts`, update the handler to be lifecycle-aware:
```typescript
let wizardPhase = true

if (!app.listenerCount('window-all-closed')) {
  app.on('window-all-closed', () => {
    if (wizardPhase) return  // Keep alive during wizard-to-main transition
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
```

Set `wizardPhase = false` after the startup result is `'main'` (right before `initMainProcess`).

**Step 3: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/main.test.ts --config vitest.electron.config.ts`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/electron-distribution
git add electron/entry.ts electron/main.ts test/unit/electron/main.test.ts
git commit -m "fix(electron): consolidate window-all-closed handler in entry.ts"
```

---

## Task 4: Fix window state persistence (save on move/resize/maximize)

The `WindowStatePersistence` module can load and save state, but nothing in `entry.ts` or `startup.ts` actually calls `save()` when the window is moved, resized, or maximized. The window state is loaded on startup but never persisted.

**Files:**
- Modify: `electron/startup.ts` (add save handlers to window)
- Modify: `electron/startup.ts` (extend `BrowserWindowLike` interface to support bounds/maximize events)
- Test: `test/unit/electron/startup.test.ts`

**Step 1: Write failing test**

Add a test that verifies `windowStatePersistence.save()` is called when the window emits a `resize` or `move` event:

```typescript
it('saves window state on resize', async () => {
  // Trigger the 'resize' event on the mock window
  // Verify windowStatePersistence.save() was called with correct bounds
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 2: Implement window state save handlers**

In `startup.ts`, after creating the window and before returning the result, add event handlers:

```typescript
// Save window state on move/resize (debounced)
let saveTimeout: ReturnType<typeof setTimeout> | undefined
const saveState = () => {
  clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    const bounds = (window as any).getBounds?.()
    const maximized = (window as any).isMaximized?.()
    if (bounds) {
      void ctx.windowStatePersistence.save({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: maximized ?? false,
      })
    }
  }, 500)
}

window.on('resize', saveState)
window.on('move', saveState)
```

Extend `BrowserWindowLike` to include:
```typescript
getBounds?(): { x: number; y: number; width: number; height: number }
isMaximized?(): boolean
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

## Task 5: Exclude node_modules from ASAR via electron-builder config

The ASAR currently contains 15,000+ entries from `node_modules`. The Electron main process code (`dist/electron/`) imports only a few things: `zod`, `electron-updater`, and `fs/path/os/child_process` (built-ins). The server's dependencies are already in `server-node-modules` in extraResources. Including the full `node_modules` in the ASAR wastes ~100MB+ and slows startup.

The fix is to add a `node_modules` filter in `electron-builder.yml` to include only the packages the main process actually needs.

**Files:**
- Modify: `electron-builder.yml`

**Step 1: Identify main process dependencies**

The electron main process imports:
- `electron` (provided by Electron runtime, not from node_modules)
- `electron-updater` (from node_modules)
- `zod` (used in desktop-config.ts via types.ts)

So only `zod` and `electron-updater` (plus their transitive deps) need to be in the ASAR.

**Step 2: Update electron-builder.yml**

Add a `node_modules` filter to the `files` section. Note: electron-builder automatically installs production dependencies from package.json into the ASAR. To limit this, we should either use the `files` pattern to exclude most modules, or better, create a separate `package.json` for the electron app that only declares `zod` and `electron-updater` as dependencies.

The cleanest approach for electron-builder is to add negative patterns to `files`:

```yaml
files:
  - dist/electron/**
  - dist/wizard/**
  - package.json
  - "!node_modules/**"
  - node_modules/zod/**
  - node_modules/electron-updater/**
  - node_modules/electron-log/**
  - node_modules/builder-util-runtime/**
  - node_modules/lazy-val/**
  - node_modules/semver/**
  - node_modules/lodash.isequal/**
  - node_modules/js-yaml/**
  - node_modules/argparse/**
```

Actually, electron-builder handles node_modules specially. It runs its own pruning based on `package.json` dependencies. The issue is that our `package.json` has ALL dependencies (server + client + electron) because it's a monorepo.

The proper fix: use `files` to exclude `!node_modules` entirely (the electron main process only needs `zod` which is small, and `electron-updater` is already bundled by electron-builder separately). Then explicitly include just the needed node_modules.

An even simpler approach: since the main process code can work without any node_modules at all if we bundle it (e.g., with esbuild/rollup), but that's a bigger change. For now, let's just filter.

**Step 3: Update the config**

In `electron-builder.yml`, change:
```yaml
files:
  - dist/electron/**
  - dist/wizard/**
  - package.json
```

to:
```yaml
files:
  - dist/electron/**
  - dist/wizard/**
  - package.json
  - "!**/node_modules"
```

Wait -- this would break the ASAR entirely because the main process `require('zod')` would fail. We need zod in the ASAR.

Actually, let's check: does `desktop-config.ts` import zod at runtime? Yes it does -- `DesktopConfigSchema.safeParse(parsed)`. And `types.ts` has `import { z } from 'zod'`.

So we need `zod` in the ASAR. Let's use electron-builder's built-in dependency management but tell it to only include specific dependencies. The way to do this is with the `files` patterns.

The simplest fix that works: change the `files` array to explicitly exclude then include:

```yaml
files:
  - dist/electron/**
  - dist/wizard/**
  - package.json
  - "!node_modules"
  - node_modules/zod
  - node_modules/zod/**
```

Note: `electron-updater` is handled separately by electron-builder -- it's a `devDependency` and electron-builder knows to include it. But let's verify.

Actually, electron-builder's `files` globs do NOT control `node_modules` installation. Electron-builder always runs its own `npm install --production` or equivalent to populate `node_modules` in the ASAR. The `files` patterns only control which source files go in. The `node_modules` are managed separately.

To control which node_modules get bundled, we need to use the `includeSubNodeModules` option or restructure. The easiest approach is to move the electron `package.json` dependencies out of the main `package.json` and use a two-package.json structure (which electron-builder supports natively). But that's complex.

A pragmatic approach for now: this is a packaging optimization, not a functionality bug. Let's defer this to a separate task and focus on the functional bugs. Note it as a known issue.

**Decision:** Skip this task for now. The bloated ASAR is a packaging optimization issue, not a functional bug. The app still works correctly with the full node_modules. File a TODO to address later with either esbuild bundling of main process code or a two-package.json structure.

---

## Task 5 (revised): Fix wizard completion flow -- window.close() race

When the wizard completes, `main.tsx` calls `window.freshellDesktop.completeSetup(config)` then `window.close()`. The `completeSetup` IPC call is async -- it writes the config to disk. But `window.close()` is called immediately after, potentially before the config write completes.

Additionally, the wizard window's `closed` event triggers `void main()` to restart the startup sequence. If `window.close()` fires before `patchDesktopConfig` has finished writing, the re-read in `main()` may get stale data (or no data at all).

**Files:**
- Modify: `electron/setup-wizard/main.tsx`
- Test: `test/unit/electron/setup-wizard/wizard.test.tsx` (or `wizard-window.test.ts`)

**Step 1: Fix main.tsx to await completeSetup before closing**

Change:
```typescript
async function handleComplete(config: WizardConfig): Promise<void> {
  await window.freshellDesktop?.completeSetup(config)
  window.close()
}
```

This is actually already correct -- `await` ensures `completeSetup` resolves before `window.close()` is called. But let's verify the IPC handler in `entry.ts`:

```typescript
ipcMain.handle('complete-setup', async (_event, config) => {
  await patchDesktopConfig({ ... })
})
```

This also looks correct -- the handler awaits `patchDesktopConfig` before resolving, which means the `invoke()` in the renderer won't resolve until the config is written. So the `await` in `main.tsx` is sufficient. No bug here.

**Decision:** Skip. The flow is correct as-is.

---

## Task 5 (final): Add auth token handling for Electron-spawned server

When the server starts in Electron `app-bound` mode, it needs a valid `AUTH_TOKEN` to accept WebSocket connections. The server's `bootstrap.ts` creates `.env` with a generated token, but the Electron app's main window then loads `http://localhost:{port}` without any auth cookie/token.

The browser client normally gets the auth token from a cookie set during login at `/login`. In Electron, there's no login page -- the user just launches the app and expects it to work.

The fix: the server spawner should read the `.env` file after the server starts to get the `AUTH_TOKEN`, and the main window should be loaded with the token as a query parameter or via a cookie. Alternatively, the server should recognize connections from localhost as trusted when running in Electron mode.

Actually, looking at the existing auth flow more carefully:

**Files:**
- Verify: `server/auth.ts`

Let me check how auth works. The server's `auth.ts` validates tokens. The question is: does the Electron window (loading `http://localhost:3001`) get past auth?

**Step 1: Check auth flow**

The server has an `AUTH_TOKEN` env var. Clients authenticate by posting to `/login` with the token, which sets a cookie. WebSocket connections are authenticated via the cookie.

In Electron, the main window loads `http://localhost:3001`. Without the auth cookie, the server would redirect to `/login`. This means the user would see a login page inside Electron, which is wrong UX.

The fix: The Electron app should auto-authenticate. Options:
1. Pass the auth token as a query param when loading the URL
2. Have the server skip auth for localhost connections when running in Electron mode
3. Have the Electron app read the `.env` and set the cookie before loading

Option 3 is cleanest -- it doesn't require server changes.

In `entry.ts` or `startup.ts`, after the server starts:
1. Read the `AUTH_TOKEN` from `~/.freshell/.env`
2. Set the auth cookie on the Electron session before loading the URL

This can be done via Electron's `session.defaultSession.cookies.set()`.

**Files:**
- Modify: `electron/startup.ts` (read token, set cookie before loadURL)
- Modify: `electron/entry.ts` (expose session.cookies API via context)
- Test: `test/unit/electron/startup.test.ts`

**Step 1: Write failing test**

Add a test that verifies the startup flow sets an auth cookie before loading the URL:

```typescript
it('sets auth cookie before loading server URL in app-bound mode', async () => {
  const setCookie = vi.fn()
  const ctx = buildCtx({
    desktopConfig: { ...defaultConfig, serverMode: 'app-bound', setupCompleted: true },
    setCookie,
  })
  await runStartup(ctx)
  expect(setCookie).toHaveBeenCalledWith(expect.objectContaining({
    url: expect.stringContaining('localhost'),
    name: 'auth_token',
    value: expect.any(String),
  }))
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 2: Add cookie-setting to StartupContext and startup flow**

In `startup.ts`, add to `StartupContext`:
```typescript
setCookie?: (cookie: { url: string; name: string; value: string; path: string }) => Promise<void>
readEnvFile?: (envPath: string) => Promise<Record<string, string>>
```

In the `app-bound` case of `runStartup`, after `serverSpawner.start()` and before `window.loadURL()`:
```typescript
// Auto-authenticate: read the server's AUTH_TOKEN and set it as a cookie
if (ctx.readEnvFile && ctx.setCookie) {
  const envPath = path.join(ctx.configDir, '.env')
  const env = await ctx.readEnvFile(envPath)
  if (env.AUTH_TOKEN) {
    await ctx.setCookie({
      url: serverUrl,
      name: 'auth_token',
      value: env.AUTH_TOKEN,
      path: '/',
    })
  }
}
```

In `entry.ts`, provide the real implementations:
```typescript
import { session } from 'electron'
// ...
setCookie: async (cookie) => {
  await session.defaultSession.cookies.set(cookie)
},
readEnvFile: async (envPath) => {
  // Reuse bootstrap's parseEnvFile if available, or inline
  const fs = await import('fs/promises')
  try {
    const content = await fs.readFile(envPath, 'utf-8')
    const env: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
    }
    return env
  } catch {
    return {}
  }
},
```

**Step 3: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/electron-distribution
git add electron/startup.ts electron/entry.ts test/unit/electron/startup.test.ts
git commit -m "fix(electron): auto-authenticate by setting auth cookie from server .env"
```

---

## Task 6: Fix daemon mode -- pass token for auto-auth

Similar to Task 5, but for daemon mode: the daemon is started by the OS, not by Electron. The Electron app connects to `http://localhost:{port}` but needs the auth cookie. The daemon's `.env` was created during installation.

The same `readEnvFile` + `setCookie` approach works. The code from Task 5 should handle both `app-bound` and `daemon` modes, since both connect to `http://localhost:{port}`.

**Files:**
- Modify: `electron/startup.ts` (apply cookie-setting to daemon mode too)
- Test: `test/unit/electron/startup.test.ts`

**Step 1: Write failing test**

```typescript
it('sets auth cookie before loading server URL in daemon mode', async () => {
  const setCookie = vi.fn()
  const ctx = buildCtx({
    desktopConfig: { ...defaultConfig, serverMode: 'daemon', setupCompleted: true },
    setCookie,
    daemonManager: { status: async () => ({ installed: true, running: true }) },
  })
  await runStartup(ctx)
  expect(setCookie).toHaveBeenCalled()
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 2: Move cookie-setting to after serverUrl is determined**

In `startup.ts`, move the cookie-setting code to after the `switch` statement (after `serverUrl` is determined), so it applies to both `daemon` and `app-bound` modes (but not `remote`, which has its own auth via `remoteToken`):

```typescript
// After the switch statement, before creating the window:
if (desktopConfig.serverMode !== 'remote' && ctx.readEnvFile && ctx.setCookie) {
  const envPath = path.join(ctx.configDir, '.env')
  const env = await ctx.readEnvFile(envPath)
  if (env.AUTH_TOKEN) {
    await ctx.setCookie({
      url: serverUrl,
      name: 'auth_token',
      value: env.AUTH_TOKEN,
      path: '/',
    })
  }
}
```

**Step 3: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/electron-distribution
git add electron/startup.ts test/unit/electron/startup.test.ts
git commit -m "fix(electron): auto-authenticate in daemon mode too"
```

---

## Task 7: Fix server spawner production mode NODE_PATH on Windows

The server spawner sets `NODE_PATH` using `path.delimiter` which is `;` on Windows and `:` on Unix. This is correct. However, the production `nodeBinary` path computation in `startup.ts` needs the Windows `.exe` fix from Task 1.

Additionally, verify that the server spawner's production mode correctly resolves all the paths when the resources directory contains spaces (common on Windows: `C:\Program Files\Freshell\resources`).

**Files:**
- Modify: `electron/server-spawner.ts` (no changes needed if path.delimiter is already used)
- Test: `test/unit/electron/server-spawner.test.ts`

**Step 1: Write test for paths with spaces**

```typescript
it('handles paths with spaces in production mode', async () => {
  const spawner = createServerSpawner()
  // Mock spawn to capture args
  // Use paths with spaces: 'C:\\Program Files\\Freshell\\resources\\bundled-node\\bin\\node.exe'
  // Verify spawn is called with the correct paths
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/server-spawner.test.ts --config vitest.electron.config.ts`
Expected: PASS (paths with spaces work because spawn() doesn't use shell)

**Decision:** The server spawner already uses `spawn()` without `shell: true`, which means paths with spaces are handled correctly (no shell escaping needed). `path.delimiter` is also correct. No code changes needed here. Skip.

---

## Task 7 (revised): Fix the tray icon path on Windows in production

In `entry.ts`, the tray icon path construction is:
```typescript
const iconName = process.platform === 'win32' ? 'tray-icon-win.ico' : 'tray-icon.png'
const iconPath = isDev
  ? path.join(__dirname, '..', '..', 'assets', 'electron', iconName)
  : path.join(process.resourcesPath!, 'assets', iconName)
```

In the packaged app, `process.resourcesPath` points to the `resources/` directory. The `extraResources` config copies from `assets/electron` to `assets`, filtering for `tray-icon*`. Let's verify the icon files are present:

The assets directory in the packaged app contains: `tray-icon@2x.png`, `tray-icon.png`, `tray-icon-win.ico`. This looks correct.

**Decision:** No bug here. Skip.

---

## Task 7 (final): Add remote mode auth token support

In remote mode, the user configures a `remoteToken` in the wizard. The Electron app needs to pass this token to the server. Currently, startup.ts just loads the remote URL directly -- the user would see a login page.

**Files:**
- Modify: `electron/startup.ts` (set cookie for remote mode using remoteToken)
- Test: `test/unit/electron/startup.test.ts`

**Step 1: Write failing test**

```typescript
it('sets auth cookie for remote mode using remoteToken', async () => {
  const setCookie = vi.fn()
  const ctx = buildCtx({
    desktopConfig: {
      ...defaultConfig,
      serverMode: 'remote',
      remoteUrl: 'http://10.0.0.5:3001',
      remoteToken: 'test-token-123',
      setupCompleted: true,
    },
    setCookie,
  })
  await runStartup(ctx)
  expect(setCookie).toHaveBeenCalledWith(expect.objectContaining({
    url: 'http://10.0.0.5:3001',
    name: 'auth_token',
    value: 'test-token-123',
  }))
})
```

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: FAIL

**Step 2: Add remote auth token handling**

In `startup.ts`, after the switch statement and the local mode cookie setting, add:

```typescript
// For remote mode, use the configured remote token
if (desktopConfig.serverMode === 'remote' && desktopConfig.remoteToken && ctx.setCookie) {
  await ctx.setCookie({
    url: serverUrl,
    name: 'auth_token',
    value: desktopConfig.remoteToken,
    path: '/',
  })
}
```

**Step 3: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npx vitest run test/unit/electron/startup.test.ts --config vitest.electron.config.ts`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/electron-distribution
git add electron/startup.ts test/unit/electron/startup.test.ts
git commit -m "fix(electron): set auth cookie for remote mode using configured token"
```

---

## Task 8: Fix server spawner to pass PORT via environment correctly

The server spawner already sets `PORT` in the environment. But there's a subtle issue: the `.env` file in `~/.freshell/` (created by bootstrap) hardcodes `PORT=3001`. If the user chose a different port in the wizard (e.g., 8080), the spawner sets `PORT=8080` in the environment, but `dotenv/config` then loads the `.env` file which has `PORT=3001`, potentially overriding the env var.

Actually, `dotenv` does NOT override existing environment variables by default. It only sets variables that aren't already set. Since the spawner sets `PORT` in the `env` object passed to `spawn()`, and that becomes the child's `process.env`, `dotenv` will see `PORT` is already set and skip it. So this is not a bug.

**Decision:** No bug. Skip.

---

## Task 8 (revised): Fix server NODE_PATH to include client dist path

The server in production mode needs to find its `node_modules`. The spawner sets `NODE_PATH` to `nativeModulesDir:serverNodeModulesDir`. The server also needs to find built-in Node modules, which it does. And `express.static` serves from `resources/client/` relative to `resources/server/index.js`, which works.

However, the server's `import 'dotenv/config'` needs to find `dotenv` in `NODE_PATH`. Since `dotenv` is in `server-node-modules`, and `NODE_PATH` includes `serverNodeModulesDir`, this should work.

Let me verify: `node_modules/dotenv` is in the `server-node-modules` directory in the packaged app?

**Step 1: Check**

The `server-node-modules` are created by `prepare-bundled-node.ts` which runs `npm ci --omit=dev`. `dotenv` is in `dependencies` (not `devDependencies`), so it should be included.

**Decision:** No bug. Skip.

---

## Task 8 (final): Run all tests and verify everything passes

**Step 1: Run the full test suite**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npm test`
Expected: All tests pass

**Step 2: Run the electron tests specifically**

Run: `cd /home/user/code/freshell/.worktrees/electron-distribution && npm run test:electron`
Expected: All tests pass

**Step 3: Final commit**

If any test adjustments were needed, commit them.

---

## Summary of Bugs Fixed

1. **Windows node binary path** (Task 1): `node` vs `node.exe` -- spawn fails on Windows
2. **Server CWD** (Task 2): Server spawned with wrong CWD, `.env` created in wrong location
3. **Duplicate window-all-closed** (Task 3): Two handlers cause premature app exit on non-macOS
4. **Window state not saved** (Task 4): State loaded but never persisted on move/resize
5. **Auth token not set** (Tasks 5-7): Electron window loads server URL without auth cookie, sees login page
