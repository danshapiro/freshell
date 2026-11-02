# Measured Sandbox Build Budget Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix freshell#mdmw: give the 8 GiB test sandbox a measured safe default build concurrency, preserve deliberate overrides, record effective limits and useful container/workload failure diagnostics without exposing secrets, and prove the behavior with launcher tests and an isolated cold supported-toolchain Clippy run.

### Explicit constraints
- Follow the-usual workflow, including independent reviews.
- Keep the change scoped to freshell#mdmw, separate from machine watchdog and Electron recovery changes.
- Work in a dedicated .worktrees worktree from the recorded base cbae31df487bc150c1d57ba93b63f18910ce5098; preserve unrelated changes and existing worktrees.
- Use meaningful red/green/refactor tests and real integration/smoke evidence; never weaken coverage to pass.
- Do not reproduce memory pressure or kill a user manager on garageserver; use an isolated disposable environment for cold-build acceptance with equivalent rootless Docker/systemd behavior.
- Do not deploy, restart production, change host policy, or create a PR without the user's explicit approval; commit focused completed work.

### Accepted tradeoffs and residuals
- The user approved proceeding from the recorded failing base for this scoped fix, with existing failures recorded separately. The full gate exited 1 despite passing cloud test verdicts; the failing phase remains unidentified, so later failures cannot be assumed pre-existing without evidence.

**Goal:** Ordinary and managed-runtime sandbox launches default to two Cargo jobs under a real two-CPU, 8 GiB budget, retain intentional Cargo overrides, and leave secret-safe workload/limit/status receipts whose safety is confirmed by current-source isolated cold Clippy evidence.

**Architecture:** Add the budget once to the launcher's shared Docker arguments, with a small dependency-free Node helper for JSONL receipts and read-only kernel-limit observation immediately before the caller command. Keep Docker auto-removal, owned cleanup, guards, cache identity, and the two runtime phases; associate the existing CID file with a command SHA256 and distinguish the attached Docker exit from the final cleanup result. Reuse the canonical sandbox self-test, add a tiny real Cargo scheduling smoke, and perform final-source cold acceptance in a fresh disposable Ubuntu/systemd VM with normal rootless Docker.

**Tech Stack:** Bash, Node.js built-ins, TypeScript/Vitest, Docker/cgroup v2, Cargo/Rust 1.96.0, disposable QEMU/KVM Ubuntu 24.04 guest.

## Global Constraints

1. Work only in the dedicated worktree on the recorded base cbae31df487bc150c1d57ba93b63f18910ce5098. The user explicitly approved proceeding from its failing clean-base gate. Keep baseline failure evidence separate and do not classify a later failure as pre-existing without specific reproduction evidence.
2. Worktree: /home/dan/code/freshell/.worktrees/mdmw-sandbox-budget; branch: the-usual/mdmw-sandbox-budget. Plan: docs/plans/2026-11-01-mdmw-sandbox-budget.md. Tests run in this task worktree; temporary fixture projects are required test data, not additional test checkouts.
3. Follow repository AGENTS.md, pnpm 10.34.5, frozen installs, the configured cloud backends, coordinated broad gates, and the strict destructive-test sandbox route. Relative TypeScript module imports use .js. No dependency or lockfile change is needed.
4. Preserve --rm, --init, all existing cache mounts/labels, exact name/CID ownership, owner-guard behavior, signals, two-phase preparation, runtime read-only/network restrictions, early specialized dispatches, and cleanup failure returning 1.
5. Two jobs/two CPUs is a measured candidate, not current-source acceptance yet. Historical cold-rootless evidence at 3c90dd759f59d98bd9ea42fed2d4abaed4c49b9a measured 1,776,689,152 bytes (1.655 GiB), 125.061 seconds, PSI zero, no OOM deltas, and NUM_JOBS=2. Final branch acceptance must replace reliance on that old-source measurement.
6. Keep RAM 8 GiB, PIDs 512, and make Docker's existing total RAM-plus-swap allowance explicit as 16 GiB. Do not introduce a no-swap production policy. CPU quota is separate from Cargo's job selection; intentional Cargo --jobs and inline/environment overrides remain meaningful.
7. Additional diagnostics never include command text, arbitrary environment, Config.Env, Config.Cmd, raw inspect output, or raw daemon error text. Use fixed event names, JSON encoding, a command SHA256, exact CID when published/discovered, allowlisted numeric settings, observed cgroup controls, and exit statuses. Existing workload stdout/stderr remains its own stream. Do not infer OOM from exit 137.
8. Preserve auto-removal. Post-run container State/OOMKilled need not be retained; the compact records above satisfy ordinary diagnosis. Do not add a supervisor, permanent safety framework, state-retention mechanism, generic redactor, or audit trail.
9. Rust 1.96 is the package minimum; the required Rust workflow pins 1.96.0. The sandbox image installs floating stable: attribute its actual version, then use explicit +1.96.0 for the cold acceptance payload.
10. Never induce host memory pressure, kill a host or guest user manager, change host policy, touch production services, deploy, or open a PR. No Electron, watchdog, provider, unrelated Rust/Clippy, or machine repair belongs to this change. End-user UI/browser behavior is unchanged; browser tests are not meaningful acceptance for this shell/Docker change.
11. Follow the-usual independent reviews and binding-finding dispositions. A reviewer may suggest an implementation; resolve the substantiated finding by the smallest compliant means. Failed acceptance remains failed evidence; no old SHA, skipped suite, cache-warm graph, raised limits, or substituted backend counts as success.

---

## File responsibilities and dependency map

