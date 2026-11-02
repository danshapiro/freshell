import { describe, it, expect } from 'vitest'
import {
  PaneReconcileRequestSchema,
  PaneReconcileResultSchema,
  ClientMessageSchema,
  HelloSchema,
  ReadyCapabilitiesSchema,
  SessionsIndexReadySchema,
  WS_PROTOCOL_VERSION,
} from '@shared/ws-protocol'

describe('pane.reconcile schemas', () => {
  const request = {
    type: 'pane.reconcile.request',
    reconcileId: 'rec-1',
    panes: [{
      paneKey: 'tab1:paneA', kind: 'terminal', mode: 'claude',
      createRequestId: 'cr-1', terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId: 's-1' }, status: 'running',
    }],
  }
  it('parses a valid request and accepts it in the client union', () => {
    expect(PaneReconcileRequestSchema.parse(request)).toBeTruthy()
    expect(ClientMessageSchema.safeParse(request).success).toBe(true)
  })
  it('rejects >200 panes', () => {
    const big = { ...request, panes: Array.from({ length: 201 }, (_, i) => ({ ...request.panes[0], paneKey: `t:${i}` })) }
    expect(PaneReconcileRequestSchema.safeParse(big).success).toBe(false)
  })
  it('parses a result with the 6-verdict enum and no retry', () => {
    const result = {
      type: 'pane.reconcile.result', reconcileId: 'rec-1', bootId: 'b1', serverInstanceId: 'srv1',
      verdicts: [
        { paneKey: 'tab1:paneA', verdict: 'attach', terminalId: 'term-1', corrected: true },
        { paneKey: 'tab1:paneB', verdict: 'error', reason: 'index_warming' },
      ],
    }
    expect(PaneReconcileResultSchema.parse(result)).toBeTruthy()
    expect(PaneReconcileResultSchema.safeParse({ ...result, verdicts: [{ paneKey: 'x', verdict: 'retry' }] }).success).toBe(false)
  })
})

describe('sessionIndexReadyV1 wire surface (auto-restore-warming Task 2)', () => {
  it('declares the sessionIndexReadyV1 hello capability (strip hazard)', () => {
    // HelloSchema is a zod non-strict object: an UNDECLARED key is silently
    // STRIPPED on parse, so a capability that is only SENT (ws-client) but
    // not DECLARED here would silently no-op. Assert the key SURVIVES.
    const parsed = HelloSchema.safeParse({
      type: 'hello',
      protocolVersion: WS_PROTOCOL_VERSION,
      capabilities: { sessionIndexReadyV1: true },
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.capabilities?.sessionIndexReadyV1 : undefined).toBe(true)
  })

  it('echoes sessionIndexReadyV1 in the ready capabilities (strip hazard)', () => {
    // Same strip hazard as the hello capability: the ready echo must
    // SURVIVE parsing, not merely parse successfully.
    const parsed = ReadyCapabilitiesSchema.safeParse({ sessionIndexReadyV1: true })
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data?.sessionIndexReadyV1 : undefined).toBe(true)
  })

  it('parses the sessions.index.ready server frame', () => {
    expect(SessionsIndexReadySchema.safeParse({ type: 'sessions.index.ready' }).success).toBe(true)
  })
})
