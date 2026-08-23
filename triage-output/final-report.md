# Worktree Triage — Final Report

- **Date:** 2026-08-23
- **Repo:** `/home/dan/code/freshell`
- **Main:** `origin/main` @ `3d739ca4a` — "Fix gray-and-dead panes after WebSocket reconnect (4-layer reconnect revive) (#677)"
- **Scope:** all 74 worktrees under `.worktrees/` (activity window 2026-07-24 → 2026-08-23)
- **Method:** baseline git metrics → first-pass scan of all 74 → 5 parallel deep-dives on 18 worktrees (+1 folding in 0gdd-handoff) → aggregation.
- **Merger caveat:** this repo squash-merges AND merge-commits; merged-ness was verified by footprint diff vs main (files-touched comparison), not ancestor checks alone.

## Executive summary

| Verdict | Count | Action |
|---|---|---|
| ready-landing | 1 | PR it (after broad gate) |
| finish-work | 7 | salvage/finish per notes below |
| in-main | 51 | delete worktrees after dirty-files double-check |
| throw-away-useless | 8 | delete (2 archive-first cautions) |
| skipped-plan | 7 | delete; 1 kata candidate first |

**Bottom line: 66 of 74 worktrees (~89%) are done and deletable.** Real value sits in 8 worktrees: 1 ready PR candidate and 7 finish-work items (2 of which contain *uncommitted* work that would be silently lost on deletion).

---

## 1. Ready for landing (1)

### slash-command-catalogs — `the-usual/slash-command-catalogs` · 2026-08-19 · +13/−99
Slash-command catalog feature (Claude / Codex / OpenCode command listing) with unit tests and a converged, "executed" plan marker — a `the-usual` run that never got its PR. `git merge-tree` against current main shows **zero conflicts** despite being 99 commits behind, and focused suites pass at its HEAD. Land effort: small (broad gate + PR approval only).

## 2. Finish work (7)

