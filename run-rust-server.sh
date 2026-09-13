#!/usr/bin/env bash
#
# Run the standalone RUST freshell-server in the foreground with the auth token
# and port from this checkout's environment.
#
#   ./run-rust-server.sh
#
# The server binds 0.0.0.0 on WSL2 (so Windows can reach it) and listens on
# :3001 by default. Use PORT=N for an isolated non-production run.
#
# Overrides: PORT=3002 ./run-rust-server.sh   |   ENV_FILE=/path/.env ./run-rust-server.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/target/release/freshell-server"
ENV_FILE="${ENV_FILE:-$HERE/.env}"

[ -f "$ENV_FILE" ] || { echo ".env not found: $ENV_FILE" >&2; exit 1; }
[ -x "$BIN" ] || { echo "server not built: $BIN  (run: cargo build --release -p freshell-server --locked)" >&2; exit 1; }

AUTH_TOKEN="$(grep -E '^AUTH_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r\n')"
[ -n "$AUTH_TOKEN" ] || { echo "AUTH_TOKEN not found in $ENV_FILE" >&2; exit 1; }
export AUTH_TOKEN
export PORT="${PORT:-3001}"
# FRESHELL_BIND_HOST intentionally unset -> defaults to 0.0.0.0 on WSL2 (Windows-reachable).

echo "Rust freshell-server -> port $PORT, configured token (len ${#AUTH_TOKEN}), bind 0.0.0.0 on WSL2."
echo "(stop any other server on :$PORT first)"
exec "$BIN"
