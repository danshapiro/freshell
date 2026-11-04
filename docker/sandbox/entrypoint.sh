#!/usr/bin/env bash
# entrypoint for freshell-sandbox. Runs as root (PID 1) so it can fix
# ownership of named volumes Docker creates fresh at runtime (they default
# to root-owned, which the non-root "sandbox" user can't write to), then
# drops privileges via gosu (a true exec, not su/sudo) before running the
# caller's command. The caller's command never runs as root.
set -euo pipefail

TARGET_UID="$(id -u sandbox)"
TARGET_GID="$(id -g sandbox)"

# This exact, closed fixture is used only by the checkpoint permission smoke.
# The wrapper permits it only in the networkless runtime suite; setup has no
# caller-supplied path, command, or ownership script. All observations and
# mutations happen later as the unprivileged sandbox user.
if [ "${FRESHELL_SANDBOX_CHECKPOINT_FIXTURE:-}" = "1" ]; then
  if [ "${FRESHELL_SANDBOX_MODE:-}" != "runtime-suite" ] || [ "$(id -u)" -ne 0 ]; then
    echo "[sandbox] checkpoint fixture requires the root runtime-suite initializer" >&2
    exit 2
  fi
  CHECKPOINT_FIXTURE_ROOT="/tmp/freshell-checkpoint-fixture"
  mkdir -p \
    "${CHECKPOINT_FIXTURE_ROOT}/project" \
    "${CHECKPOINT_FIXTURE_ROOT}/storage" \
    "${CHECKPOINT_FIXTURE_ROOT}/home"
  chown "${TARGET_UID}:${TARGET_GID}" \
    "${CHECKPOINT_FIXTURE_ROOT}" \
    "${CHECKPOINT_FIXTURE_ROOT}/project" \
    "${CHECKPOINT_FIXTURE_ROOT}/storage" \
    "${CHECKPOINT_FIXTURE_ROOT}/home"
  chmod 0755 \
    "${CHECKPOINT_FIXTURE_ROOT}" \
    "${CHECKPOINT_FIXTURE_ROOT}/project" \
    "${CHECKPOINT_FIXTURE_ROOT}/storage" \
    "${CHECKPOINT_FIXTURE_ROOT}/home"

  printf '%s\n' 'private-file.ignored' 'private-dir.ignored/' \
    >"${CHECKPOINT_FIXTURE_ROOT}/project/.gitignore"
  chown "${TARGET_UID}:${TARGET_GID}" "${CHECKPOINT_FIXTURE_ROOT}/project/.gitignore"
  chmod 0644 "${CHECKPOINT_FIXTURE_ROOT}/project/.gitignore"

  printf '%s\n' 'restricted checkpoint file sentinel' \
    >"${CHECKPOINT_FIXTURE_ROOT}/project/private-file.ignored"
  chmod 0600 "${CHECKPOINT_FIXTURE_ROOT}/project/private-file.ignored"
  chown 0:0 "${CHECKPOINT_FIXTURE_ROOT}/project/private-file.ignored"

  mkdir "${CHECKPOINT_FIXTURE_ROOT}/project/private-dir.ignored"
  printf '%s\n' 'restricted checkpoint directory sentinel' \
    >"${CHECKPOINT_FIXTURE_ROOT}/project/private-dir.ignored/private.txt"
  chmod 0600 "${CHECKPOINT_FIXTURE_ROOT}/project/private-dir.ignored/private.txt"
  chown 0:0 "${CHECKPOINT_FIXTURE_ROOT}/project/private-dir.ignored/private.txt"
  chmod 0700 "${CHECKPOINT_FIXTURE_ROOT}/project/private-dir.ignored"
  chown 0:0 "${CHECKPOINT_FIXTURE_ROOT}/project/private-dir.ignored"

  export FRESHELL_CHECKPOINT_FIXTURE_ROOT="${CHECKPOINT_FIXTURE_ROOT}"
fi

cd /workspace

