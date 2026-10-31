import { describe, it, expect, vi } from 'vitest'

import {
  parsePersistedLayoutRaw,
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
  it('restores a Codex observer selection under the parent identity and drops malformed selections', () => {
    for (const selection of ['native-child', [], '', null]) {
      const content = { kind: 'fresh-agent', provider: 'codex', sessionType: 'freshcodex', sessionRef: { provider: 'codex', sessionId: '11111111-1111-4111-8111-111111111111' }, createRequestId: 'parent-create', status: 'idle', observedChildThreadId: selection }
      const parsed = parsePersistedPanesRaw(JSON.stringify({ version: PANES_SCHEMA_VERSION, layouts: { parent: { type: 'leaf', id: 'parent-pane', content } }, activePane: { parent: 'parent-pane' } }))
      const restored = (parsed!.layouts.parent as any).content
      expect(restored.sessionRef).toEqual(content.sessionRef)
      expect(restored.createRequestId).toBe('parent-create')
      expect(restored.observedChildThreadId).toBe(selection === 'native-child' ? 'native-child' : undefined)
      expect(Object.keys(parsed!.layouts)).toEqual(['parent'])
    }
  })
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

    it('accepts Amplifier tabs and preserves their durable session identity', () => {
      const raw = JSON.stringify({
        version: TABS_SCHEMA_VERSION,
        tabs: {
          activeTabId: 'amplifier-tab',
          tabs: [{
            id: 'amplifier-tab',
            title: 'Amplifier',
            createdAt: 1,
            mode: 'amplifier',
            codingCliProvider: 'amplifier',
            resumeSessionId: 'amp-session-1',
          }],
        },
      })

      const parsed = parsePersistedTabsRaw(raw)
      expect(parsed).not.toBeNull()
      expect(parsed!.tabs.tabs[0]).toEqual(expect.objectContaining({
        id: 'amplifier-tab',
        mode: 'amplifier',
        codingCliProvider: 'amplifier',
        sessionRef: { provider: 'amplifier', sessionId: 'amp-session-1' },
      }))
      expect(parsed!.tabs.tabs[0].resumeSessionId).toBeUndefined()
    })

    it('sanitizes a non-string mode on one tab instead of nuking the whole tabs array', () => {
      const validTabs = Array.from({ length: 5 }, (_, i) => ({
        id: `tab-${i + 1}`,
        title: `Tab ${i + 1}`,
        createdAt: i + 1,
        mode: 'shell',
      }))
      const raw = JSON.stringify({
        version: TABS_SCHEMA_VERSION,
        tabs: {
          activeTabId: 'tab-1',
          tabs: [
            ...validTabs,
            {
              id: 'ext-tab',
              title: 'Extension Tab',
              createdAt: 6,
              // A foreign/extension payload sent a non-string mode value.
              mode: 42,
            },
          ],
        },
      })

      const parsed = parsePersistedTabsRaw(raw)
      expect(parsed).not.toBeNull()
      expect(parsed!.tabs.tabs).toHaveLength(6)
      const extTab = parsed!.tabs.tabs.find((t) => t.id === 'ext-tab')
      expect(extTab).toBeDefined()
      expect(extTab!.mode).toBeUndefined()
      expect(parsed!.tabs.tabs.map((t) => t.id)).toEqual(
        expect.arrayContaining(['tab-1', 'tab-2', 'tab-3', 'tab-4', 'tab-5', 'ext-tab']),
      )
    })

    it('drops a structurally invalid tab (missing id) while preserving the other valid tabs', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const validTabs = Array.from({ length: 5 }, (_, i) => ({
          id: `tab-${i + 1}`,
          title: `Tab ${i + 1}`,
          createdAt: i + 1,
          mode: 'shell',
        }))
        const raw = JSON.stringify({
          version: TABS_SCHEMA_VERSION,
          tabs: {
            activeTabId: 'tab-1',
            tabs: [
              ...validTabs,
              {
                // No id at all - genuinely broken shape, not salvageable.
                title: 'Corrupt Tab',
                createdAt: 6,
              },
            ],
          },
        })

        const parsed = parsePersistedTabsRaw(raw)
        expect(parsed).not.toBeNull()
        expect(parsed!.tabs.tabs).toHaveLength(5)
        expect(parsed!.tabs.tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2', 'tab-3', 'tab-4', 'tab-5'])
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
        const loggedArgs = consoleErrorSpy.mock.calls[0].join(' ')
        expect(loggedArgs).toMatch(/Corrupt Tab/)
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })
  })

  describe('parsePersistedLayoutRaw', () => {
    it('does not reject a combined layout because one tab uses Amplifier mode', () => {
      const raw = JSON.stringify({
        version: 4,
        tabs: {
          activeTabId: 'amplifier-tab',
          tabs: [{
            id: 'amplifier-tab',
            title: 'Amplifier',
            createdAt: 1,
            mode: 'amplifier',
            codingCliProvider: 'amplifier',
            sessionRef: { provider: 'amplifier', sessionId: 'amp-session-1' },
          }],
        },
        panes: {
          version: PANES_SCHEMA_VERSION,
          layouts: {
            'amplifier-tab': {
              type: 'leaf',
              id: 'amplifier-pane',
              content: {
                kind: 'terminal',
                mode: 'amplifier',
                createRequestId: 'req-amplifier',
                status: 'running',
                sessionRef: { provider: 'amplifier', sessionId: 'amp-session-1' },
              },
            },
          },
          activePane: { 'amplifier-tab': 'amplifier-pane' },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
        tombstones: [],
      })

      const parsed = parsePersistedLayoutRaw(raw)
      expect(parsed).not.toBeNull()
      expect(parsed!.tabs.tabs[0]).toEqual(expect.objectContaining({
        id: 'amplifier-tab',
        mode: 'amplifier',
        sessionRef: { provider: 'amplifier', sessionId: 'amp-session-1' },
      }))
      expect(((parsed!.panes.layouts['amplifier-tab'] as any).content)).toEqual(expect.objectContaining({
        mode: 'amplifier',
        sessionRef: { provider: 'amplifier', sessionId: 'amp-session-1' },
      }))
    })

    it('salvages the whole layout when only one of several tabs is corrupt', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const validTabs = Array.from({ length: 5 }, (_, i) => ({
          id: `tab-${i + 1}`,
          title: `Tab ${i + 1}`,
          createdAt: i + 1,
          mode: 'shell',
        }))
        const raw = JSON.stringify({
          version: 4,
          tabs: {
            activeTabId: 'tab-1',
            tabs: [
              ...validTabs,
              {
                // No id - genuinely broken shape.
                title: 'Corrupt Tab',
                createdAt: 6,
              },
            ],
          },
          panes: {
            version: PANES_SCHEMA_VERSION,
            layouts: {},
            activePane: {},
            paneTitles: {},
            paneTitleSetByUser: {},
          },
          tombstones: [],
        })

        const parsed = parsePersistedLayoutRaw(raw)
        expect(parsed).not.toBeNull()
        expect(parsed!.tabs.tabs).toHaveLength(5)
        expect(parsed!.tabs.tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2', 'tab-3', 'tab-4', 'tab-5'])
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })

    it('still returns null for the whole layout when the JSON is unparseable', () => {
      expect(parsePersistedLayoutRaw('not json{')).toBeNull()
    })

    it('still returns null for the whole layout when the version is newer than this build', () => {
      const raw = JSON.stringify({
        version: 999,
        tabs: { activeTabId: null, tabs: [] },
        panes: { version: PANES_SCHEMA_VERSION },
        tombstones: [],
      })
      expect(parsePersistedLayoutRaw(raw)).toBeNull()
    })

    // Delta r5 finding 1: present-but-malformed top-level metadata is
    // corruption, not a legacy absence. The parse used to coerce a
    // non-string machineId (or a non-number persistedAt) to undefined, so
    // a corrupt envelope parsed as unstamped legacy — the boot classifier
    // kept it and the healthy path's stamp backfill relabeled it as the
    // currently selected machine. Only genuinely ABSENT keys keep the
    // legacy meaning.
    function metadataEnvelope(metadata: Record<string, unknown>): string {
      return JSON.stringify({
        version: 4,
        ...metadata,
        tabs: { activeTabId: 'tab-a', tabs: [{ id: 'tab-a', title: 'A', createdAt: 1 }] },
        panes: { version: PANES_SCHEMA_VERSION, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
        tombstones: [],
      })
    }

    it('returns null when machineId is present but not a string (malformed stamp — corruption, not legacy absence)', () => {
      expect(parsePersistedLayoutRaw(metadataEnvelope({ machineId: 123 }))).toBeNull()
      expect(parsePersistedLayoutRaw(metadataEnvelope({ machineId: null }))).toBeNull()
    })

    // e5r2: an empty-string machineId is the same malformed class — the
    // validity rule follows machine-identity.ts's nonEmptyString
    // normalization, which TRIMS, so whitespace-only values are empty too.
    // Legacy absence is the key being ABSENT from the envelope, never a
    // present-but-empty value (the Rust recovery API rejects "" the same
    // way); letting it parse kept a possibly wrong-machine workspace as
    // healthy legacy and the stamp backfill relabeled it.
    it('returns null when machineId is present but empty or whitespace-only (malformed stamp — corruption, not legacy absence)', () => {
      expect(parsePersistedLayoutRaw(metadataEnvelope({ machineId: '' }))).toBeNull()
      expect(parsePersistedLayoutRaw(metadataEnvelope({ machineId: '   ' }))).toBeNull()
    })

    it('returns null when persistedAt is present but not a number (malformed stamp)', () => {
      expect(parsePersistedLayoutRaw(metadataEnvelope({ persistedAt: 'recently' }))).toBeNull()
      expect(parsePersistedLayoutRaw(metadataEnvelope({ persistedAt: null }))).toBeNull()
    })

    it('still parses an envelope with absent machineId and absent persistedAt (legitimate legacy absence)', () => {
      const parsed = parsePersistedLayoutRaw(metadataEnvelope({}))
      expect(parsed).not.toBeNull()
      expect(parsed!.machineId).toBeUndefined()
      expect(parsed!.persistedAt).toBeUndefined()
    })

    it('still parses an unstamped envelope with a valid persistedAt (legacy machine-id absence)', () => {
      const parsed = parsePersistedLayoutRaw(metadataEnvelope({ persistedAt: 1234 }))
      expect(parsed).not.toBeNull()
      expect(parsed!.machineId).toBeUndefined()
      expect(parsed!.persistedAt).toBe(1234)
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

  describe('unified agent names (Task 6): naming identity round-trip', () => {
    it('keeps a valid tab nameSource through the persisted-tabs parse and drops a malformed one', () => {
      const raw = JSON.stringify({
        version: TABS_SCHEMA_VERSION,
        tabs: {
          activeTabId: 't1',
          tabs: [
            {
              id: 't1',
              title: 'Owned',
              createdAt: 1,
              nameSource: { kind: 'session', paneId: 'p-agent' },
            },
            {
              id: 't2',
              title: 'Corrupt',
              createdAt: 1,
              nameSource: { kind: 'session' },
            },
          ],
        },
      })

      const parsed = parsePersistedTabsRaw(raw)
      expect(parsed?.tabs.tabs[0].nameSource).toEqual({ kind: 'session', paneId: 'p-agent' })
      expect(parsed?.tabs.tabs[1].nameSource).toBeUndefined()
    })

    it('keeps pane namingHandle/nameRef on terminal pane content through the panes parse', () => {
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
              mode: 'claude',
              shell: 'system',
              namingHandle: 'nh-persist-1',
              nameRef: { kind: 'pending', id: 'nh-persist-1' },
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      })

      const parsed = parsePersistedPanesRaw(raw)
      const content = (parsed!.layouts['tab-1'] as any).content
      expect(content.namingHandle).toBe('nh-persist-1')
      expect(content.nameRef).toEqual({ kind: 'pending', id: 'nh-persist-1' })
    })

    it('drops a malformed pane nameRef instead of retaining a corrupt naming identity', () => {
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
              mode: 'claude',
              shell: 'system',
              nameRef: { kind: 'bogus' },
              namingHandle: 17,
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      })

      const parsed = parsePersistedPanesRaw(raw)
      const content = (parsed!.layouts['tab-1'] as any).content
      expect(content.nameRef).toBeUndefined()
      expect(content.namingHandle).toBeUndefined()
    })
  })

// ── unified agent names (Task 7): the parse-level sanitizer gate ─────────────

describe('persistedState parsers — unified agent names (Task 7)', () => {
  const scopedLayout = {
    type: 'leaf',
    id: 'p-agent',
    content: {
      kind: 'terminal',
      mode: 'claude',
      createRequestId: 'req-1',
      sessionRef: { provider: 'claude', sessionId: 'sess-1' },
      namingHandle: 'h-1',
    },
  } as const

  it('parsePersistedPanesRaw strips a scoped pane title/flag while preserving the pane identity and out-of-scope titles', () => {
    const raw = JSON.stringify({
      version: 7,
      layouts: {
        'tab-1': scopedLayout,
        'tab-shell': {
          type: 'leaf',
          id: 'p-shell',
          content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-2' },
        },
      },
      activePane: { 'tab-1': 'p-agent' },
      paneTitles: { 'tab-1': { 'p-agent': 'Scoped Alias' }, 'tab-shell': { 'p-shell': 'Shell Title' } },
      paneTitleSetByUser: { 'tab-1': { 'p-agent': true }, 'tab-shell': { 'p-shell': true } },
    })
    const parsed = parsePersistedPanesRaw(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.paneTitles).toEqual({ 'tab-shell': { 'p-shell': 'Shell Title' } })
    expect(parsed!.paneTitleSetByUser).toEqual({ 'tab-shell': { 'p-shell': true } })
    // The pane identity survives the sanitizer untouched.
    const content = (parsed!.layouts['tab-1'] as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toEqual({ provider: 'claude', sessionId: 'sess-1' })
    expect(content.namingHandle).toBe('h-1')
  })

  it('parsePersistedTabsRaw drops a session-owned tab freeze flag and keeps legacy tabs verbatim', () => {
    const raw = JSON.stringify({
      version: 2,
      tabs: {
        activeTabId: 't1',
        tabs: [
          { id: 't1', title: 'Session Named', titleSetByUser: true, nameSource: { kind: 'session', paneId: 'p1' } },
          { id: 't2', title: 'Legacy', titleSetByUser: true },
        ],
      },
      tombstones: [],
    })
    const parsed = parsePersistedTabsRaw(raw)
    expect(parsed).not.toBeNull()
    const sessionOwned = parsed!.tabs.tabs.find((t) => t.id === 't1')!
    expect(sessionOwned.titleSetByUser).toBeUndefined()
    // The last-known title projection and the source pointer survive.
    expect(sessionOwned.title).toBe('Session Named')
    expect(sessionOwned.nameSource).toEqual({ kind: 'session', paneId: 'p1' })
    const legacy = parsed!.tabs.tabs.find((t) => t.id === 't2')!
    expect(legacy.titleSetByUser).toBe(true)
  })
})
