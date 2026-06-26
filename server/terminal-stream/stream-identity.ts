import { randomUUID } from 'node:crypto'

export type TerminalStreamReplacementReason =
  | 'codex_pty_recovery'
  | 'server_restart_incompatible_retention'

export type TerminalStreamIdentityTracker = {
  ensureStream: (terminalId: string) => string
  getStream: (terminalId: string) => string | undefined
  recordAttach: (terminalId: string) => string
  recordDetach: (terminalId: string) => string | undefined
  replaceStream: (terminalId: string, reason: TerminalStreamReplacementReason) => string
  forgetStream: (terminalId: string) => void
}

type StreamState = {
  streamId: string
  generation: number
}

export function createTerminalStreamIdentityTracker(): TerminalStreamIdentityTracker {
  const streams = new Map<string, StreamState>()

  const mintStreamId = () => randomUUID()

  const ensureState = (terminalId: string): StreamState => {
    let state = streams.get(terminalId)
    if (!state) {
      state = {
        streamId: mintStreamId(),
        generation: 1,
      }
      streams.set(terminalId, state)
    }
    return state
  }

  return {
    ensureStream(terminalId) {
      return ensureState(terminalId).streamId
    },
    getStream(terminalId) {
      return streams.get(terminalId)?.streamId
    },
    recordAttach(terminalId) {
      const state = ensureState(terminalId)
      return state.streamId
    },
    recordDetach(terminalId) {
      const state = streams.get(terminalId)
      if (!state) return undefined
      return state.streamId
    },
    replaceStream(terminalId, _reason) {
      const state = ensureState(terminalId)
      state.generation += 1
      state.streamId = mintStreamId()
      return state.streamId
    },
    forgetStream(terminalId) {
      streams.delete(terminalId)
    },
  }
}
