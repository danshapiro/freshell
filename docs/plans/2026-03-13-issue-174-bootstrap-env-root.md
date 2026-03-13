# Issue 174 First-Run Bootstrap Env Root Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Prove that a clean compiled Freshell startup bootstraps `.env` in the runtime root and starts successfully, so issue `#174` cannot regress.

**Architecture:** The product code already uses the correct runtime-root rule: `server/bootstrap.ts` resolves the env location from `process.cwd()`, matching `dotenv/config`. Do not broaden this into a loader refactor unless a red compiled-start regression proves another mismatch. The work is to extend the existing `TestServer` helper so it can run `dist/server/index.js` from an isolated temp runtime root without a preseeded `AUTH_TOKEN`, then add regression tests that exercise the exact first-run failure from the issue.

**Tech Stack:** Node.js, TypeScript, Vitest, built `dist/server` startup, helper harness in `test/e2e-browser/helpers`

---

## Strategy Gate

- Issue `#174` is a compiled-runtime bug, not a source-only bug. The failing path is: fresh build -> `npm run start` -> bootstrap writes `.env` to `dist/` -> `dotenv/config` loads from CWD -> `AUTH_TOKEN` stays unset -> startup throws.
- On this branch, `server/bootstrap.ts` already contains the direct fix from the issue’s preferred Option A: `resolveProjectRoot()` returns `process.cwd()`, and autorun writes `path.join(resolveProjectRoot(), '.env')`.
- Because the product code is already aligned, the right problem is no longer “change bootstrap path logic again”. The real gap is the absence of a regression test at the exact boundary where the bug happened: a compiled cold start from a clean runtime root.
- Heavy coverage for this issue means:
  - keep the existing unit assertion that `resolveProjectRoot()` returns `process.cwd()`
  - add helper coverage for isolated runtime-root / bootstrap-auth startup
  - add a real compiled cold-start regression test
  - run the coordinated full suite plus the compiled helper suite after a fresh build
- No `docs/index.html` change is needed. This is a startup regression fix, not a new UI feature.

## Key Decisions

- Runtime root remains `process.cwd()`. That is the issue’s recommended fix and it already matches `dotenv/config`.
- The only planned code surface is `test/e2e-browser/helpers/test-server.ts`, behind opt-in options, so existing Playwright/browser helper callers keep their current behavior.
- The isolated runtime root must be a copied temp directory containing `package.json` and `dist/`. Do not use symlinks; the issue was reported on native Windows and the regression harness must behave the same there.
- Do not add a new product-side env helper unless the compiled startup regression still fails after the harness work. If that happens, fix only the concrete mismatch the regression exposes.

### Task 1: Add the failing compiled-start regression

**Files:**
- Modify: `test/e2e-browser/helpers/test-server.test.ts`

**Step 1: Write the red regression test**

Add this spec near the existing `TestServer` tests:

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

This is the entire issue in one test: no parent `AUTH_TOKEN`, real built server, runtime root temp directory, `.env` must appear in the runtime root, and authenticated startup must succeed.

**Step 2: Run the red test**

Run:

```bash
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts -t "bootstraps AUTH_TOKEN into the isolated runtime root for a compiled cold start"
```

Expected:
- `FAIL`
- The failure should show that `TestServer` does not yet support the isolated runtime root / bootstrap-auth flow, or that `runtimeRoot` is missing / `.env` is not created in the expected place.

### Task 2: Teach `TestServer` the exact startup mode the issue needs

**Files:**
- Modify: `test/e2e-browser/helpers/test-server.ts`
- Modify: `test/e2e-browser/helpers/test-server.test.ts`

**Step 1: Extend the helper types without changing defaults**

In `test/e2e-browser/helpers/test-server.ts`, extend the public types:

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

Defaults must stay:
- `authStrategy: 'explicit-env'`
- `runtimeRootMode: 'project'`

That keeps every existing caller behaving exactly as it does now.

**Step 2: Add a helper that stages an isolated runtime root**

Add a private helper that copies only the runtime artifacts required for `node dist/server/index.js`:

```ts
async function createIsolatedRuntimeRoot(projectRoot: string): Promise<string> {
  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-runtime-'))
  await fsp.copyFile(path.join(projectRoot, 'package.json'), path.join(runtimeRoot, 'package.json'))
  await fsp.cp(path.join(projectRoot, 'dist'), path.join(runtimeRoot, 'dist'), { recursive: true })
  return runtimeRoot
}
```

Do not use symlinks. The regression needs Windows-safe behavior.

**Step 3: Add a helper that reads the bootstrapped token back out of `.env`**

Add a small internal parser in the same file:

```ts
function readAuthTokenFromEnvFile(envText: string): string {
  const match = envText.match(/^AUTH_TOKEN=(.+)$/m)
  if (!match) {
    throw new Error('Bootstrapped .env did not contain AUTH_TOKEN')
  }
  return match[1].trim()
}
```

Keep this private. The public regression test should cover it through `TestServer.start()`.

