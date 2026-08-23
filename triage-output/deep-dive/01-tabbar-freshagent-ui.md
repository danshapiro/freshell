# Deep-dive triage: tab-bar & fresh-agent UI worktrees

Second-pass, read-only. origin/main = 3d739ca4a (2026-08-23). Verdicts checked against squash-merged PRs (GH non-ancestor lineage) plus content identity of every distinctive file.

---

```yaml
worktree: tab-bar-visual-overhaul
branch: feat/tab-bar-visual-overhaul
date: 2026-07-29
ahead: 15
behind: 1179
verdict: throw-away-useless
confidence: medium
land-effort: none
```

## Evidence

- 15 commits (f4adeb116 tip, 2026-07-29 14:35): plan doc + tab visual redesign — new module `src/lib/tab-visual-state.ts` (79 LOC) defining `resolveTabVisualState` with states `'neutral' | 'working' | 'ready' | 'ready-unacked'`, the semantic inversion "GREEN is the RESTING state" (any live non-busy tab renders green; working renders identical to neutral; pane icons go dark-grey only), fixed 150px tab width (`w-[150px] shrink-0` in TabItem), plus `readyByTab` persistence work in `turnCompletionSlice.ts`. Footprint: 23 files, ~1.9k insertions incl. `docs/plans/2026-07-29-tab-bar-visual-overhaul.md` (1278 lines) and full test updates.
- Nothing distinctive landed on main: `git grep tab-visual-state / readyByTab / data-visual-state / "resting state" / "ready-unacked"` over `origin/main` and the main checkout — zero hits anywhere (src, docs/index.html). The plan doc never reached main (`git log origin/main -- docs/plans/2026-07-29-tab-bar-visual-overhaul.md` = empty).
- Main chose different answers on the branch's own turf: tab sizing went to PR #596 `c7badcbef feat(tabs): uniform responsive tab widths (180px cap, equal shrink)` (2026-08-01, three days after the branch's last commit) using `w-[180px] min-w-[100px] shrink` wrappers rather than fixed widths; main then kept iterating its design (multirow plans 2026-08-07, mobile context-menu #635, reconnect-revive #677).
- Main's color semantics remain the pre-branch design: main's `TabItem.tsx` still colors busy blue (`busy ? 'fill-blue-500 text-blue-500'`, `text-blue-500` overflow badge) and reserves green/emerald strictly for `needsAttention` governed by `tabAttentionStyle` (highlight/pulse/darken). The branch's "idle = green resting, working = unstyled" inversion was never adopted.
- No PR was ever opened from this branch (`gh pr list --search tab-bar-visual-overhaul` = empty).
- Risk note: the branch also edits attention-related e2e specs (`truly-idle-alerting.spec.ts`, `pane-activity-indicator.spec.ts`, etc.) to match its semantics — landing it now would require re-deriving those updates against 1179 commits of drift.

## Recommendation

Delete. The design direction was never adopted; main independently reshaped every surface this branch touched (widths via #596, continued blue-busy/green-attention semantics). Nothing in the branch is a missing capability — it is a superseded restyle whose test expectations contradict main's current spec suite. If the "green = resting" idea is ever wanted, it should be re-planned against current main, not resurrected from this branch.

---

```yaml
worktree: freshagent-undo-redo
branch: the-usual/freshagent-undo-redo
date: 2026-08-23
ahead: 17
behind: 13
verdict: finish-work
confidence: high
land-effort: medium
```

## Evidence

- 17 commits (ce4096b62 tip, 2026-08-23 11:00 — branched from a main only 13 commits old); plan `docs/plans/2026-08-22-freshagent-undo-redo.md` (3743 lines, fresh-eyes rounds 1-3 remediated, load-bearing validations settled "10/10 claims"). 72-file footprint, ~19.2k insertions.
- Tasks 1–6 are committed and complete: wire contract v8 + durable rollback-record plumbing + refusal surface (67b7fed63), codex undo-only `thread/revert` (2af110095), opencode revert/unrevert with snapshots-disabled managed serve (534a85c38), claude/kilroy `resume+resumeSessionAt+forkSession` fork-at-point (e415729bb), snapshot surfacing of capabilities/marker bucket/redo availability (f204a9808), and the client UI — `/undo` `/redo` commands, per-turn rollback icon, composer refill, attention revoke, `Rolled back (N)` section (519849264 + review fixes).
- Test coverage already in branch: Rust integration — `crates/freshell-freshagent/tests/freshagent_claude_rollback.rs` (945 lines) and `freshagent_rollback_refusal.rs` (128); client unit — ~700 new/changed lines across `fresh-agent-rollback.test.ts`, `FreshAgentView.test.tsx` (+471), `FreshAgentComposer/TurnActions/Transcript` tests, `fresh-agent-ws.test.ts` (+146), `turnCompletionAttention.test.ts`. Codex durability (`crates/freshell-codex/src/durability.rs` +250) and ledger rows (`pane_ledger.rs` +136) covered by cargo tests per the plan.
- Main has zero undo/redo for fresh agents: `grep rollback/undo/redo` over main's `shared/fresh-agent-slash-commands.ts`, `crates/freshell-freshagent/src/lib.rs`, `crates/freshell-protocol/src/client_messages.rs`, `src/components/fresh-agent/*.tsx` — no matches; `git log origin/main --grep=undo/redo/rollback` finds only unrelated hits (tab reopenStack, CI rollback docs). Never landed, no PR.
- NOT done — Task 7 (the user-visible e2e): plan's Task 7 adds `test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts` (seven tests incl. kilroy leg + opencode byte-identical-tree assertion) plus fake support; the spec file exists in NEITHER the branch tree NOR the workdir. The worktree's one dirty file is Task 7's Step-1 scaffold: an uncommitted new `describe` block "fake-claude-sdk-sidecar fork-at-point arm (kata 1wxv e2e fixture)" appended to `test/e2e-browser/helpers/fake-claude-sdk-sidecar-control.test.ts`. Task 7 Steps 2–7 were never executed; the plan's final acceptance gate (contract regen, cargo clippy/fmt, `npm run check`, e2e-on-cloud + CLOUD_SKIP audit) is unrun.
- Merge mechanics vs current main: `git merge-tree --write-tree origin/main the-usual/freshagent-undo-redo` conflicts in only TWO files — `crates/freshell-freshagent/src/claude.rs` and `test/unit/client/lib/fresh-agent-ws.test.ts` — both caused by the single overlapping main commit 3d739ca4a (#677 reconnect-revive). claude.rs is heavily rewritten on the branch (7772 diff lines), so the conflict needs real reconciliation against #677's revive hooks.

## Recommendation

Keep and finish — this is the freshest, highest-value unlanded work in the triage set: a complete three-provider undo/redo implementation with unit+integration coverage, conflicting with main in only two files. To land: (1) resolve the two conflicts while preserving #677's reconnect-revive behavior; (2) commit the in-progress fork-at-point fixture test and finish plan Task 7 (e2e spec + fakes); (3) run the plan's own final acceptance gate (contract regen, cargo fmt/clippy, coordinated `npm run check`, cloud e2e incl. CLOUD_SKIP audit); (4) PR with user approval. Until Task 7 exists the feature fails the repo's e2e-coverage bar for user-visible behavior, so it is "finish-work", not "ready-landing" — but it is close.

---

```yaml
worktree: resume-button
branch: feat/resume-button
date: 2026-07-29
ahead: 16
behind: 1078
verdict: in-main
confidence: high
land-effort: none
```

## Evidence

- 16 commits (82a945a71 tip, 2026-07-29 20:59), 32-file footprint, ~6.8k insertions: pinned always-visible Resume button in Sidebar footer, `ResumeSessionDialog` (411 LOC), `POST /api/sessions/resolve` cross-provider, `claude-transcript-locator.ts`, `opencode-by-id-{query,runner,worker}.ts` (off-thread DB query), `resolve-fallbacks.ts`, permissive `resume-input-parser.ts`, plus full unit/e2e suites.
- The same capability landed three days later under a re-created branch: PR #583 `feat(sidebar): pinned Resume Session button with cross-agent resume-string resolution` (branch `feat/resume-session-button`, MERGED 2026-07-30), then evolved by PR #586 (session-resolve hardening — off-thread lookups, match ranking, provider-health channel), PR #592 (Rust resolve parity, SYNC-06), PR #593 (resume-dialog simplify — removed the always-visible agent picker).
- Every distinctive branch artifact exists on main in evolved form: main has all of `src/components/ResumeSessionDialog.tsx` (last touched by #593, `ea0e8fcb6`), `server/coding-cli/claude-transcript-locator.ts`, `resolve-fallbacks.ts`, all three `opencode-by-id-*` files, `shared/resume-input-parser.ts` (the branch's "permissive/advisory" wording survives verbatim), `POST /api/sessions/resolve` in `server/sessions-router.ts`, the pinned Resume button wired in main's `Sidebar.tsx` (imports + renders `ResumeSessionDialog`, `resolveResumeInput` in `src/lib/api.ts`), and a Resume entry in main's `docs/index.html` mock.
- The "28/32 footprint files differ vs main" baseline number reflects main being AHEAD, not content missing: e.g. `git diff origin/main feat/resume-button` on `Sidebar.tsx`/`sessions-router.ts`/`resume-input-parser.ts` shows the branch holding the older pre-#586/#593 versions.
- Branch is not an ancestor of main (expected — #583 was a separate branch containing the same work), and no commits exist on this branch after 2026-07-29.

## Recommendation

Delete. The resume-by-ID capability shipped via #583 and was subsequently hardened (#586), ported to the Rust server (#592), and simplified (#593); the stale worktree is strictly an older snapshot of that same lineage with no unique residue. Nothing to salvage.

---

```yaml
worktree: attention-bell-wrong-signals
branch: fix/attention-bell-wrong-signals
date: 2026-08-06
ahead: 28
behind: 859
verdict: in-main
confidence: high
land-effort: none
```

## Evidence

- 28 commits (6ab127a8e tip, 2026-08-06 15:36 -0700): truth-source-verified attention signals across the Rust activity stack — new `crates/freshell-activity/src/signal.rs` (313), new `crates/freshell-ws/src/claude_truth.rs` (575; ClaudeTruth session-JSONL turn-state/submit probes), opencode deadman/lane/drift work (#603–#605, #609, #610), amplifier signal-loss verify (#605), claude bare/double-Enter provisional-submit handling (#611), amplifier orchestrator:complete boundary, build.rs self-identifying boot line + `scripts/build-stamp-check.sh` (#613), death-bell suppression on observed human quit (#612).
- This exact branch was squash-merged: PR #614 (`fix(attention): truth-source-verified attention bells — … (#603–#613)`), head branch `fix/attention-bell-wrong-signals`, 28 commits, merged 2026-08-06T23:22Z as `f0b5e8cc3` (present in `git log origin/main`); merged same day as the branch tip, and the branch carries no post-merge commits. Ahead-28 / non-ancestor is pure squash-merge artifact.
- Content identity: 12 of the 17 footprint files are byte-identical to main (`git diff --quiet origin/main fix/attention-bell-wrong-signals -- <f>`), including ALL substantive new files (`signal.rs`, `claude_truth.rs`, `build-stamp-check.sh`, `build.rs`, `diag.rs`, `opencode_lane.rs`, claude/codex/idle/opencode trackers, the 5438-line plan doc). The branch's AGENTS.md tweak (self-identifying boot-line doc) is also on main verbatim (with a later 3002→3001 port edit on top).
- The 5 differing footprint files are main-evolved-FORWARD, never branch residue: (1) `AGENTS.md` — main accumulated later notes (base-gate, amplifier-skills); (2) `amplifier/tracker.rs` — main's doc comment is a superset (documents root `orchestrator:complete`), refined post-merge by 9029a3670; (3) `crates/freshell-server/src/main.rs` — diff shows only later main additions (`ai_router`, `auto_title_sweep`, `managed_ports`, `migrations`, …) absent on the older branch; (4) `crates/freshell-ws/src/lib.rs` — same (main-only `subagent_interest`, `tabs_store`, `terminal_meta`, `handshake_settings`); (5) `crates/freshell-ws/src/activity.rs` — a single `mod tests` hunk where main has +84 test lines added after the merge.
- Supersession of the whole topic: attention bells were rebuilt again after this PR by the follow-on lineage visible in `git log -- crates/freshell-ws/src/activity.rs` (f81eaf06b e2e fixes, namg/cnwc katas, #677), all building on — not reverting — the #614 content.

## Recommendation

Delete. The branch was squash-landed verbatim as PR #614 and main has since evolved on top of it; every "differing" file differs because main moved forward. There is no unmerged residue. Bonus: its `scripts/build-stamp-check.sh` self-identification mechanism is what the current AGENTS.md startup-log instructions describe, so the worktree can also serve as a reference for what landed — but nothing needs landing.
