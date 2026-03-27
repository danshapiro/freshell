import { act, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it, vi } from 'vitest'
import Sidebar from '@/components/Sidebar'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer, {
  commitSessionWindowReplacement,
  commitSessionWindowVisibleRefresh,
} from '@/store/sessionsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import extensionsReducer from '@/store/extensionsSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'
import type { ClientExtensionEntry } from '@shared/extension-types'

const defaultCliExtensions: ClientExtensionEntry[] = [
  {
    name: 'claude',
    version: '1.0.0',
    label: 'Claude CLI',
    description: '',
    category: 'cli',
    picker: { shortcut: 'L' },
    cli: { supportsPermissionMode: true, supportsResume: true, resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'] },
  },
  {
    name: 'codex',
    version: '1.0.0',
    label: 'Codex CLI',
    description: '',
    category: 'cli',
    picker: { shortcut: 'X' },
    cli: { supportsModel: true, supportsSandbox: true, supportsResume: true, resumeCommandTemplate: ['codex', 'resume', '{{sessionId}}'] },
  },
]

function createSidebarStore() {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      sessionActivity: sessionActivityReducer,
      extensions: extensionsReducer,
      codexActivity: codexActivityReducer,
      terminalDirectory: terminalDirectoryReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      settings: {
        settings: {
          ...defaultSettings,
          sidebar: {
            ...defaultSettings.sidebar,
            sortMode: 'recency',
            showProjectBadges: true,
            hideEmptySessions: false,
          },
        },
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: [],
        activeTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
      },
      connection: {
        status: 'connected',
        error: null,
        serverInstanceId: undefined,
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
        isLoading: false,
        error: null,
        windows: {},
      },
      sessionActivity: {
        sessions: {},
      },
      extensions: {
        entries: defaultCliExtensions,
      },
      codexActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
      terminalDirectory: {
        windows: {
          sidebar: {
            items: [],
            nextCursor: null,
            revision: 1,
          },
        },
        searches: {},
      },
    },
  })
}

function renderSidebar(store: ReturnType<typeof createSidebarStore>) {
  return render(
    <Provider store={store}>
      <Sidebar view="terminal" onNavigate={vi.fn()} />
    </Provider>,
  )
}

describe('Sidebar DOM stability', () => {
  it('keeps unchanged sidebar rows mounted across a silent window refresh', () => {
    const store = createSidebarStore()

    act(() => {
      store.dispatch(commitSessionWindowReplacement({
        surface: 'sidebar',
        projects: [
          {
            projectPath: '/proj',
            sessions: [
              { provider: 'codex', sessionId: 'stable-a', projectPath: '/proj', lastActivityAt: 40, title: 'Stable A' },
              { provider: 'codex', sessionId: 'stable-b', projectPath: '/proj', lastActivityAt: 30, title: 'Stable B' },
            ],
          },
        ],
        totalSessions: 2,
        oldestLoadedTimestamp: 30,
        oldestLoadedSessionId: 'codex:stable-b',
        hasMore: false,
      }))
    })

    renderSidebar(store)

    const stableAButton = screen.getByRole('button', { name: /Stable A/i })
    const stableBButton = screen.getByRole('button', { name: /Stable B/i })

    act(() => {
      store.dispatch(commitSessionWindowVisibleRefresh({
        surface: 'sidebar',
        projects: [
          {
            projectPath: '/proj',
            sessions: [
              { provider: 'codex', sessionId: 'new-top', projectPath: '/proj', lastActivityAt: 50, title: 'New Top' },
              { provider: 'codex', sessionId: 'stable-a', projectPath: '/proj', lastActivityAt: 40, title: 'Stable A' },
              { provider: 'codex', sessionId: 'stable-b', projectPath: '/proj', lastActivityAt: 30, title: 'Stable B' },
            ],
          },
        ],
        totalSessions: 3,
        oldestLoadedTimestamp: 30,
        oldestLoadedSessionId: 'codex:stable-b',
        hasMore: false,
      }))
    })

    expect(screen.getByRole('button', { name: /Stable A/i })).toBe(stableAButton)
    expect(screen.getByRole('button', { name: /Stable B/i })).toBe(stableBButton)
  })
})
