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
curl -fsS --connect-timeout 5 --max-time 10 http://127.0.0.1:3001/api/health
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

**Establish the deployment checkout FIRST.** The units run binaries from
THEIR configured paths — not from whatever directory you happen to be
in. Read them (`systemctl --user show freshell-rust.service -p
WorkingDirectory --value` and the supervisor unit's `ExecStart` path,
typically `%h/code/freshell`), and run the build from THAT checkout.
Artifacts built anywhere else (a dev worktree, a scratch clone) are
never started by the units — a mistake you would otherwise discover only
after restarting production.

**Build surface.** Build all three binaries from the deployment checkout
when any of them changes:

```bash
cargo build --release -p freshell-server -p freshell-supervisor \
  -p freshell-session-host --features freshell-server/managed-runtime-v1
```

**Preliminary: capture the baseline.** Capture two snapshots into a
private per-run directory (in the QUICK sequence, re-run this block
AFTER the build and immediately before the restart, so souls created
during the build are baselined; in the STRICT sequence, run it before
the stop) (fixed `/tmp`
paths would let a second run overwrite the first run's baseline before
its comparison): the RUNNING containers (their IDs and exact start
times) and the DESIRED-RUNNING soul IDs — the supervisor reconciles
every desired-running soul, including ones with no running container, so
that second list is what sizes the strict-sequence wait and the
post-deploy soul sweep:

```bash
set -euo pipefail
# REUSE $RUN when re-running this block in the same shell (the QUICK
# sequence re-captures after the build): a fresh mktemp would orphan the
# first directory, and the exit trap only scrubs the CURRENT run's
# header — an orphaned header is a leaked full-scope token:
RUN=${RUN:-$(mktemp -d)}   # private per-run dir for the survival snapshots
# Pin the Docker CLI to the SAME daemon socket the supervisor's unit
# actually names (its --docker-socket argument, with systemd specifiers
# %t = the user runtime dir and %h = the home expanded) — a site-specific
# unit may point elsewhere, and a machine with a second Docker daemon
# would otherwise capture against the wrong one, passing the survival
# check vacuously. DOCKER_CONTEXT must go too — it precedes DOCKER_HOST:
unset DOCKER_CONTEXT || true
# Extract flag values with a lookbehind that accepts BOTH the
# `--flag value` and `--flag=value` forms (splitting on spaces would
# separate the flag from its value and yield empty matches):
UNIT_CAT=$(systemctl --user cat freshell-supervisor.service)
DSOCK=$(grep -oP '(?<=--docker-socket[= ])\S+' <<<"$UNIT_CAT" | tail -1)   # tail: a drop-in that resets ExecStart comes LAST in cat output
DSOCK=${DSOCK//%t/${XDG_RUNTIME_DIR:-/run/user/$(id -u)}}
DSOCK=${DSOCK//%h/$HOME}
DSOCK=${DSOCK:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock}
export DOCKER_HOST="unix://$DSOCK"
# Same for the registry root the soul inventory reads (used below):
REGROOT=$(grep -oP '(?<=--registry-root[= ])\S+' <<<"$UNIT_CAT" | tail -1)   # tail: drop-in resets win
REGROOT=${REGROOT//%t/${XDG_RUNTIME_DIR:-/run/user/$(id -u)}}
REGROOT=${REGROOT//%h/$HOME}
REGROOT=${REGROOT:-$HOME/.freshell/managed-runtime/registry}
# Scope the capture to THIS installation: the daemon may host containers
# from other Freshell installations with the same name shape, and the
# installation label is the only discriminator:
INSTALL_ID=$(sqlite3 "$REGROOT/runtime.sqlite3" \
  "select installation_id from installation")
test -n "$INSTALL_ID" || { echo "cannot read installation id from the registry"; exit 1; }
echo "$INSTALL_ID" > "$RUN/installation-id"
docker ps -q --filter name=incarnation \
  --filter label=com.freshell.installation-id="$INSTALL_ID" \
  | xargs -r docker inspect \
  --format '{{.Id}} {{.Name}} {{.State.StartedAt}}' | sort | tee "$RUN/souls-before.txt"
CHECKOUT=$(systemctl --user show freshell-rust.service -p WorkingDirectory --value)
# The server may be DEAD at this point (this procedure is also the
# recovery path for a dead managed server): MainPID=0 then, and reading
# /proc/0/environ would abort under set -e — guard it:
SPID=$(systemctl --user show freshell-rust.service -p MainPID --value)
TOK=""
if [ "${SPID:-0}" -gt 0 ] 2>/dev/null; then
  TOK=$(tr '\0' '\n' < "/proc/$SPID/environ" | sed -n 's/^AUTH_TOKEN=//p' || true)
fi
if [ -z "$TOK" ]; then
  TOK=$(python3 - "$CHECKOUT/.env" <<'PY'
import os,re,sys
path=sys.argv[1]
if not os.path.exists(path): sys.exit(0)   # no .env — token comes from
                                           # the unit's EnvironmentFile
last=None
for line in open(path):
    m=re.match(r'^\s*(?:export\s+)?AUTH_TOKEN\s*=\s*(.*)$', line.rstrip("\n"))
    if m: last=m.group(1)
if last is None: sys.exit(0)
if last[:1] in ('"',"'"):
    end=last.find(last[0],1)
    print(last[1:end] if end>0 else last[1:])
else:
    print(re.split(r'\s#', last.strip(), 1)[0].strip())
PY
)
fi
umask 077
if [ -n "$TOK" ]; then
  printf 'x-auth-token: %s\n' "$TOK" > "$RUN/hdr"
else
  # Dead server + token only in the unit's EnvironmentFiles: DEFER token
  # acquisition to step 5 (the server is alive by then) rather than
  # aborting — the API-less capture below still records the containers:
  echo "AUTH_TOKEN unresolvable while the server is down — container-count capture only; step 5 re-acquires the token" >&2
  : > "$RUN/desired-running.txt"
fi
trap 'rm -f "${RUN:-/nonexistent}/hdr"' EXIT   # ${RUN:-} survives set -u
if [ -f "$RUN/hdr" ] && curl -s --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' -H @"$RUN/hdr" \
     http://127.0.0.1:3001/api/runtime/readiness | grep -q 200; then
  curl -s --connect-timeout 5 --max-time 10 -H @"$RUN/hdr" http://127.0.0.1:3001/api/runtime/souls \
    | python3 -c 'import json,sys
souls=json.load(sys.stdin)["souls"]
for s in souls:
    if s.get("desiredState")=="running":
        print(s["soulId"])' > "$RUN/desired-running.txt"
else
  # API unavailable (featureless or stopped server) — but the supervisor's
  # REGISTRY is readable directly, and it is the authority on desired
  # state. Read the baseline from sqlite so a desired-running soul with
  # no running container is not invisible to every later check:
  sqlite3 "$REGROOT/runtime.sqlite3" \
    "select soul_id from souls where desired_state='running'" \
    > "$RUN/desired-running.txt" 2>/dev/null \
    || { echo "cannot read the registry sqlite — locate desired-running souls manually"; exit 1; }
  echo "runtime API unavailable — desired-running baseline read from the registry sqlite ($(wc -l < "$RUN/desired-running.txt") souls)" >&2
fi
```

An empty container snapshot is VALID (zero running souls); an empty
`desired-running.txt` from the API-less fallback only narrows the
strict-sequence estimate (see below).

Sequence the build and restart deliberately: the build rewrites
`target/release/freshell-session-host` in place, and the running supervisor
bind-mounts that path into every NEW soul — so a soul created between the
build and the restart runs the new session host against the old supervisor
and server. Run the whole procedure from a shell OUTSIDE the server's
process tree (for example an SSH session to the host) — a host-side
Freshell terminal pane is itself killed by the restart, which would abort
the procedure mid-way and leave the service down. Two sequences:

- Quick (compatible changes): build, then RE-CAPTURE the baseline block
  immediately before the restart (souls created during the build are
  otherwise unbaselined and their loss goes undetected), then restart.
  The short skew window is accepted.
