# Task 9 Execution Brief — Make Containers, CI, and Release Artifacts Rust-Only

Governing plan section: `### Task 9: Make Containers, CI, and Release Artifacts Rust-Only` in
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`.

Required outcome:

- Convert the example and Cloud Run images to Rust server entrypoints with
  built client/tools artifacts; Node may appear only for sanctioned Claude/MCP
  tooling and never as the backend entrypoint. Keep the transitional cloud
  `npm ci --ignore-scripts` removal/assertion for Task 10 backend-only
  dependency directories.
- Add distribution-runtime structural tests and
  `scripts/verify-container-layout.sh` fixtures that accept the Rust/client/
  tools layout and fail on `dist/server`, `node-pty`, or other forbidden
  backend artifacts. Emit structured JSONL diagnostics with sorted evidence.
- Update CI workflows to own Rust fmt/clippy/workspace tests, source-runtime
  smoke, native Rust Electron build/staging/verifier/checkout-free acceptance
  on the four required OS targets, and correct crate/path triggers. Keep the
  client typecheck job's default Vitest lane free of artifact prerequisites.
- Remove server Vitest vocabulary and vacuous-test flags from container/CI
  paths; ensure the Tauri smoke receives an explicit built Rust binary and
  never soft-skips.

Required verification:

1. RED: `npm run test:vitest -- run test/unit/tooling/distribution-runtime.test.ts --config config/vitest/vitest.config.ts`.
2. GREEN: distribution-runtime test, fixture shell verifier, both Docker builds/
   inspections/probes from Step 4.
3. Impacted: forbidden scan, `cargo fmt --all --check`, clippy, and workspace
   tests, plus any focused container/CI checks needed to substantiate the
   workflows.

Execution rules:

- Follow red-green-refactor TDD, stay within Task 9 scope, and commit focused
  implementation changes on the current branch.
- Do not contact, stop, restart, or health-check port 3001 or any live server.
- Do not modify historical reports/baselines solely because they mention Node.
- Write the implementer report to
  `/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-009-report.md`.
