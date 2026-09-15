#!/usr/bin/env bash
# Test: e2e-cloud wrapper script and npm script integration.
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

SCRIPT="$ROOT/scripts/e2e-cloud.sh"

echo "=== Cloud Run Wrapper Script Test ==="

# Check 1: Script exists
if [ ! -f "$SCRIPT" ]; then
  echo "FAIL: scripts/e2e-cloud.sh does not exist"
  exit 1
fi
echo "PASS: script exists"

# Check 2: Script is executable
if [ ! -x "$SCRIPT" ]; then
  echo "FAIL: scripts/e2e-cloud.sh is not executable"
  exit 1
fi
echo "PASS: script is executable"

# Check 3: help subcommand
echo "Testing: scripts/e2e-cloud.sh help"
HELP_OUTPUT=$("$SCRIPT" help 2>&1) || {
  echo "FAIL: help subcommand failed"
  echo "$HELP_OUTPUT"
  exit 1
}

if ! echo "$HELP_OUTPUT" | grep -qi "usage"; then
  echo "FAIL: help output does not contain 'usage'"
  echo "$HELP_OUTPUT"
  exit 1
fi
echo "PASS: help contains 'usage'"

if ! echo "$HELP_OUTPUT" | grep -qi "run"; then
  echo "FAIL: help output does not contain 'run'"
  exit 1
fi
echo "PASS: help contains 'run'"

if ! echo "$HELP_OUTPUT" | grep -qi -- "--local"; then
  echo "FAIL: help output does not contain '--local'"
  exit 1
fi
echo "PASS: help contains '--local'"

# Check 4: --local flag runs tests locally
echo "Testing: scripts/e2e-cloud.sh run --local --project=chromium auth.spec.ts"
LOCAL_OUTPUT=$("$SCRIPT" run --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: --local run failed"
  echo "$LOCAL_OUTPUT" | tail -20
  exit 1
}

if ! echo "$LOCAL_OUTPUT" | grep -q "6 passed"; then
  echo "FAIL: expected '6 passed' in --local output"
  echo "$LOCAL_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: --local runs 6 auth tests"

# Check 5: npm run test:e2e -- --local works
echo "Testing: npm run test:e2e -- --local"
NPM_LOCAL_OUTPUT=$(npm run test:e2e -- --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: npm run test:e2e -- --local failed"
  echo "$NPM_LOCAL_OUTPUT" | tail -20
  exit 1
}
echo "PASS: npm run test:e2e -- --local works"

# Check 6: npm run test:e2e:local works
echo "Testing: npm run test:e2e:local"
NPM_LOCAL_SCRIPT_OUTPUT=$(npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: npm run test:e2e:local failed"
  echo "$NPM_LOCAL_SCRIPT_OUTPUT" | tail -20
  exit 1
}
echo "PASS: npm run test:e2e:local works"

# Check 7: existing scripts still work
echo "Testing: npm run test:e2e:chromium (unchanged)"
CHROMIUM_OUTPUT=$(npm run test:e2e:chromium -- test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: npm run test:e2e:chromium failed"
  echo "$CHROMIUM_OUTPUT" | tail -20
  exit 1
}
echo "PASS: npm run test:e2e:chromium still works"

# Check 8: help mentions --cloud and FRESHELL_E2E_BACKEND
echo "Testing: help mentions --cloud flag"
if ! echo "$HELP_OUTPUT" | grep -qi -- "--cloud"; then
  echo "FAIL: help output does not contain '--cloud'"
  echo "$HELP_OUTPUT"
  exit 1
fi
echo "PASS: help contains '--cloud'"

echo "Testing: help mentions FRESHELL_E2E_BACKEND"
if ! echo "$HELP_OUTPUT" | grep -qi "FRESHELL_E2E_BACKEND"; then
  echo "FAIL: help output does not contain 'FRESHELL_E2E_BACKEND'"
  echo "$HELP_OUTPUT"
  exit 1
fi
echo "PASS: help contains 'FRESHELL_E2E_BACKEND'"

