#!/usr/bin/env bash
# Behavioral contract: a Playwright retry that ultimately passes must leave
# the first failed attempt's stack and trace bytes in durable JSONL output.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RECEIPT="$ROOT/scripts/e2e-cloud-retry-receipt.mjs"

WORK="$(mktemp -d /tmp/freshell-cloud-retry-receipt.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

TRACE="$WORK/first-retry-trace.zip"
UNRELATED_TRACE="$WORK/retry-success-trace.zip"
REPORT="$WORK/report.json"
OUT="$WORK/receipt.jsonl"
head -c 196608 /dev/urandom > "$TRACE"
printf 'unrelated successful retry trace\n' > "$UNRELATED_TRACE"

cat > "$REPORT" <<JSON
{
  "stats": { "expected": 0, "skipped": 0, "unexpected": 0, "flaky": 1 },
  "suites": [{
    "title": "retry fixture",
    "specs": [{
      "title": "recovers on the first retry",
      "file": "test/e2e-browser/specs/retry-fixture.spec.ts",
      "line": 42,
      "tests": [{
        "projectName": "chromium",
        "status": "flaky",
        "results": [
          {
            "status": "failed",
            "retry": 0,
            "errors": [{
              "message": "expected ready state",
              "stack": "Error: expected ready state\\n    at retry-fixture.spec.ts:42:9"
            }],
            "attachments": [{
              "name": "trace",
              "contentType": "application/zip",
              "path": "$TRACE"
            }]
          },
          {
            "status": "passed",
            "retry": 1,
            "attachments": [{
              "name": "trace",
              "contentType": "application/zip",
              "path": "$UNRELATED_TRACE"
            }]
          }
        ]
      }]
    }]
  }]
}
JSON

if [ ! -f "$RECEIPT" ]; then
  echo "FAIL: retry-receipt exporter does not exist: $RECEIPT"
  exit 1
fi

CLOUD_RUN_EXECUTION=retry-receipt-probe CLOUD_RUN_TASK_INDEX=2 CLOUD_RUN_TASK_COUNT=4 \
  node "$RECEIPT" "$REPORT" > "$OUT"

SUMMARY="$(jq -c 'select(.event == "e2e_playwright_retry_evidence")' "$OUT")"
if [ -z "$SUMMARY" ]; then
  echo "FAIL: successful retry emitted no durable retry-evidence summary"
  cat "$OUT"
  exit 1
fi

if ! jq -e '
  .severity == "WARNING"
  and .taskIndex == 2
  and .taskCount == 4
  and .execution == "retry-receipt-probe"
  and .attempt == 0
  and .failureAttempt == 0
  and .trace.traceAttempt == 0
  and .test.title == "recovers on the first retry"
  and (.error.stack | contains("expected ready state"))
  and .trace.storage == "cloud-logging-jsonl-chunks"
  and (.trace.artifactId | startswith("playwright-retry-trace-"))
' <<< "$SUMMARY" >/dev/null; then
  echo "FAIL: retry summary did not preserve the first-attempt stack and durable trace reference"
  echo "$SUMMARY"
  exit 1
fi

CHUNKS="$(jq -c 'select(.event == "e2e_playwright_retry_trace_chunk")' "$OUT")"
if [ -z "$CHUNKS" ]; then
  echo "FAIL: successful retry emitted no durable trace chunks"
  cat "$OUT"
  exit 1
fi

if ! jq -s -e '
  [.[] | select(.event == "e2e_playwright_retry_trace_chunk")] as $chunks
  | ($chunks | length) > 1
    and all($chunks[]; ((tojson | length) < 100000) and ((.data | length) <= 65536))
' "$OUT" >/dev/null; then
  echo "FAIL: retry trace JSONL chunks exceed Cloud Logging's safe entry size"
  exit 1
fi

RECONSTRUCTED="$WORK/reconstructed-trace.zip"
jq -r 'select(.event == "e2e_playwright_retry_trace_chunk") | .data' "$OUT" \
  | base64 --decode > "$RECONSTRUCTED"
cmp -s "$TRACE" "$RECONSTRUCTED" || {
  echo "FAIL: retained trace chunks do not reconstruct the first-retry trace"
  exit 1
}

COMPLETION="$(jq -c 'select(.event == "e2e_playwright_task_complete")' "$OUT")"
if ! jq -e '
  .execution == "retry-receipt-probe"
  and .taskIndex == 2
  and .taskCount == 4
  and .recoveredRetryCount == 1
