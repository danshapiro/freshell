# Freshell Crash Resilience Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Root-cause and fix the recurring Freshell outages on garageserver and the Windows Electron client on DANDESKTOP, including the sandbox build memory-pressure trigger, failed user-service-manager recovery, and Electron stopping reconnection after a server outage.

### Explicit constraints
- Use the-usual workflow, dedicated git worktrees, behavioral tests, and independent review; preserve unrelated changes and agents.
- The recorded failing baseline is accepted for worktree creation; fix its missing durable-resume test wait before the crash fixes.
- Keep the findings and work tracked in Kata: freshell#mdmw, freshell#fprv, and machines#brpn.
- The approved production rebuild/restart and Windows client restart have been completed. Do not deploy these new fixes or restart the running production services without separate explicit approval.
- Do not create a PR without explicit user approval.

### Accepted tradeoffs and residuals
- Pane recovery, including unwanted reopened panes and requiring open panes before process restarts, remains deferred in freshell#7fen.

**Goal:** Prevent the identified sandbox build from creating excessive pressure by default, recover failed user managers on a watchdog tick, and let an Electron window render Freshell again after a long server outage without restarting the desktop application.

**Architecture:** Bound Cargo jobs and container CPU allocation in the existing sandbox wrapper, preserving its memory/isolation boundaries. Keep one Electron recovery owner per logical window, turn the existing rolling circuit limit into a timed cooldown, and bound the complete native action plus document verification with a cancellable attempt lifetime. A timed-out attempt retires its native authority while allowing future retries; permanent logical disposal stops all future work. Apply the existing failed-manager recovery policy consistently to both existing UIDs in the machines repository; prove service restoration in an isolated real systemd guest. Run destructive Freshell verification and the unchanged configured-cloud full gate inside a bounded private Docker-capable guest while reserving the original shared host test gate. Deliver deployment instructions without applying them.

**Tech Stack:** Bash, Docker with cgroup v2, Rust/Cargo, Node 22/TypeScript ESM, Electron, Vitest, Playwright, Python 3, Ubuntu 24.04/systemd.

## Global Constraints

1. The user explicitly approved creating the Freshell worktree from the recorded failing baseline and correcting the missing durable-resume wait first. Preserve the failed baseline receipts, then execute Task 0 before crash implementation. The separate machines baseline has 28 completed zero-failure suites before an unrelated broad timeout, plus a green seven-suite SentinelX baseline; that narrow result is not a green full-repository baseline.
2. Freshell base is `283e4c4b87e58f31a048732800cefb345b799082`; machines base is `0409315b6278cf343a9c8a963b236345d28fcbc1`. Primary worktree: `/home/dan/code/freshell/.worktrees/freshell-crash-resilience`, branch `the-usual/freshell-crash-resilience`. Auxiliary worktree: `/home/dan/code/machines/.worktrees/freshell-user-manager-recovery`, branch `the-usual/freshell-user-manager-recovery`. Reconcile any base movement before implementation; an old report is not a green-base receipt for a new SHA.
3. Author changes only in these dedicated worktrees. Keep machines changes in its own branch. Name files explicitly when staging. Commit as the existing configured `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`. No PR, merge, production deployment, installed-watchdog replacement, live manager action, production service restart, Windows installation, or Windows client restart is authorized here.
4. Use pnpm exactly `10.34.5`, frozen installs, repo-owned test launchers, and `.js` relative TypeScript imports. Honor both repositories' existing AGENTS instructions and the parent-owned usual run ledger. Do not invoke unrelated skills or create new Kata scope. The parent records evidence against `freshell#mdmw`, `freshell#fprv`, `machines#brpn`; `freshell#7fen` remains deferred.
5. Do not rerun the unlimited historical Clippy invocation, induce memory exhaustion, rewrite host oomd policy, kill broad process patterns, or delete shared caches. All deliberate process failures occur in disposable owned containers. Use exact owned container/process receipts and bounded cleanup. No live host user manager is a test fixture.
6. Preserve the existing three-attempt/60,000 ms Electron rolling limit, `[250, 1000, 3000]` retry delays, 15,000 ms unresponsive threshold, authenticated immutable recovery URL, replacement-window preload and privileged IPC identity behavior, and close-to-tray behavior. An application root rendering an authentication or machine-selection view is sufficient; requiring an open terminal or pane is outside scope.
7. Logs are structured JSONL with severity, cause, action and outcome. Keep Electron's established token redaction. Never log provider homes, authentication tokens or the ambient environment. Healthy watchdog ticks remain silent.
8. Verification removes only `FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE` and `FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE` from that test process, matching the sanitized recorded-base setup; the ambient optional files otherwise contaminate the existing fake OpenCode fixture. Do not change persistent/live environment or weaken provider assertions. Existing cloud backend choices persist. Broad gates use `GCLOUD_ROBOT_REQUIRE=1`, a meaningful `FRESHELL_TEST_SUMMARY`, and the shared coordinator. Never silently replace configured cloud verification with local verification. Electron's native suite is local by definition, inside the disposable sandbox nested in the private guest for this outage scenario. All Docker-dependent companion and source-runtime fault tests also stay inside that guest; the configured cloud lane remains enabled.

## Evidence and acceptance map

The sandbox report attributes the 2026-10-16 pressure event to an exact Docker scope, at 7.9 GiB and PSI avg10 72.20; it does not prove 96 simultaneously resident compilers or host-wide memory exhaustion. No CPU/Cargo budget was configured. The user-manager report establishes that oomd killed UID 1000's `init.scope` and the watchdog only restarted oomd when that manager was missing. The Electron report establishes that the third attempt leaves no future timer, failures do not schedule a successor, and production readiness verification is a no-op.

| Obligation | Deliverable | Observable acceptance |
|---|---|---|
| Sandbox build pressure trigger | Task 1 | Actual wrapper passes finite controls; tiny Cargo work respects job budgets; identified cold Clippy workload finishes at the chosen default with measured headroom in verified `system.slice` placement. |
| Electron continuing after an outage | Tasks 2 and 3 | One failure drives retries across two rolling windows without extra events; real Electron outage lasts beyond the real 60-second boundary and recovery follows only endpoint restoration. |
| No false Electron success | Task 3 | Candidate native document matches intended origin/path and has mounted Freshell content; error page, timeout and cancellation reject. No success event during the real outage. |
| Failed user-manager recovery | Task 4 | Both existing UIDs follow the same state table; a real isolated manager kill is followed by a new manager PID and a new enabled-service generation, without a login. |
| Preserve live services | All tasks | Self-owned sentinels survive; test cleanup targets exact owned resources; deployments are runbooks only. |
| Pane recovery deferred | All tasks | No pane/session restoration behavior changes or terminal-open requirement. |

**Load-bearing validation receipts:** The parent also executed the identified cold Clippy workload at budgets1and2 on immutable base283e4c4: both passed with zero recorded PSI/OOM/swap; peaks2.339GiB and2.213GiB. Receipt `reports/clippy-budget-prerequisite.md` establishes budget feasibility, not repaired-wrapper coverage. The parent executed a safe 128 MiB/one-CPU/64-PID/private-cgroup/network-none capability probe and demonstrated a writable child cgroup after remounting the existing namespace-rooted cgroup mount with SYS_ADMIN and guest-only seccomp/AppArmor relaxation: `reports/private-cgroup-capability-remount.json`. It then actually booted Ubuntu 24.04/systemd `255.4-1ubuntu8.18` as PID 1 in verified `system.slice` placement at one GiB/no swap/one CPU/512 PIDs, explicitly started guest D-Bus, and successfully ran a guest `systemd-run` child with `MemoryMax=32M`: `reports/systemd-prerequisite-probe-with-bus.json`. Finally, `reports/guest-manager-prerequisite.md` records real guest user-manager failure/restore feasibility and the original UID 1000 watchdog regression; the repaired script's automatic recovery remains Task 4 acceptance. Fresh cgroup2 mounts failed; use the executed remount correction. Recheck prerequisites in the actual fixture; unsafe host writable-cgroup binds/shared-host managers remain prohibited. If fixture feasibility regresses, retain a visible unresolved coverage gap rather than substituting fakes for required recovery.

## Stage 2 decisions and verification ownership

The evidence and remaining empirical limits are recorded outside this plan in `load-bearing-ledger.md`, `reports/load-bearing-finder.md`, `reports/load-bearing-strategist.md`, `reports/load-bearing-validator-f1.md` and `reports/load-bearing-validator-environment.md` under the run's external logs. Stage 2 accepts a guarded sequence; it does not claim a full Freshell build, RuntimeHarness run, native Electron launch or full gate passed.

1. Use the retained public build-tools guest image and guarded lifecycle identified in `reports/guest-build-tools-prerequisite.md`, extending the cloud-auth and nested-Docker images. The chosen outer profile is 8 GiB, no swap, four CPUs and 4096 PIDs, with Cargo jobs two. Pin mise 2026.9.7, its actual `rust@1.96` selection 1.96.1, Buildx 0.20.1/BuildKit 0.18.2, Docker 27.5.1/API 1.47 and pnpm 10.34.5. These are qualified tools, not a completed Freshell build. Verify the actual image identity, private namespaces, exact `system.slice` placement, limits, sole allowed mounts and pre-init barrier again before any guest build or workload. The guest's source/build paths belong under `/workspace`; guest systemd may replace `/tmp` mounts during boot.
2. Stage each required clean committed SHA as a self-contained Git bundle/standalone clone inside the guest. Do not bind the host authoring worktree, Git common directory, target/node caches, home, user/system bus or Docker socket into tests. Build artifacts from source for their actual guest/container runtime; do not copy host/trixie binaries into the glibc 2.36 guest. The existing restricted broker and guest-only dual-stack Docker bridge remain unchanged. The guest daemon owns sandbox image tags and named volumes, so dependency preparation cannot purge another agent's host cache.
3. Reserve the original repository's normal shared host test endpoint before starting a broad guest workload. A standalone guest clone has its own coordinator identity and is insufficient by itself. Reuse the existing public endpoint/store APIs in a one-off operational owner, following `reports/host-gate-reservation-prerequisite.md`; publish a truthful reservation holder only. Do not use fake-upstream seams, disable the companion, change the production coordinator, or fabricate host suite/reusable-success records. Before first real use, qualify this owner's actual guest-action cleanup path with an ordinary owned failure or cancellation, proving the reservation remains busy through cleanup and the failed result survives. Wait for foreign holders without stopping them. Retain the host socket until exact cloud work, guest work, receipt export and temporary-token cleanup are settled; clear only the matching holder and close the owned socket last.
4. Keep the existing configured cloud backends and local companion enabled. Use the public SDK and token-only mechanism in `reports/cloud-guest-auth-prerequisite.md`, with the existing configured Freshell project identity; no persistent credential store, long-lived key, host SDK home, IAM change, broker grant or impersonation setup is required. Bind only the owned temporary token directory read-only. Before a long cloud command, establish non-secret remaining token validity using supported existing SDK refresh/expiry behavior. A token-return timestamp is insufficient, and replacing the token file cannot refresh an already-running SDK wait. Give each such command a finite deadline shorter than demonstrated remaining validity, with a separate cleanup reserve. Reassess or fail safely if that cannot be established. Remove the exact temporary auth directory after guest cleanup; never retain token values or hashes in receipts.
5. Prepare a clean commit-addressed cloud image serially using the existing build path when needed, under the same bounded ownership or a separately bounded owned build. Keep exact build/image identities and finite resource/time limits; do not run an unbounded host compile or race mutable/dirty tags. Run the unchanged coordinated full check inside the private guest, including its cloud client phase, local Docker companion, source-runtime, Rust and Electron phases. Export genuine inner coordinator results and every actual phase verdict, including phases not run after an earlier failure. Cloud cleanup traps suppress errors, so independently verify settlement/removal of the exact recorded per-run cloud job/execution before releasing ownership. No broad name-prefix cleanup is permitted.
6. Task 0 is the first real full build/topology qualification and must pass with independent review before any crash implementation, including machines changes. A tool fixture, bridge probe or successful setup followed by a failing assertion proves only the setup that actually completed. Preserve all selected-case assertions and nonzero selection. Adjust only owned setup prerequisites; extend finite cold-preparation time for observed progress rather than weakening behavioral deadlines. If resources require a safer build budget, reduce Cargo jobs and requalify; never remove the enforced outer limits or use host authority as a fallback.
7. After Task 1, Task 3 must exercise both canonical native renderer-recovery cases in the nested sandbox at the exact clean SHA. Xvfb, package metadata, a version command or a root-user launch does not prove the ordinary-user native path. Correct routine display/library/Chromium fixture setup only inside owned isolation and exercise it. If no equally isolated native or complete-gate route can satisfy acceptance, keep the run `FAILED/non-converged`; no mock-only, partial or live-host substitute qualifies. Windows installation/restart/user testing remains a separately approved rollout operation.
8. The complete Electron native action plus readiness receives a finite attempt budget beginning before native navigation, initially 10,000 ms, with 100 ms readiness polling within the remaining budget. Increase that budget after a deadline expiration and retain the increase across retries/cooldowns, so a consistently slow but finite valid load can eventually finish instead of being restarted at the same deadline forever. Reset the budget only after verified success or a new logical owner; do not add a user setting or another reconnect loop. The same owner must retire a timed-out attempt before a successor can acquire native authority. A never-settling load or evaluation cannot occupy the sole recovery slot forever; late native completion cannot activate, update privileged IPC identity, show, focus, log success or requeue retired work. Attempt timeout preserves future retries/cooldowns. Logical close, a new destination or quit permanently disposes the owner; retiring an old native window and hiding to tray do not. Tasks 2/3 must cover both slow valid loads and permanently hung work.

## File responsibilities and task interfaces

Paths below are relative to the owning repository.

