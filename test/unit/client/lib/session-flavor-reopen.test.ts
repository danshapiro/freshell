import { describe, expect, it } from 'vitest'
import { resolveReopenPaneSessionTarget } from '@/lib/session-flavor-reopen'
import type { PaneContent } from '@/store/paneTypes'

const tab = {
  id: 'tab-1',
  mode: 'shell',
  title: 'Tab',
  status: 'running',
  createdAt: 1,
  createRequestId: 'tab-req',
} as any

const REOPEN_SESSION_TYPE_CASES = [
  {
    provider: 'claude',
    cliSessionType: 'claude',
    freshSessionType: 'freshclaude',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    freshLabel: 'Reopen as freshclaude',
    cliLabel: 'Reopen as Claude CLI',
  },
  {
    provider: 'codex',
    cliSessionType: 'codex',
    freshSessionType: 'freshcodex',
    sessionId: 'codex-thread-1',
    freshLabel: 'Reopen as freshcodex',
    cliLabel: 'Reopen as Codex CLI',
  },
  {
    provider: 'opencode',
    cliSessionType: 'opencode',
    freshSessionType: 'freshopencode',
    sessionId: 'ses_opencode_1',
    freshLabel: 'Reopen as freshopencode',
    cliLabel: 'Reopen as OpenCode CLI',
  },
] as const

