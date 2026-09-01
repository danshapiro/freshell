# Task 7 Review Package — Cut Electron App-Bound Lifecycle Over to Rust

Read the execution brief:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-007-brief.md`

Read the complete Task 7 plan section in:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`

Implementation commit:
`45d603cf1 feat: run Electron app-bound backend in Rust`

Implementer report:
`usual-sdd/task-007-report.md`

Review the actual diff and report. Verify separately:

- Electron config, startup, spawner, wizard, IPC/preload, and launch policy
  expose only `app-bound`/remote, migrate persisted daemon values atomically,
  and remove daemon resources/templates/tests without deleting the supported
  standalone Rust service;
- app-bound resources/env/cwd use the Rust binary and sanctioned Claude/MCP
  paths, reject malformed config roots, redact tokens, and require authenticated
  Rust server-info provenance;
- lifecycle ownership is the exact spawned `ChildProcess`, with bounded
  graceful/escalated stop, close/error reference clearing, no path scans or
  broad kills, and foreign same-path process protection;
- the Rust app-bound Electron E2E really starts/authenticates/stops the owned
  child on an ephemeral non-3001 port and leaves the foreign fixture alive;
- unit/build/scan receipts are accurate, no hidden skips or unsupported
  headless-display claims are presented as green, and the pre-Task-8 staging
  limitation is correctly left for Task 8.

Give separate requirements and code-quality verdicts with concrete findings only.
Read-only: do not edit implementation files, contact/restart/health-check port
3001, or create commits. Write the review to:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-007-review.md`
