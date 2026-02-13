#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REPORT_DIR="${HOME}/.freshell/reports/weekly"
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

PROD_AUDIT_RC="$(run_capture "npm audit --omit=dev --json" "${BASE}-audit-prod.json")"
FULL_AUDIT_RC="$(run_capture "npm audit --json" "${BASE}-audit-full.json")"
OUTDATED_RC="$(run_capture "npm outdated --json" "${BASE}-outdated.json")"

summary_file="${BASE}-summary.md"
{
  echo "# Freshell Weekly Security Report"
  echo
  echo "- Generated: $(date -u +"%Y-%m-%d %H:%M:%SZ")"
  echo "- Repo: $ROOT_DIR"
  echo "- prod audit rc: $PROD_AUDIT_RC"
  echo "- full audit rc: $FULL_AUDIT_RC"
  echo "- outdated rc: $OUTDATED_RC"
  echo
  echo "## Files"
  echo "- ${BASE}-audit-prod.json"
  echo "- ${BASE}-audit-full.json"
  echo "- ${BASE}-outdated.json"
} > "$summary_file"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] weekly report: $summary_file" >> "$LOG_DIR/security-weekly.log"
