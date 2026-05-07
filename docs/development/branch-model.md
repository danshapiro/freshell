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

## Building `dev`

Use an explicit queue. Do not blindly apply every open PR.

Example:

```bash
npm run dev:queue -- plan --prs 323,321,309,319,324,326,325,322
```

The queue script must fail if a PR is draft, closed, not targeting `main`, or cannot be applied cleanly. Fix PR branches before rebuilding `dev`.

To rebuild local `dev`:

```bash
git switch dev
npm run dev:queue -- assemble --prs 323,321,309,319,324,326,325,322
```

Use replacement PR numbers instead of external or superseded PRs. If the script stops on a conflict, do not resolve the conflict on `dev`. Abort the merge, fix the PR branch, and rerun the queue.

Initial migration queue:

| PR | Head SHA | Purpose |
| --- | --- | --- |
| #323 | Current PR head | `dev` branch workflow, launch guardrails, and queue tooling |
| #321 | `7eae9acf13d2ecf36de6ecade8354cb22b944f7b` | Sidebar reopen corner behavior |
| #309 | `93c0e15f8b3e04d7e1bbd8ab312619ae28cfefa2` | Codex startup cwd fix |
| #319 | `48927eef6b46a2232ebe31d1e1dea38d2203eb72` | OpenCode native scroll behavior |
| #324 | `fc8a953565c8c4e416fc7bc0e951b0888c8ed421` | Durable session restore identity parity |
| #326 | Current PR head | Codex sidecar resilience parity |
| #325 | Current PR head | Intentional removal of broken Codex notification launch args |
| #322 | `26601cec20434790936af3a3f9cc823c8c19f984` | Replacement for externally-owned factory terminal orchestration PR |

Initial migration exclusions:

| PR | Head SHA | Reason |
| --- | --- | --- |
| #297 | `8cad328c158a6b33d9779ce1748bfe725ecd0d1c` | Externally-owned and superseded by #322 |
| #289 | `4e4782699adadc3e006b96143f6ead6bda8b136d` | Draft approval artifact |

## Local Main Realignment

Only realign local `main` after Freshell is self-hosting from `dev`, the user has explicitly approved the reset, and the intentional OpenCode notification-argument removal has been preserved in an open PR that is included in `dev` or confirmed already present in a selected pending PR.

The intended final state is:

```bash
git switch main
git fetch origin
git reset --hard origin/main
```

Do not run that command during ordinary development. It belongs only to the migration task that realigns local `main` after self-hosting has moved to `dev`.
