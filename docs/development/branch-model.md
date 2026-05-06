# Branch Model

Freshell development uses two local integration concepts:

- `main`: exact mirror of `origin/main`
- `dev`: self-hosted local integration branch

## Branch Responsibilities

`main` is disposable. It should always be resettable to `origin/main` with no local work lost.

`dev` is where the local Freshell instance runs. It is assembled from `origin/main` plus pending PR heads. It is not where new behavior is authored.

## Pending PR Definition

A PR is pending for `dev` only when all of these are true:

- It is open.
- It targets `main`.
- It is not draft.
- It is not marked do-not-merge, superseded, or approval-artifact-only.
- The user wants it in the self-hosted integration queue.
- Its branch applies cleanly to `origin/main`, or its branch has been updated so it does.

If a PR cannot be amended because it comes from an external fork, create a replacement PR before adding that behavior to `dev`.

## Change Flow

1. Start work from `origin/main` in a worktree.
2. Implement the change.
3. Push a PR against `origin/main`.
4. Add that PR head to local `dev`.
5. Wait for independent review before merging the PR to `origin/main`.

Never put behavior changes only on `dev`.

## Conflict Policy

If a PR conflicts with `origin/main`, fix the PR branch.

If two pending PRs conflict with each other, fix one or both PR branches.

Do not resolve semantic conflicts only on `dev`. `dev` must remain reproducible from `origin/main` plus PR heads.

## Excluded PRs

Draft PRs, do-not-merge PRs, closed PRs, superseded PRs, and approval artifacts are excluded from `dev` unless the user explicitly says otherwise.

## Local Main Realignment

Only realign local `main` after Freshell is self-hosting from `dev`, the user has explicitly approved the reset, and the intentional OpenCode notification-argument removal has been preserved in an open PR that is included in `dev` or confirmed already present in a selected pending PR.

The intended final state is:

```bash
git switch main
git fetch origin
git reset --hard origin/main
```

Do not run that command during ordinary development. It belongs only to the migration task that realigns local `main` after self-hosting has moved to `dev`.
