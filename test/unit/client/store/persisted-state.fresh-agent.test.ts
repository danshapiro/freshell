import { beforeEach, describe, expect, it } from 'vitest'

import {
  LAYOUT_FRESH_AGENT_BACKUP_KEY,
  hashPersistedLayoutRaw,
  parsePersistedLayoutRaw,
  readRecoverablePersistedLayoutRaw,
} from '@/store/persistedState'

// Delta round 3, finding 1: the recoverable-read path resolves THIS
// window's per-window layout key and its per-window fresh-agent
// backup/marker channels; the marker PAYLOAD's backupKey field stays the
// migration-identifier constant.
const WINDOW_ID = 'client-persisted-fresh-agent'
const LAYOUT_STORAGE_KEY = `freshell.layout.v3.${WINDOW_ID}`
const LAYOUT_FRESH_AGENT_BACKUP_STORAGE_KEY = `${LAYOUT_STORAGE_KEY}.backup-before-fresh-agent-centralization`
const LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY = `${LAYOUT_STORAGE_KEY}.fresh-agent-centralization-pending`
const LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY = `${LAYOUT_STORAGE_KEY}.fresh-agent-centralization-commit`

function seedWindow(): void {
  sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)
}

function collectLeafContents(node: any, contents: any[] = []): any[] {
  if (!node || typeof node !== 'object') return contents
  if (node.type === 'leaf') {
    contents.push(node.content)
    return contents
  }
  if (node.type === 'split' && Array.isArray(node.children)) {
    collectLeafContents(node.children[0], contents)
    collectLeafContents(node.children[1], contents)
  }
  return contents
}

function split(children: [any, any]) {
  return {
    type: 'split',
    id: `split-${children[0].id}-${children[1].id}`,
    direction: 'horizontal',
    sizes: [50, 50],
    children,
  }
}

function leaf(id: string, content: Record<string, unknown>) {
  return {
    type: 'leaf',
    id,
    content: {
      createRequestId: `req-${id}`,
      status: 'idle',
      ...content,
    },
  }
}

function layoutRaw(layouts: Record<string, unknown>) {
  return JSON.stringify({
    version: 3,
    tabs: {
      activeTabId: 'tab-1',
      tabs: Object.keys(layouts).map((id) => ({ id, title: id })),
    },
    panes: {
      version: 6,
      layouts,
      activePane: Object.fromEntries(Object.keys(layouts).map((id) => [id, 'pane-1'])),
      paneTitles: {},
      paneTitleSetByUser: {},
    },
    tombstones: [],
  })
}

function storageWith(values: Record<string, string | null>): Pick<Storage, 'getItem'> {
  return {
    getItem(key: string) {
      return values[key] ?? null
    },
  }
}

