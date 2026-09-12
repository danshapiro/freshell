import {
  getTerminalDirectoryPage,
  searchTerminalView,
} from '@/lib/api'
import {
  foldCanonicalSessionActivity,
  foldTerminalAliasActivity,
} from '@/lib/terminal-session-association'
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
  type TerminalDirectoryItem,
} from './terminalDirectorySlice'

/**
 * Canonical identity the sidebar rows a directory item under — mirrors
 * buildSessionItems' runningSessionMap derivation in
 * selectors/sidebarSelectors.ts: sessionRef first, then the codex durability
 * id for codex terminals (getCodexDurabilitySessionId). Items with neither
 * are rowed under the identity-less `<mode>:terminal:<terminalId>` fallback
 * key, which is not a canonical identity. This identity is ALSO the alias
 * fold's target: a touch recorded under that fallback key folds onto the
 * key the row actually reads once an applied page carries this identity.
 */
function directoryItemCanonicalIdentity(
  item: TerminalDirectoryItem,
): { provider: string; sessionId: string } | undefined {
  const ref = item?.sessionRef
  if (
    typeof ref?.provider === 'string'
    && typeof ref.sessionId === 'string'
    && ref.sessionId.length > 0
  ) {
    return { provider: ref.provider, sessionId: ref.sessionId }
  }
  if (item?.mode === 'codex') {
    const durabilitySessionId = item.codexDurability?.durableThreadId
      ?? item.codexDurability?.candidate?.candidateThreadId
    if (typeof durabilitySessionId === 'string' && durabilitySessionId.length > 0) {
      return { provider: 'codex', sessionId: durabilitySessionId }
    }
  }
  return undefined
}

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

      // Close-tab activity migration runs at this store-level choke point —
      // the sidebar rows running terminals straight from the applied window
      // (buildSessionItems reads terminalDirectory.windows.sidebar.items;
      // the directory never passes through
      // reconcileTerminalSessionAssociation), and the refresh fires on every
      // terminals.changed / terminal.meta.updated broadcast as well as on
      // (re)connect, mounted or not. Two folds over every applied item
      // carrying a canonical identity (directoryItemCanonicalIdentity —
      // sessionRef for any provider, codex durability for codex terminals),
      // both ratchet-only:
      //
      // 1. Canonical-to-canonical: the terminal.session.associated frame
      //    carrying previousSessionId is a single transient broadcast, so a
      //    client disconnected at rebind time only ever sees a codex fork
      //    handoff as the SAME terminalId swapping canonical identity between
      //    two applied pages. The previous window is the only record of the
      //    superseded identity — fold its activity onto the new one.
      // 2. Alias-to-canonical, ALL providers: a terminal closed while
      //    identity-less had its touch recorded under
      //    `<provider>:terminal:<terminalId>`; once the applied item carries
      //    a canonical identity the row rekeys, so fold the alias across
      //    (onto the same key the sidebar rows the item under — the
      //    sessionRef identity wins over durability when both exist, exactly
      //    like the row derivation). This is the only heal for a binding
      //    that arrived during closeTab's ack wait: its
      //    association-reconcile fold ran before the ratchet wrote the
      //    alias (a no-op on an empty source), and the once-per-binding
      //    broadcast never re-fires — without it, a non-codex alias stays
      //    stranded until a reconnect/attach re-reconcile.
      const items = Array.isArray(response?.items) ? response.items : []
      const stateBeforeFold = getState()
      const previousIdentityByTerminalId = new Map<string, { provider: string; sessionId: string }>()
      for (const previous of stateBeforeFold.terminalDirectory?.windows?.[args.surface]?.items ?? []) {
        if (typeof previous?.terminalId !== 'string') continue
        const identity = directoryItemCanonicalIdentity(previous)
        if (identity) previousIdentityByTerminalId.set(previous.terminalId, identity)
      }
      for (const item of items) {
        if (typeof item?.terminalId !== 'string') continue
        const identity = directoryItemCanonicalIdentity(item)
        if (!identity) continue
        const previous = previousIdentityByTerminalId.get(item.terminalId)
        if (
          previous
          && previous.provider === identity.provider
          && previous.sessionId !== identity.sessionId
        ) {
          foldCanonicalSessionActivity({
            dispatch,
            state: stateBeforeFold,
            provider: identity.provider,
            previousSessionId: previous.sessionId,
            sessionId: identity.sessionId,
          })
        }
        foldTerminalAliasActivity({
          dispatch,
          state: stateBeforeFold,
          terminalId: item.terminalId,
          provider: identity.provider,
          sessionId: identity.sessionId,
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