| Repository/file | Responsibility |
|---|---|
| Freshell `test/integration/server/managed-provider-parity.test.ts` | Observe durable resume readiness before the injected test outage, preserving every existing assertion. |
| Freshell `scripts/sandbox-test.sh` | Shared runtime resource defaults and start/completion JSONL receipts. |
| Freshell `docker/sandbox/Dockerfile` | Minimal xvfb/xauth prerequisites for actual headless Electron launch. |
| Freshell `test/unit/scripts/sandbox-test.test.ts` | Execute the real wrapper with a recording Docker executable; verify arguments, modes and exit propagation. |
| Freshell `scripts/testing/sandbox-budget-smoke.mjs` | Tiny bounded Cargo concurrency and effective-cgroup proof inside the real wrapper. |
| Freshell `scripts/sandbox-selftest.sh` | Existing sandbox isolation acceptance, extended with real resource proof. |
| Freshell `docs/development/test-sandbox.md` | Agent/operator resource policy, proof instructions and explicit limits of protection. |
| Freshell `electron/renderer-recovery.ts` | One cancellable bounded retry controller per logical window. |
| Freshell `test/unit/electron/renderer-recovery.test.ts` | Fake-clock recovery, coalescing, cooldown, cancellation and existing crash behavior. |
| Freshell `electron/renderer-readiness.ts` | Bounded cancellable native document/root verification. |
| Freshell `electron/recoverable-window.ts` | Existing replacement adapter, moved for testing; finite native-action/readiness attempts, candidate identity and permanent logical disposal. |
| Freshell `electron/startup.ts` | Install recovery before first navigation and return explicit recovery disposal. |
| Freshell `electron/entry.ts` | Native constructor injection, IPC identity, launch-generation and quit disposal. |
| Freshell `electron/main.ts` | Dispose renderer recovery when quitting begins, before asynchronous server teardown. |
| Freshell `test/unit/electron/renderer-readiness.test.ts`, `recoverable-window.test.ts`, `startup.test.ts`, `main.test.ts` | Behavioral native adapter, readiness, startup and quit wiring coverage. |
| Freshell `test/e2e-electron/electron-app.test.ts` | Real >60-second endpoint outage and recovery without a new post-restore client event. |
| Machines `garageserver/sentinelx/bin/sentinelx-oomd-watchdog` | Common state-sensitive recovery for UIDs 1001 and 1000; aggregate one oomd restart. |
| Machines `tests/test-sentinelx-janitor.sh`, `tests/test-oomd-watchdog.py` | Preserve existing janitor acceptance and run independent per-UID, per-call watchdog behavior matrix. |
| Machines `tests/systemd-watchdog/Dockerfile`, `guest-smoke.sh`, `tests/smoke-oomd-watchdog.sh` | Disposable real-systemd prerequisite check, manager/service recovery and exact cleanup. |
| Machines `garageserver/docs/sentinelx-sandbox.md`, `garageserver/sentinelx/AGENTS.md` | Current policy and narrow approved-deployment/rollback runbook; preserve historical incidents. |

Task 0 must pass and receive its required review before any crash implementation, including the auxiliary machines task. Task 2 produces `registerRendererRecovery(options): () => void` and optional listener removal without depending on Task 3's native adapter. Task 3 consumes that disposer and produces `StartupResult` main-arm `disposeRendererRecovery(): void`; the native adapter owns the finite complete attempt and distinguishes retryable attempt retirement from permanent `cancelRecovery(): void` disposal. Tasks 1 and 4 are code-independent; execute their mutations only in their separate worktrees. Task 3's destructive Electron proof depends on Task 1's green bounded sandbox, and Freshell's actual sandbox/runtime Docker proofs run against the private guest daemon. Task 4 retains its separately qualified rootful disposable Ubuntu/systemd guest and exact outer-driver ownership.

All code below is a pre-implementation draft. Once execution begins the source tree supersedes these snippets; review corrections belong in source rather than being backported into plan code.

---

### Task 0: Wait for durable resume evidence before the injected test outage

**Files:** Modify `test/integration/server/managed-provider-parity.test.ts` only.

**Intent:** Correct the demonstrated test readiness race before implementing the crash fixes. The existing test currently kills the web process and provider after observing CLI identity text; it must wait for the supervisor's durable resume evidence, preserving all replacement/config/source/MCP assertions and leaving production recovery unchanged.

- [x] **Step 1: Confirm red evidence and exact scope**

Use the two recorded base failures in `reports/base-gate.log` and `reports/base-gate-sanitized.log`, supported by `reports/baseline-managed-restart.md`. The test consistently fails waiting for replacement, and the soul's retained lifecycle has zero recovery store probes. Record that the branch differs from that exact base only by planning until this correction. Do not rerun an unbounded or shared-host kill experiment for RED.

- [x] **Step 2: Correct the missing prerequisite**

Immediately after `OpenCode native identity before web restart`, insert the same bounded readiness wait the neighboring passing replacement case already uses:

```ts
await waitFor('OpenCode resume evidence before web restart', async () => {
  const view = (await rig.inventory()).find((row: any) => row.terminalId === terminalId)
  return view?.durabilityState === 'resume_captured' ? view : undefined
}, 45_000)
```

Keep all existing later assertions and timeouts. Do not change supervisor/pane recovery, manufacture resume evidence, use arbitrary sleeps, or weaken assertions. Refactor only if this small test change exposes actual duplication worth removing; otherwise keep the existing idiom and confirm it remains green.

- [x] **Step 3: Commit the correction for exact-source verification**

```bash
git add test/integration/server/managed-provider-parity.test.ts
git commit -m "test: wait for durable resume before OpenCode restart"
```

- [x] **Step 4: Run the actual affected case in a disposable Docker-capable guest**

Use the Stage 2 guest and ownership decisions above, with the finalized build-tools, cloud-auth and nested-Docker prerequisite reports. Stage a self-contained clean checkout at the committed Task 0 SHA under guest `/workspace`; use the guest's own Docker daemon, restricted runtime broker, validated dual-stack bridge and actual absolute mise path/Rust selection. Keep the qualified outer 8-GiB/no-swap/four-CPU/4096-PID profile and Cargo jobs two. Recheck ownership/namespace/cgroup/mount guards before releasing init or any build. Full runtime-image, test/release and qualification builds are not yet proved: let this actual selected case qualify them and then the real broker/workload/MCP/durable-recovery topology. Retain separate setup and behavioral verdicts. All deliberate fixture kills remain inside the outer guest. The already-proven shared-gate primitive still requires its actual operational cleanup qualification before broad use. Keep fresh owned guest artifacts for immediate affected-suite continuation when useful, with exact cleanup ownership.
Inside that guest, the exact repo-owned selector is:

```bash
env -u FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE -u FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE CARGO_BUILD_JOBS=2 pnpm run test:vitest run test/integration/server/managed-provider-parity.test.ts --config config/vitest/vitest.config.ts --testNamePattern 'recovers OpenCode inline and home JSONC TUI inputs after web restart with its container down'
```

Expected: exactly the selected case runs and passes with the durable barrier satisfied before the real outage, then replacement and all existing assertions pass. A filter matching zero tests is failure. Preserve full command/output/sourceSHA and guest ownership/cleanup receipts under this run's external logs. Record any safe setup refinements and rerun meaningful impacted coverage after subsequent corrections.

- [x] **Step 5: Review the committed task**

Fresh task review must confirm the new wait observes real supervisor state, existing assertions remain, RED/GREEN evidence is attributable, and no production or pane-recovery behavior changed. Repair any substantive findings before Task 1 starts.

---

### Task 1: Bound sandbox builds and prove the identified workload safely

**Files:**
- Modify: `scripts/sandbox-test.sh:111`, `docker/sandbox/Dockerfile:34`, `scripts/sandbox-selftest.sh:270`, `docs/development/test-sandbox.md`.
- Create/Test: `test/unit/scripts/sandbox-test.test.ts`.
- Create: `scripts/testing/sandbox-budget-smoke.mjs`.

**Interfaces:**
- Consumes: existing `scripts/sandbox-test.sh [--runtime-suite] "command"` and its exact workload exit status.
- Produces: both ordinary/runtime modes pass `--cpus 2 --memory 8g --memory-swap 16g --pids-limit 512 -e CARGO_BUILD_JOBS=2`; native-tools remains its early independent branch. No new production override interface.
- Produces: JSONL `sandbox_resources` with `severity`, `mode`, `cargoJobs`, `cpus`, `memoryBytes`, `memorySwapBytes`, `pidsLimit`; `sandbox_completed` with `severity`, `mode`, `exitCode`. Both include controlled `cause`, `action` and `outcome` fields.
- Produces: safe proof commands documented below; `sandbox-budget-smoke.mjs <jobs>` exits nonzero on missing limits, wrong NUM_JOBS, excess overlap, or incomplete work.

- [ ] **Step 1: Write a failing behavioral wrapper test**

