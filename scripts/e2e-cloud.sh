#!/usr/bin/env bash
# e2e-cloud.sh — Cloud Run Jobs wrapper for Playwright e2e tests.
#
# Usage:
#   scripts/e2e-cloud.sh [subcommand] [flags] [playwright-args...]
#
# Subcommands:
#   run       (default) Run e2e tests locally or on Cloud Run Jobs
#   build     Build and push the Docker image to Artifact Registry
#   push      Push an already-built image to Artifact Registry
#   logs      Fetch logs from the latest Cloud Run Job execution
#   help      Show this help message
#
# Backend selection:
#   The FRESHELL_E2E_BACKEND env var controls where tests run by default:
#     - "local"  (default if unset): run locally via Playwright
#     - "cloud":                run on Google Cloud Run Jobs
#   Override at invocation time with --local or --cloud.
#
# Flags:
#   --local           Run locally (overrides FRESHELL_E2E_BACKEND)
#   --cloud           Run on Cloud Run (overrides FRESHELL_E2E_BACKEND)
#   --build           Force image rebuild + push before running
#   --local-build     Build locally with Docker instead of Cloud Build
#   --shards=N        Number of parallel Cloud Run tasks (default: 1)
#   --timeout=DURATION Cloud Run task timeout (default: 60m)
#   --grep=PATTERN    Pass --grep=PATTERN to Playwright
#   --project=NAME    Pass --project=NAME to Playwright
#   --account=EMAIL   GCP account pin (highest precedence; default: none —
#                     FRESHELL_GCP_ACCOUNT env, then the gcloud-robot identity
#                     ladder, then ambient gcloud)
#   --project-id=ID   GCP project (default: FRESHELL_GCP_PROJECT env or misc-puttering-project)
#   --region=REGION   GCP region (default: FRESHELL_GCP_REGION env or us-west1)
#
# Examples:
#   scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/auth.spec.ts
#   scripts/e2e-cloud.sh run --project=chromium --reporter=line
#   scripts/e2e-cloud.sh run --shards=4 --project=chromium
#   scripts/e2e-cloud.sh run --shards=4 --timeout=30m --project=chromium
#   scripts/e2e-cloud.sh build
#   scripts/e2e-cloud.sh help
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
# No account is hardcoded. Precedence: --account= flag > FRESHELL_GCP_ACCOUNT
# > gcloud-robot identity ladder (freshell_resolve_cloud_identity, resolved
# lazily per cloud lane) > unset — calls then omit --account and ambient
# gcloud applies, which the ladder announces once on stderr.
GCP_ACCOUNT="${FRESHELL_GCP_ACCOUNT:-}"
GCP_PROJECT="${FRESHELL_GCP_PROJECT:-misc-puttering-project}"
GCP_REGION="${FRESHELL_GCP_REGION:-us-west1}"
GCP_REPO="${FRESHELL_GCP_REPO:-freshell-e2e}"
GCP_JOB="${FRESHELL_GCP_JOB:-freshell-e2e}"

IMAGE_NAME="freshell-e2e"
# The digest reference (<repo>@sha256:...) of the image a cloud run tests;
# set by cmd_run. Never a tag: see scripts/lib/cloud-image.sh.
IMAGE_REMOTE=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Shared gcloud identity ladder (gcloud-robot). Sourcing only defines
# functions — no side effects, no output — so help and local lanes stay
# gcloud-free and silent.
# shellcheck source=scripts/lib/gcp-identity.sh
. "$SCRIPT_DIR/lib/gcp-identity.sh"

# Shared test-image identity: which exact tree an image holds, its tag,
# build dedupe across concurrent runs, and digest pinning. The contract is
# documented at the top of the helper. Sourcing only defines functions.
# shellcheck source=scripts/lib/cloud-image.sh
. "$SCRIPT_DIR/lib/cloud-image.sh"
CLOUD_IMAGE_LOG_PREFIX="[e2e-cloud]"
# Image progress joins this wrapper's other progress on stdout; the stdout of
# cloud_image_ensure itself carries only its result line.
exec {CLOUD_IMAGE_LOG_FD}>&1

