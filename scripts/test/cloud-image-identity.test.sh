#!/usr/bin/env bash
# Test: cloud-image-identity — a cloud run always tests exactly the tree it was
# started from, and never rebuilds an image another run is already building.
#
# Executes the REAL wrappers (scripts/vitest-cloud.sh, scripts/e2e-cloud.sh)
# from throwaway worktrees of a fixture repository. `gcloud` and `docker` are
# stateful stubs that model Artifact Registry (tag -> digest) and Cloud Build
# (async builds that take several polls), EXCEPT `gcloud meta
# list-files-for-upload`, which is delegated to the real gcloud so the upload
# set is gcloud's own .gcloudignore evaluation. No credentials, no network.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

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

echo "=== Cloud image identity test ==="

REAL_GCLOUD="$(command -v gcloud || true)"
if [ -z "$REAL_GCLOUD" ]; then
  echo "FAIL: gcloud is required (the upload set is gcloud's own .gcloudignore evaluation)"
  exit 1
fi
export REAL_GCLOUD

WORK="$(mktemp -d /tmp/cloud-image-identity.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
STUBS="$WORK/bin"
STATE="$WORK/state"
mkdir -p "$STUBS" "$STATE"
export STUB_STATE="$STATE"
REMOTE_BASE="us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e"

