import { describe, expect, it } from 'vitest'

import {
  LAYOUT_FRESH_AGENT_BACKUP_KEY,
  LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY,
  LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY,
  LAYOUT_STORAGE_KEY,
  hashPersistedLayoutRaw,
  parsePersistedLayoutRaw,
  readRecoverablePersistedLayoutRaw,
} from '@/store/persistedState'

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
      showThinking: false,
      showTools: true,
      showTimecodes: true,
    })
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
      showTools: true,
    })
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
      [LAYOUT_FRESH_AGENT_BACKUP_KEY]: backupRaw,
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
      [LAYOUT_FRESH_AGENT_BACKUP_KEY]: backupRaw,
    }) as Storage)).toBe(currentRaw)
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
      [LAYOUT_FRESH_AGENT_BACKUP_KEY]: backupRaw,
      [LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY]: marker,
    }) as Storage)).toBe(currentRaw)
  })
})
