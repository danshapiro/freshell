#!/usr/bin/env bash
# Launch the Rust freshell server: build client + server, start in background.
#
# This is the canonical launcher for the self-hosted PRODUCTION Rust server
# (default port 3002). See AGENTS.md "Rust Server (Self-Hosted Production)".
#
# Usage:
#   scripts/launch-rust.sh                 # build client + server, start on port 3002
#   scripts/launch-rust.sh --port 3499     # any other port (e.g. testing a branch)
#   scripts/launch-rust.sh --client-only   # rebuild dist/client ONLY (no restart --
#                                          #   the server serves it from disk; just
#                                          #   hard-refresh the browser)
#   scripts/launch-rust.sh --skip-build    # start without rebuilding
#   scripts/launch-rust.sh --restart       # stop the pid-file-verified instance on
#                                          #   this port first, then start
#   scripts/launch-rust.sh --stop          # stop the pid-file-verified instance
#
# DETACHMENT: the server is started in its own session (setsid, stdin from
# /dev/null). Closing the shell/console that ran this script does NOT stop
# the server or its child terminals. Stop it with:
#   scripts/launch-rust.sh --stop [--port N]
# CAVEAT (WSL2): when the LAST console/interop handle into the distro
# closes, Windows shuts the whole WSL VM down (documented behavior) — no
# launcher-side detachment survives that. For unattended operation use the
# systemd user unit (recommended; restores the server at next distro boot):
# see installers/systemd/freshell-rust.service.
#
# SAFETY (per AGENTS.md):
#   * Managed live servers cannot be stopped or restarted here because this
#     launcher does not perform the managed runtime's pane-ownership census.
#   * This script will never kill a process it did not start: it only stops
#     PIDs recorded in its own pid file, and only after verifying the process
#     is this repo's freshell-server binary.
#   * If the port is held by an unknown process, it refuses and tells you.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRESHELL_HOME="${FRESHELL_HOME:-$HOME/.freshell}"

PORT="${PORT:-3002}"
CLIENT_ONLY=0
SKIP_BUILD=0
RESTART=0
STOP_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --client-only) CLIENT_ONLY=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --restart) RESTART=1; shift ;;
    --stop) STOP_ONLY=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

PID_FILE="$FRESHELL_HOME/rust-server-$PORT.pid"
MANAGED_MARKER_FILE="$PID_FILE.managed"
LOG_FILE="$FRESHELL_HOME/logs/rust-server-$PORT.log"
BINARY="$REPO_ROOT/target/release/freshell-server"

cd "$REPO_ROOT"

# --- helpers -----------------------------------------------------------------

# True iff $1 is a live PID that is THIS repo's rust server (never match a
# foreign process -- see AGENTS.md Process Safety).
is_our_server_pid() {
  local pid="$1" cwd="" args=""
  kill -0 "$pid" 2>/dev/null || return 1
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$cwd" == "$REPO_ROOT" && "$args" == *"target/release/freshell-server"* ]]
}

port_in_use() {
  ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT\$"
}

stop_ours() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No pid file at $PID_FILE -- nothing to stop." >&2
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if is_our_server_pid "$pid"; then
    echo "Stopping freshell-server pid $pid (port $PORT)..."
    kill "$pid"
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "Process $pid did not exit after SIGTERM; NOT escalating automatically." >&2
      return 1
    fi
    rm -f "$PID_FILE" "$MANAGED_MARKER_FILE"
  else
    echo "Pid file $PID_FILE is stale (pid $pid is not this repo's server); removing." >&2
    rm -f "$PID_FILE" "$MANAGED_MARKER_FILE"
    return 1
  fi
}

trim_env_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