describe('resolveReopenPaneSessionTarget', () => {
  for (const entry of REOPEN_SESSION_TYPE_CASES) {
    it(`resolves ${entry.cliSessionType} CLI panes to ${entry.freshSessionType}`, () => {
      const content: PaneContent = {
        kind: 'terminal',
        mode: entry.cliSessionType,
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        sessionRef: { provider: entry.provider, sessionId: entry.sessionId },
        initialCwd: '/repo',
      }

      expect(resolveReopenPaneSessionTarget({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content,
        tab,
        activity: { isBusy: false },
      })).toMatchObject({
        sourceSessionType: entry.cliSessionType,
        targetSessionType: entry.freshSessionType,
        provider: entry.provider,
        sessionId: entry.sessionId,
        label: entry.freshLabel,
        disabled: false,
      })
    })

    it(`resolves ${entry.freshSessionType} panes to ${entry.cliSessionType} CLI`, () => {
      const content: PaneContent = {
        kind: 'fresh-agent',
        sessionType: entry.freshSessionType,
        provider: entry.provider,
        sessionRef: { provider: entry.provider, sessionId: entry.sessionId },
        createRequestId: 'req-1',
        status: 'idle',
        initialCwd: '/repo',
      }

      expect(resolveReopenPaneSessionTarget({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content,
        tab,
        activity: { isBusy: false },
      })).toMatchObject({
        sourceSessionType: entry.freshSessionType,
        targetSessionType: entry.cliSessionType,
        provider: entry.provider,
        sessionId: entry.sessionId,
        label: entry.cliLabel,
        disabled: false,
      })
    })
  }

  it('resolves a Claude CLI pane to freshclaude using canonical sessionRef', () => {
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'claude',
      terminalId: 'term-1',
      createRequestId: 'req-1',
      status: 'running',
      sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
      initialCwd: '/repo',
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab,
      activity: { isBusy: false },
    })).toMatchObject({
      sourceSessionType: 'claude',
      targetSessionType: 'freshclaude',
      provider: 'claude',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      label: 'Reopen as freshclaude',
      disabled: false,
    })
  })

  it('does not use a FreshAgent internal sessionId without a durable sessionRef or resumeSessionId', () => {
    const content: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: 'runtime-sdk-session-id',
      createRequestId: 'req-1',
      status: 'idle',
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab,
      activity: { isBusy: false },
    })).toBeNull()
  })

  it('uses durable tab sessionRef fallback for FreshAgent panes without pane-local durable refs', () => {
    const content: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: 'runtime-sdk-session-id',
      createRequestId: 'req-1',
      status: 'idle',
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab: {
        ...tab,
        sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
      },
      activity: { isBusy: false },
    })).toMatchObject({
      sourceSessionType: 'freshclaude',
      targetSessionType: 'claude',
      provider: 'claude',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      label: 'Reopen as Claude CLI',
      disabled: false,
    })
  })

  it('uses tab cwd fallback for FreshAgent tab sessionRef reopen targets', () => {
    const content: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: 'runtime-sdk-session-id',
      createRequestId: 'req-1',
      status: 'idle',
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab: {
        ...tab,
        initialCwd: '/repo/from-tab',
        sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
      },
      activity: { isBusy: false },
    })).toMatchObject({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      cwd: '/repo/from-tab',
    })
  })

  it('rejects FreshAgent tab fallback placeholders', () => {
    const content: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'runtime-sdk-session-id',
      createRequestId: 'req-1',
      status: 'idle',
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab: {
        ...tab,
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
      },
      activity: { isBusy: false },
    })).toBeNull()
  })

  it('rejects FreshOpenCode placeholders and accepts materialized ses ids', () => {
    const placeholder: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
      createRequestId: 'req-1',
      status: 'idle',
    }
    const durable: PaneContent = {
      ...placeholder,
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: placeholder,
      tab,
      activity: { isBusy: false },
    })).toBeNull()
    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: durable,
      tab,
      activity: { isBusy: false },
    })).toMatchObject({ targetSessionType: 'opencode', sessionId: 'ses_real_1' })
  })

  it('disables reopen when the source pane has active work or waiting user decisions', () => {
    const content: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshcodex',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'codex-thread-1' },
      createRequestId: 'req-1',
      status: 'running',
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab,
      activity: { isBusy: true },
    })).toMatchObject({
      disabled: true,
      disabledReason: 'Agent is busy',
    })
    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab,
      activity: { isBusy: false, hasWaitingItems: true },
    })).toMatchObject({
      disabled: true,
      disabledReason: 'Agent is waiting for input',
    })
  })

  it('passes the resolved durable identity in the action payload', () => {
    const target = resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        createRequestId: 'req-1',
        status: 'exited',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-1' },
      },
      tab,
      activity: { isBusy: false },
    })

    expect(target).toMatchObject({
      tabId: 'tab-1',
      paneId: 'pane-1',
      provider: 'codex',
      sessionId: 'codex-thread-1',
      targetSessionType: 'freshcodex',
    })
  })

  it('prefers pane-local Codex durability over stale tab sessionRef fallback', () => {
    const target = resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        createRequestId: 'req-1',
        status: 'exited',
        codexDurability: {
          schemaVersion: 1,
          state: 'durable',
          durableThreadId: 'actual-thread',
        },
      },
      tab: {
        ...tab,
        mode: 'codex',
        sessionRef: { provider: 'codex', sessionId: 'stale-thread' },
      },
      activity: { isBusy: false },
    })

    expect(target).toMatchObject({
      provider: 'codex',
      sessionId: 'actual-thread',
      targetSessionType: 'freshcodex',
    })
  })

  it('uses tab cwd fallback for terminal tab sessionRef reopen targets', () => {
    const target = resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'claude',
        createRequestId: 'req-1',
        status: 'exited',
      },
      tab: {
        ...tab,
        initialCwd: '/repo/from-tab',
        sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
      },
      activity: { isBusy: false },
    })

    expect(target).toMatchObject({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      targetSessionType: 'freshclaude',
      cwd: '/repo/from-tab',
    })
  })

  it('does not use a raw Codex resumeSessionId without durable proof', () => {
    const unproven = resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        createRequestId: 'req-1',
        status: 'exited',
        resumeSessionId: 'codex-thread-1',
      },
      tab,
      activity: { isBusy: false },
    })
    const proven = resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        createRequestId: 'req-1',
        status: 'exited',
        resumeSessionId: 'codex-thread-1',
        codexDurability: {
          schemaVersion: 1,
          state: 'durable',
          durableThreadId: 'codex-thread-1',
        },
      },
      tab,
      activity: { isBusy: false },
    })

    expect(unproven).toBeNull()
    expect(proven).toMatchObject({ provider: 'codex', sessionId: 'codex-thread-1' })
  })
})
