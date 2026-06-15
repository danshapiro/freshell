import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../src/store/tabsSlice'
import panesReducer from '../../src/store/panesSlice'
import tabRegistryReducer, { setTabRegistrySnapshot } from '../../src/store/tabRegistrySlice'
import connectionReducer, { setServerInstanceId } from '../../src/store/connectionSlice'
import TabsView from '../../src/components/TabsView'
import { countPaneLeaves } from '../../src/lib/tab-registry-snapshot'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    state: 'ready',
    sendTabsSyncQuery: vi.fn(),
    sendTabsSyncPush: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
  }),
}))

vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
}))

describe('tabs view flow', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('reopens remote tabs as unlinked local copies', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })

    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [{
        tabKey: 'remote:tab-1',
        tabId: 'tab-1',
        serverInstanceId: 'srv-remote',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'work item',
        status: 'open',
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
        paneCount: 2,
        titleSetByUser: false,
        panes: [
          {
            paneId: 'pane-1',
            kind: 'terminal',
            payload: { mode: 'shell' },
          },
          {
            paneId: 'pane-2',
            kind: 'browser',
            payload: { url: 'https://example.com' },
          },
        ],
      }],
      closed: [],
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    // Click the remote tab card to pull it
    const remoteCard = screen.getByLabelText('remote-device: work item')
    expect(remoteCard).toBeTruthy()
    fireEvent.click(remoteCard)

    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabs.tabs[0]?.title).toBe('work item')
    const tabId = store.getState().tabs.tabs[0]!.id
    expect(countPaneLeaves(store.getState().panes.layouts[tabId])).toBe(2)
  })

  it('opens remote tab copy without auto-resuming foreign machine codex sessions', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })
    store.dispatch(setServerInstanceId('srv-local'))

    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [{
        tabKey: 'remote:tab-codex',
        tabId: 'tab-codex',
        serverInstanceId: 'srv-remote',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'codex run',
        status: 'open',
        revision: 2,
        createdAt: 10,
        updatedAt: 20,
        paneCount: 1,
        titleSetByUser: false,
        panes: [{
          paneId: 'pane-codex',
          kind: 'terminal',
          payload: {
            mode: 'codex',
            sessionRef: {
              provider: 'codex',
              sessionId: 'codex-session-123',
            },
            liveTerminal: {
              terminalId: 'term-remote-1',
              serverInstanceId: 'srv-remote',
            },
          },
        }],
      }],
      closed: [],
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    // Click the remote tab card to pull it
    const remoteCard = screen.getByLabelText('remote-device: codex run')
    expect(remoteCard).toBeTruthy()
    fireEvent.click(remoteCard)

    const copiedTab = store.getState().tabs.tabs[0]
    expect(copiedTab?.title).toBe('codex run')
    const copiedLayout = copiedTab ? (store.getState().panes.layouts[copiedTab.id] as any) : undefined
    expect(copiedLayout?.content?.resumeSessionId).toBeUndefined()
    expect(copiedLayout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-123',
    })
    expect(copiedLayout?.content?.terminalId).toBeUndefined()
  })

  it('preserves candidate-only Codex durability state when pulling a registry tab', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })
    store.dispatch(setServerInstanceId('srv-local'))
    const codexDurability = {
      schemaVersion: 1,
      state: 'captured_pre_turn',
      candidate: {
        provider: 'codex',
        candidateThreadId: '019e2413-b8d0-7a98-b5fb-2f4af05baf58',
        rolloutPath: '/home/user/.codex/sessions/2026/05/14/rollout.jsonl',
        source: 'thread_start_response',
        capturedAt: 1778764200000,
      },
    } as const

    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [{
        tabKey: 'remote:tab-codex-candidate',
        tabId: 'tab-codex-candidate',
        serverInstanceId: 'srv-remote',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'codex candidate',
        status: 'open',
        revision: 2,
        createdAt: 10,
        updatedAt: 20,
        paneCount: 1,
        titleSetByUser: false,
        panes: [{
          paneId: 'pane-codex-candidate',
          kind: 'terminal',
          payload: {
            mode: 'codex',
            codexDurability,
            liveTerminal: {
              terminalId: 'term-remote-candidate',
              serverInstanceId: 'srv-remote',
            },
          },
        }],
      }],
      closed: [],
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const remoteCard = screen.getByLabelText('remote-device: codex candidate')
    expect(remoteCard).toBeTruthy()
    fireEvent.click(remoteCard)

    const copiedTab = store.getState().tabs.tabs[0]
    expect(copiedTab?.title).toBe('codex candidate')
    const copiedLayout = copiedTab ? (store.getState().panes.layouts[copiedTab.id] as any) : undefined
    expect(copiedLayout?.content?.sessionRef).toBeUndefined()
    expect(copiedLayout?.content?.codexDurability).toEqual(codexDurability)
    expect(copiedLayout?.content?.terminalId).toBeUndefined()
  })

  it('opens same-server tab copies without hydrating an unproven live terminal handle when a canonical sessionRef exists', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })
    store.dispatch(setServerInstanceId('srv-local'))

    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [{
        tabKey: 'remote:tab-codex-local',
        tabId: 'tab-codex-local',
        serverInstanceId: 'srv-local',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'codex local',
        status: 'open',
        revision: 3,
        createdAt: 10,
        updatedAt: 20,
        paneCount: 1,
        titleSetByUser: false,
        panes: [{
          paneId: 'pane-codex-local',
          kind: 'terminal',
          payload: {
            mode: 'codex',
            sessionRef: {
              provider: 'codex',
              sessionId: 'codex-session-456',
            },
            liveTerminal: {
              terminalId: 'term-local-1',
              serverInstanceId: 'srv-local',
            },
          },
        }],
      }],
      closed: [],
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const remoteCard = screen.getByLabelText('remote-device: codex local')
    expect(remoteCard).toBeTruthy()
    fireEvent.click(remoteCard)

    const copiedTab = store.getState().tabs.tabs[0]
    expect(copiedTab?.title).toBe('codex local')
    const copiedLayout = copiedTab ? (store.getState().panes.layouts[copiedTab.id] as any) : undefined
    expect(copiedLayout?.content?.resumeSessionId).toBeUndefined()
    expect(copiedLayout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-456',
    })
    expect(copiedLayout?.content?.terminalId).toBeUndefined()
    expect(copiedLayout?.content?.serverInstanceId).toBeUndefined()
  })
})
