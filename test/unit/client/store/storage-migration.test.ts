import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_PREFERENCES_STORAGE_KEY } from '@/store/storage-keys'

const AUTH_STORAGE_KEY = 'freshell.auth-token'

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
    expect(localStorage.getItem('freshell_version')).toBe('3')
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
    expect(localStorage.getItem('freshell_version')).toBe('3')
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
