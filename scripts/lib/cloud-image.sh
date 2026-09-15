#!/usr/bin/env bash
# cloud-image.sh — the test image a cloud run executes: which exact tree it
# holds, what it is called, how concurrent runs share it, and how Cloud Run is
# pinned to it. Shared by scripts/e2e-cloud.sh and scripts/vitest-cloud.sh.
#
# THIS FILE IS SOURCED, NOT EXECUTED. It only defines functions — no top-level
# side effects, no output, no gcloud/docker calls — so help and local lanes
# may source it unconditionally.
#
# Guarantee: a cloud run tests exactly the tree it was started from, even when
# several worktrees on the same commit with different uncommitted changes run
# at the same time.
#
#   Snapshot  The build context is ONE archive of exactly the files
#             `gcloud meta list-files-for-upload` selects — the chooser
#             `gcloud builds submit` itself applies (.gcloudignore, which
#             includes .gitignore). Cloud Build receives that archive, and
#             --local-build extracts the same archive and builds from it. The
#             bytes that are hashed are the bytes that are built, so an edit
#             made while a run is in flight can never land in an image whose
#             tag names other content. Archive metadata is normalized (owner
#             0:0, commit-time mtimes, 644/755 modes) so identical content
#             hashes identically in every worktree.
#   Tag       Clean tree (git status empty before AND after the snapshot):
#             <sha12>, reusable by every run of that commit on any machine.
#             Otherwise <sha12>-dirty-<first 16 hex of sha256(archive)>.
#   Pin       Cloud Run jobs reference <repo>@sha256:<digest>: the digest this
#             run's own build reported (Cloud Build step output or docker
#             push), or the digest the tag resolved to when reused. A tag is
#             never handed to Cloud Run, which would resolve it only when the
#             execution starts.
#   Dedupe    Same machine: a per-tag flock serializes runs, so a second run
#             finds the first run's image instead of building it again. Other
#             machines: an ongoing Cloud Build for the same tag is waited on
#             and its image reused; if it fails, this run builds once itself.
#             Known gap (accepted): two machines that both start before either
#             build exists — inside the source-upload window of `builds
#             submit` — each build once. Tags are content-addressed, so that
#             costs a duplicate build, never a wrong image.
#   Cache     BuildKit's registry cache keeps its long-standing names
#             (<sha12>-cache, <sha12>-dirty-cache), so dirty rebuilds of a
#             commit stay warm although each dirty content has its own tag.
#             Cache keys are content checksums: sharing can miss, never serve
#             wrong layers.
#   Pruning   Artifact Registry deletes old image versions. A pruned tag is
#             simply missing and gets rebuilt; nothing here needs an image to
#             outlive the run that resolved its digest.
#
# Caller provides: ROOT, GCP_PROJECT, GCP_REGION, GCP_REPO, IMAGE_NAME,
# GCP_ACCOUNT (may be empty), CLOUD_IMAGE_LOG_PREFIX (e.g. "[e2e-cloud]") and,
# optionally, CLOUD_IMAGE_LOG_FD: the file descriptor for progress lines
# (default 2). Errors always go to stderr. The public functions print their
# result on stdout, so callers capture it with $(...) while progress still
# reaches the terminal through CLOUD_IMAGE_LOG_FD.
# Knobs: FRESHELL_CLOUD_IMAGE_LOCK_DIR (default
# ${XDG_CACHE_HOME:-$HOME/.cache}/freshell/cloud-image-locks),
# FRESHELL_CLOUD_BUILD_POLL_SECONDS (default 15) and
# FRESHELL_CLOUD_BUILD_WAIT_SECONDS (default 4500).
#
# Every function reports failure through its return status and never relies
# on `set -e`: the wrappers call these from `if`/`||` contexts, where bash
# suspends errexit.

_cloud_image_log() {
  printf '%s %s\n' "${CLOUD_IMAGE_LOG_PREFIX:-[cloud-image]}" "$*" >&"${CLOUD_IMAGE_LOG_FD:-2}"
}

_cloud_image_error() {
  printf '%s ERROR: %s\n' "${CLOUD_IMAGE_LOG_PREFIX:-[cloud-image]}" "$*" >&2
}

# gcloud with this lane's identity pin and project appended. An unresolved
# identity (ambient gcloud) omits --account entirely.
_cloud_image_gcloud() {
  if [ -n "${GCP_ACCOUNT:-}" ]; then
    gcloud "$@" --account="$GCP_ACCOUNT" --project="$GCP_PROJECT"
  else
    gcloud "$@" --project="$GCP_PROJECT"
  fi
}