# Check 9: default backend (unset env var) runs locally
echo "Testing: default backend (unset FRESHELL_E2E_BACKEND) runs locally"
DEFAULT_OUTPUT=$(env -u FRESHELL_E2E_BACKEND "$SCRIPT" run --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: default run failed"
  echo "$DEFAULT_OUTPUT" | tail -20
  exit 1
}
if ! echo "$DEFAULT_OUTPUT" | grep -q "Running locally"; then
  echo "FAIL: expected 'Running locally' in default output"
  echo "$DEFAULT_OUTPUT" | tail -20
  exit 1
fi
if ! echo "$DEFAULT_OUTPUT" | grep -q "6 passed"; then
  echo "FAIL: expected '6 passed' in default output"
  echo "$DEFAULT_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: default backend (unset) runs locally"

# Check 10: FRESHELL_E2E_BACKEND=local runs locally
echo "Testing: FRESHELL_E2E_BACKEND=local runs locally"
LOCAL_ENV_OUTPUT=$(FRESHELL_E2E_BACKEND=local "$SCRIPT" run --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line 2>&1) || {
  echo "FAIL: FRESHELL_E2E_BACKEND=local run failed"
  echo "$LOCAL_ENV_OUTPUT" | tail -20
  exit 1
}
if ! echo "$LOCAL_ENV_OUTPUT" | grep -q "Running locally"; then
  echo "FAIL: expected 'Running locally' with FRESHELL_E2E_BACKEND=local"
  echo "$LOCAL_ENV_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: FRESHELL_E2E_BACKEND=local runs locally"

# Check 11: --cloud overrides FRESHELL_E2E_BACKEND=local, and the cloud job is
# pinned to the DIGEST of the image built from this exact tree — never a tag
# (Cloud Run resolves a tag only when the execution starts, so a concurrent
# run could swap it) and never mutable :latest (wrap-review r3: a stale
# :latest let the cloud e2e gate pass against old source). The build must
# publish this tree's tag: the commit for a clean tree, the commit plus a
# content hash otherwise. Fully STUBBED gcloud/docker: this check previously
# invoked the real toolchain, which on an authenticated machine could really
# build, push, and execute a cloud job from a test.
echo "Testing: --cloud pins the digest of this tree's image (stubbed gcloud/docker)"
STUB_DIR="$(mktemp -d /tmp/e2e-cloud-stubs.XXXXXX)"
export STUB_CAPTURE="$STUB_DIR/capture"
mkdir -p "$STUB_CAPTURE"
cat > "$STUB_DIR/gcloud" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  "info "*) echo "/nonexistent-sdk-root"; exit 0 ;;
  "meta list-files-for-upload"*) printf '%s\n' package.json docker/cloud-run/cloudbuild.yaml; exit 0 ;;
  "builds submit"*) echo "$args" >> "$STUB_CAPTURE/builds.args"; echo stub-build-1; exit 0 ;;
  "builds list"*) exit 0 ;;
  "builds describe"*)
    case "$args" in
      *buildStepOutputs*) printf '{"results":{"buildStepOutputs":["","%s"]}}\n' "$(printf 'sha256:%064d' 42 | base64 -w0)" ;;
      *) echo SUCCESS ;;
    esac
    exit 0 ;;
  "auth print-access-token"*) echo stub-token; exit 0 ;;
  *"artifacts repositories describe"*) exit 1 ;;
  *"artifacts repositories create"*) exit 0 ;;
  *"artifacts docker images describe"*) echo "$args" >> "$STUB_CAPTURE/describe.args"; exit 1 ;;
  *"run jobs create"*) echo "$args" >> "$STUB_CAPTURE/create.args"; exit 0 ;;
  *"run jobs update"*) echo "$args" >> "$STUB_CAPTURE/update.args"; exit 0 ;;
  *"run jobs execute"*) exit 0 ;;
  *"executions list"*) echo "exec-stub"; exit 0 ;;
  *"executions describe"*)
    case "$args" in
      *failedCount*) echo "0" ;;
      *succeededCount*) echo "1" ;;
      *) echo "1" ;;
    esac
    exit 0 ;;
  *"logs read"*) echo "  6 passed (4.2s)"; exit 0 ;;
  *"logging read"*)
    echo '[{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-stub","taskIndex":0,"taskCount":1,"recoveredRetryCount":0}}]'
    exit 0 ;;
  *) exit 0 ;;
