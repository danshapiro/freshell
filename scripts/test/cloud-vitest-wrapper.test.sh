#!/usr/bin/env bash
# Test: cloud-vitest-wrapper — verify vitest-cloud.sh exists and performs
# local/cloud dispatch with the intended backend selection, argv, retries,
# and exit statuses.
set -euo pipefail

# The agent shell exports BASH_ENV to load machine-specific gcloud settings.
# This harness needs its child Bash processes to keep the fake identity below.
unset BASH_ENV

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

# gcloud-robot hermeticity pin (skill trap 11): the wrappers now carry a live
# identity ladder. Pinning GCLOUD_IDENT forces the ladder's rung-2 bypass, so
# no wrapper invocation from this suite can reach the real probe/network —
# even if the harness environment happens to export GCLOUD_ROBOT_HOME. The
# value is deliberately fake; nothing in this suite depends on it.
export GCLOUD_IDENT="suite-pinned-identity@example.invalid"

SCRIPT="$ROOT/scripts/vitest-cloud.sh"

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

echo "=== Cloud Vitest Wrapper Test ==="

# Check 1: Script exists and is executable
check "scripts/vitest-cloud.sh exists and is executable" test -x "$SCRIPT"

# Check 3: Default backend (unset env var) runs locally
# Run with --local flag and a fast test to verify local execution works
LOCAL_OUTPUT=$(FRESHELL_VITEST_BACKEND= bash "$SCRIPT" run --local --config=default test/unit/lib/pane-utils.test.ts 2>&1 || true)
check "--local runs vitest locally" grep -q 'passed\|PASS\|Test Files' <<< "$LOCAL_OUTPUT"

# Check 4: FRESHELL_VITEST_BACKEND=local runs locally
LOCAL_ENV_OUTPUT=$(FRESHELL_VITEST_BACKEND=local bash "$SCRIPT" run --config=default test/unit/lib/pane-utils.test.ts 2>&1 || true)
check "FRESHELL_VITEST_BACKEND=local runs locally" grep -q 'passed\|PASS\|Test Files' <<< "$LOCAL_ENV_OUTPUT"

# Check 5: --cloud flag with fake gcloud — verify the wrapper calls gcloud
FAKE_GCLOUD_DIR=$(mktemp -d)
cat > "$FAKE_GCLOUD_DIR/gcloud" << 'FAKE'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
# Capture env-vars file content before it's deleted
for i in "$@"; do
  if [[ "$i" == --env-vars-file=* ]]; then
    envfile="${i#--env-vars-file=}"
    if [ -f "$envfile" ]; then
      cp "$envfile" "${FAKE_GCLOUD_LOG}.envvars"
    fi
  fi
done
# More specific patterns first; catch-all run jobs last
if [[ "$*" == *"artifacts docker images describe"* ]]; then
  exit 0
fi
if [[ "$*" == *"artifacts repositories describe"* ]]; then
  exit 0
fi
if [[ "$*" == *"auth print-access-token"* ]]; then
  echo "fake-token"
  exit 0
fi
if [[ "$*" == *"info"* ]]; then
  echo "/usr/lib/google-cloud-sdk"
  exit 0
fi
if [[ "$*" == *"logs read"* ]]; then
  echo "Test Files  1 passed (1)"
  exit 0
fi
if [[ "$*" == *"executions describe"* ]]; then
  echo "1"
  exit 0
fi
if [[ "$*" == *"executions list"* ]]; then
  echo "test-execution-1"
  exit 0
fi
if [[ "$*" == *"builds submit"* ]]; then
  exit 0
fi
# Catch-all for run jobs create/update/execute
if [[ "$*" == *"run jobs"* ]]; then
  exit 0
fi
exit 0
FAKE
chmod +x "$FAKE_GCLOUD_DIR/gcloud"

export FAKE_GCLOUD_LOG="$FAKE_GCLOUD_DIR/gcloud.log"
touch "$FAKE_GCLOUD_LOG"
export PATH="$FAKE_GCLOUD_DIR:$PATH"