# Ensure gcloud's bin dir is on PATH (for docker-credential-gcloud used by
# Docker when pushing to Artifact Registry). Guarded: local runs, `help`,
# and machines without gcloud must get past this section — a failing
# `gcloud info` inside a bare assignment's command substitution would trip
# `set -e` before ANY subcommand dispatch (a silent 127 with stderr
# suppressed). Only the cloud paths below actually require gcloud.
GCLOUD_SDK_ROOT=""
if command -v gcloud >/dev/null 2>&1; then
  GCLOUD_SDK_ROOT="$(gcloud info --format="value(installation.sdk_root)" 2>/dev/null || true)"
fi
if [ -n "$GCLOUD_SDK_ROOT" ] && [ -d "$GCLOUD_SDK_ROOT/bin" ] && ! echo "$PATH" | grep -q "$GCLOUD_SDK_ROOT/bin"; then
  export PATH="$GCLOUD_SDK_ROOT/bin:$PATH"
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
gcloud_flags() {
  # No identity may legitimately resolve (rung 4: ambient gcloud). An empty
  # pin omits --account entirely rather than passing gcloud an empty value.
  if [ -n "${GCP_ACCOUNT:-}" ]; then
    echo "--account=${GCP_ACCOUNT} --project=${GCP_PROJECT} --region=${GCP_REGION}"
  else
    echo "--project=${GCP_PROJECT} --region=${GCP_REGION}"
  fi
}

# Unique per-run job. `gcloud run jobs execute` snapshots the job's CURRENT
# template, so sharing one job across runs lets a concurrent run's job update
# swap the image/config of an in-flight run, and forces "find my execution"
# to fall back to "the latest execution of the shared job" — which may be
# another run's results. Every run therefore creates its own job
# (<prefix>-<commit>[-dirty]-<random6>, from the image tag in $1), executes
# it, and deletes it on every exit path (success, failure, SIGINT/SIGTERM).
# FRESHELL_GCP_JOB is the prefix.
unique_job_name() {
  local rand
  rand=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6)
  printf '%s-%s-%s' "$GCP_JOB" "$(cloud_image_job_label "$1")" "$rand"
}

# Prints a pinned --account flag, or NOTHING (not even an empty word) when no
# identity resolved — for the gcloud calls that pin inline instead of via
# gcloud_flags(). An empty expansion inside an unquoted $() yields no argv
# word, which is exactly what "omit --account" needs; always exits 0.
account_flag() {
  if [ -n "${GCP_ACCOUNT:-}" ]; then
    printf -- '--account=%s' "${GCP_ACCOUNT}"
  fi
}

usage() {
  cat <<'EOF'
Usage: scripts/e2e-cloud.sh [subcommand] [flags] [playwright-args...]

Subcommands:
  run       (default) Run e2e tests locally or on Cloud Run Jobs
  build     Build and push the Docker image to Artifact Registry
  push      Push an already-built image to Artifact Registry
  logs      Fetch logs from the latest Cloud Run Job execution
  help      Show this help message

Flags:
  --local           Run locally (overrides FRESHELL_E2E_BACKEND)
  --cloud           Run on Cloud Run (overrides FRESHELL_E2E_BACKEND)
  --build           Force image rebuild + push before running
  --local-build     Build locally with Docker instead of Cloud Build
  --shards=N        Number of parallel Cloud Run tasks (default: 1)
  --timeout=DURATION Cloud Run task timeout (default: 60m)
  --grep=PATTERN    Pass --grep=PATTERN to Playwright
  --project=NAME    Pass --project=NAME to Playwright
  --account=EMAIL   GCP account pin (highest precedence; default: none)
  --project-id=ID   GCP project (default: misc-puttering-project)
  --region=REGION   GCP region (default: us-west1)

Environment:
  FRESHELL_E2E_BACKEND  "local" (default) or "cloud"
  FRESHELL_GCP_JOB      Cloud Run job-name prefix (default: freshell-e2e)
  FRESHELL_GCP_ACCOUNT  GCP account override pinned on every gcloud call (optional)

Identity (cloud lanes only — details: docs/development/gcloud-robot.md):
  Cloud subcommands resolve a gcloud identity lazily, in this order:
  --account= > FRESHELL_GCP_ACCOUNT > GCLOUD_IDENT > gcloud-robot probe
  (needs GCLOUD_ROBOT_HOME, the installed gcloud-robot skill directory)
  > ambient gcloud (one quiet stderr note). GCLOUD_ROBOT_REQUIRE=1 fails
  closed with guidance instead of the ambient fallback.

Test image (details: docs/development/cloud-test-images.md): a cloud run
tests an image of exactly the tree it was started from, and its job pins that
image by digest. A clean tree uses the commit tag (<commit>), reused while it
exists; uncommitted changes get <commit>-dirty-<content hash>. Runs that need
the same image share one build instead of building it again.

Cloud job lifecycle: each cloud run creates its OWN unique job
(<prefix>-<commit>[-dirty]-<random>), executes it, and deletes it
afterwards — never a shared job — so concurrent runs cannot overwrite each
other's image/config or read each other's results. The 'logs' subcommand
reads the legacy shared job only; per-run logs are printed in full during
the run and remain in Cloud Logging afterwards.

Examples:
  scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/auth.spec.ts
  scripts/e2e-cloud.sh run --cloud --project=chromium --reporter=line
  scripts/e2e-cloud.sh run --cloud --shards=4 --project=chromium
  scripts/e2e-cloud.sh run --cloud --shards=4 --timeout=30m --project=chromium
  scripts/e2e-cloud.sh build
  scripts/e2e-cloud.sh help
EOF
}