describe('persistedState fresh-agent migration', () => {
  beforeEach(seedWindow)

  it.each(['freshclaude', 'kilroy'])('restores %s placeholder panes under their durable identity', (sessionType) => {
    const sessionId = '00000000-0000-4000-8000-000000000779'
    const parsed = parsePersistedLayoutRaw(layoutRaw({
      'tab-1': leaf('legacy', {
        kind: 'fresh-agent', sessionType, provider: 'claude',
        sessionId: 'old-placeholder', sessionRef: { provider: 'claude', sessionId },
        serverInstanceId: 'old-server', initialCwd: '/repo',
      }),
    }))
    expect(collectLeafContents(parsed!.panes.layouts['tab-1'])[0]).toMatchObject({
      sessionId, sessionRef: { provider: 'claude', sessionId },
      createRequestId: 'req-legacy', initialCwd: '/repo',
    })
  })

  it('retains a validated same-provider Claude sessionRef alongside a persisted restore error', () => {
    const sessionId = '00000000-0000-4000-8000-000000000780'
    const parsed = parsePersistedLayoutRaw(layoutRaw({
      'tab-1': leaf('lost-claude', {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionId: 'legacy-runtime-placeholder',
        sessionRef: { provider: 'claude', sessionId },
        restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'durable_artifact_missing' },
      }),
    }))

    expect(collectLeafContents(parsed!.panes.layouts['tab-1'])[0]).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId,
      sessionRef: { provider: 'claude', sessionId },
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'durable_artifact_missing' },
    })
  })

  it('leaves a legacy zero-turn placeholder without a durable reference available for lost-session recovery', () => {
    const parsed = parsePersistedLayoutRaw(layoutRaw({
      'tab-1': leaf('legacy', {
        kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
        sessionId: 'old-zero-turn-placeholder', serverInstanceId: 'old-server',
      }),
    }))
    const content = collectLeafContents(parsed!.panes.layouts['tab-1'])[0]
    expect(content.sessionId).toBe('old-zero-turn-placeholder')
    expect(content.sessionRef).toBeUndefined()
  })

  it('migrates persisted agent-chat panes to fresh-agent panes in the combined layout key shape', () => {
    const parsed = parsePersistedLayoutRaw(layoutRaw({
      'tab-1': {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'agent-chat', provider: 'freshclaude', createRequestId: 'req-1', status: 'idle' },
      },
    }))

    expect(collectLeafContents(parsed!.panes.layouts['tab-1'])[0]).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
  })

  it('covers legacy providers, canonical ids, aliases, cli ids, and timeline ids', () => {
    const canonical = '00000000-0000-4000-8000-000000000123'
    const timeline = '00000000-0000-4000-8000-000000000124'
    const cli = '00000000-0000-4000-8000-000000000125'
    const parsed = parsePersistedLayoutRaw(layoutRaw({
      'tab-1': split([
        leaf('pane-freshclaude', {
          kind: 'agent-chat',
          provider: 'freshclaude',
          resumeSessionId: canonical,
          showThinking: false,
          showTools: true,
          showTimecodes: true,
        }),
        split([
          leaf('pane-kilroy', {
            kind: 'agent-chat',
            provider: 'kilroy',
            timelineSessionId: timeline,
          }),
          split([
            leaf('pane-old-claude', {
              kind: 'agent-chat',
              provider: 'claude',
              cliSessionId: cli,
            }),
            split([
              leaf('pane-missing-provider', {
                kind: 'agent-chat',
                resumeSessionId: canonical,
              }),
              split([
                leaf('pane-missing-identity', {
                  kind: 'agent-chat',
                  provider: 'freshclaude',
                }),
                leaf('pane-alias', {
                  kind: 'agent-chat',
                  provider: 'claude',
                  sessionRef: { provider: 'claude', sessionId: 'named-alias' },
                }),
              ]),
            ]),
          ]),
        ]),
      ]),
    }))

    const byPane = Object.fromEntries(
      collectLeafContents(parsed!.panes.layouts['tab-1']).map((content) => [content.createRequestId, content]),
    )

    expect(byPane['req-pane-freshclaude']).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: canonical },
      showTimecodes: true,
    })
    expect(byPane['req-pane-freshclaude'].showThinking).toBeUndefined()
    expect(byPane['req-pane-freshclaude'].showTools).toBeUndefined()
    expect(byPane['req-pane-kilroy']).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'kilroy',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: timeline },
    })
    expect(byPane['req-pane-old-claude']).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: cli },
    })
    expect(byPane['req-pane-missing-provider']).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
    expect(byPane['req-pane-missing-identity']).toMatchObject({
      kind: 'fresh-agent',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
    expect(byPane['req-pane-alias']).toMatchObject({
      kind: 'fresh-agent',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
    expect(byPane['req-pane-alias'].sessionRef).toBeUndefined()
  })

  it('keeps invalid legacy restore errors mutually exclusive with durable session refs', () => {
    const canonical = '00000000-0000-4000-8000-000000000777'
    const parsed = parsePersistedLayoutRaw(layoutRaw({
      'tab-1': leaf('pane-alias-with-resume', {
        kind: 'agent-chat',
        provider: 'freshclaude',
        sessionRef: { provider: 'claude', sessionId: 'named-alias' },
        resumeSessionId: canonical,
      }),
    }))

    const content = collectLeafContents(parsed!.panes.layouts['tab-1'])[0]
    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
    expect(content.sessionRef).toBeUndefined()
    expect(content.resumeSessionId).toBeUndefined()
  })

  it('normalizes existing fresh-agent panes with non-canonical Claude session refs to restore errors', () => {
    const canonical = '00000000-0000-4000-8000-000000000778'
    const parsed = parsePersistedLayoutRaw(layoutRaw({
      'tab-1': leaf('pane-fresh-alias', {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionRef: { provider: 'claude', sessionId: 'named-alias' },
        resumeSessionId: canonical,
        initialCwd: '/repo',
        modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
        showTools: true,
      }),
    }))

    const content = collectLeafContents(parsed!.panes.layouts['tab-1'])[0]
    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
      initialCwd: '/repo',
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
    })
    expect(content.showTools).toBeUndefined()
    expect(content.sessionRef).toBeUndefined()
    expect(content.resumeSessionId).toBeUndefined()
  })

  it('drops stale Freshopencode DeepSeek legacy model defaults during persisted layout parsing', () => {
    const parsed = parsePersistedLayoutRaw(layoutRaw({
      'tab-1': leaf('pane-freshopencode', {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode',
        status: 'idle',
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
      }),
    }))

    const content = collectLeafContents(parsed!.panes.layouts['tab-1'])[0]
    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      effort: 'max',
    })
    expect(content.modelSelection).toBeUndefined()
  })

  it('preserves explicit Freshopencode DeepSeek selections during persisted layout parsing', () => {
    const parsed = parsePersistedLayoutRaw(layoutRaw({
      'tab-1': leaf('pane-freshopencode', {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode',
        status: 'idle',
        model: 'opencode-go/deepseek-v4-flash',
        modelSelection: { kind: 'exact', modelId: 'opencode-go/deepseek-v4-flash' },
        effort: 'max',
      }),
    }))

    const content = collectLeafContents(parsed!.panes.layouts['tab-1'])[0]
    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      effort: 'max',
      modelSelection: { kind: 'exact', modelId: 'opencode-go/deepseek-v4-flash' },
    })
  })

  it('prefers the backup when a pending fresh-agent migration matches the current raw layout without a commit marker', () => {
    const backupRaw = layoutRaw({
      'tab-1': leaf('pane-backup', { kind: 'terminal', mode: 'shell' }),
    })
    const partialRaw = layoutRaw({
      'tab-1': leaf('pane-partial', { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude' }),
    })
    const pendingMarker = JSON.stringify({
      version: 1,
      migration: 'fresh-agent-centralization',
      backupKey: LAYOUT_FRESH_AGENT_BACKUP_KEY,
      originalHash: hashPersistedLayoutRaw(backupRaw),
      migratedHash: hashPersistedLayoutRaw(partialRaw),
      startedAt: 1,
    })

    expect(readRecoverablePersistedLayoutRaw(storageWith({
      [LAYOUT_STORAGE_KEY]: partialRaw,
      [LAYOUT_FRESH_AGENT_BACKUP_STORAGE_KEY]: backupRaw,
      [LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY]: pendingMarker,
    }) as Storage)).toBe(backupRaw)
  })

  it('keeps a valid current layout when backup remains but no recovery marker identifies it as partial', () => {
    const backupRaw = layoutRaw({
      'tab-1': leaf('pane-backup', { kind: 'terminal', mode: 'shell' }),
    })
    const currentRaw = layoutRaw({
      'tab-1': leaf('pane-current', { kind: 'terminal', mode: 'codex' }),
    })

    expect(readRecoverablePersistedLayoutRaw(storageWith({
      [LAYOUT_STORAGE_KEY]: currentRaw,
      [LAYOUT_FRESH_AGENT_BACKUP_STORAGE_KEY]: backupRaw,
    }) as Storage)).toBe(currentRaw)
  })

  // e5r1: the recoverable-read fallback must distinguish parse-level
  // failure classes. It historically treated ANY parse failure as a
  // reason to select the surviving backup, but the r5 metadata refusal
  // made present-but-malformed machineId/persistedAt a parse failure too
  // — so a corrupt CURRENT layout selected the older backup and the boot
  // never saw the corruption. The backup fallback is for STRUCTURALLY
  // destroyed primaries only; a metadata-malformed primary must flow
  // through as the corrupt evidence the boot classifier needs.
  it('keeps a metadata-malformed primary (machineId present but not a string) when a backup exists — no backup swap', () => {
    const backupRaw = layoutRaw({
      'tab-1': leaf('pane-backup', { kind: 'terminal', mode: 'shell' }),
    })
    const malformedRaw = JSON.stringify({
      ...JSON.parse(layoutRaw({ 'tab-1': leaf('pane-current', { kind: 'terminal', mode: 'codex' }) })),
      machineId: 123,
    })

    expect(readRecoverablePersistedLayoutRaw(storageWith({
      [LAYOUT_STORAGE_KEY]: malformedRaw,
      [LAYOUT_FRESH_AGENT_BACKUP_STORAGE_KEY]: backupRaw,
    }) as Storage)).toBe(malformedRaw)
  })

  it('keeps a metadata-malformed primary (persistedAt present but not a number) when a backup exists — no backup swap', () => {
    const backupRaw = layoutRaw({
      'tab-1': leaf('pane-backup', { kind: 'terminal', mode: 'shell' }),
    })
    const malformedRaw = JSON.stringify({
      ...JSON.parse(layoutRaw({ 'tab-1': leaf('pane-current', { kind: 'terminal', mode: 'codex' }) })),
      persistedAt: 'recently',
    })

    expect(readRecoverablePersistedLayoutRaw(storageWith({
      [LAYOUT_STORAGE_KEY]: malformedRaw,
      [LAYOUT_FRESH_AGENT_BACKUP_STORAGE_KEY]: backupRaw,
    }) as Storage)).toBe(malformedRaw)
  })

  // e5r2: the empty-string machineId is the same metadata-malformed
  // class. parseLayoutStructure stays structural-only — an empty stamp
  // must NOT select the backup; the malformed PRIMARY is the corrupt
  // evidence the boot classifier needs.
  it('keeps an empty-string machineId primary when a backup exists — no backup swap (e5r2)', () => {
    const backupRaw = layoutRaw({
      'tab-1': leaf('pane-backup', { kind: 'terminal', mode: 'shell' }),
    })
    const malformedRaw = JSON.stringify({
      ...JSON.parse(layoutRaw({ 'tab-1': leaf('pane-current', { kind: 'terminal', mode: 'codex' }) })),
      machineId: '',
    })

    expect(readRecoverablePersistedLayoutRaw(storageWith({
      [LAYOUT_STORAGE_KEY]: malformedRaw,
      [LAYOUT_FRESH_AGENT_BACKUP_STORAGE_KEY]: backupRaw,
    }) as Storage)).toBe(malformedRaw)
  })

  it('still selects the backup when the primary is structurally destroyed (JSON garbage, wrong shape, or a newer schema version)', () => {
    const backupRaw = layoutRaw({
      'tab-1': leaf('pane-backup', { kind: 'terminal', mode: 'shell' }),
    })

    expect(readRecoverablePersistedLayoutRaw(storageWith({
      [LAYOUT_STORAGE_KEY]: '{ not json',
      [LAYOUT_FRESH_AGENT_BACKUP_STORAGE_KEY]: backupRaw,
    }) as Storage)).toBe(backupRaw)

    expect(readRecoverablePersistedLayoutRaw(storageWith({
      [LAYOUT_STORAGE_KEY]: '{"version":3,"unexpected":"shape"}',
      [LAYOUT_FRESH_AGENT_BACKUP_STORAGE_KEY]: backupRaw,
    }) as Storage)).toBe(backupRaw)

    const tooNewRaw = JSON.stringify({
      version: 999,
      tabs: { activeTabId: null, tabs: [] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    expect(readRecoverablePersistedLayoutRaw(storageWith({
      [LAYOUT_STORAGE_KEY]: tooNewRaw,
      [LAYOUT_FRESH_AGENT_BACKUP_STORAGE_KEY]: backupRaw,
    }) as Storage)).toBe(backupRaw)
  })

  it('ignores a stale marker and keeps the current valid layout', () => {
    const backupRaw = layoutRaw({
      'tab-1': leaf('pane-backup', { kind: 'terminal', mode: 'shell' }),
    })
    const currentRaw = layoutRaw({
      'tab-1': leaf('pane-current', { kind: 'terminal', mode: 'codex' }),
    })
    const marker = JSON.stringify({
      version: 1,
      migration: 'fresh-agent-centralization',
      backupKey: LAYOUT_FRESH_AGENT_BACKUP_KEY,
      originalHash: hashPersistedLayoutRaw(backupRaw),
      migratedHash: hashPersistedLayoutRaw('some-old-layout'),
      committedAt: 1,
    })

    expect(readRecoverablePersistedLayoutRaw(storageWith({
      [LAYOUT_STORAGE_KEY]: currentRaw,
      [LAYOUT_FRESH_AGENT_BACKUP_STORAGE_KEY]: backupRaw,
      [LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY]: marker,
    }) as Storage)).toBe(currentRaw)
  })
})
