import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../../../src/store/tabsSlice'
import panesReducer from '../../../../src/store/panesSlice'
import tabRegistryReducer from '../../../../src/store/tabRegistrySlice'
import connectionReducer, { setError, setStatus } from '../../../../src/store/connectionSlice'
import TabsView from '../../../../src/components/TabsView'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    state: 'disconnected',
    sendTabsSyncQuery: vi.fn(),
    sendTabsSyncPush: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
  }),
}))

describe('TabsView websocket error state', () => {
  it('shows a clear tabs sync error banner when websocket is disconnected', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })
    store.dispatch(setStatus('disconnected'))
    store.dispatch(setError('socket failed'))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Tabs sync unavailable')
  })
})
