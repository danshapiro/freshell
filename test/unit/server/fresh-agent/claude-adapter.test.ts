import { describe, expect, it, vi } from 'vitest'

import { createClaudeFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/claude/adapter.js'
import { makeClaudeLiveSession, makeClaudeRestoreResolution } from '../../../fixtures/fresh-agent/claude/thread.js'

describe('Claude fresh-agent adapter', () => {
  it('delegates create, resume, send, interrupt, and interactive responses to the sdk bridge', async () => {
    const sdkBridge = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'sdk-claude-1' }),
      subscribe: vi.fn().mockReturnValue({ off: vi.fn(), replayed: false }),
      sendUserMessage: vi.fn().mockReturnValue(true),
      interrupt: vi.fn().mockReturnValue(true),
      respondQuestion: vi.fn().mockReturnValue(true),
      respondPermission: vi.fn().mockReturnValue(true),
    }

    const adapter = createClaudeFreshAgentAdapter({
      sdkBridge: sdkBridge as any,
      historyService: {
        getSnapshot: vi.fn(),
        getThreadTurnPage: vi.fn(),
        getTurnBody: vi.fn(),
      } as any,
    })

    await expect(adapter.create({
      requestId: 'req-1',
      sessionType: 'freshclaude',
      cwd: '/repo',
      model: 'claude-sonnet-4-5-20250929',
      permissionMode: 'plan',
      plugins: ['/tmp/plugin-a'],
    })).resolves.toEqual({ sessionId: 'sdk-claude-1' })

    await expect(adapter.resume?.({
      requestId: 'req-2',
      sessionType: 'freshclaude',
      resumeSessionId: 'resume-claude-1',
    })).resolves.toEqual({ sessionId: 'sdk-claude-1' })

    const listener = vi.fn()
    const off = await adapter.subscribe?.('sdk-claude-1', listener)
    await adapter.send?.('sdk-claude-1', { text: 'hello' })
    await adapter.interrupt?.('sdk-claude-1')
    await adapter.answerQuestion?.('sdk-claude-1', 'question-1', { Proceed: 'Yes' })
    await adapter.resolveApproval?.('sdk-claude-1', 'approval-1', { behavior: 'allow' })

    expect(typeof off).toBe('function')
    expect(sdkBridge.createSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cwd: '/repo',
      model: 'claude-sonnet-4-5-20250929',
      permissionMode: 'plan',
      plugins: ['/tmp/plugin-a'],
    }))
    expect(sdkBridge.createSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      resumeSessionId: 'resume-claude-1',
    }))
    expect(sdkBridge.subscribe).toHaveBeenCalledWith('sdk-claude-1', listener)
    expect(sdkBridge.sendUserMessage).toHaveBeenCalledWith('sdk-claude-1', 'hello', undefined)
    expect(sdkBridge.interrupt).toHaveBeenCalledWith('sdk-claude-1')
    expect(sdkBridge.respondQuestion).toHaveBeenCalledWith('sdk-claude-1', 'question-1', { Proceed: 'Yes' })
    expect(sdkBridge.respondPermission).toHaveBeenCalledWith('sdk-claude-1', 'approval-1', { behavior: 'allow' })
  })

  it('normalizes Freshclaude effort values against the active model', async () => {
    const sdkBridge = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'sdk-claude-1' }),
    }

    const adapter = createClaudeFreshAgentAdapter({
      sdkBridge: sdkBridge as any,
      historyService: {
        getSnapshot: vi.fn(),
        getThreadTurnPage: vi.fn(),
        getTurnBody: vi.fn(),
      } as any,
    })

    await expect(adapter.create({
      requestId: 'req-1',
      sessionType: 'freshclaude',
      model: 'opus[1m]',
      effort: 'bogus',
    })).resolves.toEqual({ sessionId: 'sdk-claude-1' })

    expect(sdkBridge.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: 'opus[1m]',
      effort: 'high',
    }))
  })

  it('uses a Claude.ai-compatible default effort for fresh Freshclaude sessions', async () => {
    const sdkBridge = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'sdk-claude-1' }),
    }

    const adapter = createClaudeFreshAgentAdapter({
      sdkBridge: sdkBridge as any,
      historyService: {
        getSnapshot: vi.fn(),
        getThreadTurnPage: vi.fn(),
        getTurnBody: vi.fn(),
      } as any,
    })

    await adapter.create({
      requestId: 'req-default',
      sessionType: 'freshclaude',
    })
    await adapter.create({
      requestId: 'req-persisted-max',
      sessionType: 'freshclaude',
      model: 'opus[1m]',
      effort: 'max',
    })
    await adapter.resume?.({
      requestId: 'req-resume-persisted-max',
      sessionType: 'freshclaude',
      resumeSessionId: 'resume-claude-1',
      model: 'opus[1m]',
      effort: 'max',
    })

    expect(sdkBridge.createSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
      effort: 'high',
    }))
    // 'max' is a legal opus[1m] effort, so a persisted max passes through
    // unchanged instead of clamping to the default
    expect(sdkBridge.createSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      effort: 'max',
    }))
    expect(sdkBridge.createSession).toHaveBeenNthCalledWith(3, expect.objectContaining({
      effort: 'max',
    }))
  })

  it('returns a live-only snapshot when durable restore diverges for an active CLI session', async () => {
    const liveSession = makeClaudeLiveSession({
      sessionId: 'sdk-live-only-1',
      cliSessionId: '00000000-0000-4000-8000-000000000222',
    })
    const sdkBridge = {
      getSession: vi.fn(),
      findSessionByCliSessionId: vi.fn((threadId: string) => (
        threadId === liveSession.cliSessionId ? liveSession : undefined
      )),
    }
    const agentHistorySource = {
      resolve: vi.fn().mockResolvedValue({
        kind: 'fatal',
        code: 'RESTORE_DIVERGED',
        message: 'Live restore state diverged from durable history',
      }),
    }
    const historyService = {
      getSnapshot: vi.fn().mockRejectedValue(new Error('history should not be loaded before live fallback')),
      getThreadTurnPage: vi.fn(),
      getTurnBody: vi.fn(),
    }

    const adapter = createClaudeFreshAgentAdapter({
      sdkBridge: sdkBridge as any,
      agentHistorySource: agentHistorySource as any,
      historyService: historyService as any,
    })

    const snapshot = await adapter.getSnapshot?.({
      sessionType: 'freshclaude',
      provider: 'claude',
      threadId: liveSession.cliSessionId!,
    })

    expect(historyService.getSnapshot).not.toHaveBeenCalled()
    expect(agentHistorySource.resolve).toHaveBeenCalledWith(liveSession.cliSessionId, {
      liveSessionOverride: liveSession,
    })
    expect(snapshot).toMatchObject({
      provider: 'claude',
      threadId: liveSession.cliSessionId,
      sessionId: liveSession.sessionId,
      status: liveSession.status,
      extensions: {
        claude: {
        liveSessionId: liveSession.sessionId,
        historySessionId: liveSession.cliSessionId,
        readiness: 'live_only',
      },
      },
    })
    // Scope truthfulness pin (Task z7j7-3): the NODE claude adapter has no
    // mid-session settings path (that is the Rust server's settings.update
    // sidecar frame), so it honestly advertises model/effort/permissionMode as
    // create-only and sandbox as unsupported.
    expect(snapshot).toMatchObject({
      capabilities: {
        settingScopes: {
          model: 'create-only',
          effort: 'create-only',
          permissionMode: 'create-only',
          sandbox: 'unsupported',
        },
      },
    })
    expect(snapshot?.turns.map((turn: { source: string }) => turn.source)).toEqual(['live'])
  })

  it('carries the session\'s published slash-command rows into the resolved snapshot', async () => {
    const liveSession = makeClaudeLiveSession({
      sessionId: 'sdk-cmds-1',
      cliSessionId: '00000000-0000-4000-8000-000000000333',
      commands: [
        { name: 'review', description: 'Review the current changes', argumentHint: '[file]' },
        { name: 'compact', description: 'Compact the conversation', argumentHint: '', aliases: ['compress-messages'] },
      ],
    })
    const sdkBridge = {
      getSession: vi.fn(),
      findSessionByCliSessionId: vi.fn((threadId: string) => (
        threadId === liveSession.cliSessionId ? liveSession : undefined
      )),
    }
    const agentHistorySource = {
      resolve: vi.fn().mockResolvedValue(makeClaudeRestoreResolution()),
    }

    const adapter = createClaudeFreshAgentAdapter({
      sdkBridge: sdkBridge as any,
      agentHistorySource: agentHistorySource as any,
      historyService: {
        getSnapshot: vi.fn(),
        getThreadTurnPage: vi.fn(),
        getTurnBody: vi.fn(),
      } as any,
    })

    const snapshot = await adapter.getSnapshot?.({
      sessionType: 'freshclaude',
      provider: 'claude',
      threadId: liveSession.cliSessionId!,
    })

    expect(snapshot.commands).toEqual([
      { name: 'review', description: 'Review the current changes', argumentHint: '[file]' },
      { name: 'compact', description: 'Compact the conversation', argumentHint: '', aliases: ['compress-messages'] },
    ])
  })
})
