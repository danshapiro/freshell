# Baseline Criteria — Worktree Triage 2026-08-23

repo: /home/dan/code/freshell · main: origin/main @ 3d739ca4a (2026-08-23)
scope: ALL 74 worktrees under `.worktrees/` (dates 2026-07-24 → 2026-08-23, i.e. ~4.5 weeks)
data: `triage-output/baseline-data.jsonl` (74 records, collected 2026-08-23)

## Merge-workflow reality (skill adaptation)

This repo uses BOTH merge-commit PRs ("Merge pull request #N …") and squash
merges ("subject (#N)"). Consequences for "is it merged":

1. `git merge-base --is-ancestor HEAD origin/main` → YES ⇒ merged (safe).
2. Squash-merged branches are NEVER ancestors. Detect by *footprint diff*:
   take the branch's merge-base with main, collect files the branch touched
   (`git diff --name-only $mb..HEAD`), then compare branch tip vs main on just
   those files (`git diff HEAD origin/main -- <files>`). ≤ a few differing
   files ⇒ contents likely landed via squash; differing files may be post-merge
   evolution or small unmerged residue. Only a human-judgment (deep dive or
   first pass reading the actual diff) can tell which.
3. `git cherry` patch-id equivalence does NOT work for squash merges (commits
   get combined) — do not rely on it.

## Baseline distribution (measured)

| bucket | count |
|---|---|
| ancestor of main (merged, incl. 3 detached HEADs) | 47 |
| not ancestor, footprint matches main except ≤3 files | 13 |
| not ancestor, clearly distinct work | 14 |
| dirty working tree (uncommitted files) | 10 |

## Triage categories

### Category A — Auto-skip / safe to delete after dirty-check
- ancestor=YES AND clean tree → merged, nothing to lose.
- ancestor=YES AND dirty → check `git diff`/untracked files for lost work
  (first-pass B check). Examples found: `0gdd-measurement` (5 modified rust
  files!), `rust-tauri-port` (untracked plan docs), `0gdd-observer`,
  `df1-gate-01-unchanged-suite-both`, `df1-restore-01-panel-inert`.
- detached HEAD + ancestor + clean → deletable: `df1-arb`, `df1-gate-final`,
  `pbh2-ro`.

### Category B — First-pass only (quick inspection, no full deep dive)
- Near-landed (footprint differs in ≤3 files): read the small diff and decide
  "in main already" vs "tiny unmerged residue worth noting". List:
  `0gdd-handoff`, `coding-agent-resource-containment`, `df1-retro`,
  `df1-session-09-live-watching`, `fix-rust-specs-0q8k`, `kata-sbnj`,
  `reconnect-revive`, `resilience-sprint`, `rest-codex-terminal-identity`,
  `session-directory-lazy-page-prep`, `session-directory-page-bound`,
  `session-directory-page-prep`, `ws-bootstrap-recovery-flake`.
- Branch-name patterns considered doc/meta here: `docs/*`, `investigation/*`,
  `build/electron-latest`, `release/*`, `df1/gate-*`, `df1/control-*`,
  `df1-retro` — these get first-pass but usually not deep dives.
- NOTE: `the-usual/*` branches are REAL work outputs (the-usual automation),
  not plan branches — do not skip on name.

### Category C — Deep-dive required
- clearly distinct work (14 worktrees):
  - `deploy-compatibility-rollback` (ahead 72/behind 896, 81 files)
  - `qa-campaign` (57/860, 69 files)
  - `parity-campaign` (45/860, 67 files)
  - `restart-resumable-pane` (38/1114, 113 files)
  - `attention-bell-wrong-signals` (28/859, 5 of 17 footprint files differ —
    partially landed?)
  - `freshagent-undo-redo` (17/13, 72 files, 1 dirty)
  - `resume-button` (16/1078, 28/32 differ)
  - `tab-bar-visual-overhaul` (15/1179, 23 files)
  - `restart-recovery-hardening` (13/1237, 73 files, **18 dirty files**)
  - `slash-command-catalogs` (13/99, 25 files)
  - `cloud-run-jobs` (10/732, 10/13 differ)
  - `df1-control` (6/735, 9 files)
  - `playwright-azure-cloud` (1/735, 4 files)
  - `release-v0.7.6-rc.1` (1/192, 4 files)
- Any worktree where first pass finds unexpected dirty content.

## Verdict vocabulary (for deep dives)

1. **ready-landing** — done, useful, never landed.
2. **finish-work** — significant useful progress, incomplete.
3. **throw-away-useless** — dead end / mistake / superseded.
4. **in-main** — functionality already on origin/main (possibly squash-merged).
5. **skipped-plan / skipped-trivial** — category A/B with nothing at stake.

## Rules for subagents

- READ-ONLY. Do not mutate worktrees, do not kill processes, do not restart
  servers, do not create PRs, do not delete anything.
- Tests: only focused `npm run test:vitest -- run <pattern>` from the correct
  worktree, and only when it materially affects the verdict. Never run broad
  suites (`npm test`, `npm run check`).
- Evidence over vibes: cite commit subjects, diff stats, and file paths.
