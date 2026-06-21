---
name: triage-old-worktrees
description: "Use when auditing stale worktrees in Freshell to determine which contain novel unmerged work, which should be landed, which need finishing, and which can be safely deleted."
---

# Triage Old Worktrees

## When to Use

Use this skill when the repo has accumulated worktrees in `.worktrees/` whose branches may or may not have been merged into `main`. This skill provides a systematic, agent-driven process to classify each worktree and produce a clear action plan.

## Prerequisites

- `origin/main` is the integration branch (Freshell policy)
- Merge-commit PR workflow — branch tips become ancestors of `origin/main` when merged
- Worktree branches start from `origin/main` and target PRs to `main`

## Process Overview

```
01-baseline     → Establish safe-to-ignore criteria & filter worktrees
02-first-pass   → One subagent scans all candidate worktrees for novel work
03-second-pass  → Parallel deep-dive subagents for meaningful worktrees
04-aggregate    → Produce final report (md + csv + html) with verdicts
```

Each step produces files in the analysis worktree. The final output drives deletion decisions and work-to-land prioritization.

---

## Step 1: Establish Baseline Criteria

Deploy a subagent to review the codebase and worktree inventory (`.worktrees/branch-inventory.json` if it exists) and establish criteria for "safe to ignore."

### Criteria Categories

**Category A — Auto-Skip / Safe to Delete (no deep dive needed):**
- HEAD is ancestor of `origin/main` AND working tree is clean AND branch has 0 ahead commits
- Plan-only or doc-only branches (`plan/*`, `docs/*`, `proof-*`)
- Trivial changes (< 5 lines, config-only, test-reorder-only)
- Branches already recorded as superseded in `branch-inventory.json`

**Category B — First-Pass Only (quick inspection):**
- ANCESTOR=YES + dirty working tree (check `git diff` for lost work)
- ANCESTOR=NO + stale trivial branch (1-5 ahead, 100+ behind `origin/main`)
- ANCESTOR=NO + trivial naming pattern (`plan/*`, `docs/*`, `proof-*`, `port/*`, `debug/*`, `test/*`, `chore/*`) AND ahead <= 20

**Category C — Deep-Dive Required:**
- ANCESTOR=NO + ahead > 5
- ANCESTOR=NO + behind == 0 (truly novel, no mainline catch-up)
- Any `feat/*`, `fix/*`, `codex/*`, `freshagent-*`, `freshcodex-*`, `freshopencode-*`, `opencode-*`, `rollback/*` branches
- Dirty working tree on any meaningful branch

### Baseline Data to Gather

For each worktree in scope:
```
git -C .worktrees/<name> rev-parse HEAD
git merge-base --is-ancestor <HEAD> origin/main           # YES/NO
git -C .worktrees/<name> symbolic-ref --short HEAD        # branch name
git -C .worktrees/<name> log -1 --format=%ci              # last commit date
git rev-list --count origin/main..<branch>                 # ahead count
git rev-list --count <branch>..origin/main                 # behind count
git -C .worktrees/<name> status --porcelain               # working tree check
```

Filter to the desired time window (e.g., `past 4 weeks` = `date > "2026-05-23"`).

Write baseline criteria to `.worktrees/<analysis-wt>/baseline-criteria.md`.

---

## Step 2: First Pass — Novel Work Detection

Deploy **one fresh (no-context) subagent** to run the process over all worktrees in scope. For each worktree, it determines whether the worktree contains novel work not landed on `origin/main`.

### Checks Per Worktree

```bash
git -C .worktrees/<name> merge-base --is-ancestor HEAD origin/main
git -C .worktrees/<name> status --porcelain
git -C .worktrees/<name> log --oneline origin/main..HEAD        # unmerged commits
git -C .worktrees/<name> diff --stat origin/main...HEAD          # change scope
```

### Output

