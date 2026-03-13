# Test Run Gate And Baseline Cache Test Plan

Date: 2026-03-11  
Source: `/home/user/code/freshell/.worktrees/test-run-gate/docs/plans/2026-03-08-test-run-gate-and-baseline-cache.md`

Strategy reconciliation: no approval changes are required. The implementation plan stays inside the agreed local TDD scope: Node, Git, local sockets/pipes, filesystem state, and Vitest-driven process tests. The only adjustment is emphasis, not scope: Task 6 rewires every public script in the same change, so scenario coverage has to treat script wiring and status output as part of the user-visible feature, not as documentation-only follow-up.

## Harness requirements

1. `Coordinator CLI subprocess harness`
   What it does: starts `tsx scripts/testing/test-coordinator.ts` as real child processes, captures stdout/stderr, supports two concurrent callers against the same repo common-dir, injects shortened poll/timeout values for deterministic waiting tests, and tears children down safely.
   Exposes: `spawnCoordinator(commandKey, forwardedArgs, env)`, `waitForOutput(child, pattern)`, `waitForExit(child)`, `runStatus(env)`, `readStoreSnapshot(storeDir)`, `stopChild(child)`.
   Estimated complexity: high.
   Tests depending on it: 1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 15.

2. `Temp git repo/worktree fixture`
   What it does: creates disposable regular repos and linked worktrees with real `.git` and `commondir` layouts, allows making clean and dirty commits, and exposes the repo root, checkout root, common-dir, branch, and current commit for assertions.
   Exposes: `createRepoFixture({ linkedWorktree?: boolean, dirty?: boolean })`, `commitFile(...)`, `markDirty(...)`, `storeDir`, `repoRoot`, `checkoutRoot`, `commonDir`, `headCommit`, `cleanup()`.
   Estimated complexity: medium.
   Tests depending on it: 1, 2, 3, 4, 5, 8, 9, 14, 17.

3. `Endpoint and status probe harness`
   What it does: stands up live socket listeners or stale socket files against a temp common-dir, seeds holder/latest/baseline JSON files, and exercises status rendering without needing a full coordinator run.
   Exposes: `listenBusyEndpoint(commonDir)`, `createStaleUnixSocket(commonDir)`, `seedHolder(...)`, `seedLatestCommand(...)`, `seedLatestSuite(...)`, `seedReusableSuccess(...)`, `corruptStoreFile(name)`, `closeEndpoint()`.
   Estimated complexity: medium.
   Tests depending on it: 5, 9, 10, 11, 14.

The command-classifier tests do not need a bespoke harness. A table-driven unit suite is enough because the public command contract is frozen by the implementation plan, current `package.json`, and the existing Vitest config split.

## Test plan

1. **Name:** `npm test` acquires the broad-run gate, publishes a truthful holder while active, and records a reusable full-suite baseline only after success
   **Type:** scenario
   **Harness:** `Coordinator CLI subprocess harness` + `Temp git repo/worktree fixture`
   **Preconditions:** Clean linked worktree fixture on a committed HEAD; no coordinator store files; fake upstream full-suite phases configured to hold briefly and exit `0`.
   **Actions:**
   1. Start `tsx scripts/testing/test-coordinator.ts run test` with `FRESHELL_TEST_SUMMARY="Nightly full suite"`.
   2. While the run is active, invoke `tsx scripts/testing/test-coordinator.ts status`.
   3. Wait for the coordinated run to exit.
   4. Invoke `status` again.
   **Expected outcome:**
   - While active, status reports `running` and includes the holder summary, `commandKey=test`, `suiteKey=full-suite`, pid, branch, worktree path, and command display/argv. Source: implementation plan `§4 Shared State Lives Under The Git Common-Dir` and `§6 Wait And Status Semantics Are Fixed`.
   - The coordinator exits `0`, matching the upstream fake workload exit exactly. Source: implementation plan `§5 Upstream Execution Is Direct And Recursion-Safe`.
   - After completion, status reports `idle`, shows the latest command result for `test`, the latest suite result for `full-suite`, and a reusable exact-match success for the current `commit|dirty:0|node|platform|arch` key. Source: implementation plan `§4 Shared State Lives Under The Git Common-Dir` and `§6 Wait And Status Semantics Are Fixed`.
   - `holder.json` is cleared after the run finishes. Source: implementation plan Task 5 run sequence.
   **Interactions:** CLI parsing, command classifier, git metadata helpers, endpoint lock, holder store, latest result store, reusable baseline store, status renderer.

