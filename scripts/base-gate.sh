#!/usr/bin/env bash
# Run a broad gate (default: npm test; or any npm script, e.g.
# `scripts/base-gate.sh check`) from a clean scratch worktree at origin/main.
#
# Why: the cloud vitest/e2e runners treat ANY dirty state in the checkout they
# run from — including untracked files — as non-addressable, forcing a
# "<sha>-dirty" image that ALWAYS rebuilds from a cold build (~13 min) and is
# never reusable. The main checkout accumulates untracked litter (plan docs,
# agent artifacts), so base gates run there pay that rebuild every time. A
# fresh worktree at origin/main is clean by construction, so the run uses the
# content-addressed commit tag: built at most once per commit and shared by
# every later run on any machine.
#
# The coordinator gate is repo-global (keyed off the common git dir), so gate
# queuing, holder publication, and result recording behave identically from
# the scratch worktree.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
git -C "$root" fetch --quiet origin main
wt="$root/.worktrees/.base-gate-$$"
trap 'git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true' EXIT
git -C "$root" worktree add --quiet --detach "$wt" origin/main
cd "$wt"
npm ci --no-audit --no-fund
npm run "${@:-test}"
