# Measured Sandbox Build Budget Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix freshell#mdmw: give the 8 GiB test sandbox a measured safe default build concurrency, preserve deliberate overrides, record effective limits and useful container/workload failure diagnostics without exposing secrets, and prove the behavior with launcher tests and an isolated cold supported-toolchain Clippy run. Address the three required sandbox review findings and investigate and fix the Codex blockers preventing the full suite, then rerun verification.

### Explicit constraints
- Follow the-usual workflow, including independent reviews; the user explicitly authorized repairs after the passed delta review.
- Keep the change scoped to freshell#mdmw and the Codex blockers preventing its verification, separate from machine watchdog and Electron recovery changes.
- Work in a dedicated .worktrees worktree from the recorded base cbae31df487bc150c1d57ba93b63f18910ce5098; preserve unrelated changes and existing worktrees.
- Use meaningful red/green/refactor tests and real integration/smoke evidence; never weaken coverage to pass.
- On garageserver, store agent-created files only on the /home filesystem (including /tmp); if it lacks space, report the problem rather than using another filesystem.
- Do not reproduce memory pressure or kill a user manager on garageserver; use an isolated disposable environment for cold-build acceptance with equivalent rootless Docker/systemd behavior.
- Do not deploy, restart production, change host policy, or create a PR without the user's explicit approval; commit focused completed work.

### Accepted tradeoffs and residuals
- The user approved proceeding from the recorded failing base for this scoped fix, with existing failures recorded separately. The full gate exited 1 despite passing cloud test verdicts; the failing phase remains unidentified, so later failures cannot be assumed pre-existing without evidence.
- The user approved addressing the sandbox review findings and expanding the work to resolve the Codex blockers so verification can be rerun.

**Goal:** Ordinary and managed-runtime sandbox launches use a real two-CPU, 8 GiB budget whose native Cargo default is two jobs, preserve deliberate Cargo configuration/environment/CLI overrides, and produce secret-safe effective-limit and failure receipts backed by launcher tests and isolated current-source cold Clippy evidence. Strengthen the identified sandbox tests and failure diagnostics, resolve Codex blockers without weakening their behavior coverage, and complete the full-suite verification.

**Architecture:** Set the shared Docker CPU/memory/swap/PID budget once. Let Cargo derive its default from the enforced CPU quota, forwarding only a caller-supplied jobs environment value; add a dependency-free Node observer/JSONL receipt helper within the existing owned lifecycle. Preserve auto-removal and exact cleanup, prove the launcher through its strict Docker test enclosure, and perform real cold acceptance in one fresh bounded normal-rootless/systemd KVM guest.

**Tech Stack:** Bash, Node.js built-ins, TypeScript/Vitest, Docker/cgroup v2, Cargo/Rust 1.96.0, Ubuntu 24.04 QEMU/KVM guest.

## Global Constraints

1. Keep immutable approved base cbae31df487bc150c1d57ba93b63f18910ce5098 and worktree /home/dan/code/freshell/.worktrees/mdmw-sandbox-budget on branch the-usual/mdmw-sandbox-budget. Main advanced with unrelated UI changes; do not rebase this approved run or alter the older broad crash-resilience work.
2. Follow repository AGENTS.md, pnpm 10.34.5, frozen installs, configured cloud backends and coordinated broad gates. Tests run in this task worktree. Tiny generated projects are required fixtures; the exact archive inside the explicitly required isolated guest is acceptance input, not an additional host test checkout.
3. Preserve --rm, --init, exact name/CID ownership, owner-guard and signals, cache identity/mounts/labels, early specialized dispatches, both runtime preparation/execution phases, runtime restrictions, and cleanup failure returning 1. No second lifecycle owner, retained-container framework, generic redactor, supervisor, or audit trail.
4. Apply --cpus 2, --memory 8g, --memory-swap 16g, and --pids-limit 512 in the shared launch arguments. Total RAM-plus-swap is explicit; do not introduce a no-swap product policy. The fixed aggregate CPU quota applies to every sandbox workload, including explicit higher Cargo job counts; this change adds no CPU-limit override. Document that throughput tradeoff. The required full-suite gate must treat any resulting timeout as a failure to investigate, not a presumed baseline failure.
5. The normal default leaves CARGO_BUILD_JOBS absent. Cargo 1.96's native selector reads cgroup quotas; do not inject an environment fallback that masks project build.jobs. Preserve project configuration, nonempty exported environment strings, inline assignments, and CLI overrides. Never parse arbitrary project TOML, rewrite the caller command, or add a fallback config unless actual scheduling disproves the selected native path.
6. Historical two-job evidence is a reliable candidate only. Final-source ordinary/runtime scheduling and cold current-source resource/containment evidence remain mandatory. Attribute the canonical image's floating Cargo version separately from the explicitly pinned Rust/Clippy 1.96.0 payload.
7. New metadata contains fixed events, JSON encoding, command SHA256, published full CID, allowlisted numeric/null settings, own cgroup controls, and true statuses. Never add command text, arbitrary environment, Config.Env/Config.Cmd, raw inspect output, or raw daemon errors to metadata. Keep original workload stdout/stderr separate. Unavailable OOM state stays null; exit 137 is not proof of OOM.
8. Fixed-path controls describe the workload's own cgroup, not an invented minimum across invisible ancestors. Required acceptance independently verifies actual limits, delegation, normal namespace and relevant ancestor capacity. Unavailable fields are honest diagnostics but cannot replace numeric acceptance evidence.
9. Never reproduce memory pressure on garageserver, kill a user manager, change host policy, deploy/restart production, or open a PR. Codex changes are limited to resolving the failures blocking verification; no Electron recovery, watchdog, other provider, unrelated Rust/Clippy, or machine repair belongs to this task.
10. Finite harmless fake-Docker RED/GREEN may run inside the repository's strict Docker enclosure on garageserver. Do not run its process-signal fixture directly on the host. Real cold acceptance and resource-failure observation use the disposable guest.
11. Kata criterion 5 allows cold Clippy to complete within budget or fail its own sandbox with useful evidence while unrelated services remain healthy. Report a failed workload as failed, with graph coverage and limits of measurement. Setup failure, missing jobs/controls, lost evidence, or a driver protective stop is not automatic proof of product containment.
12. The approved broad base gate exited 1 despite passing cloud shard verdicts; its failing phase/wrapper status remains unidentified. Later failures receive their own evidence and disposition; none is automatically pre-existing. Full-suite verification remains a separate gate.

