#!/usr/bin/env bash
# Build (or rebuild) the freshell-sandbox Docker image.
#
# The image is tagged freshell-sandbox:latest and carries the invoking
# operator's UID/GID so bind-mounted repo files keep sane ownership. Run this
# directly after changing docker/sandbox/Dockerfile; scripts/sandbox-test.sh
# also auto-builds the image on first use if it's missing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="freshell-sandbox:latest"
# shellcheck source=scripts/sandbox-image-definition.sh
source "${REPO_ROOT}/scripts/sandbox-image-definition.sh"

SANDBOX_UID="$(id -u)"
SANDBOX_GID="$(id -g)"
PLAYWRIGHT_VERSION="$(sandbox_playwright_version "${REPO_ROOT}")"
DEFINITION_SHA256="$(
  sandbox_image_definition_sha256 \
    "${REPO_ROOT}" \
    "${PLAYWRIGHT_VERSION}" \
    "${SANDBOX_UID}" \
    "${SANDBOX_GID}"
)"

echo "[sandbox] building ${IMAGE_TAG} (uid=${SANDBOX_UID} gid=${SANDBOX_GID}, definition=${DEFINITION_SHA256})..." >&2
# --network=host here is a BUILD-time-only workaround for this host's Docker
# default bridge network being broken (its docker0 interface is absent — a
# pre-existing environment condition, not introduced by this image). It only
# affects RUN steps' outbound package-manager traffic (apt/curl/npm) during
# the build; the build never listens on a port, so it cannot collide with
# host services. Runtime containers (scripts/sandbox-test.sh) use the
# dedicated freshell-sandbox bridge network instead, never host networking.
docker build \
  --network=host \
  --build-arg "UID=${SANDBOX_UID}" \
  --build-arg "GID=${SANDBOX_GID}" \
  --build-arg "PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}" \
  --build-arg "FRESHELL_SANDBOX_DEFINITION_SHA256=${DEFINITION_SHA256}" \
  -t "${IMAGE_TAG}" \
  "${REPO_ROOT}/docker/sandbox"

echo "[sandbox] built ${IMAGE_TAG}" >&2
