# Task 11 Execution Brief — Declare and Prove the Rust Cutover

Governing plan section: `### Task 11: Update Active Documentation, Repeat Gap Triage, and Prove the Cutover` in
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`.

Required outcome:

- Update only active documentation/configuration requested by the plan:
  `README.md`, `AGENTS.md`, `.env.example`,
  `docs/development/windows-electron-build.md`,
  `docs/development/test-sandbox.md`, and the active runtime guard/tests.
  Describe Rust server install/dev/build/start/serve, standalone CLI/MCP and
  Claude tooling, Electron's packaged app-bound Rust backend, the standalone
  Rust service, and the isolated Claude sidecar. Remove stale Node-server,
  Electron daemon, deterministic-404, `conpty.node`, and obsolete sandbox
  rationale guidance. Keep `docs/index.html` and `.kata.toml` byte-for-byte
  unchanged unless a real Kata configuration change is independently required.
- Tighten the final runtime guard to require `manifestDrift=[]`,
  `legacyDebt=[]`, and `unexpectedNodeBackend=[]` from executable evidence,
  while preserving historical-plan/report exclusions. Update active command
  examples and naming only where they imply a runnable legacy Node path.
- Create the external, untracked receipt at
  `/home/dan/code/freshell/.worktrees/.the-usual-logs/retire-node-server-v2/reports/final-node-feature-triage.md`.
  Record the fixed source/caller inventory and every required command's exit
  code/result, including `kata list`, lexical `kata search`, GitHub issue
  searches, issue views for 624/165/6, and the parity checklist search. For
  each reachable Rust-absent capability, classify the owner. Apply the user's
  policy exactly: node-only server features absent from Rust are triaged and,
  if important and not tracked elsewhere, filed as Katas. Do not add redundant
  generic security findings once that coverage is established. Expected result
  is no important untracked residual and no new Kata; if evidence contradicts
  that, create only an acceptance-sized priority-1 Kata with labels
  `enhancement` and `rust-gap`, metadata `source=retire-node-server-v2`, the
  specified idempotency slug, and verify it with `kata show`/`kata events`.
- Do not modify historical plans/reports merely to erase Node references. Do
  not contact, stop, restart, or health-check live port 3001.

Required verification:

1. RED: `npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts --config config/vitest/vitest.config.ts`.
2. GREEN: the same focused runtime test, protected-file diff check against
   `origin/main`, and a nonempty final triage receipt.
3. Impacted: status/check, Rust fmt/clippy/workspace and real-transport tests,
   lint, oracle/E2E/Electron/artifact checks, disposition verifier, both Docker
   builds/probes, and the final active-path forbidden scan from the plan. Record
   environment blockers honestly; do not turn a filtered or skipped run into a
   passing claim.

Execution rules:

- Follow red-green-refactor TDD, stay within Task 11 scope, and commit focused
  implementation changes with `docs: declare the Rust-only backend`.
- The triage receipt is intentionally outside tracked worktree history; leave
  it in the specified `.the-usual-logs` location for review.
- Do not create a PR or deploy/restart anything. Push is a later user-approved
  integration step, not part of this task.
- Write the implementer report to
  `/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-011-report.md`.
