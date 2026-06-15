import { describe, expect, it } from 'vitest'
import { shouldKeepClosedTab, collectPaneSnapshots, buildOpenTabRegistryRecord } from '@/lib/tab-registry-snapshot'
import { getTabDisplayTitle } from '@/lib/tab-title'
import type { PaneNode } from '@/store/paneTypes'

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

  it('serializes fresh-agent selection strategies and explicit effort overrides', () => {
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-agent',
      content: {
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
      },
    }

    const snapshots = collectPaneSnapshots(node, 'server-1')

    expect(snapshots).toEqual([{
      paneId: 'pane-agent',
      kind: 'fresh-agent',
      title: undefined,
      payload: {
        provider: 'claude',
        sessionType: 'freshclaude',
        sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000123' },
        initialCwd: undefined,
        modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
        permissionMode: 'default',
        effort: 'turbo',
        plugins: ['planner'],
        settingsDismissed: undefined,
        showThinking: undefined,
        showTools: undefined,
        showTimecodes: undefined,
      },
    }])
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