# ---------------------------------------------------------------------------
# Stateful gcloud stub. Registry entries live in $STATE/registry/<ref-key>;
# builds in $STATE/builds/<id>/ (build ids sort by creation time). A build's
# digest is derived from the exact context bytes it was handed, so a job
# pinned to a digest can be traced back to the tree that produced it.
# ---------------------------------------------------------------------------
cat > "$STUBS/gcloud" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
S="${STUB_STATE:?}"
printf '%s\t%s\n' "${STUB_LABEL:-?}" "$*" >> "$S/gcloud.log"
ref_key() { printf '%s' "$1" | tr '/:@' '___'; }
arg_value() {
  local name="$1" a
  shift
  for a in "$@"; do
    case "$a" in "$name="*) printf '%s' "${a#*=}"; return 0 ;; esac
  done
  return 1
}
case "${1:-} ${2:-}" in
  "info "*) echo /nonexistent-sdk-root; exit 0 ;;
  "meta list-files-for-upload")
    if [ -n "${STUB_LIST_HOOK:-}" ]; then bash -c "$STUB_LIST_HOOK"; fi
    dir=""
    for a in "${@:3}"; do case "$a" in --*) ;; *) dir="$a" ;; esac; done
    exec "$REAL_GCLOUD" meta list-files-for-upload "$dir" ;;
  "builds submit")
    [[ "$*" == *"--async"* ]] || { echo "stub: builds submit must be --async" >&2; exit 2; }
    src="${3:-}"
    [ -f "$src" ] || { echo "stub: builds submit source must be a context archive, got '$src'" >&2; exit 2; }
    image="$(arg_value --substitutions "$@" | tr ',' '\n' | sed -n 's/^_IMAGE=//p')"
    id="build-$(date +%s%N)-$$"
    d="$S/builds/$id"
    mkdir -p "$d"
    cp "$src" "$d/context.tgz"
    printf '%s\n' "$image" > "$d/image"
    printf '%s\n' "${STUB_BUILD_OUTCOME:-SUCCESS}" > "$d/outcome"
    printf '%s\n' "${STUB_BUILD_POLLS:-2}" > "$d/polls"
    echo WORKING > "$d/status"
    echo "sha256:$(gzip -dc "$d/context.tgz" | sha256sum | cut -c1-64)" > "$d/digest"
    printf '%s\t%s\t%s\n' "${STUB_LABEL:-?}" "$id" "$image" >> "$S/submits.log"
    echo "$id"
    exit 0 ;;
  "builds list")
    [[ "$*" == *"--ongoing"* ]] || exit 0
    ref="$(arg_value --filter "$@" | sed -n 's/^substitutions\._IMAGE="\(.*\)"$/\1/p')"
    for d in $(ls -1d "$S"/builds/*/ 2>/dev/null | LC_ALL=C sort); do
      st="$(cat "$d/status")"
      if [ "$(cat "$d/image")" = "$ref" ] && { [ "$st" = WORKING ] || [ "$st" = QUEUED ]; }; then
        basename "$d"
      fi
    done
    exit 0 ;;
  "builds describe")
    d="$S/builds/${3:-}"
    [ -d "$d" ] || { echo "ERROR: build not found" >&2; exit 1; }
    case "$(arg_value --format "$@")" in
      "value(status)")
        (
          flock 9
          st="$(cat "$d/status")"
          if [ "$st" = WORKING ]; then
            left=$(( $(cat "$d/polls") - 1 ))
            echo "$left" > "$d/polls"
            if [ "$left" -le 0 ]; then
              st="$(cat "$d/outcome")"
              echo "$st" > "$d/status"
              if [ "$st" = SUCCESS ]; then
                mkdir -p "$S/registry"
                cp "$d/digest" "$S/registry/$(ref_key "$(cat "$d/image")")"
              fi
            fi
          fi
          echo "$st"
        ) 9>"$d/lock"
        ;;
      "json(results.buildStepOutputs)")
        if [ "$(cat "$d/status")" = SUCCESS ]; then
          printf '{"results":{"buildStepOutputs":["","","%s"]}}\n' "$(tr -d '\n' < "$d/digest" | base64 -w0)"
        else
          echo '{}'
        fi
        ;;
    esac
    exit 0 ;;
  "builds log") echo "stub build log for ${3:-}"; exit 0 ;;
  "artifacts docker")
    f="$S/registry/$(ref_key "${5:-}")"
    if [ -f "$f" ]; then cat "$f"; exit 0; fi
    echo "ERROR: (gcloud.artifacts.docker.images.describe) Image not found." >&2
    exit 1 ;;
  "artifacts repositories") exit 0 ;;
  "auth print-access-token") echo stub-token; exit 0 ;;
  "run jobs")
    case "${3:-}" in
      create) printf '%s\t%s\n' "${STUB_LABEL:-?}" "$*" >> "$S/jobs.log" ;;
      execute) echo "Execution [exec-1] has successfully completed." ;;
      executions)
        case "${4:-}" in
          list) echo exec-1 ;;
          describe) case "$*" in *failedCount*) echo 0 ;; *) echo 1 ;; esac ;;
        esac ;;
    esac
    exit 0 ;;
  "beta run") printf 'Test Files  1 passed (1)\n  1 passed (1.0s)\n'; exit 0 ;;
  "logging read")
    echo '[{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-1","taskIndex":0,"taskCount":1,"recoveredRetryCount":0}}]'
    exit 0 ;;
esac
exit 0
STUB

# Docker stub for --local-build. `build` takes a context DIRECTORY (its last
# argument); the stub archives that directory as the build saw it and derives
# the image id from those bytes. `push` publishes the image a remote ref was
# tagged from, with a digest derived from that image id.
cat > "$STUBS/docker" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
S="${STUB_STATE:?}"
printf '%s\t%s\n' "${STUB_LABEL:-?}" "$*" >> "$S/docker.log"
ref_key() { printf '%s' "$1" | tr '/:@' '___'; }
case "${1:-}" in
  login) cat >/dev/null; echo "Login Succeeded"; exit 0 ;;
  build)
    iidfile="" prev="" ctx=""
    for a in "$@"; do
      [ "$prev" = "--iidfile" ] && iidfile="$a"
      case "$a" in --iidfile=*) iidfile="${a#*=}" ;; esac
      prev="$a"
      ctx="$a"
    done
    [ -d "$ctx" ] || { echo "stub docker: build context must be a directory, got '$ctx'" >&2; exit 2; }
    [ -n "$iidfile" ] || { echo "stub docker: build must record --iidfile" >&2; exit 2; }
    mkdir -p "$S/docker-builds"
    archive="$S/docker-builds/ctx-$(date +%s%N)-$$.tar"
    (cd "$ctx" && find . \( -type f -o -type l \) -printf '%P\n' | LC_ALL=C sort \
      | tar -cf "$archive" --no-recursion --verbatim-files-from -T -) || exit 1
    iid="sha256:$(sha256sum < "$archive" | cut -c1-64)"
    printf '%s' "$iid" > "$iidfile"
    printf '%s\t%s\n' "$iid" "$archive" >> "$S/docker-images.log"
    exit 0 ;;
  tag)
    mkdir -p "$S/docker-tags"
    printf '%s' "$2" > "$S/docker-tags/$(ref_key "$3")"
    exit 0 ;;
  push)
    f="$S/docker-tags/$(ref_key "${2:-}")"
    [ -f "$f" ] || { echo "stub docker: no local image for $2" >&2; exit 1; }
    digest="sha256:$(printf 'manifest-of-%s' "$(cat "$f")" | sha256sum | cut -c1-64)"
    mkdir -p "$S/registry"
    printf '%s\n' "$digest" > "$S/registry/$(ref_key "$2")"
    echo "The push refers to repository [${2%:*}]"
    echo "${2##*:}: digest: $digest size: 1234"
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$STUBS/gcloud" "$STUBS/docker"

# ---------------------------------------------------------------------------
# Fixture repository: the wrappers and build config under test, the real
# ignore files, and one source file each check edits.
# ---------------------------------------------------------------------------
ORIGIN="$WORK/origin"
mkdir -p "$ORIGIN/src" "$ORIGIN/docker/cloud-run" \
  "$ORIGIN/test/fixtures/distribution/rust-only/dist/client"
cp -R "$ROOT/scripts" "$ORIGIN/scripts"
cp "$ROOT/docker/cloud-run/Dockerfile" "$ROOT/docker/cloud-run/cloudbuild.yaml" \
  "$ROOT/docker/cloud-run/entrypoint.sh" "$ORIGIN/docker/cloud-run/"
cp "$ROOT/.gitignore" "$ROOT/.gcloudignore" "$ROOT/.dockerignore" "$ORIGIN/"
printf 'origin\n' > "$ORIGIN/src/marker.ts"
printf '<html></html>\n' > "$ORIGIN/test/fixtures/distribution/rust-only/dist/client/index.html"
git -C "$ORIGIN" init -q
git -C "$ORIGIN" add -A
git -C "$ORIGIN" -c user.name=fixture -c user.email=fixture@example.invalid commit -qm fixture
SHA12="$(git -C "$ORIGIN" rev-parse --short=12 HEAD)"

new_worktree() {
  git -C "$ORIGIN" worktree add -q --detach "$WORK/$1"
}

reset_state() {
  rm -rf "$STATE"
  mkdir -p "$STATE"
  touch "$STATE/gcloud.log" "$STATE/submits.log" "$STATE/jobs.log" "$STATE/docker.log" "$STATE/docker-images.log"
}

# run_wrapper LABEL WRAPPER [args...] — one cloud run; output in out-LABEL.log.
# LOCK_DIR (default: shared) models "same machine" vs "another machine".
run_wrapper() {
  local label="$1" wrapper="$2"
  shift 2
  env -u GCLOUD_ROBOT_HOME -u GCLOUD_ROBOT_REQUIRE -u FRESHELL_GCP_ACCOUNT \
    -u FRESHELL_GCP_PROJECT -u FRESHELL_GCP_REGION -u FRESHELL_GCP_REPO \
    PATH="$STUBS:$PATH" STUB_LABEL="$label" \
    GCLOUD_IDENT="suite-pinned-identity@example.invalid" \
    FRESHELL_CLOUD_IMAGE_LOCK_DIR="${LOCK_DIR:-$STATE/locks}" \
    FRESHELL_CLOUD_BUILD_POLL_SECONDS=0.1 \
    "$wrapper" "$@" > "$WORK/out-$label.log" 2>&1
}

pinned_image() {
  awk -F'\t' -v l="$1" '$1 == l { print $2 }' "$STATE/jobs.log" | grep -oP -- '--image=\K\S+' | head -1 || true
}
submits_by() { awk -F'\t' -v l="$1" '$1 == l' "$STATE/submits.log" | wc -l; }
submit_count() { wc -l < "$STATE/submits.log"; }
# The SUCCESSFUL build that produced DIGEST (a job must never be pinned to a
# failed build's output, even one with identical content).
build_for_digest() {
  local d
  for d in "$STATE"/builds/*/; do
    [ -f "$d/digest" ] && [ "$(cat "$d/status")" = SUCCESS ] && [ "$(cat "$d/digest")" = "$1" ] && basename "$d"
  done
  return 0
}
submitter_of() { awk -F'\t' -v id="$1" '$2 == id { print $1 }' "$STATE/submits.log"; }
wait_for_submit() {
  local _
  for _ in $(seq 1 300); do
    [ -s "$STATE/submits.log" ] && return 0
    sleep 0.1
  done
  return 1
}
is_digest_ref() { [[ "$1" =~ ^${REMOTE_BASE}@sha256:[0-9a-f]{64}$ ]]; }
show_log() { echo "--- out-$1.log (tail) ---"; tail -15 "$WORK/out-$1.log" 2>/dev/null || true; }

