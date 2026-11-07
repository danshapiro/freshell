// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// This file is selected only by sandbox-test.config.ts, never the default
// *.test.ts collector. Fail closed if explicitly invoked in another lane.
if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite'
  || process.cwd() !== '/workspace' || process.getuid?.() === 0
  || !existsSync('/.dockerenv') || process.env.FRESHELL_VITEST_BACKEND === 'cloud'
  || process.env.TEST_MODE === 'vitest') {
  throw new Error('Requires non-root scripts/sandbox-test.sh --runtime-suite; refuses ordinary Vitest/cloud')
}

describe('sandbox selftest sentinel lifecycle', () => {
  const cases = ['outlives_300_seconds', 'normal_exit', 'killed_process', 'killed_listener', 'early_exit']
  it.each(cases)('%s', name => {
    const root = path.resolve('test-results')
    mkdirSync(root, { recursive: true })
    const results = process.env.FRESHELL_SENTINEL_RESULTS_DIR ?? mkdtempSync(path.join(root, 'sentinel-'))
    const destination = path.join(results, name)
    const args = ['scripts/test/sandbox-selftest-sentinel.test.py', '--results', destination]
    if (process.env.FRESHELL_SENTINEL_SOURCE_SHA256) {
      args.push('--source-sha256', process.env.FRESHELL_SENTINEL_SOURCE_SHA256)
    }
    args.push(`SentinelLifecycle.test_${name}`)
    const run = spawnSync('python3', args, { encoding: 'utf8', timeout: 400_000 })
    // Retain unittest's actual case count and failure, not just the wrapper code.
    mkdirSync(destination, { recursive: true })
    writeFileSync(path.join(destination, 'unittest.stdout.txt'), run.stdout ?? '')
    writeFileSync(path.join(destination, 'unittest.stderr.txt'), run.stderr ?? '')
    console.info(JSON.stringify({ severity: run.status === 0 ? 'info' : 'error',
      event: 'sentinel_lifecycle_result', name, status: run.status, signal: run.signal, results: destination }))
    expect(run.error, run.stderr).toBeUndefined()
    expect(run.signal, run.stderr).toBeNull()
    expect(run.status, run.stdout + run.stderr).toBe(0)
  }, 430_000)
})
