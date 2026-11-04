# Self-hosted launch

Use the same flow for every Freshell machine. An instance is one Rust server
and one native Windows Electron client connected to it.

## Prepare the checkout (once, and after pulling changes)

The server needs the locked dependency tree present before it can start —
the Rust server launches the Claude sidecar from
`crates/freshell-claude-sidecar` at runtime. On a pnpm-era checkout
(development `main`), run the frozen install from the repo root:

```bash
cd /home/dan/code/freshell
pnpm install --frozen-lockfile
```

The root workspace install covers the app plus both workspace members (the
Claude sidecar and the MCP runtime packaging package). The launcher and the
`dev`/`start` script hooks verify sidecar readiness before the server spawns
and, if the tree is missing or stale, repair it with one frozen filtered
install — never a mutable one. An npm-era checkout (for example the v0.7.5
release) prepares with `npm install` instead.

Preparing or refreshing the workspace is a normal build step. For managed-runtime
maintenance, the default updater mode restarts only the web service and has no
`APPROVED` gate; reset-capable modes are documented below.

## Start or verify the server

Run this on the machine that owns the server:

```bash
cd /home/dan/code/freshell
curl -fsS --connect-timeout 5 --max-time 10 http://127.0.0.1:3001/api/health
```

If the health check fails, inspect the recorded owner's state and logs first;
failure does not establish that the process is stopped. Use the launcher only
for a launcher-owned server or a confirmed inactive new instance. For an
existing managed installation, use
[Managed-runtime upgrades](#managed-runtime-upgrades). Use systemd for a
systemd-owned instance.

For an ordinary launcher-owned instance, start with the canonical launcher:

```bash
scripts/launch-rust.sh --port 3001
```

For a remote machine, run the same command through SSH:

```bash
ssh <machine> 'cd /home/dan/code/freshell && scripts/launch-rust.sh --port 3001'
```

The launcher builds as needed, verifies the sidecar tree as part of startup,
and leaves a healthy instance running. If managed runtime is enabled, it also
checks the configured supervisor and authenticated runtime readiness before it
prints that the server is ready.

The optional systemd user unit (`installers/systemd/freshell-rust.service`)
launches the Rust binary directly — its `ExecStart` is the
`freshell-server` executable, no package manager involved — so it performs
no dependency preparation; prepare the checkout once on that machine as
above, and the service restores the server after restarts.

## Managed-runtime upgrades

Use the [managed-runtime update modes](#managed-runtime-update-modes) for
routine maintenance and upgrades. The default updates the web/client while
leaving the durable supervisor and managed sessions running. Use `--all` or
`--durable-only` only when the selected update requires a managed-session
reset; those modes require the exact word `APPROVED` and attempt to reopen
saved conversations afterward.

The launcher builds the server with `managed-runtime-v1` whenever
`FRESHELL_MANAGED_RUNTIME_V1=1` is set and checks the resulting feature marker.
With `--skip-build`, it refuses a binary that lacks that feature. A new
managed server can start only when the configured supervisor socket and
readable secret file are available. Before it prints ready, the launcher
checks authenticated `/api/runtime/readiness` and confirms that the reported
installation ID and control epoch match the same supervisor before and after
the request. It reports host-managed and unknown panes as outside durable-soul
protection and leaves them running.

The launcher refuses `--stop` and `--restart` for a running managed server.
Those actions bypass the pane-ownership census and could interrupt agent
work. The updater currently supports systemd-owned deployments only. For a
systemd installation, use the [managed-runtime update modes](#managed-runtime-update-modes).
Launcher-owned managed installations have no automated live update path.

If an existing featureless server returns 404 for authenticated
`/api/runtime/readiness`, the updater refuses before building or changing any
service. Without that endpoint it cannot safely inventory existing panes or
bootstrap the install. Keep the server and its sessions running; save or port
host-agent sessions, then use a separate deliberate approved recovery and
verify authenticated readiness against the intended supervisor before
describing the agents as protected.

For a deliberate upgrade from older protocol-1 hosts, qualify retained
terminal processes and Codex sidecar adoption with the candidate first. See
[Retaining processes from a legacy installation](managed-runtime-rollout.md#retaining-processes-from-a-legacy-installation).
This does not bypass the updater's refusal or authorize a service restart.
Record the specific interruption and recovery plan for other host-owned
agents before requesting bootstrap approval.

For reset-capable updates, retain the isolated old-schema drill, read-only
registry preflight, and verified live-backup procedure in
[Managed runtime rollout](managed-runtime-rollout.md#upgrade-an-existing-installation-while-preserving-stores).
Prepare candidate artifacts away from the live paths. The updater checks the
candidate feature, schema, systemd owner, effective service graph, and
authenticated runtime readiness before reporting success. On failure,
preserve the stores and artifacts and follow the forward-recovery instructions
in the update-modes section; do not assume artifact rollback.

## Prepare the operator home (managed-runtime souls)

Managed-runtime souls mount the operator home read-only so config `{file:}`
references under it (for example an opencode API key reference) resolve
in-soul. After deploying, run the host prep once as the operator:

```bash
scripts/prepare-operator-home.sh
```

The script is idempotent and safe to re-run at any time. Re-run it after any
Amplifier key rotation: rotation recreates keys at `0600`, which would
otherwise restore the original unreadable-reference failure. This one-command
re-run is the ratified tradeoff, not a gap — the failing provider's error
names the exact path. The session host's `operator_home_readiness` event
confirms the home root's group traversal afterward.

## Managed-runtime update modes

Run the updater from a host shell in the deployment checkout. It currently
supports systemd-owned installations only. Do not run it
inside a Freshell-managed pane: managed panes run inside soul containers and
do not own the host systemd user manager or deployment checkout. Resolve the
actual web and supervisor owners before maintenance. For systemd installations,
inspect the effective user units and drop-ins. The web unit may have
`After=freshell-supervisor.service`, but it must have no `Requires=`, `Wants=`,
or `Requisite=` relationship to the supervisor. If the installed drop-in has
those relationships, install the ordering-only drop-in and run
`systemctl --user daemon-reload` before retrying. The updater refuses a graph
where a web action could start, stop, or restart the supervisor. Fixture tests
do not certify the installed systemd graph.

The managed server must be built with the compile-time
`managed-runtime-v1` feature whenever `FRESHELL_MANAGED_RUNTIME_V1=1` is set.
The supported build is:

```bash
cargo build --release --locked -p freshell-server --features managed-runtime-v1
```

The updater builds and checks the candidate feature marker before installation.
The server also checks at startup and exits with a clear error if managed
runtime is requested from a binary without that feature. Do not use the
ordinary `scripts/launch-rust.sh` build path to install a managed server; its
default Rust build omits the managed feature. Use the updater below.

Before a reset-capable update, follow the read-only registry preflight and
verified-backup procedure in
[Managed runtime rollout](managed-runtime-rollout.md#upgrade-an-existing-installation-while-preserving-stores).
The candidate schema check must pass before any candidate opens the live
registry. Keep the verified old-schema backup, matching provider/session
stores, configuration, image, and prior artifacts. Do not treat a preview as
a backup.

Run one of these commands from the deployment checkout:

```bash
# Default: build/install web and client; restart only freshell-rust.service.
pnpm exec tsx scripts/update-managed-runtime.ts

# Reset managed coding sessions, then update web/client and durable runtime.
pnpm exec tsx scripts/update-managed-runtime.ts --all

# Reset managed coding sessions and update the durable runtime while keeping
# the existing web executable, client directory, and callback peer selected.
pnpm exec tsx scripts/update-managed-runtime.ts --durable-only
```

The default mode has no `APPROVED` gate. It replaces the web/client, restarts
only the web service, checks authenticated runtime readiness against the
intended supervisor identity, and prints a reminder that the supervisor and
managed sessions were not restarted and reset-capable updates require the exact
word `APPROVED`. The completion event and reminder are
also recorded in the updater's private JSONL log.

`--all` and `--durable-only` are reset-capable modes. After the updater has
resolved the mode and completed its non-mutating checks, it reads one raw line
and accepts only the exact string `APPROVED`. Both modes stop managed coding
sessions, update the selected runtime components, preserve saved conversation
history, and attempt to reopen saved conversations against the updated
runtime. Reopen is not guaranteed; inspect the report and manually reopen or
port a saved session when necessary. Every update mode refuses before
mutation if an open coding-agent pane is known to be host-managed or its
ownership cannot be established. It reports the pane identity and reason. A
known host-managed process is preserved and left running; unknown ownership is
not proof that a process is still running, and the updater fails closed without
trying to interrupt or migrate it. Moving known host-managed work into a soul
requires a separate deliberate migration.

`--all` replaces the web/client and durable runtime. `--durable-only` leaves
the existing web executable, client directory, and callback peer selected; it
updates the supervisor/workload, then restarts the old web process as needed to
restore and verify its callback to the new supervisor. The updater checks the
authenticated runtime API and supervisor installation identity before it
reports success. A generic `/api/health` response or a connected socket alone
is not sufficient.

The updater first checks live ownership and readiness, the effective systemd
graph, persistent runtime resources, and the candidate/current registry schema
versions. It obtains a read-only readiness and pane-ownership census before
building or stopping services, then rechecks ownership after admission drains.
If a host-owned pane appears during artifact preparation, the updater releases
the temporary admission lease, refuses before stopping services, and preserves
the process. Do not terminate or migrate that process as part of an update.

After success, inspect the printed transient unit and run ID, then check the
units and journal from the same host shell:

```bash
systemctl --user status freshell-rust.service freshell-supervisor.service
journalctl --user -u <printed-transient-update-unit> --no-pager
```

Read the matching `~/.freshell/logs/managed-runtime-update-<run-id>.jsonl` for
phase-by-phase evidence, including candidate checks, exact service effects,
readiness identity, reopen results, the reminder, and `update.completed`. Also
query authenticated `/api/runtime/readiness` and `/api/runtime/maintenance/status`
through the updater's intended web owner when diagnosing readiness. Use the
recorded auth token only through the host's normal protected credential path.

If an update fails or only partly completes, preserve the registry, provider
and history stores, runtime data, workspace, installed binaries, and log. Use
the failure phase and service state to recover forward; do not assume artifacts
were rolled back. Verify whether the old web process is alive before reopening
host-agent admission. Use the runbook's matching old-schema backup only for a
separately authorized restore that will not discard later writes or user
intent. Never delete runtime or registry state to clear an update failure.

The existing schema migration and verified-backup procedures remain in
[Managed runtime rollout](managed-runtime-rollout.md#upgrade-an-existing-installation-while-preserving-stores).
## Launch the native Windows client

Run this in a native Windows PowerShell terminal:

```powershell
$exe = "$env:LOCALAPPDATA\Programs\Freshell\Freshell.exe"
$profile = "$env:APPDATA\freshell-<server-id>"
Start-Process -FilePath $exe -ArgumentList "--user-data-dir=$profile"
```

Use a different `<server-id>` for each client whose Electron state should be
separate. The `--user-data-dir` argument selects the Electron/Chromium profile;
it does not select the Freshell server. The current desktop connection target
and token are shared outside that profile in
`%USERPROFILE%\.freshell\desktop.json`. Select or configure the target in
Freshell when prompted and verify that the client connected to the intended
server. Do not put tokens in the launch command.

## Verify the instance

Confirm that:

1. `GET /api/health` returns successfully on the server.
2. The native Windows Freshell window is visible.
3. The client is connected to the intended server, especially when more than
   one server is in use.
