import { describe, expect, it } from 'vitest'
import { shouldKeepClosedTab, collectPaneSnapshots, buildOpenTabRegistryRecord, buildClosedTabRegistryRecord } from '@/lib/tab-registry-snapshot'
import { collectPaneIdentityActivity } from '@/lib/pane-activity'
import { getTabDisplayTitle } from '@/lib/tab-title'
import type { PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import { normalizeRegistryTabRecord } from '@/store/tabRegistryTypes'

describe('shouldKeepClosedTab', () => {
  it('keeps when open for more than 5 minutes', () => {
    expect(shouldKeepClosedTab({
      openDurationMs: 6 * 60_000,
      paneCount: 1,
      titleSetByUser: false,
    })).toBe(true)
  })

  it('keeps when pane count is greater than one', () => {
    expect(shouldKeepClosedTab({
      openDurationMs: 60_000,
      paneCount: 2,
      titleSetByUser: false,
    })).toBe(true)
  })

  it('keeps when title was set by user', () => {
    expect(shouldKeepClosedTab({
      openDurationMs: 60_000,
      paneCount: 1,
      titleSetByUser: true,
    })).toBe(true)
  })

  it('does not keep otherwise', () => {
    expect(shouldKeepClosedTab({
      openDurationMs: 60_000,
      paneCount: 1,
      titleSetByUser: false,
    })).toBe(false)
  })
})

describe('collectPaneSnapshots', () => {
  it('serializes candidate-only Codex durability state for registry reopen surfaces', () => {
    const codexDurability = {
      schemaVersion: 1,
      state: 'captured_pre_turn',
      candidate: {
        provider: 'codex',
        candidateThreadId: '019e2413-b8d0-7a98-b5fb-2f4af05baf58',
        rolloutPath: '/home/user/.codex/sessions/2026/05/14/rollout.jsonl',
        source: 'thread_start_response',
        capturedAt: 1778764200000,
      },
    } as const
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-codex',
      content: {
        kind: 'terminal',
        createRequestId: 'req-codex',
        status: 'running',
        mode: 'codex',
        shell: 'system',
        terminalId: 'term-codex',
        serverInstanceId: 'server-1',
        codexDurability,
        initialCwd: '/home/user/code/freshell',
      },
    }

    const snapshots = collectPaneSnapshots(node, 'server-1')

    expect(snapshots).toEqual([{
      paneId: 'pane-codex',
      kind: 'terminal',
      title: undefined,
      payload: {
        createRequestId: 'req-codex',
        mode: 'codex',
        shell: 'system',
        sessionRef: undefined,
        codexDurability,
        liveTerminal: {
          terminalId: 'term-codex',
          serverInstanceId: 'server-1',
        },
        initialCwd: '/home/user/code/freshell',
      },
    }])
  })

  it('serializes fresh-agent selection strategies and drops legacy display overrides from payloads', () => {
    // The content carries legacy per-pane display overrides (no writer since
    // 2026-04); the registry payload must never carry showThinking/showTools
    // forward, while showTimecodes keeps stamping through.
    const legacyContent = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-agent',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000123',
      sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000123' },
      modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
      permissionMode: 'default',
      effort: 'turbo',
      plugins: ['planner'],
      showThinking: true,
      showTools: true,
      showTimecodes: true,
    }
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-agent',
      content: legacyContent as PaneNode['content'],
    }

    const snapshots = collectPaneSnapshots(node, 'server-1')

    expect(snapshots).toEqual([{
      paneId: 'pane-agent',
      kind: 'fresh-agent',
      title: undefined,
      payload: {
        createRequestId: 'req-agent',
        provider: 'claude',
        sessionType: 'freshclaude',
        sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000123' },
        initialCwd: undefined,
        modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
        permissionMode: 'default',
        effort: 'turbo',
        plugins: ['planner'],
        settingsDismissed: undefined,
        showTimecodes: true,
      },
    }])
    expect('showThinking' in snapshots[0].payload).toBe(false)
    expect('showTools' in snapshots[0].payload).toBe(false)
  })

  it('keeps fresh-agent style in tab-registry pane payloads', () => {
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-style',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-style',
        status: 'idle',
        style: 'serif',
      },
    }

    const snapshots = collectPaneSnapshots(node, 'server-style')

    expect(snapshots[0]).toMatchObject({
      kind: 'fresh-agent',
      payload: {
        sessionType: 'freshcodex',
        style: 'serif',
      },
    })
  })

  it('persists createRequestId in terminal and fresh-agent pane payloads', () => {
    const terminalNode: PaneNode = {
      type: 'leaf',
      id: 'pane-term',
      content: {
        kind: 'terminal',
        createRequestId: 'req-stable-term',
        status: 'running',
        mode: 'shell',
        shell: 'system',
        terminalId: 'term-1',
        serverInstanceId: 'server-1',
      },
    }
    const termSnapshots = collectPaneSnapshots(terminalNode, 'server-1')
    expect(termSnapshots[0].payload.createRequestId).toBe('req-stable-term')

    const freshAgentNode: PaneNode = {
      type: 'leaf',
      id: 'pane-fa',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-stable-fa',
        status: 'idle',
      } as any,
    }
    const faSnapshots = collectPaneSnapshots(freshAgentNode, 'server-1')
    expect(faSnapshots[0].payload.createRequestId).toBe('req-stable-fa')
  })

  describe('extension content', () => {
    it('serializes extension pane content with correct kind and payload', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: {
          kind: 'extension',
          extensionName: 'my-ext',
          props: { key: 'val' },
        },
      }

      const snapshots = collectPaneSnapshots(node, 'server-1')

      expect(snapshots).toEqual([{
        paneId: 'pane-1',
        kind: 'extension',
        title: undefined,
        payload: {
          extensionName: 'my-ext',
          props: { key: 'val' },
        },
      }])
    })

    it('preserves extension data in a split tree', () => {
      const node: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: 'pane-left',
            content: {
              kind: 'extension',
              extensionName: 'ext-a',
              props: { count: 42 },
            },
          },
          {
            type: 'leaf',
            id: 'pane-right',
            content: {
              kind: 'extension',
              extensionName: 'ext-b',
              props: { nested: { deep: true } },
            },
          },
        ],
      }

      const snapshots = collectPaneSnapshots(node, 'server-2')

      expect(snapshots).toHaveLength(2)
      expect(snapshots[0]).toEqual({
        paneId: 'pane-left',
        kind: 'extension',
        title: undefined,
        payload: {
          extensionName: 'ext-a',
          props: { count: 42 },
        },
      })
      expect(snapshots[1]).toEqual({
        paneId: 'pane-right',
        kind: 'extension',
        title: undefined,
        payload: {
          extensionName: 'ext-b',
          props: { nested: { deep: true } },
        },
      })
    })

    it('includes pane title when provided', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-titled',
        content: {
          kind: 'extension',
          extensionName: 'my-ext',
          props: {},
        },
      }

      const snapshots = collectPaneSnapshots(node, 'server-1', {
        'pane-titled': 'My Extension Pane',
      })

      expect(snapshots[0].title).toBe('My Extension Pane')
    })
  })
})

