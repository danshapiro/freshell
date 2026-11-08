#!/usr/bin/env bash
set -euo pipefail
export PATH="/home/dan/.local/bin:$PATH"
cloud_account=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com
cloud_project=misc-puttering-project
candidate_commit=$(git rev-parse HEAD)
candidate_tag=$(git rev-parse --short=12 HEAD)
candidate_image="us-west1-docker.pkg.dev/$cloud_project/freshell-e2e/freshell-e2e:$candidate_tag"
if ! gcloud artifacts docker images describe "$candidate_image" --account="$cloud_account" --project="$cloud_project" --format='value(image_summary.digest)' --quiet >/dev/null 2>&1; then
 gcloud builds submit --region=global --quiet --account="$cloud_account" --project="$cloud_project" --config "$PWD/docker/cloud-run/cloudbuild.yaml" --substitutions="_IMAGE=$candidate_image,_FRESHELL_BUILD_COMMIT=$candidate_commit" "$PWD"
fi
exec "$PWD/scripts/vitest-cloud.sh" "$@"