2. **Name:** `npm run test:all` waits behind an active broad run, prints queued status and baseline information, and still executes after the holder releases
   **Type:** scenario
   **Harness:** `Coordinator CLI subprocess harness` + `Temp git repo/worktree fixture`
   **Preconditions:** Clean repo fixture; an earlier clean `full-suite` reusable success already exists; one coordinated `test` process is holding the endpoint; shortened poll/max-wait values are enabled for the test.
   **Actions:**
   1. Start a long-running `tsx scripts/testing/test-coordinator.ts run test`.
   2. Start `tsx scripts/testing/test-coordinator.ts run test:all`.
   3. Capture the waiting output from the second process while the first is still active.
   4. Let the first process exit successfully.
   5. Wait for the second process to acquire the endpoint and finish.
   **Expected outcome:**
   - The second process prints that the command is queued intentionally, includes the current time, the first holder's summary/branch/worktree/command/pid, and any matching reusable `full-suite` baseline. Source: implementation plan `§6 Wait And Status Semantics Are Fixed`.
   - The second process does not exit early from the cached reusable success and does not signal or kill the first process. Source: implementation plan Strategy Gate and `§6 Wait And Status Semantics Are Fixed`.
   - After the first process exits, the second process runs its own coordinated `full-suite` workload and records the latest command result under `test:all`. Source: implementation plan `§1 Public Commands Keep Their Current Meaning`.
   **Interactions:** Endpoint contention, wait loop, holder status projection, reusable baseline lookup, latest command/suite store updates across multiple processes.

3. **Name:** `npm run check` runs typecheck before the coordinated full-suite phase and only claims success after both phases succeed
   **Type:** scenario
   **Harness:** `Coordinator CLI subprocess harness` + `Temp git repo/worktree fixture`
   **Preconditions:** Clean repo fixture; fake `typecheck` pre-phase logs a deterministic marker and exits `0`; fake `full-suite` phase exits `0`; no active holder.
   **Actions:**
   1. Run `tsx scripts/testing/test-coordinator.ts run check`.
   2. Capture child-process invocation order and status output during the run.
   **Expected outcome:**
   - `npm run typecheck` runs before any holder metadata is written or any endpoint lock is acquired. Source: implementation plan `§1 Public Commands Keep Their Current Meaning` and Task 5 run order.
   - After the pre-phase succeeds, the coordinator acquires the endpoint and runs the coordinated `full-suite` phase. Source: implementation plan `§1 Public Commands Keep Their Current Meaning`.
   - Final exit code is `0`, latest command result is keyed to `check`, and latest suite result is keyed to `full-suite`. Source: implementation plan `§5 Upstream Execution Is Direct And Recursion-Safe` and `§6 Wait And Status Semantics Are Fixed`.
   **Interactions:** Pre-phase npm invocation, endpoint acquisition, holder store, suite result store, status projection.

4. **Name:** `npm run verify` propagates a failing build exit code exactly and never claims the coordinated suite ran
   **Type:** scenario
   **Harness:** `Coordinator CLI subprocess harness` + `Temp git repo/worktree fixture`
   **Preconditions:** Clean repo fixture; fake `build` pre-phase exits with a distinctive nonzero code such as `23`; no active holder or prior `full-suite` run for this command.
   **Actions:**
   1. Run `tsx scripts/testing/test-coordinator.ts run verify`.
   2. Inspect the process exit code and the resulting coordinator status/store state.
   **Expected outcome:**
   - The command exits with the exact failing build code (`23` in the fixture). Source: implementation plan `§5 Upstream Execution Is Direct And Recursion-Safe`.
   - No endpoint holder is acquired and no new `full-suite` latest suite result is recorded, because the coordinated test phase never starts. Source: implementation plan `§1 Public Commands Keep Their Current Meaning` and Task 5 run order.
   **Interactions:** Pre-phase build invocation, coordinator CLI control flow, status/store readback.