# Verifies that LABEL's job is pinned to the digest of a Cloud Build whose
# uploaded context carries MARKER, tagged with the content hash of exactly
# those bytes. Prints the build's tag on success.
assert_pinned_to_own_cloud_build() {
  local label="$1" marker="$2" image build tag suffix
  image="$(pinned_image "$label")"
  is_digest_ref "$image" || { echo "  $label pinned '$image' (not a digest ref)"; return 1; }
  build="$(build_for_digest "${image#*@}")"
  [ -n "$build" ] || { echo "  $label pinned a digest no successful build produced"; return 1; }
  [ "$(submitter_of "$build")" = "$label" ] || { echo "  $label pinned a build it did not submit"; return 1; }
  [ "$(tar -xzOf "$STATE/builds/$build/context.tgz" src/marker.ts)" = "$marker" ] || {
    echo "  $label's build context does not carry its own marker '$marker'"; return 1; }
  tag="$(cat "$STATE/builds/$build/image")"
  tag="${tag##*:}"
  suffix="$(gzip -dc "$STATE/builds/$build/context.tgz" | sha256sum | cut -c1-16)"
  [ "$tag" = "${SHA12}-dirty-${suffix}" ] || {
    echo "  $label's tag '$tag' is not ${SHA12}-dirty-<hash of its uploaded context>"; return 1; }
}

# --- I1: same commit, different uncommitted changes, concurrent ------------
reset_state
new_worktree wt-a
new_worktree wt-b
printf 'alpha\n' > "$WORK/wt-a/src/marker.ts"
printf 'bravo\n' > "$WORK/wt-b/src/marker.ts"
mkdir -p "$WORK/wt-a/release/win-unpacked"
printf 'binary\n' > "$WORK/wt-a/release/win-unpacked/Freshell.exe"
printf 'SECRET=1\n' > "$WORK/wt-a/.verify-vantages.env"
run_wrapper a "$WORK/wt-a/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 & PID_A=$!
run_wrapper b "$WORK/wt-b/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 & PID_B=$!
wait "$PID_A" && RC_A=0 || RC_A=$?
wait "$PID_B" && RC_B=0 || RC_B=$?
check "I1: two concurrent dirty runs at the same commit both succeed" test "$RC_A$RC_B" = "00"
[ "$RC_A$RC_B" = "00" ] || { show_log a; show_log b; }
check "I1: run A's job is pinned to the digest of a build of A's own tree" \
  assert_pinned_to_own_cloud_build a alpha
check "I1: run B's job is pinned to the digest of a build of B's own tree" \
  assert_pinned_to_own_cloud_build b bravo
check "I1: the two different trees got two different image tags" \
  test "$(cut -f3 "$STATE/submits.log" | sort -u | wc -l)" = "2"
A_BUILD="$(build_for_digest "$(pinned_image a | sed 's/.*@//')")"
check "I1: gitignored litter in A's tree never reached the uploaded context" \
  bash -c '[ -n "$1" ] && ! tar -tzf "$2/builds/$1/context.tgz" | grep -Eq "^(release/|\.verify-vantages\.env$)"' \
  _ "$A_BUILD" "$STATE"
check "I1: the uploaded context keeps checked-in fixture re-includes" \
  bash -c '[ -n "$1" ] && tar -tzf "$2/builds/$1/context.tgz" | grep -Fxq test/fixtures/distribution/rust-only/dist/client/index.html' \
  _ "$A_BUILD" "$STATE"

# --- I2: identical uncommitted content (different mtimes), concurrent ------
reset_state
new_worktree wt-c
new_worktree wt-d
printf 'same\n' > "$WORK/wt-c/src/marker.ts"
printf 'same\n' > "$WORK/wt-d/src/marker.ts"
touch -d '2001-02-03 04:05:06' "$WORK/wt-d/src/marker.ts" "$WORK/wt-d/scripts/vitest-cloud.sh"
run_wrapper c "$WORK/wt-c/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 & PID_C=$!
run_wrapper d "$WORK/wt-d/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 & PID_D=$!
wait "$PID_C" && RC_C=0 || RC_C=$?
wait "$PID_D" && RC_D=0 || RC_D=$?
check "I2: two concurrent runs of identical content both succeed" test "$RC_C$RC_D" = "00"
[ "$RC_C$RC_D" = "00" ] || { show_log c; show_log d; }
check "I2: identical content triggers exactly one Cloud Build" test "$(submit_count)" = "1"
check "I2: both jobs are pinned to that one image digest" \
  bash -c '[ -n "$1" ] && [ "$1" = "$2" ] && [[ "$1" == *@sha256:* ]]' _ "$(pinned_image c)" "$(pinned_image d)"

# --- I3: another machine is already building the same tag -----------------
reset_state
new_worktree wt-e
new_worktree wt-f
printf 'shared\n' > "$WORK/wt-e/src/marker.ts"
printf 'shared\n' > "$WORK/wt-f/src/marker.ts"
LOCK_DIR="$STATE/locks-machine-1" STUB_BUILD_POLLS=100 \
  run_wrapper e "$WORK/wt-e/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 & PID_E=$!
wait_for_submit || true
LOCK_DIR="$STATE/locks-machine-2" \
  run_wrapper f "$WORK/wt-f/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 & PID_F=$!
wait "$PID_E" && RC_E=0 || RC_E=$?
wait "$PID_F" && RC_F=0 || RC_F=$?
check "I3: both runs succeed" test "$RC_E$RC_F" = "00"
[ "$RC_E$RC_F" = "00" ] || { show_log e; show_log f; }
check "I3: the second machine waited instead of submitting its own build" \
  test "$(submits_by f)$(submit_count)" = "01"
check "I3: the waiting run reused the in-flight build's digest" \
  bash -c '[ -n "$1" ] && [ "$1" = "$2" ] && [[ "$1" == *@sha256:* ]]' _ "$(pinned_image e)" "$(pinned_image f)"
E_BUILD_ID="$(cut -f2 "$STATE/submits.log" | head -1)"
check "I3: the waiting run names the build it waited for" \
  bash -c '[ -n "$1" ] && grep -Fq -- "$1" "$2"' _ "$E_BUILD_ID" "$WORK/out-f.log"

# --- I4: the in-flight build fails — build once ourselves ------------------
reset_state
new_worktree wt-g
new_worktree wt-h
printf 'fallback\n' > "$WORK/wt-g/src/marker.ts"
printf 'fallback\n' > "$WORK/wt-h/src/marker.ts"
LOCK_DIR="$STATE/locks-machine-1" STUB_BUILD_POLLS=60 STUB_BUILD_OUTCOME=FAILURE \
  run_wrapper g "$WORK/wt-g/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 & PID_G=$!
wait_for_submit || true
LOCK_DIR="$STATE/locks-machine-2" \
  run_wrapper h "$WORK/wt-h/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 & PID_H=$!
wait "$PID_G" && RC_G=0 || RC_G=$?
wait "$PID_H" && RC_H=0 || RC_H=$?
check "I4: the run whose own build failed fails and creates no job" \
  bash -c '[ "$1" != 0 ] && [ -z "$2" ]' _ "$RC_G" "$(pinned_image g)"
check "I4: the waiting run falls back to exactly one build of its own and succeeds" \
  test "$RC_H/$(submits_by h)/$(submit_count)" = "0/1/2"
[ "$RC_H" = 0 ] || show_log h
check "I4: the fallback run is pinned to its own successful build" \
  assert_pinned_to_own_cloud_build h fallback

# --- I5: clean tree whose commit image exists — reuse, no build ------------
reset_state
new_worktree wt-clean
SEEDED="sha256:$(printf 'seeded' | sha256sum | cut -c1-64)"
mkdir -p "$STATE/registry"
printf '%s\n' "$SEEDED" > "$STATE/registry/$(printf '%s' "$REMOTE_BASE:$SHA12" | tr '/:@' '___')"
run_wrapper clean1 "$WORK/wt-clean/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 && RC=0 || RC=$?
check "I5: clean run reuses the existing commit image without building" \
  test "$RC/$(submit_count)" = "0/0"
[ "$RC" = 0 ] || show_log clean1
check "I5: the job is pinned to the commit image's digest" \
  test "$(pinned_image clean1)" = "$REMOTE_BASE@$SEEDED"

# --- I6: clean tree whose commit image is missing (pruned) — rebuild -------
reset_state
run_wrapper clean2 "$WORK/wt-clean/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 && RC=0 || RC=$?
check "I6: a missing commit image is rebuilt once under the commit tag" \
  bash -c '[ "$1" = 0 ] && [ "$(wc -l < "$2")" = 1 ] && [ "$(cut -f3 "$2")" = "$3" ]' \
  _ "$RC" "$STATE/submits.log" "$REMOTE_BASE:$SHA12"
[ "$RC" = 0 ] || show_log clean2
CLEAN_PIN="$(pinned_image clean2)"
check "I6: the job is pinned to the rebuilt image's digest" \
  bash -c '[[ "$1" =~ @sha256:[0-9a-f]{64}$ ]] && [ -n "$2" ]' \
  _ "$CLEAN_PIN" "$(build_for_digest "${CLEAN_PIN#*@}")"
run_wrapper clean3 "$WORK/wt-clean/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 && RC=0 || RC=$?
check "I6: re-running the clean tree reuses that image (no second build)" \
  test "$RC/$(submit_count)/$(pinned_image clean3)" = "0/1/$CLEAN_PIN"

# --- I7: the tree changes while a clean tree is being snapshotted ----------
reset_state
new_worktree wt-race
STUB_LIST_HOOK="printf 'edited-mid-snapshot\n' > '$WORK/wt-race/src/marker.ts'" \
  run_wrapper race "$WORK/wt-race/scripts/vitest-cloud.sh" run --cloud --config=default --shards=1 && RC=0 || RC=$?
check "I7: a tree edited during the snapshot is never published under the commit tag" \
  bash -c '[ "$1" = 0 ] && ! cut -f3 "$3" | grep -Fxq -- "$2"' _ "$RC" "$REMOTE_BASE:$SHA12" "$STATE/submits.log"
[ "$RC" = 0 ] || show_log race
check "I7: it is tagged and pinned by the content it actually uploaded" \
  assert_pinned_to_own_cloud_build race edited-mid-snapshot

# --- I8: --local-build, two different dirty trees, concurrent --------------
reset_state
new_worktree wt-i
new_worktree wt-j
printf 'india\n' > "$WORK/wt-i/src/marker.ts"
printf 'juliet\n' > "$WORK/wt-j/src/marker.ts"
mkdir -p "$WORK/wt-i/release"
printf 'binary\n' > "$WORK/wt-i/release/app.exe"
run_wrapper i "$WORK/wt-i/scripts/vitest-cloud.sh" run --cloud --local-build --config=default --shards=1 & PID_I=$!
run_wrapper j "$WORK/wt-j/scripts/vitest-cloud.sh" run --cloud --local-build --config=default --shards=1 & PID_J=$!
wait "$PID_I" && RC_I=0 || RC_I=$?
wait "$PID_J" && RC_J=0 || RC_J=$?
check "I8: two concurrent --local-build runs both succeed without Cloud Build" \
  test "$RC_I$RC_J/$(submit_count)" = "00/0"
[ "$RC_I$RC_J" = "00" ] || { show_log i; show_log j; }

# Follows LABEL's pinned digest back through the push to the image id and
# the exact build context Docker was streamed.
local_build_context_for() {
  local image digest iid ctx
  image="$(pinned_image "$1")"
  is_digest_ref "$image" || return 1
  digest="${image#*@}"
  while IFS=$'\t' read -r iid ctx; do
    if [ "sha256:$(printf 'manifest-of-%s' "$iid" | sha256sum | cut -c1-64)" = "$digest" ]; then
      printf '%s\n' "$ctx"
      return 0
    fi
  done < "$STATE/docker-images.log"
  return 1
}
CTX_I="$(local_build_context_for i || true)"
CTX_J="$(local_build_context_for j || true)"
check "I8: run I's job is pinned to the image built from I's own tree" \
  bash -c '[ -n "$1" ] && [ "$(tar -xOf "$1" src/marker.ts)" = india ]' _ "$CTX_I"
check "I8: run J's job is pinned to the image built from J's own tree" \
  bash -c '[ -n "$1" ] && [ "$(tar -xOf "$1" src/marker.ts)" = juliet ]' _ "$CTX_J"
check "I8: the local build context honors .gitignore like the Cloud Build upload" \
  bash -c '[ -n "$1" ] && ! tar -tf "$1" | grep -q "^release/"' _ "$CTX_I"
check "I8: remote tags are applied from exact image ids, never a shared local tag" \
  bash -c '! grep -P "\ttag " "$1" | grep -vP "\ttag sha256:[0-9a-f]{64} " | grep -q . && ! grep -q "freshell-e2e:latest" "$1"' _ "$STATE/docker.log"

# --- I9: e2e wrapper parity — dirty tree pinned to its own build ------------
reset_state
new_worktree wt-k
printf 'kilo\n' > "$WORK/wt-k/src/marker.ts"
run_wrapper k "$WORK/wt-k/scripts/e2e-cloud.sh" run --cloud --shards=1 && RC=0 || RC=$?
check "I9: e2e dirty run succeeds" test "$RC" = 0
[ "$RC" = 0 ] || show_log k
check "I9: e2e job is pinned to the digest of a build of its own tree" \
  assert_pinned_to_own_cloud_build k kilo

# --- I10: the build subcommand always builds, even if the tag exists -------
reset_state
mkdir -p "$STATE/registry"
printf '%s\n' "$SEEDED" > "$STATE/registry/$(printf '%s' "$REMOTE_BASE:$SHA12" | tr '/:@' '___')"
run_wrapper build1 "$WORK/wt-clean/scripts/vitest-cloud.sh" build && RC=0 || RC=$?
check "I10: 'build' submits a fresh build of the commit even when its image exists" \
  bash -c '[ "$1" = 0 ] && [ "$(wc -l < "$2")" = 1 ] && [ "$(cut -f3 "$2")" = "$3" ]' \
  _ "$RC" "$STATE/submits.log" "$REMOTE_BASE:$SHA12"
[ "$RC" = 0 ] || show_log build1

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
