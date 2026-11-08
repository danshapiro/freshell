#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="/home/dan/.nvm/versions/node/v22.21.1/bin:/home/dan/.cargo/bin:/home/dan/.local/bin:$PATH"
export FRESHELL_BUILD_COMMIT=51ca8c6a33daa41f5461f93540138a5677698ed6
export FRESHELL_BUILD_SOURCE_STATE=clean
cd /home/dan/code/freshell/.worktrees/.base-gate-985321
unset DOCKER_CONTEXT || true
export DOCKER_HOST=unix:///run/user/1000/docker.sock
docker build -f /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/source-51ca8c6a3/docker/runtime/Dockerfile --iidfile /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/candidate/runtime-image.id --label org.opencontainers.image.revision=51ca8c6a33daa41f5461f93540138a5677698ed6 -t freshell-runtime:prepare-51ca8c6a3 /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/source-51ca8c6a3
printf "Runtime image build completed\n"
