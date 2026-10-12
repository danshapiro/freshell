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
   found ... — using ambient gcloud`). On machines with a well-known-path
   install this state resolves the robot via discovery instead: the selector
   runs, and a second stderr note (`gcloud-robot: well-known install at ...
   produced no identity`) can appear when the probe fails. In this state
   `verify-as-robot.sh` failing at the key/token-mint rung is the CORRECT
   result, not a regression — do not debug it, provision.
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
   `testIamPermissions` probe; when `GCLOUD_ROBOT_HOME` is unset the lanes
   probe the first well-known skill install (`~/.codex/skills/gcloud-robot`,
   `~/.claude/skills/gcloud-robot`, `~/code/skill-gcloud-robot/gcloud-robot`)
   instead. The robot "just works" wherever its key is
   activated; human accounts keep working untouched.
5. Ambient gcloud (default when nothing above resolves), announced once on
   stderr. Set `GCLOUD_ROBOT_REQUIRE=1` to fail closed with guidance instead
   (hardening / CI).

A resolved identity pins every `--account` the wrappers emit and exports
`CLOUDSDK_CORE_ACCOUNT`/`CLOUDSDK_CORE_PROJECT` for any unpinned descendants.

## OneCLI gateway broker (garageserver)

garageserver routes all outbound HTTPS through the OneCLI gateway
(`127.0.0.1:10255`; see `/srv/onecli/docker-compose.yml`). Since 2026-09-15
the gateway holds a **Google Cloud app connection** — a dedicated
gcloud-robot service-account key stored in OneCLI — that mints short-lived
robot tokens and injects them on the lane control-plane hosts:

`artifactregistry.googleapis.com`, `cloudbuild.googleapis.com`,
`run.googleapis.com` (+ regional `-run`), `logging.googleapis.com`
(+ regional `-logging`), `serviceusage.googleapis.com`,
`containeranalysis.googleapis.com`.

**Opt-in only, since 2026-09-26.** The connection is granted to a
dedicated OneCLI agent, `gcloud-broker`, and to nothing else. For an agent
holding the grant, the gateway *overwrites* the `Authorization` header on
those hosts, whatever the caller sent: a valid token for another account is
replaced just like a dead one. From 2026-09-15 to 2026-09-26 the grant sat on
the machine-wide `garageserver` agent that every shell uses. So every gcloud,
Terraform, curl and Node call from garageserver to those hosts ran as this
robot, and other identities got 403s: deploy-bot on `directordeck` and
`directordeck-staging`, the glowfer-claws robot, and others. Lanes do not
need the broker. They authenticate with their own key for the same robot and
check that it can mint a token before they start.

What the broker is still for: a single command that has to succeed as the
robot when the local credential is dead or missing, for example during
incident recovery. Send just that command through the `gcloud-broker` agent.
Its token comes from the OneCLI admin API and is not stored in any file:

```bash
tok=$(curl -fsS --noproxy '*' http://127.0.0.1:10254/v1/agents |
  python3 -c 'import json,sys; print(next(a["accessToken"] for a in json.load(sys.stdin) if a["identifier"]=="gcloud-broker"))')
HTTPS_PROXY="http://x:$tok@127.0.0.1:10255" https_proxy="$HTTPS_PROXY" \
  gcloud artifacts docker tags delete ... --project=misc-puttering-project
```

Do not grant the connection back to `garageserver`, `dandesktop`, or any
other agent that general-purpose tools use. OneCLI picks the credential by the
calling agent, not by what the request carries.

Deliberately NOT brokered, so do not "fix" their absence:

- `cloudresourcemanager.googleapis.com` — the identity probe above must
  reflect the CALLER's credentials; injecting the robot would fabricate a
  pass for every account and break ladder ordering.
- `iam.googleapis.com`, `compute.googleapis.com` — admin surfaces stay on
  client credentials; the broker key is least-privilege by design.
- `oauth2.googleapis.com` token refresh — every other Google account on the
  machine refreshes through the same proxy; serving the broker's cached
  token to their refresh POSTs would corrupt client credential state.

The identity preflight mints via `oauth2.googleapis.com`, which the gateway
never brokers, so a lane whose resolved identity has a dead LOCAL credential
fails fast at the preflight. Keep the robot key
activated (`$GCLOUD_ROBOT_HOME/scripts/bootstrap-robot.sh`) or pin
`GCLOUD_IDENT` on such machines.

Consequence for operators: with the default proxy settings, gcloud calls
from garageserver run as the account gcloud selected (`--account`, the lane's
resolved identity, or the active account). There is no need to unset
`HTTPS_PROXY` for locally authenticated calls. The OneCLI record for the
change, including how to revert it, is `garageserver/docs/onecli.md` in the
`machines` repo, section "The Google Cloud broker".

Facts on disk (garageserver):

- OneCLI image `1.45.0-gcloud-iap-wrap-7cdf9b6` (local build, not in any
  registry; `ONECLI_VERSION` in `/srv/onecli/.env`), source branch
  `gcp-broker` in the onecli fork (`~/code/onecli`, GitHub
  `danshapiro/onecli`). The gateway's `google-cloud` provider and the
  web/API connect flow live there.
- Broker key file: `~/.local/share/gcloud-robot/misc-puttering-onecli-broker.json`
  (user-managed key id `9ba89633eb32cfe902738f6d8747e3e193cda7ca`) — a
  SEPARATE key from the lane key, so lane-key rotation never breaks the
  broker. Connection granted only to the opt-in `gcloud-broker` OneCLI
  agent (see above); manage grants from the OneCLI UI
  (`http://192.168.3.150:10254` → Connections → Google Cloud).
