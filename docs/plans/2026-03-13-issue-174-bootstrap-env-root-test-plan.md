# Issue 174 Bootstrap Env Root Test Plan

Date: 2026-03-13
Implementation plan: `/home/user/code/freshell/.worktrees/trycycle-issue-174-bootstrap-env-root/docs/plans/2026-03-13-issue-174-bootstrap-env-root.md`
Worktree: `/home/user/code/freshell/.worktrees/trycycle-issue-174-bootstrap-env-root`

## Strategy reconciliation

No approval-required changes are needed. The approved heavy strategy still fits the implementation plan and the current codebase.

Two non-scope-changing adjustments are required to make that strategy concrete:

1. The strongest practical differential reference is not cross-branch parity. The functional `process.cwd()` fix already exists on both `main` and this worktree. The useful differential seam is the existing compiled `TestServer` startup path (`runtimeRootMode: 'project'`, `authStrategy: 'explicit-env'`) versus the new isolated compiled startup path (`runtimeRootMode: 'isolated'`, `authStrategy: 'bootstrap'`).
2. Because issue 174 is a startup-path regression, the heavy plan should include one low-cost performance guard. That guard should only catch catastrophic hangs, so it will use the existing helper startup budget rather than introducing a benchmark harness.

No new external services, paid APIs, or platform-specific infrastructure are required. The existing helper-test, server-unit, and coordinated-suite harnesses are sufficient.

## Sources of truth

- `ST-1 Issue 174 intent`: The implementation plan's strategy gate defines the target journey as `fresh clone -> npm install -> npm run build -> npm run start`, and says the regression was bootstrap writing `.env` to `dist/.env` while `dotenv/config` loaded from `process.cwd()`. The expected behavior is that first compiled startup writes `.env` into the runtime root, loads that token on first run, and serves authenticated requests successfully.
- `ST-2 Bootstrap contract`: `server/bootstrap.ts` imports before `dotenv/config`, `resolveProjectRoot()` returns `process.cwd()`, and the bootstrap path is `path.join(projectRoot, '.env')`.
- `ST-3 Startup and auth contract`: `server/index.ts` mounts `/api/health` before `httpAuthMiddleware`, mounts `/api/settings` after `httpAuthMiddleware`, and `server/auth.ts` refuses startup without `AUTH_TOKEN`.
- `ST-4 Existing built-server harness contract`: `test/e2e-browser/helpers/test-server.ts` and `docs/plans/2026-03-08-e2e-browser-testing-test-plan.md` define `TestServer` as the canonical production-start helper used by browser and perf tests. Existing callers depend on the default project-root startup path staying unchanged.
- `ST-5 Helper/test-runner constraints`: `test/e2e-browser/vitest.config.ts` gives helper tests a 60s test timeout; `TestServerOptions.startTimeoutMs` defaults to 30_000ms; `package.json` routes helper coverage through `npm run test:e2e:helpers`.
- `ST-6 Isolated runtime-root staging rules`: `.gitignore` ignores `.worktrees/`; the implementation plan requires isolated runtime roots under the worktree, not `os.tmpdir()`; `server/extension-manager.ts` explicitly skips missing extension directories, so a copied runtime root does not need `extensions/` for `/api/health` and `/api/settings`.
- `ST-7 Planned harness contract`: The issue 174 implementation plan extends `TestServer` with opt-in `authStrategy`, `runtimeRootMode`, `runtimeRoot`, and staged-runtime-root cleanup on `stop()`.
- `ST-8 Approved heavy strategy`: The user approved heavy coverage, and the strategy requires a generous performance guard for startup-path work rather than skipping performance checks entirely.

## Harness requirements

### 1. Extended `TestServer` isolated compiled-start harness

- What it does: Stages a clean runtime root under `<worktree>/.worktrees/test-server-runtime-*`, copies `package.json` and `dist/`, optionally starts without an inherited `AUTH_TOKEN`, reads the bootstrapped token from `<runtimeRoot>/.env`, and removes the staged runtime root on `stop()`.
- What it exposes:
  - `TestServerOptions.authStrategy?: 'explicit-env' | 'bootstrap'`
  - `TestServerOptions.runtimeRootMode?: 'project' | 'isolated'`
  - `TestServerInfo.runtimeRoot: string`
  - existing `start()`, `stop()`, and `info`
- Estimated complexity to build: Medium. This is an opt-in extension of the existing helper, not a new harness family.
- Tests depending on it: Tests 1 through 6.

No second harness is required. The existing server-unit harness already covers the source contract in `bootstrap.test.ts`, and the coordinated full suite remains the final verification step after targeted red/green runs.

## Test plan