---

## File responsibilities and dependency map

1. Modify scripts/sandbox-test.sh: shared limits, conditional forwarding of an explicit jobs value, unchanged command argument, pre-caller observation, and compact receipts within existing settlement.
2. Create scripts/testing/sandbox-diagnostics.mjs: dependency-free JSONL/digest formatting and four read-only own-cgroup observations. No Docker or process management. Keep mode 0644 and invoke via Node.
3. Modify test/unit/tooling/sandbox-test.sandbox.ts: extend existing recording-Docker fixture and execute the actual copied launcher. The whole file retains its strict sandbox configuration.
4. Create scripts/testing/sandbox-budget-smoke.mjs: restore/adapt the existing six-member offline Cargo smoke from commit 73c28b98038cd0d8c8bedd2042eaef6866106e4f; prove actual jobs/overlap, native defaults, and overrides. Keep mode 0644 and invoke via Node; neither new .mjs file is a new executable launch owner.
5. Modify scripts/sandbox-selftest.sh: add actual default/project/exported/inline/CLI smoke cases while retaining every isolation proof. Apply the already identified narrow lock-generator readability/umask correction only if needed.
6. Modify scripts/sandbox-cache-selftest.sh, scripts/test/sandbox-runtime-startup.test.sh, and test/unit/tooling/testing/codex-sandbox-cache.test.ts: copy the newly required helper wherever the real copied launcher executes.
7. Modify docs/development/test-sandbox.md: explain quota-derived defaults versus overrides, requested/observed limits, compact receipts, and missing post-removal state. This existing usage document is already linked from AGENTS.md. The new plan receives its own single reference there during Stage 2; no instructions change. No end-user UI, dependency, lockfile, README or docs/index.html change is needed.
8. Acceptance-only driver/evidence belongs under /home/dan/code/freshell/.worktrees/.the-usual-logs/mdmw-sandbox-budget/acceptance/. Disposable guest disks/keys/seed/source inputs belong under the task worktree .test-tmp/ and are recorded for exact cleanup. Review results belong under test-results/mdmw-sandbox-budget/. Before any rootful bind, create task-owned directories as the current user and verify ownership; do not let Docker create them. Verify ignores with `git check-ignore -v .test-tmp/check test-results/check`: the existing common Git exclude covers .test-tmp/ and .gitignore covers test-results/. Do not commit tooling frameworks, guest disks, archives, dependencies, or logs.

Task 1 produces the clean implementation commit. Task 2 accepts exactly that commit; later scoped source corrections require a new commit and affected revalidation. No parallel worktree mutators are needed.

## Task 1: Implement the shared budget and compact receipts with behavioral tests

**Files:** scripts/sandbox-test.sh; new scripts/testing/sandbox-diagnostics.mjs; new scripts/testing/sandbox-budget-smoke.mjs; test/unit/tooling/sandbox-test.sandbox.ts; test/unit/tooling/testing/codex-sandbox-cache.test.ts; scripts/sandbox-selftest.sh; scripts/sandbox-cache-selftest.sh; scripts/test/sandbox-runtime-startup.test.sh; docs/development/test-sandbox.md.

**Interfaces:**

- Preserve the one-argument caller-command CLI and existing runtime flags.
- Extend existing fixture.run(guard?, runtimeSuite?, twoPhase?, options?) with optional command and cargoJobs inputs. The default test input explicitly removes ambient CARGO_BUILD_JOBS; an explicit input is forwarded unchanged.
- Helper modes: digest; configured/effective CONTAINER PHASE SHA256 JOBS_ENV; workload CONTAINER PHASE SHA256 CID DOCKER_STATUS; final CONTAINER PHASE SHA256 DOCKER_STATUS FINAL_STATUS SETTLED. An empty jobs argument means absent, not an invented default. An empty digest argument means unavailable and encodes null; other nonempty digests must be validated hex. Digest alone writes hex on stdout; other modes emit JSONL on stderr.
- Smoke CLI: node scripts/testing/sandbox-budget-smoke.mjs EXPECTED_JOBS, optionally followed by exactly --cli-jobs EXPECTED_JOBS or --project-jobs EXPECTED_JOBS. Expected jobs is 1 or 2; other argument forms fail. Each mode observes actual build-script NUM_JOBS.
- Stage 2 corrected decisions below intentionally replace invalid unexecuted draft implementation snippets. No newly authored unexecuted product code is prescribed as validated code.

- [x] **Step 1: Write failing real-wrapper behavioral tests**

Extend the existing fixture, preserving its owner/volume/guard model. Add completed fake modes budget-success, budget-failure, budget-137, and budget-launch-failure. Preserve real argv recording and volume creation. The first three publish full CID a repeated 64 times, create the object, then remove the object before return when --rm applies; retain the CIDfile, matching Docker's established contract. Return 0, 37, 137 respectively. Launch failure returns 125 without publication. The fake must never fabricate diagnostic rows.

