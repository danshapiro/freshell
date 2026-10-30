#!/usr/bin/env bash
# Focused Docker acceptance test for per-worktree Cargo target volumes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
IMAGE_TAG="freshell-sandbox:latest"
NETWORK_NAME="freshell-sandbox"
log() { printf '{"severity":"%s","event":"%s"}\n' "$1" "$2" >&2; }
fail() { log error "$1"; exit 1; }

if ! docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  printf '[cache-selftest] image %s is missing; run scripts/sandbox-build.sh first\n' "${IMAGE_TAG}" >&2
  exit 2
fi
if ! docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
  docker network create --driver bridge "${NETWORK_NAME}" >/dev/null
fi

SCRATCH_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/freshell-cache-selftest-XXXXXXXX")"
TEST_ID="${SCRATCH_ROOT##*/}"
chmod 0755 "${SCRATCH_ROOT}"
FIRST_ROOT="${SCRATCH_ROOT}/first"
SECOND_ROOT="${SCRATCH_ROOT}/second"
mkdir -p "${FIRST_ROOT}/scripts" "${SECOND_ROOT}/scripts"
chmod 0755 "${FIRST_ROOT}" "${SECOND_ROOT}"
cp "${REPO_ROOT}/scripts/sandbox-test.sh" "${FIRST_ROOT}/scripts/sandbox-test.sh"
cp "${REPO_ROOT}/scripts/sandbox-test.sh" "${SECOND_ROOT}/scripts/sandbox-test.sh"
chmod 0755 "${FIRST_ROOT}/scripts/sandbox-test.sh" "${SECOND_ROOT}/scripts/sandbox-test.sh"

hash_path() {
  local root="$1" output
  if command -v sha256sum >/dev/null 2>&1; then
    output="$(printf '%s' "${root}" | sha256sum)" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    output="$(printf '%s' "${root}" | shasum -a 256)" || return 1
  else
    return 1
  fi
  printf '%s\n' "${output%% *}"
}
FIRST_DIGEST="$(hash_path "$(cd "${FIRST_ROOT}" && pwd -P)")" || fail sandbox_cache_selftest_hash_failed
SECOND_DIGEST="$(hash_path "$(cd "${SECOND_ROOT}" && pwd -P)")" || fail sandbox_cache_selftest_hash_failed
FIRST_VOLUME="freshell-sandbox-rust-target-v1-${FIRST_DIGEST:0:24}"
SECOND_VOLUME="freshell-sandbox-rust-target-v1-${SECOND_DIGEST:0:24}"
[ "${FIRST_VOLUME}" != "${SECOND_VOLUME}" ] || fail sandbox_cache_selftest_worktree_identity_collided
[ "${FIRST_DIGEST}" != "${SECOND_DIGEST}" ] || fail sandbox_cache_selftest_worktree_hash_collided

volume_labels_match() {
  local name="$1" digest="$2" labels
  labels="$(docker volume inspect --format '{{json .Labels}}' "${name}")" || return 1
  python3 - "${labels}" "${digest}" <<'PY'
import json
import sys
try:
    labels = json.loads(sys.argv[1])
except (TypeError, json.JSONDecodeError):
    raise SystemExit(1)
expected = {
    "com.freshell.cache.owner": "freshell",
    "com.freshell.cache.purpose": "rust-target",
    "com.freshell.cache.schema": "1",
    "com.freshell.cache.worktree-sha256": sys.argv[2],
}
raise SystemExit(0 if isinstance(labels, dict) and all(labels.get(key) == value for key, value in expected.items()) else 1)
PY
}
volume_exists() {
  local name="$1" names
  names="$(docker volume ls --format '{{.Name}}' --filter "name=${name}")" || return 2
  printf '%s\n' "${names}" | grep -Fxq -- "${name}"
}
cleanup_scratch() {
  local status=$?
  trap - EXIT
  rm -rf -- "${SCRATCH_ROOT}"
  exit "${status}"
}
trap cleanup_scratch EXIT

for volume in "${FIRST_VOLUME}" "${SECOND_VOLUME}"; do
  if volume_exists "${volume}"; then
    fail sandbox_cache_selftest_unexpected_preexisting_volume
  else
    status=$?
    [ "${status}" -eq 1 ] || fail sandbox_cache_selftest_volume_list_failed
  fi
done

