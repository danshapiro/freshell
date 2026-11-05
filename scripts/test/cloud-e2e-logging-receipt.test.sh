#!/usr/bin/env bash
# Behavioral Cloud wrapper contract: jsonPayload receipts are required, retried
# through ingestion lag, and used to reject recovered Playwright retries.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT="$ROOT/scripts/e2e-cloud.sh"
WORK="$(mktemp -d /tmp/freshell-cloud-logging-receipt.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/capture"

cat > "$WORK/bin/gcloud" <<'GCLOUD'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$STUB_CAPTURE/gcloud.args"
case "$*" in
  "info "*) echo /nonexistent-sdk-root ;;
  *"artifacts docker images describe"*) exit 0 ;;
  *"builds submit"*) exit 0 ;;
  *"run jobs create"*)
    for arg in "$@"; do
      case "$arg" in
        --env-vars-file=*) cp "${arg#*=}" "$STUB_CAPTURE/run-env.yaml" ;;
      esac
    done
    exit 0 ;;
  *"run jobs delete"*) exit 0 ;;
  *"run jobs execute"*) echo "Execution [exec-json-receipt] has successfully completed." ;;
  *"executions logs read"*)
    count_file="$STUB_CAPTURE/logs.count"
    count="$(cat "$count_file" 2>/dev/null || echo 0)"; count=$((count + 1)); echo "$count" > "$count_file"
    if [ "${STUB_SCREENSHOT_DISPLAY:-0}" = 1 ]; then
      cat "$STUB_CAPTURE/screenshot-display.log"
      echo '{"event":"e2e_playwright_retry_trace_chunk","artifactId":"trace-original","offset":0,"data":"RETRY_TRACE_BYTES_SHOULD_STAY_RAW"}'
      echo '{"event":"ordinary_diagnostic","message":"keep readable diagnostic"}'
    fi
    if [ "${STUB_DELAY_PASSED_AFTER_SKIPPED_ONCE:-0}" = 1 ]; then
      echo "[e2e-entrypoint] Shard 1/1 assignment: focused fixture"
      echo "  3 skipped (1.0s)"
      if [ "$count" -gt 1 ]; then
        echo "  2 passed (5.0s)"
      fi
    elif [ "${STUB_SKIPPED_ONLY:-0}" = 1 ]; then
      echo "[e2e-entrypoint] Shard 1/1 assignment: focused fixture"
      echo "  3 skipped (1.0s)"
    elif [ "${STUB_EMPTY_SHARDS:-0}" = 1 ]; then
      echo "[e2e-entrypoint] Shard 1/4 assignment: focused fixture"
      echo "[e2e-entrypoint] Shard 2/4 assignment: focused fixture"
      echo "[e2e-entrypoint] Shard 3/4 assignment: focused fixture"
      echo "[e2e-entrypoint] Shard 4/4 assignment: focused fixture"
      echo "[e2e-entrypoint] No specs assigned to this shard. Exporting zero-test receipt."
      echo "  3 passed (2.0s)"
    elif [ "${STUB_DELAY_TASK_FOOTER_ONCE:-0}" = 1 ]; then
      echo "[e2e-entrypoint] Shard 1/2 assignment: focused fixture"
      echo "[e2e-entrypoint] Shard 2/2 assignment: focused fixture"
      echo "  2 passed (5.0s)"
      echo "  1 skipped (1.0s)"
      if [ "$count" -gt 1 ]; then
        echo "  3 passed (7.0s)"
      fi
    elif [ "${STUB_DELAY_INDEXED_DISPLAY_ONCE:-0}" = 1 ]; then
      echo "[e2e-entrypoint] Shard 1/1 assignment: focused fixture"
      if [ "$count" -gt 1 ]; then
        echo "  3 passed (42.9s)"
      fi
    elif [ "${STUB_DELAY_SUMMARY_ONCE:-0}" = 1 ] && [ "$count" -eq 1 ]; then
      echo "[e2e-entrypoint] Shard 1/2 assignment: focused fixture"
    else
      echo "[e2e-entrypoint] Shard 1/2 assignment: focused fixture"
      echo "  4 passed (12.3s)"
    fi ;;
  *"logging read"*)
    case "$*" in
      *'labels."run.googleapis.com/execution_name"="exec-json-receipt"'*) ;;
      *'labels.execution_name'*) echo "obsolete execution label" >&2; exit 9 ;;
      *) echo "missing or incorrect Cloud Run Jobs execution label" >&2; exit 9 ;;
    esac
    if [[ "$*" == *"textPayload =~"* ]]; then
      count_file="$STUB_CAPTURE/task-footers.count"
      count="$(cat "$count_file" 2>/dev/null || echo 0)"; count=$((count + 1)); echo "$count" > "$count_file"
      if [ "${STUB_NO_TASK_SUMMARY:-0}" = 1 ]; then
        echo '[]'
      elif [ "${STUB_DELAY_PASSED_AFTER_SKIPPED_ONCE:-0}" = 1 ]; then
        if [ "$count" -eq 1 ]; then
          cat <<'JSON'
