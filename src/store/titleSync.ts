import type { AppDispatch, RootState } from './store'
import { updatePaneTitle } from './panesSlice'
import { updateTab } from './tabsSlice'

type TitleSyncThunk = (dispatch: AppDispatch, getState: () => RootState) => void

function getSinglePaneId(state: RootState, tabId: string): string | null {
  const layout = state.panes.layouts[tabId]
  if (!layout || layout.type !== 'leaf') return null
  return layout.id
}

export function applyPaneRename(input: {
  tabId: string
  paneId: string
  title: string
}): TitleSyncThunk {
  return (dispatch, getState) => {
    dispatch(updatePaneTitle(input))

    const singlePaneId = getSinglePaneId(getState(), input.tabId)
    if (singlePaneId !== input.paneId) return

    dispatch(updateTab({
      id: input.tabId,
      updates: {
        title: input.title,
        titleSetByUser: true,
      },
    }))
  }
}

export function applyTabRename(input: {
  tabId: string
  title: string
}): TitleSyncThunk {
  return (dispatch, getState) => {
    dispatch(updateTab({
      id: input.tabId,
      updates: {
        title: input.title,
        titleSetByUser: true,
      },
    }))

    const singlePaneId = getSinglePaneId(getState(), input.tabId)
    if (!singlePaneId) return

    dispatch(updatePaneTitle({
      tabId: input.tabId,
      paneId: singlePaneId,
      title: input.title,
    }))
  }
}