# /home/sandbox/.cache is where npm/pnpm postinstall scripts (electron,
# playwright, ...) create their OWN cache subdirectories on demand — it must
# be sandbox-owned itself, not just the ms-playwright volume mounted below,
# or a plain `mkdir` for a sibling dir (e.g. .cache/electron) gets EACCES.
mkdir -p /home/sandbox/.cache
chown "${TARGET_UID}:${TARGET_GID}" /home/sandbox/.cache

# Volumes that may be freshly created (root-owned) on first use of this
# image: the cargo registry/git caches, and the sandbox-owned node_modules
# and cargo target dirs layered over the bind-mounted repo. Cheap to check,
# only chowns (recursively) the first time a given volume is used.
VOLUME_DIRS=(
  "/usr/local/cargo/registry"
  "/usr/local/cargo/git"
  "/home/sandbox/.local/share/pnpm/store"
  "/workspace/target"
  "/home/sandbox/.cache/ms-playwright"
)
if [ "${FRESHELL_SANDBOX_DEPENDENCY_READONLY:-}" != 1 ]; then
  VOLUME_DIRS+=("/workspace/node_modules")
fi
for dir in "${VOLUME_DIRS[@]}"; do
  mkdir -p "${dir}"
  if [ "$(stat -c %u "${dir}")" != "${TARGET_UID}" ]; then
    chown -R "${TARGET_UID}:${TARGET_GID}" "${dir}"
  fi
done

# pnpm workspace members with their own dependencies (the sidecar and the
# private MCP runtime package) each get a sandbox-owned node_modules
# layered over the bind-mounted repo — scripts/sandbox-test.sh mounts
# named volumes there. Unlike the paths above, docker creates these mount
# points itself and a foreign tree may not contain the members at all, so
# never mkdir here (that would litter the bind mount) and only fix
# ownership of actual mounts: member dir present AND volume mounted.
is_mount_point() {
  awk '{print $5}' /proc/self/mountinfo | grep -qxF "$1"
}
if [ -f pnpm-workspace.yaml ] && [ "${FRESHELL_SANDBOX_DEPENDENCY_READONLY:-}" != 1 ]; then
  for dir in \
    crates/freshell-claude-sidecar/node_modules \
    packages/freshell-mcp-runtime/node_modules; do
    if [ -d "$(dirname "/workspace/${dir}")" ] && is_mount_point "/workspace/${dir}"; then
      if [ "$(stat -c %u "/workspace/${dir}")" != "${TARGET_UID}" ]; then
        chown -R "${TARGET_UID}:${TARGET_GID}" "/workspace/${dir}"
      fi
    fi
  done
fi

if is_mount_point /workspace/target; then
  for slot in root sidecar mcp; do
    for cache in .vite .vite-temp .vitest .cache; do
      directory="/workspace/target/.freshell-node-cache/${slot}/${cache}"
      mkdir -p "${directory}"
      if [ "$(stat -c %u "${directory}")" != "${TARGET_UID}" ]; then
        chown -R "${TARGET_UID}:${TARGET_GID}" "${directory}"
      fi
    done
  done
fi

