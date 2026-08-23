#!/usr/bin/env bash
# Collect baseline git data for all worktrees under .worktrees/
# Outputs JSONL, one record per worktree.
set -uo pipefail
ROOT=/home/dan/code/freshell
MAIN=origin/main
OUT="$ROOT/.worktrees/worktree-triage-20260823/triage-output/baseline-data.jsonl"
: > "$OUT"

git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | while read -r wt; do
  case "$wt" in
    "$ROOT") continue ;;                                   # skip main checkout
    *worktree-triage-20260823) continue ;;                 # skip analysis worktree
  esac
  name=$(basename "$wt")
  head=$(git -C "$wt" rev-parse HEAD 2>/dev/null || echo "?")
  branch=$(git -C "$wt" symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")
  date=$(git -C "$wt" log -1 --format=%cs 2>/dev/null || echo "?")
  if git merge-base --is-ancestor "$head" "$MAIN" 2>/dev/null; then anc=YES; else anc=NO; fi
  # ahead/behind: only meaningful for a real branch; for detached use HEAD
  ahead=$(git rev-list --count "$MAIN..$head" 2>/dev/null || echo "?")
  behind=$(git rev-list --count "$head..$MAIN" 2>/dev/null || echo "?")
  # dirty: line count of status --porcelain + category letters
  status=$(git -C "$wt" status --porcelain 2>/dev/null)
  dirty=$(printf '%s' "$status" | grep -c . || true)
  dirtysample=$(printf '%s' "$status" | head -3 | paste -sd';' | cut -c1-160)
  # squash-merge detection: branch footprint vs main
  mb=$(git merge-base "$MAIN" "$head" 2>/dev/null || echo "")
  touched=0; differ=0
  if [ -n "$mb" ]; then
    tfiles=$(git diff --name-only "$mb..$head" 2>/dev/null)
    touched=$(printf '%s' "$tfiles" | grep -c . || true)
    if [ "$touched" -gt 0 ]; then
      differ=$(git diff --name-only "$head" "$MAIN" -- $tfiles 2>/dev/null | grep -c . || true)
    fi
  fi
  python3 -c '
import json,sys
name,branch,head,date,anc,ahead,behind,dirty,dirtysample,touched,differ,wt = sys.argv[1:13]
print(json.dumps({"name":name,"branch":branch,"head":head[:9],"date":date,"ancestor":anc,
 "ahead":int(ahead) if ahead.isdigit() else ahead,"behind":int(behind) if behind.isdigit() else behind,
 "dirty":int(dirty),"dirtySample":dirtysample,"footprintFiles":int(touched),"footprintDiffersVsMain":int(differ),
 "path":wt}))
' "$name" "$branch" "$head" "$date" "$anc" "$ahead" "$behind" "$dirty" "$dirtysample" "$touched" "$differ" "$wt" >> "$OUT"
done
echo "collected $(wc -l < "$OUT") records"
