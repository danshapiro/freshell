import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { PaneNode } from './paneTypes'
import type { RootState } from './store'
import {
  closePane,
  hydratePanes,
  mergePaneContent,
  removeLayout,
  replacePane,
  restoreLayout,
  updatePaneTitle,
  updatePaneContent,
} from './panesSlice'
import { normalizeRuntimeTitle } from '@/lib/title-source'

export interface PaneRuntimeTitleState {
  titlesByPaneId: Record<string, string>
}

const initialState: PaneRuntimeTitleState = {
  titlesByPaneId: {},
}

function clearPaneIds(state: PaneRuntimeTitleState, paneIds: string[]) {
  for (const paneId of paneIds) {
    delete state.titlesByPaneId[paneId]
  }
}

function findPaneIdsByTerminalId(node: PaneNode | undefined, terminalId: string): string[] {
  if (!node) return []
  if (node.type === 'leaf') {
    return node.content.kind === 'terminal' && node.content.terminalId === terminalId
      ? [node.id]
      : []
  }

  return [
    ...findPaneIdsByTerminalId(node.children[0], terminalId),
    ...findPaneIdsByTerminalId(node.children[1], terminalId),
  ]
}

export const paneRuntimeTitleSlice = createSlice({
  name: 'paneRuntimeTitle',
  initialState,
  reducers: {
    setPaneRuntimeTitle: (
      state,
      action: PayloadAction<{ paneId: string; title: string | null | undefined }>,
    ) => {
      const normalizedTitle = normalizeRuntimeTitle(action.payload.title)
      if (!normalizedTitle) {
        delete state.titlesByPaneId[action.payload.paneId]
        return
      }
      state.titlesByPaneId[action.payload.paneId] = normalizedTitle
    },
    clearPaneRuntimeTitle: (state, action: PayloadAction<{ paneId: string }>) => {
      delete state.titlesByPaneId[action.payload.paneId]
    },
    clearPaneRuntimeTitles: (state, action: PayloadAction<{ paneIds: string[] }>) => {
      clearPaneIds(state, action.payload.paneIds)
    },
    clearAllPaneRuntimeTitles: (state) => {
      state.titlesByPaneId = {}
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(updatePaneContent, (state, action) => {
        delete state.titlesByPaneId[action.payload.paneId]
      })
      .addCase(updatePaneTitle, (state, action) => {
        delete state.titlesByPaneId[action.payload.paneId]
      })
      .addCase(mergePaneContent, (state, action) => {
        delete state.titlesByPaneId[action.payload.paneId]
      })
      .addCase(replacePane, (state, action) => {
        delete state.titlesByPaneId[action.payload.paneId]
      })
      .addCase(closePane, (state, action) => {
        delete state.titlesByPaneId[action.payload.paneId]
      })
      .addCase(removeLayout, (state) => {
        state.titlesByPaneId = {}
      })
      .addCase(hydratePanes, (state) => {
        state.titlesByPaneId = {}
      })
      .addCase(restoreLayout, (state) => {
        state.titlesByPaneId = {}
      })
  },
})

export const {
  setPaneRuntimeTitle,
  clearPaneRuntimeTitle,
  clearPaneRuntimeTitles,
  clearAllPaneRuntimeTitles,
} = paneRuntimeTitleSlice.actions

export function setPaneRuntimeTitleByTerminalId(input: {
  terminalId: string
  title: string | null | undefined
}) {
  return (dispatch: (action: any) => void, getState: () => RootState) => {
    const state = getState()
    for (const layout of Object.values(state.panes.layouts)) {
      for (const paneId of findPaneIdsByTerminalId(layout, input.terminalId)) {
        dispatch(setPaneRuntimeTitle({ paneId, title: input.title }))
      }
    }
  }
}

export function clearPaneRuntimeTitleByTerminalId(input: { terminalId: string }) {
  return (dispatch: (action: any) => void, getState: () => RootState) => {
    const state = getState()
    const paneIds = Object.values(state.panes.layouts).flatMap((layout) => findPaneIdsByTerminalId(layout, input.terminalId))
    if (paneIds.length > 0) {
      dispatch(clearPaneRuntimeTitles({ paneIds }))
    }
  }
}

export default paneRuntimeTitleSlice.reducer
