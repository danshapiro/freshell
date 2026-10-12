import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ansiEscape = /\u001B\[[0-?]*[ -/]*[@-~]/g
const cloudLogTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? /

export function extractE2eCloudPlaywrightSummaryLines(output) {
  return output.split(/\r?\n/)
    .map(line => line.replace(cloudLogTimestamp, '').replace(ansiEscape, ''))
    .filter(line => /^\[e2e-entrypoint\] Shard [0-9]+\/[0-9]+ assignment\b/.test(line)
      || /^\s+[0-9]+ (?:failed|passed|skipped|interrupted)\b/.test(line))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const lines = extractE2eCloudPlaywrightSummaryLines(readFileSync(0, 'utf8'))
  if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`)
}