describe('pane identity stamping', () => {
  function baseRecordInput(layout: PaneNode) {
    return {
      tab: {
        id: 'tab-1',
        createRequestId: 'req-tab-1',
        title: 'Tab 1',
        status: 'running',
        mode: 'shell',
        createdAt: 1,
      } as never,
      layout,
      serverInstanceId: 'srv',
      deviceId: 'device-1',
      deviceLabel: 'Device 1',
      updatedAt: 1,
      revision: 0,
    }
  }

  it('stamps sessionKeys and busySessionKeys onto open-record pane payloads via paneIdentityActivity', () => {
    const layout: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        {
          type: 'leaf',
          id: 'pane-claude',
          content: {
            kind: 'terminal',
            createRequestId: 'req-claude',
            status: 'running',
            mode: 'claude',
            shell: 'system',
            terminalId: 'term-claude',
            resumeSessionId: '11111111-1111-4111-8111-111111111111',
          },
        },
        {
          type: 'leaf',
          id: 'pane-shell',
          content: {
            kind: 'terminal',
            createRequestId: 'req-shell',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            terminalId: 'term-shell',
          },
        },
      ],
    }
    const paneIdentityActivity = new Map([
      ['pane-claude', {
        sessionKeys: ['claude:11111111-1111-4111-8111-111111111111', 'claude:terminal:term-claude'],
        busySessionKeys: ['claude:11111111-1111-4111-8111-111111111111'],
      }],
    ])

    const record = buildOpenTabRegistryRecord({
      ...baseRecordInput(layout),
      paneIdentityActivity,
    })

    expect(record.panes[0].payload.sessionKeys).toEqual([
      'claude:11111111-1111-4111-8111-111111111111',
      'claude:terminal:term-claude',
    ])
    expect(record.panes[0].payload.busySessionKeys).toEqual(['claude:11111111-1111-4111-8111-111111111111'])
    // Sessionless panes carry neither field.
    expect(record.panes[1].payload).not.toHaveProperty('sessionKeys')
    expect(record.panes[1].payload).not.toHaveProperty('busySessionKeys')
  })

  it('stamps every alias in sessionKeys but only the effective identity in busySessionKeys', () => {
    const explicitId = '66666666-6666-4666-8666-666666666666'
    const resumeId = '77777777-7777-4777-8777-777777777777'
    const tab = {
      id: 'tab-1',
      createRequestId: 'req-tab-1',
      title: 'Tab 1',
      status: 'running',
      mode: 'claude',
      createdAt: 1,
    } as unknown as Tab
    const layout: PaneNode = {
      type: 'leaf',
      id: 'pane-alias',
      content: {
        kind: 'terminal',
        createRequestId: 'req-alias',
        status: 'running',
        mode: 'claude',
        shell: 'system',
        terminalId: 'term-alias',
        sessionRef: { provider: 'claude', sessionId: explicitId },
        resumeSessionId: resumeId,
      },
    }
    const paneIdentityActivity = collectPaneIdentityActivity({
      tabs: [tab],
      paneLayouts: { 'tab-1': layout },
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {
        'term-alias': { terminalId: 'term-alias', phase: 'busy', updatedAt: 1 },
      },
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    })

    const record = buildOpenTabRegistryRecord({
      ...baseRecordInput(layout),
      paneIdentityActivity,
    })

    expect(record.panes[0].payload.sessionKeys).toEqual([
      `claude:${explicitId}`,
      `claude:${resumeId}`,
    ])
    expect(record.panes[0].payload.busySessionKeys).toEqual([`claude:${explicitId}`])
  })

  it('never stamps identity fields onto closed/tombstone records even when given a nonempty map', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'pane-claude',
      content: {
        kind: 'terminal',
        createRequestId: 'req-claude',
        status: 'running',
        mode: 'claude',
        shell: 'system',
        terminalId: 'term-claude',
        resumeSessionId: '11111111-1111-4111-8111-111111111111',
      },
    }
    const paneIdentityActivity = new Map([
      ['pane-claude', {
        sessionKeys: ['claude:11111111-1111-4111-8111-111111111111'],
        busySessionKeys: ['claude:11111111-1111-4111-8111-111111111111'],
      }],
    ])

    const record = buildClosedTabRegistryRecord({
      ...baseRecordInput(layout),
      paneIdentityActivity,
    })

    expect(record.status).toBe('closed')
    for (const pane of record.panes) {
      expect(pane.payload).not.toHaveProperty('sessionKeys')
      expect(pane.payload).not.toHaveProperty('busySessionKeys')
    }
  })
})

