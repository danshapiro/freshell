# Dirt Report 01 — restart-recovery-hardening + freshagent-undo-redo

Dirt reader pass, 2026-08-23. Every uncommitted file in both worktrees was
physically read (full diffs for tracked modifications; full structure read for
untracked files). No files were modified, no tests were run, nothing was
committed.

---

## Worktree 1: restart-recovery-hardening

**Branch:** `feat/restart-recovery-hardening`
**Dirt verdict: read-useful — 18/18 files are real, coherent, mid-flight
implementation WIP. Zero litter, zero poison.**

This is the second half of the branch's committed work: a strict "exact
recovery" ownership-proof layer for Claude and Codex plus the
CLAUDE_CONFIG_DIR canonicalization that makes child-writer and
recovery-reader resolve to one NFC/absolute store root. Everything
interlocks: the sidecar accepts a per-create `claudeConfigDir`
(index.mjs), `claude.rs` threads it, `cli_launch.rs` canonicalizes it
against the child cwd with NFC, `claude_snapshot.rs` implements the Claude
provider with TOCTOU-safe identity proofs, the new `codex_exact.rs` module
implements the Codex DB-first provider, and `recovery_providers.rs` wires
both into the server registry.

One compile-blocking caveat: `coordinator.rs`'s dirty diff adds RED-phase
tests for a **store-domain identity feature (`RecoveryStoreDomain ::
Host/WindowsInterop/Wsl`) whose production counterpart does not exist
anywhere** — not in the branch HEAD, not in the worktree, not on
origin/main. `ExactRecoveryLookupKey` (lines 16–20 of the worktree file)
has only `session_ref`/`cwd`; the new tests add `store_domain:` to its
struct literals and reference the missing enum, so the crate cannot compile
in its current dirty state. This is legitimate mid-TDD red (test names map
1:1 to domain dispatch/canonicalization/poison-isolation behavior), not
sabotage — but any commit of coordinator.rs alone snapshots a red tree.

**Useful files (all 18):**

