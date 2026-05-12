import type { PayloadAction } from '@reduxjs/toolkit'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'

type DispatchLike = (action: unknown) => unknown

type RefreshThunk = unknown

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

  const runRefresh = () => {
    refreshTimer = undefined
    deps.dispatch(deps.fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }))
    deps.dispatch(deps.queueActiveSessionWindowRefresh())
  }

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimer(refreshTimer)
    refreshTimer = setTimer(runRefresh, delayMs)
  }

  return {
    handle(msg: { type?: unknown; upsert?: unknown; remove?: unknown }): boolean {
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
