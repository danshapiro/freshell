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

**Architecture:** Bound Cargo jobs and container CPU allocation in the existing sandbox wrapper, preserving its memory/isolation boundaries. Keep the Electron recovery controller local to its logical window, turn the existing rolling circuit limit into a timed cooldown, and verify the actual native candidate document before accepting recovery. Apply the existing failed-manager recovery policy consistently to both existing UIDs in the machines repository; prove service restoration in an isolated real systemd guest and deliver deployment instructions without applying them.

**Tech Stack:** Bash, Docker with cgroup v2, Rust/Cargo, Node 22/TypeScript ESM, Electron, Vitest, Playwright, Python 3, Ubuntu 24.04/systemd.

## Global Constraints

1. The user explicitly approved creating the Freshell worktree from the recorded failing baseline and correcting the missing durable-resume wait first. Preserve the failed baseline receipts, then execute Task 0 before crash implementation. The separate machines baseline has 28 completed zero-failure suites before an unrelated broad timeout, plus a green seven-suite SentinelX baseline; that narrow result is not a green full-repository baseline.
2. Freshell base is `283e4c4b87e58f31a048732800cefb345b799082`; machines base is `0409315b6278cf343a9c8a963b236345d28fcbc1`. Primary worktree: `/home/dan/code/freshell/.worktrees/freshell-crash-resilience`, branch `the-usual/freshell-crash-resilience`. Auxiliary worktree: `/home/dan/code/machines/.worktrees/freshell-user-manager-recovery`, branch `the-usual/freshell-user-manager-recovery`. Reconcile any base movement before implementation; an old report is not a green-base receipt for a new SHA.
3. Author changes only in these dedicated worktrees. Keep machines changes in its own branch. Name files explicitly when staging. Commit as the existing configured `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`. No PR, merge, production deployment, installed-watchdog replacement, live manager action, production service restart, Windows installation, or Windows client restart is authorized here.
4. Use pnpm exactly `10.34.5`, frozen installs, repo-owned test launchers, and `.js` relative TypeScript imports. Honor both repositories' existing AGENTS instructions and the parent-owned usual run ledger. Do not invoke unrelated skills or create new Kata scope. The parent records evidence against `freshell#mdmw`, `freshell#fprv`, `machines#brpn`; `freshell#7fen` remains deferred.
5. Do not rerun the unlimited historical Clippy invocation, induce memory exhaustion, rewrite host oomd policy, kill broad process patterns, or delete shared caches. All deliberate process failures occur in disposable owned containers. Use exact owned container/process receipts and bounded cleanup. No live host user manager is a test fixture.
6. Preserve the existing three-attempt/60,000 ms Electron rolling limit, `[250, 1000, 3000]` retry delays, 15,000 ms unresponsive threshold, authenticated immutable recovery URL, replacement-window preload and privileged IPC identity behavior, and close-to-tray behavior. An application root rendering an authentication or machine-selection view is sufficient; requiring an open terminal or pane is outside scope.
7. Logs are structured JSONL with severity, cause, action and outcome. Keep Electron's established token redaction. Never log provider homes, authentication tokens or the ambient environment. Healthy watchdog ticks remain silent.
8. Host verification removes only `FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE` and `FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE` from that test process, matching the sanitized recorded-base setup; the ambient optional files otherwise contaminate the existing fake OpenCode fixture. Do not change persistent/live environment or weaken provider assertions. Existing cloud backend choices persist. Broad gates use `GCLOUD_ROBOT_REQUIRE=1`, a meaningful `FRESHELL_TEST_SUMMARY`, and the shared coordinator. Never silently replace configured cloud verification with local verification. Electron's native suite is local by definition, inside the disposable sandbox for this outage scenario.

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

## File responsibilities and task interfaces

Paths below are relative to the owning repository.

| Repository/file | Responsibility |
|---|---|
| Freshell `test/integration/server/managed-provider-parity.test.ts` | Observe durable resume readiness before the injected test outage, preserving every existing assertion. |
| Freshell `scripts/sandbox-test.sh` | Shared runtime resource defaults and start/completion JSONL receipts. |
| Freshell `docker/sandbox/Dockerfile` | Minimal xvfb/xauth prerequisites for actual headless Electron launch. |
| Freshell `test/unit/scripts/sandbox-test.test.ts` | Execute the real wrapper with a recording Docker executable; verify arguments, modes and exit propagation. |
| Freshell `scripts/testing/sandbox-budget-smoke.mjs` | Tiny bounded Cargo concurrency and effective-cgroup proof inside the real wrapper. |
| Freshell `scripts/testing/sandbox-clippy-budget-proof.py` | Rootful, barrier-gated, monitored cold proof of the identified Clippy workload; owns all proof volumes/containers. |
| Freshell `scripts/sandbox-selftest.sh` | Existing sandbox isolation acceptance, extended with real resource proof. |
| Freshell `docs/development/test-sandbox.md` | Agent/operator resource policy, proof instructions and explicit limits of protection. |
| Freshell `electron/renderer-recovery.ts` | One cancellable bounded retry controller per logical window. |
| Freshell `test/unit/electron/renderer-recovery.test.ts` | Fake-clock recovery, coalescing, cooldown, cancellation and existing crash behavior. |
| Freshell `electron/renderer-readiness.ts` | Bounded cancellable native document/root verification. |
| Freshell `electron/recoverable-window.ts` | Existing replacement adapter, moved for testing; candidate readiness and logical lifecycle ownership. |
| Freshell `electron/startup.ts` | Install recovery before first navigation and return explicit recovery disposal. |
| Freshell `electron/entry.ts` | Native constructor injection, IPC identity, launch-generation and quit disposal. |
| Freshell `electron/main.ts` | Dispose renderer recovery when quitting begins, before asynchronous server teardown. |
| Freshell `test/unit/electron/renderer-readiness.test.ts`, `recoverable-window.test.ts`, `startup.test.ts`, `main.test.ts` | Behavioral native adapter, readiness, startup and quit wiring coverage. |
| Freshell `test/e2e-electron/electron-app.test.ts` | Real >60-second endpoint outage and recovery without a new post-restore client event. |
| Machines `garageserver/sentinelx/bin/sentinelx-oomd-watchdog` | Common state-sensitive recovery for UIDs 1001 and 1000; aggregate one oomd restart. |
| Machines `tests/test-sentinelx-janitor.sh`, `tests/test-oomd-watchdog.py` | Preserve existing janitor acceptance and run independent per-UID, per-call watchdog behavior matrix. |
| Machines `tests/systemd-watchdog/Dockerfile`, `guest-smoke.sh`, `tests/smoke-oomd-watchdog.sh` | Disposable real-systemd prerequisite check, manager/service recovery and exact cleanup. |
| Machines `garageserver/docs/sentinelx-sandbox.md`, `garageserver/sentinelx/AGENTS.md` | Current policy and narrow approved-deployment/rollback runbook; preserve historical incidents. |

