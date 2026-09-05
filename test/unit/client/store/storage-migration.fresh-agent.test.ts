import { beforeEach, describe, expect, it, vi } from 'vitest'

const LAYOUT_KEY = 'freshell.layout.v3'
const BACKUP_KEY = 'freshell.layout.v3.backup-before-fresh-agent-centralization'
const MARKER_KEY = 'freshell.layout.v3.fresh-agent-centralization-commit'
const PENDING_KEY = 'freshell.layout.v3.fresh-agent-centralization-pending'
const VERSION_KEY = 'freshell_version'

type StorageHooks = {
  onSetItem?: (key: string, value: string, storage: TestStorage) => void
  failSetItem?: (key: string, value: string) => boolean
}

type TestStorage = Storage & {
  seed: (key: string, value: string) => void
  dump: () => Record<string, string>
}

function createStorage(hooks: StorageHooks = {}): TestStorage {
  let store: Record<string, string> = {}
  const storage: Partial<TestStorage> = {
    get length() {
      return Object.keys(store).length
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null
    },
    getItem(key: string) {
      return store[key] ?? null
    },
    setItem(key: string, value: string) {
      if (hooks.failSetItem?.(key, value)) {
        throw new Error(`injected write failure for ${key}`)
      }
      storage.seed!(key, String(value))
      hooks.onSetItem?.(key, String(value), storage as TestStorage)
    },
    removeItem(key: string) {
      delete store[key]
      delete (storage as Record<string, unknown>)[key]
    },
    clear() {
      for (const key of Object.keys(store)) {
        delete (storage as Record<string, unknown>)[key]
      }
      store = {}
    },
    seed(key: string, value: string) {
      store[key] = String(value)
      Object.defineProperty(storage, key, {
        value: String(value),
        configurable: true,
        enumerable: true,
      })
    },
    dump() {
      return { ...store }
    },
  }
  return storage as TestStorage
}

function makeLayoutWithContent(content: Record<string, unknown>) {
  return {
    version: 3,
    tabs: { tabs: [{ id: 'tab-1', title: 'Tab 1' }], activeTabId: 'tab-1' },
    panes: {
      version: 6,
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content,
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
      paneTitleSetByUser: {},
    },
    tombstones: [],
  }
}

function makeLegacyLayoutRaw(content: Record<string, unknown> = {
  kind: 'agent-chat',
  provider: 'freshclaude',
  createRequestId: 'req-1',
  status: 'idle',
  resumeSessionId: '00000000-0000-4000-8000-000000000001',
}) {
  return JSON.stringify(makeLayoutWithContent(content))
}

function buildSplitLeaves(leaves: Array<{ type: 'leaf'; id: string; content: Record<string, unknown> }>): any {
  if (leaves.length === 1) return leaves[0]
  const mid = Math.floor(leaves.length / 2)
  return {
    type: 'split',
    id: `split-${leaves[0].id}-${leaves[leaves.length - 1].id}`,
    direction: leaves.length % 2 === 0 ? 'horizontal' : 'vertical',
    sizes: [50, 50],
    children: [
      buildSplitLeaves(leaves.slice(0, mid)),
      buildSplitLeaves(leaves.slice(mid)),
    ],
  }
}

function makeLargeLegacyLayoutRaw(): string {
  const tabs = Array.from({ length: 100 }, (_, tabIndex) => ({
    id: `tab-${tabIndex}`,
    title: `Tab ${tabIndex}`,
  }))
  const layouts = Object.fromEntries(tabs.map((tab, tabIndex) => {
    const leaves = Array.from({ length: 10 }, (_, leafIndex) => ({
      type: 'leaf' as const,
      id: `pane-${tabIndex}-${leafIndex}`,
      content: {
        kind: 'agent-chat',
        provider: leafIndex % 2 === 0 ? 'freshclaude' : 'kilroy',
        createRequestId: `req-${tabIndex}-${leafIndex}`,
        status: 'idle',
        resumeSessionId: `00000000-0000-4000-8000-${String(tabIndex * 10 + leafIndex).padStart(12, '0')}`,
      },
    }))
    return [tab.id, buildSplitLeaves(leaves)]
  }))
  return JSON.stringify({
    version: 3,
    tabs: { tabs, activeTabId: 'tab-0' },
    panes: {
      version: 6,
      layouts,
      activePane: Object.fromEntries(tabs.map((tab) => [tab.id, `pane-${tab.id.slice(4)}-0`])),
      paneTitles: {},
      paneTitleSetByUser: {},
    },
    tombstones: [],
  })
}