describe('tab registry record name alignment', () => {
  it('uses the canonical display title for tabName, not the raw stored tab.title', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'p1',
      content: { kind: 'terminal', mode: 'claude', status: 'running', createRequestId: 'r' },
    }
    const tab = { id: 't1', createRequestId: 'r', title: 'Tab 1', status: 'running', mode: 'claude' } as never
    const paneTitles = { p1: 'my-project' }

    const record = buildOpenTabRegistryRecord({
      tab, layout, serverInstanceId: 'srv', paneTitles,
      deviceId: 'd', deviceLabel: 'D', updatedAt: 1, revision: 0,
    })

    // The archive panel must show the same name as the tab bar (canonical),
    // not the raw stored 'Tab 1'.
    expect(record.tabName).toBe('my-project')
    expect(record.tabName).toBe(getTabDisplayTitle(tab, layout, paneTitles))
  })
})

describe('unified agent names registry round-trip (Task 6)', () => {
  it('carries the pane naming identity (namingHandle/nameRef) in terminal pane payloads', () => {
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-named',
      content: {
        kind: 'terminal',
        createRequestId: 'req-named',
        status: 'running',
        mode: 'claude',
        shell: 'system',
        namingHandle: 'nh-reg-1',
        nameRef: { kind: 'pending', id: 'nh-reg-1' },
      },
    }

    const snapshots = collectPaneSnapshots(node, 'srv')

    expect(snapshots[0].payload).toMatchObject({
      namingHandle: 'nh-reg-1',
      nameRef: { kind: 'pending', id: 'nh-reg-1' },
    })
  })

  it('carries the pane naming identity in fresh-agent pane payloads', () => {
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-fa-named',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-fa-named',
        status: 'idle',
        namingHandle: 'nh-fa-1',
        nameRef: { kind: 'session', provider: 'claude', sessionId: 'sess-fa' },
      } as any,
    }

    const snapshots = collectPaneSnapshots(node, 'srv')

    expect(snapshots[0].payload).toMatchObject({
      namingHandle: 'nh-fa-1',
      nameRef: { kind: 'session', provider: 'claude', sessionId: 'sess-fa' },
    })
  })

  it('stamps the tab nameSource onto open and closed records, and omits it when absent', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'p1',
      content: { kind: 'terminal', mode: 'claude', status: 'running', createRequestId: 'r' },
    }

    const openRecord = buildOpenTabRegistryRecord({
      tab: { id: 't1', createRequestId: 'r', title: 'T', status: 'running', mode: 'claude', createdAt: 1, nameSource: { kind: 'session', paneId: 'p1' } } as never,
      layout,
      serverInstanceId: 'srv',
      deviceId: 'd',
      deviceLabel: 'D',
      updatedAt: 1,
      revision: 0,
    })
    expect(openRecord.nameSource).toEqual({ kind: 'session', paneId: 'p1' })

    const closedRecord = buildClosedTabRegistryRecord({
      tab: { id: 't1', createRequestId: 'r', title: 'T', status: 'running', mode: 'claude', createdAt: 1, nameSource: { kind: 'legacy' } } as never,
      layout,
      serverInstanceId: 'srv',
      deviceId: 'd',
      deviceLabel: 'D',
      updatedAt: 1,
      revision: 0,
    })
    expect(closedRecord.nameSource).toEqual({ kind: 'legacy' })

    const unownedRecord = buildOpenTabRegistryRecord({
      tab: { id: 't1', createRequestId: 'r', title: 'T', status: 'running', mode: 'claude', createdAt: 1 } as never,
      layout,
      serverInstanceId: 'srv',
      deviceId: 'd',
      deviceLabel: 'D',
      updatedAt: 1,
      revision: 0,
    })
    expect(unownedRecord).not.toHaveProperty('nameSource')
  })
})