Task 0 must pass before any crash implementation, including the auxiliary machines task. Task 2 produces `registerRendererRecovery(options): () => void` and optional listener removal without depending on Task 3's native adapter. Task 3 consumes that disposer and produces `StartupResult` main-arm `disposeRendererRecovery(): void`; native adapter `cancelRecovery(): void` aborts candidate verification/activation. Tasks 1 and 4 are code-independent; execute their mutations only in their separate worktrees. Task 3's destructive Electron proof depends on Task 1's green bounded sandbox.

All code below is a pre-implementation draft. Once execution begins the source tree supersedes these snippets; review corrections belong in source rather than being backported into plan code.

---

### Task 0: Wait for durable resume evidence before the injected test outage

**Files:** Modify `test/integration/server/managed-provider-parity.test.ts` only.

**Intent:** Correct the demonstrated test readiness race before implementing the crash fixes. The existing test currently kills the web process and provider after observing CLI identity text; it must wait for the supervisor's durable resume evidence, preserving all replacement/config/source/MCP assertions and leaving production recovery unchanged.

- [ ] **Step 1: Confirm red evidence and exact scope**

Use the two recorded base failures in `reports/base-gate.log` and `reports/base-gate-sanitized.log`, supported by `reports/baseline-managed-restart.md`. The test consistently fails waiting for replacement, and the soul's retained lifecycle has zero recovery store probes. Record that the branch differs from that exact base only by planning until this correction. Do not rerun an unbounded or shared-host kill experiment for RED.

- [ ] **Step 2: Correct the missing prerequisite**

Immediately after `OpenCode native identity before web restart`, insert the same bounded readiness wait the neighboring passing replacement case already uses:

```ts
await waitFor('OpenCode resume evidence before web restart', async () => {
  const view = (await rig.inventory()).find((row: any) => row.terminalId === terminalId)
  return view?.durabilityState === 'resume_captured' ? view : undefined
}, 45_000)
```

Keep all existing later assertions and timeouts. Do not change supervisor/pane recovery, manufacture resume evidence, use arbitrary sleeps, or weaken assertions. Refactor only if this small test change exposes actual duplication worth removing; otherwise keep the existing idiom and confirm it remains green.

- [ ] **Step 3: Commit the correction for exact-source verification**

```bash
git add test/integration/server/managed-provider-parity.test.ts
git commit -m "test: wait for durable resume before OpenCode restart"
```

- [ ] **Step 4: Run the actual affected case in a disposable Docker-capable guest**

The validated environment recipe is `reports/nested-docker-prerequisite.md`, with setup under `/tmp/freshell-nested-docker-prerequisite-20261016`. Stage a self-contained clean checkout at the committed Task 0 SHA inside the guest; do not mount the host repository/home/cache/socket. Use the guest's own Docker27.5.1/API1.47, restricted runtime broker, and validated dual-stack bridge. Verify outer placement/private namespaces/limits before releasing systemd or any build. Source-build artifacts inside this glibc2.36 guest; prebuilt host/trixie binaries are not accepted. Pin pnpm10.34.5 and Cargo jobs2; use bounded outer8GiB/no-swap/2CPU/1024PIDs and exact owned cleanup. Extend timeout for cold qualification builds rather than weakening the test. All deliberate fixture kills stay inside this outer guest. Keep the guest and its fresh owned build artifacts for the immediate affected-suite continuation if useful.

Inside that guest, the exact repo-owned selector is:

```bash
env -u FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE -u FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE CARGO_BUILD_JOBS=2 pnpm run test:vitest run test/integration/server/managed-provider-parity.test.ts --config config/vitest/vitest.config.ts --testNamePattern 'recovers OpenCode inline and home JSONC TUI inputs after web restart with its container down'
```

Expected: exactly the selected case runs and passes with the durable barrier satisfied before the real outage, then replacement and all existing assertions pass. A filter matching zero tests is failure. Preserve full command/output/sourceSHA and guest ownership/cleanup receipts under this run's external logs. Record any safe setup refinements and rerun meaningful impacted coverage after subsequent corrections.

- [ ] **Step 5: Review the committed task**

Fresh task review must confirm the new wait observes real supervisor state, existing assertions remain, RED/GREEN evidence is attributable, and no production or pane-recovery behavior changed. Repair any substantive findings before Task 1 starts.

---

### Task 1: Bound sandbox builds and prove the identified workload safely

**Files:**
- Modify: `scripts/sandbox-test.sh:111`, `docker/sandbox/Dockerfile:34`, `scripts/sandbox-selftest.sh:270`, `docs/development/test-sandbox.md`.
- Create/Test: `test/unit/scripts/sandbox-test.test.ts`.
- Create: `scripts/testing/sandbox-budget-smoke.mjs`, `scripts/testing/sandbox-clippy-budget-proof.py`.

**Interfaces:**
- Consumes: existing `scripts/sandbox-test.sh [--runtime-suite] "command"` and its exact workload exit status.
- Produces: both ordinary/runtime modes pass `--cpus 2 --memory 8g --memory-swap 16g --pids-limit 512 -e CARGO_BUILD_JOBS=2`; native-tools remains its early independent branch. No new production override interface.
- Produces: JSONL `sandbox_resources` and `sandbox_completed` with `severity`, `mode`, `cargoJobs`, `cpus`, `memoryBytes`, `memorySwapBytes`, `pidsLimit`, and completion `exitCode`.
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

- [ ] **Step 3: Implement bounded defaults and real proof fixtures**

Add `--cpus 2`, `--memory-swap 16g` and `-e CARGO_BUILD_JOBS=2` beside the existing shared `--memory 8g`. Explicit 16g RAM+swap preserves Docker's existing default allowance rather than silently removing swap. Before `docker "${DOCKER_ARGS[@]}"`, insert:

```bash
SANDBOX_MODE=ordinary
[ "${RUNTIME_SUITE}" -eq 0 ] || SANDBOX_MODE=runtime-suite
printf '{"severity":"info","event":"sandbox_resources","mode":"%s","cargoJobs":2,"cpus":2,"memoryBytes":8589934592,"memorySwapBytes":17179869184,"pidsLimit":512}\n' "${SANDBOX_MODE}" >&2
```

Immediately after collecting `DOCKER_STATUS` insert:

```bash
SANDBOX_SEVERITY=info
[ "${DOCKER_STATUS}" -eq 0 ] || SANDBOX_SEVERITY=error
printf '{"severity":"%s","event":"sandbox_completed","mode":"%s","exitCode":%s}\n' "${SANDBOX_SEVERITY}" "${SANDBOX_MODE}" "${DOCKER_STATUS}" >&2
```

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

Extend the existing self-test before Proof 4 with two bounded calls using its existing status-capture convention. Change its exact owned PID sentinel's `sleep 300` to `sleep 3600`, so bounded two-job preparation cannot make a healthy fixture expire during this now-longer test; the existing EXIT trap still stops only its exact recorded PID.

