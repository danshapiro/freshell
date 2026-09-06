#!/usr/bin/env bash
# Test: cloud-vitest-entrypoint — verify TEST_MODE=vitest branch, .dockerignore exceptions,
# and Dockerfile USER node + PLAYWRIGHT_BROWSERS_PATH changes.
#
# Note: This test uses string-grep checks for fast feedback. Execution-level
# verification (running vitest in a Docker container with TEST_MODE=vitest)
# was performed in Task 5's end-to-end validation and is not repeated here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

ENTRYPOINT="$ROOT/docker/cloud-run/entrypoint.sh"
DOCKERFILE="$ROOT/docker/cloud-run/Dockerfile"
DOCKERIGNORE="$ROOT/.dockerignore"

FAILURES=0

check() {
  local desc="$1"
  shift
  if "$@"; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "=== Cloud Vitest Entrypoint Test ==="

# Check 1: entrypoint.sh contains TEST_MODE reference
check "entrypoint.sh contains 'TEST_MODE'" grep -q 'TEST_MODE' "$ENTRYPOINT"

# Check 2: entrypoint.sh contains 'vitest' reference
check "entrypoint.sh contains 'vitest'" grep -q 'vitest' "$ENTRYPOINT"

# Check 3: entrypoint.sh contains '--shard' reference
check "entrypoint.sh contains '--shard'" grep -q -- '--shard' "$ENTRYPOINT"

# Check 4: entrypoint.sh contains '--passWithNoTests'
check "entrypoint.sh contains '--passWithNoTests'" grep -q -- '--passWithNoTests' "$ENTRYPOINT"

# Check 5: entrypoint.sh references VITEST_CONFIGS
check "entrypoint.sh references 'VITEST_CONFIGS'" grep -q 'VITEST_CONFIGS' "$ENTRYPOINT"

# Check 6: entrypoint.sh references VITEST_ARGS_JSON (not VITEST_ARGS)
check "entrypoint.sh references 'VITEST_ARGS_JSON'" grep -q 'VITEST_ARGS_JSON' "$ENTRYPOINT"

# Check 7: entrypoint.sh references jq (for parsing VITEST_ARGS_JSON)
check "entrypoint.sh references 'jq'" grep -q 'jq' "$ENTRYPOINT"

# Check 8: When TEST_MODE is unset, entrypoint still references playwright (unchanged behavior)
check "entrypoint.sh still references 'playwright'" grep -q 'playwright' "$ENTRYPOINT"

# Check 9: .dockerignore contains !AGENTS.md exception
check ".dockerignore contains '!AGENTS.md'" grep -q '!AGENTS\.md' "$DOCKERIGNORE"

# Check 10: .dockerignore contains !docs/skills/testing.md exception
check ".dockerignore contains '!docs/skills/testing.md'" grep -q '!docs/skills/testing\.md' "$DOCKERIGNORE"

# Check 11: Dockerfile contains USER node in the runtime stage
check "Dockerfile contains 'USER node'" grep -q 'USER node' "$DOCKERFILE"

# Check 12: Dockerfile contains chown for /app ownership transfer
check "Dockerfile contains 'chown' for node ownership" grep -q 'chown.*node' "$DOCKERFILE"

# Check 13: Dockerfile sets PLAYWRIGHT_BROWSERS_PATH before the existing install
check "Dockerfile contains 'PLAYWRIGHT_BROWSERS_PATH'" grep -q 'PLAYWRIGHT_BROWSERS_PATH' "$DOCKERFILE"

# Check 14: the entrypoint COPY pins the mode explicitly (COPY --chmod=755),
# and USER node comes AFTER that COPY (not before). COPY --chmod is
# load-bearing: COPY preserves the context file's mode, and umask-0077
# checkouts bake 0700 (no group/other READ) — `RUN chmod +x` only ORs
# execute bits (0700|0111=0711), and a script must be READABLE to execute,
# so the non-root runtime hit "Permission denied" at container start.
ENTRYPOINT_COPY_LINE=$(grep -n 'COPY --chmod=755 docker/cloud-run/entrypoint.sh' "$DOCKERFILE" | tail -1 | cut -d: -f1)
USER_LINE=$(grep -n 'USER node' "$DOCKERFILE" | tail -1 | cut -d: -f1)
if [ -n "$ENTRYPOINT_COPY_LINE" ] && [ -n "$USER_LINE" ] && [ "$USER_LINE" -gt "$ENTRYPOINT_COPY_LINE" ]; then
  echo "PASS: USER node (line $USER_LINE) is after the --chmod=755 entrypoint COPY (line $ENTRYPOINT_COPY_LINE)"
else
  echo "FAIL: USER node (line ${USER_LINE:-N/A}) is not after the --chmod=755 entrypoint COPY (line ${ENTRYPOINT_COPY_LINE:-N/A}) — COPY must pin the entrypoint mode before switching to USER node"
  FAILURES=$((FAILURES + 1))
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
