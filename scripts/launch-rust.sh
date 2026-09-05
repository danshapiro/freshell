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
#   * Restarting the LIVE self-hosted server (port 3002) requires explicit user
#     approval ("APPROVED"). This script will never kill a process it did not
#     start: it only stops PIDs recorded in its own pid file, and only after
#     verifying the process is this repo's freshell-server binary.
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
    rm -f "$PID_FILE"
  else
    echo "Pid file $PID_FILE is stale (pid $pid is not this repo's server); removing." >&2
    rm -f "$PID_FILE"
    return 1
  fi
}

# --- stop mode ---------------------------------------------------------------

if [[ "$STOP_ONLY" == 1 ]]; then
  stop_ours
  exit $?
fi

# --- build -------------------------------------------------------------------

if [[ "$SKIP_BUILD" != 1 ]]; then
  echo "Building client (typecheck + vite)..."
  npm run typecheck:client
  npm run build:client
  if [[ "$CLIENT_ONLY" == 1 ]]; then
    echo ""
    echo "Client rebuilt at dist/client. The running server serves it from disk --"
    echo "hard-refresh the browser to pick it up. No server restart needed."
    exit 0
  fi
  echo "Building Rust server (cargo build --release -p freshell-server)..."
  cargo build --release -p freshell-server --locked
fi

# The Claude SDK is a sanctioned Node sidecar, not the Freshell server.  Keep
# its locked dependency tree available for every launcher startup, including
# --skip-build runs from a clean checkout.
echo "Preparing Rust runtime prerequisites..."
npm run --silent prepare:rust-runtime

[[ -x "$BINARY" ]] || { echo "Missing binary: $BINARY (build first)" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------

# AUTH_TOKEN must be available (env or .env in repo root; the server loads .env
# from its cwd and refuses to start without a token).
AUTH_TOKEN_VALUE="${AUTH_TOKEN:-$(grep -m1 '^AUTH_TOKEN=' .env 2>/dev/null | cut -d= -f2- || true)}"
if [[ -z "$AUTH_TOKEN_VALUE" ]]; then
  echo "AUTH_TOKEN not set (env or $REPO_ROOT/.env). The server will refuse to start." >&2
  exit 1
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
      echo "  Use --restart to stop and relaunch it. NOTE: restarting the live"
      echo "  self-hosted server (port 3002) requires explicit user approval."
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

# Health check: /api/health is unauthenticated and rate-limit exempt.
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo ""
    echo "freshell-server is ready! (pid $SERVER_PID, port $PORT)"
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
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 0.5
done

echo "Server started (pid $SERVER_PID) but /api/health not ready within 30s. Check $LOG_FILE" >&2
exit 1