[
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"  3 skipped (1.0s)"}
]
JSON
        else
          cat <<'JSON'
[
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"  3 skipped (1.0s)"},
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"  2 passed (5.0s)"}
]
JSON
        fi
      elif [ "${STUB_SKIPPED_ONLY:-0}" = 1 ]; then
        cat <<'JSON'
[
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"  3 skipped (1.0s)"}
]
JSON
      elif [ "${STUB_EMPTY_SHARDS:-0}" = 1 ]; then
        cat <<'JSON'
[
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"  3 passed (2.0s)"},
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"1"},"textPayload":"[e2e-entrypoint] No specs assigned to this shard. Exporting zero-test receipt."},
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"2"},"textPayload":"[e2e-entrypoint] No specs assigned to this shard. Exporting zero-test receipt."},
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"3"},"textPayload":"[e2e-entrypoint] No specs assigned to this shard. Exporting zero-test receipt."}
]
JSON
      elif [ "${STUB_DELAY_TASK_FOOTER_ONCE:-0}" = 1 ]; then
        if [[ "$*" == *'textPayload =~ "^[[:space:]]*'* ]]; then
          # Cloud Logging applies its filter to the raw payload, before ANSI
          # controls are stripped. The old anchored query misses this footer.
          echo '[]'
        elif [ "$count" -eq 1 ]; then
          cat <<'JSON'
[
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"\u001b[1A\u001b[2K  2 passed (5.0s)"},
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"\u001b[1A\u001b[2K  1 skipped (1.0s)"}
]
JSON
        else
          cat <<'JSON'
[
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"\u001b[1A\u001b[2K  2 passed (5.0s)"},
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"\u001b[1A\u001b[2K  1 skipped (1.0s)"},
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"1"},"textPayload":"\u001b[1A\u001b[2K  3 passed (7.0s)"}
]
JSON
        fi
      elif [ "${STUB_DELAY_INDEXED_DISPLAY_ONCE:-0}" = 1 ]; then
        cat <<'JSON'
[
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"\u001b[1A\u001b[2K  3 passed (42.9s)"}
]
JSON
      elif [ "${STUB_DELAY_SUMMARY_ONCE:-0}" = 1 ] && [ "$count" -eq 1 ]; then
        echo '[]'
      else
        cat <<'JSON'
[
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"0"},"textPayload":"  2 passed (5.0s)"},
 {"labels":{"run.googleapis.com/execution_name":"exec-json-receipt","run.googleapis.com/task_index":"1"},"textPayload":"  2 passed (7.0s)"}
]
JSON
      fi
      exit 0
    fi
    if [ "${STUB_LOGGING_FAIL:-0}" = 1 ]; then echo "logging unavailable" >&2; exit 7; fi
    count_file="$STUB_CAPTURE/logging.count"
    count="$(cat "$count_file" 2>/dev/null || echo 0)"; count=$((count + 1)); echo "$count" > "$count_file"
    if [ "${STUB_DELAY_ONCE:-0}" = 1 ] && [ "$count" -eq 1 ]; then echo '[]'; else printf '%s\n' "$STUB_LOGGING_JSON"; fi ;;
  *"executions describe"*)
    case "$*" in
      *completionTime*) echo "2026-10-13T00:00:01Z" ;;
      *failedCount*) echo 0 ;;
      *succeededCount*) echo "${STUB_SUCCEEDED:-2}" ;;
    esac ;;
  *) exit 0 ;;
