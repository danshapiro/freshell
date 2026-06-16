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

const codexDurability = {
  schemaVersion: 1 as const,
  state: 'captured_pre_turn' as const,
  candidate: {
    provider: 'codex' as const,
    candidateThreadId: '019e2a0c-7cef-7281-94df-d0d05d7b9ac3',
    rolloutPath: '/home/user/.codex/sessions/2026/05/14/rollout.jsonl',
    source: 'thread_started_notification' as const,
    capturedAt: 1778743920000,
  },
}

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

    it('preserves valid Codex durability state on tabs', () => {
      const raw = JSON.stringify({
        version: TABS_SCHEMA_VERSION,
        tabs: {
          activeTabId: 't1',
          tabs: [{
            id: 't1',
            title: 'Codex',
            createdAt: 1,
            type: 'terminal',
            mode: 'codex',
            codexDurability,
          }],
        },
      })

      const parsed = parsePersistedTabsRaw(raw)
      expect(parsed?.tabs.tabs[0].codexDurability).toEqual(codexDurability)
    })

    it('drops raw Codex legacy session ids instead of inventing sessionRef', () => {
      const raw = JSON.stringify({
        version: TABS_SCHEMA_VERSION,
        tabs: {
          activeTabId: 'legacy-codex',
          tabs: [{
            id: 'legacy-codex',
            title: 'Legacy Codex',
            createdAt: 1,
            mode: 'codex',
            codingCliProvider: 'codex',
            codingCliSessionId: 'thread-durable-1',
          }],
        },
      })

      const parsed = parsePersistedTabsRaw(raw)
      expect(parsed).not.toBeNull()
      expect(parsed!.tabs.tabs[0].id).toBe('legacy-codex')
      expect(parsed!.tabs.tabs[0].sessionRef).toBeUndefined()
      expect(parsed!.tabs.tabs[0].codingCliSessionId).toBeUndefined()
      expect(parsed!.tabs.tabs[0].claudeSessionId).toBeUndefined()
    })

    it('migrates legacy claudeSessionId into sessionRef for old Claude tabs', () => {
      const raw = JSON.stringify({
        version: TABS_SCHEMA_VERSION,
        tabs: {
          activeTabId: 'legacy-claude',
          tabs: [{
            id: 'legacy-claude',
            title: 'Legacy Claude',
            createdAt: 1,
            mode: 'claude',
            claudeSessionId: '11111111-1111-4111-8111-111111111111',
          }],
        },
      })

      const parsed = parsePersistedTabsRaw(raw)
      expect(parsed).not.toBeNull()
      expect(parsed!.tabs.tabs[0]).toMatchObject({
        id: 'legacy-claude',
        sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
      })
      expect(parsed!.tabs.tabs[0].codingCliSessionId).toBeUndefined()
      expect(parsed!.tabs.tabs[0].claudeSessionId).toBeUndefined()
    })

    it('drops unrecoverable orphan legacy session fields without rejecting the tab', () => {
      const raw = JSON.stringify({
        version: TABS_SCHEMA_VERSION,
        tabs: {
          activeTabId: 'legacy-orphan',
          tabs: [{
            id: 'legacy-orphan',
            title: 'Legacy Orphan',
            createdAt: 1,
            mode: 'shell',
            codingCliSessionId: 'orphan-session',
          }],
        },
      })

      const parsed = parsePersistedTabsRaw(raw)
      expect(parsed).not.toBeNull()
      expect(parsed!.tabs.tabs[0].id).toBe('legacy-orphan')
      expect(parsed!.tabs.tabs[0].sessionRef).toBeUndefined()
      expect(parsed!.tabs.tabs[0].codingCliSessionId).toBeUndefined()
      expect(parsed!.tabs.tabs[0].claudeSessionId).toBeUndefined()
    })
  })

  describe('parsePersistedPanesRaw', () => {
    it('bumps the panes schema version for selection-strategy persistence', () => {
      expect(PANES_SCHEMA_VERSION).toBe(7)
    })

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

    it('preserves valid Codex durability state on terminal pane content', () => {
      const raw = JSON.stringify({
        version: PANES_SCHEMA_VERSION,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              createRequestId: 'req-1',
              status: 'creating',
              mode: 'codex',
              shell: 'system',
              codexDurability,
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      })

      const parsed = parsePersistedPanesRaw(raw)
      const content = (parsed!.layouts['tab-1'] as any).content
      expect(content.codexDurability).toEqual(codexDurability)
    })

    it('normalizes legacy Codex recovery_failed panes to creating resume panes', () => {
      const parsed = parsePersistedPanesRaw(JSON.stringify({
        version: 1,
        layouts: {
          tab1: {
            type: 'leaf',
            id: 'pane1',
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
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
      }))

      expect(parsed).not.toBeNull()
      const content = (parsed!.layouts.tab1 as any).content
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

    it('does not create a fresh Codex pane for non-resumable legacy recovery_failed state', () => {
      const parsed = parsePersistedPanesRaw(JSON.stringify({
        version: 1,
        layouts: {
          tab1: {
            type: 'leaf',
            id: 'pane1',
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
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
      }))

      expect(parsed).not.toBeNull()
      const content = (parsed!.layouts.tab1 as any).content
      expect(content.status).toBe('error')
      expect(content.terminalId).toBeUndefined()
      expect(content.restoreError).toEqual({
        code: 'RESTORE_UNAVAILABLE',
        reason: 'invalid_legacy_restore_target',
      })
    })

    it('does not treat mismatched legacy Codex recovery_failed session refs as resumable', () => {
      const parsed = parsePersistedPanesRaw(JSON.stringify({
        version: 1,
        layouts: {
          tab1: {
            type: 'leaf',
            id: 'pane1',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-old',
              terminalId: 'term-old',
              status: 'recovery_failed',
              sessionRef: {
                provider: 'claude',
                sessionId: '550e8400-e29b-41d4-a716-446655440000',
              },
              initialCwd: '/repo',
            },
          },
        },
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
      }))

      expect(parsed).not.toBeNull()
      const content = (parsed!.layouts.tab1 as any).content
      expect(content.status).toBe('error')
      expect(content.terminalId).toBeUndefined()
      expect(content.sessionRef).toBeUndefined()
      expect(content.restoreError).toEqual({
        code: 'RESTORE_UNAVAILABLE',
        reason: 'invalid_legacy_restore_target',
      })
    })
  })
})