1. Modify scripts/sandbox-test.sh: select one budget, forward Cargo jobs, invoke the observer without reparsing the command, and add compact receipts to the existing owned lifecycle. The launcher remains the only lifecycle owner.
2. Create scripts/testing/sandbox-diagnostics.mjs: dependency-free JSON encoding, command digest, configured limits, read-only cgroup observations, exact-CID/Docker-exit receipt, and final settlement receipt. It does not manage any process or inspect Docker state.
3. Modify test/unit/tooling/sandbox-test.sandbox.ts: extend the existing recording-Docker fixture and add real-wrapper behavioral cases. Neighboring cases deliberately signal/kill processes, so this entire file stays on its strict sandbox config.
4. Create scripts/testing/sandbox-budget-smoke.mjs: six tiny offline Cargo members whose build scripts record NUM_JOBS and overlap, and assertions on actual cgroup controls and low resource use.
5. Modify scripts/sandbox-selftest.sh: invoke the default/override smoke through the actual wrapper; preserve all isolation proofs. Correct the existing narrow lock-generator readability/umask setup if needed for canonical acceptance, using the already identified 3c90dd759f59d98bd9ea42fed2d4abaed4c49b9a correction without weakening assertions.
6. Modify scripts/sandbox-cache-selftest.sh and scripts/test/sandbox-runtime-startup.test.sh: copy the newly required diagnostic helper with their existing copied launcher fixtures.
7. Modify test/unit/tooling/testing/codex-sandbox-cache.test.ts: copy the helper with its launcher fixture; preserve existing native-contract cache/security assertions.
8. Modify docs/development/test-sandbox.md: explain default versus overrides, configured versus observed limits, compact receipt fields, auto-removal's missing OOM state, and smoke usage. It is already linked agent documentation; no AGENTS.md, README, docs/index.html, or dependency change is necessary.
9. External acceptance-only artifacts, owned by this run: /home/dan/code/freshell/.worktrees/.the-usual-logs/mdmw-sandbox-budget/acceptance/driver/, /home/dan/code/freshell/.worktrees/.the-usual-logs/mdmw-sandbox-budget/acceptance/attempt-NNN/, and task-worktree test-results/mdmw-sandbox-budget/. Keep the external driver small and specific to this acceptance. Do not commit a permanent VM/monitoring framework.

The helper is consumed by the launcher and its copied-wrapper test fixtures. Task 2 consumes Task 1's clean committed source and real smoke. No parallel mutations of the feature worktree are needed.

## Task 1: Ship the shared default budget and compact diagnostics with behavioral coverage

**Files:**
- Modify: scripts/sandbox-test.sh:319, scripts/sandbox-test.sh:338, scripts/sandbox-test.sh:398, scripts/sandbox-test.sh:483, scripts/sandbox-test.sh:575
- Create: scripts/testing/sandbox-diagnostics.mjs
- Create: scripts/testing/sandbox-budget-smoke.mjs
- Modify/Test: test/unit/tooling/sandbox-test.sandbox.ts:16, test/unit/tooling/sandbox-test.sandbox.ts:108, test/unit/tooling/sandbox-test.sandbox.ts:195
- Modify/Test: test/unit/tooling/testing/codex-sandbox-cache.test.ts:11
- Modify/Test: scripts/sandbox-selftest.sh:382, scripts/sandbox-selftest.sh:541
- Modify/Test: scripts/sandbox-cache-selftest.sh:23
- Modify/Test: scripts/test/sandbox-runtime-startup.test.sh:103
- Modify: docs/development/test-sandbox.md:116

**Interfaces:**
- Consumes: existing fixture(mode: string), fixture.run(guard?: boolean, runtimeSuite?: boolean, twoPhase?: boolean), and real Bash launcher accepting one caller command argument.
- Produces: unchanged launcher CLI plus CARGO_BUILD_JOBS forwarded as the caller's nonempty exported value or "2"; --cpus 2, --memory 8g, --memory-swap 16g, and --pids-limit 512 for all shared-argv routes.
- Produces: Node helper subcommands digest; configured/effective CONTAINER PHASE SHA256 JOBS; workload CONTAINER PHASE SHA256 CID DOCKER_STATUS; final CONTAINER PHASE SHA256 DOCKER_STATUS FINAL_STATUS SETTLED. All receipt output is JSONL on stderr; digest alone returns a hex digest on stdout. Empty/unknown values are represented as null rather than fabricated success.
- Produces: node scripts/testing/sandbox-budget-smoke.mjs EXPECTED_JOBS [--cli-jobs EXPECTED_JOBS] with dependency-free offline Cargo fixtures and a sandbox_budget_smoke_passed JSON record.
- Produces: a focused clean implementation commit whose SHA is the acceptance source. Any later source correction requires a new commit and fresh affected acceptance, including final-source cold Clippy.

- [ ] **Step 1: Write the failing behavioral tests**

Extend the existing fixture rather than copying its owner/volume/guard model.

a. Add an optional fourth run parameter:

~~~ts
options: { command?: string; cargoJobs?: string } = {}
~~~

Select the wrapper command with options.command ?? 'true'. Put CARGO_BUILD_JOBS: options.cargoJobs ?? '' after ...process.env in the fixture's env so the default case cannot accidentally inherit the test runner's own job setting. Existing three-argument callers stay unchanged.

b. Add new fake-Docker modes without changing existing modes. For budget-success, budget-failure, budget-137, and budget-launch-failure, retain the existing volume creation logic and record the real docker argv. The launch-failure mode returns 125 before writing an object/CID. The other three publish the exact fixture CID, 'a'.repeat(64), and create the object. Their exit statuses are 0, 37, and 137 respectively. If the argv contains --rm, delete the object before returning, exactly modeling the ordinary post-completion auto-removal race. Leave the CID file intact. Do not synthesize resource receipt output inside the fake: receipts must come from the real copied Bash wrapper/helper.

c. Keep new fake fixture scenarios completed and low risk; the existing file's signal/guard scenarios still require strict execution. Add the following tests after the existing fixture definition:

~~~ts
function diagnosticRows(stderr: string) {
  return stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
}
function dockerRuns(events: Array<{ kind: string; args?: string[] }>) {
  return events.filter(event => event.kind === 'docker' && event.args?.[0] === 'run')
    .map(event => event.args!)
}
function option(args: string[], name: string) {
  const index = args.indexOf(name)
  expect(index, name + ' is present').toBeGreaterThanOrEqual(0)
  return args[index + 1]
}

