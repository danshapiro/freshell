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
# builds the ACTUAL Dockerfile from an ISOLATED copy of the working tree
# with the entrypoint restricted to 0700 in that private copy, and asserts
# — against the exact image this build produced:
#   0. the image's configured runtime user is the non-root user (uid 1000)
#   1. that user can read AND execute the entrypoint
#   2. the container starts through its configured ENTRYPOINT (--dry-run
#      completes, no Permission denied)
# It fails against the pre-fix Dockerfile (COPY + 'RUN chmod +x') and passes
# against the fixed one.
#
# Isolation: the fixture never mutates the shared source tree — the context
# is a disposable copy under mktemp, so there is nothing to restore on
# success, failure, or cancellation, and concurrent invocations (same or
# different worktrees) cannot interfere. Every assertion runs against the
# built image's IMMUTABLE id (captured via --iidfile), never the mutable
# tag — tags are shared across worktrees, so a concurrent rebuild could
# otherwise swap the image between this build and its assertions.
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
CTX="$WORK/context"
IIDFILE="$WORK/image-id"
BUILD_LOG="$WORK/build.log"
trap 'rm -rf "$WORK"' EXIT

# --- Build the isolated context ---------------------------------------------
# Full copy of the working tree; the builder still applies the tree's own
# committed .dockerignore to this directory context, so the excludes here
# only bound the copy cost. The fixture then restricts the entrypoint in
# the PRIVATE copy and verifies the mode before building (a setup failure
# must abort, never silently build the wrong fixture).
echo "Preparing isolated 0700-entrypoint build context..."
mkdir -p "$CTX"
tar -cf - \
  --exclude=./node_modules \
  --exclude=./dist \
  --exclude=./target \
  --exclude=./.git \
  --exclude=./.worktrees \
  --exclude=./coverage \
  --exclude=./test-results \
  --exclude=./playwright-report \
  --exclude=./.env \
  --exclude=./.env.local \
  . | tar -xf - -C "$CTX"

chmod 700 "$CTX/$EP"
FIXTURE_MODE="$(stat -c %a "$CTX/$EP")"
if [ "$FIXTURE_MODE" != "700" ]; then
  fail "fixture setup failed: context entrypoint mode is $FIXTURE_MODE, expected 700"
  exit 1
fi

# --- Build the ACTUAL Dockerfile from the restricted context ----------------
echo "Building $DOCKERFILE with a 0700-entrypoint context (this may take a while on a cold cache)..."
if ! docker build -f "$CTX/$DOCKERFILE" --iidfile "$IIDFILE" -t "$IMAGE_TAG" "$CTX" \
  >"$BUILD_LOG" 2>&1; then
  cp "$BUILD_LOG" "$SCRIPT_DIR/.entrypoint-mode-build.log"
  fail "docker build failed (see $SCRIPT_DIR/.entrypoint-mode-build.log)"
  tail -30 "$BUILD_LOG"
  exit 1
fi
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