- The robot's repo-level IAM on `freshell-e2e` now carries BOTH
  `roles/artifactregistry.writer` (push) and
  `roles/artifactregistry.repoAdmin` (tag/version deletion — the poisoned-
  tag recovery lever; `writer` alone cannot delete tags).

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

  On machines with a standard install the `GCLOUD_ROBOT_HOME` export is
  optional — the lanes probe the well-known locations in order when
  `GCLOUD_ROBOT_HOME` is unset; an explicit export still wins.

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
    # to every current and future repo. repoAdmin adds tag/version DELETION
    # (the poisoned-tag recovery lever) — writer alone cannot delete tags:
    for role in roles/artifactregistry.writer roles/artifactregistry.repoAdmin; do
      gcloud artifacts repositories add-iam-policy-binding freshell-e2e \
        --location=us-west1 --project=misc-puttering-project \
        --member="serviceAccount:gcloud-robot@misc-puttering-project.iam.gserviceaccount.com" \
        --role="$role" \
        --account="$GCLOUD_ROBOT_ADMIN_ACCOUNT" --condition=None
    done
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
     --probe "gcloud artifacts docker images describe us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e:latest --project=misc-puttering-project" \
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

4. Done. `pnpm run test:cloud` / `pnpm run test:e2e:cloud` now select the robot
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

   NOTE: this service account also holds a SECOND user-managed key — the
   OneCLI gateway broker key (`9ba89633…`, see the broker section above).
   Pick the row by key id, never "delete all others"; deleting the broker
   key breaks the opt-in `gcloud-broker` path on garageserver's gateway.

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
  credential-broker proxy that does not broker
  cloudresourcemanager.googleapis.com (garageserver's OneCLI gateway
  deliberately does not — see the broker section) → the lane falls to
  ambient with the one-line note. Either unset `https_proxy` /
  `HTTPS_PROXY` for the lane process (probe then reaches Google directly) or
  pin `GCLOUD_IDENT=<robot>` for the lane (this is why the operator machine's
  pin exists).
- A `403 … "credential not found"` error from OneCLI is the gateway's
  MASKED version of Google's own 401/403: it means the request's own
  credential was dead or absent AND the gateway holds no brokered
  credential for that host. It is NOT a Google permission verdict and has
  fooled incident triage before (2026-09-14: it hid both a dead ambient
  token and the robot's missing `artifactregistry.tags.delete` permission
  behind one identical error). Through the default `garageserver` agent
  (no broker grant), the gateway replaces Google's 401/403 body on the
  brokered hosts with OneCLI's `access_restricted` JSON instead. Either
  way it means the calling credential was rejected. Fix the credential, not
  the registry; do not grant the broker to get rid of the error.
- A lane prints the ambient-fallback note and then gcloud's
  "Reauthentication failed" → the lane fell back to ambient gcloud: the
  robot is not provisioned (or not activated) on this machine. Provision
  (above) or re-login interactively; both work, the point is the robot
  cannot be culled.
- A dead resolved identity now fails a lane in seconds at the identity
  preflight with the observable signature `[vitest-cloud]/[e2e-cloud]
  ERROR: identity preflight failed for <identity> (source: <rung>) - gcloud
  auth print-access-token could not mint a token.` — the preflight swallows
  gcloud's own output, so the historical raw signature (`There was a problem
  refreshing your current auth tokens: Reauthentication failed. cannot
  prompt during non-interactive execution`) no longer appears on the
  preflight path; it is what the preflight replaced. A lane under a real TTY
  with a reauth-required HUMAN credential still blocks interactively on
  `Reauthentication required.` / `Please enter your password:` (the prompt
  class that produced the multi-hour incident; discovery moves this blockage
  EARLIER, inside the resolve, with the selector's output swallowed) — pin
  `GCLOUD_ROBOT_ACCOUNT` (the selector probes it first and never mints the
  human) or `GCLOUD_IDENT` on PTY-launched agent lanes. A
  `gcloud-robot: well-known install at ... produced no identity` note means
  a standard install exists but its probe failed. The lane swallows the
  selector's own stderr when it runs it (`scripts/lib/gcp-identity.sh`
  invokes it with `2>/dev/null`), so that one-line note is the only in-lane
  observable; to see the selector's real guidance, run it manually with the
  env the lane passes (use the install path from the note):

  ```bash
  GCLOUD_ROBOT_HOME=<install path from the note> \
  GCLOUD_ROBOT_PROJECT=misc-puttering-project \
  GCLOUD_ROBOT_PROBE_PERMISSION=cloudbuild.builds.create \
  bash "$GCLOUD_ROBOT_HOME/scripts/select-gcloud-identity.sh"
  ```

### CI

No GitHub Actions workflow touches GCP (verified by survey); keep it that
way. If CI ever needs GCP, use Workload Identity Federation (keyless) —
never a JSON key in CI.