describe('sandbox build budget and compact failure receipts', () => {
  it.each([false, true])('defaults every actual launch, runtime=%s', runtime => {
    const f = fixture('budget-success')
    try {
      const result = f.run(false, runtime, runtime)
      expect(result.status, result.stderr).toBe(0)
      const runs = dockerRuns(result.events)
      expect(runs).toHaveLength(runtime ? 2 : 1)
      for (const args of runs) {
        expect(args).toContain('--rm')
        expect(option(args, '--cpus')).toBe('2')
        expect(option(args, '--memory')).toBe('8g')
        expect(option(args, '--memory-swap')).toBe('16g')
        expect(option(args, '--pids-limit')).toBe('512')
        expect(args).toContain('CARGO_BUILD_JOBS=2')
      }
      const rows = diagnosticRows(result.stderr)
      expect(rows.filter(row => row.event === 'sandbox_resources_requested').map(row => row.phase))
        .toEqual(runtime ? ['dependency-preparation', 'runtime-suite'] : ['ordinary'])
      const exits = rows.filter(row => row.event === 'sandbox_workload_exit')
      expect(exits).toHaveLength(runtime ? 2 : 1)
      for (const row of exits) {
        expect(row.cid).toBe('a'.repeat(64))
        expect(row.dockerExitCode).toBe(0)
        expect(row.containerState).toBe('not_retained')
        expect(row.oomKilled).toBeNull()
      }
      expect(result.events.some(event => event.kind === 'docker' && event.args?.[0] === 'rm')).toBe(false)
    } finally { f.cleanup() }
  })

  it.each(['1', '3', '-1', 'bad\nvalue'])('forwards a deliberate exported Cargo value %j', cargoJobs => {
    const f = fixture('budget-success')
    try {
      const result = f.run(false, false, false, { cargoJobs })
      expect(result.status, result.stderr).toBe(0)
      expect(dockerRuns(result.events)[0]).toContain('CARGO_BUILD_JOBS=' + cargoJobs)
      expect(option(dockerRuns(result.events)[0], '--cpus')).toBe('2')
      const requested = diagnosticRows(result.stderr).find(row => row.event === 'sandbox_resources_requested')
      expect(requested).toBeDefined()
      expect(requested.cargoJobs).toBe(/^-?[0-9]+$/.test(cargoJobs) ? cargoJobs : 'non-numeric')
    } finally { f.cleanup() }
  })

  it('preserves one exact caller argument and emits only its digest in metadata', () => {
    const f = fixture('budget-success')
    const command = "printf '%s' 'token=mdmw-secret; $(not-executed) \"quoted\" \\\\ newline\nend'"
    try {
      const result = f.run(false, false, false, { command })
      expect(result.status, result.stderr).toBe(0)
      expect(dockerRuns(result.events)[0].at(-1)).toBe(command)
      const rows = diagnosticRows(result.stderr)
      expect(rows.find(row => row.event === 'sandbox_resources_requested')?.commandSha256)
        .toBe(createHash('sha256').update(command).digest('hex'))
      expect(JSON.stringify(rows)).not.toContain('mdmw-secret')
      expect(JSON.stringify(rows)).not.toContain('not-executed')
      expect(JSON.stringify(rows)).not.toContain('quoted')
    } finally { f.cleanup() }
  })

  it.each([
    ['budget-success', 0],
    ['budget-failure', 37],
    ['budget-137', 137],
    ['budget-launch-failure', 125],
  ] as const)('preserves %s attached status after auto-removal', (mode, code) => {
    const f = fixture(mode)
    try {
      const result = f.run(false, false)
      expect(result.status, result.stderr).toBe(code)
      const rows = diagnosticRows(result.stderr)
      const workload = rows.find(row => row.event === 'sandbox_workload_exit')
      expect(workload).toMatchObject({
        dockerExitCode: code, cid: code === 125 ? null : 'a'.repeat(64),
        oomKilled: null, containerState: 'not_retained',
      })
      expect(rows.find(row => row.event === 'sandbox_result')).toMatchObject({
        dockerExitCode: code, finalExitCode: code, settled: true,
      })
      expect(existsSync(f.state)).toBe(false)
    } finally { f.cleanup() }
  })

  it('keeps original Docker failure distinct from cleanup failure', () => {
    const f = fixture('remove-failed')
    try {
      const result = f.run(false, false)
      expect(result.status, result.stderr).toBe(1)
      const rows = diagnosticRows(result.stderr)
      expect(rows.find(row => row.event === 'sandbox_workload_exit')?.dockerExitCode).toBe(42)
      expect(rows.find(row => row.event === 'sandbox_result')).toMatchObject({
        dockerExitCode: 42, finalExitCode: 1, settled: false,
      })
      expect(result.control).toBeDefined()
      expect(existsSync(result.control!)).toBe(true)
    } finally { f.cleanup() }
  })
})
~~~

Do not assert log text/source contents. These tests execute the real wrapper and protect applied Docker settings, exact command arguments, preserved statuses, and association metadata. Add one assertion to existing guard/signal cases that an interrupted Docker wait reports an unknown attached status instead of zero; preserve their existing cleanup/ownership assertions.

- [ ] **Step 2: Run the tests and verify the intended failure**

Do this only after the parent has provided the dedicated worktree and the disposable acceptance guest described in Task 2 is ready. The strict fixture file cannot run directly on garageserver.

From the final guest's staged task source, run:

~~~bash
scripts/sandbox-test.sh --runtime-suite 'pnpm run test:vitest run test/unit/tooling/sandbox-test.sandbox.ts --config test/unit/tooling/sandbox-test.config.ts -t "sandbox build budget and compact failure receipts"'
~~~

Expected: FAIL on missing --cpus/CARGO_BUILD_JOBS/default receipt fields against unchanged launcher behavior. Preserve stdout/stderr and exact source identification as the RED evidence. If test setup fails, fix the test setup and rerun until the failure is the missing behavior. Do not count missing tools, helper files, permissions, or environment failures as RED.

A separate new safe fixture is optional only if it truly runs the real wrapper and completed fake Docker without process signaling. It is not necessary for this plan and must not replace the strict file's coverage.

- [ ] **Step 3: Add the minimal production implementation**

Create scripts/testing/sandbox-diagnostics.mjs with the following implementation:

