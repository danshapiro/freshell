import { beforeEach, describe, expect, it, vi } from 'vitest'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

async function importFreshWorkspacePersistence() {
  vi.resetModules()
  return await import('@/store/workspacePersistence')
}

function buildWorkspaceRaw(input: {
  tabs: {
    activeTabId: string | null
    tabs: Array<Record<string, unknown>>
  }
  panes: {
    layouts: Record<string, unknown>
    activePane: Record<string, string>
    paneTitles?: Record<string, Record<string, string>>
    paneTitleSetByUser?: Record<string, Record<string, boolean>>
  }
}) {
  return JSON.stringify({
    version: 1,
    tabs: input.tabs,
    panes: {
      paneTitles: {},
      paneTitleSetByUser: {},
      ...input.panes,
    },
  })
}

describe('workspacePersistence', () => {
  beforeEach(() => {
    localStorageMock.clear()
  })

  it('prefers the authoritative workspace snapshot over split-key mirrors', async () => {
    const {
      WORKSPACE_STORAGE_KEY,
      loadPersistedWorkspaceSnapshot,
      loadPersistedTabs,
      loadPersistedPanes,
      resetLoadedWorkspaceSnapshotCacheForTests,
    } = await importFreshWorkspacePersistence()

    localStorage.setItem(WORKSPACE_STORAGE_KEY, buildWorkspaceRaw({
      tabs: {
        activeTabId: 'tab-combined',
        tabs: [{
          id: 'tab-combined',
          title: 'Combined Workspace',
          createRequestId: 'req-combined',
          status: 'creating',
          mode: 'shell',
          shell: 'system',
          createdAt: 1,
        }],
      },
      panes: {
        layouts: {
          'tab-combined': {
            type: 'leaf',
            id: 'pane-combined',
            content: {
              kind: 'terminal',
              createRequestId: 'req-combined',
              status: 'creating',
              mode: 'shell',
              shell: 'system',
            },
          },
        },
        activePane: {
          'tab-combined': 'pane-combined',
        },
      },
    }))

    localStorage.setItem('freshell.tabs.v2', JSON.stringify({
      tabs: {
        activeTabId: 'tab-split',
        tabs: [{
          id: 'tab-split',
          title: 'Split Workspace',
          createRequestId: 'req-split',
          status: 'creating',
          mode: 'shell',
          shell: 'system',
          createdAt: 2,
        }],
      },
    }))
    localStorage.setItem('freshell.panes.v2', JSON.stringify({
      version: 6,
      layouts: {
        'tab-split': {
          type: 'leaf',
          id: 'pane-split',
          content: {
            kind: 'terminal',
            createRequestId: 'req-split',
            status: 'creating',
            mode: 'shell',
            shell: 'system',
          },
        },
      },
      activePane: {
        'tab-split': 'pane-split',
      },
      paneTitles: {},
      paneTitleSetByUser: {},
    }))

    resetLoadedWorkspaceSnapshotCacheForTests()

    const snapshot = loadPersistedWorkspaceSnapshot()
    expect(snapshot).not.toBeNull()
    expect(snapshot?.source).toBe('workspace')
    expect(snapshot?.tabs.tabs[0]?.id).toBe('tab-combined')
    expect(snapshot?.validation).toEqual({ ok: true })

    expect(loadPersistedTabs()).toEqual({
      tabs: snapshot?.tabs,
    })
    expect(loadPersistedPanes()).toEqual({
      ...snapshot?.panes,
      version: 6,
    })
  })

  it('falls back to split keys only when the authoritative workspace key is absent', async () => {
    const {
      loadPersistedWorkspaceSnapshot,
      resetLoadedWorkspaceSnapshotCacheForTests,
    } = await importFreshWorkspacePersistence()

    localStorage.setItem('freshell.tabs.v2', JSON.stringify({
      tabs: {
        activeTabId: 'tab-broken',
        tabs: [{
          id: 'tab-broken',
          title: 'Broken Legacy Tab',
          createRequestId: 'req-broken',
          status: 'creating',
          mode: 'codex',
          shell: 'system',
          resumeSessionId: 'legacy-session',
          createdAt: 3,
        }],
      },
    }))
    localStorage.setItem('freshell.panes.v2', JSON.stringify({
      version: 6,
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
    }))

    resetLoadedWorkspaceSnapshotCacheForTests()

    const snapshot = loadPersistedWorkspaceSnapshot()
    expect(snapshot).not.toBeNull()
    expect(snapshot?.source).toBe('legacy-split')
    expect(snapshot?.tabs.tabs[0]?.id).toBe('tab-broken')
    expect(snapshot?.panes.layouts['tab-broken']).toBeUndefined()
    expect(snapshot?.validation).toEqual({
      ok: false,
      missingLayoutTabIds: ['tab-broken'],
    })
  })

  it('drops malformed authoritative pane layouts so the snapshot fails closed as missing-layout corruption', async () => {
    const {
      WORKSPACE_STORAGE_KEY,
      loadPersistedWorkspaceSnapshot,
      resetLoadedWorkspaceSnapshotCacheForTests,
    } = await importFreshWorkspacePersistence()

    localStorage.setItem(WORKSPACE_STORAGE_KEY, buildWorkspaceRaw({
      tabs: {
        activeTabId: 'tab-malformed',
        tabs: [{
          id: 'tab-malformed',
          title: 'Malformed Workspace',
          createRequestId: 'req-malformed',
          status: 'creating',
          mode: 'shell',
          shell: 'system',
          createdAt: 1,
        }],
      },
      panes: {
        layouts: {
          'tab-malformed': {},
        },
        activePane: {
          'tab-malformed': 'pane-malformed',
        },
      },
    }))

    resetLoadedWorkspaceSnapshotCacheForTests()

    const snapshot = loadPersistedWorkspaceSnapshot()
    expect(snapshot).not.toBeNull()
    expect(snapshot?.source).toBe('workspace')
    expect(snapshot?.panes.layouts['tab-malformed']).toBeUndefined()
    expect(snapshot?.panes.activePane['tab-malformed']).toBeUndefined()
    expect(snapshot?.validation).toEqual({
      ok: false,
      missingLayoutTabIds: ['tab-malformed'],
    })
  })

  it('serializes a validated workspace snapshot and compatibility mirrors from one source', async () => {
    const {
      parsePersistedWorkspaceRaw,
      serializeWorkspaceSnapshot,
    } = await importFreshWorkspacePersistence()

    const result = serializeWorkspaceSnapshot({
      tabs: {
        tabs: [{
          id: 'tab-1',
          title: 'Persist Me',
          createRequestId: 'req-1',
          status: 'running',
          mode: 'shell',
          shell: 'system',
          createdAt: 1,
          lastInputAt: 999,
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: 'rename-me',
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'editor',
              filePath: '/tmp/demo.md',
              language: 'markdown',
              readOnly: false,
              content: 'do not persist editor buffer',
              viewMode: 'source',
            },
          },
        },
        activePane: {
          'tab-1': 'pane-1',
        },
        paneTitles: {
          'tab-1': {
            'pane-1': 'Persist Me',
          },
        },
        paneTitleSetByUser: {},
        renameRequestTabId: 'rename-tab',
        renameRequestPaneId: 'rename-pane',
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    } as any)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const parsedWorkspace = parsePersistedWorkspaceRaw(result.workspaceRaw)
    expect(parsedWorkspace?.tabs.tabs[0]?.lastInputAt).toBeUndefined()
    expect(parsedWorkspace?.panes.layouts['tab-1']).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'editor',
        content: '',
      },
    })

    const parsedTabsMirror = JSON.parse(result.tabsRaw)
    expect(parsedTabsMirror.tabs.tabs[0].lastInputAt).toBeUndefined()
    const parsedPanesMirror = JSON.parse(result.panesRaw)
    expect(parsedPanesMirror.layouts['tab-1'].content.content).toBe('')
  })

  it('refuses to serialize an invalid workspace snapshot', async () => {
    const { serializeWorkspaceSnapshot } = await importFreshWorkspacePersistence()

    const result = serializeWorkspaceSnapshot({
      tabs: {
        tabs: [{
          id: 'tab-corrupt',
          title: 'Corrupt Tab',
          createRequestId: 'req-corrupt',
          status: 'creating',
          mode: 'shell',
          shell: 'system',
          createdAt: 1,
        }],
        activeTabId: 'tab-corrupt',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    } as any)

    expect(result).toEqual({
      ok: false,
      missingLayoutTabIds: ['tab-corrupt'],
    })
  })
})
