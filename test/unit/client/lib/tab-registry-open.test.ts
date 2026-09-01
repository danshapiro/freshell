import { describe, it, expect, vi } from 'vitest'
import {
  findRecordByTabKey,
  jumpToRecord,
  openPaneInNewTab,
  openRecordAsUnlinkedCopy,
  sanitizePaneSnapshot,
  type TabsRegistryGroups,
} from '@/lib/tab-registry-open'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { addPane, initLayout } from '@/store/panesSlice'
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
    expect(calls.map((a) => a.type)).toEqual([addTab.type, initLayout.type, addPane.type])
    expect(calls[2].payload.newContent).toMatchObject({ kind: 'browser' })
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
