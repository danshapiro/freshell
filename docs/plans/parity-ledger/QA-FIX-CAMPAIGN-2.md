# Closed-Loop Fix Campaign — run 2 (1-hour box, 2026-08-06)

A time-boxed second run on a fresh 6-cluster batch (5 low-confidence single-detector
"incorrect" candidates + 1 high-convergence security candidate), under collision-proof
`fable/qa2-20260806/*` naming.

## Outcome: negative result — fix wave timed out with zero commits

All 6 fixers ran the full 40-minute timeout and were killed **before committing**; only one
worktree (empty-root-sandbox) had surviving uncommitted work, salvaged to its branch as WIP
(unverified, unreviewed, **not landed**). Nothing reached the quality bar this run. **0 fixes
landed.**

## Root cause (a reintroduced failure mode)

This is the **exact failure from the very first campaign's audit wave**: agents did careful work
but wrote no intermediate output, so the timeout forfeited everything. Two compounding causes:

1. **No WIP-commit discipline.** The fixer prompt said "commit when done" with no instruction to
   commit intermediate progress. Careful adjudication of *low-confidence single-detector* candidates
   (reading the Node oracle, checking for tests that pin current behavior) ate the whole budget, and
   the kill erased it. Fix: instruct fixers to commit early and often (WIP commits), and to commit an
   adjudication note the moment they reach a verdict — before attempting the fix.
2. **Timeout too short for the task shape.** 40 min fit the *first* run's higher-confidence clusters,
   but single-detector candidates require more adjudication (is this even a real bug?) before any
   fix. The timeout must scale with confidence: low-confidence items need longer, or a two-phase
   split (adjudicate-and-commit-verdict, then fix).

## What this run still validated

- **Collision-proof naming worked.** All artifacts lived under `fable/qa2-20260806/*`; cleanup was
  a delete-by-explicit-manifest with no risk to shared namespaces (the fix for last run's error).
- **The negative result is itself the finding.** A quality-first loop that lands nothing is the
  correct outcome when the work didn't reach the bar — no unverified, unreviewed code was integrated.

## Carry-forward for the next run

- Fixer prompt: "commit WIP early; commit your adjudication verdict (real divergence vs AUDIT_WRONG)
  before fixing; a partial committed fix beats a perfect uncommitted one."
- Size timeouts by confidence, or split adjudication from fixing so a slow adjudication can't erase
  a would-be fix.
- Low-confidence single-detector candidates are expensive to adjudicate; consider a cheap
  pre-adjudication pass to drop the AUDIT_WRONG ones before spending a full fixer on them.
