#!/usr/bin/env bash
# Entrypoint for the Cloud Run e2e image.
#
# Translates Cloud Run task indexing env vars into a duration-aware spec-file
# shard assignment, then execs playwright test with the cloud config and any
# pass-through args.
#
# When CLOUD_RUN_TASK_COUNT > 1, instead of Playwright's count-based --shard
# round-robin (which ignores per-test duration and produces severe imbalance),
# the entrypoint:
#   1. Discovers which spec files will run (via `playwright test --list`,
#      respecting --project filters and positional spec args).
#   2. Looks up an estimated duration for each spec file from
#      docker/cloud-run/test-durations.txt (default 30s if absent).
#   3. Greedy-assigns spec files to shards: sort by duration descending,
#      assign each to the shard with the least estimated total so far.
#   4. Runs only this shard's assigned spec files as positional args.
#
# When CLOUD_RUN_TASK_COUNT == 1, runs all tests (no sharding).
#
# Args can be passed two ways:
# 1. As container args (docker run ... --project=chromium auth.spec.ts)
# 2. Via PLAYWRIGHT_ARGS env var (space-separated, for Cloud Run Jobs where
#    --args uses comma separators that conflict with Playwright arg values)
#
# If both are present, they are combined.
#
# --dry-run: print the full shard assignment for all shards without executing
# Playwright. Pass as a container arg or in PLAYWRIGHT_ARGS.
set -euo pipefail

# Cloud Run sets CLOUD_RUN_TASK_INDEX (0-based) and CLOUD_RUN_TASK_COUNT
# when the job is configured with --tasks > 1.
TASK_INDEX="${CLOUD_RUN_TASK_INDEX:-0}"
TASK_COUNT="${CLOUD_RUN_TASK_COUNT:-1}"

CONFIG="test/e2e-browser/playwright.cloud.config.ts"
SPECS_DIR="test/e2e-browser/specs"
DURATIONS_FILE="docker/cloud-run/test-durations.txt"
DEFAULT_DURATION=30

# ---------------------------------------------------------------------------
# Parse args: separate flags from spec-path filters, intercept --dry-run.
# ---------------------------------------------------------------------------
DRY_RUN=false
FLAGS=()
SPEC_FILTERS=()

# From PLAYWRIGHT_ARGS env (space-separated).
if [ -n "${PLAYWRIGHT_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  for arg in $PLAYWRIGHT_ARGS; do
    case "$arg" in
      --dry-run) DRY_RUN=true ;;
      --shard=*) ;;  # strip stale shard flags (entrypoint handles sharding)
      -*) FLAGS+=("$arg") ;;
      *) SPEC_FILTERS+=("$arg") ;;
    esac
  done
fi

# From container args ($@).
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --shard=*) ;;  # strip stale shard flags
    -*) FLAGS+=("$arg") ;;
    *) SPEC_FILTERS+=("$arg") ;;
  esac
done

# ---------------------------------------------------------------------------
# Single-task: run everything (current behaviour, no sharding).
# ---------------------------------------------------------------------------
if [ "$TASK_COUNT" -eq 1 ]; then
  if $DRY_RUN; then
    echo "[e2e-entrypoint] Dry-run: single task (no sharding)"
    echo "[e2e-entrypoint] Would run all tests with flags: ${FLAGS[*]-} ${SPEC_FILTERS[*]-}"
    exit 0
  fi
  echo "[e2e-entrypoint] Running all tests (single task)"
  echo "[e2e-entrypoint] Playwright args: ${FLAGS[*]-} ${SPEC_FILTERS[*]-}"
  exec npx playwright test --config "$CONFIG" "${FLAGS[@]}" "${SPEC_FILTERS[@]}"
fi

# ---------------------------------------------------------------------------
# Multi-task: duration-aware spec-file shard assignment.
# ---------------------------------------------------------------------------
SHARD=$((TASK_INDEX + 1))
echo "[e2e-entrypoint] Duration-aware shard ${SHARD}/${TASK_COUNT}"

# 1. Discover spec files that will actually run (respects --project, grep,
#    and positional spec-path filters). Falls back to globbing if --list fails.
echo "[e2e-entrypoint] Discovering spec files via --list..."
LIST_OUTPUT=$(npx playwright test --config "$CONFIG" --list \
  "${FLAGS[@]}" "${SPEC_FILTERS[@]}" 2>/dev/null || true)

if [ -n "$LIST_OUTPUT" ]; then
  # Extract unique spec basenames from lines like:
  #   "  [chromium] › auth.spec.ts:4:3 › ..."
  mapfile -t SPEC_NAMES < <(
    echo "$LIST_OUTPUT" | sed -n 's/.*› \([^:]*\.spec\.ts\):.*/\1/p' | sort -u
  )
