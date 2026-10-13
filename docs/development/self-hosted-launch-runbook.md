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

If the health check fails, start the server with the canonical launcher:

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

## Redeploy managed runtime (build, units, restart effects)

The managed runtime spans THREE binaries, one opt-in feature flag, and two
systemd user units. A server-only rebuild or restart is NOT enough to change
soul behavior — and a plain rebuild silently loses it.

**Build surface.** Build all three from the repo root when any of them
changes:

```bash
cargo build --release -p freshell-server -p freshell-supervisor \
  -p freshell-session-host --features freshell-server/managed-runtime-v1
```

- The server's soul controller is strictly opt-in (`default = []` in
  `crates/freshell-server/Cargo.toml`). Setting `FRESHELL_MANAGED_RUNTIME_V1=1`
  in the unit enables nothing by itself — the env var only arms a binary that
  was compiled with the feature. A server built without it serves fresh panes
  on the HOST (no soul isolation) and answers `404` on `/api/runtime/*`.
- The SUPERVISOR creates and owns soul containers (`freshell-supervisor
  serve ...`); the home mount, masks, and the `--operator-home` flag live
  there. It must match the server's expectations, so redeploy it together
  with the server.
- The SESSION HOST binary is injected into every NEW soul at container
  creation (the supervisor's `--host-binary` argument). New souls pick the
  new binary automatically; running souls keep the one they were created
  with until their next incarnation.

**Units and restart coupling.** With the systemd topology
(`installers/systemd/freshell-rust.service` + its `managed-runtime.conf`
drop-in, plus `freshell-supervisor.service`):

- `freshell-rust.service` has `Requires=` + `After=` on
  `freshell-supervisor.service`. Restarting the SUPERVISOR therefore also
  restarts the server in the same transaction — one
  `systemctl --user restart freshell-supervisor.service` redeploys both.
- Restarting the server alone (`systemctl --user restart
  freshell-rust.service`) leaves the supervisor running. Use this for
  server-only changes.
- Restarting the production server always requires the user's explicit
  approval (`APPROVED`), including the coupled bounce above.

**What a restart does:**

- **Existing souls keep running.** Soul containers are owned by the Docker
  daemon and tracked by the supervisor's durable registry, not by the server
  process. After the restart, soul-backed panes reattach on the next client
  connect; the supervisor re-verifies each running container against its
  persisted creation-time state, so pre-restart souls pass with no
  migration. Souls keep the mounts they were created with (running souls
  gain the operator-home mount only at their next incarnation).
- **Non-soul terminals end.** Host terminals (shell panes and host-run CLI
  panes) are child processes of the server, so a restart terminates them.
  Their panes rehydrate as exited terminals; resume those conversations
  through the CLI's own durable storage (`claude --resume`,
  `codex resume`, opencode's session picker), not through Freshell.

**Post-deploy verification checklist:**

1. Health: `curl -fsS http://127.0.0.1:3001/api/health` → `"ready": true`.
2. Feature present: with the auth token,
   `GET /api/runtime/readiness` answers `200`. A `404` means the running
   binary was built WITHOUT the feature — rebuild with the command above
   and restart again.
3. Units: `systemctl --user is-active freshell-rust.service
   freshell-supervisor.service` → both `active`.
4. Existing souls: `docker ps --filter name=incarnation` shows the same
   containers with unchanged uptimes. A NEW container may appear within
   seconds of the restart — that is a client reconnecting and a durable
   terminal pane reattaching, not an old soul being replaced; the
   pre-restart containers must keep their uptimes.
5. New-soul probe: create a terminal pane in a real workspace and confirm a
   NEW `freshell-incarnation-*` container appears (`docker ps`), that it
   carries the operator-home bind and the
   `FRESHELL_OPERATOR_HOME_MOUNT=1` marker env (`docker inspect`), and that
   its session host emitted one `operator_home_readiness` event
   (`docker exec <container> cat /run/freshell/host-lifecycle.jsonl`). Close
   the probe pane afterward; its container is collected by the idle
   reaper after the idle timeout, not immediately on close.

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
