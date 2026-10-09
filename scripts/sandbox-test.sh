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
#   scripts/sandbox-test.sh --native-tools <manifest-path> --receipt-dir <absolute-directory>
#   scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-codex ..."
#
# --runtime-suite is the stricter managed-runtime lifecycle mode: no network,
# no real provider corpus, no Docker/admin socket, read-only container root.
#
# --corpus mounts ~/.codex/sessions and ~/.claude/projects READ-ONLY at their
# natural paths inside the container, for realistic-data perf tests. Without
# it, no real user data is mounted at all.
#
# --native-tools is the EARLY native-only branch (unified-agent-names Task 8):
# it never runs the repo-mount sandbox path. It delegates to the Node wrapper
# (scripts/testing/native-session-names-sandbox.mjs), which validates the
# closed input list (optionally relocated by the manifest), then runs the
# native session-names contract runner read-only in an owned disposable
# container — no corpus, no operator home, no package installation. The
# wrapper's exit codes pass through unchanged (0 all providers passed,
# 1 contract failure, 2 missing prerequisite before any Docker mutation).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="freshell-sandbox:latest"

if [ "${1:-}" = "--provider-mountpoints" ]; then
  shift
  exec python3 "${REPO_ROOT}/scripts/testing/managed-provider-mountpoints-sandbox.py" "$@"
fi

if [ "${1:-}" = "--provider-launches" ]; then
  shift
  exec python3 "${REPO_ROOT}/scripts/testing/managed-provider-launch-sandbox.py" "$@"
fi

if [ "${1:-}" = "--provider-inputs" ]; then
  shift
  exec python3 "${REPO_ROOT}/scripts/testing/probe-provider-config-readonly-home.py" --indexed-inputs "$@"
fi

if [ "${1:-}" = "--provider-sources" ]; then
  shift
  exec python3 "${REPO_ROOT}/scripts/testing/managed-provider-source-sandbox.py" "$@"
fi

if [ "${1:-}" = "--native-tools" ]; then
  NATIVE_MANIFEST="${2:-}"
  if [ -z "${NATIVE_MANIFEST}" ]; then
    echo "usage: $0 --native-tools <manifest-path> [--receipt-dir <absolute-directory>]" >&2
    exit 2
  fi
  shift 2
  NATIVE_RECEIPT_DIR="/tmp"
  if [ "${1:-}" = "--receipt-dir" ]; then
    NATIVE_RECEIPT_DIR="${2:-}"
    if [ -z "${NATIVE_RECEIPT_DIR}" ]; then
      echo "usage: $0 --native-tools <manifest-path> --receipt-dir <absolute-directory>" >&2
      exit 2
    fi
    shift 2
  fi
  if [ ! -d "${NATIVE_RECEIPT_DIR}" ]; then
    echo "[sandbox] --receipt-dir is not an existing directory: ${NATIVE_RECEIPT_DIR}" >&2
    exit 2
  fi
  exec node "${REPO_ROOT}/scripts/testing/native-session-names-sandbox.mjs" \
    --require-all \
    --manifest "${NATIVE_MANIFEST}" \
    --output "${NATIVE_RECEIPT_DIR%/}/native-session-names.json"
fi

MOUNT_CORPUS=0
RUNTIME_SUITE=0
while [ "$#" -gt 0 ]; do
  case "${1}" in
    --corpus)
      MOUNT_CORPUS=1
      shift
      ;;
    --runtime-suite)
      RUNTIME_SUITE=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [ "${MOUNT_CORPUS}" -eq 1 ] && [ "${RUNTIME_SUITE}" -eq 1 ]; then
  echo "[sandbox] --runtime-suite may not mount the real --corpus provider data" >&2
  exit 2
fi

if [ "$#" -lt 1 ]; then
  echo "usage: $0 [--corpus | --runtime-suite] \"<command to run inside the sandbox>\"" >&2
  exit 2
fi
CMD="$1"

if ! docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  echo "[sandbox] image ${IMAGE_TAG} not found, building it first..." >&2
  "${REPO_ROOT}/scripts/sandbox-build.sh"
fi

# Ordinary destructive tests keep the established dedicated bridge network.
# Managed-runtime lifecycle tests are stricter: no network at all. Neither mode
# ever uses the host network.
NETWORK_ARGS=()
if [ "${RUNTIME_SUITE}" -eq 1 ]; then
  NETWORK_ARGS=(--network none)
else
  NETWORK_NAME="freshell-sandbox"
  if ! docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
    docker network create --driver bridge "${NETWORK_NAME}" >/dev/null
  fi
  NETWORK_ARGS=(--network "${NETWORK_NAME}")
