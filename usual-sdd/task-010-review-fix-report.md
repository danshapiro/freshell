# Task 10 review-fix report — close the Node test disposition universe

## Finding addressed

The Task 10 review found that `test/integration/session-repair.test.ts` was
deleted but absent from `scripts/retirement/node-test-disposition.json`. The
verifier also trusted the ledger's own `candidatePaths`, so it could not detect
that omission.

## Fix

The ledger now includes an explicit deleted row for
`test/integration/session-repair.test.ts` and its candidate path. The corrected
accounting is:

- 347 candidate paths;
- 349 subject rows (the extra rows preserve split mixed-file subjects);
- 21 retained subjects;
- 328 deleted subjects.

The verifier now requires `candidatePaths` and independently checks the exact
300 test paths deleted by Task 10's backend deletion scope. This independent
snapshot includes the session-repair path and covers the `test/server/**`,
`test/unit/server/**`, and `test/integration/server/**` deletion sets. Missing
required paths now produce an explicit closed-universe error before row
coverage can pass.

`test/unit/architecture/node-test-disposition.test.ts` adds a regression that
removes the session-repair path and row from a copy of the committed ledger and
asserts that verification fails with the required-path error. Existing
synthetic checks opt out of the real Task 10 scope while continuing to verify
unresolved subjects, zero-test selectors, skipped optional-T2 receipts, and
unknown/duplicate/stale rows.

The original Task 10 implementation report was updated to use the corrected
counts and describe the independent scope check.

## Verification

Passed:

```text
NODE_NO_WARNINGS=1 npm run test:vitest -- run test/unit/architecture/node-test-disposition.test.ts --config config/vitest/vitest.config.ts
```

Result: 1 file, 6 tests passed.

```text
NODE_NO_WARNINGS=1 node --import tsx scripts/retirement/verify-node-test-disposition.ts
```

Result:

```json
{"severity":"info","event":"node_test_disposition_verified","candidateCount":347,"rowCount":349,"retainedRows":21,"deletedRows":328}
```

`npm run typecheck` and `git diff --check` also pass. No live server or port
3001 operation was performed.