```bash
for budget in 1 2; do
  BUDGET_STATUS=0
  BUDGET_OUT="$("${REPO_ROOT}/scripts/sandbox-test.sh" --runtime-suite "CARGO_BUILD_JOBS=${budget} node scripts/testing/sandbox-budget-smoke.mjs ${budget}" 2>&1)" || BUDGET_STATUS=$?
  if [ "${BUDGET_STATUS}" -eq 0 ]; then
    pass "effective cgroup controls and completed Cargo work at ${budget} jobs"
  else
    fail "Cargo budget proof failed at ${budget} jobs: ${BUDGET_OUT}"
  fi
done
```

For the actual identified workload, create the host-side Python proof script with these exact operational steps and central control loop. Its arguments are `--jobs {1,2} --evidence <existing absolute directory>`; source is resolved from the script's repository root. No production wrapper options are added for this proof.

```python
#!/usr/bin/env python3
import argparse, http.client, http.server, json, os, pathlib, re, signal, subprocess, threading, time, uuid

p = argparse.ArgumentParser()
p.add_argument('--jobs', type=int, choices=(1, 2), required=True)
p.add_argument('--evidence', type=pathlib.Path, required=True)
a = p.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
evidence = a.evidence.resolve(strict=True)
env = dict(os.environ, DOCKER_HOST='unix:///var/run/docker.sock')
env.pop('DOCKER_CONTEXT', None)
prefix = 'freshell-budget-' + uuid.uuid4().hex
cid = None
volumes = []
status = 0
sentinel = None
health = None
def interrupted(_signal, _frame): raise KeyboardInterrupt('owned proof interrupted')
signal.signal(signal.SIGTERM, interrupted)
def docker(*args):
    return subprocess.check_output(['docker', *args], env=env, text=True, timeout=60).strip()
def record(event, severity='info', **fields):
    with (evidence / (prefix + '.jsonl')).open('a') as out:
        out.write(json.dumps(dict(severity=severity, event=event, **fields)) + '\n')
def available():
    return int(re.search(r'^MemAvailable:\s+(\d+)', pathlib.Path('/proc/meminfo').read_text(), re.M)[1]) * 1024
def cgroup_read(cgroup, name):
    return (cgroup / name).read_text().strip()
def counters(value):
    return dict((key, int(number)) for key, number in (line.split() for line in value.splitlines()))
class HealthSentinel(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'freshell-budget-owned-sentinel'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_args): pass
def assert_sentinels():
    assert sentinel is not None and sentinel.poll() is None
    connection = http.client.HTTPConnection('127.0.0.1', health.server_port, timeout=2)
    try:
        connection.request('GET', '/')
        response = connection.getresponse()
        assert response.status == 200 and response.read() == b'freshell-budget-owned-sentinel'
    finally: connection.close()
info = json.loads(docker('info', '--format', '{{json .}}'))
assert info['CgroupVersion'] == '2' and info['CgroupDriver'] == 'systemd'
assert not any('rootless' in entry for entry in info['SecurityOptions'])
assert available() >= 32 * 1024**3
try:
    sentinel = subprocess.Popen(['sleep', '3600'])
    health = http.server.HTTPServer(('127.0.0.1', 0), HealthSentinel)
    threading.Thread(target=health.serve_forever, daemon=True).start()
    assert_sentinels()
    for suffix in ('registry', 'git', 'target', 'node', 'sidecar', 'mcp'):
        volume = prefix + '-' + suffix
        docker('volume', 'create', '--label', 'freshell.proof=' + prefix, volume)
        volumes.append(volume)
    destinations = ('/usr/local/cargo/registry', '/usr/local/cargo/git', '/workspace/target',
      '/workspace/node_modules', '/workspace/crates/freshell-claude-sidecar/node_modules',
      '/workspace/packages/freshell-mcp-runtime/node_modules')
    for destination in destinations:
        if destination.startswith('/workspace/'):
            (root / destination.removeprefix('/workspace/')).mkdir(parents=True, exist_ok=True)
    mounts = []
    for volume, destination in zip(volumes, destinations): mounts.extend(('-v', volume + ':' + destination))
    workload = 'rustup toolchain install 1.96.0 --profile minimal --component clippy && cargo +1.96.0 clippy -p freshell-session-host --all-targets -- -D warnings'
    # Keep this owned PID 1 alive after the workload, preserving final cgroup metrics.
    barrier = ('while [ ! -f /tmp/release-budget ]; do sleep 0.1; done; '
      '/usr/local/bin/sandbox-entrypoint.sh "$@"; proof_code=$?; '
      'printf "%s\\n" "$proof_code" > /tmp/budget-exit; '
      'while :; do sleep 1; done')
    cid = docker('create', '--name', prefix, '--label', 'freshell.proof=' + prefix,
      '--cpus', '2', '--memory', '8g', '--memory-swap', '8g', '--pids-limit', '512',
      '--network', 'freshell-sandbox', '-e', 'CARGO_BUILD_JOBS=' + str(a.jobs),
      '-v', str(root) + ':/workspace', *mounts, '--entrypoint', 'bash',
      'freshell-sandbox:latest', '-c', barrier, 'budget-barrier', 'bash', '-c', workload)
    docker('start', cid)
    inspected = json.loads(docker('inspect', cid))[0]
    pid = inspected['State']['Pid']
    placement = pathlib.Path(f'/proc/{pid}/cgroup').read_text().strip()
    expected = '/system.slice/docker-' + cid + '.scope'
    assert placement == '0::' + expected, placement
    cgroup = pathlib.Path('/sys/fs/cgroup' + expected)
    assert cgroup_read(cgroup, 'memory.max') == '8589934592'
    assert cgroup_read(cgroup, 'memory.swap.max') == '0'
    assert cgroup_read(cgroup, 'pids.max') == '512'
    quota, period = map(int, cgroup_read(cgroup, 'cpu.max').split())
    assert quota / period == 2
    initial_events = counters(cgroup_read(cgroup, 'memory.events'))
    record('cold_clippy_budget_verified', cid=cid, pid=pid, placement=placement,
      jobs=a.jobs, commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
      image=inspected['Image'], initialMemoryEvents=initial_events,
      sentinelPid=sentinel.pid, sentinelPort=health.server_port)
    docker('exec', cid, 'touch', '/tmp/release-budget')
    deadline = time.monotonic() + 1800
    pressure_samples = 0
    max_memory = 0
    while True:
        assert_sentinels()
        state = json.loads(docker('inspect', '--format', '{{json .State}}', cid))
        assert state['Running'] and not state['OOMKilled'], state
        current = int(cgroup_read(cgroup, 'memory.current'))
        pressure = cgroup_read(cgroup, 'memory.pressure')
        psi = float(re.search(r'some avg10=([0-9.]+)', pressure)[1])
        pressure_samples = pressure_samples + 1 if psi >= 5 else 0
        max_memory = max(max_memory, current)
        record('cold_clippy_sample', memoryCurrent=current, memoryPeak=cgroup_read(cgroup, 'memory.peak'),
          memoryEvents=cgroup_read(cgroup, 'memory.events'), memorySwapCurrent=cgroup_read(cgroup, 'memory.swap.current'),
          pressure=pressure, cpuStat=cgroup_read(cgroup, 'cpu.stat'), hostAvailable=available())
        if current >= 6 * 1024**3 or pressure_samples >= 3 or available() < 24 * 1024**3:
            raise RuntimeError('bounded proof aborted before unsafe pressure/headroom')
        if time.monotonic() >= deadline: raise TimeoutError('cold Clippy exceeded 30 minute deadline')
        exit_code = docker('exec', cid, 'bash', '-c', 'if [ -f /tmp/budget-exit ]; then cat /tmp/budget-exit; fi')
        if exit_code != '': break
        time.sleep(1)
    final_events = counters(cgroup_read(cgroup, 'memory.events'))
    final_peak = int(cgroup_read(cgroup, 'memory.peak'))
    assert int(exit_code) == 0, exit_code
    assert final_peak < 6 * 1024**3
    for event in ('oom', 'oom_kill'):
        assert final_events.get(event, 0) == initial_events.get(event, 0), final_events
    assert_sentinels()
    record('cold_clippy_completed', jobs=a.jobs, exitCode=int(exit_code), memoryPeak=final_peak,
      maxSampledMemory=max_memory, memoryEvents=final_events)
except BaseException as error:
    status = 1
    record('cold_clippy_failed', severity='error', error=str(error), cid=cid, jobs=a.jobs)
finally:
    if cid:
        try:
            state = json.loads(docker('inspect', '--format', '{{json .State}}', cid))
            if state['Running']: docker('stop', '--time', '10', cid)
        except BaseException as error:
            status = 1
            record('cold_clippy_cleanup_stop_failed', severity='error', error=str(error), cid=cid)
        try:
            logs = subprocess.run(['docker', 'logs', cid], env=env, capture_output=True, text=True, timeout=60)
            (evidence / (prefix + '.workload.log')).write_text(logs.stdout + logs.stderr)
        except BaseException as error:
            status = 1
            record('cold_clippy_cleanup_log_failed', severity='error', error=str(error), cid=cid)
        try: docker('rm', '--force', cid)
        except BaseException as error:
            status = 1
            record('cold_clippy_cleanup_remove_failed', severity='error', error=str(error), cid=cid)
    for volume in reversed(volumes):
        try: docker('volume', 'rm', volume)
        except BaseException as error:
            status = 1
            record('cold_clippy_cleanup_volume_failed', severity='error', error=str(error), volume=volume)
    if health:
        try: health.shutdown(); health.server_close()
        except BaseException as error:
            status = 1
            record('cold_clippy_cleanup_health_failed', severity='error', error=str(error))
    if sentinel and sentinel.poll() is None:
        try:
            sentinel.terminate()
            try: sentinel.wait(timeout=5)
            except subprocess.TimeoutExpired: sentinel.kill(); sentinel.wait(timeout=5)
        except BaseException as error:
            status = 1
            record('cold_clippy_cleanup_sentinel_failed', severity='error', error=str(error), pid=sentinel.pid)
raise SystemExit(status)
```