esac
STUB
cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
# Drain stdin ONLY when it is not a TTY: `gcloud … | docker login
# --password-stdin` needs the pipe consumed (else pipefail can SIGPIPE the
# producer), but build/tag/push inherit the caller's stdin, and a bare
# `cat` on an interactive terminal would block the suite forever.
if [ ! -t 0 ]; then cat >/dev/null 2>&1 || true; fi
echo "$*" >> "$STUB_CAPTURE/docker.args"
exit 0
STUB
chmod +x "$STUB_DIR/gcloud" "$STUB_DIR/docker"
SHA12="$(git rev-parse --short=12 HEAD)"
STUB_DIGEST="sha256:$(printf '%064d' 42)"
CLOUD_STUB_OUTPUT=$(env PATH="$STUB_DIR:$PATH" FRESHELL_E2E_BACKEND=local \
  FRESHELL_CLOUD_IMAGE_LOCK_DIR="$STUB_DIR/locks" \
  "$SCRIPT" run --cloud --project=chromium test/e2e-browser/specs/auth.spec.ts 2>&1) || {
  echo "FAIL: stubbed cloud run failed"
  echo "$CLOUD_STUB_OUTPUT" | tail -20
  rm -rf "$STUB_DIR"
  exit 1
}
if echo "$CLOUD_STUB_OUTPUT" | grep -q "Running locally"; then
  echo "FAIL: --cloud flag was ignored (printed 'Running locally')"
  echo "$CLOUD_STUB_OUTPUT" | tail -20
  rm -rf "$STUB_DIR"
  exit 1
fi
IMAGE_ARG="$(grep -oE -- '--image=[^ ]+' "$STUB_CAPTURE/create.args" 2>/dev/null | head -1 || true)"
IMAGE_RE="^--image=[^ ]+/freshell-e2e@${STUB_DIGEST}$"
if ! [[ "$IMAGE_ARG" =~ $IMAGE_RE ]]; then
  echo "FAIL: cloud job was not pinned to the digest the build recorded ($STUB_DIGEST)"
  echo "create args: $(cat "$STUB_CAPTURE/create.args" 2>/dev/null || echo '<none>')"
  rm -rf "$STUB_DIR"
  exit 1
fi
# The build must PUBLISH this tree's tag: the commit for a clean tree, the
# commit plus the content hash of its snapshot otherwise.
PUBLISHED_REF="$(grep -oE '_IMAGE=[^ ,]+' "$STUB_CAPTURE/builds.args" 2>/dev/null | head -1 || true)"
PUBLISHED_TAG="${PUBLISHED_REF##*:}"
if [ -n "$(git status --porcelain)" ]; then
  TAG_RE="^${SHA12}-dirty-[0-9a-f]{16}$"
else
  TAG_RE="^${SHA12}$"
fi
if ! [[ "$PUBLISHED_REF" == _IMAGE=*freshell-e2e:* && "$PUBLISHED_TAG" =~ $TAG_RE ]]; then
  echo "FAIL: the build did not publish this tree's tag (got '$PUBLISHED_REF', want tag $TAG_RE)"
  echo "builds args: $(cat "$STUB_CAPTURE/builds.args" 2>/dev/null || echo '<none>')"
  rm -rf "$STUB_DIR"
  exit 1
fi
rm -rf "$STUB_DIR"
unset STUB_CAPTURE
echo "PASS: --cloud publishes this tree's tag and pins the job to the built digest"

# Check 12: the wrapper works on machines WITHOUT gcloud for non-cloud
# subcommands. The top-level gcloud-sdk PATH setup must not kill the script
# under `set -e` before dispatch (previously a silent 127). `help` is the
# deterministic pin (needs no node/npx); the `run --local` dispatch itself
# never calls gcloud.
echo "Testing: help works without gcloud on PATH"
CLEAN_PATH="$PATH"
if GCLOUD_PATH=$(command -v gcloud 2>/dev/null); then
  GCLOUD_DIRNAME="$(cd "$(dirname "$GCLOUD_PATH")" && pwd)"
  CLEAN_PATH="$(echo "$PATH" | tr ':' '\n' | grep -vx "$GCLOUD_DIRNAME" | paste -sd:)"
  if [ "$CLEAN_PATH" = "$PATH" ]; then
    echo "FAIL: could not construct a gcloud-free PATH (gcloud dir not on PATH?)"
    exit 1
  fi
