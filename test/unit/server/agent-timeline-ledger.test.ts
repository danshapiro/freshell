// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createRestoreLedgerManager } from '../../../server/agent-timeline/ledger.js'
import type { SdkSessionState } from '../../../server/sdk-bridge-types.js'
import type { ChatMessage } from '../../../server/session-history-loader.js'

function makeMessage(
  role: 'user' | 'assistant',
  text: string,
  options: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp: '2026-04-03T12:00:00.000Z',
    ...options,
  }
}

function makeSession(
  overrides: Partial<SdkSessionState> & Pick<SdkSessionState, 'sessionId' | 'messages'>,
): SdkSessionState {
  return {
    sessionId: overrides.sessionId,
    status: 'running',
    createdAt: 1,
    messages: overrides.messages,
    streamingActive: false,
    streamingText: '',
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    costUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  }
}

describe('restore ledger manager', () => {
  it('returns typed missing outcomes with explicit restore codes', async () => {
    const manager = createRestoreLedgerManager({
      loadSessionHistory: vi.fn().mockResolvedValue(null),
      getLiveSessionBySdkSessionId: () => undefined,
      getLiveSessionByCliSessionId: () => undefined,
    })

    await expect(manager.resolve('missing-session')).resolves.toEqual({
      kind: 'missing',
      code: 'RESTORE_NOT_FOUND',
    })
  })

  it('returns typed live-only, merged, and durable-only restore outcomes while upgrading aliases in place', async () => {
    const liveSession = makeSession({
      sessionId: 'sdk-live',
      resumeSessionId: 'named-resume-token',
      messages: [
        makeMessage('user', 'draft prompt', { messageId: 'live-user-1' }),
      ],
    })

    const durableMessages = [
      makeMessage('user', 'older prompt', { messageId: 'durable-user-1' }),
      makeMessage('assistant', 'older answer', { messageId: 'durable-assistant-1' }),
    ]

    const loadSessionHistory = vi.fn(async (sessionId: string) => {
      if (sessionId === 'named-resume-token') return null
      if (sessionId === '00000000-0000-4000-8000-000000000123') return durableMessages
      return null
    })

    const manager = createRestoreLedgerManager({
      loadSessionHistory,
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => {
        if (queryId === liveSession.resumeSessionId || queryId === liveSession.cliSessionId) return liveSession
        return undefined
      },
    })

    const liveOnly = await manager.resolve('sdk-live')
    expect(liveOnly).toMatchObject({
      kind: 'resolved',
      readiness: 'live_only',
      liveSessionId: 'sdk-live',
      timelineSessionId: 'named-resume-token',
    })
    if (liveOnly.kind !== 'resolved') throw new Error('expected resolved')
    const initialRevision = liveOnly.revision

    liveSession.cliSessionId = '00000000-0000-4000-8000-000000000123'
    liveSession.messages.push(makeMessage('assistant', 'new live reply', { messageId: 'live-assistant-2' }))

    const merged = await manager.resolve('named-resume-token')
    expect(merged).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-live',
      timelineSessionId: '00000000-0000-4000-8000-000000000123',
    })
    if (merged.kind !== 'resolved') throw new Error('expected resolved')
    expect(merged.revision).toBeGreaterThan(initialRevision)
    expect(merged.turns.map((turn) => turn.messageId)).toEqual([
      'durable-user-1',
      'durable-assistant-1',
      'live-user-1',
      'live-assistant-2',
    ])

    manager.teardownLiveSession('sdk-live', { recoverable: true })

    const stillLive = await manager.resolve('sdk-live')
    expect(stillLive).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-live',
      timelineSessionId: '00000000-0000-4000-8000-000000000123',
    })
    if (stillLive.kind !== 'resolved') throw new Error('expected resolved')
    expect(stillLive.turns.map((turn) => turn.messageId)).toEqual([
      'durable-user-1',
      'durable-assistant-1',
      'live-user-1',
      'live-assistant-2',
    ])
  })

  it('keeps synthesized durable ids stable across equivalent JSONL rewrites and preserves upstream ids', async () => {
    const firstDurable = [
      makeMessage('user', 'hello  \r\nworld', { timestamp: '2026-04-03T12:00:00.000Z' }),
      makeMessage('assistant', 'reply', { messageId: 'upstream-assistant-id' }),
    ]
    const rewrittenDurable = [
      makeMessage('user', 'hello  \nworld', { timestamp: '2026-04-03T18:00:00.000Z' }),
      makeMessage('assistant', 'reply', { messageId: 'upstream-assistant-id' }),
    ]

    const manager = createRestoreLedgerManager({
      loadSessionHistory: vi.fn()
        .mockResolvedValueOnce(firstDurable)
        .mockResolvedValueOnce(rewrittenDurable),
      getLiveSessionBySdkSessionId: () => undefined,
      getLiveSessionByCliSessionId: () => undefined,
    })

    const first = await manager.resolve('00000000-0000-4000-8000-000000000124')
    const second = await manager.resolve('00000000-0000-4000-8000-000000000124')

    expect(first).toMatchObject({ kind: 'resolved', readiness: 'durable_only' })
    expect(second).toMatchObject({ kind: 'resolved', readiness: 'durable_only' })
    if (first.kind !== 'resolved' || second.kind !== 'resolved') throw new Error('expected resolved')
    expect(first.turns[0]?.messageId).toBe(second.turns[0]?.messageId)
    expect(first.turns[1]?.messageId).toBe('upstream-assistant-id')
    expect(second.turns[1]?.messageId).toBe('upstream-assistant-id')
  })

  it('removes unrecoverable live aliases so stale in-memory authority cannot outlive the session', async () => {
    const liveSession = makeSession({
      sessionId: 'sdk-gone',
      resumeSessionId: 'named-only',
      messages: [makeMessage('user', 'ephemeral', { messageId: 'live-msg-1' })],
    })

    const manager = createRestoreLedgerManager({
      loadSessionHistory: vi.fn().mockResolvedValue(null),
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => (queryId === liveSession.resumeSessionId ? liveSession : undefined),
    })

    const beforeTeardown = await manager.resolve('named-only')
    expect(beforeTeardown).toMatchObject({ kind: 'resolved', readiness: 'live_only' })

    manager.teardownLiveSession('sdk-gone', { recoverable: false })

    const afterTeardown = await manager.resolve('named-only')
    expect(afterTeardown).toEqual({ kind: 'missing', code: 'RESTORE_NOT_FOUND' })
  })

  it('upgrades idless live turns to the authoritative durable ids without duplicating the conversation', async () => {
    const livePrompt = makeMessage('user', 'draft prompt')
    const durablePrompt = makeMessage('user', 'draft prompt', { messageId: 'durable-upstream-1' })
    const liveSession = makeSession({
      sessionId: 'sdk-upgrade',
      resumeSessionId: 'named-upgrade',
      messages: [livePrompt],
    })

    const loadSessionHistory = vi.fn(async (sessionId: string) => {
      if (sessionId === 'named-upgrade') return null
      if (sessionId === '00000000-0000-4000-8000-000000000777') return [durablePrompt]
      return null
    })

    const manager = createRestoreLedgerManager({
      loadSessionHistory,
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => {
        if (queryId === liveSession.resumeSessionId || queryId === liveSession.cliSessionId) return liveSession
        return undefined
      },
    })

    const liveOnly = await manager.resolve('sdk-upgrade')
    expect(liveOnly).toMatchObject({
      kind: 'resolved',
      readiness: 'live_only',
    })

    liveSession.cliSessionId = '00000000-0000-4000-8000-000000000777'
    const upgraded = await manager.resolve('00000000-0000-4000-8000-000000000777')

    expect(upgraded).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      timelineSessionId: '00000000-0000-4000-8000-000000000777',
    })
    if (upgraded.kind !== 'resolved') throw new Error('expected resolved')
    expect(upgraded.turns.map((turn) => turn.messageId)).toEqual(['durable-upstream-1'])
  })

  it('classifies ambiguous compatibility overlap as RESTORE_DIVERGED instead of inventing alternate history', async () => {
    const durablePrompt = makeMessage('user', 'alpha', { messageId: 'durable-alpha' })
    const durableReply = makeMessage('assistant', 'omega', { messageId: 'durable-omega' })
    const liveSession = makeSession({
      sessionId: 'sdk-diverged',
      cliSessionId: '00000000-0000-4000-8000-000000000909',
      messages: [
        makeMessage('user', 'alpha', { messageId: 'live-alpha-0' }),
        makeMessage('assistant', 'interleaved live delta'),
        makeMessage('assistant', 'omega', { messageId: 'live-omega-0' }),
      ],
    })
    const logDivergence = vi.fn()

    const manager = createRestoreLedgerManager({
      loadSessionHistory: vi.fn().mockResolvedValue([durablePrompt, durableReply]),
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => (queryId === liveSession.cliSessionId ? liveSession : undefined),
      logDivergence,
    })

    await expect(manager.resolve('sdk-diverged')).resolves.toEqual({
      kind: 'fatal',
      code: 'RESTORE_DIVERGED',
      message: 'Live restore state diverged from durable history',
    })
    expect(logDivergence).toHaveBeenCalledWith(expect.objectContaining({
      queryId: 'sdk-diverged',
      reason: 'ambiguous-live-overlap',
    }))
  })
})
