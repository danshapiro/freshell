#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="/home/dan/.nvm/versions/node/v22.21.1/bin:/home/dan/.cargo/bin:/home/dan/.local/bin:$PATH"
export FRESHELL_BUILD_COMMIT=51ca8c6a33daa41f5461f93540138a5677698ed6
export FRESHELL_BUILD_SOURCE_STATE=clean
cd /home/dan/code/freshell/.worktrees/.base-gate-985321
export CARGO_TARGET_DIR=/home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/build-target
export CARGO_BUILD_JOBS=16
cargo build --release -p freshell-server -p freshell-supervisor -p freshell-session-host --locked --features freshell-server/managed-runtime-v1
mkdir -p /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/candidate/bin
install -m 755 "$CARGO_TARGET_DIR/release/freshell-server" /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/candidate/bin/freshell-server
install -m 755 "$CARGO_TARGET_DIR/release/freshell-supervisor" /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/candidate/bin/freshell-supervisor
install -m 755 "$CARGO_TARGET_DIR/release/freshell-session-host" /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/candidate/bin/freshell-session-host
sha256sum /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/candidate/bin/* > /home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi/candidate/bin-sha256.txt
printf "Managed binary build and staging completed\n"
