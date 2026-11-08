#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="/home/dan/.nvm/versions/node/v22.21.1/bin:/home/dan/.cargo/bin:/home/dan/.local/bin:$PATH"
export FRESHELL_VITEST_BACKEND=cloud
export FRESHELL_E2E_BACKEND=cloud
export FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com
export GCLOUD_ROBOT_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com
export GCLOUD_ROBOT_REQUIRE=1
export FRESHELL_RUST_TEST_SANDBOX=1
export DOCKER_HOST=unix:///run/user/1000/docker.sock
export FRESHELL_TEST_COORDINATOR_POLL_MS=1000
export FRESHELL_VITEST_CLOUD_SCRIPT=/tmp/freshell-cloud-prepared-image-20261103.sh
export FRESHELL_TEST_SUMMARY='Garageserver latest-main update preparation'
cd /home/dan/code/freshell
scripts/base-gate.sh test > /tmp/freshell-garage-update-main-base-gate.log 2>&1
