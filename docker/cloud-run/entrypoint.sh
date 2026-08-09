#!/usr/bin/env bash
# Entrypoint for the Cloud Run e2e image.
#
# Translates Cloud Run task indexing env vars into Playwright --shard flags,
# then execs playwright test with the cloud config and any pass-through args.
set -euo pipefail

# Cloud Run sets CLOUD_RUN_TASK_INDEX (0-based) and CLOUD_RUN_TASK_COUNT
# when the job is configured with --tasks > 1.
TASK_INDEX="${CLOUD_RUN_TASK_INDEX:-0}"
TASK_COUNT="${CLOUD_RUN_TASK_COUNT:-1}"

SHARD_ARGS=()
if [ "$TASK_COUNT" -gt 1 ]; then
  SHARD=$((TASK_INDEX + 1))
  SHARD_ARGS=(--shard="${SHARD}/${TASK_COUNT}")
  echo "[e2e-entrypoint] Running shard ${SHARD}/${TASK_COUNT}"
else
  echo "[e2e-entrypoint] Running all tests (single task)"
fi

exec npx playwright test \
  --config test/e2e-browser/playwright.cloud.config.ts \
  "${SHARD_ARGS[@]}" \
  "$@"
