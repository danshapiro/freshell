# Task 8 Execution Brief — Package the Rust Server and Sanctioned Node Runtimes in Electron

Governing plan section: `### Task 8: Package the Rust Server and Only Sanctioned Node Runtimes in Electron` in
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`.

Required outcome:

- Replace the old bundled-Node/server-node-modules staging with
  `prepare-electron-runtime`, staging only the native Rust server, client,
  sanctioned Node runtime, Claude sidecar, and checkout-free MCP bundle with
  locked production dependencies and matching package metadata.
- Add a declarative artifact verifier that checks required files, rejects every
  forbidden backend/native-module artifact, and executes the native Rust binary
  in an empty temporary cwd with auth/config discovery removed. It must require
  the expected authentication refusal before any listen event; foreign-platform
  artifacts receive structural checks locally and native CI performs execution.
- Preserve locked archive extraction/integrity behavior and redacted structured
  error logging. Update Electron builder/scripts/package metadata and ignore
  generated `electron-runtime/` staging.
- Add the dedicated Node Vitest runtime config and checkout-free acceptance:
  copy the staged runtime outside the checkout, authenticate to Rust
  server-info, fetch the SPA and a hashed asset, exercise fake Claude, speak
  stdio JSON-RPC to MCP without a listening socket, and reap every owned child.
  Keep artifact-bound tests out of default Vitest.

Required verification:

1. RED commands from Task 8 Step 2.
2. GREEN commands from Step 4, including staging, artifact runtime lane, and
   native Rust/client/tools builds.
3. Step 6 forbidden scan, ignore check, `npm run electron:build`,
   `npm run verify:electron-artifact`, and dedicated runtime lane.

Execution rules:

- Follow red-green-refactor TDD, stay within Task 8 scope, and commit focused
  implementation changes on the current branch.
- Do not contact, stop, restart, or health-check port 3001 or any live server.
- Do not modify historical reports/baselines solely because they mention Node.
- Write the implementer report to
  `/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-008-report.md`.
