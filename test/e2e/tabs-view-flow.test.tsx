import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../src/store/tabsSlice'
import panesReducer from '../../src/store/panesSlice'
import tabRegistryReducer, { setTabRegistrySnapshot } from '../../src/store/tabRegistrySlice'
import connectionReducer from '../../src/store/connectionSlice'
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

    fireEvent.click(screen.getByRole('button', { name: 'Open copy' }))
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabs.tabs[0]?.title).toBe('work item')
    const tabId = store.getState().tabs.tabs[0]!.id
    expect(countPaneLeaves(store.getState().panes.layouts[tabId])).toBe(2)
  })
})
