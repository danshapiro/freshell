#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="/home/dan/.nvm/versions/node/v22.21.1/bin:/home/dan/.cargo/bin:/home/dan/.local/bin:$PATH"
export FRESHELL_BUILD_COMMIT=51ca8c6a33daa41f5461f93540138a5677698ed6
export FRESHELL_BUILD_SOURCE_STATE=clean
cd /home/dan/code/freshell/.worktrees/.base-gate-985321
pnpm run typecheck:client
pnpm run build:client --outDir /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/candidate/client
pnpm run build:tools --outDir /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/candidate/tools
pnpm --filter freshell-claude-sidecar --prod --frozen-lockfile --config.node-linker=hoisted deploy /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/candidate/claude-sidecar
printf "Client, tools and portable sidecar staging completed\n"
