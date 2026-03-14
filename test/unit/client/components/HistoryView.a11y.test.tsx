import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import HistoryView from '@/components/HistoryView'
import sessionsReducer from '@/store/sessionsSlice'
import tabsReducer from '@/store/tabsSlice'

// HistoryView calls into api helpers for refresh/rename/delete; keep tests isolated.
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    put: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

describe('HistoryView a11y', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('does not render nested <button> elements for session rows', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const projectPath = '/test/project'
    const store = configureStore({
      reducer: {
        sessions: sessionsReducer,
        tabs: tabsReducer,
      },
      middleware: (getDefault) =>
        getDefault({
          serializableCheck: {
            ignoredPaths: ['sessions.expandedProjects'],
          },
        }),
      preloadedState: {
        sessions: {
          projects: [
            {
              projectPath,
              color: '#6b7280',
              sessions: [
                {
                  provider: 'claude',
                  sessionId: 'session-123',
                  projectPath,
                  lastActivityAt: Date.now(),
                  title: 'Test Session',
                },
              ],
            },
          ],
          expandedProjects: new Set([projectPath]),
        },
        tabs: { tabs: [], activeTabId: null },
      } as any,
    })

    const { container } = render(
      <Provider store={store}>
        <HistoryView />
      </Provider>
    )

    expect(container.querySelectorAll('button button').length).toBe(0)

    // The historical bug produced a validateDOMNesting warning for nested buttons.
    const nestingWarnings = consoleErrorSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((msg) => msg.includes('validateDOMNesting') && msg.includes('<button>'))
    expect(nestingWarnings).toEqual([])

    consoleErrorSpy.mockRestore()
  })
})

