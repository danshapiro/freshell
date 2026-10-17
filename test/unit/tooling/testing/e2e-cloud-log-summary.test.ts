import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractE2eCloudPlaywrightSummaryLines } from '../../../../scripts/testing/e2e-cloud-log-summary.mjs'

const cliPath = path.resolve(import.meta.dirname, '../../../../scripts/testing/e2e-cloud-log-summary.mjs')

describe('Cloud Playwright log summary extraction', () => {
  it('removes Cloud Logging timestamps and terminal control codes before selecting the footer', () => {
    const output = [
      '2026-10-12 12:12:13 [e2e-entrypoint] Shard 1/1 assignment: tests 1-3',
      '2026-10-12 12:12:54 \u001b[1A\u001b[2K  3 passed (39.8s)\u001b[0m',
      '2026-10-12 12:12:54 worker task completed successfully',
      '2026-10-12 12:12:55   1 skipped (0.1s)',
    ].join('\n')

    const expected = [
      '[e2e-entrypoint] Shard 1/1 assignment: tests 1-3',
      '  3 passed (39.8s)',
      '  1 skipped (0.1s)',
    ]
    expect(extractE2eCloudPlaywrightSummaryLines(output)).toEqual(expected)

    const cli = spawnSync(process.execPath, [cliPath], { input: output, encoding: 'utf8' })
    expect(cli.status, cli.stderr).toBe(0)
    expect(cli.stdout.trimEnd().split('\n')).toEqual(expected)
  })
})
