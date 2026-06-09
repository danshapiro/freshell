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
            terminalReplayEvents: [],
            terminalOutputEvents: [],
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

  it('populates reconnect backlog required metrics from websocket and replay evidence', async () => {
    const sample = await runVisibleFirstAuditSample({
      scenarioId: 'terminal-reconnect-backlog',
      profileId: 'desktop_local',
      deps: {
        executeSample: async () => ({
          browser: {
            milestones: { 'terminal.first_output': 100 },
            perfEvents: [
              { event: 'visible_first.audit.max_raf_gap', maxGapMs: 16 },
              { event: 'terminal.parser_applied', timestamp: 40, parserAppliedSeq: 1 },
            ],
            terminalLatencySamplesMs: [],
          },
          transport: {
            http: { requests: [] },
            ws: {
              frames: [
                {
                  timestamp: 10,
                  direction: 'sent',
                  type: 'terminal.attach',
                  payload: JSON.stringify({ type: 'terminal.attach', terminalId: 'term-reconnect' }),
                  payloadLength: 80,
                },
                {
                  timestamp: 30,
                  direction: 'received',
                  type: 'terminal.output.batch',
                  payload: JSON.stringify({
                    type: 'terminal.output.batch',
                    source: 'replay',
                    terminalId: 'term-reconnect',
                    seqStart: 1,
                    seqEnd: 1,
                    serializedBytes: 120,
                  }),
                  payloadLength: 120,
                },
              ],
            },
            summary: { http: { byRoute: {} }, ws: { byType: {} } },
          },
          server: {
            httpRequests: [],
            perfEvents: [],
            perfSystemSamples: [],
            terminalReplayEvents: [
              {
                event: 'terminal.replay.batch',
                source: 'replay',
                seqStart: 1,
                seqEnd: 1,
                serializedBytes: 120,
              },
            ],
            terminalOutputEvents: [],
            parserDiagnostics: [],
          },
        }),
      },
    })

    expect(sample.status).toBe('ok')
    expect(sample.errors).toEqual([])
    expect(sample.derived).toEqual(expect.objectContaining({
      terminalInputToFirstOutputMs: 20,
      terminalReplayMessageCount: 1,
      terminalReplaySerializedBytes: 120,
      terminalParserAppliedLagMs: 10,
      terminalReplayGapCount: 0,
      terminalFullHydrateFallbackCount: 0,
      terminalSurfaceQuarantineCount: 0,
      terminalStaleGenerationRejectionCount: 0,
      terminalStoppedRetentionCoveredMs: 0,
      terminalStopResumeGapCount: 0,
    }))
  })
})
