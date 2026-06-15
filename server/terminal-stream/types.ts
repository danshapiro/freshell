import type { LiveWebSocket } from '../ws-handler.js'
import type { ClientOutputQueue } from './client-output-queue.js'
import type { ReplayFrame, ReplayRing } from './replay-ring.js'
import type { TerminalGeometryAuthority } from '../../shared/ws-protocol.js'

export type BrokerClientMode = 'attaching' | 'live'
export type BrokerClientPriority = 'foreground' | 'background'

export type ReplayCursor = {
  nextSeq: number
  toSeq: number
  streamId: string
}

export type ReplayProgressLogState = {
  startedAt: number
  batchCount: number
  rawFrameCount: number
  dataBytes: number
  serializedBytes: number
  payloadTypes: Set<string>
  seqStart?: number
  seqEnd?: number
  streamId?: string
  maxBufferedAmount?: number
}

export type BrokerClientAttachment = {
  ws: LiveWebSocket
  mode: BrokerClientMode
  priority: BrokerClientPriority
  queue: ClientOutputQueue
  replayCursor: ReplayCursor | null
  attachStaging: ReplayFrame[]
  lastSeq: number
  flushTimer: NodeJS.Timeout | null
  activeAttachRequestId?: string
  catastrophicSince?: number
  catastrophicClosed?: boolean
  replayBackpressureLogLastAt?: number
  replayBackpressureLogSuppressed?: number
  replayBackpressureActive?: boolean
  replayBackpressureSince?: number
  replayProgressLog?: ReplayProgressLogState
  terminalOutputBatchV1: boolean
}

export type BrokerTerminalState = {
  replayRing: ReplayRing
  clients: Map<LiveWebSocket, BrokerClientAttachment>
  geometryEpoch: number
  geometryAuthority: TerminalGeometryAuthority
  geometryCols?: number
  geometryRows?: number
  replayRetentionLogLastAt?: number
  replayRetentionLogSuppressed?: number
}