esac
GCLOUD
chmod +x "$WORK/bin/gcloud"
cat > "$WORK/bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
# Poll retries are driven by fixture responses; real waiting adds no coverage.
exit 0
SLEEP
chmod +x "$WORK/bin/sleep"

records_no_retry='[
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":0,"taskCount":2,"recoveredRetryCount":0}},
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":1,"taskCount":2,"recoveredRetryCount":0}}
]'
records_one_task='[
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":0,"taskCount":1,"recoveredRetryCount":0}}
]'

node - "$WORK/capture" <<'NODE'
const fs = require('node:fs')
const zlib = require('node:zlib')
const root = process.argv[2]
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
  chunk('tEXt', Buffer.from('review\0' + 'large-review-note-'.repeat(1000))),
  chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0)),
])
const base64 = png.toString('base64')
const records = []
for (let offset = 0; offset < base64.length; offset += 12000) {
  const payload = { event: 'compact_panel_screenshot', severity: 'INFO', path: 'test-results/review.png', offset, data: base64.slice(offset, offset + 12000) }
  records.push(offset === 0 ? { jsonPayload: payload } : { textPayload: '[chromium] ' + JSON.stringify(payload) })
}
const payload = record => record.jsonPayload ?? JSON.parse(record.textPayload.slice(record.textPayload.indexOf('{')))
const displayedRecords = records.filter(record => record.textPayload)
fs.writeFileSync(root + '/screenshot-display.log', displayedRecords.map(record => record.textPayload).join('\n') + '\n')
fs.writeFileSync(root + '/displayed-chunks.txt', displayedRecords.map(record => payload(record).data).join('\n') + '\n')
NODE
OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_SCREENSHOT_DISPLAY=1 STUB_LOGGING_JSON="$records_no_retry" GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=2 2>&1)" || {
  echo "FAIL: screenshot-display wrapper run failed"; echo "$OUT"; exit 1
}
while IFS= read -r chunk; do
  [ -z "$chunk" ] && continue
  if grep -Fq "$chunk" <<< "$OUT"; then
    echo 'FAIL: default wrapper display leaked a screenshot payload chunk'; exit 1
  fi
done < "$WORK/capture/displayed-chunks.txt"
if grep -Fq 'RETRY_TRACE_BYTES_SHOULD_STAY_RAW' <<< "$OUT"; then
  echo 'FAIL: default wrapper display leaked retry-trace payload bytes'; exit 1
fi
for retained in compact_panel_screenshot test-results/review.png offset retained-in-cloud-logging ordinary_diagnostic 'keep readable diagnostic'; do
  if ! grep -Fq "$retained" <<< "$OUT"; then echo "FAIL: lost display metadata/diagnostic: $retained"; exit 1; fi
done
rm -f "$WORK/capture/logs.count" "$WORK/capture/logging.count" "$WORK/capture/task-footers.count" "$WORK/capture/gcloud.args" "$WORK/capture/run-env.yaml"

# --dry-run is an entrypoint diagnostic: it deliberately does not run
# Playwright and therefore cannot emit a completion receipt. The wrapper must
# still prove that Cloud Run completed every requested task, but it must not
# turn the absence of an execution receipt into a false failure. Split-form
# Playwright flags must remain normalized in the per-run environment.
rm -f "$WORK/capture/gcloud.args" "$WORK/capture/logging.count" "$WORK/capture/run-env.yaml"
DRY_SINGLE_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_SUCCEEDED=1 GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=1 --project chromium --dry-run 2>&1)" || {
  echo "FAIL: one-task cloud --dry-run failed despite a successful Cloud Run task"; echo "$DRY_SINGLE_OUT"; exit 1
}
if ! grep -q "All tasks completed successfully" <<< "$DRY_SINGLE_OUT" \
  || ! grep -q "Skipping structured retry-receipt reconciliation for --dry-run" <<< "$DRY_SINGLE_OUT"; then
  echo "FAIL: one-task cloud --dry-run did not report diagnostic success without receipt reconciliation"
  echo "$DRY_SINGLE_OUT"; exit 1
