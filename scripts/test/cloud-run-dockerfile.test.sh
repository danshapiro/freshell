#!/usr/bin/env bash
# Test: Cloud Run Docker image builds and can run Playwright tests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

IMAGE_TAG="freshell-e2e:test"

echo "=== Cloud Run Docker Image Test ==="

# Check 1: Dockerfile exists
if [ ! -f "docker/cloud-run/Dockerfile" ]; then
  echo "FAIL: docker/cloud-run/Dockerfile does not exist"
  exit 1
fi
echo "PASS: Dockerfile exists"

# Check 2: entrypoint exists
if [ ! -f "docker/cloud-run/entrypoint.sh" ]; then
  echo "FAIL: docker/cloud-run/entrypoint.sh does not exist"
  exit 1
fi
echo "PASS: entrypoint.sh exists"

# Check 3: .dockerignore exists
if [ ! -f ".dockerignore" ]; then
  echo "FAIL: .dockerignore does not exist"
  exit 1
fi
echo "PASS: .dockerignore exists"

# Check 4: Build the image
echo "Building Docker image (this may take a while)..."
docker build -f docker/cloud-run/Dockerfile -t "$IMAGE_TAG" . || {
  echo "FAIL: docker build failed"
  exit 1
}
echo "PASS: docker build succeeded"

# Check 5: Run auth smoke test in container
echo "Running auth smoke test in container..."
RUN_OUTPUT=$(docker run --rm "$IMAGE_TAG" --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: docker run failed"
  echo "$RUN_OUTPUT" | tail -30
  exit 1
}

if ! echo "$RUN_OUTPUT" | grep -q "6 passed"; then
  echo "FAIL: expected '6 passed' in output"
  echo "$RUN_OUTPUT" | tail -30
  exit 1
fi
echo "PASS: auth smoke test passed (6 passed)"

# Check 6: Sharding works
echo "Testing shard 1 of 2..."
SHARD1_OUTPUT=$(docker run --rm -e CLOUD_RUN_TASK_INDEX=0 -e CLOUD_RUN_TASK_COUNT=2 "$IMAGE_TAG" --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: shard 1 run failed"
  echo "$SHARD1_OUTPUT" | tail -30
  exit 1
}
echo "PASS: shard 1/2 completed"

echo "Testing shard 2 of 2..."
SHARD2_OUTPUT=$(docker run --rm -e CLOUD_RUN_TASK_INDEX=1 -e CLOUD_RUN_TASK_COUNT=2 "$IMAGE_TAG" --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: shard 2 run failed"
  echo "$SHARD2_OUTPUT" | tail -30
  exit 1
}
echo "PASS: shard 2/2 completed"

echo ""
echo "=== All checks passed ==="