### freshagent-undo-redo — `the-usual/freshagent-undo-redo` · 2026-08-23 · +17/−13 · **freshest distinct work**
Fresh-agent `/undo` `/redo` rollback. Tasks 1–6 complete with tests; the final e2e task was mid-flight (the one dirty file is the uncommitted fork-at-point fixture; `fresh-agent-rollback-rust.spec.ts` exists nowhere). ~19k lines; conflicts with main in only 2 files (both from PR #677). Finish task 7 in a rebased worktree rather than restarting.

### restart-recovery-hardening — `feat/restart-recovery-hardening` · 2026-07-29 · +13/−1237 · **18 dirty files — DO NOT DELETE**
The dirty tree is **+3,373 lines of real uncommitted WIP** (Claude `DurableRecoveryProvider` adapter; CLI-launch NFC/`CLAUDE_CONFIG_DIR` canonicalization) — the plan's next task, mid-flight. Deleting the worktree would silently destroy the resume point. Commit the WIP on the branch (or extract it) before any cleanup.

### restart-resumable-pane — `feat/restart-resumable-pane` · 2026-07-31 · +38/−1114
Complete Restart-pane transaction design (113 files), but predates the reconnect-revive rework (PR #677). Concepts remain relevant; needs a full re-port onto post-#677 main. Large effort.

### qa-campaign — `qa-campaign-20260806` · 2026-08-06 · +57/−860
Closed-loop QA campaign. **7 reviewed Node-oracle `files.rs` fixes (mkdir ENOTDIR→409, `~\` tilde, etag, mime, UNC, sanitize, dot-seg) — each with a proof test — never landed**; main's `files.rs` is byte-identical to the Aug-6 merge-base. Also found a live gap: main's client `BrowserPane.tsx` converts `file://` URLs to `/local-file?path=…`, but the Rust server has **no `/local-file` route** — the campaign fixed exactly this on-branch (FILE-01/02). Kata candidates: `/local-file` port, the 7 file fixes, `completion_sort` collator decision, DIAG-04 perf sampler.

### deploy-compatibility-rollback — `feat/deploy-compatibility-rollback` · 2026-07-31 · +72/−896 · **UNPUSHED — only copy**
Complete, tested (~34k lines) immutable-generation deploy-rollback controller. Main chose the simpler setsid+systemd route, so reviving is an architecture/product decision. **Push the branch to origin as an archive before considering worktree deletion.**

### df1-session-09-live-watching — `df1/session-09-live-watching` · 2026-08-09 · +2
Committed feature deliberately superseded on main (`09495fe07`; in-code comment D1-3 documents the trade). Only live value: the **untracked** black-box WS-wire acceptance test `crates/freshell-server/tests/session09_live_watching.rs`. The dirty `main.rs` change is a deliberately-labeled "TEMPORARY MUTATION (black-box red proof)" — **it must never be committed**. Salvage = copy the test file to a fresh worktree, adapt, PR.

### 0gdd-handoff — `docs/0gdd-handoff` · 2026-08-15 · +1
1,482-line 0gdd investigation handoff doc (commit `2aec62a10`, unlanded) + untracked 2,493-line lab-notes observations file. Docs-only, matching `docs/lab-notes/` convention. **Landing these two docs is the prerequisite** that makes deleting `0gdd-measurement`/`0gdd-observer` information-loss-free.

## 3. Already in main (51)

All verified merged — 48 as ancestors of `origin/main`, 3 via squash-merge footprint verification:

- **attention-bell-wrong-signals** — squash-landed verbatim as PR #614; the "5 files differ" baseline flag was post-merge forward evolution, not residue.
- **resume-button** — shipped via PR #583 (+ hardened #586, Rust-ported #592, simplified #593); this branch is a strictly older snapshot.
- **cloud-run-jobs** — landed as PR #628; main iterated 4+ times beyond (vitest-cloud lane, gcloud-robot ladder, image tagging).
- **reconnect-revive** — landed as PR #677 (today); only residual diff is a test fixture's model-ID strings, generalized on main.
- **fix-rust-specs-0q8k** — all 9 spec registrations already in main's `RUST_ONLY_SPECS`.
- **resilience-sprint** — main inlined `detached-session.sh` into `launch-rust.sh` with richer comments.
- The remaining 45: ancestors of main, clean trees (the two `gate01-baseline.json` dirty files are regenerated gate-run artifacts; `rust-tauri-port`'s untracked files are plan docs + a tmp probe). This includes the entire `df1/*` campaign worktree fleet and the 3 detached checkpoints (`df1-arb`, `df1-gate-final`, `pbh2-ro`).

## 4. Throw away (8)

| Worktree | Why |
|---|---|
| tab-bar-visual-overhaul | Fixed-width design never adopted; PR #596 superseded the width approach |
| ws-bootstrap-recovery-flake | Byte-identical to PR #625, which was squash-merged **and reverted same-day** (#626); branch adds nothing to history |
| parity-campaign | All 45 commits are ancestors of qa-campaign's HEAD — strictly redundant |
| df1-control | df1 campaign control-plane litter; branch already pushed to origin (sync copy exists) |
| playwright-azure-cloud | 1-commit Azure spike; project chose GCP Cloud Run; script names collide with main |
| release-v0.7.6-rc.1 | Version-bump only; 0.7.6 was never tagged |
| 0gdd-measurement | Uncommitted instrumentation explicitly marked **"do not merge"** in the investigation's own handoff doc; evidence archived outside the repo; main since shipped the recommended watcher-driven design |
| 0gdd-observer | Untracked 180KB observer program from a completed 24h campaign; evidence archived at `~/.local/state/freshell/0gdd-observer-20260814-08/` |

## 5. Skipped — plan/doc only (7)

`rest-codex-terminal-identity` (feature landed via PR #584) · `session-directory-lazy-page-prep` · `session-directory-page-prep` · `session-directory-page-bound` · `kata-sbnj` (22.8k-line parallel-cloud-runner plan, unexecuted) · `df1-retro` (retrospective) · **coding-agent-resource-containment** — a 3,963-line hardened cgroup-v2 agent-containment plan describing a feature absent from main; file a kata before deleting if that feature is still wanted.

---

## Recommended next actions

1. **Land the one PR candidate:** broad-gate `slash-command-catalogs`, then PR (requires your approval per repo rules).
2. **Land the 0gdd docs** (tiny PR: `0gdd-handoff` commit + untracked lab note), then `0gdd-measurement` and `0gdd-observer` become pure deletions.
3. **Archive before deleting:** push `feat/deploy-compatibility-rollback` to origin (only copy; product decision pending).
4. **Protect the WIP:** in `restart-recovery-hardening`, commit or stash the +3,373 uncommitted lines before any worktree removal.
5. **File katas** from `qa-campaign` (`/local-file` route gap is live — client references a route the Rust server doesn't have), the 7 unlanded `files.rs` fixes, and optionally `coding-agent-resource-containment`'s plan.
6. **Salvage then delete:** extract `session09_live_watching.rs` from `df1-session-09-live-watching` (the dirty main.rs is a poison red-proof mutation — never commit it).
7. **Finish or park:** `freshagent-undo-redo` (closest to done — missing only its final e2e spec) · `restart-resumable-pane` (needs full re-port, park unless prioritized).
8. **Delete the 59 done worktrees** (51 in-main + 8 throw-away, after items 2–4) — reclaiming ~36G in the campaigns group alone (`deploy-compatibility-rollback` ~26G, `df1-control` ~8.7G, mostly Rust `target/`).

## Cautions (do not skip)

- `restart-recovery-hardening` — uncommitted WIP, item 4 above.
- `df1-session-09-live-watching` — the modified `main.rs` must never be committed (it's a deliberate red proof).
- `ws-bootstrap-recovery-flake` — "reviving" it is a revert-of-a-revert that already failed verification once; treat via fresh investigation instead.
- `deploy-compatibility-rollback` — unpushed; deleting the worktree pre-archive loses the work permanently.

## Full reference table

See `final-report.csv` (74 rows, machine-readable) and `final-report.html` (sortable/filterable, links to deep-dive reports).

## Evidence files

- `baseline-data.jsonl` — raw per-worktree git metrics
- `baseline-criteria.md` — triage categories & method (incl. squash-merge detection)
- `first-pass-table.md` — all 74 worktrees, one-line assessments
- `deep-dive/01-tabbar-freshagent-ui.md` … `deep-dive/05-0gdd-investigation.md` — per-worktree evidence and verdicts