read_dotenv_value() {
  local wanted="$1" line key value
  [[ -f "$REPO_ROOT/.env" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim_env_value "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" == export[[:space:]]* ]]; then
      line="$(trim_env_value "${line#export}")"
    fi
    [[ "$line" == *=* ]] || continue
    key="$(trim_env_value "${line%%=*}")"
    [[ "$key" == "$wanted" ]] || continue
    value="$(trim_env_value "${line#*=}")"
    if [[ "$value" == \"* || "$value" == \'* ]]; then
      local quote="${value:0:1}"
      value="${value:1}"
      value="${value%%"$quote"*}"
    else
      if [[ "$value" == \#* ]]; then
        value=""
      else
        value="${value%%[[:space:]]#*}"
      fi
      value="$(trim_env_value "$value")"
    fi
    printf '%s' "$value"
    return 0
  done < "$REPO_ROOT/.env"
  return 1
}

if [[ "${FRESHELL_MANAGED_RUNTIME_V1+x}" == x ]]; then
  MANAGED_RUNTIME_REQUESTED="$FRESHELL_MANAGED_RUNTIME_V1"
else
  MANAGED_RUNTIME_REQUESTED="$(read_dotenv_value FRESHELL_MANAGED_RUNTIME_V1 || true)"
fi
DOTENV_MANAGED_RUNTIME="$(read_dotenv_value FRESHELL_MANAGED_RUNTIME_V1 || true)"

if [[ "${AUTH_TOKEN+x}" == x ]]; then
  AUTH_TOKEN_VALUE="$AUTH_TOKEN"
else
  AUTH_TOKEN_VALUE="$(read_dotenv_value AUTH_TOKEN || true)"
fi

process_managed_runtime_state() {
  local pid="$1" proc_env="/proc/$1/environ" env_contents managed_value
  [[ -r "$proc_env" ]] || return 2
  env_contents="$(tr '\0' '\n' < "$proc_env" 2>/dev/null)" || return 2
  managed_value="$(printf '%s\n' "$env_contents" | sed -n 's/^FRESHELL_MANAGED_RUNTIME_V1=//p')"
  if [[ "$env_contents" != *$'\nFRESHELL_MANAGED_RUNTIME_V1='* && "$env_contents" != FRESHELL_MANAGED_RUNTIME_V1=* ]]; then
    return 2
  fi
  [[ "$managed_value" == "1" ]] && return 0
  return 1
}

process_start_identity() {
  awk '{print $22}' "/proc/$1/stat" 2>/dev/null
}

managed_marker_matches_pid() {
  local pid="$1" marker start_identity
  [[ -r "$MANAGED_MARKER_FILE" ]] || return 1
  marker="$(cat "$MANAGED_MARKER_FILE" 2>/dev/null || true)"
  start_identity="$(process_start_identity "$pid" || true)"
  [[ -n "$start_identity" && "$marker" == "managed-runtime-v1:$pid:$start_identity" ]]
}

managed_feature_enabled_in_binary() {
  [[ -x "$BINARY" ]] || return 1
  "$BINARY" --build-info 2>/dev/null | node -e '
    let output = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { output += chunk; });
    process.stdin.on("end", () => {
      try {
        if (JSON.parse(output)?.managedRuntimeV1 !== true) process.exitCode = 1;
      } catch {
        process.exitCode = 1;
      }
    });
  '
}

probe_live_managed_runtime() {
  local token="$AUTH_TOKEN_VALUE" escaped_token response status body
  [[ -n "$token" ]] || return 2
  escaped_token="${token//\\/\\\\}"
  escaped_token="${escaped_token//\"/\\\"}"
  if [[ "$escaped_token" == *$'\n'* || "$escaped_token" == *$'\r'* ]]; then
    return 2
  fi
  response="$(printf 'header = "x-auth-token: %s"\n' "$escaped_token" \
    | curl --silent --show-error --max-time 2 --config - \
      --write-out $'\n__FRESHELL_STATUS__%{http_code}' \
      "http://127.0.0.1:$PORT/api/runtime/readiness" 2>/dev/null)" || return 2
  status="${response##*$'\n__FRESHELL_STATUS__'}"
  body="${response%$'\n__FRESHELL_STATUS__'*}"
  [[ "$status" =~ ^[0-9]{3}$ ]] || return 2
  case "$status" in
    200) return 0 ;;
    404) return 1 ;;
    503)
      if printf '%s' "$body" | node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          try {
            const response = JSON.parse(input);
            if (response?.error !== "Managed runtime unavailable"
              || Object.keys(response).length !== 1) process.exitCode = 1;
          } catch {
            process.exitCode = 1;
          }
        });
      '; then
        return 1
      fi
      return 2
      ;;
    *) return 2 ;;
  esac
}

