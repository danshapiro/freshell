import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import TabsView from '@/components/TabsView'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import tabRegistryReducer, { setTabRegistrySnapshot } from '@/store/tabRegistrySlice'
import connectionReducer, { setServerInstanceId } from '@/store/connectionSlice'

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

vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
}))

describe('TabsView fresh-agent reopen', () => {
  it('serializes fresh-agent panes in remote snapshots and rehydrates them back into fresh-agent panes', () => {
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
        tabKey: 'remote:fresh-agent',
        tabId: 'open-1',
        serverInstanceId: 'srv-remote',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'fresh agent remote',
        status: 'open',
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
        paneCount: 1,
        titleSetByUser: false,
        panes: [{
          paneId: 'pane-1',
          kind: 'fresh-agent',
          payload: {
            provider: 'claude',
            sessionType: 'freshclaude',
            resumeSessionId: 'resume-1',
            sessionRef: {
              provider: 'claude',
              sessionId: 'resume-1',
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

    fireEvent.click(screen.getByLabelText('remote-device: fresh agent remote'))

    const openedTab = store.getState().tabs.tabs.find((tab) => tab.title === 'fresh agent remote')
    expect(openedTab).toBeTruthy()
    const layout = openedTab ? (store.getState().panes.layouts[openedTab.id] as any) : undefined
    expect(layout?.content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
  })
})
