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
    vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('/api/files/stat')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            exists: true,
            size: 100,
            modifiedAt: '2026-01-01T00:00:00.000Z',
          })),
          json: () => Promise.resolve({
            exists: true,
            size: 100,
            modifiedAt: '2026-01-01T00:00:00.000Z',
          }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ success: true, modifiedAt: '2026-01-01T00:00:00.000Z' })),
        json: () => Promise.resolve({ success: true, modifiedAt: '2026-01-01T00:00:00.000Z' }),
      } as Response)
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

    const writeCalls = () => vi.mocked(fetch).mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
    )

    await act(async () => {
      fireEvent.change(editor, { target: { value: 'changed content' } })
    })

    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(writeCalls()).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(writeCalls().length).toBeGreaterThanOrEqual(1)
    expect(writeCalls()[0]).toEqual([
      '/api/files/write',
      expect.objectContaining({
        method: 'POST',
      }),
    ])
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

    const writeCalls = () => vi.mocked(fetch).mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
    )

    await act(async () => {
      fireEvent.change(editor, { target: { value: 'first change' } })
    })

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    await act(async () => {
      fireEvent.change(editor, { target: { value: 'second change' } })
    })

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    expect(writeCalls()).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(writeCalls()).toHaveLength(1)
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

    await act(async () => {
      fireEvent.change(editor, { target: { value: 'updated content' } })
    })

    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
    )
    expect(writeCalls.length).toBeGreaterThanOrEqual(1)
    expect(writeCalls[0]).toEqual([
      '/api/files/write',
      expect.objectContaining({ method: 'POST' }),
    ])

    const [, options] = writeCalls[0]
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

    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
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

    await act(async () => {
      fireEvent.change(editor, { target: { value: 'changed' } })
    })

    unmount()

    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
    )
    expect(writeCalls).toHaveLength(0)
  })
})
