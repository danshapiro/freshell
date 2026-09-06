#!/usr/bin/env bash
# Test: cloud-run entrypoint is usable by the non-root runtime user.
#
# BEHAVIORAL regression test for the "Permission denied at container start"
# failure class. COPY preserves the build-context file's mode, and a
# umask-0077 checkout bakes docker/cloud-run/entrypoint.sh = 0700 (no
# group/other READ). A bare 'RUN chmod +x' only ORs execute bits
# (0700|0111 = 0711), and a script must be READABLE to execute, so images
# built from such checkouts crashed under USER node with:
#   bash: /usr/local/bin/e2e-entrypoint.sh: Permission denied
# The fix pins the mode in the COPY itself (COPY --chmod=755). This test
# deterministically reproduces the bad source mode (chmod 0700 around the
# build), builds the ACTUAL Dockerfile, and asserts:
#   1. the runtime user (node, uid 1000) can read AND execute the entrypoint
#   2. the container starts through its configured ENTRYPOINT (--dry-run
#      completes, no Permission denied)
# It fails against the pre-fix Dockerfile (COPY + 'RUN chmod +x') and passes
# against the fixed one.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

IMAGE_TAG="freshell-entrypoint-mode:test"
EP="docker/cloud-run/entrypoint.sh"
DOCKERFILE="docker/cloud-run/Dockerfile"
IN_CONTAINER_EP="/usr/local/bin/e2e-entrypoint.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker not available"
  exit 0
fi

FAILURES=0
fail() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

# --- Reproduce the bad source mode deterministically -----------------------
# (a fresh git checkout under umask 0077 lands here anyway; forcing it makes
# the test independent of the invoking shell's umask)
ORIG_MODE="$(stat -c %a "$EP")"
restore_mode() { chmod "$ORIG_MODE" "$EP"; }
trap restore_mode EXIT
chmod 700 "$EP"

# --- Build the ACTUAL Dockerfile from the restricted context ---------------
echo "Building $DOCKERFILE with a 0700-entrypoint source (this may take a while on a cold cache)..."
if ! docker build -f "$DOCKERFILE" -t "$IMAGE_TAG" . >"$SCRIPT_DIR/.entrypoint-mode-build.log" 2>&1; then
  fail "docker build failed (see $SCRIPT_DIR/.entrypoint-mode-build.log)"
  tail -30 "$SCRIPT_DIR/.entrypoint-mode-build.log"
  exit 1
fi
echo "PASS: docker build succeeded"
restore_mode
trap - EXIT

# --- Check 1: entrypoint readable+executable by the runtime user -----------
# Runs as the image's USER (node, uid 1000) — exactly the runtime identity.
if docker run --rm --entrypoint /bin/sh "$IMAGE_TAG" \
  -c "test -r $IN_CONTAINER_EP && test -x $IN_CONTAINER_EP" >/dev/null 2>&1; then
  echo "PASS: entrypoint readable AND executable by the non-root runtime user"
else
  fail "entrypoint not readable+executable by the non-root runtime user (the 0711 'Permission denied' regression)"
fi

# --- Check 2: the container starts through its configured ENTRYPOINT -------
set +e
RUN_OUT="$(docker run --rm "$IMAGE_TAG" --dry-run 2>&1)"
RUN_EXIT=$?
set -e
if [ "$RUN_EXIT" -eq 0 ] && ! echo "$RUN_OUT" | grep -qi "permission denied"; then
  echo "PASS: container starts via its configured entrypoint (--dry-run, exit 0)"
else
  fail "container failed to start through its configured entrypoint (exit $RUN_EXIT)"
  echo "$RUN_OUT" | tail -30
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
