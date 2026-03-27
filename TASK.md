# Stability Fixes — Serial Implementation

## Your Mission

You are implementing a series of stability fixes for Freshell, working through them serially on this branch. Each fix builds on the previous ones. Commit frequently. The goal is solid, tested, verified work — not speed.

## Context Files (Read These First)

1. `docs/plans/2026-03-27-stability-fixes.md` — **The implementation plan.** 9 issues in order, with what/why/where/how-to-verify for each.
2. `docs/lab-notes/2026-03-27-complete-characterization.md` — Complete system characterization. The "why" behind every issue.
3. `docs/lab-notes/2026-03-27-spike-1-4-synthesis.md` — Reconnect timing data and server audit findings.
4. `docs/lab-notes/2026-03-27-spike-2-action-storms.md` — Session-directory polling data.
5. `docs/lab-notes/2026-03-27-spike-3-terminal-rendering.md` — "Recovering" banner root cause with exact code path.
6. `docs/lab-notes/2026-03-27-spike-5-data-flow-tracing.md` — Pane corruption mechanism, cross-tab sync races, persistence analysis.
7. `docs/lab-notes/2026-03-27-spike-6-consistency-audit.md` — Consistency model audit, three-tier analysis, permanent divergence scenarios.

## Work Process

For each issue in the plan:
1. Read the issue description and any referenced spike lab notes
2. Write a failing test that validates the fix
3. Implement the minimal fix to pass the test
4. Refactor if needed
5. Build production (`npm run build`) and run on PORT=3400 (`PORT=3400 npm start`)
6. Verify in a real browser that the behavior is fixed (use Chrome automation tools)
7. Run the test suite to catch regressions
8. Commit with a clear message

## PR Breakpoints

Stop and report after completing each group:
- **After Issues 1-3** (quick wins) — run full test suite, verify all three fixes in Chrome
- **After Issues 4-7** (architectural core) — run full test suite, verify reconnect behavior in Chrome
- **After Issues 8-9** (recovery polish) — final verification

## Important Notes

- Work in THIS worktree (`stability-fixes`), on this branch.
- Use `PORT=3400` for any server you start.
- TDD: write the test first, see it fail, then implement.
- If something surprising comes up, write it in a lab note before continuing.
- The plan gives you context and constraints but leaves implementation decisions to you. Use your judgment.
- Commit after each issue, not in one big batch.
- Start with Issue 1 (/api/version cache) — it's the simplest and will warm you up.
