# 0gdd Diagnostic Instrumentation — Archival Notes

Archived 2026-08-23. Copies only; source worktrees were not modified.

## 0gdd-measurement/

**Origin:** worktree `/home/dan/code/freshell/.worktrees/0gdd-measurement`, branch `investigation/0gdd-measurement`, HEAD `225a91db3e4d48d4b6a7e8bc0987afad8ff31917` at copy time.

Env-gated `FRESHELL_0GDD_LEVEL1` measurement bundle — Rust tracing diffs plus campaign runner and its 31-test vitest suite.

- `main.rs.patch` — `git diff` of tracked modifications to `crates/freshell-server/src/main.rs` (tracing instrumentation wiring).
- `auto_title_sweep.rs.patch` — `git diff` of tracked modifications to `crates/freshell-server/src/auto_title_sweep.rs` (sweep tracing).
- `directory_index.rs.patch` — `git diff` of tracked modifications to `crates/freshell-sessions/src/directory_index.rs` (index tracing).
- `measure-0gdd-level1.ts` — untracked campaign runner script (copied as-is from `scripts/`).
- `measure-0gdd-level1.test.ts` — untracked 31-test vitest suite for the runner (copied as-is from `test/unit/scripts/`).

## 0gdd-observer/

**Origin:** worktree `/home/dan/code/freshell/.worktrees/0gdd-observer`, branch `investigation/0gdd-observer`, HEAD `225a91db3e4d48d4b6a7e8bc0987afad8ff31917` at copy time.

- `observer_0gdd.rs` — untracked standalone 24h filesystem-event observer example binary (copied as-is from `crates/freshell-sessions/examples/`). The entire `examples/` directory was untracked in the source worktree; `observer_0gdd.rs` was its only file.

## Why archived, not landed

Both source worktrees are marked do-not-merge per the 0gdd handoff decision record. The diagnostic capability they provide has been superseded on `main` by `SessionWatcher`, so the instrumentation will not be merged; these copies preserve the only instances of it.

## Campaign output loss

The Level-1 measurement campaign **output** (collected data) was destroyed by a WSL reboot and is unrecoverable. These archived sources are the only re-derivation path: re-applying the patches and running the archived runner against a build at the recorded HEAD reproduces the measurement capability.