classify_managed_process() {
  local pid="$1" process_state=2
  managed_marker_matches_pid "$pid" && return 0
  if process_managed_runtime_state "$pid"; then
    process_state=0
  else
    process_state=$?
  fi
  if [[ "$MANAGED_RUNTIME_REQUESTED" == "1" ]]; then
    return 0
  fi
  [[ "$process_state" == 0 ]] && return 0
  if [[ "$process_state" == 1 ]]; then
    return 1
  fi
  [[ "$DOTENV_MANAGED_RUNTIME" == "1" ]] && return 0
  if ! managed_feature_enabled_in_binary; then
    return 1
  fi
  probe_live_managed_runtime
}

refuse_managed_live_action() {
  local action="$1"
  cat >&2 <<EOF
Managed server $action is refused by launch-rust.sh because it bypasses the live pane-ownership check and could interrupt coding work.
For a systemd-owned installation, use the default mode of: pnpm exec tsx scripts/update-managed-runtime.ts
That updater checks host and unknown panes before changing services. A launcher-owned managed server has no safe live maintenance path here; leave it running and use a separate approved recovery procedure.
EOF
  exit 1
}

# The managed updater performs a complete pane census before changing a live
# service. Refuse launcher-owned stop/restart when either the caller requests
# managed mode or the recorded server was launched with it.
if [[ "$STOP_ONLY" == 1 || "$RESTART" == 1 ]] && [[ -f "$PID_FILE" ]]; then
  saved_pid="$(cat "$PID_FILE")"
  if is_our_server_pid "$saved_pid"; then
    managed_process_state=2
    if classify_managed_process "$saved_pid"; then
      managed_process_state=0
    else
      managed_process_state=$?
    fi
    if [[ "$managed_process_state" == 0 ]]; then
      if [[ "$STOP_ONLY" == 1 ]]; then
        refuse_managed_live_action "--stop"
      fi
      refuse_managed_live_action "--restart"
    elif [[ "$managed_process_state" == 2 ]]; then
      echo "Could not verify that the running server is outside managed runtime. Refusing --stop/--restart to preserve agent work." >&2
      echo "For a systemd-owned installation, use the managed runtime updater. For launcher-owned managed services, use a separate approved recovery procedure." >&2
      exit 1
    fi
  fi
fi

# --- stop mode ---------------------------------------------------------------

if [[ "$STOP_ONLY" == 1 ]]; then
  stop_ours
  exit $?
fi

# --- build -------------------------------------------------------------------

if [[ "$SKIP_BUILD" != 1 ]]; then
  echo "Building client (typecheck + vite)..."
  pnpm run typecheck:client
  pnpm run build:client
  if [[ "$CLIENT_ONLY" == 1 ]]; then
    echo ""
    echo "Client rebuilt at dist/client. The running server serves it from disk --"
    echo "hard-refresh the browser to pick it up. No server restart needed."
    exit 0
  fi
  echo "Building Rust server (cargo build --release -p freshell-server)..."
  cargo_args=(build --release -p freshell-server --locked)
  if [[ "$MANAGED_RUNTIME_REQUESTED" == "1" ]]; then
    cargo_args+=(--features managed-runtime-v1)
  fi
  cargo "${cargo_args[@]}"
  if [[ "$MANAGED_RUNTIME_REQUESTED" == "1" ]]; then
    echo "Building supervisor admin client for managed-runtime readiness verification..."
    cargo build --release -p freshell-runtime-client --bin freshell-supervisor-admin --locked
  fi
fi

# --client-only never starts a server, including when combined with
# --skip-build. In that combination there is no client work to perform.
if [[ "$CLIENT_ONLY" == 1 ]]; then
  echo "Client-only mode requested with --skip-build; no server launch."
  exit 0
