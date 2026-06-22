import type { PayloadAction } from '@reduxjs/toolkit'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'

type DispatchLike = (action: unknown) => unknown

type RefreshThunk = unknown

/** Identifies which fire-and-forget background refresh produced a rejection. */
export type RefreshSource = 'terminal-directory' | 'session-window'

type TerminalInvalidationDeps = {
  dispatch: DispatchLike
  upsertTerminalMeta: (payload: TerminalMetaRecord[]) => PayloadAction<TerminalMetaRecord[]>
  removeTerminalMeta: (terminalId: string) => PayloadAction<string>
  patchSessionRunningStateFromTerminalMeta: (payload: {
    upsert: TerminalMetaRecord[]
    remove: string[]
  }) => PayloadAction<{
    upsert: TerminalMetaRecord[]
    remove: string[]
  }>
  queueActiveSessionWindowRefresh: () => RefreshThunk
  fetchTerminalDirectoryWindow: (payload: { surface: 'sidebar'; priority: 'visible' }) => RefreshThunk
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  refreshDelayMs?: number
  handleRecoverableTerminalIds?: (terminalIds: string[]) => void
  /**
   * Invoked when a fire-and-forget background refresh rejects. The refresh
   * thunks re-throw on failure (callers that await them rely on this), but the
   * handler dispatches them from a timer without awaiting, so it contains the
   * rejection here instead of letting it surface as an unhandled rejection.
   * `source` identifies which refresh failed so the callback can log accurately.
   */
  onRefreshError?: (error: unknown, source: RefreshSource) => void
}

function isTerminalMetaRecord(value: unknown): value is TerminalMetaRecord {
  return !!value
    && typeof value === 'object'
    && typeof (value as { terminalId?: unknown }).terminalId === 'string'
    && typeof (value as { updatedAt?: unknown }).updatedAt === 'number'
}

export function createTerminalInvalidationHandler(deps: TerminalInvalidationDeps) {
  const setTimer = deps.setTimeout ?? setTimeout
  const clearTimer = deps.clearTimeout ?? clearTimeout
  const delayMs = deps.refreshDelayMs ?? 50
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  const dispatchBackgroundRefresh = (thunk: RefreshThunk, source: RefreshSource) => {
    const result = deps.dispatch(thunk) as unknown
    // Contain rejections from the fire-and-forget refresh dispatch: the thunks
    // re-throw on failure, and a failed background refresh must never become an
    // unhandled promise rejection (which crashes test runs and is silently
    // uncaught in production).
    if (result && typeof (result as { catch?: unknown }).catch === 'function') {
      void (result as Promise<unknown>).catch((error: unknown) => {
        deps.onRefreshError?.(error, source)
      })
    }
  }

  const runRefresh = () => {
    refreshTimer = undefined
    dispatchBackgroundRefresh(deps.fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }), 'terminal-directory')
    dispatchBackgroundRefresh(deps.queueActiveSessionWindowRefresh(), 'session-window')
  }

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimer(refreshTimer)
    refreshTimer = setTimer(runRefresh, delayMs)
  }

  return {
    handle(msg: {
      type?: unknown
      upsert?: unknown
      remove?: unknown
      recoverableTerminalIds?: unknown
    }): boolean {
      if (msg.type === 'terminal.meta.updated') {
        const upsert = Array.isArray(msg.upsert)
          ? msg.upsert.filter(isTerminalMetaRecord)
          : []
        if (upsert.length > 0) {
          deps.dispatch(deps.upsertTerminalMeta(upsert))
        }

        const remove = Array.isArray(msg.remove)
          ? msg.remove.filter((terminalId): terminalId is string => typeof terminalId === 'string')
          : []
        for (const terminalId of remove) {
          deps.dispatch(deps.removeTerminalMeta(terminalId))
        }

        deps.dispatch(deps.patchSessionRunningStateFromTerminalMeta({
          upsert,
          remove,
        }))
        scheduleRefresh()
        return true
      }

      if (msg.type === 'terminals.changed') {
        const recoverableTerminalIds = Array.isArray(msg.recoverableTerminalIds)
          ? msg.recoverableTerminalIds.filter((terminalId): terminalId is string => (
              typeof terminalId === 'string' && terminalId.length > 0
            ))
          : []
        if (recoverableTerminalIds.length > 0) {
          deps.handleRecoverableTerminalIds?.(recoverableTerminalIds)
        }
        scheduleRefresh()
        return true
      }

      return false
    },

    flush() {
      if (!refreshTimer) return
      clearTimer(refreshTimer)
      runRefresh()
    },

    dispose() {
      if (!refreshTimer) return
      clearTimer(refreshTimer)
      refreshTimer = undefined
    },
  }
}
