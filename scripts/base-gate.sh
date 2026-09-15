#!/usr/bin/env bash
# Run a broad gate (default: npm test; or any npm script, e.g.
# `scripts/base-gate.sh check`) from a clean scratch worktree at origin/main.
#
# Why: the cloud vitest/e2e runners reuse a test image only for an identical
# tree. A fresh worktree at origin/main is clean by construction, so its run
# uses the commit tag (<sha12>): built once per commit and shared by every
# later run of that commit on any machine, for as long as Artifact Registry
# keeps it. The main checkout accumulates untracked litter (plan docs, agent
# artifacts), which makes it dirty: its image is tagged by content
# (<sha12>-dirty-<hash>) and has to be rebuilt (~13 min cold) whenever that
# litter changes. See docs/development/cloud-test-images.md.
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
