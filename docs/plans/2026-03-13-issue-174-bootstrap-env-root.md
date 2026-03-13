# Issue 174 First-Run Bootstrap Env Root Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Ensure a clean built Freshell server always bootstraps and loads `.env` from the same runtime root, then lock that behavior with a real compiled-startup regression test so first-run `npm run start` no longer crashes or regresses.

**Architecture:** Keep the runtime root anchored to `process.cwd()` because Freshell already intentionally treats CWD as the runtime root for repo launches and Electron-spawned config directories. Remove the bootstrap/dotenv double-guessing by introducing one small env-path helper used by both the bootstrap writer and a dedicated dotenv loader path, then prove the contract with an isolated compiled-server harness instead of only unit tests.

**Tech Stack:** Node.js, TypeScript, dotenv, Vitest, existing E2E helper harness

---

## Strategy Gate

- `server/bootstrap.ts` on `main` already contains the source-level hotfix from `7233abe6`: it writes `.env` to `process.cwd()`. The open issue exists because the tagged production path lacked that fix, and the current repository still has no compiled-runtime regression test preventing the mismatch from returning.
- The clean end state is not another relative-path tweak. Freshell already relies on CWD as runtime root in several places: `server/index.ts` extension lookup, orchestration skill/plugin paths, and Electron app-bound server startup via `cwd=configDir`. Switching back to file-relative discovery would fix one edge while fighting the rest of the runtime model.
- The actual weakness is duplicated authority:
  - `bootstrap.ts` decides where to write `.env`
  - `server/index.ts` imports `dotenv/config`, which independently decides where to read `.env`
  - `server/get-network-host.ts` calls `dotenv.config()` again
  The plan should converge these onto one helper.
- Heavy coverage is justified here because the failure only appears at the compiled/process boundary. Unit tests alone are too weak.

## Key Decisions

- Keep CWD as the authoritative runtime root, but centralize it in `server/env-path.ts` so write-path and read-path can never drift again.
- Replace `import 'dotenv/config'` with a side-effect module that calls `dotenv.config({ path: resolveEnvPath() })`. This preserves import-time env loading for modules that read `process.env` during evaluation.
- Keep the callable dotenv helper separate from the side-effect module:
  - `server/load-env.ts` exports `loadEnvFile()` with no top-level side effect
  - `server/load-env-on-import.ts` imports `loadEnvFile()` and invokes it immediately
  This keeps `server/get-network-host.ts` explicit while letting `server/index.ts` load env early enough.
- Extend the existing `TestServer` helper instead of inventing a second production-server harness. Add an opt-in isolated runtime root plus bootstrap auth mode, while keeping current defaults unchanged for existing E2E tests.
- Stage the compiled-runtime test in a temporary copied runtime root, not the repo worktree, because the regression creates `.env` as a side effect and the test must remain hermetic on Windows as well as Unix. Use `fs.cp()` rather than symlinks to avoid Windows symlink privilege problems.
- No `docs/index.html` change is needed. This is a startup/runtime correctness fix, not a new UI feature.

### Task 1: Lock the missing contract at the right seams

**Files:**
- Add: `test/unit/server/env-path.test.ts`
- Modify: `test/e2e-browser/helpers/test-server.test.ts`

**Step 1: Write the failing unit test for the shared env path**

Add a new node-environment unit test file that defines the contract before any implementation exists:

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
  config: vi.fn(),
}))

import dotenv from 'dotenv'
import { resolveEnvPath } from '../../../server/env-path.js'
import { loadEnvFile } from '../../../server/load-env.js'

describe('resolveEnvPath', () => {
  it('anchors .env to the runtime cwd', () => {
    expect(resolveEnvPath('/tmp/freshell-runtime')).toBe('/tmp/freshell-runtime/.env')
  })
})

describe('loadEnvFile', () => {
  it('loads dotenv from the shared env path', () => {
    loadEnvFile('/tmp/freshell-runtime')
    expect(dotenv.config).toHaveBeenCalledWith({ path: '/tmp/freshell-runtime/.env' })
  })
})
```

This creates a red test for the new single-source-of-truth contract.

**Step 2: Write the failing compiled-startup regression test**

In `test/e2e-browser/helpers/test-server.test.ts`, add a new helper-level regression spec that exercises the real built server without injecting `AUTH_TOKEN` from the parent process:

```ts
it('bootstraps AUTH_TOKEN into the isolated runtime root instead of dist/', async () => {
  server = new TestServer({
    authStrategy: 'bootstrap',
    runtimeRootMode: 'isolated',
  })

  const info = await server.start()

  const envText = await fs.readFile(path.join(info.runtimeRoot, '.env'), 'utf8')
  expect(envText).toMatch(/^AUTH_TOKEN=.+$/m)
  await expect(fs.stat(path.join(info.runtimeRoot, 'dist', '.env'))).rejects.toThrow()

  const res = await fetch(`${info.baseUrl}/api/settings`, {
    headers: { 'x-auth-token': info.token },
  })
  expect(res.status).toBe(200)
})
```

This is the critical regression: a built server, a clean runtime root, no preset token, and a positive assertion that `dist/.env` is absent.

**Step 3: Run the new tests to verify they fail for the right reason**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/env-path.test.ts
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
```

