---
name: reviewing-prs
description: Use when reviewing, triaging, or landing pull requests — especially batches of open PRs that need inspection, fixes, and merging. Also triages open issues after the PR queue is clear.
---

# Reviewing PRs

## Overview

Systematic PR review workflow: assess, recommend, gate on user approval, fix issues, merge, and leave a signed comment. After the PR queue is clear, triage open issues. Uses a worktree for isolation, fresheyes for independent review, and processes PRs oldest-to-newest to minimize conflicts.

## Contributor Philosophy

We never push work back onto contributors. Our goal is to harvest **good ideas first, and code second**. A PR with a great idea but rough implementation is more valuable than no PR at all — we take the idea, implement it properly ourselves, and give the contributor credit (in commit messages, PR comments, and closing notes). A PR with good code that we can merge directly is a bonus.

## Setup

1. Create a detached worktree for all PR work:
   ```bash
   git worktree add .worktrees/pr-review --detach HEAD
   ```
2. List open PRs with `gh pr list`
3. Process oldest-to-newest (reduces cascading merge conflicts)

## Per-PR Workflow

### 1. Check Out

```bash
cd .worktrees/pr-review
git fetch origin && git checkout --detach origin/main
gh pr checkout <N>
```

Always reset the worktree to latest main before each PR.

### 2. Review the Diff

```bash
git diff origin/main...HEAD
```

Read and understand every change before proceeding.

### 3. Assess & Recommend (Gate)

Start every PR review with this header (use `gh pr view <N>` to get details):

```
## PR #<N> — <title>
Submitted by <author>, <relative time>
<PR URL>
```

Then present to the user:
- **Summary**: What the PR does in plain language
- **Changes table**: Files changed, what each contributes
- **Pros**: What's good about the design, test coverage, backwards compatibility
- **Cons**: Risks, gaps, concerns
- **Recommendation**: Merge as-is, merge with fixes, or reject

**Do not proceed until the user explicitly approves.** This is the most important step. The user decides whether to take the PR, not the reviewer.

**What counts as approval:** The user says words like "yes", "approve", "merge it", "go ahead", "LGTM", or "proceed" **in direct response to the assessment**. Nothing else counts.

**What does NOT count:** Ambiguous signals, instructions about other topics, general enthusiasm, or approval of a different action (e.g., "do it now" about a skill edit is not PR approval). **When in doubt, ask.**

### 4. Build + Fresheyes (Parallel)