fi

OWNED_CONTROL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/freshell-sandbox-XXXXXXXX")"
OWNED_CONTAINER_NAME="$(basename "${OWNED_CONTROL_DIR}")"
OWNED_CID_FILE="${OWNED_CONTROL_DIR}/container.id"
DOCKER_CLIENT_PID=""
REQUESTED_SIGNAL=""

sandbox_log() {
  # All interpolated values are fixed events, numeric statuses or the owned
  # mktemp-generated identity, never caller command text or credentials.
  printf '{"severity":"%s","event":"%s","container":"%s","code":%s}\n' \
    "$1" "$2" "${OWNED_CONTAINER_NAME}" "$3" >&2
}

# shellcheck disable=SC2317 # Reached by the installed EXIT/signal trap handlers.
owned_docker_client_running() {
  [ -n "${DOCKER_CLIENT_PID}" ] \
    && ps -p "${DOCKER_CLIENT_PID}" -o args= 2>/dev/null \
      | grep -F -- "--name ${OWNED_CONTAINER_NAME}" \
      | grep -F -- "${REPO_ROOT}:/workspace" >/dev/null
}

# shellcheck disable=SC2317 # Reached by the installed EXIT trap handler.
cleanup_owned_container() {
  local cleanup_status=0
  if [ -s "${OWNED_CID_FILE}" ]; then
    local owned_cid
    owned_cid="$(cat "${OWNED_CID_FILE}")"
    if ! [[ "${owned_cid}" =~ ^[a-f0-9]{64}$ ]]; then
      sandbox_log error sandbox_invalid_owned_identity 1
      return 1
    fi
    if docker container inspect "${owned_cid}" >/dev/null 2>&1; then
      if [ -n "${REQUESTED_SIGNAL}" ]; then
        timeout 15s docker kill --signal "${REQUESTED_SIGNAL}" "${owned_cid}" >/dev/null || {
          docker container inspect "${owned_cid}" >/dev/null 2>&1 && cleanup_status=1
        }
        # Give the inner runner time to forward the same signal and clean its
        # own executable temp directory before stopping any remaining work.
        timeout 10s docker wait "${owned_cid}" >/dev/null 2>&1 || true
      fi
      if docker container inspect "${owned_cid}" >/dev/null 2>&1; then
        timeout 15s docker stop --time 5 "${owned_cid}" >/dev/null 2>&1 || {
          docker container inspect "${owned_cid}" >/dev/null 2>&1 && cleanup_status=1
        }
      fi
      # --rm may remove it before wait; only a successful absence check
      # counts as settlement when that races with the explicit wait.
      timeout 15s docker wait "${owned_cid}" >/dev/null 2>&1 || {
        docker container inspect "${owned_cid}" >/dev/null 2>&1 && cleanup_status=1
      }
      timeout 15s docker rm --force "${owned_cid}" >/dev/null 2>&1 || {
        docker container inspect "${owned_cid}" >/dev/null 2>&1 && cleanup_status=1
      }
    fi
    # A daemon error is not proof of absence. List succeeds first, then check
    # the exact ID rather than treating any inspect failure as cleanup.
    local remaining
    remaining="$(docker ps -aq --no-trunc --filter "id=${owned_cid}")" || cleanup_status=1
    [ -z "${remaining}" ] || cleanup_status=1
  fi
  return "${cleanup_status}"
}

# shellcheck disable=SC2317 # Invoked by the installed EXIT trap.
finish_owned_sandbox() {
  local result=$?
  trap - EXIT
  trap '' INT TERM HUP
  cleanup_owned_container || result=1
  if [ -n "${DOCKER_CLIENT_PID}" ]; then
    # The container is already settled; terminate a lingering attached client
    # rather than leaving this wrapper waiting on a transport after cleanup.
    if owned_docker_client_running; then
      kill -TERM "${DOCKER_CLIENT_PID}" 2>/dev/null || true
    fi
    wait "${DOCKER_CLIENT_PID}" 2>/dev/null || true
  fi
  rm -rf -- "${OWNED_CONTROL_DIR}" || result=1
  if [ "${result}" -eq 0 ]; then
    sandbox_log info sandbox_workload_finished "${result}"
  else
    sandbox_log error sandbox_workload_failed "${result}"
  fi
  exit "${result}"
}

