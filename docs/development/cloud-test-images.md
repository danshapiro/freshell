# Cloud test images

`scripts/vitest-cloud.sh` and `scripts/e2e-cloud.sh` run tests on Cloud Run
Jobs from a Docker image built from your tree. This page covers which image a
run uses, when an image is reused or rebuilt, and how old images are cleaned
up. The shared logic lives in `scripts/lib/cloud-image.sh`, and the contract
comment at the top of that file is authoritative.

## What a cloud run tests

A cloud run always tests exactly the tree it was started from, even when
several worktrees on the same commit, each with different uncommitted
changes, run at the same time.

1. **Snapshot.** The run archives exactly the files that
   `gcloud meta list-files-for-upload` selects. That is the same file chooser
   `gcloud builds submit` uses. Cloud Build receives that archive, and
   `--local-build` extracts the same archive and builds from it. Edits made
   while the run is in flight do not change what gets built.
2. **Tag.**
   - Clean tree (`git status` shows nothing): `<sha12>`, the commit tag. It is
     shared by every run of that commit on any machine.
   - Anything else: `<sha12>-dirty-<hash>`, where the hash is taken from the
     snapshot archive. Identical content gets the same tag in every worktree.
     Different content never shares a tag.
3. **Pin.** The Cloud Run job references the image by digest
   (`...freshell-e2e@sha256:...`), never by tag. The run header prints both
   `Image:` (the digest) and `Tag:`.

## Reuse, rebuilds, and concurrent runs

- If the tag is already published, the run reuses it without building.
- If another run is already building the same tag, the run waits for that
  build and reuses its image instead of building again:
  - On the same machine, a lock file under
    `~/.cache/freshell/cloud-image-locks/` makes the second run wait.
  - On different machines, the run finds the other run's Cloud Build (queued
    or working) and waits for it.
  - If the build it waited for fails, the run builds once itself.
- **Known gap:** two machines that start the same image within the same
  source-upload window (tens of seconds) can each build once. That wastes one
  build but never runs wrong code, because tags follow content.
- A missing image, whether never built or deleted by the cleanup policy
  below, is simply rebuilt. A cold build takes about 13 minutes.
- `--build` (and the `build` subcommand) always builds a fresh image, but
  still reuses a build of the same tag that is already in flight.
- The BuildKit layer cache keeps its long-standing names (`<sha12>-cache` and
  `<sha12>-dirty-cache`). Dirty rebuilds of one commit therefore stay warm
  even though each dirty content has its own tag.
- `scripts/base-gate.sh` runs base gates from a clean scratch worktree so
  they use the reusable commit tag.

Knobs (rarely needed): `FRESHELL_CLOUD_IMAGE_LOCK_DIR`,
`FRESHELL_CLOUD_BUILD_POLL_SECONDS` (default 15), and
`FRESHELL_CLOUD_BUILD_WAIT_SECONDS` (default 4500).

## Which files are uploaded

`.gcloudignore` includes `.gitignore` first, so git-ignored build outputs and
local litter (`release/`, `.verify-vantages.env`, agent scratch) are never
uploaded. The `!` re-includes after that line, such as the checked-in
distribution fixtures and `docker/cloud-run/test-durations.txt`, still ship.
`.git` is excluded as a file too, because in a linked worktree it is a file.

To inspect the upload set, run from the repo root:

```bash
gcloud meta list-files-for-upload . | LC_ALL=C sort > /tmp/upload.txt
git ls-files --cached --others --exclude-standard | LC_ALL=C sort > /tmp/gitview.txt
LC_ALL=C comm -23 /tmp/upload.txt /tmp/gitview.txt   # must print nothing
```

## Tests

- `scripts/test/cloud-image-identity.test.sh` runs the real wrappers from
  fixture worktrees, with stubbed `gcloud`/`docker` modeling the registry and
  Cloud Build. It covers per-tree pinning, dedupe, waiting on an in-flight
  build, fallback after a failed build, reuse and rebuild of a commit image,
  edits during the snapshot, and `--local-build`.
- `scripts/test/cloud-upload-set.test.sh` runs gcloud's real upload chooser
  over a copy of the tree with git-ignored litter planted in it.

Both need `gcloud` installed but no credentials or network access.

## Cleanup policy (runbook)

Artifact Registry repo `freshell-e2e` (project `misc-puttering-project`,
location `us-west1`) holds these images. Each build uploads several GB, and
without a cleanup policy nothing is ever deleted (about 1 TB, roughly
$100/month, by 2026-09).

The policy in `docker/cloud-run/artifact-registry-cleanup-policy.json`:

- deletes every version of the `freshell-e2e` image package (tagged or
  untagged, including `-cache` and `-dirty` tags) once it is more than 1 day
  old
- always keeps the 12 newest versions, which is about the last 3 builds. Each
  build uploads about 4 versions: an index, its two child manifests, and its
  `-cache` manifest. So a quiet weekend doesn't force a rebuild.

**Status:** the repo only defines the policy. It takes effect when someone
applies it with the operator account, using the commands below. To check
whether it is currently applied, run the view command.

**Timing:** Artifact Registry runs cleanup in the background about once a
day. A version can survive 1 to 2 days, and policy changes take up to a day
to apply. Child manifests are deleted only after their parent index is
deleted.

**Identity:**

- Viewing works as the test robot
  `gcloud-robot@misc-puttering-project.iam.gserviceaccount.com`.
- Setting or removing the policy needs `artifactregistry.repositories.update`
  (role `roles/artifactregistry.admin`). The robot does not have that
  permission and should not get it. Use the human operator account
  (`$GCLOUD_ROBOT_ADMIN_ACCOUNT`, see [gcloud-robot.md](gcloud-robot.md)).
- Always pass `--account` and `--project` explicitly.
- On machines behind the OneCLI proxy, prefix each command with
  `env -u https_proxy -u HTTPS_PROXY`.

Run from the repo root:

```bash
REPO="freshell-e2e --location=us-west1 --project=misc-puttering-project"
POLICY=docker/cloud-run/artifact-registry-cleanup-policy.json

# View
gcloud artifacts repositories list-cleanup-policies $REPO \
  --account=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com

# Preview (dry run: log what would be deleted, delete nothing)
gcloud artifacts repositories set-cleanup-policies $REPO --policy="$POLICY" \
  --dry-run --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"

# Apply or change (edit the policy file first)
gcloud artifacts repositories set-cleanup-policies $REPO --policy="$POLICY" \
  --no-dry-run --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"

# Remove
gcloud artifacts repositories delete-cleanup-policies $REPO \
  --policynames=delete-test-images-older-than-1d,keep-12-most-recent-test-image-versions \
  --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"
```

**Watch out:**

- Once the policy is applied, a commit's image usually disappears about a day
  after newer builds replace it. The next run of that commit rebuilds it.
- Nothing may depend on a fixed tag such as `:latest` surviving; the runners
  no longer push one. The robot verification probe in
  [gcloud-robot.md](gcloud-robot.md) lists the newest image instead.