- Strict (changes that must never skew): re-run the baseline capture
  block IMMEDIATELY before the stop command below (a soul created
  between an earlier capture and the stop would be unbaselined; the
  next command being the stop makes that window effectively nil), then
  `systemctl --user stop freshell-supervisor.service` (the server stops with it via the
  `Requires=` coupling), THEN run the build command from the Build
  surface above — never before the stop, or the running supervisor
  picks up the new session host mid-flight (the exact skew this
  sequence exists to prevent) — then start in socket order: start BOTH units —
  `Requires=` pulls the supervisor in when the server starts, but starting
  the supervisor alone does not start its dependent server, so starting
  only the supervisor would leave the web server down. The supervisor
  unit is `Type=simple`, so systemd considers it "started" BEFORE its
  control socket exists (the socket binds after startup reconciliation);
  the server needs that socket. After starting the supervisor, wait for
  the socket before relying on the server, or start the server in a
  second command once the socket is live:

  ```bash
  systemctl --user start freshell-supervisor.service
  # The control socket path comes from the INSTALLED unit (a
  # site-specific --control-socket must not defeat this wait):
  SOCK=$(grep -oP '(?<=--control-socket[= ])\S+' \
    <(systemctl --user cat freshell-supervisor.service) | tail -1)   # tail: a drop-in that resets ExecStart comes LAST
  SOCK=${SOCK//%t/${XDG_RUNTIME_DIR:-/run/user/$(id -u)}}
  SOCK=${SOCK//%h/$HOME}
  SOCK=${SOCK:-$HOME/.freshell/managed-runtime/control/supervisor.sock}
  # Two failure detectors: supervisor-unit LIVENESS (fast — a dead unit
  # ends the wait immediately) and an inventory-sized absolute CAP
  # (stall — a live-but-wedged process must not hang the redeploy
  # forever). Read the EFFECTIVE concurrency in systemd's own precedence
  # order — the user manager's inherited environment first, then the
  # unit's Environment= lines, then its EnvironmentFile= values (systemd
  # applies the FILE later, so it WINS) — then mirror the supervisor's
  # own 1..16 clamp (0 or garbage become 1/defaults, never a division
  # by zero). Worst case is N * 900s / C, doubled for margin, floored at
  # an hour; extreme configs can override the env var. The if-forms are
  # load-bearing under set -e: an `&&`-short-circuit as the loop's last
  # command would make the LOOP return 1 and abort the whole sequence:
  C=""
  V=$(systemctl --user show-environment 2>/dev/null \
        | sed -n 's/^FRESHELL_RUNTIME_STARTUP_CONCURRENCY=//p' | tail -1)
  if [ -n "$V" ]; then C="$V"; fi
  V=$(systemctl --user show freshell-supervisor.service -p Environment --value 2>/dev/null \
        | tr ' ' '\n' | sed -n 's/^FRESHELL_RUNTIME_STARTUP_CONCURRENCY=//p' | tail -1)
  if [ -n "$V" ]; then C="$V"; fi
  for EF in $(systemctl --user show freshell-supervisor.service \
                -p EnvironmentFiles --value | tr ' ' '\n' \
                | sed 's/(.*//' | grep -v '^$'); do
    V=$(sed -n 's/^FRESHELL_RUNTIME_STARTUP_CONCURRENCY=//p' "$EF" 2>/dev/null | tail -1)
    if [ -n "$V" ]; then C="$V"; fi
  done
  # Systemd EnvironmentFile values may be QUOTED ("1"), and bash
  # arithmetic treats leading zeroes as OCTAL (08 is an error) — strip
  # quotes, validate digits, then force base 10:
  case "$C" in
    \"*\") C=${C#\"}; C=${C%\"} ;;
    \'*\') C=${C#\'}; C=${C%\'} ;;
  esac
  case "$C" in ''|*[!0-9]*) C=4;; esac   # absent/garbage -> supervisor default
  C=$((10#$C))                            # defeat octal interpretation
  [ "$C" -ge 1 ] 2>/dev/null || C=1      # supervisor clamps to 1..16 — mirror it
  [ "$C" -le 16 ] 2>/dev/null || C=16
  # Count UNIQUE soul IDs: the inventory stores per-incarnation rows, so
  # a raw line count can multiply one soul by its history and inflate the
  # cap uselessly:
  N=$(sort -u "$RUN/desired-running.txt" 2>/dev/null | wc -l || echo 0)
  [ "$N" -gt 0 ] || N=$(wc -l < "$RUN/souls-before.txt" 2>/dev/null || echo 0)
  WC=$(( N * 900 / C * 2 ))
  [ "$WC" -ge 3600 ] || WC=3600
  CAP=${FRESHELL_PROBE_SOCKET_WAIT_SECONDS:-$WC}
  WAITED=0
  while true; do
    # CONNECT-probe, not a file test: a stopped supervisor leaves its old
    # socket FILE on disk, so [ -S ... ] passes on a dead listener:
    if python3 -c 'import socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(1)
try: s.connect(sys.argv[1])
except OSError: sys.exit(1)' "$SOCK" 2>/dev/null; then
      break
    fi
    systemctl --user is-active freshell-supervisor.service >/dev/null \
      || { echo "supervisor unit is not active"; exit 1; }
    [ "$WAITED" -lt "$CAP" ] || {
      echo "supervisor alive but socket not bound after ${WAITED}s — check its journal:"
      journalctl --user -u freshell-supervisor.service -n 30 --no-pager
      echo "if your config legitimately needs longer, raise FRESHELL_PROBE_SOCKET_WAIT_SECONDS"
      exit 1
    }
    WAITED=$((WAITED + 5)); sleep 5
  done
  systemctl --user start freshell-rust.service
  ```

  If the server unit fails its first start in a race window, that is this
  socket ordering, not a bad build — wait for the live socket and start
  it again (repeated immediate failures can also trip the unit's start
  limit). No soul can be created during the build. This is a full outage
  for the duration of the build.

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
  from disk, and only a browser client that negotiates `managedRuntimeV1`
  gets managed terminal panes for panes it creates — so a stale client
  serves its users host-side panes. (The REST probe below is NOT affected:
  `POST /api/tabs` picks managed routing from the server's controller, with
  no WebSocket negotiation involved.) When the client changed (or on a
  fresh checkout), run `pnpm run build:client`; the running server picks
  it up on the next browser hard refresh, with no restart.

**Units and restart coupling.** With the systemd topology
(`installers/systemd/freshell-rust.service` + its `managed-runtime.conf`
drop-in, plus `freshell-supervisor.service`):

- `freshell-rust.service` has `Requires=` + `After=` on
  `freshell-supervisor.service`. Restarting the SUPERVISOR therefore also
  restarts the server in the same transaction — one
  `systemctl --user restart freshell-supervisor.service` redeploys both.
  The shipped unit sets `KillMode=process` (SAFE-11: the server's graceful
  shutdown deliberately RETAINS adopted terminal-pane Codex sidecars, and
  a control-group kill would slaughter them), so unit restarts PRESERVE
  in-flight Codex conversations — but only if the INSTALLED copy carries
  that line. Verify `systemctl --user show freshell-rust -p KillMode`
  reports `process`; an installed copy without it (or explicitly
  `control-group`) must be re-copied from `installers/systemd/` and
  `systemctl --user daemon-reload`d, or unit restarts still terminate
  retained Codex conversations.
  The same `Type=simple` socket race as the strict sequence applies here:
  the server may start before the supervisor rebinds its control socket
  and come up failed; the unit's `Restart=on-failure` retries can then
  trip systemd's start-rate limit, after which a plain `start` is
  REFUSED. If the server unit is not `active` after the coupled bounce:
  connect-probe the socket as in the strict sequence, then
  `systemctl --user reset-failed freshell-rust.service` (clears the
  rate-limit counter) and `systemctl --user start freshell-rust.service`
  once it is live.
- Restarting the server alone (`systemctl --user restart
  freshell-rust.service`) leaves the supervisor running. Use this for
  server-only changes.
- Restarting the production server always requires the user's explicit
  approval (`APPROVED`), including the coupled bounce above.
- When the checked-in unit files or drop-ins under `installers/systemd/`
  changed, DEPLOY THEM TOO — but never blind-copy over the installed
  units: they can carry site-specific settings (this host's installed
  unit sets `PORT=3001` where the checked-in unit says `3002`, plus its
  own `EnvironmentFile` lines). Diff the checked-in file against the
  installed one, port over only the intended changes, verify the effective
  unit (`systemctl --user cat freshell-rust.service
  freshell-supervisor.service`), and run `systemctl --user daemon-reload`
  before restarting — a restart alone runs the previously installed
  configuration.
- The deployed unit's port wins: the checked-in installer unit defaults to
  `PORT=3002`, while this host's installed unit serves `PORT=3001`. The
  commands below use 3001 — substitute the port the deployed unit actually
  sets.
- The soul-inventory baselines were already captured in the preliminary
  step above (`$RUN/souls-before.txt` and `$RUN/desired-running.txt`); the
  post-deploy checks in the checklist compare against those.

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

1. Health: `curl -fsS --connect-timeout 5 --max-time 10 http://127.0.0.1:3001/api/health` → `"ready": true`.
2. Feature present AND scan completed: with the auth token,
   `GET /api/runtime/readiness` answers `200` — a `404` means the running
   binary was built WITHOUT the feature; rebuild with the command above
   and restart again — AND the response's `readiness.initialScanState`
   (the fields are nested under `readiness`) is `"complete"` with an
   empty `readiness.blockedSubsystems` list. This proves the scan
   completed without subsystem errors, NOT that every soul can reattach —
   an individually blocked soul is a per-soul outcome that does not enter
   `blockedSubsystems`, which is why step 4 checks each soul directly.
3. Units: `is-active` with MULTIPLE units succeeds if at least ONE is
   active, so check each separately and assert both outputs are
   `active`:
   `systemctl --user is-active freshell-rust.service` and
   `systemctl --user is-active freshell-supervisor.service` → each
   `active`, and the supervisor's
   control socket
   (`~/.freshell/managed-runtime/control/supervisor.sock`) is LIVE —
   connect-probe it as in the strict sequence, because the supervisor unit
   is `Type=simple` and a stopped supervisor leaves its old socket file
   on disk.
