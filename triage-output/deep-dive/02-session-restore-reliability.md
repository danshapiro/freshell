# Deep-dive triage: session restore / reliability worktrees

Second-pass, read-only. origin/main = 3d739ca4a (2026-08-23), tip = PR #677 "Fix gray-and-dead panes after WebSocket reconnect (4-layer reconnect revive)" — it reworked `src/lib/ws-client.ts` (+137), `src/store/panesSlice.ts`, `src/lib/pane-reconcile.ts`, `crates/freshell-ws/src/terminal.rs` (+251), `src/App.tsx`, `FreshAgentView.tsx` on 2026-08-23, so every branch here predates that rework. Squash-landed checks done via distinctive-identifier greps and exact diff comparison against main's history.

---

```yaml
worktree: restart-resumable-pane
branch: feat/restart-resumable-pane
date: 2026-07-31
ahead: 38
behind: 1114
verdict: finish-work
confidence: high
land-effort: large
```

## Evidence

- 38 commits (tip 1d591b723, 2026-07-31): 7 plan docs then a complete implementation of "Restart resumable pane" per `docs/superpowers/plans/2026-07-29-restart-resumable-pane.md` — replace right-click Refresh with a server-serialized Restart for resumable coding-agent panes, targeting the Rust server. Footprint: 113 files, +21890/-700.
- Rust core is all new files/major rewrites: `crates/freshell-ws/src/restart.rs` (4648 lines: `RestartCoordinator`, `RuntimeLocator{kind,provider,session_id}`, runtime-generation fences, session-admission serialization across terminal+sidecar writers, persisted terminal-result replay), `crates/freshell-ws/tests/restart_protocol.rs` (4614 lines), protocol additions (`AgentRestart` request; `agent.restart.started`/`replaced`/`failed` broadcasts in `crates/freshell-protocol`), provider adapters (`freshell-freshagent/src/{claude,codex,opencode_ws}.rs` ~+1070 each), `terminal.rs` +918. Client: `ws-client.ts` +310, `freshAgentSlice.ts` +265, `panesSlice.ts` +152 (+1542 total across 21 src files), plus `docs/index.html`.
- Nothing landed on main: greps for `AgentRestart`, `AgentRestartReplaced`, `RestartCoordinator`, `RuntimeLocator`, `ProductionRestartRuntime`, `restart_runtime_contract_satisfied` over origin/main → zero hits. Main's `crates/freshell-protocol/src/client_messages.rs` has no restart message; main's only client-side restart concept is the `restartFreshAgentCreate` reducer (a fresh-create on hydration failure, different thing) and the pre-existing `Refresh pane` context-menu item (`src/components/context-menu/menu-defs.ts:430/498/551`). The duplicate-open part is partially covered on main in evolved form (device-aware "Open copy"/`isSessionOpen` in menu-defs.ts:365-381,673) but not the branch's workspace-local hide/report behavior.
- Compatibility: branch base is 2026-07-29, before the August df1 Rust port convergence and before #677. Every anchor file it builds on has moved hard: #677 alone rewrote `ws-client.ts` reconnect (+137) and `terminal.rs` (+251); `pane_ledger.rs`, `recovery_inventory.rs` grew independently (main's `pane_ledger.rs` = 1004 lines on a different lineage). "restart-resume" hits in main's log are narrow rebind/resume-resilience fixes (e.g. 348723d35 fork→rebind→restart-resume for claude/codex) — none provide user-initiated pane restart.
- Tests were not re-run (verdict rests on code/history identity, not suite state).

## Recommendation

