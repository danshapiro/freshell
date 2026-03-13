# Issue 174 First-Run Bootstrap Env Root Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Lock issue `#174` down with heavy regression coverage by proving that a clean compiled startup writes `.env` into the runtime root, loads that token on first run, and serves authenticated requests successfully.

**Architecture:** The functional fix already exists on the current branch and on `main`: [server/bootstrap.ts](/home/user/code/freshell/.worktrees/trycycle-issue-174-bootstrap-env-root/server/bootstrap.ts#L310) resolves the env root from `process.cwd()`, which matches `dotenv/config`. The missing work is durable coverage at the real failure boundary, so the plan extends the existing production-start `TestServer` harness just enough to run `dist/server/index.js` from an isolated temp runtime root without a preseeded `AUTH_TOKEN`, then verifies both the compiled cold-start flow and the helper cleanup path.

**Tech Stack:** Node.js, TypeScript, Vitest, built `dist/server` startup, `test/e2e-browser/helpers/TestServer`

---

## Strategy Gate

- The issue is not “bootstrap logic in isolation”; it is specifically the first compiled startup path from the GitHub issue:

  ```text
  fresh clone -> npm install -> npm run build -> npm run start
  ```

- The issue body says the failure was caused by bootstrap writing `.env` to `dist/.env` while `dotenv/config` loaded from `process.cwd()`. That exact mismatch is already corrected in the current code by [server/bootstrap.ts](/home/user/code/freshell/.worktrees/trycycle-issue-174-bootstrap-env-root/server/bootstrap.ts#L313).
- Because the product fix is already present, the right plan is not to invent another env-loading abstraction. The right plan is to add the missing compiled-start regression harness and only touch product code if that regression still exposes a real mismatch.
- The cleanest surface is the existing `TestServer` helper in [test/e2e-browser/helpers/test-server.ts](/home/user/code/freshell/.worktrees/trycycle-issue-174-bootstrap-env-root/test/e2e-browser/helpers/test-server.ts), because it is already the canonical “start the built production server and wait for health” utility used by browser and perf tests. Replacing it with a one-off spawn helper would duplicate port selection, health waiting, log capture, and cleanup logic for a single issue.
- Heavy coverage for this issue means:
  - keep the existing source-contract unit assertion for `resolveProjectRoot()`
  - add a real compiled cold-start regression using a temp runtime root and no inherited `AUTH_TOKEN`
  - add coverage for the new harness cleanup semantics introduced by the isolated runtime root
  - run the coordinated full suite after focused build-backed verification
- No `docs/index.html` update is needed. This is a startup regression with no user-facing UI change.

## Key Decisions

- Keep the product rule `resolveProjectRoot() === process.cwd()`. That is the issue’s preferred fix and it is the only rule guaranteed to agree with `dotenv/config`.
- Extend `TestServer` behind opt-in options rather than changing default behavior. Existing Playwright/perf callers must continue to get the current “project-root + explicit token” startup path unchanged.
- The isolated runtime root should copy only `package.json` and `dist/`. Do not symlink. Windows-native reproduction was part of the issue, and symlink behavior would make the regression less representative. Do not copy `extensions/`: [server/extension-manager.ts](/home/user/code/freshell/.worktrees/trycycle-issue-174-bootstrap-env-root/server/extension-manager.ts#L62) explicitly tolerates missing extension directories, so they are not required for `/api/health` and `/api/settings`.
- Treat harness changes as the expected end state. Product code changes are conditional and only allowed if the new compiled-start regression still reveals a real runtime-root mismatch.

### Task 1: Add the red compiled cold-start regression

**Files:**
- Modify: `test/e2e-browser/helpers/test-server.test.ts:1-89`

**Step 1: Write the failing regression test**

Add this spec near the existing `TestServer` tests in [test/e2e-browser/helpers/test-server.test.ts](/home/user/code/freshell/.worktrees/trycycle-issue-174-bootstrap-env-root/test/e2e-browser/helpers/test-server.test.ts):

```ts
  it('bootstraps AUTH_TOKEN into the isolated runtime root for a compiled cold start', async () => {
    server = new TestServer({
      authStrategy: 'bootstrap',
      runtimeRootMode: 'isolated',
    })

    const info = await server.start()

    const envText = await fs.readFile(path.join(info.runtimeRoot, '.env'), 'utf8')
    expect(envText).toMatch(/^AUTH_TOKEN=[a-f0-9]{64}$/m)
    await expect(fs.stat(path.join(info.runtimeRoot, 'dist', '.env'))).rejects.toThrow()

    const res = await fetch(`${info.baseUrl}/api/settings`, {
      headers: { 'x-auth-token': info.token },
    })
    expect(res.status).toBe(200)
  })
```

This is the exact issue path in executable form:
- built server, not source server
- clean temp runtime root, not the repo root
- no inherited `AUTH_TOKEN`
- `.env` must land in the runtime root, not `dist/`
- authenticated API must work with the bootstrapped token

**Step 2: Run the single red test**

Run:

```bash
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts -t "bootstraps AUTH_TOKEN into the isolated runtime root for a compiled cold start"
```

Expected:
- `FAIL`
- Failure reason should be harness-related: missing `runtimeRoot`, no isolated runtime-root mode, or no bootstrap-auth mode.

### Task 2: Extend `TestServer` for isolated compiled startup without changing defaults

**Files:**
- Modify: `test/e2e-browser/helpers/test-server.ts:14-217`
- Modify: `test/e2e-browser/helpers/test-server.test.ts:1-89`

**Step 1: Add the new opt-in types**

In [test/e2e-browser/helpers/test-server.ts](/home/user/code/freshell/.worktrees/trycycle-issue-174-bootstrap-env-root/test/e2e-browser/helpers/test-server.ts), extend the exported types:

```ts
export interface TestServerInfo {
  port: number
  baseUrl: string
  wsUrl: string
  token: string
  configDir: string
  homeDir: string
  logsDir: string
  debugLogPath: string
  pid: number
  runtimeRoot: string
}

export interface TestServerOptions {
  env?: Record<string, string>
  setupHome?: (homeDir: string) => Promise<void>
  preserveHomeOnStop?: boolean
  startTimeoutMs?: number
  verbose?: boolean
  authStrategy?: 'explicit-env' | 'bootstrap'
  runtimeRootMode?: 'project' | 'isolated'
}
```

Keep both new options optional. Default behavior must remain:
- `authStrategy: 'explicit-env'`
- `runtimeRootMode: 'project'`

**Step 2: Add a private helper that stages the isolated runtime root**

In the same file, add:

```ts
async function createIsolatedRuntimeRoot(projectRoot: string): Promise<string> {
  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-runtime-'))
  await fsp.copyFile(path.join(projectRoot, 'package.json'), path.join(runtimeRoot, 'package.json'))
  await fsp.cp(path.join(projectRoot, 'dist'), path.join(runtimeRoot, 'dist'), { recursive: true })
  return runtimeRoot
}
```

Do not use symlinks.

**Step 3: Add a private parser for the bootstrapped token**

Also add:

```ts
function readAuthTokenFromEnvFile(envText: string): string {
  const match = envText.match(/^AUTH_TOKEN=(.+)$/m)
  if (!match) {
    throw new Error('Bootstrapped .env did not contain AUTH_TOKEN')
  }
  return match[1].trim()
}
```

Keep this helper private. The public contract is still `TestServer.start()`.

**Step 4: Track the temp runtime root on the class**

Add a private field:

```ts
  private runtimeRootDir: string | null = null
```

This field exists only to clean up temp runtime roots created by `runtimeRootMode: 'isolated'`.

**Step 5: Choose the runtime root before spawn**

Inside `start()`:
- resolve `projectRoot` exactly as today
- resolve `runtimeRootMode` from options with default `'project'`
- choose `runtimeRoot`
  - `'project'` -> `projectRoot`
  - `'isolated'` -> `await createIsolatedRuntimeRoot(projectRoot)`
- store the temp runtime root in `this.runtimeRootDir` only for isolated mode
- resolve `serverEntry` from `runtimeRoot`

Use this shape:

```ts
const runtimeRootMode = this.options.runtimeRootMode ?? 'project'
const runtimeRoot = runtimeRootMode === 'isolated'
  ? await createIsolatedRuntimeRoot(projectRoot)
  : projectRoot

this.runtimeRootDir = runtimeRootMode === 'isolated' ? runtimeRoot : null

const serverEntry = path.join(runtimeRoot, 'dist', 'server', 'index.js')
```

**Step 6: Spawn from the runtime root and make auth injection optional**

Still inside `start()`:
- resolve `authStrategy` with default `'explicit-env'`
- only pre-seed `AUTH_TOKEN` when using the explicit strategy
- spawn with `cwd: runtimeRoot`

Use this shape:

```ts
const authStrategy = this.options.authStrategy ?? 'explicit-env'
const explicitToken = randomUUID()

const env: Record<string, string> = {
  ...process.env as Record<string, string>,
  PORT: String(port),
  HOME: homeDir,
  NODE_ENV: 'production',
  FRESHELL_LOG_DIR: logsDir,
  HIDE_STARTUP_TOKEN: 'true',
  FRESHELL_BIND_HOST: '127.0.0.1',
  ...this.options.env,
}

if (authStrategy === 'explicit-env') {
  env.AUTH_TOKEN = explicitToken
} else {
  delete env.AUTH_TOKEN
}

this.process = spawn('node', [serverEntry], {
  cwd: runtimeRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
```

**Step 7: Resolve the token after health succeeds**

After `waitForHealth(baseUrl, timeoutMs)`, resolve the returned token from the correct source:

```ts
const token = authStrategy === 'bootstrap'
  ? readAuthTokenFromEnvFile(await fsp.readFile(path.join(runtimeRoot, '.env'), 'utf8'))
  : explicitToken
```

Then include `runtimeRoot` in `this._info`:

```ts
    this._info = {
      port,
      baseUrl,
      wsUrl,
      token,
      configDir: homeDir,
      homeDir,
      logsDir,
      debugLogPath,
      pid,
      runtimeRoot,
    }
```

**Step 8: Clean up isolated runtime roots in `stop()`**

In `stop()`’s `finally` block:
- preserve the existing `configDir` cleanup logic
- additionally remove `this.runtimeRootDir` when it is set
- reset `this.runtimeRootDir` to `null`

Use this shape:

```ts
      if (this.runtimeRootDir) {
        await fsp.rm(this.runtimeRootDir, { recursive: true, force: true }).catch(() => {})
      }
      this.runtimeRootDir = null
```

This must never delete the repo root, because `runtimeRootDir` is only populated for isolated mode.

**Step 9: Add coverage for the new helper surface**

In [test/e2e-browser/helpers/test-server.test.ts](/home/user/code/freshell/.worktrees/trycycle-issue-174-bootstrap-env-root/test/e2e-browser/helpers/test-server.test.ts), make two small additions besides the red regression:

1. Extend the existing `"starts a server on an ephemeral port"` test:

```ts
    expect(info.runtimeRoot).toBeTruthy()
```

2. Add a cleanup test:

```ts
  it('removes isolated runtime roots on stop', async () => {
    server = new TestServer({
      authStrategy: 'bootstrap',
      runtimeRootMode: 'isolated',
    })

    const info = await server.start()
    await expect(fs.stat(info.runtimeRoot)).resolves.toBeDefined()

    await server.stop()
    server = undefined

    await expect(fs.stat(info.runtimeRoot)).rejects.toThrow()
  })
```

This covers the new behavior introduced by Task 2 Step 8, which the previous plan left untested.

**Step 10: Run the helper suite**

Run:

```bash
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
```

Expected:
- `PASS`

**Step 11: Commit the harness work**

```bash
git add test/e2e-browser/helpers/test-server.ts test/e2e-browser/helpers/test-server.test.ts
git commit -m "test(harness): cover compiled first-run bootstrap"
```

### Task 3: Re-verify the product contract and touch product code only if the new regression proves it is still needed

**Files:**
- Test: `test/unit/server/bootstrap.test.ts:483-487`
- Modify only if needed: `server/bootstrap.ts:310-318`

**Step 1: Run the existing bootstrap source contract**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/bootstrap.test.ts -t "returns process.cwd() so .env lands where dotenv looks"
```

Expected:
- `PASS`

**Step 2: Only if Task 2 or Step 1 still exposes a real runtime-root mismatch, apply the minimal product fix**

Allowed change in [server/bootstrap.ts](/home/user/code/freshell/.worktrees/trycycle-issue-174-bootstrap-env-root/server/bootstrap.ts#L313):

```ts
export function resolveProjectRoot(): string {
  return process.cwd()
}

const projectRoot = resolveProjectRoot()
const envPath = path.join(projectRoot, '.env')
```

Rules:
- do not add a new env-loading abstraction
- do not switch to `__dirname` math
- do not broaden this into a general startup refactor

**Step 3: If Step 2 changed product code, rerun the focused proofs**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/bootstrap.test.ts
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
```

Expected:
- `PASS`

**Step 4: If Step 2 changed product code, commit that minimal fix**

```bash
git add server/bootstrap.ts test/unit/server/bootstrap.test.ts
git commit -m "fix(server): keep first-run bootstrap rooted at cwd"
```

### Task 4: Heavy verification

**Files:**
- Modify: none

**Step 1: Re-run the focused compiled-start verification stack**

Run:

```bash
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/bootstrap.test.ts
```

Expected:
- `PASS`

**Step 2: Check the coordinated gate before the broad run**

Run:

```bash
npm run test:status
```

Expected:
- shared coordinator idle, or you wait for it

**Step 3: Run the coordinated full suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="issue 174 compiled first-run bootstrap" npm test
```

Expected:
- `PASS`

**Step 4: Rebuild and rerun the helper suite after the broad run**

Run:

```bash
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
```

Expected:
- `PASS`

This final rerun matters because the issue is specifically about compiled artifacts, not only source-level behavior.

**Step 5: Confirm the worktree is clean**

Run:

```bash
git status --short
```

Expected:
- no output

There is intentionally no extra “final commit” step here. The code-changing tasks already committed the work, and a clean-tree check is the correct final state.