trap - EXIT
OWNED_VOLUMES=("${FIRST_VOLUME}" "${SECOND_VOLUME}")
REFERENCE_CONTAINER="freshell-cache-selftest-ref-${TEST_ID}"
ACTIVE_PIDS=()
reference_container_owned() {
  local recorded_id
  recorded_id="$(docker container inspect --format '{{ index .Config.Labels "com.freshell.cache.selftest" }}' "${REFERENCE_CONTAINER}")" || return 1
  [ "${recorded_id}" = "${TEST_ID}" ]
}
cleanup() {
  local status=$? cleanup_failed=0 refs name digest
  trap - EXIT
  for pid in "${ACTIVE_PIDS[@]}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      kill -TERM "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
    fi
  done
  if [ -n "${REFERENCE_CONTAINER}" ] && docker container inspect "${REFERENCE_CONTAINER}" >/dev/null 2>&1; then
    if reference_container_owned; then
      docker rm --force "${REFERENCE_CONTAINER}" >/dev/null 2>&1 || cleanup_failed=1
    else
      log error sandbox_cache_selftest_container_name_not_owned
      cleanup_failed=1
    fi
  fi
  for name in "${OWNED_VOLUMES[@]}"; do
    case "${name}" in
      "${FIRST_VOLUME}") digest="${FIRST_DIGEST}" ;;
      "${SECOND_VOLUME}") digest="${SECOND_DIGEST}" ;;
      *) continue ;;
    esac
    if volume_exists "${name}"; then
      if volume_labels_match "${name}" "${digest}"; then
        if refs="$(docker ps -aq --filter "volume=${name}")"; then
          if [ -z "${refs}" ]; then
            docker volume rm "${name}" >/dev/null 2>&1 || cleanup_failed=1
          else
            log error sandbox_cache_selftest_cleanup_volume_still_referenced
            cleanup_failed=1
          fi
        else
          log error sandbox_cache_selftest_cleanup_reference_check_failed
          cleanup_failed=1
        fi
      else
        log error sandbox_cache_selftest_cleanup_volume_labels_unverified
        cleanup_failed=1
      fi
    else
      local volume_status=$?
      if [ "${volume_status}" -ne 1 ]; then
        log error sandbox_cache_selftest_cleanup_volume_list_failed
        cleanup_failed=1
      fi
    fi
  done
  rm -rf -- "${SCRATCH_ROOT}"
  if [ "${status}" -eq 0 ] && [ "${cleanup_failed}" -ne 0 ]; then status=1; fi
  exit "${status}"
}
trap cleanup EXIT

run_wrapper() {
  local root="$1" mode="$2" command="$3" output
  if [ "${mode}" = runtime ]; then
    if output="$("${root}/scripts/sandbox-test.sh" --runtime-suite "${command}" 2>&1)"; then return 0; fi
  else
    if output="$("${root}/scripts/sandbox-test.sh" "${command}" 2>&1)"; then return 0; fi
  fi
  printf '%s\n' "${output}" >&2
  return 1
}

ordinary_marker=".cache-selftest-${TEST_ID}-ordinary"
runtime_marker=".cache-selftest-${TEST_ID}-runtime"
concurrent_one=".cache-selftest-${TEST_ID}-concurrent-one"
concurrent_two=".cache-selftest-${TEST_ID}-concurrent-two"
isolated_marker=".cache-selftest-${TEST_ID}-isolated"
recreated_marker=".cache-selftest-${TEST_ID}-recreated"

run_wrapper "${FIRST_ROOT}" ordinary "test \"\$(id -u)\" -ne 0 && printf one > /workspace/target/${concurrent_one}" \
  >"${SCRATCH_ROOT}/concurrent-one.log" 2>&1 &
FIRST_PID=$!
ACTIVE_PIDS+=("${FIRST_PID}")
run_wrapper "${FIRST_ROOT}" ordinary "test \"\$(id -u)\" -ne 0 && printf two > /workspace/target/${concurrent_two}" \
  >"${SCRATCH_ROOT}/concurrent-two.log" 2>&1 &
SECOND_PID=$!
ACTIVE_PIDS+=("${SECOND_PID}")
FIRST_STATUS=0
SECOND_STATUS=0
wait "${FIRST_PID}" || FIRST_STATUS=$?
wait "${SECOND_PID}" || SECOND_STATUS=$?
ACTIVE_PIDS=()
if [ "${FIRST_STATUS}" -ne 0 ] || [ "${SECOND_STATUS}" -ne 0 ]; then
  cat "${SCRATCH_ROOT}/concurrent-one.log" "${SCRATCH_ROOT}/concurrent-two.log" >&2
  fail sandbox_cache_selftest_concurrent_first_use_failed
fi
log info sandbox_cache_selftest_concurrent_first_use_passed

