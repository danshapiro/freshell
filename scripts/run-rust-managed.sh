#!/usr/bin/env bash
# Foreground managed Freshell entrypoint for systemd/supervisors.
# A release must first be prepared with scripts/launch-rust.sh --prepare-only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRESHELL_HOME="${FRESHELL_HOME:-$HOME/.freshell}"
PORT="${PORT:-3002}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    -h|--help) sed -n '1,3s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid port: $PORT" >&2
  exit 2
fi

cd "$REPO_ROOT"
MISE="$(command -v mise || true)"
[[ -n "$MISE" ]] || MISE="$HOME/.local/bin/mise"
MANAGER=("$MISE" exec node@22 -- "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/scripts/managed-runtime-release.ts")
managed() { "${MANAGER[@]}" "$@" --repo-root "$REPO_ROOT" --freshell-home "$FRESHELL_HOME"; }

# Reading current re-verifies immutable metadata and binary digests. Do not
# require every optional provider credential merely to restore the web UI;
# provider launch attempts report their own dependency failures.
BINARY="$(managed current --field serverBinary)"
managed backup-registry >/dev/null
managed ensure-supervisor >/dev/null
ENV_FILE="$(managed web-env-file)"
[[ -x "$BINARY" ]] || { echo "Missing immutable Freshell server: $BINARY" >&2; exit 1; }
while IFS='=' read -r key value; do
  [[ -z "$key" ]] && continue
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || { echo "Invalid managed environment key: $key" >&2; exit 1; }
  export "$key=$value"
done < "$ENV_FILE"
export PORT
exec "$BINARY"
