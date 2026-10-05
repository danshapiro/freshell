# Claude CLI pane status repair

## Goal

Make Claude CLI panes return to idle when a turn ends, including native Windows launches, and repair the origin/main watcher test race that failed the pre-worktree baseline before beginning the feature changes.

## User Request

### Requested result
Repair the red origin/main Rust watcher-race test in the dedicated worktree before implementing Kata 98xc, then make Claude CLI panes return to idle after Claude finishes a turn.

### Explicit constraints
- Follow the usual workflow.
- Use Kata 98xc as the work and tracking record.
- Complete and verify the baseline test repair before starting the Claude pane status implementation.

### Accepted tradeoffs and residuals
- None.

## Findings

The pre-worktree `origin/main` gate failed in `claude::tests::a_watcher_race_on_the_stamp_take_never_panics_and_completes_coherently`. The test treated a recorded identity row as proof that ownership was Live and the retained stop stamp existed. Since commit `129613906` moved the durable binding write before the Live commit, a kill can begin in that gap and refuse before reaching the test pause. The production ownership order is intentional; the test must synchronize on the retained stamp instead.

Kata 98xc identifies the completion path gap: Claude's Stop hook attempts to write BEL directly to a console device, where Claude hooks do not reliably own a controlling terminal. The hook should return Claude's documented `terminalSequence` response so Claude writes BEL through its own PTY. Windows hook command strings also embed PowerShell `$` expressions in shell-form commands, which may be expanded by Git Bash before PowerShell receives them. Separately, the Windows transcript truth source omits the `USERPROFILE\\.claude` default when `HOME` is unset.

The activity parser and WebSocket busy-to-idle transition already have behavioral coverage. The implementation must add execution-level coverage for generated hook commands and Windows profile discovery; exact serialized-settings assertions alone are not sufficient. Windows must use the platform home from `std::env::home_dir()` even when `HOME` is set, matching the repository's Windows home rule. Explicit Claude roots still take precedence.

## Ordered implementation

### 1. Repair and verify the baseline watcher test

- Change only the race test's readiness barrier in `crates/freshell-freshagent/src/claude.rs` to wait for the retained ownership stamp for `FRESH_CREATE_DURABLE_ID`; retain the existing pause, raced take, and completion assertions.
- Keep production ownership ordering unchanged.
- Run the exact test and the focused `freshell-freshagent` test suite. Confirm the barrier times out with a useful message and does not weaken the race assertions.
- Commit this standalone test-harness repair before editing Claude hook or transcript code.
- Once the exact race test and focused `freshell-freshagent` suite pass, begin the feature work. The already captured baseline showed the other lanes passing; the full coordinated gate remains part of final verification.

### 2. Return completion through Claude's PTY

- Update Unix and Windows Stop-hook command generation in `crates/freshell-platform/src/cli_launch.rs` to return a valid Claude hook JSON response with exactly one BEL in `terminalSequence`; do not write BEL directly to `/dev/tty` or `CONOUT$`.
- Make Windows shell-form commands safe when Claude launches them under Git Bash or PowerShell. Encode the PowerShell body as UTF-16LE Base64 for `-EncodedCommand`, keeping the outer command free of `$` expansion and nested PowerShell quoting. Preserve the Windows SessionStart signal-file behavior.
- Remove the settings-byte-only golden test if it blocks the command change; a test that only checks serialized configuration text is not behavior coverage. Keep launch argument order/shape coverage by comparing the actual `--settings` argument with the runtime `claude_settings_json` output.
- Add execution coverage that extracts the generated commands from the actual `--settings` argument returned by the launch resolver, runs the Stop command, and parses its stdout JSON response. On native Windows, execute SessionStart and Stop with dummy hook stdin and a temporary `USERPROFILE`; assert the signal is written only there and Stop returns a response whose `terminalSequence` contains exactly one BEL. Run the commands under both Git Bash and PowerShell when Git Bash is installed, and under PowerShell otherwise. Do not invoke Claude or a model.
- Reuse the existing activity tracker and WebSocket BEL-to-idle tests after verifying the generated response contains one BEL. Do not add a separate PTY-to-hub integration test.

### 3. Resolve Claude transcript truth under the Windows profile

- In `crates/freshell-ws/src/claude_truth.rs`, preserve the current ordered explicit roots and append the platform default after them, deduplicating it if already present. On Windows only, derive the default from `std::env::home_dir()` (USERPROFILE; ignore HOME); leave the existing Unix HOME lookup unchanged.
- Add a native Windows subprocess test with a temporary profile, a conflicting `HOME`, and `CLAUDE_CONFIG_DIR` and `CLAUDE_HOME` unset. Put synthetic in-flight and ended JSONL records only under the temporary profile's `.claude` tree; assert the truth source classifies both correctly without touching a real Claude profile.
- Add the focused Windows-only Rust test commands to the existing `windows-2022` CI workflow.
- Retain current isolated `with_roots` transcript classification tests and current activity/WebSocket completion behavior tests.

### 4. Review and close

- Run focused platform, activity, WebSocket, transcript, and fresh-agent tests as they become relevant.
- Run the repository-supported full gates from this worktree after the changes, using the already configured cloud Vitest backend and the shared coordinator. Do not deploy or restart the self-hosted server.
- Have an independent reviewer inspect the complete delta, address actionable findings, then rerun the affected focused checks.
- Update Kata 98xc with the fix and evidence, close it only after verification, and leave the feature branch ready for PR review. Do not create a PR without explicit approval.

## Test approach

Use behavior-focused regression tests. The watcher race repair changes the barrier in the existing regression test rather than asserting source text. For hook generation, execute commands extracted from the launch resolver's actual settings argument and parse the response; for Windows, run them under the available shells with an isolated temporary profile. For transcript resolution, launch a subprocess with controlled environment variables so parallel tests cannot observe mutated process-global environment. Reuse the existing activity tracker and WebSocket tests for the busy-to-idle event contract.

## Risks and constraints

- A shell-form hook can be interpreted by Git Bash even on Windows; test both Git Bash and PowerShell on the Windows runner when Git Bash is available.
- Native Windows execution cannot be established by cross-compiling from WSL. Run the Windows-only smoke on the repository's Windows CI runner and record local native Windows evidence if available.
- The broad baseline gate is coordinated and cloud-backed. Use `GCLOUD_ROBOT_REQUIRE=1`; do not run competing broad gates outside the coordinator.
- Keep commits focused: baseline test synchronization first, then feature implementation, then any narrowly justified follow-up.