Add behavioral cases that:

1. Run ordinary and actual two-phase runtime paths; each real Docker argv has --rm, CPUs 2, RAM 8g, total RAM-plus-swap 16g, PIDs 512. No CARGO_BUILD_JOBS argument appears in the absent-env default. Runtime has both dependency-preparation and runtime-suite receipts.
2. Forward deliberate exported strings 1, 3, -1 and an invalid newline-containing value unchanged, retaining quota 2. Metadata shows only a numeric string, null, or a fixed non-numeric marker; it never prints the invalid raw value.
3. Pass one exact quote/dollar/metacharacter/newline caller argument through the real wrapper; compute its expected SHA256 in the test and verify added metadata contains only that digest, never the secret sentinel or command fragments.
4. Preserve attached statuses 0, 37, 137, 125; associate the full published CID after object auto-removal, use null for unpublished identity, and keep OOM null/state not retained.
5. Preserve the existing remove-failed case's original Docker status 42 separately from final cleanup status 1 and settled=false, retaining its control directory. Successful cleanup leaves no owned control directory.
6. Preserve all existing guard/signal/ownership cases; interrupted wait must not report false attached status 0.
7. Omit the copied diagnostic helper, and separately replace it with a fixture-only helper that exits nonzero for each of digest, configured, workload and final modes. Execute the real launcher for successful and exit-37 workloads plus remove-failed cleanup: the caller still runs, original attached status remains 0, 37 or 42, cleanup failure still returns 1 and retains its control directory, and each unavailable diagnostic emits a fixed secret-safe event rather than a fabricated successful observation. Missing digest becomes null. Use finite subprocess deadlines and no new production fault-injection interface.
8. Exercise effective-observation failure by running the actual new Bash prelude tail argv in a bounded subprocess against the fixture's copied missing/failing helper and a caller that writes a marker then exits 37. Map only the container helper pathname to the fixture pathname; keep the final caller argument unchanged. Assert exact marker/output, exit 37 and the unavailable event. The fake must execute the prelude for this case, not fabricate its receipt.

Keep the original fixture working against unchanged source for RED. Add copies of the new helper only in Step 3 when that file is created; do not turn RED into a missing-helper setup failure. Existing budget/default assertions must fail because the real launcher lacks the new CPU/receipt/forwarding behavior.

- [x] **Step 2: Run focused RED in the existing strict enclosure**

From this task worktree, run:

~~~bash
scripts/sandbox-test.sh --runtime-suite 'pnpm run test:vitest run test/unit/tooling/sandbox-test.sandbox.ts --config test/unit/tooling/sandbox-test.config.ts -t "sandbox build budget and compact failure receipts"'
~~~

Expected: intended assertions fail against unchanged launcher behavior. Save the exact source identification and log. Fix setup errors and rerun until the missing behavior causes failure; tools, permission, or helper-copy errors are not RED. A fresh VM is not a prerequisite for these finite fake-Docker cases. No compiler/pressure reproduction is part of this step.

- [x] **Step 3: Implement the smallest production behavior**

In the single shared Docker argument block add CPU 2 and explicit total RAM-plus-swap 16g; retain RAM 8g and PIDs 512. Append the CARGO_BUILD_JOBS environment argument only for a caller-supplied nonempty value. An empty/unset value follows Cargo's native default. Do not validate/restrict deliberate strings or inject 2; Cargo remains responsible for its own config/CLI/error semantics.

Initialize diagnostic phase/digest and attached status safely before lifecycle use. The commandless --settle-owned route must not dereference CMD/RUNTIME_SUITE. Normal launches select ordinary, dependency-preparation or runtime-suite phase after existing specialized dispatch/two-phase recursion. Hash the exact caller bytes via helper stdin without logging them.

The helper JSON-encodes fixed severity/event fields. Validate owned names and full CIDs/digests; encode absent/unknown values as null, numeric jobs strings unchanged, invalid jobs values as a fixed marker. Emit:

1. sandbox_resources_requested with configured CPU/memory/total-swap/PID policy and absent-versus-explicit jobs input.
2. sandbox_effective_limits with actual cpu.max, memory.max, memory.swap.max and pids.max from /sys/fs/cgroup, string/max/null values, availability and severity. Read after canonical entrypoint gosu sandbox and immediately before the unchanged caller. Never repeat requested constants as observed values or assert effective Cargo jobs from an environment string.
3. sandbox_workload_exit with the exact owned CID when published/discovered, true attached Docker status or null, state not_retained, OOM null. Emit before existing cleanup removes the control directory, using its existing CID/name resolution.
4. sandbox_result with attached status separately from final status and settled outcome, after existing container/guard cleanup.

Add a positional-argument shell prelude: helper runs before final exec of the caller, whose text remains one unchanged argv element and the final Docker argument, preserving existing args.at(-1) callers. Guard every auxiliary digest, observation and receipt invocation against set -e termination; suppress raw helper failures and emit a fixed secret-safe unavailable event. A failed digest becomes null, and failed observation never claims effective limits were observed. Auxiliary failure must not skip the caller, overwrite an original attached/cleanup status, or bypass settlement; missing required diagnostic evidence still fails acceptance even when the workload itself exits 0. Preserve existing workload-started/finished/failed semantics, ownership checks, removal, guard joining and signal handling.

Create the helper and then add dependency copies to the four existing real copied-wrapper fixtures. Search for other actual launcher copies and add only necessary copies. Do not change stub-only fixtures or weaken their assertions.

