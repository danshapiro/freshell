# Task 8 Review Package — Package Rust Server and Sanctioned Node Runtimes

Read the execution brief:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-008-brief.md`

Read the complete Task 8 plan section in:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`

Implementation commit:
`64b727501 build: package Rust backend in Electron`

Implementer report:
`usual-sdd/task-008-report.md`

Review the actual diff and report. Verify separately:

- staging produces only the native Rust server, client, sanctioned Node
  runtime, Claude sidecar, and checkout-free MCP closure with locked
  dependencies and matching metadata;
- verifier allowlists required paths, rejects retired backend/native-module
  artifacts, performs the empty-cwd auth-refusal execution probe, and does not
  allow producer-supplied bypasses;
- archive extraction/integrity and structured redacted error logging remain
  correct; builder/package scripts and generated-runtime ignore agree with the
  staged layout;
- the checkout-free runtime truly runs outside the checkout, authenticates to
  Rust, serves a real hashed client asset, exercises Claude and stdio MCP
  without a listening socket, and reaps all owned children;
- default Vitest does not absorb artifact-bound tests, dedicated runtime
  selection is non-vacuous, and the reported root node-pty/historical evidence
  exceptions are within later-task scope rather than shipped artifacts;
- build, direct verifier, runtime lane, and scan receipts are accurate.

Give separate requirements and code-quality verdicts with concrete findings only.
Read-only: do not edit implementation files, contact/restart/health-check port
3001, or create commits. Write the review to:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-008-review.md`
