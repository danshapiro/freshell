#!/usr/bin/env bash
# vitest-cloud.sh — Cloud Run Jobs wrapper for the retained Vitest tests.
#
# Usage:
#   scripts/vitest-cloud.sh [subcommand] [flags] [vitest-args...]
#
# Subcommands:
#   run       (default) Run vitest tests locally or on Cloud Run Jobs
#   build     Build and push the Docker image to Artifact Registry
#   push      Push an already-built image to Artifact Registry
#   logs      Fetch logs from the latest Cloud Run Job execution
#   help      Show this help message
#
# Backend selection:
#   The FRESHELL_VITEST_BACKEND env var controls where tests run by default:
#     - "local"  (default if unset): run locally via vitest
#     - "cloud":                run on Google Cloud Run Jobs
#   Override at invocation time with --local or --cloud.
#
# Flags:
#   --local           Run locally (overrides FRESHELL_VITEST_BACKEND)
#   --cloud           Run on Cloud Run (overrides FRESHELL_VITEST_BACKEND)
#   --build           Force image rebuild + push before running
#   --local-build     Build locally with Docker instead of Cloud Build
#   --shards=N        Number of parallel Cloud Run tasks (default: 4)
#   --timeout=DURATION Cloud Run task timeout (default: 30m)
#   --config=default             Which retained Vitest config to run
#   --account=EMAIL   GCP account pin (highest precedence; default: none —
#                     FRESHELL_GCP_ACCOUNT env, then the gcloud-robot identity
#                     ladder, then ambient gcloud)
#   --project-id=ID   GCP project (default: FRESHELL_GCP_PROJECT env or misc-puttering-project)
#   --region=REGION   GCP region (default: FRESHELL_GCP_REGION env or us-west1)
#
# Examples:
#   scripts/vitest-cloud.sh run --local test/unit/lib/pane-utils.test.ts
#   scripts/vitest-cloud.sh run --cloud --shards=4
#   scripts/vitest-cloud.sh run --cloud --config=default --shards=2
#   scripts/vitest-cloud.sh build
#   scripts/vitest-cloud.sh help
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
GCP_JOB="${FRESHELL_GCP_VITEST_JOB:-freshell-vitest}"

IMAGE_NAME="freshell-e2e"
IMAGE_LOCAL="${IMAGE_NAME}:latest"
IMAGE_REMOTE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}:latest"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Shared gcloud identity ladder (gcloud-robot). Sourcing only defines
# functions — no side effects, no output — so help and local lanes stay
# gcloud-free and silent.
# shellcheck source=scripts/lib/gcp-identity.sh
. "$SCRIPT_DIR/lib/gcp-identity.sh"

# Commit-addressed image tag — mirrors scripts/e2e-cloud.sh (wrap-review r3):
# a cloud run must execute the code at the CURRENT HEAD — with only a mutable
# :latest tag, `run` would happily execute whatever source was last pushed and
# the "cloud vitest gate" could pass against STALE code. This was observed in
# practice: the freshell-vitest job kept an image predating TEST_MODE=vitest
# support and ran Playwright instead of vitest. `:latest` is still
# built/pushed (human convenience pointer + layer-cache anchor) but the run
# path never uses it. A dirty tree gets a non-addressable `-dirty` SENTINEL
# tag so a build of uncommitted code can never masquerade as the clean commit
# (untracked files count as dirty — the image bakes the working tree);
# `-dirty` tags are never reused: the run path ALWAYS rebuilds on a dirty tree
# (mirrors wrap-review r4).
image_tag_for_head() {
  local sha
  sha="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
  if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    sha="${sha}-dirty"
  fi
  echo "$sha"
}

# Ensure gcloud's bin dir is on PATH (for docker-credential-gcloud used by
# Docker when pushing to Artifact Registry).
if command -v gcloud &>/dev/null; then
  GCLOUD_BIN="$(gcloud info --format="value(installation.sdk_root)" 2>/dev/null)/bin"
  if [ -d "$GCLOUD_BIN" ] && ! echo "$PATH" | grep -q "$GCLOUD_BIN"; then
    export PATH="$GCLOUD_BIN:$PATH"
  fi
fi

