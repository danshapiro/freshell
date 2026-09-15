# gcloud-robot identity for cloud test lanes

Freshell's cloud test lanes (`scripts/e2e-cloud.sh`, `scripts/vitest-cloud.sh`
— Cloud Run Jobs for Playwright e2e and Vitest suites, plus their shared
Cloud Build / Artifact Registry image machinery) no longer depend on an
interactive `gcloud auth login`. Interactive gcloud sessions ride OAuth
refresh tokens that Google silently culls (roughly hourly under heavy agent
use); the last observed casualty was a base-gate run dying mid-lane with
`Reauthentication failed. cannot prompt during non-interactive execution`
(2026-08-23, UTC). The replacement is the gcloud-robot pattern: one
per-project robot service account minted from a local JSON key — no browser
login, no refresh token, no hourly expiry.

Project: `misc-puttering-project` (region `us-west1`, AR repo `freshell-e2e`).
Robot: `gcloud-robot@misc-puttering-project.iam.gserviceaccount.com`.

## Security, stated plainly

A JSON key is bearer power with no MFA and — by default — no expiry. It is
weaker than an expiring interactive session. Two things bound the risk:
least-privilege per-project grants (below), and rotation plus instant
revocation as first-class operations (below). The control that still holds
when logs are blind is the standing rotation cadence — keep one, and enable
the key-usage alerting in "Monitor".

## Adoption states

The repo is in exactly one of two states at any time:

1. **wired but not yet provisioned** — the ladder and this runbook are
   committed, but the robot SA/key do not exist yet. Expected behavior: lanes
   run exactly as before under ambient gcloud, with one quiet stderr note
   (`gcloud-robot: no probed identity; using ambient gcloud` / `skill not
   found ... — using ambient gcloud`). In this state `verify-as-robot.sh`
   failing at the key/token-mint rung is the CORRECT result, not a
   regression — do not debug it, provision.
2. **provisioned and verified** — provisioning below completed and the
   verification ladder passed as the robot.

## How lanes resolve identity (after conversion)

Lazily, immediately before a cloud lane's first real gcloud call (`help` and
`run --local` never resolve anything and need zero GCP tooling), in this
fixed order:

1. `--account=<email>` flag — call-site pin, always wins.
2. `FRESHELL_GCP_ACCOUNT` env — repo pin, also always wins.
3. `GCLOUD_IDENT` env — explicit bypass (CI, hermetic tests): used verbatim,
   no probe, no network.
4. gcloud-robot probe — `$GCLOUD_ROBOT_HOME/scripts/select-gcloud-identity.sh`
   picks the first credentialed account passing the lane's live
   `testIamPermissions` probe. The robot "just works" wherever its key is
   activated; human accounts keep working untouched.
5. Ambient gcloud (default when nothing above resolves), announced once on
   stderr. Set `GCLOUD_ROBOT_REQUIRE=1` to fail closed with guidance instead
   (hardening / CI).

A resolved identity pins every `--account` the wrappers emit and exports
`CLOUDSDK_CORE_ACCOUNT`/`CLOUDSDK_CORE_PROJECT` for any unpinned descendants.

## Operator setup

### Prerequisites

- The `gcloud-robot` skill installed for your agent platform (whatever
  directory holds its `scripts/` — the repo never records that path).
- The Cloud Resource Manager API enabled on the project (the identity probe's
  `testIamPermissions` call needs it; any project that has ever touched IAM
  already has it — `gcloud services enable cloudresourcemanager.googleapis.com
  --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"`
  is the one-time, idempotent enable).
- Point the lanes at it once, e.g. in `~/.bashrc`:

  ```bash
  export GCLOUD_ROBOT_HOME="<installed gcloud-robot skill directory>"
  # Prefer the robot when several accounts pass the probe:
  export GCLOUD_ROBOT_ACCOUNT="gcloud-robot@misc-puttering-project.iam.gserviceaccount.com"
  ```

### Provision (once per project, human-run — agents never run these)

All commands pin `--account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"` to your operator
account (export it). All skill scripts are invoked via
`bash "$GCLOUD_ROBOT_HOME/scripts/<name>.sh"`.