fi
if env PATH="$CLEAN_PATH" command -v gcloud >/dev/null 2>&1; then
  echo "FAIL: gcloud still resolvable on the filtered PATH"
  exit 1
fi
NO_GCLOUD_HELP=$(env PATH="$CLEAN_PATH" "$SCRIPT" help 2>&1) || {
  echo "FAIL: help subcommand died without gcloud (top-level gcloud probe is not set -e safe)"
  echo "$NO_GCLOUD_HELP" | tail -10
  exit 1
}
if ! echo "$NO_GCLOUD_HELP" | grep -qi "usage"; then
  echo "FAIL: help output without gcloud does not contain 'usage'"
  echo "$NO_GCLOUD_HELP" | tail -10
  exit 1
fi
echo "PASS: help works without gcloud on PATH"

# Check 13: pass-through args CONTAINING SPACES survive end-to-end.
# Two halves:
#  (a) local path: `run --local` execs playwright with the raw arg array —
#      `--grep "auth modal"` (two whitespace-separated words, one arg)
#      must filter auth.spec.ts down to exactly its 3 modal-titled tests.
#  (b) cloud path: the container entrypoint reads PLAYWRIGHT_ARGS
#      newline-delimited (e2e-cloud.sh emits a YAML literal block scalar)
#      and must NOT word-split on spaces — pinned via the single-task
#      --dry-run echo, where a split arg would land in the spec-filter
#      tail instead of the flags list.
echo "Testing: spaced --grep arg filters locally (pass-through array)"
GREP_LOCAL_OUTPUT=$("$SCRIPT" run --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line --grep "auth modal" 2>&1) || {
  echo "FAIL: --local run with spaced --grep failed"
  echo "$GREP_LOCAL_OUTPUT" | tail -20
  exit 1
}
if ! echo "$GREP_LOCAL_OUTPUT" | grep -q "3 passed"; then
  echo "FAIL: expected '3 passed' for --grep 'auth modal' (spaced arg corrupted?)"
  echo "$GREP_LOCAL_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: spaced --grep arg survives local pass-through"

echo "Testing: spaced args survive PLAYWRIGHT_ARGS newline round-trip (entrypoint)"
ENTRYPOINT="$ROOT/docker/cloud-run/entrypoint.sh"
DRY_OUTPUT=$(CLOUD_RUN_TASK_COUNT=1 \
  PLAYWRIGHT_ARGS="$(printf -- '--grep=wrap-review spaced sentinel\n--project=chromium')" \
  "$ENTRYPOINT" --dry-run 2>&1) || {
  echo "FAIL: entrypoint --dry-run with spaced PLAYWRIGHT_ARGS died"
  echo "$DRY_OUTPUT" | tail -10
  exit 1
}
if ! echo "$DRY_OUTPUT" | grep -q -- "--grep=wrap-review spaced sentinel --project=chromium"; then
  echo "FAIL: spaced arg was word-split by the entrypoint (expected intact flag in dry-run echo)"
  echo "$DRY_OUTPUT" | tail -10
  exit 1
fi
echo "PASS: entrypoint keeps space-containing PLAYWRIGHT_ARGS entries intact"

# Check 14: SPLIT-FORM value flags ("--grep foo", "--project chromium") are
# normalized to =form before either backend consumes the args. Without
# normalization the cloud entrypoint's dash-vs-positional classification
# silently reordered split values behind later flags
# ("--project chromium --grep 'auth modal'" corrupted into
# "--project --grep chromium 'auth modal'"). Playwright binds =form
# identically, so the observable pin here is the local run filtering
# auth.spec.ts down to its 3 modal-titled tests via split-form args.
echo "Testing: split-form flags normalize (--project chromium --grep 'auth modal')"
SPLIT_OUTPUT=$("$SCRIPT" run --local --project chromium test/e2e-browser/specs/auth.spec.ts --reporter line --grep "auth modal" 2>&1) || {
  echo "FAIL: --local run with split-form flags failed (normalization corrupted argv?)"
  echo "$SPLIT_OUTPUT" | tail -20
  exit 1
}
if ! echo "$SPLIT_OUTPUT" | grep -q "3 passed"; then
  echo "FAIL: expected '3 passed' for split-form --grep 'auth modal'"
  echo "$SPLIT_OUTPUT" | tail -20
  exit 1
