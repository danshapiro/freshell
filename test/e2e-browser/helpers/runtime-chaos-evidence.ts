import type { ExactRuntimeHandle, NativeToolEvidence } from '../../../scripts/testing/runtime-sandbox.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { ManagedRuntimeView, ManagedFixtureRig } from './managed-runtime.js'
import type { RuntimeChaosLog } from '../../../scripts/testing/runtime-sandbox.js'
import type { TestInfo } from '@playwright/test'
export { writePrivateRuntimeChaosJsonl as writePrivateJsonl } from '../../../scripts/testing/runtime-sandbox.js'



export type ChaosRuntimeObservation = {
  soulId: string
  incarnationId: string
  containerId: string
  hostBootId: string
  nativeSessionId: string
  providerPid: number
  providerLaunchCount: number
  activeWriters: number
  unsafeBrokerAttempts: number
  limits: { cpuMax: string; memoryMax: string; swapMax: string; pidsMax: string }
}

export type { NativeToolEvidence } from '../../../scripts/testing/runtime-sandbox.js'

export type StructuredChaosLog = RuntimeChaosLog

export async function captureChaosRuntimeObservation(
  rig: ManagedFixtureRig,
  expected: Pick<ManagedRuntimeView, 'soulId' | 'incarnationId' | 'containerId' | 'hostBootId' | 'nativeSessionId'>,
): Promise<ChaosRuntimeObservation> {
  if (!expected.containerId || !expected.hostBootId || !expected.nativeSessionId) {
    throw new Error('chaos observation lacks an exact initial runtime identity')
  }
  const snapshot = await rig.inventorySnapshot()
  const rows = (snapshot.souls as ManagedRuntimeView[]).filter((row) => (
    row.soulId === expected.soulId && row.launchState === 'running'
  ))
  if (rows.length !== 1) throw new Error(`chaos expected exactly one running incarnation, observed ${rows.length}`)
  const row = rows[0]
  const claim = await rig.writerClaimFacts(rig.exactRuntimeHandle(expected))
  if (claim.provider !== 'opencode' || claim.activeClaimCount !== 1 || claim.globalConflictingClaimCount !== 0) {
    throw new Error('chaos writer claim is not uniquely owned')
  }
  const ownerFacts = await rig.chaosHostFacts(rig.exactRuntimeHandle(expected))
  return {
    soulId: row.soulId,
    incarnationId: row.incarnationId,
    containerId: row.containerId ?? '',
    hostBootId: row.hostBootId ?? '',
    nativeSessionId: row.nativeSessionId ?? '',
    providerPid: ownerFacts.workerPid,
    providerLaunchCount: ownerFacts.workerLaunchCount,
    activeWriters: claim.activeClaimCount,
    unsafeBrokerAttempts: ownerFacts.unsafeBrokerAttempts,
    limits: ownerFacts.limits,
  }
}

export async function nativeToolEvidence(
  rig: ManagedFixtureRig, handle: ExactRuntimeHandle, challengeId: string,
): Promise<NativeToolEvidence> {
  return rig.nativeToolEvidence(handle, challengeId)
}

export async function nativeFollowUpMessageIds(
  rig: ManagedFixtureRig, handle: ExactRuntimeHandle, challengeId: string,
): Promise<string[]> {
  return rig.nativeFollowUpMessageIds(handle, challengeId)
}

export function structuredChaosLog<T extends StructuredChaosLog['source']>(
  source: T,
  sequence: number,
  monotonicMs: number,
  level: string,
  event: string,
  transientContent: string,
): StructuredChaosLog & { source: T } {
  return {
    source,
    sequence,
    monotonicMs,
    level,
    event,
    contentSha256: createHash('sha256').update(transientContent).digest('hex'),
    contentBytes: Buffer.byteLength(transientContent),
    redacted: true,
  }
}

export function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

type InterruptedOrdinaryStopPane = {
  id: string
  type: string
  content: {
    kind: string
    soulId?: string
    createRequestId: string
    provider: string
    sessionType: string
    sessionId?: string | null
    sessionRef?: { provider: string; sessionId: string }
  }
}