1. **Name:** Clean compiled first run bootstraps `AUTH_TOKEN` in the isolated runtime root and serves the first authenticated settings request
   - **Type:** scenario
   - **Harness:** Extended `TestServer` helper suite via `npm run test:e2e:helpers -- helpers/test-server.test.ts`
   - **Preconditions:** `npm run build` has produced `dist/server/index.js`; the staged runtime root starts empty except for copied `package.json` and `dist/`; no `AUTH_TOKEN` is inherited into the child process; no `extensions/` directory is copied into the staged runtime root.
   - **Actions:**
     1. Start `new TestServer({ authStrategy: 'bootstrap', runtimeRootMode: 'isolated' })`.
     2. Read `<info.runtimeRoot>/.env`.
     3. Request `GET /api/health` without auth.
     4. Request `GET /api/settings` with `x-auth-token: info.token`.
   - **Expected outcome:**
     - `info.runtimeRoot` is a temp directory under `<worktree>/.worktrees/`. (`ST-4`, `ST-6`)
     - `<info.runtimeRoot>/.env` exists and contains `AUTH_TOKEN=<64 hex chars>`. (`ST-1`, `ST-2`)
     - `<info.runtimeRoot>/dist/.env` does not exist. (`ST-1`, `ST-2`)
     - `GET /api/health` returns `200` with `body.ok === true`. (`ST-3`)
     - `GET /api/settings` returns `200` when the header uses the bootstrapped token surfaced by `info.token`. (`ST-1`, `ST-3`, `ST-4`)
   - **Interactions:** Child-process startup from copied `dist/`; bootstrap-before-dotenv ordering; `validateStartupSecurity()`; `httpAuthMiddleware`; missing-extension-directory scan.

2. **Name:** Stopping an isolated compiled server removes only its staged runtime root and preserves existing HOME cleanup semantics
   - **Type:** integration
   - **Harness:** Extended `TestServer` helper suite
   - **Preconditions:** Built server is available; test starts one server with `runtimeRootMode: 'isolated'`, `authStrategy: 'bootstrap'`, and `preserveHomeOnStop: true`.
   - **Actions:**
     1. Start the server and record `info.runtimeRoot` and `info.homeDir`.
     2. Confirm both paths exist before shutdown.
     3. Stop the server.
     4. Check the staged runtime root, preserved HOME, and worktree root after shutdown.
   - **Expected outcome:**
     - `<info.runtimeRoot>` no longer exists after `stop()`. (`ST-4`, `ST-7`)
     - `<info.homeDir>` still exists because `preserveHomeOnStop: true` remains authoritative. (`ST-4`)
     - The worktree root still exists, for example `package.json` at the worktree root remains present. The cleanup path may delete only the staged runtime root, never the project root. (`ST-4`, `ST-6`)
   - **Interactions:** `TestServer.stop()` cleanup ordering; filesystem deletion boundaries; existing preserve-home audit behavior.

3. **Name:** Default project-root startup remains unchanged for existing browser and perf callers
   - **Type:** integration
   - **Harness:** Extended `TestServer` helper suite
   - **Preconditions:** Built server is available; the test starts `new TestServer()` with no new options.
   - **Actions:**
     1. Start the default server.
     2. Derive the worktree root from the helper test file path.
     3. Request `GET /api/settings` with `x-auth-token: info.token`.
   - **Expected outcome:**
     - `info.runtimeRoot` equals the worktree root, not a staged temp directory. (`ST-4`)
     - `info.token` is still the explicit token that the default helper path returns to callers. (`ST-4`)
     - The authenticated `GET /api/settings` call still returns `200`. (`ST-3`, `ST-4`)
   - **Interactions:** Existing Playwright fixture contract; perf audit helper contract; spawn `cwd` for the default path; explicit-env auth injection.

4. **Name:** Missing `extensions/` in the isolated runtime root does not block health or authenticated settings
   - **Type:** integration
   - **Harness:** Extended `TestServer` helper suite
   - **Preconditions:** Built server is available; isolated runtime-root staging copies only `package.json` and `dist/`; `<runtimeRoot>/extensions` and `<runtimeRoot>/.freshell/extensions` are absent.
   - **Actions:**
     1. Start `new TestServer({ authStrategy: 'bootstrap', runtimeRootMode: 'isolated' })`.
     2. Assert the staged runtime root does not contain copied extension directories.
     3. Request `GET /api/health`.
     4. Request `GET /api/settings` with `x-auth-token: info.token`.
   - **Expected outcome:**
     - The staged runtime root starts without copied extension directories. (`ST-6`)
     - `GET /api/health` still returns `200`.
     - Authenticated `GET /api/settings` still returns `200`. The server must tolerate missing extension directories at startup rather than failing before the first authenticated request. (`ST-3`, `ST-6`)
   - **Interactions:** `ExtensionManager.scan()` against missing directories; startup readiness; authenticated REST path after extension discovery.

