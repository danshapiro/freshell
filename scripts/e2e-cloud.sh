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
IMAGE_LOCAL="${IMAGE_NAME}:latest"
IMAGE_REMOTE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}:latest"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# kata e83z: non-TTY stdin is the agent case (bash -c, tool harnesses, CI).
# The identity preflight below is the guaranteed fail-fast leg; this export is
# defense-in-depth — verified in gcloud's CanPrompt() source to be honored as
# the --quiet equivalent even where auto-detection does not apply. Humans at
# a real terminal keep interactive reauth (the export is deliberately withheld
# on TTY stdin).
if [ ! -t 0 ]; then
  export CLOUDSDK_CORE_DISABLE_PROMPTS=1
fi

# Shared gcloud identity ladder (gcloud-robot). Sourcing only defines
# functions — no side effects, no output — so help and local lanes stay
# gcloud-free and silent.
# shellcheck source=scripts/lib/gcp-identity.sh
. "$SCRIPT_DIR/lib/gcp-identity.sh"

# Commit-addressed image tag (wrap-review r3): a cloud run must execute the
# code at the CURRENT HEAD — with only a mutable :latest tag, `run` would
# happily execute whatever source was last pushed and the "cloud e2e gate"
# could pass against STALE code. `:latest` is still built/pushed (human
# convenience pointer + layer-cache anchor) but the run path never uses it.
# A dirty tree gets a non-addressable `-dirty` SENTINEL tag so a build of
# uncommitted code can never masquerade as the clean commit (untracked files
# count as dirty — the image bakes the working tree); `-dirty` tags are not
# content-addressable, so the run path ALWAYS rebuilds on a dirty tree
# instead of reusing a stale `-dirty` image (wrap-review r4).
image_tag_for_head() {
  local sha
  sha="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
  if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    sha="${sha}-dirty"
  fi
  echo "$sha"
}

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
# (<prefix>-<imagetag>-<random6>), executes it, and deletes it on every exit
# path (success, failure, SIGINT/SIGTERM). FRESHELL_GCP_JOB is the prefix.
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

cloud_duration_seconds() {
  node "$ROOT/scripts/e2e-cloud-duration.mjs" "$1"
}

write_cloud_dispatch_receipt() {
  local receipt_path="${FRESHELL_E2E_CLOUD_DISPATCH_RECEIPT:-}"
  [ -n "$receipt_path" ] || return 0
  if ! [[ "$RUN_JOB_NAME" =~ ^[a-z][a-z0-9-]{0,48}$ && "$execution_id" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]]; then
    echo "[e2e-cloud] ERROR: cannot write a dispatch receipt for an invalid job or execution name." >&2
    return 1
  fi
  local temporary="${receipt_path}.tmp.$$"
  local accepted_at
  accepted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! (umask 077; printf '{"jobName":"%s","executionName":"%s","acceptedAt":"%s"}\n' \
    "$RUN_JOB_NAME" "$execution_id" "$accepted_at" > "$temporary") \
    || ! mv -f "$temporary" "$receipt_path"; then
    rm -f "$temporary"
    echo "[e2e-cloud] ERROR: could not publish the accepted Cloud Run execution receipt." >&2
    return 1
  fi
  return 0
}

wait_for_cloud_execution_completion() {
  local timeout_seconds="$1" task_timeout="$2" completion_time deadline describe_failures=0
  # Allow five minutes for Cloud Run's terminal status to settle after the
  # configured per-task deadline.
  deadline=$((SECONDS + timeout_seconds + 300))
  echo "[e2e-cloud] Waiting for execution $execution_id to complete (task deadline: $task_timeout)."
  while (( SECONDS <= deadline )); do
    if completion_time=$(gcloud run jobs executions describe $(gcloud_flags) "$execution_id" \
      --format="value(status.completionTime)" 2>/dev/null); then
      describe_failures=0
      if [ -n "$completion_time" ] && [ "$completion_time" != "(unset)" ]; then return 0; fi
    else
      describe_failures=$((describe_failures + 1))
      if [ "$describe_failures" -ge 5 ]; then
        echo "[e2e-cloud] ERROR: failed to query execution $execution_id status five consecutive times." >&2
        return 1
      fi
    fi
    sleep 3
  done
  echo "[e2e-cloud] ERROR: execution $execution_id did not reach a terminal state within its task timeout and status-settlement margin." >&2
  return 1
}

