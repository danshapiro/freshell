/**
 * E2E tests for freshclaude polish features.
 *
 * These tests render ClaudeChatView with a realistic Redux store and validate
 * the integrated behavior of: left-border message layout, tool block expand/collapse,
 * auto-collapse, collapsed turn summaries, thinking indicator, diff view, and
 * system-reminder stripping.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ClaudeChatView from '@/components/claude-chat/ClaudeChatView'
import claudeChatReducer, {
  sessionCreated,
  addUserMessage,
  addAssistantMessage,
  setSessionStatus,
} from '@/store/claudeChatSlice'
import panesReducer from '@/store/panesSlice'
import type { ClaudeChatPaneContent } from '@/store/paneTypes'
import type { ChatContentBlock } from '@/store/claudeChatTypes'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

function makeStore() {
  return configureStore({
    reducer: {
      claudeChat: claudeChatReducer,
      panes: panesReducer,
    },
  })
}

const BASE_PANE: ClaudeChatPaneContent = {
  kind: 'claude-chat',
  createRequestId: 'req-1',
  sessionId: 'sess-1',
  status: 'idle',
}

describe('freshclaude polish e2e: left-border message layout', () => {
  afterEach(cleanup)

  it('renders user messages with user border and assistant messages with assistant border', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Hello Claude' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Hello human' }],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const messages = screen.getAllByRole('article')
    expect(messages).toHaveLength(2)

    // User message labeled correctly
    const userMsg = screen.getByLabelText('user message')
    expect(userMsg).toBeInTheDocument()
    expect(userMsg.className).toContain('border-l-')

    // Assistant message labeled correctly
    const assistantMsg = screen.getByLabelText('assistant message')
    expect(assistantMsg).toBeInTheDocument()
    expect(assistantMsg.className).toContain('border-l-')

    // Different border widths distinguish them: user=3px, assistant=2px
    expect(userMsg.className).toContain('border-l-[3px]')
    expect(assistantMsg.className).toContain('border-l-2')
  })

  it('renders assistant markdown-formatted text content', async () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: '# Hello Markdown' }],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    expect(await screen.findByRole('heading', { level: 1 }, { timeout: 5000 })).toHaveTextContent('Hello Markdown')
  })
})

describe('freshclaude polish e2e: tool block expand/collapse', () => {
  afterEach(cleanup)

  it('collapses and expands tool blocks on click', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Run a command' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [
        { type: 'text', text: 'Running...' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls -la' } },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'file1.txt\nfile2.txt' },
      ],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // Tool block should be rendered with a toggle button
    const toolButton = screen.getByRole('button', { name: /tool call/i })
    expect(toolButton).toBeInTheDocument()

    // With only 1 tool (< RECENT_TOOLS_EXPANDED=3), it should start expanded
    expect(toolButton).toHaveAttribute('aria-expanded', 'true')

    // Click to collapse
    fireEvent.click(toolButton)
    expect(toolButton).toHaveAttribute('aria-expanded', 'false')

    // Click to expand again
    fireEvent.click(toolButton)
    expect(toolButton).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('freshclaude polish e2e: auto-collapse old tools', () => {
  afterEach(cleanup)

  it('old tools start collapsed while recent tools start expanded', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Do things' }))

    // 5 completed tool blocks in one assistant message
    const content: ChatContentBlock[] = [{ type: 'text', text: 'Working...' }]
    for (let t = 0; t < 5; t++) {
      const id = `tool-${t}`
      content.push({ type: 'tool_use', id, name: 'Bash', input: { command: `cmd ${t}` } })
      content.push({ type: 'tool_result', tool_use_id: id, content: `result ${t}` })
    }
    store.dispatch(addAssistantMessage({ sessionId: 'sess-1', content }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const toolButtons = screen.getAllByRole('button', { name: /tool call/i })
    expect(toolButtons).toHaveLength(5)

    // RECENT_TOOLS_EXPANDED=3: first 2 collapsed, last 3 expanded
    expect(toolButtons[0]).toHaveAttribute('aria-expanded', 'false')
    expect(toolButtons[1]).toHaveAttribute('aria-expanded', 'false')
    expect(toolButtons[2]).toHaveAttribute('aria-expanded', 'true')
    expect(toolButtons[3]).toHaveAttribute('aria-expanded', 'true')
    expect(toolButtons[4]).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('freshclaude polish e2e: collapsed turn summaries', () => {
  afterEach(cleanup)

  it('old turns show collapsed summary, click expands to full messages', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    // 5 turns: first 2 should be collapsed
    for (let i = 0; i < 5; i++) {
      store.dispatch(addUserMessage({ sessionId: 'sess-1', text: `Question ${i + 1}` }))
      store.dispatch(addAssistantMessage({
        sessionId: 'sess-1',
        content: [{ type: 'text', text: `Answer ${i + 1}` }],
      }))
    }
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // 2 collapsed turns
    const expandButtons = screen.getAllByLabelText('Expand turn')
    expect(expandButtons).toHaveLength(2)

    // Answers 1 and 2 should NOT be visible (collapsed)
    expect(screen.queryByText('Answer 1')).not.toBeInTheDocument()
    expect(screen.queryByText('Answer 2')).not.toBeInTheDocument()

    // Recent answers should be visible
    expect(screen.getByText('Answer 3')).toBeInTheDocument()
    expect(screen.getByText('Answer 4')).toBeInTheDocument()
    expect(screen.getByText('Answer 5')).toBeInTheDocument()

    // Click to expand the first collapsed turn
    fireEvent.click(expandButtons[0])

    // Now it should show the full messages and have a "Collapse turn" button
    expect(screen.getByText('Answer 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Collapse turn')).toBeInTheDocument()
  })
})

describe('freshclaude polish e2e: thinking indicator', () => {
  afterEach(cleanup)

  it('appears when Claude is processing and disappears when content arrives', () => {
    vi.useFakeTimers()
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Think about this' }))

    const pane: ClaudeChatPaneContent = { ...BASE_PANE, status: 'running' }
    const { rerender } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // Not visible immediately (200ms debounce)
    expect(screen.queryByLabelText('Claude is thinking')).not.toBeInTheDocument()

    // Visible after debounce
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.getByLabelText('Claude is thinking')).toBeInTheDocument()

    // Simulate assistant response arriving
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Here is my answer' }],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const idlePane: ClaudeChatPaneContent = { ...BASE_PANE, status: 'idle' }
    rerender(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={idlePane} />
      </Provider>,
    )

    // Thinking indicator gone, answer visible
    expect(screen.queryByLabelText('Claude is thinking')).not.toBeInTheDocument()
    expect(screen.getByText('Here is my answer')).toBeInTheDocument()

    vi.useRealTimers()
  })
})

describe('freshclaude polish e2e: diff view for Edit tool', () => {
  afterEach(cleanup)

  it('shows color-coded diff when an Edit tool result contains old_string/new_string', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Edit a file' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [
        {
          type: 'tool_use',
          id: 'edit-1',
          name: 'Edit',
          input: {
            file_path: '/tmp/test.ts',
            old_string: 'const foo = 1',
            new_string: 'const bar = 2',
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'edit-1',
          content: 'File edited successfully',
        },
      ],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // Tool block should be present and expanded (only 1 tool < 3)
    const toolButton = screen.getByRole('button', { name: /tool call/i })
    expect(toolButton).toHaveAttribute('aria-expanded', 'true')

    // DiffView should render with the diff figure role
    const diffView = screen.getByRole('figure', { name: /diff/i })
    expect(diffView).toBeInTheDocument()

    // Both old and new content should appear in the diff
    expect(diffView.textContent).toContain('foo')
    expect(diffView.textContent).toContain('bar')
  })
})

describe('freshclaude polish e2e: system-reminder stripping', () => {
  afterEach(cleanup)

  it('strips <system-reminder> tags from tool result output', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Read a file' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/f.txt' } },
        {
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: 'File content here<system-reminder>secret internal stuff</system-reminder> and more text',
        },
      ],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // The visible output should contain the real content
    expect(screen.getByText(/File content here/)).toBeInTheDocument()
    expect(screen.getByText(/and more text/)).toBeInTheDocument()

    // The system-reminder content should NOT be visible anywhere
    const fullText = document.body.textContent ?? ''
    expect(fullText).not.toContain('secret internal stuff')
    expect(fullText).not.toContain('system-reminder')
  })
})

describe('freshclaude polish e2e: context menu data attribute', () => {
  afterEach(cleanup)

  it('scroll container has data-context="freshclaude-chat" with session ID', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Hello' }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { container } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const scrollArea = container.querySelector('[data-context="freshclaude-chat"]')
    expect(scrollArea).not.toBeNull()
    expect(scrollArea?.getAttribute('data-session-id')).toBe('sess-1')
  })
})