# --- dependency prep (fingerprinted, dual-manager) ------------------------
# Replaces the one-shot `.sandbox-npm-ci-done` marker: the sandbox serves
# both pnpm-era trees (packageManager pin; plan §7.3) and legacy npm-era
# branches (package-lock.json only), so the manager is selected per tree and
# the install is keyed by a fingerprint over the actual dependency inputs.
# The state file lives inside the install volume (node_modules is a named
# volume under scripts/sandbox-test.sh), so wiping the volume wipes the
# state. The old marker never satisfies this state: an npm-era volume, a
# stale marker, or a manager switch selects a separately prepared tree.
if [ -f package.json ]; then
  # Manager selection precedence mirrors scripts/lib/package-manager.ts
  # (detectProjectManager): the packageManager field is authoritative; a
  # missing or unrecognized field falls back to lock presence, npm's
  # package-lock.json first so legacy branches keep their `npm ci` path
  # while both lock styles exist transiently in migrated trees.
  DEPS_PM_FIELD="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync("package.json","utf8")).packageManager||"")}catch{}' 2>/dev/null || true)"
  DEPS_MANAGER=""
  case "${DEPS_PM_FIELD%%@*}" in
    pnpm) DEPS_MANAGER=pnpm ;;
    npm) DEPS_MANAGER=npm ;;
  esac
  if [ -z "${DEPS_MANAGER}" ]; then
    if [ -f package-lock.json ]; then
      DEPS_MANAGER=npm
    elif [ -f pnpm-lock.yaml ]; then
      DEPS_MANAGER=pnpm
    fi
  fi

  if [ -n "${DEPS_MANAGER}" ]; then
    if ! command -v "${DEPS_MANAGER}" >/dev/null 2>&1; then
      echo "[sandbox] ERROR: this tree selects ${DEPS_MANAGER}, which is not installed in the sandbox image" >&2
      exit 1
    fi

    if [ "${DEPS_MANAGER}" = pnpm ]; then
      # The explicit --store-dir is load-bearing: pnpm's default store-path
      # resolution (storePathRelativeToHome) probes the project root's
      # writability by touching a _tmp_ file next to the root manifest. The
      # bind-mounted repo is not writable by the sandbox user, so the probe
      # EACCES would kill every install. The path is the same canonical
      # per-user location pnpm would pick itself (/home/sandbox is
      # sandbox-owned by construction).
      DEPS_POLICY=(install --frozen-lockfile --store-dir /home/sandbox/.local/share/pnpm/store)
      DEPS_LOCKS=(pnpm-lock.yaml pnpm-workspace.yaml)
    else
      DEPS_POLICY=(ci --no-audit --no-fund)
      DEPS_LOCKS=(package-lock.json)
    fi
    DEPS_MANAGER_VERSION="$(gosu sandbox "${DEPS_MANAGER}" --version 2>/dev/null || true)"

    # Fingerprint over the selected manager's identity, the install policy
    # flags, the root manifest, the selected manager's lock/config files,
    # and the workspace member manifests when present. Absent files are
    # skipped; changing an input selects a new prepared identity.
    DEPS_FINGERPRINT="$(
      {
        printf 'manager=%s@%s\n' "${DEPS_MANAGER}" "${DEPS_MANAGER_VERSION}"
        printf 'policy=%s\n' "${DEPS_POLICY[*]}"
        for f in package.json "${DEPS_LOCKS[@]}" \
                 crates/freshell-claude-sidecar/package.json \
                 packages/freshell-mcp-runtime/package.json; do
          if [ -f "$f" ]; then
            sha256sum "$f"
          fi
        done
      } | sha256sum | cut -d' ' -f1
    )"

    DEPS_STATE="node_modules/.sandbox-deps-state"
    FOUNDATION_ID="$(cat /usr/local/share/freshell-sandbox/foundation-id)"
    PROTOCOL_VERSION="$(node -p 'require("/usr/local/share/freshell-sandbox/protocol.json").version')"
    CACHE_IDENTITY="$(node /usr/local/share/freshell-sandbox/dependency-cache.mjs --key /workspace "${FOUNDATION_ID}" "${PROTOCOL_VERSION}")"
    if [ -n "${FRESHELL_SANDBOX_DEPENDENCY_KEY:-}" ] && [ "${FRESHELL_SANDBOX_DEPENDENCY_KEY}" != "${CACHE_IDENTITY}" ]; then
      printf '{"severity":"error","event":"sandbox_dependency_inputs_changed"}\n' >&2
      exit 2
    fi
    require_current_dependency_inputs() {
      local current_identity
      current_identity="$(node /usr/local/share/freshell-sandbox/dependency-cache.mjs --key /workspace "${FOUNDATION_ID}" "${PROTOCOL_VERSION}")"
      if [ "${current_identity}" != "${CACHE_IDENTITY}" ]; then
        printf '{"severity":"error","event":"sandbox_dependency_inputs_changed"}\n' >&2
        exit 2
      fi
    }
    read_dependency_state() {
      RECORDED_FINGERPRINT=""
      RECORDED_IDENTITY=""
      if [ -f "${DEPS_STATE}" ]; then
        RECORDED_FINGERPRINT="$(grep '^fingerprint=' "${DEPS_STATE}" | cut -d= -f2 || true)"
        RECORDED_IDENTITY="$(grep '^cache_identity=' "${DEPS_STATE}" | cut -d= -f2 || true)"
      fi
    }
    dependency_state_matches() {
      [ "${RECORDED_FINGERPRINT}" = "${DEPS_FINGERPRINT}" ] && [ "${RECORDED_IDENTITY}" = "${CACHE_IDENTITY}" ]
    }
    # Consumer mounts are read-only. No setup or replacement can occur after
    # admission, including when its foreground process or descendants exit.
    if [ "${FRESHELL_SANDBOX_DEPENDENCY_READONLY:-}" = 1 ]; then
      read_dependency_state
      if ! dependency_state_matches; then
        printf '{"severity":"error","event":"sandbox_dependency_not_prepared"}\n' >&2
        exit 2
      fi
    else
      # Only cold/incomplete preparation writes this input-specific tree.
      # Keep the standard descriptor lock through the synchronous installer.
      exec {DEPENDENCY_PREPARATION_DESCRIPTOR}</workspace/node_modules
      printf '{"severity":"info","event":"sandbox_dependency_preparation_waiting"}\n' >&2
      flock --exclusive "${DEPENDENCY_PREPARATION_DESCRIPTOR}"
      trap 'exit 130' INT
      trap 'exit 143' TERM
      trap 'exit 129' HUP
      require_current_dependency_inputs
      read_dependency_state
      if [ -f "${DEPS_STATE}" ]; then
        if ! dependency_state_matches; then
          printf '{"severity":"error","event":"sandbox_dependency_identity_mismatch"}\n' >&2
          exit 2
        fi
        echo "[sandbox] deps: reusing sandbox-owned node_modules (${DEPS_MANAGER} fingerprint ${DEPS_FINGERPRINT} unchanged)" >&2
      else
        echo "[sandbox] deps: installing via ${DEPS_MANAGER} ${DEPS_POLICY[*]} (fingerprint ${DEPS_FINGERPRINT}, incomplete tree)" >&2
        for dir in node_modules crates/freshell-claude-sidecar/node_modules packages/freshell-mcp-runtime/node_modules; do
          if [ -d "${dir}" ] && is_mount_point "/workspace/${dir}"; then
            find "${dir}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
          fi
        done
        gosu sandbox "${DEPS_MANAGER}" "${DEPS_POLICY[@]}"
        # Build caches belong to this worktree's writable artifact volume,
        # rather than the immutable installed dependency trees.
        module_dirs=(node_modules crates/freshell-claude-sidecar/node_modules packages/freshell-mcp-runtime/node_modules)
        slots=(root sidecar mcp)
        for index in 0 1 2; do
          directory="${module_dirs[index]}"
          if [ -d "${directory}" ] && is_mount_point "/workspace/${directory}"; then
            for cache in .vite .vite-temp .vitest .cache; do
              if [ -e "${directory}/${cache}" ] || [ -L "${directory}/${cache}" ]; then
                printf '{"severity":"error","event":"sandbox_dependency_cache_collision","slot":"%s","cache":"%s"}\n' \
                  "${slots[index]}" "${cache}" >&2
                exit 2
              fi
              ln -sT "/workspace/target/.freshell-node-cache/${slots[index]}/${cache}" "${directory}/${cache}"
            done
          fi
        done
        require_current_dependency_inputs
        temporary_state="${DEPS_STATE}.tmp.$$"
        printf 'manager=%s\nmanager_version=%s\nfingerprint=%s\ncache_identity=%s\n' "${DEPS_MANAGER}" "${DEPS_MANAGER_VERSION}" "${DEPS_FINGERPRINT}" "${CACHE_IDENTITY}" | gosu sandbox tee "${temporary_state}" >/dev/null
        gosu sandbox mv "${temporary_state}" "${DEPS_STATE}"
        printf '{"severity":"info","event":"sandbox_dependency_preparation_published"}\n' >&2
      fi
      exec {DEPENDENCY_PREPARATION_DESCRIPTOR}<&-
      trap - INT TERM HUP
    fi
  fi
fi

exec gosu sandbox "$@"
