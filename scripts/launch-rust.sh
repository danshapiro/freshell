#!/usr/bin/env bash
# Launch the Rust Freshell server with the Durable Souls control plane.
#
# Usage:
#   scripts/launch-rust.sh                         # prepare managed release and start (port 3002)
#   scripts/launch-rust.sh --port 3499             # use a scratch port
#   scripts/launch-rust.sh --client-only           # rebuild dist/client only; no restart
#   scripts/launch-rust.sh --prepare-only          # build/copy immutable artifacts; start nothing
#   scripts/launch-rust.sh --preflight             # prepare unless --skip-build, then validate only
#   scripts/launch-rust.sh --managed-status        # inspect supervisor/release state; mutate nothing
#   scripts/launch-rust.sh --skip-build             # use the current immutable managed release
#   scripts/launch-rust.sh --restart               # restart the exact web pid and upgrade controller
#   scripts/launch-rust.sh --legacy                # web rollback: omit managed routing, leave agents alive
#   scripts/launch-rust.sh --stop                  # stop the exact web pid only; agents keep running
#   scripts/launch-rust.sh --stop-supervisor       # stop exact controller pid; agents keep running
#
# The supervisor is independent of the web server. Existing session-host
# containers bind their immutable release binary and survive both web and
# supervisor replacement. This script never scans or kills by process name.
# Restarting the live self-hosted server still requires Dan's literal APPROVED.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRESHELL_HOME="${FRESHELL_HOME:-$HOME/.freshell}"
PORT="${PORT:-3002}"
CLIENT_ONLY=0
SKIP_BUILD=0
RESTART=0
STOP_ONLY=0
STOP_SUPERVISOR=0
PREPARE_ONLY=0
PREFLIGHT_ONLY=0
MANAGED_STATUS=0
LEGACY=0
PREPARED_RELEASE_ID=""
PREFLIGHT_DONE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --client-only) CLIENT_ONLY=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --restart) RESTART=1; shift ;;
    --stop) STOP_ONLY=1; shift ;;
    --stop-supervisor) STOP_SUPERVISOR=1; shift ;;
    --prepare-only) PREPARE_ONLY=1; shift ;;
    --preflight) PREFLIGHT_ONLY=1; shift ;;
    --managed-status) MANAGED_STATUS=1; shift ;;
    --legacy) LEGACY=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid port: $PORT" >&2
  exit 2
fi

cd "$REPO_ROOT"
MISE="$(command -v mise || true)"
[[ -n "$MISE" ]] || MISE="$HOME/.local/bin/mise"
[[ -x "$MISE" ]] || { echo "mise is required at $MISE" >&2; exit 1; }
MANAGER=("$MISE" exec node@22 -- "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/scripts/managed-runtime-release.ts")
managed() { "${MANAGER[@]}" "$@" --repo-root "$REPO_ROOT" --freshell-home "$FRESHELL_HOME"; }

PID_FILE="$FRESHELL_HOME/rust-server-$PORT.pid"
LOG_FILE="$FRESHELL_HOME/logs/rust-server-$PORT.log"
RELEASES_ROOT="$FRESHELL_HOME/mr/releases"
TARGET_BINARY="$REPO_ROOT/target/release/freshell-server"

is_our_server_pid() {
  local pid="$1" cwd="" args=""
  kill -0 "$pid" 2>/dev/null || return 1
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  args="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cwd" == "$REPO_ROOT" ]] || return 1
  [[ "$args" == "$TARGET_BINARY"* || "$args" == "$RELEASES_ROOT/"*"/freshell-server"* ]]
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
  if ! [[ "$pid" =~ ^[0-9]+$ ]] || ! is_our_server_pid "$pid"; then
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      echo "Refusing to stop pid $pid: it is not this repo's Freshell server." >&2
      return 1
    fi
    echo "Removing stale server pid file $PID_FILE." >&2
    rm -f "$PID_FILE"
    return 1
  fi
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
}

