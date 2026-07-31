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
#   scripts/sandbox-test.sh --fresh-playwright-cache "npx playwright test ..."
#
# --corpus mounts ~/.codex/sessions and ~/.claude/projects READ-ONLY at their
# natural paths inside the container, for realistic-data perf tests. Without
# it, no real user data is mounted at all.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="freshell-sandbox:latest"
PLAYWRIGHT_VERSION="$(
  node -e '
    const lock = require(process.argv[1])
    const version = lock.packages?.["node_modules/playwright"]?.version
    if (!version) throw new Error("package-lock.json does not resolve playwright")
    process.stdout.write(version)
  ' "${REPO_ROOT}/package-lock.json"
)"
DEFINITION_SHA256="$(
  {
    sha256sum \
      "${REPO_ROOT}/docker/sandbox/Dockerfile" \
      "${REPO_ROOT}/docker/sandbox/entrypoint.sh" \
      "${REPO_ROOT}/docker/sandbox/ensure-playwright-cache.sh"
    printf 'playwright=%s\n' "${PLAYWRIGHT_VERSION}"
  } \
  | awk '{print $1}' \
  | sha256sum \
  | awk '{print $1}'
)"

MOUNT_CORPUS=0
FRESH_PLAYWRIGHT_CACHE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
  --corpus)
    MOUNT_CORPUS=1
    shift
    ;;
  --fresh-playwright-cache)
    FRESH_PLAYWRIGHT_CACHE=1
    shift
    ;;
  *)
    break
    ;;
  esac
done

if [ "$#" -lt 1 ]; then
  echo "usage: $0 [--corpus] [--fresh-playwright-cache] \"<command to run inside the sandbox>\"" >&2
  exit 2
fi
CMD="$1"

IMAGE_DEFINITION_SHA256="$(
  docker image inspect \
    --format '{{ index .Config.Labels "com.freshell.sandbox-definition-sha256" }}' \
    "${IMAGE_TAG}" 2>/dev/null \
  || true
)"
if [ "${IMAGE_DEFINITION_SHA256}" != "${DEFINITION_SHA256}" ]; then
  echo "[sandbox] image ${IMAGE_TAG} is missing or stale; rebuilding for definition ${DEFINITION_SHA256}..." >&2
  "${REPO_ROOT}/scripts/sandbox-build.sh"
fi

# A dedicated, isolated bridge network — not Docker's implicit default
# "bridge" network. Functionally identical isolation (own network namespace,
# no host port exposure, never --network=host); a dedicated name just makes
# intent explicit and doesn't depend on the daemon's default-network state.
NETWORK_NAME="freshell-sandbox"
if ! docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
  NETWORK_CREATE_STATUS=0
  NETWORK_CREATE_OUTPUT="$(
    docker network create --driver bridge "${NETWORK_NAME}" 2>&1
  )" || NETWORK_CREATE_STATUS=$?
  if [ "${NETWORK_CREATE_STATUS}" -ne 0 ]; then
    # A concurrent wrapper may have created the network after our inspect.
    # Accept that race only when Docker confirms the desired end state;
    # otherwise preserve the original create failure and diagnostics.
    if ! docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
      if [ -n "${NETWORK_CREATE_OUTPUT}" ]; then
        echo "${NETWORK_CREATE_OUTPUT}" >&2
      fi
      exit "${NETWORK_CREATE_STATUS}"
    fi
  fi
fi

DOCKER_ARGS=(
  run --rm
  --network "${NETWORK_NAME}"
  --env FRESHELL_DESTRUCTIVE_TEST_SANDBOX=1
  --pids-limit 512
  --memory 8g
  -v "${REPO_ROOT}:/workspace"
  -v freshell-sandbox-cargo-registry:/usr/local/cargo/registry
  -v freshell-sandbox-cargo-git:/usr/local/cargo/git
  -v freshell-sandbox-cargo-target:/workspace/target
  -v freshell-sandbox-node-modules:/workspace/node_modules
)
if [ "${FRESH_PLAYWRIGHT_CACHE}" -eq 1 ]; then
  # An anonymous cache volume is empty on entry and is removed automatically
  # with `docker run --rm`. The normal named cache remains untouched.
  DOCKER_ARGS+=(-v /home/sandbox/.cache/ms-playwright)
else
  DOCKER_ARGS+=(
    -v freshell-sandbox-playwright-cache:/home/sandbox/.cache/ms-playwright
  )
fi

if [ "${MOUNT_CORPUS}" -eq 1 ]; then
  if [ -d "${HOME}/.codex/sessions" ]; then
    DOCKER_ARGS+=(-v "${HOME}/.codex/sessions:/home/sandbox/.codex/sessions:ro")
  fi
  if [ -d "${HOME}/.claude/projects" ]; then
    DOCKER_ARGS+=(-v "${HOME}/.claude/projects:/home/sandbox/.claude/projects:ro")
  fi
fi

# Docker creates any bind-mount point that doesn't yet exist on the host as
# root (dockerd itself runs as root), before the container ever hands off to
# its non-root user. A named volume layered under a path inside our
# bind-mounted repo (e.g. -v ...:/workspace/target) needs a mount point at
# ${REPO_ROOT}/target on the host side; in a freshly cloned/worktree'd repo
# that path doesn't exist yet, so dockerd creates it — root-owned. That stub
# then breaks host-side `cargo`/`npm` in this worktree with EACCES the next
# time a human (not root) tries to write there.
#
# Fix: pre-create every such mount point ourselves, as the invoking user,
# so dockerd never has to. Derived from DOCKER_ARGS itself (rather than a
# hardcoded list) so a future volume added above is covered automatically.
for entry in "${DOCKER_ARGS[@]}"; do
  case "${entry}" in
  *:/workspace/*)
    subpath="${entry#*:/workspace/}"
    subpath="${subpath%%:*}" # strip a trailing :ro/:rw suffix, if present
    if [ -n "${subpath}" ]; then
      mkdir -p "${REPO_ROOT}/${subpath}"
    fi
    ;;
  esac
done

# Plain (non-login) shell: a login shell (-l) would source /etc/profile,
# which on Debian unconditionally overwrites PATH and would clobber the
# cargo/rustup PATH entry set via the image's Dockerfile ENV.
DOCKER_STATUS=0
docker "${DOCKER_ARGS[@]}" "${IMAGE_TAG}" bash -c "${CMD}" || DOCKER_STATUS=$?

# Guard-rail: verify the pre-create step above actually did its job, rather
# than assuming it. If dockerd (or a future volume/mount this script doesn't
# yet know to pre-create) still left a root-owned entry directly under the
# repo root, fail loudly with a concrete remediation instead of leaving the
# next `cargo build`/`npm install` on the host to fail with a bare EACCES.
ROOT_DROPPINGS="$(find "${REPO_ROOT}" -maxdepth 1 -user root 2>/dev/null || true)"
if [ -n "${ROOT_DROPPINGS}" ]; then
  echo "[sandbox] ERROR: root-owned entries found directly under ${REPO_ROOT}:" >&2
  echo "${ROOT_DROPPINGS}" >&2
  echo "[sandbox] dockerd (which runs as root) created these as bind-mount points." >&2
  echo "[sandbox] Remediation: sudo chown -R \"\$(id -u):\$(id -g)\" <path>, for each path listed above, then re-run." >&2
  exit 1
fi

exit "${DOCKER_STATUS}"