Expected:
- The unit test fails because `server/env-path.ts` and `server/load-env.ts` do not exist yet.
- The helper test fails because `TestServer` has no bootstrap auth mode or isolated runtime-root support yet.

### Task 2: Make `.env` path resolution authoritative and shared

**Files:**
- Add: `server/env-path.ts`
- Add: `server/load-env.ts`
- Add: `server/load-env-on-import.ts`
- Modify: `server/bootstrap.ts`
- Modify: `server/index.ts`
- Modify: `server/get-network-host.ts`
- Modify: `test/unit/server/bootstrap.test.ts`
- Modify: `test/unit/vite-config.test.ts`
- Modify: `test/unit/server/env-path.test.ts`

**Step 1: Add a tiny shared env-path helper**

Create `server/env-path.ts`:

```ts
import path from 'path'

export function resolveEnvPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, '.env')
}
```

Do not make this helper smarter than the runtime model. It should encode the existing CWD-based contract explicitly, not reintroduce file-layout heuristics.

**Step 2: Add a callable dotenv helper and a side-effect import module**

Create `server/load-env.ts`:

```ts
import dotenv from 'dotenv'
import { resolveEnvPath } from './env-path.js'

export function loadEnvFile(cwd: string = process.cwd()) {
  return dotenv.config({ path: resolveEnvPath(cwd) })
}
```

Create `server/load-env-on-import.ts`:

```ts
import { loadEnvFile } from './load-env.js'

loadEnvFile()
```

The split matters:
- `load-env.ts` is safe for explicit use from `getNetworkHost()`
- `load-env-on-import.ts` exists only so `server/index.ts` can keep import-time env initialization

**Step 3: Rewire bootstrap to the shared env path**

In `server/bootstrap.ts`:
- Import `resolveEnvPath` from `./env-path.js`
- Delete the `resolveProjectRoot()` helper and its auto-run usage
- Keep `ensureEnvFile(envPath)` pure
- Change the auto-run section to:

```ts
const envPath = resolveEnvPath()
const result = ensureEnvFile(envPath)
```

Do not change `ensureEnvFile()` semantics in this issue. The fix is path authority, not env-content policy.

**Step 4: Rewire server startup without breaking import order**

In `server/index.ts`, replace the current first two imports with:

```ts
import './bootstrap.js'
import './load-env-on-import.js'
```

Do not move env loading into `main()`. Several imported modules already read `process.env` at module evaluation time; the whole point is to keep env available before they execute.

**Step 5: Reuse the same loader in `get-network-host`**

In `server/get-network-host.ts`:
- Remove the direct `dotenv` import
- Import `loadEnvFile` from `./load-env.js`
- Replace `dotenv.config()` inside `getNetworkHost()` with `loadEnvFile()`

This closes the last remaining duplicate dotenv path decision in the server runtime.

**Step 6: Update unit tests to match the new source of truth**

In `test/unit/server/bootstrap.test.ts`:
- Remove the old `resolveProjectRoot()` describe block
- Keep the `ensureEnvFile()` coverage unchanged; it still owns content generation and patching

In `test/unit/vite-config.test.ts`:
- Mock `../../server/load-env.js` instead of raw dotenv so the test stays hermetic after the refactor
- Add one assertion that `getNetworkHost()` calls the shared loader before reading config:

```ts
expect(loadEnvFile).toHaveBeenCalled()
```

In `test/unit/server/env-path.test.ts`:
- Finalize the loader contract from Task 1 against the real implementation

**Step 7: Run the focused unit suite**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/env-path.test.ts test/unit/server/bootstrap.test.ts
npm run test:vitest -- test/unit/vite-config.test.ts
```

Expected:
- PASS

**Step 8: Commit the env-path refactor checkpoint**

```bash
git add server/env-path.ts server/load-env.ts server/load-env-on-import.ts server/bootstrap.ts server/index.ts server/get-network-host.ts test/unit/server/env-path.test.ts test/unit/server/bootstrap.test.ts test/unit/vite-config.test.ts
git commit -m "refactor(server): centralize runtime env path loading"
```

### Task 3: Extend the production test harness to cover first-run compiled startup

**Files:**
- Modify: `test/e2e-browser/helpers/test-server.ts`
- Modify: `test/e2e-browser/helpers/test-server.test.ts`

**Step 1: Add opt-in bootstrap and isolated-runtime modes to `TestServer`**

Extend the helper types:

```ts
export interface TestServerOptions {
  authStrategy?: 'explicit-env' | 'bootstrap'
  runtimeRootMode?: 'project' | 'isolated'
  ...
}