Restore the historical six-member smoke and adapt its intent:

1. Six independent offline members each retain 8 MiB for 300 ms and write one complete completion record with name, NUM_JOBS and start/end timestamps. Require exactly six distinct completions, expected NUM_JOBS for all, and overlap between one and the expected job cap.
2. Native default mode requires no jobs environment/config/CLI override or inherited external jobserver. Project mode creates fixture-local .cargo/config.toml build.jobs and runs Cargo from that project directory. CLI mode passes the real --jobs argument. Environment modes receive their setting through actual wrapper invocation.
3. Use unique fixture source/target directories, a 120-second Cargo deadline and finally cleanup. Runtime uses the existing executable-artifact root FRESHELL_TEST_EXECUTABLE_TMP_DIR for its owned fixture/target; preserve runtime restrictions instead of changing temp mount policy.
4. Assert actual own-cgroup CPU ratio 2, memory 8589934592, swap allowance 8589934592 and PIDs 512, low-pressure smoke lifetime memory.peak below 2 GiB and MEMORY PSI some avg10 from memory.pressure below 5. Warm fingerprinted Node dependencies in a separate completed setup container before the measured smoke containers; verify their entrypoints reuse that fingerprint without installation. Do not reset memory.peak or include bootstrap in the tiny-build measurement; do not precompile the cold Cargo graph. Emit sandbox_budget_smoke_passed with observed jobs/overlap/kernel readings. A tiny smoke never replaces the final cold graph.

Add selftest default, project 1, exported 1, inline 1 and CLI 1 cases through the actual wrapper. Before these measured cases, warm fingerprinted Node dependencies through a separate completed wrapper setup container running only `:`. Default explicitly removes CARGO_BUILD_JOBS and never assigns 2. Keep all original isolation proofs, including their intentional dependency-install cases. If known Proof 6 lock-generation permissions block acceptance, apply only the already identified input readability plus generator umask 022 correction; preserve its assertions and record necessity.

Document the fixed CPU budget for all workloads, higher-job override throughput limits, requested versus observed controls, and compact diagnostics in the existing agent test-sandbox documentation. State plainly that unavailable OOM state remains null and exit 137 is never classified as OOM by this launcher.

- [x] **Step 4: Run focused GREEN**

Repeat Step 2's exact strict command from the task worktree. Expected: all selected cases pass, after real RED evidence. Ensure the secret sentinel appears nowhere in added metadata and published CID survives modeled auto-removal. Later Task 2 executes the actual literal quote/newline caller to verify bytes beyond fake argv.

- [x] **Step 5: Refactor while green**

Keep one shared resource budget and one lifecycle owner. Keep JSON/numeric/null formatting in the helper; remove new duplicated shell JSON except a fixed unavailable fallback. Reuse existing cleanup/recording fixtures. Repeat the focused tests. No unrelated cache, provider, runtime or owner-guard restructuring.

- [x] **Step 6: Run impacted verification**

From the task worktree, preserve the strict enclosure for process-signal fixtures:

~~~bash
scripts/sandbox-test.sh --runtime-suite 'pnpm run test:vitest run --config test/unit/tooling/sandbox-test.config.ts'
scripts/sandbox-test.sh --runtime-suite 'pnpm run test:vitest run test/unit/tooling/testing/codex-sandbox-cache.test.ts test/unit/tooling/testing/runtime-sandbox.test.ts test/unit/tooling/native-session-names.test.ts test/unit/tooling/sandbox-owner-guard.test.ts --config config/vitest/vitest.config.ts'
bash -n scripts/sandbox-test.sh
bash -n scripts/sandbox-selftest.sh
bash -n scripts/sandbox-cache-selftest.sh
bash -n scripts/test/sandbox-runtime-startup.test.sh
node --check scripts/testing/sandbox-diagnostics.mjs
node --check scripts/testing/sandbox-budget-smoke.mjs
git diff --check
~~~

Expected: all commands exit 0 and selected tests actually run, covering resource/ownership/guard cases, Cargo callers, per-worktree caches, native-contract dispatch and runtime preparation/startup. Tests invoking real substantial compilation must use Task 2's qualified guest; finite fixture cases may stay in the task's strict enclosure.

- [x] **Step 7: Commit the coherent implementation**

~~~bash
git add scripts/sandbox-test.sh scripts/testing/sandbox-diagnostics.mjs scripts/testing/sandbox-budget-smoke.mjs test/unit/tooling/sandbox-test.sandbox.ts test/unit/tooling/testing/codex-sandbox-cache.test.ts scripts/sandbox-selftest.sh scripts/sandbox-cache-selftest.sh scripts/test/sandbox-runtime-startup.test.sh docs/development/test-sandbox.md
git diff --cached --check
git diff --cached --summary
git commit -m "fix: bound sandbox build concurrency and record effective limits"
git status --short
git rev-parse HEAD
~~~

Expected: staged whitespace check exits 0 and the summary shows both new .mjs files as mode 100644, followed by a focused source/tests/docs commit and clean worktree. Record its commit/tree before final-source acceptance. Any later scoped correction requires affected tests and a new commit. Reuse the recorded cold result only when the actual workload and its complete compiled input closure are demonstrated unchanged; otherwise repeat cold acceptance on the corrected source. Attribute the measured source honestly, and run the final full-suite gate on the final committed HEAD.

## Task 2: Prove actual launcher behavior and cold Clippy in one disposable normal-rootless/systemd guest

**Files:** external task-only driver and per-attempt manifests/commands/receipts/kernel samples/workload logs/cleanup records beneath this run's acceptance directory; Task 1 actual launcher/helper/smoke/selftest and exact final committed source.

