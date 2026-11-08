#!/bin/bash
# Darkforge owner helper: atomic stdin->file write for contract-mandated
# records outside the worktree (run-state.md, reports, receipts).
set -euo pipefail
dest="$1"
dir=$(dirname "$dest")
tmp="$dir/.dfw.$$.tmp"
cat > "$tmp"
mv "$tmp" "$dest"
