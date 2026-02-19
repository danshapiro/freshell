import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import HistoryView from '@/components/HistoryView'
import sessionsReducer from '@/store/sessionsSlice'
import tabsReducer from '@/store/tabsSlice'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    put: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

function renderHistoryView(onOpenSession = vi.fn()) {
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
                updatedAt: Date.now(),
                title: 'Test Session',
                summary: 'summary',
              },
            ],
          },
        ],
        expandedProjects: new Set([projectPath]),
      },
      tabs: { tabs: [], activeTabId: null },
    } as any,
  })

  return render(
    <Provider store={store}>
      <HistoryView onOpenSession={onOpenSession} />
    </Provider>
  )
}

describe('HistoryView mobile behavior', () => {
  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('opens mobile bottom sheet for session details before opening session', () => {
    ;(globalThis as any).setMobileForTest(true)
    const onOpenSession = vi.fn()

    renderHistoryView(onOpenSession)

    fireEvent.click(screen.getByRole('button', { name: /open session test session/i }))

    expect(screen.getByText('Session details')).toBeInTheDocument()
    expect(onOpenSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenSession).toHaveBeenCalledTimes(1)
  })

  it('uses 44px touch targets for mobile session actions', () => {
    ;(globalThis as any).setMobileForTest(true)

    renderHistoryView()

    expect(screen.getByRole('button', { name: 'Open session' }).className).toContain('min-h-11')
    expect(screen.getByRole('button', { name: 'Edit session' }).className).toContain('min-h-11')
    expect(screen.getByRole('button', { name: 'Delete session' }).className).toContain('min-h-11')
  })
})