4. Existing souls: capture the post-restart inventory to a SEPARATE file
   in the same private run directory and compare it against the preserved
   baseline — do NOT re-run the pre-restart command as-is, which would
   overwrite the baseline and compare the file against itself:

   ```bash
   docker ps -q --filter name=incarnation \
     --filter label=com.freshell.installation-id="$(cat "$RUN/installation-id")" \
     | xargs -r docker inspect \
     --format '{{.Id}} {{.Name}} {{.State.StartedAt}}' | sort > "$RUN/souls-after.txt"
   LOST=$(comm -23 "$RUN/souls-before.txt" "$RUN/souls-after.txt")
   test -z "$LOST" || { echo "SOULS LOST/RESTARTED:"; echo "$LOST"; exit 1; }
   comm -13 "$RUN/souls-before.txt" "$RUN/souls-after.txt"   # new containers (expected)
   ```

    The `test -z` matters: `comm` exits successfully even when it prints
    missing containers, so `set -e` alone would not enforce the empty
    result. A non-empty `LOST` is a failure — a baseline container is gone
    or was restarted with a new `StartedAt`. The final `comm` lists
    containers that appeared after the restart; on a busy instance that is
    normal (a client reconnect creating a new durable terminal, or another
    client's new pane) — identify which pane or session each one belongs
    to before assuming it is yours or that it is a replacement.
    Then check the souls INDIVIDUALLY, over the DESIRED-RUNNING list from
    the preliminary capture — not just the containers (a desired-running
    soul with no running container at capture time still had to
    reconcile, and it is exactly the kind the container comparison never
    sees):

    ```bash
    # The server is ALIVE now — re-acquire the token (live environment
    # first; the .env dotenv fallback second, because a server that
    # loads its token from the checkout's .env never exposes it in
    # /proc/<pid>/environ) and REWRITE the header: one minted while the
    # server was down may carry a stale .env value the unit's
    # EnvironmentFile actually overrides:
    SPID=$(systemctl --user show freshell-rust.service -p MainPID --value)
    TOK=""
    if [ "${SPID:-0}" -gt 0 ] 2>/dev/null; then
      TOK=$(tr '\0' '\n' < "/proc/$SPID/environ" | sed -n 's/^AUTH_TOKEN=//p' || true)
    fi
    if [ -z "$TOK" ]; then
      TOK=$(python3 - "$(systemctl --user show freshell-rust.service -p WorkingDirectory --value)/.env" <<'PY'
import os,re,sys
path=sys.argv[1]
if not os.path.exists(path): sys.exit(0)
last=None
for line in open(path):
    m=re.match(r'^\s*(?:export\s+)?AUTH_TOKEN\s*=\s*(.*)$', line.rstrip("\n"))
    if m: last=m.group(1)
if last is None: sys.exit(0)
if last[:1] in ('"',"'"):
    end=last.find(last[0],1)
    print(last[1:end] if end>0 else last[1:])
else:
    print(re.split(r'\s#', last.strip(), 1)[0].strip())
PY
)
    fi
    test -n "$TOK" \
      || { echo "AUTH_TOKEN unresolvable even with the server running — extract it manually"; exit 1; }
    umask 077; printf 'x-auth-token: %s\n' "$TOK" > "$RUN/hdr"
    # Fetch the DEPLOYED registry's soul list into a SEPARATE file — the
    # pre-restart baseline must survive, because a soul that DISAPPEARED
    # from the registry is exactly what the sweep must catch (this also
    # fills the API-less fallback's empty baseline — an empty sweep
    # would otherwise pass vacuously):
    curl -s --connect-timeout 5 --max-time 10 -H @"$RUN/hdr" http://127.0.0.1:3001/api/runtime/souls \
      | python3 -c 'import json,sys
souls=json.load(sys.stdin)["souls"]
for s in souls:
    print(s["soulId"], s.get("containerId") or "-", s.get("launchState") or "-")' > "$RUN/souls-all.txt"
    curl -s --connect-timeout 5 --max-time 10 -H @"$RUN/hdr" http://127.0.0.1:3001/api/runtime/souls \
      | python3 -c 'import json,sys
souls=json.load(sys.stdin)["souls"]
for s in souls:
    if s.get("desiredState")=="running":
        print(s["soulId"])' | sort -u > "$RUN/desired-running-after.txt"
    # POSITIVE ownership check for EVERY baseline container: its
    # (soul, container) pair must appear in the deployed registry with a
    # RUNNING incarnation — a registry swap or restore leaves containers
    # running but owned by nothing (or by a historical stopped row):
    while read -r CIDLINE; do
      CID=${CIDLINE%% *}
      [ -n "$CID" ] || continue
      SID=$(docker inspect "$CID" \
        --format '{{index .Config.Labels "com.freshell.soul-id"}}') \
        || { echo "docker inspect failed for baseline container $CID"; exit 1; }
      grep -q "^$SID $CID running$" "$RUN/souls-all.txt" \
        || { echo "ORPHANED container — ($SID, $CID) has no running row in the deployed registry"; exit 1; }
    done < "$RUN/souls-before.txt"
    echo "sweeping $(sort -u "$RUN/desired-running.txt" "$RUN/desired-running-after.txt" | wc -l) desired-running soul(s) (baseline ∪ deployed)"
    sort -u "$RUN/desired-running.txt" "$RUN/desired-running-after.txt" \
      | while read -r SID; do
      [ -n "$SID" ] || continue
      curl -s --connect-timeout 5 --max-time 10 -H @"$RUN/hdr" "http://127.0.0.1:3001/api/runtime/souls/$SID" \
        | python3 -c 'import json,sys
o=json.load(sys.stdin)
s=o.get("soul")
assert s is not None, ("SOUL GONE from the deployed registry", sys.argv[1], o)
ls=s.get("launchState"); rs=s.get("recoveryState")
assert ls=="running" and rs not in ("blocked","lost"), (sys.argv[1], ls, rs)
print("ok:", sys.argv[1])' "$SID"
    done
    ```

    A blocked or lost `recoveryState` can hide behind a `"running"`
    `launchState` — that is why both fields are asserted. Any failure here
    needs the supervisor journal and that soul's record investigated
    before the deploy is called good. A zero-soul sweep is a legitimate
    empty instance — but the printed count makes that visible instead of
    vacuous. The earlier API-less-fallback limitation (no pre-restart
    soul-ID baseline) is now covered positively: the ownership check
    above proves every baseline container has a RUNNING row in the
    DEPLOYED registry, which is what detects a registry swap even without
    a pre-restart baseline.
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
   protects against staleness, not against stopping the wrong soul). Use a
   private per-run directory — two operators (or two windows) running the
   probe concurrently must never share probe files, or one run's cleanup
   can stop the other run's soul:

   ```bash
   set -euo pipefail   # a failed step must halt, not continue half-named
   D=$(mktemp -d)   # private per-run directory
   # Probe workspaces live under a FRESH per-run root directly under the
   # home root (group-traversable after the host prep) — never chmod a
   # pre-existing directory like ~/scratch, which may hold unrelated
   # data; we only ever change permissions of directories this run
   # created:
   PROBE_ROOT=$(mktemp -d ~/freshell-probe.XXXXXX)
   chmod 0770 "$PROBE_ROOT"   # the in-soul provider (65534:0) must
                               # traverse and write what we create
   WS=$(mktemp -d "$PROBE_ROOT/ws.XXXXXX")   # unique probe workspace
   chmod 0770 "$WS"
   CHECKOUT=$(systemctl --user show freshell-rust.service -p WorkingDirectory --value)
   # Token source: the server's INITIAL environment first (exact for
   # unit-supplied tokens), then a fallback parse of the checkout's .env
   # following the server's dotenv rules for the common forms (fully
   # quoted values, quoted-then-comment, unquoted with a
   # whitespace-preceded `#` comment; `v#x` keeps the `#` literally).
    # NOTE: /proc/<pid>/environ does NOT contain variables dotenvy loaded
    # at runtime — that is exactly why the .env fallback exists.
    SPID=$(systemctl --user show freshell-rust.service -p MainPID --value)
    TOK=""
    if [ "${SPID:-0}" -gt 0 ] 2>/dev/null; then
      TOK=$(tr '\0' '\n' < "/proc/$SPID/environ" | sed -n 's/^AUTH_TOKEN=//p' || true)
    fi
    if [ -z "$TOK" ]; then
     TOK=$(python3 - "$CHECKOUT/.env" <<'PY'
import re,sys
last=None
for line in open(sys.argv[1]):
    m=re.match(r'^\s*(?:export\s+)?AUTH_TOKEN\s*=\s*(.*)$', line.rstrip("\n"))
    if m: last=m.group(1)
if last is None: sys.exit(0)
if last[:1] in ('"',"'"):
    end=last.find(last[0],1)
    print(last[1:end] if end>0 else last[1:])
else:
    print(re.split(r'\s#', last.strip(), 1)[0].strip())
PY
)
   fi
   test -n "$TOK" || { echo "AUTH_TOKEN not found — extract it manually"; exit 1; }
   umask 077
   printf 'x-auth-token: %s\n' "$TOK" > "$D/hdr"   # header file, not argv
   # ONE EXIT trap per shell: this REPLACES the preliminary capture's
   # trap, so scrub BOTH token headers here or $RUN/hdr would leak (the
   # ${VAR:-} defaults keep the trap functional under set -u even in a
   # lost-shell recovery where RUN is unset):
   trap 'rm -f "${RUN:-/nonexistent}/hdr" "${D:-/nonexistent}/hdr"' EXIT
    printf 'D=%q\nWS=%q\nCHECKOUT=%q\nPROBE_ROOT=%q\n' "$D" "$WS" "$CHECKOUT" "$PROBE_ROOT" > "$D/run.env"
    # create the probe pane (example); record terminalId from the response:
   curl -s --connect-timeout 5 --max-time 30 -X POST -H @"$D/hdr" -H "Content-Type: application/json" \
     -d '{"mode":"shell","cwd":"'"$WS"'","name":"home-mount probe"}' \
     http://127.0.0.1:3001/api/tabs | tee "$D/probe-tab.json"
   TID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["data"]["terminalId"])' "$D/probe-tab.json")
   SOUL_ID=$(curl -s --connect-timeout 5 --max-time 10 -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls \
     | python3 -c 'import json,sys
souls=json.load(sys.stdin)["souls"]
print(next(s["soulId"] for s in souls if s.get("terminalId")==sys.argv[1]))' "$TID" \
     | tee "$D/probe-soul-id.txt")
   CID=$(docker ps -q --filter label=com.freshell.soul-id=$SOUL_ID)
   ```

   If the unit's environment (not the checkout's `.env`) is what supplies
   the token on your installation, the `/proc` read above already picks
   that up — it reads the server's effective environment, whatever its
   source. The header-file form keeps the token out of process argument
   lists (visible via `/proc/*/cmdline`) and the `trap` scrubs it on
   every exit path. This direct form is a deliberate, one-off exception
   for a human operator at the host console; it uses the full-scope
   checkout token, whereas every routine or agent-driven runtime API call
   must use the scope-limited OneCLI grant instead (see
   [managed-runtime-rollout.md](managed-runtime-rollout.md)).

   Run steps 5-8 in ONE shell session: the private directory `$D`, the
   probe workspace `$WS`, and their records persist between them. If the
   shell is lost or a check aborts under `set -e`, the FILES survive —
   only the variables die. There is deliberately NO shared pointer file to
   reload: a pointer can be overwritten by a concurrent probe run whose
   records are self-consistent, and loading it would stop the wrong soul.
   Recovery is by YOUR unique workspace only — locate it by timestamp
   (`ls -dt ~/freshell-probe.*/ws.*`), pick the one that is yours
   (you know when you ran the probe; inspect the directory if unsure),
   and recover purely from it: the soul whose `terminalCwd` equals that
   workspace IS your probe (workspace uniqueness is the identity proof),
   so apply the same fenced stop to that soul directly, then delete the
   directories by hand. If you cannot identify your workspace with
   certainty, do not stop anything — leave the probe soul running (it is
   inert) rather than risk stopping another run's session.

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
    `~/.config/freshell/managed-runtime.env`.     After a session-host
    redeploy: the probe container's `/runtime/freshell-session-host`
    mount source (`docker inspect $CID --format '{{json .Mounts}}'`) is
    this checkout's `target/release/freshell-session-host`, AND the
    mounted bytes are the built candidate —
    `docker exec $CID sha256sum /runtime/freshell-session-host` equals
    `sha256sum $CHECKOUT/target/release/freshell-session-host` (the mount
    is a bind of the build output, so a soul created after the build runs
    the new bytes; a soul created before it keeps the old inode). On a
    server-only restart the supervisor's process legitimately still runs
    its earlier binary — only compare the units that were actually bounced.
 7. Browser-path check (required on EVERY managed-runtime redeploy — not
    only after a client redeploy: any reconnected client can be stale): the
    REST probe in step 5 deliberately bypasses WebSocket capability
    negotiation, so it can pass while a stale browser client still creates
    host-side panes. Run it BEFORE the cleanup step so the probe records
    and token header still exist. Hard-refresh the web client, create a
    terminal pane FROM THE UI in a fresh unique workspace minted for this
    run — never a reused fixed path, which a stale soul from an earlier
    redeploy could match:

    ```bash
    : "${PROBE_ROOT:=$(mktemp -d ~/freshell-probe.XXXXXX)}"
    # An environment-inherited PROBE_ROOT is only trusted after
    # canonicalization (defeat symlinks — chmod follows them) and the
    # pattern check:
    PROBE_ROOT=$(realpath -e "$PROBE_ROOT") \
      || { echo "PROBE_ROOT: path does not exist"; exit 1; }
    # Pin depth and basename — a case-pattern `*` matches `/` too, so a
    # bare "$HOME"/freshell-probe.* would chmod an inherited nested
    # directory like $HOME/freshell-probe.old/project:
    if [ "$(dirname "$PROBE_ROOT")" = "$HOME" ] \
       && case "$(basename "$PROBE_ROOT")" in freshell-probe.*) true ;; *) false ;; esac; then
      chmod 0770 "$PROBE_ROOT"
    else
      echo "REFUSING: PROBE_ROOT=$PROBE_ROOT is not a freshell-probe run root directly under home"
      exit 1
    fi
    BWS=$(mktemp -d "$PROBE_ROOT/bws.XXXXXX")   # unique per run
    chmod 0770 "$BWS"   # same in-soul-shell access requirement as $WS
    # The server CANONICALIZES the cwd when it stores terminalCwd — a
    # symlinked parent in an allowed root means the raw $BWS spelling
    # never matches the soul record. Match on the canonical form:
    BWS_MATCH=$(realpath -e "$BWS")
    printf 'BWS=%q\nBWS_MATCH=%q\n' "$BWS" "$BWS_MATCH" >> "$D/run.env"
    # The directory picker PERSISTS the chosen path as OpenCode's default
    # cwd (the confirm handler patches settings) — record the current
    # default (VERIFIED read: an error response must not masquerade as
    # an empty saved default):
    SETTINGS_CODE=$(curl -s --connect-timeout 5 --max-time 10 \
      -o "$D/settings.json" -w '%{http_code}' -H @"$D/hdr" \
      http://127.0.0.1:3001/api/settings)
    grep -q '^2' <<<"$SETTINGS_CODE" || { echo "settings read failed (HTTP $SETTINGS_CODE)"; exit 1; }
    python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
assert isinstance(d, dict), "malformed settings response"
d=d.get("data",d)
cc=d.get("codingCli")
assert isinstance(cc, dict), "malformed settings response: no codingCli"
cur=(cc.get("providers") or {}).get("opencode",{}).get("cwd")
print("" if cur is None else cur)' "$D/settings.json" > "$D/old-opencode-cwd.txt"
    rm -f "$D/settings.json"   # the response can carry secrets — do not keep it
    # Hard-refresh the web client, then in the UI: open the pane picker
    # and choose OPENCODE specifically — the only managed-enabled
    # coding-CLI provider in the current release (Claude, Codex, and
    # Amplifier are pending live qualification and the fresh-agent modes
    # are release-disabled, so choosing those fails this check on a
    # correctly deployed client). A plain shell pane will NOT do either:
    # shell panes skip the directory step and always take the default
    # workspace. OpenCode's directory step has a free-text PATH INPUT:
    # type the absolute $BWS path there — but DO NOT CONFIRM YET: the
    # block below snapshots the soul list FIRST, and its prompt tells
    # you when to confirm (a pane created before the snapshot lands in
    # the baseline and the delta assertion would reject a correct
    # deploy). If the picker REJECTS the path (the directory is validated against the
    # `allowedFilePaths` setting — a deployment whose allowed roots
    # exclude $HOME will 403 the probe root), mint the probe root under
    # an allowed root instead and record it so the cleanup guard
    # validates against the RECORDED root:
    SETTINGS_CODE=$(curl -s --connect-timeout 5 --max-time 10 \
      -o "$D/settings.json" -w '%{http_code}' -H @"$D/hdr" \
      http://127.0.0.1:3001/api/settings)
    grep -q '^2' <<<"$SETTINGS_CODE" || { echo "settings read failed (HTTP $SETTINGS_CODE)"; exit 1; }
    ALLOWED=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
assert isinstance(d, dict), "malformed settings response"
d=d.get("data",d)
afp=d.get("allowedFilePaths")
assert afp is None or isinstance(afp, list), "malformed allowedFilePaths"
for r in (afp or []):
    print(r)' "$D/settings.json") || { echo "malformed settings response"; exit 1; }
    rm -f "$D/settings.json"   # the response can carry secrets
    # Is the probe path itself PERMITTED? An allowed entry A permits the
    # probe path when the path starts with A — e.g. allowed=["/home/dan/work"]
    # does NOT permit $HOME/freshell-probe.* even though the entry sits
    # under $HOME; allowed=["/home"] DOES. A grep for "^$HOME" answers
    # the wrong question for both cases:
    # An empty/unset allowedFilePaths means the server permits ALL
    # paths — treat that as allowed, not denied:
    if [ -z "$(printf '%s' "$ALLOWED" | tr -d '[:space:]')" ]; then
      PROBE_PATH_OK=1
    else
    PROBE_PATH_OK=0
    while read -r A; do
      [ -n "$A" ] || continue
      A=${A/#\~/$HOME}   # the server normalizes ~ roots — mirror it
      # Test THIS run's actual $BWS, not a stand-in path: the server's
      # is_path_allowed requires the path to BE the root or sit under it
      # at a / boundary — a bare string prefix would wrongly accept
      # /home/dan/freshell for /home/dan/freshell-probe.x:
      case "$BWS" in
        "$A"|"$A"/*) PROBE_PATH_OK=1; break ;;
      esac
    done <<<"$ALLOWED"
    fi
    if [ "$PROBE_PATH_OK" != 1 ]; then
      # Pick the first USABLE Linux-path root: the server maps
      # Windows-style roots (WSL deployments, e.g. C:\Users\...) to
      # Linux paths itself — a literal such entry would break mktemp:
      FIRST_ALLOWED=""
      while read -r A; do
        A=${A/#\~/$HOME}
        case "$A" in
          /*) FIRST_ALLOWED="$A"; break ;;
        esac
      done <<<"$ALLOWED"
      if [ -z "$FIRST_ALLOWED" ]; then
        # Windows-only allowed lists (WSL): the server maps such roots
        # itself and this script cannot replicate the mapping — ask the
        # operator for the Linux form of one allowed root (visible in
        # the picker) and mint under that:
        read -r -p "Allowed roots are Windows-style; type the LINUX path of one allowed root for the browser probe: " FIRST_ALLOWED
        FIRST_ALLOWED=${FIRST_ALLOWED/#\~/$HOME}
        case "$FIRST_ALLOWED" in
          /*) ;;
          *) echo "not a Linux absolute path — aborting"; exit 1 ;;
        esac
        # Feed the typed path into the creation loop below (it iterates
        # over $ALLOWED):
        ALLOWED="$FIRST_ALLOWED"
      fi
      if [ -n "$FIRST_ALLOWED" ]; then
        # Keep PROBE_ROOT (and the REST probe's WS) where it is — mint a
        # SEPARATE browser root under the first WRITABLE allowed root (a
        # valid list may start with read-only roots):
        BROWSER_ROOT=""
        while read -r A; do
          A=${A/#\~/$HOME}
          case "$A" in
            /*) if BROWSER_ROOT=$(mktemp -d "$A/freshell-probe.XXXXXX" 2>/dev/null); then break; fi ;;
          esac
        done <<<"$ALLOWED"
        if [ -n "$BROWSER_ROOT" ]; then
          chmod 0770 "$BROWSER_ROOT"
          printf 'BROWSER_ROOT=%q\n' "$BROWSER_ROOT" >> "$D/run.env"
          rm -rf "$BWS"
          BWS=$(mktemp -d "$BROWSER_ROOT/bws.XXXXXX")
          chmod 0770 "$BWS"
          # Recompute the canonical match path for the NEW workspace — a
          # stale BWS_MATCH would search for the deleted old one:
          BWS_MATCH=$(realpath -e "$BWS")
          printf 'BWS=%q\nBWS_MATCH=%q\n' "$BWS" "$BWS_MATCH" >> "$D/run.env"
        fi
      fi
    fi
    # Then WAIT (bounded):
    # the confirmation dispatches a UI update, terminal.create goes out
    # from a React effect, and the managed launch is asynchronous — so
    # the soul may not exist the instant you confirm. Poll up to ~120s:
    # Snapshot the soul list BEFORE the pane creation — the check must
    # match a NEW soul (a delta), not any pre-existing one. The snapshot
    # MUST precede the UI step below, or the probe's own soul lands in
    # the baseline and the delta assertion rejects a correctly managed
    # pane:
    SOULS_BEFORE=$(curl -s --connect-timeout 5 --max-time 10 -H @"$D/hdr" \
      http://127.0.0.1:3001/api/runtime/souls \
      | python3 -c 'import json,sys
print(" ".join(x["soulId"] for x in json.load(sys.stdin)["souls"]))')
    # The manual UI step must finish BEFORE the clock starts — create
    # the pane, then press ENTER to start the bounded poll:
    read -r -p "Create the OpenCode pane at $BWS in the hard-refreshed client, then press ENTER to poll: " _
    # Restore the OpenCode default IMMEDIATELY once the picker's async
    # save lands, so other clients cannot inherit BWS as their default
    # during the poll — the confounding window shrinks from minutes to
    # seconds, and cleanup's restore becomes belt-and-braces:
    CUR=""
    for i in $(seq 1 15); do
      SETTINGS_CODE=$(curl -s --connect-timeout 5 --max-time 10 \
        -o "$D/settings.json" -w '%{http_code}' -H @"$D/hdr" \
        http://127.0.0.1:3001/api/settings)
      if grep -q '^2' <<<"$SETTINGS_CODE"; then
        CUR=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
assert isinstance(d, dict), "malformed settings response"
d=d.get("data",d)
cc=d.get("codingCli")
assert isinstance(cc, dict), "malformed settings response: no codingCli"
cur=(cc.get("providers") or {}).get("opencode",{}).get("cwd")
print("" if cur is None else cur)' "$D/settings.json" 2>/dev/null) || { rm -f "$D/settings.json"; sleep 2; continue; }
        rm -f "$D/settings.json"
        if [ "$CUR" = "$BWS" ]; then break; fi
      fi
      sleep 2
    done
    if [ "${CUR:-}" = "$BWS" ] && [ -f "$D/old-opencode-cwd.txt" ]; then
      OLD=$(cat "$D/old-opencode-cwd.txt")
      BODY=$(python3 -c 'import json,sys
old=sys.argv[1] or None
print(json.dumps({"codingCli":{"providers":{"opencode":{"cwd":old}}}}))' "$OLD")
      CODE=$(curl -s --connect-timeout 5 --max-time 30 -o "$D/settings-restore.out" -w '%{http_code}' \
        -X PATCH -H @"$D/hdr" -H "Content-Type: application/json" -d "$BODY" \
        http://127.0.0.1:3001/api/settings)
      grep -q '^2' <<<"$CODE" || echo "early default restore failed (HTTP $CODE) — cleanup will retry"
      rm -f "$D/settings-restore.out"
    fi
    POLL_DEADLINE=$((SECONDS + 120))
    while [ "$SECONDS" -lt "$POLL_DEADLINE" ]; do
      if curl -s --connect-timeout 5 --max-time 10 -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls \
        | python3 -c 'import json,sys
before=set(sys.argv[2].split())
souls=json.load(sys.stdin)["souls"]
rows=[s for s in souls if s.get("terminalCwd")==sys.argv[1] and s["soulId"] not in before]
sids={r["soulId"] for r in rows}
assert len(sids)<=1, ("workspace ambiguous (mint a fresh BWS and retry)", rows)
sys.exit(0 if len(sids)==1 and rows[-1].get("launchState")=="running" else 1)' "$BWS_MATCH" "$SOULS_BEFORE"; then
        echo "UI pane is managed (after $((SECONDS - POLL_DEADLINE + 120))s)"
        break
      fi
      sleep 2
    done
    # Final assert with a clear diagnosis when the wait ran out (the
    # --max-time flags are what make the poll actually bounded):
    curl -s --connect-timeout 5 --max-time 10 -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls \
      | python3 -c 'import json,sys
before=set(sys.argv[2].split())
souls=json.load(sys.stdin)["souls"]
rows=[s for s in souls if s.get("terminalCwd")==sys.argv[1] and s["soulId"] not in before]
sids={r["soulId"] for r in rows}
assert len(sids)<=1, ("workspace ambiguous (mint a fresh BWS and retry)", rows)
assert rows and rows[-1].get("launchState")=="running", \
  "no NEW running managed soul for the UI pane after ~120s — client stale or not negotiating"
print("UI pane is managed:", rows[-1]["soulId"])' "$BWS_MATCH" "$SOULS_BEFORE"
    ```

    If the assertion fails, the client is stale or not negotiating
    `managedRuntimeV1` — rebuild/redeploy the client and hard-refresh
    again. Close the test pane.
    RESIDUAL RISK (documented, not eliminated): the UI does not expose
    the tested pane's terminal ID, so the check identifies the pane by
    workspace + creation-delta, not by exact terminal identity. A
    concurrent client that creates an OpenCode pane in $BWS inside the
    seconds between this client's picker save and the immediate default
    restore could still confound the match. Run this check when no
    other client is likely to create OpenCode panes (the single-operator
    self-hosted norm), and treat any surprise match with suspicion —
    the cleanup confirmations still gate destructive stops.
 8. Probe cleanup (LAST): probe souls are NOT auto-collected — the
    server's idle reaper explicitly skips managed terminals (their
    lifetime is supervisor-owned) and the supervisor has no idle reaper,
    so the containers persist as durable background sessions. To remove
    them, stop each through the fenced runtime API. For the REST probe
    soul, use the records from step 5 — never a soul picked fresh from
    `docker ps` at cleanup time — and RE-VERIFY the identity immediately
    before stopping: `GET /api/runtime/souls/$SOUL_ID` must still report
    the probe's `terminalId` (the one saved in `$D`); if it does not
    match, stop — you are about to stop someone else's session. For the
    browser-check soul, locate it by its unique workspace
    (`terminalCwd == $BWS`) the same way step 7 did.
    Protected runtime API calls go through OneCLI per the rollout
    procedure (its grant is scoped to the server host and `/api/runtime/*`
    and injects `x-auth-token` — see
    [managed-runtime-rollout.md](managed-runtime-rollout.md)); that is the
    policy path for routine and agent-driven calls. The direct form below
    is the same one-off operator-console exception documented in step 5 —
    the same `trap` scrubbing rules apply. The stop is
    intent-revision-guarded, and HTTP 200 alone proves nothing — the
    response's `outcome` must be `verified_empty` (other outcomes such as
    `termination_unconfirmed` or `blocked_ownership` mean the soul is NOT
    confirmed stopped; re-check `GET /api/runtime/souls/$SOUL_ID` and
    retry with the new revision if needed):

    ```bash
    set -euo pipefail   # a failed check must halt BEFORE the stop request
    CHECKOUT=$(systemctl --user show freshell-rust.service -p WorkingDirectory --value)
    if [ -z "${D:-}" ]; then
      # Lost-shell recovery — deliberately NOT pointer-based (a concurrent
      # run's records are self-consistent and would stop the wrong soul).
      # $WS is the identity proof; export it from YOUR workspace listing.
      # If your run included the step-7 browser check, export BWS too —
      # otherwise its soul is reported below but deliberately left
      # running rather than guessed at:
      if [ -z "${WS:-}" ]; then
        ls -dt ~/freshell-probe.*/ws.* 2>/dev/null || true
        ls -dt ~/freshell-probe.*/bws.* 2>/dev/null || true
        echo "export WS=<your probe workspace>, and BWS=<your browser-check workspace> if applicable, then re-run"
        exit 1
      fi
      # DESTRUCTIVE-PATH GUARD: canonicalize and pattern-match BOTH paths
      # against this run's probe layout before any stop request or
      # deletion. A mistaken export pointing at a real workspace (one
      # managed soul in it) would otherwise stop that live session AND
      # rm -rf its project files:
      for V in WS BWS; do
        eval "VAL=\${$V:-}"
        [ -n "$VAL" ] || continue
        VAL=$(realpath -e "$VAL") || { echo "$V: path does not exist"; exit 1; }
        case "$(basename "$(dirname "$VAL")")" in
          freshell-probe.*) printf -v "$V" '%s' "$VAL" ;;
          *) echo "REFUSING: $V=$VAL is not under a freshell-probe run root — resolve manually"; exit 1 ;;
        esac
      done
      D=$(mktemp -d)   # fresh records dir for the recovery run
      RECOVERY_MINTED=1   # exempt from the records check (it is empty BY DESIGN)
    fi
    # Self-healing token header: the trap removed it on the previous exit;
    # recreate it (0600) only when missing, extracting the token exactly
    # as step 5 does (initial environment first, .env dotenv fallback,
    # hard non-empty assert):
    if [ ! -f "$D/hdr" ]; then
      SPID=$(systemctl --user show freshell-rust.service -p MainPID --value)
      TOK=""
      if [ "${SPID:-0}" -gt 0 ] 2>/dev/null; then
        TOK=$(tr '\0' '\n' < "/proc/$SPID/environ" | sed -n 's/^AUTH_TOKEN=//p' || true)
      fi
      if [ -z "$TOK" ]; then
        TOK=$(python3 - "$CHECKOUT/.env" <<'PY'
import re,sys
last=None
for line in open(sys.argv[1]):
    m=re.match(r'^\s*(?:export\s+)?AUTH_TOKEN\s*=\s*(.*)$', line.rstrip("\n"))
    if m: last=m.group(1)
if last is None: sys.exit(0)
if last[:1] in ('"',"'"):
    end=last.find(last[0],1)
    print(last[1:end] if end>0 else last[1:])
else:
    print(re.split(r'\s#', last.strip(), 1)[0].strip())
PY
)
      fi
      test -n "$TOK" || { echo "AUTH_TOKEN not found — extract it manually"; exit 1; }
      umask 077; printf 'x-auth-token: %s\n' "$TOK" > "$D/hdr"
    fi
    trap 'rm -f "${RUN:-/nonexistent}/hdr" "${D:-/nonexistent}/hdr"; [ -n "${SWEEP_DIR:-}" ] && rm -rf "${SWEEP_DIR:-/nonexistent}"' EXIT   # both headers AND any sweep dir minted below (set -u-safe)
    # DESTRUCTIVE-PATH GUARD (both the normal and recovery flows pass
    # through here). Canonicalize every probe path and tie them together:
    # PROBE_ROOT must BE a freshell-probe run root; WS and BWS must be
    # workspaces DIRECTLY UNDER that same root; D must be a mktemp-style
    # records directory carrying this run's probe records. Validating the
    # paths independently would let a mixed-up recovery export stop
    # another run's soul and delete its files:
    GUARD_ROOT=""
    if [ -n "${PROBE_ROOT:-}" ]; then
      PROBE_ROOT=$(realpath -e "$PROBE_ROOT") || { echo "PROBE_ROOT: path does not exist"; exit 1; }
      # Ownership when records exist: the root must be the one THIS run
      # recorded in run.env (which may live under an allowed root other
      # than $HOME); without records (recovery), fall back to the
      # $HOME/freshell-probe.* pattern:
      if [ -f "${D:-/nonexistent}/run.env" ]; then
        RECORDED_ROOT=$(bash -c '. "$1"; printf "%s" "${PROBE_ROOT:-}"' _ "${D:-}/run.env")
        RECORDED_ROOT=${RECORDED_ROOT:+$(realpath -m "$RECORDED_ROOT")}
        if [ -n "$RECORDED_ROOT" ] && [ "$RECORDED_ROOT" != "$PROBE_ROOT" ]; then
          echo "REFUSING: PROBE_ROOT=$PROBE_ROOT is not the root this run recorded ($RECORDED_ROOT)"
          exit 1
        fi
        case "$(basename "$PROBE_ROOT")" in
          freshell-probe.*) GUARD_ROOT="$PROBE_ROOT" ;;
          *) echo "REFUSING: PROBE_ROOT=$PROBE_ROOT is not a freshell-probe run root"; exit 1 ;;
        esac
      else
        case "$PROBE_ROOT" in
          "$HOME"/freshell-probe.*) GUARD_ROOT="$PROBE_ROOT" ;;
          *) echo "REFUSING: PROBE_ROOT=$PROBE_ROOT is not a freshell-probe run root"; exit 1 ;;
        esac
      fi
    fi
    for V in WS BWS; do
      eval "VAL=\${$V:-}"
      [ -n "$VAL" ] || continue
      VAL=$(realpath -e "$VAL") || { echo "$V: path does not exist"; exit 1; }
      PARENT=$(dirname "$VAL")
      if [ -n "${GUARD_ROOT:-}" ]; then
        # Records exist: WS must sit under the recorded PROBE_ROOT and
        # BWS under the recorded BROWSER_ROOT (when the allowed-roots
        # fallback minted one) — per-variable roots, never a shared one:
        if [ -f "${D:-/nonexistent}/run.env" ]; then
          case "$V" in
            WS) WANT_ROOT=$(bash -c '. "$1"; printf "%s" "${PROBE_ROOT:-}"' _ "${D:-}/run.env") ;;
            BWS) WANT_ROOT=$(bash -c '. "$1"; printf "%s" "${BROWSER_ROOT:-${PROBE_ROOT:-}}"' _ "${D:-}/run.env") ;;
          esac
        fi
        WANT_ROOT="${WANT_ROOT:-$GUARD_ROOT}"
        # Canonicalize the recorded root — a symlinked allowed root
        # records uncanonicalized while $VAL above went through realpath:
        [ -n "$WANT_ROOT" ] && WANT_ROOT=$(realpath -m "$WANT_ROOT")
        if [ "$PARENT" != "$WANT_ROOT" ]; then
          echo "REFUSING: $V=$VAL is not under this run's recorded root for it ($WANT_ROOT) — resolve manually"
          exit 1
        fi
      else
      # Recovery (no records): the workspace's parent must BE a
      # freshell-probe root by BASENAME — anchored anywhere (an
      # allowed-roots deployment puts the browser probe outside $HOME).
      # The emptiness check and the interactive confirm below still
      # apply; a real directory named freshell-probe.* is the residual
      # risk the confirm step exists to catch:
      case "$(basename "$PARENT")" in
        freshell-probe.*) ;;
        *) echo "REFUSING: $V=$VAL is not under a freshell-probe run root — resolve manually"; exit 1 ;;
      esac
      fi
      # A NAME pattern is not ownership: a real workspace could sit under
      # a freshell-probe-named directory. Probe workspaces are created
      # EMPTY and stay empty (in-soul provider state lives in the soul
      # volume, not the workspace) — refuse ANY content, dotfiles
      # included, so a mistaken selection holding e.g. only an .env is
      # still caught:
      if [ -n "$(find "$VAL" -mindepth 1 -print -quit 2>/dev/null)" ]; then
        echo "REFUSING: $V=$VAL is not empty — probe workspaces are empty; resolve manually"
        exit 1
      fi
      # Each workspace is validated independently: the records path ties
      # it to its OWN recorded root (PROBE_ROOT for WS, BROWSER_ROOT for
      # BWS); recovery anchors by basename. No cross-variable sharing —
      # the two roots are legitimately different:
      printf -v "$V" '%s' "$VAL"
    done
    if [ -n "${D:-}" ]; then
      case "$D" in
        "${TMPDIR:-/tmp}"/tmp.*) ;;   # mktemp honors $TMPDIR when set
        *) echo "REFUSING: D=$D is not a mktemp records directory"; exit 1 ;;
      esac
      if [ "${RECOVERY_MINTED:-0}" != "1" ]; then
        if [ ! -f "$D/probe-soul-id.txt" ] && [ ! -f "$D/run.env" ]; then
          echo "REFUSING: D=$D carries no probe records — resolve manually"
          exit 1
        fi
        # TIE the records to THIS run's workspace: mixing one run's D (and
        # its self-consistent SOUL_ID/TID) with another run's WS would
        # otherwise stop the old run's soul and delete the new workspace:
        # Source the file to UNESCAPE the %q-encoded values — a raw
        # text read would compare escaped bytes against the real path
        # and false-refuse any path with spaces. BOTH recorded paths are
        # cross-checked, so a mistaken BWS pointing at another empty
        # workspace is refused:
        if [ -f "$D/run.env" ]; then
          if [ -n "${WS:-}" ]; then
            RECORDED_WS=$(bash -c '. "$1"; printf "%s" "${WS:-}"' _ "$D/run.env")
            if [ -n "$RECORDED_WS" ] && [ "$RECORDED_WS" != "$WS" ]; then
              echo "REFUSING: D=$D records workspace $RECORDED_WS, but WS=$WS — mixed runs; resolve manually"
              exit 1
            fi
          fi
          if [ -n "${BWS:-}" ]; then
            RECORDED_BWS=$(bash -c '. "$1"; printf "%s" "${BWS:-}"' _ "$D/run.env")
            if [ -n "$RECORDED_BWS" ] && [ "$RECORDED_BWS" != "$BWS" ]; then
              echo "REFUSING: D=$D records browser workspace $RECORDED_BWS, but BWS=$BWS — mixed runs; resolve manually"
              exit 1
            fi
            RECORDED_BWS_MATCH=$(bash -c '. "$1"; printf "%s" "${BWS_MATCH:-}"' _ "$D/run.env")
            if [ -n "$RECORDED_BWS_MATCH" ]; then
              BWS_MATCH="$RECORDED_BWS_MATCH"
            fi
          fi
        fi
      fi
    fi
    if [ -z "${SOUL_ID:-}" ]; then
      # Recovery mode: derive the probe soul from the unique workspace —
      # no independent terminalId check applies here; WS uniqueness IS
      # the identity proof. (Requires WS; a known $D alone is NOT enough —
      # its records are only trustworthy alongside this shell's own step 5.)
      if [ -z "${WS:-}" ]; then
        ls -dt ~/freshell-probe.*/ws.* 2>/dev/null || true
        ls -dt ~/freshell-probe.*/bws.* 2>/dev/null || true
        echo "export WS=<your probe workspace>, and BWS=<your browser-check workspace> if applicable, then re-run"
        exit 1
      fi
      PROBE=$(curl -s --connect-timeout 5 --max-time 10 -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls \
        | python3 -c 'import json,sys
souls=json.load(sys.stdin)["souls"]
rows=[s for s in souls if s.get("terminalCwd")==sys.argv[1]]
# The grouping is deliberately robust whether the API returns collapsed
# (latest-per-soul) rows or full per-incarnation rows: exactly one SOUL
# per probe workspace, refuse on ambiguity, act on the last matching row:
sids={r["soulId"] for r in rows}
assert len(sids)==1, ("workspace ambiguous — do not stop anything; resolve manually", rows)
s=rows[-1]
print(s["soulId"], s["intentRevision"], s["terminalId"])' "$WS")
      read -r SOUL_ID REV TID <<< "$PROBE"
      # CONFIRM the matched record is really the throwaway probe — the
      # final human check before a destructive stop:
      echo "Recovery matched: soul=$SOUL_ID terminal=$TID workspace=$WS"
      read -r -p "Stop and delete this PROBE soul? Type 'yes' to confirm: " CONFIRM
      [ "$CONFIRM" = "yes" ] || { echo "aborted — nothing stopped, nothing deleted"; exit 1; }
    else
      TID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["data"]["terminalId"])' "$D/probe-tab.json")
      # Identity re-check FIRST; with set -e its failure aborts the block
      # before the revision fetch and the stop request are ever reached:
      curl -s --connect-timeout 5 --max-time 10 -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls/$SOUL_ID \
        | python3 -c 'import json,sys