describe('name reliability (Task 9): registry pane user flags', () => {
  const splitLayout: PaneNode = {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      {
        type: 'leaf',
        id: 'pane-renamed',
        content: { kind: 'terminal', mode: 'shell', status: 'running', createRequestId: 'req-renamed' },
      },
      {
        type: 'leaf',
        id: 'pane-osc',
        content: { kind: 'browser', browserInstanceId: 'browser-1', url: 'https://example.com', devToolsOpen: false },
      },
    ],
  }
  const tab = {
    id: 't1', createRequestId: 'r', title: 'MyShellTab', titleSetByUser: true,
    status: 'running', mode: 'shell', createdAt: 1,
  } as Tab
  const paneTitles = { 'pane-renamed': 'KeepMePane', 'pane-osc': 'user@host: ~' }
  const paneTitleSetByUser = { 'pane-renamed': true }

  it('registry pane snapshots carry the pane user flag', () => {
    const input = {
      tab, layout: splitLayout, serverInstanceId: 'srv', paneTitles, paneTitleSetByUser,
      deviceId: 'd', deviceLabel: 'D', updatedAt: 1, revision: 0,
    }
    for (const record of [buildOpenTabRegistryRecord(input), buildClosedTabRegistryRecord(input)]) {
      const renamed = record.panes.find((pane) => pane.paneId === 'pane-renamed')
      const automatic = record.panes.find((pane) => pane.paneId === 'pane-osc')
      expect(renamed).toMatchObject({ title: 'KeepMePane', titleSetByUser: true })
      // A pane whose title is automatic (an OSC title) carries no flag at all.
      expect(automatic?.title).toBe('user@host: ~')
      expect(automatic).not.toHaveProperty('titleSetByUser')
      expect(record.titleSetByUser).toBe(true)
    }
  })

  it('the registry record schema keeps the pane user flag (tabs.sync normalizes every record)', () => {
    const record = buildOpenTabRegistryRecord({
      tab, layout: splitLayout, serverInstanceId: 'srv', paneTitles, paneTitleSetByUser,
      deviceId: 'd', deviceLabel: 'D', updatedAt: 1, revision: 0,
    })
    const normalized = normalizeRegistryTabRecord(JSON.parse(JSON.stringify(record)))
    expect(normalized?.panes.find((pane) => pane.paneId === 'pane-renamed')?.titleSetByUser).toBe(true)
    expect(normalized?.panes.find((pane) => pane.paneId === 'pane-osc')).not.toHaveProperty('titleSetByUser')
  })
})
