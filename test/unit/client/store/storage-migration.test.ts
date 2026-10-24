import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePersistedLayoutRaw } from '@/store/persistedState'
import { BROWSER_PREFERENCES_STORAGE_KEY, PANES_STORAGE_KEY, TABS_STORAGE_KEY } from '@/store/storage-keys'

const AUTH_STORAGE_KEY = 'freshell.auth-token'
// Delta round 3, finding 1 / e3r1 findings 3+6: the migration operates on
// THIS window's per-window layout key (derived from the mint-once
// layout-window-id, sessionStorage freshell.layout-window-id.v1); the bare
// freshell.layout.v3 stays as the LEGACY adoption source (never deleted).
const WINDOW_ID = 'client-migration-tests'
const LAYOUT_STORAGE_KEY = `freshell.layout.v3.${WINDOW_ID}`
const OWN_SIDECAR_KEY = `freshell.layout.pre-migration-raw.v1.${WINDOW_ID}`
const LEGACY_SIDECAR_KEY = 'freshell.layout.pre-migration-raw.v1'
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
    sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)
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
    expect(localStorage.getItem('freshell_version')).toBe('5')
  })

  it('clears stale freshell-auth cookie when no auth token remains', async () => {
    localStorage.setItem('freshell_version', '2')
    localStorage.setItem('freshell.tabs.v1', 'legacy-tabs')
    document.cookie = 'freshell-auth=stale-token; path=/'

    await importFreshStorageMigration()

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(document.cookie).not.toContain('freshell-auth=')
  })

  it('spares the pre-migration raw evidence sidecar in the version-bump full wipe (e2r4 finding 1)', async () => {
    // The sidecar holds the OLDEST pre-rewrite raw the health classifier
    // needs after a reload (clearFreshellKeysExcept wipes every freshell.*
    // key on a version bump); it must sit on the wipe's keep list with the
    // auth token and browser preferences. Delta round 3: the keep-list
    // entry is the sidecar PREFIX — this window's per-window sidecar AND
    // the pre-change shared sidecar both survive.
    localStorage.setItem('freshell_version', '2')
    localStorage.setItem(AUTH_STORAGE_KEY, 'token-123')
    localStorage.setItem('freshell.tabs.v1', 'legacy-tabs')
    localStorage.setItem(OWN_SIDECAR_KEY, 'original-corrupt-raw')
    localStorage.setItem(LEGACY_SIDECAR_KEY, 'original-legacy-corrupt-raw')

    await importFreshStorageMigration()

    expect(localStorage.getItem(OWN_SIDECAR_KEY)).toBe('original-corrupt-raw')
    expect(localStorage.getItem(LEGACY_SIDECAR_KEY)).toBe('original-legacy-corrupt-raw')
    expect(localStorage.getItem('freshell.tabs.v1')).toBeNull()
    expect(localStorage.getItem('freshell_version')).toBe('5')
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
    expect(localStorage.getItem('freshell_version')).toBe('5')
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
    expect(localStorage.getItem('freshell_version')).toBe('5')

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

  it('preserves a validated Claude sessionRef alongside a recoverable restore error during boot migration', async () => {
    localStorage.setItem('freshell_version', '5')
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      persistedAt: Date.now(),
      version: 3,
      tabs: {
        activeTabId: 'tab-claude',
        tabs: [{ id: 'tab-claude', title: 'Claude', createdAt: 1, mode: 'freshclaude' }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-claude': {
            type: 'leaf',
            id: 'pane-claude',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-restore-error',
              status: 'idle',
              sessionId: VALID_CLAUDE_SESSION_ID,
              sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
              restoreError: {
                code: 'RESTORE_UNAVAILABLE',
                reason: 'durable_artifact_missing',
              },
            },
          },
        },
        activePane: { 'tab-claude': 'pane-claude' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    await importFreshStorageMigration()

    const migratedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(migratedRaw).not.toBeNull()
    const migrated = JSON.parse(migratedRaw!)
    const content = migrated.panes.layouts['tab-claude'].content
    expect(content.sessionRef).toEqual({
      provider: 'claude',
      sessionId: VALID_CLAUDE_SESSION_ID,
    })
    expect(content.restoreError).toEqual({
      code: 'RESTORE_UNAVAILABLE',
      reason: 'durable_artifact_missing',
    })
  })

  it('migrates durable legacy Codex recovery_failed panes to creating resume panes', async () => {
    localStorage.setItem('freshell_version', '3')
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 3,
      tabs: {
        activeTabId: 'tab-codex',
        tabs: [{
          id: 'tab-codex',
          title: 'Codex terminal',
          createdAt: 1,
          mode: 'codex',
          sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' },
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-codex': {
            type: 'leaf',
            id: 'pane-codex',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-old',
              terminalId: 'term-old',
              status: 'recovery_failed',
              sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' },
              restoreError: {
                code: 'RESTORE_UNAVAILABLE',
                reason: 'provider_runtime_failed',
              },
              initialCwd: '/repo',
            },
          },
        },
        activePane: { 'tab-codex': 'pane-codex' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    await importFreshStorageMigration()

    const migratedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(migratedRaw).not.toBeNull()
    const parsed = parsePersistedLayoutRaw(migratedRaw!)
    expect(parsed).not.toBeNull()
    const content = ((parsed!.panes.layouts['tab-codex'] as any)?.content) ?? {}
    expect(content).toMatchObject({
      kind: 'terminal',
      mode: 'codex',
      status: 'creating',
      sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' },
      initialCwd: '/repo',
    })
    expect(content.terminalId).toBeUndefined()
    expect(content.restoreError).toBeUndefined()
  })

  it('migrates non-resumable legacy Codex recovery_failed panes to restore-unavailable errors', async () => {
    localStorage.setItem('freshell_version', '3')
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 3,
      tabs: {
        activeTabId: 'tab-codex',
        tabs: [{
          id: 'tab-codex',
          title: 'Codex terminal',
          createdAt: 1,
          mode: 'codex',
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-codex': {
            type: 'leaf',
            id: 'pane-codex',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-old',
              terminalId: 'term-old',
              status: 'recovery_failed',
              initialCwd: '/repo',
            },
          },
        },
        activePane: { 'tab-codex': 'pane-codex' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    await importFreshStorageMigration()

    const migratedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(migratedRaw).not.toBeNull()
    const parsed = parsePersistedLayoutRaw(migratedRaw!)
    expect(parsed).not.toBeNull()
    const content = ((parsed!.panes.layouts['tab-codex'] as any)?.content) ?? {}
    expect(content.status).toBe('error')
    expect(content.terminalId).toBeUndefined()
    expect(content.restoreError).toEqual({
      code: 'RESTORE_UNAVAILABLE',
      reason: 'invalid_legacy_restore_target',
    })
  })

  it('migrates mismatched legacy Codex recovery_failed session refs to restore-unavailable errors', async () => {
    localStorage.setItem('freshell_version', '3')
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 3,
      tabs: {
        activeTabId: 'tab-codex',
        tabs: [{
          id: 'tab-codex',
          title: 'Codex terminal',
          createdAt: 1,
          mode: 'codex',
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-codex': {
            type: 'leaf',
            id: 'pane-codex',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-old',
              terminalId: 'term-old',
              status: 'recovery_failed',
              sessionRef: {
                provider: 'claude',
                sessionId: VALID_CLAUDE_SESSION_ID,
              },
              initialCwd: '/repo',
            },
          },
        },
        activePane: { 'tab-codex': 'pane-codex' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    await importFreshStorageMigration()

    const migratedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(migratedRaw).not.toBeNull()
    const parsed = parsePersistedLayoutRaw(migratedRaw!)
    expect(parsed).not.toBeNull()
    const content = ((parsed!.panes.layouts['tab-codex'] as any)?.content) ?? {}
    expect(content.status).toBe('error')
    expect(content.terminalId).toBeUndefined()
    expect(content.sessionRef).toBeUndefined()
    expect(content.restoreError).toEqual({
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

  it('carries the machineId stamp through the every-boot layout rewrite (LB-05)', async () => {
    localStorage.setItem('freshell_version', '5')
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      // Real-clock-fresh (e3r1 finding 5): the boot migration's stale
      // prune sweep removes beyond-STALE_LAYOUT_MS envelopes, and a fixed
      // 2025 timestamp has drifted past the threshold. The stamp's
      // survival through the rewrite is the pin; the age is incidental.
      persistedAt: Date.now(),
      version: 4,
      machineId: 'machine-stamp-1',
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', title: 'Work', createdAt: 1 }],
      },
      panes: {
        version: 7,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'editor',
              filePath: '/tmp/a.md',
              language: null,
              readOnly: false,
              content: '',
              viewMode: 'source',
              wordWrap: true,
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    await importFreshStorageMigration()

    const migratedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(migratedRaw).not.toBeNull()
    expect(JSON.parse(migratedRaw!).machineId).toBe('machine-stamp-1')

    const parsed = parsePersistedLayoutRaw(migratedRaw!)
    expect(parsed).not.toBeNull()
    expect(parsed?.machineId).toBe('machine-stamp-1')
  })

  // e3 post-cap finding 2: the migration-boot prune sweep deleted THIS
  // window's beyond-threshold envelope BEFORE the App classifier ran, so a
  // real stale boot classified (and logged) 'absent' — never 'stale'. The
  // sweep now spares the own key; the App gate's deferred own-key prune
  // (pruneOwnStaleLayoutEnvelope) retires it after the keep-vs-rebuild
  // decision, while the sweep keeps pruning OTHER windows' abandoned keys.
  function layoutEnvelopeFixture(persistedAt: number): Record<string, unknown> {
    return {
      persistedAt,
      version: 4,
      machineId: 'machine-sweep-1',
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', title: 'Work', createdAt: 1, updatedAt: 1 }],
      },
      panes: {
        version: 7,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'editor',
              filePath: '/tmp/a.md',
              language: null,
              readOnly: false,
              content: '',
              viewMode: 'source',
              wordWrap: true,
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }
  }

  it('the boot sweep spares THIS window’s stale envelope for the classifier but still prunes other windows’ stale keys (e3 post-cap finding 2)', async () => {
    localStorage.setItem('freshell_version', '5')
    const stalePersistedAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layoutEnvelopeFixture(stalePersistedAt)))
    const otherStaleKey = 'freshell.layout.v3.client-other-window'
    localStorage.setItem(otherStaleKey, JSON.stringify(layoutEnvelopeFixture(stalePersistedAt)))
    const otherFreshKey = 'freshell.layout.v3.client-fresh-window'
    localStorage.setItem(otherFreshKey, JSON.stringify(layoutEnvelopeFixture(Date.now())))

    const module = await importFreshStorageMigration()

    // Hygiene intact: OTHER windows' abandoned keys are pruned by the
    // boot sweep, fresh ones kept.
    expect(localStorage.getItem(otherStaleKey)).toBeNull()
    expect(localStorage.getItem(otherFreshKey)).not.toBeNull()
    // The classifier's input survived: the own stale envelope is still
    // there for classifyPersistedLayoutHealth (the migration rewrite
    // preserves persistedAt).
    const ownRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(ownRaw).not.toBeNull()
    expect(JSON.parse(ownRaw!).persistedAt).toBe(stalePersistedAt)

    // The gate-time prune (called by App after the decision) removes the
    // own stale envelope together with its channels.
    localStorage.setItem(`${LAYOUT_STORAGE_KEY}.bak`, 'stale-backup')
    ;(module.pruneOwnStaleLayoutEnvelope as () => void)()
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(`${LAYOUT_STORAGE_KEY}.bak`)).toBeNull()
  })

  it('the gate-time own-key prune keeps a fresh envelope and no-ops an absent one', async () => {
    localStorage.setItem('freshell_version', '5')
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layoutEnvelopeFixture(Date.now())))

    const module = await importFreshStorageMigration()
    ;(module.pruneOwnStaleLayoutEnvelope as () => void)()
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).not.toBeNull()

    localStorage.removeItem(LAYOUT_STORAGE_KEY)
    ;(module.pruneOwnStaleLayoutEnvelope as () => void)()
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBeNull()
  })
})
