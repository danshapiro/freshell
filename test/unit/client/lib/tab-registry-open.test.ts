import { describe, it, expect, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import {
  findRecordByTabKey,
  jumpToRecord,
  openPaneInNewTab,
  openRecordAsUnlinkedCopy,
  sanitizePaneSnapshot,
  type TabsRegistryGroups,
} from '@/lib/tab-registry-open'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'
import tabsReducer, { addTab, setActiveTab } from '@/store/tabsSlice'
import panesReducer, { addPane, initLayout, updatePaneTitle } from '@/store/panesSlice'
import type { PaneNode } from '@/store/paneTypes'
import type { AppDispatch } from '@/store/store'

function makeRecord(overrides: Partial<RegistryTabRecord> = {}): RegistryTabRecord {
  return {
    tabKey: 'device-a:tab-9',
    tabId: 'tab-9',
    serverInstanceId: 'srv-1',
    deviceId: 'device-a',
    deviceLabel: 'Device A',
    tabName: 'My Tab',
    status: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    paneCount: 1,
    titleSetByUser: false,
    panes: [],
    ...overrides,
  }
}

function makeGroups(overrides: Partial<TabsRegistryGroups> = {}): TabsRegistryGroups {
  return { localOpen: [], sameDeviceOpen: [], remoteOpen: [], closed: [], ...overrides }
}

describe('sanitizePaneSnapshot', () => {
  it('returns a host-stats pane for a host-stats snapshot (no picker fallback)', () => {
    const record = makeRecord()
    const snapshot = { paneId: 'pane-hs', kind: 'host-stats', payload: {} } as never
    expect(sanitizePaneSnapshot(record, snapshot)).toEqual({ kind: 'host-stats' })
  })
})

describe('findRecordByTabKey', () => {
  it('finds a record in any group', () => {
    const record = makeRecord()
    expect(findRecordByTabKey(makeGroups({ remoteOpen: [record] }), 'device-a:tab-9')).toBe(record)
    expect(findRecordByTabKey(makeGroups({ closed: [record] }), 'device-a:tab-9')).toBe(record)
    expect(findRecordByTabKey(makeGroups({ localOpen: [record] }), 'device-a:tab-9')).toBe(record)
  })

  it('returns undefined for an unknown tabKey', () => {
    expect(findRecordByTabKey(makeGroups(), 'nope')).toBeUndefined()
  })

  it('prefers the record whose status matches when a tabKey exists in two groups', () => {
    // Same-device multi-window can put one tabKey in localOpen AND closed
    // (live-rebuilt localOpen vs. retained closed tombstone) — validated
    // 2026-08-09; the status discriminator resolves the card's own record.
    const open = makeRecord()
    const closed = makeRecord({ status: 'closed', closedAt: 3 })
    const groups = makeGroups({ localOpen: [open], closed: [closed] })
    expect(findRecordByTabKey(groups, 'device-a:tab-9', 'closed')).toBe(closed)
    expect(findRecordByTabKey(groups, 'device-a:tab-9', 'open')).toBe(open)
    expect(findRecordByTabKey(groups, 'device-a:tab-9')).toBe(open)
  })
})

describe('openRecordAsUnlinkedCopy', () => {
  it('creates a new tab with a terminal fallback layout when the record has no panes', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const onOpened = vi.fn()
    openRecordAsUnlinkedCopy(makeRecord(), { dispatch, onOpened })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe(addTab.type)
    expect(calls[0].payload).toMatchObject({
      title: 'My Tab',
      mode: 'shell',
      status: 'creating',
      serverInstanceId: 'srv-1',
    })
    expect(calls[1].type).toBe(initLayout.type)
    expect(calls[1].payload.content).toMatchObject({ kind: 'terminal', mode: 'shell' })
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('adds one pane per extra snapshot', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const record = makeRecord({
      panes: [
        { paneId: 'p1', kind: 'terminal', title: 'sh', payload: {} },
        { paneId: 'p2', kind: 'browser', title: 'docs', payload: {} },
      ],
    })
    openRecordAsUnlinkedCopy(record, { dispatch })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    // One pane per snapshot, then the recorded pane titles (name
    // reliability, Task 14).
    expect(calls.map((a) => a.type)).toEqual([
      addTab.type, initLayout.type, addPane.type, updatePaneTitle.type, updatePaneTitle.type,
    ])
    expect(calls[2].payload.newContent).toMatchObject({ kind: 'browser' })
  })

  it('remaps a session-owned record nameSource through the explicit old->new pane-id map', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const record = makeRecord({
      nameSource: { kind: 'session', paneId: 'p2' },
      panes: [
        { paneId: 'p1', kind: 'terminal', title: 'sh', payload: { mode: 'shell' } },
        { paneId: 'p2', kind: 'terminal', title: 'agent', payload: { mode: 'claude' } },
      ],
    })
    openRecordAsUnlinkedCopy(record, { dispatch })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe(addTab.type)
    // The copy remints every pane id; the pointer must follow the source
    // pane's NEW id, not the stale recorded one.
    const firstNewPaneId = calls[1].payload.paneId
    const secondNewPaneId = calls[2].payload.newPaneId
    expect(firstNewPaneId).toBeTruthy()
    expect(secondNewPaneId).toBeTruthy()
    expect(firstNewPaneId).not.toBe('p1')
    expect(secondNewPaneId).not.toBe('p2')
    expect(calls[0].payload.nameSource).toEqual({ kind: 'session', paneId: secondNewPaneId })
  })

  it('an unresolvable pointer on a copy resolves from the rebuilt layout, not a stale pane id', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const record = makeRecord({
      // Pre-feature/foreign record: no pointer to remap.
      panes: [{ paneId: 'p1', kind: 'terminal', title: 'sh', payload: { mode: 'shell' } }],
    })
    openRecordAsUnlinkedCopy(record, { dispatch })
    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls[0].payload.nameSource).toBeUndefined()
  })

  it('carries the pane naming identity (namingHandle/nameRef) into the copied pane content', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const record = makeRecord({
      panes: [{
        paneId: 'p1',
        kind: 'terminal',
        title: 'agent',
        payload: {
          mode: 'claude',
          namingHandle: 'nh-copy-1',
          nameRef: { kind: 'pending', id: 'nh-copy-1' },
        },
      }],
    })
    openRecordAsUnlinkedCopy(record, { dispatch })
    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls[1].payload.content).toMatchObject({
      kind: 'terminal',
      mode: 'claude',
      namingHandle: 'nh-copy-1',
    })
  })
})