# ---------------------------------------------------------------------------
# Subcommand: build
# ---------------------------------------------------------------------------
cmd_build() {
  local local_build=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --local-build)
        local_build=true
        shift
        ;;
      --account=*)
        GCP_ACCOUNT="${1#*=}"
        shift
        ;;
      --project-id=*)
        GCP_PROJECT="${1#*=}"
        shift
        ;;
      --region=*)
        GCP_REGION="${1#*=}"
        shift
        ;;
      *)
        shift
        ;;
    esac
  done

  # Identity ladder (build/push lane): resolve before the first gcloud call,
  # never at script top — help and local-only paths must keep working with
  # zero GCP tooling. Probe = the lane's gating permission.
  freshell_resolve_cloud_identity "cloudbuild.builds.create"

  # `build` always publishes a fresh image of the current tree (--force); a
  # build of the same tag that is already in flight is still reused.
  local -a ensure_args=(--force)
  if $local_build; then
    ensure_args+=(--local-build)
  fi
  local image_line
  if ! image_line="$(cloud_image_ensure "${ensure_args[@]}")"; then
    echo "[e2e-cloud] ERROR: image build failed." >&2
    exit 1
  fi
  if $local_build; then
    echo "[e2e-cloud] Image published: ${image_line#* } (tag ${image_line%% *})"
  else
    echo "[e2e-cloud] Cloud Build complete: ${image_line#* } (tag ${image_line%% *})"
  fi
}

# ---------------------------------------------------------------------------
# Subcommand: push
# ---------------------------------------------------------------------------
cmd_push() {
  echo "[e2e-cloud] Pushing to Artifact Registry..."

  # The standalone push lane honors the same pin flags as build/run;
  # parse FIRST so an explicit --account= wins without touching the ladder.
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --account=*)
        GCP_ACCOUNT="${1#*=}"
        shift
        ;;
      --project-id=*)
        GCP_PROJECT="${1#*=}"
        shift
        ;;
      --region=*)
        GCP_REGION="${1#*=}"
        shift
        ;;
      *)
        shift
        ;;
    esac
  done

  # A standalone `push` reaches gcloud without passing through cmd_build;
  # resolve idempotently.
  freshell_resolve_cloud_identity "cloudbuild.builds.create"

  # Pushes the local image `build --local-build` made for the CURRENT tree
  # (tagged freshell-e2e:<tag>) — never a shared local tag.
  local image_line
  if ! image_line="$(cloud_image_push_local_build)"; then
    echo "[e2e-cloud] ERROR: push failed." >&2
    exit 1
  fi
  echo "[e2e-cloud] Pushed: ${image_line#* } (tag ${image_line%% *})"
}