fi
if [ -e "$WORK/capture/logging.count" ] || grep -Fq 'logging read' "$WORK/capture/gcloud.args"; then
  echo "FAIL: cloud --dry-run queried structured retry receipts even though no Playwright task ran"
  cat "$WORK/capture/gcloud.args"; exit 1
fi
if ! grep -Fxq '  --project=chromium' "$WORK/capture/run-env.yaml" \
  || ! grep -Fxq '  --dry-run' "$WORK/capture/run-env.yaml"; then
  echo "FAIL: cloud --dry-run did not preserve normalized split-form arguments in PLAYWRIGHT_ARGS"
  cat "$WORK/capture/run-env.yaml"; exit 1
fi

rm -f "$WORK/capture/gcloud.args" "$WORK/capture/logging.count"
DRY_MULTI_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_SUCCEEDED=4 GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=4 --grep 'focused smoke' --dry-run 2>&1)" || {
  echo "FAIL: multi-task cloud --dry-run failed despite all Cloud Run tasks succeeding"; echo "$DRY_MULTI_OUT"; exit 1
}
if ! grep -q "Succeeded tasks: 4" <<< "$DRY_MULTI_OUT" \
  || [ -e "$WORK/capture/logging.count" ] \
  || grep -Fq 'logging read' "$WORK/capture/gcloud.args"; then
  echo "FAIL: multi-task cloud --dry-run did not retain task-success checks while skipping receipt reconciliation"
  echo "$DRY_MULTI_OUT"; cat "$WORK/capture/gcloud.args"; exit 1
fi
if ! grep -Fxq '  --grep=focused smoke' "$WORK/capture/run-env.yaml" \
  || ! grep -Fxq '  --dry-run' "$WORK/capture/run-env.yaml"; then
  echo "FAIL: multi-task cloud --dry-run did not preserve normalized split-form grep arguments"
  cat "$WORK/capture/run-env.yaml"; exit 1
fi

rm -f "$WORK/capture/logs.count"
OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_DELAY_ONCE=1 STUB_DELAY_SUMMARY_ONCE=1 STUB_LOGGING_JSON="$records_no_retry" GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=2 2>&1)" || {
  echo "FAIL: delayed structured receipt run failed"; echo "$OUT"; exit 1
}
if ! grep -q "All tasks completed successfully" <<< "$OUT"; then
  echo "FAIL: complete delayed structured receipts did not allow success"; echo "$OUT"; exit 1
fi
if [ "$(cat "$WORK/capture/logging.count")" -lt 2 ]; then
  echo "FAIL: wrapper did not retry delayed Cloud Logging receipt ingestion"; cat "$WORK/capture/gcloud.args"; exit 1
fi
if [ "$(cat "$WORK/capture/logs.count")" -lt 2 ] || ! grep -q "4 passed (12.3s)" <<< "$OUT"; then
  echo "FAIL: wrapper did not retry its display-log read until the Playwright footer arrived"; echo "$OUT"; cat "$WORK/capture/gcloud.args"; exit 1
fi
if ! grep -Fq 'labels."run.googleapis.com/execution_name"="exec-json-receipt"' "$WORK/capture/gcloud.args" \
  || grep -Fq 'labels.execution_name' "$WORK/capture/gcloud.args"; then
  echo "FAIL: wrapper did not issue a structured jsonPayload Cloud Logging query scoped to its execution"
  cat "$WORK/capture/gcloud.args"; exit 1
fi