fi
echo "PASS: split-form value flags are normalized before dispatch"

# ---------------------------------------------------------------------------
# Check 15: per-run unique job lifecycle + result hardening (stubbed gcloud).
#
# The run must:
#  (a) create its OWN unique job (<prefix>-<imagetag>-<random>), execute it,
#      and delete it on every exit path — a shared job lets a concurrent run
#      overwrite the image/config of an in-flight run (execute snapshots the
#      job's CURRENT template) and forces the cross-run "latest execution"
#      fallback;
#  (b) fail nonzero when `gcloud run jobs execute` itself fails — never print
#      the success footer;
#  (c) propagate permanent status-query errors (transient ones retry);
#  (d) require succeeded tasks == requested shards, not merely failed == 0;
#  (e) scope any execution-id fallback listing to the run's own job;
#  (f) still delete the run's job on SIGINT mid-execution.
# ---------------------------------------------------------------------------
STUB2_DIR="$(mktemp -d /tmp/e2e-cloud-stub2.XXXXXX)"
export STUB2_CAPTURE="$STUB2_DIR/capture"
mkdir -p "$STUB2_CAPTURE"
# Keep the wrapper's same-machine image lock inside this check's sandbox.
export FRESHELL_CLOUD_IMAGE_LOCK_DIR="$STUB2_DIR/locks"
cat > "$STUB2_DIR/gcloud" <<'STUB2'
#!/usr/bin/env bash
echo "$*" >> "$STUB2_CAPTURE/gcloud.args"
case "$*" in
  "info "*) echo "/nonexistent-sdk-root"; exit 0 ;;
  # Image lane: a small upload listing and an already-published image.
  "meta list-files-for-upload"*) printf '%s\n' package.json docker/cloud-run/cloudbuild.yaml; exit 0 ;;
  *"artifacts repositories describe"*) exit 0 ;;
  *"artifacts repositories create"*) exit 0 ;;
  *"artifacts docker images describe"*) printf 'sha256:%064d\n' 1; exit 0 ;;
  *"auth print-access-token"*) echo stub-token; exit 0 ;;
  *"builds submit"*) exit 0 ;;
  *"run jobs create"*)
    tasks=$(grep -o -- '--tasks=[0-9]\+' <<< "$*" | tail -1 | cut -d= -f2)
    echo "${tasks:-1}" > "$STUB2_CAPTURE/tasks"
    exit 0 ;;
  *"run jobs delete"*) exit 0 ;;
  *"run jobs execute"*)
    if [ -n "${STUB2_EXECUTE_SLEEP:-}" ]; then sleep "$STUB2_EXECUTE_SLEEP"; exit 0; fi
    if [ -n "${STUB2_EXECUTE_RC:-}" ]; then echo "ERROR: STUB2_EXECUTE_RC=$STUB2_EXECUTE_RC"; exit "$STUB2_EXECUTE_RC"; fi
    if [ -n "${STUB2_EXECUTE_NOEXECLINE:-}" ]; then echo "Creating execution..."; echo "OK."; exit 0; fi
    echo "Execution [exec-stub-7] has successfully completed."
    exit 0 ;;
  *"executions list"*) echo "exec-stub-7"; exit 0 ;;
  *"executions describe"*)
    if [ -n "${STUB2_DESCRIBE_FAIL:-}" ]; then
      DCOUNT_FILE="$STUB2_CAPTURE/desc.count"
      C=$(cat "$DCOUNT_FILE" 2>/dev/null || echo 0); C=$((C+1)); echo "$C" > "$DCOUNT_FILE"
      if [ "$STUB2_DESCRIBE_FAIL" = "always" ] || [ "$C" -le "$STUB2_DESCRIBE_FAIL" ]; then exit 1; fi
    fi
    case "$*" in
      *failedCount*) echo "${STUB2_FAILED:-0}" ;;
      *succeededCount*) echo "${STUB2_SUCCEEDED:-1}" ;;
      *) echo "1" ;;
    esac
    exit 0 ;;
  *"logs read"*)
    if [ -n "${STUB2_LOGS:-}" ]; then printf '%s\n' "$STUB2_LOGS"; else echo "  6 passed (4.2s)"; fi
    exit 0 ;;
  *"logging read"*)
    if [ -n "${STUB2_STRUCTURED_LOGS:-}" ]; then
      printf '%s\n' "$STUB2_STRUCTURED_LOGS"
      exit 0
    fi
    tasks=$(cat "$STUB2_CAPTURE/tasks" 2>/dev/null || echo 1)
    printf '['
    for ((task = 0; task < tasks; task++)); do
      [ "$task" -gt 0 ] && printf ','
      printf '{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-stub-7","taskIndex":%s,"taskCount":%s,"recoveredRetryCount":0}}' "$task" "$tasks"
    done
    printf ']\n'
    exit 0 ;;
  *) exit 0 ;;