cloud_image_remote_base() {
  printf '%s-docker.pkg.dev/%s/%s/%s' "$GCP_REGION" "$GCP_PROJECT" "$GCP_REPO" "$IMAGE_NAME"
}

# Job-name label for a tag: <sha12> or <sha12>-dirty. The content hash is
# left out to stay inside Cloud Run's 49-character job-name limit.
cloud_image_job_label() {
  case "$1" in
    *-dirty-*) printf '%s-dirty' "${1%%-dirty-*}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Clean means git reports nothing — no modified, staged, or untracked
# non-ignored file. A failing `git status` counts as NOT clean.
_cloud_image_tree_is_clean() {
  local status
  status="$(git -C "$ROOT" status --porcelain)" || return 1
  [ -z "$status" ]
}

# _cloud_image_snapshot WORKDIR — archives the upload set into
# WORKDIR/context.tar and prints the archive's sha256.
_cloud_image_snapshot() {
  local work="$1" mtime count
  if ! _cloud_image_gcloud meta list-files-for-upload "$ROOT" > "$work/upload.list"; then
    _cloud_image_error "could not list the build context (gcloud meta list-files-for-upload $ROOT)."
    return 1
  fi
  LC_ALL=C sort -u -o "$work/upload.list" "$work/upload.list" || return 1
  count="$(wc -l < "$work/upload.list")"
  if [ "$count" -eq 0 ]; then
    _cloud_image_error "the build context of $ROOT is empty."
    return 1
  fi
  mtime="$(git -C "$ROOT" log -1 --format=%ct HEAD)" || return 1
  if ! tar --create --file="$work/context.tar" --directory="$ROOT" \
      --format=gnu --no-recursion --owner=0 --group=0 --numeric-owner \
      --mtime="@$mtime" --mode='u=rwX,go=rX' \
      --verbatim-files-from --files-from="$work/upload.list"; then
    _cloud_image_error "could not archive the build context of $ROOT."
    return 1
  fi
  _cloud_image_log "Snapshotted $count files from $ROOT."
  sha256sum "$work/context.tar" | cut -c1-64
}

# Same-machine dedupe: holds an exclusive per-image-ref lock for the rest of
# the calling (sub)shell.
_CLOUD_IMAGE_LOCK_FD=""
_cloud_image_lock() {
  local ref="$1" dir file limit
  if ! command -v flock >/dev/null 2>&1; then
    _cloud_image_log "flock is unavailable; same-machine build dedupe is off (in-flight Cloud Build dedupe still applies)."
    return 0
  fi
  dir="${FRESHELL_CLOUD_IMAGE_LOCK_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/freshell/cloud-image-locks}"
  mkdir -p "$dir" || return 1
  file="$dir/$(printf '%s' "$ref" | sha256sum | cut -c1-32).lock"
  exec {_CLOUD_IMAGE_LOCK_FD}>"$file" || return 1
  if flock -n "$_CLOUD_IMAGE_LOCK_FD"; then
    return 0
  fi
  limit="${FRESHELL_CLOUD_BUILD_WAIT_SECONDS:-4500}"
  _cloud_image_log "Another run on this machine is already publishing $ref; waiting for it."
  if ! flock -w "$limit" "$_CLOUD_IMAGE_LOCK_FD"; then
    _cloud_image_error "gave up after ${limit}s waiting for the other run publishing $ref."
    return 1
  fi
}

_cloud_image_unlock() {
  if [ -n "$_CLOUD_IMAGE_LOCK_FD" ]; then
    exec {_CLOUD_IMAGE_LOCK_FD}>&-
    _CLOUD_IMAGE_LOCK_FD=""
  fi
}

# Prints the digest REF currently resolves to; fails when it is not published.
_cloud_image_registry_digest() {
  local digest
  digest="$(_cloud_image_gcloud artifacts docker images describe "$1" \
    --format='value(image_summary.digest)' 2>/dev/null)" || return 1
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$digest"
}

# Prints the id of the oldest queued/working Cloud Build publishing REF.
_cloud_image_ongoing_build() {
  _cloud_image_gcloud builds list --ongoing \
    --filter="substitutions._IMAGE=\"$1\"" --sort-by=createTime \
    --format='value(id)' 2>/dev/null \
    | awk 'NR == 1'
}

