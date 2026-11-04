#!/usr/bin/env bash
# Build (or rebuild) the freshell-sandbox Docker image.
#
# The default image uses docker/sandbox/protocol.json and carries the invoking
# operator's UID/GID so bind-mounted repo files keep sane ownership. Run this
# directly after changing docker/sandbox/Dockerfile; scripts/sandbox-test.sh
# also auto-builds the image on first use if it's missing.
# FRESHELL_SANDBOX_IMAGE selects an explicit development/test tag.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_IMAGE_TAG="$(node -p 'require(process.argv[1]).image' "${REPO_ROOT}/docker/sandbox/protocol.json")"
IMAGE_TAG="${FRESHELL_SANDBOX_IMAGE:-${DEFAULT_IMAGE_TAG}}"

FOUNDATION_ID_FILE="$(mktemp "${TMPDIR:-/tmp}/freshell-sandbox-foundation.XXXXXXXX")"
FOUNDATION_BUILD_TAG="freshell-sandbox:foundation-build-${FOUNDATION_ID_FILE##*.}"
FOUNDATION_BUILD_TAG="${FOUNDATION_BUILD_TAG,,}"
FOUNDATION_ID=""
node -e 'console.error(JSON.stringify({severity:"info",event:"sandbox_foundation_build_allocated",tag:process.argv[1],idFile:process.argv[2]}))' \
  "${FOUNDATION_BUILD_TAG}" "${FOUNDATION_ID_FILE}"

cleanup_foundation_build() {
  local status=$? observed
  trap - EXIT
  if [ -z "${FOUNDATION_ID}" ] && [ -s "${FOUNDATION_ID_FILE}" ]; then
    FOUNDATION_ID="$(cat "${FOUNDATION_ID_FILE}")"
  fi
  if observed="$(docker image inspect "${FOUNDATION_BUILD_TAG}" --format '{{.Id}}' 2>/dev/null)"; then
    if [ -n "${FOUNDATION_ID}" ] && [ "${observed}" = "${FOUNDATION_ID}" ]; then
      docker image rm "${FOUNDATION_BUILD_TAG}" >/dev/null || status=1
    else
      printf '{"severity":"error","event":"sandbox_foundation_build_cleanup_unverified"}\n' >&2
      status=1
    fi
  fi
  rm -f -- "${FOUNDATION_ID_FILE}"
  exit "${status}"
}
trap cleanup_foundation_build EXIT

if docker image inspect "${FOUNDATION_BUILD_TAG}" >/dev/null 2>&1; then
  printf '{"severity":"error","event":"sandbox_foundation_build_tag_exists"}\n' >&2
  exit 2
fi
# Build-time networking retains the existing bridge workaround. Runtime
# network, process, memory and user limits are owned by sandbox-test.sh.
docker build --network=host --target dependency-foundation \
  --build-arg "UID=$(id -u)" --build-arg "GID=$(id -g)" \
  --iidfile "${FOUNDATION_ID_FILE}" -t "${FOUNDATION_BUILD_TAG}" \
  "${REPO_ROOT}/docker/sandbox"
FOUNDATION_ID="$(cat "${FOUNDATION_ID_FILE}")"
[[ "${FOUNDATION_ID}" =~ ^sha256:[a-f0-9]{64}$ ]]
FOUNDATION_TAG="freshell-sandbox:dependency-foundation-v2-${FOUNDATION_ID#sha256:}"
if existing="$(docker image inspect "${FOUNDATION_TAG}" --format '{{.Id}}' 2>/dev/null)"; then
  [ "${existing}" = "${FOUNDATION_ID}" ] || exit 2
else
  docker tag "${FOUNDATION_BUILD_TAG}" "${FOUNDATION_TAG}"
fi
printf '{"severity":"info","event":"sandbox_dependency_foundation","image":"%s","id":"%s"}\n' \
  "${FOUNDATION_TAG}" "${FOUNDATION_ID}" >&2

docker build --network=host --target sandbox-runtime \
  --build-arg "UID=$(id -u)" --build-arg "GID=$(id -g)" \
  --build-arg "FRESHELL_SANDBOX_FOUNDATION_IMAGE=${FOUNDATION_TAG}" \
  --build-arg "FRESHELL_SANDBOX_DEPENDENCY_FOUNDATION_ID=${FOUNDATION_ID}" \
  -t "${IMAGE_TAG}" "${REPO_ROOT}/docker/sandbox"
printf '[sandbox] built %s\n' "${IMAGE_TAG}" >&2