**Interfaces:**

- Consume clean final commit/tree and exact source archive digest; each attempt has a new owned directory and immutable result evidence.
- Produce distinct actual workload/attached-Docker/launcher/cleanup statuses plus a separate acceptance judgment. Never change child statuses to encode a policy pass.
- A small task-specific setup/runner may orchestrate this one guest and finite evidence collection. No prescribed permanent driver API, cloning framework, host-pressure monitor or product supervisor.

- [x] **Step 1: Prepare and qualify one fresh bounded guest before real acceptance compilation**

The read-only cloud route is unavailable with current Compute API/robot authority. Use the available rootful Docker/KVM tool image, not missing old disks/harnesses. Immediately before allocation, perform one read-only capacity admission: require host MemAvailable at least 28 GiB (20 GiB outer cap plus 8 GiB reserve), at least 120 GiB free on each backing filesystem used for the 100 GiB guest disk and Docker storage, and at least 28 GiB remaining under every finite host ancestor memory.max. Missing readings or lower capacity stop setup without allocation; do not add a host-pressure monitor or change host policy. Pre-create every task bind directory as the current user, verify its ownership and the documented Git ignores, then create one exact-owned outer container explicitly in host system.slice: RAM 20 GiB, total RAM-plus-swap 20 GiB, CPUs 4, host PIDs 512, only /dev/kvm passthrough. Give the Ubuntu 24.04 guest RAM 16 GiB/four vCPUs and one new 100 GiB virtual disk. Keep outer/guest allocations finite; never pair the larger guest with the old 12 GiB outer cap. No garageserver package/service/policy change.

Record vendor image/checksum, toolimage identity, guest kernel/systemd/Docker, owned PID/CID/cgroups and paths. Require KVM rather than silently switching acceleration. Use task-only SSH key/cloud-init/forwarding and finite setup/workload/export/cleanup deadlines with time reserved for export/cleanup. Keep the small guest setup specific to this run.

Inside the guest use ordinary UID 1000, a real systemd user manager, normal rootless Docker/systemd cgroup v2 delegation, supported overlayfs, private Docker bridge and normal proc/sysfs. Prove rootless daemon/workload ancestry beneath the guest user manager and real UID maps. Guest-local ordinary package/delegation setup is allowed; no privileged/unconfined/host-network workaround and no host-policy change.

Provide at least 8 GiB physical guest swap for the advertised container swap allowance; record guest swap availability/use separately from cgroup allowance. Record read-only host and guest systemd-oomd enabled/active state and relevant user-slice ManagedOOM policy. Before interpreting a swap-using or oomd-related failure as evidence for host manager preservation, qualify the relevant behavior in the disposable guest; otherwise report the observed guest-only outcome and the missing equivalence. A no-swap or oomd-disabled guest cannot prove manager-preservation failure paths it did not exercise. Do not recreate a manager-kill scenario or alter the host to obtain equivalence.

Before releasing a compiler, prove actual outer placement/bounds, guest memory/CPU headroom, CPU/memory/PID delegation, a finite harmless container's live controls, two ordinary private-bridge containers communicating, an owned unrelated-service sentinel, an evidence export round trip and exact resource ownership/cleanup path. Recheck relevant ancestor controls so the container's own 8 GiB allowance is not silently narrower. No pressure reproducer or user-manager failure is needed.

Keep evidence sampling finite and focused on the guest workload. Hard outer containment and headroom remove reliance on the historical host/outer pressure-monitoring framework. If normal-security boot/rootless/controllers/export cannot qualify, stop before compilation and report the concrete blocker; do not compile under garageserver's user manager, enable cloud services, or raise/remove limits to get a pass.

- [x] **Step 2: Exercise actual defaults, overrides, diagnostics and selftest**

Transfer the exact clean Task 1 archive; record commit/tree/archive and file manifest. Install pinned dependencies frozen in this isolated source. Attribute canonical image identity and actual Rust/Cargo version. Guest source is the required isolated acceptance input; no extra host checkout is created.

Repeat the strict/impacted commands where their real route needs the guest. First finish a separate ordinary wrapper setup container that warms only fingerprinted Node dependencies. Verify subsequent measured entrypoints reuse them; a dependency reinstall invalidates that tiny smoke measurement and requires completing setup before a fresh measured container. This warmup does not compile Cargo. Run actual ordinary default and project/exported/inline/CLI override smokes, then runtime default and at least a discriminating native project override:

~~~bash
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh ':'
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh 'node scripts/testing/sandbox-budget-smoke.mjs 2'
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh 'node scripts/testing/sandbox-budget-smoke.mjs 1 --project-jobs 1'
env CARGO_BUILD_JOBS=1 scripts/sandbox-test.sh 'node scripts/testing/sandbox-budget-smoke.mjs 1'
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh 'CARGO_BUILD_JOBS=1 node scripts/testing/sandbox-budget-smoke.mjs 1'
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh 'node scripts/testing/sandbox-budget-smoke.mjs 1 --cli-jobs 1'
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh --runtime-suite 'node scripts/testing/sandbox-budget-smoke.mjs 2'
env -u CARGO_BUILD_JOBS scripts/sandbox-test.sh --runtime-suite 'node scripts/testing/sandbox-budget-smoke.mjs 1 --project-jobs 1'
scripts/sandbox-selftest.sh
~~~

Expected: all exit 0, actual default NUM_JOBS=2 in both modes on a guest with more than two available CPUs, override NUM_JOBS=1, real overlap evidence, kernel budget in ordinary and both runtime phases, and ALL PROOFS PASSED. Control inherited external jobserver/other jobs inputs for default cases and record their absence without exposing unrelated environment.