Run build and fresheyes simultaneously:
- `go build ./...` (or the project's equivalent)
- Run targeted tests for the PR's changes
- Run fresheyes: `Review the changes between main and this branch using git diff origin/main...HEAD.`

### 5. Present Results (Gate)

Present build, test, and fresheyes results to the user. Include:
- Build status (pass/fail)
- Test results (pass/fail, which tests)
- Fresheyes verdict and findings summary

**Do not merge or fix until the user approves.** The user may want to reject, request changes, discuss findings, or fix things themselves. This is the second hard gate.

### 6. Fix Issues

Address all fresheyes findings and test failures before merging:
- Commit fixes on the PR branch with detailed messages
- **Show the diff and get approval before pushing** to the PR branch or main
- Re-build and re-test after fixes

### 7. Merge (only after user approves)

**Prefer GitHub merge:**
```bash
gh pr merge <N> --merge
```

**If GitHub's merge state is stale** (common after rebase/force-push):
```bash
# In the main repo (not the worktree)
git fetch origin && git merge --ff-only origin/main
git merge --no-ff <branch> -m "Merge pull request #N from ..."
git push origin main
```

**If conflicts exist:** rebase the PR branch on main, resolve, rebuild, retest, force-push, then merge.

### 8. Comment and Close

Leave an effusive comment summarizing:
- What was good about the PR
- What fixes were applied (if any)
- Always sign off as `— Codex CLI`

```bash
gh pr comment <N> --body "..."
```

Then ensure the PR is closed. Local merges (the fallback path) don't trigger GitHub's auto-close:

```bash
# Check if still open; close if needed
gh pr view <N> --json state -q '.state' | grep -q OPEN && gh pr close <N>
```

### 9. Teardown (after queue is clear)

Once all PRs are landed and there is no unfinished work, clean up:

```bash
# Switch back to main in the primary repo
cd <primary-repo>
git checkout main && git pull --ff-only origin main

# Remove the pr-review worktree
git worktree remove .worktrees/pr-review
```

Only do this when the PR queue is empty and all merges succeeded. If there is any unfinished work, leave the worktree in place.

### 10. Issue Triage (after PRs are done)

Once all PRs are processed (or if there were none), check for open issues:

```bash
gh issue list --state open
```

**If there are no open issues**, report that the issue queue is clear and proceed to teardown.

**If there are open issues**, process them oldest-to-newest, one at a time, using the same assess-then-gate pattern as PRs.

#### Per-Issue Workflow

##### a. Read the Issue

```bash
gh issue view <N>
```

Read the full issue body, comments, and labels. Understand the problem or request before assessing.

##### b. Assess & Recommend (Gate)

Start every issue review with this header:

```
## Issue #<N> — <title>
Opened by <author>, <relative time>
<Issue URL>
Labels: <labels or "none">
```

Then present to the user:
- **Summary**: What the issue describes in plain language
- **Current status**: Is this already fixed (e.g., by a just-merged PR)? Partially addressed? Still open?
- **Scope**: Small fix, medium feature, large effort
- **Codebase context**: Which files/packages are likely involved (check the code if needed)
- **Recommendation**: One of:
  - **Fix now** — small, clear scope, can address in this session
  - **Needs PR** — requires a branch and proper review cycle
  - **Needs discussion** — ambiguous, under-specified, or contentious
  - **Close** — already fixed, duplicate, or obsolete (state why)

**Do not take action until the user explicitly approves.** The same approval rules apply as for PRs — only explicit words like "yes", "fix it", "close it", "skip", or "next" count. Ambiguity means ask.

The user may respond with:
- **Fix it** → create a branch, implement the fix, build, test, submit a PR or commit, then come back for the next issue
- **Close it** → close with a comment explaining why, signed `— Codex CLI`
- **Skip** / **Next** → move to the next issue without action
- **Stop** → end issue triage entirely

##### c. Fix (if approved)

- Create a branch: `git checkout -b fix/issue-<N> origin/main`
- Implement the fix in the worktree
- Build and run targeted tests
- **Show the diff and get approval before pushing**
- Push and open a PR, or commit directly if the user approves
- Close the issue with a comment linking to the fix, signed `— Codex CLI`

##### d. Close (if approved)

```bash
gh issue close <N> --comment "..."
```

Always sign the comment `— Codex CLI`.

## Quick Reference

| Step | Command / Action | Blocks on |
|------|-----------------|-----------|
| Checkout | `gh pr checkout <N>` | — |
| Diff | `git diff origin/main...HEAD` | — |
| Assess | Summary, pros/cons, recommendation | **User approval (Gate 1)** |
| Build | `go build ./...` | — |
| Fresheyes | fresheyes skill | — |
| Tests | `go test ./...` (targeted) | — |
| Present results | Build/test/fresheyes summary | **User approval (Gate 2)** |
| Fix | Commit + show diff + get approval before push | Build + tests green |
| Merge | `gh pr merge` or local merge | All fixes landed + user says merge |
| Comment + Close | `gh pr comment` + `gh pr close` if still open | Merge complete |
| Reset | `git checkout --detach origin/main` | Before next PR |
| Teardown | `git worktree remove .worktrees/pr-review` | Queue empty, all landed |
| Issue list | `gh issue list --state open` | PRs done (or none) |
| Issue read | `gh issue view <N>` | — |
| Issue assess | Summary, status, scope, recommendation | **User approval** |
| Issue fix | Branch, implement, build, test, show diff | User says "fix it" |
| Issue close | `gh issue close <N> --comment` | User says "close it" |

## Red Flags — STOP and Re-read the Gates

If you catch yourself thinking any of these, you are about to violate a gate:

| Thought | Reality |
|---------|---------|
| "The user said 'do it' so that's approval" | Was it a direct response to your assessment? If not, it's not approval. Ask. |
| "Everything passed, obviously I should merge" | Green build ≠ merge approval. Present results and wait for Gate 2. |
| "The user said to fix things, so I'll push too" | "Fix" ≠ "push to main." Show the diff, ask before pushing. |
| "I'll just merge quickly and move on" | Speed is not a goal. Consent is. |
| "The user seems impatient, I should go faster" | Impatience is not approval. Ambiguity means ask. |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Proceeding without user approval | There are TWO hard gates. Always wait at both. |
| Treating ambiguous signals as approval | Only explicit approval words count. When in doubt, ask. |
| Merging after build+fresheyes without asking | Gate 2 requires presenting results and waiting for go/no-go. |
| Pushing fixes to main without showing diff | Show the diff first. Get approval before any push. |
| Merging with fresheyes FAILED | Fix all findings first. Never merge a failed review. |
| Forgetting to update worktree between PRs | Stale base causes unnecessary conflicts. Always reset to origin/main. |
| Forgetting to close after local merge | Local merges don't trigger GitHub auto-close. Always check and `gh pr close` if still open. |
| Signing comment as "Codex" or "Claude" | Always sign as `— Codex CLI`. |
| Processing newest-first | Oldest-first minimizes cascading conflicts since earlier PRs often touch files later ones depend on. |