fi

# The Claude SDK is a sanctioned Node sidecar, not the Freshell server.  Keep
# its locked dependency tree available for every launcher startup, including
# --skip-build runs from a clean checkout.
echo "Preparing Rust runtime prerequisites..."
pnpm run --silent prepare:rust-runtime

[[ -x "$BINARY" ]] || { echo "Missing binary: $BINARY (build first)" >&2; exit 1; }

# A requested managed-runtime launch must use a binary that proves the feature
# was compiled in. This read-only command runs before any existing instance can
# be stopped or any replacement server can be started, including --skip-build.
if [[ "$MANAGED_RUNTIME_REQUESTED" == "1" ]]; then
  if ! "$BINARY" --build-info | node -e '
    let output = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { output += chunk; });
    process.stdin.on("end", () => {
      try {
        const info = JSON.parse(output);
        if (info?.managedRuntimeV1 !== true) process.exitCode = 1;
      } catch {
        process.exitCode = 1;
      }
    });
  '; then
    echo "FRESHELL_MANAGED_RUNTIME_V1=1 requires $BINARY to report managedRuntimeV1=true via --build-info; rebuild with --features managed-runtime-v1." >&2
    exit 1
  fi
fi

if [[ "$MANAGED_RUNTIME_REQUESTED" == "1" ]]; then
  if [[ "${FRESHELL_RUNTIME_CONTROL_SOCKET+x}" == x ]]; then
    RUNTIME_CONTROL_SOCKET="$FRESHELL_RUNTIME_CONTROL_SOCKET"
  else
    RUNTIME_CONTROL_SOCKET="$(read_dotenv_value FRESHELL_RUNTIME_CONTROL_SOCKET || true)"
  fi
  if [[ "${FRESHELL_RUNTIME_CONTROL_SECRET_FILE+x}" == x ]]; then
    RUNTIME_CONTROL_SECRET_FILE="$FRESHELL_RUNTIME_CONTROL_SECRET_FILE"
  else
    RUNTIME_CONTROL_SECRET_FILE="$(read_dotenv_value FRESHELL_RUNTIME_CONTROL_SECRET_FILE || true)"
  fi
  if [[ -z "$RUNTIME_CONTROL_SOCKET" || -z "$RUNTIME_CONTROL_SECRET_FILE" ]]; then
    echo "FRESHELL_MANAGED_RUNTIME_V1=1 requires FRESHELL_RUNTIME_CONTROL_SOCKET and FRESHELL_RUNTIME_CONTROL_SECRET_FILE." >&2
    echo "Set both to the intended supervisor control socket and readable secret file before starting." >&2
    exit 1
  fi
  if [[ ! -r "$RUNTIME_CONTROL_SECRET_FILE" ]]; then
    echo "FRESHELL_MANAGED_RUNTIME_V1=1 requires a readable supervisor secret file at FRESHELL_RUNTIME_CONTROL_SECRET_FILE." >&2
    exit 1
  fi
fi

# --- preflight ---------------------------------------------------------------

# AUTH_TOKEN must be available (env or .env in repo root; the server loads .env
# from its cwd and refuses to start without a token).
if [[ -z "$AUTH_TOKEN_VALUE" ]]; then
  echo "AUTH_TOKEN not set (env or $REPO_ROOT/.env). The server will refuse to start." >&2
  exit 1
fi

ADMIN_CLI="$REPO_ROOT/target/release/freshell-supervisor-admin"
MANAGED_SUPERVISOR_IDENTITY=""
managed_supervisor_identity() {
  local health
  if ! health="$("$ADMIN_CLI" --socket "$RUNTIME_CONTROL_SOCKET" --secret-file "$RUNTIME_CONTROL_SECRET_FILE" health 2>/dev/null)"; then
    return 1
  fi
  printf '%s' "$health" | node -e '
    let output = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { output += chunk; });
    process.stdin.on("end", () => {
      try {
        const health = JSON.parse(output);
        if (health?.state !== "ok" || typeof health.installationId !== "string"
          || !Number.isSafeInteger(health.controlEpoch) || health.controlEpoch < 0) {
          process.exitCode = 1;
          return;
        }
        process.stdout.write(JSON.stringify({ installationId: health.installationId, controlEpoch: health.controlEpoch }));
      } catch {
        process.exitCode = 1;
      }
    });
  '
}

