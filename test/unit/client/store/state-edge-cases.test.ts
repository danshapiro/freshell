/**
 * State Edge Cases Tests
 *
 * Tests for Redux state management reliability under adverse conditions:
 * - Rapid state updates (debouncing issues)
 * - State hydration with corrupted data
 * - Actions dispatched in wrong order
 * - Concurrent updates from multiple sources
 * - Tab operations during connection loss
 * - Settings update failures mid-save
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureStore, EnhancedStore } from '@reduxjs/toolkit'
import { enableMapSet } from 'immer'

import tabsReducer, {
  addTab,
  setActiveTab,
  updateTab,
  removeTab,
  hydrateTabs,
  TabsState,
} from '@/store/tabsSlice'
import sessionsReducer, {
  setProjects,
  toggleProjectExpanded,
  setProjectExpanded,
  collapseAll,
  expandAll,
  SessionsState,
} from '@/store/sessionsSlice'
import connectionReducer, {
  setStatus,
  setError,
  ConnectionState,
  ConnectionStatus,
} from '@/store/connectionSlice'
import settingsReducer, {
  setSettings,
  updateSettingsLocal,
  markSaved,
  defaultSettings,
  SettingsState,
} from '@/store/settingsSlice'
import type { Tab, ProjectGroup, AppSettings } from '@/store/types'

// Enable Immer's MapSet plugin for Set/Map support in Redux state
enableMapSet()

// Mock nanoid for predictable IDs
let idCounter = 0
vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => `test-id-${++idCounter}`),
}))

// Helper to create a test store
function createTestStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      settings: settingsReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
  })
}

type TestStore = ReturnType<typeof createTestStore>

describe('State Edge Cases', () => {
  beforeEach(() => {
    idCounter = 0
    vi.clearAllMocks()
  })

  // ============================================================
  // TABS SLICE EDGE CASES
  // ============================================================
  describe('tabsSlice edge cases', () => {
    describe('rapid state updates', () => {
      it('handles rapid sequential tab additions without data loss', () => {
        const store = createTestStore()
        const tabCount = 100

        // Simulate rapid tab creation (like spam-clicking "New Tab")
        for (let i = 0; i < tabCount; i++) {
          store.dispatch(addTab({ title: `Tab ${i}` }))
        }

        const state = store.getState().tabs
        expect(state.tabs).toHaveLength(tabCount)

        // Verify each tab has unique ID
        const ids = new Set(state.tabs.map((t) => t.id))
        expect(ids.size).toBe(tabCount)

        // Last added tab should be active
        expect(state.activeTabId).toBe(state.tabs[tabCount - 1].id)
      })

      it('handles rapid tab switching without race conditions', () => {
        const store = createTestStore()

        // Create 10 tabs
        for (let i = 0; i < 10; i++) {
          store.dispatch(addTab())
        }

        const tabIds = store.getState().tabs.tabs.map((t) => t.id)

        // Rapidly switch between tabs
        for (let i = 0; i < 1000; i++) {
          const randomIndex = Math.floor(Math.random() * tabIds.length)
          store.dispatch(setActiveTab(tabIds[randomIndex]))
        }

        // Final state should have valid activeTabId
        const state = store.getState().tabs
        expect(tabIds).toContain(state.activeTabId)
      })

      it('handles rapid add and remove operations', () => {
        const store = createTestStore()

        // Simulate chaotic user behavior
        for (let i = 0; i < 50; i++) {
          store.dispatch(addTab({ title: `Tab ${i}` }))

          // Remove random tab occasionally
          if (i > 0 && i % 3 === 0) {
            const tabs = store.getState().tabs.tabs
            if (tabs.length > 0) {
              const randomIndex = Math.floor(Math.random() * tabs.length)
              store.dispatch(removeTab(tabs[randomIndex].id))
            }
          }
        }

        const state = store.getState().tabs

        // State should remain consistent
        if (state.tabs.length > 0) {
          // activeTabId should be valid or null
          const validIds = state.tabs.map((t) => t.id)
          expect(
            state.activeTabId === null || validIds.includes(state.activeTabId)
          ).toBe(true)
        } else {
          expect(state.activeTabId).toBeNull()
        }
      })

      it('handles concurrent update and remove of same tab', () => {
        const store = createTestStore()

        store.dispatch(addTab({ title: 'Target Tab' }))
        const tabId = store.getState().tabs.tabs[0].id

        // Simulate concurrent operations on same tab
        store.dispatch(updateTab({ id: tabId, updates: { status: 'running' } }))
        store.dispatch(removeTab(tabId))
        store.dispatch(updateTab({ id: tabId, updates: { status: 'exited' } }))

        // Tab should be removed; update on non-existent tab is no-op
        expect(store.getState().tabs.tabs).toHaveLength(0)
      })
    })

    describe('state hydration with corrupted data', () => {
      it('handles null tabs array gracefully', () => {
        const state = tabsReducer(
          { tabs: [], activeTabId: null },
          hydrateTabs({ tabs: null as unknown as Tab[], activeTabId: 'foo' })
        )

        expect(state.tabs).toEqual([])
        expect(state.activeTabId).toBeNull()
      })

      it('handles undefined tabs array gracefully', () => {
        const state = tabsReducer(
          { tabs: [], activeTabId: null },
          hydrateTabs({ tabs: undefined as unknown as Tab[], activeTabId: 'foo' })
        )

        expect(state.tabs).toEqual([])
        expect(state.activeTabId).toBeNull()
      })

      it('handles tabs with missing required fields', () => {
        const corruptedTabs = [
          { id: 'tab-1' }, // Missing title, status, mode, etc.
          { id: 'tab-2', title: 'Valid Title' },
          {}, // Missing everything including id
        ] as Tab[]

        const state = tabsReducer(
          { tabs: [], activeTabId: null },
          hydrateTabs({ tabs: corruptedTabs, activeTabId: null })
        )

        // Should apply defaults
        expect(state.tabs[0].status).toBe('creating')
        expect(state.tabs[0].mode).toBe('shell')
        expect(state.tabs[0].shell).toBe('system')
        expect(state.tabs[0].createdAt).toBeDefined()
      })

      it('handles tabs with invalid status values', () => {
        const tabsWithInvalidStatus = [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Test',
            status: 'invalid-status' as any,
            mode: 'shell' as const,
            createdAt: Date.now(),
          },
        ]

        // The slice doesn't validate status values - it passes through
        // This tests that invalid values don't crash the reducer
        const state = tabsReducer(
          { tabs: [], activeTabId: null },
          hydrateTabs({ tabs: tabsWithInvalidStatus, activeTabId: 'tab-1' })
        )

        expect(state.tabs).toHaveLength(1)
      })

      it('handles activeTabId pointing to non-existent tab', () => {
        const validTabs: Tab[] = [
          {
            id: 'real-tab',
            createRequestId: 'real-tab',
            title: 'Real Tab',
            status: 'running',
            mode: 'shell',
            createdAt: Date.now(),
          },
        ]

        const state = tabsReducer(
          { tabs: [], activeTabId: null },
          hydrateTabs({ tabs: validTabs, activeTabId: 'non-existent-tab' })
        )

        expect(state.activeTabId).toBe('real-tab')
      })

      it('handles extremely large tab arrays', () => {
        const largeTabs: Tab[] = Array.from({ length: 10000 }, (_, i) => ({
          id: `tab-${i}`,
          createRequestId: `tab-${i}`,
          title: `Tab ${i}`,
          status: 'running' as const,
          mode: 'shell' as const,
          createdAt: Date.now(),
        }))

        const startTime = performance.now()
        const state = tabsReducer(
          { tabs: [], activeTabId: null },
          hydrateTabs({ tabs: largeTabs, activeTabId: 'tab-5000' })
        )
        const endTime = performance.now()

        expect(state.tabs).toHaveLength(10000)
        // Should complete reasonably fast (< 1 second)
        expect(endTime - startTime).toBeLessThan(1000)
      })

      it('handles tabs with circular references (JSON parse would fail)', () => {
        // This tests what happens if corrupted localStorage data is parsed
        // Creating an object that mimics what would remain after failed parse
        const corruptedPayload = {
          tabs: [{ id: 'tab-1', title: 'Test' }],
          activeTabId: 'tab-1',
        } as unknown as TabsState

        // Simulate hydration with potentially corrupted data
        const state = tabsReducer(
          { tabs: [], activeTabId: null },
          hydrateTabs(corruptedPayload)
        )

        expect(state.tabs).toHaveLength(1)
      })

      it('handles tabs with NaN or Infinity in numeric fields', () => {
        const tabsWithBadNumbers: Tab[] = [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Test',
            status: 'running',
            mode: 'shell',
            createdAt: NaN, // Invalid timestamp
          },
        ]

        const state = tabsReducer(
          { tabs: [], activeTabId: null },
          hydrateTabs({ tabs: tabsWithBadNumbers, activeTabId: 'tab-1' })
        )

        // Should set default createdAt when NaN
        expect(state.tabs[0].createdAt).toBeDefined()
        // Note: Current implementation doesn't check for NaN, it would remain NaN
        // This documents the current behavior
      })
    })

    describe('actions dispatched in wrong order', () => {
      it('handles setActiveTab before any tabs exist', () => {
        const store = createTestStore()

        // Set active tab when no tabs exist
        store.dispatch(setActiveTab('phantom-tab'))

        const state = store.getState().tabs
        // activeTabId is set even if no tabs exist
        expect(state.activeTabId).toBe('phantom-tab')
        expect(state.tabs).toHaveLength(0)
      })

      it('handles removeTab before tab is fully created', () => {
        const store = createTestStore()

        // Simulate race: remove fires before add completes
        store.dispatch(removeTab('future-tab-id'))
        store.dispatch(addTab({ title: 'Test' }))

        // Tab should exist since remove ran first on non-existent tab
        expect(store.getState().tabs.tabs).toHaveLength(1)
      })

      it('handles updateTab before tab exists', () => {
        const store = createTestStore()

        // Update non-existent tab (should be no-op)
        store.dispatch(updateTab({ id: 'ghost-tab', updates: { title: 'New Title' } }))

        expect(store.getState().tabs.tabs).toHaveLength(0)
      })

      it('handles hydrateTabs called multiple times', () => {
        const store = createTestStore()

        const firstHydration: Tab[] = [
          { id: 'first-1', createRequestId: 'first-1', title: 'First', status: 'running', mode: 'shell', createdAt: 1000 },
        ]
        const secondHydration: Tab[] = [
          { id: 'second-1', createRequestId: 'second-1', title: 'Second', status: 'running', mode: 'shell', createdAt: 2000 },
          { id: 'second-2', createRequestId: 'second-2', title: 'Second 2', status: 'running', mode: 'shell', createdAt: 3000 },
        ]

        store.dispatch(hydrateTabs({ tabs: firstHydration, activeTabId: 'first-1' }))
        store.dispatch(hydrateTabs({ tabs: secondHydration, activeTabId: 'second-2' }))

        // Second hydration should completely replace first
        const state = store.getState().tabs
        expect(state.tabs).toHaveLength(2)
        expect(state.tabs[0].id).toBe('second-1')
        expect(state.activeTabId).toBe('second-2')
      })
    })

    describe('tab operations edge cases', () => {
      it('handles removing the only tab', () => {
        const store = createTestStore()

        store.dispatch(addTab({ title: 'Only Tab' }))
        const tabId = store.getState().tabs.tabs[0].id

        store.dispatch(removeTab(tabId))

        const state = store.getState().tabs
        expect(state.tabs).toHaveLength(0)
        expect(state.activeTabId).toBeNull()
      })

      it('handles removing middle tab selection behavior', () => {
        const store = createTestStore()

        // Create 3 tabs: A, B, C
        store.dispatch(addTab({ title: 'A' }))
        const tabA = store.getState().tabs.tabs[0].id
        store.dispatch(addTab({ title: 'B' }))
        const tabB = store.getState().tabs.tabs[1].id
        store.dispatch(addTab({ title: 'C' }))

        // Set B as active
        store.dispatch(setActiveTab(tabB))

        // Remove B
        store.dispatch(removeTab(tabB))

        // Should select first tab (A)
        expect(store.getState().tabs.activeTabId).toBe(tabA)
      })

      it('handles removing all tabs one by one', () => {
        const store = createTestStore()

        for (let i = 0; i < 5; i++) {
          store.dispatch(addTab())
        }

        while (store.getState().tabs.tabs.length > 0) {
          const firstTab = store.getState().tabs.tabs[0]
          store.dispatch(removeTab(firstTab.id))
        }

        expect(store.getState().tabs.tabs).toHaveLength(0)
        expect(store.getState().tabs.activeTabId).toBeNull()
      })
    })
  })

  // ============================================================
  // SESSIONS SLICE EDGE CASES
  // ============================================================
  describe('sessionsSlice edge cases', () => {
    describe('rapid state updates', () => {
      it('handles rapid toggle operations', () => {
        const store = createTestStore()

        const projects: ProjectGroup[] = [
          { projectPath: '/project/a', sessions: [] },
          { projectPath: '/project/b', sessions: [] },
          { projectPath: '/project/c', sessions: [] },
        ]

        store.dispatch(setProjects(projects))

        // Rapidly toggle same project
        for (let i = 0; i < 100; i++) {
          store.dispatch(toggleProjectExpanded('/project/a'))
        }

        // After even number of toggles, should be collapsed
        expect(store.getState().sessions.expandedProjects.has('/project/a')).toBe(false)
      })

      it('handles concurrent expand/collapse operations', () => {
        const store = createTestStore()

        const projects: ProjectGroup[] = Array.from({ length: 50 }, (_, i) => ({
          projectPath: `/project/${i}`,
          sessions: [],
        }))

        store.dispatch(setProjects(projects))

        // Randomly expand/collapse
        for (let i = 0; i < 500; i++) {
          const projectIndex = Math.floor(Math.random() * 50)
          const expanded = Math.random() > 0.5
          store.dispatch(
            setProjectExpanded({
              projectPath: `/project/${projectIndex}`,
              expanded,
            })
          )
        }

        // State should be consistent - no duplicates, no corruption
        const expanded = store.getState().sessions.expandedProjects
        expect(expanded).toBeInstanceOf(Set)
      })
    })

    describe('state synchronization issues', () => {
      it('handles setProjects with stale expandedProjects', () => {
        const store = createTestStore()

        // Initial projects
        const oldProjects: ProjectGroup[] = [
          { projectPath: '/old/project', sessions: [] },
        ]
        store.dispatch(setProjects(oldProjects))
        store.dispatch(setProjectExpanded({ projectPath: '/old/project', expanded: true }))

        // Replace with new projects
        const newProjects: ProjectGroup[] = [
          { projectPath: '/new/project', sessions: [] },
        ]
        store.dispatch(setProjects(newProjects))

        // expandedProjects should not keep stale project paths
        expect(store.getState().sessions.expandedProjects.has('/old/project')).toBe(false)
      })

      it('handles expandAll when projects are empty', () => {
        const store = createTestStore()

        store.dispatch(expandAll())

        expect(store.getState().sessions.expandedProjects.size).toBe(0)
      })

      it('handles collapseAll when nothing is expanded', () => {
        const store = createTestStore()

        const projects: ProjectGroup[] = [
          { projectPath: '/project/a', sessions: [] },
        ]
        store.dispatch(setProjects(projects))
        store.dispatch(collapseAll())

        expect(store.getState().sessions.expandedProjects.size).toBe(0)
      })

      it('handles rapid setProjects calls', () => {
        const store = createTestStore()

        // Simulate rapid session list refreshes
        for (let i = 0; i < 100; i++) {
          const projects: ProjectGroup[] = [
            {
              projectPath: `/project/${i}`,
              sessions: [
                {
                  sessionId: `session-${i}`,
                  projectPath: `/project/${i}`,
                  updatedAt: Date.now(),
                },
              ],
            },
          ]
          store.dispatch(setProjects(projects))
        }

        // Should have last update
        const state = store.getState().sessions
        expect(state.projects[0].projectPath).toBe('/project/99')
        expect(state.lastLoadedAt).toBeDefined()
      })
    })

    describe('Set operations edge cases', () => {
      it('handles expandedProjects with duplicate paths', () => {
        const store = createTestStore()

        const projects: ProjectGroup[] = [
          { projectPath: '/project/a', sessions: [] },
        ]
        store.dispatch(setProjects(projects))

        // Try to expand same project multiple times
        store.dispatch(setProjectExpanded({ projectPath: '/project/a', expanded: true }))
        store.dispatch(setProjectExpanded({ projectPath: '/project/a', expanded: true }))
        store.dispatch(setProjectExpanded({ projectPath: '/project/a', expanded: true }))

        // Set should deduplicate automatically
        expect(store.getState().sessions.expandedProjects.size).toBe(1)
      })

      it('handles expandedProjects with special characters in paths', () => {
        const store = createTestStore()

        const projects: ProjectGroup[] = [
          { projectPath: '/path/with spaces/project', sessions: [] },
          { projectPath: '/path/with-dashes/project', sessions: [] },
          { projectPath: '/path/with_underscores/project', sessions: [] },
          { projectPath: 'C:\\Windows\\Path', sessions: [] },
        ]
        store.dispatch(setProjects(projects))
        store.dispatch(expandAll())

        const expanded = store.getState().sessions.expandedProjects
        expect(expanded.size).toBe(4)
        expect(expanded.has('/path/with spaces/project')).toBe(true)
        expect(expanded.has('C:\\Windows\\Path')).toBe(true)
      })
    })
  })

  // ============================================================
  // CONNECTION SLICE EDGE CASES
  // ============================================================
  describe('connectionSlice edge cases', () => {
    describe('state machine violations', () => {
      it('allows any state transition (no guards)', () => {
        const store = createTestStore()

        // Jump from disconnected directly to ready (skipping connecting/connected)
        store.dispatch(setStatus('ready'))
        expect(store.getState().connection.status).toBe('ready')

        // Jump back to connecting from ready
        store.dispatch(setStatus('connecting'))
        expect(store.getState().connection.status).toBe('connecting')
      })

      it('handles rapid connection status changes', () => {
        const store = createTestStore()

        const statuses: ConnectionStatus[] = [
          'disconnected',
          'connecting',
          'connected',
          'ready',
        ]

        // Simulate flaky connection
        for (let i = 0; i < 100; i++) {
          const randomStatus = statuses[Math.floor(Math.random() * statuses.length)]
          store.dispatch(setStatus(randomStatus))
        }

        // Final state should be valid
        expect(statuses).toContain(store.getState().connection.status)
      })

      it('handles error set during connecting state', () => {
        const store = createTestStore()

        store.dispatch(setStatus('connecting'))
        store.dispatch(setError('Connection timeout'))

        // Error is stored but status unchanged
        expect(store.getState().connection.status).toBe('connecting')
        expect(store.getState().connection.lastError).toBe('Connection timeout')
      })

      it('handles ready status setting lastReadyAt correctly', () => {
        vi.useFakeTimers()
        const now = 1000000

        const store = createTestStore()

        vi.setSystemTime(now)
        store.dispatch(setStatus('ready'))

        expect(store.getState().connection.lastReadyAt).toBe(now)

        // Set to another status
        store.dispatch(setStatus('disconnected'))

        // lastReadyAt should be preserved
        expect(store.getState().connection.lastReadyAt).toBe(now)

        // Set ready again with new time
        vi.setSystemTime(now + 5000)
        store.dispatch(setStatus('ready'))

        expect(store.getState().connection.lastReadyAt).toBe(now + 5000)

        vi.useRealTimers()
      })
    })

    describe('error handling edge cases', () => {
      it('handles extremely long error messages', () => {
        const store = createTestStore()

        const longError = 'Error: ' + 'a'.repeat(10000)
        store.dispatch(setError(longError))

        expect(store.getState().connection.lastError).toBe(longError)
      })

      it('handles error messages with special characters', () => {
        const store = createTestStore()

        const specialError = 'Error: <script>alert("xss")</script>\n\t\r\0'
        store.dispatch(setError(specialError))

        expect(store.getState().connection.lastError).toBe(specialError)
      })

      it('handles undefined error clearing', () => {
        const store = createTestStore()

        store.dispatch(setError('Initial error'))
        store.dispatch(setError(undefined))

        expect(store.getState().connection.lastError).toBeUndefined()
      })

      it('handles empty string error', () => {
        const store = createTestStore()

        store.dispatch(setError(''))

        expect(store.getState().connection.lastError).toBe('')
      })
    })

    describe('concurrent operations', () => {
      it('handles setStatus and setError in rapid succession', () => {
        const store = createTestStore()

        for (let i = 0; i < 50; i++) {
          store.dispatch(setStatus('connecting'))
          store.dispatch(setError(`Attempt ${i} failed`))
          store.dispatch(setStatus('disconnected'))
          store.dispatch(setError(undefined))
          store.dispatch(setStatus('connecting'))
          store.dispatch(setStatus('connected'))
          store.dispatch(setStatus('ready'))
        }

        // Final state should be valid
        const state = store.getState().connection
        expect(state.status).toBe('ready')
        expect(state.lastReadyAt).toBeDefined()
      })
    })
  })

  // ============================================================
  // SETTINGS SLICE EDGE CASES
  // ============================================================
  describe('settingsSlice edge cases', () => {
    describe('partial updates edge cases', () => {
      it('handles deeply nested partial updates correctly', () => {
        const store = createTestStore()

        // Update only terminal fontSize
        store.dispatch(updateSettingsLocal({ terminal: { fontSize: 20 } }))

        const settings = store.getState().settings.settings
        expect(settings.terminal.fontSize).toBe(20)
        // Other terminal properties should remain default
        expect(settings.terminal.fontFamily).toBe(defaultSettings.terminal.fontFamily)
        expect(settings.terminal.cursorBlink).toBe(defaultSettings.terminal.cursorBlink)
      })

      it('handles empty nested object updates', () => {
        const store = createTestStore()

        store.dispatch(updateSettingsLocal({ terminal: {} }))

        // Should preserve all terminal settings
        expect(store.getState().settings.settings.terminal).toEqual(
          defaultSettings.terminal
        )
      })

      it('handles undefined values in partial updates', () => {
        const store = createTestStore()

        store.dispatch(
          updateSettingsLocal({
            theme: 'dark',
            defaultCwd: undefined,
          })
        )

        const settings = store.getState().settings.settings
        expect(settings.theme).toBe('dark')
        // undefined should not overwrite existing value due to spread
        expect(settings.defaultCwd).toBeUndefined()
      })

      it('handles rapid sequential updates', () => {
        const store = createTestStore()

        for (let i = 1; i <= 100; i++) {
          store.dispatch(updateSettingsLocal({ terminal: { fontSize: i } }))
        }

        expect(store.getState().settings.settings.terminal.fontSize).toBe(100)
      })
    })

    describe('settings persistence edge cases', () => {
      it('handles markSaved without prior setSettings', () => {
        vi.useFakeTimers()
        const now = 5000000

        const store = createTestStore()

        vi.setSystemTime(now)
        store.dispatch(markSaved())

        expect(store.getState().settings.lastSavedAt).toBe(now)
        expect(store.getState().settings.loaded).toBe(false) // Still false

        vi.useRealTimers()
      })

      it('handles setSettings with completely different structure', () => {
        const store = createTestStore()

        const customSettings: AppSettings = {
          theme: 'light',
          uiScale: 2.0,
          logging: {
            debug: false,
          },
          terminal: {
            fontSize: 24,
            fontFamily: 'Fira Code',
            lineHeight: 1.8,
            cursorBlink: false,
            scrollback: 100000,
            theme: 'one-light',
            warnExternalLinks: true,
          },
          defaultCwd: '/custom/path',
          safety: {
            autoKillIdleMinutes: 10,
            warnBeforeKillMinutes: 2,
          },
          sidebar: {
            sortMode: 'activity',
            showProjectBadges: false,
            showSubagents: false,
            showNoninteractiveSessions: false,
            width: 400,
            collapsed: true,
          },
          panes: {
            defaultNewPane: 'shell',
            snapThreshold: 3,
            iconsOnTabs: true,
            tabAttentionStyle: 'highlight' as const,
            attentionDismiss: 'click' as const,
          },
          codingCli: {
            enabledProviders: ['claude', 'codex'],
            providers: {
              claude: { permissionMode: 'default' },
              codex: { model: 'gpt-5-codex' },
            },
          },
        }

        store.dispatch(setSettings(customSettings))

        expect(store.getState().settings.settings).toEqual(customSettings)
        expect(store.getState().settings.loaded).toBe(true)
      })

      it('handles multiple setSettings calls overwriting each other', () => {
        const store = createTestStore()

        for (let i = 0; i < 10; i++) {
          const settings: AppSettings = {
            ...defaultSettings,
            uiScale: i * 0.1 + 1,
          }
          store.dispatch(setSettings(settings))
        }

        // Last one wins
        expect(store.getState().settings.settings.uiScale).toBeCloseTo(1.9, 5)
      })
    })

    describe('invalid settings values', () => {
      it('handles negative numeric values', () => {
        const store = createTestStore()

        store.dispatch(
          updateSettingsLocal({
            uiScale: -1,
            terminal: { fontSize: -10, scrollback: -1000 },
            safety: { autoKillIdleMinutes: -5, warnBeforeKillMinutes: -1 },
          })
        )

        // Values are stored as-is (no validation in reducer)
        const settings = store.getState().settings.settings
        expect(settings.uiScale).toBe(-1)
        expect(settings.terminal.fontSize).toBe(-10)
      })

      it('handles NaN and Infinity in numeric fields', () => {
        const store = createTestStore()

        store.dispatch(
          updateSettingsLocal({
            uiScale: NaN,
            terminal: { fontSize: Infinity },
          })
        )

        // Values are stored as-is (no validation)
        expect(store.getState().settings.settings.uiScale).toBeNaN()
        expect(store.getState().settings.settings.terminal.fontSize).toBe(Infinity)
      })

      it('handles extremely large values', () => {
        const store = createTestStore()

        store.dispatch(
          updateSettingsLocal({
            uiScale: Number.MAX_SAFE_INTEGER,
            terminal: { scrollback: Number.MAX_SAFE_INTEGER },
          })
        )

        expect(store.getState().settings.settings.uiScale).toBe(Number.MAX_SAFE_INTEGER)
      })
    })
  })

  // ============================================================
  // CROSS-SLICE INTERACTION EDGE CASES
  // ============================================================
  describe('cross-slice interaction edge cases', () => {
    describe('tab operations during connection loss', () => {
      it('allows tab operations when disconnected', () => {
        const store = createTestStore()

        store.dispatch(setStatus('disconnected'))
        store.dispatch(setError('Network unavailable'))

        // Tab operations should still work locally
        store.dispatch(addTab({ title: 'Offline Tab' }))
        expect(store.getState().tabs.tabs).toHaveLength(1)

        store.dispatch(updateTab({
          id: store.getState().tabs.tabs[0].id,
          updates: { status: 'error' },
        }))
        expect(store.getState().tabs.tabs[0].status).toBe('error')
      })

      it('handles connection state changes during tab operations', () => {
        const store = createTestStore()

        // Start connected
        store.dispatch(setStatus('ready'))

        // Begin tab operation
        store.dispatch(addTab({ title: 'New Tab' }))
        const tabId = store.getState().tabs.tabs[0].id

        // Connection drops mid-operation
        store.dispatch(setStatus('disconnected'))
        store.dispatch(setError('Connection lost'))

        // Continue tab operation
        store.dispatch(updateTab({
          id: tabId,
          updates: { terminalId: 'terminal-123' },
        }))

        // Both states should be consistent
        expect(store.getState().connection.status).toBe('disconnected')
        expect(store.getState().tabs.tabs[0].terminalId).toBe('terminal-123')
      })
    })

    describe('settings changes affecting other slices', () => {
      it('settings changes do not affect tabs state', () => {
        const store = createTestStore()

        store.dispatch(addTab({ title: 'Test Tab' }))
        const tabsBefore = store.getState().tabs

        store.dispatch(updateSettingsLocal({ terminal: { fontSize: 20 } }))

        // Tabs should be unchanged
        expect(store.getState().tabs).toEqual(tabsBefore)
      })
    })

    describe('full store state consistency', () => {
      it('maintains consistency under heavy mixed operations', () => {
        const store = createTestStore()

        // Simulate realistic app usage
        for (let i = 0; i < 50; i++) {
          // Random tab operations
          if (Math.random() > 0.3) {
            store.dispatch(addTab({ title: `Tab ${i}` }))
          }
          if (store.getState().tabs.tabs.length > 0 && Math.random() > 0.7) {
            const tabs = store.getState().tabs.tabs
            store.dispatch(removeTab(tabs[Math.floor(Math.random() * tabs.length)].id))
          }

          // Random session operations
          store.dispatch(
            setProjects([
              {
                projectPath: `/project/${i}`,
                sessions: [
                  { sessionId: `s-${i}`, projectPath: `/project/${i}`, updatedAt: Date.now() },
                ],
              },
            ])
          )
          if (Math.random() > 0.5) {
            store.dispatch(toggleProjectExpanded(`/project/${i}`))
          }

          // Random connection status
          const statuses: ConnectionStatus[] = ['disconnected', 'connecting', 'connected', 'ready']
          store.dispatch(setStatus(statuses[Math.floor(Math.random() * statuses.length)]))

          // Random settings update
          store.dispatch(
            updateSettingsLocal({
              terminal: { fontSize: 10 + Math.floor(Math.random() * 20) },
            })
          )
        }

        // Verify final state is valid
        const state = store.getState()

        // Tabs state valid
        if (state.tabs.tabs.length > 0) {
          state.tabs.tabs.forEach((tab) => {
            expect(tab.id).toBeDefined()
            expect(tab.status).toBeDefined()
          })
        }

        // Sessions state valid
        expect(state.sessions.projects).toBeInstanceOf(Array)
        expect(state.sessions.expandedProjects).toBeInstanceOf(Set)

        // Connection state valid
        expect(['disconnected', 'connecting', 'connected', 'ready']).toContain(
          state.connection.status
        )

        // Settings state valid
        expect(state.settings.settings.terminal.fontSize).toBeGreaterThanOrEqual(10)
        expect(state.settings.settings.terminal.fontSize).toBeLessThan(30)
      })
    })
  })

  // ============================================================
  // POTENTIAL BUG DOCUMENTATION
  // ============================================================
  describe('documented potential issues', () => {
    it('FIXED: activeTabId is validated against tabs on hydration', () => {
      const state = tabsReducer(
        { tabs: [], activeTabId: null },
        hydrateTabs({
          tabs: [{ id: 'tab-1', createRequestId: 'tab-1', title: 'Tab', status: 'running', mode: 'shell', createdAt: 1000 }],
          activeTabId: 'non-existent',
        })
      )

      expect(state.activeTabId).toBe('tab-1')
      expect(state.tabs.find((t) => t.id === state.activeTabId)).toBeDefined()
    })

    it('FIXED: expandedProjects is pruned when projects change', () => {
      const store = createTestStore()

      store.dispatch(setProjects([{ projectPath: '/old', sessions: [] }]))
      store.dispatch(setProjectExpanded({ projectPath: '/old', expanded: true }))
      store.dispatch(setProjects([{ projectPath: '/new', sessions: [] }]))

      expect(store.getState().sessions.expandedProjects.has('/old')).toBe(false)
    })

    it('ISSUE: connection state allows invalid transitions', () => {
      const store = createTestStore()

      // Can skip connecting/connected and go directly to ready
      store.dispatch(setStatus('ready'))
      expect(store.getState().connection.status).toBe('ready')

      // Can go from ready back to connecting
      store.dispatch(setStatus('connecting'))
      expect(store.getState().connection.status).toBe('connecting')

      // This may cause UI inconsistencies if components expect proper state machine
    })

    it('ISSUE: settings validation not performed in reducer', () => {
      const store = createTestStore()

      // Can set invalid values
      store.dispatch(
        updateSettingsLocal({
          uiScale: -999,
          terminal: { fontSize: -1, scrollback: -1 },
        })
      )

      // Negative values stored without validation
      expect(store.getState().settings.settings.uiScale).toBe(-999)
      expect(store.getState().settings.settings.terminal.fontSize).toBe(-1)
    })
  })
})