5. **Name:** `npm run test:status` reports `running-undescribed` when the gate is live but holder metadata is missing or corrupt
   **Type:** scenario
   **Harness:** `Coordinator CLI subprocess harness` + `Endpoint and status probe harness` + `Temp git repo/worktree fixture`
   **Preconditions:** Live endpoint bound for the repo common-dir; first with no `holder.json`, then with a corrupt `holder.json`; latest command/suite/baseline files may exist.
   **Actions:**
   1. Invoke `tsx scripts/testing/test-coordinator.ts status` while the endpoint is live and `holder.json` is absent.
   2. Corrupt `holder.json` and invoke `status` again.
   3. Stop the endpoint and invoke `status` a third time.
   **Expected outcome:**
   - In steps 1 and 2, status reports `running-undescribed` rather than `idle`, and still shows any readable latest command, latest suite, and reusable baseline information. Source: implementation plan `§4 Shared State Lives Under The Git Common-Dir` and `§6 Wait And Status Semantics Are Fixed`.
   - In step 3, status reports `idle` even if stale advisory JSON remains on disk. Source: implementation plan `§3 Socket Or Named Pipe Is The Only Lock`.
   **Interactions:** Endpoint liveness detection, advisory JSON parsing tolerance, status output composition.

6. **Name:** `npm run test:server` preserves its help/watch behavior by default and coordinates only explicit broad `--run`
   **Type:** scenario
   **Harness:** `Coordinator CLI subprocess harness`
   **Preconditions:** No active holder; fake server Vitest help output and broad-run workload fixture available.
   **Actions:**
   1. Run `tsx scripts/testing/test-coordinator.ts run test:server -- --help`.
   2. Run `tsx scripts/testing/test-coordinator.ts run test:server -- --run`.
   **Expected outcome:**
   - Step 1 delegates directly to upstream `vitest --config vitest.server.config.ts --help`, exits `0`, and creates no holder/store side effects. Source: implementation plan `§1 Public Commands Keep Their Current Meaning` and `§2 Forwarded-Arg Rules Are Explicit`.
   - Step 2 coordinates the `server:all:run` suite, acquires the endpoint, and records the latest suite result for that key. Source: implementation plan `§1 Public Commands Keep Their Current Meaning` and `§2 Forwarded-Arg Rules Are Explicit`.
   **Interactions:** Command classifier, upstream argv generation, endpoint/store.

7. **Name:** Focused and interactive test commands stay immediate passthroughs even while a broad holder is active
   **Type:** scenario
   **Harness:** `Coordinator CLI subprocess harness`
   **Preconditions:** One coordinated `test` process is actively holding the endpoint; representative client and server test file paths exist; no unsupported composite selectors are used.
   **Actions:**
   1. Run `tsx scripts/testing/test-coordinator.ts run test:unit -- test/unit/server/coding-cli/utils.test.ts`.
   2. Run `tsx scripts/testing/test-coordinator.ts run test:client -- --run test/unit/client/components/Sidebar.test.tsx`.
   3. Run `tsx scripts/testing/test-coordinator.ts run test:watch -- --help`.
   4. Run `tsx scripts/testing/test-coordinator.ts run test:ui -- --help`.
   5. Run `tsx scripts/testing/test-coordinator.ts run test:vitest -- --config vitest.server.config.ts test/server/ws-protocol.test.ts`.
   **Expected outcome:**
   - None of these commands wait on the active holder; each delegates or passthroughs immediately. Source: implementation plan `§2 Forwarded-Arg Rules Are Explicit`.
   - `test:unit -- test/unit/server/...` delegates to the truthful server-config owner instead of pretending the default config can run it. Source: implementation plan `§2 Forwarded-Arg Rules Are Explicit` plus current `vitest.config.ts` and `vitest.server.config.ts`.
   - `test:watch`, `test:ui`, and help/direct-Vitest flows surface upstream behavior and create no coordinator holder/store mutations. Source: implementation plan `§1 Public Commands Keep Their Current Meaning` and `§2 Forwarded-Arg Rules Are Explicit`.
   **Interactions:** Classifier fast-paths, upstream Vitest resolver, busy-holder bypass logic.

8. **Name:** Broad single-phase commands coordinate only for their exact no-arg workloads and record distinct suite keys
   **Type:** scenario
   **Harness:** `Coordinator CLI subprocess harness` + `Temp git repo/worktree fixture`
   **Preconditions:** Clean repo fixture; fake success workloads for `test:coverage`, `test:unit`, `test:client`, and `test:integration`; empty coordinator store.
   **Actions:**
   1. Run `tsx scripts/testing/test-coordinator.ts run test:coverage`.
   2. Run `tsx scripts/testing/test-coordinator.ts run test:unit`.
   3. Run `tsx scripts/testing/test-coordinator.ts run test:client`.
   4. Run `tsx scripts/testing/test-coordinator.ts run test:integration`.
   **Expected outcome:**
   - The recorded coordinated suite keys are exactly `default:coverage`, `default:test/unit`, `default:test/unit/client`, and `server:test/server`. Source: implementation plan `§1 Public Commands Keep Their Current Meaning`.
   - Each command acquires the same repo-wide gate serially, proving the coordination boundary is workload-based rather than command-name-based. Source: implementation plan Architecture summary and `§3 Socket Or Named Pipe Is The Only Lock`.
   **Interactions:** Command classifier, endpoint lock, latest command/suite store.