~~~js
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [mode, container, phase, digest, first, second, third] = process.argv.slice(2)
if (mode === 'digest') {
  process.stdout.write(createHash('sha256').update(readFileSync(0)).digest('hex'))
} else {
  const knownPhase = ['ordinary', 'dependency-preparation', 'runtime-suite', 'settlement'].includes(phase)
    ? phase : 'settlement'
  const base = {
    container: /^freshell-sandbox-[a-zA-Z0-9]{8}$/.test(container ?? '') ? container : null,
    phase: knownPhase,
    commandSha256: /^[a-f0-9]{64}$/.test(digest ?? '') ? digest : null,
  }
  const status = value => /^(0|[1-9][0-9]{0,2})$/.test(value ?? '') && Number(value) <= 255
    ? Number(value) : null
  const jobs = value => /^-?[0-9]+$/.test(value ?? '') ? value : 'non-numeric'
  const emit = (severity, event, fields) =>
    process.stderr.write(JSON.stringify({ severity, event, ...base, ...fields }) + '\n')
  if (mode === 'configured') {
    emit('info', 'sandbox_resources_requested', {
      cargoJobs: jobs(first), cpus: 2, memoryBytes: 8589934592,
      memorySwapBytes: 17179869184, pidsLimit: 512,
    })
  } else if (mode === 'effective') {
    const read = (file, pattern) => {
      try {
        const value = readFileSync('/sys/fs/cgroup/' + file, 'utf8').trim()
        return pattern.test(value) ? value : null
      } catch { return null }
    }
    const controls = {
      cpuMax: read('cpu.max', /^(max|[0-9]+) [0-9]+$/),
      memoryMax: read('memory.max', /^(max|[0-9]+)$/),
      memorySwapMax: read('memory.swap.max', /^(max|[0-9]+)$/),
      pidsMax: read('pids.max', /^(max|[0-9]+)$/),
    }
    const available = Object.values(controls).every(value => value !== null)
    emit(available ? 'info' : 'warning', 'sandbox_effective_limits', {
      forwardedCargoJobs: jobs(first), controls, available,
    })
  } else if (mode === 'workload') {
    const code = status(second)
    emit(code === 0 ? 'info' : 'error', 'sandbox_workload_exit', {
      cid: /^[a-f0-9]{64}$/.test(first ?? '') ? first : null,
      dockerExitCode: code, containerState: 'not_retained', oomKilled: null,
    })
  } else if (mode === 'final') {
    const finalCode = status(second)
    emit(finalCode === 0 ? 'info' : 'error', 'sandbox_result', {
      dockerExitCode: status(first), finalExitCode: finalCode, settled: third === '1',
    })
  } else {
    process.stderr.write(JSON.stringify({
      severity: 'error', event: 'sandbox_diagnostic_mode_invalid',
    }) + '\n')
    process.exitCode = 2
  }
}
~~~

Apply these precise changes to scripts/sandbox-test.sh:

a. After REQUESTED_SIGNAL="" initialize SANDBOX_PHASE=settlement and COMMAND_SHA256="". Do not dereference CMD/RUNTIME_SUITE in --settle-owned. For a normal launch, before the shared DOCKER_ARGS block choose:

~~~bash
SANDBOX_CARGO_JOBS="${CARGO_BUILD_JOBS:-2}"
SANDBOX_PHASE=ordinary
if [ "$RUNTIME_SUITE" -eq 1 ]; then
  SANDBOX_PHASE=runtime-suite
  if [ "${FRESHELL_SANDBOX_PREPARE_ONLY:-}" = 1 ]; then
    SANDBOX_PHASE=dependency-preparation
  fi
fi
COMMAND_SHA256="$(printf '%s' "$CMD" | node "$REPO_ROOT/scripts/testing/sandbox-diagnostics.mjs" digest)"
~~~

Leave early dispatches and two-phase recursion ahead of this unchanged. Exported jobs propagate naturally to the child launchers; each child supplies its own phase/digest and independently owned container.

b. Keep run --rm --init, existing networks/mounts, and --pids-limit 512. Replace the old memory-only resource section with:

~~~bash
  --cpus 2
  --pids-limit 512
  --memory 8g
  --memory-swap 16g
  -e "CARGO_BUILD_JOBS=$SANDBOX_CARGO_JOBS"
~~~

Do not parse or rewrite the caller command. A nonempty caller value is forwarded unchanged, including a value Cargo itself will reject. Do not impose an integer subset or rewrite Cargo config/CLI flags.

c. In cleanup_owned_container, after resolving the existing cidfile/exact-name owned_cid and before existing mutation/absence checks, emit:

~~~bash
  node "$REPO_ROOT/scripts/testing/sandbox-diagnostics.mjs" workload \
    "$OWNED_CONTAINER_NAME" "$SANDBOX_PHASE" "$COMMAND_SHA256" \
    "$owned_cid" "${DOCKER_STATUS:-}" || true
~~~

The helper validates any CID string before logging it. Keep the existing cleanup validation, exact-ID operations, absence checks, retained control-directory failure, and --settle-owned behavior unchanged. A diagnostic failure cannot change the original cleanup/workload result.

d. At normal launch set DOCKER_STATUS="" until wait actually returns. Keep sandbox_workload_started and emit configured limits before launch. Replace only the final Docker command/wait with:

~~~bash
node "$REPO_ROOT/scripts/testing/sandbox-diagnostics.mjs" configured \
  "$OWNED_CONTAINER_NAME" "$SANDBOX_PHASE" "$COMMAND_SHA256" "$SANDBOX_CARGO_JOBS"
docker "${DOCKER_ARGS[@]}" "$IMAGE_TAG" bash -c '
  node /workspace/scripts/testing/sandbox-diagnostics.mjs effective "$1" "$2" "$3" "$4" ||
    printf '"'"'{"severity":"warning","event":"sandbox_effective_limits_unavailable"}\n'"'"' >&2
  exec bash -c "$5"
' sandbox "$OWNED_CONTAINER_NAME" "$SANDBOX_PHASE" "$COMMAND_SHA256" "$SANDBOX_CARGO_JOBS" "$CMD" &
DOCKER_CLIENT_PID=$!
if wait "$DOCKER_CLIENT_PID"; then DOCKER_STATUS=0; else DOCKER_STATUS=$?; fi
DOCKER_CLIENT_PID=""
~~~

