import type { LiveWebSocket } from '../ws-handler.js'
import type { ClientOutputQueue } from './client-output-queue.js'
import type { ReplayFrame, ReplayRing } from './replay-ring.js'

export type BrokerClientMode = 'attaching' | 'live'

export type BrokerClientAttachment = {
  ws: LiveWebSocket
  mode: BrokerClientMode
  queue: ClientOutputQueue
  attachStaging: ReplayFrame[]
  lastSeq: number
  flushTimer: NodeJS.Timeout | null
  catastrophicSince?: number
}

export type BrokerTerminalState = {
  replayRing: ReplayRing
  clients: Map<LiveWebSocket, BrokerClientAttachment>
}
