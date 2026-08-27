# CFG-01 Restart-Leg Drift Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result

Fix the pre-existing red e2e assertion in
`test/e2e-browser/specs/cfg01-lossless-writes.spec.ts:383` ("every REST
writer preserves all sentinels; restart writes nothing"), which fails in
cloud e2e full-suite runs (rust-chromium) with "normalized boot with
sentinels present: unexpected config.json drift beyond the writer's intended
paths". First teach the failing assertion to log the exact drifted key set,
then classify the drift as (a) a real product wedge (the Rust server
normalizes/writes config on boot when it must not) or (b) an
environment-sensitive comparator or spec defect, and land the faithful fix so
the spec passes.

### Explicit constraints

- Do not weaken the CFG-01 guarantee: every `config.json` write must remain
  lossless for `sessionOverrides`, `terminalOverrides`, `projectColors`,
  `recentDirectories`, `completedMigrations`, `legacyLocalSettingsSeed`,
  Codex secrets, and unknown future keys; the restart leg's acceptance
  remains "a fully-normalized config boots to a no-op".
- The spec is rust-only (acceptance `PW-RUST`); the legacy Node store cannot
  be a parity control for guarantees it never provided.
- Cloud runs keep no HTML report artifacts, so failure diagnostics must land
  in stdout/expect messages visible in Cloud Run task logs.
- Preserve Node/Rust parity: no product-behavior divergence from the legacy
  server's boot-migration semantics.

### Accepted tradeoffs and residuals

- The failure is pre-existing on unmodified main (red in the cloud control
  run and locally); fixing it is a spec-side correction, not a behavior
  change, so no `docs/index.html` update is needed.
- Classification is settled as hypothesis (b), a spec defect, by local
  reproduction on the unmodified base commit: the spec fails identically to
  the cloud signature and the sole drifted path is `["completedMigrations"]`.
  The cause is the `ai-title-shadow-cleanup` boot migration (ported from
  Node), which unconditionally appends its `completedMigrations` marker
  whenever the marker is absent, while the spec's seeded sentinel block
  erases boot 1's real marker.

**Goal:** The CFG-01 spec's restart leg ("restart writes nothing") is green
again because the seeded config preserves the server's real boot-migration
record, and any future drift failure names the exact drifted config paths in
its output.

**Architecture:** This is a test-side fix in one file,
`test/e2e-browser/specs/cfg01-lossless-writes.spec.ts`. The product is
correct: `crates/freshell-server/src/main.rs` (~:1345) spawns the one-time
`run_ai_title_shadow_cleanup` boot migration (Node parity,
`server/index.ts:1111-1120`), which appends `ai-title-shadow-cleanup` to
`completedMigrations` whenever the marker is absent — even when it clears
zero keys ("the marker is written even when nothing qualified, so a clean
home never re-scans", `crates/freshell-server/src/migrations.rs`). The spec's
`sentinelBlock()` wholesale-replaces `completedMigrations` with
`['cfg01-sentinel-migration']`, erasing the marker boot 1 recorded, so boot 2
(correctly, idempotently) re-appends it — the sole drift is
`[["completedMigrations"]]`. `SettingsStore::load` itself is a clean no-op on the seeded config — proven
by the local reproduction where the ONLY drift was `completedMigrations`.
The fix mirrors the handling the spec already gives `serverSecrets`: preserve
the server's own value from boot 1 and add an unknown sibling sentinel to it.

**Tech Stack:** TypeScript, Playwright (`@playwright/test` via
`test/e2e-browser/helpers/fixtures.ts`), Node `fetch` against the spawned
Rust `freshell-server` binary.

## Global Constraints

- Rust-only spec: keep it matched exactly under the `rust-chromium` project
  (`test/e2e-browser/playwright.config.ts`), still ignored by `chromium` via
  `RUST_ONLY_SPECS`.
- The spec must remain serial and self-isolating (mkdtemp home, pinned-empty
  extension discovery, spawned binary, exact-PID cleanup) — no new global
  helpers, no fixture changes, no shared state.
- Local verification command (this plan's gate):
  `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --retries=0 specs/cfg01-lossless-writes.spec.ts`
  from the worktree root, expecting `2 passed`.
- Wired assertions may not regress: every existing `expectDiffWithin` /
  `expectSentinelsIntact` call keeps its current allowed-path semantics; the
  diagnostic change only adds failure output, never relaxes a check.
- Full QA gate (`npm run check` via `darkforge qa`, vitest unit+server
  configs) must stay at its baseline: zero new failures (three pre-existing
  `test/unit/vite-config.test.ts` `getNetworkHost` failures are the
  identity-allowed baseline exception). E2E specs are not part of that gate;
  the focused playwright run above is this plan's e2e evidence.
- No product (`crates/`, `server/`, `src/`) changes in this plan.

---

### Task 1: Name the unexpected drift set in CFG-01 assertion-failure output

**Files:**
- Modify: `test/e2e-browser/specs/cfg01-lossless-writes.spec.ts`
  (`expectDiffWithin`, currently lines 260-270)

**Interfaces:**
- Consumes: existing `DiffPath` (`string[]`), `fmt(path)`, `collectDiffPaths`
  in the same file — unchanged.
- Produces: `expectDiffWithin(actual, allowed, context)` with the same
  signature and pass/fail semantics; on failure the assertion message now
  embeds `fmt`-rendered unexpected paths and a `console.error` line prefixed
  `[cfg01-lossless]` carries the same set (Playwright's line reporter can
  truncate long `Received` blocks; the `console.error` line rides worker
  stderr into Cloud Run task logs and local output). The load-bearing probe
  below greps for EITHER channel (LB7): the base-commit red run proved the
  custom expect message prints verbatim under the line reporter; console.error
  surfacing is proven by this probe itself at Step 4 — whichever channels
  surface, the gate counts it, and a zero count is a real failure of the
  diagnostic.

- [ ] **Step 1: Write the failing behavioral test**

The verifying "test" for this diagnostic is a run of the existing (still
unfixed) spec whose failure output must contain the rendered drift set. The
probe script asserts the rendered path appears in the failure output:

```bash
mkdir -p /tmp/cfg01-fd1m
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium --retries=0 --reporter=line \
  -g "every REST writer" \
  specs/cfg01-lossless-writes.spec.ts > /tmp/cfg01-fd1m/task1-red.log 2>&1
echo "spec exit: $?"   # expected nonzero (spec still red; that is correct pre-fix)
# Either-channel probe (LB7): matches the [cfg01-lossless] console.error line
# AND/OR the expect message's new `(unexpected: [...])` suffix — a nonzero
# count cannot depend on which stream the line reporter surfaces.
grep -E -c '\[cfg01-lossless\] UNEXPECTED DRIFT|unexpected: \[' /tmp/cfg01-fd1m/task1-red.log
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: the block from Step 1.

Expected: FAIL — spec exit code is nonzero (the pre-existing restart-leg red)
AND the final `grep -c` prints `0`: the current failure output contains
neither the `[cfg01-lossless] UNEXPECTED DRIFT` line nor an `unexpected: [`
message suffix (its Expected/Received block renders `[\"completedMigrations\"]`
with no such prefix). (The diagnostic is the missing behavior; the spec red is
the reproduced pre-existing failure this task instruments.)

- [ ] **Step 3: Add the minimal production implementation**

Replace the body of `expectDiffWithin`
(`test/e2e-browser/specs/cfg01-lossless-writes.spec.ts`) so the drift set is
named twice — once in the expect message, once on stdout — without changing
any pass/fail semantics:

```ts
/** Assert every actual diff path is contained under one of the allowed
 * (prefix) paths — "only that writer's intended paths differ". On failure
 * the unexpected set is named TWICE: in the expect message and on a
 * `[cfg01-lossless]` console line, because cloud runs retain only the line
 * reporter's stdout (no HTML report) and the reporter can abbreviate the
 * Received block. */
function expectDiffWithin(actual: DiffPath[], allowed: DiffPath[], context: string): void {
  const unexpected = actual.filter(
    (p) => !allowed.some((a) => a.length <= p.length && a.every((seg, i) => seg === p[i])),
  )
  if (unexpected.length > 0) {
    console.error(
      `[cfg01-lossless] UNEXPECTED DRIFT (${context}): ${unexpected.map(fmt).join(', ')}` +
        ` — allowed: ${allowed.length > 0 ? allowed.map(fmt).join(', ') : '(none)'}`,
    )
  }
  expect(
    unexpected.map(fmt),
    `${context}: unexpected config.json drift beyond the writer's intended paths` +
      ` (unexpected: ${unexpected.map(fmt).join(', ') || 'none'})`,
  ).toEqual([])
}
```

- [ ] **Step 4: Run the focused test**

Run: the same block from Step 1.

Expected: PASS — spec exit code is STILL nonzero (the fix arrives in Task 2),
but this time the probe's final `grep -c` prints `>=1` (both channels may
surface; either alone satisfies the gate) and
`/tmp/cfg01-fd1m/task1-red.log` names `["completedMigrations"]` as the sole
unexpected path — the local reproduction fingerprint matching the cloud
signature. (Record this log as the run's red/diagnostic evidence.)

- [ ] **Step 5: Refactor while green**

No refactor needed: one self-contained function-body change; `fmt` reuse
keeps formatting in one place; no new exports.

- [ ] **Step 6: Run impacted-test verification**

Only one spec file changed; no helper, config, or production code moved.
Note: the repo-owned typecheck configs exclude `test/` (`tsconfig.json`
include is `src`, `shared`, `config/vite/vite.config.ts`; `tsconfig.server.json`
includes `server`, `shared`), but CFG-01 has an item-scoped tsc gate:
`test/e2e-browser/tsconfig.cfg01-check.json` covers exactly
`specs/cfg01-lossless-writes.spec.ts` (house convention per
`docs/plans/df1-evidence/CFG-01.md`, mirroring TERM-04/HARNESS-05). Its
criterion is zero error lines attributed to the spec file — errors in
pre-existing dependency files (e.g. `src/lib/perf-logger.ts`) reproduce
identically on the base commit and are out of scope. Run the repo typecheck
as a cheap guard, the e2e helper unit suite (none of its inputs changed), and
the spec-attributed tsc gate:

Run: `npm run typecheck && npm run test:e2e:helpers && npx tsc -p test/e2e-browser/tsconfig.cfg01-check.json 2>&1 | tee /tmp/cfg01-fd1m/task1-tsc.log; ! grep -F 'specs/cfg01-lossless-writes.spec.ts' /tmp/cfg01-fd1m/task1-tsc.log`

Expected: PASS — typecheck and helper suite exit zero; the tsc log contains
no line naming `specs/cfg01-lossless-writes.spec.ts` (the trailing grep fails
the step if any spec-attributed type error exists).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/cfg01-lossless-writes.spec.ts
git commit -m "test(cfg01): name the unexpected config drift set in failure output"
```

---

### Task 2: Seed preserves the real boot-migration record; correct stale writer inventory

**Files:**
- Modify: `test/e2e-browser/specs/cfg01-lossless-writes.spec.ts`
  (header doc comment writer inventory ~lines 24-41; `sentinelBlock` ~lines
  328-351; test 1 boot-1 snapshot ~line 391 and seeding ~line 399; test 2
  boot-1 snapshot ~line 533 and `regressed` ~lines 539-558)

**Interfaces:**
- Consumes: `readConfig(homeDir)`, `writeConfig(homeDir, doc)`,
  `sentinelBlock()`, `spawnRustServer`, `stopProcessGracefully` — same file.
- Produces:
  - `sentinelBlock(existingCompletedMigrations: readonly string[]): Record<string, unknown>`
    — as today, except `completedMigrations` is
    `[...existingCompletedMigrations, 'cfg01-sentinel-migration']`.
  - `readConfigAfterBootWrites(homeDir: string, timeoutMs?: number): Promise<any>`
    — polls `readConfig` (100 ms interval) until `completedMigrations`
    contains `ai-title-shadow-cleanup`, then returns that doc; throws with
    the observed array on timeout (a loud, self-diagnosing failure if the
    boot writer ever stops running).

- [ ] **Step 1: Write the failing behavioral test**

The failing test already exists: the unmodified spec after Task 1, whose
restart leg deterministically fails with `["completedMigrations"]` (the
seeded config provably lacks the marker — `sentinelBlock()` replaces the
array wholesale, so boot 2's migration re-appends it; the failure does not
depend on any timing race). The Step-1 probe from Task 1 doubles as this
task's red gate.

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
mkdir -p /tmp/cfg01-fd1m
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium --retries=0 --reporter=line \
  specs/cfg01-lossless-writes.spec.ts > /tmp/cfg01-fd1m/task2-red.log 2>&1
echo "spec exit: $?"
# Either-channel probe (LB7): the console.error marker line and/or the expect
# message line, both bound to this leg's context.
grep -E -c 'UNEXPECTED DRIFT \(normalized boot with sentinels present\): \["completedMigrations"\]|normalized boot with sentinels present: unexpected config.json drift' /tmp/cfg01-fd1m/task2-red.log
```

Expected: FAIL — nonzero spec exit; the drift set named under context
`normalized boot with sentinels present` (by the marker line and/or the expect
message, whichever channels surface) is exactly `["completedMigrations"]`, and
the grep count is `>=1`. (The second test is skipped in this serial describe
after the first's failure.)

- [ ] **Step 3: Add the minimal production implementation**

Four edits, all in `test/e2e-browser/specs/cfg01-lossless-writes.spec.ts`:

1. Header doc comment — correct the stale writer inventory. Replace the
   lines pairing "recent-directory update / title migration … NOT a Rust
   writer" with:

   ```
    *   recent-directory update    NOT a Rust writer (CFG-09 open) — the CFG-01
    *                              obligation for `recentDirectories` is
    *                              PRESERVATION across every writer, asserted
    *                              as a sentinel in every leg below.
    *   title migration            IS a Rust boot writer since the Node-parity
    *                              port: main.rs spawns the one-time
    *                              `run_ai_title_shadow_cleanup`
    *                              (`crates/freshell-server/src/migrations.rs`),
    *                              which appends its `completedMigrations`
    *                              marker whenever the marker is absent — even
    *                              when it clears zero keys, so a clean home
    *                              never re-scans. The seeded config must
    *                              therefore PRESERVE boot 1's real marker
    *                              (same treatment `serverSecrets` already
    *                              gets), or the restart boot re-appends it —
    *                              the exact drift this spec's restart leg
    *                              once reported as a product wedge.
   ```

2. `sentinelBlock` takes the server's own recorded migrations and appends
   the sentinel instead of replacing:

   ```ts
   /** Sentinel top-level block injected into a server-written default config.
    * (The codex secret is NOT here: the server's own minted value is preserved
    * from its first write and asserted alongside. `completedMigrations` is
    * likewise a MERGE: the server's real boot-migration markers must survive
    * seeding — erasing them makes the next boot re-run the marker append, a
    * correct idempotent writer the restart leg would misread as drift.) */
   function sentinelBlock(existingCompletedMigrations: readonly string[]): Record<string, unknown> {
     return {
       sessionOverrides: {
         'claude:cfg01-sentinel-sess': { summaryOverride: 'CFG-01 sentinel summary', archived: true },
       },
       terminalOverrides: {
         'cfg01-sentinel-term': { titleOverride: 'CFG-01 Sentinel Title' },
       },
       projectColors: { '/cfg01/sentinel-project': '#aa00bb' },
       recentDirectories: ['/cfg01/recent/a', '/cfg01/recent/b', '/cfg01/recent/c'],
       completedMigrations: [...existingCompletedMigrations, 'cfg01-sentinel-migration'],
       legacyLocalSettingsSeed: {
         theme: 'light',
         uiScale: 1.25,
         terminal: { fontSize: 18, fontFamily: 'CFG01 E2E Mono' },
         sidebar: { sortMode: 'project', width: 280, collapsed: true },
         notifications: { soundEnabled: false },
       },
       zzCfg01FutureKey: { nested: { array: [1, 2, { x: 'y' }] }, scalar: 'keep' },
     }
   }
   ```

3. Add the boot-writes quiescence reader next to `readConfig`:

   ```ts
   /** The marker `crates/freshell-server/src/migrations.rs` appends on every
    * boot where it is absent (Node parity; see the file-header inventory). */
   const AI_TITLE_SHADOW_CLEANUP_MARKER = 'ai-title-shadow-cleanup'

   /** Snapshot config.json only AFTER the detached boot writers have landed.
    * The boot persist inside `SettingsStore::load` is synchronous before the
    * listener binds, but the one-time `ai-title-shadow-cleanup` migration is
    * `tokio::spawn`'d (`main.rs`) and appends its marker on a fresh/erased
    * home; seeding must not snapshot before that append or it would seed a
    * file the next boot must (correctly) rewrite. Timeout fails LOUDLY with
    * the observed migrations — a stopped boot writer is a bug this spec
    * wants to know about. */
   async function readConfigAfterBootWrites(homeDir: string, timeoutMs = 10_000): Promise<any> {
     const start = Date.now()
     let last: any
     for (;;) {
       last = await readConfig(homeDir)
       const done = last?.completedMigrations
       if (Array.isArray(done) && done.includes(AI_TITLE_SHADOW_CLEANUP_MARKER)) return last
       if (Date.now() - start > timeoutMs) {
         throw new Error(
           `Timed out waiting for the ai-title-shadow-cleanup boot marker; completedMigrations=${JSON.stringify(done)}`,
         )
       }
       await new Promise((r) => setTimeout(r, 100))
     }
   }
   ```

4. Both tests take their boot-1 snapshots through the quiescence reader and
   pass their real migrations into `sentinelBlock`:
   - Test 1: `const afterFirstWrite = await readConfigAfterBootWrites(homeDir)`
     (replacing the plain `readConfig`) and
     `const seeded = { ...afterFirstWrite, ...sentinelBlock(afterFirstWrite.completedMigrations ?? []) }`.
   - Test 2: `const firstWrite = await readConfigAfterBootWrites(homeDir)`
     (replacing the plain `readConfig`) and the `regressed` spread becomes
     `...sentinelBlock(firstWrite.completedMigrations ?? [])`. Test 2 keeps
     corrupting only `settings.codingCli.knownProviders` + the stray
     browser-local `settings` keys + deleting `legacyLocalSettingsSeed` —
     it deliberately does NOT erase `completedMigrations`, because boot 2's
     allowed-diff list covers exactly the normalization persist and nothing
     else.

- [ ] **Step 4: Run the focused test**

Run:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium --retries=0 --reporter=line \
  specs/cfg01-lossless-writes.spec.ts
```

Expected: PASS — `2 passed`. The restart leg is a true no-op (zero drift
allowed, zero observed) and the boot-writers test's allowed list matches its
persist byte-for-byte. No `[cfg01-lossless] UNEXPECTED DRIFT` line appears.

- [ ] **Step 5: Refactor while green**

Re-read the file header's "Why rust-only" and "Discovery determinism"
paragraphs for consistency with the corrected inventory; adjust only wording
that contradicts it (no behavior). Confirm no duplicated constant strings
(`AI_TITLE_SHADOW_CLEANUP_MARKER` is the single source).

- [ ] **Step 6: Run impacted-test verification**

Blast radius is the one spec file. Impact set = the spec itself (Step 4),
plus the repo typecheck guard (`tsconfig.json`/`tsconfig.server.json`
exclude `test/`; the CFG-01 item-scoped tsc gate below carries the
spec-file check — same convention as Task 1 Step 6), the e2e helper unit
suite, and the sibling rust-only
config specs that share the spawned-binary + config-on-disk pattern, to catch
any accidental shared-assumption change (there should be none — no helper
moved):

Run: `npm run typecheck && npm run test:e2e:helpers && npx tsc -p test/e2e-browser/tsconfig.cfg01-check.json 2>&1 | tee /tmp/cfg01-fd1m/task2-tsc.log; ! grep -F 'specs/cfg01-lossless-writes.spec.ts' /tmp/cfg01-fd1m/task2-tsc.log && npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --retries=0 --reporter=line specs/cfg01-lossless-writes.spec.ts specs/cfg03-backup-restore.spec.ts specs/cfg04-legacy-browser-seed.spec.ts`

Expected: PASS — no spec-attributed tsc error lines; `cfg01`: 2 passed;
`cfg03`/`cfg04`: all passed — unmodified
siblings must be exactly as green or red as they were on the base commit, and
no `[cfg01-lossless] UNEXPECTED DRIFT` line appears.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/cfg01-lossless-writes.spec.ts
git commit -m "fix(cfg01): preserve real boot-migration record when seeding sentinels"
```

---

## Self-review result

Performed before commit (recorded in
`/home/dan/.local/state/darkforge/freshell-fb808e79f4/traces/fd1m/reports/plan-self-review.md`):

1. **Spec coverage:** Requested result maps to Task 1 (teach the assertion
   to log the drifted key set) and Task 2 (faithful fix; classification (b)
   with the evidence recorded). Explicit constraints are covered: no
   guarantee weakened (allowed-path semantics unchanged; restart leg keeps
   its zero-drift budget), rust-only lane unchanged, diagnostics in stdout
   (Task 1), Node parity untouched (no product change).
2. **No silent deferrals:** no stubs, mocks, or seams introduced; both tasks
   end in committed, executed production-test code.
3. **File and interface consistency:** every edit is in
   `test/e2e-browser/specs/cfg01-lossless-writes.spec.ts`;
   `sentinelBlock`'s new parameter is supplied at both call sites;
   `readConfigAfterBootWrites` is defined before use; no external interface
   changes.
4. **Executable tests:** Task 1's probe fails for exactly the missing
   diagnostic (grep count 0) and passes after the edit; Task 2's red gate is
   the deterministic restart-leg failure (`sentinelBlock` wholesale-replaces
   `completedMigrations`, so boot 2 must re-append — no timing dependency),
   and its green gate is the full `2 passed` spec run.
5. **Placeholder scan:** no TBD/TODO/"handle edge cases"; all commands are
   runnable as written with stated expected results.
6. **Operational completeness:** no migrations, rollbacks, or docs needed
   (spec-only change, invisible to `docs/index.html`); logging improvement
   lands in stdout where cloud retains it; commit messages are conventional.

No `UNRESOLVED COVERAGE GAP`.
