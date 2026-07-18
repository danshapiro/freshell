#!/usr/bin/env bash
# entrypoint for freshell-sandbox. Runs as root (PID 1) so it can fix
# ownership of named volumes Docker creates fresh at runtime (they default
# to root-owned, which the non-root "sandbox" user can't write to), then
# drops privileges via gosu (a true exec, not su/sudo) before running the
# caller's command. The caller's command never runs as root.
set -euo pipefail

TARGET_UID="$(id -u sandbox)"
TARGET_GID="$(id -g sandbox)"

cd /workspace

# /home/sandbox/.cache is where npm postinstall scripts (electron,
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
  "/workspace/target"
  "/workspace/node_modules"
  "/home/sandbox/.cache/ms-playwright"
)
for dir in "${VOLUME_DIRS[@]}"; do
  mkdir -p "${dir}"
  if [ "$(stat -c %u "${dir}")" != "${TARGET_UID}" ]; then
    chown -R "${TARGET_UID}:${TARGET_GID}" "${dir}"
  fi
done

if [ -f package-lock.json ] && [ ! -f node_modules/.sandbox-npm-ci-done ]; then
  echo "[sandbox] populating sandbox-owned node_modules via npm ci (first use of this volume)..." >&2
  gosu sandbox npm ci --no-audit --no-fund
  gosu sandbox touch node_modules/.sandbox-npm-ci-done
fi

exec gosu sandbox "$@"