5. **Name:** Default compiled startup and isolated compiled startup expose the same external HTTP auth contract
   - **Type:** differential
   - **Harness:** Extended `TestServer` helper suite
   - **Preconditions:** Built server is available; one server uses the default path (`new TestServer()`), and one uses the isolated bootstrap path (`new TestServer({ authStrategy: 'bootstrap', runtimeRootMode: 'isolated' })`).
   - **Actions:**
     1. Start both servers.
     2. On each server, request `GET /api/health` without auth.
     3. On each server, request `GET /api/settings` without auth.
     4. On each server, request `GET /api/settings` with that server's `info.token`.
   - **Expected outcome:**
     - Both health requests return `200` with `body.ok === true`. (`ST-3`)
     - Both unauthenticated settings requests return `401`. (`ST-3`)
     - Both authenticated settings requests return `200`. (`ST-3`, `ST-4`)
     - The only permitted difference between the two runs is the token source and runtime-root location; the public HTTP contract must be identical. (`ST-1`, `ST-4`)
   - **Interactions:** Existing project-root auth strategy versus new isolated bootstrap strategy; auth middleware; health bypass; helper token discovery.

6. **Name:** Isolated compiled cold start reaches health within the existing helper startup budget
   - **Type:** boundary
   - **Harness:** Extended `TestServer` helper suite with elapsed-time measurement
   - **Preconditions:** Built server is available; the server starts in isolated bootstrap mode; the helper uses the default `startTimeoutMs` budget or an explicit `30_000ms` budget.
   - **Actions:**
     1. Record a monotonic start time.
     2. Call `await server.start()`.
     3. Measure elapsed time once the helper resolves.
   - **Expected outcome:**
     - Startup completes and the helper resolves before the 30_000ms startup budget expires. (`ST-4`, `ST-5`)
     - This is a catastrophic-regression guard only. Any timeout indicates a severe startup/pathing error in the compiled first-run flow, not a micro-performance regression. (`ST-1`, `ST-8`)
   - **Interactions:** Bootstrap file I/O; copied `dist/` process startup; health polling loop; startup validation before readiness.

7. **Name:** `resolveProjectRoot()` remains pinned to `process.cwd()` so bootstrap and `dotenv/config` agree on `.env` location
   - **Type:** unit
   - **Harness:** Server Vitest suite via `npm run test:vitest -- --config vitest.server.config.ts test/unit/server/bootstrap.test.ts`
   - **Preconditions:** None beyond the existing bootstrap unit-test environment.
   - **Actions:**
     1. Call `resolveProjectRoot()` from `server/bootstrap.ts`.
   - **Expected outcome:**
     - The function returns `process.cwd()`. This is the source-level invariant that justifies the isolated compiled cold-start scenario writing `.env` into the runtime root instead of `dist/`. (`ST-2`)
   - **Interactions:** Bootstrap source contract only.

## Coverage summary

- Covered action space:
  - Compiled first run from a clean runtime root under the worktree
  - `.env` placement in the runtime root rather than `dist/`
  - Bootstrapped token discovery and first authenticated `/api/settings` success
  - Default `TestServer` compatibility for existing Playwright and perf callers
  - Startup tolerance when extension directories are intentionally absent from the staged runtime root
  - Cleanup semantics for staged runtime roots versus preserved HOME directories
  - Catastrophic startup-time regression guard using the existing helper budget
  - Source-level invariant that keeps bootstrap and `dotenv/config` aligned

- Explicitly excluded by this plan:
  - Cross-branch differential testing against `main`. The functional fix already exists on both `main` and this worktree, so cross-branch parity would be redundant and lower-signal than project-root versus isolated-runtime-root comparison.
  - Manual Windows-native verification of `npm run start` outside the helper harness. The implementation plan intentionally models the same runtime-root failure boundary inside the worktree so dependencies still resolve from ancestor `node_modules`.
  - Warm-start behavior with an already-valid runtime-root `.env` across a second compiled restart in the same staged directory. Existing `ensureEnvFile()` unit coverage already protects the source-level "skip when valid token exists" rule, and the new helper intentionally deletes staged runtime roots on stop.
  - Full-suite execution as an individual numbered test case. The coordinated `npm test` run remains required final verification, but it is a suite-level confirmation step rather than a TDD-first behavior spec.

- Risks carried by those exclusions:
  - A platform-specific process-spawn quirk that only reproduces on native Windows could escape helper-only coverage. The staged-runtime-root approach minimizes that risk by avoiding symlinks and preserving ancestor `node_modules` lookup, but it does not replace native manual confirmation.
  - Reuse-of-existing-`.env` behavior at the compiled artifact layer is only indirectly covered here. If the source-level bootstrap skip logic and compiled startup ever diverge on warm starts, the existing unit test would catch the source contract but not a harness-level cleanup bug that deletes the staged runtime root too early.
