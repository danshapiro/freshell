# Fold Port Contract Drift Guard Into Local Suite Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
The local default `npm test` suite runs the WS port contract drift-guard vitest
suite (`config/vitest/vitest.port.config.ts`) so the cross-language WS protocol
drift signal is covered on every local test run, replacing reliance on the
separate `port-contract` CI workflow for that signal.

### Explicit constraints
- Implement using the-usual workflow.
- Do NOT disable or modify any CI workflow (`.github/workflows/port-contract.yml`
  stays as-is); this change only adds local coverage.
- Fold only the `test:port` vitest suite. The `test:port` freeze test
  (`test/unit/port/ws-contract-freeze.test.ts`) already regenerates the contract
  artifacts in-memory and asserts byte-equality with the committed files, so it
  fully subsumes the `contract:generate` idempotency check — no separate
  codegen step is needed.
- Do NOT fold the Rust crate checks (`cargo test -p freshell-protocol` /
  `cargo test -p freshell-terminal`); those stay a separate manual step.
- Pause and evaluate if scope creeps up significantly.

### Accepted tradeoffs and residuals
- The Rust crate checks (#3) remain a separate manual `cargo test` step; the
  user already runs `cargo test` when touching Rust.
- `port-contract.yml` continues to run all three checks in CI; this change
  only adds local coverage, it does not remove CI.
- Narrow targeting via the test coordinator (`npm test test/unit/port/foo`)
  still routes to the default config (which excludes port tests) — that is a
  pre-existing coordinator routing gap, not widened by this change. The
  `test:balanced` narrow path (`npm run test:balanced -- test/unit/port/foo`)
  IS fixed here by extending `classifySuitePath`, but only on the local
  (non-cloud) path: when `FRESHELL_VITEST_BACKEND=cloud` is set, the cloud
  branch executes before `createStandardTestPlan` and dispatches client+server
  to Cloud Run regardless of narrow targets — that cloud-dispatch narrow
  targeting limitation is pre-existing and out of scope.

**Goal:** Make every local `npm test` run include the WS port contract drift
guard so wire-protocol drift between the React/TS frontend and the Rust server
is caught locally before a PR, without relying on CI.

**Architecture:** Add a `port` suite to `scripts/run-standard-tests.ts`'s
standard test plan (both desktop and aggressive modes) running the existing
`config/vitest/vitest.port.config.ts`. Extend `classifySuitePath` so
`test/unit/port/**` targets route to the port suite under the port config
(they currently misroute to the client/default config, which excludes them).
Add the port suite to the cloud-backend path's local section (alongside
electron) so `npm test` with `FRESHELL_VITEST_BACKEND=cloud` also runs it.

**Tech Stack:** TypeScript, Vitest, tsx, the local test standard-runner
(`scripts/run-standard-tests.ts`).

## Global Constraints

- Server/runner scripts use NodeNext/ESM; relative imports must include `.js`
  extensions (the test imports `../../../scripts/run-standard-tests.js`).
- Red-Green-Refactor TDD: write the failing test first, confirm it fails for
  the right reason, implement, confirm green, then refactor.
- No CI workflow files are modified.
- The default vitest config (`config/vitest/vitest.config.ts`) explicitly
  excludes `test/unit/port/**` (line 40) — port tests must run under
  `config/vitest/vitest.port.config.ts` (node environment, no jsdom).

---

### Task 1: Add `port` suite to the standard test plan and port-target routing

**Files:**
- Modify: `scripts/run-standard-tests.ts` (add `port` SuiteName, port config
  constant, port run in both plan modes + cloud path, `port` classification in
  `classifySuitePath`, `port` in `detectRequestedSuites` filter list)
- Test: `test/unit/server/run-standard-tests.test.ts` (update existing plan
  assertions to include the port suite; add a port-routing test)

**Interfaces:**
- Consumes: existing `config/vitest/vitest.port.config.ts` (unchanged); the
  `SuiteName`, `StandardTestRun`, `classifySuitePath`, `detectRequestedSuites`,
  and `createStandardTestPlan` surface in `run-standard-tests.ts`.
- Produces: an extended `SuiteName` (`'client' | 'server' | 'electron' | 'port'`)
  and a standard plan that includes a
  `{ name: 'port', configPath: 'config/vitest/vitest.port.config.ts', ... }`
  run in both modes and the cloud-backend local section.

- [ ] **Step 1: Write the failing behavioral tests**

Update `test/unit/server/run-standard-tests.test.ts`. The two existing
`createStandardTestPlan` tests (desktop + aggressive) assert exact plan
structures that no longer hold once `port` is added, so they become the red
signal alongside a new routing test.

Replace the desktop plan test's expected value to include the port run in the
initial stage:

```typescript
    it('uses the desktop-balanced two-stage plan outside CI', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: [],
      })).toEqual({
        mode: 'desktop',
        stages: [
          [
            { name: 'client', configPath: 'config/vitest/vitest.config.ts', maxWorkers: '5', priority: 'background' },
            { name: 'server', configPath: 'config/vitest/vitest.server.config.ts', maxWorkers: '3', priority: 'background' },
            { name: 'port', configPath: 'config/vitest/vitest.port.config.ts', priority: 'background' },
          ],
          [
            { name: 'electron', configPath: 'config/vitest/vitest.electron.config.ts', priority: 'background' },
          ],
        ],
      })
    })
```

Replace the aggressive plan test's expected value to include the port run in
the single stage:

