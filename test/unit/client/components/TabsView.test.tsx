import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '../../../../src/store/tabsSlice'
import panesReducer, { initLayout } from '../../../../src/store/panesSlice'
import tabRegistryReducer, { setTabRegistrySnapshot } from '../../../../src/store/tabRegistrySlice'
import connectionReducer from '../../../../src/store/connectionSlice'
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
})