The positional-argument prelude observes actual cgroups after the image entrypoint's privilege drop and immediately before caller execution. Its final exec preserves signal forwarding and shell semantics. The command is still one unchanged final argv element, including quotes, dollar signs, and newlines. No raw command is interpolated into the prelude.

e. In finish_owned_sandbox, after all existing cleanup and owner-guard outcomes are known and before the existing final log/exit, add:

~~~bash
  node "$REPO_ROOT/scripts/testing/sandbox-diagnostics.mjs" final \
    "$OWNED_CONTAINER_NAME" "$SANDBOX_PHASE" "$COMMAND_SHA256" \
    "${DOCKER_STATUS:-}" "$result" "$container_settled" || true
~~~

Keep the existing final sandbox_workload_finished/sandbox_workload_failed events and their post-cleanup semantics. Unknown attached exit on interruption stays null, while finalExitCode reports the actual signal/cleanup outcome. No Docker inspect calls or extra process supervisor are added.

f. Update copied-launcher fixtures to copy scripts/testing/sandbox-diagnostics.mjs:

- In sandbox-test.sandbox.ts create scripts/testing unconditionally and copy the helper alongside the wrapper before the optional owner-guard copy.
- In codex-sandbox-cache.test.ts add that exact helper path to its existing copied-files array.
- In sandbox-runtime-startup.test.sh add a cp alongside the owner-guard helper.
- In sandbox-cache-selftest.sh create scripts/testing beneath FIRST_ROOT and SECOND_ROOT, then copy the helper into both. Preserve its existing per-root volumes and cleanup.
- Check for any other copied-launcher fixture with rg and make the same dependency copy only where the launcher really executes. Do not weaken assertions or alter contract behavior.

Create scripts/testing/sandbox-budget-smoke.mjs by restoring the dependency-free six-member implementation from commit 73c28b98038cd0d8c8bedd2042eaef6866106e4f, then apply these precise corrections:

1. Parse expected jobs (only 1 or 2) from argv[2]. The optional remaining args are exactly [] or ['--cli-jobs', expected-jobs-as-string]; reject anything else.
2. Without --cli-jobs, assert Number(process.env.CARGO_BUILD_JOBS) equals expected jobs. With --cli-jobs, do not demand that the environment matches; append ['--jobs', String(jobs)] to the real cargo build arguments and assert the observed build scripts' NUM_JOBS matches expected jobs instead.
3. Keep its actual cpu.max quota/period=2, memory.max=8589934592, memory.swap.max=8589934592, and pids.max=512 assertions. No claim based solely on Docker argv qualifies.
4. Keep six offline workspace members with independent build.rs scripts, each retaining only 8 MiB for 300 ms, writing one complete line after finishing with name, NUM_JOBS, start/end nanoseconds. Assert exactly six distinct completions, every observed NUM_JOBS equals expected jobs, and measured overlap is at least one and no greater than expected jobs.
5. Keep the real Cargo timeout of 120 seconds, unique temp project and CARGO_TARGET_DIR beneath its owned temp directory, finally cleanup, actual memory.peak < 2 GiB and PSI some avg10 < 5. The environment's low-pressure smoke must not be substituted for the real cold Clippy graph in Task 2.
6. Keep sandbox_budget_smoke_passed as the success event and include observed jobs, overlap, actual cgroup readings, kernel peak, and pressure. This runs in ordinary mode because runtime /tmp is intentionally noexec.

The historical helper is completely available through Git; unlike the missing raw VM harnesses, no reconstruction is needed. Review/adapt its code rather than cherry-picking the old launcher commit. The specified edits define all changed behavior and leave its already-complete fixture source intact.

Before the final host-isolation section in scripts/sandbox-selftest.sh, append a numbered budget proof:

~~~bash
echo "=== Proof 9: actual default and deliberate Cargo overrides ==="
for BUDGET_CASE in default exported inline cli; do
  BUDGET_STATUS=0
  case "$BUDGET_CASE" in
    default)
      BUDGET_OUTPUT="$(env -u CARGO_BUILD_JOBS "$REPO_ROOT/scripts/sandbox-test.sh" \
        'node scripts/testing/sandbox-budget-smoke.mjs 2' 2>&1)" || BUDGET_STATUS=$?
      ;;
    exported)
      BUDGET_OUTPUT="$(env CARGO_BUILD_JOBS=1 "$REPO_ROOT/scripts/sandbox-test.sh" \
        'node scripts/testing/sandbox-budget-smoke.mjs 1' 2>&1)" || BUDGET_STATUS=$?
      ;;
    inline)
      BUDGET_OUTPUT="$(env -u CARGO_BUILD_JOBS "$REPO_ROOT/scripts/sandbox-test.sh" \
        'CARGO_BUILD_JOBS=1 node scripts/testing/sandbox-budget-smoke.mjs 1' 2>&1)" || BUDGET_STATUS=$?
      ;;
    cli)
      BUDGET_OUTPUT="$(env -u CARGO_BUILD_JOBS "$REPO_ROOT/scripts/sandbox-test.sh" \
        'node scripts/testing/sandbox-budget-smoke.mjs 1 --cli-jobs 1' 2>&1)" || BUDGET_STATUS=$?
      ;;
  esac
  if [ "$BUDGET_STATUS" -eq 0 ] &&
     printf '%s\n' "$BUDGET_OUTPUT" | grep -q '"event":"sandbox_budget_smoke_passed"'; then
    pass "bounded Cargo smoke completed: $BUDGET_CASE"
  else
    fail "bounded Cargo smoke failed: $BUDGET_CASE exit=$BUDGET_STATUS"
    printf '%s\n' "$BUDGET_OUTPUT"
  fi
done
echo
~~~

The default case explicitly removes the caller's variable and never assigns 2 itself. The CLI case proves a real --jobs 1 wins over the launcher's forwarded 2.

