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

On a managed-runtime instance (systemd topology, see "Redeploy managed
runtime" below), do NOT recover a dead server with
`scripts/launch-rust.sh`: it rebuilds `freshell-server` WITHOUT the
`managed-runtime-v1` feature and would overwrite the feature-enabled
binary, silently reverting the instance to host-side terminals. Use the
redeploy procedure in that section instead.

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

The managed runtime spans three binaries, a pinned workload image, the web
client, one opt-in feature flag, and two systemd user units. A server-only
rebuild or restart is NOT enough to change soul behavior — and a plain
rebuild silently loses it.

**Build surface.** Build all three binaries from the repo root when any of
them changes:

```bash
cargo build --release -p freshell-server -p freshell-supervisor \
  -p freshell-session-host --features freshell-server/managed-runtime-v1
```

Sequence the build and restart deliberately: the build rewrites
`target/release/freshell-session-host` in place, and the running supervisor
bind-mounts that path into every NEW soul — so a soul created between the
build and the restart runs the new session host against the old supervisor
and server. Two sequences:

- Quick (compatible changes): build, then restart immediately, accepting
  the short skew window.
- Strict (changes that must never skew): `systemctl --user stop
  freshell-supervisor.service` (the server stops with it via the `Requires=`
  coupling), build, then `systemctl --user start
  freshell-supervisor.service` — no soul can be created during the build.
  This is a full outage for the duration of the build.

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
- The WORKLOAD IMAGE is a fourth deploy surface: every soul runs the image
  recorded in `~/.config/freshell/managed-runtime.env` as
  `FRESHELL_RUNTIME_IMAGE` (an immutable `sha256:` ID — build it from
  `docker/runtime/Dockerfile` per
  [managed-runtime-rollout.md](managed-runtime-rollout.md)). Rebuilding the
  Rust binaries never updates it. To deploy image changes: build the new
  image, record its `sha256:` ID in that file, and restart
  `freshell-supervisor.service` (the unit reads the file at start). New
  souls use the new image; running souls keep theirs until their next
  incarnation.
- The WEB CLIENT is a fifth deploy surface: the server serves `dist/client`
  from disk, and only a client that negotiates `managedRuntimeV1` can create
  managed terminal panes — so an old client can make the new-soul probe
  unachievable. When the client changed (or on a fresh checkout), run
  `pnpm run build:client`; the running server picks it up on the next
  browser hard refresh, with no restart.

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
- The deployed unit's port wins: the checked-in installer unit defaults to
  `PORT=3002`, while this host's installed unit serves `PORT=3001`. The
  commands below use 3001 — substitute the port the deployed unit actually
  sets.
- Before restarting, capture the soul inventory so the post-deploy checks
  can prove nothing was replaced — record container IDs AND their exact
  start times (`State.StartedAt`, not `docker ps`'s `CreatedAt`, which is
  the creation time and would not reveal a stop-and-restart of the same
  container):

  ```bash
  docker ps -q --filter name=incarnation | xargs docker inspect \
    --format '{{.Id}} {{.Name}} {{.State.StartedAt}}' | tee /tmp/souls-before.txt
  ```

**What a restart does:**

- **Existing souls keep running.** Soul containers are owned by the Docker
  daemon and tracked by the supervisor's durable registry, not by the server
  process. After the restart, soul-backed panes reattach on the next client
  connect; the supervisor re-verifies each running container against its
  persisted creation-time state, so pre-restart souls pass with no
  migration. Souls keep the mounts they were created with (running souls
  gain the operator-home mount only at their next incarnation). With the
  managed runtime live this includes SHELL panes — `shell` mode routes
  through souls, so shells survive the restart and reattach like any other
  soul-backed pane.
- **Host-side terminals and sidecars end — and the client reconciles
  them.** Only processes the server hosts as its own children die with it:
  panes created while the feature was missing (they silently spawned
  host-side), panes from clients that did not negotiate
  `managedRuntimeV1`, host-run CLI panes, and any host-side fresh-agent
  sidecar processes. The process and any unsaved in-flight state are gone,
  but the panes do not sit as exited terminals: on reconnect the client's
  reconcile handshake replaces a lost shell with a fresh terminal
  automatically (shells are stateless by design) and respawns a CLI pane
  with a durable session from the CLI's own storage (`claude --resume`,
  `codex resume`, opencode's session picker are the manual fallbacks when
  there is nothing durable to resume).

**Post-deploy verification checklist:**

1. Health: `curl -fsS http://127.0.0.1:3001/api/health` → `"ready": true`.
2. Feature present: with the auth token,
   `GET /api/runtime/readiness` answers `200`. A `404` means the running
   binary was built WITHOUT the feature — rebuild with the command above
   and restart again.
3. Units: `systemctl --user is-active freshell-rust.service
   freshell-supervisor.service` → both `active`.
