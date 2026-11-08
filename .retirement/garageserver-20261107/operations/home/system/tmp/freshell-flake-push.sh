#!/usr/bin/env bash
set -euo pipefail
cd /home/dan/code/freshell/.worktrees/flaky-supervisor-permission

# Preserve the normal pre-push gate while routing its process tests through
# the repository's disposable sandbox. Formatting and clippy stay local.
cargo() {
  if [ "${1:-}" != test ]; then
    command cargo "$@"
    return
  fi
  local cargo_command sandbox_command
  printf -v cargo_command '%q ' cargo "$@"
  sandbox_command='set -euo pipefail
owned_tmp=$(mktemp -d /freshell-test-artifacts/flake-push-XXXXXXXX)
owned_runtime=$(mktemp -d /freshell-test-artifacts/XXX)
trap '\''rm -rf -- "$owned_tmp" "$owned_runtime"'\'' EXIT
export TMPDIR="$owned_runtime" FRESHELL_TEST_EXECUTABLE_TMP_DIR="$owned_tmp"
export CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=4 TOKIO_WORKER_THREADS=2
'
  scripts/sandbox-test.sh --runtime-suite "$sandbox_command$cargo_command"
}
export -f cargo
git push -u origin fix/flaky-supervisor-permission
