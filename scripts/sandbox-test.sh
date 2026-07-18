#!/usr/bin/env bash
# Run a command inside the disposable freshell-sandbox container.
#
# This is the ONE entry point operators and agents use for destructive/ops
# suites (process kills, config corruption, restart storms) so accidents
# physically cannot reach the host's live servers, real data, or unrelated
# processes. See docs/development/test-sandbox.md.
#
# Usage:
#   scripts/sandbox-test.sh "cargo test -p freshell-ws"
#   scripts/sandbox-test.sh --corpus "cargo test -p freshell-sessions -- --ignored perf"
#
# --corpus mounts ~/.codex/sessions and ~/.claude/projects READ-ONLY at their
# natural paths inside the container, for realistic-data perf tests. Without
# it, no real user data is mounted at all.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="freshell-sandbox:latest"

MOUNT_CORPUS=0
if [ "${1:-}" = "--corpus" ]; then
  MOUNT_CORPUS=1
  shift
fi

if [ "$#" -lt 1 ]; then
  echo "usage: $0 [--corpus] \"<command to run inside the sandbox>\"" >&2
  exit 2
fi
CMD="$1"

if ! docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  echo "[sandbox] image ${IMAGE_TAG} not found, building it first..." >&2
  "${REPO_ROOT}/scripts/sandbox-build.sh"
fi

# A dedicated, isolated bridge network — not Docker's implicit default
# "bridge" network. Functionally identical isolation (own network namespace,
# no host port exposure, never --network=host); a dedicated name just makes
# intent explicit and doesn't depend on the daemon's default-network state.
NETWORK_NAME="freshell-sandbox"
if ! docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
  docker network create --driver bridge "${NETWORK_NAME}" >/dev/null
fi

DOCKER_ARGS=(
  run --rm
  --network "${NETWORK_NAME}"
  --pids-limit 512
  --memory 8g
  -v "${REPO_ROOT}:/workspace"
  -v freshell-sandbox-cargo-registry:/usr/local/cargo/registry
  -v freshell-sandbox-cargo-git:/usr/local/cargo/git
  -v freshell-sandbox-cargo-target:/workspace/target
  -v freshell-sandbox-node-modules:/workspace/node_modules
  -v freshell-sandbox-playwright-cache:/home/sandbox/.cache/ms-playwright
)

if [ "${MOUNT_CORPUS}" -eq 1 ]; then
  if [ -d "${HOME}/.codex/sessions" ]; then
    DOCKER_ARGS+=(-v "${HOME}/.codex/sessions:/home/sandbox/.codex/sessions:ro")
  fi
  if [ -d "${HOME}/.claude/projects" ]; then
    DOCKER_ARGS+=(-v "${HOME}/.claude/projects:/home/sandbox/.claude/projects:ro")
  fi
fi

# Plain (non-login) shell: a login shell (-l) would source /etc/profile,
# which on Debian unconditionally overwrites PATH and would clobber the
# cargo/rustup PATH entry set via the image's Dockerfile ENV.
docker "${DOCKER_ARGS[@]}" "${IMAGE_TAG}" bash -c "${CMD}"