CLOUD_OUTPUT=$(bash "$SCRIPT" run --cloud --config=default --shards=2 2>&1 || true)
check "--cloud calls gcloud (fake)" grep -q 'FAKE_GCLOUD' "$FAKE_GCLOUD_LOG"
check "--cloud references freshell-vitest job" grep -q 'freshell-vitest' "$FAKE_GCLOUD_LOG"

# Check 6: --config=default sets VITEST_CONFIGS to only default config
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
bash "$SCRIPT" run --cloud --config=default 2>&1 > /dev/null || true
check "--config=default sets correct config" grep -q 'vitest.config.ts' "$FAKE_GCLOUD_LOG"

# Check 7: the retired server selector is rejected with a Rust-lane hint
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
SERVER_OUTPUT=$(bash "$SCRIPT" run --cloud --config=server 2>&1) && SERVER_RC=0 || SERVER_RC=$?
check "--config=server exits with usage error" bash -c "[ '$SERVER_RC' -eq 2 ]"
check "--config=server explains the Rust lane" grep -qi 'Rust' <<< "$SERVER_OUTPUT"
check "--config=server does not create or execute a cloud job" bash -c "! grep -q 'run jobs' '$FAKE_GCLOUD_LOG'"

# Check 7b: an unknown config selector explains both accepted values.
UNKNOWN_OUTPUT=$(bash "$SCRIPT" run --local --config=unknown 2>&1) && UNKNOWN_RC=0 || UNKNOWN_RC=$?
check "unknown config selector exits with usage error" bash -c "[ '$UNKNOWN_RC' -eq 2 ]"
check "unknown config selector documents default and all" grep -q 'expected default or all' <<< "$UNKNOWN_OUTPUT"

# Check 8: VITEST_ARGS_JSON is valid JSON when pass-through args are present
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
bash "$SCRIPT" run --cloud --config=default test/unit/lib/pane-utils.test.ts 2>&1 > /dev/null || true
# Extract VITEST_ARGS_JSON from the --update-env-vars flag in the gcloud log
ENV_VARS_LINE=$(grep 'update-env-vars' "$FAKE_GCLOUD_LOG" | head -1 || true)
if [ -n "$ENV_VARS_LINE" ]; then
  # Extract the JSON array value after VITEST_ARGS_JSON= (non-greedy match for [...])
  VITEST_ARGS_VAL=$(echo "$ENV_VARS_LINE" | grep -oP 'VITEST_ARGS_JSON=\K\[.*?\]' || true)
  if [ -n "$VITEST_ARGS_VAL" ]; then
    check "VITEST_ARGS_JSON is valid JSON" bash -c "echo '$VITEST_ARGS_VAL' | jq -e '.' > /dev/null 2>&1"
  else
    echo "FAIL: VITEST_ARGS_JSON not found in --update-env-vars"
    FAILURES=$((FAILURES + 1))
  fi
else
  echo "FAIL: --update-env-vars not found in fake gcloud log"
  FAILURES=$((FAILURES + 1))
fi

# Check 9: TEST_MODE=vitest is set in --update-env-vars
if [ -n "$ENV_VARS_LINE" ]; then
  check "TEST_MODE=vitest set in --update-env-vars" grep -q 'TEST_MODE=vitest' <<< "$ENV_VARS_LINE"
else
  echo "FAIL: --update-env-vars not available for TEST_MODE check"
  FAILURES=$((FAILURES + 1))
fi