1. Bootstrap the robot (project-level roles):

   ```bash
   GCLOUD_ROBOT_PROJECT=misc-puttering-project \
   GCLOUD_ROBOT_ROLES="roles/cloudbuild.builds.editor roles/run.developer roles/logging.viewer roles/serviceusage.serviceUsageConsumer roles/containeranalysis.occurrences.viewer" \
   GCLOUD_ROBOT_ADMIN_ACCOUNT="$GCLOUD_ROBOT_ADMIN_ACCOUNT" \
   bash "$GCLOUD_ROBOT_HOME/scripts/bootstrap-robot.sh" --name gcloud-robot --activate
   ```

   This creates the SA, binds the project roles, mints a JSON key under
   `~/.local/share/gcloud-robot/` (mode 600, never inside
   `~/.config/gcloud`), prints the key path, and activates it. Role notes:
   names need the `roles/` prefix (bootstrap rejects bare names);
   `containeranalysis.occurrences.viewer` exists because Artifact Registry's
   `docker images describe` reads scan metadata and 403s without it — the
   wrappers' image-exists probe depends on that call. Record the
   key location for yourself as
   `key-path: <printed at provisioning>` (until then this runbook says:
   not yet minted — operator step).

   Also ensure the Artifact Registry repository exists. The robot holds
   `artifactregistry.writer` (push) but writer CANNOT create repositories,
   and the wrappers' create-if-missing path is `|| true`-masked — a missing
   repo would surface only as a push failure mid-run:

   ```bash
   gcloud artifacts repositories describe freshell-e2e \
     --location=us-west1 --project=misc-puttering-project \
     --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" || \
   gcloud artifacts repositories create freshell-e2e \
     --repository-format=docker --location=us-west1 --project=misc-puttering-project \
     --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"

   # Push/write power is granted on THIS repository only (repository-level
   # binding), never project-wide — the bearer key must not gain write access
   # to every current and future repo:
   gcloud artifacts repositories add-iam-policy-binding freshell-e2e \
     --location=us-west1 --project=misc-puttering-project \
     --member="serviceAccount:gcloud-robot@misc-puttering-project.iam.gserviceaccount.com" \
     --role=roles/artifactregistry.writer \
     --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" --condition=None
   ```

2. Scoped grants (bootstrap does NOT do these; skipping them is the classic
   "probe passes, build 403s" failure):

   ```bash
   # Staging bucket Cloud Build uploads source to (the default is
   # <project>_cloudbuild). Discovery must be deterministic: exactly one
   # *cloudbuild* bucket or the operator stops and picks by hand.
   mapfile -t BUCKETS < <(gcloud storage buckets list --project=misc-puttering-project \
     --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" --format='value(name)' | grep cloudbuild)
   if [ "${#BUCKETS[@]}" -ne 1 ]; then
     printf 'expected exactly one *cloudbuild* bucket, found %d:\n' "${#BUCKETS[@]}" >&2
     printf '  %s\n' "${BUCKETS[@]}" >&2
     exit 1
   fi
   BUCKET="${BUCKETS[0]}"
   echo "scoping storage grants to staging bucket: $BUCKET"
   # objectUser (object CRUD/list/multipart), NOT objectAdmin: the submitter
   # only stages ordinary source objects, and objectAdmin would add object
   # setIamPolicy/retention powers the bearer key must never hold. (This
   # diverges from the gcloud-robot skill's example role on purpose.)
   for role in roles/storage.objectUser roles/storage.legacyBucketReader; do
     gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
       --member="serviceAccount:gcloud-robot@misc-puttering-project.iam.gserviceaccount.com" \
       --role="$role" \
       --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" --condition=None
   done

   # actAs on the default build/run identities. Cloud Run jobs execute as the
   # project default compute SA, so creating jobs requires actAs on it. Cloud
   # Build's default execution identity is DISCOVERED, not assumed: on older
   # projects it is the legacy <number>@cloudbuild.gserviceaccount.com
   # (Google-owned, accepts NO bindings — skip it), on newer ones the compute
   # default SA. (actAs beyond this is only needed when a build config pins
   # serviceAccount: — docker/cloud-run/cloudbuild.yaml pins none.)
   PROJECT_NUMBER=$(gcloud projects describe misc-puttering-project \
     --format='value(projectNumber)' --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT")
   BUILD_SA="$(gcloud builds get-default-service-account --project=misc-puttering-project \
     --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" | grep -oE '[A-Za-z0-9._-]+@[A-Za-z0-9.-]+' | head -1)"
   for sa in "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" ${BUILD_SA:+"$BUILD_SA"}; do
     case "$sa" in
       *@cloudbuild.gserviceaccount.com) echo "skipping $sa (legacy Cloud Build SA accepts no IAM bindings)"; continue ;;
     esac
     gcloud iam service-accounts add-iam-policy-binding "$sa" \
       --member="serviceAccount:gcloud-robot@misc-puttering-project.iam.gserviceaccount.com" \
       --role=roles/iam.serviceAccountUser \
       --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" --condition=None
   done
   ```