describe('openPaneInNewTab', () => {
  it('creates a single-pane tab titled after the record and pane', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const record = makeRecord({
      panes: [{ paneId: 'p2', kind: 'browser', title: 'docs', payload: {} }],
    })
    openPaneInNewTab(record, record.panes[0], { dispatch })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe(addTab.type)
    expect(calls[0].payload).toMatchObject({ title: 'My Tab · docs' })
    expect(calls[1].type).toBe(initLayout.type)
    expect(calls[1].payload.content).toMatchObject({ kind: 'browser' })
  })

  it('never seeds a scoped agent pane with the record-tab group label', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const record = makeRecord({
      tabName: 'Research sprint',
      nameSource: { kind: 'session', paneId: 'p-agent' },
      panes: [{
        paneId: 'p-agent',
        kind: 'terminal',
        title: 'Refactor planner',
        payload: { mode: 'claude', sessionRef: { provider: 'claude', sessionId: 'sess-1' } },
      }],
    })
    openPaneInNewTab(record, record.panes[0], { dispatch })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    // The moved scoped pane OWNS the new tab: no composed
    // `${record.tabName} · ${pane.title}` label, and the tab is named by
    // that pane's session (the lifecycle middleware resolves the pointer
    // from the created layout; the display reads the canonical name).
    expect(calls[0].payload.title).not.toContain('Research sprint')
    expect(calls[0].payload.title).not.toContain('·')
    expect(calls[0].payload.title).toBe('Refactor planner')
  })
})