if [[ "$MANAGED_RUNTIME_REQUESTED" == "1" ]]; then
  if [[ ! -x "$ADMIN_CLI" ]]; then
    echo "FRESHELL_MANAGED_RUNTIME_V1=1 requires $ADMIN_CLI to verify the configured supervisor; rebuild with the managed-runtime launcher." >&2
    exit 1
  fi
  if ! MANAGED_SUPERVISOR_IDENTITY="$(managed_supervisor_identity)"; then
    echo "Managed runtime requested, but the configured supervisor control socket did not return a valid authenticated health identity. No server was started." >&2
    exit 1
  fi
fi

# Existing instance on this port?
if [[ -f "$PID_FILE" ]]; then
  saved_pid="$(cat "$PID_FILE")"
  if is_our_server_pid "$saved_pid"; then
    if [[ "$RESTART" == 1 ]]; then
      stop_ours
    else
      echo "freshell-server already running on port $PORT (pid $saved_pid)."
      echo "  URL: http://localhost:$PORT/?token=$AUTH_TOKEN_VALUE"
      echo "  Use --restart to stop and relaunch it."
      exit 0
    fi
  else
    rm -f "$PID_FILE"
  fi
fi

if port_in_use; then
  echo "Port $PORT is in use by a process this script did not start. Refusing." >&2
  echo "(Never kill foreign processes -- see AGENTS.md Process Safety.)" >&2
  exit 1
fi

