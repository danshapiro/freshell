import type { TerminalTurnCompleteMessage } from '@shared/ws-protocol'
import { selectTabPaneByTerminalId } from './selectors/paneTerminalSelectors'
import { recordTurnComplete } from './turnCompletionSlice'
import type { AppDispatch, RootState } from './store'

export type ApplyServerCompletionPayload = {
  terminalId: string
  provider: TerminalTurnCompleteMessage['provider']
  at: number
  completionSeq: number
}

export function applyServerCompletion(payload: ApplyServerCompletionPayload) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const state = getState()
    const lastApplied = state.turnCompletion?.lastAppliedCompletionSeqByTerminalId?.[payload.terminalId]
    if (lastApplied !== undefined && payload.completionSeq <= lastApplied) return

    const location = selectTabPaneByTerminalId(state, payload.terminalId)
    if (!location) return

    dispatch(recordTurnComplete({
      tabId: location.tabId,
      paneId: location.paneId,
      terminalId: payload.terminalId,
      at: payload.at,
      completionSeq: payload.completionSeq,
    }))
  }
}
