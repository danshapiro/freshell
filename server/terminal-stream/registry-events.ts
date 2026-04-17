import type { CodingCliProviderName } from '../../shared/ws-protocol.js'

export type SessionBindingReason = 'start' | 'resume' | 'association'
export type SessionUnbindReason = 'exit' | 'rebind' | 'stale_owner' | 'repair_duplicate'

export type TerminalInputRawEvent = {
  terminalId: string
  data: string
  at: number
}

export type TerminalOutputRawEvent = {
  terminalId: string
  data: string
  at: number
}

export type TerminalSessionBoundEvent = {
  terminalId: string
  provider: CodingCliProviderName
  sessionId: string
  reason: SessionBindingReason
}

export type TerminalSessionUnboundEvent = {
  terminalId: string
  provider: CodingCliProviderName
  sessionId: string
  reason: SessionUnbindReason
}
