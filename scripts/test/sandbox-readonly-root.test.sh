#!/usr/bin/env bash
# Exercise the exact runtime assertion without any host mounts or cache volumes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG=freshell-sandbox:latest
ASSERTION="${REPO_ROOT}/scripts/test/assert-sandbox-readonly-root.sh"
DOCKER_ARGS=(run --rm -i --network none --user sandbox --cap-drop ALL
  --security-opt no-new-privileges --entrypoint bash)

STATUS=0
OUTPUT="$(docker "${DOCKER_ARGS[@]}" \
  "${IMAGE_TAG}" -s <"${ASSERTION}" 2>&1)" || STATUS=$?
echo "${OUTPUT}"
if [ "${STATUS}" -ne 1 ] || ! grep -q 'FAIL: sandbox root filesystem is writable' <<<"${OUTPUT}"; then
  echo "FAIL: readonly assertion must reject a writable root (container_exit=${STATUS})" >&2
  exit 1
fi
echo 'PASS: negative control rejected the writable container root'

docker "${DOCKER_ARGS[@]}" --read-only \
  "${IMAGE_TAG}" -s <"${ASSERTION}"
echo 'PASS: positive control accepted the read-only container root'
