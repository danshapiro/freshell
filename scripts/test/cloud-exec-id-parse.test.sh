#!/usr/bin/env bash
# Test: cloud-exec-id-parse — regression for execution-ID capture from both
# `gcloud run jobs execute --wait` and `--async` output.
#
# gcloud prints "Execution [NAME] has successfully completed." (brackets are
# literal around the name, ANSI SGR codes around it on color-capable output).
# Both wrappers previously parsed with `grep -oP 'Execution \K[^ ]+'`, which
# captured the leading "[" (and ANSI escapes), making every downstream
# describe/logs call address a nonexistent execution:
#   - vitest-cloud.sh: status queries all failed → green run reported failed
#     (observed live 2026-08-18, executions freshell-vitest-xzrwg/-ftrdv).
#   - e2e-cloud.sh: `|| echo 0` masked the failure → wrapper always reported
#     success with succeeded=0, masking real task failures.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

# gcloud-robot hermeticity pin (skill trap 11): the wrappers now carry a live
# identity ladder. Pinning GCLOUD_IDENT forces the ladder's rung-2 bypass, so
# no wrapper invocation from this suite can reach the real probe/network —
# even if the harness environment happens to export GCLOUD_ROBOT_HOME. The
# value is deliberately fake; nothing in this suite depends on it.
export GCLOUD_IDENT="suite-pinned-identity@example.invalid"

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

echo "=== Cloud execution-ID parse regression test ==="

FAKE_DIR=$(mktemp -d)
trap 'rm -rf "$FAKE_DIR"' EXIT
export FAKE_LOG="$FAKE_DIR/gcloud.log"
touch "$FAKE_LOG"

cat > "$FAKE_DIR/gcloud" << 'FAKE'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "$FAKE_LOG"
# Mimic gcloud's accepted execution output with literal brackets and ANSI
# SGR codes around the name (gcloud 581.0.0).
if [[ "$*" == *"run jobs execute"* ]]; then
  if [[ "$*" == *" --async"* ]]; then
    printf 'Execution [\033[1mtest-exec-123\033[m] is being started asynchronously.\n'
  else
    printf 'Creating execution...\nExecution [\033[1mtest-exec-123\033[m] has successfully completed.\n'
  fi
  exit 0
fi
if [[ "$*" == *"executions describe"* ]]; then
  if [[ "$*" == *"completionTime"* ]]; then
    if [[ -s "${FRESHELL_E2E_CLOUD_DISPATCH_RECEIPT:-/nonexistent}" ]]; then
      echo "dispatch receipt available before completion wait" >> "$FAKE_LOG"
    fi
    echo "2026-10-12T00:00:00Z"
    exit 0
  fi
  if [[ "$*" == *"succeededCount"* ]]; then
    # Report every requested shard as succeeded (vitest passes per-execution
    # --tasks=N; e2e creates the job with --tasks=N). The wrappers require
    # succeeded == shards, so the stub must satisfy that to stay green.
    N=$(grep -oP -- '--tasks=\K[0-9]+' "$FAKE_LOG" | tail -1)
    echo "${N:-1}"
  else
    echo "0"
  fi
  exit 0
fi
if [[ "$*" == *"executions list"* ]]; then echo "test-exec-123"; exit 0; fi
if [[ "$*" == *"logs read"* ]]; then echo "Test Files  1 passed (1)"; exit 0; fi
if [[ "$*" == *"logging read"* ]]; then
  # One zero-retry completion receipt per task, as Cloud Logging would return
  # for the single-task execution this stub reports above. Without this
  # branch the e2e wrapper's structured-receipt reconciliation fails closed
  # before the exec-id-parse behavior under test ever runs.
  printf '[{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"test-exec-123","taskIndex":0,"taskCount":1,"recoveredRetryCount":0}}]\n'
  exit 0
