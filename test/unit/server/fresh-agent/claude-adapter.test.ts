import { describe, expect, it, vi } from 'vitest'

import { createClaudeFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/claude/adapter.js'

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
      timelineService: {
        getSnapshot: vi.fn(),
        getTimelinePage: vi.fn(),
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
})