# ---------------------------------------------------------------------------
# Subcommand: run
# ---------------------------------------------------------------------------
cmd_run() {
  local local_mode=false
  local cloud_mode=false
  local force_build=false
  local local_build_flag=false
  local shards=1
  local timeout="60m"
  local -a pw_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --local)
        local_mode=true
        shift
        ;;
      --cloud)
        cloud_mode=true
        shift
        ;;
      --build)
        force_build=true
        shift
        ;;
      --local-build)
        local_build_flag=true
        shift
        ;;
      --shards=*)
        shards="${1#*=}"
        shift
        ;;
      --timeout=*)
        timeout="${1#*=}"
        shift
        ;;
      --account=*)
        GCP_ACCOUNT="${1#*=}"
        shift
        ;;
      --project-id=*)
        GCP_PROJECT="${1#*=}"
        shift
        ;;
      --region=*)
        GCP_REGION="${1#*=}"
        shift
        ;;
      --grep=*)
        pw_args+=("$1")
        shift
        ;;
      --project=*)
        pw_args+=("$1")
        shift
        ;;
      *)
        pw_args+=("$1")
        shift
        ;;
    esac
  done

  # Normalize split-form Playwright value flags ("--grep foo" ->
  # "--grep=foo") BEFORE either backend consumes pw_args. The cloud path
  # serializes the args one per line and the container entrypoint
  # classifies entries by shape (dash-prefixed => flag, else positional
  # spec filter), which is only correct when every value-carrying flag is
  # a SINGLE token: a split-form value would be reclassified as a spec
  # filter and silently REORDERED behind the remaining flags
  # ("--project chromium --grep 'auth modal'" became
  # "--project --grep chromium 'auth modal'"). Playwright binds =form
  # identically to split form, so local runs are unaffected. Only the
  # documented value-taking flags are rewritten; boolean switches and the
  # optional-value --update-snapshots are never split-form here.
  local -a value_flags=(--grep --grep-invert --project --reporter --retries --workers --timeout --global-timeout --max-failures --repeat-each --output)
  local -a normalized=()
  local i arg vf matched
  for ((i = 0; i < ${#pw_args[@]}; i++)); do
    arg="${pw_args[i]}"
    matched=false
    for vf in "${value_flags[@]}"; do
      if [ "$arg" = "$vf" ] && [ $((i + 1)) -lt ${#pw_args[@]} ]; then
        normalized+=("$vf=${pw_args[i + 1]}")
        i=$((i + 1))
        matched=true
        break
      fi
    done
    if [ "$matched" = false ]; then
      normalized+=("$arg")
    fi
  done
  pw_args=("${normalized[@]}")

  # The container entrypoint treats --dry-run as a diagnostic-only request: it
  # calculates and prints shard assignments, then exits before Playwright runs.
  # Such a task has no completion/retry receipt by design, so keep Cloud Run's
  # task-success checks below but do not reconcile execution receipts that
  # truthfully do not exist. Scan the normalized array so split-form flags and
  # PLAYWRIGHT_ARGS serialization have one authoritative representation.
  local playwright_dry_run=false
  for arg in "${pw_args[@]}"; do
    if [ "$arg" = "--dry-run" ]; then
      playwright_dry_run=true
      break
    fi
  done

  # Resolve backend: explicit flags override env var; env var defaults to local.
  if $cloud_mode; then
    local_mode=false
  elif $local_mode; then
    : # local_mode already true
  elif [ "${FRESHELL_E2E_BACKEND:-local}" = "cloud" ]; then
    cloud_mode=true
  else
    local_mode=true
  fi

  if $local_mode; then
    echo "[e2e-cloud] Running locally..."
    cd "$ROOT"
    exec npx playwright test \
      --config test/e2e-browser/playwright.config.ts \
      "${pw_args[@]}"
  fi

  # Identity ladder (run lane): resolve before the image lookup / build /
  # job calls below. `run --local` never reaches here (it exec'd above),
  # so the local lane stays free of GCP tooling and of the ladder's
  # stderr note.
  freshell_resolve_cloud_identity "run.jobs.run"

  # The image of exactly this tree (scripts/lib/cloud-image.sh): reused when
  # already published or already being built, otherwise built once. The job
  # below pins its DIGEST, so no concurrent run can swap what this run tests.
  local image_line image_tag
  local -a ensure_args=()
  if $force_build; then
    ensure_args+=(--force)
  fi
  if $local_build_flag; then
    ensure_args+=(--local-build)
  fi
  if ! image_line="$(cloud_image_ensure "${ensure_args[@]+"${ensure_args[@]}"}")"; then
    echo "[e2e-cloud] ERROR: could not build or resolve the test image for this tree." >&2
    exit 1
  fi
  image_tag="${image_line%% *}"
  IMAGE_REMOTE="${image_line#* }"

  echo "[e2e-cloud] Running on Cloud Run Jobs..."
  echo "[e2e-cloud]   Image:   $IMAGE_REMOTE"
  echo "[e2e-cloud]   Tag:     $image_tag"
  echo "[e2e-cloud]   Shards:  $shards"
  echo "[e2e-cloud]   Timeout: $timeout"
  echo "[e2e-cloud]   Args:    ${pw_args[*]}"

  # Build a YAML env-vars file for this run's Cloud Run Job.
  # We use --env-vars-file (YAML) instead of --set-env-vars because
  # --set-env-vars splits on spaces, breaking PLAYWRIGHT_ARGS.
  # PLAYWRIGHT_ARGS is NEWLINE-delimited (one arg per line, YAML literal
  # block scalar) so args CONTAINING spaces (e.g. --grep "foo bar") or YAML
  # metacharacters survive verbatim — a space-joined quoted scalar would be
  # re-split on spaces by the entrypoint and quotes could corrupt the YAML.
  # Note: CLOUD_RUN_TASK_COUNT and CLOUD_RUN_TASK_INDEX are reserved env vars
  # set automatically by Cloud Run when --tasks > 1 — do NOT set them here.
  RUN_ENV_FILE=$(mktemp /tmp/e2e-env-vars.XXXXXX.yaml)
  if [ "${#pw_args[@]}" -gt 0 ]; then
    {
      echo "PLAYWRIGHT_ARGS: |-"
      printf '  %s\n' "${pw_args[@]}"
    } > "$RUN_ENV_FILE"
  else
    echo 'PLAYWRIGHT_ARGS: ""' > "$RUN_ENV_FILE"
  fi

  # Create THIS run's own unique job (see unique_job_name). Create-only: a
  # name collision would mean the job is not unique to this run, so fail
  # rather than fall back to mutating a shared job. The job carries all
  # per-run state (image, tasks, timeout, arg env file) — safe to store on
  # the job precisely because no other run ever touches it. Delete the job
  # (and temp env file) on EVERY exit path: success, failure, Ctrl-C/TERM.
  RUN_JOB_NAME="$(unique_job_name "$image_tag")"
  if ! [[ "$RUN_JOB_NAME" =~ ^[a-z][a-z0-9-]{0,48}$ ]]; then
    echo "[e2e-cloud] ERROR: invalid job name '$RUN_JOB_NAME' (check FRESHELL_GCP_JOB prefix)" >&2
    rm -f "$RUN_ENV_FILE"
    exit 1
  fi
  echo "[e2e-cloud]   Job:     $RUN_JOB_NAME"
  cleanup_run_job() {
    if [ -n "${RUN_JOB_NAME:-}" ]; then
      gcloud run jobs delete $(gcloud_flags) "$RUN_JOB_NAME" --quiet >/dev/null 2>&1 || true
    fi
    if [ -n "${RUN_ENV_FILE:-}" ]; then
      rm -f "$RUN_ENV_FILE"
    fi
  }
  trap cleanup_run_job EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  gcloud run jobs create $(gcloud_flags) "$RUN_JOB_NAME" \
    --image="$IMAGE_REMOTE" \
    --tasks="$shards" \
    --task-timeout="$timeout" \
    --max-retries=0 \
    --env-vars-file="$RUN_ENV_FILE" \
    --memory=2Gi \
    --cpu=2

  # Execute this run's job and wait for completion, capturing the exit
  # status: an execute failure (quota, permissions, template error) MAY NOT
  # masquerade as a test outcome.
  echo "[e2e-cloud] Executing Cloud Run Job..."
  local execute_output
  local execute_exit=0
  local execution_id=""
  execute_output=$(gcloud run jobs execute $(gcloud_flags) "$RUN_JOB_NAME" --wait 2>&1) || execute_exit=$?
  echo "$execute_output"

  # Extract the execution ID from the execute output. gcloud prints
  # `Execution [NAME] has successfully completed.` — brackets are literal and,
  # on color-capable captures, the name is wrapped in ANSI SGR codes — so strip
  # escapes and allow the bracket form. (A bare `Execution \K[^ ]+` captured
  # the bracket+escapes; downstream describe/logs then addressed a nonexistent
  # execution and the `|| echo 0` masking below reported succeeded=0 forever.)
  execution_id=$(echo "$execute_output" \
    | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -oP 'Execution \[?\K[A-Za-z0-9][A-Za-z0-9-]*' \
    | head -1 || true)
  if [ -z "$execution_id" ]; then
    # Fallback: list executions of THIS run's own job only — attribution-safe
    # because no other run ever creates executions under it.
    echo "[e2e-cloud] WARNING: could not capture execution ID, falling back to listing this run's job"
    execution_id=$(gcloud run jobs executions list $(gcloud_flags) \
      --job="$RUN_JOB_NAME" \
      --sort-by="~metadata.creationTimestamp" \
      --format="value(name)" \
      --limit=1 || true)
  fi

  if [ "$execute_exit" -ne 0 ]; then
    echo "[e2e-cloud] Cloud Run Job execution failed (exit code $execute_exit)."
    if [ -n "$execution_id" ]; then
      echo "[e2e-cloud] Fetching logs..."
      gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>/dev/null || true
    fi
    exit 1
  fi

  # Fetch logs (requires beta track for logs read).
  # Capture to a variable so we can print the full output AND extract a
  # per-shard summary, even when some shards fail.
  echo "[e2e-cloud] Fetching logs..."
  local log_output
  if ! log_output=$(gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>&1); then
    # This human formatter exposes textPayload only. It remains useful for
    # display, but never decides whether retry evidence exists; that decision
    # comes from the required jsonPayload query below.
    echo "[e2e-cloud] WARNING: could not read display logs: $log_output" >&2
    log_output=""
  fi

  # Print logs from every shard. Retry traces are retained as bounded base64
  # JSONL chunks in Cloud Logging; redact their bytes here so a successful
  # retry's terminal receipt remains readable while retaining the immutable
  # artifact id and first-attempt stack in the underlying logs.
  local display_log_output
  display_log_output=$(printf '%s\n' "$log_output" | sed -E \
    '/"event":"e2e_playwright_retry_trace_chunk"/ s/("data":")[^"]*/\1<retained-in-cloud-logging>/' )
  echo "$display_log_output"

  # Cloud Run turns structured stdout JSON into jsonPayload, which the human
  # `executions logs read` formatter deliberately does not print. Fetch the
  # machine-readable entries directly, wait through bounded Cloud Logging
  # ingestion lag, and require one exact completion receipt from every task.
  # A query/read/parser failure is never evidence of zero retries.
  query_structured_retry_receipts() {
    local query attempt raw parsed parser_error
    query="resource.type=\"cloud_run_job\" AND labels.\"run.googleapis.com/execution_name\"=\"${execution_id}\" AND (jsonPayload.event=\"e2e_playwright_task_complete\" OR jsonPayload.event=\"e2e_playwright_retry_evidence\")"
    for attempt in 1 2 3 4 5; do
      if raw=$(gcloud logging read "$query" $(account_flag) --project="$GCP_PROJECT" --format=json --limit=1000 2>&1); then
        if parsed=$(printf '%s' "$raw" | node "$ROOT/scripts/e2e-cloud-structured-receipts.mjs" "$execution_id" "$shards" 2>&1); then
          printf '%s\n' "$parsed"
          return 0
        fi
        parser_error="$parsed"
      else
        parser_error="$raw"
      fi
      if [ "$attempt" -lt 5 ]; then
        echo "[e2e-cloud] Waiting for complete structured retry receipts (attempt ${attempt}/5): $parser_error" >&2
        sleep 3
      fi
    done
    echo "[e2e-cloud] ERROR: could not retrieve complete structured retry receipts: $parser_error" >&2
    return 1
  }

  local retry_evidence_count=0
  if $playwright_dry_run; then
    echo "[e2e-cloud] Skipping structured retry-receipt reconciliation for --dry-run (no Playwright task executed)."
  else
    local structured_retry_receipts
    if ! structured_retry_receipts=$(query_structured_retry_receipts); then
      exit 1
    fi

    retry_evidence_count=$(jq -r '.recoveredRetryCount' <<< "$structured_retry_receipts")
    if ! [[ "$retry_evidence_count" =~ ^[0-9]+$ ]]; then
      echo "[e2e-cloud] ERROR: structured retry receipt returned an invalid recoveredRetryCount." >&2
      exit 1
    fi
    if [ "$retry_evidence_count" -gt 0 ]; then
      echo "[e2e-cloud] Recovered Playwright retry evidence retained in Cloud Logging (${retry_evidence_count} case(s)):"
      jq -c '.retryEvidence[] | {taskIndex, failureAttempt, test, error, trace}' <<< "$structured_retry_receipts"
    fi
  fi

  # Extract and display a per-shard summary from the Playwright output.
  # Each shard's entrypoint prints "Shard X/Y assignment" and Playwright's
  # line reporter prints a final "  N passed (duration)" or
  # "  N failed, M passed (duration)" summary line.
  echo ""
  echo "[e2e-cloud] Per-shard summary:"
  echo "$log_output" | grep -E '(\[e2e-entrypoint\] Shard [0-9]+/[0-9]+ assignment|^\s+[0-9]+ (passed|failed))' || true

  # Check execution status — transient describe errors right after
  # `execute --wait` are a real flake class, so retry briefly; a PERMANENT
  # query failure must fail the run, never read as succeeded=0/failed=0.
  query_count() {
    local field="$1" val attempt
    for attempt in 1 2 3 4 5; do
      if val=$(gcloud run jobs executions describe $(gcloud_flags) "$execution_id" \
        --format="value($field)" 2>/dev/null); then
        echo "${val:-0}"
        return 0
      fi
      sleep 3
    done
    return 1
  }
  local succeeded
  local failed
  if ! succeeded=$(query_count status.succeededCount); then
    echo "[e2e-cloud] ERROR: failed to query execution status"
    exit 1
  fi
  if ! failed=$(query_count status.failedCount); then
    echo "[e2e-cloud] ERROR: failed to query execution status"
    exit 1
  fi

  echo ""
  echo "[e2e-cloud] Succeeded tasks: $succeeded"
  echo "[e2e-cloud] Failed tasks: $failed"

  if [ "$failed" -gt 0 ] 2>/dev/null; then
    echo "[e2e-cloud] Some tasks failed."
    exit 1
  fi

  # Zero failures is not success: require every requested task to have
  # succeeded (a cancelled/preempted task yields succeeded=0, failed=0 — and
  # ran zero tests).
  if [ "$succeeded" != "$shards" ]; then
    echo "[e2e-cloud] ERROR: expected $shards succeeded task(s), got $succeeded."
    exit 1
  fi

  # Playwright retries are useful diagnostics, but a task that passes only on
  # retry is not a zero-flake release receipt. The structured evidence above
  # names the exact first failure and durable trace artifact before failing the
  # wrapper; retry policy itself remains unchanged.
  if [ "$retry_evidence_count" -gt 0 ]; then
    echo "[e2e-cloud] ERROR: recovered Playwright retry evidence prevents a zero-flake cloud receipt."
    exit 1
  fi

  echo "[e2e-cloud] All tasks completed successfully."
}

# ---------------------------------------------------------------------------
# Subcommand: logs
# ---------------------------------------------------------------------------
cmd_logs() {
  # `logs read` takes an EXECUTION name, not the job name. NOTE: cloud runs
  # now use unique per-run jobs that are deleted when the run ends — this
  # legacy lookup only helps for executions of the old shared job. Per-run
  # logs are printed in full during the run and remain queryable in Cloud
  # Logging by job/execution name afterwards.

  # Parse the pin flags FIRST (same contract as build/run); the rest passes
  # through to `logs read` verbatim, preserving the existing behavior.
  local -a logs_passthrough=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --account=*)
        GCP_ACCOUNT="${1#*=}"
        shift
        ;;
      --project-id=*)
        GCP_PROJECT="${1#*=}"
        shift
        ;;
      --region=*)
        GCP_REGION="${1#*=}"
        shift
        ;;
      *)
        logs_passthrough+=("$1")
        shift
        ;;
    esac
  done

  # logs is a cloud-only lane (executions list + logs read); resolve after
  # parsing so an explicit pin short-circuits the ladder.
  freshell_resolve_cloud_identity "run.jobs.run"

  local execution_id
  execution_id=$(gcloud run jobs executions list $(gcloud_flags) \
    --job="$GCP_JOB" \
    --sort-by="~metadata.creationTimestamp" \
    --format="value(name)" \
    --limit=1)
  if [ -z "$execution_id" ]; then
    echo "[e2e-cloud] No executions found for job $GCP_JOB" >&2
    exit 1
  fi
  gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" \
    "${logs_passthrough[@]+"${logs_passthrough[@]}"}"
}

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------
SUBCOMMAND="${1:-run}"
case "$SUBCOMMAND" in
  run)
    if [ $# -gt 0 ]; then shift; fi
    cmd_run "$@"
    ;;
  build)
    shift
    cmd_build "$@"
    ;;
  push)
    shift
    cmd_push "$@"
    ;;
  logs)
    shift
    cmd_logs "$@"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    # If first arg is a flag, treat as `run` with that flag
    cmd_run "$SUBCOMMAND" "${@:2}"
    ;;
esac