fi
if [[ "$*" == *"artifacts docker images describe"* ]] || [[ "$*" == *"artifacts repositories describe"* ]] || [[ "$*" == *"builds submit"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo "fake-token"; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo "/usr/lib/google-cloud-sdk"; exit 0; fi
if [[ "$*" == *"run jobs"* ]]; then exit 0; fi  # create/update
exit 0
FAKE
chmod +x "$FAKE_DIR/gcloud"
export PATH="$FAKE_DIR:$PATH"

# --- vitest wrapper ---
rm -f "$FAKE_LOG"; touch "$FAKE_LOG"
VITEST_OUT=$(bash "$ROOT/scripts/vitest-cloud.sh" run --cloud --config=default 2>&1) && VITEST_RC=0 || VITEST_RC=$?
check "vitest wrapper exits 0 on green run" bash -c "[ $VITEST_RC -eq 0 ]"
check "vitest wrapper prints success footer" grep -q "All tasks completed successfully" <<< "$VITEST_OUT"
# Downstream queries must address the clean id (no bracket/ANSI garbage).
check "vitest describe targets clean execution id" \
  bash -c "grep -q 'executions describe .* test-exec-123 ' '$FAKE_LOG' && ! grep -q 'executions describe .*\[' '$FAKE_LOG'"

# Confirm the Vitest wrapper still waits in its existing execution path.
check "vitest wrapper retains wait-for-completion execution mode" \
  grep -q 'run jobs execute .* --wait' "$FAKE_LOG"

# --- e2e wrapper ---
rm -f "$FAKE_LOG"; touch "$FAKE_LOG"
export FRESHELL_E2E_CLOUD_DISPATCH_RECEIPT="$FAKE_DIR/e2e-dispatch.json"
rm -f "$FRESHELL_E2E_CLOUD_DISPATCH_RECEIPT"
E2E_OUT=$(bash "$ROOT/scripts/e2e-cloud.sh" run --cloud --shards=1 2>&1) && E2E_RC=0 || E2E_RC=$?
check "e2e wrapper exits 0 on green run" bash -c "[ $E2E_RC -eq 0 ]"
check "e2e wrapper reports truthfully (succeeded=1)" grep -q "Succeeded tasks: 1" <<< "$E2E_OUT"
check "e2e describe targets clean execution id" \
  bash -c "grep -q 'executions describe .* test-exec-123 ' '$FAKE_LOG' && ! grep -q 'executions describe .*\[' '$FAKE_LOG'"
check "e2e execution uses asynchronous acceptance before its bounded completion wait" \
  bash -c "grep -q 'run jobs execute .* --async' '$FAKE_LOG' && grep -q 'dispatch receipt available before completion wait' '$FAKE_LOG'"
check "e2e wrapper records the exact accepted Cloud Run execution" \
  bash -c "jq -e '.jobName and .executionName == \"test-exec-123\" and (.acceptedAt | test(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$\"))' '$FRESHELL_E2E_CLOUD_DISPATCH_RECEIPT' >/dev/null"

check_duration() {
  local input="$1" expected="$2" actual
  actual=$(node "$ROOT/scripts/e2e-cloud-duration.mjs" "$input" 2>/dev/null) || return 1
  [[ "$actual" == "$expected" ]]
}

check_duration_rejected() {
  local input="$1"
  ! node "$ROOT/scripts/e2e-cloud-duration.mjs" "$input" >/dev/null 2>&1
}

check "cloud timeout parser accepts decimal hours" check_duration "1.5h" "5400"
check "cloud timeout parser rounds a fractional mixed duration up to whole seconds" \
  check_duration "1m30.5s" "91"
check "cloud timeout parser preserves gcloud's rounded one-second minimum" \
  check_duration "PT0.99995S" "1"
check "cloud timeout parser accepts ISO time durations" check_duration "PT1H" "3600"
check "cloud timeout parser accepts ISO day and time durations" check_duration "P1DT2H" "93600"
check "cloud timeout parser matches gcloud fractional-year normalization" \
  check_duration "P0.00016Y" "6308"
check "cloud timeout parser preserves gcloud's lower-side year half-way rounding" \
  check_duration "P0.00005Y" "3154"
check "cloud timeout parser preserves gcloud's lower-adjacent year half-way rounding" \
  check_duration "P0.00015Y" "3154"
check "cloud timeout parser preserves gcloud's upper-side year half-way rounding" \
  check_duration "P0.00025Y" "9470"
check "cloud timeout parser preserves gcloud's upper-adjacent year half-way rounding" \
  check_duration "P0.00035Y" "9470"
check "cloud timeout parser preserves gcloud's lower-side hour half-way rounding" \
  check_duration "1.00015h" "3601"
check "cloud timeout parser preserves gcloud's upper-side hour half-way rounding" \
  check_duration "1.00025h" "3602"
check "cloud timeout parser preserves gcloud's upper-adjacent hour half-way rounding" \
  check_duration "1.00035h" "3602"
check "cloud timeout parser matches gcloud fractional-month normalization" \
  check_duration "P0.1M" "259200"
check "cloud timeout parser rounds gcloud fractional-day normalization up safely" \
  check_duration "P0.00016D" "18"
check "cloud timeout parser rounds gcloud fractional-week normalization up safely" \
  check_duration "P0.00016W" "96"
check "cloud timeout parser treats a bare integer as seconds" check_duration "60" "60"
check "cloud timeout parser accepts whitespace around a bare integer" \
  check_duration " 60 " "60"
check "cloud timeout parser rejects calendar fractions that normalize below gcloud's minimum" \
  check_duration_rejected "P0.001M"

check_rejected_timeout_before_job() {
  local duration="$1" output
  : > "$FAKE_LOG"
  if output=$(bash "$ROOT/scripts/e2e-cloud.sh" run --cloud --shards=1 "--timeout=$duration" 2>&1); then
    return 1
  fi
  ! grep -q 'FAKE_GCLOUD: run jobs create' "$FAKE_LOG" \
    && ! grep -q 'FAKE_GCLOUD: run jobs execute' "$FAKE_LOG" \
    && grep -q 'unsupported Cloud Run task timeout duration' <<< "$output"
}

check "cloud timeout parser rejects malformed durations before creating a job" \
  check_rejected_timeout_before_job "1hbanana"
check "cloud timeout parser rejects zero seconds before creating a job" \
  check_rejected_timeout_before_job "0"
check "cloud timeout parser rejects zero ISO duration before creating a job" \
  check_rejected_timeout_before_job "PT0S"
check "cloud timeout parser rejects values below gcloud's one-second minimum before creating a job" \
  check_rejected_timeout_before_job "0.5s"
check "cloud timeout parser rejects durations beyond the safe wait bound before creating a job" \
  check_rejected_timeout_before_job "999999999999999999999999999999999999999s"
check "cloud timeout parser rejects calendar fractions below gcloud's minimum before creating a job" \
  check_rejected_timeout_before_job "P0.001M"

: > "$FAKE_LOG"
VALID_DECIMAL_OUT=$(bash "$ROOT/scripts/e2e-cloud.sh" run --cloud --shards=1 --timeout=1.5h 2>&1) && VALID_DECIMAL_RC=0 || VALID_DECIMAL_RC=$?
check "e2e wrapper accepts a decimal Cloud Run timeout" bash -c "[ $VALID_DECIMAL_RC -eq 0 ]"
check "e2e wrapper passes the accepted decimal timeout to Cloud Run" \
  grep -q 'run jobs create .* --task-timeout=1.5h' "$FAKE_LOG"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
