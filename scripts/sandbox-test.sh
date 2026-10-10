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

SETTLE_ONLY=0
if [ "${1:-}" = "--settle-owned" ]; then
  SETTLE_ONLY=1
  OWNED_CONTROL_DIR="${2:?owned control directory is required}"
  OWNED_CONTAINER_NAME="$(basename "${OWNED_CONTROL_DIR}")"
  if ! [[ "${OWNED_CONTAINER_NAME}" =~ ^freshell-sandbox-[[:alnum:]]{8}$ ]] \
    || [ "$(cat "${OWNED_CONTROL_DIR}/container.name")" != "${OWNED_CONTAINER_NAME}" ]; then
    echo '[sandbox] invalid owned settlement control directory' >&2
    exit 1
  fi
else
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
  printf '%s\n' "${OWNED_CONTAINER_NAME}" > "${OWNED_CONTROL_DIR}/container.name"
fi
OWNED_CID_FILE="${OWNED_CONTROL_DIR}/container.id"
OWNER_GUARD_PID=""
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
  local owned_cid=""
  if [ -s "${OWNED_CID_FILE}" ]; then
    owned_cid="$(cat "${OWNED_CID_FILE}")"
  else
    # Creation may reach the daemon before the attached client publishes its
    # CID. The preallocated exact name is still ours; missing publication is
    # unknown state, not evidence that no container was created.
    owned_cid="$(docker ps -aq --no-trunc --filter "name=^/${OWNED_CONTAINER_NAME}$")" || return 1
  fi
  if [ -n "${owned_cid}" ]; then
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
  # Always query the exact name, including failures before CID publication.
  # Only a successful daemon response establishes absence.
  local remaining_by_name
  remaining_by_name="$(docker ps -aq --no-trunc --filter "name=^/${OWNED_CONTAINER_NAME}$")" || cleanup_status=1
  [ -z "${remaining_by_name}" ] || cleanup_status=1
  return "${cleanup_status}"
}

# The independent owner guard uses this same exact-ID/name settlement path.
# It runs after a SIGKILL, when the ordinary wrapper cannot execute its traps.
if [ "${SETTLE_ONLY}" -eq 1 ]; then
  REQUESTED_SIGNAL="SIGTERM"
  cleanup_owned_container
  exit $?
fi

# shellcheck disable=SC2317 # Invoked by the installed EXIT trap.
finish_owned_sandbox() {
  local result=$?
  local container_settled=0
  trap - EXIT
  trap '' INT TERM HUP
  if [ ! -s "${OWNED_CID_FILE}" ] && [ -n "${DOCKER_CLIENT_PID}" ]; then
    # Join creation before looking up the name: querying first could observe
    # absence while this client is still creating the owned object.
    if owned_docker_client_running; then
      kill -TERM "${DOCKER_CLIENT_PID}" 2>/dev/null || true
    fi
    wait "${DOCKER_CLIENT_PID}" 2>/dev/null || true
    DOCKER_CLIENT_PID=""
  fi
  if cleanup_owned_container; then
    container_settled=1
  else
    result=1
  fi
  if [ -n "${DOCKER_CLIENT_PID}" ]; then
    # Cleanup has been attempted; join a lingering attached client instead of
    # leaving this wrapper waiting on its transport. Unknown daemon state
    # retains the control directory below.
    if owned_docker_client_running; then
      kill -TERM "${DOCKER_CLIENT_PID}" 2>/dev/null || true
    fi
    wait "${DOCKER_CLIENT_PID}" 2>/dev/null || true
  fi
  # The owner completed its cleanup attempt even when daemon state is
  # unknown. Join the guard, preserve that failure and retain its evidence.
  if [ -n "${OWNER_GUARD_PID}" ]; then
    touch "${OWNED_CONTROL_DIR}/owner.released"
    if ! python3 "${REPO_ROOT}/scripts/testing/sandbox-owner-guard.py" --join "${OWNED_CONTROL_DIR}"; then
      sandbox_log error sandbox_owner_guard_unsettled 1
      result=1
      container_settled=0
    fi
  fi
  if [ "${container_settled}" -eq 1 ]; then
    rm -rf -- "${OWNED_CONTROL_DIR}" || result=1
  else
    sandbox_log error sandbox_owned_container_unsettled 1
    printf '[sandbox] owned container %s could not be settled; control evidence retained at %q\n' \
      "${OWNED_CONTAINER_NAME}" "${OWNED_CONTROL_DIR}" >&2
  fi
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

# Only the strict Rust route opts in. A detached owner guard survives the
# unchanged coordinator's SIGKILL tree and settles this preallocated object.
if [ "${RUNTIME_SUITE}" -eq 1 ] && [ "${FRESHELL_SANDBOX_OWNER_GUARD:-}" = "1" ]; then
  OWNER_GUARD_PID="$(python3 "${REPO_ROOT}/scripts/testing/sandbox-owner-guard.py" "${OWNED_CONTROL_DIR}" "$$" "${BASH_SOURCE[0]}")"
  printf '{"severity":"info","event":"sandbox_owner_guard_started","container":"%s","pid":%s}\n' \
    "${OWNED_CONTAINER_NAME}" "${OWNER_GUARD_PID}" >&2
fi

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
