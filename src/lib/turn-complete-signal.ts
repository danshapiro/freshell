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

function normalizeTurnCompleteSignalMode(mode: TabMode): TurnCompleteSignalMode {
  switch (mode) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'gemini':
    case 'kimi':
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
