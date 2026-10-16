import { describe, expect, it } from 'vitest'
import { ManagedEnvironmentBrowserSummaryCapture } from '../../../../scripts/testing/managed-environment-browser-summary.js'

describe('managed environment configured-browser summary', () => {
  it('captures the actual one-shard Playwright footer across stream chunk boundaries', () => {
    const capture = new ManagedEnvironmentBrowserSummaryCapture()
    capture.write('[e2e-cloud] progress before the summary\n[e2e-cloud] Per-shard sum')
    capture.write('mary:\n\u001b[32m  3 passed')
    capture.write(' (42.1s)\u001b[0m\n')
    capture.write('[e2e-cloud] Succeeded tasks: 1\n')

    expect(capture.finish()).toEqual({
      footer: '3 passed (42.1s)',
      executedCases: 3,
      passedCases: 3,
      failedCases: 0,
      skippedCases: 0,
      interruptedCases: 0,
      flakyCases: 0,
    })
  })

  it('reports failures and skips in a mixed Playwright footer', () => {
    const capture = new ManagedEnvironmentBrowserSummaryCapture()
    capture.write('[e2e-cloud] Per-shard summary:\n  1 failed, 1 skipped, 1 passed (42.1s)\n')
    capture.write('[e2e-cloud] Succeeded tasks: 1\n')

    expect(capture.finish()).toEqual({
      footer: '1 failed, 1 skipped, 1 passed (42.1s)',
      executedCases: 3,
      passedCases: 1,
      failedCases: 1,
      skippedCases: 1,
      interruptedCases: 0,
      flakyCases: 0,
    })
  })

  it('counts flaky cases in the Playwright footer instead of treating them as missing tests', () => {
    const capture = new ManagedEnvironmentBrowserSummaryCapture()
    capture.write('[e2e-cloud] Per-shard summary:\n  1 flaky, 2 passed (1.9m)\n')
    capture.write('[e2e-cloud] Succeeded tasks: 1\n')

    expect(capture.finish()).toEqual({
      footer: '1 flaky, 2 passed (1.9m)',
      executedCases: 3,
      passedCases: 2,
      failedCases: 0,
      skippedCases: 0,
      interruptedCases: 0,
      flakyCases: 1,
    })
  })

  it('rejects a missing or ambiguous per-shard footer instead of inventing a pass count', () => {
    const missing = new ManagedEnvironmentBrowserSummaryCapture()
    missing.write('[e2e-cloud] All tasks completed successfully.\n')
    expect(() => missing.finish()).toThrow(/exactly one Playwright shard summary, observed 0/)

    const ambiguous = new ManagedEnvironmentBrowserSummaryCapture()
    ambiguous.write('[e2e-cloud] Per-shard summary:\n  3 passed (42s)\n  3 passed (43s)\n')
    ambiguous.write('[e2e-cloud] Succeeded tasks: 1\n')
    expect(() => ambiguous.finish()).toThrow(/exactly one Playwright shard summary/)
  })

  it('ignores oversized unrelated log lines but rejects an oversized summary line', () => {
    const unrelated = new ManagedEnvironmentBrowserSummaryCapture()
    unrelated.write('x'.repeat(20_000))
    unrelated.write('\n[e2e-cloud] Per-shard summary:\n  3 passed (42s)\n[e2e-cloud] Succeeded tasks: 1\n')
    expect(unrelated.finish().passedCases).toBe(3)

    const oversizedSummary = new ManagedEnvironmentBrowserSummaryCapture()
    oversizedSummary.write(`[e2e-cloud] Per-shard summary:\n${'x'.repeat(20_000)}\n`)
    expect(() => oversizedSummary.finish()).toThrow(/overlong Playwright summary line/)
  })
})