s=json.load(sys.stdin)["soul"]
assert s.get("terminalId")==sys.argv[1], ("SOUL/PROBE MISMATCH", s)
print("identity ok:", s.get("terminalId"))' "$TID"
      REV=$(curl -s --connect-timeout 5 --max-time 10 -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls/$SOUL_ID \
        | python3 -c 'import json,sys;print(json.load(sys.stdin)["soul"]["intentRevision"])')
    fi
    curl -s --connect-timeout 5 --max-time 30 -X POST -H @"$D/hdr" -H "Content-Type: application/json" \
      -d "{\"requestId\":\"probe-cleanup\",\"expectedIntentRevision\":$REV}" \
      http://127.0.0.1:3001/api/runtime/souls/$SOUL_ID/stop \
      | python3 -c 'import json,sys
o=json.load(sys.stdin)
assert o.get("outcome")=="verified_empty", o
print("stopped:", o["outcome"])'
    # Stop the browser-check soul the same way BEFORE deleting its
    # workspace (closing the pane only detaches; the soul keeps running).
    # Look it up by workspace in ANY launchState — a blocked or exited
    # probe soul still must not be orphaned against a deleted workspace:
    if [ -n "${BWS:-}" ]; then
      # Match the server's canonical spelling (BWS_MATCH from the
      # records; realpath of $BWS in recovery):
      BWS_LOOKUP="${BWS_MATCH:-$(realpath -e "$BWS" 2>/dev/null || printf '%s' "$BWS")}"
      BS=$(curl -s --connect-timeout 5 --max-time 10 -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls \
        | python3 -c 'import json,sys
souls=json.load(sys.stdin)["souls"]
rows=[s for s in souls if s.get("terminalCwd")==sys.argv[1]]
# The grouping is deliberately robust whether the API returns collapsed
# (latest-per-soul) rows or full per-incarnation rows: exactly one SOUL
# per probe workspace, act on the last matching row:
sids={r["soulId"] for r in rows}
assert len(sids)<=1, ("workspace ambiguous — do not stop anything; resolve manually", rows)
if rows:
    s=rows[-1]
    print(s["soulId"], s["intentRevision"], s["launchState"], s.get("containerId") or "-")
else:
    print("")' "$BWS_LOOKUP")
      NO_BROWSER_SOUL=0
      if [ -z "$BS" ]; then
        # Two cases: step 7 FAILED with a diagnosed stale client (no
        # managed soul was ever created — export BROWSER_CHECK_FAILED=1
        # to clean up), or a previously verified soul vanished (an
        # anomaly — refuse):
        if [ "${BROWSER_CHECK_FAILED:-0}" = "1" ]; then
          echo "no managed browser soul (stale-client step 7) — restoring settings and removing the workspace"
          NO_BROWSER_SOUL=1
        else
          { echo "browser-check soul disappeared from the registry before cleanup — investigate before deleting $BWS (or export BROWSER_CHECK_FAILED=1 if step 7 failed with a stale client)"; exit 1; }
        fi
      fi
      read -r BS_ID BS_REV BS_STATE BS_CID <<< "$BS"
      # In recovery (no records tie BWS to this run), confirm the
      # browser soul separately — mixing two runs' empty probe dirs
      # must not stop another run's soul unconfirmed:
      if [ "${RECOVERY_MINTED:-0}" = "1" ] && [ "${NO_BROWSER_SOUL:-0}" != 1 ]; then
        echo "Recovery matched browser soul: $BS_ID state=$BS_STATE workspace=$BWS"
        read -r -p "Stop and delete this BROWSER probe soul too? Type 'yes' to confirm: " BCONFIRM
        [ "$BCONFIRM" = "yes" ] || { echo "browser probe left running — resolve $BWS manually"; exit 1; }
      fi
      if [ "$NO_BROWSER_SOUL" != 1 ]; then
      # An EXITED incarnation can still be desired-running (eligible for
      # recovery) — only a committed stop intent makes it safe to delete
      # the workspace, so require desiredState=="stopped" too:
      BS_DESIRED=$(curl -s --connect-timeout 5 --max-time 10 -H @"$D/hdr" \
        "http://127.0.0.1:3001/api/runtime/souls/$BS_ID" \
        | python3 -c 'import json,sys;print(json.load(sys.stdin)["soul"].get("desiredState") or "")')
      if [ "$BS_CID" = "-" ]; then
        # No container handle (e.g. a prepared replacement incarnation):
        # unresolved intent — refuse rather than report success:
        { echo "browser-check soul has no container but state=$BS_STATE — resolve manually before deleting $BWS"; exit 1; }
      elif [ "$BS_STATE" != "stopped" ] || [ "$BS_DESIRED" != "stopped" ]; then
        curl -s --connect-timeout 5 --max-time 30 -X POST -H @"$D/hdr" -H "Content-Type: application/json" \
          -d "{\"requestId\":\"probe-cleanup\",\"expectedIntentRevision\":$BS_REV}" \
          http://127.0.0.1:3001/api/runtime/souls/$BS_ID/stop \
          | python3 -c 'import json,sys
o=json.load(sys.stdin)
assert o.get("outcome")=="verified_empty", o
print("stopped browser soul:", o["outcome"])'
      fi
      fi
    fi
    # Restore OpenCode's default cwd that the directory step overwrote
    # (only when the browser check ran — $BWS set). Step 7 already
    # restored it once the picker's async save landed; this is the
    # belt-and-braces pass — a save that somehow never landed (or landed
    # after step 7's restore window) still gets corrected here before
    # the workspace goes away. The wait is bounded; a save arriving after
    # BOTH this pass and the post-deletion sweep is the documented
    # residual (Settings shows it):
    if [ -n "${BWS:-}" ]; then
      for i in $(seq 1 15); do
        SETTINGS_CODE=$(curl -s --connect-timeout 5 --max-time 10 \
          -o "$D/settings.json" -w '%{http_code}' -H @"$D/hdr" \
          http://127.0.0.1:3001/api/settings)
        if ! grep -q '^2' <<<"$SETTINGS_CODE"; then sleep 2; continue; fi
        CUR=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
assert isinstance(d, dict), "malformed settings response"
d=d.get("data",d)
cc=d.get("codingCli")
assert isinstance(cc, dict), "malformed settings response: no codingCli"
cur=(cc.get("providers") or {}).get("opencode",{}).get("cwd")
print("" if cur is None else cur)' "$D/settings.json" 2>/dev/null) || { rm -f "$D/settings.json"; sleep 2; continue; }
        rm -f "$D/settings.json"   # may carry secrets
        if [ "$CUR" = "$BWS" ]; then break; fi
        sleep 2
      done
      CUR=${CUR:-}   # every read failing must not trip set -u downstream
      # Branch on what the default settled to — cleanup is NEVER wedged:
      #   $BWS        -> the picker's save landed; the restore below puts
      #                  back the recorded default.
      #   $OLD        -> already the desired value; nothing to do.
      #   anything else -> a NEWER user choice won the race; leave it.
      if [ "$CUR" != "$BWS" ] && [ -f "$D/old-opencode-cwd.txt" ] && [ "$CUR" != "$(cat "$D/old-opencode-cwd.txt")" ]; then
        echo "OpenCode default was changed to a newer value ('$CUR') after the probe — leaving it untouched"
      fi
    fi
    # Then the restore itself — JSON-safe (a path containing
    # quotes/backslashes must not corrupt the request; a null CLEARS a
    # previously-absent default), HTTP-status-checked, and VERIFIED by
    # re-reading it — curl succeeds as a shell command even on a 4xx/5xx:
    if [ -n "${BWS:-}" ] && [ -f "$D/old-opencode-cwd.txt" ]; then
      OLD=$(cat "$D/old-opencode-cwd.txt")
      # Restore ONLY if the setting still points at THIS probe's path —
      # a newer user choice made after our read must not be overwritten:
      SETTINGS_CODE=$(curl -s --connect-timeout 5 --max-time 10 \
        -o "$D/settings.json" -w '%{http_code}' -H @"$D/hdr" \
        http://127.0.0.1:3001/api/settings)
      grep -q '^2' <<<"$SETTINGS_CODE" || { echo "settings read failed (HTTP $SETTINGS_CODE)"; exit 1; }
      CURNOW=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
assert isinstance(d, dict), "malformed settings response"
d=d.get("data",d)
cc=d.get("codingCli")
assert isinstance(cc, dict), "malformed settings response: no codingCli"
cur=(cc.get("providers") or {}).get("opencode",{}).get("cwd")
print("" if cur is None else cur)' "$D/settings.json")
      rm -f "$D/settings.json"   # may carry secrets — remove immediately
      if [ "$CURNOW" != "$BWS" ]; then
        echo "OpenCode default no longer points at the probe path (now '$CURNOW') — leaving the newer value alone"
      else
      BODY=$(python3 -c 'import json,sys
old=sys.argv[1] or None
print(json.dumps({"codingCli":{"providers":{"opencode":{"cwd":old}}}}))' "$OLD")
      CODE=$(curl -s --connect-timeout 5 --max-time 30 -o "$D/settings-restore.out" -w '%{http_code}' -X PATCH \
        -H @"$D/hdr" -H "Content-Type: application/json" -d "$BODY" \
        http://127.0.0.1:3001/api/settings)
      grep -q '^2' <<<"$CODE" \
        || { echo "settings restore failed (HTTP $CODE):"; cat "$D/settings-restore.out"; exit 1; }
      curl -s --connect-timeout 5 --max-time 10 -H @"$D/hdr" http://127.0.0.1:3001/api/settings \
        | python3 -c 'import json,sys
d=json.load(sys.stdin); d=d.get("data",d)
cur=(d.get("codingCli") or {}).get("providers",{}).get("opencode",{}).get("cwd")
cur="" if cur is None else cur
sys.exit(0 if cur==sys.argv[1] else 1)' "$OLD" \
        || { echo "settings restore did not stick (expected OpenCode cwd '$OLD') — fix Settings → Coding CLI → OpenCode manually BEFORE deleting the probe dirs"; exit 1; }
      fi
    elif [ -n "${BWS:-}" ]; then
      # RECOVERY MODE: the original $D (with the saved pre-check default)
      # was lost with the shell, so the original value is unrecoverable.
      # If the current default still points at $BWS, clearing it is the
      # only safe option — otherwise deleting $BWS would leave OpenCode
      # defaulting into a deleted directory (VERIFIED read: an error
      # response must not masquerade as a changed default):
      SETTINGS_CODE=$(curl -s --connect-timeout 5 --max-time 10 \
        -o "$D/settings.json" -w '%{http_code}' -H @"$D/hdr" \
        http://127.0.0.1:3001/api/settings)
      grep -q '^2' <<<"$SETTINGS_CODE" || { echo "settings read failed (HTTP $SETTINGS_CODE)"; exit 1; }
      CUR=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
assert isinstance(d, dict), "malformed settings response"
d=d.get("data",d)
cc=d.get("codingCli")
assert isinstance(cc, dict), "malformed settings response: no codingCli"
cur=(cc.get("providers") or {}).get("opencode",{}).get("cwd")
print("" if cur is None else cur)' "$D/settings.json")
      rm -f "$D/settings.json"   # the response can carry secrets
      if [ "$CUR" = "$BWS" ]; then
        BODY=$(python3 -c 'import json;print(json.dumps({"codingCli":{"providers":{"opencode":{"cwd":None}}}}))')
        CODE=$(curl -s --connect-timeout 5 --max-time 30 -o "$D/settings-clear.out" -w '%{http_code}' -X PATCH \
          -H @"$D/hdr" -H "Content-Type: application/json" -d "$BODY" \
          http://127.0.0.1:3001/api/settings)
        grep -q '^2' <<<"$CODE" || { echo "clearing OpenCode default failed (HTTP $CODE)"; exit 1; }
        echo "NOTE: the pre-check OpenCode default was lost with the lost shell — set your preferred default in Settings → Coding CLI → OpenCode"
      fi
    fi
    # Delete the probe workspaces, and the ROOT only when it holds
    # nothing besides this run's known workspaces — a root with other
    # entries (another workspace, hidden data) is NOT ours to delete:
    rm -rf "$D" "$WS" "${BWS:-}"
    # POST-DELETION SWEEP: the client's settings save is unawaited, so a
    # late landing can set the default to the now-DELETED $BWS after all
    # the pre-restore checks passed. The sweep reads into a FRESH PRIVATE
    # dir (the response can carry secrets; a fixed /tmp path would be
    # shared between concurrent runs and left behind on failure) and
    # needs a live token header — after a lost shell, mint both:
    if [ -n "${BWS:-}" ]; then
      # Bounded post-deletion POLL rather than a single read — the
      # client's save queue can deliver late:
      sleep 3
      SWEEP_DIR=$(mktemp -d)
      umask 077
      HDR="${RUN:-/nonexistent}/hdr"
      if [ ! -f "$HDR" ]; then
        # Re-mint the token with the SAME two-source extraction the rest
        # of the procedure uses — a server that loaded its token from
        # .env never exposes it in /proc:
        SPID=$(systemctl --user show freshell-rust.service -p MainPID --value)
        TOK=""
        if [ "${SPID:-0}" -gt 0 ] 2>/dev/null; then
          TOK=$(tr '\0' '\n' < "/proc/$SPID/environ" | sed -n 's/^AUTH_TOKEN=//p' || true)
        fi
        if [ -z "$TOK" ]; then
          SWEEP_CHECKOUT=$(systemctl --user show freshell-rust.service -p WorkingDirectory --value)
          TOK=$(python3 - "$SWEEP_CHECKOUT/.env" <<'PY'
import os,re,sys
path=sys.argv[1]
if not os.path.exists(path): sys.exit(0)
last=None
for line in open(path):
    m=re.match(r'^\s*(?:export\s+)?AUTH_TOKEN\s*=\s*(.*)$', line.rstrip("\n"))
    if m: last=m.group(1)
if last is None: sys.exit(0)
if last[:1] in ('"',"'"):
    end=last.find(last[0],1)
    print(last[1:end] if end>0 else last[1:])
else:
    print(re.split(r'\s#', last.strip(), 1)[0].strip())
PY
)
        fi
        if [ -n "$TOK" ]; then
          printf 'x-auth-token: %s\n' "$TOK" > "$SWEEP_DIR/hdr"
          HDR="$SWEEP_DIR/hdr"
        fi
      fi
      # The sweep is the LAST verification gate — it fails closed:
      [ -f "$HDR" ] \
        || { echo "sweep cannot run (no token) — check Settings → Coding CLI → OpenCode manually; the default may point at the deleted probe dir"; rm -rf "$SWEEP_DIR"; exit 1; }
      SWEEP_HITS=0; SWEEP_READS_OK=0
      for SWEEP_I in $(seq 1 6); do
        SETTINGS_CODE=$(curl -s --connect-timeout 5 --max-time 10 \
          -o "$SWEEP_DIR/settings.json" -w '%{http_code}' -H @"$HDR" \
          http://127.0.0.1:3001/api/settings) || SETTINGS_CODE=000
        if ! grep -q '^2' <<<"$SETTINGS_CODE"; then sleep 3; continue; fi
        SWEEP_CWD=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1])); d=d.get("data",d)
cc=d.get("codingCli")
assert isinstance(cc, dict), "malformed settings response"
cur=((cc.get("providers") or {}).get("opencode",{}) or {}).get("cwd")
print("" if cur is None else cur)' "$SWEEP_DIR/settings.json") || { sleep 3; continue; }
        SWEEP_READS_OK=$((SWEEP_READS_OK + 1))
        if [ "$SWEEP_CWD" = "$BWS" ]; then SWEEP_HITS=1; break; fi
        sleep 3
      done
      rm -f "$SWEEP_DIR/settings.json"
      # Fail closed: a sweep where EVERY read failed verified nothing:
      [ "$SWEEP_READS_OK" -ge 1 ] \
        || { echo "sweep could not read settings at all — check Settings → Coding CLI → OpenCode manually; the default may point at the deleted probe dir"; rm -rf "$SWEEP_DIR"; exit 1; }
      if [ "$SWEEP_HITS" = 1 ]; then
        BODY=$(python3 -c 'import json;print(json.dumps({"codingCli":{"providers":{"opencode":{"cwd":None}}}}))')
        PATCH_CODE=$(curl -s --connect-timeout 5 --max-time 30 \
          -o "$SWEEP_DIR/patch.out" -w '%{http_code}' -X PATCH -H @"$HDR" \
          -H "Content-Type: application/json" -d "$BODY" \
          http://127.0.0.1:3001/api/settings)
        grep -q '^2' <<<"$PATCH_CODE" \
          || { echo "late-save clear FAILED (HTTP $PATCH_CODE) — clear Settings → Coding CLI → OpenCode manually"; rm -rf "$SWEEP_DIR"; exit 1; }
        echo "NOTE: a late picker save re-pointed OpenCode at the deleted probe dir — cleared; set your default in Settings"
      fi
      rm -rf "$SWEEP_DIR"
    fi
    rm -f "${RUN:-/nonexistent}/hdr" "$D/hdr" 2>/dev/null   # scrub last —
    # the sweep above needed $RUN/hdr; the trap alone only fires at shell
    # EXIT, which is too late in a still-living interactive shell
    if [ -n "${PROBE_ROOT:-}" ]; then
      UNEXPECTED=""
      shopt -s nullglob
      for ENTRY in "$PROBE_ROOT"/* "$PROBE_ROOT"/.[!.]* "$PROBE_ROOT"/..?*; do
        case "$ENTRY" in
          "$WS"|"$BWS") ;;
          *) UNEXPECTED="$UNEXPECTED $ENTRY" ;;
        esac
      done
      shopt -u nullglob
      if [ -z "$UNEXPECTED" ]; then
        rm -rf "$PROBE_ROOT"
      else
        echo "probe root kept — it contains unexpected entries:$UNEXPECTED"
      fi
    fi
    # The allowed-roots fallback's browser root (when this run minted
    # one and it is empty after the workspace deletion):
    if [ -n "${BROWSER_ROOT:-}" ] && [ -d "$BROWSER_ROOT" ] \
       && [ -z "$(find "$BROWSER_ROOT" -mindepth 1 -print -quit 2>/dev/null)" ]; then
      rm -rf "$BROWSER_ROOT"
    fi
    ```

    If the block aborts before `verified_empty`, the token header is
    already gone (the `trap` removed it) while the probe records — the
    soul ID and the tab response — remain in `$D` for the documented
    recheck-and-retry. Settings responses are deleted right after
    each single-read parse; the sweep keeps its response only inside its
    private loop directory and removes it with the directory (responses
    can carry API keys). Delete `$D`, `$WS`, and `$BWS`
    manually once BOTH probe souls are resolved.

   HONEST LIMIT on the settings restore: the settings API has no
   compare-and-swap, so a concurrent writer can still race the
   read-then-PATCH sequence; the procedure narrows the window (re-read
   immediately before patching, verified reads, and the post-deletion
   sweep above) but cannot eliminate a truly concurrent write. The sweep
   catches saves that land during cleanup; a save landing after the
   sweep's read is out of the runbook's hands — Settings shows it.

   Do NOT `docker stop` a probe container directly — the supervisor
   treats an externally stopped container as an unexpected exit and runs
   its automatic recovery path, which may recreate the soul or mark a
   session without a durable resume path as lost. Leaving a probe soul
   running is also fine; it is inert.

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