' <<< "$COMPLETION" >/dev/null; then
  echo "FAIL: exporter did not emit an exact task completion receipt"
  cat "$OUT"
  exit 1
fi

printf '{}' > "$WORK/malformed-report.json"
if CLOUD_RUN_EXECUTION=retry-receipt-probe CLOUD_RUN_TASK_INDEX=2 CLOUD_RUN_TASK_COUNT=4 \
  node "$RECEIPT" "$WORK/malformed-report.json" >/dev/null 2>&1; then
  echo "FAIL: structurally incomplete Playwright JSON report was accepted"
  exit 1
fi
for incomplete_report in \
  '{"stats":{"expected":0},"suites":{}}' \
  '{"stats":{"expected":1},"suites":[{}]}' \
  '{"stats":{"expected":1},"suites":[{"specs":[{"tests":[{}]}]}]}'; do
  printf '%s' "$incomplete_report" > "$WORK/incomplete-report.json"
  if CLOUD_RUN_EXECUTION=retry-receipt-probe CLOUD_RUN_TASK_INDEX=2 CLOUD_RUN_TASK_COUNT=4 \
    node "$RECEIPT" "$WORK/incomplete-report.json" >/dev/null 2>&1; then
    echo "FAIL: wrong-typed suites, missing specs, or missing results were accepted"
    exit 1
  fi
done

printf '%s' '{"stats":{"expected":1,"skipped":0,"unexpected":0,"flaky":0},"suites":[]}' > "$WORK/truncated-report.json"
if CLOUD_RUN_EXECUTION=retry-receipt-probe CLOUD_RUN_TASK_INDEX=2 CLOUD_RUN_TASK_COUNT=4 \
  node "$RECEIPT" "$WORK/truncated-report.json" >/dev/null 2>&1; then
  echo "FAIL: report statistics that contradict serialized tests were accepted"
  exit 1
fi

cat > "$WORK/outcomes-report.json" <<'JSON'
{
  "stats": { "expected": 1, "skipped": 1, "unexpected": 1, "flaky": 1 },
  "suites": [{ "specs": [{
    "title": "all Playwright outcomes",
    "tests": [
      { "projectName": "chromium", "status": "expected", "results": [{ "status": "passed", "retry": 0, "attachments": [] }] },
      { "projectName": "chromium", "status": "skipped", "results": [] },
      { "projectName": "chromium", "status": "unexpected", "results": [{ "status": "failed", "retry": 0, "attachments": [] }] },
      { "projectName": "chromium", "status": "flaky", "results": [{ "status": "failed", "retry": 0, "attachments": [] }, { "status": "passed", "retry": 1, "attachments": [] }] }
    ]
  }]}]
}
JSON
OUTCOMES_OUT="$WORK/outcomes-receipt.jsonl"
CLOUD_RUN_EXECUTION=outcomes-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  node "$RECEIPT" "$WORK/outcomes-report.json" > "$OUTCOMES_OUT"
if ! jq -e 'select(.event == "e2e_playwright_task_complete") | .recoveredRetryCount == 1' "$OUTCOMES_OUT" >/dev/null; then
  echo "FAIL: a realistic Playwright pass/skipped/unexpected/flaky report was not accepted"
  cat "$OUTCOMES_OUT"
  exit 1
fi

MULTI_FIRST_TRACE="$WORK/multi-first-failure.zip"
MULTI_LATER_TRACE="$WORK/multi-later-attempt.zip"
printf 'first failed attempt trace\n' > "$MULTI_FIRST_TRACE"
printf 'later attempt trace that must not be paired\n' > "$MULTI_LATER_TRACE"
cat > "$WORK/multi-report.json" <<JSON
{
  "stats": { "expected": 0, "skipped": 0, "unexpected": 0, "flaky": 1 },
  "suites": [{ "specs": [{
    "title": "fails twice then recovers",
    "file": "test/e2e-browser/specs/multi-retry.spec.ts",
    "line": 7,
    "tests": [{ "projectName": "chromium", "status": "flaky", "results": [
      { "status": "failed", "retry": 0, "errors": [{ "stack": "first failure" }], "attachments": [{ "name": "trace", "contentType": "application/zip", "path": "$MULTI_FIRST_TRACE" }] },
      { "status": "failed", "retry": 1, "errors": [{ "stack": "later failure" }], "attachments": [{ "name": "trace", "contentType": "application/zip", "path": "$MULTI_LATER_TRACE" }] },
      { "status": "passed", "retry": 2, "attachments": [] }
    ]}]
  }]}]
}
JSON
MULTI_OUT="$WORK/multi-receipt.jsonl"
CLOUD_RUN_EXECUTION=multi-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  node "$RECEIPT" "$WORK/multi-report.json" > "$MULTI_OUT"
MULTI_SUMMARY="$(jq -c 'select(.event == "e2e_playwright_retry_evidence")' "$MULTI_OUT")"
if ! jq -e '
  .failureAttempt == 0
  and .trace.traceAttempt == 0
  and (.error.stack | contains("first failure"))
