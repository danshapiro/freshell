# Task 5 review-fix report

Date: 2026-08-27
Base checkpoint: `0dc90af3c` (`refactor: retire Node-only contracts and oracles`)

## Fix

Updated the active T2 Claude and Codex harness comments to describe
`startExternalServer`, the owned Rust server, and its isolated HOME setup.
Updated the PTY scenario comments to describe the Rust terminal runtime and
frozen Rust-baseline provenance.

Extended `rust-only-oracle-boundary.test.ts` to include the active PTY scenario
source and to reject `TestServer`, `original server`, and `node-pty` terms in
the Rust baseline harness/scenario comments.

## RED

After adding the new boundary assertions but before updating the comments:

```text
npm run test:oracle -- --run test/unit/port/oracle/rust-only-oracle-boundary.test.ts
```

failed 1 of 2 tests because the active T2/scenario source still contained the
retired `TestServer` documentation.

## GREEN

```text
npm run test:oracle -- --run test/unit/port/oracle/rust-only-oracle-boundary.test.ts
```

passed 2 tests.

```text
env -u FRESHELL_RUN_REAL_PROVIDER_CONTRACTS npm run test:oracle
```

passed 11 files / 162 tests and skipped the 3 explicitly gated provider files
(3 tests).

```text
npm run typecheck:client
npm run typecheck:server
```

Both passed.

No live server or port 3001 was contacted, stopped, restarted, or health-checked.
Unrelated Task 2–4 reports in the worktree were left untouched.