esac
STUB2
cat > "$STUB2_DIR/docker" <<'STUB2D'
#!/usr/bin/env bash
if [ ! -t 0 ]; then cat >/dev/null 2>&1 || true; fi
exit 0
STUB2D
chmod +x "$STUB2_DIR/gcloud" "$STUB2_DIR/docker"

stub2_reset() {
  rm -f "$STUB2_CAPTURE/gcloud.args" "$STUB2_CAPTURE/desc.count"
  touch "$STUB2_CAPTURE/gcloud.args"
}

# (a) unique job lifecycle on the happy path
echo "Testing: cloud run creates/executes/deletes its own unique job"
stub2_reset
UNIQ_OUT=$(env PATH="$STUB2_DIR:$PATH" STUB2_SUCCEEDED=2 "$SCRIPT" run --cloud --shards=2 2>&1) || {
  echo "FAIL: unique-job cloud run errored"; echo "$UNIQ_OUT" | tail -10; rm -rf "$STUB2_DIR"; exit 1
}
E2E_JOB1=$(grep -oP 'Job:\s+\K[a-z0-9-]+' <<< "$UNIQ_OUT" | head -1 || true)
if [ -z "$E2E_JOB1" ]; then
  echo "FAIL: run header does not report a Job name"; echo "$UNIQ_OUT" | tail -10; rm -rf "$STUB2_DIR"; exit 1
fi
if ! grep -qP '^freshell-e2e-[a-z0-9]{12}(-dirty)?-[a-z0-9]{6}$' <<< "$E2E_JOB1"; then
  echo "FAIL: job name '$E2E_JOB1' is not unique per run"; rm -rf "$STUB2_DIR"; exit 1
fi
for verb in create execute; do
  if ! grep "run jobs $verb" "$STUB2_CAPTURE/gcloud.args" | grep -q -- "$E2E_JOB1"; then
    echo "FAIL: 'run jobs $verb' did not target the run's own job ($E2E_JOB1)"
    cat "$STUB2_CAPTURE/gcloud.args"; rm -rf "$STUB2_DIR"; exit 1
  fi
done
if ! grep "run jobs delete" "$STUB2_CAPTURE/gcloud.args" | grep -q -- "$E2E_JOB1 --quiet\|--quiet .*$E2E_JOB1\|$E2E_JOB1$"; then
  echo "FAIL: run did not delete its own job"; cat "$STUB2_CAPTURE/gcloud.args"; rm -rf "$STUB2_DIR"; exit 1
fi
if grep -q "run jobs update" "$STUB2_CAPTURE/gcloud.args"; then
  echo "FAIL: run still mutates a job with 'run jobs update' (shared-job hazard)"
  rm -rf "$STUB2_DIR"; exit 1
fi
# The unique job carries its own config, so per-run state (--tasks, the
# PLAYWRIGHT_ARGS env file) lives on the created job — verify it is passed.
if ! grep "run jobs create" "$STUB2_CAPTURE/gcloud.args" | grep -q -- "--tasks=2"; then
  echo "FAIL: --tasks not applied for this run"; rm -rf "$STUB2_DIR"; exit 1
