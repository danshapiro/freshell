# Task 10 Execution Brief — Delete the Legacy Node Backend

Governing plan section: `### Task 10: Delete the Legacy Node Backend, Tests, Scripts, and Dependencies` in
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`.

Required outcome:

- First run the required RED test, then create and review the committed
  `scripts/retirement/node-test-disposition.json` ledger for the complete
  346-file Task 5/6/10 candidate universe. Every old test path and every
  independently meaningful subject in a mixed file needs a resolved row with
  retained/deleted decision, exact surviving test, lane, selector, and latest
  positive receipt. Optional real-provider T2 rows are supplemental only;
  unknown, duplicate, stale, unresolved, zero-selector, skipped-required, and
  vacuous rows must fail verification. Include the earlier updater deletion
  row. Re-home retained shared subjects (including the split title-utils and
  tab-registry subjects) before deleting their old files.
- Add `scripts/retirement/verify-node-test-disposition.ts` and
  `test/unit/architecture/node-test-disposition.test.ts`, including synthetic
  failures for unresolved mixed subjects, zero-test selectors, and skipped
  optional T2 receipts. Tighten the Rust-only runtime guard and
  `fresh-agent-only-runtime.test.ts` so `server/` and all Node backend test,
  config, script, artifact, and dependency categories are absent while the
  explicitly manifest-listed coordinator/fixture/probe listeners remain
  allowed. The final guard must report `unexpectedNodeBackend=[]`.
- Retain standalone CLI/MCP/Claude packages and their allowed fixtures, Rust
  tests, Electron, shared contracts/tools, Rust fixtures, and the Claude
  sidecar. Do not delete historical plans/reports merely because they mention
  Node. Move any provider fixture still consumed by retained Rust/E2E tests
  before removal.
- Delete exactly the legacy `server/**`, Node server test trees and session
  repair test, backend-only title-utils remainder, fake Codex launch planner,
  obsolete Claude thread fixture, repair scripts, PTY proof, and listed oracle
  `.mjs` files. Remove the specified Node-backend direct dependencies/types from
  the root package and regenerate `package-lock.json`; retain `extract-zip`,
  `tar`, `diff`, `@modelcontextprotocol/sdk`, and sidecar-only Claude SDK use.
  Adjust `.gitignore` only for obsolete generated Node-server directories.

Required verification:

1. RED: `npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts --config config/vitest/vitest.config.ts`.
2. GREEN: `test ! -d server`; lockfile-only install; focused runtime and
   disposition tests; disposition verifier; and `npm run typecheck`.
3. Impacted: forbidden active-tree import scan, disposition verifier,
   `cargo test -p freshell-codex --features real-transport --locked`,
   `cargo test -p freshell-opencode --features real-transport --locked`,
   `npm run build`, and the coordinated full suite with
   `FRESHELL_TEST_SUMMARY="legacy Node backend deleted"`.

Execution rules:

- Follow red-green-refactor TDD, stay within Task 10 scope, and commit focused
  implementation changes on the current branch.
- Do not contact, stop, restart, or health-check port 3001 or any live server.
- Do not modify historical reports/baselines solely because they mention Node.
- Write the implementer report to
  `/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-010-report.md`.
