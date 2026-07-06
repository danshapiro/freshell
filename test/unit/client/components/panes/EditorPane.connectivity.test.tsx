import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer, { setStatus, type ConnectionStatus } from '@/store/connectionSlice'

// Spy on the component logger so we can assert *severity* (the whole point of the
// change: expected outages must not reach error/warn).
const logSpies = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}))

vi.mock('@/lib/client-logger', () => ({
  createLogger: () => logSpies,
}))

vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value, onChange }: any) => (
    <textarea data-testid="monaco-mock" value={value} onChange={(e: any) => onChange?.(e.target.value)} />
  )
  return { default: MonacoMock, Editor: MonacoMock }
})

import EditorPane from '@/components/panes/EditorPane'

global.fetch = vi.fn()

const okText = (body: unknown): Response =>
  ({ ok: true, text: () => Promise.resolve(JSON.stringify(body)) } as Response)

const createStore = (status: ConnectionStatus) => {
  const store = configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
  })
  store.dispatch(setStatus(status))
  return store
}

const renderEditor = (store: ReturnType<typeof createStore>, content = 'initial') =>
  render(
    <Provider store={store}>
      <EditorPane
        paneId="pane-1"
        tabId="tab-1"
        filePath="/test.ts"
        language="typescript"
        readOnly={false}
        content={content}
        viewMode="source"
      />
    </Provider>
  )

const callsTo = (fragment: string) =>
  vi.mocked(fetch).mock.calls.filter(
    (call) => typeof call[0] === 'string' && (call[0] as string).includes(fragment)
  )

const statCalls = () => callsTo('/api/files/stat')
const readCalls = () => callsTo('/api/files/read')

describe('EditorPane disk-sync poll — connectivity gating', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.values(logSpies).forEach((spy) => spy.mockReset())
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
      const u = typeof url === 'string' ? url : url.toString()
      if (u.includes('/api/files/stat')) {
        return Promise.resolve(okText({ exists: true, size: 100, modifiedAt: '2026-01-01T00:00:00.000Z' }))
      }
      return Promise.resolve(okText({ content: 'initial', modifiedAt: '2026-01-01T00:00:00.000Z' }))
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('does not poll the stat endpoint while the connection is not ready', async () => {
    const store = createStore('disconnected')
    renderEditor(store)

    await act(async () => {
      vi.advanceTimersByTime(12000)
    })

    expect(statCalls()).toHaveLength(0)
    expect(logSpies.error).not.toHaveBeenCalled()
    expect(logSpies.warn).not.toHaveBeenCalled()
  })

  it('resumes polling once the connection becomes ready', async () => {
    const store = createStore('disconnected')
    renderEditor(store)

    await act(async () => {
      vi.advanceTimersByTime(6000)
    })
    expect(statCalls()).toHaveLength(0)

    await act(async () => {
      store.dispatch(setStatus('ready'))
    })
    await act(async () => {
      vi.advanceTimersByTime(3500)
    })

    expect(statCalls().length).toBeGreaterThanOrEqual(1)
  })

  it('does not log error/warn when a poll fails with a transient network error', async () => {
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
      const u = typeof url === 'string' ? url : url.toString()
      if (u.includes('/api/files/stat')) {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve(okText({}))
    })

    const store = createStore('ready')
    renderEditor(store)

    await act(async () => {
      vi.advanceTimersByTime(3500)
    })

    expect(statCalls().length).toBeGreaterThanOrEqual(1) // it did attempt
    expect(logSpies.error).not.toHaveBeenCalled()
    expect(logSpies.warn).not.toHaveBeenCalled()
  })

  it('still logs an error when the response body is malformed (bugs must surface)', async () => {
    // Regression guard: a TypeError thrown while *processing* a successful
    // response (null body -> null.exists) is a real bug, not a transient
    // network failure, and must not be silently classified away.
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
      const u = typeof url === 'string' ? url : url.toString()
      if (u.includes('/api/files/stat')) {
        return Promise.resolve(okText(null))
      }
      return Promise.resolve(okText({}))
    })

    const store = createStore('ready')
    renderEditor(store)

    await act(async () => {
      vi.advanceTimersByTime(3500)
    })

    expect(logSpies.error).toHaveBeenCalled()
    expect(String(logSpies.error.mock.calls[0][0])).toContain('editor_stat_poll_failed')
  })

  it('defers the mount auto-restore until the connection is ready', async () => {
    const store = createStore('disconnected')
    renderEditor(store, '') // filePath set, content empty -> restoration path

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readCalls()).toHaveLength(0)
    expect(logSpies.error).not.toHaveBeenCalled()
    expect(logSpies.warn).not.toHaveBeenCalled()

    await act(async () => {
      store.dispatch(setStatus('ready'))
    })
    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    expect(readCalls().length).toBeGreaterThanOrEqual(1)
  })

  it('does not log error/warn when the auto-restore load fails transiently', async () => {
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
      const u = typeof url === 'string' ? url : url.toString()
      if (u.includes('/api/files/read')) {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve(okText({ exists: false, size: null, modifiedAt: null }))
    })

    const store = createStore('ready')
    renderEditor(store, '')

    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    expect(readCalls().length).toBeGreaterThanOrEqual(1) // it did attempt
    expect(logSpies.error).not.toHaveBeenCalled()
    expect(logSpies.warn).not.toHaveBeenCalled()
  })

  it('still logs an error when a poll fails with an unexpected HTTP error (500)', async () => {
    // A 500 means the server responded and something is genuinely wrong — that
    // must surface even though the connection is fine.
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
      const u = typeof url === 'string' ? url : url.toString()
      if (u.includes('/api/files/stat')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: () => Promise.resolve(JSON.stringify({ error: 'boom' })),
        } as Response)
      }
      return Promise.resolve(okText({}))
    })

    const store = createStore('ready')
    renderEditor(store)

    await act(async () => {
      vi.advanceTimersByTime(3500)
    })

    expect(logSpies.error).toHaveBeenCalled()
    expect(String(logSpies.error.mock.calls[0][0])).toContain('editor_stat_poll_failed')
  })
})
