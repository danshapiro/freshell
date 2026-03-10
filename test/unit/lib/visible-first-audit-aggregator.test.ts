// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { summarizeScenarioSamples } from '@test/e2e-browser/perf/audit-aggregator'

function buildScenarioFixture() {
  return {
    id: 'terminal-cold-boot' as const,
    description: 'Terminal cold boot',
    focusedReadyMilestone: 'terminal.first_output',
    samples: [
      {
        profileId: 'desktop_local' as const,
        status: 'ok' as const,
        startedAt: '2026-03-10T00:00:00.000Z',
        finishedAt: '2026-03-10T00:00:01.000Z',
        durationMs: 1000,
        browser: {},
        transport: {},
        server: {},
        derived: { focusedReadyMs: 110 },
        errors: [],
      },
      {
        profileId: 'mobile_restricted' as const,
        status: 'ok' as const,
        startedAt: '2026-03-10T00:00:00.000Z',
        finishedAt: '2026-03-10T00:00:02.000Z',
        durationMs: 2000,
        browser: {},
        transport: {},
        server: {},
        derived: { focusedReadyMs: 220 },
        errors: [],
      },
    ],
  }
}

describe('visible-first audit aggregation', () => {
  it('summarizes the single sample per profile without inventing medians', () => {
    const summary = summarizeScenarioSamples(buildScenarioFixture())
    expect(summary.desktop_local?.focusedReadyMs).toBeTypeOf('number')
    expect(summary.mobile_restricted?.focusedReadyMs).toBeTypeOf('number')
  })
})
