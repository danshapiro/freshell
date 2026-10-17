#!/usr/bin/env node
/** Validate per-task Playwright footer or explicit empty-shard log evidence. */
import { readFileSync } from 'node:fs'

const [execution, expectedTaskCountText] = process.argv.slice(2)
const expectedTaskCount = Number.parseInt(expectedTaskCountText ?? '', 10)

if (!execution || !Number.isInteger(expectedTaskCount) || expectedTaskCount < 1) {
  console.error('usage: e2e-cloud-task-summaries.mjs <execution> <expected-task-count>')
  process.exit(2)
}

let entries
try {
  entries = JSON.parse(readFileSync(0, 'utf8'))
} catch (error) {
  console.error(`Cloud Logging response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
if (!Array.isArray(entries)) {
  console.error('Cloud Logging response must be a JSON array')
  process.exit(2)
}

const ansiEscape = /\u001B\[[0-?]*[ -/]*[@-~]/g
const footerPattern = /^\s*[0-9]+\s+(?:failed|passed|skipped|interrupted)\b/
const emptyShardMarker = '[e2e-entrypoint] No specs assigned to this shard. Exporting zero-test receipt.'
const footerTaskIndexes = new Set()
const emptyTaskIndexes = new Set()
const footerLinesByTask = new Map()
let hasPassedTest = false

for (const [entryIndex, entry] of entries.entries()) {
  const labels = entry?.labels
  const textPayload = entry?.textPayload
  if (typeof textPayload !== 'string') {
    console.error(`Cloud Logging task-summary entry ${entryIndex} has no textPayload`)
    process.exit(2)
  }
  const normalizedTextPayload = textPayload.replace(ansiEscape, '')
  const isFooter = footerPattern.test(normalizedTextPayload)
  const isEmptyShard = normalizedTextPayload.trim() === emptyShardMarker
  if (!isFooter && !isEmptyShard) continue

  const entryExecution = labels?.['run.googleapis.com/execution_name'] ?? labels?.execution_name
  const taskIndexValue = labels?.['run.googleapis.com/task_index'] ?? labels?.task_index
  const taskIndexText = typeof taskIndexValue === 'number' && Number.isInteger(taskIndexValue)
    ? String(taskIndexValue)
    : taskIndexValue

  if (entryExecution !== execution || typeof taskIndexText !== 'string' || !/^\d+$/.test(taskIndexText)) {
    console.error(`Cloud Logging task-summary entry ${entryIndex} has invalid execution or task-index labels`)
    process.exit(2)
  }
  const taskIndex = Number(taskIndexText)
  if (!Number.isInteger(taskIndex) || taskIndex < 0 || taskIndex >= expectedTaskCount) {
    console.error(`Cloud Logging task-summary entry ${entryIndex} has out-of-range task index ${taskIndexText}`)
    process.exit(2)
  }
  if (isFooter) {
    footerTaskIndexes.add(taskIndex)
    hasPassedTest ||= /\b[1-9][0-9]*\s+passed\b/.test(normalizedTextPayload)
    const lines = footerLinesByTask.get(taskIndex) ?? new Set()
    lines.add(normalizedTextPayload.trim())
    footerLinesByTask.set(taskIndex, lines)
  } else if (isEmptyShard) {
    emptyTaskIndexes.add(taskIndex)
  }
}

for (const taskIndex of footerTaskIndexes) {
  if (emptyTaskIndexes.has(taskIndex)) {
    console.error(`task ${taskIndex} has both a Playwright footer and an empty-shard marker`)
    process.exit(2)
  }
}

const accountedTaskIndexes = new Set([...footerTaskIndexes, ...emptyTaskIndexes])
const missingTaskIndexes = Array.from({ length: expectedTaskCount }, (_, taskIndex) => taskIndex)
  .filter((taskIndex) => !accountedTaskIndexes.has(taskIndex))
if (missingTaskIndexes.length > 0) {
  console.error(`missing task-indexed Playwright summary evidence for task(s): ${missingTaskIndexes.join(', ')}`)
  process.exit(1)
}

const summaries = [...accountedTaskIndexes]
  .sort((left, right) => left - right)
  .flatMap((taskIndex) => {
    if (emptyTaskIndexes.has(taskIndex)) {
      return [{ taskIndex, kind: 'empty', text: emptyShardMarker }]
    }
    return [...(footerLinesByTask.get(taskIndex) ?? [])]
      .map((text) => ({ taskIndex, kind: 'footer', text }))
  })

process.stdout.write(`${JSON.stringify({
  execution,
  taskCount: expectedTaskCount,
  hasPassedTest,
  footerTaskIndexes: [...footerTaskIndexes].sort((left, right) => left - right),
  emptyTaskIndexes: [...emptyTaskIndexes].sort((left, right) => left - right),
  summaries,
})}\n`)
