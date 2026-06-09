import type { LiveWebSocket } from '../ws-handler.js'
import type { ClientOutputQueue } from './client-output-queue.js'
import type { ReplayFrame, ReplayRing } from './replay-ring.js'

export type BrokerClientMode = 'attaching' | 'live'
export type BrokerClientPriority = 'foreground' | 'background'

export type ReplayCursor = {
  nextSeq: number
  toSeq: number
  streamId: string
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
}

export type BrokerTerminalState = {
  replayRing: ReplayRing
  clients: Map<LiveWebSocket, BrokerClientAttachment>
}