The owned PID 1 waits after workload completion, so final peak/events are read from a live cgroup before cleanup. The barrier does not run a dependency-preparation command until placement/controls are verified. A fresh target volume establishes cold compilation; toolchain installation modifies only the disposable container's private image layer. No host toolchain or existing cache is replaced. Cleanup independently attempts stop, log retention and exact owned removal even if one fails.

- [ ] **Step 4: Run focused green tests and safe real proofs**

```bash
pnpm run test:vitest run test/unit/scripts/sandbox-test.test.ts --config config/vitest/vitest.config.ts
bash -n scripts/sandbox-test.sh scripts/sandbox-selftest.sh
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock scripts/sandbox-build.sh
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock scripts/sandbox-test.sh --runtime-suite "node scripts/testing/sandbox-budget-smoke.mjs 2"
```

Expected: wrapper tests PASS; syntax succeeds; headless image builds; tiny Cargo work completes with finite effective controls and ample memory. Rebuild only in the explicitly chosen rootful daemon, without changing the operator's Docker context. Run the actual proof one container at a time after committing its source, with an already-created external evidence directory:

```bash
git add scripts/sandbox-test.sh docker/sandbox/Dockerfile scripts/sandbox-selftest.sh scripts/testing/sandbox-budget-smoke.mjs scripts/testing/sandbox-clippy-budget-proof.py test/unit/scripts/sandbox-test.test.ts docs/development/test-sandbox.md
git commit -m "fix: bound sandbox build resources and prove safe compilation"
python3 scripts/testing/sandbox-clippy-budget-proof.py --jobs 1 --evidence /home/dan/code/freshell/.worktrees/.the-usual-logs/freshell-crash-resilience/reports
python3 scripts/testing/sandbox-clippy-budget-proof.py --jobs 2 --evidence /home/dan/code/freshell/.worktrees/.the-usual-logs/freshell-crash-resilience/reports
```

Expected: both identified cold workloads complete at exit 0 with actual `system.slice` controls and headroom receipts; two jobs is accepted only after its own cold proof. A one-job success cannot validate a two-job default. If two jobs fails/aborts, change production default to the demonstrated safer value and rerun tests/verification; do not increase/remove limits. Rootful placement and proof-only zero-swap are explicit safety choices, not claims about the old incident.

- [ ] **Step 5: Refactor while green**

Keep shared wrapper defaults in one argument block and resource-proof ownership/cleanup in small helpers. Do not add configurable schedulers, host Cargo settings or a collection of unrelated build-tool limits. Re-run focused tests after cleanup.

- [ ] **Step 6: Run impacted verification**

```bash
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock CARGO_BUILD_JOBS=2 scripts/sandbox-selftest.sh
pnpm run test:vitest run test/unit/scripts/sandbox-test.test.ts --config config/vitest/vitest.config.ts
```

Expected: all existing isolation/dependency-preparation proofs and new resource proofs PASS; exact self-owned host sentinels survive. Existing host Cargo comparison inherits the finite job budget. Because the Docker image is shared test infrastructure, the parent also includes the full supported suite in the final gate; the new headless Electron path is actually launched in Task 3.

- [ ] **Step 7: Commit the task**

Step 4's checkpoint is the focused task commit when no source changes follow. If proof/refactor changes source, commit those named refinements and rerun the affected proof at that new SHA; do not rewrite another agent's commit. Use the following only when there are remaining task changes:

```bash
git add scripts/sandbox-test.sh docker/sandbox/Dockerfile scripts/sandbox-selftest.sh scripts/testing/sandbox-budget-smoke.mjs scripts/testing/sandbox-clippy-budget-proof.py test/unit/scripts/sandbox-test.test.ts docs/development/test-sandbox.md
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

Replace the old permanent-circuit test and its delayed-second-unresponsive variant with the stronger autonomous-window and immediate-responsive cases above. Replace any unbounded `runAllTimersAsync` in permanent-failure cases with explicit clock advancement. Update the existing in-flight diagnostic assertion to the new `main_window_recovery_coalesced` event; behavior remains one in-flight attempt, with the failure retained.

- [ ] **Step 2: Run red**

```bash
pnpm run test:vitest run test/unit/electron/renderer-recovery.test.ts --config config/vitest/vitest.electron.config.ts
```

Expected: FAIL because the second attempt/window never starts autonomously, a resolving native action can falsely succeed after its failure event, and no disposer exists.

- [ ] **Step 3: Replace the controller's scheduling/lifecycle implementation**

Keep the file's existing request types/constants. Add the optional removal method to `RecoverableWebContents`, then replace `registerRendererRecovery` with:

```ts
export function registerRendererRecovery(options: RendererRecoveryOptions): () => void {
  const { window, loadUrl, serverUrl, logger, setTimeout: later, clearTimeout: cancel } = options
  const wc = window.webContents
  if (!wc) return () => {}
  const verifyRecovered = options.verifyRecovered ?? (async () => {})
  let disposed = false
  let inFlight = false
  let failedDuringAttempt = false
  let expectedRendererGone = false
  let failures = 0
  let attempts: number[] = []
  let pending: RecoveryRequest | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let unresponsiveTimer: ReturnType<typeof setTimeout> | undefined
  const listeners: Array<[string, (...args: any[]) => void]> = []
  const alive = () => !disposed && !isWindowDestroyed(window)
  const log = (entry: ElectronMainLogEntry) => {
    let currentUrl: string | undefined
    try { currentUrl = wc.getURL?.() } catch { /* retired native window */ }
    logger.log({ serverUrl, loadUrl, currentUrl, ...entry })
  }
  const clearRetry = () => {
    if (retryTimer !== undefined) cancel(retryTimer)
    retryTimer = undefined
  }
  const clearUnresponsive = () => {
    if (unresponsiveTimer !== undefined) cancel(unresponsiveTimer)
    unresponsiveTimer = undefined
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    pending = undefined
    clearRetry()
    clearUnresponsive()
    for (const [event, fn] of listeners) wc.removeListener?.(event, fn)
    log({ severity: 'info', event: 'main_window_recovery_cancelled', reason: 'disposed' })
  }
  const listen = (event: string, fn: (...args: any[]) => void) => {
    listeners.push([event, fn])
    wc.on(event, fn)
  }
  const merge = (request: RecoveryRequest) => {
    // A concrete failed navigation outranks an older unresponsive request.
    if (!pending || request.trigger === 'did-fail-load' || pending.trigger !== 'did-fail-load') pending = request
  }
  const drain = () => {
    if (!alive()) { dispose(); return }
    if (inFlight || retryTimer !== undefined || !pending) return
    const now = Date.now()
    attempts = attempts.filter(at => now - at < CIRCUIT_WINDOW_MS)
    const backoff = failures ? RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)] : 0
    const cooldown = attempts.length >= MAX_ATTEMPTS_PER_WINDOW
      ? Math.max(0, attempts[0] + CIRCUIT_WINDOW_MS - now) : 0
    const delayMs = Math.max(backoff, cooldown)
    if (delayMs > 0) {
      log({ severity: cooldown ? 'warn' : 'info',
        event: cooldown ? 'main_window_recovery_circuit_open' : 'main_window_recovery_scheduled',
        trigger: pending.trigger, attemptsInWindow: attempts.length, windowMs: CIRCUIT_WINDOW_MS, retryInMs: delayMs })
      retryTimer = later(() => {
        retryTimer = undefined
        // Backoff was paid; recheck the rolling limit without paying it twice.
        startIfCapacity()
      }, delayMs)
      return
    }
    startIfCapacity()
  }
  const startIfCapacity = () => {
    if (!alive()) { dispose(); return }
    if (inFlight || !pending) return
    const now = Date.now()
    attempts = attempts.filter(at => now - at < CIRCUIT_WINDOW_MS)
    if (attempts.length >= MAX_ATTEMPTS_PER_WINDOW) { drain(); return }
    const request = pending
    pending = undefined
    inFlight = true
    failedDuringAttempt = false
    attempts.push(now)
    const attempt = attempts.length
    log({ severity: 'warn', event: 'main_window_recovery_started', attempt,
      trigger: request.trigger, mode: request.mode, ...(request.metadata ?? {}) })
    void (async () => {
      try {
        if (request.mode === 'load-url') {
          await window.loadURL(loadUrl)
        } else {
          if (request.crashBeforeReload) {
            expectedRendererGone = true
            wc.forcefullyCrashRenderer?.()
          }
          if (!wc.reload || isWebContentsDestroyed(wc)) {
            log({ severity: 'warn', event: 'main_window_recovery_reload_unavailable', trigger: request.trigger })
            await window.loadURL(loadUrl)
          } else await wc.reload()
        }
        if (!alive()) return
        await verifyRecovered()
        if (!alive()) return
        if (failedDuringAttempt) throw new Error('main-frame failure observed during recovery')
        failures = 0
        window.show()
        window.focus()
        log({ severity: 'info', event: 'main_window_recovery_succeeded', attempt,
          trigger: request.trigger, mode: request.mode })
      } catch (error) {
        if (!alive()) return
        failures += 1
        merge(request)
        log({ severity: 'error', event: 'main_window_recovery_failed', attempt,
          trigger: request.trigger, mode: request.mode, error })
      } finally {
        expectedRendererGone = false
        inFlight = false
        if (!disposed) drain()
      }
    })()
  }
  const request = (value: RecoveryRequest) => {
    if (!alive()) { dispose(); return }
    if (inFlight) {
      failedDuringAttempt = true
      log({ severity: 'info', event: 'main_window_recovery_coalesced', reason: 'recovery-in-flight', trigger: value.trigger })
    }
    merge(value)
    drain()
  }
  listen('render-process-gone', (_event, details: { reason?: string; exitCode?: number } = {}) => {
    if (expectedRendererGone) { expectedRendererGone = false; return }
    const metadata = { reason: details.reason ?? 'unknown', exitCode: details.exitCode, willRecover: true }
    log({ severity: 'warn', event: 'main_window_renderer_gone', ...metadata })
    request({ trigger: 'render-process-gone', mode: 'reload', metadata })
  })
  listen('did-fail-load', (_event, errorCode: number, errorDescription: string, validatedUrl: string, isMainFrame: boolean) => {
    const willRecover = isMainFrame && errorCode !== ABORTED_NAVIGATION_ERROR_CODE
    const metadata = { errorCode, errorDescription, validatedUrl, isMainFrame, willRecover }
    log({ severity: willRecover ? 'warn' : 'info', event: 'main_window_navigation_failed', ...metadata })
    if (willRecover) request({ trigger: 'did-fail-load', mode: 'load-url', metadata })
  })
  listen('unresponsive', () => {
    clearUnresponsive()
    log({ severity: 'warn', event: 'main_window_unresponsive', willRecover: true })
    unresponsiveTimer = later(() => {
      unresponsiveTimer = undefined
      request({ trigger: 'unresponsive', mode: 'reload', crashBeforeReload: true })
    }, UNRESPONSIVE_THRESHOLD_MS)
  })
  listen('responsive', () => {
    clearUnresponsive()
    if (pending?.trigger === 'unresponsive') { pending = undefined; clearRetry() }
    log({ severity: 'info', event: 'main_window_responsive' })
  })
  return dispose
}
```

Keep coalesced events from turning one failed attempt into two successors: `pending` is the only queued request and `retryTimer` the only recovery timer. Do not emit success or focus after a disposal/destruction check fails. The optional no-op verifier preserves deterministic non-native callers in this task; Task 3 supplies and exercises the real production verifier, so this fallback is never production acceptance.

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
- Produces: `verifyRendererReady(window, loadUrl, {signal?, isCurrent?}): Promise<void>`, deadline 10,000 ms, polling 100 ms, no production timing override.
- Produces: `createRecoverableWindow({createNativeWindow, options, onWebContentsChanged, logger}): BrowserWindowLike` with `verifyRendererReady(loadUrl)` and `cancelRecovery()` methods.
- Produces: main `StartupResult.disposeRendererRecovery(): void`; disposal clears controller timers and aborts candidate work. Main startup installs listeners before `loadURL` and passes an actual native verifier. Logical close, new launch generation and quit dispose; hide-to-tray does not.

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
    if (result?.type === 'main') { result.disposeRendererRecovery(); clearTimeout(result.updateCheckTimer) }
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

- [ ] **Step 2: Run red**

```bash
pnpm run test:vitest run test/unit/electron/renderer-readiness.test.ts test/unit/electron/recoverable-window.test.ts test/unit/electron/startup.test.ts test/unit/electron/main.test.ts --config config/vitest/vitest.electron.config.ts
```

Expected: new modules are absent initially; then the meaningful startup case fails because listeners are installed after the first navigation. Confirm these intended missing behaviors, rather than counting a syntax/fixture failure as red evidence.

- [ ] **Step 3: Implement actual native readiness, candidate ownership and startup wiring**

Create `electron/renderer-readiness.ts`:

```ts
export interface ReadinessWindow {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    executeJavaScript(source: string): Promise<unknown>
  }
}