3. Verify as the robot. Read-only probes retry through IAM propagation lag;
   a failure that persists past the retries names the missing grant.

   ```bash
   # For a quick pre-flight use GCLOUD_ROBOT_RETRIES=2 GCLOUD_ROBOT_RETRY_SLEEP=2,
   # then unset them for the real run.
   GCLOUD_ROBOT_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
   GCLOUD_ROBOT_PROJECT=misc-puttering-project \
   GCLOUD_ROBOT_PROBE_PERMISSION=cloudbuild.builds.create \
   GCLOUD_ROBOT_KEY_FILE=<key path printed by bootstrap> \
   bash "$GCLOUD_ROBOT_HOME/scripts/verify-as-robot.sh" \
     --probe "gcloud artifacts repositories describe freshell-e2e --location=us-west1 --project=misc-puttering-project" \
     --probe "gcloud artifacts docker images list us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e --include-tags --sort-by=~UPDATE_TIME --limit=1 --project=misc-puttering-project" \
     --probe "gcloud run jobs list --region=us-west1 --project=misc-puttering-project --limit=1" \
     --probe "gcloud builds list --project=misc-puttering-project --limit=1"
   ```

   The wrappers read execution logs via `gcloud beta run jobs executions logs
   read ... || true`, which masks a missing `roles/logging.viewer` quietly.
   When an execution exists, list a real log read as an explicit probe too:
   `--probe "gcloud beta run jobs executions logs read <execution-name> --project=misc-puttering-project --region=us-west1"`.

   Read probes alone do NOT prove the lane: they skip the scoped bucket
   grants, job create/delete, actAs, and the per-execution overrides the
   vitest lane uses. Finish verification with ONE REAL LANE SMOKE as the
   robot (~$0.02; small test file):

   ```bash
   GCLOUD_IDENT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
     bash scripts/vitest-cloud.sh run --cloud --config=default --shards=1 \
       test/unit/lib/pane-utils.test.ts
   ```

   Expected on success: `All tasks completed successfully.` A 403 names the
   missing grant in its error message — add the smallest covering grant
   (`bootstrap-robot.sh --no-key` updates roles without touching keys), then
   re-verify and re-smoke. Only after the probes AND the smoke pass is the
   repo "provisioned and verified".

4. Done. `npm run test:cloud` / `npm run test:e2e:cloud` now select the robot
   automatically wherever its key is activated; no `.env` or repo config
   exists for this (`.env.example` is server-runtime config and deliberately
   carries no cloud-lane knobs).

### Rotate (standing cadence — suggest quarterly, and after any suspicion)

1. Mint + activate a new key. Re-supply the CURRENT role list exactly —
   `bootstrap-robot.sh` re-applies it verbatim and bindings are additive-only:

   ```bash
   GCLOUD_ROBOT_PROJECT=misc-puttering-project \
   GCLOUD_ROBOT_ROLES="roles/cloudbuild.builds.editor roles/run.developer roles/logging.viewer roles/serviceusage.serviceUsageConsumer roles/containeranalysis.occurrences.viewer" \
   GCLOUD_ROBOT_ADMIN_ACCOUNT="$GCLOUD_ROBOT_ADMIN_ACCOUNT" \
   bash "$GCLOUD_ROBOT_HOME/scripts/bootstrap-robot.sh" --rekey --activate
   ```

2. Prove the real lane works as the robot (verify block above with the new
   key path).