# Check 10: transient execution-status query failures are retried.
# Regression: a single flaky `gcloud run jobs executions describe` right after
# `execute --wait` completed must not fail an otherwise-green run (observed
# live 2026-08-18: execution succeeded on all shards, wrapper exited 1 because
# the status query errored once).
cat > "$FAKE_GCLOUD_DIR/gcloud" << 'FAKE2'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
if [[ "$*" == *"artifacts docker images describe"* ]] || [[ "$*" == *"artifacts repositories describe"* ]] || [[ "$*" == *"builds submit"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo "fake-token"; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo "/usr/lib/google-cloud-sdk"; exit 0; fi
if [[ "$*" == *"logs read"* ]]; then echo "Test Files  1 passed (1)"; exit 0; fi
if [[ "$*" == *"executions describe"* ]]; then
  if [[ "$*" == *"succeededCount"* ]]; then
    CC=$(cat "${FAKE_GCLOUD_LOG}.desccount" 2>/dev/null || echo 0); CC=$((CC+1)); echo "$CC" > "${FAKE_GCLOUD_LOG}.desccount"
    if [ "$CC" -le 2 ]; then exit 1; fi
    # Report every requested shard as succeeded (the wrapper must require
    # succeeded == shards, so the stub must satisfy that to stay green).
    N=$(grep -oP -- '--tasks=\K[0-9]+' "$FAKE_GCLOUD_LOG" | tail -1)
    echo "${N:-4}"
  else
    echo "0"   # zero failed shards
  fi
  exit 0
fi
if [[ "$*" == *"executions list"* ]]; then echo "test-execution-1"; exit 0; fi
if [[ "$*" == *"run jobs execute"* ]]; then echo "Execution test-execution-1"; exit 0; fi
if [[ "$*" == *"run jobs"* ]]; then exit 0; fi
exit 0
FAKE2
chmod +x "$FAKE_GCLOUD_DIR/gcloud"
rm -f "${FAKE_GCLOUD_LOG}.desccount"
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
check "transient describe failures retried (2 failures, then success)" bash -c "bash '$SCRIPT' run --cloud --config=default >/dev/null 2>&1"
check "describe was retried (>=3 describe calls logged)" bash -c "[ \$(grep -c 'executions describe' '$FAKE_GCLOUD_LOG') -ge 3 ]"

# Check 11: each cloud run uses its OWN unique Cloud Run job. A shared job is
# a concurrency hole: `gcloud run jobs execute` snapshots the job's CURRENT
# template, so a concurrent run's job update can swap the image of an
# in-flight run, and a later run's own settings race on the same resource.
# The run must create one job named <prefix>-<imagerag>-<random>, execute it,
# and delete it on every exit path.
cat > "$FAKE_GCLOUD_DIR/gcloud" << 'FAKE3'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
if [[ "$*" == *"artifacts docker images describe"* ]] || [[ "$*" == *"artifacts repositories describe"* ]] || [[ "$*" == *"builds submit"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo "fake-token"; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo "/usr/lib/google-cloud-sdk"; exit 0; fi
if [[ "$*" == *"logs read"* ]]; then echo "Test Files  1 passed (1)"; exit 0; fi
if [[ "$*" == *"executions describe"* ]]; then
  if [[ "$*" == *"succeededCount"* ]]; then
    N=$(grep -oP -- '--tasks=\K[0-9]+' "$FAKE_GCLOUD_LOG" | tail -1)
    echo "${N:-4}"
  else
    echo "0"
  fi
  exit 0
fi
if [[ "$*" == *"executions list"* ]]; then echo "test-execution-1"; exit 0; fi
if [[ "$*" == *"run jobs execute"* ]]; then echo "Execution [test-execution-1] has successfully completed."; exit 0; fi
if [[ "$*" == *"run jobs"* ]]; then exit 0; fi
exit 0
FAKE3
chmod +x "$FAKE_GCLOUD_DIR/gcloud"

rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
UNIQ_OUTPUT=$(bash "$SCRIPT" run --cloud --config=default 2>&1) || {
  echo "FAIL: unique-job cloud run errored"
  echo "$UNIQ_OUTPUT" | tail -5
  FAILURES=$((FAILURES + 1))
  UNIQ_OUTPUT=""
}
JOB1=$(grep -oP 'Job:\s+\K[a-z0-9-]+' <<< "$UNIQ_OUTPUT" | head -1 || true)
check "run header reports its unique Job name" bash -c "[ -n '${JOB1:-}' ]"
if [ -n "${JOB1:-}" ]; then
  check "job name is unique per run (prefix-imagetag-random)" \
    grep -qP '^freshell-vitest-[a-z0-9]{12}(-dirty)?-[a-z0-9]{6}$' <<< "$JOB1"
  check "create/execute/delete all target the run's own job" bash -c "
    grep -q 'run jobs create .* ${JOB1} ' '$FAKE_GCLOUD_LOG' &&
    grep -q 'run jobs execute .* ${JOB1} --tasks=' '$FAKE_GCLOUD_LOG' &&
    grep -q 'run jobs delete .* ${JOB1} --quiet' '$FAKE_GCLOUD_LOG'"
  check "no job update happens (the job is single-owner)" \
    bash -c "! grep -q 'run jobs update' '$FAKE_GCLOUD_LOG'"
  rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
  UNIQ2_OUTPUT=$(bash "$SCRIPT" run --cloud --config=default 2>&1 || true)
  JOB2=$(grep -oP 'Job:\s+\K[a-z0-9-]+' <<< "$UNIQ2_OUTPUT" | head -1 || true)
  check "a second run gets a different job name" \
    bash -c "[ -n '${JOB2:-}' ] && [ '${JOB1}' != '${JOB2:-}' ]"
fi

# Check 12: `gcloud run jobs execute` failing (quota, permissions, ...) must
# fail the run — and the run-owned job must STILL be deleted.
cat > "$FAKE_GCLOUD_DIR/gcloud" << 'FAKE4'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
if [[ "$*" == *"artifacts docker images describe"* ]] || [[ "$*" == *"artifacts repositories describe"* ]] || [[ "$*" == *"builds submit"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo "fake-token"; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo "/usr/lib/google-cloud-sdk"; exit 0; fi
if [[ "$*" == *"logs read"* ]]; then exit 0; fi
if [[ "$*" == *"executions describe"* ]]; then echo "0"; exit 0; fi
if [[ "$*" == *"executions list"* ]]; then exit 0; fi
if [[ "$*" == *"run jobs execute"* ]]; then echo "ERROR: (gcloud.run.jobs.execute) quota exceeded"; exit 7; fi
if [[ "$*" == *"run jobs"* ]]; then exit 0; fi
exit 0
FAKE4
chmod +x "$FAKE_GCLOUD_DIR/gcloud"
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
EXECFAIL_OUTPUT=$(bash "$SCRIPT" run --cloud --config=default 2>&1) && EXECFAIL_RC=0 || EXECFAIL_RC=$?
check "execute failure exits nonzero" bash -c "[ $EXECFAIL_RC -ne 0 ]"
if grep -q 'All tasks completed successfully' <<< "$EXECFAIL_OUTPUT"; then
  echo "FAIL: execute failure prints no success footer"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: execute failure prints no success footer"
fi
EXECFAIL_JOB=$(grep -oP 'Job:\s+\K[a-z0-9-]+' <<< "$EXECFAIL_OUTPUT" | head -1 || true)
check "failed run still deletes its own job" bash -c \
  "[ -n '${EXECFAIL_JOB:-}' ] && grep -q 'run jobs delete .* ${EXECFAIL_JOB} --quiet' '$FAKE_GCLOUD_LOG'"

# Check 13: "zero failed tasks" is not success — the number of succeeded
# tasks must equal the requested shard count, else the run fails closed
# (a cancelled/preempted task has succeeded=0, failed=0, and zero tests ran).
cat > "$FAKE_GCLOUD_DIR/gcloud" << 'FAKE5'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
if [[ "$*" == *"artifacts docker images describe"* ]] || [[ "$*" == *"artifacts repositories describe"* ]] || [[ "$*" == *"builds submit"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo "fake-token"; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo "/usr/lib/google-cloud-sdk"; exit 0; fi
if [[ "$*" == *"logs read"* ]]; then echo "Test Files  1 passed (1)"; exit 0; fi
if [[ "$*" == *"executions describe"* ]]; then
  if [[ "$*" == *"succeededCount"* ]]; then echo "1"; else echo "0"; fi
  exit 0
fi
if [[ "$*" == *"executions list"* ]]; then echo "test-execution-1"; exit 0; fi
if [[ "$*" == *"run jobs execute"* ]]; then echo "Execution [test-execution-1] has successfully completed."; exit 0; fi
if [[ "$*" == *"run jobs"* ]]; then exit 0; fi
exit 0
FAKE5
chmod +x "$FAKE_GCLOUD_DIR/gcloud"
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
SHORT_OUTPUT=$(bash "$SCRIPT" run --cloud --config=default --shards=4 2>&1) && SHORT_RC=0 || SHORT_RC=$?
check "succeeded < shards exits nonzero (1 of 4)" bash -c "[ $SHORT_RC -ne 0 ]"
if grep -q 'All tasks completed successfully' <<< "$SHORT_OUTPUT"; then
  echo "FAIL: succeeded < shards prints no success footer"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: succeeded < shards prints no success footer"
fi

# Check 14: when the execution id can't be parsed from execute output, the
# fallback listing MUST be scoped to this run's own job (--job=<unique>) —
# never the shared job, where it could return another run's execution.
cat > "$FAKE_GCLOUD_DIR/gcloud" << 'FAKE6'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
if [[ "$*" == *"artifacts docker images describe"* ]] || [[ "$*" == *"artifacts repositories describe"* ]] || [[ "$*" == *"builds submit"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo "fake-token"; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo "/usr/lib/google-cloud-sdk"; exit 0; fi
if [[ "$*" == *"logs read"* ]]; then echo "Test Files  1 passed (1)"; exit 0; fi
if [[ "$*" == *"executions describe"* ]]; then
  if [[ "$*" == *"succeededCount"* ]]; then
    N=$(grep -oP -- '--tasks=\K[0-9]+' "$FAKE_GCLOUD_LOG" | tail -1)
    echo "${N:-4}"
  else
    echo "0"
  fi
  exit 0
fi
if [[ "$*" == *"executions list"* ]]; then echo "fallback-exec-9"; exit 0; fi
if [[ "$*" == *"run jobs execute"* ]]; then echo "Creating execution..."; echo "OK."; exit 0; fi
if [[ "$*" == *"run jobs"* ]]; then exit 0; fi
exit 0
FAKE6
chmod +x "$FAKE_GCLOUD_DIR/gcloud"
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
FALLBACK_OUTPUT=$(bash "$SCRIPT" run --cloud --config=default 2>&1 || true)
FALLBACK_JOB=$(grep -oP 'Job:\s+\K[a-z0-9-]+' <<< "$FALLBACK_OUTPUT" | head -1 || true)
check "id-parse fallback lists executions of THIS run's job only" bash -c \
  "[ -n '${FALLBACK_JOB:-}' ] && grep 'executions list' '$FAKE_GCLOUD_LOG' | grep -q -- '--job=${FALLBACK_JOB}'"

# Check 15: Ctrl-C (SIGINT to the process group) mid-execution still deletes
# the run's own job via the exit trap.
cat > "$FAKE_GCLOUD_DIR/gcloud" << 'FAKE7'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
if [[ "$*" == *"artifacts docker images describe"* ]] || [[ "$*" == *"artifacts repositories describe"* ]] || [[ "$*" == *"builds submit"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo "fake-token"; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo "/usr/lib/google-cloud-sdk"; exit 0; fi
if [[ "$*" == *"logs read"* ]]; then exit 0; fi
if [[ "$*" == *"executions describe"* ]]; then echo "0"; exit 0; fi
if [[ "$*" == *"executions list"* ]]; then exit 0; fi
if [[ "$*" == *"run jobs execute"* ]]; then sleep 60; exit 0; fi
if [[ "$*" == *"run jobs"* ]]; then exit 0; fi
exit 0
FAKE7
chmod +x "$FAKE_GCLOUD_DIR/gcloud"
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
setsid bash "$SCRIPT" run --cloud --config=default >/dev/null 2>&1 &
INT_PID=$!
for _ in $(seq 1 100); do
  grep -q 'run jobs execute' "$FAKE_GCLOUD_LOG" 2>/dev/null && break
  sleep 0.1
done
kill -INT -- -"$INT_PID" 2>/dev/null || kill -INT "$INT_PID" 2>/dev/null || true
wait "$INT_PID" 2>/dev/null || true
check "SIGINT mid-run still deletes the run's own job" \
  grep -q 'run jobs delete' "$FAKE_GCLOUD_LOG"

# Check 16 (kata e83z): TTY-gated prompt disabling + identity preflight.
# FAKE8: prompts-env recording + failing-token mode. Every invocation runs
# under `env -u CLOUDSDK_CORE_DISABLE_PROMPTS` so a host export can never
# skew the TTY-side assertions.
FAKE8_DIR=$(mktemp -d)
FAKE8_LOG="$FAKE8_DIR/gcloud.log"
export FAKE8_LOG
cat > "$FAKE8_DIR/gcloud" << 'FAKE8'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE8_LOG:?set FAKE8_LOG}"
[ -n "${CLOUDSDK_CORE_DISABLE_PROMPTS:-}" ] && echo "PROMPTS_DISABLED=1" >> "$FAKE8_LOG"
if [ -n "${CLOUDSDK_CORE_DISABLE_PROMPTS:-}" ] && {
  [[ " $* " != *" --project="* ]] || [[ " $* " != *" --account="* ]]
}; then
  echo "explicit --project and --account are required" >&2
  exit 64
fi
case "$*" in
  *"auth print-access-token"*)
    if [ -n "${FAKE8_TOKEN_FAIL:-}" ]; then
      echo "Reauthentication failed. cannot prompt during non-interactive execution" >&2
      exit 1
    fi
    echo fake-token; exit 0 ;;
  *"info"*) echo "/nonexistent-sdk-root"; exit 0 ;;
  *"artifacts docker images describe"*) exit 0 ;;
  *"artifacts repositories describe"*) exit 0 ;;
  *"builds submit"*) exit 0 ;;
  *"run jobs create"*) exit 0 ;;
  *"run jobs execute"*) printf 'Execution [fake8-exec-1] has successfully completed.\n'; exit 0 ;;
  *"executions list"*) echo "fake8-exec-1"; exit 0 ;;
  *"executions describe"*) echo 1; exit 0 ;;
  *"logs read"*) echo "  1 passed (1.0s)"; exit 0 ;;
  *"run jobs delete"*) exit 0 ;;
  *) exit 0 ;;
