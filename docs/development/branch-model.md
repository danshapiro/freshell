# Branch Model

Freshell uses `main` as the only integration branch. The old local `dev` integration branch and PR queue are retired.

## Branch Responsibilities

`origin/main` is the source of truth for integrated work.

Local `main` should be a clean, fast-forwarded copy of `origin/main`. It may be used to run the self-hosted Freshell server, but it must not contain local-only behavior changes.

Feature branches are authored in dedicated worktrees under `.worktrees/<slug>`.

## Change Flow

1. Confirm the repo-supported test suite is green on the intended base before creating a new worktree.
2. Create a worktree branch from `origin/main`.
3. Implement and verify the change in that worktree.
4. Push the branch and open a PR targeting `main`.
5. Merge the PR after required checks pass, unless the user has said the PR needs someone else's approval.
6. Bring remote `main` down to local `main`.
7. Remove the finished worktree and local feature branch when they are no longer needed.

Example local-main update:

```bash
git fetch origin
git switch main
git pull --ff-only origin main
```

If local `main` is checked out in a separate worktree, run the `git switch main` and `git pull --ff-only origin main` steps from that worktree. If local `main` cannot fast-forward, stop and resolve that explicitly instead of creating a local merge commit.

## Conflict Policy

If a PR conflicts with `origin/main`, fix the PR branch and rerun verification there.

Do not hide semantic conflict resolution in local-only commits on `main`.

## Retired `dev` Queue

Do not rebuild or self-host from a local `dev` integration branch. Do not apply pending PR heads to a local queue. Ready changes go through PRs, merge to `origin/main`, and then arrive locally by updating local `main`.

Obsolete `.worktrees/dev` checkouts and local `dev` branches should be deleted after confirming no running Freshell server depends on them.
