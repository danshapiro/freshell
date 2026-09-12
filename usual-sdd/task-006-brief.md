# Task 6 Execution Brief — Make Source Build, Start, and Broad Tests Rust-First

Governing plan section: `### Task 6: Make Source Build, Start, and Broad Tests Rust-First and Non-Vacuous` in
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`.

Required outcome:

- Make `dev:server`, `dev`, `build`, `start`, `check`, `test`, and
  `verify` use the Rust server and explicit client/tools/Rust/Electron phases.
  Keep `scripts/launch-rust.sh` canonical; make compatibility launchers and
  the WSL bootstrap Rust-only and exact-PID safe.
- Replace the server Vitest config/global setup and Node server build artifacts
  with the default client/tooling lane plus an artifact-owning source-runtime
  Rust lane. Exclude artifact-dependent integration trees from default
  discovery, reject zero-test selectors, and preserve the visible-first CLI
  harness in the default lane.
- Rehome retained tests out of `test/unit/server/**`, split shared title/tab
  subjects as specified, delete only Node/provider contracts that no longer test
  retained Rust behavior, and add the owned source-runtime smoke.
- Make cloud wrappers truthful (no `--passWithNoTests`), make Tauri smoke
  fail rather than skip when its explicit Rust binary is absent, and add the
  Rust build/env CI path.
- Maintain structured wrapper error logging, signal forwarding, exact child
  ownership, isolated homes/ports, and no contact with live port 3001.

Required verification:

1. RED commands from Task 6 Step 2, including the focused tooling tests,
   source-runtime config, cloud wrapper shell test, and Tauri smoke.
2. GREEN commands from Step 4, including client/tools/release builds, focused
   tooling/shared/provider tests, source-runtime, cloud wrapper, Tauri smoke,
   and Rust codex/opencode real-transport crate tests.
3. Step 6 forbidden scans, absence checks, `npm run typecheck`, and the
   coordinated `FRESHELL_TEST_SUMMARY="retire Node server: Rust broad gate" npm test`.

Execution rules:

- Follow red-green-refactor TDD, stay within Task 6 scope, and commit focused
  implementation changes on the current branch.
- Do not contact, stop, restart, or health-check port 3001 or any live server.
- Do not modify historical reports/baselines solely because they mention Node.
- Write the implementer report to
  `/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-006-report.md`.
