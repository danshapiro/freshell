#!/usr/bin/env bash
# Compatibility entrypoint. The Rust launcher owns build, start, readiness,
# pid-file verification, and exact-PID stop/restart behavior.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/launch-rust.sh" "$@"
