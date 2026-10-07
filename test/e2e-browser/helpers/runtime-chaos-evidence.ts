import type { ExactRuntimeHandle, NativeToolEvidence } from '../../../scripts/testing/runtime-sandbox.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { ManagedRuntimeView, ManagedFixtureRig } from './managed-runtime.js'



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

export type StructuredChaosLog = {
  source: 'server' | 'browser'
  sequence: number
  monotonicMs: number
  level: string
  event: string
  contentSha256: string
  contentBytes: number
  redacted: true
}

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
  if (claim.activeClaimCount !== 1 || claim.globalConflictingClaimCount !== 0) {
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

export function structuredChaosLog(
  source: 'server' | 'browser',
  sequence: number,
  monotonicMs: number,
  level: string,
  event: string,
  transientContent: string,
): StructuredChaosLog {
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

export function writePrivateJsonl(filePath: string, rows: readonly StructuredChaosLog[]): void {
  if (rows.length === 0) throw new Error('refusing to persist an empty chaos log')
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}