4. Existing souls: re-run the pre-restart capture command and compare with
   `/tmp/souls-before.txt` — every captured container ID is still running
   with the SAME `State.StartedAt` (a changed `StartedAt` means the
   container was stopped and restarted; a missing ID means it was lost). A
   container absent from the capture may appear within seconds of the
   restart: that is a client reconnecting and a durable terminal pane
   reattaching, not an old soul being replaced.
 5. New-soul probe: create a terminal pane in a real workspace that is NOT
    the operator home itself (a subdirectory of it is fine) — when the
    workspace equals the operator home, the supervisor deliberately omits
    the separate home bind (the workspace bind already provides it), so the
    checks below do not apply to that launch. TIE THE PROBE TO ITS OWN
    IDENTITY: create the pane through the REST tab API and keep the
    response's `terminalId` — every soul record carries its `terminalId`,
    so the probe's soul is selected by an exact match, immune to
    concurrent soul creation in the same workspace ("the newest container"
    is never a safe selector, and the stop request's revision guard
    protects against staleness, not against stopping the wrong soul):

    ```bash
    CHECKOUT=$(systemctl --user show freshell-rust.service -p WorkingDirectory --value)
    TOK=$(grep -E '^AUTH_TOKEN=' "$CHECKOUT/.env" | cut -d= -f2-)
    # create the probe pane (example); record terminalId from the response:
    curl -s -X POST -H "x-auth-token: $TOK" -H "Content-Type: application/json" \
      -d '{"mode":"shell","cwd":"<a real workspace outside the operator home>","name":"home-mount probe"}' \
      http://127.0.0.1:3001/api/tabs | tee /tmp/probe-tab.json
    TID=$(python3 -c 'import json;print(json.load(open("/tmp/probe-tab.json"))["data"]["terminalId"])')
    SOUL_ID=$(curl -s -H "x-auth-token: $TOK" http://127.0.0.1:3001/api/runtime/souls \
      | python3 -c 'import json,sys
souls=json.load(sys.stdin)["souls"]
print(next(s["soulId"] for s in souls if s.get("terminalId")=="'$TID'"))' \
      | tee /tmp/probe-soul-id.txt)
    CID=$(docker ps -q --filter label=com.freshell.soul-id=$SOUL_ID)
    ```

    If the unit's environment (not the checkout's `.env`) is what supplies
    the token on your installation, read `TOK` from there instead.

    Then confirm the probe container carries the operator-home bind and the
    `FRESHELL_OPERATOR_HOME_MOUNT=1` marker env (`docker inspect`), and that
    its session host emitted an `operator_home_readiness` event
    (`docker exec $CID cat /run/freshell/host-lifecycle.jsonl`) whose
    payload reports `"present":true` and
    `"home_root_traversable_by_child":true` — the event is emitted with its
    findings even when the home is missing or unreadable, so its mere
    presence is NOT proof of readiness. Close the probe pane afterward.
 6. Artifact freshness, per changed surface — timestamps alone don't prove
    the units run the binaries you just built (an installed unit can point
    at another checkout or an older executable, and a cached Cargo build
    does not rewrite unchanged files). Verify content and mounts directly,
    scoped to what this deploy actually changed. After a binary redeploy:
    for each restarted unit, `readlink /proc/$(systemctl --user show <unit>
    -p MainPID --value)/exe` resolves into THIS checkout, and
    `sha256sum $(readlink /proc/<pid>/exe)` equals `sha256sum` of the
    freshly built artifact in this checkout. After an image redeploy: the
    new probe container's image (`docker inspect $CID --format
    '{{.Image}}'`) equals the `sha256:` ID recorded in
    `~/.config/freshell/managed-runtime.env`. After a session-host
    redeploy: the probe container's `/runtime/freshell-session-host`
    mount source (`docker inspect $CID --format '{{json .Mounts}}'`) is
    this checkout's `target/release/freshell-session-host`. On a
    server-only restart the supervisor's process legitimately still runs
    its earlier binary — only compare the units that were actually bounced.
 7. Probe cleanup: the probe soul is NOT auto-collected — the server's
    idle reaper explicitly skips managed terminals (their lifetime is
    supervisor-owned) and the supervisor has no idle reaper, so the
    container persists as a durable background session. To remove it
    immediately, stop the soul recorded in step 5 — never a soul picked
    fresh from `docker ps` at cleanup time — through the fenced runtime
    API. Protected runtime API calls go through OneCLI per the rollout
    procedure (its grant is scoped to the server host and `/api/runtime/*`
    and injects `x-auth-token` — see
    [managed-runtime-rollout.md](managed-runtime-rollout.md)); the direct
    form below is the equivalent for an operator holding the checkout's
    token. The stop is intent-revision-guarded, and HTTP 200 alone proves
    nothing — the response's `outcome` must be `verified_empty` (other
    outcomes such as `termination_unconfirmed` or `blocked_ownership` mean
    the soul is NOT confirmed stopped; re-check
    `GET /api/runtime/souls/$SOUL_ID` and retry with the new revision if
    needed):

    ```bash
    TOK=$(grep -E '^AUTH_TOKEN=' "$CHECKOUT/.env" | cut -d= -f2-)
    SOUL_ID=$(cat /tmp/probe-soul-id.txt)
    REV=$(curl -s -H "x-auth-token: $TOK" \
      http://127.0.0.1:3001/api/runtime/souls/$SOUL_ID \
      | python3 -c 'import json,sys;print(json.load(sys.stdin)["soul"]["intentRevision"])')
    curl -s -X POST -H "x-auth-token: $TOK" \
      -H "Content-Type: application/json" \
      -d "{\"requestId\":\"probe-cleanup\",\"expectedIntentRevision\":$REV}" \
      http://127.0.0.1:3001/api/runtime/souls/$SOUL_ID/stop \
      | python3 -c 'import json,sys;
o=json.load(sys.stdin)
assert o.get("outcome")=="verified_empty", o
print("stopped:", o["outcome"])'
    ```

   Do NOT `docker stop` the container directly — the supervisor treats an
   externally stopped container as an unexpected exit and runs its
   automatic recovery path, which may recreate the soul or mark a session
   without a durable resume path as lost. Leaving the probe soul running
   is also fine; it is inert.

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