**Step 4: Stage the runtime root before spawning the process**

Inside `start()`:
- resolve `projectRoot` exactly as today
- choose `runtimeRoot`
  - project mode -> `projectRoot`
  - isolated mode -> `await createIsolatedRuntimeRoot(projectRoot)`
- resolve `serverEntry` from `runtimeRoot`, not `projectRoot`
- spawn the child with `cwd: runtimeRoot`

The built server must believe the temp runtime root is its real working directory. That is how the original bug is reproduced honestly.

**Step 5: Make auth injection optional**

Inside `start()`:
- keep generating the explicit token up front for the default path
- when `authStrategy === 'explicit-env'`, continue setting `AUTH_TOKEN` in the child env exactly as today
- when `authStrategy === 'bootstrap'`, delete `AUTH_TOKEN` from the child env before `spawn()`

Use this shape:

```ts
const authStrategy = this.options.authStrategy ?? 'explicit-env'
const token = authStrategy === 'explicit-env' ? randomUUID() : ''
...
if (authStrategy === 'explicit-env') {
  env.AUTH_TOKEN = token
} else {
  delete env.AUTH_TOKEN
}
```

Do not change any other env defaults.

**Step 6: Read the generated token after health succeeds**

After `waitForHealth(baseUrl, timeoutMs)`:
- if `authStrategy === 'bootstrap'`, read `${runtimeRoot}/.env`
- parse the generated token with `readAuthTokenFromEnvFile`
- return that token in `TestServerInfo`

Use this exact flow:

```ts
const resolvedToken = authStrategy === 'bootstrap'
  ? readAuthTokenFromEnvFile(await fsp.readFile(path.join(runtimeRoot, '.env'), 'utf8'))
  : token
```

Set `runtimeRoot` on `this._info`.

**Step 7: Clean up isolated runtime roots on stop**

Add a private field for the temp-managed runtime root.
When `runtimeRootMode === 'isolated'`, remove that temp directory in `stop()` after the process exits.
Do not delete the repo root when `runtimeRootMode === 'project'`.

**Step 8: Add one green-path assertion for the new info surface**

In `test/e2e-browser/helpers/test-server.test.ts`, update the existing `"starts a server on an ephemeral port"` test to assert:

```ts
    expect(info.runtimeRoot).toBeTruthy()
```

Do not add more default-path churn than this. The cold-start regression is the real coverage.

**Step 9: Run the helper suite**

Run:

```bash
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
```

Expected:
- `PASS`

**Step 10: Commit the helper changes**

```bash
git add test/e2e-browser/helpers/test-server.ts test/e2e-browser/helpers/test-server.test.ts
git commit -m "test(harness): support isolated compiled startup"
```

### Task 3: Verify the existing product fix still matches the source contract

**Files:**
- Modify: none expected
- Test: `test/unit/server/bootstrap.test.ts`

**Step 1: Run the existing bootstrap unit contract**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/bootstrap.test.ts -t "returns process.cwd() so .env lands where dotenv looks"
```

Expected:
- `PASS`

This confirms the source-level rule that actually fixes the issue remains in place.

**Step 2: Only if this test or the compiled helper regression still fails, apply the minimum product fix**

Allowed file:
- Modify: `server/bootstrap.ts`

Allowed change:
- keep `resolveProjectRoot()` returning `process.cwd()`
- keep the autorun path as `path.join(resolveProjectRoot(), '.env')`

Do not introduce a wider env-loading refactor here. The issue is about runtime-root agreement, not about abstracting dotenv.

**Step 3: If Step 2 was needed, run the focused tests again**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/bootstrap.test.ts
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
```

Expected:
- `PASS`

**Step 4: Commit only if product code changed**

```bash
git add server/bootstrap.ts test/unit/server/bootstrap.test.ts
git commit -m "fix(server): keep first-run bootstrap rooted at cwd"
```

### Task 4: Heavy verification and final issue close-out

**Files:**
- Modify only files already touched for this issue

**Step 1: Run the focused verification stack in the same order users hit the bug**

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
- The shared coordinator is idle, or you wait until it becomes available.

**Step 3: Run the coordinated full suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="issue 174 compiled first-run bootstrap" npm test
```

Expected:
- `PASS`

**Step 4: Re-run the compiled-start helper suite after the broad run**

Run:

```bash
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
```

Expected:
- `PASS`

This rerun matters because the issue is about the built artifact, not just source tests.

**Step 5: Commit the issue closure**

If only harness/tests changed:

```bash
git add test/e2e-browser/helpers/test-server.ts test/e2e-browser/helpers/test-server.test.ts
git commit -m "test(server): lock first-run bootstrap runtime root"
```

If `server/bootstrap.ts` also changed:

```bash
git add server/bootstrap.ts test/unit/server/bootstrap.test.ts test/e2e-browser/helpers/test-server.ts test/e2e-browser/helpers/test-server.test.ts
git commit -m "fix(server): lock first-run bootstrap runtime root"
```

Expected:
- One final issue commit containing the code that actually changed for `#174`.
