#!/usr/bin/env bash
# restore-tabs.sh -- rebuild a device's tabs from its newest (or Nth) tabs-sync
# snapshot generation. Continuity trio deliverable 1
# (docs/plans/2026-07-22-continuity-safety-trio.md).
#
#   scripts/restore-tabs.sh --url http://127.0.0.1:PORT --token TOK --list
#   scripts/restore-tabs.sh --url http://127.0.0.1:PORT --token TOK \
#       --device <deviceId> [--generation N | --generation-id ID] [--dry-run]
#
# DEFAULT (no --generation/--generation-id): restores the COHERENT all-clients
# UNION for the device -- no single client's tabs are dropped. Pass
# --generation-id ID (a stable content digest from --list) to restore a specific
# past point-in-time file; --generation N is the positional (index) form.
#
# The target browser/device should be CONNECTED when you run this: restored
# tabs are delivered live via ui.command{tab.create}. Requires curl + jq.
# NOTE: --url is REQUIRED on purpose (no default) -- never point tooling at a
# server you did not intend.
set -euo pipefail

URL="" TOKEN="${FRESHELL_TOKEN:-}" DEVICE="" GENERATION="" GENERATION_ID="" COMPONENTS="" DRY_RUN=false LIST=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --generation) GENERATION="$2"; shift 2 ;;
    --generation-id) GENERATION_ID="$2"; shift 2 ;;
    --components) COMPONENTS="$2"; shift 2 ;;   # comma-separated generation ids (the deploy bundle)
    --dry-run) DRY_RUN=true; shift ;;
    --list) LIST=true; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$URL" ]] || { echo "ERROR: --url is required" >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "ERROR: --token (or FRESHELL_TOKEN) is required" >&2; exit 2; }

auth=(-H "x-auth-token: ${TOKEN}")

if $LIST; then
  curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots" | jq -r '
    .devices[] | .deviceId as $d | .generations[] |
    "\($d)\tgen=\(.generation)\tid=\(.generationId)\trev=\(.snapshotRevision)\trecords=\(.recordCount)\tcapturedAt=\(.capturedAt)\tlabel=\(.deviceLabel)"'
  exit 0
fi

[[ -n "$DEVICE" ]] || { echo "ERROR: --device is required (try --list)" >&2; exit 2; }

# Send a selector ONLY when explicitly asked; otherwise the server restores the
# coherent union (the safe multi-client default). Priority mirrors the server:
# --components (immutable multi-client bundle) > --generation-id > --generation.
body=$(jq -n --arg d "$DEVICE" --argjson dry "$DRY_RUN" '{deviceId: $d, dryRun: $dry}')
sel="union"
if [[ -n "$COMPONENTS" ]]; then
  # Split the CSV into a JSON string array (no single-client substitution).
  comps=$(jq -Rn --arg c "$COMPONENTS" '$c | split(",") | map(select(length>0))')
  body=$(jq --argjson c "$comps" '. + {components: $c}' <<<"$body"); sel="components=$COMPONENTS"
elif [[ -n "$GENERATION_ID" ]]; then
  body=$(jq --arg g "$GENERATION_ID" '. + {generationId: $g}' <<<"$body"); sel="generationId=$GENERATION_ID"
elif [[ -n "$GENERATION" ]]; then
  body=$(jq --argjson g "$GENERATION" '. + {generation: $g}' <<<"$body"); sel="generation=$GENERATION"
fi
resp=$(curl -fsS "${auth[@]}" -H 'content-type: application/json' \
  -d "$body" "${URL}/api/tabs-sync/restore") || {
  echo "ERROR: restore request failed (is the snapshot/device id right? try --list)" >&2
  exit 1
}

echo "== restore ${DEVICE} (${sel}) =="
echo "$resp" | jq -r '
  (.restored[] | "RESTORED  \(.kind)\t\(.tabKey)  tabId=\(.tabId)  terminalId=\(.terminalId // "-")"),
  (.skipped[]  | "SKIPPED   \(.kind)\t\(.tabKey)  reason=\(.reason)"),
  (.failed[]   | "FAILED    \(.kind)\t\(.tabKey)  reason=\(.reason // "-")  status=\(.status // "-")  \(.error // "" | tostring)")'
restored=$(echo "$resp" | jq '.restored | length')
skipped=$(echo "$resp" | jq '.skipped | length')
failedn=$(echo "$resp" | jq '.failed | length')
echo "-- restored=${restored} skipped=${skipped} failed=${failedn}"
[[ "$failedn" == "0" ]] || exit 1
