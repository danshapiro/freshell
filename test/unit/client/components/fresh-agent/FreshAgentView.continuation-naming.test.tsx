import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { appReducers } from '@/store/appReducers'
import { initLayout } from '@/store/panesSlice'
import { setStatus } from '@/store/connectionSlice'
import { useAppSelector } from '@/store/hooks'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { resolvePaneNameRef } from '@/store/selectors/sessionNameSelectors'
import { resetSnapshotSchedulerForTests } from '@/lib/fresh-agent-snapshot-scheduler'
import type { FreshAgentPaneContent } from '@/store/paneTypes'

const wsMock = vi.hoisted(() => ({ handlers: new Set<(message: unknown) => void>(), send: vi.fn() }))
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMock.send,
    onMessage: (handler: (message: unknown) => void) => {
      wsMock.handlers.add(handler)
      return () => { wsMock.handlers.delete(handler) }
    },
    onReconnect: () => () => {},
  }),
}))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn().mockRejectedValue(new Error('no server')), post: vi.fn().mockRejectedValue(new Error('no server')) },
    getFreshAgentThreadSnapshot: vi.fn().mockRejectedValue(new Error('no server')),
    getFreshAgentCheckpointOutcomePage: vi.fn().mockResolvedValue({ outcomes: [], nextCursor: null }),
    getFreshAgentModelCapabilities: vi.fn().mockRejectedValue(new Error('no server')),
    setSessionMetadata: vi.fn().mockResolvedValue(undefined),
  }
})

const SOURCE = '550e8400-e29b-41d4-a716-446655440001'
const CHILD = '550e8400-e29b-41d4-a716-446655440002'
const childNameRef = { kind: 'session' as const, provider: 'claude' as const, sessionId: CHILD }

function StoreBackedView() {
  const content = useAppSelector((state) => {
    const root = state.panes.layouts.tab
    if (!root || root.type !== 'leaf' || root.content.kind !== 'fresh-agent') throw new Error('missing pane')
    return root.content
  })
  return <FreshAgentView tabId="tab" paneId="pane" paneContent={content} />
}

beforeEach(() => {
  vi.useFakeTimers()
  resetSnapshotSchedulerForTests()
  wsMock.handlers.clear()
})
afterEach(() => {
  cleanup()
  resetSnapshotSchedulerForTests()
  vi.useRealTimers()
})

describe('continuation naming through the App and mounted view handlers', () => {
  it.each(['pending', 'durable'] as const)('replaces the stale %s source binding with the authoritative child', async (sourceBinding) => {
    const store = configureStore({ reducer: appReducers, middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }) })
    store.dispatch(setStatus('ready'))
    store.dispatch(initLayout({ tabId: 'tab', paneId: 'pane', content: {
      kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', sessionId: SOURCE,
      sessionRef: { provider: 'claude', sessionId: SOURCE }, createRequestId: 'continued', status: 'idle',
      nameRef: sourceBinding === 'pending' ? { kind: 'pending', id: 'source-handle' } : { kind: 'session', provider: 'claude', sessionId: SOURCE },
      ...(sourceBinding === 'pending' ? { namingHandle: 'source-handle' } : {}),
    } }))
    render(<Provider store={store}><StoreBackedView /></Provider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(wsMock.handlers.size).toBeGreaterThan(0)
    const message = {
      type: 'freshAgent.session.materialized', provider: 'claude', sessionType: 'freshclaude',
      previousSessionId: SOURCE, sessionId: CHILD,
      sessionRef: { provider: 'claude', sessionId: CHILD }, nameRef: childNameRef,
    }
    act(() => {
      handleFreshAgentMessage(store.dispatch, message)
      // Both listeners receive the same frame before React updates the
      // mounted view's paneContentRef. Its local merge cannot restore A.
      for (const handler of [...wsMock.handlers]) handler(message)
    })
    const root = store.getState().panes.layouts.tab!
    expect(root.type).toBe('leaf')
    const content = (root as { content: FreshAgentPaneContent }).content
    expect(content.sessionRef).toEqual({ provider: 'claude', sessionId: CHILD })
    expect(content.nameRef).toEqual(childNameRef)
    expect(content.namingHandle).toBeUndefined()
    expect(resolvePaneNameRef(content), 'the next rename must address the child').toEqual(childNameRef)
  })
})
