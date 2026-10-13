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

**Preliminary: capture the baseline.** Before restarting anything,
capture two snapshots into a private per-run directory (fixed `/tmp`
paths would let a second run overwrite the first run's baseline before
its comparison): the RUNNING containers (their IDs and exact start
times) and the DESIRED-RUNNING soul IDs — the supervisor reconciles
every desired-running soul, including ones with no running container, so
that second list is what sizes the strict-sequence wait and the
post-deploy soul sweep:

```bash
set -euo pipefail
RUN=$(mktemp -d)   # private per-run dir for the survival snapshots
# Pin the Docker CLI to the SAME daemon socket the supervisor uses (its
# unit passes --docker-socket %t/docker.sock, the user runtime dir). A
# machine with a second Docker daemon would otherwise capture against
# the wrong one and the survival check would pass vacuously. DOCKER_CONTEXT
# must go too — it takes precedence over DOCKER_HOST:
unset DOCKER_CONTEXT || true
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"
# Scope the capture to THIS installation: the daemon may host containers
# from other Freshell installations with the same name shape, and the
# installation label is the only discriminator:
INSTALL_ID=$(sqlite3 "$HOME/.freshell/managed-runtime/registry/runtime.sqlite3" \
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
if [ -f "$RUN/hdr" ] && curl -s -o /dev/null -w '%{http_code}' -H @"$RUN/hdr" \
     http://127.0.0.1:3001/api/runtime/readiness | grep -q 200; then
  curl -s -H @"$RUN/hdr" http://127.0.0.1:3001/api/runtime/souls \
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
  sqlite3 "$HOME/.freshell/managed-runtime/registry/runtime.sqlite3" \
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

- Quick (compatible changes): build, then restart immediately, accepting
  the short skew window.
- Strict (changes that must never skew): `systemctl --user stop
  freshell-supervisor.service` (the server stops with it via the `Requires=`
  coupling), build, then start in socket order: start BOTH units —
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
  SOCK="$HOME/.freshell/managed-runtime/control/supervisor.sock"
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
  case "$C" in ''|*[!0-9]*) C=4;; esac   # absent/garbage -> supervisor default
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
  The same `Type=simple` socket race as the strict sequence applies here:
  the server may start before the supervisor rebinds its control socket
  and come up failed. If the server unit is not `active` after the
  coupled bounce, connect-probe the socket as in the strict sequence and
  `systemctl --user start freshell-rust.service` once it is live.
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

1. Health: `curl -fsS http://127.0.0.1:3001/api/health` → `"ready": true`.
2. Feature present AND scan completed: with the auth token,
   `GET /api/runtime/readiness` answers `200` — a `404` means the running
   binary was built WITHOUT the feature; rebuild with the command above
   and restart again — AND the response's `readiness.initialScanState`
   (the fields are nested under `readiness`) is `"complete"` with an
   empty `readiness.blockedSubsystems` list. This proves the scan
   completed without subsystem errors, NOT that every soul can reattach —
   an individually blocked soul is a per-soul outcome that does not enter
   `blockedSubsystems`, which is why step 4 checks each soul directly.
3. Units: `systemctl --user is-active freshell-rust.service
   freshell-supervisor.service` → both `active`, and the supervisor's
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
    curl -s -H @"$RUN/hdr" http://127.0.0.1:3001/api/runtime/souls \
      | python3 -c 'import json,sys
