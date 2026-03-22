import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
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

    const remoteCard = screen.getByText('remote-device: work item').closest('article')
    expect(remoteCard).toBeTruthy()
    fireEvent.click(within(remoteCard as HTMLElement).getByRole('button', { name: /Open copy/i }))
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
            resumeSessionId: 'codex-session-123',
            sessionRef: {
              provider: 'codex',
              sessionId: 'codex-session-123',
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

    const remoteCard = screen.getByText('remote-device: codex run').closest('article')
    expect(remoteCard).toBeTruthy()
    fireEvent.click(within(remoteCard as HTMLElement).getByRole('button', { name: /Open copy/i }))

    const copiedTab = store.getState().tabs.tabs[0]
    expect(copiedTab?.title).toBe('codex run')
    const copiedLayout = copiedTab ? (store.getState().panes.layouts[copiedTab.id] as any) : undefined
    expect(copiedLayout?.content?.resumeSessionId).toBeUndefined()
    expect(copiedLayout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-123',
      serverInstanceId: 'srv-remote',
    })
  })

  it('drops foreign live terminalIds when reopening a remote codex copy', () => {
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
        tabKey: 'remote:tab-codex-live',
        tabId: 'tab-codex-live',
        serverInstanceId: 'srv-remote',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'codex live remote',
        status: 'open',
        revision: 3,
        createdAt: 10,
        updatedAt: 20,
        paneCount: 1,
        titleSetByUser: false,
        panes: [{
          paneId: 'pane-codex-live',
          kind: 'terminal',
          payload: {
            mode: 'codex',
            terminalId: 'term-remote-live',
            resumeSessionId: 'codex-session-live',
            sessionRef: {
              provider: 'codex',
              sessionId: 'codex-session-live',
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

    const remoteCard = screen.getByText('remote-device: codex live remote').closest('article')
    expect(remoteCard).toBeTruthy()
    fireEvent.click(within(remoteCard as HTMLElement).getByRole('button', { name: /Open copy/i }))

    const copiedTab = store.getState().tabs.tabs[0]
    const copiedLayout = copiedTab ? (store.getState().panes.layouts[copiedTab.id] as any) : undefined
    expect(copiedLayout?.content?.terminalId).toBeUndefined()
    expect(copiedLayout?.content?.resumeSessionId).toBeUndefined()
    expect(copiedLayout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-live',
      serverInstanceId: 'srv-remote',
    })
  })
})