If canonical self-test Proof 6 encounters the known lock-generation ownership issue, apply only the historical correction: chmod caller-created fixture inputs before the two Docker lock generators; have each generator run 'umask 022; cd /fixture; ...'; remove the post-generation recursive chmod that cannot chmod root-owned locks with rootful Docker. Keep the existing manager-change and install-state assertions. Record whether this narrow prerequisite was needed.

Document the budget and override examples in docs/development/test-sandbox.md. Explain that requested JSON receipts describe intended settings, sandbox_effective_limits reads the running kernel, forwardedCargoJobs is inherited before an inline/CLI override, and sandbox_workload_exit/sandbox_result distinguish Docker completion and final cleanup. Explain that missing CID indicates unpublished identity, disappeared --rm containers have no retained State/OOMKilled, and exit137 alone cannot diagnose OOM. Include direct smoke examples, default budget, and the canonical selftest command; do not add a new end-user doc.

- [ ] **Step 4: Run the focused tests**

Repeat the exact Step 2 command in the disposable guest on the updated task source.

Expected: PASS. Check parsed receipts show exact CID even after the fake models --rm disappearance, and no added metadata contains the secret sentinel. Run the same real wrapper once with an actual caller that prints the quoted/metacharacter/newline sentinel and verify exact bytes against the supplied argument; caller stdout is allowed to contain its intentional text while metadata contains only the digest.

- [ ] **Step 5: Refactor while green**

Keep the single shared argv budget rather than repeating it across ordinary/runtime phases. Keep JSON encoding and numeric/null handling inside the helper; remove any copied shell JSON construction introduced during implementation except the fixed observer-unavailable fallback. Reuse the existing owned cleanup and recorder rather than adding competing lifecycle/identity code. Ensure the helper has no Docker/process-control responsibility.

Repeat the focused tests after this cleanup. Do not refactor unrelated cache, owner-guard, provider, or runtime implementations.

- [ ] **Step 6: Run impacted-test verification**

The impacted set includes real-wrapper ownership/guard/resource cases, Cargo launcher callers, per-worktree cache identity, native-contract wrapper dispatch, and real runtime preparation/startup. Keep all existing assertions and full cases.

Within the disposable guest, run:

~~~bash
scripts/sandbox-test.sh --runtime-suite 'pnpm run test:vitest run --config test/unit/tooling/sandbox-test.config.ts'
scripts/sandbox-test.sh --runtime-suite 'pnpm run test:vitest run test/unit/tooling/testing/codex-sandbox-cache.test.ts test/unit/tooling/testing/runtime-sandbox.test.ts test/unit/tooling/native-session-names.test.ts test/unit/tooling/sandbox-owner-guard.test.ts --config config/vitest/vitest.config.ts'
bash -n scripts/sandbox-test.sh scripts/sandbox-selftest.sh scripts/sandbox-cache-selftest.sh scripts/test/sandbox-runtime-startup.test.sh
node --check scripts/testing/sandbox-diagnostics.mjs
node --check scripts/testing/sandbox-budget-smoke.mjs
git diff --check
~~~

Expected: all commands exit0 and every selected test actually runs. The full strict config covers sandbox-test.sandbox.ts, run-rust-tests.test.ts, and rust-launcher-resources.sandbox.ts. The canonical actual-Docker selftest and real ordinary/runtime checks remain separately mandatory in Task 2.

Before final handoff, the parent runs the configured coordinated branch full-suite gate from the feature worktree:

~~~bash
env GCLOUD_ROBOT_REQUIRE=1 CARGO_BUILD_JOBS=2 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='freshell mdmw sandbox build budget branch verification' pnpm run test
~~~

Expected: PASS with every phase, including the configured cloud local companion and local Electron lane, completed normally. Do not disable a phase or fix unrelated Electron/provider behavior. Use the parent coordinator and wait for any foreign holder; this is not a competing gate launched by an explorer. Full-suite failures need explicit disposition and cannot be silently replaced by a local backend.

- [ ] **Step 7: Commit the task**

From the task worktree, after the focused green/refactor and impacted tests:

~~~bash
git add scripts/sandbox-test.sh scripts/testing/sandbox-diagnostics.mjs scripts/testing/sandbox-budget-smoke.mjs test/unit/tooling/sandbox-test.sandbox.ts test/unit/tooling/testing/codex-sandbox-cache.test.ts scripts/sandbox-selftest.sh scripts/sandbox-cache-selftest.sh scripts/test/sandbox-runtime-startup.test.sh docs/development/test-sandbox.md
git commit -m "fix: bound sandbox build concurrency and record effective limits"
git status --short
git rev-parse HEAD
~~~

Expected: a focused commit containing only Task 1 source/tests/docs and a clean worktree. Record its SHA/tree before Task 2 final-source acceptance. If the full coordinated gate occurs after this commit, it still validates the exact clean source. Never commit logs, generated temporary fixtures, copied workspaces, guest disks, or downloaded dependencies.

## Task 2: Prove actual wrapper behavior and final-source cold Clippy in a disposable rootless/systemd environment

**Files:**
- Create, external only: acceptance/driver/cold-acceptance.py and its task-specific shell/cloud-init inputs under this run's logs directory.
- Create, external only: acceptance/attempt-NNN/manifest.json, commands.jsonl, kernel-samples.jsonl, wrapper-tests.log, selftest.log, clippy.log, cleanup.json and source archive/manifest.
- Test: Task 1's actual current-source launcher, canonical scripts/sandbox-selftest.sh, and the final committed Rust graph.

**Interfaces:**
- Consumes: Task 1 clean commit/tree and source archive SHA256; current task reports plan-sandbox.md/workspace-baseline.md; the actual canonical launcher/selftest/smoke.
- Produces: immutable per-attempt evidence tying the exact source, image, toolchain, CID/PID/cgroup, controls, NUM_JOBS, statuses, peak/pressure/OOM observations, and exact cleanup to one acceptance result.
- External driver CLI:
  python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/mdmw-sandbox-budget/acceptance/driver/cold-acceptance.py --source /home/dan/code/freshell/.worktrees/mdmw-sandbox-budget --commit COMMIT_SHA --output /home/dan/code/freshell/.worktrees/.the-usual-logs/mdmw-sandbox-budget/acceptance/attempt-NNN
