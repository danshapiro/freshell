#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${HOME}/.freshell/logs"
mkdir -p "$LOG_DIR"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

echo "[$(timestamp)] freshell managed start: attempting production serve" >> "$LOG_DIR/managed.log"

set +e
npm run serve
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  echo "[$(timestamp)] production serve failed (exit $rc), falling back to dev mode" >> "$LOG_DIR/managed.log"
  exec npm run dev
fi
