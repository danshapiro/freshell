import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'
import {
  _resetTerminalDirectoryThunkControllers,
  fetchTerminalDirectoryWindow,
  loadTerminalSearch,
} from '@/store/terminalDirectoryThunks'

const getTerminalDirectoryPage = vi.fn()
const searchTerminalView = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getTerminalDirectoryPage: (...args: any[]) => getTerminalDirectoryPage(...args),
    searchTerminalView: (...args: any[]) => searchTerminalView(...args),
  }
})

function createStore() {
  return configureStore({
    reducer: {
      terminalDirectory: terminalDirectoryReducer,
    },
  })
}

describe('terminalDirectoryThunks', () => {
  beforeEach(() => {
    getTerminalDirectoryPage.mockReset()
    searchTerminalView.mockReset()
    _resetTerminalDirectoryThunkControllers()
  })

  it('loads a visible terminal directory window into the requested surface', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [
        {
          terminalId: 'term-1',
          title: 'Codex',
          createdAt: 1,
          lastActivityAt: 10,
          status: 'running',
          hasClients: false,
          mode: 'codex',
          resumeSessionId: 'sess-1',
        },
      ],
      nextCursor: 'cursor-1',
      revision: 10,
    })

    const store = createStore()
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(getTerminalDirectoryPage).toHaveBeenCalledWith(
      { priority: 'visible' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(store.getState().terminalDirectory.windows.sidebar.items[0]?.terminalId).toBe('term-1')
    expect(store.getState().terminalDirectory.windows.sidebar.nextCursor).toBe('cursor-1')
  })

  it('appends using the stored nextCursor when loading more', async () => {
    getTerminalDirectoryPage
      .mockResolvedValueOnce({
        items: [
          {
            terminalId: 'term-1',
            title: 'Codex',
            createdAt: 1,
            lastActivityAt: 10,
            status: 'running',
            hasClients: false,
          },
        ],
        nextCursor: 'cursor-1',
        revision: 10,
      })
      .mockResolvedValueOnce({
        items: [
          {
            terminalId: 'term-2',
            title: 'Shell',
            createdAt: 2,
            lastActivityAt: 9,
            status: 'running',
            hasClients: false,
          },
        ],
        nextCursor: null,
        revision: 10,
      })

    const store = createStore()
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'background',
      priority: 'visible',
    }) as any)
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'background',
      priority: 'visible',
      append: true,
    }) as any)

    expect(getTerminalDirectoryPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        priority: 'visible',
        cursor: 'cursor-1',
        revision: 10,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(store.getState().terminalDirectory.windows.background.items.map((item) => item.terminalId)).toEqual([
      'term-1',
      'term-2',
    ])
  })

  it('loads server-owned search results for a terminal', async () => {
    searchTerminalView.mockResolvedValue({
      matches: [
        { line: 3, column: 2, text: 'needle one' },
        { line: 7, column: 0, text: 'needle two' },
      ],
      nextCursor: null,
    })

    const store = createStore()
    await store.dispatch(loadTerminalSearch({
      terminalId: 'term-9',
      query: 'needle',
    }) as any)

    expect(searchTerminalView).toHaveBeenCalledWith(
      'term-9',
      { query: 'needle' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(store.getState().terminalDirectory.searches['term-9']).toEqual(expect.objectContaining({
      query: 'needle',
      activeIndex: 0,
    }))
  })

  it('aborts an in-flight search when a new query replaces it', async () => {
    const signals: AbortSignal[] = []

    searchTerminalView
      .mockImplementationOnce((_terminalId: string, _query: { query: string }, options: { signal?: AbortSignal }) => {
        if (options.signal) signals.push(options.signal)
        return new Promise((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(undefined), { once: true })
        })
      })
      .mockImplementationOnce((_terminalId: string, _query: { query: string }, options: { signal?: AbortSignal }) => {
        if (options.signal) signals.push(options.signal)
        return Promise.resolve({
          matches: [{ line: 4, column: 0, text: 'needle two' }],
          nextCursor: null,
        })
      })

    const store = createStore()
    const firstDispatch = store.dispatch(loadTerminalSearch({
      terminalId: 'term-9',
      query: 'need',
    }) as any)

    await Promise.resolve()

    await store.dispatch(loadTerminalSearch({
      terminalId: 'term-9',
      query: 'needle',
    }) as any)

    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    await expect(firstDispatch).resolves.toBeUndefined()
  })
})