# Waits for a Cloud Build to finish and prints its terminal status. Fails only
# when the status cannot be read or the wait limit is reached.
_cloud_image_wait_build() {
  local id="$1" poll="${FRESHELL_CLOUD_BUILD_POLL_SECONDS:-15}" limit="${FRESHELL_CLOUD_BUILD_WAIT_SECONDS:-4500}"
  local start=$SECONDS next_note=$((SECONDS + 120)) status last="" failures=0
  while :; do
    if status="$(_cloud_image_gcloud builds describe "$id" --format='value(status)' 2>/dev/null)" \
        && [ -n "$status" ]; then
      failures=0
      if [ "$status" != "$last" ]; then
        _cloud_image_log "Cloud Build $id: $status"
        last="$status"
      elif [ "$SECONDS" -ge "$next_note" ]; then
        _cloud_image_log "Cloud Build $id: still $status after $((SECONDS - start))s"
        next_note=$((SECONDS + 120))
      fi
      case "$status" in
        SUCCESS|FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)
          printf '%s\n' "$status"
          return 0
          ;;
      esac
    else
      failures=$((failures + 1))
      if [ "$failures" -ge 5 ]; then
        _cloud_image_error "could not read the status of Cloud Build $id."
        return 1
      fi
    fi
    if [ $((SECONDS - start)) -ge "$limit" ]; then
      _cloud_image_error "gave up after ${limit}s waiting for Cloud Build $id."
      return 1
    fi
    sleep "$poll"
  done
}

# Prints the image digest a finished Cloud Build recorded in its step output
# (docker/cloud-run/cloudbuild.yaml writes it to $BUILDER_OUTPUT).
_cloud_image_build_digest() {
  local json digest
  json="$(_cloud_image_gcloud builds describe "$1" \
    --format='json(results.buildStepOutputs)' 2>/dev/null)" || return 1
  digest="$(printf '%s' "$json" \
    | jq -r '.results.buildStepOutputs[]? // empty | select(length > 0) | @base64d' 2>/dev/null \
    | grep -oE '^sha256:[0-9a-f]{64}$' | tail -n 1)"
  [ -n "$digest" ] || return 1
  printf '%s' "$digest"
}

# Prints a digest and returns 0 when REF's image is available without this run
# building: already published (unless FORCE is true), or produced by an
# in-flight Cloud Build this run waited for. Returns 1 when this run must build.
_cloud_image_reuse_or_wait() {
  local ref="$1" force="$2" digest id status=""
  if [ "$force" != true ] && digest="$(_cloud_image_registry_digest "$ref")"; then
    _cloud_image_log "Reusing published image $ref ($digest)."
    printf '%s' "$digest"
    return 0
  fi
  id="$(_cloud_image_ongoing_build "$ref")" || id=""
  if [ -z "$id" ]; then
    return 1
  fi
  _cloud_image_log "Cloud Build $id is already building $ref; waiting for it instead of building again."
  if status="$(_cloud_image_wait_build "$id")" && [ "$status" = SUCCESS ]; then
    if digest="$(_cloud_image_build_digest "$id")" || digest="$(_cloud_image_registry_digest "$ref")"; then
      _cloud_image_log "Reusing $ref from Cloud Build $id ($digest)."
      printf '%s' "$digest"
      return 0
    fi
    _cloud_image_log "Cloud Build $id succeeded but its image digest could not be resolved; building once in this run."
    return 1
  fi
  _cloud_image_log "Cloud Build $id did not succeed (${status:-status unavailable}); building once in this run."
  return 1
}

# Publishes IMAGE_ID as REF with docker and prints the pushed digest.
_cloud_image_push() {
  local iid="$1" ref="$2" out digest
  if ! _cloud_image_gcloud artifacts repositories describe "$GCP_REPO" \
      --location="$GCP_REGION" >/dev/null 2>&1; then
    _cloud_image_log "Creating Artifact Registry repository: $GCP_REPO"
    _cloud_image_gcloud artifacts repositories create "$GCP_REPO" \
      --repository-format=docker --location="$GCP_REGION" >&"${CLOUD_IMAGE_LOG_FD:-2}" || true
  fi
  # Token login: the docker-credential-gcloud helper may not be on PATH.
  if ! _cloud_image_gcloud auth print-access-token \
      | docker login -u oauth2accesstoken --password-stdin "https://${GCP_REGION}-docker.pkg.dev" \
        >&"${CLOUD_IMAGE_LOG_FD:-2}"; then
    _cloud_image_error "docker login to Artifact Registry failed."
    return 1
  fi
  # Tag from the exact image id, never from a name another build could move.
  docker tag "$iid" "$ref" || return 1
  if ! out="$(docker push "$ref")"; then
    printf '%s\n' "$out" >&2
    _cloud_image_error "docker push $ref failed."
    return 1
  fi
  printf '%s\n' "$out" >&"${CLOUD_IMAGE_LOG_FD:-2}"
  digest="$(printf '%s\n' "$out" | grep -oE 'digest: sha256:[0-9a-f]{64}' | tail -n 1)"
  digest="${digest#digest: }"
  if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    _cloud_image_error "docker push reported no digest for $ref."
    return 1
  fi
  printf '%s' "$digest"
}

