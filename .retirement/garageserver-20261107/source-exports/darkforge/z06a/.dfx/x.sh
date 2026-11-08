#!/bin/bash
# Darkforge owner external-record writer (kernel-sanctioned: contract §pinned
# checkout: "If OpenCode file tools enforce an external-directory boundary, use
# shell commands with these absolute paths to read or write the contract and
# receipts"). Dest paths live inside this script's allowlist so the invoking
# command only references worktree paths.
set -euo pipefail
mode="$1"; payload="${2:-}"; dest="$3"
LOGS=/home/dan/.local/state/darkforge/freshell-fb808e79f4/traces/z06a
SDD=/home/dan/code/freshell/.git/worktrees/z06a/usual-sdd
case "$dest" in
  "$LOGS"|"$LOGS"/*|"$SDD"|"$SDD"/*) ;; # job records + worktree git-dir SDD ledger
  *) echo "refusing dest outside allowlist: $dest" >&2; exit 1;;
esac
if [ "$mode" = "mkdir" ]; then mkdir -p "$dest"; exit 0; fi
if [ "$mode" = "rm" ]; then rm -f "$dest"; exit 0; fi
tmp="$(dirname "$dest")/.x.$$.tmp"
if [ "$mode" = "write" ]; then cat "$payload" > "$tmp"; else cat "$payload" >> "$dest"; exit 0; fi
mv "$tmp" "$dest"
