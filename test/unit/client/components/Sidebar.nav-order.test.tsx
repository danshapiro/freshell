import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../../../src/store/tabsSlice'
import panesReducer from '../../../../src/store/panesSlice'
import sessionsReducer from '../../../../src/store/sessionsSlice'
import settingsReducer from '../../../../src/store/settingsSlice'
import Sidebar from '../../../../src/components/Sidebar'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
  }),
}))

describe('Sidebar navigation order', () => {
  it('renders navigation in the requested order', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessions: sessionsReducer,
        settings: settingsReducer,
      },
    })

    const { container } = render(
      <Provider store={store}>
        <Sidebar view="terminal" onNavigate={() => {}} />
      </Provider>,
    )

    const navButtons = [...container.querySelectorAll('button[title*="Ctrl+B"]')]
    const labels = navButtons.map((button) => button.getAttribute('title')?.split(' (')[0])
    expect(labels).toEqual([
      'Coding Agents',
      'Tabs',
      'Panes',
      'Projects',
      'Settings',
    ])
  })
})