managed_readiness_summary() {
  local health_before readiness_response http_status readiness_json health_after
  health_before="$(managed_supervisor_identity)" || { echo "supervisor_control_socket_unavailable" >&2; return 1; }
  if [[ "$health_before" != "$MANAGED_SUPERVISOR_IDENTITY" ]]; then
    echo "supervisor_identity_changed_before_runtime_readiness" >&2
    return 3
  fi

  local escaped_token="$AUTH_TOKEN_VALUE"
  escaped_token="${escaped_token//\\/\\\\}"
  escaped_token="${escaped_token//\"/\\\"}"
  if [[ "$escaped_token" == *$'\n'* || "$escaped_token" == *$'\r'* ]]; then
    echo "auth_token_contains_invalid_header_characters" >&2
    return 3
  fi
  if ! readiness_response="$(printf 'header = "x-auth-token: %s"\n' "$escaped_token" \
    | curl --silent --show-error --max-time 2 --config - \
      --write-out $'\n__FRESHELL_STATUS__%{http_code}' \
      "http://127.0.0.1:$PORT/api/runtime/readiness" 2>/dev/null)"; then
    echo "authenticated_runtime_readiness_unavailable" >&2
    return 1
  fi
  http_status="${readiness_response##*$'\n__FRESHELL_STATUS__'}"
  readiness_json="${readiness_response%$'\n__FRESHELL_STATUS__'*}"
  if [[ ! "$http_status" =~ ^[0-9]{3}$ ]]; then
    echo "authenticated_runtime_readiness_http_status_missing" >&2
    return 3
  fi
  if [[ "$http_status" != "200" ]]; then
    echo "authenticated_runtime_readiness_http_$http_status" >&2
    if [[ "$http_status" == "401" || "$http_status" == "403" || "$http_status" == "404" ]]; then
      return 3
    fi
    return 1
  fi

  health_after="$(managed_supervisor_identity)" || { echo "supervisor_control_socket_unavailable_after_readiness" >&2; return 1; }
  if [[ "$health_after" != "$health_before" ]]; then
    echo "supervisor_identity_changed_during_runtime_readiness" >&2
    return 3
  fi
  printf '{"expected":%s,"before":%s,"readiness":%s,"after":%s}' \
    "$MANAGED_SUPERVISOR_IDENTITY" "$health_before" "$readiness_json" "$health_after" \
    | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const fail = (reason, permanent = false) => {
          process.stderr.write(`${reason}\n`);
          process.exitCode = permanent ? 3 : 1;
        };
        try {
          const value = JSON.parse(input);
          const identity = (candidate) => ({ installationId: candidate.installationId, controlEpoch: candidate.controlEpoch });
          const validIdentity = (candidate) => candidate && typeof candidate.installationId === "string"
            && Number.isSafeInteger(candidate.controlEpoch) && candidate.controlEpoch >= 0;
          if (!validIdentity(value.expected) || !validIdentity(value.before) || !validIdentity(value.after)) {
            fail("supervisor_health_identity_invalid", true);
            return;
          }
          if (JSON.stringify(identity(value.expected)) !== JSON.stringify(identity(value.before))
            || JSON.stringify(identity(value.before)) !== JSON.stringify(identity(value.after))) {
            fail("supervisor_identity_changed_during_runtime_readiness", true);
            return;
          }
          const body = value.readiness;
          if (!body || typeof body !== "object" || !body.readiness || !body.paneOwnership) {
            fail("authenticated_runtime_readiness_missing_required_fields", true);
            return;
          }
          if (body.installationId !== value.before.installationId || body.controlEpoch !== value.before.controlEpoch) {
            fail("runtime_readiness_supervisor_identity_mismatch", true);
            return;
          }
          if (body.readiness.initialScanState !== "complete" || !Array.isArray(body.readiness.blockedSubsystems)
            || body.readiness.blockedSubsystems.length !== 0) {
            fail("runtime_readiness_scan_incomplete");
            return;
          }
          const ownership = body.paneOwnership;
          if (ownership.complete !== true || !Array.isArray(ownership.panes)
            || !Array.isArray(ownership.unattachedProcesses)) {
            fail("runtime_pane_ownership_census_incomplete");
            return;
          }
          const counts = { durable: 0, hostManaged: 0, unknown: 0 };
          for (const pane of ownership.panes) {
            if (pane?.ownership === "durable") counts.durable += 1;
            else if (pane?.ownership === "host-managed") counts.hostManaged += 1;
            else if (pane?.ownership === "unknown") counts.unknown += 1;
            else {
              fail("runtime_pane_ownership_census_invalid", true);
              return;
            }
          }
          process.stdout.write(`${counts.durable}\t${counts.hostManaged}\t${counts.unknown}\t${ownership.unattachedProcesses.length}`);
        } catch {
          fail("authenticated_runtime_readiness_invalid", true);
        }
      });
    '
}

managed_startup_failure() {
  local reason="$1"
  reason="${reason//_/ }"
  echo "Managed runtime startup verification failed ($reason). The newly launched web server will be stopped; existing host sessions were not migrated." >&2
  echo "If this is an existing installation, save or port live host-agent sessions and use a deliberate approved recovery, then verify authenticated runtime readiness. For systemd-owned maintenance, use the managed runtime updater." >&2
  stop_ours || true
  exit 1
}

# --- launch ------------------------------------------------------------------