# Multiple summary lines can come from one Cloud Run task. The per-task JSON
# records below attribute both task 0 statuses to index 0; task 1 is absent on
# the first query and appears on the next query. The merged display output has
# no task identity, so it must not satisfy the two-task requirement by count.
rm -f "$WORK/capture/logs.count" "$WORK/capture/logging.count" "$WORK/capture/task-footers.count" "$WORK/capture/gcloud.args"
TASK_SCOPED_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_DELAY_TASK_FOOTER_ONCE=1 STUB_LOGGING_JSON="$records_no_retry" GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=2 2>&1)" || {
  echo "FAIL: two-task run with a delayed second task footer failed"; echo "$TASK_SCOPED_OUT"; exit 1
}
TASK_FOOTER_READS="$(cat "$WORK/capture/task-footers.count" 2>/dev/null || echo 0)"
if [ "$TASK_FOOTER_READS" -ne 2 ] \
  || [ "$(cat "$WORK/capture/logs.count")" -lt 2 ] \
  || grep -q "task-indexed Playwright footer or empty-shard evidence" <<< "$TASK_SCOPED_OUT" \
  || ! grep -q "1 skipped (1.0s)" <<< "$TASK_SCOPED_OUT" \
  || ! grep -q "3 passed (7.0s)" <<< "$TASK_SCOPED_OUT"; then
  echo "FAIL: multiple task 0 footer lines incorrectly satisfied the two-task summary wait"
  echo "$TASK_SCOPED_OUT"; cat "$WORK/capture/gcloud.args"; exit 1
fi

# Task-indexed Cloud Logging can have the footer before the human-formatted
# executions-log read catches up. The accepted per-shard summary must come
# from the indexed payload so that a stale display read cannot erase it.
rm -f "$WORK/capture/logs.count" "$WORK/capture/logging.count" "$WORK/capture/task-footers.count" "$WORK/capture/gcloud.args"
INDEXED_EARLY_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_DELAY_INDEXED_DISPLAY_ONCE=1 STUB_LOGGING_JSON="$records_one_task" STUB_SUCCEEDED=1 GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=1 2>&1)" || {
  echo "FAIL: one-task run with an early indexed footer failed"; echo "$INDEXED_EARLY_OUT"; exit 1
}
INDEXED_SUMMARY="$(sed -n '/^\[e2e-cloud\] Per-shard summary:$/,/^\[e2e-cloud\] Succeeded tasks:/p' <<< "$INDEXED_EARLY_OUT")"
if [ "$(cat "$WORK/capture/logs.count" 2>/dev/null || echo 0)" -ne 1 ] \
  || ! grep -Fq '[Cloud Run task 0]' <<< "$INDEXED_SUMMARY" \
  || ! grep -Fq '3 passed (42.9s)' <<< "$INDEXED_SUMMARY"; then
  echo "FAIL: wrapper summary omitted a task-attributed footer already present in Cloud Logging"; echo "$INDEXED_EARLY_OUT"; cat "$WORK/capture/gcloud.args"; exit 1
fi

records_empty_shards='[
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":0,"taskCount":4,"recoveredRetryCount":0}},
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":1,"taskCount":4,"recoveredRetryCount":0}},
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":2,"taskCount":4,"recoveredRetryCount":0}},
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":3,"taskCount":4,"recoveredRetryCount":0}}
]'
EMPTY_SHARDS_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_EMPTY_SHARDS=1 STUB_LOGGING_JSON="$records_empty_shards" STUB_SUCCEEDED=4 GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=4 2>&1)" || {
  echo "FAIL: a narrow multi-task run with empty shards did not accept one zero-retry receipt for each task"; echo "$EMPTY_SHARDS_OUT"; exit 1
}
if ! grep -q "All tasks completed successfully" <<< "$EMPTY_SHARDS_OUT" \
  || ! grep -q "3 passed (2.0s)" <<< "$EMPTY_SHARDS_OUT" \
  || ! grep -q "No specs assigned to this shard" <<< "$EMPTY_SHARDS_OUT" \
  || grep -q "task-indexed Playwright footer or empty-shard evidence" <<< "$EMPTY_SHARDS_OUT"; then
  echo "FAIL: empty shards beside a passing task did not retain completion semantics"; echo "$EMPTY_SHARDS_OUT"; exit 1
