#!/usr/bin/env bash
# Test: cloud-vitest-integration — process-level verification that
# run-standard-tests.ts dispatches the default Vitest phase to the cloud
# backend only when FRESHELL_VITEST_BACKEND=cloud, never on local, and that
# a cloud dispatch automatically runs the LOCAL companion for the tests the
# cloud image excludes (the .dockerignore test/ exclusions), folding its
# result into the run verdict.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

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

echo "=== Cloud Vitest Integration Test ==="

# Process-level test — fake vitest-cloud.sh invoked when FRESHELL_VITEST_BACKEND=cloud
FAKE_CLOUD=$(mktemp /tmp/fake-vitest-cloud.XXXXXX.sh)
cat > "$FAKE_CLOUD" << 'FAKE'
#!/usr/bin/env bash
echo "FAKE_VITEST_CLOUD: $@" >> "${FAKE_CLOUD_LOG:-/dev/null}"
exit 0
FAKE
chmod +x "$FAKE_CLOUD"

# Fake local companion — stands in for the real vitest so the process test
# never spawns cargo/docker builds. The runner invokes it (instead of vitest)
# when FRESHELL_VITEST_COMPANION_SCRIPT is set.
FAKE_COMPANION=$(mktemp /tmp/fake-companion.XXXXXX.sh)
cat > "$FAKE_COMPANION" << 'FAKE'
#!/usr/bin/env bash
echo "FAKE_COMPANION: $@" >> "${FAKE_COMPANION_LOG:-/dev/null}"
exit 0
FAKE
chmod +x "$FAKE_COMPANION"

export FAKE_CLOUD_LOG=$(mktemp /tmp/fake-cloud-log.XXXXXX)
export FAKE_COMPANION_LOG=$(mktemp /tmp/fake-companion-log.XXXXXX)
touch "$FAKE_CLOUD_LOG" "$FAKE_COMPANION_LOG"

# --- Check block 1: broad cloud run invokes cloud shards AND the local companion.
# Use a timeout — after the fakes exit 0, the code runs the remaining local
# phases (source-runtime/rust/electron), which take minutes. We only need to
# verify the fakes were invoked. Capture stdout to verify the companion log
# lines and the local-phase plan.
rm -f "$FAKE_CLOUD_LOG" "$FAKE_COMPANION_LOG"; touch "$FAKE_CLOUD_LOG" "$FAKE_COMPANION_LOG"
BROAD_STDOUT=$(mktemp /tmp/cloud-stdout.XXXXXX)
timeout 10s bash -c "
FRESHELL_VITEST_BACKEND=cloud \
FRESHELL_VITEST_CLOUD_SCRIPT='$FAKE_CLOUD' \
FRESHELL_VITEST_COMPANION_SCRIPT='$FAKE_COMPANION' \
pnpm exec tsx scripts/run-standard-tests.ts --mode desktop
" > "$BROAD_STDOUT" 2>&1 || true

check "fake vitest-cloud.sh was invoked" grep -q 'FAKE_VITEST_CLOUD' "$FAKE_CLOUD_LOG"
check "fake was called with 'run'" grep -q 'run' "$FAKE_CLOUD_LOG"
check "fake local companion was invoked on a broad cloud run" grep -q 'FAKE_COMPANION' "$FAKE_COMPANION_LOG"
check "companion ran the cloud-excluded test dir (test/integration/server)" \
  grep -q 'test/integration/server' "$FAKE_COMPANION_LOG"
check "companion used the default vitest config" \
  grep -q 'config/vitest/vitest.config.ts' "$FAKE_COMPANION_LOG"
check "companion start is announced in the run log" \
  grep -q 'Starting local companion' "$BROAD_STDOUT"

# The remaining local phases run after the cloud dispatch; the run-standard-tests
# logs the local-phase plan naming the electron suite.
check "local phases attempted after cloud dispatch" \
  grep -q 'electron' "$BROAD_STDOUT"
rm -f "$BROAD_STDOUT"