mkdir -p "$(dirname "$LOG_FILE")"
echo "Starting freshell-server on port $PORT..."
# Detach into a NEW SESSION (setsid): the server gets its own session +
# process group and no controlling terminal, so the death of the launching
# shell (or its WSL2 relay) can no longer deliver the SIGHUP/SIGTERM
# cascades that killed the server and every child agent PTY at once
# (shutdown_forensics events in ~/.freshell/logs/rust-server.jsonl).
# nohup was useless here: the server installs its own SIGHUP handler, which
# replaces nohup's inherited SIG_IGN (docs/plans/2026-07-26-rust-wsl-crash-
# hardening.md A13/V5). stdin comes from /dev/null so no tty fd ties us to
# the console. setsid exec's WITHOUT forking here (a background job in a
# non-interactive script is not a process-group leader), so $! below is the
# server's real pid. Verified by experiment (ledger A11) — but ONLY under
# these conditions: never enable job control (set -m) in this script and
# never wrap this script in an outer setsid/setpgid; either would make
# setsid a process-group leader and flip it into its FORK branch, leaving
# $! pointing at a short-lived intermediate.
PORT="$PORT" setsid "$BINARY" < /dev/null >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"
if [[ "$MANAGED_RUNTIME_REQUESTED" == "1" ]]; then
  start_identity="$(process_start_identity "$SERVER_PID" || true)"
  if [[ -z "$start_identity" ]] || ! {
    printf 'managed-runtime-v1:%s:%s\n' "$SERVER_PID" "$start_identity" > "$MANAGED_MARKER_FILE"
    chmod 600 "$MANAGED_MARKER_FILE"
  }; then
    echo "Could not record managed-runtime startup state for pid $SERVER_PID; refusing to leave an unverifiable managed server running." >&2
    stop_ours || true
    exit 1
  fi
else
  rm -f "$MANAGED_MARKER_FILE"
fi

# Readiness check: ordinary mode uses /api/health. Managed mode additionally
# verifies the authenticated runtime census and the exact control-socket peer.
MANAGED_READINESS_FAILURE="runtime_readiness_not_yet_available"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    managed_counts=""
    if [[ "$MANAGED_RUNTIME_REQUESTED" == "1" ]]; then
      if managed_counts="$(managed_readiness_summary 2>&1)"; then
        IFS=$'\t' read -r durable_panes host_managed_panes unknown_panes unattached_processes <<< "$managed_counts"
      else
        readiness_status=$?
        MANAGED_READINESS_FAILURE="$managed_counts"
        if [[ "$readiness_status" == 3 ]]; then
          managed_startup_failure "$MANAGED_READINESS_FAILURE"
        fi
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
          echo "Server exited during managed runtime readiness verification. Last log lines:" >&2
          tail -20 "$LOG_FILE" >&2 || true
          rm -f "$PID_FILE" "$MANAGED_MARKER_FILE"
          exit 1
        fi
        sleep 0.5
        continue
      fi
    fi
    echo ""
    if [[ "$MANAGED_RUNTIME_REQUESTED" == "1" ]]; then
      echo "freshell-server and managed runtime are ready (pid $SERVER_PID, port $PORT; durable=$durable_panes, host-managed=$host_managed_panes, unknown=$unknown_panes, unattached=$unattached_processes)"
      if [[ "$host_managed_panes" != "0" || "$unknown_panes" != "0" ]]; then
        echo "Host-managed and unknown panes remain outside durable-soul protection and are left running."
      fi
      if [[ "$unattached_processes" != "0" ]]; then
        echo "Unattached agent processes were not migrated and remain running; check their ownership before relying on durable-soul protection."
      fi
    else
      echo "freshell-server is ready! (pid $SERVER_PID, port $PORT)"
    fi
    if ! is_our_server_pid "$SERVER_PID"; then
      echo "WARNING: $PID_FILE may be stale — setsid forked unexpectedly;" >&2
      echo "         --stop/--restart may not find the server. Inspect with:" >&2
      echo "         ps -eo pid,sid,args | grep freshell-server" >&2
    fi
    # The listening line includes the commit the binary was built from.
    grep -m1 "freshell-server listening" "$LOG_FILE" | tail -1 || true
    echo "  URL: http://localhost:$PORT/?token=$AUTH_TOKEN_VALUE"
    echo "  Log: $LOG_FILE"
    echo "  Pid: $PID_FILE"
    exit 0
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server exited during startup. Last log lines:" >&2
    tail -20 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE" "$MANAGED_MARKER_FILE"
    exit 1
  fi
  sleep 0.5
done

if [[ "$MANAGED_RUNTIME_REQUESTED" == "1" ]]; then
  managed_startup_failure "$MANAGED_READINESS_FAILURE"
fi
echo "Server started (pid $SERVER_PID) but /api/health not ready within 30s. Check $LOG_FILE" >&2
exit 1
