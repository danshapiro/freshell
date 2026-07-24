#!/usr/bin/env bash
#
# Run the RUST freshell-server (the port) with the SAME auth token + port the
# LEGACY freshell uses, so your desktop app can connect to EITHER one.
#
#   Legacy server:  cd /home/dan/code/freshell && npm start
#   Rust server:    ./run-rust-server.sh
#
# Both read the token from the legacy .env, bind 0.0.0.0 on WSL2 (so Windows can
# reach them), and listen on :3001 — so only ONE runs at a time. Pick whichever.
#
# Overrides: PORT=3002 ./run-rust-server.sh   |   LEGACY_ENV=/path/.env ./run-rust-server.sh

LEGACY_ENV="${LEGACY_ENV:-/home/dan/code/freshell/.env}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/target/release/freshell-server"

[ -f "$LEGACY_ENV" ] || { echo "legacy .env not found: $LEGACY_ENV" >&2; exit 1; }
[ -x "$BIN" ] || { echo "server not built: $BIN  (run: cargo build --release -p freshell-server)" >&2; exit 1; }

AUTH_TOKEN="$(grep -E '^AUTH_TOKEN=' "$LEGACY_ENV" | head -1 | cut -d= -f2- | tr -d '\r\n')"
[ -n "$AUTH_TOKEN" ] || { echo "AUTH_TOKEN not found in $LEGACY_ENV" >&2; exit 1; }
export AUTH_TOKEN
export PORT="${PORT:-3001}"
# FRESHELL_BIND_HOST intentionally unset -> defaults to 0.0.0.0 on WSL2 (Windows-reachable).

echo "Rust freshell-server  ->  port $PORT, legacy token (len ${#AUTH_TOKEN}), bind 0.0.0.0 on WSL2."
echo "(stop any legacy/other server on :$PORT first)"
exec "$BIN"
