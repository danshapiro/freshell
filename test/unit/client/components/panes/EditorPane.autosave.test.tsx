import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '@/components/panes/EditorPane'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value, onChange }: any) => (
    <textarea
      data-testid="monaco-mock"
      value={value}
      onChange={(e: any) => onChange?.(e.target.value)}
    />
  )
  return {
    default: MonacoMock,
    Editor: MonacoMock,
  }
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
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
      json: () => Promise.resolve({ success: true }),
    } as Response)
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
    expect(fetch).toHaveBeenCalledWith(
      '/api/files/write',
      expect.objectContaining({
        method: 'POST',
      })
    )
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

    expect(fetch).not.toHaveBeenCalled()
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

    expect(fetch).toHaveBeenCalledTimes(1)
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

    expect(fetch).toHaveBeenCalledWith(
      '/api/files/write',
      expect.objectContaining({
        method: 'POST',
      })
    )

    // Verify the body content
    const [, options] = vi.mocked(fetch).mock.calls[0]
    expect(options?.body).toBeDefined()
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

    expect(fetch).not.toHaveBeenCalled()
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
    expect(fetch).not.toHaveBeenCalled()
  })
})
