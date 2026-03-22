import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { updateTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import paneRuntimeTitleReducer, { setPaneRuntimeTitleByTerminalId } from '@/store/paneRuntimeTitleSlice'
import { syncStableTitleByTerminalId } from '@/store/titleSync'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { normalizeRuntimeTitle, shouldDecorateExitTitle, type DurableTitleSource } from '@/lib/title-source'

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
    const tab = store.getState().tabs.tabs[0]
    const updates: { status: 'exited'; title?: string } = { status: 'exited' }
    if (shouldDecorateExitTitle(tab.titleSource)) {
      updates.title = `${tab.title} (exit ${exitCode})`
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
})