export interface TestServerInfo {
  ...
  runtimeRoot: string
}
```

Keep defaults exactly as they are today:
- `authStrategy: 'explicit-env'`
- `runtimeRootMode: 'project'`

That preserves all existing E2E callers.

**Step 2: Implement isolated runtime-root staging with real compiled output**

In `test/e2e-browser/helpers/test-server.ts`:
- Add a `createRuntimeRoot()` helper that, when `runtimeRootMode === 'isolated'`, creates a temp directory and copies:
  - `package.json`
  - `dist/`
- If an `extensions/` directory is needed for startup fidelity, create it explicitly or copy it only when required. Do not use symlinks; Windows reproducibility matters for this issue.
- Spawn `node dist/server/index.js` with `cwd` set to `runtimeRoot`, not the repo root, when isolated mode is selected
- Include `runtimeRoot` in `TestServerInfo`

The purpose is to simulate a fresh built checkout without letting the test create `.env` inside the repo worktree.

**Step 3: Implement bootstrap-auth startup in the helper**

When `authStrategy === 'bootstrap'`:
- Do not inject `AUTH_TOKEN` into the child environment
- After health succeeds, parse `${runtimeRoot}/.env` and extract the generated token
- Populate `info.token` from that file so callers can authenticate normally
- Leave the existing explicit-env path unchanged for the rest of the suite

A small internal parser is enough here:

```ts
function readAuthTokenFromEnv(envText: string): string {
  const match = envText.match(/^AUTH_TOKEN=(.+)$/m)
  if (!match) throw new Error('Bootstrapped .env did not contain AUTH_TOKEN')
  return match[1].trim()
}
```

**Step 4: Make the helper test red-to-green on the real compiled flow**

Keep the new regression spec from Task 1 and add one more explicit token assertion:

```ts
expect(info.token).toMatch(/^[a-f0-9]{64}$/)
```

Then run:

```bash
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
```

Expected:
- PASS

**Step 5: Commit the compiled-startup regression coverage**

```bash
git add test/e2e-browser/helpers/test-server.ts test/e2e-browser/helpers/test-server.test.ts
git commit -m "test(server): cover first-run compiled bootstrap startup"
```

### Task 4: Refactor lightly, then run heavy verification

**Files:**
- Modify only files already touched for this issue

**Step 1: Keep the runtime-root story single-purpose**

Do a small refactor pass only if needed so:
- `resolveEnvPath()` remains the only place that turns a runtime root into a `.env` path
- `loadEnvFile()` remains the only place that tells dotenv where to read
- `TestServer` contains the new isolated-runtime logic behind opt-in options rather than duplicating spawn code paths

Do not broaden this into a general runtime-root cleanup. `process.cwd()` remains the current steady-state design for the rest of the server.

**Step 2: Re-run the narrow suites after the refactor**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/env-path.test.ts test/unit/server/bootstrap.test.ts
npm run test:vitest -- test/unit/vite-config.test.ts
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
```

Expected:
- PASS

**Step 3: Run the coordinated broad suite and final compiled-runtime check**

First inspect the coordinator:

```bash
npm run test:status
```

Expected:
- The shared coordinator is idle, or you wait until it is available

Then run the broad repo suite:

```bash
FRESHELL_TEST_SUMMARY="issue 174 bootstrap env root" npm test
```

Expected:
- PASS

Finally rerun the helper suite against fresh build output:

```bash
npm run build
npm run test:e2e:helpers -- helpers/test-server.test.ts
```

Expected:
- PASS

This is the heavy verification for this issue:
- unit contract for env-path authority
- source/runtime integration through `getNetworkHost()`
- real compiled server cold-start in an isolated runtime root
- full coordinated repo suite

### Task 5: Commit the issue fix

**Files:**
- Stage the issue-specific code, tests, and this plan only

**Step 1: Commit**

```bash
git add docs/plans/2026-03-13-issue-174-bootstrap-env-root.md \
  server/env-path.ts \
  server/load-env.ts \
  server/load-env-on-import.ts \
  server/bootstrap.ts \
  server/index.ts \
  server/get-network-host.ts \
  test/unit/server/env-path.test.ts \
  test/unit/server/bootstrap.test.ts \
  test/unit/vite-config.test.ts \
  test/e2e-browser/helpers/test-server.ts \
  test/e2e-browser/helpers/test-server.test.ts
git commit -m "fix(server): harden first-run env bootstrap"
```

Expected:
- One commit containing the shared env-path refactor, the compiled-startup regression coverage, and the plan for issue `#174`
