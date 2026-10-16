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
# --runtime-suite prepares dependencies first, then runs the caller in the
# stricter managed-runtime lifecycle mode: no network, no real provider corpus,
# no Docker/admin socket, read-only container root.
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
CACHE_PREFIX="${FRESHELL_SANDBOX_CACHE_PREFIX:-freshell-sandbox}"

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

# This one committed library selector needs the owned runtime broker and its
# daemon-host paths. Every parent and its aborting child still runs enclosed.
if [ "${RUNTIME_SUITE}" -eq 1 ] && [ "$#" -eq 1 ] && \
   [ "${CMD}" = "cargo test -p freshell-supervisor stopped_repair_crash_ -- --ignored" ]; then
  cd "${REPO_ROOT}"
  exec pnpm exec tsx "${REPO_ROOT}/scripts/testing/task007-destructive-sandbox.ts"
fi

# A prefix must name Docker volumes, never turn these mounts into host paths.
if [[ ! "${CACHE_PREFIX}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "[sandbox] FRESHELL_SANDBOX_CACHE_PREFIX must be a Docker volume name prefix, not a path" >&2
  exit 2
fi

if ! docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  echo "[sandbox] image ${IMAGE_TAG} not found, building it first..." >&2
  "${REPO_ROOT}/scripts/sandbox-build.sh"
fi

# Preparation and ordinary tests use the dedicated bridge, never host
# networking. The runtime-suite caller runs in a separate container without
# networking after preparation succeeds.
NETWORK_NAME="freshell-sandbox"
if ! docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
  docker network create --driver bridge "${NETWORK_NAME}" >/dev/null
fi

DOCKER_ARGS=(
  # Reap orphaned test children so zombies cannot exhaust the PID limit.
  run --rm --init
  --pids-limit 512
  --memory 8g
  -v "${REPO_ROOT}:/workspace"
  -v "${CACHE_PREFIX}-cargo-registry:/usr/local/cargo/registry"
  -v "${CACHE_PREFIX}-cargo-git:/usr/local/cargo/git"
  -v "${CACHE_PREFIX}-cargo-target:/workspace/target"
  -v "${CACHE_PREFIX}-node-modules:/workspace/node_modules"
  # pnpm workspace members with their own dependencies get their own
  # sandbox-owned node_modules (the entrypoint chowns and, on fingerprint
  # changes, purges these only as mounted volumes). On legacy npm-era
  # branches these stay mounted-but-unused and harmless.
  -v "${CACHE_PREFIX}-sidecar-node-modules:/workspace/crates/freshell-claude-sidecar/node_modules"
  -v "${CACHE_PREFIX}-mcp-node-modules:/workspace/packages/freshell-mcp-runtime/node_modules"
  -v "${CACHE_PREFIX}-playwright-cache:/home/sandbox/.cache/ms-playwright"
)

EXECUTION_ARGS=(--network "${NETWORK_NAME}")
if [ "${RUNTIME_SUITE}" -eq 1 ]; then
  EXECUTION_ARGS=(
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,size=512m"
    --tmpfs "/home/sandbox/.cache:rw,nosuid,nodev,size=256m"
    --security-opt no-new-privileges
    -e FRESHELL_SANDBOX_MODE=runtime-suite
    -e CARGO_NET_OFFLINE=true
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
if [ "${RUNTIME_SUITE}" -eq 1 ]; then
  # The entrypoint prepares fingerprinted Node dependencies. Fetch Rust
  # sources into the same named volumes too, so cold Cargo tests can compile
  # offline. Only this fixed preparation runs with networking and a writable
  # root; the caller's command is never sent to this container.
  echo "[sandbox] preparing runtime-suite dependencies before restricted execution" >&2
  docker "${DOCKER_ARGS[@]}" --network "${NETWORK_NAME}" "${IMAGE_TAG}" \
    bash -c 'if [ -f Cargo.lock ]; then cargo fetch --locked; fi' || DOCKER_STATUS=$?
fi
if [ "${DOCKER_STATUS}" -eq 0 ]; then
  docker "${DOCKER_ARGS[@]}" "${EXECUTION_ARGS[@]}" "${IMAGE_TAG}" bash -c "${CMD}" || DOCKER_STATUS=$?
fi

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
