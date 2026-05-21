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

describe('storage-migration fresh-agent', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorageMock.clear()
    Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
  })

  it('does not clear freshell layout storage during the fresh-agent migration', async () => {
    localStorage.setItem('freshell.layout.v3', JSON.stringify({
      version: 3,
      tabs: { tabs: [], activeTabId: null },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: { kind: 'agent-chat', provider: 'freshclaude', createRequestId: 'req-1', status: 'idle' },
          },
        },
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    const module = await import('@/store/storage-migration')
    module.runStorageMigration()

    const raw = localStorage.getItem('freshell.layout.v3')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.panes.layouts['tab-1'].content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
    })
  })
})