souls=json.load(sys.stdin)["souls"]
for s in souls:
    print(s["soulId"], s.get("containerId") or "-", s.get("launchState") or "-")' > "$RUN/souls-all.txt"
    curl -s -H @"$RUN/hdr" http://127.0.0.1:3001/api/runtime/souls \
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
      curl -s -H @"$RUN/hdr" "http://127.0.0.1:3001/api/runtime/souls/$SID" \
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
    printf 'D=%q\nWS=%q\nCHECKOUT=%q\n' "$D" "$WS" "$CHECKOUT" > "$D/run.env"
    # create the probe pane (example); record terminalId from the response:
   curl -s -X POST -H @"$D/hdr" -H "Content-Type: application/json" \
     -d '{"mode":"shell","cwd":"'"$WS"'","name":"home-mount probe"}' \
     http://127.0.0.1:3001/api/tabs | tee "$D/probe-tab.json"
   TID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["data"]["terminalId"])' "$D/probe-tab.json")
   SOUL_ID=$(curl -s -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls \
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
    chmod 0770 "$PROBE_ROOT"   # only ever chmods a directory this run made
    BWS=$(mktemp -d "$PROBE_ROOT/bws.XXXXXX")   # unique per run
    chmod 0770 "$BWS"   # same in-soul-shell access requirement as $WS
    echo "BWS=$BWS" >> "$D/run.env"
    # The directory picker PERSISTS the chosen path as OpenCode's default
    # cwd (the confirm handler patches settings) — record the current
    # default so step 8 can restore it:
    curl -s -H @"$D/hdr" http://127.0.0.1:3001/api/settings \
      | python3 -c 'import json,sys
d=json.load(sys.stdin)
d=d.get("data",d)
print((d.get("codingCli") or {}).get("providers",{}).get("opencode",{}).get("cwd") or "")' \
      > "$D/old-opencode-cwd.txt"
    # Hard-refresh the web client, then in the UI: open the pane picker
    # and choose OPENCODE specifically — the only managed-enabled
    # coding-CLI provider in the current release (Claude, Codex, and
    # Amplifier are pending live qualification and the fresh-agent modes
    # are release-disabled, so choosing those fails this check on a
    # correctly deployed client). A plain shell pane will NOT do either:
    # shell panes skip the directory step and always take the default
    # workspace. OpenCode's directory step has a free-text PATH INPUT:
    # type the absolute $BWS path there and confirm. Then:
    curl -s -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls \
      | python3 -c 'import json,sys
souls=json.load(sys.stdin)["souls"]
rows=[s for s in souls if s.get("terminalCwd")==sys.argv[1]]
# The registry stores one row per incarnation (the API collapses to the
# latest row per soul in the current server). The grouping below is
# deliberately robust under EITHER shape: exactly one SOUL must match
# the probe workspace; refuse on ambiguity and act on the last matching
# row:
sids={r["soulId"] for r in rows}
assert len(sids)==1, ("workspace ambiguous (mint a fresh BWS and retry)", rows)
cur=rows[-1]
assert cur.get("launchState")=="running", "soul not running — client took the host-side route?"
print("UI pane is managed:", cur["soulId"])' "$BWS"
    ```

    If the assertion fails, the client is stale or not negotiating
    `managedRuntimeV1` — rebuild/redeploy the client and hard-refresh
    again. Close the test pane.
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
      D=$(mktemp -d)   # fresh records dir for the recovery run
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
    trap 'rm -f "${RUN:-/nonexistent}/hdr" "${D:-/nonexistent}/hdr"' EXIT   # BOTH headers, every exit path, set -u-safe
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
      PROBE=$(curl -s -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls \
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
    else
      TID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["data"]["terminalId"])' "$D/probe-tab.json")
      # Identity re-check FIRST; with set -e its failure aborts the block
      # before the revision fetch and the stop request are ever reached:
      curl -s -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls/$SOUL_ID \
        | python3 -c 'import json,sys
s=json.load(sys.stdin)["soul"]
assert s.get("terminalId")==sys.argv[1], ("SOUL/PROBE MISMATCH", s)
print("identity ok:", s.get("terminalId"))' "$TID"
      REV=$(curl -s -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls/$SOUL_ID \
        | python3 -c 'import json,sys;print(json.load(sys.stdin)["soul"]["intentRevision"])')
    fi
    curl -s -X POST -H @"$D/hdr" -H "Content-Type: application/json" \
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
      BS=$(curl -s -H @"$D/hdr" http://127.0.0.1:3001/api/runtime/souls \
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
    print("")' "$BWS")
      if [ -z "$BS" ]; then
        # Step 7 VERIFIED a running soul in this workspace; a row that
        # vanished since is an anomaly, not success — do not delete the
        # workspace while the soul's intent is unresolved:
        { echo "browser-check soul disappeared from the registry before cleanup — investigate before deleting $BWS"; exit 1; }
      fi
      read -r BS_ID BS_REV BS_STATE BS_CID <<< "$BS"
      if [ "$BS_CID" = "-" ]; then
        # No container handle (e.g. a prepared replacement incarnation):
        # unresolved intent — refuse rather than report success:
        { echo "browser-check soul has no container but state=$BS_STATE — resolve manually before deleting $BWS"; exit 1; }
      elif [ "$BS_STATE" != "stopped" ]; then
          curl -s -X POST -H @"$D/hdr" -H "Content-Type: application/json" \
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
    # (only when the browser check ran — $BWS set):
    if [ -n "${BWS:-}" ] && [ -f "$D/old-opencode-cwd.txt" ]; then
      OLD=$(cat "$D/old-opencode-cwd.txt")
      if [ -n "$OLD" ]; then
        curl -s -X PATCH -H @"$D/hdr" -H "Content-Type: application/json" \
          -d '{"codingCli":{"providers":{"opencode":{"cwd":"'"$OLD"'"}}}}' \
          http://127.0.0.1:3001/api/settings > /dev/null
      else
        echo "OpenCode had no default cwd — clear the probe path in Settings → Coding CLI → OpenCode"
      fi
    fi
    rm -rf "$D" "${PROBE_ROOT:-}" "$WS" "${BWS:-}"   # success only; both
    # token headers were already scrubbed by the trap
    ```

    If the block aborts before `verified_empty`, the token header is
    already gone (the `trap` removed it) while the non-secret probe
    records — the soul ID and the tab response — remain in `$D` for the
    documented recheck-and-retry; delete `$D`, `$WS`, and `$BWS`
    manually once BOTH probe souls are resolved.

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
