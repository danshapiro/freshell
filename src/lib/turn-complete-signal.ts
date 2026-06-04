import type { TabMode } from '@/store/types'
import {
  TURN_COMPLETE_SIGNAL,
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals as extractSharedTurnCompleteSignals,
  type TurnCompleteSignalMode,
  type TurnCompleteSignalParserState,
} from '@shared/turn-complete-signal'

export { TURN_COMPLETE_SIGNAL, createTurnCompleteSignalParserState }
export type { TurnCompleteSignalParserState }

// gemini/kimi are intentionally NOT mapped here: the shared `supportsTurnSignal`
// gate only recognizes claude/codex, so a gemini/kimi pass-through implied a
// turn-complete capability that never existed. They normalize to 'shell' (status
// inert) until their CLIs expose a real turn-complete signal.
export function normalizeTurnCompleteSignalMode(mode: TabMode): TurnCompleteSignalMode {
  switch (mode) {
    case 'claude':
    case 'codex':
    case 'opencode':
      return mode
    default:
      return 'shell'
  }
}

export function extractTurnCompleteSignals(
  data: string,
  mode: TabMode,
  state?: TurnCompleteSignalParserState,
): { cleaned: string; count: number } {
  return extractSharedTurnCompleteSignals(data, normalizeTurnCompleteSignalMode(mode), state)
}