export async function verifyRendererReady(
  window: ReadinessWindow,
  loadUrl: string,
  options: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
): Promise<void> {
  const intended = new URL(loadUrl)
  let poll: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let rejectStop!: (error: Error) => void
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject })
  const abort = () => rejectStop(new Error('renderer recovery cancelled'))
  const check = () => {
    if (options.signal?.aborted) throw new Error('renderer recovery cancelled')
    if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('renderer window destroyed')
    if (options.isCurrent && !options.isCurrent()) throw new Error('renderer navigation changed')
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  deadline = setTimeout(() => rejectStop(new Error('renderer readiness timed out')), 10_000)
  try {
    for (;;) {
      check()
      const value = await Promise.race([window.webContents.executeJavaScript(`({
        href: location.href,
        documentUri: document.documentURI,
        ready: document.readyState !== 'loading',
        mounted: !!document.getElementById('root')?.firstElementChild
      })`), stopped]) as { href?: string; documentUri?: string; ready?: boolean; mounted?: boolean }
      check()
      let matches = false
      try {
        const actual = new URL(value.href ?? '')
        const documentUrl = new URL(value.documentUri ?? '')
        matches = actual.origin === intended.origin && actual.pathname === intended.pathname
          && documentUrl.origin === intended.origin && documentUrl.pathname === intended.pathname
      } catch { /* Chromium's error document is never ready. */ }
      if (matches && value.ready && value.mounted) return
      await Promise.race([new Promise<void>(resolve => { poll = setTimeout(resolve, 100) }), stopped])
      poll = undefined
    }
  } finally {
    if (poll !== undefined) clearTimeout(poll)
    if (deadline !== undefined) clearTimeout(deadline)
    options.signal?.removeEventListener('abort', abort)
  }
}
```

Query-string equality is intentionally absent: `src/lib/auth.ts` removes the URL token after saving it. Origin, document path, readiness, mounted content, native candidate identity and unchanged navigation generation still must match.

Move only `createRecoverableEntryWindow` and its tiny listener types from `entry.ts` into `recoverable-window.ts`, rename/export it `createRecoverableWindow`, inject the native constructor/logger, and retain its geometry/visibility/preload/IPC behavior. The complete replacement/action ownership is:

```ts
import type { BrowserWindowLike } from './startup.js'
import type { ElectronMainLogger } from './main-process-logger.js'
import type { RecoverableWebContents } from './renderer-recovery.js'
import { verifyRendererReady, type ReadinessWindow } from './renderer-readiness.js'

interface NativeWindow extends ReadinessWindow {
  webContents: ReadinessWindow['webContents'] & {
    id: number; on(event: string, fn: (...args: any[]) => void): unknown
    removeListener(event: string, fn: (...args: any[]) => void): unknown
    getURL(): string; forcefullyCrashRenderer(): void
  }
  loadURL(url: string): Promise<void>
  on(event: string, fn: (...args: any[]) => void): unknown
  removeListener(event: string, fn: (...args: any[]) => void): unknown
  destroy(): void; show(): void; hide(): void; focus(): void; maximize(): void; restore(): void
  isVisible(): boolean; isFocused(): boolean; isMaximized(): boolean; isMinimized(): boolean
  getBounds(): { x: number; y: number; width: number; height: number }
}
type Listener = { event: string; fn: (...args: any[]) => void; bindings: Map<NativeWindow, (...args: any[]) => void> }