3. Delete the OLD key id in IAM (list with `--managed-by=user`, pick the row
   whose id matches the old key file's `private_key_id`):

   ```bash
   gcloud iam service-accounts keys list --managed-by=user \
     --iam-account=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
     --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"
   gcloud iam service-accounts keys delete <OLD_KEY_ID> \
     --iam-account=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
     --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"
   ```

4. On any other host holding the old key copy, delete the file and run
   `gcloud auth revoke gcloud-robot@misc-puttering-project.iam.gserviceaccount.com`
   there (never on the host that just activated the new key).

### Revoke (leak response)

Delete the key in IAM (`keys delete`, above) — that instantly stops all NEW
token minting from every copy of the key. Tokens already minted stay valid
for up to an hour (Google-documented; key deletion does not invalidate issued
credentials). For an immediate total cutoff:

```bash
gcloud iam service-accounts disable gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
  --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT"
```

(Disabling halts all use project-wide until re-enabled — that is the trade
for immediacy.)

### Monitor (safety net, with honest limits)

- Key lifecycle events: `CreateServiceAccountKey` is a default-on Admin
  Activity audit event. Create a log-based metric (fully-qualified method
  name, scoped to the robot) and alert on it in your monitoring stack:

  ```bash
  gcloud logging metrics create robot-key-creations \
    --project=misc-puttering-project --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" \
    --description="key creation events for the gcloud-robot SA" \
    --log-filter='protoPayload.methodName="google.iam.admin.v1.CreateServiceAccountKey" AND resource.labels.email_id="gcloud-robot@misc-puttering-project.iam.gserviceaccount.com"'
  ```

- Key usage: `iam.googleapis.com/service_account/key/authn_events_count`
  (per-`key_id`) is the best available signal — but it is sampled every 600s
  and data lags up to ~3 hours, so it suits anomaly review and off-hours
  alerting, not instant paging. Rotation remains the control that holds when
  logs are blind.

### Troubleshooting

- Probe passes but `gcloud builds submit` 403s → the actAs grants (step 2).
- Cloud Build dies resolving source/logs (`storage.buckets.get` 403) → the
  bucket-scoped `roles/storage.legacyBucketReader` (step 2); object roles
  alone never carry bucket metadata reads.
- Push 403s or the run logs "Creating Artifact Registry repository" then
  fails → step 1's repo-exists check was skipped: writer cannot create
  repositories. Run the describe/create block from provisioning.
- "Where did build logs go?" / "submit doesn't stream anymore" → by design:
  `options.logging: CLOUD_LOGGING_ONLY` puts logs in Cloud Logging (the
  robot's `logging.viewer` covers reads; no project-wide viewer grant), and
  this mode does not stream during submit. Builds complete normally; read
  logs with `gcloud builds log <build-id> --project=misc-puttering-project`.
- A grant that definitely exists 403s for the first minutes → IAM
  propagation lag; the verifier's retries (12 × 30s default) absorb it. For
  bucket-scoped grants the observed lag ran to ~5 minutes once (don't retry
  instantly — wait minutes, not seconds).
- `bootstrap-robot.sh --activate` fails with `Properties in configuration
  [NONE] cannot be set.` → machines running an explicit-context gcloud
  wrapper delegate with `--configuration=NONE`, which cannot accept the
  config write. The credential IS registered before that failure: verify
  with `gcloud auth list` (robot row appears) and
  `gcloud auth print-access-token --account=<robot> --project=misc-puttering-project`
  (mints). Do not re-run bootstrap for this.
- The identity probe (`rung 3`) fails silently on machines behind a
  credential-broker proxy that lacks a credential for
  cloudresourcemanager.googleapis.com (e.g. a OneCLI gateway) → the lane
  falls to ambient with the one-line note. Either unset `https_proxy` /
  `HTTPS_PROXY` for the lane process (probe then reaches Google directly) or
  pin `GCLOUD_IDENT=<robot>` for the lane (this is why the operator machine's
  pin exists).
- A lane prints the ambient-fallback note and then gcloud's
  "Reauthentication failed" → the lane fell back to ambient gcloud: the
  robot is not provisioned (or not activated) on this machine. Provision
  (above) or re-login interactively; both work, the point is the robot
  cannot be culled.

### CI

No GitHub Actions workflow touches GCP (verified by survey); keep it that
way. If CI ever needs GCP, use Workload Identity Federation (keyless) —
never a JSON key in CI.
