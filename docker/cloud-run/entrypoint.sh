#!/usr/bin/env bash
# Entrypoint for the Cloud Run e2e image.
#
# Translates Cloud Run task indexing env vars into Playwright --shard flags,
# then execs playwright test with the cloud config and any pass-through args.
#
# Args can be passed two ways:
# 1. As container args (docker run ... --project=chromium auth.spec.ts)
# 2. Via PLAYWRIGHT_ARGS env var (space-separated, for Cloud Run Jobs where
#    --args uses comma separators that conflict with Playwright arg values)
#
# If both are present, container args take precedence.
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

# Build the args array: shard flags + PLAYWRIGHT_ARGS (if set) + container args
PW_ARGS=()
if [ -n "${PLAYWRIGHT_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  PW_ARGS=($PLAYWRIGHT_ARGS)
fi

echo "[e2e-entrypoint] Playwright args: ${PW_ARGS[*]} $*"

exec npx playwright test \
  --config test/e2e-browser/playwright.cloud.config.ts \
  "${SHARD_ARGS[@]}" \
  "${PW_ARGS[@]}" \
  "$@"
