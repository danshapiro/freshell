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

Preparing or refreshing the workspace is a normal build step and needs no
approval. **Restarting the live production server is a different operation and
still requires the user's explicit approval (`APPROVED`).**

## Start or verify the server

Run this on the machine that owns the server:

```bash
cd /home/dan/code/freshell
curl -fsS http://127.0.0.1:3001/api/health
```

If the health check fails, inspect the recorded owner's state and logs first;
failure does not establish that the process is stopped. The launcher below is
for a launcher-owned ordinary server or a confirmed inactive new instance.
For managed installations use [Managed-runtime upgrades](#managed-runtime-upgrades)
to preserve the verified feature build and stores. Use systemd for a
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
and leaves a healthy instance running. Restarting
the live port requires explicit approval (`APPROVED`).

The optional systemd user unit (`installers/systemd/freshell-rust.service`)
launches the Rust binary directly — its `ExecStart` is the
`freshell-server` executable, no package manager involved — so it performs
no dependency preparation; prepare the checkout once on that machine as
above, and the service restores the server after restarts.

## Managed-runtime upgrades

For a managed installation, complete the
[preserving-store upgrade procedure](managed-runtime-rollout.md#upgrade-an-existing-installation-while-preserving-stores)
before installation. It requires an isolated old-schema backup/upgrade/readability
drill, current candidate verification, and a consistent verified live backup
**before any candidate registry opener**. A migration preview does not create
that backup. Prepare artifacts away from live binary/client/sidecar paths and
preserve existing registry, control, runtime, provider, session, and configuration
paths. This repair checks ordinary use in the four Codex/OpenCode modes;
Claude live behavior remains unverified by explicit agreement. The backup
drill below applies to a separately requested production upgrade, not to this
repair's acceptance. Committing these instructions does not authorize
production installation.

Record the actual owners, effective units/commands and port before requesting
the separate exact **APPROVED** for installation, necessary backup maintenance,
and restarts. PR creation/landing approval is distinct. Keep prior artifacts,
configuration, and image with the matching verified old-schema backup.

With systemd ownership, use the recorded effective units. After installing the
verified artifacts/settings, restart the supervisor first and verify control
socket/readiness, then restart the server. The supplied unit names are
`freshell-supervisor.service` and `freshell-rust.service`; confirm the actual
units and override the server template's port 3002 to retain live port 3001.
Do not run the launcher against a systemd-owned port.

With launcher ownership, prepare/install the server built with
`freshell-server/managed-runtime-v1`, supervisor/session-host, client, and
sidecar first. Resolve the independently owned supervisor's restart command
and verify its readiness before restarting the server. Only after the approved
backup and installation, run from the recorded server checkout:

```bash
scripts/launch-rust.sh --skip-build --restart --port 3001
```

The default launcher rebuild uses no managed feature; use `--skip-build` to
retain the verified candidate. Even this path checks sidecar prerequisites,
so prepare their locked tree beforehand. Both server opt-ins
`FRESHELL_MANAGED_RUNTIME_V1=1` and `FRESHELL_MANAGED_FRESH_AGENT_V1=1`, control
socket/secret paths, and the supervisor's immutable `FRESHELL_RUNTIME_IMAGE`
must be effective in their actual owners. Do not use qualification overrides
or fixture modes for production. Managed Amplifier/Kilroy stay disabled.

Check health, startup build identity/features, effective image, intended
four-mode admission, structured errors, and preserved inventory/history metadata
without starting or prompting historical sessions. On failure preserve new
state and prefer a compatible fix-forward; an older binary may reject the
upgraded schema. Restoring old state needs a matching verified backup and a
separately approved concrete restore/restart that loses no later writes or
changed user intent.

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