esac
FAKE8
chmod +x "$FAKE8_DIR/gcloud"

run8() { # suite-level helper: run the run lane under FAKE8; stdin: caller's
  rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
  env -u CLOUDSDK_CORE_DISABLE_PROMPTS PATH="$FAKE8_DIR:$PATH" \
    bash "$SCRIPT" run --cloud --config=default --shards=2 2>&1
}

V8_OUT=$(run8 < /dev/null) && V8_RC=0 || V8_RC=$?
check "non-TTY stdin exports CLOUDSDK_CORE_DISABLE_PROMPTS=1 to gcloud children" \
  bash -c 'grep -q "PROMPTS_DISABLED=1" "$1"' _ "$FAKE8_LOG"
check "non-TTY cloud calls include explicit account and project context" \
  awk '
    /^FAKE_GCLOUD:/ {
      seen = 1
      if ($0 !~ /--account=[^ ]+/ || $0 !~ /--project=[^ ]+/) bad = 1
    }
    END { exit !(seen && !bad) }
  ' "$FAKE8_LOG"

rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
check "TTY stdin leaves prompts enabled (humans keep interactive reauth)" \
  bash -c '
    script -qec "env -u CLOUDSDK_CORE_DISABLE_PROMPTS PATH=\"$1:\$PATH\" bash \"$2\" run --cloud --config=default --shards=2" /dev/null >/dev/null 2>&1 || true
    ! grep -q "PROMPTS_DISABLED=1" "$3"
  ' _ "$FAKE8_DIR" "$SCRIPT" "$FAKE8_LOG"

rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
V8S_OUT=$(run8 < /dev/null) >/dev/null 2>&1 || true
check "identity preflight mints a token before any build/submit work" \
  bash -c '
    tok_line="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok_line" ] || exit 1
    if awk -v n="$tok_line" "NR<n" "$1" | grep -qE "FAKE_GCLOUD:.*(builds submit|run jobs create)"; then exit 1; fi
    grep -q "FAKE_GCLOUD: auth print-access-token --account=suite-pinned-identity@example.invalid" "$1"
  ' _ "$FAKE8_LOG"

rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
V8F_OUT=$(env -u CLOUDSDK_CORE_DISABLE_PROMPTS PATH="$FAKE8_DIR:$PATH" FAKE8_TOKEN_FAIL=1 bash "$SCRIPT" run --cloud --config=default --shards=2 2>&1 < /dev/null) && V8F_RC=0 || V8F_RC=$?
check "failed preflight exits fast: no builds submit, no job create, loud attributable error" \
  bash -c '
    [ "$1" != "0" ] &&
    grep -q "identity preflight failed for suite-pinned-identity@example.invalid (source: GCLOUD_IDENT (explicit env bypass))" <<<"$2" &&
    ! grep -qE "FAKE_GCLOUD:.*(builds submit|run jobs create)" "$3"
  ' _ "$V8F_RC" "$V8F_OUT" "$FAKE8_LOG"

