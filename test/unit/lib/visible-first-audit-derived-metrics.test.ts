// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  deriveVisibleFirstMetrics,
  normalizeAuditRouteId,
} from '@test/e2e-browser/perf/derive-visible-first-metrics'

describe('deriveVisibleFirstMetrics', () => {
  it('normalizes routes and counts offscreen work before focused readiness', () => {
    expect(normalizeAuditRouteId('http://localhost:3000/api/sessions/abc123?token=secret')).toBe(
      '/api/sessions/:sessionId',
    )

    const input = {
      focusedReadyMilestone: 'terminal.first_output',
      allowedApiRouteIdsBeforeReady: ['/api/settings', '/api/terminals'],
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
            { timestamp: 20, url: 'http://localhost:3000/api/settings', encodedDataLength: 10 },
            { timestamp: 60, url: 'http://localhost:3000/api/sessions/abc123', encodedDataLength: 20 },
            { timestamp: 120, url: 'http://localhost:3000/api/terminals', encodedDataLength: 30 },
          ],
        },
        ws: {
          frames: [
            { timestamp: 30, payload: JSON.stringify({ type: 'hello' }), payloadLength: 8 },
            { timestamp: 40, payload: JSON.stringify({ type: 'sdk.history' }), payloadLength: 9 },
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
})
