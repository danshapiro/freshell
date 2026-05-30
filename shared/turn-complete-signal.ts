export const TURN_COMPLETE_SIGNAL = '\x07'
const ESC = '\x1b'
const C1_ST = '\x9c'
const C1_CSI = '\x9b'
const C1_DCS = '\x90'
const C1_OSC = '\x9d'

export type TurnCompleteSignalMode = 'shell' | (string & {})

export type TurnCompleteSignalParserState = {
  inOsc: boolean
  inCsi: boolean
  inDcs: boolean
  pendingEsc: boolean
}

export function createTurnCompleteSignalParserState(): TurnCompleteSignalParserState {
  return { inOsc: false, inCsi: false, inDcs: false, pendingEsc: false }
}

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/

function isIgnorableLeadingTurnCompleteChar(ch: string): boolean {
  return ch !== TURN_COMPLETE_SIGNAL && (
    /\s/.test(ch)
    || CONTROL_CHAR_RE.test(ch)
  )
}

/**
 * Counts only turn-complete BELs that are "tracker-eligible": a BEL that is
 * either leading (no visible output before it in the chunk) or has no visible
 * output after it. A BEL sandwiched between visible output (a stray bell from
 * a sub-tool) is NOT counted. OSC/DCS/CSI-enclosed BELs are skipped.
 */
export function countTrackerTurnCompleteSignals(
  data: string,
  state: TurnCompleteSignalParserState,
): number {
  let inOsc = state.inOsc
  let pendingEsc = state.pendingEsc
  let inCsi = state.inCsi
  let inDcs = state.inDcs
  let sawVisibleOutput = false
  const candidates: Array<{ leadingEligible: boolean; hasVisibleAfter: boolean }> = []

  const markVisibleOutput = () => {
    sawVisibleOutput = true
    for (const candidate of candidates) {
      candidate.hasVisibleAfter = true
    }
  }

  for (const ch of data) {
    if (pendingEsc) {
      if (inOsc && ch === '\\') {
        inOsc = false
      } else if (inDcs && ch === '\\') {
        inDcs = false
      } else if (!inOsc && !inDcs && ch === ']') {
        inOsc = true
      } else if (!inOsc && !inDcs && ch === '[') {
        inCsi = true
      } else if (!inOsc && !inDcs && ch === 'P') {
        inDcs = true
      }
      pendingEsc = false
      continue
    }

    if (ch === ESC) {
      pendingEsc = true
      continue
    }

    if (inOsc) {
      if (ch === TURN_COMPLETE_SIGNAL || ch === C1_ST) {
        inOsc = false
      }
      continue
    }

    if (inDcs) {
      if (ch === C1_ST) {
        inDcs = false
      }
      continue
    }

    if (inCsi) {
      if (ch >= '@' && ch <= '~') {
        inCsi = false
      }
      continue
    }

    if (ch === C1_CSI) {
      inCsi = true
      continue
    }
    if (ch === C1_DCS) {
      inDcs = true
      continue
    }
    if (ch === C1_OSC) {
      inOsc = true
      continue
    }
    if (ch === TURN_COMPLETE_SIGNAL) {
      candidates.push({
        leadingEligible: !sawVisibleOutput,
        hasVisibleAfter: false,
      })
      continue
    }
    if (isIgnorableLeadingTurnCompleteChar(ch)) {
      continue
    }
    markVisibleOutput()
  }

  return candidates.filter((candidate) => candidate.leadingEligible || !candidate.hasVisibleAfter).length
}

export function isSubmitInput(data: string): boolean {
  return /^(?:\r\n|\r|\n)+$/.test(data)
}

function supportsTurnSignal(mode: TurnCompleteSignalMode): boolean {
  return mode === 'claude' || mode === 'codex'
}

export function extractTurnCompleteSignals(
  data: string,
  mode: TurnCompleteSignalMode,
  state?: TurnCompleteSignalParserState,
): { cleaned: string; count: number } {
  if (!supportsTurnSignal(mode)) {
    if (state?.pendingEsc) {
      state.pendingEsc = false
      state.inOsc = false
      state.inCsi = false
      state.inDcs = false
      return { cleaned: `${ESC}${data}`, count: 0 }
    }
    return { cleaned: data, count: 0 }
  }

  const parserState = state ?? createTurnCompleteSignalParserState()
  let inOsc = parserState.inOsc
  let inCsi = parserState.inCsi
  let inDcs = parserState.inDcs
  let pendingEsc = parserState.pendingEsc
  let cleaned = ''
  let count = 0

  for (const ch of data) {
    if (pendingEsc) {
      if (inOsc && ch === '\\') {
        cleaned += `${ESC}\\`
        inOsc = false
      } else if (inDcs && ch === '\\') {
        cleaned += `${ESC}\\`
        inDcs = false
      } else if (!inOsc && !inDcs && ch === ']') {
        cleaned += `${ESC}]`
        inOsc = true
      } else if (!inOsc && !inDcs && ch === '[') {
        cleaned += `${ESC}[`
        inCsi = true
      } else if (!inOsc && !inDcs && ch === 'P') {
        cleaned += `${ESC}P`
        inDcs = true
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

    if (ch === C1_CSI) {
      cleaned += ch
      inCsi = true
      continue
    }

    if (ch === C1_DCS) {
      cleaned += ch
      inDcs = true
      continue
    }

    if (ch === C1_OSC) {
      cleaned += ch
      inOsc = true
      continue
    }

    if (inCsi) {
      cleaned += ch
      if (ch >= '@' && ch <= '~') {
        inCsi = false
      }
      continue
    }

    if (ch === TURN_COMPLETE_SIGNAL) {
      if (inOsc) {
        cleaned += ch
        inOsc = false
      } else if (inDcs) {
        cleaned += ch
      } else {
        count += 1
      }
      continue
    }

    if (ch === C1_ST) {
      if (inOsc) {
        cleaned += ch
        inOsc = false
      } else if (inDcs) {
        cleaned += ch
        inDcs = false
      } else {
        cleaned += ch
      }
      continue
    }

    if (inDcs) {
      cleaned += ch
      continue
    }

    cleaned += ch
  }

  parserState.inOsc = inOsc
  parserState.inCsi = inCsi
  parserState.inDcs = inDcs
  parserState.pendingEsc = pendingEsc
  return { cleaned, count }
}