else
  echo "[e2e-entrypoint] --list produced no output, falling back to glob"
  mapfile -t SPEC_NAMES < <(
    ls "$SPECS_DIR"/*.spec.ts 2>/dev/null | xargs -n1 basename 2>/dev/null | sort
  )
fi

SPEC_COUNT="${#SPEC_NAMES[@]}"
if [ "$SPEC_COUNT" -eq 0 ]; then
  echo "[e2e-entrypoint] No spec files found. Running all tests."
  exec npx playwright test --config "$CONFIG" "${FLAGS[@]}" "${SPEC_FILTERS[@]}"
fi
echo "[e2e-entrypoint] Found ${SPEC_COUNT} spec files"

# 2. Load duration estimates into an associative array.
declare -A DURATIONS
if [ -f "$DURATIONS_FILE" ]; then
  while IFS=':' read -r name seconds; do
    case "$name" in
      ''|'#'*|[[:space:]]#*) continue ;;
    esac
    # Trim leading/trailing whitespace.
    name="${name#"${name%%[![:space:]]*}"}"
    name="${name%"${name##*[![:space:]]}"}"
    seconds="${seconds#"${seconds%%[![:space:]]*}"}"
    seconds="${seconds%"${seconds##*[![:space:]]}"}"
    if [ -n "$name" ] && [ -n "$seconds" ]; then
      DURATIONS["$name"]="$seconds"
    fi
  done < "$DURATIONS_FILE"
else
  echo "[e2e-entrypoint] Warning: durations file not found ($DURATIONS_FILE), using default ${DEFAULT_DURATION}s"
fi

# 3. Build "duration basename" pairs, sort by duration descending.
PAIRS=""
for spec in "${SPEC_NAMES[@]}"; do
  dur="${DURATIONS[$spec]:-$DEFAULT_DURATION}"
  PAIRS+="${dur} ${spec}"$'\n'
done
SORTED_PAIRS=$(printf '%s' "$PAIRS" | sort -rn)

# 4. Greedy assignment: each spec (duration desc) → least-loaded shard.
#    shard_totals[i]  = accumulated estimated seconds for shard i
#    shard_specs[i]   = space-separated spec basenames for shard i
declare -a shard_totals=()
declare -a shard_specs=()
for ((i = 0; i < TASK_COUNT; i++)); do
  shard_totals[$i]=0
  shard_specs[$i]=""
done

while read -r dur spec; do
  [ -z "$spec" ] && continue
  # Find the shard with the minimum accumulated total.
  min_shard=0
  min_total=${shard_totals[0]}
  for ((i = 1; i < TASK_COUNT; i++)); do
    if [ "${shard_totals[$i]}" -lt "$min_total" ]; then
      min_shard=$i
      min_total=${shard_totals[$i]}
    fi
  done
  shard_totals[$min_shard]=$(( min_total + dur ))
  if [ -z "${shard_specs[$min_shard]}" ]; then
    shard_specs[$min_shard]="$spec"
  else
    shard_specs[$min_shard]="${shard_specs[$min_shard]} $spec"
  fi
done <<< "$SORTED_PAIRS"

# 5. Dry-run: print the full assignment table for all shards, then exit.
if $DRY_RUN; then
  echo ""
  echo "[e2e-entrypoint] Dry-run: ${SPEC_COUNT} specs across ${TASK_COUNT} shards"
  echo ""
  for ((i = 0; i < TASK_COUNT; i++)); do
    echo "=== Shard $((i + 1))/${TASK_COUNT}  (est. ${shard_totals[$i]}s) ==="
    for spec in ${shard_specs[$i]}; do
      echo "  ${spec}  (${DURATIONS[$spec]:-$DEFAULT_DURATION}s)"
    done
    echo ""
  done
  exit 0
fi

# 6. This shard's assignment.
MY_SPECS="${shard_specs[$TASK_INDEX]:-}"
echo "[e2e-entrypoint] Shard ${SHARD}/${TASK_COUNT} assignment (est. ${shard_totals[$TASK_INDEX]}s):"
for spec in $MY_SPECS; do
  echo "  ${spec}  (${DURATIONS[$spec]:-$DEFAULT_DURATION}s)"
done

# 7. If this shard got no specs, exit cleanly (nothing to run).
if [ -z "$MY_SPECS" ]; then
  echo "[e2e-entrypoint] No specs assigned to this shard. Exiting."
  exit 0
fi

# 8. Run this shard's specs as explicit file paths (avoids Playwright's
#    substring filter ambiguity between similarly-named specs).
read -ra MY_SPEC_PATHS <<< "$MY_SPECS"
for i in "${!MY_SPEC_PATHS[@]}"; do
  MY_SPEC_PATHS[$i]="${SPECS_DIR}/${MY_SPEC_PATHS[$i]}"
done

echo "[e2e-entrypoint] Playwright flags: ${FLAGS[*]-}"
echo "[e2e-entrypoint] Exec: npx playwright test --config ${CONFIG} ${FLAGS[*]-} ${MY_SPEC_PATHS[*]}"

exec npx playwright test --config "$CONFIG" "${FLAGS[@]}" "${MY_SPEC_PATHS[@]}"