- COMMIT_SHA and NNN above are runtime arguments recorded verbatim in the manifest; replace them with the actual clean Task 1 commit and next unused attempt number. The driver rejects a nonmatching/dirty source and an existing output directory. It exits0 only after workload success, durable export, and independent exact cleanup; on any failure it retains the failed attempt and exits nonzero.

This is an operational acceptance task, with no additional product behavior. It reuses Task 1's meaningful RED/GREEN tests rather than introducing tests that merely check evidence prose or hashes.

- [ ] **Step 1: Prepare a fresh bounded environment and prove it before any compiler starts**

Do not reuse the absent historical raw harnesses/disks. Reconstruct a small task-owned driver from the recorded recipe in plan-sandbox.md and workspace-baseline.md, consulting the retained stage4-kvm-prerequisite.md only for the concrete qualified topology. Record every external task path for cleanup.

The driver provisions one fresh Ubuntu 24.04 KVM guest inside an exact-owned rootful outer Docker container in host system.slice, with hard 12 GiB/no-swap, four CPUs, 4096 PIDs, and only /dev/kvm passed through. Build public QEMU/cloud-image tools inside that outer image; do not install host packages or change host services/policy. Give the VM 8 GiB/four vCPUs, a new writable disk, unique task key/instance, and finite setup deadlines. Attribute the vendor image URL/checksum, outer image digest/tools, guest kernel/systemd, and actual Docker versions. Missing KVM or unfixable ordinary rootless prerequisites is a reported acceptance blocker, never permission to compile on garageserver.

Inside the guest use ordinary UID1000 with a real systemd user manager and ordinary rootless Docker: systemd cgroup driver/cgroup v2, delegated controllers, normal overlayfs, default private bridge, normal proc/sysfs, no host network, no unconfined/privileged workaround. Show actual guest dockerd/container processes beneath user-1000.slice/user@1000.service and actual UID maps. A host system.slice outer alone does not prove guest rootless topology.

Before accepting the environment, verify real kernel limits on a finite harmless probe container, two private-bridge containers communicating normally, an owned guest/outer/host sentinel, and an evidence export round trip. Do not induce OOM or user-manager failure. Any rootful lock-fixture correction needed belongs to Task 1 before its final commit, not an undocumented guest edit.

Use bounded commands and a task-owned external one-second sampler, not a permanent product supervisor. Set finite setup/workload/export/cleanup deadlines; reserve at least 120 seconds for export/cleanup. Historical guard thresholds are suitable for this task: stop the exact owned compiler container at 6 GiB inner memory, inner memory PSI some avg10 >10% for three consecutive samples, any new inner/outer OOM event, outer memory >11 GiB, host available <2 GiB, guest available <512 MiB, unhealthy owned sentinels, failed inspection, or overall deadline. Monitor outer/guest/host headroom too; never raise/remove limits to obtain a pass. Start only the bounded real workload, not a synthetic pressure reproducer.

Prepare this environment early enough to support Task 1 RED/GREEN. Any early source snapshot is labeled provisional and cannot satisfy final-source Clippy acceptance.

- [ ] **Step 2: Exercise real ordinary/runtime defaults, overrides, and canonical selftest**

Stage the clean final Task 1 commit as an exact archive in the guest, with a standalone source copy identified by commit/tree/archive digest and file manifest. Install pinned dependencies with pnpm install --frozen-lockfile in the guest copy. Attribute the canonical sandbox image build and its actual Rust version.

Run the complete Task 1 strict/impacted commands on the final source, then run:

~~~bash
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh 'node scripts/testing/sandbox-budget-smoke.mjs 2'
env CARGO_BUILD_JOBS=1 scripts/sandbox-test.sh 'node scripts/testing/sandbox-budget-smoke.mjs 1'
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh 'CARGO_BUILD_JOBS=1 node scripts/testing/sandbox-budget-smoke.mjs 1'
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh 'node scripts/testing/sandbox-budget-smoke.mjs 1 --cli-jobs 1'
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh --runtime-suite 'node -e "if (process.env.CARGO_BUILD_JOBS !== String(2)) process.exit(1)"'
scripts/sandbox-selftest.sh
~~~

Expected: every command exits0; the default actually comes from the launcher, the exported/inline/CLI override builds observe NUM_JOBS=1, both runtime phases have CPUs2/RAM8GiB/totalRAM+swap16GiB/PIDs512 and forwarded jobs2, and selftest ends ALL PROOFS PASSED. Record actual kernel-control receipts, exact normal --rm CID after return, and healthy sentinels.

Also execute the production diagnostic helper directly in one harmless guest container with independently configured one CPU, 256 MiB RAM, no swap, and 64 PIDs, using the canonical image with its entrypoint replaced by Node so package installation is not run. Assert that its effective receipt reports quota/period=1, memory.max=268435456, memory.swap.max=0, and pids.max=64. This protects the kernel-observation behavior: a helper that merely repeats the normal two-CPU/8-GiB requested constants must fail this check. Own and clean this probe by its exact recorded CID; it runs no compiler or pressure workload.

Separately use the actual wrapper to run exit37 and exit137; each must return its exact code with associated CID/digest/effective limits/final result, and neither may claim OOMKilled=true. Check all added metadata for the task secret sentinel without retaining real secrets. A literal quote/dollar/newline caller verifies exact command execution beyond the fake argv assertion. Preserve expected nonzero workload statuses as successful negative-case evidence, distinct from command/setup failures.

Task-specific tiny projects may be created only as disposable test fixtures, removed after each run. Do not create another repository checkout as a test environment. The standalone guest archive is the explicitly required isolated acceptance source, not a second host worktree.

- [ ] **Step 3: Run the identified cold supported-toolchain graph on the final commit**

Use fresh exact-owned target, registry, and Git-cache volumes and prove target empty at the pre-compiler barrier. Dependency/toolchain preparation may be networked but cannot precompile this graph. Record initial directory inventory and source/image/toolchain identity before release.

The identified payload is exactly:

~~~bash
rustup toolchain install 1.96.0 --profile minimal --component clippy && cargo +1.96.0 clippy -p freshell-session-host --all-targets -- -D warnings
~~~

