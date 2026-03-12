// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { runVisibleFirstAuditSample } from '@test/e2e-browser/perf/run-sample'

describe('runVisibleFirstAuditSample', () => {
  it('returns one schema-shaped sample with browser, transport, server, and derived data', async () => {
    const sample = await runVisibleFirstAuditSample({
      scenarioId: 'terminal-cold-boot',
      profileId: 'desktop_local',
      deps: {
        executeSample: async () => ({
          browser: {
            milestones: { 'terminal.first_output': 123 },
            perfEvents: [],
            terminalLatencySamplesMs: [45],
          },
          transport: {
            http: { requests: [] },
            ws: { frames: [] },
            summary: { http: { byRoute: {} }, ws: { byType: {} } },
          },
          server: {
            httpRequests: [],
            perfEvents: [],
            perfSystemSamples: [],
            parserDiagnostics: [],
          },
        }),
      },
    })

    expect(sample.profileId).toBe('desktop_local')
    expect(sample.browser).toBeDefined()
    expect(sample.transport).toBeDefined()
    expect(sample.server).toBeDefined()
    expect(sample.derived.focusedReadyMs).toBeTypeOf('number')
  })
})
