#!/usr/bin/env bash
# Darkforge full QA gate for freshell worktrees.
#
# Runs the repo's canonical gate (npm run check: typecheck + coordinated full
# vitest suite) plus the mandatory Rust CI gates from .github/workflows/
# rust-clippy.yml: cargo fmt check and clippy. freshell-tauri is excluded from
# clippy because its GTK/WebKit system dependencies are not installed on this
# host (CI installs them via apt); cargo fmt still covers it.
#
# Darkforge invokes this with cwd = the job's git worktree. Dependencies are
# installed once per worktree and refreshed when package-lock.json changes.
set -euo pipefail

export PATH="/home/dan/.nvm/versions/node/v22.21.1/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

if [ ! -f node_modules/.install-stamp ] || [ package-lock.json -nt node_modules/.install-stamp ]; then
  npm ci --no-audit --no-fund
  touch node_modules/.install-stamp
fi

npm run check

if [ -f Cargo.toml ]; then
  cargo fmt --all --check
  cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings
  cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
  cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings
fi
