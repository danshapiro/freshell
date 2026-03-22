import type { AppDispatch, RootState } from './store'
import { updatePaneTitle, updatePaneTitleByTerminalId } from './panesSlice'
import { setTabTitle, updateTab } from './tabsSlice'
import { clearPaneRuntimeTitleByTerminalId } from './paneRuntimeTitleSlice'
import {
  resolveEffectiveLegacyTabTitleSource,
  shouldReplaceDurableTitleSource,
  type DurableTitleSource,
} from '@/lib/title-source'
import type { Tab } from './types'

type TitleSyncThunk = (dispatch: AppDispatch, getState: () => RootState) => void

function getSinglePaneId(state: RootState, tabId: string): string | null {
  const layout = state.panes.layouts[tabId]
  if (!layout || layout.type !== 'leaf') return null
  return layout.id
}

function resolveEffectiveTabTitleSource(
  state: RootState,
  tab: Tab,
): DurableTitleSource {
  const layout = state.panes.layouts[tab.id]
  const paneId = layout?.type === 'leaf' ? layout.id : undefined
  return tab.titleSource
    ?? resolveEffectiveLegacyTabTitleSource({
      storedTitle: tab.title,
      titleSetByUser: tab.titleSetByUser,
      layout,
      paneTitle: paneId ? state.panes.paneTitles[tab.id]?.[paneId] : undefined,
      paneTitleSource: paneId ? state.panes.paneTitleSources?.[tab.id]?.[paneId] : undefined,
      extensions: state.extensions?.entries,
    })
    ?? (tab.titleSetByUser ? 'user' : 'stable')
}

export function syncStableTitleByTerminalId(input: {
  terminalId: string
  title: string
}): TitleSyncThunk {
  return (dispatch, getState) => {
    dispatch(updatePaneTitleByTerminalId({
      terminalId: input.terminalId,
      title: input.title,
      source: 'stable',
    }))
    dispatch(clearPaneRuntimeTitleByTerminalId({ terminalId: input.terminalId }))

    const state = getState()
    for (const tab of state.tabs.tabs) {
      const layout = state.panes.layouts[tab.id]
      if (layout?.type !== 'leaf') continue
      if (layout.content.kind !== 'terminal' || layout.content.terminalId !== input.terminalId) {
        continue
      }

      const currentSource = resolveEffectiveTabTitleSource(state, tab)
      if (!shouldReplaceDurableTitleSource(currentSource, 'stable')) {
        continue
      }

      dispatch(setTabTitle({
        id: tab.id,
        title: input.title,
        source: 'stable',
      }))
    }
  }
}

export function applyPaneRename(input: {
  tabId: string
  paneId: string
  title: string
}): TitleSyncThunk {
  return (dispatch, getState) => {
    dispatch(updatePaneTitle({
      ...input,
      source: 'user',
    }))

    const singlePaneId = getSinglePaneId(getState(), input.tabId)
    if (singlePaneId !== input.paneId) return

    dispatch(updateTab({
      id: input.tabId,
      updates: {
        title: input.title,
        source: 'user',
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
        source: 'user',
      },
    }))

    const singlePaneId = getSinglePaneId(getState(), input.tabId)
    if (!singlePaneId) return

    dispatch(updatePaneTitle({
      tabId: input.tabId,
      paneId: singlePaneId,
      title: input.title,
      source: 'user',
    }))
  }
}
