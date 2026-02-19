import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import BackgroundSessions from '../../../../src/components/BackgroundSessions'
import tabsReducer from '../../../../src/store/tabsSlice'
import settingsReducer from '../../../../src/store/settingsSlice'

// Track messages sent to WS
const sentMessages: any[] = []
let messageHandler: ((msg: any) => void) | null = null

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    connect: () => Promise.resolve(),
    send: (msg: any) => {
      sentMessages.push(msg)
      // Auto-reply with terminal.list.response
      if (msg.type === 'terminal.list') {
        setTimeout(() => {
          messageHandler?.({
            type: 'terminal.list.response',
            requestId: msg.requestId,
            terminals: [
              {
                terminalId: 'term-codex-1',
                title: 'Codex',
                mode: 'codex',
                resumeSessionId: 'codex-sess-abc',
                createdAt: Date.now() - 60000,
                lastActivityAt: Date.now() - 30000,
                status: 'running',
                hasClients: false,
              },
            ],
          })
        }, 0)
      }
    },
    onMessage: (handler: (msg: any) => void) => {
      messageHandler = handler
      return () => { messageHandler = null }
    },
  }),
}))

function makeStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      settings: settingsReducer,
    },
  })
}

describe('BackgroundSessions', () => {
  beforeEach(() => {
    sentMessages.length = 0
    messageHandler = null
  })

  it('attaches with the real terminal mode, not hardcoded shell', async () => {
    const store = makeStore()
    const user = userEvent.setup()

    render(
      <Provider store={store}>
        <BackgroundSessions />
      </Provider>
    )

    // Trigger an explicit refresh after mount to avoid races between
    // initial request dispatch and mock onMessage registration.
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    // Wait for the list to load and render.
    const attachBtn = await screen.findByRole('button', { name: 'Attach' })
    await user.click(attachBtn)

    const tabs = store.getState().tabs.tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].mode).toBe('codex')
    expect(tabs[0].resumeSessionId).toBe('codex-sess-abc')
    expect(tabs[0].terminalId).toBe('term-codex-1')
  })
})
