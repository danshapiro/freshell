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
PANES=()   # repeatable --pane "tabKey#paneId": restore ONLY these panes (targeted remediation)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --generation) GENERATION="$2"; shift 2 ;;
    --generation-id) GENERATION_ID="$2"; shift 2 ;;
    --components) COMPONENTS="$2"; shift 2 ;;   # comma-separated generation ids (the deploy bundle)
    --pane) PANES+=("$2"); shift 2 ;;           # repeatable; server rejects unknown keys fail-closed
    --dry-run) DRY_RUN=true; shift ;;
    --list) LIST=true; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$URL" ]] || { echo "ERROR: --url is required" >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "ERROR: --token (or FRESHELL_TOKEN) is required" >&2; exit 2; }

auth=(-H "x-auth-token: ${TOKEN}")

# Print a loud failure WITHOUT masking the server's refusal: curl runs with
# --fail-with-body so an HTTP error still yields the response body, and the
# server's explanation (e.g. the 409 "restore requires exactly one connected
# browser" gate) reaches the operator. Prefers the JSON .message/.error field,
# falls back to the raw body, and keeps the generic hint when there is no body.
#   $1 = what failed, $2 = generic hint, $3 = response body (may be empty)
fail_loud() {
  local msg=""
  if [[ -n "$3" ]]; then
    msg=$(jq -r '.message // .error // empty' <<<"$3" 2>/dev/null) || msg=""
    printf 'ERROR: %s: %s\n' "$1" "${msg:-$3}" >&2
  else
    printf 'ERROR: %s (%s)\n' "$1" "$2" >&2
  fi
  exit 1
}

if $LIST; then
  resp=$(curl --fail-with-body -sS "${auth[@]}" "${URL}/api/tabs-sync/snapshots") ||
    fail_loud "list request failed" "URL/token correct? server up?" "${resp:-}"
  jq -r '
    .devices[] | .deviceId as $d | .generations[] |
    "\($d)\tgen=\(.generation)\tid=\(.generationId)\trev=\(.snapshotRevision)\trecords=\(.recordCount)\tcapturedAt=\(.capturedAt)\tlabel=\(.deviceLabel)"' <<<"$resp"
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
# Targeted remediation (deploy-tab-diff): restore ONLY the named panes. Each
# --pane value becomes one JSON string; the server 400s on unknown keys and
# reports unselected panes as skipped{not-selected} -- never a silent drop.
if [[ ${#PANES[@]} -gt 0 ]]; then
  panes_json=$(printf '%s\0' "${PANES[@]}" | jq -Rs 'split("\u0000") | map(select(length>0))')
  body=$(jq --argjson p "$panes_json" '. + {panes: $p}' <<<"$body")
  sel="$sel panes=${#PANES[@]}"
fi
resp=$(curl --fail-with-body -sS "${auth[@]}" -H 'content-type: application/json' \
  -d "$body" "${URL}/api/tabs-sync/restore") ||
  fail_loud "restore request failed" "is the snapshot/device id right? try --list" "${resp:-}"

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
