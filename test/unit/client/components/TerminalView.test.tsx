import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { updateTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import paneRuntimeTitleReducer, { setPaneRuntimeTitleByTerminalId } from '@/store/paneRuntimeTitleSlice'
import { syncStableTitleByTerminalId } from '@/store/titleSync'
import { getTabDisplayTitle, getTabDurableDisplayTitle } from '@/lib/tab-title'
import {
  normalizeRuntimeTitle,
  resolveEffectiveLegacyTabTitleSource,
  shouldDecorateExitTitle,
  type DurableTitleSource,
} from '@/lib/title-source'

function createStore(options?: {
  title?: string
  titleSource?: DurableTitleSource
  paneTitles?: Record<string, string>
  paneTitleSources?: Record<string, DurableTitleSource>
}) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      paneRuntimeTitle: paneRuntimeTitleReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          mode: 'shell' as const,
          status: 'running' as const,
          title: options?.title ?? 'Terminal',
          titleSource: options?.titleSource ?? 'derived',
          titleSetByUser: options?.titleSource === 'user',
          createRequestId: 'req-1',
          createdAt: 1,
        }],
        activeTabId: 'tab-1',
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              shell: 'system',
              terminalId: 'term-1',
              initialCwd: '/tmp/project',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: options?.paneTitles ? { 'tab-1': options.paneTitles } : {},
        paneTitleSources: options?.paneTitleSources ? { 'tab-1': options.paneTitleSources } : {},
        paneTitleSetByUser: {},
      },
      paneRuntimeTitle: {
        titlesByPaneId: {},
      },
    },
  })
}

function getDisplayTitle(store: ReturnType<typeof createStore>): string {
  const state = store.getState()
  return getTabDisplayTitle(
    state.tabs.tabs[0],
    state.panes.layouts['tab-1'],
    state.panes.paneTitles['tab-1'],
    state.panes.paneTitleSources?.['tab-1'],
    state.paneRuntimeTitle.titlesByPaneId,
  )
}

describe('TerminalView exit title behavior', () => {
  function applyExitTitle(
    store: ReturnType<typeof createStore>,
    exitCode: number,
  ) {
    const state = store.getState()
    const tab = state.tabs.tabs[0]
    const paneId = state.panes.layouts['tab-1']?.type === 'leaf'
      ? state.panes.layouts['tab-1'].id
      : undefined
    const resolvedTitleSource = tab.titleSource ?? resolveEffectiveLegacyTabTitleSource({
      storedTitle: tab.title,
      titleSetByUser: tab.titleSetByUser,
      layout: state.panes.layouts['tab-1'],
      paneTitle: paneId ? state.panes.paneTitles['tab-1']?.[paneId] : undefined,
      paneTitleSource: paneId ? state.panes.paneTitleSources?.['tab-1']?.[paneId] : undefined,
    })
    const updates: { status: 'exited'; title?: string; source?: DurableTitleSource } = { status: 'exited' }
    if (shouldDecorateExitTitle(resolvedTitleSource)) {
      const exitBaseTitle = getTabDurableDisplayTitle(
        tab,
        state.panes.layouts['tab-1'],
        state.panes.paneTitles['tab-1'],
        state.panes.paneTitleSources?.['tab-1'],
      )
      updates.title = `${exitBaseTitle} (exit ${exitCode})`
      updates.source = 'derived'
    }
    store.dispatch(updateTab({ id: tab.id, updates }))
  }

  it('appends exit code when the durable title is still derived', () => {
    const store = createStore({ title: 'project', titleSource: 'derived' })

    applyExitTitle(store, 0)

    expect(store.getState().tabs.tabs[0]).toMatchObject({
      title: 'project (exit 0)',
      status: 'exited',
    })
    expect(getDisplayTitle(store)).toBe('project (exit 0)')
  })

  it('decorates the resolved derived display title instead of the stored fallback tab title', () => {
    const store = createStore({
      title: 'Tab 1',
      titleSource: 'derived',
    })

    expect(getDisplayTitle(store)).toBe('project')

    applyExitTitle(store, 1)

    expect(store.getState().tabs.tabs[0]).toMatchObject({
      title: 'project (exit 1)',
      status: 'exited',
    })
    expect(getDisplayTitle(store)).toBe('project (exit 1)')
  })

  it('stamps decorated legacy titles as derived so runtime precedence survives migration paths', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: 'tab-1',
            mode: 'shell' as const,
            status: 'running' as const,
            title: 'Tab 1',
            titleSetByUser: false,
            createRequestId: 'req-1',
            createdAt: 1,
          }],
          activeTabId: 'tab-1',
        },
        panes: {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'shell',
                shell: 'system',
                terminalId: 'term-1',
                initialCwd: '/tmp/project',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
          paneTitleSources: {},
          paneTitleSetByUser: {},
        },
        paneRuntimeTitle: {
          titlesByPaneId: {},
        },
      },
    })

    expect(getDisplayTitle(store as ReturnType<typeof createStore>)).toBe('project')

    applyExitTitle(store as ReturnType<typeof createStore>, 1)

    expect(store.getState().tabs.tabs[0]).toMatchObject({
      title: 'project (exit 1)',
      titleSource: 'derived',
      status: 'exited',
    })
  })

  it('keeps a stable durable title plain on exit', () => {
    const store = createStore({ title: 'codex resume 019d', titleSource: 'stable' })

    applyExitTitle(store, 1)

    expect(store.getState().tabs.tabs[0]).toMatchObject({
      title: 'codex resume 019d',
      status: 'exited',
    })
  })

  it('keeps a user title plain on exit', () => {
    const store = createStore({ title: 'Ops desk', titleSource: 'user' })

    applyExitTitle(store, 1)

    expect(store.getState().tabs.tabs[0]).toMatchObject({
      title: 'Ops desk',
      status: 'exited',
    })
  })
})