Run the production observer in one harmless independently configured probe with one CPU, RAM 256 MiB, total RAM-plus-swap 256 MiB and PIDs 64. Replace entrypoint with Node only with an explicit actual sandbox UID/GID. Require cpu.max ratio 1, memory.max=268435456, memory.swap.max=0 and pids.max=64; bind exact CID/PID/cgroup/UID. A root-only probe or echoed normal constants does not prove the required observer.

Run the actual wrapper with exit 37 and literal exit 137; preserve their exact statuses and associated CID/digest/controls/final results, never an inferred OOM label. Run one intentional quote/dollar/newline caller and compare exact stdout bytes; verify added metadata contains no secret sentinel. These are expected-negative workload cases, separate from setup errors.

Retain --rm and corroborate published full CID after ordinary auto-removal before wrapper control cleanup. Record actual guest Docker version; source-matched installed-host CLI evidence is not a substitute for its real route. Remove fixture projects after each run.

- [x] **Step 3: Run exact final-source cold supported-toolchain Clippy**

Commit any scoped correction discovered in Step 2, run its affected verification and repeat affected real smokes before this step. Archive that new clean commit and run the cold payload against it. A later follow-up may reuse the recorded result only after proving that the workload and complete compiled input closure are unchanged; if that proof fails, repeat the cold payload on the corrected source, preserving exact source attribution.

Use fresh exact-owned target, registry and Git caches. Prove the effective target empty before compiler release and rule out inherited target/compiler-cache redirection. Network/toolchain preparation may not precompile the graph. Record image ABI/UID/tools, source and actual supported toolchain.

Preserve the identified payload exactly:

~~~bash
rustup toolchain install 1.96.0 --profile minimal --component clippy && cargo +1.96.0 clippy -p freshell-session-host --all-targets -- -D warnings
~~~

Leave CARGO_BUILD_JOBS absent for this native-default measurement, with no deliberate project/CLI jobs setting or inherited external jobserver. Do not add --locked, alter package/targets/flags, edit unrelated source, use old source, or warm the target to obtain a favorable outcome.

A separately pinned public Rust-only image may run this graph if its exact digest/ABI/tools/UID/toolchain/controls are attributed; the canonical current-source launcher remains independently proven in Step 2. Set actual CPUs 2, RAM 8589934592, total RAM-plus-swap 17179869184 and PIDs 512. Expected cgroup swap allowance is 8589934592, distinct from physical swap availability/use.

Before rustup/compiler initialization, hold the exact finite acceptance container behind a barrier. Record CID/guest PID/cgroup/UID map, rootless/systemd lineage, numeric own/ancestor controls, empty target and default scheduling inputs. Release only after the finite sampler, deadlines, service sentinel and export path are ready. Never mutate source/build scripts to manufacture jobs evidence.

Sample memory.current/peak/events, swap.current, memory.pressure, CPU quota/stat and PID counts/events each second, with final samples after child exit. Obtain NUM_JOBS=2 from an actual unchanged graph build-script child, not just the launcher environment or separate tiny smoke. Preserve elapsed time, exact child/Docker/launcher status and original workload errors. Keep the task-only container alive briefly after the child solely to export final evidence, then remove by exact CID; this does not change production --rm.

Judge observed outcomes separately:

1. Complete exact graph within useful measured headroom, low pressure, no OOM/escaped limits/service loss: evidence supports successful Clippy and safety of the observed full graph.
2. Attributable compile/lint/workload failure inside its own sandbox with useful diagnostics, actual jobs/controls/resource data and healthy unrelated services: may satisfy criterion 5's contained-failure alternative. Explicitly report failed workload and graph portion run; do not claim successful full Clippy or complete-graph peak safety. Do not repair unrelated Rust solely for exit 0.
3. Directly evidenced sandbox-local resource failure with preserved unrelated services: judge containment independently from whether two jobs is supported as the measured safe default. Never infer OOM from 137 or call the failed graph successful.
4. Setup/download failure before Clippy, missing actual jobs, misattributed/unreadable controls, lost evidence/export or driver protective intervention: failed/incomplete attempt, not automatic product containment. Resolve within scope or report unmet acceptance.
5. User-manager disruption, unrelated-service loss or escaped limits: containment failed. Do not call it acceptable or reproduce it on garageserver.

The coordinator and independent review decide whether the actual evidence delivers the requested measured default and contained outcome. If it does not, lower concurrency only through scoped red/green/refactor and rerun affected final-source acceptance, or report FAILED/non-converged. Historical evidence cannot fill a current measurement gap.

- [x] **Step 4: Export, clean exact resources and obtain independent review**

Export commands/statuses, source/image/toolchain manifests, actual jobs, receipts, one-second/final kernel samples, complete workload logs, expected-negative cases and failed attempts before deleting temporary source/dependencies/disks. Keep necessary review evidence, not workspace/dependency copies.

Verify recorded containers/volumes are absent and unreferenced; QEMU/outer/sampler/sentinel processes ended; owned keys/disks/seed/temp inputs removed. Verify PID birth identity/cwd/argv before stopping an exact task process. Never broad-kill, delete another task's resource/shared cache, or treat inspection failure as absence. Keep the feature branch/worktree for review.

Obtain this task's the-usual fresh specification-plus-quality review of implementation and actual evidence. It must assess final-source attribution, normal rootless/systemd topology, limits before compiler, observed jobs/defaults/overrides, cold graph, measured resource/failure limits, service continuity, metadata privacy and cleanup. Resolve every substantiated finding with the smallest compliant disposition. A generated receipt or mock alone cannot close a real-route finding. Any further source correction is committed and receives affected verification; reuse cold evidence only after proving its workload and complete compiled input closure unchanged, or repeat acceptance on the corrected source.

