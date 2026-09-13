# Task 10 implementation report — delete the legacy Node backend

## Outcome

Task 10 removed the tracked Node application server and its Node-only test,
repair, PTY-proof, and port-oracle trees from this branch. The retained runtime
surface is the Rust server, with standalone CLI/MCP tooling, Rust/Electron
fixtures, shared contracts, and the Claude sidecar left in place.

The work did not contact, stop, restart, or health-check the live server on
port 3001.

## Red-green work

The required RED command was run before the deletion:

```text
npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts --config config/vitest/vitest.config.ts
```

It failed as intended. The runtime inventory reported legacy `server/` and
build/config debt, stale service rows, unlisted distribution fixtures, and the
retirement verifier entry. The run had 14 passing tests and one failing test.

The implementation then added a committed test-disposition ledger and its
verifier before removing the old test trees. The review fix corrected the
closed universe to include the explicitly deleted session-repair integration
test. The corrected ledger covers 347 Task 5/6/10 candidate paths:

- 347 candidate paths, represented by 349 subject rows because mixed subjects
  and the split title-utils subjects are recorded independently;
- 21 retained subjects, each bound to an exact surviving test, selector, lane,
  and positive Task 6 receipt;
- 328 explicitly deleted subjects, including the historical updater deletion
  row and supplemental real-provider T2 rows that cannot satisfy a required
  replacement;
- no unknown, duplicate, stale, unresolved, zero-selector, skipped-required,
  or vacuous rows.

`node-test-disposition.json` is checked by
`verify-node-test-disposition.ts`. The architecture test includes synthetic
failures for an unresolved mixed subject, a zero-test selector, a skipped
optional-T2 receipt, and omission of the required session-repair path. The
verifier independently checks the exact 300 test paths deleted by Task 10,
including `test/integration/session-repair.test.ts`, instead of accepting only
the ledger's self-declared candidate universe. It currently reports:

```json
{"severity":"info","event":"node_test_disposition_verified","candidateCount":347,"rowCount":349,"retainedRows":21,"deletedRows":328}
```

Shared subjects were re-homed before deletion. This includes shared title
extraction coverage, the shared tab-registry schema coverage, and retained
Codex/fresh-agent contract traceability. Gemini fixture coverage remains raw
HTTP/Rust-client coverage rather than importing the retired root AI SDK.

## Removed and retained files

The change deletes exactly the requested legacy backend scope: `server/**`,
`test/server/**`, `test/unit/server/**`, `test/integration/server/**`, the
session-repair integration test, the fake Codex launch planner, the obsolete
Claude thread fixture, the repair scripts, the PTY metrics proof, and the
listed interchange, matrix, parity, robustness, indexer, and T3 oracle files.

The root package manifest and lockfile no longer directly own the Node backend
dependencies and types: Express, node-pty, the root AI SDK/Google provider,
chokidar, dotenv, rate limiting, pino, test HTTP clients, and their listed
types/helpers were removed. `extract-zip`, `tar`, `diff`, and
`@modelcontextprotocol/sdk` remain. The Claude SDK remains owned by the
isolated `crates/freshell-claude-sidecar` package.

The runtime boundary and fresh-agent guard now require the legacy roots,
artifacts, maintenance scripts, and direct dependency set to be absent. The
manifest explicitly classifies the allowed coordinator, provider-fixture, and
probe listeners as non-backend infrastructure; the final runtime inventory
reports `manifestDrift=[]`, `legacyDebt=[]`, and
`unexpectedNodeBackend=[]`. A generated ignored `dist/server` tree found in
the worktree was moved to `/tmp/freshell-retired-dist-server-task10` so the
absence guard could test the checkout rather than an old build artifact.
The visible-first acceptance scanner was also reduced to the retained
`shared/` and `src/` roots so its contract check no longer tries to read the
deleted backend tree.

## Verification

Passing checks:

- `test ! -d server`;
- `npm install --package-lock-only --ignore-scripts`;
- focused runtime, fresh-agent, disposition, Vite, and distribution checks:
  5 files and 52 tests passed;
- `node --import tsx scripts/retirement/verify-node-test-disposition.ts`;
- `npm run typecheck`;
- `cargo test -p freshell-codex --features real-transport --locked`;
- `cargo test -p freshell-opencode --features real-transport --locked`;
- `npm run build`;
- the active-tree forbidden import/artifact scan;
- the visible-first acceptance contract tests (3 tests);
- `git diff --check`.

The coordinated full suite was run with
`FRESHELL_TEST_SUMMARY="legacy Node backend deleted"`. It completed with 472
passing files and 5,605 passing tests, but retained three unrelated client
failures:

1. `test/e2e/refresh-context-menu-flow.test.tsx` expected a browser-pane
   refresh API call that was not made in the test environment;
2. `test/unit/client/components/fresh-agent/FreshAgentMobile.test.tsx` failed
   two expectations because the send callback received `"hello"` without the
   test's expected second empty-array argument.

The first full run also exposed two failures caused by Task 10's own stale
references (the Vite WSL mock and the Docker retired-directory assertion).
Those were fixed, and the final coordinated run contained only the three
client failures above. The failures reproduce in the focused rerun and do not
reference the deleted Node backend.
