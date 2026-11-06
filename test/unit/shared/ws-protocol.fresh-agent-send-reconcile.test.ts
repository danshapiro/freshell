import { describe, expect, it } from 'vitest'

import {
  ClientMessageSchema,
  FreshAgentSendReconcileSchema,
  FreshAgentSendSchema,
  HelloSchema,
  ReadyCapabilitiesSchema,
} from '../../../shared/ws-protocol.js'

const sendFields = {
  provider: 'codex',
  sessionId: 'thread-1',
  sessionType: 'freshcodex',
  requestId: 'request-1',
  text: 'the original input',
  settings: { model: 'gpt-5-codex', effort: 'high', sandbox: 'workspace-write' },
  checkpointIntent: {
    logicalAttemptId: 'attempt-1',
    workspace: { path: '/workspace', provenance: 'resolved-project' },
  },
  observedEpoch: 3,
  observedGeneration: 8,
} as const

describe('fresh-agent receipt-only send protocol', () => {
  it('accepts the same correlated checkpoint payload as a normal send', () => {
    const normal = FreshAgentSendSchema.parse({ type: 'freshAgent.send', ...sendFields })
    const reconcile = FreshAgentSendReconcileSchema.parse({
      type: 'freshAgent.send.reconcile',
      ...sendFields,
    })

    expect(reconcile).toEqual({ ...normal, type: 'freshAgent.send.reconcile' })
    expect(ClientMessageSchema.safeParse(reconcile).success).toBe(true)
  })

  it('retains the capability through hello parsing and ready parsing', () => {
    const hello = HelloSchema.parse({
      type: 'hello',
      protocolVersion: 10,
      capabilities: { managedRuntimeV1: true, freshAgentSendReconcileV1: true },
    })
    expect(hello.capabilities).toEqual({
      managedRuntimeV1: true,
      freshAgentSendReconcileV1: true,
    })
    expect(ReadyCapabilitiesSchema.parse({
      managedRuntimeV1: true,
      freshAgentSendReconcileV1: true,
    })).toEqual({ managedRuntimeV1: true, freshAgentSendReconcileV1: true })
  })
})