run_wrapper "${FIRST_ROOT}" ordinary \
  "test \"\$(cat /workspace/target/${concurrent_one})\" = one && test \"\$(cat /workspace/target/${concurrent_two})\" = two && printf ordinary > /workspace/target/${ordinary_marker}" \
  || fail sandbox_cache_selftest_same_worktree_reuse_failed
run_wrapper "${FIRST_ROOT}" runtime \
  "test \"\$(id -u)\" -ne 0 && test \"\$(cat /freshell-test-artifacts/${ordinary_marker})\" = ordinary && printf runtime > /freshell-test-artifacts/${runtime_marker}" \
  || fail sandbox_cache_selftest_runtime_alias_failed
run_wrapper "${FIRST_ROOT}" ordinary \
  "test \"\$(cat /workspace/target/${runtime_marker})\" = runtime" \
  || fail sandbox_cache_selftest_alias_reuse_failed
run_wrapper "${SECOND_ROOT}" ordinary \
  "test ! -e /workspace/target/${ordinary_marker} && printf isolated > /workspace/target/${isolated_marker}" \
  || fail sandbox_cache_selftest_worktree_isolation_failed

volume_labels_match "${FIRST_VOLUME}" "${FIRST_DIGEST}" || fail sandbox_cache_selftest_first_volume_labels_invalid
volume_labels_match "${SECOND_VOLUME}" "${SECOND_DIGEST}" || fail sandbox_cache_selftest_second_volume_labels_invalid
log info sandbox_cache_selftest_reuse_alias_isolation_and_labels_passed

docker run --detach --network none --name "${REFERENCE_CONTAINER}" \
  --label "com.freshell.cache.selftest=${TEST_ID}" \
  --mount "type=volume,src=${FIRST_VOLUME},dst=/cache" \
  --entrypoint sleep "${IMAGE_TAG}" 60 >/dev/null
reference_running="$(docker container inspect --format '{{.State.Running}}' "${REFERENCE_CONTAINER}")" \
  || fail sandbox_cache_selftest_reference_container_inspect_failed
[ "${reference_running}" = true ] || fail sandbox_cache_selftest_reference_container_not_running
reference_container_owned || fail sandbox_cache_selftest_reference_container_not_owned
if docker volume rm "${FIRST_VOLUME}" >"${SCRATCH_ROOT}/running-reference-rm.log" 2>&1; then
  fail sandbox_cache_selftest_running_reference_was_removed
fi
grep -q 'volume is in use' "${SCRATCH_ROOT}/running-reference-rm.log" \
  || fail sandbox_cache_selftest_running_reference_error_unexpected
docker stop --time 1 "${REFERENCE_CONTAINER}" >/dev/null
reference_running="$(docker container inspect --format '{{.State.Running}}' "${REFERENCE_CONTAINER}")" \
  || fail sandbox_cache_selftest_stopped_reference_inspect_failed
[ "${reference_running}" = false ] || fail sandbox_cache_selftest_reference_container_not_stopped
if docker volume rm "${FIRST_VOLUME}" >"${SCRATCH_ROOT}/stopped-reference-rm.log" 2>&1; then
  fail sandbox_cache_selftest_stopped_reference_was_removed
fi
grep -q 'volume is in use' "${SCRATCH_ROOT}/stopped-reference-rm.log" \
  || fail sandbox_cache_selftest_stopped_reference_error_unexpected
reference_container_owned || fail sandbox_cache_selftest_reference_container_not_owned
docker rm "${REFERENCE_CONTAINER}" >/dev/null
REFERENCE_CONTAINER=""
log info sandbox_cache_selftest_running_and_stopped_references_protected

volume_labels_match "${FIRST_VOLUME}" "${FIRST_DIGEST}" || fail sandbox_cache_selftest_volume_labels_changed_before_reset
refs="$(docker ps -aq --filter "volume=${FIRST_VOLUME}")" || fail sandbox_cache_selftest_reference_check_failed
[ -z "${refs}" ] || fail sandbox_cache_selftest_volume_still_referenced_before_reset
docker volume rm "${FIRST_VOLUME}" >/dev/null
run_wrapper "${FIRST_ROOT}" ordinary \
  "test \"\$(id -u)\" -ne 0 && test ! -e /workspace/target/${ordinary_marker} && printf recreated > /workspace/target/${recreated_marker}" \
  || fail sandbox_cache_selftest_fresh_recreation_failed
volume_labels_match "${FIRST_VOLUME}" "${FIRST_DIGEST}" || fail sandbox_cache_selftest_recreated_volume_labels_invalid
log info sandbox_cache_selftest_fresh_volume_recreation_passed
log info sandbox_cache_selftest_passed
