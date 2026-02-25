import { describe, it, expect } from 'vitest'

import {
  parsePersistedTabsRaw,
  parsePersistedPanesRaw,
  TABS_STORAGE_KEY,
  PANES_STORAGE_KEY,
  TABS_SCHEMA_VERSION,
  PANES_SCHEMA_VERSION,
} from '../../../../src/store/persistedState'
import { PERSIST_BROADCAST_CHANNEL_NAME } from '../../../../src/store/persistBroadcast'
import { STORAGE_KEYS } from '../../../../src/store/storage-keys'

describe('persistedState parsers', () => {
  it('uses v2 namespaced storage and broadcast keys', () => {
    expect(TABS_STORAGE_KEY).toBe('freshell.tabs.v2')
    expect(PANES_STORAGE_KEY).toBe('freshell.panes.v2')
    expect(STORAGE_KEYS.sessionActivity).toBe('freshell.sessionActivity.v2')
    expect(PERSIST_BROADCAST_CHANNEL_NAME).toBe('freshell.persist.v2')
  })

  describe('parsePersistedTabsRaw', () => {
    it('returns null for invalid JSON', () => {
      expect(parsePersistedTabsRaw('{')).toBeNull()
    })

    it('returns null for versions newer than this build', () => {
      const raw = JSON.stringify({
        version: TABS_SCHEMA_VERSION + 1,
        tabs: { activeTabId: null, tabs: [] },
      })
      expect(parsePersistedTabsRaw(raw)).toBeNull()
    })

    it('normalizes missing version to 0', () => {
      const raw = JSON.stringify({
        tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'Tab', createdAt: 1 }] },
      })
      const parsed = parsePersistedTabsRaw(raw)
      expect(parsed).not.toBeNull()
      expect(parsed!.version).toBe(0)
      expect(parsed!.tabs.tabs[0].id).toBe('t1')
    })
  })

  describe('parsePersistedPanesRaw', () => {
    it('returns null for invalid JSON', () => {
      expect(parsePersistedPanesRaw('{')).toBeNull()
    })

    it('returns null for versions newer than this build', () => {
      const raw = JSON.stringify({
        version: PANES_SCHEMA_VERSION + 1,
        layouts: {},
        activePane: {},
        paneTitles: {},

      })
      expect(parsePersistedPanesRaw(raw)).toBeNull()
    })

    it('accepts legacy terminal content missing lifecycle fields (migration will add them)', () => {
      const raw = JSON.stringify({
        version: 1,
        layouts: {
          'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell' } },
        },
        activePane: { 'tab-1': 'pane-1' },
      })
      const parsed = parsePersistedPanesRaw(raw)
      expect(parsed).not.toBeNull()
      expect(parsed!.version).toBe(1)
      expect(Object.keys(parsed!.layouts)).toEqual(['tab-1'])
    })
  })
})
