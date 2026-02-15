import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../src/store/tabsSlice'
import panesReducer from '../../src/store/panesSlice'
import tabRegistryReducer from '../../src/store/tabRegistrySlice'
import connectionReducer from '../../src/store/connectionSlice'
import TabsView from '../../src/components/TabsView'

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

describe('tabs view search range loading', () => {
  beforeEach(() => {
    wsMock.sendTabsSyncQuery.mockClear()
  })

  it('requests older history only when user expands search range', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    expect(wsMock.sendTabsSyncQuery).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Closed range filter'), {
      target: { value: '90' },
    })
    expect(wsMock.sendTabsSyncQuery).toHaveBeenCalledTimes(1)
    expect(wsMock.sendTabsSyncQuery.mock.calls[0][0].rangeDays).toBe(90)
  })
})
