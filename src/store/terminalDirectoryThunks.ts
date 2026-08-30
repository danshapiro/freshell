import {
  getTerminalDirectoryPage,
  searchTerminalView,
} from '@/lib/api'
import { foldTerminalAliasActivity } from '@/lib/terminal-session-association'
import type { AppDispatch, RootState } from './store'
import {
  clearTerminalSearch,
  selectNextTerminalSearchMatch,
  selectPreviousTerminalSearchMatch,
  setTerminalDirectoryWindowData,
  setTerminalDirectoryWindowError,
  setTerminalDirectoryWindowLoading,
  setTerminalSearchError,
  setTerminalSearchLoading,
  setTerminalSearchResults,
} from './terminalDirectorySlice'

type TerminalDirectorySurface = 'sidebar' | 'background' | 'overview'

type FetchTerminalDirectoryWindowArgs = {
  surface: TerminalDirectorySurface
  priority: 'visible' | 'background'
  append?: boolean
  cursor?: string
}

type LoadTerminalSearchArgs = {
  terminalId: string
  query: string
  cursor?: string
}

const windowControllers = new Map<string, AbortController>()
const searchControllers = new Map<string, AbortController>()

function abortController(map: Map<string, AbortController>, key: string) {
  const controller = map.get(key)
  if (controller) {
    controller.abort()
    map.delete(key)
  }
}

export function _resetTerminalDirectoryThunkControllers() {
  for (const controller of windowControllers.values()) {
    controller.abort()
  }
  for (const controller of searchControllers.values()) {
    controller.abort()
  }
  windowControllers.clear()
  searchControllers.clear()
}

export function fetchTerminalDirectoryWindow(args: FetchTerminalDirectoryWindowArgs) {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const windowState = getState().terminalDirectory?.windows?.[args.surface]
    const cursor = args.append
      ? (args.cursor ?? windowState?.nextCursor ?? undefined)
      : args.cursor

    abortController(windowControllers, args.surface)
    const controller = new AbortController()
    windowControllers.set(args.surface, controller)

    dispatch(setTerminalDirectoryWindowLoading({
      surface: args.surface,
      loading: true,
    }))
    dispatch(setTerminalDirectoryWindowError({
      surface: args.surface,
      error: undefined,
    }))

    try {
      const response = await getTerminalDirectoryPage({
        priority: args.priority,
        ...(cursor ? { cursor } : {}),
        ...(windowState?.revision !== undefined ? { revision: windowState.revision } : {}),
      }, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) return

      // Codex durability identity is a sidebar binding path: a running codex
      // terminal with durability identity is rowed under
      // codex:<durabilitySessionId> (getCodexDurabilitySessionId in
      // selectors/sidebarSelectors.ts), never under the identity-less
      // codex:terminal:<terminalId> close-tab alias. This thunk is the
      // store-level choke point where refreshed directory data is applied,
      // and the refresh fires on every terminals.changed broadcast (the Node
      // server broadcasts terminals.changed immediately after
      // terminal.codex.durability.updated), mounted or not — so the alias
      // fold lives here, where a paneless post-close binding still reaches it.
      const items = Array.isArray(response?.items) ? response.items : []
      const stateBeforeFold = getState()
      for (const item of items) {
        if (item?.mode !== 'codex' || typeof item?.terminalId !== 'string') continue
        const durabilitySessionId = item.codexDurability?.durableThreadId
          ?? item.codexDurability?.candidate?.candidateThreadId
        if (!durabilitySessionId) continue
        foldTerminalAliasActivity({
          dispatch,
          state: stateBeforeFold,
          terminalId: item.terminalId,
          provider: 'codex',
          sessionId: durabilitySessionId,
        })
      }

      dispatch(setTerminalDirectoryWindowData({
        surface: args.surface,
        items,
        revision: response?.revision,
        nextCursor: response?.nextCursor ?? null,
        append: args.append,
      }))
    } catch (error) {
      if (controller.signal.aborted) return
      dispatch(setTerminalDirectoryWindowError({
        surface: args.surface,
        error: error instanceof Error ? error.message : 'Failed to load terminals',
      }))
      dispatch(setTerminalDirectoryWindowLoading({
        surface: args.surface,
        loading: false,
      }))
      throw error
    } finally {
      if (windowControllers.get(args.surface) === controller) {
        windowControllers.delete(args.surface)
      }
    }
  }
}

export function loadTerminalSearch(args: LoadTerminalSearchArgs) {
  return async (dispatch: AppDispatch) => {
    const query = args.query.trim()
    abortController(searchControllers, args.terminalId)
    if (!query) {
      dispatch(clearTerminalSearch({ terminalId: args.terminalId }))
      return
    }

    const controller = new AbortController()
    searchControllers.set(args.terminalId, controller)

    dispatch(setTerminalSearchLoading({
      terminalId: args.terminalId,
      query,
      loading: true,
    }))

    try {
      const response = await searchTerminalView(args.terminalId, {
        query,
        ...(args.cursor ? { cursor: args.cursor } : {}),
      }, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) return

      dispatch(setTerminalSearchResults({
        terminalId: args.terminalId,
        query,
        matches: Array.isArray(response?.matches) ? response.matches : [],
        nextCursor: response?.nextCursor ?? null,
      }))
    } catch (error) {
      if (controller.signal.aborted) return
      dispatch(setTerminalSearchError({
        terminalId: args.terminalId,
        error: error instanceof Error ? error.message : 'Failed to search terminal',
      }))
      throw error
    } finally {
      if (searchControllers.get(args.terminalId) === controller) {
        searchControllers.delete(args.terminalId)
      }
    }
  }
}

export function focusNextTerminalSearchMatch(terminalId: string) {
  return (dispatch: AppDispatch) => {
    dispatch(selectNextTerminalSearchMatch({ terminalId }))
  }
}

export function focusPreviousTerminalSearchMatch(terminalId: string) {
  return (dispatch: AppDispatch) => {
    dispatch(selectPreviousTerminalSearchMatch({ terminalId }))
  }
}