| # | File | Diff / size | Disposition |
|---|------|-------------|-------------|
| 1 | `Cargo.toml` | +4/-0 | commit-to-branch |
| 2 | `Cargo.lock` | +45/-0 | commit-to-branch (with #1 — real dep additions, not churn) |
| 3 | `crates/freshell-claude-sidecar/index.mjs` | +8/-3 | commit-to-branch |
| 4 | `crates/freshell-freshagent/Cargo.toml` | +11/-5 | commit-to-branch |
| 5 | `crates/freshell-freshagent/src/claude.rs` | +295/-8 | commit-to-branch |
| 6 | `crates/freshell-freshagent/src/claude_snapshot.rs` | +2047/-22 | commit-to-branch |
| 7 | `crates/freshell-freshagent/src/lib.rs` | +6/-4 | commit-to-branch |
| 8 | `crates/freshell-freshagent/src/terminal_tabs.rs` | +7/-1 | commit-to-branch |
| 9 | `crates/freshell-platform/Cargo.toml` | +1/-0 | commit-to-branch |
| 10 | `crates/freshell-platform/src/cli_launch.rs` | +280/-2 | commit-to-branch |
| 11 | `crates/freshell-platform/src/cli_launch_goldens.rs` | +28/-0 | commit-to-branch |
| 12 | `crates/freshell-recovery/src/coordinator.rs` | +169/-0 | commit-to-branch — **red-phase tests for a struct field/enum that does not exist yet; will not compile until `RecoveryStoreDomain` + the `store_domain` field are implemented** |
| 13 | `crates/freshell-server/src/recovery_providers.rs` | +440/-31 | commit-to-branch |
| 14 | `crates/freshell-sessions/Cargo.toml` | +15/-4 | commit-to-branch |
| 15 | `crates/freshell-sessions/src/lib.rs` | +1/-0 | commit-to-branch |
| 16 | `crates/freshell-ws/src/terminal.rs` | +16/-1 | commit-to-branch |
| 17 | `crates/freshell-sessions/src/codex_exact.rs` (untracked) | 1,445 lines / 50,721 B | commit-to-branch |
| 18 | `crates/freshell-sessions/tests/codex_exact.rs` (untracked) | 991 lines / 38,636 B | commit-to-branch |

---

## Worktree 2: freshagent-undo-redo

**Branch:** `the-usual/freshagent-undo-redo`
**Dirt verdict: read-useful — 8/8 files are real, coherent, mid-flight
implementation WIP. Zero litter, zero poison.**

⚠️ **The briefing's description is wrong.** The prompt claimed one dirty
file (`test/e2e-browser/helpers/fake-claude-sdk-sidecar-control.test.ts`,
"a fork-at-point fixture"). The authoritative `git status` shows **8 modified
Rust files** in `crates/freshell-freshagent/src/`; the e2e fixture **exists
in the worktree but is fully clean/committed**. The actual dirt is a
"delta-r1" follow-up batch on top of the branch's committed rollback
(undo/redo) work:

- **F1 (claude compact busy discipline):** `handle_compact` now mirrors
  `handle_send` — parks through a mid-rollback teardown window, takes the
  session `turn_lock`, sets `in_turn` under the lock before the sidecar
  write; rollback during a compact refuses `BUSY_TURN` with zero teardown
  traffic (test included).
- **F2 (codex compact-window busy truth):** new `compact_in_flight:
  Arc<AtomicBool>` on every codex session, set under `turn_lock` at compact
  start and cleared by the compact turn's `turn/completed` in
  `reduce_notification`, closing the post-RPC/pre-`turn/started` window
  where `active_turn` is still empty (test with scripted fake peer
  included).
- **F6 (server-authored redo gate):** snapshot `rollback` JSON gains
  `redoableTurnIds` — the exact user-role turn ids of the CURRENT epoch's
  entries.
- **F8 (literal epoch bookkeeping):** `RollbackEntry.epoch` +
  `RollbackRecord.current_epoch` with `begin_new_epoch()` /
  `splice_undo_entry()` replacing the timestamp-heuristic frozen/current
  split across all three lanes (claude/codex/opencode);
  `#[serde(default)]` keeps pre-F8 disk rows parsing (schema stays v1).

**Useful files (all 8):**

| # | File | Diff | Disposition |
|---|------|------|-------------|
| 1 | `crates/freshell-freshagent/src/rollback_record.rs` | +259/-11? (259 net adds, small deletions) | commit-to-branch — core of the batch: epoch fields, splice logic, `redoable_turn_ids`, 4 new tests |
| 2 | `crates/freshell-freshagent/src/codex.rs` | +408/-? (largest: net ~+230) | commit-to-branch — F2 + F8 adoption + new fake-peer tests |
| 3 | `crates/freshell-freshagent/src/opencode_ws.rs` | +151/-123 | commit-to-branch — F8 adoption (per-op entries replace served-ids partition heuristic) + test updates |
| 4 | `crates/freshell-freshagent/src/claude.rs` | +167/-? | commit-to-branch — F1 compact discipline + F8 undo arm + compact/rollback test |
| 5 | `crates/freshell-freshagent/src/claude_snapshot.rs` | +23/-4 | commit-to-branch — test-only updates for epoch/`redoableTurnIds` |
| 6 | `crates/freshell-freshagent/src/lib.rs` | +13/-4 | commit-to-branch — test-only updates (opencode snapshot JSON expectations) |
| 7 | `crates/freshell-freshagent/src/snapshot.rs` | +3/-1 | commit-to-branch — test-only update |
| 8 | `crates/freshell-freshagent/src/identity_sink.rs` | +1/-0 | commit-to-branch — test-only one-liner (`epoch: 0` fixture) |

(Exact +/- per file from `git diff --numstat` for worktree 2 was captured:
812 insertions, 213 deletions total across the 8 files.)

---

## Key proof excerpts (non-obvious calls)

1. **coordinator.rs is red-phase TDD, does not compile as-is.**
   Worktree file, production struct (lines 16–20):
   `pub struct ExactRecoveryLookupKey { pub session_ref: SessionLocator, pub cwd: Option<PathBuf> }`
   — no `store_domain`. The diff's new test helper (line 326–333) constructs
   it with `store_domain: RecoveryStoreDomain::Host`. `git grep
   RecoveryStoreDomain HEAD -- crates/freshell-recovery` and the same grep
   against `origin/main` both return zero hits. New tests encode the intent
   (`registry_dispatches_identical_locators_in_distinct_store_domains`,
   `registry_canonicalizes_wsl_distribution_before_dedupe`, `invalid_wsl_domain_does_not_poison_an_identical_host_lookup`).
   → keep, commit-to-branch, but it snapshots a RED tree until the field +
   enum land.

2. **Cargo.lock is semantic, not churn.** Its 45 additions are exactly the
   new real deps: `unicode-normalization 0.1.25`, `zstd 0.13.3` (+safe/sys),
   `windows-sys 0.61.2`, `toml 0.9.12`, and `freshell-protocol` /
   `freshell-recovery` added to freshell-sessions' dependency list — all
   matching the Cargo.toml diffs. Commit together with them.

3. **codex_exact.rs is a complete provider, not a stub.** Header: "Strict,
   read-only Codex exact-recovery ownership proofs… SQLite rows are only
   accelerators, rollout metadata is ownership authority". 1,445 lines:
   `CodexExactStore` (split codex_home/sqlite_home with config.toml /
   `CODEX_SQLITE_HOME` precedence per Codex 0.145), DB row schema validation
   (sole PK, NOT NULL TEXT rollout_path), WAL-safe read-only opens, busy
   deadline + progress-callback caps, plain/.zst logical-artifact
   coalescing, hardlink/identity dedup (`FileIdentity` via dev:ino /
   FILE_ID_INFO), O_NOFOLLOW+O_NONBLOCK opens, root-replacement recheck
   (`ArtifactChanged`), bounded tree scan (50k entries/8,192 dirs/2,048
   candidates). Its 991-line test file has 30 tests including
   `wal_visible_committed_row_is_read_without_checkpointing`,
   `db_traversal_outside_and_symlink_escape_are_retryable_without_opening_target`,
   `fifo_socket_and_device_shaped_db_or_rollout_candidates_return_promptly`.

4. **claude_snapshot.rs exact provider is the security-sensitive core.**
   `inspect_claude_transcript_under_root` proves ownership with: canonical
   parent containment under the captured canonical root,
   `stable_directory_identity` before/after, handle-vs-path identity
   re-check after read (`ensure_unchanged`), O_NOFOLLOW opens, bounded head
   read (64 records / 256 KiB), Node-vs-Bun long-slug dual-hash fallback
   (`claude_project_location_from_writer_cwd` with the Java-style base36
   hash + 200-UTF-16-unit prefix), and an explicit
   Node-realpath-compatible Windows reparse walk
   (`node_compatible_windows_realpath`) so Claude's project slug/hash is
   not perturbed by Rust canonicalize's case normalization.

5. **freshagent-undo-redo dirt is a delta-r1 fix batch, not the briefing's
   fixture.** Representative new test: rollback_record.rs
   `splice_undo_entry_after_destroy_freezes_the_prior_epoch_then_orders_the_new_epoch`
   asserts entry epochs `[(0,"p4"),(1,"pn1"),(1,"pn2")]` — "frozen
   prior-epoch prefix first (untouched epochs), then the new epoch
   ascending"; and codex.rs drops the at_ms-descending heuristic in favor
   of `splice_undo_entry`, deleting the old guardrail test
   (`handle_rollback_without_an_unambiguous_frozen_split_appends_never_reorders`
   was REPLACED by
   `handle_rollback_undo_send_undo_undo_freezes_epoch_zero_and_orders_the_new_epoch_ascending`).

6. **No poison anywhere.** No secrets, no test-widening, no
   skip/ignore markers, no adversarial edits — every deletion is a
   commented-and-justified replacement of a superseded implementation, and
   test expectation updates all correspond to the new epoch/redoableTurnIds
   semantics.

---

## Roll-up

- **restart-recovery-hardening: read-useful, 18/18 useful.** Single
  recommendation: commit all 18 files to `feat/restart-recovery-hardening`
  (the dependency manifests, sidecar, launch canonicalization, both
  providers, and the two new codex_exact files are one interlocking
  change-set; coordinator.rs is red-phase TDD for the not-yet-implemented
  store-domain identity — flag it in the commit message or implement
  `RecoveryStoreDomain` first if a green tree is required).
- **freshagent-undo-redo: read-useful, 8/8 useful.** Commit all 8 Rust
  files to `the-usual/freshagent-undo-redo` as the delta-r1 batch (F1/F2/F6/F8).
- Nothing for archive-in-triage, delete-as-litter, or never-commit-poison.
