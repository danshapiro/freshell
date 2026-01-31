import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '@/components/panes/EditorPane'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

// Mock Monaco to avoid loading issues in tests
vi.mock('@monaco-editor/react', () => {
  const MockEditor = ({ value, onChange }: any) => {
    const React = require('react')
    return React.createElement('textarea', {
      'data-testid': 'monaco-mock',
      value,
      onChange: (e: any) => onChange?.(e.target.value),
    })
  }
  return {
    default: MockEditor,
    Editor: MockEditor,
  }
})

// Helper to create a proper mock response for the api module (which uses res.text())
const createMockResponse = (data: unknown, ok = true, statusText = 'OK') => ({
  ok,
  statusText,
  text: async () => JSON.stringify(data),
})

// Mock fetch for auto-save
global.fetch = vi.fn()

const createMockStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
  })

describe('EditorPane auto-save', () => {
  let store: ReturnType<typeof createMockStore>

  beforeEach(() => {
    vi.useFakeTimers()
    store = createMockStore()
    vi.mocked(fetch).mockReset()
    // Default mock for all endpoints
    vi.mocked(fetch).mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString()
      if (urlStr === '/api/terminals') {
        return createMockResponse([]) as Response
      }
      if (urlStr === '/api/files/write') {
        return createMockResponse({ success: true }) as Response
      }
      if (urlStr.startsWith('/api/files/complete')) {
        return createMockResponse({ suggestions: [] }) as Response
      }
      return createMockResponse({ success: true }) as Response
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('auto-saves after 5 seconds of inactivity', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial"
          viewMode="source"
        />
      </Provider>
    )

    const editor = screen.getByTestId('monaco-mock')

    // Simulate typing by triggering onChange via fireEvent
    await act(async () => {
      fireEvent.change(editor, { target: { value: 'changed content' } })
    })

    // Fast-forward 4 seconds - should not save yet
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(fetch).not.toHaveBeenCalled()

    // Fast-forward 1 more second (total 5s) - should save
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    // Check that /api/files/write was called
    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => call[0] === '/api/files/write'
    )
    expect(writeCalls.length).toBeGreaterThan(0)
  })

  it('does not auto-save scratch pads (no filePath)', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath={null}
          language={null}
          readOnly={false}
          content="scratch content"
          viewMode="source"
        />
      </Provider>
    )

    // Fast-forward past debounce time
    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    // Check that /api/files/write was NOT called (other calls like /api/terminals are okay)
    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => call[0] === '/api/files/write'
    )
    expect(writeCalls).toHaveLength(0)
  })

  it('resets debounce timer on each change', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial"
          viewMode="source"
        />
      </Provider>
    )

    const editor = screen.getByTestId('monaco-mock')

    // First change
    await act(async () => {
      fireEvent.change(editor, { target: { value: 'first change' } })
    })

    // Wait 3 seconds
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    // Another change - should reset the timer
    await act(async () => {
      fireEvent.change(editor, { target: { value: 'second change' } })
    })

    // Wait 3 more seconds (6s total from start, but only 3s since last change)
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    expect(fetch).not.toHaveBeenCalled()

    // Wait 2 more seconds (5s since last change)
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    // Should have saved once
    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => call[0] === '/api/files/write'
    )
    expect(writeCalls).toHaveLength(1)
  })

  it('sends correct content in auto-save request', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial"
          viewMode="source"
        />
      </Provider>
    )

    const editor = screen.getByTestId('monaco-mock')

    // Simulate content change
    await act(async () => {
      fireEvent.change(editor, { target: { value: 'updated content' } })
    })

    // Wait for debounce
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    // Find the write call
    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => call[0] === '/api/files/write'
    )
    expect(writeCalls.length).toBeGreaterThan(0)

    const [, options] = writeCalls[0]
    expect(options?.method).toBe('POST')

    // Verify the body content
    const body = JSON.parse(options?.body as string)
    expect(body).toEqual({
      path: '/test.ts',
      content: 'updated content',
    })
  })

  it('does not auto-save when readOnly is true', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={true}
          content="read only content"
          viewMode="source"
        />
      </Provider>
    )

    // Fast-forward past debounce time
    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    // Check that /api/files/write was NOT called
    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => call[0] === '/api/files/write'
    )
    expect(writeCalls).toHaveLength(0)
  })

  it('cleans up timer on unmount', async () => {
    const { unmount } = render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial"
          viewMode="source"
        />
      </Provider>
    )

    const editor = screen.getByTestId('monaco-mock')

    // Trigger a change to schedule auto-save
    await act(async () => {
      fireEvent.change(editor, { target: { value: 'changed' } })
    })

    // Unmount before timer fires
    unmount()

    // Advance past the debounce time
    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    // Should not have saved since component unmounted
    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => call[0] === '/api/files/write'
    )
    expect(writeCalls).toHaveLength(0)
  })
})
