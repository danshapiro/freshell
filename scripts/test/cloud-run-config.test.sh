#!/usr/bin/env bash
# Test: Cloud Run Playwright config exists and has correct settings.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

CONFIG="test/e2e-browser/playwright.cloud.config.ts"

echo "=== Cloud Run Config Test ==="

# Check 1: Config file exists
if [ ! -f "$CONFIG" ]; then
  echo "FAIL: $CONFIG does not exist"
  exit 1
fi
echo "PASS: $CONFIG exists"

# Check 2: Config lists specs (non-empty)
echo "Running: playwright test --list with cloud config..."
LIST_OUTPUT=$(npx playwright test --config "$CONFIG" --list 2>&1) || {
  echo "FAIL: --list command failed"
  echo "$LIST_OUTPUT" | tail -20
  exit 1
}

if [ -z "$LIST_OUTPUT" ]; then
  echo "FAIL: --list output is empty"
  exit 1
fi
echo "PASS: --list produced output"

# Check 3: No firefox/webkit/continuity-smoke
if echo "$LIST_OUTPUT" | grep -qi "firefox"; then
  echo "FAIL: firefox project found in cloud config"
  exit 1
fi
echo "PASS: no firefox project"

if echo "$LIST_OUTPUT" | grep -qi "webkit"; then
  echo "FAIL: webkit project found in cloud config"
  exit 1
fi
echo "PASS: no webkit project"

if echo "$LIST_OUTPUT" | grep -qi "continuity-smoke"; then
  echo "FAIL: continuity-smoke project found in cloud config"
  exit 1
fi
echo "PASS: no continuity-smoke project"

# Check 4: No globalSetup build step triggered
if echo "$LIST_OUTPUT" | grep -q "\[e2e-setup\]"; then
  echo "FAIL: globalSetup build step was triggered (--list should not build)"
  exit 1
fi
echo "PASS: no globalSetup build step"

# Check 5: Sharding works
SHARD_OUTPUT=$(npx playwright test --config "$CONFIG" --list --shard=1/2 2>&1) || {
  echo "FAIL: --shard=1/2 list failed"
  echo "$SHARD_OUTPUT" | tail -20
  exit 1
}

TOTAL_COUNT=$(echo "$LIST_OUTPUT" | grep -c ".*")
SHARD_COUNT=$(echo "$SHARD_OUTPUT" | grep -c ".*")

if [ "$SHARD_COUNT" -ge "$TOTAL_COUNT" ]; then
  echo "FAIL: shard count ($SHARD_COUNT) should be less than total ($TOTAL_COUNT)"
  exit 1
fi
echo "PASS: sharding works (total=$TOTAL_COUNT, shard1/2=$SHARD_COUNT)"

echo ""
echo "=== All checks passed ==="
