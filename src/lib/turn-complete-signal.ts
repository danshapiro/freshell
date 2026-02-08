import type { TabMode } from '@/store/types'

export const TURN_COMPLETE_SIGNAL = '\x07'
const ESC = '\x1b'
const C1_ST = '\x9c'

export type TurnCompleteSignalParserState = {
  inOsc: boolean
  pendingEsc: boolean
}

export function createTurnCompleteSignalParserState(): TurnCompleteSignalParserState {
  return { inOsc: false, pendingEsc: false }
}

function supportsTurnSignal(mode: TabMode): boolean {
  return mode === 'claude' || mode === 'codex'
}

export function extractTurnCompleteSignals(
  data: string,
  mode: TabMode,
  state?: TurnCompleteSignalParserState
): { cleaned: string; count: number } {
  if (!supportsTurnSignal(mode)) {
    if (state?.pendingEsc) {
      state.pendingEsc = false
      state.inOsc = false
      return { cleaned: `${ESC}${data}`, count: 0 }
    }
    return { cleaned: data, count: 0 }
  }

  const parserState = state ?? createTurnCompleteSignalParserState()
  let inOsc = parserState.inOsc
  let pendingEsc = parserState.pendingEsc
  let cleaned = ''
  let count = 0

  for (const ch of data) {
    if (pendingEsc) {
      if (!inOsc && ch === ']') {
        cleaned += `${ESC}]`
        inOsc = true
      } else if (inOsc && ch === '\\') {
        cleaned += `${ESC}\\`
        inOsc = false
      } else {
        cleaned += `${ESC}${ch}`
      }
      pendingEsc = false
      continue
    }

    if (ch === ESC) {
      pendingEsc = true
      continue
    }

    if (ch === TURN_COMPLETE_SIGNAL) {
      if (inOsc) {
        cleaned += ch
        inOsc = false
      } else {
        count += 1
      }
      continue
    }

    if (ch === C1_ST) {
      if (inOsc) {
        cleaned += ch
        inOsc = false
      } else {
        cleaned += ch
      }
      continue
    }

    cleaned += ch
  }

  parserState.inOsc = inOsc
  parserState.pendingEsc = pendingEsc
  return { cleaned, count }
}
