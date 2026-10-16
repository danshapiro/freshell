#!/usr/bin/env node
/**
 * Export recovered Playwright retry evidence as bounded structured log entries.
 *
 * Cloud Run discards a task filesystem after it exits. Cloud Logging retains
 * stdout, so retry-only failures need their first failure stack and the trace
 * archive copied there before a successful retry can hide the evidence.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const MAX_TRACE_BYTES = 8 * 1024 * 1024
// Keep each serialized base64 JSONL record below Cloud Logging's 102,400-byte
// entry limit (48 KiB raw becomes 64 KiB base64 plus a small fixed envelope).
const TRACE_CHUNK_BYTES = 48 * 1024
const MAX_ERROR_TEXT_BYTES = 64 * 1024
const PLAYWRIGHT_OUTCOMES = ['expected', 'skipped', 'unexpected', 'flaky']

const [reportPath] = process.argv.slice(2)

if (!reportPath) {
  throw new Error('usage: e2e-cloud-retry-receipt.mjs <playwright-json-report>')
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const execution = process.env.CLOUD_RUN_EXECUTION
const taskIndex = Number.parseInt(process.env.CLOUD_RUN_TASK_INDEX ?? '0', 10)
const taskCount = Number.parseInt(process.env.CLOUD_RUN_TASK_COUNT ?? '1', 10)

if (!execution) throw new Error('CLOUD_RUN_EXECUTION is required for a durable retry receipt')
if (!Number.isInteger(taskIndex) || !Number.isInteger(taskCount) || taskCount < 1 || taskIndex < 0 || taskIndex >= taskCount) {
  throw new Error('Cloud Run task identity is invalid')
}

function emit(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`)
}

function boundedText(value) {
  const text = typeof value === 'string' ? value : ''
  const bytes = Buffer.byteLength(text)
  if (bytes <= MAX_ERROR_TEXT_BYTES) return { text, truncated: false }
  return {
    text: Buffer.from(text).subarray(0, MAX_ERROR_TEXT_BYTES).toString('utf8'),
    truncated: true,
  }
}

function errorEvidence(result) {
  const error = result.errors?.[0] ?? result.error ?? {}
  const message = boundedText(error.message)
  const stack = boundedText(error.stack ?? error.message)
  return {
    message: message.text,
    stack: stack.text,
    truncated: message.truncated || stack.truncated,
  }
}

function validateReport(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Playwright JSON report must be an object')
  if (!candidate.stats || typeof candidate.stats !== 'object') {
    throw new Error('Playwright JSON report is missing stats')
  }
  for (const outcome of PLAYWRIGHT_OUTCOMES) {
    if (!Number.isInteger(candidate.stats[outcome]) || candidate.stats[outcome] < 0) {
      throw new Error(`Playwright JSON report is missing valid stats.${outcome}`)
    }
  }

  const tests = validateSuites(candidate.suites, 'report.suites')
  const serializedStats = Object.fromEntries(PLAYWRIGHT_OUTCOMES.map((outcome) => [outcome, 0]))
  for (const test of tests) {
    serializedStats[test.status] += 1
  }
  for (const outcome of PLAYWRIGHT_OUTCOMES) {
    if (candidate.stats[outcome] !== serializedStats[outcome]) {
      throw new Error(`Playwright JSON report stats.${outcome} does not match serialized test outcomes`)
    }
  }
}

function validateSuites(suites, location) {
  if (!Array.isArray(suites)) throw new Error(`${location} must be an array`)
  const tests = []
  suites.forEach((suite, suiteIndex) => {
    const suiteLocation = `${location}[${suiteIndex}]`
    if (!suite || typeof suite !== 'object' || Array.isArray(suite)) throw new Error(`${suiteLocation} must be an object`)
    if (!Array.isArray(suite.specs)) throw new Error(`${suiteLocation}.specs must be an array`)
    if (suite.suites !== undefined && !Array.isArray(suite.suites)) throw new Error(`${suiteLocation}.suites must be an array`)
    suite.specs.forEach((spec, specIndex) => {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Array.isArray(spec.tests)) {
        throw new Error(`${suiteLocation}.specs[${specIndex}].tests must be an array`)
      }
      spec.tests.forEach((test, testIndex) => {
        if (!test || typeof test !== 'object' || Array.isArray(test) || !Array.isArray(test.results)) {
          throw new Error(`${suiteLocation}.specs[${specIndex}].tests[${testIndex}].results must be an array`)
        }
        if (!PLAYWRIGHT_OUTCOMES.includes(test.status)) {
          throw new Error(`${suiteLocation}.specs[${specIndex}].tests[${testIndex}].status is not a Playwright test outcome`)
        }
        if (test.status !== 'skipped' && test.results.length === 0) {
          throw new Error(`${suiteLocation}.specs[${specIndex}].tests[${testIndex}] has no serialized test results`)
        }
        test.results.forEach((result, resultIndex) => {
          if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.status !== 'string' || !Number.isInteger(result.retry)) {
            throw new Error(`${suiteLocation}.specs[${specIndex}].tests[${testIndex}].results[${resultIndex}] is invalid`)
          }
          if (result.attachments !== undefined && !Array.isArray(result.attachments)) {
            throw new Error(`${suiteLocation}.specs[${specIndex}].tests[${testIndex}].results[${resultIndex}].attachments must be an array`)
          }
        })
        tests.push(test)
      })
    })
    tests.push(...validateSuites(suite.suites ?? [], `${suiteLocation}.suites`))
  })
  return tests
}

function specsIn(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []),
    ...specsIn(suite.suites ?? []),
  ])
}

function traceAttachmentFor(result) {
  return (result.attachments ?? []).find((attachment) => (
    attachment?.name === 'trace' && attachment.contentType === 'application/zip'
  ))
}

function artifactIdFor({ spec, test, attempt, traceIndex }) {
  const seed = [execution, taskIndex, spec.file ?? '', spec.line ?? 0, spec.title ?? '', test.projectName ?? '', attempt, traceIndex].join('\u0000')
  return `playwright-retry-trace-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`
}

function emitTrace({ attachment, artifactId }) {
  if (!attachment.path) {
    return { storage: 'cloud-logging-jsonl-chunks', artifactId, retained: false, reason: 'Trace attachment for the failed attempt has no file path.' }
  }

  let trace
  try {
    trace = readFileSync(attachment.path)
  } catch (error) {
    return {
      storage: 'cloud-logging-jsonl-chunks',
      artifactId,
      retained: false,
      reason: `Could not read trace for the failed attempt: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (trace.length > MAX_TRACE_BYTES) {
    return {
      storage: 'cloud-logging-jsonl-chunks',
      artifactId,
      retained: false,
      bytes: trace.length,
      maxBytes: MAX_TRACE_BYTES,
      reason: 'Trace for the failed attempt exceeds the bounded Cloud Logging retention limit.',
    }
  }

  const chunkCount = Math.max(1, Math.ceil(trace.length / TRACE_CHUNK_BYTES))
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * TRACE_CHUNK_BYTES
    const end = Math.min(start + TRACE_CHUNK_BYTES, trace.length)
    emit({
      severity: 'WARNING',
      event: 'e2e_playwright_retry_trace_chunk',
      execution,
      taskIndex,
      taskCount,
      artifactId,
      chunkIndex,
      chunkCount,
      encoding: 'base64',
      data: trace.subarray(start, end).toString('base64'),
    })
  }

  return {
    storage: 'cloud-logging-jsonl-chunks',
    artifactId,
    retained: true,
    bytes: trace.length,
    sha256: createHash('sha256').update(trace).digest('hex'),
    chunkCount,
    encoding: 'base64',
  }
}

validateReport(report)

let recoveredRetryCount = 0
for (const spec of specsIn(report.suites)) {
  for (const test of spec.tests ?? []) {
    const results = test.results ?? []
    const firstFailure = results.find((result) => result.status === 'failed' || result.status === 'timedOut')
    const recovered = firstFailure && results.some((result) => result.status === 'passed' && result.retry > firstFailure.retry)
    if (!recovered) continue

    recoveredRetryCount += 1
    const attachment = traceAttachmentFor(firstFailure)
    const trace = attachment
      ? emitTrace({
        attachment,
        artifactId: artifactIdFor({ spec, test, attempt: firstFailure.retry, traceIndex: 0 }),
      })
      : {
        storage: 'cloud-logging-jsonl-chunks',
        retained: false,
        reason: 'No trace attachment was retained for the failed attempt.',
      }
    trace.traceAttempt = firstFailure.retry

    emit({
      severity: 'WARNING',
      event: 'e2e_playwright_retry_evidence',
      execution,
      taskIndex,
      taskCount,
      attempt: firstFailure.retry,
      failureAttempt: firstFailure.retry,
      test: {
        file: spec.file ?? '',
        line: spec.line ?? 0,
        title: spec.title ?? '',
        project: test.projectName ?? '',
      },
      error: errorEvidence(firstFailure),
      trace,
    })
  }
}

emit({
  severity: 'INFO',
  event: 'e2e_playwright_task_complete',
  execution,
  taskIndex,
  taskCount,
  recoveredRetryCount,
})
