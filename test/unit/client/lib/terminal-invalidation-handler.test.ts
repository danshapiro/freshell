import { configureStore } from '@reduxjs/toolkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalInvalidationHandler } from '@/lib/terminal-invalidation-handler'
import { upsertTerminalMeta, removeTerminalMeta } from '@/store/terminalMetaSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import sessionsReducer, {
  commitSessionWindowReplacement,
  patchSessionRunningStateFromTerminalMeta,
} from '@/store/sessionsSlice'

function createRefreshDoubles() {
  const terminalDirectoryRefreshThunk = vi.fn()
  const activeSessionWindowRefreshThunk = vi.fn()

  return {
    terminalDirectoryRefreshThunk,
    activeSessionWindowRefreshThunk,
    fetchTerminalDirectoryWindow: vi.fn(() => terminalDirectoryRefreshThunk),
    queueActiveSessionWindowRefresh: vi.fn(() => activeSessionWindowRefreshThunk),
  }
}

describe('createTerminalInvalidationHandler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('upserts terminal metadata immediately and coalesces refreshes', async () => {
    vi.useFakeTimers()
    const dispatch = vi.fn()
    const refresh = createRefreshDoubles()
    const handler = createTerminalInvalidationHandler({
      dispatch,
      upsertTerminalMeta,
      removeTerminalMeta,
      patchSessionRunningStateFromTerminalMeta,
      queueActiveSessionWindowRefresh: refresh.queueActiveSessionWindowRefresh,
      fetchTerminalDirectoryWindow: refresh.fetchTerminalDirectoryWindow,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      refreshDelayMs: 50,
    })

    const handled = handler.handle({
      type: 'terminal.meta.updated',
      upsert: [{ terminalId: 'term-1', provider: 'codex', sessionId: 'codex-live-1', updatedAt: 1_700 }],
      remove: [],
    })
    handler.handle({ type: 'terminals.changed', revision: 12 })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith({
      type: upsertTerminalMeta.type,
      payload: [{ terminalId: 'term-1', provider: 'codex', sessionId: 'codex-live-1', updatedAt: 1_700 }],
    })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: patchSessionRunningStateFromTerminalMeta.type,
    }))
    expect(refresh.fetchTerminalDirectoryWindow).not.toHaveBeenCalled()
    expect(refresh.queueActiveSessionWindowRefresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)
    expect(refresh.fetchTerminalDirectoryWindow).toHaveBeenCalledTimes(1)
    expect(refresh.fetchTerminalDirectoryWindow).toHaveBeenCalledWith({
      surface: 'sidebar',
      priority: 'visible',
    })
    expect(refresh.queueActiveSessionWindowRefresh).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(refresh.terminalDirectoryRefreshThunk)
    expect(dispatch).toHaveBeenCalledWith(refresh.activeSessionWindowRefreshThunk)
  })

  it('refreshes the sidebar terminal directory and session window after terminals.changed', async () => {
    vi.useFakeTimers()
    const dispatch = vi.fn()
    const refresh = createRefreshDoubles()
    const handler = createTerminalInvalidationHandler({
      dispatch,
      upsertTerminalMeta,
      removeTerminalMeta,
      patchSessionRunningStateFromTerminalMeta,
      queueActiveSessionWindowRefresh: refresh.queueActiveSessionWindowRefresh,
      fetchTerminalDirectoryWindow: refresh.fetchTerminalDirectoryWindow,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      refreshDelayMs: 50,
    })

    const handled = handler.handle({
      type: 'terminals.changed',
      revision: 12,
    })

    expect(handled).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(refresh.fetchTerminalDirectoryWindow).toHaveBeenCalledTimes(1)
    expect(refresh.queueActiveSessionWindowRefresh).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(refresh.terminalDirectoryRefreshThunk)
    expect(dispatch).toHaveBeenCalledWith(refresh.activeSessionWindowRefreshThunk)
  })

  it('flushes a pending refresh before a user-initiated sidebar attach', async () => {
    vi.useFakeTimers()
    const dispatch = vi.fn()
    const refresh = createRefreshDoubles()
    const handler = createTerminalInvalidationHandler({
      dispatch,
      upsertTerminalMeta,
      removeTerminalMeta,
      patchSessionRunningStateFromTerminalMeta,
      queueActiveSessionWindowRefresh: refresh.queueActiveSessionWindowRefresh,
      fetchTerminalDirectoryWindow: refresh.fetchTerminalDirectoryWindow,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      refreshDelayMs: 50,
    })

    handler.handle({ type: 'terminals.changed', revision: 12 })
    handler.flush()

    expect(refresh.fetchTerminalDirectoryWindow).toHaveBeenCalledTimes(1)
    expect(refresh.queueActiveSessionWindowRefresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(refresh.fetchTerminalDirectoryWindow).toHaveBeenCalledTimes(1)
  })

  it('patches loaded sessions running before the coalesced fetch fires', async () => {
    vi.useFakeTimers()
    const refresh = createRefreshDoubles()
    const store = configureStore({
      reducer: {
        sessions: sessionsReducer,
        terminalMeta: terminalMetaReducer,
      },
      middleware: (getDefault) =>
        getDefault({
          serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
        }),
    })
    store.dispatch(commitSessionWindowReplacement({
      surface: 'sidebar',
      projects: [{
        projectPath: '/repo',
        sessions: [{
          provider: 'codex',
          sessionId: 'codex-live-1',
          projectPath: '/repo',
          lastActivityAt: 1,
          title: 'Live Codex',
        }],
      }],
    }))

    const handler = createTerminalInvalidationHandler({
      dispatch: store.dispatch,
      upsertTerminalMeta,
      removeTerminalMeta,
      patchSessionRunningStateFromTerminalMeta,
      queueActiveSessionWindowRefresh: refresh.queueActiveSessionWindowRefresh,
      fetchTerminalDirectoryWindow: refresh.fetchTerminalDirectoryWindow,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      refreshDelayMs: 50,
    })

    handler.handle({
      type: 'terminal.meta.updated',
      upsert: [{ terminalId: 'term-1', provider: 'codex', sessionId: 'codex-live-1', updatedAt: 1_700 }],
      remove: [],
    })

    expect(store.getState().sessions.projects[0]?.sessions[0]).toMatchObject({
      isRunning: true,
      runningTerminalId: 'term-1',
    })
    expect(refresh.fetchTerminalDirectoryWindow).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)
    expect(refresh.fetchTerminalDirectoryWindow).toHaveBeenCalledTimes(1)
  })
})