- [x] **Step 5: Complete the scoped handoff**

Record actual commands, final commit, measured result or qualifying contained failure and limitations, task-review verdicts and evidence paths in the run record. The parent appends the final-HEAD full-suite disposition after both task reviews and before whole-branch review. Unresolved required proof is FAILED/non-converged, never silent success. Launcher/Docker/Cargo integration and smokes provide relevant end-to-end coverage; browser tests add no evidence for this unchanged UI.

No PR or deployment is authorized. Prepare the clean committed result and ask for explicit landing authorization only at the parent workflow's final handoff.

## Approved follow-up: sandbox review findings and Codex blockers

The user approved repairing the three required findings after the passed delta review and expanding this work to the Codex failures blocking the full suite. The earlier pass and its unresolved findings remain recorded; fresh task reviews, a review of the cumulative repairs and an independent review of the resulting complete delta are required. The exact failed gate, its skipped cases and unrun phases remain historical evidence, not a pass.

Before allocating a test environment, use the ongoing read-only storage audit to choose evidence-based disk and memory admission, bounded resource use, monitoring and exact cleanup appropriate to that command. The earlier 120 GiB stop applied to a large guest and is not automatically a suitable bound for a tiny test; never silently ignore it or consume another task's reserve. A guest must not outlive its only resource guard when an agent or tool session ends. No host-policy changes, shared-cache deletion, extra worktree or workspace copy, production restart, or broad process kill is permitted. The process-signal and container-restart paths require a qualified disposable isolation boundary with its own daemon; ordinary finite behavioral tests use the repository-supported strict sandbox when applicable.

On garageserver, put all newly generated test, temporary, cache, log and guard files on the `/home` filesystem, including private writable paths used by a container; do not use root-backed storage or tmpfs for those files. Verify the backing filesystem before releasing a test, and report insufficient space instead of moving files elsewhere. Preserve the actual historical execution evidence without relabeling it.

### Task 3: Close the sandbox test and diagnostic findings

- [ ] Add a committed behavioral regression that actually runs the in-container prelude with the real effective-limit helper and observes the resulting correct receipt. A missing/failing helper case alone is not the positive path. Exercise the real wrapper in its strict test enclosure; when the behavior already works, demonstrate the new test fails under a controlled relevant fault rather than inventing a product failure, then restore and refactor.
- [ ] Make the two-job smoke detect a serial run, while preserving the one-job, environment, project and CLI override cases. Verify overlap with deterministic behavioral evidence rather than relying on a short timing window that can flake; prove a serial two-job simulation fails and a real overlapping case succeeds.
- [ ] Preserve useful, structured, secret-safe smoke failure details for incorrect job observations, overlap and resource checks after temporary observations are cleaned. Test that distinct failures remain diagnosable without leaking raw commands, environment values or other secret inputs.
- [ ] Run focused and neighboring affected tests, actual sandbox selftest/smoke when safe, perform refactor and self-review, commit the scoped change, then obtain a fresh requirements-and-quality review. Record evidence clearing D1.1, D1.2 and D1.3; do not change the three optional findings merely because they were mentioned.

### Task 4: Repair the installed-Codex test-support async contract

- [ ] Trace the managed helper and all callers in `test/integration/providers/codex-local-provider.mjs` and `test/integration/server/fresh-agent-parity.test.ts`. Add a focused behavioral test using genuinely asynchronous owned execution: cover ordered launch/readiness, repeated not-ready results, parsed traffic, signal/closed settlement, and surfaced failures without orphaned work. Verify the test fails for the observed Promise/JSON bug before changing the helper.
- [ ] Await the complete managed lifecycle and update its actual callers coherently, preserving cleanup, traffic, resume, restart and crash coverage. Do not repair only the first `JSON.parse` while leaving later async operations unhandled; do not weaken assertions.
- [ ] Run RED/GREEN/refactor and focused neighboring tests; execute the exact installed-Codex integration path under an appropriately qualified isolated daemon when resources permit. Commit and obtain a fresh task review.

### Task 5: Resolve Codex identity and parity coverage

- [ ] Establish the actual initial-create, real replacement, materialization, managed-alias, native-resume and client-routing contracts from source, existing tests and prior evidence. Distinguish the deterministic fixture's first-turn behavior from genuine replacement delivery. The earlier timeout reproduced on the immutable base, but that alone does not choose a product or fixture fix.
- [ ] Add meaningful tests that reproduce whichever fixture or product defect is proven. Preserve exact native resume, missing-grant, stale/replay and real replacement coverage; never accept the old managed-ID completion merely by relaxing the assertion. Change the smallest correct fixture, test or production route supported by that evidence, then GREEN and refactor.
- [ ] Run all hosted provider rows, the complete provider-parity contract and the exact installed-Codex case with positive test counts when their isolation and resource requirements are met. Include the relevant Rust and client behavior tests if those layers change. Commit and obtain a fresh task review.

### Follow-up integration and gate

After Tasks 3–5, verify all affected smoke/integration behavior and revalidate or repeat the cold evidence as described above. Run the exact configured coordinated full-suite command on the final committed HEAD, preserving its cloud companion and every phase; inventory and fix in-scope failures and record any separately reproduced base failure. Obtain the required fresh whole-branch review, then the parent performs an independent complete-delta review of the approved repairs. The user authorized a new repair/review cycle despite the earlier passing marker; that earlier verdict does not cover new commits. No PR or deployment is authorized.

## Final committed-source gate