export function createRecoverableWindow(deps: {
  createNativeWindow(options: Record<string, any>): NativeWindow
  options: Record<string, any>
  onWebContentsChanged(id: number): void
  logger: ElectronMainLogger
}): BrowserWindowLike {
  const lifetime = new AbortController()
  const windows = new Set<NativeWindow>()
  const generations = new WeakMap<NativeWindow, number>()
  const windowListeners: Listener[] = []
  const contentListeners: Listener[] = []
  let active: NativeWindow
  let candidate: NativeWindow | undefined
  let lastUrl: string | undefined
  let replacing: Promise<void> | undefined
  const bind = (win: NativeWindow, listener: Listener, contents: boolean) => {
    const wrapped = (...args: any[]) => {
      if (contents ? win === active || win === candidate : win === active) listener.fn(...args)
    }
    listener.bindings.set(win, wrapped)
    if (contents) win.webContents.on(listener.event, wrapped)
    else win.on(listener.event, wrapped)
  }
  const create = (options: Record<string, any>) => {
    const win = deps.createNativeWindow(options)
    windows.add(win)
    generations.set(win, 0)
    win.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) generations.set(win, (generations.get(win) ?? 0) + 1)
    })
    for (const listener of windowListeners) bind(win, listener, false)
    for (const listener of contentListeners) bind(win, listener, true)
    return win
  }
  const retire = (win: NativeWindow) => {
    windows.delete(win)
    for (const listener of [...windowListeners, ...contentListeners]) listener.bindings.delete(win)
  }
  const ensureLive = () => {
    if (lifetime.signal.aborted) throw new Error('renderer recovery cancelled')
  }
  const verify = async (win: NativeWindow, url: string) => {
    const generation = generations.get(win)
    await verifyRendererReady(win, url, {
      signal: lifetime.signal, isCurrent: () => generations.get(win) === generation,
    })
    ensureLive()
  }
  const replace = () => {
    if (replacing) return replacing
    replacing = (async () => {
      ensureLive()
      const old = active
      const url = lastUrl ?? old.webContents.getURL()
      if (!url) throw new Error('main window recovery URL unavailable')
      const bounds = old.getBounds()
      const visible = old.isVisible(), focused = old.isFocused(), maximized = old.isMaximized()
      const next = create({ ...deps.options, ...bounds, show: false })
      candidate = next
      try {
        await next.loadURL(url)
        ensureLive()
        await verify(next, url)
        active = next
        candidate = undefined
        deps.onWebContentsChanged(next.webContents.id)
        if (maximized) next.maximize()
        if (visible) next.show()
        if (focused) next.focus()
        if (!old.isDestroyed()) old.destroy()
        retire(old)
      } catch (error) {
        if (!next.isDestroyed()) next.destroy()
        retire(next)
        if (!lifetime.signal.aborted) deps.logger.log({ severity: 'error', event: 'main_window_replacement_failed', loadUrl: url, error })
        throw error
      } finally { candidate = undefined }
    })().finally(() => { replacing = undefined })
    return replacing
  }
  active = create(deps.options)
  deps.onWebContentsChanged(active.webContents.id)
  const contents: RecoverableWebContents = {
    get id() { return active.webContents.id },
    on(event, fn) {
      const listener = { event, fn, bindings: new Map<NativeWindow, (...args: any[]) => void>() }
      contentListeners.push(listener)
      for (const win of windows) bind(win, listener, true)
    },
    removeListener(event, fn) {
      for (let i = contentListeners.length - 1; i >= 0; i--) {
        const listener = contentListeners[i]
        if (listener.event !== event || listener.fn !== fn) continue
        for (const [win, wrapped] of listener.bindings) win.webContents.removeListener(event, wrapped)
        contentListeners.splice(i, 1)
      }
    },
    getURL: () => active.webContents.getURL(), isDestroyed: () => active.webContents.isDestroyed(),
    reload: replace, forcefullyCrashRenderer: () => active.webContents.forcefullyCrashRenderer(),
  }
  return {
    webContents: contents,
    async loadURL(url) {
      ensureLive(); lastUrl = url
      const target = active
      await target.loadURL(url)
      ensureLive()
      if (active !== target) throw new Error('renderer native target changed')
      await verify(target, url)
    },
    verifyRendererReady: url => verify(active, url),
    cancelRecovery() {
      if (lifetime.signal.aborted) return
      lifetime.abort()
      if (candidate && !candidate.isDestroyed()) candidate.destroy()
    },
    show: () => active.show(), hide: () => active.hide(), focus: () => active.focus(),
    maximize: () => active.maximize(), isVisible: () => active.isVisible(), isFocused: () => active.isFocused(),
    getBounds: () => active.getBounds(), isMaximized: () => active.isMaximized(),
    isDestroyed: () => active.isDestroyed(), isMinimized: () => active.isMinimized(), restore: () => active.restore(),
    on(event, fn) {
      const listener = { event, fn, bindings: new Map<NativeWindow, (...args: any[]) => void>() }
      windowListeners.push(listener)
      for (const win of windows) bind(win, listener, false)
    },
  }
}
```

`BrowserWindowLike` gets optional `isDestroyed`, `isMinimized`, `restore`, `verifyRendererReady(loadUrl)` and `cancelRecovery` signatures matching the object above. Keep adapter tests structural; constructor injection remains the real Electron `BrowserWindow` constructor in production.

In `StartupContext`, change the injectable verifier signature to `(window: BrowserWindowLike, loadUrl: string) => Promise<void>`. In main `StartupResult`, add required `disposeRendererRecovery: () => void`. In `loadMainWindow`, move the entire recovery-registration block before the initial `void window.loadURL(loadUrl)` call and construct disposal there:

```ts
let disposedRecovery = false
const disposeController = ctx.mainProcessLogger && window.webContents
  ? registerRendererRecovery({
    window, loadUrl, serverUrl, logger: ctx.mainProcessLogger, setTimeout, clearTimeout,
    verifyRecovered: () => {
      if (ctx.rendererRecoveryVerifier) return ctx.rendererRecoveryVerifier(window, loadUrl)
      if (window.verifyRendererReady) return window.verifyRendererReady(loadUrl)
      return Promise.reject(new Error('native renderer readiness verifier unavailable'))
    },
  })
  : () => {}