fi
echo "PASS: unique job created/executed/deleted with its own config"

# A recovered Playwright retry has a successful Cloud Run task, so its only
# useful receipt is the structured first-attempt evidence the entrypoint put
# in Cloud Logging. The runner must call that out without dumping base64 trace
# chunks into the terminal receipt.
echo "Testing: recovered retry evidence is surfaced with a durable artifact id"
stub2_reset
RETRY_RECEIPT_OUT=$(env PATH="$STUB2_DIR:$PATH" \
  STUB2_STRUCTURED_LOGS='[{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-stub-7","taskIndex":0,"taskCount":1,"recoveredRetryCount":1}},{"jsonPayload":{"event":"e2e_playwright_retry_evidence","execution":"exec-stub-7","taskIndex":0,"taskCount":1,"failureAttempt":0,"trace":{"artifactId":"playwright-retry-trace-test","traceAttempt":0,"retained":false},"error":{"stack":"first attempt stack"}}}]' \
  "$SCRIPT" run --cloud --shards=1 2>&1) && RETRY_RECEIPT_RC=0 || RETRY_RECEIPT_RC=$?
if [ "$RETRY_RECEIPT_RC" -eq 0 ]; then
  echo "FAIL: recovered Playwright retry was accepted as a zero-flake cloud receipt"
  echo "$RETRY_RECEIPT_OUT" | tail -30; rm -rf "$STUB2_DIR"; exit 1
fi
if ! grep -q "Recovered Playwright retry evidence retained in Cloud Logging" <<< "$RETRY_RECEIPT_OUT"; then
  echo "FAIL: runner did not surface recovered retry evidence in its receipt"
  echo "$RETRY_RECEIPT_OUT" | tail -30; rm -rf "$STUB2_DIR"; exit 1
fi
if ! grep -q "playwright-retry-trace-test" <<< "$RETRY_RECEIPT_OUT"; then
  echo "FAIL: runner receipt omitted the durable retry trace artifact id"
  echo "$RETRY_RECEIPT_OUT" | tail -30; rm -rf "$STUB2_DIR"; exit 1
fi
if grep -q "All tasks completed successfully" <<< "$RETRY_RECEIPT_OUT"; then
  echo "FAIL: runner printed a green receipt despite recovered Playwright retry evidence"
  echo "$RETRY_RECEIPT_OUT" | tail -30; rm -rf "$STUB2_DIR"; exit 1
fi
echo "PASS: recovered retry evidence is surfaced and fails the zero-flake receipt"

# a second run must get a different job
stub2_reset
UNIQ2_OUT=$(env PATH="$STUB2_DIR:$PATH" "$SCRIPT" run --cloud --shards=1 2>&1 || true)
E2E_JOB2=$(grep -oP 'Job:\s+\K[a-z0-9-]+' <<< "$UNIQ2_OUT" | head -1 || true)
if [ -z "$E2E_JOB2" ] || [ "$E2E_JOB1" = "$E2E_JOB2" ]; then
  echo "FAIL: two runs share a job name ('$E2E_JOB1' vs '$E2E_JOB2')"; rm -rf "$STUB2_DIR"; exit 1
fi
echo "PASS: second run gets a different job name"

# (b) execute failure fails the run (and still deletes the job)
echo "Testing: execute failure fails the run, no success footer, job deleted"
stub2_reset
EXECFAIL_OUT=$(env PATH="$STUB2_DIR:$PATH" STUB2_EXECUTE_RC=7 "$SCRIPT" run --cloud --shards=1 2>&1) && EXECFAIL_RC=0 || EXECFAIL_RC=$?
if [ "$EXECFAIL_RC" -eq 0 ]; then
  echo "FAIL: wrapper reported success when execute exited 7"; rm -rf "$STUB2_DIR"; exit 1
fi
if grep -q "All tasks completed successfully" <<< "$EXECFAIL_OUT"; then
  echo "FAIL: success footer printed despite execute failure"; rm -rf "$STUB2_DIR"; exit 1
