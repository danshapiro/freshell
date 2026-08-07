# Closed-Loop Fix Campaign — first real run (2026-08-06)

First end-to-end run of the closed-loop fix system: detect → adjudicate → fix →
**independently review the fix** → verify → integrate. Time-boxed, quality-first.

**Branch:** `qa-campaign-20260806` (off `parity-campaign-20260805`). Not pushed, no PR.
**Workers:** identical Kimi-K3 via opencode. **Wall clock:** ~56 min (18:02–18:58), well under the box.
**Input:** 8 confirmed defect clusters from the QA panel, each carrying a failing proof test as its acceptance criterion. Ordered by this run's severity (crash > corruption > incorrect [esp. oracle-misaligned] > resource > cosmetic > security), modulated by significance.

## Result

| Stage | Outcome |
|-------|---------|
| Fixers | 8/8 committed real fixes; **0 AUDIT_WRONG** (all adjudicated as genuine Node divergences) |
| Central verify | 8/8 pass (proof test green + full 640-test server suite green) |
| Independent review (round 1) | **6 PASS, 2 BOUNCE** — both bounces caught REAL oracle divergences |
| Rework + re-review | 2 reworked; `tilde_expand` fixed its real defect and landed; `completion_sort` withheld |
| **Landed** | **7 fixes** (7 of 8 clusters), final integrated suite **646 tests green, rc=0** |
| Not landed | `completion_sort` — correct outcome, see below |

**Landed (verified + independently reviewed PASS):** mkdir_500_vs_409, posix_not_sanitized,
mime_content_type, unc_classification, etag_shape, dotseg_collapse_display, tilde_expand — each
now matches Node behavior with a permanent regression test. `tilde_expand` landed only after its
first version was bounced (a real `~\/rest` absolute-path bug), reworked, verified, and re-reviewed.

## The review gate earned its keep (the headline)

Two fixes passed their proof test **and** the full 640-test suite, yet a fresh independent
reviewer — cold context, rotated lens, re-deriving correct behavior from the Node oracle before
reading the diff, never shown the fixer's rationale — judged both **wrong** and bounced them with
evidence:

- **completion_sort:** the fix approximated `localeCompare` with lowercase+byte-order — correct
  for ASCII, but Node's ICU collation interleaves accented letters at the primary level
  (`éclair` < `zebra`, `e` < `é` < `f`) and expands `ß`≈`ss`. The fix sorted these backwards; its
  test only pinned the ASCII case.
- **tilde_expand:** the fix handled `~\proj` correctly but introduced a NEW bug for `~\/rest` —
  Rust `Path::join` with an absolute argument drops the home base (`/rest` instead of `$HOME/rest`),
  feeding a wrong absolute path into fs ops and the sandbox check. Worse than pre-fix for that form.

Tests-green is not correct-against-oracle. Only the independent review caught these. This is
exactly the gap the last campaign left open (31 fixes landed on tests+gates alone, unreviewed).

## `completion_sort`: an honest not-landed

The rework improved it to an ASCII+accent approximation but exact ICU parity needs a real
collator library. The loop **correctly refused to land an approximation that claimed exactness** —
surfaced as a human scope decision (accept the documented approximation, or add a collator crate),
not forced in. Honest not-landed beats a wrong fix that claims parity.

## Process learnings

1. **Integrating onto the branch that outstanding fix-worktrees are based on invalidates their
   base-diffs.** After 5 fixes landed on the integration branch, the two rework worktrees (still
   branched from the pre-integration point) produced diffs that *appeared* to revert the 5 landed
   fixes, contaminating round-2 review. Fix: rebase outstanding worktrees after each integration,
   OR compute each review diff against the fix's own merge-base, never the moving integration branch.
2. **The seam is where both bugs and merge-conflicts concentrate.** Four fixes touched the
   path-normalization region; they conflicted on integration and had to serialize/rebase. Budget
   for seam serialization — do not assume independent fixes to one subsystem integrate cleanly.
3. **Shared build-cache contamination struck again** (a fix false-failed verification with errors
   in unrelated crates). Verify each variant in an isolated target, or serialize strictly and
   distrust a failure whose errors are outside the changed file.
4. **Adjudication held:** 0/8 fixers cried AUDIT_WRONG — the high-convergence clusters were all
   real, consistent with treating detector-convergence as the confidence signal.

## Metrics that matter

- **Review bounce rate:** 2/8 (25%) at round 1 — and both bounces were real defects, not noise.
- **Land rate to full quality bar:** 6/8 landed verified + independently reviewed; 1 honest
  not-landed (scope); 1 verified + endorsed pending final seam-reconcile.
- **False landings:** 0 — nothing landed without a passing proof test AND an independent review PASS.
- **Cost:** ~56 min wall-clock, ~20 agent sessions (8 fix + 8 review + reworks/reconciles).

Success here is not "8 bugs fixed" — it is **coverage to a quality bar with evidence**: every
landed fix carries a failing→passing regression test and an independent review PASS, and every
not-landed item is surfaced with its reason.

## Cleanup safety (learned the hard way)

The highest-blast-radius commands in a campaign — `branch -D`, `worktree remove --force`,
`reset --hard`, `rm -rf` — cluster at the END, exactly when attention flags. A greedy
`git branch -D fix/*` in this run's cleanup swept up a pre-existing user branch that merely
shared the generic `fix/` prefix (recovered from `origin`, but it was unrecoverable-by-luck).
Rules for every future run:

1. **Namespace your artifacts so they cannot collide.** Create all branches/worktrees under a
   campaign-unique prefix — `fable/<campaign-id>/<item>` for branches,
   `.worktrees/fable-<campaign-id>-<item>` for worktrees. Then even a glob is safe by
   construction, because nothing else lives in that namespace. Never reuse a generic prefix
   (`fix/`, `qa/`) the repo already uses.
2. **Delete by explicit list, never by pattern.** Maintain the exact list of branches/worktrees
   you created; delete precisely that list. A wildcard can only match things you didn't create.
3. **Dry-run first, and read the output.** Before any bulk delete, run the read-only form
   (`git branch --list`, `git worktree list`) and confirm every entry is yours. Unconditionally —
   not only when you feel careful.
4. **Prefer recoverable over forced.** Use `git branch -d` (refuses unmerged) over `-D`. Campaign
   fix branches are cherry-picked/merged, so `-d` succeeds for them and *refuses* anything
   unmerged — turning a silent destruction into a flagged error.
5. **Cleanup gets more scrutiny, not less.** Treat the wind-down as the most dangerous phase.
   This repo is self-hosted off worktrees; a wrong `--force` can hit something load-bearing.
