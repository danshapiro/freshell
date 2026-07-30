#!/usr/bin/env bash
# Canonical compatibility-aware Freshell launcher.
#
# Usage:
#   scripts/launch-rust.sh --restart
#   scripts/launch-rust.sh --server-only --restart
#   scripts/launch-rust.sh --client-only
#   scripts/launch-rust.sh --skip-build
#   scripts/launch-rust.sh --skip-build --restart
#   scripts/launch-rust.sh --stop
#   scripts/launch-rust.sh --port 3499 <mode>
#
# The shell owns argument validation and private build outputs only. Immutable
# generation assembly, compatibility checks, process ownership, activation,
# recovery, and lifecycle receipts belong to the Rust deployment controller.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3002}"
PORT_SEEN=0
CLIENT_ONLY=0
SERVER_ONLY=0
SKIP_BUILD=0
RESTART=0
STOP_ONLY=0

die() {
  echo "launch-rust: $*" >&2
  exit 2
}

mark_once() {
  local name="$1"
  local value="$2"
  [[ "$value" == 0 ]] || die "duplicate $name option"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      mark_once "--port" "$PORT_SEEN"
      [[ $# -ge 2 ]] || die "missing value for --port"
      PORT="$2"
      PORT_SEEN=1
      shift 2
      ;;
    --port=*)
      mark_once "--port" "$PORT_SEEN"
      PORT="${1#*=}"
      PORT_SEEN=1
      shift
      ;;
    --client-only)
      mark_once "--client-only" "$CLIENT_ONLY"
      CLIENT_ONLY=1
      shift
      ;;
    --server-only)
      mark_once "--server-only" "$SERVER_ONLY"
      SERVER_ONLY=1
      shift
      ;;
    --skip-build)
      mark_once "--skip-build" "$SKIP_BUILD"
      SKIP_BUILD=1
      shift
      ;;
    --restart)
      mark_once "--restart" "$RESTART"
      RESTART=1
      shift
      ;;
    --stop)
      mark_once "--stop" "$STOP_ONLY"
      STOP_ONLY=1
      shift
      ;;
    -h|--help)
      sed -n '2,14s/^# \\{0,1\\}//p' "$0"
      exit 0
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