fi
if ! grep -q "run jobs delete" "$STUB2_CAPTURE/gcloud.args"; then
  echo "FAIL: run-owned job not deleted after execute failure"; rm -rf "$STUB2_DIR"; exit 1
fi
echo "PASS: execute failure fails the run and still deletes the job"

# (c) status queries: transient errors retry; permanent errors fail the run
echo "Testing: transient describe errors retry, permanent ones fail"
stub2_reset
env PATH="$STUB2_DIR:$PATH" STUB2_DESCRIBE_FAIL=2 "$SCRIPT" run --cloud --shards=1 >/dev/null 2>&1 || {
  echo "FAIL: transient describe errors (2x) were not retried to success"; rm -rf "$STUB2_DIR"; exit 1
}
stub2_reset
env PATH="$STUB2_DIR:$PATH" STUB2_DESCRIBE_FAIL=always "$SCRIPT" run --cloud --shards=1 >/dev/null 2>&1 && {
  echo "FAIL: permanent describe errors were masked as success"; rm -rf "$STUB2_DIR"; exit 1
}
echo "PASS: describe errors retry then fail closed"

# (d) succeeded must equal shards, not merely failed == 0
echo "Testing: succeeded < shards fails the run"
stub2_reset
SHORT_OUT=$(env PATH="$STUB2_DIR:$PATH" STUB2_SUCCEEDED=0 STUB2_FAILED=0 "$SCRIPT" run --cloud --shards=1 2>&1) && SHORT_RC=0 || SHORT_RC=$?
if [ "$SHORT_RC" -eq 0 ]; then
  echo "FAIL: succeeded=0/1 shards reported as success ('zero failed' is not success)"; rm -rf "$STUB2_DIR"; exit 1
fi
if grep -q "All tasks completed successfully" <<< "$SHORT_OUT"; then
  echo "FAIL: success footer printed with succeeded < shards"; rm -rf "$STUB2_DIR"; exit 1
fi
echo "PASS: succeeded < shards fails closed"

# (e) execution-id fallback listing stays scoped to the run's own job
echo "Testing: id-parse fallback lists executions of the run's own job only"
stub2_reset
FALLBACK_OUT=$(env PATH="$STUB2_DIR:$PATH" STUB2_EXECUTE_NOEXECLINE=1 "$SCRIPT" run --cloud --shards=1 2>&1 || true)
FALLBACK_JOB=$(grep -oP 'Job:\s+\K[a-z0-9-]+' <<< "$FALLBACK_OUT" | head -1 || true)
if [ -z "$FALLBACK_JOB" ] || ! grep "executions list" "$STUB2_CAPTURE/gcloud.args" | grep -q -- "--job=$FALLBACK_JOB"; then
  echo "FAIL: fallback listing not scoped to the run's own job ($FALLBACK_JOB)"
  cat "$STUB2_CAPTURE/gcloud.args"; rm -rf "$STUB2_DIR"; exit 1
fi
echo "PASS: fallback listing scoped to the run's own job"

# (f) SIGINT mid-execution still deletes the run's job
echo "Testing: SIGINT mid-run still deletes the run's job"
stub2_reset
setsid env PATH="$STUB2_DIR:$PATH" STUB2_EXECUTE_SLEEP=60 "$SCRIPT" run --cloud --shards=1 >/dev/null 2>&1 &
E2E_INT_PID=$!
for _ in $(seq 1 100); do
  grep -q 'run jobs execute' "$STUB2_CAPTURE/gcloud.args" 2>/dev/null && break
  sleep 0.1
done
kill -INT -- -"$E2E_INT_PID" 2>/dev/null || kill -INT "$E2E_INT_PID" 2>/dev/null || true
wait "$E2E_INT_PID" 2>/dev/null || true
if ! grep -q "run jobs delete" "$STUB2_CAPTURE/gcloud.args"; then
  echo "FAIL: run-owned job not deleted after SIGINT"; rm -rf "$STUB2_DIR"; exit 1
fi
echo "PASS: SIGINT mid-run still deletes the job"

rm -rf "$STUB2_DIR"
unset STUB2_CAPTURE

echo ""
echo "=== All checks passed ==="