if [[ "$MANAGED_STATUS" == 1 ]]; then
  managed status
  exit $?
fi
if [[ "$STOP_SUPERVISOR" == 1 ]]; then
  managed stop-supervisor
  exit $?
fi
if [[ "$STOP_ONLY" == 1 ]]; then
  stop_ours
  exit $?
fi

if [[ "$SKIP_BUILD" != 1 ]]; then
  echo "Building client (typecheck + Vite)..."
  npm run typecheck:client
  npm run build:client
  if [[ "$CLIENT_ONLY" == 1 ]]; then
    echo ""
    echo "Client rebuilt at dist/client. The running server serves it from disk;"
    echo "hard-refresh the browser. No process was restarted."
    exit 0
  fi

  if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
    echo "Refusing to prepare a managed release from dirty source; commit or clean the worktree before preparing a managed release." >&2
    exit 1
  fi

  echo "Building managed Rust server, supervisor, and session host..."
  cargo build --release -p freshell-server --features managed-runtime-v1
  cargo build --release -p freshell-supervisor -p freshell-session-host

  COMMIT="$(git rev-parse --verify HEAD)"
  IMAGE_TAG="freshell-managed-runtime:release-${COMMIT:0:12}"
  echo "Building managed runtime image $IMAGE_TAG..."
  docker build --file docker/runtime/Dockerfile --tag "$IMAGE_TAG" .
  IMAGE_REF="$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')"
  PREPARED_JSON="$(managed prepare \
    --commit "$COMMIT" \
    --image-ref "$IMAGE_REF" \
    --server-binary "$REPO_ROOT/target/release/freshell-server" \
    --supervisor-binary "$REPO_ROOT/target/release/freshell-supervisor" \
    --host-binary "$REPO_ROOT/target/release/freshell-session-host")"
  PREPARED_RELEASE_ID="$("$MISE" exec node@22 -- node -e \
    'const release=JSON.parse(process.argv[1]); if(!/^[0-9a-f]{24}$/.test(release.releaseId)) process.exit(2); process.stdout.write(release.releaseId)' \
    "$PREPARED_JSON")"
  managed preflight --release-id "$PREPARED_RELEASE_ID"
  PREFLIGHT_DONE=1
  if [[ "$PREFLIGHT_ONLY" == 1 ]]; then
    echo "Managed release passed preflight; no active release pointer was changed."
    exit 0
  fi
fi

if [[ "$CLIENT_ONLY" == 1 ]]; then
  echo "--client-only requires a build; remove --skip-build." >&2
  exit 2
fi

if [[ "$PREFLIGHT_ONLY" == 1 ]]; then
  managed preflight
  echo "Current managed release passed preflight; no active release pointer was changed."
  exit 0
fi

if [[ "$PREPARE_ONLY" == 1 ]]; then
  if [[ "$PREFLIGHT_DONE" != 1 ]]; then managed preflight; fi
  if [[ -n "$PREPARED_RELEASE_ID" ]]; then
    managed backup-registry --release-id "$PREPARED_RELEASE_ID" >/dev/null
    managed activate --release-id "$PREPARED_RELEASE_ID" >/dev/null
  else
    managed backup-registry >/dev/null
  fi
  echo "Managed release prepared and activated; no process was started or restarted."
  exit 0
fi