[[ "$PORT" =~ ^(0|[1-9][0-9]*)$ ]] || die "port must be canonical decimal"
(( ${#PORT} <= 5 )) || die "port must be between 1 and 65535"
(( PORT >= 1 && PORT <= 65535 )) || die "port must be between 1 and 65535"

(( CLIENT_ONLY + SERVER_ONLY <= 1 )) || die "--client-only and --server-only conflict"
if (( CLIENT_ONLY == 1 && RESTART == 1 )); then
  die "--client-only conflicts with --restart"
fi
if (( SERVER_ONLY == 1 && RESTART == 0 )); then
  die "--server-only requires --restart"
fi
if (( SKIP_BUILD == 1 && (CLIENT_ONLY == 1 || SERVER_ONLY == 1 || STOP_ONLY == 1) )); then
  die "--skip-build conflicts with component and stop modes"
fi
if (( STOP_ONLY == 1 && (RESTART == 1 || CLIENT_ONLY == 1 || SERVER_ONLY == 1) )); then
  die "--stop conflicts with restart and component modes"
fi
if (( CLIENT_ONLY == 0 && SERVER_ONLY == 0 && SKIP_BUILD == 0 && STOP_ONLY == 0 && RESTART == 0 )); then
  die "combined deployment requires --restart"
fi

PORT_ROOT="$REPO_ROOT/.freshell-deploy/ports/$PORT"
CURRENT_CONTROLLER="$PORT_ROOT/current/controller/freshell-deploy"

require_current_controller() {
  [[ -x "$CURRENT_CONTROLLER" ]] || {
    echo "launch-rust: no controller is stored in the selected generation for port $PORT" >&2
    echo "launch-rust: complete a combined bootstrap before using this mode" >&2
    exit 1
  }
}

if (( STOP_ONLY == 1 )); then
  require_current_controller
  exec "$CURRENT_CONTROLLER" stop-current --checkout "$REPO_ROOT" --port "$PORT"
fi

if (( SKIP_BUILD == 1 )); then
  require_current_controller
  if (( RESTART == 1 )); then
    exec "$CURRENT_CONTROLLER" restart-current --checkout "$REPO_ROOT" --port "$PORT"
  fi
  exec "$CURRENT_CONTROLLER" start-current --checkout "$REPO_ROOT" --port "$PORT"
fi

if (( CLIENT_ONLY == 1 )); then
  require_current_controller
fi

BUILD_PARENT="${FRESHELL_DEPLOY_BUILD_PARENT:-${TMPDIR:-/tmp}/freshell-deploy-builds-${UID}}"
[[ "$BUILD_PARENT" == /* ]] || die "FRESHELL_DEPLOY_BUILD_PARENT must be absolute"
if [[ ! -e "$BUILD_PARENT" ]]; then
  (
    umask 077
    mkdir -p "$BUILD_PARENT"
  )
fi
[[ -d "$BUILD_PARENT" && ! -L "$BUILD_PARENT" ]] ||
  die "FRESHELL_DEPLOY_BUILD_PARENT must be a real directory"
BUILD_PARENT="$(readlink -f "$BUILD_PARENT")"
[[ "$BUILD_PARENT" != "/" ]] ||
  die "FRESHELL_DEPLOY_BUILD_PARENT must not be the filesystem root"
case "$BUILD_PARENT/" in
  "$REPO_ROOT/"*)
    die "FRESHELL_DEPLOY_BUILD_PARENT must be outside the checkout and immutable store"
    ;;
esac
BUILD_PARENT_UID="$(stat -c '%u' "$BUILD_PARENT")"
BUILD_PARENT_MODE="$(stat -c '%a' "$BUILD_PARENT")"
CURRENT_UID="$(id -u)"
if [[ "$BUILD_PARENT_UID" != "$CURRENT_UID" ]] &&
  (( (8#$BUILD_PARENT_MODE & 01000) == 0 )); then
  die "FRESHELL_DEPLOY_BUILD_PARENT must be owned by the current user or sticky"
fi
if (( (8#$BUILD_PARENT_MODE & 00022) != 0 && (8#$BUILD_PARENT_MODE & 01000) == 0 )); then
  die "FRESHELL_DEPLOY_BUILD_PARENT must not be writable by other users unless sticky"
fi
BUILD_DIR="$(mktemp -d "$BUILD_PARENT/launch-$PORT.XXXXXXXX")"
chmod 700 "$BUILD_DIR"

cleanup_build() {
  rm -rf -- "$BUILD_DIR"
}
trap cleanup_build EXIT

CLIENT_DIR="$BUILD_DIR/client"
SERVER_BUILD_ROOT="$BUILD_DIR/server-build"
DIST_SERVER_DIR="$SERVER_BUILD_ROOT/server"
RUNTIME_ROOT="$BUILD_DIR/runtime"
CARGO_TARGET_DIR_VALUE="$BUILD_DIR/cargo-target"
CONTROLLER="$CURRENT_CONTROLLER"

build_client() {
  echo "Typechecking and building the client in private staging..."
  npm run typecheck:client -- \
    --incremental false \
    --tsBuildInfoFile "$BUILD_DIR/tsconfig.client.tsbuildinfo"
  FRESHELL_CLIENT_OUT_DIR="$CLIENT_DIR" npm run build:client
}

build_server_runtime() {
  echo "Typechecking and building the server runtime in private staging..."
  npm run typecheck:server -- \
    --incremental false \
    --tsBuildInfoFile "$BUILD_DIR/tsconfig.server.check.tsbuildinfo"
  npm run build:server -- \
    --outDir "$SERVER_BUILD_ROOT" \
    --tsBuildInfoFile "$BUILD_DIR/tsconfig.server.build.tsbuildinfo"

  mkdir -p "$RUNTIME_ROOT"
  cp "$REPO_ROOT/package.json" "$RUNTIME_ROOT/package.json"
  cp "$REPO_ROOT/package-lock.json" "$RUNTIME_ROOT/package-lock.json"
  npm ci --omit=dev --prefix "$RUNTIME_ROOT"

  CARGO_TARGET_DIR="$CARGO_TARGET_DIR_VALUE" \
    cargo build --release -p freshell-server -p freshell-deploy
  CONTROLLER="$CARGO_TARGET_DIR_VALUE/release/freshell-deploy"
  [[ -x "$CONTROLLER" ]] || {
    echo "launch-rust: private controller build did not produce $CONTROLLER" >&2
    exit 1
  }
  [[ -x "$CARGO_TARGET_DIR_VALUE/release/freshell-server" ]] || {
    echo "launch-rust: private server build did not produce freshell-server" >&2
    exit 1
  }
}

NODE_COMMAND="$(command -v node)"
NODE_EXECUTABLE="$(readlink -f "$NODE_COMMAND")"
[[ "$NODE_EXECUTABLE" == /* && -x "$NODE_EXECUTABLE" ]] || {
  echo "launch-rust: Node executable could not be resolved to an absolute executable" >&2
  exit 1
}
NODE_VERSION="$("$NODE_EXECUTABLE" --version)"

cd "$REPO_ROOT"

if (( CLIENT_ONLY == 1 )); then
  build_client
  "$CONTROLLER" deploy \
    --checkout "$REPO_ROOT" \
    --port "$PORT" \
    --mode client-only \
    --client-dir "$CLIENT_DIR" \
    --node-executable "$NODE_EXECUTABLE" \
    --node-version "$NODE_VERSION"
  echo "Client generation selected. Hard-refresh the browser to load it."
  exit 0
fi

if (( SERVER_ONLY == 1 )); then
  build_server_runtime
  "$CONTROLLER" deploy \
    --checkout "$REPO_ROOT" \
    --port "$PORT" \
    --mode server \
    --server-executable "$CARGO_TARGET_DIR_VALUE/release/freshell-server" \
    --controller-executable "$CONTROLLER" \
    --extensions-dir "$REPO_ROOT/extensions" \
    --dist-server-dir "$DIST_SERVER_DIR" \
    --mcp-entry-relative "mcp/server.js" \
    --claude-sidecar-dir "$REPO_ROOT/crates/freshell-claude-sidecar" \
    --claude-sidecar-entry-relative "index.mjs" \
    --package-json "$RUNTIME_ROOT/package.json" \
    --package-lock "$RUNTIME_ROOT/package-lock.json" \
    --node-modules "$RUNTIME_ROOT/node_modules" \
    --node-executable "$NODE_EXECUTABLE" \
    --node-version "$NODE_VERSION"
  exit 0
fi

build_client
build_server_runtime

BOOTSTRAP_STATE="$("$CONTROLLER" bootstrap-status --checkout "$REPO_ROOT" --port "$PORT")"
if [[ "$BOOTSTRAP_STATE" == "capture-required" ]]; then
  FRESHELL_HOME_VALUE="${FRESHELL_HOME:-$HOME/.freshell}"
  "$CONTROLLER" capture \
    --checkout "$REPO_ROOT" \
    --port "$PORT" \
    --pid-file "$FRESHELL_HOME_VALUE/rust-server-$PORT.pid" \
    --client-dir "$REPO_ROOT/dist/client" \
    --extensions-dir "$REPO_ROOT/extensions" \
    --dist-server-dir "$REPO_ROOT/dist/server" \
    --mcp-entry-relative "mcp/server.js" \
    --claude-sidecar-dir "$REPO_ROOT/crates/freshell-claude-sidecar" \
    --claude-sidecar-entry-relative "index.mjs" \
    --package-json "$REPO_ROOT/package.json" \
    --package-lock "$REPO_ROOT/package-lock.json" \
    --node-modules "$RUNTIME_ROOT/node_modules" \
    --node-executable "$NODE_EXECUTABLE" \
    --node-version "$NODE_VERSION"
elif [[ "$BOOTSTRAP_STATE" != "captured-legacy" && "$BOOTSTRAP_STATE" != "managed" ]]; then
  echo "launch-rust: controller returned unknown bootstrap state $BOOTSTRAP_STATE" >&2
  exit 1
fi

"$CONTROLLER" deploy \
  --checkout "$REPO_ROOT" \
  --port "$PORT" \
  --mode full \
  --client-dir "$CLIENT_DIR" \
  --server-executable "$CARGO_TARGET_DIR_VALUE/release/freshell-server" \
  --controller-executable "$CONTROLLER" \
  --extensions-dir "$REPO_ROOT/extensions" \
  --dist-server-dir "$DIST_SERVER_DIR" \
  --mcp-entry-relative "mcp/server.js" \
  --claude-sidecar-dir "$REPO_ROOT/crates/freshell-claude-sidecar" \
  --claude-sidecar-entry-relative "index.mjs" \
  --package-json "$RUNTIME_ROOT/package.json" \
  --package-lock "$RUNTIME_ROOT/package-lock.json" \
  --node-modules "$RUNTIME_ROOT/node_modules" \
  --node-executable "$NODE_EXECUTABLE" \
  --node-version "$NODE_VERSION"
