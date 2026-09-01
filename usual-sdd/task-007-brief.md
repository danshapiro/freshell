# Task 7 Execution Brief — Cut Electron App-Bound Lifecycle Over to Rust

Governing plan section: `### Task 7: Cut Electron App-Bound Lifecycle Over to Rust and Retire Dead Daemon Mode` in
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`.

Required outcome:

- Electron supports only `app-bound` and `remote`; migrate persisted
  `serverMode: "daemon"` atomically to app-bound with a structured notice,
  remove daemon wizard/IPC/startup/launch-policy branches, daemon tests, and
  Electron-owned launchd/systemd/Task Scheduler templates. Preserve the
  standalone `installers/systemd/freshell-rust.service`.
- Replace Electron's app-bound server resources with the Rust binary, client
  directory, sanctioned Claude/MCP Node runtime entries, isolated home/config/
  log paths, and no Node backend/native-module/server-entry/NODE_PATH fields.
  Dev uses `target/debug/freshell-server`; packaged mode uses the staged
  release binary. Child cwd is the existing `.freshell` config directory,
  `FRESHELL_HOME` is its parent, and token values remain redacted.
- Spawn Rust with the explicit env contract, verify authenticated Rust
  server-info provenance, and bind ownership to the exact `ChildProcess`
  returned by spawn. Stop only that child with bounded graceful/escalated
  waits; never scan paths or broadly kill same-path processes.
- Add app-bound Electron E2E using staged Rust/Claude/MCP fixtures: authenticate,
  verify runtime/commit, exit, prove the exact Rust child is gone, and prove a
  foreign same-path process survives until its fixture cleanup.

Required verification:

1. RED: the Step 2 Electron unit command including daemon tests.
2. GREEN: the same focused unit command without the deleted daemon selector.
3. Impacted: Task 7 forbidden scans/absence checks, Rust build, Electron build,
   and the app-bound Rust E2E.

Execution rules:

- Follow red-green-refactor TDD, stay within Task 7 scope, and commit focused
  implementation changes on the current branch.
- Do not contact, stop, restart, or health-check port 3001 or any live server.
- Do not modify historical reports/baselines solely because they mention Node.
- Write the implementer report to
  `/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-007-report.md`.
