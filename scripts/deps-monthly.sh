#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REPORT_DIR="${HOME}/.freshell/reports/monthly"
LOG_DIR="${HOME}/.freshell/logs"
mkdir -p "$REPORT_DIR" "$LOG_DIR"

STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
BASE="${REPORT_DIR}/${STAMP}"

run_capture() {
  local cmd="$1"
  local out="$2"
  set +e
  bash -lc "$cmd" > "$out" 2>&1
  local rc=$?
  set -e
  echo "$rc"
}

OUTDATED_RC="$(run_capture "npm outdated --json" "${BASE}-outdated.json")"
PROD_AUDIT_RC="$(run_capture "npm audit --omit=dev --json" "${BASE}-audit-prod.json")"
FULL_AUDIT_RC="$(run_capture "npm audit --json" "${BASE}-audit-full.json")"

summary_file="${BASE}-summary.md"
{
  echo "# Freshell Monthly Dependency Report"
  echo
  echo "- Generated: $(date -u +"%Y-%m-%d %H:%M:%SZ")"
  echo "- Repo: $ROOT_DIR"
  echo "- outdated rc: $OUTDATED_RC"
  echo "- prod audit rc: $PROD_AUDIT_RC"
  echo "- full audit rc: $FULL_AUDIT_RC"
  echo
  echo "## Recommended Workflow"
  echo "1. Create test branch: deps/monthly-${STAMP}"
  echo "2. Run targeted upgrades for non-breaking items"
  echo "3. Run app smoke tests and policy checks"
  echo "4. Stage and review diffs before merge"
  echo
  echo "## Files"
  echo "- ${BASE}-outdated.json"
  echo "- ${BASE}-audit-prod.json"
  echo "- ${BASE}-audit-full.json"
} > "$summary_file"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] monthly report: $summary_file" >> "$LOG_DIR/deps-monthly.log"