// Name reliability (plan Task 14; Task 9 receipt, open concern 3): opening a
// registry record from the Tabs view restores pane names and their "user
// renamed" protection exactly as the Task 9 new-window rebuild does — titles
// remapped to the new pane ids, a flag only together with its title, no
// title for a scoped agent pane, and the tab's own flag only on a tab that is
// not session-owned.
describe('registry opens keep pane names', () => {
  function buildStore() {
    return configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  }

  type Store = ReturnType<typeof buildStore>

  function leafIds(node: PaneNode | undefined): string[] {
    if (!node) return []
    if (node.type === 'leaf') return [node.id]
    return [...leafIds(node.children[0]), ...leafIds(node.children[1])]
  }

  /** The tab the open created (the last one) with its leaves in order. */
  function openedTab(store: Store) {
    const state = store.getState()
    const tab = state.tabs.tabs[state.tabs.tabs.length - 1]
    return {
      tab,
      leaves: leafIds(state.panes.layouts[tab.id]),
      titles: state.panes.paneTitles[tab.id] ?? {},
      flags: state.panes.paneTitleSetByUser?.[tab.id] ?? {},
    }
  }

  it('a copy restores pane titles and rename flags through the pane-id remap, and the tab flag', () => {
    const store = buildStore()
    const record = makeRecord({
      tabName: 'MyShellTab',
      titleSetByUser: true,
      paneCount: 3,
      panes: [
        { paneId: 'p1', kind: 'terminal', title: 'KeepMePane', titleSetByUser: true, payload: { mode: 'shell' } },
        { paneId: 'p2', kind: 'terminal', title: 'dan@host: ~', payload: { mode: 'shell' } },
        { paneId: 'p3', kind: 'browser', title: 'Team docs', titleSetByUser: true, payload: { url: 'https://example.com/docs' } },
      ],
    })

    openRecordAsUnlinkedCopy(record, { dispatch: store.dispatch })

    const { tab, leaves, titles, flags } = openedTab(store)
    expect(tab.title).toBe('MyShellTab')
    expect(tab.titleSetByUser).toBe(true)
    expect(leaves).toHaveLength(3)
    expect(leaves).not.toContain('p1')
    const [first, second, third] = leaves
    expect(titles).toEqual({ [first]: 'KeepMePane', [second]: 'dan@host: ~', [third]: 'Team docs' })
    expect(flags).toEqual({ [first]: true, [third]: true })
  })

  it('a copy never restores a rename flag without its title', () => {
    const store = buildStore()
    const record = makeRecord({
      paneCount: 2,
      panes: [
        { paneId: 'p1', kind: 'terminal', titleSetByUser: true, payload: { mode: 'shell' } },
        { paneId: 'p2', kind: 'terminal', title: '', titleSetByUser: true, payload: { mode: 'shell' } },
      ],
    })

    openRecordAsUnlinkedCopy(record, { dispatch: store.dispatch })

    const { leaves, titles, flags } = openedTab(store)
    expect(flags).toEqual({})
    // Each pane keeps the default title its creation gave it.
    expect(titles).toEqual({ [leaves[0]]: 'Shell', [leaves[1]]: 'Shell' })
  })

  it('a copy of a session-owned agent tab restores no agent pane title and no tab flag', () => {
    const store = buildStore()
    const record = makeRecord({
      tabName: 'Refactor planner',
      titleSetByUser: true,
      nameSource: { kind: 'session', paneId: 'p-agent' },
      paneCount: 2,
      panes: [
        {
          paneId: 'p-agent',
          kind: 'terminal',
          title: 'Refactor planner',
          titleSetByUser: true,
          payload: { mode: 'claude', sessionRef: { provider: 'claude', sessionId: 'sess-1' } },
        },
        { paneId: 'p-shell', kind: 'terminal', title: 'KeepMePane', titleSetByUser: true, payload: { mode: 'shell' } },
      ],
    })

    openRecordAsUnlinkedCopy(record, { dispatch: store.dispatch })

    const { tab, leaves, titles, flags } = openedTab(store)
    expect(tab.nameSource).toEqual({ kind: 'session', paneId: leaves[0] })
    expect(tab.titleSetByUser).toBeUndefined()
    // The agent pane's saved session record names it; the recorded label is
    // an old alias and never comes back as a pane title.
    expect(titles[leaves[0]]).not.toBe('Refactor planner')
    expect(flags[leaves[0]]).toBeUndefined()
    expect(titles[leaves[1]]).toBe('KeepMePane')
    expect(flags[leaves[1]]).toBe(true)
  })

  it('a pane opened in its own tab keeps its title and rename flag', () => {
    const store = buildStore()
    const record = makeRecord({
      tabName: 'MyShellTab',
      titleSetByUser: true,
      paneCount: 2,
      panes: [
        { paneId: 'p1', kind: 'terminal', title: 'sh', payload: { mode: 'shell' } },
        { paneId: 'p2', kind: 'terminal', title: 'KeepMePane', titleSetByUser: true, payload: { mode: 'shell' } },
      ],
    })

    openPaneInNewTab(record, record.panes[1], { dispatch: store.dispatch })

    const { tab, leaves, titles, flags } = openedTab(store)
    expect(leaves).toHaveLength(1)
    expect(leaves[0]).not.toBe('p2')
    expect(titles).toEqual({ [leaves[0]]: 'KeepMePane' })
    expect(flags).toEqual({ [leaves[0]]: true })
    // A new tab: the record tab's own rename flag is not its flag.
    expect(tab.titleSetByUser).toBeUndefined()
  })

  it('a scoped agent pane opened in its own tab gets no stored title', () => {
    const store = buildStore()
    const record = makeRecord({
      nameSource: { kind: 'session', paneId: 'p-agent' },
      panes: [{
        paneId: 'p-agent',
        kind: 'terminal',
        title: 'Refactor planner',
        titleSetByUser: true,
        payload: { mode: 'claude', sessionRef: { provider: 'claude', sessionId: 'sess-1' } },
      }],
    })

    openPaneInNewTab(record, record.panes[0], { dispatch: store.dispatch })

    const { leaves, titles, flags } = openedTab(store)
    expect(titles[leaves[0]]).not.toBe('Refactor planner')
    expect(flags).toEqual({})
  })
})

describe('jumpToRecord', () => {
  it('activates the local tab when it exists', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const onOpened = vi.fn()
    jumpToRecord(makeRecord(), { dispatch, onOpened, hasLocalTab: () => true })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls).toHaveLength(1)
    expect(calls[0].type).toBe(setActiveTab.type)
    expect(calls[0].payload).toBe('tab-9')
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('falls back to opening an unlinked copy when the local tab is gone', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    jumpToRecord(makeRecord(), { dispatch, hasLocalTab: () => false })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe(addTab.type)
  })
})
