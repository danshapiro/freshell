// Tests for atomic tabs+panes persistence via freshell.layout.v3
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LAYOUT_STORAGE_KEY, TABS_STORAGE_KEY, PANES_STORAGE_KEY } from '@/store/storage-keys'
import { parsePersistedLayoutRaw, migrateV2ToV3 } from '@/store/persistedState'

describe('atomic persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('LAYOUT_STORAGE_KEY', () => {
    it('is freshell.layout.v3', () => {
      expect(LAYOUT_STORAGE_KEY).toBe('freshell.layout.v3')
    })
  })

  describe('parsePersistedLayoutRaw', () => {
    it('parses a valid v3 layout payload', () => {
      const payload = {
        version: 3,
        tabs: {
          activeTabId: 'tab-1',
          tabs: [{ id: 'tab-1', title: 'Tab 1', status: 'running', mode: 'shell', createdAt: 1000 }],
        },
        panes: {
          layouts: { 'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell' } } },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
        tombstones: [{ id: 'deleted-tab', deletedAt: 1000 }],
      }

      const result = parsePersistedLayoutRaw(JSON.stringify(payload))
      expect(result).not.toBeNull()
      expect(result!.tabs.tabs).toHaveLength(1)
      expect(result!.tabs.tabs[0].id).toBe('tab-1')
      expect(result!.panes.layouts).toHaveProperty('tab-1')
      expect(result!.tombstones).toHaveLength(1)
      expect(result!.tombstones[0].id).toBe('deleted-tab')
    })

    it('returns null for invalid JSON', () => {
      expect(parsePersistedLayoutRaw('not json')).toBeNull()
    })

    it('returns null for missing tabs', () => {
      expect(parsePersistedLayoutRaw(JSON.stringify({ version: 3, panes: {} }))).toBeNull()
    })

    it('defaults tombstones to empty array', () => {
      const payload = {
        version: 3,
        tabs: { activeTabId: null, tabs: [] },
        panes: { layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      }
      const result = parsePersistedLayoutRaw(JSON.stringify(payload))
      expect(result!.tombstones).toEqual([])
    })
  })

  describe('migrateV2ToV3', () => {
    it('combines v2 tabs and panes into v3 layout', () => {
      const v2Tabs = JSON.stringify({
        tabs: {
          activeTabId: 'tab-1',
          tabs: [{ id: 'tab-1', title: 'Shell', status: 'running', mode: 'shell', createdAt: 1000 }],
        },
        tombstones: [{ id: 'old-tab', deletedAt: 500 }],
      })
      const v2Panes = JSON.stringify({
        version: 6,
        layouts: { 'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell' } } },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      })

      localStorage.setItem(TABS_STORAGE_KEY, v2Tabs)
      localStorage.setItem(PANES_STORAGE_KEY, v2Panes)

      const result = migrateV2ToV3()
      expect(result).not.toBeNull()

      // Should have written the v3 key
      const v3Raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
      expect(v3Raw).not.toBeNull()

      const v3 = JSON.parse(v3Raw!)
      expect(v3.version).toBe(4)
      expect(v3.tabs.tabs).toHaveLength(1)
      expect(v3.panes.layouts).toHaveProperty('tab-1')
      expect(v3.tombstones).toHaveLength(1)

      // Should have deleted v2 keys
      expect(localStorage.getItem(TABS_STORAGE_KEY)).toBeNull()
      expect(localStorage.getItem(PANES_STORAGE_KEY)).toBeNull()
    })

    it('returns null when no v2 keys exist', () => {
      expect(migrateV2ToV3()).toBeNull()
    })

    it('handles missing panes key — creates empty panes', () => {
      localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({
        tabs: { activeTabId: null, tabs: [] },
      }))

      const result = migrateV2ToV3()
      expect(result).not.toBeNull()
      expect(result!.panes.layouts).toEqual({})
    })
  })
})