9. **Name:** Bare status output merges holder details, latest command results, latest suite results, and the current exact-match reusable baseline
   **Type:** integration
   **Harness:** `Endpoint and status probe harness` + `Temp git repo/worktree fixture`
   **Preconditions:** Live endpoint; valid holder record seeded; latest command results for multiple command keys seeded; latest suite results seeded; one reusable `full-suite` success seeded for the current clean commit/runtime tuple.
   **Actions:**
   1. Build or invoke the bare status view for the repo.
   **Expected outcome:**
   - Status reports `running`.
   - The holder portion includes summary, elapsed time, branch, worktree, command display, pid, and any session/thread metadata present in the seeded holder. Source: implementation plan `§4 Shared State Lives Under The Git Common-Dir` and `§6 Wait And Status Semantics Are Fixed`.
   - The output includes the latest reusable `full-suite` baseline for the current runtime plus a compact latest-results summary by command key. Source: implementation plan `§6 Wait And Status Semantics Are Fixed`.
   **Interactions:** Status renderer, holder store, latest command/suite stores, reusable baseline store, git/runtime metadata matching.

10. **Name:** Coordinator store reads tolerate empty or corrupt advisory files and later failures do not erase a previously reusable clean success
   **Type:** integration
   **Harness:** `Endpoint and status probe harness`
   **Preconditions:** Empty store dir; then invalid JSON written into each advisory file; then one valid clean reusable success already recorded for a reusable key.
   **Actions:**
   1. Read holder/latest/baseline state from an empty store.
   2. Corrupt each JSON file and read again.
   3. Record a later failing command/suite result for the same reusable key context.
   4. Read status/store state again.
   **Expected outcome:**
   - Empty or corrupt advisory files are treated as missing state rather than crashing the coordinator or status view. Source: implementation plan `§4 Shared State Lives Under The Git Common-Dir`.
   - The later failure updates the latest command and latest suite results but leaves the older reusable clean success intact. Source: implementation plan `§4 Shared State Lives Under The Git Common-Dir`.
   - Readers continue to observe valid old-or-new JSON, never partial persisted state. Source: implementation plan Task 2 atomic-write requirement.
   **Interactions:** Zod schema validation, file I/O, latest results store, reusable baseline store.

11. **Name:** Endpoint derivation uses repo-hash socket or pipe names, honors Unix path limits, and only removes stale sockets after a failed connection proves no live owner
   **Type:** integration
   **Harness:** `Endpoint and status probe harness`
   **Preconditions:** Temp common-dir values covering short and long runtime directories; one live Unix listener; one stale Unix socket file; simulated Windows platform value.
   **Actions:**
   1. Build endpoints for Unix and Windows from the same common-dir.
   2. Attempt to listen when a live owner is present.
   3. Attempt to listen with only a stale socket file present.
   4. Build an endpoint with runtime-dir paths near and beyond the configured byte-length cap.
   **Expected outcome:**
   - Unix uses `frt-<repoHash>.sock` first and falls back to `f-<repoHash>.sock` when necessary; an explicit actionable error is raised if no candidate fits under the byte limit. Source: implementation plan `§3 Socket Or Named Pipe Is The Only Lock`.
   - Windows endpoint naming is `\\\\.\\pipe\\freshell-test-<repoHash>`. Source: implementation plan `§3 Socket Or Named Pipe Is The Only Lock`.
   - A live owner yields `busy` without deleting the socket file; a stale socket is removed only after a failed connection proves there is no live owner. Source: implementation plan `§3 Socket Or Named Pipe Is The Only Lock`.
   **Interactions:** Endpoint derivation, `net` binding/connection, filesystem cleanup.

