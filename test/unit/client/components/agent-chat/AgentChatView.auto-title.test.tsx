import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, {
  sessionCreated,
  addUserMessage,
  addAssistantMessage,
  setSessionStatus,
} from '@/store/agentChatSlice'
import panesReducer, { initLayout, updatePaneTitle } from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const wsSend = vi.fn()

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsSend,
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    setSessionMetadata: vi.fn(() => Promise.resolve(undefined)),
  }
})

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: vi.fn((patch: unknown) => ({
    type: 'settings/saveServerSettingsPatch',
    payload: patch,
  })),
}))

const TAB_ID = 'tab-auto-title'
const PANE_ID = 'pane-auto-title'

function makeStore() {
  const store = configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
      settings: settingsReducer,
      tabs: tabsReducer,
    },
    preloadedState: {
      settings: {
        settings: {
          ...defaultSettings,
          agentChat: { ...defaultSettings.agentChat, initialSetupDone: true },
        } as any,
        loaded: true,
        lastSavedAt: 0,
      },
    },
  })

  // Create a tab and pane layout for the agent-chat pane
  store.dispatch(addTab({
    id: TAB_ID,
    title: 'Freshclaude',
    mode: 'shell',
  }))
  store.dispatch(initLayout({
    tabId: TAB_ID,
    content: {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-auto-title',
      status: 'idle',
    },
  }))

  return store
}

const BASE_PANE: AgentChatPaneContent = {
  kind: 'agent-chat',
  provider: 'freshclaude',
  createRequestId: 'req-auto-title',
  sessionId: 'sess-auto-title',
  status: 'idle',
}

afterEach(() => {
  cleanup()
  wsSend.mockClear()
})

describe('AgentChatView auto-title on first user message', () => {
  it('sets pane title when user sends first message via ChatComposer', async () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-auto-title', sessionId: 'sess-auto-title' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId={TAB_ID} paneId={PANE_ID} paneContent={BASE_PANE} />
      </Provider>,
    )

    const composer = screen.getByRole('textbox')
    const user = userEvent.setup()
    await user.click(composer)
    await user.type(composer, 'Fix the login page redirect bug')
    await user.keyboard('{Enter}')

    // The pane title should now be derived from the first user message
    const paneState = store.getState().panes
    const paneTitle = paneState.paneTitles?.[TAB_ID]?.[PANE_ID]
    expect(paneTitle).toBe('Fix the login page redirect bug')
  })

  it('sets tab title when user sends first message', async () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-auto-title', sessionId: 'sess-auto-title' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId={TAB_ID} paneId={PANE_ID} paneContent={BASE_PANE} />
      </Provider>,
    )

    const composer = screen.getByRole('textbox')
    const user = userEvent.setup()
    await user.click(composer)
    await user.type(composer, 'Add dark mode support')
    await user.keyboard('{Enter}')

    // Tab title should also be updated
    const tab = store.getState().tabs.tabs.find((t: any) => t.id === TAB_ID)
    expect(tab?.title).toBe('Add dark mode support')
  })

  it('does not update title on subsequent messages', async () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-auto-title', sessionId: 'sess-auto-title' }))

    // Pre-populate with an existing message (simulating the first message was already sent)
    store.dispatch(addUserMessage({ sessionId: 'sess-auto-title', text: 'First message' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-auto-title',
      content: [{ type: 'text', text: 'Response' }],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-auto-title', status: 'idle' }))

    // Manually set the pane title as if the first message had set it
    store.dispatch(updatePaneTitle({ tabId: TAB_ID, paneId: PANE_ID, title: 'First message', setByUser: false }))

    render(
      <Provider store={store}>
        <AgentChatView tabId={TAB_ID} paneId={PANE_ID} paneContent={BASE_PANE} />
      </Provider>,
    )

    const composer = screen.getByRole('textbox')
    const user = userEvent.setup()
    await user.click(composer)
    await user.type(composer, 'Second message with different text')
    await user.keyboard('{Enter}')

    // Title should still be from the first message
    const paneTitle = store.getState().panes.paneTitles?.[TAB_ID]?.[PANE_ID]
    expect(paneTitle).toBe('First message')
  })

  it('does not overwrite a user-set title', async () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-auto-title', sessionId: 'sess-auto-title' }))

    // User manually renamed the pane before sending the first message
    store.dispatch(updatePaneTitle({ tabId: TAB_ID, paneId: PANE_ID, title: 'My custom name', setByUser: true }))

    render(
      <Provider store={store}>
        <AgentChatView tabId={TAB_ID} paneId={PANE_ID} paneContent={BASE_PANE} />
      </Provider>,
    )

    const composer = screen.getByRole('textbox')
    const user = userEvent.setup()
    await user.click(composer)
    await user.type(composer, 'Fix login bug')
    await user.keyboard('{Enter}')

    // Title should remain the user-set title (updatePaneTitle with setByUser: false skips user-set)
    const paneTitle = store.getState().panes.paneTitles?.[TAB_ID]?.[PANE_ID]
    expect(paneTitle).toBe('My custom name')
  })

  it('truncates long message text for the title', async () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-auto-title', sessionId: 'sess-auto-title' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId={TAB_ID} paneId={PANE_ID} paneContent={BASE_PANE} />
      </Provider>,
    )

    const longText = 'A'.repeat(100)
    const composer = screen.getByRole('textbox')
    const user = userEvent.setup()
    await user.click(composer)
    await user.type(composer, longText)
    await user.keyboard('{Enter}')

    const paneTitle = store.getState().panes.paneTitles?.[TAB_ID]?.[PANE_ID]
    expect(paneTitle?.length).toBeLessThanOrEqual(50)
  })

  // Multi-line title extraction is covered by shared/title-utils unit tests.
  // The ChatComposer sends on Enter (without Shift), so multi-line messages
  // require Shift+Enter which is hard to drive via userEvent. The shared
  // extractTitleFromMessage function handles multi-line correctly.
})