# shellcheck disable=SC2317 # Invoked by the installed signal traps.
interrupt_owned_sandbox() {
  local result="$1"
  REQUESTED_SIGNAL="$2"
  trap '' INT TERM HUP
  sandbox_log info sandbox_workload_signal "${result}"
  # Docker publishes the cid before starting the workload. If interrupted
  # during creation, let this owned client publish its identity before cleanup.
  if [ -n "${DOCKER_CLIENT_PID}" ]; then
    for _attempt in $(seq 1 300); do
      [ -s "${OWNED_CID_FILE}" ] && break
      owned_docker_client_running || break
      sleep 0.1
    done
    if [ ! -s "${OWNED_CID_FILE}" ] && owned_docker_client_running; then
      sandbox_log error sandbox_identity_not_settled 1
      kill -TERM "${DOCKER_CLIENT_PID}" 2>/dev/null || true
      result=1
    fi
  fi
  exit "${result}"
}
trap 'finish_owned_sandbox' EXIT
trap 'interrupt_owned_sandbox 130 SIGINT' INT
trap 'interrupt_owned_sandbox 143 SIGTERM' TERM
trap 'interrupt_owned_sandbox 129 SIGHUP' HUP

DOCKER_ARGS=(
  # Reap orphaned test children so zombies cannot exhaust the PID limit.
  run --rm --init
  --name "${OWNED_CONTAINER_NAME}" --cidfile "${OWNED_CID_FILE}"
  "${NETWORK_ARGS[@]}"
  --pids-limit 512
  --memory 8g
  -v "${REPO_ROOT}:/workspace"
  -v freshell-sandbox-cargo-registry:/usr/local/cargo/registry
  -v freshell-sandbox-cargo-git:/usr/local/cargo/git
  -v freshell-sandbox-cargo-target:/workspace/target
  -v freshell-sandbox-node-modules:/workspace/node_modules
  # pnpm workspace members with their own dependencies get their own
  # sandbox-owned node_modules (the entrypoint chowns and, on fingerprint
  # changes, purges these only as mounted volumes). On legacy npm-era
  # branches these stay mounted-but-unused and harmless.
  -v freshell-sandbox-sidecar-node-modules:/workspace/crates/freshell-claude-sidecar/node_modules
  -v freshell-sandbox-mcp-node-modules:/workspace/packages/freshell-mcp-runtime/node_modules
  -v freshell-sandbox-playwright-cache:/home/sandbox/.cache/ms-playwright
)

if [ "${RUNTIME_SUITE}" -eq 1 ]; then
  # shellcheck disable=SC2054 # Commas belong to each single tmpfs option string.
  DOCKER_ARGS+=(
    --read-only
    --tmpfs /tmp:rw,nosuid,nodev,size=512m
    --tmpfs /home/sandbox/.cache:rw,nosuid,nodev,size=256m
    # Executable fixtures need a private package-lookup boundary. Reuse the
    # same sandbox-owned target volume outside /workspace, where native
    # ancestor lookup would otherwise select the repo's real node_modules.
    -v freshell-sandbox-cargo-target:/freshell-test-artifacts
    -e FRESHELL_TEST_EXECUTABLE_TMP_DIR=/freshell-test-artifacts
    --security-opt no-new-privileges
    -e FRESHELL_SANDBOX_MODE=runtime-suite
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
# then breaks host-side `cargo`/`pnpm` in this worktree with EACCES the next
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
sandbox_log info sandbox_workload_started 0
docker "${DOCKER_ARGS[@]}" "${IMAGE_TAG}" bash -c "${CMD}" &
DOCKER_CLIENT_PID=$!
wait "${DOCKER_CLIENT_PID}" || DOCKER_STATUS=$?
DOCKER_CLIENT_PID=""

# Guard-rail: verify the pre-create step above actually did its job, rather
# than assuming it. If dockerd (or a future volume/mount this script doesn't
# yet know to pre-create) still left a root-owned entry directly under the
# repo root, fail loudly with a concrete remediation instead of leaving the
# next `cargo build`/`pnpm install` on the host to fail with a bare EACCES.
ROOT_DROPPINGS="$(find "${REPO_ROOT}" -maxdepth 1 -user root 2>/dev/null || true)"
if [ -n "${ROOT_DROPPINGS}" ]; then
  echo "[sandbox] ERROR: root-owned entries found directly under ${REPO_ROOT}:" >&2
  echo "${ROOT_DROPPINGS}" >&2
  echo "[sandbox] dockerd (which runs as root) created these as bind-mount points." >&2
  echo "[sandbox] Remediation: sudo chown -R \"\$(id -u):\$(id -g)\" <path>, for each path listed above, then re-run." >&2
  exit 1
fi

exit "${DOCKER_STATUS}"