describe('storage-migration fresh-agent', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('does not clear freshell layout storage during the fresh-agent migration', async () => {
    const storage = createStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
    storage.seed(LAYOUT_KEY, makeLegacyLayoutRaw())

    await import('@/store/storage-migration')

    const raw = localStorage.getItem(LAYOUT_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.panes.layouts['tab-1'].content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
    expect(localStorage.getItem(BACKUP_KEY)).toBe(makeLegacyLayoutRaw())
    expect(localStorage.getItem(MARKER_KEY)).toContain('fresh-agent-centralization')
  })

  it('migrates existing version-5 layout storage once using the fresh-agent marker', async () => {
    const originalRaw = makeLegacyLayoutRaw()
    const storage = createStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
    storage.seed(VERSION_KEY, '5')
    storage.seed(LAYOUT_KEY, originalRaw)

    const module = await import('@/store/storage-migration')

    const raw = localStorage.getItem(LAYOUT_KEY)
    expect(raw).not.toBeNull()
    expect(raw).not.toContain('"agent-chat"')
    expect(raw).toContain('"fresh-agent"')
    expect(localStorage.getItem(BACKUP_KEY)).toBe(originalRaw)
    expect(localStorage.getItem(MARKER_KEY)).toContain('fresh-agent-centralization')
    expect(localStorage.getItem(VERSION_KEY)).toBe('5')

    const firstDump = storage.dump()
    module.runStorageMigration()
    expect(storage.dump()).toEqual(firstDump)
  })

  it('does not restore durable identity over an invalid legacy restore error', async () => {
    const canonical = '00000000-0000-4000-8000-000000000777'
    const originalRaw = makeLegacyLayoutRaw({
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-alias-with-resume',
      status: 'idle',
      sessionRef: { provider: 'claude', sessionId: 'named-alias' },
      resumeSessionId: canonical,
    })
    const storage = createStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
    storage.seed(VERSION_KEY, '5')
    storage.seed(LAYOUT_KEY, originalRaw)

    await import('@/store/storage-migration')

    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY)!)
    const content = parsed.panes.layouts['tab-1'].content
    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
    expect(content.sessionRef).toBeUndefined()
    expect(content.resumeSessionId).toBeUndefined()
  })

  it('turns existing fresh-agent panes with invalid Claude sessionRef into restore errors', async () => {
    const originalRaw = makeLegacyLayoutRaw({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-fresh-alias',
      status: 'idle',
      sessionRef: { provider: 'claude', sessionId: 'named-alias' },
      resumeSessionId: '00000000-0000-4000-8000-000000000779',
      showTimecodes: true,
    })
    const storage = createStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
    storage.seed(VERSION_KEY, '5')
    storage.seed(LAYOUT_KEY, originalRaw)

    await import('@/store/storage-migration')

    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY)!)
    const content = parsed.panes.layouts['tab-1'].content
    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
      showTimecodes: true,
    })
    expect(content.sessionRef).toBeUndefined()
    expect(content.resumeSessionId).toBeUndefined()
  })

  it('aborts before touching the original layout when the backup write fails', async () => {
    const originalRaw = makeLegacyLayoutRaw()
    const storage = createStorage({
      failSetItem: (key) => key === BACKUP_KEY,
    })
    Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
    storage.seed(LAYOUT_KEY, originalRaw)

    await import('@/store/storage-migration')

    expect(localStorage.getItem(LAYOUT_KEY)).toBe(originalRaw)
    expect(localStorage.getItem(BACKUP_KEY)).toBeNull()
    expect(localStorage.getItem(MARKER_KEY)).toBeNull()
    expect(localStorage.getItem(VERSION_KEY)).toBeNull()
  })

  it('leaves the original layout untouched when the migrated layout write fails', async () => {
    const originalRaw = makeLegacyLayoutRaw()
    const storage = createStorage({
      failSetItem: (key) => key === LAYOUT_KEY,
    })
    Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
    storage.seed(LAYOUT_KEY, originalRaw)

    await import('@/store/storage-migration')

    expect(localStorage.getItem(LAYOUT_KEY)).toBe(originalRaw)
    expect(localStorage.getItem(BACKUP_KEY)).toBe(originalRaw)
    expect(localStorage.getItem(MARKER_KEY)).toBeNull()
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
    expect(localStorage.getItem(VERSION_KEY)).toBeNull()
  })

  it('does not overwrite a concurrent layout write between backup and migrated layout commit', async () => {
    const originalRaw = makeLegacyLayoutRaw()
    const concurrentRaw = JSON.stringify(makeLayoutWithContent({
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'other-req',
      status: 'running',
    }))
    const storage = createStorage({
      onSetItem: (key, _value, currentStorage) => {
        if (key === BACKUP_KEY) {
          currentStorage.seed(LAYOUT_KEY, concurrentRaw)
        }
      },
    })
    Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
    storage.seed(LAYOUT_KEY, originalRaw)

    await import('@/store/storage-migration')
    const { readRecoverablePersistedLayoutRaw } = await import('@/store/persistedState')

    expect(localStorage.getItem(LAYOUT_KEY)).toBe(concurrentRaw)
    expect(localStorage.getItem(BACKUP_KEY)).toBeNull()
    expect(localStorage.getItem(MARKER_KEY)).toBeNull()
    expect(localStorage.getItem(VERSION_KEY)).toBeNull()
    expect(readRecoverablePersistedLayoutRaw(localStorage)).toBe(concurrentRaw)
  })

  it('keeps a valid post-layout interleaving write when the commit marker is missing', async () => {
    const originalRaw = makeLegacyLayoutRaw()
    const concurrentRaw = JSON.stringify(makeLayoutWithContent({
      kind: 'terminal',
      mode: 'codex',
      createRequestId: 'post-layout-req',
      status: 'running',
    }))
    const storage = createStorage({
      failSetItem: (key) => key === MARKER_KEY,
      onSetItem: (key, value, currentStorage) => {
        if (key === LAYOUT_KEY && value.includes('"fresh-agent"')) {
          currentStorage.seed(LAYOUT_KEY, concurrentRaw)
        }
      },
    })
    Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
    storage.seed(LAYOUT_KEY, originalRaw)

    await import('@/store/storage-migration')
    const { readRecoverablePersistedLayoutRaw } = await import('@/store/persistedState')

    expect(localStorage.getItem(LAYOUT_KEY)).toBe(concurrentRaw)
    expect(localStorage.getItem(BACKUP_KEY)).toBe(originalRaw)
    expect(localStorage.getItem(MARKER_KEY)).toBeNull()
    expect(localStorage.getItem(PENDING_KEY)).not.toBeNull()
    expect(localStorage.getItem(VERSION_KEY)).toBeNull()
    expect(readRecoverablePersistedLayoutRaw(localStorage)).toBe(concurrentRaw)
  })

  it('migrates a synthetic 100-tab 1000-leaf layout within the performance budget', async () => {
    const storage = createStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
    storage.seed(VERSION_KEY, '5')
    const module = await import('@/store/storage-migration')
    storage.removeItem(VERSION_KEY)
    storage.seed(LAYOUT_KEY, makeLargeLegacyLayoutRaw())

    // This migration is synchronous and the test storage is in memory. Charge
    // its own worker's CPU work, not time descheduled behind parallel tests.
    // Node <22.19 lacks threadCpuUsage; retain the original wall-clock budget
    // there rather than counting other Vitest workers with process.cpuUsage.
    const startedCpu = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : undefined
    const startedAt = performance.now()
    module.runStorageMigration()
    const elapsedMs = performance.now() - startedAt
    const cpu = startedCpu ? process.threadCpuUsage(startedCpu) : undefined
    const workMs = cpu ? (cpu.user + cpu.system) / 1_000 : elapsedMs

    expect(workMs, `migration work: ${workMs} ms; elapsed: ${elapsedMs} ms`).toBeLessThan(500)
    const migrated = JSON.parse(localStorage.getItem(LAYOUT_KEY)!)
    expect(migrated.tabs.tabs).toHaveLength(100)
    const leavesOf = (node: any): any[] => node.type === 'leaf'
      ? [node]
      : node.children.flatMap(leavesOf)
    const leaves = Object.values(migrated.panes.layouts).flatMap(leavesOf)
    expect(leaves).toHaveLength(1_000)
    for (let tabIndex = 0; tabIndex < 100; tabIndex++) {
      const tabLeaves = leavesOf(migrated.panes.layouts[`tab-${tabIndex}`])
      expect(tabLeaves).toHaveLength(10)
      for (let leafIndex = 0; leafIndex < 10; leafIndex++) {
        expect(tabLeaves[leafIndex]).toMatchObject({
          id: `pane-${tabIndex}-${leafIndex}`,
          content: {
            kind: 'fresh-agent',
            provider: 'claude',
            sessionType: leafIndex % 2 === 0 ? 'freshclaude' : 'kilroy',
            createRequestId: `req-${tabIndex}-${leafIndex}`,
            sessionRef: {
              provider: 'claude',
              sessionId: `00000000-0000-4000-8000-${String(tabIndex * 10 + leafIndex).padStart(12, '0')}`,
            },
          },
        })
      }
    }
  })
})
