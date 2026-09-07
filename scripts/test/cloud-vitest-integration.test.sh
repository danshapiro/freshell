#!/usr/bin/env bash
# Test: cloud-vitest-integration — verify FRESHELL_VITEST_BACKEND dispatch in
# run-standard-tests.ts, npm scripts, and AGENTS.md documentation.
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

# Check 1: run-standard-tests.ts contains FRESHELL_VITEST_BACKEND reference
check "run-standard-tests.ts references FRESHELL_VITEST_BACKEND" \
  grep -q 'FRESHELL_VITEST_BACKEND' scripts/run-standard-tests.ts

# Check 2: run-standard-tests.ts contains FRESHELL_VITEST_CLOUD_SCRIPT reference (injection point)
check "run-standard-tests.ts references FRESHELL_VITEST_CLOUD_SCRIPT" \
  grep -q 'FRESHELL_VITEST_CLOUD_SCRIPT' scripts/run-standard-tests.ts

# Check 3: run-standard-tests.ts contains vitest-cloud.sh reference (default path)
check "run-standard-tests.ts references vitest-cloud.sh" \
  grep -q 'vitest-cloud.sh' scripts/run-standard-tests.ts

# Check 4: package.json contains test:cloud script
check "package.json contains test:cloud" \
  grep -q '"test:cloud"' package.json

# Check 5: package.json contains test:cloud:build script
check "package.json contains test:cloud:build" \
  grep -q '"test:cloud:build"' package.json

# Check 6: AGENTS.md mentions FRESHELL_VITEST_BACKEND
check "AGENTS.md mentions FRESHELL_VITEST_BACKEND" \
  grep -q 'FRESHELL_VITEST_BACKEND' AGENTS.md

# Check 7: Process-level test — fake vitest-cloud.sh invoked when FRESHELL_VITEST_BACKEND=cloud
FAKE_SCRIPT=$(mktemp /tmp/fake-vitest-cloud.XXXXXX.sh)
cat > "$FAKE_SCRIPT" << 'FAKE'
#!/usr/bin/env bash
echo "FAKE_VITEST_CLOUD: $@" >> "${FAKE_CLOUD_LOG:-/dev/null}"
exit 0
FAKE
chmod +x "$FAKE_SCRIPT"

export FAKE_CLOUD_LOG=$(mktemp /tmp/fake-cloud-log.XXXXXX)
touch "$FAKE_CLOUD_LOG"

# Run with FRESHELL_VITEST_BACKEND=cloud and the fake script.
# Use a timeout — after the fake exits 0, the code runs the electron suite
# locally (which takes minutes). We only need to verify the fake was invoked.
# Capture stdout to also verify the electron fallback was attempted.
CLOUD_STDOUT=$(mktemp /tmp/cloud-stdout.XXXXXX)
timeout 10s bash -c "
FRESHELL_VITEST_BACKEND=cloud \
FRESHELL_VITEST_CLOUD_SCRIPT='$FAKE_SCRIPT' \
npx tsx scripts/run-standard-tests.ts --mode desktop
" > "$CLOUD_STDOUT" 2>&1 || true

check "fake vitest-cloud.sh was invoked" grep -q 'FAKE_VITEST_CLOUD' "$FAKE_CLOUD_LOG"
check "fake was called with 'run'" grep -q 'run' "$FAKE_CLOUD_LOG"

# Check 7b: Electron fallback was attempted after cloud dispatch
# The run-standard-tests.ts logs "Running electron suite locally after cloud dispatch"
check "electron fallback attempted after cloud dispatch" \
  grep -q 'electron' "$CLOUD_STDOUT"
rm -f "$CLOUD_STDOUT"

# Check 7c: Port contract suite is included in the cloud-backend local section
# The cloud branch blocks on the electron execFileSync for minutes, so the
# port log line (emitted after electron returns) is not captured by the
# timeout-bounded process-level test above. A static source check guards
# against deletion or misconfiguration of the port block in the cloud path.
check "run-standard-tests.ts cloud path includes port contract suite" \
  grep -q 'Running port contract suite locally after cloud dispatch' scripts/run-standard-tests.ts

# Check 8: FRESHELL_VITEST_BACKEND=local does NOT invoke vitest-cloud.sh
# Use a timeout — the local path runs the full test suite which takes minutes.
# We only need to verify the fake was NOT invoked (checked after the timeout).
rm -f "$FAKE_CLOUD_LOG"; touch "$FAKE_CLOUD_LOG"
timeout 10s bash -c "
FRESHELL_VITEST_BACKEND=local \
FRESHELL_VITEST_CLOUD_SCRIPT='$FAKE_SCRIPT' \
npx tsx scripts/run-standard-tests.ts --mode desktop
" > /dev/null 2>&1 || true

if grep -q 'FAKE_VITEST_CLOUD' "$FAKE_CLOUD_LOG" 2>/dev/null; then
  echo "FAIL: FRESHELL_VITEST_BACKEND=local should NOT invoke vitest-cloud.sh"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: FRESHELL_VITEST_BACKEND=local does not invoke vitest-cloud.sh"
fi

# Cleanup
rm -f "$FAKE_SCRIPT" "$FAKE_CLOUD_LOG"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