DEFAULT_CONFIGS="config/vitest/vitest.config.ts"

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
# swap the image of an in-flight run, and forces "find my execution" to fall
# back to "the latest execution of the shared job" — which may be another
# run's results. Every run therefore creates its own job
# (<prefix>-<imagetag>-<random6>), executes it, and deletes it on every exit
# path (success, failure, SIGINT/SIGTERM). FRESHELL_GCP_VITEST_JOB is the
# prefix.
unique_job_name() {
  local rand
  rand=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6)
  printf '%s-%s-%s' "$GCP_JOB" "$(image_tag_for_head)" "$rand"
}

# gcloud artifacts commands use --location, not --region
gcloud_artifacts_flags() {
  if [ -n "${GCP_ACCOUNT:-}" ]; then
    echo "--account=${GCP_ACCOUNT} --project=${GCP_PROJECT} --location=${GCP_REGION}"
  else
    echo "--project=${GCP_PROJECT} --location=${GCP_REGION}"
  fi
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
Usage: scripts/vitest-cloud.sh [subcommand] [flags] [vitest-args...]

Subcommands:
  run       (default) Run vitest tests locally or on Cloud Run Jobs
  build     Build and push the Docker image to Artifact Registry
  push      Push an already-built image to Artifact Registry
  logs      Fetch logs from the latest Cloud Run Job execution
  help      Show this help message

Flags:
  --local           Run locally (overrides FRESHELL_VITEST_BACKEND)
  --cloud           Run on Cloud Run (overrides FRESHELL_VITEST_BACKEND)
  --build           Force image rebuild + push before running
  --local-build     Build locally with Docker instead of Cloud Build
  --shards=N        Number of parallel Cloud Run tasks (default: 4)
  --timeout=DURATION Cloud Run task timeout (default: 30m)
  --config=default             Which retained Vitest config to run
  --account=EMAIL   GCP account pin (highest precedence; default: none)
  --project-id=ID   GCP project (default: misc-puttering-project)
  --region=REGION   GCP region (default: us-west1)

Environment:
  FRESHELL_VITEST_BACKEND  "local" (default) or "cloud"
  FRESHELL_GCP_VITEST_JOB  Cloud Run job-name prefix (default: freshell-vitest)
  FRESHELL_GCP_ACCOUNT  GCP account override pinned on every gcloud call (optional)

Identity (cloud lanes only — details: docs/development/gcloud-robot.md):
  Cloud subcommands resolve a gcloud identity lazily, in this order:
  --account= > FRESHELL_GCP_ACCOUNT > GCLOUD_IDENT > gcloud-robot probe
  (needs GCLOUD_ROBOT_HOME, the installed gcloud-robot skill directory)
  > ambient gcloud (one quiet stderr note). GCLOUD_ROBOT_REQUIRE=1 fails
  closed with guidance instead of the ambient fallback.

Cloud job lifecycle: each cloud run creates its OWN unique job
(<prefix>-<commit>[-dirty]-<random>), executes it, and deletes it
afterwards — never a shared job — so concurrent runs cannot overwrite each
other's image or read each other's results. The 'logs' subcommand reads the
legacy shared job only; per-run logs are printed in full during the run and
remain in Cloud Logging afterwards.

Examples:
  scripts/vitest-cloud.sh run --local test/unit/lib/pane-utils.test.ts
  scripts/vitest-cloud.sh run --cloud --shards=4
  scripts/vitest-cloud.sh run --cloud --config=default --shards=2
  scripts/vitest-cloud.sh build
  scripts/vitest-cloud.sh help
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

  # Content-addressed tag (see image_tag_for_head): the only tag `run` pins.
  local tag remote_base
  tag="$(image_tag_for_head)"
  remote_base="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}"

  if $local_build; then
    echo "[vitest-cloud] Building Docker image locally (tag: $tag)..."
    docker build -f "$ROOT/docker/cloud-run/Dockerfile" \
      -t "$IMAGE_LOCAL" \
      -t "${IMAGE_NAME}:${tag}" \
      "$ROOT"
    echo "[vitest-cloud] Image built: $IMAGE_LOCAL (${IMAGE_NAME}:${tag})"
    cmd_push
  else
    echo "[vitest-cloud] Building Docker image via Cloud Build (tag: $tag)..."
    gcloud builds submit \
      --config "$ROOT/docker/cloud-run/cloudbuild.yaml" \
      $(account_flag) \
      --project="$GCP_PROJECT" \
      --substitutions=_IMAGE="${remote_base}:${tag}" \
      "$ROOT"
    echo "[vitest-cloud] Cloud Build complete: ${remote_base}:${tag}"
  fi
}

