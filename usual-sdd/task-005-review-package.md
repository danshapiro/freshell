# Task 5 Review Package — Retire Dead Contracts and Rebase Active Port Oracles on Rust

Read the execution brief:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-005-brief.md`

Read the complete Task 5 plan section in:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`

Implementation commit:
`0dc90af3c refactor: retire Node-only contracts and oracles`

Implementer report:
`usual-sdd/task-005-report.md`

Review the actual diff and report. Verify separately:

- the obsolete `codingcli.*` family is absent from active TS/Rust schemas,
  handlers, inventories, generated contracts, and tests;
- caller-free client exports/thunks and the three retired visible-first
  harnesses are removed without leaving active callers;
- active T0/T1/T2 oracle paths start only owned Rust on ephemeral non-3001
  ports, use frozen Rust fixtures or invariants, retain nonempty/mutation
  proofs, and contain no Node target/build/spawn/copy/warm-proxy/3001
  inspection path;
- the opt-in real-provider contracts are correctly classified as supplemental,
  while always-running fake/provider-shape checks remain active;
- deleted generators and original-side T2 tests/config are not still referenced,
  contract generation is deterministic, and visible-first acceptance coverage
  still runs the intended retained tests;
- focused verification, lint/typechecks, Rust tests, and the documented
  baseline failures are honestly represented and no tests are hidden/skipped
  merely to make the migration pass.

Give separate requirements and code-quality verdicts with concrete findings only.
Do not require a green pre-existing Rust baseline when the report provides
evidence it is unrelated; do flag any missing proof, regression, stale active
path, or over-broad deletion.

Read-only review: do not edit implementation files, contact/restart/health-check
port 3001, or create commits. Write the review to:
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-005-review.md`