12. **Name:** Upstream runner mirrors child exit codes and signals exactly and blocks recursive coordinator entry
   **Type:** integration
   **Harness:** `Coordinator CLI subprocess harness`
   **Preconditions:** Fake `.mjs` child fixture that can exit with a numeric code or terminate by signal; repo root available for resolving the local Vitest entry module.
   **Actions:**
   1. Resolve the upstream Vitest command for the repo and run a delegated phase.
   2. Run a fake child that exits nonzero.
   3. Run a fake child that terminates by signal.
   4. Attempt public `run` mode with `FRESHELL_TEST_COORDINATOR_ACTIVE=1`.
   **Expected outcome:**
   - Delegated Vitest execution uses `process.execPath` plus the repo-local Vitest entry module. Source: implementation plan `§5 Upstream Execution Is Direct And Recursion-Safe`.
   - Nonzero numeric exits are propagated exactly, and signaled exits are mirrored or surfaced as conventional nonzero failures without being rewritten to success. Source: implementation plan `§5 Upstream Execution Is Direct And Recursion-Safe`.
   - Recursive public `run` entry is rejected immediately when `FRESHELL_TEST_COORDINATOR_ACTIVE=1` is set. Source: implementation plan `§5 Upstream Execution Is Direct And Recursion-Safe`.
   **Interactions:** Child-process spawning, env propagation, fixture script behavior.

13. **Name:** Public script rewiring and docs publish the coordinated workflow truthfully
   **Type:** regression
   **Harness:** direct file reads in the server test environment
   **Preconditions:** `package.json`, `AGENTS.md`, and `docs/skills/testing.md` modified by Task 6.
   **Actions:**
   1. Read the public test scripts from `package.json`.
   2. Read the relevant testing guidance in `AGENTS.md`.
   3. Read the relevant command guidance in `docs/skills/testing.md`.
   **Expected outcome:**
   - Every public test command routes through `scripts/testing/test-coordinator.ts`, and `test:status` plus `test:vitest` exist. Source: implementation plan Task 6.
   - `docs/skills/testing.md` no longer says `npm test` is watch mode and instead describes truthful command ownership for `test:unit`, `test:integration`, and `test:server`. Source: implementation plan Task 6 and current `package.json`.
   - `AGENTS.md` instructs agents to use `FRESHELL_TEST_SUMMARY`, `npm run test:status`, and `npm run test:vitest -- ...`, and to wait rather than kill a foreign holder. Source: implementation plan Task 6.
   **Interactions:** Package-script contract, operator guidance, agent workflow docs.

14. **Name:** Dirty worktree successes never become reusable baselines, but an exact clean rerun on the same commit and runtime does
   **Type:** invariant
   **Harness:** `Coordinator CLI subprocess harness` + `Temp git repo/worktree fixture` + `Endpoint and status probe harness`
   **Preconditions:** Repo fixture with one committed HEAD; first run has uncommitted changes; second run restores a clean worktree without changing the commit; both coordinated runs succeed.
   **Actions:**
   1. Mark the worktree dirty and run a coordinated `test`.
   2. Inspect latest results and reusable-success state.
   3. Clean the worktree and rerun the same coordinated `test`.
   4. Inspect reusable-success state again.
   **Expected outcome:**
   - The dirty success updates latest command/suite results but does not create a reusable success record. Source: implementation plan `§4 Shared State Lives Under The Git Common-Dir`.
   - The clean rerun on the same commit/runtime creates a reusable success keyed with `dirty:0`. Source: implementation plan `§4 Shared State Lives Under The Git Common-Dir`.
   **Interactions:** Git metadata helpers, reusable baseline keying, latest result store, status lookup.

15. **Name:** Queued callers honor max-wait timeout and never delete or kill a foreign holder
   **Type:** boundary
   **Harness:** `Coordinator CLI subprocess harness`
   **Preconditions:** One coordinated holder is configured to stay alive beyond a shortened test-only max wait; second caller uses shortened poll and max-wait values.
   **Actions:**
   1. Start the long-running holder process.
   2. Start a second coordinated broad command against the same repo.
   3. Wait for the second command to time out.
   4. Verify the first holder is still running and its holder record still matches its `runId`.
   **Expected outcome:**
   - The second caller exits nonzero after the configured timeout and prints the same queued guidance required for normal waiting. Source: implementation plan `§6 Wait And Status Semantics Are Fixed`.
   - The first holder remains alive and its holder metadata is left intact; the waiting caller does not kill it or clear its record. Source: implementation plan `§6 Wait And Status Semantics Are Fixed`.
   **Interactions:** Wait loop timers, endpoint contention, holder cleanup guard.