# ---------------------------------------------------------------------------
# Subcommand: push
# ---------------------------------------------------------------------------
cmd_push() {
  echo "[vitest-cloud] Pushing to Artifact Registry..."

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
  # resolve idempotently (free when cmd_build already did).
  freshell_resolve_cloud_identity "cloudbuild.builds.create"

  # Ensure the Artifact Registry repo exists
  if ! gcloud artifacts repositories describe $(gcloud_artifacts_flags) "$GCP_REPO" &>/dev/null; then
    echo "[vitest-cloud] Creating Artifact Registry repository: $GCP_REPO"
    gcloud artifacts repositories create $(gcloud_artifacts_flags) "$GCP_REPO" \
      --repository-format=docker || true
  fi

  # Authenticate Docker to Artifact Registry using an access token.
  gcloud auth print-access-token $(account_flag) | \
    docker login -u oauth2accesstoken --password-stdin \
      "https://${GCP_REGION}-docker.pkg.dev"

  # Push BOTH refs explicitly (mirrors scripts/e2e-cloud.sh): the
  # commit-addressed tag (what `run` resolves) and :latest (human convenience
  # pointer + cache anchor; `run` never consumes it). Never read the mutable
  # $IMAGE_REMOTE global here — the standalone `push` subcommand path still
  # has it at :latest while the run path has repointed it at the HEAD tag.
  local tag remote_base
  tag="$(image_tag_for_head)"
  remote_base="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}"
  docker tag "$IMAGE_LOCAL" "${remote_base}:latest"
  docker tag "$IMAGE_LOCAL" "${remote_base}:${tag}"
  docker push "${remote_base}:${tag}"
  docker push "${remote_base}:latest"
  echo "[vitest-cloud] Pushed: ${remote_base}:${tag} (+ ${remote_base}:latest)"
}