fi

SKIPPED_ONLY_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_SKIPPED_ONLY=1 STUB_LOGGING_JSON="$records_one_task" STUB_SUCCEEDED=1 GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=1 2>&1)" && SKIPPED_ONLY_RC=0 || SKIPPED_ONLY_RC=$?
if [ "$SKIPPED_ONLY_RC" -eq 0 ] || ! grep -q "no passed Playwright tests" <<< "$SKIPPED_ONLY_OUT"; then
  echo "FAIL: skipped-only Playwright evidence was accepted as a passing Cloud run"; echo "$SKIPPED_ONLY_OUT"; exit 1
fi

rm -f "$WORK/capture/logs.count" "$WORK/capture/task-footers.count"
DELAYED_PASS_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_DELAY_PASSED_AFTER_SKIPPED_ONCE=1 STUB_LOGGING_JSON="$records_one_task" STUB_SUCCEEDED=1 GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=1 2>&1)" && DELAYED_PASS_RC=0 || DELAYED_PASS_RC=$?
if [ "$DELAYED_PASS_RC" -ne 0 ] \
  || [ "$(cat "$WORK/capture/task-footers.count" 2>/dev/null || echo 0)" -ne 2 ] \
  || ! grep -q "3 skipped (1.0s)" <<< "$DELAYED_PASS_OUT" \
  || ! grep -q "2 passed (5.0s)" <<< "$DELAYED_PASS_OUT" \
  || ! grep -q "All tasks completed successfully" <<< "$DELAYED_PASS_OUT"; then
  echo "FAIL: wrapper stopped polling after a skipped footer instead of waiting for the same task's later passed footer"; echo "$DELAYED_PASS_OUT"; exit 1
fi

NO_TASK_SUMMARY_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_NO_TASK_SUMMARY=1 STUB_LOGGING_JSON="$records_no_retry" STUB_SUCCEEDED=2 GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=2 2>&1)" && NO_TASK_SUMMARY_RC=0 || NO_TASK_SUMMARY_RC=$?
if [ "$NO_TASK_SUMMARY_RC" -eq 0 ] || ! grep -q "required task-indexed Playwright summary evidence was not present" <<< "$NO_TASK_SUMMARY_OUT"; then
  echo "FAIL: a Cloud run without complete task-indexed Playwright summaries was accepted"; echo "$NO_TASK_SUMMARY_OUT"; exit 1
fi

records_retry='[
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":0,"taskCount":2,"recoveredRetryCount":0}},
 {"jsonPayload":{"event":"e2e_playwright_retry_evidence","execution":"exec-json-receipt","taskIndex":1,"taskCount":2,"failureAttempt":0,"error":{"stack":"first failure"},"trace":{"traceAttempt":0,"retained":false}}},
 {"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"exec-json-receipt","taskIndex":1,"taskCount":2,"recoveredRetryCount":1}}
]'
rm -f "$WORK/capture/logging.count"
RETRY_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_LOGGING_JSON="$records_retry" GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=2 2>&1)" && RETRY_RC=0 || RETRY_RC=$?
if [ "$RETRY_RC" -eq 0 ] || ! grep -q "recovered Playwright retry evidence prevents a zero-flake" <<< "$RETRY_OUT"; then
  echo "FAIL: structured recovered retry did not fail the zero-flake receipt"; echo "$RETRY_OUT"; exit 1
fi

ERROR_OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_LOGGING_FAIL=1 GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=2 2>&1)" && ERROR_RC=0 || ERROR_RC=$?
if [ "$ERROR_RC" -eq 0 ] || ! grep -q "could not retrieve complete structured retry receipts" <<< "$ERROR_OUT"; then
  echo "FAIL: Cloud Logging read failure was accepted as zero retry evidence"; echo "$ERROR_OUT"; exit 1
fi

echo "PASS: Cloud wrapper requires structured delayed task receipts and rejects recovered retries"