Keep — this is the largest wholly-unlanded feature in the set: a complete, tested, server-authoritative pane-restart transaction with duplicate-session-open prevention that main simply does not have. But it is not landable as-is: 1114 commits behind with its whole foundation (#677 Rework, df1 port) shifted; landing means rebasing/re-porting `restart.rs` onto current `terminal.rs`/`pane_ledger`/protocol and re-deriving the client atop post-#677 `ws-client.ts`/`panesSlice.ts`. If the product still wants Restart pane, revive the plan first, then re-apply the implementation piecewise against current main rather than attempting a monolithic rebase.

---

```yaml
worktree: restart-recovery-hardening
branch: feat/restart-recovery-hardening
date: 2026-07-29
ahead: 13
behind: 1237
verdict: finish-work
confidence: high
land-effort: large
```

## Evidence

- 13 committed commits (tip 84cf0efe5, 2026-07-29), 73 files, +7858/-585: implementation of `docs/superpowers/plans/2026-07-28-fast-exact-session-restore.md` (2053 lines) — "Fast, Exact, Automatic Session Restore": after a server restart every provable pane restores immediately with NO recovery popup. Adds a new leaf crate `crates/freshell-recovery` (`coordinator.rs` 882, `lib.rs` 260 contract, `ownership.rs` 65), new `crates/freshell-server/src/recovery_providers.rs` (+295), `recovery_inventory.rs` rework (+193), `pane_ledger.rs` +567 (branch 1385 lines vs main 1004), heavy ledger/reconcile tests (+1091/+428/+335), a client `ws-client.ts` rework (±323: `WS_LEGACY_PROTOCOL_VERSION` connect fallback), `RecoveryOfferPanel.tsx` +20, `shared/ws-protocol.ts` +28/`ws-version.ts` +6, and 3 base deflake commits.
- The 18 dirty files are REAL work, not build noise (+3373/-81): the next plan task — `claude_snapshot.rs` +2069 implementing `freshell_recovery::DurableRecoveryProvider` for Claude (exact-ownership proofs, batched project index, ordered store-root candidates), `recovery_providers.rs` +471, `cli_launch.rs` +282 (`child_cwd`, `ClaudeInvalidConfigRoot`, unicode-normalization NFC), and sidecar `index.mjs` `claudeConfigDir` plumb-through (+11), with Cargo.toml/lock adding `unicode-normalization`.
- Nothing on main: `git ls-tree origin/main crates/` has no `freshell-recovery` crate; greps for `RecoveryCoordinator`, `recovery_providers`, `claudeConfigDir`, `child_cwd`, `unicode_normalization`, `WS_LEGACY_PROTOCOL_VERSION`, `legacyFallbackAttempted` over origin/main → all zero.
- Main chose a different restore product: B3/P1.9 lineage (`00307ff1f` GET /api/recovery/inventory, `b8cb904bd` pure inventory builder, `55941fddb` inventory omission fix; client `src/lib/recovery/{boot-state,build-recovery-plan,dismissal,types}.ts`) + RESTORE-01 `RecoveryOfferPanel` — a user-invoked recovery offer dialog that the branch's plan explicitly supersedes ("no recovery pop-up... the existing tabs simply return"). Main's `recovery_inventory.rs` (570 lines, `select_foreign_recent_generation_ids` staleness logic) diverged from the branch's base (507 lines). #677 also reworked the very `ws-client.ts` reconnect code this branch rewrote.
- Tests not re-run; compile state of the dirty WIP unknown (depends on the branch-only crate).

## Recommendation

Keep — this is a mid-flight, well-planned feature (coordinator + provider contracts committed; Claude provider adapter uncommitted but substantial and real). Nothing in it is on main under any name, and main's RESTORE-01 offer dialog is a deliberately different (manual) UX answer, so reviving this is a product decision, not just a rebase. If automatic restore is wanted, resurrect the plan and re-base task-by-task onto current main (crate-first, then providers, then the ws-client controller, adapting to #677); the dirty diff is the immediate resume point and should be committed or stashed before any cleanup touches the worktree.

---

```yaml
worktree: ws-bootstrap-recovery-flake
branch: the-usual/ws-bootstrap-recovery-flake
date: 2026-08-09
ahead: 14
behind: 735
verdict: throw-away-useless
confidence: high
land-effort: none
```

## Evidence

- 14 commits; net footprint exactly 3 files: `docs/plans/2026-08-09-ws-bootstrap-recovery-flake.md` (+221), `test/unit/client/components/App.ws-bootstrap.test.tsx` (+29: `InertBroadcastChannel` stub + `_resetSessionWindowThunkState()`/`_resetTerminalDirectoryThunkControllers()` boundary resets + one fence assertion), `test/unit/server/fresh-agent/opencode-serve-manager.test.ts` (+22/-4: onceIdle inner deadline 100ms→10s, eager observation branch to kill the unhandled-rejection window, outer budget 1000→10000ms). The branch's own 84-line regression-guard test (1b8f57e71) was reverted at tip (3969ea802) after delta-review round 4.
- Decisive fact: this exact net content was squash-merged as PR #625 (2300258d6, 2026-08-09, same commit list including the tip revert) and REVERTED the same day by PR #626 (d9712f84b / merge 90e31f578): "Reverted pending further verification; state and open items are tracked in the follow-up issue." Byte check: `git diff merge-base..HEAD` ≡ `git show 2300258d6` — IDENTICAL. The worktree holds nothing that is not already in main's git history.
- Main today still carries the flaky versions: main's `opencode-serve-manager.test.ts` (lines ~831-848) still has `onceIdle('ses_a', 100)` with `}, 1000)`; main's `App.ws-bootstrap.test.tsx` has neither `InertBroadcastChannel` nor the thunk resets (the reset helpers themselves DO exist on main: `src/store/sessionsThunks.ts:60`, `src/store/terminalDirectoryThunks.ts:44`). PR #677 independently grew the same file (added `poke: vi.fn()` mock + a visibilitychange-poke test) — that delta is disjoint from the branch's (imports/class/beforeEach/afterEach vs poke-mock/new-test), so the #625 diff would still apply as a revert-of-the-revert.
- PR #677's reconnect rework does not moot this flake: the root cause (cross-file BroadcastChannel poison into the mounted suite, empirically proven in the plan doc) is test-environment hygiene; nothing in #677 changes BroadcastChannel or thunk-residue behavior in that suite.

## Recommendation

Delete the worktree; it is a frozen copy of reverted PR #625 with zero unique residue. The underlying flake is still live on main (the onceIdle 100ms/1000ms shape and the missing BroadcastChannel isolation are unchanged), so if it recurs, the correct move is `git revert d9712f84b` (revert the #626 revert) — a tiny history operation, not a salvage from this worktree — and only after doing the "further verification" #626 demanded, since this fix already failed the trust bar once.

---

```yaml
worktree: df1-session-09-live-watching
branch: df1/session-09-live-watching
date: 2026-08-09
ahead: 2
behind: 515
verdict: finish-work
confidence: high
land-effort: small
```

## Evidence

- 2 committed commits: bf8a30c33 (red pins + plan) and d823c9870 ("full-comparable digest sweep signature") — reworks `sessions_sweep_signature` in `crates/freshell-server/src/main.rs` from a blind `(len, max_last_activity_at)` shape to hashing per-session content fields (provider/session_id/project_path/title/summary/first_user_message/created_at/cwd/is_subagent/is_non_interactive).
- Dirty `crates/freshell-server/src/main.rs` is explicitly labeled "TEMPORARY MUTATION (black-box red proof)": it blinds the signature back to `(len, max)` semantics so the untracked test provably fails against it. It must be discarded, never committed.
- Untracked `crates/freshell-server/tests/session09_live_watching.rs` (424 lines): a single black-box acceptance test — boots the real `freshell-server` binary against an isolated temp HOME, hello→ready WS handshake, then drives on-disk create → append → hidden→visible `is_non_interactive` flip (the SESSION-16 handoff case with NO timestamp movement) → delete → 5-append burst, asserting live `sessions.changed` frames with monotonic revisions plus a 6.5s quiet-boot window. An anchor session at a 2030 timestamp pins the corpus max so the old signature is provably blind (non-tautological). Harness conventions are duplicated from `diag01_lifecycle_logging.rs`/`safe11_term22_shutdown_reaping.rs`, which exist on main.
- Superseded-by-design for the committed part: main commit 09495fe07 (2026-08-18, ON MAIN) "broadcast sessions.changed on every index generation advance" made the sweep broadcast unconditionally on `rx.changed()` and demoted the `(count,max,digest)` triple to a suppression gate for the 2s identity ticker only — the in-code D1-3 comment (main.rs ~2650-2665) documents the exact under-approximation the branch was fixing and resolves it at the SessionIndex generation layer instead of with a full-comparable digest.
- Coverage gap is real but narrow: main has in-crate `sessions_sweep_tests` (signature semantics), SessionIndex generation logic, and browser-level PW rust specs (`session-directory-matrix.spec.ts` live-create leg L565-599 + removed-file leg ~L680; `sidebar-registry-sync-rust.spec.ts` mutates jsonl mid-test). Nothing on main boots the real binary and asserts raw WS-wire frames for the full 5-leg matrix — quiet boot, revision monotonicity, burst coalescing, and the no-timestamp-movement flip are unpinned at wire depth.

## Recommendation

Discard the two commits and the temporary mutation (superseded design + proof-tool); salvage only the untracked acceptance test. Copy `session09_live_watching.rs` out of the worktree, run it against a main-built binary (the generation-advance design should pass every leg: content changes advance the index generation, and an idle corpus keeps boot quiet), and land it as an additive wire-level SESSION-09 pin via a fresh PR. If that validation shows any leg tautological or redundant with the PW specs, drop the whole worktree instead.