describe('TerminalView runtime title handling', () => {
  it('normalizes spinner-prefixed runtime titles', () => {
    expect(normalizeRuntimeTitle('⠋ codex')).toBe('codex')
    expect(normalizeRuntimeTitle('  vim README.md  ')).toBe('vim README.md')
    expect(normalizeRuntimeTitle('***')).toBe(null)
  })

  it('routes raw runtime titles into the runtime slice only', async () => {
    const store = createStore()

    await store.dispatch(setPaneRuntimeTitleByTerminalId({
      terminalId: 'term-1',
      title: '⠋ vim README.md',
    }) as any)

    expect(store.getState().tabs.tabs[0]).toMatchObject({
      title: 'Terminal',
      titleSource: 'derived',
    })
    expect(store.getState().panes.paneTitles['tab-1']).toBeUndefined()
    expect(store.getState().paneRuntimeTitle.titlesByPaneId['pane-1']).toBe('vim README.md')
    expect(getDisplayTitle(store)).toBe('vim README.md')
  })

  it('keeps a stable durable title ahead of later runtime titles', async () => {
    const store = createStore()
    const durableTitle = 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346'

    await store.dispatch(setPaneRuntimeTitleByTerminalId({
      terminalId: 'term-1',
      title: 'vim README.md',
    }) as any)
    await store.dispatch(syncStableTitleByTerminalId({
      terminalId: 'term-1',
      title: durableTitle,
    }) as any)

    expect(store.getState().tabs.tabs[0]).toMatchObject({
      title: durableTitle,
      titleSource: 'stable',
    })
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-1']).toBe(durableTitle)
    expect(store.getState().panes.paneTitleSources?.['tab-1']?.['pane-1']).toBe('stable')
    expect(store.getState().paneRuntimeTitle.titlesByPaneId['pane-1']).toBeUndefined()

    await store.dispatch(setPaneRuntimeTitleByTerminalId({
      terminalId: 'term-1',
      title: 'codex',
    }) as any)

    expect(getDisplayTitle(store)).toBe(durableTitle)
  })

  it('promotes layoutless mirrored tabs by terminalId when a stable rename arrives', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: 'tab-1',
            mode: 'codex' as const,
            status: 'running' as const,
            title: 'Codex CLI',
            titleSource: 'derived' as const,
            terminalId: 'term-1',
            createRequestId: 'req-1',
            createdAt: 1,
          }],
          activeTabId: 'tab-1',
        },
        panes: {
          layouts: {},
          activePane: {},
          paneTitles: {},
          paneTitleSources: {},
          paneTitleSetByUser: {},
        },
        paneRuntimeTitle: {
          titlesByPaneId: {},
        },
      },
    })

    await store.dispatch(syncStableTitleByTerminalId({
      terminalId: 'term-1',
      title: 'Renamed Session',
    }) as any)

    expect(store.getState().tabs.tabs[0]).toMatchObject({
      title: 'Renamed Session',
      titleSource: 'stable',
      terminalId: 'term-1',
    })
  })
})