16. **Name:** Composite selector, `--reporter`, and compatibility `--run` rules stay frozen under the coordinator classifier
   **Type:** regression
   **Harness:** table-driven unit tests against the pure classifier
   **Preconditions:** None.
   **Actions:**
   1. Classify server-only selectors on `test` and `check`.
   2. Classify client-only selectors on `test` and `test:all`.
   3. Classify mixed client-plus-server selectors on `test`.
   4. Classify `--reporter` on composite commands and on delegated single-phase commands.
   5. Classify `--run` on `test` and `test:all`.
   **Expected outcome:**
   - Server-only selectors delegate to one truthful server-config invocation; client-only selectors delegate to one truthful default-config invocation. Source: implementation plan `§2 Forwarded-Arg Rules Are Explicit` plus current `vitest.config.ts` and `vitest.server.config.ts`.
   - Mixed selectors are rejected with guidance to split the command. Source: implementation plan `§2 Forwarded-Arg Rules Are Explicit`.
   - `--reporter` is rejected on composite coordinated commands and accepted on delegated single-phase invocations. Source: implementation plan `§2 Forwarded-Arg Rules Are Explicit`.
   - `--run` on `test` and `test:all` is treated as a compatibility no-op. Source: implementation plan `§2 Forwarded-Arg Rules Are Explicit`.
   **Interactions:** Pure command-classifier logic, current script semantics, Vitest config ownership split.

17. **Name:** Repo identity helpers resolve common-dir, invocation cwd, branch, checkout root, repo root, and dirty state correctly for repos and linked worktrees
   **Type:** unit
   **Harness:** `Temp git repo/worktree fixture`
   **Preconditions:** One regular repo fixture, one linked worktree fixture with a real `commondir`, and env variants with and without `INIT_CWD`.
   **Actions:**
   1. Call `resolveGitCommonDir()` on the regular repo and linked worktree.
   2. Call `resolveInvocationCwd()` with `INIT_CWD` set and unset.
   3. Call `resolveGitCheckoutRoot()`, `resolveGitRepoRoot()`, and `resolveGitBranchAndDirty()` from nested paths in both fixtures.
   **Expected outcome:**
   - `resolveGitCommonDir()` returns the repo `.git` dir for a regular repo and the shared common-dir for a linked worktree. Source: implementation plan Task 2 and current worktree patterns in `test/unit/server/coding-cli/resolve-git-root.test.ts`.
   - `resolveInvocationCwd()` prefers `INIT_CWD` when present. Source: implementation plan Task 2.
   - Checkout root stays on the worktree, repo root collapses to the parent repo, and branch/dirty metadata uses the existing `isDirty` field name. Source: implementation plan Task 2 and current `test/unit/server/coding-cli/git-metadata.test.ts`.
   **Interactions:** Git helper module, filesystem layout parsing, Git subprocess metadata lookup.

## Coverage summary

- Covered action space:
  - Every public command in the implementation plan appears in at least one scenario: `test`, `test:all`, `check`, `verify`, `test:coverage`, `test:unit`, `test:client`, `test:integration`, `test:server`, `test:watch`, `test:ui`, `test:status`, and `test:vitest`.
  - The plan covers the coordinated lifecycle end to end: command classification, holder acquisition, queued waiting, timeout, status rendering, latest results, reusable baseline caching, exact exit propagation, recursion guard, and final script/doc publication.
  - Low-risk timing coverage is included through timer-compressed waiting and timeout scenarios rather than a standalone benchmark, which is proportionate for a local socket/file coordination feature.

- Explicit exclusions:
  - No separate differential harness is proposed because there is no second runnable reference implementation; the frozen command contract in the implementation plan, current `package.json`, and the current Vitest config split are the sources of truth instead.
  - Raw `npx vitest ...` remains out of scope for coordination because the implementation plan explicitly says the supported repo-owned escape hatch is `npm run test:vitest -- ...`.
  - Strict FIFO queue ordering is excluded because the implementation plan freezes serialized waiting, not queue fairness.
  - Real Windows named-pipe runtime behavior is not covered by a live Windows integration process in this Linux worktree; coverage is by deterministic endpoint derivation and platform-injected unit tests.

- Risks carried by the exclusions:
  - Windows-specific pipe lifecycle bugs could still survive until they run on an actual Windows host.
  - Very long-duration timing issues beyond the timer-compressed wait tests could still appear, although catastrophic regressions in wait/timeout logic should be caught.
  - Because there is no independent runtime reference, the classifier regression tests must stay anchored to the frozen contract and current config ownership; if those sources drift silently, the tests need to be updated deliberately rather than inferred from implementation code.
