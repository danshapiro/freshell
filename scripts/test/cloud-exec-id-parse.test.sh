#!/usr/bin/env bash
# Test: cloud-exec-id-parse — regression for execution-ID capture from
# `gcloud run jobs execute --wait` output.
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
# Mimic current gcloud: "Execution [NAME] ..." with literal brackets and ANSI
# SGR codes around the name (observed ngcloud output 2026-08-18).
if [[ "$*" == *"run jobs execute"* ]]; then
  printf 'Creating execution...\nExecution [\033[1mtest-exec-123\033[m] has successfully completed.\n'
  exit 0
fi
if [[ "$*" == *"executions describe"* ]]; then
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
# Image lane: a small upload listing and an already-published image (by
# digest), so these runs reuse it and go straight to the job lifecycle.
if [[ "$*" == *"meta list-files-for-upload"* ]]; then printf '%s\n' package.json docker/cloud-run/cloudbuild.yaml; exit 0; fi
if [[ "$*" == *"artifacts docker images describe"* ]]; then printf 'sha256:%064d\n' 1; exit 0; fi
if [[ "$*" == *"artifacts repositories describe"* ]] || [[ "$*" == *"builds submit"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo "fake-token"; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo "/usr/lib/google-cloud-sdk"; exit 0; fi
if [[ "$*" == *"run jobs"* ]]; then exit 0; fi  # create/update
exit 0
FAKE
chmod +x "$FAKE_DIR/gcloud"
export PATH="$FAKE_DIR:$PATH"
# Keep the wrappers' same-machine image lock inside this suite's sandbox.
export FRESHELL_CLOUD_IMAGE_LOCK_DIR="$FAKE_DIR/locks"

# --- vitest wrapper ---
rm -f "$FAKE_LOG"; touch "$FAKE_LOG"
VITEST_OUT=$(bash "$ROOT/scripts/vitest-cloud.sh" run --cloud --config=default 2>&1) && VITEST_RC=0 || VITEST_RC=$?
check "vitest wrapper exits 0 on green run" bash -c "[ $VITEST_RC -eq 0 ]"
check "vitest wrapper prints success footer" grep -q "All tasks completed successfully" <<< "$VITEST_OUT"
# Downstream queries must address the clean id (no bracket/ANSI garbage).
check "vitest describe targets clean execution id" \
  bash -c "grep -q 'executions describe .* test-exec-123 ' '$FAKE_LOG' && ! grep -q 'executions describe .*\[' '$FAKE_LOG'"

# --- e2e wrapper ---
rm -f "$FAKE_LOG"; touch "$FAKE_LOG"
E2E_OUT=$(bash "$ROOT/scripts/e2e-cloud.sh" run --cloud --shards=1 2>&1) && E2E_RC=0 || E2E_RC=$?
check "e2e wrapper exits 0 on green run" bash -c "[ $E2E_RC -eq 0 ]"
check "e2e wrapper reports truthfully (succeeded=1)" grep -q "Succeeded tasks: 1" <<< "$E2E_OUT"
check "e2e describe targets clean execution id" \
  bash -c "grep -q 'executions describe .* test-exec-123 ' '$FAKE_LOG' && ! grep -q 'executions describe .*\[' '$FAKE_LOG'"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