# _cloud_image_local_build REF TAG COMMIT WORKDIR — builds the snapshot with
# the local Docker daemon, publishes it, and prints the pushed digest. The
# snapshot is extracted and built as a directory — exactly what Cloud Build
# does with the uploaded archive — so .dockerignore applies identically (a
# tar streamed to `docker build -` would skip .dockerignore).
_cloud_image_local_build() {
  local ref="$1" tag="$2" commit="$3" work="$4" iid
  mkdir -p "$work/context" || return 1
  if ! tar --extract --file="$work/context.tar" --directory="$work/context"; then
    _cloud_image_error "could not extract the build snapshot."
    return 1
  fi
  _cloud_image_log "Building $IMAGE_NAME:$tag locally with Docker from the snapshot."
  if ! docker build --file "$work/context/docker/cloud-run/Dockerfile" \
      --build-arg "FRESHELL_BUILD_COMMIT=$commit" \
      --iidfile "$work/image.id" \
      --tag "$IMAGE_NAME:$tag" \
      "$work/context" >&"${CLOUD_IMAGE_LOG_FD:-2}"; then
    _cloud_image_error "local docker build of $IMAGE_NAME:$tag failed."
    return 1
  fi
  iid="$(cat "$work/image.id")" || return 1
  _cloud_image_push "$iid" "$ref"
}

# _cloud_image_cloud_build REF CACHE_REF COMMIT WORKDIR — submits the snapshot
# to Cloud Build, waits, and prints the digest the build recorded.
_cloud_image_cloud_build() {
  local ref="$1" cache_ref="$2" commit="$3" work="$4" id="" status digest
  # The build config comes from the snapshot too, never from the live tree.
  if ! tar --extract --to-stdout --file="$work/context.tar" docker/cloud-run/cloudbuild.yaml > "$work/cloudbuild.yaml"; then
    _cloud_image_error "the build snapshot has no docker/cloud-run/cloudbuild.yaml."
    return 1
  fi
  if command -v pigz >/dev/null 2>&1; then
    pigz --no-name --stdout "$work/context.tar" > "$work/context.tgz"
  else
    gzip --no-name --stdout "$work/context.tar" > "$work/context.tgz"
  fi || return 1
  _cloud_image_log "Submitting a Cloud Build for $ref."
  if ! id="$(_cloud_image_gcloud builds submit "$work/context.tgz" \
      --config="$work/cloudbuild.yaml" \
      --substitutions="_IMAGE=${ref},_CACHE_IMAGE=${cache_ref},_FRESHELL_BUILD_COMMIT=${commit}" \
      --async --format='value(id)')" || [ -z "$id" ]; then
    _cloud_image_error "could not submit the Cloud Build for $ref."
    return 1
  fi
  _cloud_image_log "Cloud Build $id is building $ref. It keeps running if this run is interrupted, and later runs reuse it."
  status="$(_cloud_image_wait_build "$id")" || return 1
  if [ "$status" != SUCCESS ]; then
    _cloud_image_error "Cloud Build $id ended $status. Last build log lines:"
    _cloud_image_gcloud builds log "$id" 2>&1 | tail -n 40 >&2 || true
    return 1
  fi
  if ! digest="$(_cloud_image_build_digest "$id")"; then
    _cloud_image_error "Cloud Build $id succeeded but reported no image digest."
    return 1
  fi
  printf '%s' "$digest"
}

# _cloud_image_publish REF CACHE_REF COMMIT WORKDIR TAG LOCAL_BUILD
_cloud_image_publish() {
  if [ "$6" = true ]; then
    _cloud_image_local_build "$1" "$5" "$3" "$4"
  else
    _cloud_image_cloud_build "$1" "$2" "$3" "$4"
  fi
}