const disposeRendererRecovery = () => {
  if (disposedRecovery) return
  disposedRecovery = true
  disposeController()
  window.cancelRecovery?.()
}
window.on('closed', disposeRendererRecovery)
```

Retain the existing `main_window_recovery_unavailable` diagnostic if webContents/logger prerequisites are absent. Return `disposeRendererRecovery` with the main result. Update test fake windows to provide an explicit deterministic verifier when a test expects recovery success; production receives no no-op.

In `entry.ts`, remove the old inline adapter and import `createRecoverableWindow`. Define these bindings before constructing `ctx`, then spread `...recoveryWindowBindings` into that context in place of the old `createBrowserWindow` property:

```ts
const recoveryWindowBindings: Pick<StartupContext, 'createBrowserWindow' | 'rendererRecoveryVerifier'> = {
createBrowserWindow: options => createRecoverableWindow({
  options,
  createNativeWindow: nativeOptions => new BrowserWindow({
    ...nativeOptions,
    webPreferences: { ...nativeOptions.webPreferences, preload: path.join(__dirname, 'preload.js') },
  }),
  onWebContentsChanged: id => { mainWebContentsId = id },
  logger: mainProcessLogger,
}),
rendererRecoveryVerifier: (window, loadUrl) => {
  if (!window.verifyRendererReady) throw new Error('native renderer readiness verifier unavailable')
  return window.verifyRendererReady(loadUrl)
},
}
```

Add module-level `let disposeActiveRecovery: (() => void) | undefined`. At the beginning of each `main()` pass call and clear the previous disposer. Immediately after a `runStartup` result is known to be `type:'main'`, assign `disposeActiveRecovery = result.disposeRendererRecovery`. Pass `disposeRendererRecovery: result.disposeRendererRecovery` to `initMainProcess`. Add optional `disposeRendererRecovery?: () => void` to `MainProcessDeps` and replace the first-quit `isQuitting = true` assignment in its before-quit handler with:

```ts
if (!isQuitting) {
  isQuitting = true
  deps.disposeRendererRecovery?.()
}
```

This runs once before asynchronous `stopServer`, including repeated before-quit events. A destination choice's next `main()` also invalidates old-target work even if the old close was prevented by tray behavior. Retired-window `closed` events cannot dispose a current replacement because the adapter filters them by native identity.

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

Linked worktree `.git` files point outside the sandbox mount. Preserve exact clean-source provenance without expanding production sandbox mounts: make a test-owned standalone clone of this committed branch, with its own internal objects and `.git`, and run the canonical sandbox/runner from that clone. It is a disposable test fixture, never an authoring checkout. Record both SHAs and require equality:

```bash
set -o pipefail
electron_proof_root="$(mktemp -d /tmp/freshell-electron-proof.XXXXXX)"
git clone --no-hardlinks --single-branch --branch the-usual/freshell-crash-resilience /home/dan/code/freshell "${electron_proof_root}/checkout"
test "$(git rev-parse HEAD)" = "$(git -C "${electron_proof_root}/checkout" rev-parse HEAD)"
env -u DOCKER_CONTEXT -u FRESHELL_BUILD_COMMIT DOCKER_HOST=unix:///var/run/docker.sock "${electron_proof_root}/checkout/scripts/sandbox-test.sh" "xvfb-run -a pnpm run test:e2e:electron --grep 'Renderer crash recovery'" 2>&1 | tee /home/dan/code/freshell/.worktrees/.the-usual-logs/freshell-crash-resilience/reports/electron-outage-e2e.log
```

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

Before implementing the watchdog, build/run the owned smoke guest below only as far as `--probe`. The parent has already proved the underlying bounded private remount/systemd/D-Bus capability; this rechecks it with the actual fixture image and source. It must establish actual rootful placement, a private cgroup namespace, enforced resource limits and a guest systemd-created child cgroup. It must not kill a manager at this stage. If this probe regresses, report the explicit system-level coverage gap to the parent before continuing the task; never replace this proof with shared-host operations.

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
test "$(cat /proc/1/cgroup)" = '0::/'
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
cat > /tmp/owned-oomctl <<'OOM'
#!/usr/bin/env bash
for uid in 1001 1000; do
  if [ "${OMIT_UID:-}" != "$uid" ] && systemctl is-active --quiet "user@${uid}.service"; then
    printf 'user.slice/user-%s.slice/user@%s.service present\n' "$uid" "$uid"
  fi
done
OOM
chmod 0755 /tmp/owned-oomctl
export FRESHELL_OOMCTL=/tmp/owned-oomctl FRESHELL_WATCHDOG_SETTLE=0
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

This uses real systemctl for manager/service lifecycle and a clearly identified oomctl registration fixture, because registration timing is separate from the repair. No login/SSH/PAM session starts a manager after failure; `setpriv` observations change only the observing process UID/groups, without a PAM login, and occur after the watchdog produces new manager/service receipts. Install `dbus-user-session` explicitly because the fixture disables apt recommendations. The fixture-only stop timeout is shortened to two seconds so child teardown completes inside its bounded assertion wait; no production unit is changed. Install the enabled test unit before `enable-linger`, since enabling linger can itself start a manager.

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
bash -n garageserver/sentinelx/bin/sentinelx-oomd-watchdog tests/smoke-oomd-watchdog.sh tests/systemd-watchdog/guest-smoke.sh
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

1. Record reviewed machines commit, watchdog source SHA-256 and successful fake/broad/real-smoke receipts. Read installed script, unit/timer state, user-manager PIDs/state and registrations. Confirm `ExecStart` is `/usr/local/sbin/sentinelx-oomd-watchdog`; wait until no watchdog invocation is in progress. Do not run the broader `sentinelx-deploy` command.
2. Save a timestamped root-owned backup and stage only the reviewed script as root:root mode 0755 in `/usr/local/sbin`. Run `bash -n` on staging, then atomically replace the installed script and compare SHA-256. This script-only update needs no daemon reload, timer change, manager restart, Freshell restart or client restart.
3. Observe the next natural timer activation and its exit/result, both active managers/full registrations, and Freshell health. A healthy tick can be silent. Confirm existing healthy manager/Freshell PIDs did not change. Never deliberately fail live managers to validate installation.
4. If a manager is already failed, starting it must fall within the separately approved recovery operation; installing the script alone is not authorization to start arbitrary live managers.
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
2. Required final Freshell gate, from the clean primary branch, is `env -u FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE -u FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE GCLOUD_ROBOT_REQUIRE=1 CARGO_BUILD_JOBS=4 FRESHELL_TEST_SUMMARY='Crash resilience final branch verification' pnpm run check`. It uses the existing configured cloud/local companion behavior. Run the canonical Electron sandbox proof at the final reviewed SHA and retain its exact selected-test count, timing and JSONL receipts. Do not restart the production server or install a Windows build as part of verification.
3. Required machines endpoint is its focused policy matrix, all seven affected SentinelX suites, an honestly reported final `tests/validate.sh` result and successful real isolated-systemd smoke at the reviewed SHA. A broad pre-existing unrelated timeout requires an explicit recorded disposition; it is never green coverage. An unresolved safe-guest prerequisite keeps the overall result `FAILED/non-converged`; it cannot be turned into a platform-confidence footnote.
4. Preserve actual workload/rootful-cgroup/headroom receipts, real >60-second Electron timing and no-false-success evidence, real manager/service-generation receipts and self-owned sentinel evidence. Parent updates the existing Kata items and usual run ledger with actual results, accepted residuals and every binding finding disposition.
5. End with clean focused commits and branches ready for user review. Push is permitted by repository instructions when the parent reaches that workflow stage. Stop before creating either PR; ask for the user's explicit approval to land the concrete branches. Deployment and Windows user testing remain separately approved operations, described with runbooks rather than performed here.

## Planner self-review

- The dispatcher-authored `## User Request` block appears unchanged exactly once above; requested behavior and accepted pane-recovery residual map to explicit tasks and acceptance.
- Runtime mocks cover scheduling/state decisions; they do not replace real workload completion, actual native-document outage recovery, or actual isolated-systemd manager/service restoration.
- No live host policy rewrite, deployed service change, production restart, client install/restart or PR creation is included. Resource defaults remain proposed until the two-job actual-workload proof has material measured headroom.
- The parent proved bounded private-cgroup/systemd/D-Bus and real guest manager/service restoration capability with retained receipts. Repaired-watchdog user-manager recovery remains required Task 4 acceptance, with a fail-closed fixture prerequisite recheck. No unsafe host-bound substitute is permitted.
- The completed `reports/guest-manager-prerequisite.md` was read before handoff: the unchanged watchdog reproduced UID 1000's failure after a real guest oomd restart, direct guest start restored its enabled service, and the original UID 1001 path restored its service. Both had new manager/service PIDs and receipt counts 1→2 without an independent login. Task 4 preserves the executed setup decisions and must prove the repaired script itself restores UID 1000.
- Self-review checked the dispatcher User Request byte-for-byte and exactly once, five coherent task boundaries, including the explicitly approved baseline readiness prerequisite, two Python blocks with AST parsing, 27 Bash blocks with `bash -n`, 18 TypeScript/JavaScript blocks with TypeScript syntax diagnostics, and in-memory TypeScript semantic diagnostics for the three central Electron production modules; all were clear. These are plan-code checks, not claimed implementation or acceptance test results.
- Source snippets are draft guidance and must be reconciled with exact current interfaces during the parent's independent plan review before execution. The plan's source-tree authority rule applies after implementation begins.