### Execution checkpoint

Task 1 implementation is committed at `0a6db8f23ce520575d795407cf4ab53388fbb1a1`
(tree `e46e0571ca6ede11b0fba876ca8c4196fefcd47a`). Its independent requirements
review passed and quality review approved with zero findings. That exact clean
source, archived with SHA256
`3c64c4cfb49db80c09f70871e66af11d9f9b2ef678a38c4e73e1e147cd015373`,
is the product source compiled for Task 2. This later checkpoint changes only
plan progress; it is not a new compiled product source.

Task 2's empirical steps passed in one fresh bounded KVM guest with ordinary
UID 1000, normal rootless Docker/systemd cgroup delegation, private networking,
16 GiB RAM, four vCPUs and over 8 GiB usable physical swap. Actual own and
ancestor controls were qualified before compilation. All seven ordinary/runtime
smokes observed the expected jobs and overlap, overrides remained effective,
the distinct-control non-root observer probe passed, literal caller bytes and
negative statuses were preserved, both strict impacted selections passed
(81 and 76 tests), and the full sandbox selftest reported ALL PROOFS PASSED.

The exact Rust/Clippy 1.96.0 cold payload completed with child/Docker status 0
in 155.385 seconds. Twenty-three unchanged graph build-script children each
reported NUM_JOBS=2. Across 159 samples, peak memory was 3,088,547,840 bytes,
leaving 5,501,386,752 bytes (64.045%) of RAM headroom; own sampled swap use,
memory pressure and OOM event deltas were zero, and every unrelated-service
health check passed. This supports the observed requested graph; it does not
prove unexercised swap/oomd failure paths or future workloads. The canonical
image's floating Cargo/Rust 1.99.1 is separately attributed from the pinned
payload's 1.96.0.

Evidence and failed setup-attempt dispositions are retained under
`/home/dan/code/freshell/.worktrees/.the-usual-logs/mdmw-sandbox-budget/acceptance/attempt-001/`.
Forty published CIDs were verified absent, eleven unreferenced guest volumes
were removed, 462 exported files were checked byte-for-byte, and the guest,
outer container, owned processes, disk, seed, keys and task temporary inputs
were removed. The feature worktree and branch remain for review. No product
correction, host-policy change, production restart, deployment, push or PR
occurred during Task 2.

Task 2's fresh independent requirements review passed and quality review was
approved with no findings. The review examined the actual source attribution,
resource measurements, jobs, statuses, privacy, and cleanup evidence. The
final-HEAD full-suite gate and whole-branch review below remain pending; the
earlier unidentified base failure grants no exemption.

### Pending final gate

After all planned tasks, their corrections and task reviews are complete, the coordinator runs the configured coordinated full-suite gate on the final committed HEAD from this feature worktree, before whole-branch review. Follow usual-executing-plans for periodic gates, adopting exact-HEAD results, recording failures and rerunning after committed fixes; Task 1's precommit checks and an older commit's full-suite result do not substitute for this gate. Wait for any foreign coordinator holder.

~~~bash
env GCLOUD_ROBOT_REQUIRE=1 CARGO_BUILD_JOBS=2 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='freshell mdmw sandbox build budget branch verification' pnpm run test
~~~

Expected: every configured phase, cloud local companion and local Electron lane completes and passes, excluding only ledger-recorded failures reproduced on the immutable base. Record exact HEAD, command and all phase results. The unidentified base exit 1 grants no exemption. Do not disable phases, change backend, assume baseline cause, or repair behavior beyond the approved Codex blockers; unresolved failures receive an explicit blocked/non-converged disposition. Any optional external-provider process-local environment sanitation must be corroborated/recorded; it is not a source repair or a baseline exemption. Any subsequent source fix requires committed affected verification and an exact-final-HEAD gate before whole-branch review.

## Requirement coverage and planning self-review

1. Measured default: Task 1 shared quota/native selector; Task 2 actual ordinary/runtime jobs and final-source cold resource/containment evidence.
2. Overrides: conditional exported forwarding plus real project/inline/CLI cases; no project parser or precedence-masking environment fallback.
3. Limits and failures: requested versus own-kernel observations, non-root distinct-budget probe, digest/CID/true attached and final statuses, null unavailable state, no 137 OOM inference.
4. Meaningful coverage: real-wrapper RED/GREEN/refactor, preserved strict ownership/guard/cache tests, actual modes/selftest/negative cases and isolated exact-toolchain cold graph.
5. Safety/scope: approved immutable failing base, task worktree, finite strict fixture route, qualified bounded disposable guest for cold evidence, exact cleanup, only the approved Codex blocker repair beyond sandbox scope, no production/PR.
6. Review/commit: focused implementation checkpoint and actual evidence with fresh independent gates. Unknown baseline failure grants no exemption.

Stage 2 decision evidence stays in the external run reports: load-bearing-finder.md, load-bearing-strategist.md and load-bearing-validator-{env-cgroup,cid,override,budget-clippy}.md under /home/dan/code/freshell/.worktrees/.the-usual-logs/mdmw-sandbox-budget/reports/. Static proof selected the architecture; the execution checkpoint above records the subsequent actual guest, observer/defaults and cold outcomes without treating that earlier static proof as empirical evidence.

Self-review: the canonical User Request remains unchanged exactly once; every obligation maps above. Removed invalid env-default implementation drafts and VM-before-finite-fake-test dependency; retained intended behavior and exact interfaces rather than substituting new unexecuted product snippets. The user-approved follow-up targets only required sandbox review findings and the Codex blockers; no stub-as-acceptance, permanent host-monitoring framework or blanket failure exemption is introduced.