```typescript
    it('switches to the aggressive plan in CI by default', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: true,
        forwardedArgs: [],
      })).toEqual({
        mode: 'aggressive',
        stages: [
          [
            { name: 'client', configPath: 'config/vitest/vitest.config.ts', maxWorkers: '50%', priority: 'normal' },
            { name: 'server', configPath: 'config/vitest/vitest.server.config.ts', maxWorkers: '50%', priority: 'normal' },
            { name: 'electron', configPath: 'config/vitest/vitest.electron.config.ts', priority: 'normal' },
            { name: 'port', configPath: 'config/vitest/vitest.port.config.ts', priority: 'normal' },
          ],
        ],
      })
    })
```

Add a new test asserting port-targeted args route to the port suite only:

```typescript
    it('routes port contract paths to the port suite only', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: ['test/unit/port/ws-contract-freeze.test.ts'],
      })).toEqual({
        mode: 'desktop',
        stages: [
          [
            { name: 'port', configPath: 'config/vitest/vitest.port.config.ts', priority: 'background' },
          ],
        ],
      })
    })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/run-standard-tests.test.ts --run`

Expected: FAIL — the two existing plan tests fail because the actual plan has
no `port` run, and the new routing test fails because `test/unit/port/**` is
classified as `client` (it matches the generic `test/` catch-all in
`classifySuitePath`), producing a client-only plan instead of a port-only plan.

- [ ] **Step 3: Add the minimal production implementation**

In `scripts/run-standard-tests.ts`:

1. Extend the `SuiteName` type:

```typescript
export type SuiteName = 'client' | 'server' | 'electron' | 'port'
```

2. Add the port config constant next to the others (after `electronVitestConfig`):

```typescript
const portVitestConfig = 'config/vitest/vitest.port.config.ts'
```

3. In `classifySuitePath`, add port detection after the server block and before
   the generic `test/` catch-all (the port path is disjoint from server paths):

```typescript
  if (
    normalizedToken.startsWith('test/unit/port/')
    || normalizedToken.includes('/test/unit/port/')
  ) {
    return 'port'
  }
```

4. In `detectRequestedSuites`, add `'port'` to the filter list:

```typescript
  return ['client', 'server', 'electron', 'port'].filter((suite): suite is SuiteName => suites.has(suite))
```

5. In `createStandardTestPlan`, add the port run to the aggressive plan:

```typescript
      { name: 'port', configPath: portVitestConfig, priority: 'normal' },
```

   and to the desktop `initialStage`:

```typescript
    { name: 'port', configPath: portVitestConfig, priority: 'background' },
```

6. In the cloud-backend path (the `FRESHELL_VITEST_BACKEND === 'cloud'` branch),
   after the electron suite runs locally, also run the port suite locally
   (port is a fast in-process drift guard; it is not a cloud-dispatchable
   client/server config). Add right after the electron local run block:

```typescript
      // Port contract drift guard: fast, in-process, no cloud dispatch.
      const portArgs = buildVitestArgs({
        configPath: portVitestConfig,
        forwardedArgs,
      })
      log('info', 'Running port contract suite locally after cloud dispatch', {
        args: portArgs,
      })
      try {
        execFileSync(process.execPath, [vitestEntrypoint, ...portArgs], {
          stdio: 'inherit',
          cwd: repoRoot,
          env: process.env,
        })
      } catch {
        process.exitCode = 1
        return 1
      }
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/run-standard-tests.test.ts --run`

Expected: PASS — all three updated/new tests pass.

- [ ] **Step 5: Refactor while green**

No refactor needed — the additions follow the existing pattern exactly (a new
SuiteName + config constant + classifySuitePath branch + plan run, mirroring
how `electron` is handled). Confirm no duplicated logic was introduced.

- [ ] **Step 6: Run impacted-test verification**

The change touches the standard-runner used by `npm test`. Impacted tests:
the modified test file itself, the port contract suite it now includes, and
the coordinator matrix test (which imports the runner name but does not assert
plan structure — confirm it still passes).

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/run-standard-tests.test.ts test/unit/server/testing/coordinator-command-matrix.test.ts --run && npm run test:port`

Expected: PASS — the standard-runner tests (including the new port assertions)
pass, the coordinator matrix tests still pass, and the port contract freeze
suite passes (proving the folded-in suite is green on this base).

Note: the cloud-backend branch (`FRESHELL_VITEST_BACKEND=cloud`) is not
exercised by these tests — it follows the established electron local-run
pattern (sequential `execFileSync` with a vitest config) and the existing
opt-in cloud integration tests (`scripts/test/cloud-vitest-integration.test.sh`,
requiring cloud credentials) cover the dispatch mechanism. Adding a
process-level test for the port block is out of scope for this change.

- [ ] **Step 7: Commit the task**

```bash
git add scripts/run-standard-tests.ts test/unit/server/run-standard-tests.test.ts
git commit -m "test: fold WS port contract drift guard into the local standard suite

Add a 'port' suite to run-standard-tests that runs the existing
config/vitest/vitest.port.config.ts drift guard, so every local 'npm test'
verifies the TS<->Rust wire-protocol contract without relying on the
port-contract CI workflow. The test:port freeze test already regenerates
the contract artifacts in-memory and asserts byte-equality with the committed
files, subsuming the contract:generate idempotency check.

Also extends classifySuitePath so test/unit/port/** targets route to the
port suite under the port config (previously misrouted to the client/default
config, which excludes them), and adds the port suite to the cloud-backend
local section alongside electron."
```
