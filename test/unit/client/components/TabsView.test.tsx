import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '../../../../src/store/tabsSlice'
import panesReducer, { initLayout } from '../../../../src/store/panesSlice'
import tabRegistryReducer, { setTabRegistrySnapshot } from '../../../../src/store/tabRegistrySlice'
import connectionReducer, { setServerInstanceId } from '../../../../src/store/connectionSlice'
import TabsView from '../../../../src/components/TabsView'

const wsMock = {
  state: 'ready',
  sendTabsSyncQuery: vi.fn(),
  sendTabsSyncPush: vi.fn(),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMock,
}))

function createStore() {
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      tabRegistry: tabRegistryReducer,
      connection: connectionReducer,
    },
  })

  store.dispatch(addTab({ id: 'local-tab', title: 'local tab', mode: 'shell' }))
  store.dispatch(initLayout({
    tabId: 'local-tab',
    content: { kind: 'terminal', mode: 'shell' },
  }))

  store.dispatch(setTabRegistrySnapshot({
    localOpen: [],
    remoteOpen: [{
      tabKey: 'remote:open',
      tabId: 'open-1',
      serverInstanceId: 'srv-remote',
      deviceId: 'remote',
      deviceLabel: 'remote-device',
      tabName: 'remote open',
      status: 'open',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      paneCount: 1,
      titleSetByUser: false,
      panes: [],
    }],
    closed: [{
      tabKey: 'remote:closed',
      tabId: 'closed-1',
      serverInstanceId: 'srv-remote',
      deviceId: 'remote',
      deviceLabel: 'remote-device',
      tabName: 'remote closed',
      status: 'closed',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      closedAt: 2,
      paneCount: 1,
      titleSetByUser: false,
      panes: [],
    }],
  }))

  return store
}

describe('TabsView', () => {
  beforeEach(() => {
    wsMock.sendTabsSyncQuery.mockClear()
  })

  it('renders groups in order: local open, remote open, closed', () => {
    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const headings = [...container.querySelectorAll('h2')].map((node) => node.textContent?.trim())
    expect(headings).toEqual([
      'Open on this device',
      'Open on other devices',
      'Closed',
    ])
    expect(screen.getByText('remote-device: remote open')).toBeInTheDocument()
    expect(screen.getByText('remote-device: remote closed')).toBeInTheDocument()
  })

  it('drops resumeSessionId when opening remote copy from another server instance', () => {
    const store = createStore()
    store.dispatch(setServerInstanceId('srv-local'))
    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [{
        tabKey: 'remote:session-copy',
        tabId: 'open-2',
        serverInstanceId: 'srv-remote',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'session remote',
        status: 'open',
        revision: 2,
        createdAt: 2,
        updatedAt: 3,
        paneCount: 1,
        titleSetByUser: false,
        panes: [{
          paneId: 'pane-remote',
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

    const remoteCardTitle = screen.getByText('remote-device: session remote')
    const remoteCard = remoteCardTitle.closest('article')
    expect(remoteCard).toBeTruthy()
    fireEvent.click(within(remoteCard as HTMLElement).getByText('Open copy'))

    const tabs = store.getState().tabs.tabs
    const newTab = tabs.find((tab) => tab.title === 'session remote')
    expect(newTab).toBeTruthy()
    const layout = newTab ? (store.getState().panes.layouts[newTab.id] as any) : undefined
    expect(layout?.content?.resumeSessionId).toBeUndefined()
    expect(layout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-123',
      serverInstanceId: 'srv-remote',
    })
  })
})
