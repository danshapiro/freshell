// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  deriveVisibleFirstMetrics,
  normalizeAuditRouteId,
} from '@test/e2e-browser/perf/derive-visible-first-metrics'

describe('deriveVisibleFirstMetrics', () => {
  it('normalizes routes and counts offscreen work before focused readiness', () => {
    expect(normalizeAuditRouteId('http://localhost:3000/api/bootstrap?token=secret')).toBe('/api/bootstrap')
    expect(normalizeAuditRouteId('http://localhost:3000/api/session-directory?query=alpha')).toBe('/api/session-directory')
    expect(normalizeAuditRouteId('http://localhost:3000/api/fresh-agent/threads/freshclaude/claude/abc123/turns')).toBe(
      '/api/fresh-agent/threads/:sessionType/:provider/:threadId/turns',
    )
    expect(normalizeAuditRouteId('http://localhost:3000/api/terminals/term-1/viewport')).toBe(
      '/api/terminals/:terminalId/viewport',
    )

    const input = {
      focusedReadyMilestone: 'terminal.first_output',
      allowedApiRouteIdsBeforeReady: ['/api/bootstrap', '/api/terminals/:terminalId/viewport'],
      allowedWsTypesBeforeReady: ['hello', 'ready', 'terminal.output'],
      browser: {
        milestones: {
          'terminal.first_output': 100,
        },
        terminalLatencySamplesMs: [45],
      },
      transport: {
        http: {
          requests: [
            { timestamp: 20, url: 'http://localhost:3000/api/bootstrap', encodedDataLength: 10 },
            { timestamp: 60, url: 'http://localhost:3000/api/session-directory?query=alpha', encodedDataLength: 20 },
            { timestamp: 120, url: 'http://localhost:3000/api/terminals/term-1/viewport', encodedDataLength: 30 },
          ],
        },
        ws: {
          frames: [
            { timestamp: 30, payload: JSON.stringify({ type: 'hello' }), payloadLength: 8 },
            { timestamp: 40, payload: JSON.stringify({ type: 'freshAgent.event', event: { type: 'freshAgent.session.snapshot' } }), payloadLength: 9 },
            { timestamp: 70, payload: '{"type":"unknown-route"}', payloadLength: 10 },
            { timestamp: 130, payload: JSON.stringify({ type: 'terminal.output' }), payloadLength: 11 },
          ],
        },
      },
    }

    const result = deriveVisibleFirstMetrics(input)
    expect(result.httpRequestsBeforeReady).toBe(2)
    expect(result.offscreenHttpRequestsBeforeReady).toBe(1)
    expect(result.wsFramesBeforeReady).toBe(3)
    expect(result.offscreenWsFramesBeforeReady).toBe(2)
    expect(result.terminalInputToFirstOutputMs).toBe(45)
  })

  it('allows only configured inner fresh-agent provider events before readiness', () => {
    const result = deriveVisibleFirstMetrics({
      focusedReadyMilestone: 'agent_chat.surface_visible',
      allowedApiRouteIdsBeforeReady: ['/api/bootstrap'],
      allowedWsTypesBeforeReady: ['hello', 'ready', 'freshAgent.event'],
      allowedFreshAgentEventTypesBeforeReady: ['freshAgent.session.snapshot', 'freshAgent.status'],
      browser: {
        milestones: {
          'agent_chat.surface_visible': 100,
        },
      },
      transport: {
        http: { requests: [] },
        ws: {
          frames: [
            { timestamp: 20, payload: JSON.stringify({ type: 'freshAgent.event', event: { type: 'freshAgent.session.snapshot' } }) },
            { timestamp: 30, payload: JSON.stringify({ type: 'freshAgent.event', event: { type: 'freshAgent.status' } }) },
            { timestamp: 40, payload: JSON.stringify({ type: 'freshAgent.event', event: { type: 'freshAgent.permission.request' } }) },
          ],
        },
      },
    })

    expect(result.wsFramesBeforeReady).toBe(3)
    expect(result.offscreenWsFramesBeforeReady).toBe(1)
  })

  it('derives terminal catch-up replay metrics from structured logs, websocket evidence, and client perf events', () => {
    const result = deriveVisibleFirstMetrics({
      focusedReadyMilestone: 'terminal.first_output',
      allowedApiRouteIdsBeforeReady: ['/api/bootstrap', '/api/terminals/:terminalId/viewport'],
      allowedWsTypesBeforeReady: ['hello', 'ready', 'terminal.output', 'terminal.output.batch', 'terminal.output.gap'],
      browser: {
        milestones: {
          'terminal.first_output': 150,
        },
        perfEvents: [
          { event: 'visible_first.audit.max_raf_gap', maxGapMs: 31 },
          { event: 'terminal.parser_applied', timestamp: 118, parserAppliedSeq: 6 },
          { event: 'terminal.parser_applied', timestamp: 140, parserAppliedSeq: 8 },
          { event: 'terminal.catchup.full_hydrate_fallback', timestamp: 141 },
          { event: 'terminal.catchup.surface_quarantined', timestamp: 142 },
          { event: 'terminal.attach_generation_stale_rejected', timestamp: 143 },
          {
            event: 'terminal.catchup.stop_resume',
            timestamp: 144,
            source: 'visible_first_audit_process_suspend',
            browserExecutionStopped: true,
            retentionCoveredMs: 2_500,
            stoppedDurationMs: 8_000,
            outputStartedAfterStopMs: 1_000,
            outputStartedBeforeResumeMs: 2_500,
            cdpCatchupOutputMessageCount: 3,
            gapCount: 1,
          },
        ],
      },
      transport: {
        http: { requests: [] },
        ws: {
          frames: [
            {
              timestamp: 90,
              direction: 'sent',
              type: 'terminal.attach',
              payload: JSON.stringify({
                type: 'terminal.attach',
                terminalId: 'term-reconnect',
              }),
              payloadLength: 80,
            },
            {
              timestamp: 100,
              direction: 'received',
              type: 'terminal.output.batch',
              payload: JSON.stringify({
                type: 'terminal.output.batch',
                source: 'replay',
                seqStart: 1,
                seqEnd: 6,
                serializedBytes: 400,
              }),
              payloadLength: 400,
            },
            {
              timestamp: 130,
              direction: 'received',
              type: 'terminal.output',
              payload: JSON.stringify({
                type: 'terminal.output',
                source: 'replay',
                seqStart: 7,
                seqEnd: 8,
              }),
              payloadLength: 120,
            },
          ],
        },
      },
      server: {
        terminalReplayEvents: [
          {
            event: 'terminal.replay.progress',
            source: 'replay',
            seqStart: 1,
            seqEnd: 8,
            batchCount: 2,
            serializedBytes: 520,
          },
          {
            event: 'terminal.replay.gap',
            source: 'replay',
            fromSeq: 9,
            toSeq: 9,
          },
        ],
      },
    })

    expect(result.maxRafGapMs).toBe(31)
    expect(result.terminalInputToFirstOutputMs).toBe(10)
    expect(result.terminalReplayMessageCount).toBe(2)
    expect(result.terminalReplaySerializedBytes).toBe(520)
    expect(result.terminalParserAppliedLagMs).toBe(18)
    expect(result.terminalReplayGapCount).toBe(1)
    expect(result.terminalFullHydrateFallbackCount).toBe(1)
    expect(result.terminalSurfaceQuarantineCount).toBe(1)
    expect(result.terminalStaleGenerationRejectionCount).toBe(1)
    expect(result.terminalStoppedRetentionCoveredMs).toBe(2_500)
    expect(result.terminalStopResumeGapCount).toBe(1)
  })

  it('omits source-dependent required metrics when RAF or parser-applied evidence is absent', () => {
    const withoutRaf = deriveVisibleFirstMetrics({
      focusedReadyMilestone: 'terminal.first_output',
      allowedApiRouteIdsBeforeReady: [],
      allowedWsTypesBeforeReady: ['terminal.output.batch'],
      browser: {
        milestones: {
          'terminal.first_output': 100,
        },
        perfEvents: [
          { event: 'terminal.parser_applied', timestamp: 40, parserAppliedSeq: 1 },
        ],
      },
      transport: {
        http: { requests: [] },
        ws: {
          frames: [
            {
              timestamp: 30,
              direction: 'received',
              type: 'terminal.output.batch',
              payload: JSON.stringify({
                type: 'terminal.output.batch',
                source: 'replay',
                seqStart: 1,
                seqEnd: 1,
              }),
              payloadLength: 120,
            },
          ],
        },
      },
    })
    expect(withoutRaf).not.toHaveProperty('maxRafGapMs')
    expect(withoutRaf.terminalParserAppliedLagMs).toBe(10)

    const withoutParserApplied = deriveVisibleFirstMetrics({
      focusedReadyMilestone: 'terminal.first_output',
      allowedApiRouteIdsBeforeReady: [],
      allowedWsTypesBeforeReady: ['terminal.output.batch'],
      browser: {
        milestones: {
          'terminal.first_output': 100,
        },
        perfEvents: [
          { event: 'visible_first.audit.max_raf_gap', maxGapMs: 16 },
        ],
      },
      transport: {
        http: { requests: [] },
        ws: {
          frames: [
            {
              timestamp: 30,
              direction: 'received',
              type: 'terminal.output.batch',
              payload: JSON.stringify({
                type: 'terminal.output.batch',
                source: 'replay',
                seqStart: 1,
                seqEnd: 1,
              }),
              payloadLength: 120,
            },
          ],
        },
      },
    })
    expect(withoutParserApplied.maxRafGapMs).toBe(16)
    expect(withoutParserApplied).not.toHaveProperty('terminalParserAppliedLagMs')
  })

  it('does not count untagged or live terminal output as replay websocket evidence', () => {
    const result = deriveVisibleFirstMetrics({
      focusedReadyMilestone: 'terminal.first_output',
      allowedApiRouteIdsBeforeReady: [],
      allowedWsTypesBeforeReady: ['terminal.output', 'terminal.output.batch'],
      browser: {
        milestones: {
          'terminal.first_output': 100,
        },
        perfEvents: [
          { event: 'terminal.parser_applied', timestamp: 90, parserAppliedSeq: 2 },
        ],
      },
      transport: {
        http: { requests: [] },
        ws: {
          frames: [
            {
              timestamp: 40,
              direction: 'received',
              type: 'terminal.output',
              payload: JSON.stringify({
                type: 'terminal.output',
                seqStart: 1,
                seqEnd: 1,
              }),
              payloadLength: 120,
            },
            {
              timestamp: 50,
              direction: 'received',
              type: 'terminal.output.batch',
              payload: JSON.stringify({
                type: 'terminal.output.batch',
                source: 'live',
                seqStart: 2,
                seqEnd: 2,
              }),
              payloadLength: 140,
            },
          ],
        },
      },
    })

    expect(result.terminalReplayMessageCount).toBe(0)
    expect(result.terminalReplaySerializedBytes).toBe(0)
    expect(result).not.toHaveProperty('terminalParserAppliedLagMs')
  })

  it('omits stop/resume metrics when process-suspend proof evidence is absent or synthetic', () => {
    const result = deriveVisibleFirstMetrics({
      focusedReadyMilestone: 'terminal.first_output',
      allowedApiRouteIdsBeforeReady: [],
      allowedWsTypesBeforeReady: [],
      browser: {
        milestones: {
          'terminal.first_output': 50,
        },
        perfEvents: [
          {
            event: 'terminal.catchup.stop_resume',
            source: 'unit_reconnect_fixture',
            browserExecutionStopped: false,
            retentionCoveredMs: 900,
            stoppedDurationMs: 1_200,
            outputStartedAfterStopMs: 300,
            outputStartedBeforeResumeMs: 900,
            cdpCatchupOutputMessageCount: 5,
            gapCount: 0,
          },
          {
            event: 'terminal.catchup.stop_resume',
            source: 'visible_first_audit_process_suspend',
            browserExecutionStopped: true,
            retentionCoveredMs: 900,
            stoppedDurationMs: 1_200,
            outputStartedAfterStopMs: 300,
            outputStartedBeforeResumeMs: 900,
            cdpCatchupOutputMessageCount: 0,
            gapCount: 0,
          },
        ],
      },
      transport: {
        http: { requests: [] },
        ws: { frames: [] },
      },
    })

    expect(result).not.toHaveProperty('terminalStoppedRetentionCoveredMs')
    expect(result).not.toHaveProperty('terminalStopResumeGapCount')
  })
})