# --- V9/V10 (kata e83z Task 3): run-lane banner identity attribution + loud
# dirty-tree surfacing. The top-of-file GCLOUD_IDENT pin makes the resolved
# identity deterministic, so the banner text is assertable exactly.
rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
V9_OUT=$(run8 < /dev/null) || true
check "run-lane startup banner reports the resolved identity and its source" \
  bash -c '
    grep -q "\[vitest-cloud\] Identity: suite-pinned-identity@example.invalid (source: GCLOUD_IDENT (explicit env bypass))" <<<"$1"
  ' _ "$V9_OUT"
check "identity line leads the lane output (before any build work and the banner)" \
  bash -c '
    ident="$(grep -n "\[vitest-cloud\] Identity:" <<<"$1" | head -1 | cut -d: -f1)"
    [ -n "$ident" ] || exit 1
    firstwork="$(grep -nE "Building Docker image|Running on Cloud Run Jobs" <<<"$1" | head -1 | cut -d: -f1)"
    [ -n "$firstwork" ] && [ "$ident" -lt "$firstwork" ]
  ' _ "$V9_OUT"

V10_DIRTY="$ROOT/.vitest-cloud-dirty-check-$$"
touch "$V10_DIRTY"
rm -f "$FAKE8_LOG"; touch "$FAKE8_LOG"
V10_OUT=$(run8 < /dev/null) || true
rm -f "$V10_DIRTY"
check "loud stdout WARNING when the -dirty image path is taken" \
  bash -c '
    grep -q "WARNING: dirty worktree" <<<"$1" &&
    grep -q "not content-addressed" <<<"$1"
  ' _ "$V10_OUT"
check "dirty WARNING precedes the rebuild work itself, not just the banner" \
  bash -c '
    warn="$(grep -n "WARNING: dirty worktree" <<<"$1" | head -1 | cut -d: -f1)"
    [ -n "$warn" ] || exit 1
    build="$(grep -n "Building Docker image" <<<"$1" | head -1 | cut -d: -f1)"
    banner="$(grep -n "Running on Cloud Run Jobs" <<<"$1" | head -1 | cut -d: -f1)"
    [ -n "$build" ] && [ "$warn" -lt "$build" ] &&
    [ -n "$banner" ] && [ "$warn" -lt "$banner" ]
  ' _ "$V10_OUT"

# Cleanup
rm -rf "$FAKE_GCLOUD_DIR"
rm -rf "$FAKE8_DIR"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