AUTH_TOKEN_VALUE="${AUTH_TOKEN:-$(grep -m1 '^AUTH_TOKEN=' .env 2>/dev/null | cut -d= -f2- || true)}"
if [[ -z "$AUTH_TOKEN_VALUE" ]]; then
  echo "AUTH_TOKEN not set (env or $REPO_ROOT/.env)." >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  saved_pid="$(cat "$PID_FILE")"
  if [[ "$saved_pid" =~ ^[0-9]+$ ]] && is_our_server_pid "$saved_pid"; then
    if [[ "$RESTART" == 1 ]]; then
      stop_ours
    else
      echo "freshell-server already running on port $PORT (pid $saved_pid)."
      echo "  URL: http://localhost:$PORT/?token=$AUTH_TOKEN_VALUE"
      echo "  A managed release may have been prepared, but no controller/web process was replaced."
      echo "  Use --restart only with required approval for the live server."
      exit 0
    fi
  else
    if [[ "$saved_pid" =~ ^[0-9]+$ ]] && kill -0 "$saved_pid" 2>/dev/null; then
      echo "Pid file points at a foreign live process; refusing." >&2
      exit 1
    fi
    rm -f "$PID_FILE"
  fi
fi

if port_in_use; then
  echo "Port $PORT is in use by a process this script did not start. Refusing." >&2
  exit 1
fi

if [[ "$LEGACY" != 1 ]]; then
  if [[ "$PREFLIGHT_DONE" != 1 ]]; then managed preflight >/dev/null; fi
  if [[ -n "$PREPARED_RELEASE_ID" ]]; then
    managed backup-registry --release-id "$PREPARED_RELEASE_ID" >/dev/null
    managed activate --release-id "$PREPARED_RELEASE_ID" >/dev/null
  else
    managed backup-registry >/dev/null
  fi
  # Replacing the controller does not stop managed hosts. It is done only
  # while this launch owns a stopped/absent web process.
  managed ensure-supervisor --replace >/dev/null
  WEB_ENV_FILE="$(managed web-env-file)"
  while IFS='=' read -r key value; do
    [[ -z "$key" ]] && continue
    [[ "$key" =~ ^[A-Z0-9_]+$ ]] || { echo "Invalid managed environment key: $key" >&2; exit 1; }
    export "$key=$value"
  done < "$WEB_ENV_FILE"
else
  unset FRESHELL_MANAGED_RUNTIME_V1 FRESHELL_MANAGED_FRESH_AGENT_V1 \
    FRESHELL_MANAGED_PROVIDERS FRESHELL_RUNTIME_CONTROL_SOCKET \
    FRESHELL_RUNTIME_CONTROL_SECRET_FILE
  echo "Starting web in legacy rollback mode; existing managed agents and supervisor are left intact."
fi

if [[ -n "$PREPARED_RELEASE_ID" && "$LEGACY" == 1 ]]; then
  BINARY="$(managed current --release-id "$PREPARED_RELEASE_ID" --field serverBinary)"
else
  BINARY="$(managed current --field serverBinary)"
fi
[[ -x "$BINARY" ]] || { echo "Missing immutable release binary: $BINARY" >&2; exit 1; }

mkdir -p "$(dirname "$LOG_FILE")"
echo "Starting freshell-server on port $PORT from immutable release $BINARY..."
PORT="$PORT" setsid "$BINARY" < /dev/null >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PID_FILE"

for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo ""
    echo "freshell-server is ready! (pid $SERVER_PID, port $PORT)"
    if ! is_our_server_pid "$SERVER_PID"; then
      echo "WARNING: pid ownership verification failed; inspect before any stop/restart." >&2
    fi
    grep "freshell-server listening" "$LOG_FILE" | tail -1 || true
    echo "  URL: http://localhost:$PORT/?token=$AUTH_TOKEN_VALUE"
    echo "  Log: $LOG_FILE"
    echo "  Pid: $PID_FILE"
    [[ "$LEGACY" == 1 ]] || managed status
    exit 0
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server exited during startup. Last log lines:" >&2
    tail -30 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 0.5
done

echo "Server started (pid $SERVER_PID) but /api/health was not ready within 30s. Check $LOG_FILE" >&2
if is_our_server_pid "$SERVER_PID"; then
  kill "$SERVER_PID"
  for _ in $(seq 1 20); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.25
  done
fi
if ! kill -0 "$SERVER_PID" 2>/dev/null; then rm -f "$PID_FILE"; fi
exit 1