# --- Check block 2: focused client run does not drag in the companion.
# A selector that does not intersect the local-only tests must skip the
# companion (and say so) instead of running the whole parity directory.
rm -f "$FAKE_CLOUD_LOG" "$FAKE_COMPANION_LOG"; touch "$FAKE_CLOUD_LOG" "$FAKE_COMPANION_LOG"
FOCUSED_STDOUT=$(mktemp /tmp/focused-stdout.XXXXXX)
timeout 10s bash -c "
FRESHELL_VITEST_BACKEND=cloud \
FRESHELL_VITEST_CLOUD_SCRIPT='$FAKE_CLOUD' \
FRESHELL_VITEST_COMPANION_SCRIPT='$FAKE_COMPANION' \
pnpm exec tsx scripts/run-standard-tests.ts --mode desktop test/unit/lib/pane-utils.test.ts
" > "$FOCUSED_STDOUT" 2>&1 || true

check "focused run still dispatches to the cloud shards" \
  grep -q 'FAKE_VITEST_CLOUD' "$FAKE_CLOUD_LOG"
if grep -q 'FAKE_COMPANION' "$FAKE_COMPANION_LOG" 2>/dev/null; then
  echo "FAIL: focused client run should NOT invoke the local companion"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: focused client run does not invoke the local companion"
fi
check "focused run announces the companion skip" \
  grep -q 'Local companion skipped' "$FOCUSED_STDOUT"
rm -f "$FOCUSED_STDOUT"

# --- Check block 3: the off switch disables the companion with a loud warning.
rm -f "$FAKE_CLOUD_LOG" "$FAKE_COMPANION_LOG"; touch "$FAKE_CLOUD_LOG" "$FAKE_COMPANION_LOG"
OFF_STDOUT=$(mktemp /tmp/off-stdout.XXXXXX)
timeout 10s bash -c "
FRESHELL_VITEST_BACKEND=cloud \
FRESHELL_VITEST_LOCAL_COMPANION=off \
FRESHELL_VITEST_CLOUD_SCRIPT='$FAKE_CLOUD' \
FRESHELL_VITEST_COMPANION_SCRIPT='$FAKE_COMPANION' \
pnpm exec tsx scripts/run-standard-tests.ts --mode desktop
" > "$OFF_STDOUT" 2>&1 || true

check "off switch still dispatches to the cloud shards" \
  grep -q 'FAKE_VITEST_CLOUD' "$FAKE_CLOUD_LOG"
if grep -q 'FAKE_COMPANION' "$FAKE_COMPANION_LOG" 2>/dev/null; then
  echo "FAIL: FRESHELL_VITEST_LOCAL_COMPANION=off should NOT invoke the companion"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: FRESHELL_VITEST_LOCAL_COMPANION=off does not invoke the companion"
fi
check "off switch warns that green does not cover the local-only tests" \
  grep -q 'Local companion disabled' "$OFF_STDOUT"
rm -f "$OFF_STDOUT"

# --- Check block 4: FRESHELL_VITEST_BACKEND=local invokes neither fake.
# Use a timeout — the local path runs the full test suite which takes minutes.
# We only need to verify the fakes were NOT invoked (checked after the timeout).
rm -f "$FAKE_CLOUD_LOG" "$FAKE_COMPANION_LOG"; touch "$FAKE_CLOUD_LOG" "$FAKE_COMPANION_LOG"
timeout 10s bash -c "
FRESHELL_VITEST_BACKEND=local \
FRESHELL_VITEST_CLOUD_SCRIPT='$FAKE_CLOUD' \
FRESHELL_VITEST_COMPANION_SCRIPT='$FAKE_COMPANION' \
pnpm exec tsx scripts/run-standard-tests.ts --mode desktop
" > /dev/null 2>&1 || true

if grep -q 'FAKE_VITEST_CLOUD' "$FAKE_CLOUD_LOG" 2>/dev/null; then
  echo "FAIL: FRESHELL_VITEST_BACKEND=local should NOT invoke vitest-cloud.sh"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: FRESHELL_VITEST_BACKEND=local does not invoke vitest-cloud.sh"
fi
if grep -q 'FAKE_COMPANION' "$FAKE_COMPANION_LOG" 2>/dev/null; then
  echo "FAIL: FRESHELL_VITEST_BACKEND=local should NOT invoke the companion"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: FRESHELL_VITEST_BACKEND=local does not invoke the companion"
fi

# Cleanup
rm -f "$FAKE_CLOUD" "$FAKE_COMPANION" "$FAKE_CLOUD_LOG" "$FAKE_COMPANION_LOG"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
