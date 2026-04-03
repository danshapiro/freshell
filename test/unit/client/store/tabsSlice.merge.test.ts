// Tests for cross-tab tombstone merge in hydrateTabs
import { describe, it, expect } from 'vitest'
import tabsReducer, { addTab, hydrateTabs, removeTab, updateTab } from '@/store/tabsSlice'
import type { Tab } from '@/store/types'
import type { TabsState } from '@/store/tabsSlice'
import { sessionMetadataKey } from '@/lib/session-metadata'

function makeTab(overrides: Partial<Tab> & { id: string }): Tab {
  return {
    createRequestId: overrides.id,
    title: `Tab ${overrides.id}`,
    status: 'running',
    mode: 'shell',
    shell: 'system',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeState(tabs: Tab[], activeTabId?: string | null, tombstones?: TabsState['tombstones']): TabsState {
  return {
    tabs,
    activeTabId: activeTabId ?? tabs[0]?.id ?? null,
    renameRequestTabId: null,
    tombstones: tombstones ?? [],
  }
}

describe('hydrateTabs merge', () => {
  it('merges local and remote tabs as a set union', () => {
    const shared = makeTab({ id: 'shared', title: 'Shared' })
    const localOnly = makeTab({ id: 'local-only', title: 'Local Only' })
    const remoteOnly = makeTab({ id: 'remote-only', title: 'Remote Only' })

    const localState = makeState([shared, localOnly], 'shared')

    const result = tabsReducer(
      localState,
      hydrateTabs({
        tabs: [shared, remoteOnly],
        activeTabId: 'shared',
        renameRequestTabId: null,
        tombstones: [],
      })
    )

    const ids = result.tabs.map(t => t.id)
    // All three should be present — union, not replacement
    expect(ids).toContain('shared')
    expect(ids).toContain('local-only')
    expect(ids).toContain('remote-only')
    expect(result.tabs).toHaveLength(3)
  })

  it('does not resurrect tombstoned tabs from remote', () => {
    const localTab = makeTab({ id: 'alive', title: 'Alive' })
    const deletedTab = makeTab({ id: 'deleted', title: 'Deleted' })

    const localState = makeState(
      [localTab],
      'alive',
      [{ id: 'deleted', deletedAt: Date.now() }],
    )

    const result = tabsReducer(
      localState,
      hydrateTabs({
        tabs: [localTab, deletedTab],
        activeTabId: 'alive',
        renameRequestTabId: null,
        tombstones: [],
      })
    )

    const ids = result.tabs.map(t => t.id)
    expect(ids).toContain('alive')
    expect(ids).not.toContain('deleted')
  })

  it('does not resurrect tabs tombstoned in remote', () => {
    const alive = makeTab({ id: 'alive', title: 'Alive' })
    const deletedRemotely = makeTab({ id: 'deleted-remote', title: 'Was Deleted' })

    const localState = makeState([alive, deletedRemotely], 'alive')

    const result = tabsReducer(
      localState,
      hydrateTabs({
        tabs: [alive],
        activeTabId: 'alive',
        renameRequestTabId: null,
        tombstones: [{ id: 'deleted-remote', deletedAt: Date.now() }],
      })
    )

    const ids = result.tabs.map(t => t.id)
    expect(ids).toContain('alive')
    expect(ids).not.toContain('deleted-remote')
  })

  it('resolves property conflicts using updatedAt — newer wins', () => {
    const now = Date.now()
    const localTab = makeTab({ id: 'tab-1', title: 'Local Title', updatedAt: now + 1000 })
    const remoteTab = makeTab({ id: 'tab-1', title: 'Remote Title', updatedAt: now })

    const localState = makeState([localTab])

    const result = tabsReducer(
      localState,
      hydrateTabs({
        tabs: [remoteTab],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
        tombstones: [],
      })
    )

    // Local tab is newer, so local properties win
    expect(result.tabs[0].title).toBe('Local Title')
  })

  it('resolves property conflicts — remote wins when newer', () => {
    const now = Date.now()
    const localTab = makeTab({ id: 'tab-1', title: 'Local Title', updatedAt: now })
    const remoteTab = makeTab({ id: 'tab-1', title: 'Remote Title', updatedAt: now + 1000 })

    const localState = makeState([localTab])

    const result = tabsReducer(
      localState,
      hydrateTabs({
        tabs: [remoteTab],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
        tombstones: [],
      })
    )

    // Remote tab is newer, so remote properties win
    expect(result.tabs[0].title).toBe('Remote Title')
  })

  it('remote wins ties on updatedAt', () => {
    const now = Date.now()
    const localTab = makeTab({ id: 'tab-1', title: 'Local', updatedAt: now })
    const remoteTab = makeTab({ id: 'tab-1', title: 'Remote', updatedAt: now })

    const localState = makeState([localTab])

    const result = tabsReducer(
      localState,
      hydrateTabs({
        tabs: [remoteTab],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
        tombstones: [],
      })
    )

    expect(result.tabs[0].title).toBe('Remote')
  })

  it('uses remote order for shared tabs, appends local-only tabs', () => {
    const a = makeTab({ id: 'a', title: 'A' })
    const b = makeTab({ id: 'b', title: 'B' })
    const c = makeTab({ id: 'c', title: 'C' })
    const localOnly = makeTab({ id: 'local', title: 'Local' })

    // Local order: a, b, c, local
    const localState = makeState([a, b, c, localOnly])

    // Remote order is reversed: c, b, a
    const result = tabsReducer(
      localState,
      hydrateTabs({
        tabs: [c, b, a],
        activeTabId: 'a',
        renameRequestTabId: null,
        tombstones: [],
      })
    )

    const ids = result.tabs.map(t => t.id)
    // Shared tabs use remote order (c, b, a), local-only appended
    expect(ids).toEqual(['c', 'b', 'a', 'local'])
  })

  it('preserves local activeTabId if it exists in merged set', () => {
    const tab1 = makeTab({ id: 't1' })
    const tab2 = makeTab({ id: 't2' })

    const localState = makeState([tab1], 't1')

    const result = tabsReducer(
      localState,
      hydrateTabs({
        tabs: [tab1, tab2],
        activeTabId: 't2',
        renameRequestTabId: null,
        tombstones: [],
      })
    )

    // Local activeTabId is preferred if it exists in merged set
    expect(result.activeTabId).toBe('t1')
  })

  it('unions tombstones from both local and remote', () => {
    const tab = makeTab({ id: 'alive' })
    const localState = makeState(
      [tab],
      'alive',
      [{ id: 'local-deleted', deletedAt: Date.now() }],
    )

    const result = tabsReducer(
      localState,
      hydrateTabs({
        tabs: [tab],
        activeTabId: 'alive',
        renameRequestTabId: null,
        tombstones: [{ id: 'remote-deleted', deletedAt: Date.now() }],
      })
    )

    const tombstoneIds = result.tombstones.map(t => t.id)
    expect(tombstoneIds).toContain('local-deleted')
    expect(tombstoneIds).toContain('remote-deleted')
  })

  it('allows a newer remote tab change to merge without regressing canonical durable fallback identity', () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000321'
    const localTab = makeTab({
      id: 'tab-1',
      title: 'Local title',
      mode: 'shell',
      codingCliProvider: 'claude',
      updatedAt: 100,
      resumeSessionId: canonicalSessionId,
      sessionMetadataByKey: {
        [sessionMetadataKey('claude', canonicalSessionId)]: {
          sessionType: 'freshclaude',
          firstUserMessage: 'Continue locally',
        },
      },
    })
    const remoteTab = makeTab({
      id: 'tab-1',
      title: 'Renamed elsewhere',
      mode: 'shell',
      updatedAt: 200,
      resumeSessionId: 'named-resume',
      sessionMetadataByKey: {
        [sessionMetadataKey('claude', 'named-resume')]: {
          sessionType: 'freshclaude',
          firstUserMessage: 'Remote stale resume',
        },
      },
    })

    const result = tabsReducer(
      makeState([localTab], 'tab-1'),
      {
        ...hydrateTabs({
          tabs: [remoteTab],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
          tombstones: [],
        }),
        meta: {
          localLayoutPersistedAt: 200,
          remoteLayoutPersistedAt: 250,
        },
      } as any,
    )

    expect(result.tabs[0]).toEqual(expect.objectContaining({
      title: 'Renamed elsewhere',
      resumeSessionId: canonicalSessionId,
    }))
    expect(result.tabs[0].sessionMetadataByKey).toEqual(expect.objectContaining({
      [sessionMetadataKey('claude', canonicalSessionId)]: expect.objectContaining({
        sessionType: 'freshclaude',
      }),
    }))
    expect(result.tabs[0].sessionMetadataByKey).not.toHaveProperty(sessionMetadataKey('claude', 'named-resume'))
  })
})

describe('removeTab adds tombstone', () => {
  it('records a tombstone when removing a tab', () => {
    const tab1 = makeTab({ id: 't1' })
    const tab2 = makeTab({ id: 't2' })
    const state = makeState([tab1, tab2], 't1')

    const result = tabsReducer(state, removeTab('t1'))

    expect(result.tabs.map(t => t.id)).toEqual(['t2'])
    expect(result.tombstones).toHaveLength(1)
    expect(result.tombstones[0].id).toBe('t1')
    expect(result.tombstones[0].deletedAt).toBeGreaterThan(0)
  })
})

describe('tab mutations set updatedAt', () => {
  it('addTab sets updatedAt', () => {
    const before = Date.now()
    const state = tabsReducer(makeState([]), addTab({ title: 'New' }))
    const tab = state.tabs[0]
    expect(tab.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('updateTab bumps updatedAt', () => {
    const tab = makeTab({ id: 't1', updatedAt: 1000 })
    const state = makeState([tab])

    const before = Date.now()
    const result = tabsReducer(state, updateTab({ id: 't1', updates: { title: 'Renamed' } }))
    expect(result.tabs[0].updatedAt).toBeGreaterThanOrEqual(before)
    expect(result.tabs[0].title).toBe('Renamed')
  })
})