# ---------------------------------------------------------------------------
# Subcommand: run
# ---------------------------------------------------------------------------
cmd_run() {
  local local_mode=false
  local cloud_mode=false
  local force_build=false
  local local_build_flag=false
  local shards=4
  local timeout="30m"
  local config_selector="default"
  local -a vt_args=()

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
      --config=*)
        config_selector="${1#*=}"
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
        vt_args+=("$1")
        shift
        ;;
    esac
  done

  # Resolve configs based on selector
  local configs
  case "$config_selector" in
    default)
      configs="config/vitest/vitest.config.ts"
      ;;
    server)
      echo "[vitest-cloud] ERROR: the retired Node server config is unavailable; use npm run test:server for the Rust cargo lane." >&2
      exit 2
      ;;
    all)
      configs="$DEFAULT_CONFIGS"
      ;;
    *)
      echo "[vitest-cloud] Unknown --config value: $config_selector (expected default)" >&2
      exit 1
      ;;
  esac

  # Resolve backend: explicit flags override env var; env var defaults to local.
  if $cloud_mode; then
    local_mode=false
  elif $local_mode; then
    : # local_mode already true
  elif [ "${FRESHELL_VITEST_BACKEND:-local}" = "cloud" ]; then
    cloud_mode=true
  else
    local_mode=true
  fi

  if $local_mode; then
    echo "[vitest-cloud] Running locally..."
    cd "$ROOT"
    local exit_code=0
    for config in $configs; do
      echo "[vitest-cloud] Running vitest: $config ${vt_args[*]-}"
      npx vitest run --config "$config" "${vt_args[@]+"${vt_args[@]}"}" || exit_code=$?
    done
    exit "$exit_code"
  fi

  # Identity ladder (run lane): resolve before the image describe / build /
  # job calls below. `run --local` never reaches here (it exited above),
  # so the local lane stays free of GCP tooling and of the ladder's
  # stderr note.
  freshell_resolve_cloud_identity "run.jobs.run"

  # Recompute the remote ref with potentially overridden GCP settings —
  # COMMIT-ADDRESSED, never mutable :latest (see image_tag_for_head; mirrors
  # scripts/e2e-cloud.sh): the job must run THIS HEAD's code or fail loudly,
  # never pass on a stale image.
  local image_tag
  image_tag="$(image_tag_for_head)"
  IMAGE_REMOTE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}:${image_tag}"

  # Cloud mode
  if $force_build; then
    if $local_build_flag; then
      cmd_build --local-build
    else
      cmd_build
    fi
  elif [[ "$image_tag" == *-dirty ]]; then
    # A dirty tree has NO addressable content: a stored `<sha>-dirty` tag can
    # only ever name whatever the FIRST dirty build contained, so reusing it
    # would silently run stale source. Always rebuild+push; docker's layer
    # cache keeps an unchanged tree cheap.
    echo "[vitest-cloud] Dirty worktree — rebuilding the image (uncommitted tree has no addressable tag)..."
    if $local_build_flag; then
      cmd_build --local-build
    else
      cmd_build
    fi
  fi

  # Ensure image exists in remote registry
  if ! gcloud artifacts docker images describe "$IMAGE_REMOTE" \
      $(account_flag) --project="$GCP_PROJECT" &>/dev/null 2>&1; then
    echo "[vitest-cloud] Remote image not found, building and pushing..."
    cmd_build
  fi

  echo "[vitest-cloud] Running on Cloud Run Jobs..."
  echo "[vitest-cloud]   Image:   $IMAGE_REMOTE"
  echo "[vitest-cloud]   Shards:  $shards"
  echo "[vitest-cloud]   Timeout: $timeout"
  echo "[vitest-cloud]   Configs: $configs"
  echo "[vitest-cloud]   Args:    ${vt_args[*]-}"

  # Build VITEST_ARGS_JSON (JSON array) from pass-through args.
  # Handle empty args correctly (printf with no args produces [""], not []).
  local vitest_args_json="[]"
  if [ ${#vt_args[@]} -gt 0 ]; then
    vitest_args_json=$(printf '%s\n' "${vt_args[@]}" | jq -R . | jq -sc .)
  fi

  # Create THIS run's own unique job (see unique_job_name). Create-only: a
  # name collision would mean the job is not unique to this run, so fail
  # rather than fall back to mutating a shared job. Per-run overrides
  # (tasks/timeout/env) are passed to `execute` below; the job only carries
  # the image. Delete the job on EVERY exit path: success, failure,
  # Ctrl-C/TERM.
  RUN_JOB_NAME="$(unique_job_name)"
  if ! [[ "$RUN_JOB_NAME" =~ ^[a-z][a-z0-9-]{0,48}$ ]]; then
    echo "[vitest-cloud] ERROR: invalid job name '$RUN_JOB_NAME' (check FRESHELL_GCP_VITEST_JOB prefix)" >&2
    exit 1
  fi
  echo "[vitest-cloud]   Job:     $RUN_JOB_NAME"
  cleanup_run_job() {
    if [ -n "${RUN_JOB_NAME:-}" ]; then
      gcloud run jobs delete $(gcloud_flags) "$RUN_JOB_NAME" --quiet >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_run_job EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  gcloud run jobs create $(gcloud_flags) "$RUN_JOB_NAME" \
    --image="$IMAGE_REMOTE" \
    --max-retries=0 \
    --memory=4Gi \
    --cpu=4

  # Execute the job with per-execution overrides (tasks, timeout, env-vars),
  # and capture the execution ID from the output.
  echo "[vitest-cloud] Executing Cloud Run Job..."
  local execute_output
  local execute_exit=0
  # Use ^@^ delimiter for --update-env-vars to handle commas in JSON arrays.
  local env_overrides="^@^TEST_MODE=vitest@VITEST_CONFIGS=${configs}@VITEST_ARGS_JSON=${vitest_args_json}"
  execute_output=$(gcloud run jobs execute $(gcloud_flags) "$RUN_JOB_NAME" \
    --tasks="$shards" \
    --task-timeout="$timeout" \
    --update-env-vars="$env_overrides" \
    --wait 2>&1) || execute_exit=$?
  echo "$execute_output"

  # Extract the execution ID from the execute output. gcloud prints
  # `Execution [NAME] has successfully completed.` — brackets are literal and,
  # on color-capable captures, the name is wrapped in ANSI SGR codes — so strip
  # escapes and allow the bracket form. (A bare `Execution \K[^ ]+` captures the
  # bracket+escapes; every downstream describe/logs then addresses a nonexistent
  # execution — observed live 2026-08-18 on executions -xzrwg and -ftrdv.)
  local execution_id
  execution_id=$(echo "$execute_output" \
    | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -oP 'Execution \[?\K[A-Za-z0-9][A-Za-z0-9-]*' \
    | head -1 || true)
  if [ -z "$execution_id" ]; then
    # Fallback: list executions of THIS run's own job only — attribution-safe
    # because no other run ever creates executions under it.
    echo "[vitest-cloud] WARNING: could not capture execution ID, falling back to listing this run's job"
    execution_id=$(gcloud run jobs executions list $(gcloud_flags) \
      --job="$RUN_JOB_NAME" \
      --sort-by="~metadata.creationTimestamp" \
      --format="value(name)" \
      --limit=1 || true)
  fi

  # If execute itself failed, report and exit — don't mask with status queries.
  if [ "$execute_exit" -ne 0 ]; then
    echo "[vitest-cloud] Cloud Run Job execution failed (exit code $execute_exit)."
    # Still fetch logs for debugging when an execution was created at all.
    if [ -n "${execution_id:-}" ]; then
      echo "[vitest-cloud] Fetching logs..."
      gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>/dev/null || true
    fi
    exit 1
  fi

  # Fetch logs (one short retry: right after --wait completes, log reads can
  # transiently return empty; observed live 2026-08-18).
  echo "[vitest-cloud] Fetching logs..."
  local log_output
  log_output=$(gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>/dev/null || true)
  if [ -z "$log_output" ]; then
    sleep 3
    log_output=$(gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>/dev/null || true)
  fi

  # Print full log output from ALL shards.
  echo "$log_output"

  # Extract and display a per-shard summary from the vitest output.
  echo ""
  echo "[vitest-cloud] Per-shard summary:"
  echo "$log_output" | grep -E '(\[vitest-entrypoint\]|Test Files|Tests )' || true

  # Check execution status — propagate query errors instead of normalizing to 0.
  # Transient describe failures right after `execute --wait` returns are a real
  # flake class (observed live 2026-08-18: execution succeeded on all 4 shards
  # while a single describe errored, failing the wrapper); retry briefly before
  # declaring the run failed.
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
    echo "[vitest-cloud] ERROR: failed to query execution status"
    exit 1
  fi
  if ! failed=$(query_count status.failedCount); then
    echo "[vitest-cloud] ERROR: failed to query execution status"
    exit 1
  fi

  echo ""
  echo "[vitest-cloud] Succeeded tasks: $succeeded"
  echo "[vitest-cloud] Failed tasks: $failed"

  if [ "$failed" -gt 0 ] 2>/dev/null; then
    echo "[vitest-cloud] Some tasks failed."
    exit 1
  fi

  # Zero failures is not success: require every requested task to have
  # succeeded (a cancelled/preempted task yields succeeded=0, failed=0 — and
  # ran zero tests).
  if [ "$succeeded" != "$shards" ]; then
    echo "[vitest-cloud] ERROR: expected $shards succeeded task(s), got $succeeded."
    exit 1
  fi

  echo "[vitest-cloud] All tasks completed successfully."
}

# ---------------------------------------------------------------------------
# Subcommand: logs
# ---------------------------------------------------------------------------
cmd_logs() {
  # NOTE: cloud runs now use unique per-run jobs that are deleted when the
  # run ends — this legacy lookup only helps for executions of the old shared
  # job. Per-run logs are printed in full during the run and remain queryable
  # in Cloud Logging by job/execution name afterwards.

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
  execution_id=$(gcloud run jobs executions list $(gcloud_flags) --job="$GCP_JOB" --sort-by="~metadata.creationTimestamp" --format="value(name)" --limit=1)
  if [ -z "$execution_id" ]; then
    echo "[vitest-cloud] No executions found for job $GCP_JOB"
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
