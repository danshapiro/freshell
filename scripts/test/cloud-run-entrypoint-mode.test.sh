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
# deterministically reproduces the bad source mode, builds the ACTUAL
# Dockerfile, and asserts — against the exact image this build produced:
#   0. the image's configured runtime user is the non-root user (uid 1000)
#   1. that user can read AND execute the entrypoint
#   2. the container starts through its configured ENTRYPOINT (--dry-run
#      completes, no Permission denied)
# It fails against the pre-fix Dockerfile (COPY + 'RUN chmod +x') and passes
# against the fixed one.
#
# Concurrency: the 0700 fixture mutates the shared source file's mode in
# place, so the chmod→build→restore window is guarded by a per-worktree
# lock (overlapping invocations would otherwise save/restore modes under
# each other's builds). Every assertion runs against the built image's
# IMMUTABLE id (captured via --iidfile), never the mutable tag — tags are
# shared across worktrees, so a concurrent rebuild could otherwise swap the
# image between this build and its assertions.
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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
IIDFILE="$WORK/image-id"
BUILD_LOG="$SCRIPT_DIR/.entrypoint-mode-build.log"
# Per-worktree lock (same realpath -> same lock), outside the repo so it
# never litters the tree.
BUILD_LOCK="/tmp/freshell-entrypoint-mode-$(printf %s "$ROOT" | md5sum | cut -d' ' -f1).lock"

# --- Reproduce the bad source mode deterministically, build, restore --------
# A fresh git checkout under umask 0077 lands at 0700 anyway; forcing it
# makes the test independent of the invoking shell's umask. The whole
# chmod→build→restore window is one critical section under the worktree
# lock, and the build's image id is captured for the assertions below.
BUILD_STATUS=0
(
  flock 9
  ORIG_MODE="$(stat -c %a "$EP")"
  chmod 700 "$EP"
  docker build -f "$DOCKERFILE" --iidfile "$IIDFILE" -t "$IMAGE_TAG" . \
    >"$BUILD_LOG" 2>&1 || BUILD_STATUS=1
  chmod "$ORIG_MODE" "$EP"
  exit "$BUILD_STATUS"
) 9>"$BUILD_LOCK" || {
  fail "docker build failed (see $BUILD_LOG)"
  tail -30 "$BUILD_LOG"
  exit 1
}
echo "PASS: docker build succeeded (mode-0700 entrypoint context)"

if [ ! -s "$IIDFILE" ]; then
  fail "docker build did not report an image id (--iidfile empty)"
  exit 1
fi
IMAGE_ID="$(cat "$IIDFILE")"

# --- Check 0: the image's configured runtime user is the non-root user ------
# No --user override: we assert the identity the image itself configures
# (USER node -> uid 1000). If the image ever reverted to root, the
# permission checks below would pass vacuously against a root-owned 0711
# entrypoint — this check keeps them meaningful.
RUN_UID="$(docker run --rm --entrypoint /bin/sh "$IMAGE_ID" -c 'id -u' 2>/dev/null || true)"
if [ "$RUN_UID" = "1000" ]; then
  echo "PASS: image's configured runtime user is non-root (uid 1000)"
else
  fail "image's configured runtime user is not the non-root user (got uid '${RUN_UID:-<run failed>}', expected 1000)"
fi

# --- Check 1: entrypoint readable+executable by that runtime user -----------
if docker run --rm --entrypoint /bin/sh "$IMAGE_ID" \
  -c "test -r $IN_CONTAINER_EP && test -x $IN_CONTAINER_EP" >/dev/null 2>&1; then
  echo "PASS: entrypoint readable AND executable by the non-root runtime user"
else
  fail "entrypoint not readable+executable by the non-root runtime user (the 0711 'Permission denied' regression)"
fi

# --- Check 2: the container starts through its configured ENTRYPOINT -------
set +e
RUN_OUT="$(docker run --rm "$IMAGE_ID" --dry-run 2>&1)"
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