# cloud_image_ensure [--force] [--local-build]
#
# Makes sure an image of exactly the current tree is published and prints
# "<tag> <repo>@sha256:<digest>"; the digest reference is the only image
# reference a Cloud Run job may use. --force skips reusing an already
# published tag (an in-flight build of the tag is still reused).
cloud_image_ensure() {
  ( _cloud_image_ensure "$@" )
}

_cloud_image_ensure() {
  local force=false local_build=false arg
  for arg in "$@"; do
    case "$arg" in
      --force) force=true ;;
      --local-build) local_build=true ;;
      *) _cloud_image_error "unknown cloud_image_ensure argument: $arg"; return 2 ;;
    esac
  done

  local remote_base commit sha12 work hash="" tag digest
  remote_base="$(cloud_image_remote_base)"
  commit="$(git -C "$ROOT" rev-parse HEAD)" || return 1
  if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    _cloud_image_error "HEAD is not a lowercase 40-hex commit: $commit"
    return 1
  fi
  sha12="$(git -C "$ROOT" rev-parse --short=12 HEAD)" || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/freshell-cloud-image.XXXXXX")" || return 1
  # shellcheck disable=SC2064 # expand now: $work is local to this subshell
  trap "rm -rf '$work'" EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if _cloud_image_tree_is_clean; then
    tag="$sha12"
    _cloud_image_lock "$remote_base:$tag" || return 1
    if digest="$(_cloud_image_reuse_or_wait "$remote_base:$tag" "$force")"; then
      printf '%s %s@%s\n' "$tag" "$remote_base" "$digest"
      return 0
    fi
    hash="$(_cloud_image_snapshot "$work")" || return 1
    if _cloud_image_tree_is_clean; then
      digest="$(_cloud_image_publish "$remote_base:$tag" "$remote_base:${sha12}-cache" \
        "$commit" "$work" "$tag" "$local_build")" || return 1
      printf '%s %s@%s\n' "$tag" "$remote_base" "$digest"
      return 0
    fi
    # Known limit: an edit that is made AND reverted while the snapshot is
    # taken leaves git clean again and is not detected.
    _cloud_image_log "The tree changed while it was being snapshotted; publishing that snapshot under its content tag instead of the commit tag."
    _cloud_image_unlock
  fi

  if [ -z "$hash" ]; then
    hash="$(_cloud_image_snapshot "$work")" || return 1
  fi
  tag="${sha12}-dirty-${hash:0:16}"
  _cloud_image_lock "$remote_base:$tag" || return 1
  if digest="$(_cloud_image_reuse_or_wait "$remote_base:$tag" "$force")"; then
    printf '%s %s@%s\n' "$tag" "$remote_base" "$digest"
    return 0
  fi
  digest="$(_cloud_image_publish "$remote_base:$tag" "$remote_base:${sha12}-dirty-cache" \
    "$commit" "$work" "$tag" "$local_build")" || return 1
  printf '%s %s@%s\n' "$tag" "$remote_base" "$digest"
}

# cloud_image_push_local_build — publishes the image `build --local-build`
# produced for the current tree (local tag $IMAGE_NAME:<tag>) and prints
# "<tag> <repo>@sha256:<digest>".
cloud_image_push_local_build() {
  ( _cloud_image_push_local_build )
}

_cloud_image_push_local_build() {
  local remote_base sha12 work tag hash iid digest
  remote_base="$(cloud_image_remote_base)"
  sha12="$(git -C "$ROOT" rev-parse --short=12 HEAD)" || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/freshell-cloud-image.XXXXXX")" || return 1
  # shellcheck disable=SC2064 # expand now: $work is local to this subshell
  trap "rm -rf '$work'" EXIT
  if _cloud_image_tree_is_clean; then
    tag="$sha12"
  else
    hash="$(_cloud_image_snapshot "$work")" || return 1
    tag="${sha12}-dirty-${hash:0:16}"
  fi
  if ! iid="$(docker image inspect --format '{{.Id}}' "$IMAGE_NAME:$tag" 2>/dev/null)" || [ -z "$iid" ]; then
    _cloud_image_error "there is no local image $IMAGE_NAME:$tag for the current tree; run 'build --local-build' first."
    return 1
  fi
  _cloud_image_lock "$remote_base:$tag" || return 1
  digest="$(_cloud_image_push "$iid" "$remote_base:$tag")" || return 1
  printf '%s %s@%s\n' "$tag" "$remote_base" "$digest"
}
