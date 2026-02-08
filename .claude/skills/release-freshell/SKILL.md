---
name: release-freshell
description: Use when preparing a Freshell release — before bumping versions, writing release notes, tagging, etc on GitHub.
---

# Releasing Freshell

## When to Use

Invoke this skill before changing version numbers or cutting a release. Never release without explicit user request.

## Sanity Check

Before anything: if something seems off (discontinuous version jump like 0.25→2.6, failing tests, broken code), stop and confirm with the user.

## Writing Release Notes

Release notes are **user-facing, not code-facing**. Write from the perspective of someone using Freshell, not someone reading the git log.

### Structure

Two sections, in this order:

**"New things you can do"** — Features that let users do something they couldn't before. Each item: what it is + why you'd care. Priority-ordered (most impactful first).

**"Things that got better"** — Improvements to existing functionality. Same format: what changed + why it matters. Priority-ordered.

### Principles

- **Feature, benefit.** Not "add sessions.patch WebSocket protocol" but "Faster session sidebar — updates arrive as small patches instead of re-sends."
- **User verbs, not code verbs.** Not "centralize terminal input send path through onData" but "Paste is more reliable — all paste methods go through one pipeline."
- **Skip internal-only changes.** Test refactors, doc updates, reverts-then-re-lands — users don't care.
- **Priority order within each section.** The things that are most exciting, the things that change daily usage most, then the rest.
- **Deep-dive the changelog in preparation.** Read every commit since the last tag. Skim the files affected so you can tell if there may be changes beyond the commit note, and if so, read the diffs and source code. Group by user-visible impact. Many commits collapse into one release note line. Some commits (chore, test, docs) produce no release note at all.
- **Read the code, not just the commit messages.** Commit messages are often terse or misleading. When a commit touches UI components, user-facing config, or behavior, read the actual diff or source to understand what changed from the user's perspective. A commit titled "refactor: move X to Y" might actually introduce a visible new capability.

### Deriving Release Notes

```bash
# 1. Get the full commit list
git log v<PREV>..HEAD --oneline --no-merges

# 2. Get the diffstat for scope
git diff v<PREV>..HEAD --stat | tail -5

# 3. For commits that touch user-facing code, read the diffs
git show <hash> --stat   # what files changed?
git show <hash>          # read the diff if unclear from commit message

# 4. Walk through commits and ask: "What can the user now DO differently?"
```

### Example

```markdown
## What's New

### New things you can do

- **Launch a coding agent directly** — Pick Claude Code or Codex from the pane picker,
  choose a directory with fuzzy search, and launch. No manual cd + typing commands.
- **Know when an agent is done** — Turn-complete bell and tab attention indicators
  notify you when a coding CLI finishes its turn.

### Things that got better

- **Faster session sidebar** — Updates arrive as incremental patches instead of
  full re-sends. Noticeably snappier with many sessions.
- **Paste is reliable** — All paste paths go through one pipeline. No more
  double-pastes or dropped pastes.
```

## Version Number

Freshell uses semver. Decide the bump with the user, but offer a recommendation:

- **Patch** (0.x.Y): Incremental improvements
- **Minor** (0.X.0): Dramatic, significant, and meaningful change
- **Major** (X.0.0): Massive, exciting release, worthy of entirely new consideration

## Update the README

**This is the last step before mechanical release, and requires user approval.**

Review `README.md`'s Features section against the current state of the product. Read the relevant source code to verify claims — don't trust the README or your memory alone.

For each feature listed:

- Is it still accurate? Read the implementing code if unsure. Update or remove if the feature changed or was removed.
- Is there a new capability from this release that's more interesting or important than what's listed? Propose adding it.
- Are any listed features low-priority enough to drop? Recommend removal to keep the list tight.

Present the proposed README changes to the user for approval before proceeding to release steps.

## Release Steps

All steps are sequential — each depends on the previous succeeding.

1. **Ensure tests pass:** `npm test` — all tests must pass, no skipping
2. **Bump version** in `package.json`
3. **Push main** to remote
4. **Tag:** `git tag -a vX.Y.Z -m "vX.Y.Z"` then `git push --tags`
5. **GitHub release:** `gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."` with the release notes
6. **Update README:** Change `--branch vOLD` to `--branch vNEW` in the clone command, and apply the approved Features changes
7. **Commit and push** the README change

## Safety

- Main can contain work-in-progress; users clone a specific release tag
- You are running inside Freshell — if you break main mid-release, you kill yourself
- Commit the version bump before tagging so the tag points to the right commit
- If any step fails, stop and assess, then make recommendations to the user, rather than pushing forward
