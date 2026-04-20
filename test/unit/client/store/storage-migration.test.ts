import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePersistedLayoutRaw } from '@/store/persistedState'
import { BROWSER_PREFERENCES_STORAGE_KEY, PANES_STORAGE_KEY, TABS_STORAGE_KEY } from '@/store/storage-keys'

const AUTH_STORAGE_KEY = 'freshell.auth-token'
const LAYOUT_STORAGE_KEY = 'freshell.layout.v3'
const VALID_CLAUDE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

async function importFreshStorageMigration(): Promise<Record<string, unknown>> {
  vi.resetModules()
  return await import('@/store/storage-migration') as Record<string, unknown>
}

function snapshotLocalStorage(): Record<string, string | null> {
  return Object.fromEntries(
    Object.keys(localStorage)
      .sort()
      .map((key) => [key, localStorage.getItem(key)])
  )
}

describe('storage-migration', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    document.cookie = 'freshell-auth=; Max-Age=0; path=/'
  })

  afterEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    document.cookie = 'freshell-auth=; Max-Age=0; path=/'
  })

  it('clears legacy freshell v1 keys while preserving auth token on version bump', async () => {
    localStorage.setItem('freshell_version', '2')
    localStorage.setItem(AUTH_STORAGE_KEY, 'token-123')
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        theme: 'dark',
      },
    }))
    localStorage.setItem('freshell.tabs.v1', 'legacy-tabs')
    localStorage.setItem('freshell.panes.v1', 'legacy-panes')

    await importFreshStorageMigration()

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe('token-123')
    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBe(JSON.stringify({
      settings: {
        theme: 'dark',
      },
    }))
    expect(localStorage.getItem('freshell.tabs.v1')).toBeNull()
    expect(localStorage.getItem('freshell.panes.v1')).toBeNull()
    expect(localStorage.getItem('freshell_version')).toBe('4')
  })

  it('clears stale freshell-auth cookie when no auth token remains', async () => {
    localStorage.setItem('freshell_version', '2')
    localStorage.setItem('freshell.tabs.v1', 'legacy-tabs')
    document.cookie = 'freshell-auth=stale-token; path=/'

    await importFreshStorageMigration()

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(document.cookie).not.toContain('freshell-auth=')
  })

  it('preserves legacy terminal font migration when storage cleanup runs before browser preferences load', async () => {
    localStorage.setItem('freshell_version', '2')
    localStorage.setItem('freshell.terminal.fontFamily.v1', 'Fira Code')
    localStorage.setItem('freshell.tabs.v1', 'legacy-tabs')

    await importFreshStorageMigration()

    const browserPreferences = await import('@/lib/browser-preferences')

    expect(browserPreferences.loadBrowserPreferencesRecord()).toEqual({
      settings: {
        terminal: {
          fontFamily: 'Fira Code',
        },
      },
    })
    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBe(JSON.stringify({
      settings: {
        terminal: {
          fontFamily: 'Fira Code',
        },
      },
    }))
    expect(localStorage.getItem('freshell.terminal.fontFamily.v1')).toBeNull()
    expect(localStorage.getItem('freshell.tabs.v1')).toBeNull()
    expect(localStorage.getItem('freshell_version')).toBe('4')
  })

  it('preserves restorable layouts and migrates ambiguous resume ids instead of clearing state', async () => {
    localStorage.setItem('freshell_version', '3')
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 3,
      tabs: {
        activeTabId: 'tab-claude',
        tabs: [
          {
            id: 'tab-claude',
            title: 'Claude terminal',
            createdAt: 1,
            mode: 'claude',
            resumeSessionId: VALID_CLAUDE_SESSION_ID,
          },
          {
            id: 'tab-codex',
            title: 'Codex terminal',
            createdAt: 2,
            mode: 'codex',
            resumeSessionId: 'thread-new-1',
          },
        ],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-claude': {
            type: 'leaf',
            id: 'pane-claude',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-claude',
              status: 'running',
              resumeSessionId: VALID_CLAUDE_SESSION_ID,
            },
          },
          'tab-codex': {
            type: 'leaf',
            id: 'pane-codex',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-codex',
              status: 'running',
              resumeSessionId: 'thread-new-1',
            },
          },
        },
        activePane: {
          'tab-claude': 'pane-claude',
          'tab-codex': 'pane-codex',
        },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    await importFreshStorageMigration()

    const migratedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(migratedRaw).not.toBeNull()
    expect(localStorage.getItem('freshell_version')).toBe('4')

    const parsed = parsePersistedLayoutRaw(migratedRaw!)
    expect(parsed).not.toBeNull()
    expect((parsed!.tabs.tabs[0] as any).resumeSessionId).toBeUndefined()
    expect((parsed!.tabs.tabs[0] as any).sessionRef).toEqual({
      provider: 'claude',
      sessionId: VALID_CLAUDE_SESSION_ID,
    })

    const codexPane = (((parsed!.panes.layouts['tab-codex'] as any)?.content) ?? {}) as Record<string, unknown>
    expect(codexPane.resumeSessionId).toBeUndefined()
    expect(codexPane.sessionRef).toBeUndefined()
    expect(codexPane.restoreError).toEqual({
      code: 'RESTORE_UNAVAILABLE',
      reason: 'invalid_legacy_restore_target',
    })
  })

  it('migrates recoverable v2 tabs and panes into the v3 layout key before clearing legacy storage', async () => {
    localStorage.setItem('freshell_version', '3')
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({
      version: 2,
      tabs: {
        activeTabId: 'tab-v2',
        tabs: [
          {
            id: 'tab-v2',
            title: 'Recovered Claude',
            createdAt: 1,
            mode: 'claude',
            resumeSessionId: VALID_CLAUDE_SESSION_ID,
          },
        ],
      },
      tombstones: [],
    }))
    localStorage.setItem(PANES_STORAGE_KEY, JSON.stringify({
      version: 6,
      layouts: {
        'tab-v2': {
          type: 'leaf',
          id: 'pane-v2',
          content: {
            kind: 'terminal',
            mode: 'claude',
            createRequestId: 'req-v2',
            status: 'running',
            resumeSessionId: VALID_CLAUDE_SESSION_ID,
          },
        },
      },
      activePane: {
        'tab-v2': 'pane-v2',
      },
      paneTitles: {},
      paneTitleSetByUser: {},
    }))

    await importFreshStorageMigration()

    expect(localStorage.getItem(TABS_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(PANES_STORAGE_KEY)).toBeNull()

    const migratedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(migratedRaw).not.toBeNull()

    const parsed = parsePersistedLayoutRaw(migratedRaw!)
    expect(parsed).not.toBeNull()
    expect(parsed?.tabs.activeTabId).toBe('tab-v2')
    expect(parsed?.tabs.tabs[0]).toEqual(expect.objectContaining({
      id: 'tab-v2',
      sessionRef: {
        provider: 'claude',
        sessionId: VALID_CLAUDE_SESSION_ID,
      },
    }))
    expect(((parsed?.panes.layouts['tab-v2'] as any)?.content) ?? {}).toEqual(expect.objectContaining({
      kind: 'terminal',
      sessionRef: {
        provider: 'claude',
        sessionId: VALID_CLAUDE_SESSION_ID,
      },
    }))
  })

  it('keeps migration bootstrap order deterministic in static imports', async () => {
    const mainSource = (await import('@/main.tsx?raw')).default as string
    const storeSource = (await import('@/store/store.ts?raw')).default as string

    const migrationImportIndex = mainSource.indexOf("import '@/store/storage-migration'")
    const storeImportIndex = mainSource.indexOf("import { store } from '@/store/store'")

    expect(migrationImportIndex).toBeGreaterThanOrEqual(0)
    expect(storeImportIndex).toBeGreaterThanOrEqual(0)
    expect(migrationImportIndex).toBeLessThan(storeImportIndex)
    expect(storeSource).not.toContain("import './storage-migration'")
  })

  it('is idempotent when run a second time', async () => {
    localStorage.setItem('freshell_version', '2')
    localStorage.setItem(AUTH_STORAGE_KEY, 'token-123')
    localStorage.setItem('freshell.tabs.v1', 'legacy-tabs')

    const module = await importFreshStorageMigration()

    expect(typeof module.runStorageMigration).toBe('function')
    const first = snapshotLocalStorage()
    ;(module.runStorageMigration as () => void)()
    const second = snapshotLocalStorage()

    expect(second).toEqual(first)
  })
})