Create this test; it executes production argument construction without starting Docker or a compiler:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function invoke(mode: 'ordinary' | 'runtime-suite', code = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-wrapper-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.mkdirSync(path.join(root, 'bin'))
  fs.copyFileSync('scripts/sandbox-test.sh', path.join(root, 'scripts/sandbox-test.sh'))
  const receipt = path.join(root, 'docker.jsonl')
  const docker = path.join(root, 'bin/docker')
  fs.writeFileSync(docker, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.WRAPPER_RECEIPT, JSON.stringify(args) + '\\n');
if (args[0] === 'run') process.exit(Number(process.env.WRAPPER_EXIT));
if (args[0] === 'image' || args[0] === 'network') process.exit(0);
process.exit(89);
`)
  fs.chmodSync(docker, 0o755)
  const command = 'printf "%s\\n" "literal $(not-a-host-command)"'
  const result = spawnSync('bash', [path.join(root, 'scripts/sandbox-test.sh'),
    ...(mode === 'runtime-suite' ? ['--runtime-suite'] : []), command], {
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      WRAPPER_RECEIPT: receipt, WRAPPER_EXIT: String(code) }, encoding: 'utf8',
  })
  const calls: string[][] = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { result, command, run: calls.find(args => args[0] === 'run')! }
}

describe('sandbox execution budget', () => {
  for (const mode of ['ordinary', 'runtime-suite'] as const) {
    it(`${mode} bounds actual Docker/Cargo scheduling and preserves command boundaries`, () => {
      const { result, command, run } = invoke(mode)
      expect(result.status).toBe(0)
      for (const [flag, value] of [['--cpus', '2'], ['--memory', '8g'],
        ['--memory-swap', '16g'], ['--pids-limit', '512']]) {
        expect(run[run.indexOf(flag) + 1]).toBe(value)
      }
      expect(run).toContain('CARGO_BUILD_JOBS=2')
      expect(run).toContain('--init')
      expect(run.slice(-4)).toEqual(['freshell-sandbox:latest', 'bash', '-c', command])
      expect(run[run.indexOf('--network') + 1]).toBe(mode === 'ordinary' ? 'freshell-sandbox' : 'none')
      if (mode === 'runtime-suite') expect(run).toContain('--read-only')
      const events = result.stderr.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      expect(events).toContainEqual(expect.objectContaining({ event: 'sandbox_resources', cargoJobs: 2, cpus: 2 }))
    })
    it(`${mode} preserves a failed workload exit`, () => {
      const { result } = invoke(mode, 37)
      expect(result.status).toBe(37)
      expect(result.stderr).toContain('"exitCode":37')
    })
  }
})
```

The existing wrapper ownership guard requires the ordinary non-root repository test UID; do not bypass the production guard for this fixture.

- [ ] **Step 2: Run the test and verify intended failure**

Run from the primary worktree:

```bash
pnpm run test:vitest run test/unit/scripts/sandbox-test.test.ts --config config/vitest/vitest.config.ts
```

Expected: FAIL on absent `--cpus`/Cargo environment and absent JSONL resource receipt, with fake Docker calls recorded successfully.

- [ ] **Step 3: Implement bounded defaults and the minimal resource fixture**

Add `--cpus 2`, `--memory-swap 16g` and `-e CARGO_BUILD_JOBS=2` beside the existing shared `--memory 8g`. Explicit 16g RAM+swap preserves Docker's existing default allowance rather than silently removing swap. Keep the resource values in one shared defaults block used by both Docker arguments and the resource receipt, rather than duplicating independent literals. Emit `sandbox_resources` before launch and `sandbox_completed` immediately after collecting `DOCKER_STATUS`, preserving its exact exit code. Include the interface fields above and Global Constraint 7's controlled cause/action/outcome fields; failed completion uses error severity. Derive the implementation from the existing wrapper and exercise/parse both receipts in the behavioral wrapper test.

Add `xvfb` and `xauth` to the existing Dockerfile apt list. Do not add Linux packaging/deployment behavior. Verify actual Electron startup before deciding whether any further native runtime library is needed.

Create `scripts/testing/sandbox-budget-smoke.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const jobs = Number(process.argv[2])
assert([1, 2].includes(jobs))
assert.equal(Number(process.env.CARGO_BUILD_JOBS), jobs)
const read = name => fs.readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim()
const [quota, period] = read('cpu.max').split(' ').map(Number)
assert.equal(quota / period, 2)
assert.equal(read('memory.max'), '8589934592')
assert.equal(read('memory.swap.max'), '8589934592')
assert.equal(read('pids.max'), '512')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-budget-'))
const events = path.join(root, 'events.jsonl')
try {
  const members = Array.from({ length: 6 }, (_, i) => `unit${i}`)
  fs.writeFileSync(path.join(root, 'Cargo.toml'), `[workspace]\nresolver="2"\nmembers=${JSON.stringify(members)}\n`)
  for (const member of members) {
    fs.mkdirSync(path.join(root, member, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, member, 'Cargo.toml'), `[package]\nname="${member}"\nversion="0.1.0"\nedition="2021"\n`)
    fs.writeFileSync(path.join(root, member, 'src/lib.rs'), 'pub fn value() -> u8 { 1 }\n')
    fs.writeFileSync(path.join(root, member, 'build.rs'), `
use std::{env,fs::OpenOptions,io::Write,thread,time::{Duration,SystemTime,UNIX_EPOCH}};
fn main() {
 let start=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
 let held=vec![1u8;8*1024*1024];
 thread::sleep(Duration::from_millis(300));
 std::hint::black_box(&held);
 let end=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
 let mut f=OpenOptions::new().create(true).append(true).open(env::var("BUDGET_EVENTS").unwrap()).unwrap();
 let line=format!("{{\\"name\\":\\"${member}\\",\\"jobs\\":{},\\"start\\":\\"{}\\",\\"end\\":\\"{}\\"}}\\n",env::var("NUM_JOBS").unwrap(),start,end);
 f.write_all(line.as_bytes()).unwrap();
}
`)
  }
  execFileSync('cargo', ['build', '--workspace', '--offline', '--manifest-path', path.join(root, 'Cargo.toml')], {
    env: { ...process.env, BUDGET_EVENTS: events, CARGO_TARGET_DIR: path.join(root, 'target') },
    stdio: 'inherit', timeout: 120_000,
  })
  const rows = fs.readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 6)
  assert.equal(new Set(rows.map(row => row.name)).size, 6)
  for (const row of rows) assert.equal(row.jobs, jobs)
  const edges = rows.flatMap(row => [[BigInt(row.start), 1], [BigInt(row.end), -1]])
    .sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])
  let running = 0, peak = 0
  for (const [,delta] of edges) { running += delta; peak = Math.max(peak, running) }
  assert(peak >= 1 && peak <= jobs)
  const pressure = read('memory.pressure')
  const peakBytes = Number(read('memory.peak'))
  assert(peakBytes < 2 * 1024 ** 3)
  assert(Number(/some avg10=([0-9.]+)/.exec(pressure)[1]) < 5)
  console.log(JSON.stringify({ severity: 'info', event: 'sandbox_budget_smoke_passed', jobs, peakOverlap: peak, peakBytes, pressure }))
} finally { fs.rmSync(root, { recursive: true, force: true }) }
```

Timestamps are decimal strings to avoid JavaScript Number precision loss. This tiny fixture allocates at most 16 MiB in concurrent build scripts; it never ramps memory or aims for OOM. Its 2 GiB peak assertion concerns this entire tiny smoke container, not the real Clippy workload.

Extend the existing self-test before Proof 4 with two bounded calls using its existing status-capture convention. Use ordinary sandbox mode for this compile-only smoke: its Cargo build scripts must execute from `/tmp`, and the ordinary entrypoint can prepare fresh dependencies. Runtime-suite's noexec tmpfs/read-only root/no-network boundary stays unchanged and remains covered by the existing isolation proof and both-mode wrapper tests. Change its exact owned PID sentinel's `sleep 300` to `sleep 3600`, so bounded two-job preparation cannot make a healthy fixture expire during this now-longer test; the existing EXIT trap still stops only its exact recorded PID.

```bash
for budget in 1 2; do
  BUDGET_STATUS=0
  BUDGET_OUT="$("${REPO_ROOT}/scripts/sandbox-test.sh" "CARGO_BUILD_JOBS=${budget} node scripts/testing/sandbox-budget-smoke.mjs ${budget}" 2>&1)" || BUDGET_STATUS=$?
  if [ "${BUDGET_STATUS}" -eq 0 ]; then
    pass "effective cgroup controls and completed Cargo work at ${budget} jobs"
  else
    fail "Cargo budget proof failed at ${budget} jobs: ${BUDGET_OUT}"
  fi
done
```

For the real identified cold Clippy workload, reuse the already executed external bounded recipe and retained setup referenced by `reports/clippy-budget-prerequisite.md`; keep transient proof drivers and receipts outside the repository. Do not add a permanent cold-Clippy proof framework. Preserve its safety decisions: exact source archive, cold owned target volumes, verified rootful `system.slice` placement and finite resource controls before initialization/compilation, a live cgroup until final measurements, a self-owned sentinel and independent exact-resource cleanup.

The existing budgets-one/two results establish feasibility only. The chosen production default still needs current-branch/source and image attribution, real workload completion, matching effective Cargo/NUM_JOBS controls, measured headroom and cleanup evidence. The wrapper's actual argv/default behavior and minimal real resource smoke remain permanent behavioral coverage. Use the external recipe for the actual chosen-default workload; rerun the one-job alternative only if selecting it as a safer default, rather than repeating both already-proven budgets merely for feasibility.

- [ ] **Step 4: Run focused green tests and safe real proofs**

Run all real Docker/image/sandbox commands below inside the guarded private guest against its daemon and guest-owned source/caches. Recording-Docker unit tests remain ordinary non-destructive focused checks. Cloud-image preparation, if needed, follows the bounded serial ownership decision above.

```bash
pnpm run test:vitest run test/unit/scripts/sandbox-test.test.ts --config config/vitest/vitest.config.ts
bash -n scripts/sandbox-test.sh
bash -n scripts/sandbox-selftest.sh
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock scripts/sandbox-build.sh
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock scripts/sandbox-test.sh "node scripts/testing/sandbox-budget-smoke.mjs 2"
```

Expected: wrapper tests PASS; syntax succeeds; headless image builds; tiny Cargo work completes with finite effective controls and ample memory. Rebuild only in the explicitly chosen rootful daemon, without changing the operator's Docker context. Run the actual proof one container at a time after committing its source, with an already-created external evidence directory:

```bash
git add scripts/sandbox-test.sh docker/sandbox/Dockerfile scripts/sandbox-selftest.sh scripts/testing/sandbox-budget-smoke.mjs test/unit/scripts/sandbox-test.test.ts docs/development/test-sandbox.md
git commit -m "fix: bound sandbox build resources and prove safe compilation"
```

After the clean checkpoint, execute the retained external recipe for the chosen two-job default with this branch/source and image attribution. Expected: the identified cold workload completes at exit 0 with actual `system.slice` controls and headroom receipts. A one-job success cannot validate a two-job default. If two jobs fails/aborts, select and prove the safer one-job default and rerun wrapper/resource verification; do not increase/remove limits. Rootful placement and proof-only zero-swap are explicit safety choices, not claims about the old incident.

- [ ] **Step 5: Refactor while green**

Keep shared wrapper defaults in one argument block and resource-proof ownership/cleanup in small helpers. Do not add configurable schedulers, host Cargo settings or a collection of unrelated build-tool limits. Re-run focused tests after cleanup.

- [ ] **Step 6: Run impacted verification**

```bash
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock CARGO_BUILD_JOBS=2 scripts/sandbox-selftest.sh
pnpm run test:vitest run test/unit/scripts/sandbox-test.test.ts --config config/vitest/vitest.config.ts
```

Expected: all existing isolation/dependency-preparation proofs and new resource proofs PASS; exact self-owned host sentinels survive. Existing host Cargo comparison inherits the finite job budget. Because the Docker image supports shared test infrastructure, the parent also includes the full supported suite in the final guest gate. Image tags and named caches for this proof belong to the private guest daemon; the ordinary-user headless Electron path is actually launched in Task 3.

- [ ] **Step 7: Commit the task**

Step 4's checkpoint is the focused task commit when no source changes follow. If proof/refactor changes source, commit those named refinements and rerun the affected proof at that new SHA; do not rewrite another agent's commit. Use the following only when there are remaining task changes:

```bash
git add scripts/sandbox-test.sh docker/sandbox/Dockerfile scripts/sandbox-selftest.sh scripts/testing/sandbox-budget-smoke.mjs test/unit/scripts/sandbox-test.test.ts docs/development/test-sandbox.md
git commit -m "test: retain sandbox resource and workload proof refinements"
```

Document that explicit Cargo `--jobs` overrides can defeat a default, and that this repair does not guarantee arbitrary pressure elsewhere cannot affect a user slice. Record actual proof paths/hashes in the parent ledger/Kata rather than committing transient receipts or modifying live host settings.

### Task 2: Keep Electron recovery alive through bounded cooldowns

**Files:**
- Modify: `electron/renderer-recovery.ts:1`, `test/unit/electron/renderer-recovery.test.ts`.

**Interfaces:**
- Consumes: existing authenticated `loadUrl`, window proxy and injected timers/logger/verifier.
- Produces: `registerRendererRecovery(options: RendererRecoveryOptions): () => void`; returned disposer is idempotent and invalidates pending completions.
- Extends: `RecoverableWebContents.removeListener?(event: string, callback: (...args: any[]) => void): void`.
- Retains: existing trigger semantics and log names, plus `main_window_recovery_scheduled`, cooldown `retryInMs`, and `main_window_recovery_cancelled`.

- [ ] **Step 1: Add failing behavioral tests**

Append these inside the existing `describe('registerRendererRecovery', ...)`, reusing its real EventEmitter fixture and fake timers:

```ts
it('retries across successive rolling windows without a second external event', async () => {
  let available = false
  const verifyRecovered = vi.fn(async () => { if (!available) throw new Error('offline') })
  const dispose = registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout, verifyRecovered })
  window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', loadUrl, true)
  await vi.advanceTimersByTimeAsync(1_250)
  expect(window.loadURL).toHaveBeenCalledTimes(3)
  expect(logger.log.mock.calls.some(([e]) => e.event === 'main_window_recovery_succeeded')).toBe(false)
  await vi.advanceTimersByTimeAsync(58_749)
  expect(window.loadURL).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(window.loadURL).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(6_000)
  expect(window.loadURL).toHaveBeenCalledTimes(6)
  available = true
  await vi.advanceTimersByTimeAsync(54_000)
  expect(window.loadURL).toHaveBeenCalledTimes(7)
  expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'main_window_recovery_succeeded' }))
  expect(vi.getTimerCount()).toBe(0)
  dispose()
})

it.each([true, false])('retains in-flight navigation failure when native load rejects=%s', async rejects => {
  let settle!: () => void
  window.loadURL.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
    settle = () => rejects ? reject(new Error('refused')) : resolve()
  }))
  const dispose = registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout })
  window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', loadUrl, true)
  window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', loadUrl, true)
  settle()
  await vi.advanceTimersByTimeAsync(0)
  expect(window.focus).not.toHaveBeenCalled()
  expect(logger.log.mock.calls.filter(([e]) => e.event === 'main_window_recovery_succeeded')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(250)
  expect(window.loadURL).toHaveBeenCalledTimes(2)
  expect(window.focus).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  dispose()
})

it('disposes cooldowns and ignores an already pending verifier completion', async () => {
  let resolve!: () => void
  const verifyRecovered = vi.fn(() => new Promise<void>(done => { resolve = done }))
  const dispose = registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout, verifyRecovered })
  window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', loadUrl, true)
  await vi.advanceTimersByTimeAsync(0)
  dispose()
  resolve()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(window.loadURL).toHaveBeenCalledTimes(1)
  expect(window.focus).not.toHaveBeenCalled()
  expect(logger.log.mock.calls.some(([e]) => e.event === 'main_window_recovery_succeeded')).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  expect(window.webContents.listenerCount('did-fail-load')).toBe(0)
})

it('does not turn its deliberate unresponsive crash into a redundant recovery', async () => {
  window.webContents.forcefullyCrashRenderer.mockImplementation(() => {
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
  })
  const dispose = registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout })
  window.webContents.emit('unresponsive')
  await vi.advanceTimersByTimeAsync(15_000)
  expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  dispose()
})
```

Add these concrete additional cases inside the same suite:

```ts
it.each([0, 1_250])('disposes a retained retry after %s ms', async elapsed => {
  window.loadURL.mockRejectedValue(new Error('offline'))
  const dispose = registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout })
  window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', loadUrl, true)
  await vi.advanceTimersByTimeAsync(elapsed)
  const attempts = window.loadURL.mock.calls.length
  expect(vi.getTimerCount()).toBe(1)
  dispose()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(window.loadURL).toHaveBeenCalledTimes(attempts)
  expect(vi.getTimerCount()).toBe(0)
})

it('responsive cancels unresponsive backoff but retains a newer navigation failure', async () => {
  const verifyRecovered = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
  const dispose = registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout, verifyRecovered })
  window.webContents.emit('unresponsive')
  await vi.advanceTimersByTimeAsync(15_000)
  window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', loadUrl, true)
  window.webContents.emit('responsive')
  await vi.advanceTimersByTimeAsync(250)
  expect(window.loadURL).toHaveBeenCalledTimes(1)
  expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  dispose()
})

it('responsive cancels an unresponsive-only retry before its backoff expires', async () => {
  const verifyRecovered = vi.fn().mockRejectedValueOnce(new Error('offline'))
  const dispose = registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout, verifyRecovered })
  window.webContents.emit('unresponsive')
  await vi.advanceTimersByTimeAsync(15_000)
  window.webContents.emit('responsive')
  await vi.advanceTimersByTimeAsync(250)
  expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  dispose()
})

it.each([[-3, true], [-102, false]])('ignores aborted or subframe failure %s/%s', async (code, mainFrame) => {
  const dispose = registerRendererRecovery({ window, loadUrl, serverUrl, logger, setTimeout, clearTimeout })
  window.webContents.emit('did-fail-load', {}, code, 'ignored failure', loadUrl, mainFrame)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(window.loadURL).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  dispose()
})
```

Replace the old permanent-circuit test and its delayed-second-unresponsive variant with the stronger autonomous-window and immediate-responsive cases above. Replace any unbounded `runAllTimersAsync` in permanent-failure cases with explicit clock advancement. Retain the existing in-flight diagnostic `main_window_recovery_skipped` with `reason: recovery-in-flight`; behavior remains one in-flight attempt, now with the failure retained for its successor.

- [ ] **Step 2: Run red**

```bash
pnpm run test:vitest run test/unit/electron/renderer-recovery.test.ts --config config/vitest/vitest.electron.config.ts
```

Expected: FAIL because the second attempt/window never starts autonomously, a resolving native action can falsely succeed after its failure event, and no disposer exists.

- [ ] **Step 3: Implement the controller scheduling and logical lifecycle**

Keep the existing request types/constants and add optional listener removal. Implement one pending request, one recovery timer and one in-flight recovery action per logical window. Failure settlement schedules one successor without another external event. At the rolling limit, retain the request and schedule its next eligible time; a timer callback rechecks liveness/capacity without charging backoff twice. Preserve trigger precedence, expected self-induced renderer-gone handling, inert subframe/aborted navigation, and cancellation of only an obsolete unresponsive request when responsiveness returns.

The disposer is idempotent, removes supported listeners, clears recovery/unresponsive timers and makes late completions inert. Emit success/show/focus only after a current live action and verifier succeed without an observed main-frame failure. Task 3 supplies the bounded native-action/readiness promise and permanent cancellation hook; a timeout rejection must follow the same retry path as other action failures. Do not assume native load completion itself has a finite duration. The invalidated draft implementation has been removed; derive code from the current source/interfaces and behavioral tests rather than copying an unexecuted replacement.

Keep coalesced events from creating overlapping attempts or multiple successors. The optional deterministic verifier used by non-native tests is not production acceptance; Task 3 must wire and exercise actual native verification. Keep the established structured events, token redaction and bounded log volume.

- [ ] **Step 4: Run focused green**

```bash
pnpm run test:vitest run test/unit/electron/renderer-recovery.test.ts --config config/vitest/vitest.electron.config.ts
```

Expected: PASS, including seven autonomous attempts across two windows with no overlapping attempts or dangling timer after success/disposal.

- [ ] **Step 5: Refactor while green**

Retain the small `merge`, `drain`, `startIfCapacity`, and `dispose` responsibilities. Remove superseded old timer/request helpers and update test names that described terminal circuit behavior. Preserve reload-unavailable logging and the existing destroyed-webContents fallback; logical window destruction still disposes. Do not introduce a second retry manager or a production timing override. Re-run the same focused command after cleanup.

- [ ] **Step 6: Run impacted verification**

```bash
pnpm run test:vitest run test/unit/electron/renderer-recovery.test.ts test/unit/electron/startup.test.ts test/unit/electron/main.test.ts --config config/vitest/vitest.electron.config.ts
pnpm run typecheck
pnpm exec tsc -p tsconfig.electron.json --noEmit
```

Expected: existing startup/lifecycle behavior and new retry tests PASS, with typechecking green. Native readiness and actual long-outage acceptance follow in Task 3; do not claim the user-visible fix complete at this controller checkpoint.

- [ ] **Step 7: Commit the task**

```bash
git add electron/renderer-recovery.ts test/unit/electron/renderer-recovery.test.ts
git commit -m "fix: resume Electron recovery after bounded cooldowns"
```

### Task 3: Verify the native document and recover a real long Electron outage

**Files:**
- Create: `electron/renderer-readiness.ts`, `electron/recoverable-window.ts`.
- Modify: `electron/startup.ts:14`, `electron/startup.ts:120`, `electron/startup.ts:211`, `electron/entry.ts:85`, `electron/entry.ts:270`, `electron/entry.ts:711`, `electron/main.ts:14`, `electron/main.ts:107`.
- Test: `test/unit/electron/renderer-readiness.test.ts`, `test/unit/electron/recoverable-window.test.ts`, `test/unit/electron/startup.test.ts`, `test/unit/electron/main.test.ts`, `test/e2e-electron/electron-app.test.ts:191`.

**Interfaces:**
- Consumes: Task 2's controller disposer; Task 1's bounded headless sandbox.
- Produces: native readiness of the intended current candidate document, using the same finite adaptive complete-attempt deadline from Stage 2 decision 8, starting before native navigation, and 100 ms polling within remaining time. Hung evaluation and native load are cancellable; no production timing override is added.
- Produces: `createRecoverableWindow({createNativeWindow, options, onWebContentsChanged, logger}): BrowserWindowLike` with `verifyRendererReady(loadUrl)` and `cancelRecovery()` methods.
- Produces: main `StartupResult.disposeRendererRecovery(): void`; permanent disposal clears controller timers and aborts current native/load/verification work. Attempt deadline retirement allows future retries. Main startup installs listeners before `loadURL` and passes an actual native verifier. Logical close, new launch generation and quit dispose; retiring old native windows and hide-to-tray do not.

- [ ] **Step 1: Add failing readiness, adapter and startup behavior tests**

Create `test/unit/electron/renderer-readiness.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyRendererReady } from '../../../electron/renderer-readiness.js'

describe('native document readiness', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const url = 'http://localhost:4455/?token=secret'
  function fixture(snapshot: Record<string, unknown>) {
    return { isDestroyed: () => false, webContents: { isDestroyed: () => false,
      executeJavaScript: vi.fn().mockResolvedValue(snapshot) } }
  }
  const mounted = { href: 'http://localhost:4455/', documentUri: 'http://localhost:4455/', ready: true, mounted: true }
  it('accepts the mounted intended document after the client removes its token', async () => {
    await expect(verifyRendererReady(fixture(mounted), url)).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    { ...mounted, href: 'http://other-host:4455/' },
    { ...mounted, documentUri: 'chrome-error://chromewebdata/' },
    { ...mounted, mounted: false },
    { ...mounted, ready: false },
  ])('rejects unusable document %j at its bounded deadline', async snapshot => {
    const result = verifyRendererReady(fixture(snapshot), url)
    const assertion = expect(result).rejects.toThrow('renderer readiness timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
  it('waits for delayed mount and rejects a changed navigation generation', async () => {
    const window = fixture(mounted)
    window.webContents.executeJavaScript.mockResolvedValueOnce({ ...mounted, mounted: false })
    const ready = verifyRendererReady(window, url)
    await vi.advanceTimersByTimeAsync(100)
    await expect(ready).resolves.toBeUndefined()
    await expect(verifyRendererReady(window, url, { isCurrent: () => false })).rejects.toThrow('navigation changed')
  })
  it('cancels a hung native evaluation and clears its deadline', async () => {
    const window = fixture(mounted)
    window.webContents.executeJavaScript.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const ready = verifyRendererReady(window, url, { signal: controller.signal })
    const assertion = expect(ready).rejects.toThrow('renderer recovery cancelled')
    controller.abort()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
})
```

Create adapter tests against the injectable native constructor rather than importing Electron's runtime entry. Native fake windows are EventEmitters with `webContents` as an EventEmitter, a recorded `executeJavaScript`, `loadURL`, `destroy`, `show`, `focus` and the existing bounds/visibility/maximize methods. The following is the complete central fake and critical replacement/lifecycle test:

```ts
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRecoverableWindow } from '../../../electron/recoverable-window.js'

function native(id: number) {
  let destroyed = false
  let url = 'http://localhost:4455/'
  const wc = Object.assign(new EventEmitter(), {
    id, getURL: () => url, isDestroyed: () => destroyed,
    forcefullyCrashRenderer: vi.fn(),
    executeJavaScript: vi.fn(async () => ({ href: url, documentUri: url, ready: true, mounted: true })),
  })
  const win = Object.assign(new EventEmitter(), {
    webContents: wc, loadURL: vi.fn(async (next: string) => { url = next }),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => { destroyed = true; win.emit('closed') }),
    show: vi.fn(), hide: vi.fn(), focus: vi.fn(), maximize: vi.fn(), restore: vi.fn(),
    isVisible: () => true, isFocused: () => true, isMaximized: () => false, isMinimized: () => false,
    getBounds: () => ({ x: 1, y: 2, width: 800, height: 600 }),
  })
  return win
}

afterEach(() => vi.useRealTimers())
describe('logical native window', () => {
  it('verifies the candidate before changing IPC identity and ignores retired close', async () => {
    const windows: ReturnType<typeof native>[] = []
    const identity = vi.fn()
    const window = createRecoverableWindow({
      createNativeWindow: () => { const win = native(windows.length + 1); windows.push(win); return win },
      options: {}, onWebContentsChanged: identity, logger: { log: vi.fn() },
    })
    await window.loadURL('http://localhost:4455/?token=secret')
    const closed = vi.fn()
    window.on('closed', closed)
    await window.webContents!.reload!()
    expect(windows[1].webContents.executeJavaScript).toHaveBeenCalled()
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1, 2])
    expect(windows[0].destroy).toHaveBeenCalledOnce()
    expect(closed).not.toHaveBeenCalled()
    windows[1].destroy()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('destroys a candidate resolving after logical disposal without activating or focusing it', async () => {
    const windows: ReturnType<typeof native>[] = []
    let resolve!: () => void
    const identity = vi.fn()
    const window = createRecoverableWindow({ options: {}, onWebContentsChanged: identity, logger: { log: vi.fn() },
      createNativeWindow: () => {
        const win = native(windows.length + 1)
        if (windows.length) win.loadURL.mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
        windows.push(win); return win
      },
    })
    await window.loadURL('http://localhost:4455/')
    const replacement = window.webContents!.reload!() as Promise<void>
    const assertion = expect(replacement).rejects.toThrow('renderer recovery cancelled')
    window.cancelRecovery!()
    resolve()
    await assertion
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1])
    expect(windows[1].destroy).toHaveBeenCalledOnce()
    expect(windows[1].show).not.toHaveBeenCalled()
    expect(windows[1].focus).not.toHaveBeenCalled()
  })
})
```

Add these complementary adapter cases inside the same describe:

```ts
it('rejects an unusable candidate and preserves the original IPC identity', async () => {
  vi.useFakeTimers()
  const windows: ReturnType<typeof native>[] = []
  const identity = vi.fn()
  const window = createRecoverableWindow({ options: {}, onWebContentsChanged: identity, logger: { log: vi.fn() },
    createNativeWindow: () => {
      const win = native(windows.length + 1)
      if (windows.length) win.webContents.executeJavaScript.mockResolvedValue({ href: 'chrome-error://chromewebdata/', documentUri: 'chrome-error://chromewebdata/', ready: true, mounted: false })
      windows.push(win); return win
    },
  })
  await window.loadURL('http://localhost:4455/')
  window.hide()
  const replacement = window.webContents!.reload!() as Promise<void>
  const assertion = expect(replacement).rejects.toThrow('renderer readiness timed out')
  await vi.advanceTimersByTimeAsync(10_000)
  await assertion
  expect(identity.mock.calls.map(([id]) => id)).toEqual([1])
  expect(windows[0].destroy).not.toHaveBeenCalled()
  expect(windows[1].destroy).toHaveBeenCalledOnce()
})

it('removes a controller listener from active and pending native candidates', async () => {
  const windows: ReturnType<typeof native>[] = []
  let resolve!: () => void
  const window = createRecoverableWindow({ options: {}, onWebContentsChanged: vi.fn(), logger: { log: vi.fn() },
    createNativeWindow: () => {
      const win = native(windows.length + 1)
      if (windows.length) win.loadURL.mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
      windows.push(win); return win
    },
  })
  await window.loadURL('http://localhost:4455/')
  const listener = vi.fn()
  window.webContents!.on('did-fail-load', listener)
  const replacement = window.webContents!.reload!() as Promise<void>
  window.webContents!.removeListener!('did-fail-load', listener)
  for (const win of windows) win.webContents.emit('did-fail-load', {}, -102, 'refused', '', true)
  expect(listener).not.toHaveBeenCalled()
  resolve()
  await replacement
})
```

Add this startup integration test inside its existing suite, using `createDefaultContext`/`createMockWindowWithWebContents`:

```ts
it('observes a synchronous initial navigation failure and retries the encoded destination', async () => {
  vi.useFakeTimers()
  const window = createMockWindowWithWebContents()
  const logger = { log: vi.fn() }
  const loads = window.loadURL as ReturnType<typeof vi.fn>
  loads.mockImplementationOnce(async (url: string) => {
    window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, true)
    throw new Error('offline')
  }).mockResolvedValue(undefined)
  const verifier = vi.fn(async () => {})
  const ctx = createDefaultContext({ createBrowserWindow: () => window,
    mainProcessLogger: logger, rendererRecoveryVerifier: verifier,
    readEnvToken: async () => 'a+b&c#d',
  })
  let result: Awaited<ReturnType<typeof runStartup>> | undefined
  try {
    result = await runStartup(ctx)
    await vi.advanceTimersByTimeAsync(0)
    expect(result.type).toBe('main')
    expect(loads.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(new Set(loads.mock.calls.map(([url]) => url)).size).toBe(1)
    expect(loads.mock.calls[0][0]).toContain('token=a%2Bb%26c%23d')
    expect(verifier).toHaveBeenCalledWith(window, loads.mock.calls[0][0])
    expect(ctx.serverSpawner.start).toHaveBeenCalledTimes(1)
    expect(ctx.serverSpawner.stop).not.toHaveBeenCalled()
  } finally {
    if (result?.type === 'main') { result.disposeRendererRecovery?.(); clearTimeout(result.updateCheckTimer) }
    vi.useRealTimers()
  }
})
```

The `finally` cleanup prevents failed assertions from contaminating later fake-clock tests.

Add this quit-order test inside `main.test.ts`'s existing `describe('initMainProcess', ...)`:

```ts
it('disposes recovery once at quit initiation before waiting for the server', async () => {
  const order: string[] = []
  let release!: () => void
  deps.disposeRendererRecovery = vi.fn(() => { order.push('dispose') })
  deps.stopServer = vi.fn(() => { order.push('stop'); return new Promise<void>(done => { release = done }) })
  await initMainProcess(deps)
  const close = mockWindow.on.mock.calls.find(([event]: [string]) => event === 'close')![1]
  close({ preventDefault: vi.fn() })
  expect(deps.disposeRendererRecovery).not.toHaveBeenCalled()
  app.emit('before-quit', { preventDefault: vi.fn() })
  app.emit('before-quit', { preventDefault: vi.fn() })
  expect(order).toEqual(['dispose', 'stop'])
  expect(app.quit).not.toHaveBeenCalled()
  release()
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
})
```

Add behavioral cases alongside these drafts for an active native load and a candidate load that never settle, and for a hung native evaluation. Advance the complete attempt deadline without manually resolving those promises: the timed-out attempt must retire, reject and release the sole slot; the controller must later retry successfully without another event. Dispose during the same hung states and prove prompt permanent cancellation with no future work. Then settle every stale native result and prove it cannot activate a candidate, update privileged IPC identity, show/focus, emit success or interfere with a newer attempt. Assert that old-native destruction cannot dispose its successful logical replacement and that hide-to-tray preserves recovery. These tests exercise actual ownership behavior, not source text or an assumed native promise guarantee.

Add a fake-clock regression in which each valid navigation/mount takes longer than the initial 10,000 ms budget: after the first timeout, an automatically retried attempt must receive the increased budget and succeed without another event. Cover repeated deadline expirations and cooldowns retaining the increased budget, verified success resetting it, and logical disposal cancelling promptly at any budget. Do not replace this with a fast mock or a timing override. The first-attempt timeout drafts above still exercise the initial budget.

- [ ] **Step 2: Run red**

```bash
pnpm run test:vitest run test/unit/electron/renderer-readiness.test.ts test/unit/electron/recoverable-window.test.ts test/unit/electron/startup.test.ts test/unit/electron/main.test.ts --config config/vitest/vitest.electron.config.ts
```

Expected: new modules are absent initially; then the meaningful startup case fails because listeners are installed after the first navigation. Confirm these intended missing behaviors, rather than counting a syntax/fixture failure as red evidence.

- [ ] **Step 3: Implement actual native readiness, complete-attempt ownership and startup wiring**

Extract only the existing native adapter and tiny listener types from `entry.ts` into `recoverable-window.ts`, keeping the native constructor injectable for meaningful adapter tests. Give that existing logical owner one finite cancellable attempt spanning native load/replacement and readiness. Apply Stage 2 decision 8's adaptive budget before awaiting any native navigation; readiness polling consumes the remaining budget rather than resetting it after navigation. Timeout growth must persist across retries/cooldowns and must not impose the same deadline forever on a slow valid load. A hung `loadURL` or evaluation must reject on deadline/cancellation and retire its prior native authority before a successor proceeds. Do not implement a timeout race that leaves a candidate able to activate later. Preserve future retries after attempt timeout; permanent logical disposal separately prevents all later work. The invalidated controller/adapter/readiness production-code drafts were removed; no replacement production code is presumed executed or correct.

Verify the actual native candidate: both current native URL and evaluated document must match the immutable intended origin/path, the document must be ready and Freshell's root must contain mounted content, and its navigation generation/native identity must still be current. Query equality is intentionally absent because auth bootstrap removes the URL token. Authentication, machine-selection and preparing roots are sufficient; no terminal/pane or Redux/WebSocket addition is required. Reject error pages, wrong documents, expired budgets, cancellation, destroyed objects and stale generations. Use no polling-tick logs.

Preserve the adapter's authenticated recovery destination, geometry/maximize/visibility/focus, preload and privileged IPC identity contract. Verify a hidden replacement before making it active or giving it privileged authority; on failure/retirement destroy only that candidate and keep the surviving active native window. Logical event delivery must distinguish the active/candidate/retired native emitters: destroying a retired native cannot close/dispose the successful logical replacement. Remove bindings for retired windows so repeated recoveries do not retain them. A late timed-out candidate cannot become active, update IPC identity or affect current visibility/focus. Keep one owner and one active recovery authority, without a second reconnect manager.

Update `BrowserWindowLike` and the production startup context to expose the needed actual readiness/permanent-cancellation boundary. Install recovery listeners before the initial `loadURL`, retain initial-load/unavailable diagnostics, and return `disposeRendererRecovery` on the main startup result. Production always uses the actual native verifier; deterministic test fakes must opt into an explicit verifier rather than silently inheriting a production no-op.

Keep the current result's disposer at entry ownership. Dispose old-target recovery at each new `main()` generation and wire the current disposer to logical close and the first quit transition before asynchronous server stopping. Hiding to tray and retiring an old native do not dispose. Constructor injection remains the real Electron `BrowserWindow` with its existing preload; update trusted `mainWebContentsId` only for the verified current candidate. Test repeated before-quit delivery, destination changes and stale completion through these real seams. Reconcile exact source interfaces during implementation rather than introducing unused lifecycle methods.

- [ ] **Step 4: Add and run the real long-outage acceptance test**

Add `serverHome: string | undefined` alongside the existing renderer-recovery fixture variables. In its existing `afterEach`, capture `const serverHomeToRemove = serverHome`, clear the variable with the other fixture handles, define this closure and pass `removeHome: removeOwnedHomes` to the existing cleanup call:

```ts
const removeOwnedHomes = async () => {
  const ownedHomes = [homeToRemove, serverHomeToRemove].filter((home): home is string => typeof home === 'string')
  await Promise.all(ownedHomes.map(home => fs.promises.rm(home, { recursive: true, force: true })))
}
```

This remains inside `cleanupElectronFixture`, which removes HOME only after exact owned server teardown succeeds. Reuse its existing app/server cleanup, `stopOwnedServerAndVerify`, remote configuration, exact build assertion and log location. Add a helper in that group:

```ts
function recoveryEvents(): Array<Record<string, any>> {
  const logs = path.join(tmpHome!, '.freshell', 'logs')
  if (!fs.existsSync(logs)) return []
  return fs.readdirSync(logs).filter(name => /^electron-main\..*\.jsonl$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(logs, name), 'utf8').split('\n'))
    .filter(Boolean).map(line => JSON.parse(line))
}
```

Add this test; it intentionally uses the production 60-second rate window:

```ts
test('recovers autonomously when an endpoint returns after the real cooldown', async () => {
  test.setTimeout(240_000)
  serverHome = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-outage-server-'))
  server = new RustServer({ homeDir: serverHome, preserveHomeOnStop: true,
    expectedBuildCommit: requireElectronE2eBuildId(), expectedBuildDirty: false })
  serverInfo = await server.start()
  tmpHome = createTempHome(remoteConfig(serverInfo))
  app = await launchApp(tmpHome, true)
  const initial = await app.firstWindow()
  await expect(initial.locator('text=New Tab').first()).toBeVisible({ timeout: 30_000 })
  const savedUrl = `${serverInfo.baseUrl}/?token=${encodeURIComponent(serverInfo.token)}`
  const receipt = serverInfo
  const token = serverInfo.token, port = serverInfo.port
  await stopOwnedServerAndVerify(server, receipt)
  server = undefined
  serverInfo = undefined
  const logOffset = recoveryEvents().length
  const outageStarted = Date.now()
  await app.evaluate(async ({ BrowserWindow }, target) => {
    await BrowserWindow.getAllWindows()[0].loadURL(target).catch(() => {})
  }, savedUrl)
  await expect.poll(() => recoveryEvents().slice(logOffset)
    .some(e => e.event === 'main_window_recovery_circuit_open'), { timeout: 60_000 }).toBe(true)
  // Actual attempt after expiry is required; a cooldown log alone is insufficient.
  await expect.poll(() => recoveryEvents().slice(logOffset)
    .filter(e => e.event === 'main_window_recovery_started').length,
    { timeout: 90_000 }).toBeGreaterThanOrEqual(4)
  await expect.poll(() => Date.now() - outageStarted, { timeout: 15_000 }).toBeGreaterThan(65_000)
  expect(recoveryEvents().slice(logOffset).filter(e => e.event === 'main_window_recovery_succeeded')).toEqual([])
  server = new RustServer({ port, token, homeDir: serverHome, preserveHomeOnStop: true,
    expectedBuildCommit: requireElectronE2eBuildId(), expectedBuildDirty: false })
  serverInfo = await server.start()
  // No navigation, crash event, reload, or Electron restart occurs after this restore.
  await expect.poll(() => recoveryEvents().slice(logOffset)
    .some(e => e.event === 'main_window_recovery_succeeded'), { timeout: 75_000 }).toBe(true)
  const recovered = await waitForWindowUrl(app,
    new RegExp(`^${escapeRegExp(serverInfo.baseUrl)}(?:[/?#]|$)`), 15_000)
  await expect(recovered.locator('text=New Tab').first()).toBeVisible({ timeout: 15_000 })
  await recovered.locator('button[title^="Settings"]').click()
  await expect(recovered.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
})
```

The settings selector matches `Sidebar.tsx`'s `title="Settings (Ctrl+B ,)"` button and `SettingsView.tsx`'s `h1`. The existing healthy forced-crash test and its privileged external-link IPC assertion remain and must pass, proving replacement preload/IPC identity alongside this navigation-outage path. Preserve Rust HOME/token/port across the fixture-only stop/start; there is no discovery sweep to live development ports.

Run focused tests, typecheck and commit a clean checkpoint before canonical E2E; its launcher requires clean exact-HEAD source and rebuilds the client, Electron main and release Rust binary itself:

```bash
pnpm run test:vitest run test/unit/electron/renderer-recovery.test.ts test/unit/electron/renderer-readiness.test.ts test/unit/electron/recoverable-window.test.ts test/unit/electron/startup.test.ts test/unit/electron/main.test.ts --config config/vitest/vitest.electron.config.ts
pnpm run typecheck
pnpm exec tsc -p tsconfig.electron.json --noEmit
git add electron/renderer-readiness.ts electron/recoverable-window.ts electron/startup.ts electron/entry.ts electron/main.ts test/unit/electron/renderer-readiness.test.ts test/unit/electron/recoverable-window.test.ts test/unit/electron/startup.test.ts test/unit/electron/main.test.ts test/e2e-electron/electron-app.test.ts
git commit -m "fix: verify native Electron recovery and cancel retired work"
```

Use the clean standalone committed source checkout already staged under the private guest's `/workspace`, with internal Git objects and exact SHA equality to the reviewed authoring worktree. It is a disposable test fixture, never an authoring checkout. Execute the canonical sandbox wrapper from that checkout **inside the private outer guest**, against the guest daemon's `/var/run/docker.sock`; do not use host source paths, the host daemon or host named volumes. Its command remains `xvfb-run -a pnpm run test:e2e:electron --grep 'Renderer crash recovery'`. Keep inherited build-ID overrides absent and let the canonical runner build the exact clean source itself. Export command output, selected names/count, real timing, native JSONL, exact source/image/resource/fixture ownership and teardown receipts to this run's external evidence directory before guest cleanup. Qualify any ordinary-user Chromium/display/library setup inside that owned environment and rerun the actual canonical cases. No unexecuted host clone/socket command is supplied as an isolation recipe.

Expected: actual selected tests include both healthy crash/IPC recovery and the long-outage scenario; both PASS in the bounded disposable container. No success logs occur during the outage. No client event is supplied after endpoint restoration. Keep the exact clone path as a test-owned cleanup receipt; remove it only after logs/results have been copied to the external evidence directory. Do not fall back to raw Playwright, stale dist, skipped tests or host-side process-kill execution.

- [ ] **Step 5: Refactor while green**

Keep document verification separate from retry scheduling and native replacement. Remove duplicated inline adapter types/imports and unused lifecycle methods. Prune retired native windows from listener binding maps after removal so repeated recoveries do not retain destroyed windows. Keep all current windows' removal semantics and close filtering intact. Review cancellation races at every awaited action and candidate activation; no polling-tick logging is needed. Re-run the focused command after cleanup.

- [ ] **Step 6: Run impacted verification**

```bash
pnpm run test:vitest run test/unit/electron --config config/vitest/vitest.electron.config.ts
pnpm run typecheck
```

Expected: all Electron unit/integration tests PASS. Repeat canonical sandbox `Renderer crash recovery` only if refactoring or fixes changed the code exercised by its prior successful run; that run's commit must match the final reviewed source. The parent full supported gate covers startup, entry and shared test infrastructure across the repository. Electron sandbox coverage proves actual platform-independent reconnect/native-window behavior; a Windows installed-artifact smoke remains a separately approved deployment/user verification, not authorization to touch the running DANDESKTOP app.

- [ ] **Step 7: Commit remaining task refinements**

```bash
git add electron/renderer-readiness.ts electron/recoverable-window.ts electron/startup.ts electron/entry.ts electron/main.ts test/unit/electron/renderer-readiness.test.ts test/unit/electron/recoverable-window.test.ts test/unit/electron/startup.test.ts test/unit/electron/main.test.ts test/e2e-electron/electron-app.test.ts
git commit -m "test: prove Electron recovery beyond a real server outage"
```

Only create this second commit if E2E/refactor changed source after the checkpoint. Otherwise the checkpoint is this task's focused commit. Keep external timing/log receipts outside the clean source checkout.

### Task 4: Recover either failed user manager and prove enabled services return

**Owning repository:** `/home/dan/code/machines/.worktrees/freshell-user-manager-recovery` only.

**Files:**
- Modify: `garageserver/sentinelx/bin/sentinelx-oomd-watchdog:26`, `tests/test-sentinelx-janitor.sh:382`, `garageserver/docs/sentinelx-sandbox.md`, `garageserver/sentinelx/AGENTS.md`.
- Create/Test: `tests/test-oomd-watchdog.py`, `tests/smoke-oomd-watchdog.sh`, `tests/systemd-watchdog/Dockerfile`, `tests/systemd-watchdog/guest-smoke.sh`.

**Interfaces:**
- Consumes: unchanged command seams `FRESHELL_OOMCTL`, `FRESHELL_SYSTEMCTL`, `FRESHELL_WATCHDOG_SETTLE` and fixed UID order `1001 1000`.
- Produces: the same state policy for both UIDs: registered→silent; failed→one `start`; inactive→leave stopped; active/missing→one aggregate oomd restart; transient/unknown→wait. A failing start does not block the other UID's independent recovery, but final exit remains nonzero.
- Produces: valid JSONL with existing uppercase `level`, lowercase `severity`, UID/unit, observed state, action, result and command failure code. A failed dump is diagnosed and still allows state-sensitive recovery; an empty/failed state query never authorizes mutation.
- Preserves: 15-minute timer, root-owned watchdog independence, no host oomd policy/unit/timer edits and no live deployment.

- [ ] **Step 1: Validate real-systemd feasibility safely and add failing policy tests**

First create only the guest Dockerfile, guest-smoke script and outer driver described in Step 3 below, copying the watchdog source unchanged. Build/run that owned fixture only as far as `--probe`, before implementing the watchdog policy. The parent has already proved the underlying bounded private remount/systemd/D-Bus capability; this rechecks it with the actual fixture image and source. It must establish actual rootful placement, a private cgroup namespace, enforced resource limits and a guest systemd-created child cgroup. It must not kill a manager at this stage. If this probe regresses, report the explicit system-level coverage gap to the parent before continuing the task; never replace this proof with shared-host operations.

Create `tests/test-oomd-watchdog.py`. This executes the actual Bash watchdog against executable per-call fakes, records exact argv arrays, parses every emitted JSON line, and models normal nonzero `is-active` codes:

```python
#!/usr/bin/env python3
import json, os, pathlib, subprocess, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
WATCHDOG = ROOT / 'garageserver/sentinelx/bin/sentinelx-oomd-watchdog'
FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['WATCHDOG_CASE'])
config = json.loads((root/'case.json').read_text())
statefile = root/'state.json'
state = json.loads(statefile.read_text()) if statefile.exists() else {}
def count(key):
    value = state.get(key,0); state[key] = value+1
    statefile.write_text(json.dumps(state)); return value
args = sys.argv[1:]
if pathlib.Path(sys.argv[0]).name == 'oomctl':
    n = count('dump')
    failures = config.get('dumpCodes',[0])
    code = failures[min(n,len(failures)-1)]
    if code: sys.exit(code)
    frames = config.get('registered',[[1000,1001]])
    for uid in frames[min(n,len(frames)-1)]:
        print(f'user.slice/user-{uid}.slice/user@{uid}.service present')
    if config.get('misleading'): print('unrelated user@1000 user@1001 text')
    sys.exit(0)
with (root/'calls.jsonl').open('a') as out: out.write(json.dumps(args)+'\n')
if args[0] == 'is-active':
    uid = args[1].split('@')[1].split('.')[0]
    rows = config.get('states',{}).get(uid,[['active',0]])
    n = count('state'+uid); value,code = rows[min(n,len(rows)-1)]
    if value: print(value)
    sys.exit(code)
if args[0] == 'start': sys.exit(config.get('startCodes',{}).get(args[1],0))
if args == ['restart','systemd-oomd.service']: sys.exit(config.get('restartCode',0))
sys.exit(93)
'''

class WatchdogPolicy(unittest.TestCase):
    def run_case(self, config):
        with tempfile.TemporaryDirectory(prefix='watchdog-case-') as name:
            root = pathlib.Path(name)
            (root/'case.json').write_text(json.dumps(config))
            for tool in ('oomctl','systemctl'):
                path=root/tool; path.write_text(FAKE); path.chmod(0o755)
            env=dict(os.environ, WATCHDOG_CASE=name, FRESHELL_OOMCTL=str(root/'oomctl'),
                FRESHELL_SYSTEMCTL=str(root/'systemctl'), FRESHELL_WATCHDOG_SETTLE='0')
            result=subprocess.run(['bash',str(WATCHDOG)],env=env,text=True,capture_output=True,timeout=10)
            self.assertEqual(result.stderr,'')
            events=[json.loads(line) for line in result.stdout.splitlines() if line]
            calls=[json.loads(line) for line in (root/'calls.jsonl').read_text().splitlines()] if (root/'calls.jsonl').exists() else []
            for event in events:
                self.assertIn(event['severity'],('info','warn','error'))
                if event['event'].startswith('user_manager_'):
                    self.assertIn(event['uid'],(1000,1001))
                    self.assertEqual(event['unit'],f"user@{event['uid']}.service")
                    self.assertIn('action',event); self.assertIn('result',event)
            return result.returncode,calls,events

    def test_same_state_policy_for_each_uid(self):
        for uid in (1000,1001):
            other=1001 if uid==1000 else 1000
            unit=f'user@{uid}.service'; query=['is-active',unit]; start=['start',unit]
            restart=['restart','systemd-oomd.service']
            rows=[
              ('active',0,[[other]],[query,restart]),
              ('inactive',3,[[other]],[query]),
              ('failed',3,[[other],[other,uid]],[query,start]),
            ]
            for state,code,registered,expected in rows:
                with self.subTest(uid=uid,state=state):
                    rc,calls,events=self.run_case(dict(registered=registered,states={str(uid):[[state,code]]}))
                    self.assertEqual(rc,0); self.assertEqual(calls,expected)
            for state in ('failed','inactive','activating','deactivating','reloading','maintenance','unknown'):
                with self.subTest(uid=uid,after_start=state):
                    rc,calls,events=self.run_case(dict(registered=[[other]],states={str(uid):[['failed',3],[state,3]]}))
                    self.assertEqual(rc,0); self.assertEqual(calls,[query,start,query])
                    self.assertTrue(any(e['event']=='user_manager_pending' and e['uid']==uid for e in events))
            rc,calls,events=self.run_case(dict(registered=[[other]],states={str(uid):[['failed',3],['active',0]]}))
            self.assertEqual(rc,0); self.assertEqual(calls,[query,start,query,restart])
            for state in ('activating','deactivating','reloading','maintenance','unknown'):
                rc,calls,_=self.run_case(dict(registered=[[other]],states={str(uid):[[state,3]]}))
                self.assertEqual(rc,0); self.assertEqual(calls,[query])
            rc,calls,events=self.run_case(dict(registered=[[other]],states={str(uid):[['failed',3]]},startCodes={unit:17}))
            self.assertNotEqual(rc,0); self.assertEqual(calls,[query,start])
            self.assertTrue(any(e.get('exitCode')==17 and e.get('uid')==uid for e in events))
            rc,calls,events=self.run_case(dict(registered=[[other]],states={str(uid):[['',9]]}))
            self.assertNotEqual(rc,0); self.assertEqual(calls,[query])
            self.assertTrue(any(e['event']=='user_manager_state_query_failed' for e in events))
            rc,calls,events=self.run_case(dict(registered=[[other]],restartCode=19))
            self.assertNotEqual(rc,0); self.assertEqual(calls,[query,restart])
            self.assertTrue(any(e.get('exitCode')==19 for e in events))

    def test_healthy_and_mixed_managers(self):
        self.assertEqual(self.run_case({})[:2],(0,[]))
        self.assertEqual(self.run_case({})[2],[])
        rc,calls,_=self.run_case(dict(registered=[[]],misleading=True))
        self.assertEqual(rc,0)
        self.assertEqual(calls,[['is-active','user@1001.service'],['is-active','user@1000.service'],['restart','systemd-oomd.service']])
        for failed,stopped in ((1000,1001),(1001,1000)):
            rc,calls,_=self.run_case(dict(registered=[[],[failed]],states={str(failed):[['failed',3]],str(stopped):[['inactive',3]]}))
            self.assertEqual(rc,0)
            self.assertIn(['start',f'user@{failed}.service'],calls)
            self.assertNotIn(['start',f'user@{stopped}.service'],calls)
            self.assertNotIn(['restart','systemd-oomd.service'],calls)
        rc,calls,events=self.run_case(dict(registered=[[],[1000]],states={'1001':[['failed',3]],'1000':[['failed',3]]},startCodes={'user@1001.service':17}))
        self.assertNotEqual(rc,0)
        self.assertIn(['start','user@1000.service'],calls)
        self.assertTrue(any(e['event']=='user_manager_recovered' and e['uid']==1000 for e in events))
        rc,calls,events=self.run_case(dict(registered=[[],[1001],[1001,1000]],states={'1001':[['failed',3]],'1000':[['failed',3]]}))
        self.assertEqual(rc,0)
        self.assertEqual([c for c in calls if c[0]=='start'],[['start','user@1001.service'],['start','user@1000.service']])

    def test_failed_dump_diagnoses_error_without_speculative_state_actions(self):
        rc,calls,events=self.run_case(dict(dumpCodes=[5,6],registered=[[]],states={'1001':[['inactive',3]],'1000':[['failed',3],['active',0]]}))
        self.assertEqual(rc,0)
        self.assertIn(['start','user@1000.service'],calls)
        self.assertEqual([e['exitCode'] for e in events if e['event']=='oomd_dump_failed'],[5,6])
        self.assertNotIn(['start','user@1001.service'],calls)

if __name__=='__main__': unittest.main()
```

Replace only the existing watchdog section of `tests/test-sentinelx-janitor.sh` (from its watchdog-mocks comment through the final healthy-watchdog assertion) with this invocation of the executable suite, retaining every janitor test before and after it:

```bash
watchdog_case_output="$(PYTHONDONTWRITEBYTECODE=1 python3 "$REPO_ROOT/tests/test-oomd-watchdog.py" 2>&1)"
watchdog_case_status=$?
printf '%s\n' "$watchdog_case_output"
assert_eq "both user managers follow the watchdog state policy" 0 "$watchdog_case_status"
```

The Python matrix replaces the old one-UID semantics with stronger actual argv/outcome checks, including misleading registration text. There are no script-content assertions.

- [ ] **Step 2: Run red**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 tests/test-oomd-watchdog.py
```

Expected: UID 1000 failed/inactive cases FAIL because the old watchdog restarts oomd unconditionally; the real executable runs and its argv receipt proves the wrong action. JSONL severity/UID assertions also fail until observability is implemented.

- [ ] **Step 3: Implement the common per-UID recovery policy**

Keep the existing three command seams and replace the registration/decision body with:

```bash
registered() {
  grep -Fq "user.slice/user-${1}.slice/user@${1}.service" <<< "$2"
}
log_uid() {
  local level="$1" event="$2" uid="$3" state="$4" action="$5" result="$6" code="${7:-0}" severity
  severity="${level,,}"
  printf '{"level":"%s","severity":"%s","event":"%s","uid":%s,"unit":"user@%s.service","state":"%s","action":"%s","result":"%s","exitCode":%s}\n' \
    "$level" "$severity" "$event" "$uid" "$uid" "$state" "$action" "$result" "$code"
}
log_global() {
  local level="$1" event="$2" code="${3:-0}" uids="${4:-}" severity
  severity="${level,,}"
  printf '{"level":"%s","severity":"%s","event":"%s","exitCode":%s,"uids":[%s]}\n' \
    "$level" "$severity" "$event" "$code" "${uids// /,}"
}
read_dump() {
  local code=0
  dump="$("$OOMCTL" dump 2>/dev/null)" || code=$?
  if [ "$code" -ne 0 ]; then
    dump=""
    log_global ERROR oomd_dump_failed "$code"
  fi
}
read_state() {
  local uid="$1" code=0
  observed_state="$("$SYSTEMCTL" is-active "user@${uid}.service" 2>/dev/null)" || code=$?
  case "$observed_state" in
    active|failed|inactive|activating|deactivating|reloading|maintenance|unknown)
      if [ "$code" -eq 0 ] || [ "$code" -eq 3 ] || [ "$code" -eq 4 ]; then return 0; fi ;;
  esac
  log_uid ERROR user_manager_state_query_failed "$uid" unknown query failed "$code"
  observed_state=unknown
  return 1
}
request_oomd_restart() {
  local uid="$1"
  requesting_uids="${requesting_uids:+${requesting_uids} }${uid}"
  log_uid WARN user_manager_unregistered "$uid" active restart-oomd requested
}
recover_uid() {
  local uid="$1" code=0
  if ! read_state "$uid"; then failed=1; return; fi
  case "$observed_state" in
    failed)
      "$SYSTEMCTL" start "user@${uid}.service" 2>/dev/null || code=$?
      if [ "$code" -ne 0 ]; then
        log_uid ERROR user_manager_start_failed "$uid" failed start failed "$code"
        failed=1
        return
      fi
      log_uid INFO user_manager_autostart "$uid" failed start succeeded
      sleep "$SETTLE"
      read_dump
      if registered "$uid" "$dump"; then
        log_uid INFO user_manager_recovered "$uid" active observe registered
      elif ! read_state "$uid"; then
        failed=1
      elif [ "$observed_state" = active ]; then
        request_oomd_restart "$uid"
      else
        log_uid INFO user_manager_pending "$uid" "$observed_state" wait deferred
      fi
      ;;
    inactive) log_uid INFO user_manager_stopped_skipped "$uid" inactive none intentionally-stopped ;;
    active) request_oomd_restart "$uid" ;;
    *) log_uid INFO user_manager_pending "$uid" "$observed_state" wait deferred ;;
  esac
}
failed=0
requesting_uids=""
read_dump
missing_uids=()
for uid in 1001 1000; do registered "$uid" "$dump" || missing_uids+=("$uid"); done
if [ "${#missing_uids[@]}" -eq 0 ]; then exit 0; fi
log_global WARN oomd_user_missing 0 "${missing_uids[*]}"
for uid in "${missing_uids[@]}"; do recover_uid "$uid"; done
if [ -n "$requesting_uids" ]; then
  restart_code=0
  "$SYSTEMCTL" restart systemd-oomd.service 2>/dev/null || restart_code=$?
  if [ "$restart_code" -eq 0 ]; then
    log_global INFO oomd_restarted 0 "$requesting_uids"
  else
    log_global ERROR oomd_restart_failed "$restart_code" "$requesting_uids"
    failed=1
  fi
fi
exit "$failed"
```

Update the script header/current AGENTS summary to describe both UIDs consistently. Normal failed/inactive `is-active` status 3 is an observed state, not a command error. Unexpected/empty observations are logged as unknown and never cause starts or oomd restart. Starting a failed unit does not require `reset-failed`; retain `start`, never restart a healthy user manager. Keep one shared oomd restart even if both active managers request it.

Create the real guest fixture `tests/systemd-watchdog/Dockerfile`:

```dockerfile
FROM ubuntu:24.04
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    systemd systemd-sysv systemd-oomd dbus dbus-user-session libpam-systemd procps util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY garageserver/sentinelx/bin/sentinelx-oomd-watchdog /usr/local/sbin/sentinelx-oomd-watchdog
COPY tests/systemd-watchdog/guest-smoke.sh /usr/local/bin/guest-smoke
RUN chmod 0755 /usr/local/sbin/sentinelx-oomd-watchdog /usr/local/bin/guest-smoke \
    && mkdir -p /etc/systemd/system/user@.service.d \
    && printf '[Service]\nRestart=no\nTimeoutStopSec=2s\n' > /etc/systemd/system/user@.service.d/smoke.conf
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
```

Create `tests/systemd-watchdog/guest-smoke.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
test "$(cat /proc/1/comm)" = systemd
test "$(cat /proc/1/cgroup)" = '0::/init.scope'
test "$(cat /sys/fs/cgroup/memory.max)" = 1073741824
test "$(cat /sys/fs/cgroup/pids.max)" = 512
read -r quota period < /sys/fs/cgroup/cpu.max
test "$quota" -eq "$period"
systemctl start dbus.service
systemd-run --unit=watchdog-cgroup-probe --property=MemoryMax=32M --wait /bin/true
if [ "${1:-}" = --probe ]; then
  printf '{"severity":"info","event":"systemd_guest_probe_passed"}\n'
  exit 0
fi
mkdir -p /etc/systemd/user/default.target.wants
cat > /usr/local/bin/watchdog-receipt-service <<'SERVICE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "$$" "$(cat /proc/sys/kernel/random/uuid)" >> "/tmp/watchdog-service-$(id -u).events"
exec sleep infinity
SERVICE
chmod 0755 /usr/local/bin/watchdog-receipt-service
cat > /etc/systemd/user/watchdog-smoke.service <<'UNIT'
[Unit]
Description=Owned watchdog recovery smoke service
[Service]
ExecStart=/usr/local/bin/watchdog-receipt-service
[Install]
WantedBy=default.target
UNIT
systemctl --global enable watchdog-smoke.service
for uid in 1000 1001; do
  getent passwd "$uid" >/dev/null || useradd --create-home --uid "$uid" "smoke${uid}"
  name="$(getent passwd "$uid" | cut -d: -f1)"
  loginctl enable-linger "$name"
done
systemctl start user@1000.service user@1001.service
cat > /usr/local/bin/owned-oomctl <<'OOM'
#!/usr/bin/env bash
for uid in 1001 1000; do
  if [ "${OMIT_UID:-}" != "$uid" ] && systemctl is-active --quiet "user@${uid}.service"; then
    printf 'user.slice/user-%s.slice/user@%s.service present\n' "$uid" "$uid"
  fi
done
OOM
chmod 0755 /usr/local/bin/owned-oomctl
export FRESHELL_OOMCTL=/usr/local/bin/owned-oomctl FRESHELL_WATCHDOG_SETTLE=0
wait_receipt() {
  local uid="$1" minimum="$2"
  for attempt in $(seq 1 100); do
    if [ -f "/tmp/watchdog-service-${uid}.events" ] && [ "$(wc -l < "/tmp/watchdog-service-${uid}.events")" -ge "$minimum" ]; then return 0; fi
    sleep 0.1
  done
  return 1
}
for uid in 1000 1001; do wait_receipt "$uid" 1; done
for uid in 1000 1001; do
  unit="user@${uid}.service"
  old_pid="$(systemctl show "$unit" --property=MainPID --value)"
  old_generation="$(tail -1 "/tmp/watchdog-service-${uid}.events")"
  old_service_pid="${old_generation%% *}"
  old_lines="$(wc -l < "/tmp/watchdog-service-${uid}.events")"
  systemctl kill --kill-whom=main --signal=KILL "$unit"
  for attempt in $(seq 1 100); do
    if [ "$(systemctl is-active "$unit" || true)" = failed ] && ! kill -0 "$old_service_pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  test "$(systemctl is-active "$unit" || true)" = failed
  ! kill -0 "$old_service_pid" 2>/dev/null
  /usr/local/sbin/sentinelx-oomd-watchdog
  test "$(systemctl is-active "$unit")" = active
  new_pid="$(systemctl show "$unit" --property=MainPID --value)"
  test "$new_pid" -gt 1 && test "$new_pid" != "$old_pid"
  wait_receipt "$uid" "$((old_lines+1))"
  new_generation="$(tail -1 "/tmp/watchdog-service-${uid}.events")"
  test "$new_generation" != "$old_generation"
  name="$(getent passwd "$uid" | cut -d: -f1)"
  gid="$(id -g "$name")"
  setpriv --reuid "$uid" --regid "$gid" --init-groups env "XDG_RUNTIME_DIR=/run/user/${uid}" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus" systemctl --user is-active --quiet watchdog-smoke.service
  setpriv --reuid "$uid" --regid "$gid" --init-groups env "XDG_RUNTIME_DIR=/run/user/${uid}" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus" systemctl --user is-enabled --quiet watchdog-smoke.service
  printf '{"severity":"info","event":"real_user_manager_recovered","uid":%s,"oldPid":%s,"newPid":%s}\n' "$uid" "$old_pid" "$new_pid"
  systemctl stop "$unit"
  /usr/local/sbin/sentinelx-oomd-watchdog
  test "$(systemctl is-active "$unit" || true)" = inactive
  systemctl start "$unit"
done
systemctl start systemd-oomd.service
before="$(systemctl show systemd-oomd.service --property=MainPID --value)"
manager_before="$(systemctl show user@1000.service --property=MainPID --value)"
OMIT_UID=1000 /usr/local/sbin/sentinelx-oomd-watchdog
after="$(systemctl show systemd-oomd.service --property=MainPID --value)"
test "$before" -gt 1 && test "$after" -gt 1 && test "$before" != "$after"
test "$(systemctl show user@1000.service --property=MainPID --value)" = "$manager_before"
printf '{"severity":"info","event":"systemd_watchdog_smoke_passed"}\n'
```

This uses real systemctl for manager/service lifecycle and a clearly identified oomctl registration fixture, because registration timing is separate from the repair. Keep the executable fixture under `/usr/local/bin`, since the guest's `/tmp` can remain noexec; assert it emits both active registrations normally and omits only UID 1000 with `OMIT_UID=1000` before using that seam to test restart policy. No login/SSH/PAM session starts a manager after failure; `setpriv` observations change only the observing process UID/groups, without a PAM login, and occur after the watchdog produces new manager/service receipts. Install `dbus-user-session` explicitly because the fixture disables apt recommendations. The fixture-only stop timeout is shortened to two seconds so child teardown completes inside its bounded assertion wait; no production unit is changed. Install the enabled test unit before `enable-linger`, since enabling linger can itself start a manager. The outer barrier asserts PID 1 is at `0::/` before boot; the guest-smoke assertion runs after systemd has moved PID 1 into `init.scope`.

Create `tests/smoke-oomd-watchdog.sh` as the owned outer driver. The central safe invocation is:

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_MODE="${1:-}"
if [ -n "$SMOKE_MODE" ] && [ "$SMOKE_MODE" != --probe ]; then exit 2; fi
unset DOCKER_CONTEXT
export DOCKER_HOST=unix:///var/run/docker.sock
docker info --format '{{json .SecurityOptions}}' | python3 -c 'import json,sys; assert not any("rootless" in x for x in json.load(sys.stdin))'
test "$(docker info --format '{{.CgroupVersion}} {{.CgroupDriver}}')" = '2 systemd'
smoke_receipts="$(mktemp -d /tmp/watchdog-systemd-smoke.XXXXXX)"
smoke_name="watchdog-systemd-$(cat /proc/sys/kernel/random/uuid)"
smoke_image="${smoke_name}:test"
smoke_cid=""
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$smoke_cid" ]; then
    docker logs "$smoke_cid" >"${smoke_receipts}/container.log" 2>&1 || true
    docker exec "$smoke_cid" journalctl --no-pager -b >"${smoke_receipts}/journal.log" 2>&1 || true
    docker rm --force "$smoke_cid" >"${smoke_receipts}/cleanup.log" 2>&1 || status=1
  fi
  docker image rm "$smoke_image" >>"${smoke_receipts}/cleanup.log" 2>&1 || status=1
  printf '{"severity":"info","event":"systemd_smoke_receipts","path":"%s","exitCode":%s}\n' "$smoke_receipts" "$status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
smoke_context="${smoke_receipts}/context"
mkdir -p "${smoke_context}/garageserver/sentinelx/bin" "${smoke_context}/tests/systemd-watchdog"
cp "${REPO_ROOT}/garageserver/sentinelx/bin/sentinelx-oomd-watchdog" "${smoke_context}/garageserver/sentinelx/bin/"
cp "${REPO_ROOT}/tests/systemd-watchdog/Dockerfile" "${REPO_ROOT}/tests/systemd-watchdog/guest-smoke.sh" "${smoke_context}/tests/systemd-watchdog/"
git -C "$REPO_ROOT" rev-parse HEAD >"${smoke_receipts}/commit.txt"
git -C "$REPO_ROOT" status --porcelain >"${smoke_receipts}/source-status.txt"
sha256sum "${smoke_context}/garageserver/sentinelx/bin/sentinelx-oomd-watchdog" "${smoke_context}/tests/systemd-watchdog/guest-smoke.sh" "${smoke_context}/tests/systemd-watchdog/Dockerfile" >"${smoke_receipts}/sources.sha256"
timeout 600 docker build --network=host -t "$smoke_image" -f "${smoke_context}/tests/systemd-watchdog/Dockerfile" "$smoke_context"
smoke_cid="$(docker create --name "$smoke_name" --label "machines.watchdog-smoke=${smoke_name}" \
  --cgroupns private --cpus 1 --memory 1g --memory-swap 1g --pids-limit 512 \
  --network none --cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp --entrypoint /bin/bash "$smoke_image" -c \
  'while [ ! -f /tmp/release-systemd ]; do sleep 0.1; done; test "$(cat /proc/self/cgroup)" = "0::/"; test "$(findmnt -n -o FSROOT -T /sys/fs/cgroup)" = /; mount -o remount,rw /sys/fs/cgroup; exec /sbin/init')"
docker start "$smoke_cid" >/dev/null
smoke_pid="$(docker inspect --format '{{.State.Pid}}' "$smoke_cid")"
smoke_group="/system.slice/docker-${smoke_cid}.scope"
test "$(cat "/proc/${smoke_pid}/cgroup")" = "0::${smoke_group}"
test "$(cat "/sys/fs/cgroup${smoke_group}/memory.max")" = 1073741824
test "$(cat "/sys/fs/cgroup${smoke_group}/memory.swap.max")" = 0
test "$(cat "/sys/fs/cgroup${smoke_group}/pids.max")" = 512
read -r quota period < "/sys/fs/cgroup${smoke_group}/cpu.max"
test "$quota" -eq "$period"
test "$(docker exec "$smoke_cid" cat /proc/1/cgroup)" = '0::/'
test "$(docker exec "$smoke_cid" findmnt -n -o FSROOT -T /sys/fs/cgroup)" = /
test "$(docker exec "$smoke_cid" readlink /proc/self/ns/cgroup)" != "$(readlink /proc/self/ns/cgroup)"
docker inspect "$smoke_cid" >"${smoke_receipts}/inspect.json"
docker exec "$smoke_cid" touch /tmp/release-systemd
guest_ready=0
for attempt in $(seq 1 100); do
  if docker exec "$smoke_cid" systemctl show --property=Version --value >/dev/null 2>&1; then guest_ready=1; break; fi
  sleep 0.2
done
test "$guest_ready" -eq 1
timeout 120 docker exec "$smoke_cid" /usr/local/bin/guest-smoke ${SMOKE_MODE:+"$SMOKE_MODE"} | tee "${smoke_receipts}/smoke.jsonl"
```

The initial barrier runs before remounting the existing private cgroup hierarchy writable or starting guest systemd. The parent actually demonstrated this remount/child-cgroup operation and then full bounded systemd boot/D-Bus readiness; new cgroup2 mounts failed with AppArmor denial and then EBUSY, so do not repeat them. `systemctl show Version` alone became ready before the bus; explicitly starting guest `dbus.service` before `systemd-run` is the executed correction. Verify `FSROOT=/`, namespace difference, container-root `0::/`, exact host placement and limits before release. No `--privileged`, Docker socket, writable host cgroup bind, host PID namespace, user/system bus, home/repository bind, or host runtime network is present. SYS_ADMIN and guest-only relaxed seccomp/AppArmor are restricted to this throwaway rootful guest. If a verified prerequisite regresses, abort with retained evidence. The build's host-network package-fetch workaround has no runtime service listener and is separate from the guest's `--network none`.

On outer timeout, the EXIT trap removes only the recorded guest ID and image. Capture the actual readiness/probe failure as a non-converged prerequisite, never a skipped green smoke. Do not automatically add this rootful/systemd requirement to `tests/validate.sh`; keep explicit real-smoke acceptance in this task so the default lightweight repository suite remains usable on other machines.

- [ ] **Step 4: Run focused green and real guest acceptance**

```bash
PYTHONDONTWRITEBYTECODE=1 python3 tests/test-oomd-watchdog.py
PYTHONDONTWRITEBYTECODE=1 bash tests/test-sentinelx-janitor.sh
bash -n garageserver/sentinelx/bin/sentinelx-oomd-watchdog
bash -n tests/smoke-oomd-watchdog.sh
bash -n tests/systemd-watchdog/guest-smoke.sh
git add garageserver/sentinelx/bin/sentinelx-oomd-watchdog tests/test-sentinelx-janitor.sh tests/test-oomd-watchdog.py tests/smoke-oomd-watchdog.sh tests/systemd-watchdog/Dockerfile tests/systemd-watchdog/guest-smoke.sh garageserver/docs/sentinelx-sandbox.md garageserver/sentinelx/AGENTS.md
git commit -m "fix: recover both failed user managers from the oomd watchdog"
timeout 900 bash tests/smoke-oomd-watchdog.sh --probe
timeout 900 bash tests/smoke-oomd-watchdog.sh
```

Expected: exact-argv policy tests PASS. Real probe PASS precedes any guest manager failure. Full guest smoke proves UID 1000 and UID 1001 manager PIDs and enabled-service generations change after controlled failure, cleanly stopped managers stay inactive, and an active/unregistered manager requests oomd restart without restarting that manager. Capture JSONL, journal, placement and exit receipts. If a guest prerequisite fails, required recovery coverage remains visibly unresolved; no production manager/service action is a substitute.

- [ ] **Step 5: Refactor while green and write the deployment runbook**

Keep one registration predicate, one state reader and one per-UID recovery function. Retain independent handling after one start failure and single aggregate oomd restart. Keep logs on controlled values so every line parses as JSON. Run focused Python/Bash tests after cleanup.

Append the current repair and runbook to `garageserver/docs/sentinelx-sandbox.md` while retaining the historical incident. Update `garageserver/sentinelx/AGENTS.md`'s watchdog summary and link the new explicit real-smoke command. State the existing maximum recovery interval: next scheduled tick, approximately 15 minutes plus timer randomization/accuracy, 10-second settle per attempted start and systemd startup time; this does not promise immediate recovery.

The runbook contains these operator-visible choices and commands, guarded by separately obtained deployment approval:

1. Record reviewed machines commit, watchdog source SHA-256 and successful fake/broad/real-smoke receipts. Read installed script, unit/timer state, user-manager PIDs/state and registrations. Confirm `ExecStart` is `/usr/local/sbin/sentinelx-oomd-watchdog`; wait until no watchdog invocation is in progress. Immediately before replacement, recheck both manager states: if either is failed, defer installation unless the separate deployment approval explicitly includes its automatic recovery on the next tick. Do not run the broader `sentinelx-deploy` command.
2. Save a timestamped root-owned backup and stage only the reviewed script as root:root mode 0755 in `/usr/local/sbin`. Run `bash -n` on staging, then atomically replace the installed script and compare SHA-256. This script-only update needs no daemon reload, timer change, manager restart, Freshell restart or client restart.
3. Observe the next natural timer activation and its exit/result, both active managers/full registrations, and Freshell health. A healthy tick can be silent. Confirm existing healthy manager/Freshell PIDs did not change. Never deliberately fail live managers to validate installation.
4. The installed watchdog starts failed managers automatically on a natural tick. Installation approval must therefore cover that recovery effect if a manager is already failed; otherwise the precondition in step 1 defers installation. No separate manual start or deliberate live failure is part of script installation.
5. Rollback within approved scope restores the saved script using the same staged atomic replacement/hash check and observes the next tick. No service restart accompanies rollback.

Exact script-only installation, to appear in the runbook and **not execute during this task**:

```bash
watchdog_source=/home/dan/code/machines/.worktrees/freshell-user-manager-recovery/garageserver/sentinelx/bin/sentinelx-oomd-watchdog
watchdog_install_started="$(date --iso-8601=seconds)"
watchdog_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
watchdog_backup="/usr/local/sbin/sentinelx-oomd-watchdog.backup-${watchdog_stamp}"
watchdog_stage="/usr/local/sbin/.sentinelx-oomd-watchdog.stage-${watchdog_stamp}"
sha256sum "$watchdog_source"
sudo cp --preserve=all /usr/local/sbin/sentinelx-oomd-watchdog "$watchdog_backup"
sudo install -o root -g root -m 0755 "$watchdog_source" "$watchdog_stage"
sudo bash -n "$watchdog_stage"
sudo mv -T "$watchdog_stage" /usr/local/sbin/sentinelx-oomd-watchdog
sha256sum "$watchdog_source" /usr/local/sbin/sentinelx-oomd-watchdog
journalctl -u sentinelx-oomd-watchdog.service --since "$watchdog_install_started"
```

Runbook observation commands are read-only: `systemctl show sentinelx-oomd-watchdog.service sentinelx-oomd-watchdog.timer user@1000.service user@1001.service`, the timestamped journal command above, `oomctl dump`, and Freshell's documented health endpoint. Retain the source SHA, installation timestamp, backup/staging paths and before/after PID observations in the approved operator receipt.

- [ ] **Step 6: Run impacted verification**

```bash
umask 022
PYTHONDONTWRITEBYTECODE=1 timeout 3600 bash tests/validate.sh
```

Expected: the broad practical machines suite completes with zero failures and its existing explicit unavailable-prerequisite reports; the longer bound accommodates the known baseline timeout rather than pretending it was green. If it remains incomplete, retain its exact result and let the parent explicitly disposition the unrelated pre-existing broad limitation; never label it a pass. All seven SentinelX suites listed below and the new real-systemd smoke are required affected coverage and must actually complete:

```bash
PYTHONDONTWRITEBYTECODE=1 timeout 600 bash tests/test-sentinelx-egress-guard.sh
PYTHONDONTWRITEBYTECODE=1 timeout 600 bash tests/test-sentinelx-janitor.sh
PYTHONDONTWRITEBYTECODE=1 timeout 600 bash tests/test-sentinelx-verify.sh
PYTHONDONTWRITEBYTECODE=1 timeout 600 bash tests/test-sentinelx-layout.sh
PYTHONDONTWRITEBYTECODE=1 timeout 600 bash tests/test-sentinelx-deploy.sh
PYTHONDONTWRITEBYTECODE=1 timeout 600 bash tests/test-sentinelx-connection-watchdog.sh
PYTHONDONTWRITEBYTECODE=1 timeout 600 bash tests/test-sentinelx-agent-cutover.sh
```

Do not count an unavailable existing root-only ACL suite as coverage of that unrelated functionality. The final explorer report was reread for this draft: broad baseline exit 124 after 28 completed zero-failure suites; fresh seven-suite SentinelX baseline exit 0; clean unchanged machines base. Preserve this distinction in review/handoff.

- [ ] **Step 7: Commit the complete machines task**

```bash
git add garageserver/sentinelx/bin/sentinelx-oomd-watchdog tests/test-sentinelx-janitor.sh tests/test-oomd-watchdog.py tests/smoke-oomd-watchdog.sh tests/systemd-watchdog/Dockerfile tests/systemd-watchdog/guest-smoke.sh garageserver/docs/sentinelx-sandbox.md garageserver/sentinelx/AGENTS.md
git commit -m "test: retain user-manager recovery smoke and runbook refinements"
```

Step 4's checkpoint is the complete task commit if no source changes remain. Use this final commit only for actual subsequent refinements, and rerun the affected proof at the final reviewed SHA if executable source changed.

## Cross-repository verification, review and handoff

The parent keeps one usual run and one plan for the explicit two-repository repair. Each review sees the complete current User Request, this plan's intent/interfaces, exact reviewed endpoints for both repositories, the relevant tests and the counterpart diff where a cross-repository claim depends on it. Do not let a Freshell-only review imply machines recovery is proven or a machines-only review imply the sandbox budget prevents every pressure event.

Reviewer-visible rollout choices are runbooks only. The sandbox change takes effect through the reviewed script/image in future test invocations. The Windows client change is delivered through the existing native-Windows NSIS build/install procedure in `docs/development/windows-electron-build.md`, followed by a separately approved desktop restart and user verification against the configured remote endpoint; preserve desktop configuration and record the previous installer for rollback. There are no Rust server behavior changes requiring a new production-server deployment in this repair. The machines rollout is the narrow script-only atomic replacement/rollback runbook in Task 4. None of these rollout operations is executed by this plan.

1. Primary review endpoint: `git -C /home/dan/code/freshell/.worktrees/freshell-crash-resilience diff 283e4c4b87e58f31a048732800cefb345b799082 HEAD`; record its exact final SHA. Auxiliary endpoint: `git -C /home/dan/code/machines/.worktrees/freshell-user-manager-recovery diff 0409315b6278cf343a9c8a963b236345d28fcbc1 HEAD`; record its exact final SHA. The external evidence directory is `/home/dan/code/freshell/.worktrees/.the-usual-logs/freshell-crash-resilience/reports`.
2. Required final Freshell gate is the unchanged coordinated `pnpm run check` from an exact clean primary-branch checkout inside the qualified private guest, under the original host shared-gate reservation and Stage 2 operational/token/cleanup prerequisites. Remove only the two documented OpenCode optional-file environment values for that test process; require the existing robot identity, Cargo jobs two, a meaningful crash-resilience summary, both configured cloud backends and the local companion enabled. Keep all default phases, exact source/image identity and genuine inner coordinator records; a failed/partial gate remains failed/partial. Run the canonical Electron sandbox proof inside the guest at the final reviewed SHA and require both selected recovery cases with timing/native JSONL evidence. Export records, verify exact cloud and guest cleanup, remove temporary credentials, and only then release the host reservation. Do not restart production or install a Windows build as verification.
3. Required machines endpoint is its focused policy matrix, all seven affected SentinelX suites, an honestly reported final `tests/validate.sh` result and successful real isolated-systemd smoke at the reviewed SHA. A broad pre-existing unrelated timeout requires an explicit recorded disposition; it is never green coverage. An unresolved safe-guest prerequisite keeps the overall result `FAILED/non-converged`; it cannot be turned into a platform-confidence footnote.
4. Preserve actual workload/rootful-cgroup/headroom receipts, real >60-second Electron timing and no-false-success evidence, real manager/service-generation receipts and self-owned sentinel evidence. Parent updates the existing Kata items and usual run ledger with actual results, the sole user-accepted pane-recovery deferral, documented limits and every binding finding disposition. Retaining host oomd policy/timer cadence and an overridable Cargo default documents the repair's scope and limits; it does not add user-accepted residuals or authorize broader host-policy work.
5. End with clean focused commits and branches ready for user review. Push is permitted by repository instructions when the parent reaches that workflow stage. Stop before creating either PR; ask for the user's explicit approval to land the concrete branches. Deployment and Windows user testing remain separately approved operations, described with runbooks rather than performed here.

## Planner self-review

- The dispatcher-authored `## User Request` block appears unchanged exactly once above; requested behavior and accepted pane-recovery residual map to explicit tasks and acceptance.
- Runtime mocks cover scheduling/state decisions; they do not replace real workload completion, full private-guest RuntimeHarness qualification, actual native-document outage recovery, the exact configured-cloud full gate, or actual isolated-systemd manager/service restoration.
- No live host policy rewrite, deployed service change, production restart, client install/restart or PR creation is included. Resource defaults remain proposed until the two-job actual-workload proof has material measured headroom.
- The parent proved bounded private-cgroup/systemd/D-Bus and real guest manager/service restoration capability with retained receipts. Repaired-watchdog user-manager recovery remains required Task 4 acceptance, with a fail-closed fixture prerequisite recheck. No unsafe host-bound substitute is permitted.
- The completed `reports/guest-manager-prerequisite.md` was read before handoff: the unchanged watchdog reproduced UID 1000's failure after a real guest oomd restart, direct guest start restored its enabled service, and the original UID 1001 path restored its service. Both had new manager/service PIDs and receipt counts 1→2 without an independent login. Task 4 preserves the executed setup decisions and must prove the repaired script itself restores UID 1000.
- Stage 2 self-review checked the unchanged dispatcher User Request byte-for-byte and exactly once; Task 0 ordering; the actual chosen guest/tool/resource profile; private source/daemon/cache ownership for Freshell proofs and the separately owned Task 4 systemd guest; host reservation through actual cleanup; measured token validity; bounded image preparation; complete native-action deadline versus permanent logical disposal; all real acceptance gates; and no live deployment/PR/Windows action. All 28 remaining Bash blocks, one Python block and 13 TypeScript/JavaScript blocks passed syntax checks; Markdown fences and the focused diff passed structural/whitespace checks. These are plan-quality checks, not implementation or acceptance test results; details are in the external Stage 2 self-review report.
- The native-action completion premise was removed by design, with invalidated unexecuted production snippets replaced by decisions and required behavior. The new permanent cold-Clippy proof program was removed while retaining minimal wrapper/resource coverage and actual chosen-default current-source workload/headroom evidence through the executed external recipe.
- Source snippets are draft guidance and must be reconciled with exact current interfaces during the parent's independent plan review before execution. The plan's source-tree authority rule applies after implementation begins.
- Round 1 remediation self-review preserved the canonical User Request unchanged exactly once and checked only the edited decisions/commands against their source interfaces. Focused owned probes reproduced Cargo's noexec failure, completed the unchanged tiny Cargo fixture at one/two jobs without that mount, verified post-boot PID 1 in `init.scope`, and executed the registration fixture from `/usr/local/bin` with full/omitted-UID controls. All 26 Bash blocks, one Python block and 13 TypeScript/JavaScript blocks passed syntax checks; startup cleanup preserved its intended failure with no disposer, and each-file Bash checking detected a deliberately invalid second fixture. Details and the initial probe setup failure are retained in external `reports/plan-round-1-remediation.md`. These are plan-remediation checks only; Task 0, real current-source workload/native/systemd acceptance and the exact full gate remain required.