' <<< "$MULTI_SUMMARY" >/dev/null; then
  echo "FAIL: multi-attempt retry evidence did not retain the first failed attempt's error and trace identity"
  echo "$MULTI_SUMMARY"
  exit 1
fi
jq -r 'select(.event == "e2e_playwright_retry_trace_chunk") | .data' "$MULTI_OUT" \
  | base64 --decode > "$WORK/multi-reconstructed.zip"
cmp -s "$MULTI_FIRST_TRACE" "$WORK/multi-reconstructed.zip" || {
  echo "FAIL: multi-attempt retry receipt paired the first failure with a later attempt's trace"
  exit 1
}

NO_TRACE_REPORT="$WORK/no-trace-report.json"
cat > "$NO_TRACE_REPORT" <<'JSON'
{"stats":{"expected":0,"skipped":0,"unexpected":0,"flaky":1},"suites":[{"specs":[{"title":"recovers without a retained trace","tests":[{"projectName":"chromium","status":"flaky","results":[{"status":"failed","retry":0,"errors":[{"stack":"failure without trace"}],"attachments":[]},{"status":"passed","retry":1,"attachments":[]}]}]}]}]}
JSON
NO_TRACE_OUT="$WORK/no-trace-receipt.jsonl"
CLOUD_RUN_EXECUTION=no-trace-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  node "$RECEIPT" "$NO_TRACE_REPORT" > "$NO_TRACE_OUT"
if ! jq -e 'select(.event == "e2e_playwright_retry_evidence") | .trace.retained == false and .trace.traceAttempt == 0 and .trace.reason == "No trace attachment was retained for the failed attempt."' "$NO_TRACE_OUT" >/dev/null; then
  echo "FAIL: retry evidence without a same-attempt trace did not state the precise unavailable-trace reason"
  cat "$NO_TRACE_OUT"
  exit 1
fi

CONFIG_REPORT="$WORK/config-report.json"
FRESHELL_CLOUD_RETRY_REPORT_PATH="$CONFIG_REPORT" \
  pnpm exec playwright test --config "$ROOT/test/e2e-browser/playwright.cloud.config.ts" --list >/dev/null
if [ ! -s "$CONFIG_REPORT" ]; then
  echo "FAIL: cloud Playwright config did not write the retry-evidence JSON report"
  exit 1
fi
TRACE_MODE="$(pnpm exec tsx --eval "import config from '$ROOT/test/e2e-browser/playwright.cloud.config.ts'; console.log(config.use?.trace)")"
if [ "$TRACE_MODE" != "retain-on-first-failure" ]; then
  echo "FAIL: Cloud Playwright config does not retain the trace from the first failed attempt"
  exit 1
fi
ZERO_OUT="$WORK/zero-test-receipt.jsonl"
CLOUD_RUN_EXECUTION=zero-test-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  node "$RECEIPT" "$CONFIG_REPORT" > "$ZERO_OUT"
if ! jq -e 'select(.event == "e2e_playwright_task_complete") | .recoveredRetryCount == 0' "$ZERO_OUT" >/dev/null; then
  echo "FAIL: explicit zero-test Playwright report did not produce a zero-retry completion receipt"
  cat "$ZERO_OUT"
  exit 1
fi

BIN="$WORK/bin"
mkdir -p "$BIN"
cat > "$BIN/pnpm" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "exec" ] && [ "$2" = "playwright" ] && [ "$3" = "test" ]; then
  if [[ " $* " == *" --list "* ]]; then
    printf '  [chromium] › retry-fixture.spec.ts:42:9 › recovers on the first retry\n'
    exit 0
  fi
  if [ -n "${FRESHELL_CLOUD_RETRY_REPORT_PATH:-}" ]; then
    cp "$STUB_RETRY_REPORT" "$FRESHELL_CLOUD_RETRY_REPORT_PATH"
  fi
  exit 0