Use CARGO_BUILD_JOBS=2 with actual two CPUs, RAM8589934592, total RAM-plus-swap17179869184, PIDs512. Inside cgroup v2 the expected memory.swap.max is 8589934592; a VM without physical swap is allowed, provided configured allowance and actual swap use are distinguished. Do not add --locked or change Clippy package/flags to avoid an observed problem.

A pinned public Rust-only image is allowed for this separate Cargo graph if its exact image digest, ABI/tools/UID, supported toolchain and live kernel controls are attributed. This avoids transporting a giant canonical image solely for Cargo; canonical current-source wrapper behavior remains independently proved in Step 2. Use the real final source archive, not the old historical crate graph.

The external driver starts the finite test container behind a barrier before rustup/compiler initialization. At the barrier record exact inner CID and guest PID, /proc cgroup path and UID map, rootless daemon/systemd lineage, cpu.max, memory.max, memory.swap.max, pids.max, environment jobs2, and empty target. Release only after the external sampler, cleanup deadline, owned sentinels, and durable export path are verified.

Observe memory.current, memory.peak, memory.events, memory.swap.current, memory.pressure, cpu.stat/cpu.max, pids.current/pids.events, guest/outer/host headroom and sentinel status every second. Verify actual NUM_JOBS=2 from at least one real Cargo build-script child environment in the running graph; CARGO_BUILD_JOBS in the launcher alone is insufficient evidence. Do not replace the compiler or inject changed source/build scripts to manufacture this observation.

Keep the finite acceptance container alive after the child exits, only long enough to durably capture final kernel samples and exact child/Docker status, then remove it by exact CID. This is task-only acceptance orchestration; it does not alter production launcher --rm behavior.

Expected: Clippy exits0 on final source, supported toolchain rustc/clippy1.96.0 is recorded, actual NUM_JOBS=2, peak is materially below the 8 GiB limit, PSI stays low, no OOM events/guard triggers/sentinel loss, and export succeeds. Record measured peak/headroom/duration rather than asserting safety from quotas alone. The historical 1.655 GiB result is comparison, not a required exact match.

If current source has unrelated Clippy failures, preserve and report the exact failure and disposition. Do not edit unrelated crates or call the acceptance successful from old evidence. If a necessary scoped source correction changes the final commit, rerun affected tests and this cold acceptance for the new commit.

- [ ] **Step 4: Export evidence, clean exact resources, and review independently**

Export commands/statuses, manifests, receipts, one-second/final kernel samples, actual NUM_JOBS evidence, full workload logs, expected-negative-case results, and failure attempts before deleting temporary source/dependencies/disks. Retain only needed evidence, not workspace/dependency copies.

Independent exact cleanup verifies the recorded container IDs absent, recorded volume labels/names gone and unreferenced, QEMU/outer container/owned sampler/sentinel processes ended, and task keys/disks/temp inputs removed. Match PID birth identity/cwd/argv before terminating a task process. Never broad-kill, alter another task's resources, delete shared caches, or treat a failed inspect as proof of absence. The source branch/worktree remains for user review.

Request the-usual specification-plus-quality independent review of Task 2 evidence and the final implementation. Review must assess supported-toolchain final-source attribution, normal rootless/systemd topology, pre-compiler limits, actual jobs2, cold graph, peak/PSI/OOM/sentinels, expected failure diagnosis, and cleanup. Resolve all binding findings under the supplied scope/disposition rule. Evidence generation or a passing mock alone cannot close a real-route finding.

- [ ] **Step 5: Complete the scoped handoff**

The parent records independent verdicts, exact commit, measured cold result, actual commands and evidence locations in the run contract. The configured branch full-suite gate from Task 1 must pass before claiming completion. If a binding required check cannot pass within scope, preserve its failure and report FAILED/non-converged; an unresolved disposition is not success. No browser suite is added just to claim e2e coverage: the actual Bash/Docker default/runtime/selftest/Cargo routes provide that coverage.

No extra product code or evidence-checking test is required here. If acceptance requires a scoped code fix, return to Task 1's red/green/refactor path, commit it, and rerun final-source acceptance. Ask for PR/landing authorization only after the concrete clean committed result and evidence are ready; do not create a PR or deploy in this plan.

## Requirement coverage and self-review

1. Safe measured default: Task 1 shared argv and the genuine default smoke; Task 2 cold Rust1.96.0 graph establishes final-source safety under real enforced controls.
2. Deliberate overrides: unchanged command boundaries, nonempty exported value forwarding, real exported/inline/Cargo --jobs smokes. CPU quota remains the aggregate default.
3. Effective limits: requested receipt is distinct from kernel reads before caller execution, with explicit unavailable fields; acceptance requires numeric real controls.
4. Useful secret-safe failures: command digest plus exact CID, Docker attached status and final settlement status, no added command/env/raw daemon data, null OOM state after --rm, and no inference from137. Existing original workload stdout/stderr is not copied into metadata.
5. Behavioral and e2e/smoke evidence: real wrapper fixtures RED/GREEN, preserved ownership/cache/guard cases, actual ordinary/runtime modes, canonical selftest, real Cargo overrides and isolated cold Clippy.
6. Scope and operational safety: worktree/base prerequisite, no host pressure/user-manager kill/policy/production/PR action, no Electron/watchdog/provider/unrelated Clippy repair, owned external driver and exact cleanup.
7. Independent review and commits: each deliverable gets the-usual fresh specification/quality gate, focused source commit, and explicit binding-finding disposition.

Self-review: PASS for the draft. The full dispatcher-authored User Request appears unchanged exactly once. Every requested result and constraint maps above; the approved failing-base residual is recorded separately, with no deferred production behavior, stub-as-acceptance, broad framework, or dependency change. The helper/copying dependencies, actual wrapper command boundary, --rm/CID behavior, unknown interrupted Docker status, and final-source acceptance are explicit.

Execution prerequisites remain factual gates, not completion claims: the user approved the recorded failing base and the dedicated worktree is established; a qualified disposable environment, final-source measured acceptance, and independent review remain mandatory. Baseline failure details remain in the external run record.

