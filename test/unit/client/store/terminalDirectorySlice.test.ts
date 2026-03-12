import { describe, expect, it } from 'vitest'
import terminalDirectoryReducer, {
  clearTerminalSearch,
  selectNextTerminalSearchMatch,
  selectPreviousTerminalSearchMatch,
  setTerminalDirectoryWindowData,
  setTerminalSearchResults,
} from '@/store/terminalDirectorySlice'

describe('terminalDirectorySlice', () => {
  it('stores a terminal directory window and appends later pages by terminalId', () => {
    const first = terminalDirectoryReducer(
      undefined,
      setTerminalDirectoryWindowData({
        surface: 'sidebar',
        items: [
          {
            terminalId: 'term-1',
            title: 'One',
            createdAt: 1,
            lastActivityAt: 10,
            status: 'running',
            hasClients: false,
          },
        ],
        revision: 10,
        nextCursor: 'cursor-1',
      }),
    )

    const second = terminalDirectoryReducer(
      first,
      setTerminalDirectoryWindowData({
        surface: 'sidebar',
        items: [
          {
            terminalId: 'term-2',
            title: 'Two',
            createdAt: 2,
            lastActivityAt: 9,
            status: 'running',
            hasClients: false,
          },
          {
            terminalId: 'term-1',
            title: 'One renamed',
            createdAt: 1,
            lastActivityAt: 11,
            status: 'running',
            hasClients: true,
          },
        ],
        revision: 11,
        nextCursor: null,
        append: true,
      }),
    )

    expect(second.windows.sidebar.items).toEqual([
      expect.objectContaining({ terminalId: 'term-1', title: 'One renamed', hasClients: true }),
      expect.objectContaining({ terminalId: 'term-2', title: 'Two' }),
    ])
    expect(second.windows.sidebar.nextCursor).toBeNull()
    expect(second.windows.sidebar.revision).toBe(11)
  })

  it('tracks server-owned terminal search matches and wraps next/previous selection', () => {
    const initial = terminalDirectoryReducer(
      undefined,
      setTerminalSearchResults({
        terminalId: 'term-1',
        query: 'needle',
        matches: [
          { line: 1, column: 0, text: 'needle one' },
          { line: 5, column: 4, text: 'needle two' },
        ],
        nextCursor: null,
      }),
    )

    const afterNext = terminalDirectoryReducer(
      initial,
      selectNextTerminalSearchMatch({ terminalId: 'term-1' }),
    )
    const afterPrevious = terminalDirectoryReducer(
      afterNext,
      selectPreviousTerminalSearchMatch({ terminalId: 'term-1' }),
    )

    expect(initial.searches['term-1']).toEqual(expect.objectContaining({
      query: 'needle',
      activeIndex: 0,
    }))
    expect(afterNext.searches['term-1']?.activeIndex).toBe(1)
    expect(afterPrevious.searches['term-1']?.activeIndex).toBe(0)

    const cleared = terminalDirectoryReducer(
      afterPrevious,
      clearTerminalSearch({ terminalId: 'term-1' }),
    )
    expect(cleared.searches['term-1']).toBeUndefined()
  })
})
