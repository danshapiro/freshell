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
DEFINITION_SHA256="$(
  sha256sum \
    "${REPO_ROOT}/docker/sandbox/Dockerfile" \
    "${REPO_ROOT}/docker/sandbox/entrypoint.sh" \
  | awk '{print $1}' \
  | sha256sum \
  | awk '{print $1}'
)"

echo "[sandbox] building ${IMAGE_TAG} (uid=$(id -u) gid=$(id -g), definition=${DEFINITION_SHA256})..." >&2
# --network=host here is a BUILD-time-only workaround for this host's Docker
# default bridge network being broken (its docker0 interface is absent — a
# pre-existing environment condition, not introduced by this image). It only
# affects RUN steps' outbound package-manager traffic (apt/curl/npm) during
# the build; the build never listens on a port, so it cannot collide with
# host services. Runtime containers (scripts/sandbox-test.sh) use the
# dedicated freshell-sandbox bridge network instead, never host networking.
docker build \
  --network=host \
  --build-arg "UID=$(id -u)" \
  --build-arg "GID=$(id -g)" \
  --build-arg "FRESHELL_SANDBOX_DEFINITION_SHA256=${DEFINITION_SHA256}" \
  -t "${IMAGE_TAG}" \
  "${REPO_ROOT}/docker/sandbox"

echo "[sandbox] built ${IMAGE_TAG}" >&2