# kata e83z: cheap live-credential check at lane start — fails in seconds,
# before any build/submit work, when the resolved identity cannot mint a token.
# The error names the resolved identity and its source so the failure path is
# as attributable as the success path.
identity_preflight() {
  if ! gcloud auth print-access-token $(account_flag) >/dev/null 2>&1; then
    echo "[e2e-cloud] ERROR: identity preflight failed for ${GCP_ACCOUNT:-(ambient gcloud)} (source: ${FRESHELL_GCP_IDENTITY_SOURCE:-unresolved}) - gcloud auth print-access-token could not mint a token." >&2
    echo "[e2e-cloud] Fix the credential/identity (docs/development/gcloud-robot.md) and re-run the lane." >&2
    exit 1
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
  FRESHELL_E2E_WS_READY_TIMEOUT_MS  Cloud-lane TestHarness.waitForConnection
                                    window in ms (default 90000; overrides
                                    the 30s in-code default). Set per-run
                                    job env on `run --cloud`; sized to the
                                    observed gVisor wedge class plus the
                                    harness's one-shot self-heal reload.
  FRESHELL_E2E_SERVER_VERBOSE       Set to "1" on cloud runs (always
                                    emitted by `run --cloud`) to pipe the
                                    e2e TestServer's stdout/stderr into
                                    the container log stream so server
                                    logs reach Cloud Logging.

Identity (cloud lanes only — details: docs/development/gcloud-robot.md):
  Cloud subcommands resolve a gcloud identity lazily, in this order:
  --account= > FRESHELL_GCP_ACCOUNT > GCLOUD_IDENT > gcloud-robot probe
  (via GCLOUD_ROBOT_HOME, or the first well-known gcloud-robot skill
  install: ~/.codex/skills/gcloud-robot, ~/.claude/skills/gcloud-robot,
  ~/code/skill-gcloud-robot/gcloud-robot)
  > ambient gcloud (one quiet stderr note). GCLOUD_ROBOT_REQUIRE=1 fails
  closed with guidance instead of the ambient fallback. Non-TTY (agent)
  invocations disable gcloud prompts and preflight the credential, so a
  dead identity fails in seconds instead of hanging.

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
  identity_preflight

  # Content-addressed tag (see image_tag_for_head): the only tag `run` pins.
  local tag remote_base build_commit
  tag="$(image_tag_for_head)"
  remote_base="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}"
  build_commit="$(git -C "$ROOT" rev-parse HEAD)"
  if ! [[ "$build_commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "[e2e-cloud] ERROR: HEAD is not a lowercase 40-hex commit: $build_commit" >&2
    exit 1
  fi

  # kata e83z (delta review F2): a direct `build` computes the same `-dirty`
  # sentinel tag the run lane warns about — surface it loudly HERE too, so
  # the direct build path leads its build work with the same WARNING shape
  # (cmd_run's own WARNING stays put; its rebuild path re-enters here and the
  # first occurrence is what the ordering checks pin).
  if [[ "$tag" == *-dirty ]]; then
    echo "[e2e-cloud] WARNING: dirty worktree - image tag ${tag} is not content-addressed; this build bakes the uncommitted tree and the result is not reusable."
  fi

  if $local_build; then
    echo "[e2e-cloud] Building Docker image locally (tag: $tag)..."
    docker build -f "$ROOT/docker/cloud-run/Dockerfile" \
      --build-arg "FRESHELL_BUILD_COMMIT=${build_commit}" \
      -t "$IMAGE_LOCAL" \
      -t "${IMAGE_NAME}:${tag}" \
      "$ROOT"
    echo "[e2e-cloud] Image built: $IMAGE_LOCAL (${IMAGE_NAME}:${tag})"
    cmd_push
  else
    echo "[e2e-cloud] Building Docker image via Cloud Build (tag: $tag)..."
    gcloud builds submit \
      --config "$ROOT/docker/cloud-run/cloudbuild.yaml" \
      $(account_flag) \
      --project="$GCP_PROJECT" \
      --substitutions=_IMAGE="${remote_base}:${tag}",_FRESHELL_BUILD_COMMIT="$build_commit" \
      "$ROOT"
    echo "[e2e-cloud] Cloud Build complete: ${remote_base}:${tag}"
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
  # resolve idempotently (free when cmd_build already did).
  freshell_resolve_cloud_identity "cloudbuild.builds.create"
  identity_preflight

  # Ensure the Artifact Registry repo exists
  if ! gcloud artifacts repositories describe $(gcloud_artifacts_flags) "$GCP_REPO" &>/dev/null; then
    echo "[e2e-cloud] Creating Artifact Registry repository: $GCP_REPO"
    gcloud artifacts repositories create $(gcloud_artifacts_flags) "$GCP_REPO" \
      --repository-format=docker || true
  fi

  # Authenticate Docker to Artifact Registry using an access token.
  # We can't rely on the docker-credential-gcloud helper being on PATH.
  gcloud auth print-access-token $(account_flag) | \
    docker login -u oauth2accesstoken --password-stdin \
      "https://${GCP_REGION}-docker.pkg.dev"

  # Push BOTH refs explicitly: the commit-addressed tag (what `run`
  # resolves) and :latest (human convenience pointer + cache anchor; `run`
  # never consumes it). Never read the mutable $IMAGE_REMOTE global here —
  # the standalone `push` subcommand path still has it at :latest while the
  # run path has repointed it at the HEAD tag.
  local tag remote_base
  tag="$(image_tag_for_head)"
  remote_base="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}"
  docker tag "$IMAGE_LOCAL" "${remote_base}:latest"
  docker tag "$IMAGE_LOCAL" "${remote_base}:${tag}"
  docker push "${remote_base}:${tag}"
  docker push "${remote_base}:latest"
  echo "[e2e-cloud] Pushed: ${remote_base}:${tag} (+ ${remote_base}:latest)"
}

# ---------------------------------------------------------------------------
# Subcommand: run
# ---------------------------------------------------------------------------
cmd_run() {
  cd "$ROOT"
  local local_mode=false
  local cloud_mode=false
  local force_build=false
  local local_build_flag=false
  local shards=1
  local timeout="60m"
  local timeout_seconds
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

  # External browser targets are a closed fixture/project pair. Validate before
  # identity, image lookup or paid dispatch; ordinary lanes remain unchanged.
  local external_handoff=false
  if [ -n "${FRESHELL_E2E_EXTERNAL_FIXTURE_KIND:-}${FRESHELL_MANAGED_ENVIRONMENT_FIXTURE:-}${FRESHELL_CODE_CHECKPOINT_FIXTURE:-}" ]; then
    external_handoff=true
  fi
  for arg in "${pw_args[@]}"; do
    case "$arg" in
      --project=chromium-external-target|*managed-provider-environment-external.spec.ts|*code-checkpoint-workspace-external.spec.ts)
        external_handoff=true ;;
    esac
  done
  if $external_handoff; then
    (cd "$ROOT" && pnpm exec tsx scripts/testing/e2e-external-target.ts validate "${pw_args[@]}")
  fi

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
  # backend_source records HOW the lane was chosen (flag / env / default) —
  # the banner prints the RESOLVED lane and its selection source, never the
  # raw env value, which misleads when a flag overrides it.
  local backend_source="default"
  if $cloud_mode; then
    local_mode=false
    backend_source="flag --cloud"
  elif $local_mode; then
    backend_source="flag --local"
  elif [ "${FRESHELL_E2E_BACKEND:-local}" = "cloud" ]; then
    cloud_mode=true
    backend_source="env FRESHELL_E2E_BACKEND=cloud"
  else
    local_mode=true
    if [ -n "${FRESHELL_E2E_BACKEND:-}" ]; then
      backend_source="env FRESHELL_E2E_BACKEND=$FRESHELL_E2E_BACKEND"
    fi
  fi

  # Validate the closed owned target before any identity, build or job action.
  # JSON-quoted YAML values retain exact selections without exporting owner
  # paths, OneCLI files, Docker access or local receipt destinations.
  local managed_external_yaml managed_external=false
  managed_external_yaml=$(cd "$ROOT" && pnpm exec tsx scripts/testing/e2e-external-target.ts cloud-metadata "${pw_args[@]}")
  if [ -n "$managed_external_yaml" ]; then
    managed_external=true
    if $local_mode || [ "$shards" != "1" ]; then
      echo "[e2e-cloud] ERROR: the owned external target requires configured Cloud and exactly one task." >&2
      exit 1
    fi
    if [ "$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA" != "$(git -C "$ROOT" rev-parse HEAD)" ] || [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
      echo "[e2e-cloud] ERROR: the owned external target requires this exact clean candidate." >&2
      exit 1
    fi
  fi

  if $local_mode; then
    echo "[e2e-cloud] Running locally... (config: test/e2e-browser/playwright.config.ts; CLOUD_SKIP_SPECS does not apply on this lane; backend=local; source: ${backend_source})"
    cd "$ROOT"
    exec pnpm exec playwright test \
      --config test/e2e-browser/playwright.config.ts \
      "${pw_args[@]}"
  fi

  # Parse and bound the completion-wait budget before any Cloud API call or
  # job creation. Cloud Run accepts decimal and ISO-8601 duration forms; a
  # post-dispatch parse failure would otherwise leave an accepted execution
  # without a valid local wait deadline.
  if ! timeout_seconds=$(cloud_duration_seconds "$timeout"); then
    echo "[e2e-cloud] ERROR: unsupported Cloud Run task timeout duration '$timeout'." >&2
    exit 1
  fi

  # Identity ladder (run lane): resolve before the image describe / build /
  # job calls below. `run --local` never reaches here (it exec'd above),
  # so the local lane stays free of GCP tooling and of the ladder's
  # stderr note.
  freshell_resolve_cloud_identity "run.jobs.run"
  identity_preflight

  # Recompute the remote ref with potentially overridden GCP settings —
  # COMMIT-ADDRESSED, never mutable :latest (see image_tag_for_head): the
  # job must run THIS HEAD's code or fail loudly, never pass on a stale
  # image.
  local image_tag
  image_tag="$(image_tag_for_head)"
  IMAGE_REMOTE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${GCP_REPO}/${IMAGE_NAME}:${image_tag}"

  # kata e83z: lead the lane output with identity attribution and loud
  # dirty-tree state, BEFORE the image-lookup/rebuild decision below — the
  # decision can run a ~13-minute build, and these lines must not trail it.
  # The mid-run dirty line inside the decision block and the `Running on
  # Cloud Run Jobs...` block below keep their existing positions.
  if [[ "$image_tag" == *-dirty ]]; then
    echo "[e2e-cloud] WARNING: dirty worktree - image tag ${image_tag} is not content-addressed; this run cold-rebuilds the image (~13 min) and the result is not reusable."
  fi
  echo "[e2e-cloud] Identity: ${GCP_ACCOUNT:-(ambient gcloud)} (source: ${FRESHELL_GCP_IDENTITY_SOURCE:-unresolved})"

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
    # would silently run stale source (wrap-review r4). Always rebuild+push;
    # docker's layer cache keeps an unchanged tree cheap.
    echo "[e2e-cloud] Dirty worktree — rebuilding the image (uncommitted tree has no addressable tag)..."
    if $local_build_flag; then
      cmd_build --local-build
    else
      cmd_build
    fi
  elif ! gcloud artifacts docker images describe "$IMAGE_REMOTE" \
      $(account_flag) --project="$GCP_PROJECT" &>/dev/null 2>&1; then
    # Clean tree: the HEAD tag genuinely addresses this image's content.
    echo "[e2e-cloud] No remote image for HEAD ($image_tag), building and pushing..."
    if $local_build_flag; then
      cmd_build --local-build
    else
      cmd_build
    fi
  fi

  local managed_browser_digest=""
  if $managed_external; then
    managed_browser_digest=$(gcloud artifacts docker images describe "$IMAGE_REMOTE" \
      $(account_flag) --project="$GCP_PROJECT" --format='value(image_summary.digest)')
    if [[ ! "$managed_browser_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      echo "[e2e-cloud] ERROR: exact managed browser image digest is unavailable." >&2
      exit 1
    fi
    local managed_source_digest="$managed_browser_digest"
    managed_browser_digest=$(node --input-type=module - "${IMAGE_REMOTE%:*}" "$managed_source_digest" "$GCP_ACCOUNT" <<'JS'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
try {
  const [repository, sourceDigest, account] = process.argv.slice(2)
  if (!/^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/.test(repository)) throw new Error('repository')
  const token = execFileSync('gcloud', ['auth', 'print-access-token', ...(account ? [`--account=${account}`] : [])], { encoding: 'utf8', timeout: 30_000 }).trim()
  const imageTypes = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']
  const indexTypes = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']
  async function manifest(digest) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('digest')
    const response = await fetch(`https://${repository.split('/')[0]}/v2/${repository.split('/').slice(1).join('/')}/manifests/${digest}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: [...indexTypes, ...imageTypes].join(', ') },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok || response.headers.get('Docker-Content-Digest') !== digest) throw new Error('manifest response')
    const raw = Buffer.from(await response.arrayBuffer())
    if (raw.length > 2 * 1024 * 1024 || `sha256:${createHash('sha256').update(raw).digest('hex')}` !== digest) throw new Error('manifest content')
    const document = JSON.parse(raw.toString('utf8'))
    if (document.schemaVersion !== 2) throw new Error('manifest schema')
    return document
  }
  const source = await manifest(sourceDigest)
  let selectedDigest = sourceDigest
  if (indexTypes.includes(source.mediaType)) {
    if (!Array.isArray(source.manifests)) throw new Error('index')
    const matches = source.manifests.filter(entry => entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64')
    if (matches.length !== 1 || !imageTypes.includes(matches[0].mediaType)) throw new Error('platform')
    selectedDigest = matches[0].digest
    const selected = await manifest(selectedDigest)
    if (!imageTypes.includes(selected.mediaType)) throw new Error('selected manifest')
  } else if (!imageTypes.includes(source.mediaType)) throw new Error('manifest type')
  console.log(selectedDigest)
} catch {
  console.error('[e2e-cloud] ERROR: exact candidate Linux amd64 image manifest could not be verified.')
  process.exit(1)
}
JS
    )
    IMAGE_REMOTE="${IMAGE_REMOTE%:*}@${managed_browser_digest}"
    jq -cn --arg runId "$FRESHELL_RUNTIME_EXTERNAL_RUN_ID" --arg candidateSha "$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA" \
      --arg sourceImageDigest "$managed_source_digest" --arg imageDigest "$managed_browser_digest" \
      '{severity:"info", event:"managed_external_image_resolved", runId:$runId, candidateSha:$candidateSha, sourceImageDigest:$sourceImageDigest, imageDigest:$imageDigest}'
  fi

  echo "[e2e-cloud] Running on Cloud Run Jobs..."
  echo "[e2e-cloud]   Image:   $IMAGE_REMOTE"
  echo "[e2e-cloud]   Shards:  $shards"
  echo "[e2e-cloud]   Timeout: $timeout"
  echo "[e2e-cloud]   Args:    ${pw_args[*]}"
  echo "[e2e-cloud]   Config:  test/e2e-browser/playwright.cloud.config.ts (CLOUD_SKIP_SPECS testIgnore + CLOUD_SKIP_TITLES grepInvert apply on this lane)"

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
  if $managed_external; then
    printf '%s\n' "$managed_external_yaml" >> "$RUN_ENV_FILE"
  fi

  # Cloud-lane WS-ready tolerance (kata j90s). Under gVisor the e2e Node
  # TestServer occasionally suffers a ~40-60s zero-CPU wedge of in-flight
  # I/O: a timeout-less boot-chain fetch hangs, the WS never starts, and
  # waitForConnection can never see ready regardless of window size (see
  # the j90s stall investigation). Wedges self-heal — a fresh boot chain
  # completes in ~6s afterwards — so the harness's opt-in self-heal
  # (ONE mid-wait page.reload once ready misses half the window) plus this
  # 90s window (a single absolute deadline: phase 1 + reload + phase 2
  # spend at most W+1s together) survives the observed wedge class with
  # margin. The freshellPage fixture's boot chain derives its OWN setup
  # timeout from this window COMPOSED with the chain's other permitted
  # waits (window + 1s connection slack + the ENFORCED bounds on the
  # initial operations (goto 60s explicit + harness install 60s explicit
  # at the freshellPage boot call site —
  # unconfigured Playwright-Test navigations/waits are UNLIMITED, so the
  # bounds are enforced in the fixture chain, not assumed; delta r14) +
  # the picker's permitted worst case (~110.5s,
  # incl. the post-click-timeout creation probe), ~321.5s at this default
  # window) — Playwright's
  # fixture-timeout mechanism, so slow SETUP gets the allowance while
  # every test body keeps the config's 60s default; the wiring never
  # touches any test's own deadline. Override by exporting
  # FRESHELL_E2E_WS_READY_TIMEOUT_MS (ms) before this script; the derived
  # fixture timeout scales with the override.
  echo "FRESHELL_E2E_WS_READY_TIMEOUT_MS: \"${FRESHELL_E2E_WS_READY_TIMEOUT_MS:-90000}\"" >> "$RUN_ENV_FILE"
  # Server-log visibility (kata j90s): the TestServer pipes its
  # stdout/stderr into the container log stream only when the e2e
  # fixtures see FRESHELL_E2E_SERVER_VERBOSE=1 — without it, server logs
  # stay in in-memory buffers and a wedge episode is undiagnosable from
  # Cloud Logging (the cost of the first two j90s cloud cycles).
  echo "FRESHELL_E2E_SERVER_VERBOSE: \"1\"" >> "$RUN_ENV_FILE"

  # Create THIS run's own unique job (see unique_job_name). Create-only: a
  # name collision would mean the job is not unique to this run, so fail
  # rather than fall back to mutating a shared job. The job carries all
  # per-run state (image, tasks, timeout, arg env file) — safe to store on
  # the job precisely because no other run ever touches it. Delete the job
  # (and temp env file) on EVERY exit path: success, failure, Ctrl-C/TERM.
  RUN_JOB_NAME="$(unique_job_name)"
  if ! [[ "$RUN_JOB_NAME" =~ ^[a-z][a-z0-9-]{0,48}$ ]]; then
    echo "[e2e-cloud] ERROR: invalid job name '$RUN_JOB_NAME' (check FRESHELL_GCP_JOB prefix)" >&2
    rm -f "$RUN_ENV_FILE"
    exit 1
  fi
  echo "[e2e-cloud]   Job:     $RUN_JOB_NAME"
  RUN_MANAGED_EXTERNAL=$managed_external
  cleanup_run_job() {
    local initial_status=$? cleanup_ok=true
    if [ -n "${RUN_JOB_NAME:-}" ]; then
      if ${RUN_MANAGED_EXTERNAL:-false}; then
        # Reuse the owner cleanup operation: observe identity, cancel any
        # unfinished owned execution, delete the exact job and verify absence.
        if ! jq -cn --arg runId "$FRESHELL_RUNTIME_EXTERNAL_RUN_ID" --arg candidateSha "$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA" \
          --arg jobName "$RUN_JOB_NAME" --arg project "$GCP_PROJECT" --arg region "$GCP_REGION" --arg account "$GCP_ACCOUNT" \
          '{runId:$runId,candidateSha:$candidateSha,jobName:$jobName,project:$project,region:$region,account:$account}' | \
          pnpm exec tsx -e 'import fs from "node:fs"; import { cleanupOwnedExternalCloudJob } from "./scripts/testing/runtime-external-browser.ts"; cleanupOwnedExternalCloudJob(JSON.parse(fs.readFileSync(0,"utf8")))' >/dev/null 2>&1; then
          cleanup_ok=false
        fi
        jq -cn --arg runId "$FRESHELL_RUNTIME_EXTERNAL_RUN_ID" --arg candidateSha "$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA" \
          --arg jobName "$RUN_JOB_NAME" --argjson ok "$cleanup_ok" \
          '{severity: (if $ok then "info" else "error" end), event:"managed_external_job_cleanup", runId:$runId, candidateSha:$candidateSha, jobName:$jobName, ok:$ok}'
      else
        gcloud run jobs delete $(gcloud_flags) "$RUN_JOB_NAME" --quiet >/dev/null 2>&1 || true
      fi
    fi
    if [ -n "${RUN_ENV_FILE:-}" ]; then
      rm -f "$RUN_ENV_FILE"
    fi
    if ! $cleanup_ok; then
      echo "[e2e-cloud] ERROR: exact owned job cleanup could not be verified." >&2
      exit 1
    fi
    return "$initial_status"
  }
  trap cleanup_run_job EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if $external_handoff; then
    (cd "$ROOT" && pnpm exec tsx scripts/testing/e2e-external-target.ts append-env "$RUN_ENV_FILE" "${pw_args[@]}")
  fi

  # 4 CPU / 4Gi (the coordinator's pre-authorized escalation for the
  # unified-agent-names acceptance lane): the 2-CPU instances' cold-attempt
  # convergence — the pending-name journeys' verified bind + the five-surface
  # shared-name reads — exceeded the per-case budgets across three
  # consecutive focused runs (retry-passing flakes), while the same specs
  # are 44/44 green locally at 3 workers.
  local -a owned_job_labels=()
  if $managed_external; then
    owned_job_labels=("--labels=freshell-managed-run=$FRESHELL_RUNTIME_EXTERNAL_RUN_ID,freshell-managed-candidate=$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA")
    if [ -z "$GCP_ACCOUNT" ]; then
      echo "[e2e-cloud] ERROR: managed external cleanup requires a resolved Cloud identity." >&2
      exit 1
    fi
    # Reserve the exact name before create: a lost create acknowledgement can
    # leave a real job even when this launcher's EXIT trap cannot complete.
    jq -cn --arg runId "$FRESHELL_RUNTIME_EXTERNAL_RUN_ID" --arg candidateSha "$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA" \
      --arg jobName "$RUN_JOB_NAME" --arg project "$GCP_PROJECT" --arg region "$GCP_REGION" --arg account "$GCP_ACCOUNT" \
      '{severity:"info", event:"managed_external_job_reserved", runId:$runId, candidateSha:$candidateSha, jobName:$jobName, project:$project, region:$region, account:$account}'
  fi
  gcloud run jobs create $(gcloud_flags) "$RUN_JOB_NAME" \
    --image="$IMAGE_REMOTE" \
    --tasks="$shards" \
    --task-timeout="$timeout" \
    --max-retries=0 \
    --env-vars-file="$RUN_ENV_FILE" \
    --memory=4Gi \
    --cpu=4 "${owned_job_labels[@]}"
  if $managed_external; then
    local managed_job_image
    if ! managed_job_image=$(gcloud run jobs describe $(gcloud_flags) "$RUN_JOB_NAME" --format=json | \
      jq -er --arg jobName "$RUN_JOB_NAME" --arg runId "$FRESHELL_RUNTIME_EXTERNAL_RUN_ID" \
        --arg candidateSha "$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA" --arg image "$IMAGE_REMOTE" '
        select(.metadata.name == $jobName
          and .metadata.labels["freshell-managed-run"] == $runId
          and .metadata.labels["freshell-managed-candidate"] == $candidateSha)
        | .spec.template.spec.template.spec.containers
        | select(length == 1 and .[0].image == $image) | .[0].image'); then
      echo "[e2e-cloud] ERROR: exact owned job image observation is unavailable or changed." >&2
      exit 1
    fi
    jq -cn --arg runId "$FRESHELL_RUNTIME_EXTERNAL_RUN_ID" --arg candidateSha "$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA" \
      --arg jobName "$RUN_JOB_NAME" --arg image "$managed_job_image" --arg imageDigest "$managed_browser_digest" \
      '{severity:"info", event:"managed_external_job_created", runId:$runId, candidateSha:$candidateSha, jobName:$jobName, image:$image, imageDigest:$imageDigest}'
  fi

  # Start this run's job and capture the accepted execution ID immediately.
  # The external managed-environment target uses the dispatch receipt below
  # to start its browser acceptance window after cold image build and job
  # setup, while this wrapper still waits for the exact execution to finish.
  echo "[e2e-cloud] Executing Cloud Run Job..."
  local execute_output
  local execute_exit=0
  local execution_id=""
  execute_output=$(gcloud run jobs execute $(gcloud_flags) "$RUN_JOB_NAME" --async 2>&1) || execute_exit=$?
  echo "$execute_output"

  # Extract the execution ID from the execute output. gcloud prints
  # `Execution [NAME] has successfully started running.` — brackets are
  # literal and may contain ANSI SGR codes — so strip escapes and allow the
  # bracket form. A bare `Execution \K[^ ]+` captured the bracket+escapes,
  # making downstream describe/logs address a nonexistent execution.
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

  if $managed_external && [ -n "$execution_id" ]; then
    if [[ "$execution_id" != "$RUN_JOB_NAME"-* ]]; then
      echo "[e2e-cloud] ERROR: observed execution differs from the exact owned job." >&2
      exit 1
    fi
    local managed_execution_image managed_execution_json
    if ! managed_execution_json=$(gcloud run jobs executions describe $(gcloud_flags) "$execution_id" --format=json); then
      managed_execution_json=null
    fi
    if ! managed_execution_image=$(jq -er --arg executionName "$execution_id" --arg image "$IMAGE_REMOTE" '
        select(.metadata.name == $executionName) | .spec.template.spec.containers
        | select(length == 1 and .[0].image == $image) | .[0].image' <<< "$managed_execution_json"); then
      jq -cn --arg runId "$FRESHELL_RUNTIME_EXTERNAL_RUN_ID" --arg candidateSha "$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA" \
        --arg jobName "$RUN_JOB_NAME" --arg executionName "$execution_id" --arg expectedImage "$IMAGE_REMOTE" \
        --argjson observed "$managed_execution_json" '
        def name: if type == "string" and test("^[A-Za-z0-9_./-]{1,300}$") then . else null end;
        def image: if type == "string" and test("^([a-z0-9.-]+(/[A-Za-z0-9._-]+)+(:[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})|sha256:[a-f0-9]{64})$") then . else null end;
        ($observed | if type == "object" then . else {} end) as $object
        | $object.spec.template.spec.containers as $containers
        | {severity:"error", event:"managed_external_execution_image_refused", runId:$runId, candidateSha:$candidateSha,
          jobName:$jobName, executionName:$executionName, expectedImage:$expectedImage,
          observedName:($object.metadata.name | name),
          observedContainerCount:(if ($containers | type) == "array" then ($containers | length) else null end),
          observedImages:(if ($containers | type) == "array" then ($containers | map(if type == "object" then .image | image else null end)) else null end)}'
      echo "[e2e-cloud] ERROR: exact owned execution image observation is unavailable or changed." >&2
      exit 1
    fi
    jq -cn --arg runId "$FRESHELL_RUNTIME_EXTERNAL_RUN_ID" --arg candidateSha "$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA" \
      --arg jobName "$RUN_JOB_NAME" --arg executionName "$execution_id" --arg image "$managed_execution_image" \
      --arg imageDigest "$managed_browser_digest" \
      '{severity:"info", event:"managed_external_job_execution", runId:$runId, candidateSha:$candidateSha, jobName:$jobName, executionName:$executionName, image:$image, imageDigest:$imageDigest}'
  fi

  if [ "$execute_exit" -ne 0 ]; then
    echo "[e2e-cloud] Cloud Run Job execution failed (exit code $execute_exit)."
    if [ -n "$execution_id" ]; then
      echo "[e2e-cloud] Fetching logs..."
      gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>/dev/null || true
    fi
    exit 1
  fi
  if $managed_external && [ -z "$execution_id" ]; then
    echo "[e2e-cloud] ERROR: exact managed execution identity is unavailable." >&2
    exit 1
  fi

  if [ -z "$execution_id" ]; then
    echo "[e2e-cloud] ERROR: Cloud Run accepted the execute request but returned no execution ID." >&2
    exit 1
  fi
  if ! write_cloud_dispatch_receipt; then
    exit 1
  fi
  echo "[e2e-cloud] Cloud Run execution accepted: $execution_id"
  if ! wait_for_cloud_execution_completion "$timeout_seconds" "$timeout"; then
    exit 1
  fi

  # Fetch logs (requires beta track for logs read).
  # Capture to a variable so we can print the full output AND extract a
  # per-shard summary, even when some shards fail.
  echo "[e2e-cloud] Fetching logs..."
  local log_output="" summary_lines="" display_log_unavailable=false task_summaries_complete=false
  local task_summary_query task_summary_logs task_summary_receipts="" task_summary_error=""
  local -a task_summary_account_args=()
  local summary_attempt
  if [ -n "${GCP_ACCOUNT:-}" ]; then
    task_summary_account_args=(--account="$GCP_ACCOUNT")
  fi
  # Cloud Run's raw textPayload can begin with cursor-control ANSI sequences,
  # so the Logging filter intentionally matches the status phrase unanchored;
  # the parser strips ANSI and confirms that the normalized line is a footer.
  task_summary_query="resource.type=\"cloud_run_job\" AND labels.\"run.googleapis.com/execution_name\"=\"${execution_id}\" AND (textPayload =~ \"[0-9]+ (failed|passed|skipped|interrupted)\" OR textPayload=\"[e2e-entrypoint] No specs assigned to this shard. Exporting zero-test receipt.\")"
  for summary_attempt in 1 2 3 4 5; do
    if log_output=$(gcloud beta run jobs executions logs read $(gcloud_flags) "$execution_id" 2>&1); then
      summary_lines=$(printf '%s\n' "$log_output" | node "$ROOT/scripts/testing/e2e-cloud-log-summary.mjs")
      display_log_unavailable=false
    else
      log_output=""
      display_log_unavailable=true
    fi

    task_summaries_complete=false
    task_summary_error=""
    if $playwright_dry_run; then
      break
    fi
    if task_summary_logs=$(gcloud logging read "$task_summary_query" "${task_summary_account_args[@]}" \
      --project="$GCP_PROJECT" --format=json --limit=1000 2>&1); then
      if task_summary_receipts=$(printf '%s' "$task_summary_logs" \
        | node "$ROOT/scripts/e2e-cloud-task-summaries.mjs" "$execution_id" "$shards" 2>&1); then
        task_summaries_complete=true
      else
        task_summary_error="$task_summary_receipts"
      fi
    else
      task_summary_error="$task_summary_logs"
    fi
    if $task_summaries_complete; then
      if [ "$(jq -r '.hasPassedTest' <<< "$task_summary_receipts")" = "true" ]; then
        break
      fi
      task_summary_error="task-indexed summaries are complete, but no passed Playwright footer has arrived yet"
    fi
    if [ "$summary_attempt" -lt 5 ]; then
      echo "[e2e-cloud] Waiting for task-indexed Playwright summary evidence (attempt ${summary_attempt}/5): ${task_summary_error}" >&2
      sleep 3
    fi
  done
  if $display_log_unavailable; then
    # This human formatter exposes textPayload only. It remains useful for
    # display, but never decides whether retry evidence exists; that decision
    # comes from the required jsonPayload query below.
    echo "[e2e-cloud] WARNING: could not read display logs after five attempts." >&2
  fi
  if ! $task_summaries_complete && ! $playwright_dry_run; then
    echo "[e2e-cloud] WARNING: task-indexed Playwright footer or empty-shard evidence for all ${shards} task(s) was not present in Cloud Logging after five attempts." >&2
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

  # Display only the summary rows whose raw textPayload entries were validated
  # against this execution's Cloud Run task indexes. The formatted logs above
  # can lag independently, so they are not a reliable source for this section.
  echo ""
  echo "[e2e-cloud] Per-shard summary:"
  if $playwright_dry_run; then
    printf '%s\n' "$summary_lines"
  elif $task_summaries_complete; then
    jq -r '.summaries[] | "[Cloud Run task \(.taskIndex)]\n\(.text)"' <<< "$task_summary_receipts"
  fi

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

  if ! $playwright_dry_run; then
    if ! $task_summaries_complete; then
      echo "[e2e-cloud] ERROR: required task-indexed Playwright summary evidence was not present after five attempts: ${task_summary_error}" >&2
      exit 1
    fi
    if [ "$(jq -r '.hasPassedTest' <<< "$task_summary_receipts")" != "true" ]; then
      echo "[e2e-cloud] ERROR: Cloud execution completed with no passed Playwright tests; skipped tests and empty shards do not count." >&2
      exit 1
    fi
  fi

  # Playwright retries are useful diagnostics, but a task that passes only on
  # retry is not a zero-flake release receipt. The structured evidence above
  # names the exact first failure and durable trace artifact before failing the
  # wrapper; retry policy itself remains unchanged.
  if [ "$retry_evidence_count" -gt 0 ]; then
    echo "[e2e-cloud] ERROR: recovered Playwright retry evidence prevents a zero-flake cloud receipt."
    exit 1
  fi

  if $managed_external; then
    local external_query external_raw external_cases external_attempt external_complete=false
    external_query="resource.type=\"cloud_run_job\" AND labels.\"run.googleapis.com/execution_name\"=\"${execution_id}\" AND jsonPayload.runId=\"${FRESHELL_RUNTIME_EXTERNAL_RUN_ID}\" AND jsonPayload.candidateSha=\"${FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA}\" AND (jsonPayload.event=\"managed_external_case\" OR jsonPayload.event=\"managed_external_complete\")"
    for external_attempt in 1 2 3 4 5; do
      if external_raw=$(gcloud logging read "$external_query" $(account_flag) --project="$GCP_PROJECT" --format=json --limit=1000 2>/dev/null); then
        if external_cases=$(printf '%s' "$external_raw" | pnpm exec tsx -e 'import fs from "node:fs"; import { parseExternalCloudExecutionEvents } from "./scripts/testing/runtime-external-browser.ts"; const entries=JSON.parse(fs.readFileSync(0,"utf8")); const cases=parseExternalCloudExecutionEvents(entries.map((entry: { jsonPayload?: unknown })=>entry.jsonPayload), {runId:process.env.FRESHELL_RUNTIME_EXTERNAL_RUN_ID!, candidateSha:process.env.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA!}); process.stdout.write(JSON.stringify(cases))' 2>/dev/null); then
          external_complete=true
          break
        fi
      fi
      if [ "$external_attempt" -lt 5 ]; then sleep 3; fi
    done
    if ! $external_complete; then
      echo "[e2e-cloud] ERROR: complete exact external execution observations are unavailable." >&2
      exit 1
    fi
    jq -cn --arg runId "$FRESHELL_RUNTIME_EXTERNAL_RUN_ID" --arg candidateSha "$FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA" \
      --arg jobName "$RUN_JOB_NAME" --arg executionName "$execution_id" --argjson cases "$external_cases" \
      '{severity:"info", event:"managed_external_cloud_cases", runId:$runId, candidateSha:$candidateSha, jobName:$jobName, executionName:$executionName, cases:$cases}'
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
  identity_preflight

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
