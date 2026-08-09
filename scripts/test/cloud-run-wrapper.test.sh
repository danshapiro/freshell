#!/usr/bin/env bash
# Test: e2e-cloud wrapper script and npm script integration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

SCRIPT="$ROOT/scripts/e2e-cloud.sh"

echo "=== Cloud Run Wrapper Script Test ==="

# Check 1: Script exists
if [ ! -f "$SCRIPT" ]; then
  echo "FAIL: scripts/e2e-cloud.sh does not exist"
  exit 1
fi
echo "PASS: script exists"

# Check 2: Script is executable
if [ ! -x "$SCRIPT" ]; then
  echo "FAIL: scripts/e2e-cloud.sh is not executable"
  exit 1
fi
echo "PASS: script is executable"

# Check 3: help subcommand
echo "Testing: scripts/e2e-cloud.sh help"
HELP_OUTPUT=$("$SCRIPT" help 2>&1) || {
  echo "FAIL: help subcommand failed"
  echo "$HELP_OUTPUT"
  exit 1
}

if ! echo "$HELP_OUTPUT" | grep -qi "usage"; then
  echo "FAIL: help output does not contain 'usage'"
  echo "$HELP_OUTPUT"
  exit 1
fi
echo "PASS: help contains 'usage'"

if ! echo "$HELP_OUTPUT" | grep -qi "run"; then
  echo "FAIL: help output does not contain 'run'"
  exit 1
fi
echo "PASS: help contains 'run'"

if ! echo "$HELP_OUTPUT" | grep -qi -- "--local"; then
  echo "FAIL: help output does not contain '--local'"
  exit 1
fi
echo "PASS: help contains '--local'"

# Check 4: --local flag runs tests locally
echo "Testing: scripts/e2e-cloud.sh run --local --project=chromium auth.spec.ts"
LOCAL_OUTPUT=$("$SCRIPT" run --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: --local run failed"
  echo "$LOCAL_OUTPUT" | tail -20
  exit 1
}

if ! echo "$LOCAL_OUTPUT" | grep -q "6 passed"; then
  echo "FAIL: expected '6 passed' in --local output"
  echo "$LOCAL_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: --local runs 6 auth tests"

# Check 5: npm run test:e2e -- --local works
echo "Testing: npm run test:e2e -- --local"
NPM_LOCAL_OUTPUT=$(npm run test:e2e -- --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: npm run test:e2e -- --local failed"
  echo "$NPM_LOCAL_OUTPUT" | tail -20
  exit 1
}
echo "PASS: npm run test:e2e -- --local works"

# Check 6: npm run test:e2e:local works
echo "Testing: npm run test:e2e:local"
NPM_LOCAL_SCRIPT_OUTPUT=$(npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: npm run test:e2e:local failed"
  echo "$NPM_LOCAL_SCRIPT_OUTPUT" | tail -20
  exit 1
}
echo "PASS: npm run test:e2e:local works"

# Check 7: existing scripts still work
echo "Testing: npm run test:e2e:chromium (unchanged)"
CHROMIUM_OUTPUT=$(npm run test:e2e:chromium -- test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: npm run test:e2e:chromium failed"
  echo "$CHROMIUM_OUTPUT" | tail -20
  exit 1
}
echo "PASS: npm run test:e2e:chromium still works"

# Check 8: help mentions --cloud and FRESHELL_E2E_BACKEND
echo "Testing: help mentions --cloud flag"
if ! echo "$HELP_OUTPUT" | grep -qi -- "--cloud"; then
  echo "FAIL: help output does not contain '--cloud'"
  echo "$HELP_OUTPUT"
  exit 1
fi
echo "PASS: help contains '--cloud'"

echo "Testing: help mentions FRESHELL_E2E_BACKEND"
if ! echo "$HELP_OUTPUT" | grep -qi "FRESHELL_E2E_BACKEND"; then
  echo "FAIL: help output does not contain 'FRESHELL_E2E_BACKEND'"
  echo "$HELP_OUTPUT"
  exit 1
fi
echo "PASS: help contains 'FRESHELL_E2E_BACKEND'"

# Check 9: default backend (unset env var) runs locally
echo "Testing: default backend (unset FRESHELL_E2E_BACKEND) runs locally"
DEFAULT_OUTPUT=$(env -u FRESHELL_E2E_BACKEND "$SCRIPT" run --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: default run failed"
  echo "$DEFAULT_OUTPUT" | tail -20
  exit 1
}
if ! echo "$DEFAULT_OUTPUT" | grep -q "Running locally"; then
  echo "FAIL: expected 'Running locally' in default output"
  echo "$DEFAULT_OUTPUT" | tail -20
  exit 1
fi
if ! echo "$DEFAULT_OUTPUT" | grep -q "6 passed"; then
  echo "FAIL: expected '6 passed' in default output"
  echo "$DEFAULT_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: default backend (unset) runs locally"

# Check 10: FRESHELL_E2E_BACKEND=local runs locally
echo "Testing: FRESHELL_E2E_BACKEND=local runs locally"
LOCAL_ENV_OUTPUT=$(FRESHELL_E2E_BACKEND=local "$SCRIPT" run --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: FRESHELL_E2E_BACKEND=local run failed"
  echo "$LOCAL_ENV_OUTPUT" | tail -20
  exit 1
}
if ! echo "$LOCAL_ENV_OUTPUT" | grep -q "Running locally"; then
  echo "FAIL: expected 'Running locally' with FRESHELL_E2E_BACKEND=local"
  echo "$LOCAL_ENV_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: FRESHELL_E2E_BACKEND=local runs locally"

# Check 11: --cloud flag overrides FRESHELL_E2E_BACKEND=local
echo "Testing: --cloud flag is rejected without gcloud (override works)"
# We can't actually run cloud tests here, but we can verify the flag is
# parsed by checking that it does NOT print "Running locally"
CLOUD_FLAG_OUTPUT=$(FRESHELL_E2E_BACKEND=local "$SCRIPT" run --cloud --project=chromium test/e2e-browser/specs/auth.spec.ts 2>&1 || true)
if echo "$CLOUD_FLAG_OUTPUT" | grep -q "Running locally"; then
  echo "FAIL: --cloud flag was ignored (printed 'Running locally')"
  echo "$CLOUD_FLAG_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: --cloud flag overrides FRESHELL_E2E_BACKEND=local"

echo ""
echo "=== All checks passed ==="
