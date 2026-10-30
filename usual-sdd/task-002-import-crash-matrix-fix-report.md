# Task 2 OpenCode Import Crash Matrix Fix Report

## Scope

Closed the Important finding in `task-002-promotion-final-review.md` with synthetic process-death and restart coverage for Task 2 Step 1. No Task 3 work was started. Every crash parent and child is ignored by default and was invoked only through `scripts/sandbox-test.sh`.

## Crash and restart coverage

- **Supervisor staging: 13 durable boundaries.** Kills cover descriptor publication, the payload placeholder, writes/file syncs/parent syncs for both chunks of a two-chunk payload, payload rename and sync, READY publication, ready-directory rename, and parent-directory sync. Reconstructed staging must rehash the complete bytes, converge on retry, and reject a conflicting source generation.
- **Native importer: 4 boundaries.** Kills occur after transaction writes but before commit, immediately after commit, after database and parent sync, and after receipt construction. Restart proves SQLite exposes no uncommitted schema/rows, identical retry reconstructs the exact receipt, provider-identity verification reopens the destination and its referenced asset, and a conflicting descriptor cannot overwrite that state.
- **Session-host receipt/readiness path: 15 durable boundaries.** For both `ImportReceipt` and `InstalledStoreReadable`, kills cover temporary-file write, file sync, hard-link publication, temporary-file removal, and state-directory sync. Host-state publication covers temporary write/sync, atomic rename, and parent-directory sync. The last kill is after the readiness/grant state is durable and immediately before PTY spawn. Every clean retry reaches the synthetic PTY only after import and both reader checks. Two more killed-child retries tamper with a stale import source generation and a conflicting reader UID; both fail before grant/readiness state is written and never invoke PTY.
- **Supervisor registry: 2 boundaries.** A child dies immediately before or after the production `mark_running` SQLite commit. Reopening the registry preserves `Starting` as a receipt-recovery candidate or preserves `Running` and its command row. Retrying the interrupted transition converges to `Running`. Running transfers remain receipt-recovery candidates until the service revalidates the host receipt.

That is 34 distinct durable crash boundaries, plus two extra child deaths that exercise stale/conflicting receipt rejection. The registry crash test covers the durable commit itself; the existing service receipt tests continue to reject absent, misbound, or wrong-provider-identity receipts.

## Asset publication disposition

This importer has no separate asset-publication step: the serialized bundle contains one `payload.json`, and its supported asset kinds are references to shared workspace files or Git trees. The importer validates those references and hashes their content in place; it does not copy/publish asset files. The synthetic fixture therefore includes a real `workspace_path_reference` from an OpenCode `part` row to `workspace/prompt.txt`. Import and provider-identity read verification both traverse and hash that file, and the durable database/receipt state records one asset. The actual reference remains blocked if it is missing or changed. No live provider data is used.

## Authoritative crash-matrix command

This single invocation ran all four parents sequentially inside one disposable Docker sandbox and passed in 23 seconds:

```bash
scripts/sandbox-test.sh "set -e; cargo test -p freshell-supervisor opencode_transfer::tests::opencode_transfer_import_stage_recovers_each_durable_file_boundary_after_process_crash -- --ignored --exact --nocapture; cargo test -p freshell-agent-runtime opencode_transfer::tests::opencode_importer_restarts_after_native_transaction_boundaries -- --ignored --exact --nocapture; cargo test -p freshell-session-host tests::opencode_host_restarts_at_receipt_and_pre_pty_durable_boundaries -- --ignored --exact --nocapture; cargo test -p freshell-supervisor registry::tests::opencode_registry_readiness_commit_survives_process_crash_and_reopen -- --ignored --exact --nocapture"
```

Each parent reported `1 passed`; all re-exec children were killed with `SIGKILL` at the selected checkpoint. The run emitted two existing `Atomic::fetch_update` deprecation warnings in `freshell-freshagent`; no new warnings were reported.

## Verification

- `cargo test -p freshell-supervisor`: 115 passed, 8 ignored.
- `cargo test -p freshell-agent-runtime`: 44 passed, 2 ignored.
- `cargo test -p freshell-session-host`: 49 unit tests and 1 integration test passed; 2 crash tests ignored by default.
- `cargo clippy -p freshell-supervisor -p freshell-agent-runtime -p freshell-session-host --all-targets`: passed.
- `cargo fmt --check` and `git diff --check`: passed.

All fixtures use synthetic databases, files, receipts, and registry rows. The test-only checkpoints are behind `#[cfg(test)]`; production launch behavior and acceptance requirements were not weakened.
