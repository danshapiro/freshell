#!/usr/bin/env bash
# Docker-only fixture: retain parentage across legacy server launch and
# controller capture so restrictive container /proc policies still permit the
# controller's exact fd/listener inspection.
set -euo pipefail

: "${FRESHELL_REAL_SERVER:?}"
: "${FRESHELL_REAL_CONTROLLER:?}"
: "${FRESHELL_REAL_CHECKOUT:?}"
: "${FRESHELL_REAL_PID_FILE:?}"
: "${FRESHELL_REAL_LOG_FILE:?}"
: "${FRESHELL_REAL_PORT:?}"
: "${FRESHELL_REAL_CLIENT_DIR:?}"
: "${FRESHELL_REAL_EXTENSIONS_DIR:?}"
: "${FRESHELL_REAL_DIST_SERVER_DIR:?}"
: "${FRESHELL_REAL_SIDECAR_DIR:?}"
: "${FRESHELL_REAL_PACKAGE_JSON:?}"
: "${FRESHELL_REAL_PACKAGE_LOCK:?}"
: "${FRESHELL_REAL_NODE_MODULES:?}"
: "${FRESHELL_REAL_NODE:?}"
: "${FRESHELL_REAL_NODE_VERSION:?}"

cd "$FRESHELL_REAL_CHECKOUT"
"$FRESHELL_REAL_SERVER" >>"$FRESHELL_REAL_LOG_FILE" 2>&1 &
server_pid="$!"
printf '%s\n' "$server_pid" >"$FRESHELL_REAL_PID_FILE"

ready=0
for _ in $(seq 1 400); do
  if curl --fail --silent --show-error \
    "http://127.0.0.1:${FRESHELL_REAL_PORT}/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "real legacy fixture server exited before readiness" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ "$ready" != 1 ]]; then
  echo "real legacy fixture server did not become ready" >&2
  exit 1
fi

exec "$FRESHELL_REAL_CONTROLLER" capture \
  --checkout "$FRESHELL_REAL_CHECKOUT" \
  --port "$FRESHELL_REAL_PORT" \
  --pid-file "$FRESHELL_REAL_PID_FILE" \
  --client-dir "$FRESHELL_REAL_CLIENT_DIR" \
  --extensions-dir "$FRESHELL_REAL_EXTENSIONS_DIR" \
  --dist-server-dir "$FRESHELL_REAL_DIST_SERVER_DIR" \
  --mcp-entry-relative mcp/server.js \
  --claude-sidecar-dir "$FRESHELL_REAL_SIDECAR_DIR" \
  --claude-sidecar-entry-relative index.mjs \
  --package-json "$FRESHELL_REAL_PACKAGE_JSON" \
  --package-lock "$FRESHELL_REAL_PACKAGE_LOCK" \
  --node-modules "$FRESHELL_REAL_NODE_MODULES" \
  --node-executable "$FRESHELL_REAL_NODE" \
  --node-version "$FRESHELL_REAL_NODE_VERSION"