- `first-pass-table.md` — one-line-per-worktree table with columns: worktree, branch, date, ancestor?, status, commits, files Δ, meaningful?, summary
- `worktrees-to-deep-dive.txt` — list of worktrees needing second pass
- Skip plan-only worktrees and trivial (< 5 line) changes from deep dive

---

## Step 3: Second Pass — Deep Evaluation

Deploy **multiple fresh subagents in parallel**, grouped by topic area (3-4 worktrees per subagent). Each subagent dives deep on its assigned worktrees and produces a verdict.

### Verdict Categories

1. **Ready for landing** — work is done, never landed, seems useful. After thorough static analysis, code review, and optional test runs, the work is complete and worthwhile.

2. **Finish work** — significant progress towards something useful, but still has bugs, open questions, or integration gaps.

3. **Throw away — useless** — superseded by different work, the user/session history made clear this was a mistake or dead end.

4. **Throw away — in main already** — the same functionality already landed on `origin/main`, possibly via a different implementation.

### Deep-Dive Checks

For each worktree, the subagent should:

1. **Git analysis:** `log origin/main..HEAD`, `diff origin/main...HEAD`, `diff origin/main...HEAD --stat`
2. **Check if on main already:** `git merge-base --is-ancestor`, grep for key identifiers in `origin/main`, compare blob hashes
3. **Check for superseding work:** search `origin/main` for related keywords and implementer commits
4. **Run relevant tests:** `npm run test:vitest -- run <test-pattern>` to verify the work still works
5. **Check if the bug still exists:** read current code on main to see if the bug scenario is still present
6. **Look for context:** check `~/.claude/projects/freshell/sessions/`, `~/.codex/`, `~/.config/opencode/` for session history
7. **If in doubt:** deploy a fresh subagent to render the verdict. Never defer to the user.

### Topic Grouping

Group worktrees by topic to minimize context switching within a subagent:
- OpenCode/freshopencode/freshcodex
- Fresh agent UI
- Terminal/catchup/replay
- Settings/electron/codex
- Tab status / reliability

Each deep-dive report goes to `.worktrees/<analysis-wt>/deep-dive/<NN>-<topic>.md`.

---

## Step 4: Aggregate Final Report

Deploy one subagent to read all deep-dive reports, baseline criteria, and first-pass table, then produce three files:

### `final-report.md`
- Executive summary with verdict counts
- Section per verdict category (Ready for Landing, Finish Work, In Main Already, Skipped)
- Each worktree listed with: name, branch, date, verdict, evidence summary, recommendation narrative
- Full reference table sorted by recency

### `final-report.csv`
- Columns: `num,worktree,branch,date,verdict,category,analysis`
- One row per audited worktree
- Categories: `ready-landing`, `finish-work`, `in-main`, `skipped-plan`, `skipped-trivial`

### `final-report.html`
- Standalone, self-contained HTML (no external dependencies)
- Color-coded cards per verdict: green=ready-landing, yellow=finish-work, gray=in-main, light-gray=skipped
- Summary cards with counts
- Sortable/filterable table
- Links to deep-dive report files (relative paths)

---

## Expected Outcomes

After completing all steps, the analysis worktree contains:

```
.worktrees/<analysis-wt>/
├── baseline-criteria.md
├── first-pass-table.md
├── worktrees-to-deep-dive.txt
├── deep-dive/
│   ├── 01-<topic>.md
│   ├── 02-<topic>.md
│   └── ...
├── final-report.md
├── final-report.csv
└── final-report.html
```

The final report tells you:
- Which worktrees to delete (already merged / skipped)
- Which worktrees to land (ready for landing)
- Which worktrees need finishing (what's incomplete, what's blocking)
- Which are the highest priority (the "0 behind main" worktrees with novel commits)

## After the Audit

1. Delete worktrees in "already in main" and "skipped" categories
2. Create PRs for "ready for landing" branches
3. For "finish work" branches, file katas describing the problem, referencing the worktree and assessment
