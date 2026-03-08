import type { TabMode } from '@/store/types'
import {
  TURN_COMPLETE_SIGNAL,
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals as extractSharedTurnCompleteSignals,
  type TurnCompleteSignalParserState,
} from '@shared/turn-complete-signal'

export { TURN_COMPLETE_SIGNAL, createTurnCompleteSignalParserState }
export type { TurnCompleteSignalParserState }

export function extractTurnCompleteSignals(
  data: string,
  mode: TabMode,
  state?: TurnCompleteSignalParserState,
): { cleaned: string; count: number } {
  return extractSharedTurnCompleteSignals(data, mode, state)
}