fi
echo "unexpected pnpm invocation: $*" >&2
exit 2
PNPM
chmod +x "$BIN/pnpm"

ENTRYPOINT_OUT="$(PATH="$BIN:$PATH" STUB_RETRY_REPORT="$REPORT" CLOUD_RUN_EXECUTION=entrypoint-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  "$ROOT/docker/cloud-run/entrypoint.sh" --project=chromium 2>&1)"
if ! grep -q '"event":"e2e_playwright_retry_evidence"' <<< "$ENTRYPOINT_OUT"; then
  echo "FAIL: Cloud entrypoint did not export retry evidence after a successful retry"
  echo "$ENTRYPOINT_OUT"
  exit 1
fi

if PATH="$BIN:$PATH" STUB_RETRY_REPORT="$WORK/malformed-report.json" CLOUD_RUN_EXECUTION=entrypoint-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
  "$ROOT/docker/cloud-run/entrypoint.sh" --project=chromium >/dev/null 2>&1; then
  echo "FAIL: entrypoint accepted a structurally incomplete JSON report after a successful Playwright process"
  exit 1
fi

for incomplete_entrypoint_report in \
  "$WORK/truncated-report.json" \
  <(printf '%s' '{"stats":{"expected":1,"skipped":0,"unexpected":0,"flaky":0},"suites":[{"specs":[{"tests":[{"projectName":"chromium","status":"expected","results":[]}]}]}]}'); do
  if PATH="$BIN:$PATH" STUB_RETRY_REPORT="$incomplete_entrypoint_report" CLOUD_RUN_EXECUTION=entrypoint-probe CLOUD_RUN_TASK_INDEX=0 CLOUD_RUN_TASK_COUNT=1 \
    "$ROOT/docker/cloud-run/entrypoint.sh" --project=chromium >/dev/null 2>&1; then
    echo "FAIL: entrypoint accepted Playwright report accounting that contradicted serialized tests/results"
    exit 1
  fi
done

cat > "$WORK/passing-report.json" <<'JSON'
{"stats":{"expected":1,"skipped":0,"unexpected":0,"flaky":0},"suites":[{"specs":[{"tests":[{"projectName":"chromium","status":"expected","results":[{"status":"passed","retry":0,"attachments":[]}]}]}]}]}
JSON
EMPTY_SHARD_OUT=""
for task_index in 0 1; do
  EMPTY_SHARD_OUT+="$(PATH="$BIN:$PATH" STUB_RETRY_REPORT="$WORK/passing-report.json" CLOUD_RUN_EXECUTION=empty-shard-probe CLOUD_RUN_TASK_INDEX="$task_index" CLOUD_RUN_TASK_COUNT=2 \
    "$ROOT/docker/cloud-run/entrypoint.sh" --project=chromium 2>&1)"$'\n'
done
if [ "$(grep -c '"event":"e2e_playwright_task_complete"' <<< "$EMPTY_SHARD_OUT")" -ne 2 ] \
  || ! grep -q '"taskIndex":0,"taskCount":2,"recoveredRetryCount":0' <<< "$EMPTY_SHARD_OUT" \
  || ! grep -q '"taskIndex":1,"taskCount":2,"recoveredRetryCount":0' <<< "$EMPTY_SHARD_OUT"; then
  echo "FAIL: a one-spec/two-shard entrypoint run did not emit one zero-retry receipt for every task"
  echo "$EMPTY_SHARD_OUT"
  exit 1
fi
printf '%s\n' "$EMPTY_SHARD_OUT" | jq -R 'fromjson? | select(.event == "e2e_playwright_task_complete") | {jsonPayload: .}' | jq -s . \
  | node "$ROOT/scripts/e2e-cloud-structured-receipts.mjs" empty-shard-probe 2 >/dev/null || {
    echo "FAIL: the outer receipt parser did not accept the actual entrypoint's one-spec/two-shard completion receipts"
    echo "$EMPTY_SHARD_OUT"
    exit 1
  }

echo "PASS: successful retry retains first-attempt stack and trace in durable JSONL chunks"