export function bindInterruptedOrdinaryStopFailedAck(
  sent: any[], sentAtStop: number,
  owned: {
    pane: InterruptedOrdinaryStopPane
    paneId: string; createRequestId: string; soulId: string; nativeSessionId: string
    provider: string; sessionType: string
    pendingCreate?: { sessionId?: string; provider?: string; sessionType?: string }
  },
): (received: any[], receivedAtStop: number) => boolean {
  const content = owned.pane?.content
  if (owned.pane?.type !== 'leaf' || owned.pane.id !== owned.paneId
    || content?.kind !== 'fresh-agent' || content.createRequestId !== owned.createRequestId
    || content.soulId !== owned.soulId || content.provider !== owned.provider
    || content.sessionType !== owned.sessionType || content.sessionRef?.provider !== owned.provider
    || content.sessionRef.sessionId !== owned.nativeSessionId || !owned.nativeSessionId.trim()) {
    throw new Error('interrupted ordinary Stop lacks the exact owned pane/native identity')
  }
  const pending = owned.pendingCreate
  if (!content.sessionId && pending?.sessionId && (pending.provider !== owned.provider || pending.sessionType !== owned.sessionType)) {
    throw new Error('interrupted ordinary Stop pending target lacks matching provider/type evidence')
  }
  const expectedTarget = content.sessionId || pending?.sessionId || content.sessionRef.sessionId
  const requests = sent.slice(sentAtStop).filter((message) => message?.type === 'freshAgent.kill')
  if (requests.length !== 1) throw new Error('interrupted ordinary Stop requires exactly one post-click kill')
  const { sessionId, provider, sessionType } = requests[0]
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId !== expectedTarget
    || provider !== owned.provider || sessionType !== owned.sessionType) {
    throw new Error('interrupted ordinary Stop kill does not target the owned pane')
  }
  // Freeze the validated outbound tuple. This broadcast protocol cannot
  // distinguish another operation with the identical target/provider/type.
  return (received, receivedAtStop) => received.slice(receivedAtStop).some((message) => {
    if (message?.sessionId !== sessionId || message.provider !== provider || message.sessionType !== sessionType) return false
    const event = message.type === 'freshAgent.event' ? message.event
      : message.type === 'freshAgent.killed' ? message : undefined
    return event?.type === 'freshAgent.killed' && event.success === false
  })
}

export async function reportInterruptedOrdinaryStopAckFailure(
  failure: unknown,
  testInfo: Pick<TestInfo, 'attach'>,
  capture: {
    expected: { presentationSessionId: string | null; nativeSessionId: string; soulId: string }
    sentAtStop: number
    receivedAtStop: number
    stopSocketAtMs: number
    sent: any[]
    received: any[]
    sentSocketFacts: { socketOrdinal: number; atMs: number }[]
    receivedSocketFacts: { socketOrdinal: number; atMs: number }[]
    socketLifecycle: { socketOrdinal: number; atMs: number; event: string }[]
  },
): Promise<never> {
  try {
    const killFrames = (frames: any[], offset: number, socketFacts: typeof capture.sentSocketFacts) => frames.slice(offset).flatMap((message, index) => {
      const event = message.type === 'freshAgent.event' ? message.event : message
      if (!['freshAgent.kill', 'freshAgent.killed'].includes(event?.type)) return []
      return [{ ...socketFacts[offset + index], arrayIndex: offset + index,
        type: message.type, eventType: event.type, sessionId: message.sessionId, eventSessionId: event.sessionId,
        provider: message.provider, eventProvider: event.provider,
        sessionType: message.sessionType, eventSessionType: event.sessionType,
        observedEpoch: message.observedEpoch, observedGeneration: message.observedGeneration,
        success: event.success, code: event.code }]
    })
    const body = JSON.stringify({ severity: 'error', event: 'interrupted_ordinary_stop_ack_missing', expected: capture.expected,
      sentAtStop: capture.sentAtStop, receivedAtStop: capture.receivedAtStop, stopSocketAtMs: capture.stopSocketAtMs,
      sent: killFrames(capture.sent, capture.sentAtStop, capture.sentSocketFacts),
      received: killFrames(capture.received, capture.receivedAtStop, capture.receivedSocketFacts),
      socketLifecycle: capture.socketLifecycle })
    // Cloud's execution-log display collects textPayload; a prefix keeps this
    // complete record there instead of an unqueried structured JSON payload.
    process.stdout.write(`[interrupted-ordinary-stop-ack-sockets] ${body}\n`)
    await testInfo.attach('interrupted-ordinary-stop-ack-sockets', {
      contentType: 'application/json', body: Buffer.from(body),
    })
  } finally { throw failure }
}
