# Task 6 Review Package — Make Source Build, Start, and Broad Tests Rust-First

Read the execution brief:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-006-brief.md`

Read the complete Task 6 plan section in:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`

Implementation commit:
`82fb299fc build: make Rust the default server and test lane`

Implementer report:
`usual-sdd/task-006-report.md`

Review the actual diff and report. Verify separately:

- package scripts and launchers make Rust the source/dev/build/start server,
  retain exact-PID/signal-forwarding safety, and do not accidentally alter the
  live port 3001;
- default Vitest, source-runtime, Rust workspace, Electron, cloud, Tauri, and
  coordinator phases are non-vacuous, select the intended retained tests, and
  do not hide failures with `--passWithNoTests` or silent skips;
- retained tests are correctly rehomed out of `test/unit/server/**`, obsolete
  Node/provider contracts/configs are deleted only where the plan permits, and
  the source-runtime smoke verifies an exact owned Rust release child;
- CI/bootstrap/cloud wrappers and runtime manifests agree with the new script
  contract; forbidden-path scans are substantive;
- baseline failures and host dependency failures are accurately reported, with
  no unsupported claim that `npm test` or the Rust workspace is green.

Give separate requirements and code-quality verdicts with concrete findings only.
Read-only review: do not edit implementation files, contact/restart/health-check
port 3001, or create commits. Write the review to:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-006-review.md`
