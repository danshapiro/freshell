import { createAsyncThunk } from '@reduxjs/toolkit'
import { updatePaneTitleByTerminalId } from './panesSlice'

/**
 * Update pane titles for all panes matching a terminalId.
 * Single-pane tab displays resolve from the pane title, so callers do not
 * need to mirror runtime/session titles into tab state.
 */
export const syncPaneTitleByTerminalId = createAsyncThunk(
  'panes/syncPaneTitleByTerminalId',
  async (
    { terminalId, title }: { terminalId: string; title: string },
    { dispatch }
  ) => {
    dispatch(updatePaneTitleByTerminalId({ terminalId, title, setByUser: false }))
  }
)
