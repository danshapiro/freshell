// @vitest-environment node
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseVisibleFirstServerLogs } from '@test/e2e-browser/perf/parse-server-logs'

describe('parseVisibleFirstServerLogs', () => {
  const tempFiles: string[] = []

  afterEach(async () => {
    await Promise.all(tempFiles.map((file) => fs.rm(file, { force: true })))
    tempFiles.length = 0
  })

  it('extracts request logs, perf events, perf_system samples, and diagnostics', async () => {
    const debugLogPath = path.join(os.tmpdir(), `visible-first-server-log-${Date.now()}.jsonl`)
    tempFiles.push(debugLogPath)
    await fs.writeFile(
      debugLogPath,
      [
        JSON.stringify({ event: 'http_request', path: '/api/settings' }),
        JSON.stringify({ event: 'perf_system', rssBytes: 123 }),
        JSON.stringify({ component: 'perf', event: 'http_request_slow', durationMs: 50 }),
        '{not-json',
      ].join('\n'),
      'utf8',
    )

    const result = await parseVisibleFirstServerLogs(debugLogPath)
    expect(result.httpRequests.length).toBeGreaterThan(0)
    expect(result.perfEvents.length).toBeGreaterThan(0)
    expect(result.perfSystemSamples.length).toBeGreaterThan(0)
    expect(result.parserDiagnostics).toHaveLength(1)
  })
})
