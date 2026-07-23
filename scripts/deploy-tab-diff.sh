#!/usr/bin/env bash
# deploy-tab-diff.sh -- pre/post-restart tab identity ritual (continuity trio
# deliverable 3, docs/plans/2026-07-22-continuity-safety-trio.md).
#
#   scripts/deploy-tab-diff.sh capture --url U --token T --out before.json
#   ... restart/deploy the server ...
#   scripts/deploy-tab-diff.sh verify  --url U --token T --before before.json
#
# READ-ONLY against the server (GETs only). Exit non-zero on any divergence.
# NEVER point this at a server you do not operate. Requires curl + jq.
set -euo pipefail

CMD="${1:-}"; shift || true
URL="" TOKEN="${FRESHELL_TOKEN:-}" OUT="" BEFORE="" AFTER_IN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --before) BEFORE="$2"; shift 2 ;;
    --after) AFTER_IN="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$URL" && -n "$TOKEN" ]] || { echo "ERROR: --url and --token are required" >&2; exit 2; }
auth=(-H "x-auth-token: ${TOKEN}")

# Capture live server state. Device ids are read NUL-delimited (arbitrary ids may
# contain spaces/slashes), each is URL-encoded for its path segment, and the
# growing documents are streamed into jq via temp files + --slurpfile (never
# --argjson, which would exceed ARG_MAX at ~1 MiB-per-client scale).
#
# LOGICALLY COHERENT (:40): the generation index is fetched ONCE and .bundles
# is derived from THAT snapshot of it; after every other fetch completes, the
# index is re-fetched and compared -- if a tabs-sync push landed mid-capture
# (the two indexes disagree on any device's generation set), the capture is
# INCOHERENT and returns 3 so the caller can retry, never emitting an artifact
# whose .devices and .bundles describe different generations.
fetch_state() {
  local snaps_tmp snaps2_tmp dev_tmp term_tmp out_tmp d enc snap_tmp
  snaps_tmp=$(mktemp); snaps2_tmp=$(mktemp); dev_tmp=$(mktemp); term_tmp=$(mktemp); out_tmp=$(mktemp)
  _cleanup_fetch() { rm -f "$snaps_tmp" "$snaps2_tmp" "$dev_tmp" "$term_tmp" "$out_tmp"; }
  # EXPLICIT curl/jq status checks throughout (never rely on `set -e` propagating
  # through a function called in an `if`, nor through process substitution -- the
  # :2544 failure-masking hazard). Any failure -> return 1, no partial artifact.
  if ! curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots" > "$snaps_tmp"; then
    echo "ERROR: GET /api/tabs-sync/snapshots failed" >&2; _cleanup_fetch; return 1; fi
  jq -e . "$snaps_tmp" >/dev/null || { echo "ERROR: /snapshots not JSON" >&2; _cleanup_fetch; return 1; }
  printf '{}' > "$dev_tmp"
  while IFS= read -r -d '' d; do
    [[ -n "$d" ]] || continue
    enc=$(jq -rn --arg d "$d" '$d|@uri')
    snap_tmp=$(mktemp)
    if ! curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots/${enc}" > "$snap_tmp"; then
      echo "ERROR: GET /snapshots/$d failed" >&2; rm -f "$snap_tmp"; _cleanup_fetch; return 1; fi
    if ! jq --arg d "$d" --slurpfile s "$snap_tmp" '. + {($d): $s[0]}' "$dev_tmp" > "${dev_tmp}.new"; then
      echo "ERROR: merge failed for device $d" >&2; rm -f "$snap_tmp"; _cleanup_fetch; return 1; fi
    mv "${dev_tmp}.new" "$dev_tmp"
    rm -f "$snap_tmp"
  done < <(jq -j '.devices[].deviceId | . + "\u0000"' "$snaps_tmp")
  # GET /api/terminals with NO read-model query params returns a RAW ARRAY
  # (terminals.rs:414); `.items` would be null. Keep the array as-is.
  if ! curl -fsS "${auth[@]}" "${URL}/api/terminals" > "$term_tmp"; then
    echo "ERROR: GET /api/terminals failed" >&2; _cleanup_fetch; return 1; fi
  jq -e 'type=="array"' "$term_tmp" >/dev/null \
    || { echo "ERROR: /terminals not an array" >&2; _cleanup_fetch; return 1; }
  # COHERENCE GATE (:40): re-fetch the index and compare the generation sets.
  # generationIds are content digests, so identical projections mean every
  # fetch above happened against one logical state (an A-B-A flip would mean
  # identical content -- still coherent by construction).
  if ! curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots" > "$snaps2_tmp"; then
    echo "ERROR: coherence re-fetch of /api/tabs-sync/snapshots failed" >&2; _cleanup_fetch; return 1; fi
  local proj='[.devices[] | { deviceId, gens: ([.generations[].generationId] | sort) }] | sort_by(.deviceId)'
  if [[ "$(jq -cS "$proj" "$snaps_tmp")" != "$(jq -cS "$proj" "$snaps2_tmp")" ]]; then
    echo "WARN: generation index changed mid-capture (concurrent tabs-sync push); capture incoherent" >&2
    _cleanup_fetch; return 3; fi
  # Assemble the capture doc INCLUDING the immutable per-device bundle: the exact
  # set of per-client component generation ids at capture (all clients), so
  # remediation restores the SAME coherent union, never a single client (:2621).
  # Both .devices and .bundles derive from the SAME pinned index snapshot.
  # Newest-per-client tie-break MIRRORS the server's `newest_per_client`
  # (crates/freshell-ws/src/tabs_persist.rs): higher capturedAt wins; an equal-
  # millisecond tie is broken by the greater filename, which for one client's
  # files (same encoded prefix) is exactly the greater zero-padded
  # snapshotRevision -- so max_by([capturedAt, snapshotRevision]) is the exact
  # mirror (:69), never max_by(capturedAt) alone.
  if ! jq -n --arg url "$URL" --slurpfile devices "$dev_tmp" --slurpfile terminals "$term_tmp" \
       --slurpfile snaps "$snaps_tmp" '
       { capturedAt: (now * 1000 | floor), url: $url,
         devices: $devices[0], terminals: $terminals[0],
         bundles: ($snaps[0].devices | map({ key: .deviceId, value: {
           components: (.generations | group_by(.clientInstanceId)
                        | map(max_by([.capturedAt, .snapshotRevision]) | .generationId)),
           capturedAt: (.capturedAt // 0) } }) | from_entries) }' > "$out_tmp"; then
    echo "ERROR: assembling capture JSON failed" >&2; _cleanup_fetch; return 1; fi
  cat "$out_tmp"
  _cleanup_fetch
}

# fetch_state with a bounded retry on the mid-capture-coherence failure (rc 3).
# Any other failure is immediate (rc 1).
fetch_state_coherent() {
  local attempt rc
  for attempt in 1 2 3; do
    rc=0; fetch_state || rc=$?
    [[ $rc -eq 3 ]] || return "$rc"
    echo "WARN: retrying capture (attempt $((attempt + 1))/3) after mid-capture change" >&2
  done
  echo "ERROR: generation index kept changing across 3 capture attempts; server too busy to capture coherently" >&2
  return 1
}

case "$CMD" in
  capture)
    [[ -n "$OUT" ]] || { echo "ERROR: capture requires --out FILE" >&2; exit 2; }
    # ATOMIC (:2544/:82): fetch into a TEMP file created IN THE DESTINATION
    # DIRECTORY (mktemp defaults to /tmp, which may be a different filesystem;
    # a cross-device mv is copy+unlink, NOT atomic), validate it parses + has
    # the expected shape, THEN rename over the final artifact -- a same-fs
    # rename is atomic. Any failure leaves a prior good $OUT UNTOUCHED and
    # exits nonzero.
    tmp_out=$(mktemp "$(dirname "$OUT")/.$(basename "$OUT").XXXXXX")
    if ! fetch_state_coherent > "$tmp_out"; then
      echo "ERROR: capture failed (server unreachable/invalid/incoherent); previous $OUT left UNTOUCHED" >&2
      rm -f "$tmp_out"; exit 1
    fi
    if ! jq -e '(.devices|type=="object") and (.terminals|type=="array") and (.capturedAt|type=="number")' \
         "$tmp_out" >/dev/null; then
      echo "ERROR: capture produced invalid/empty JSON; previous $OUT left UNTOUCHED" >&2
      rm -f "$tmp_out"; exit 1
    fi
    mv "$tmp_out" "$OUT"   # atomic rename over the final artifact
    ndev=$(jq '.devices | length' "$OUT")
    nrun=$(jq '[.terminals[] | select(.status=="running")] | length' "$OUT")
    echo "captured ${ndev} device snapshot(s), ${nrun} running terminal(s) -> $OUT"
    ;;
  verify)
    [[ -n "$BEFORE" && -f "$BEFORE" ]] || { echo "ERROR: verify requires --before FILE" >&2; exit 2; }
    # AFTER: synthetic (--after, offline diff-engine test) or live fetch.
    AFTER_OWNED=false
    if [[ -n "$AFTER_IN" ]]; then
      [[ -f "$AFTER_IN" ]] || { echo "ERROR: --after FILE not found" >&2; exit 2; }
      AFTER="$AFTER_IN"
    else
      AFTER=$(mktemp); AFTER_OWNED=true
      if ! fetch_state_coherent > "$AFTER"; then echo "ERROR: fetching AFTER state failed" >&2; rm -f "$AFTER"; exit 1; fi
    fi
    # Guard form (not `$AFTER_OWNED && rm`): with --after supplied AFTER_OWNED is
    # false, and a bare `false && ...` returns 1 -- under `set -e` that would kill
    # the OK path with exit 1 before its `exit 0`.
    cleanup() { if $AFTER_OWNED; then rm -f "$AFTER"; fi; }

    # Coverage guard (:2559): compute the COMPLETE set of running terminals at
    # capture that are covered by NO persisted snapshot pane, and FAIL listing them
    # if that set is nonempty. `. as $t | $covered | index($t)` binds the id to a
    # variable BEFORE indexing -- piping into `$covered` would otherwise rebind `.`
    # to the array and search it for ITSELF (the :2563 scoping bug).
    uncovered=$(jq -r '
      ([.terminals[] | select(.status=="running") | .terminalId]) as $live
      | ([.devices | to_entries[] | .value.records // [] | .[]
           | select(.status=="open") | .panes // [] | .[]
           | .payload.liveTerminal.terminalId | select(. != null)]) as $covered
      | [ $live[] | select(. as $t | ($covered | index($t)) == null) ] | .[]' "$BEFORE")
    if [[ -n "$uncovered" ]]; then
      n=$(printf '%s\n' "$uncovered" | grep -c .)
      echo "FAIL: ${n} running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):" >&2
      printf '%s\n' "$uncovered" | sed 's/^/  - /' >&2
      cleanup; exit 1
    fi

    # Pane-by-pane identity diff. "live" == status=="running" (exited terminals
    # are filtered out so they never cause a false NOT RESPAWNED). A pane counts
    # only if it carried session identity OR was ACTUALLY running at capture.
    DIFF=$(jq -n --slurpfile b "$BEFORE" --slurpfile a "$AFTER" '
      # $dev/$snap are VALUE params (bound at the call site): plain filter params
      # are lazy closures re-evaluated against the CURRENT input, so `dev` (.key)
      # would evaluate against the pane object and yield null for every pane,
      # breaking the device column and the per-device remediation lookup.
      def panes($dev; $snap):
        ($snap.records // [])[] | select(.status == "open") as $rec
        | ($rec.panes // [])[]
        | {device: $dev, tabKey: $rec.tabKey, tabName: $rec.tabName, paneId: .paneId,
           kind: .kind, sessionRef: .payload.sessionRef,
           liveTerminalId: .payload.liveTerminal.terminalId};
      ($b[0].terminals | map(select(.status=="running") | .terminalId)) as $liveBefore
      | ($a[0].terminals | map(select(.status=="running") | .terminalId)) as $liveNow
      | ($b[0].devices | to_entries | map(panes(.key; .value)) | flatten) as $before
      | ($a[0].devices | to_entries | map(panes(.key; .value)) | flatten) as $after
      | [ $before[]
          | . as $bp
          | (($bp.sessionRef != null)
             or ($bp.liveTerminalId != null and (($liveBefore | index($bp.liveTerminalId)) != null))) as $counted
          | select($counted)
          | ($after | map(select(.tabKey == $bp.tabKey and .paneId == $bp.paneId)) | first) as $ap
          | if $ap == null then
              {verdict: "MISSING", pane: $bp}
            elif ($bp.sessionRef != null and $ap.sessionRef == null) then
              {verdict: "FRESH (identity lost)", pane: $bp}
            elif ($bp.sessionRef != null and $ap.sessionRef != null
                  and ($bp.sessionRef.provider != $ap.sessionRef.provider
                       or $bp.sessionRef.sessionId != $ap.sessionRef.sessionId)) then
              {verdict: "RE-POINTED", pane: $bp, after: $ap.sessionRef}
            elif ($bp.liveTerminalId != null and (($liveBefore | index($bp.liveTerminalId)) != null)
                  and (($ap.liveTerminalId == null) or (($liveNow | index($ap.liveTerminalId)) == null))) then
              {verdict: "NOT RESPAWNED", pane: $bp}
            else empty end ]')
    COUNT=$(jq 'length' <<<"$DIFF")
    if [[ "$COUNT" == "0" ]]; then
      echo "OK: every previously-live pane came back with the same session identity."
      cleanup; exit 0
    fi
    echo "================ TAB-DIFF DIVERGENCE (${COUNT}) ================"
    jq -r '.[] | "\(.verdict)\tdevice=\(.pane.device)\ttab=\(.pane.tabName) (\(.pane.tabKey))\tpane=\(.pane.paneId)\tkind=\(.pane.kind)\twas=\(.pane.sessionRef.provider // "-"):\(.pane.sessionRef.sessionId // "-")\(if .after then "\tnow=\(.after.provider):\(.after.sessionId)" else "" end)"' <<<"$DIFF"
    echo "================================================================"
    # Remediation is TARGETED (:175): it restores ONLY the diverged panes (one
    # --pane per diverged paneKey, the restore API's selective mode) from the
    # IMMUTABLE multi-client BUNDLE recorded in the BEFORE capture (the exact
    # set of per-client component generation ids at capture), via --components
    # -- the SAME coherent union the capture saw, NEVER a single client's
    # generationId (:2621), and never the WHOLE union (which would duplicate
    # every still-healthy pane). Everything is read from the BEFORE file +
    # $DIFF, so verify performs ZERO network operations in --after/offline
    # mode (:2619).
    echo "REMEDIATION (rebuild each diverged device's MISSING panes from its captured immutable bundle):"
    while IFS= read -r -d '' dev; do
      comps=$(jq -r --arg d "$dev" '(.bundles[$d].components // []) | join(",")' "$BEFORE")
      if [[ -z "$comps" ]]; then
        printf 'ERROR: no captured bundle for device %q in the before-file; cannot recommend a union-consistent restore.\n' "$dev" >&2
        continue
      fi
      pane_args=""
      while IFS= read -r -d '' pk; do
        pane_args+=$(printf ' --pane %q' "$pk")
      done < <(jq -j --arg d "$dev" \
        '[.[] | select(.pane.device == $d) | "\(.pane.tabKey)#\(.pane.paneId)"] | unique | .[] | . + "\u0000"' \
        <<<"$DIFF")
      printf '  scripts/restore-tabs.sh --url %q --token <TOKEN> --device %q --components %s%s\n' \
        "$URL" "$dev" "$comps" "$pane_args"
    done < <(jq -j '[.[].pane.device] | unique | .[] | . + "\u0000"' <<<"$DIFF")
    cleanup; exit 1
    ;;
  *)
    echo "usage: deploy-tab-diff.sh {capture|verify} --url U --token T [--out F | --before F [--after F]]" >&2
    exit 2 ;;
esac
