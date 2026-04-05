// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createDurableMessageFingerprint,
  createRestoreLedgerManager,
} from '../../../server/agent-timeline/ledger.js'
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
      getLiveSessionByCliSessionId: (queryId) => (
        queryId === liveSession.cliSessionId ? liveSession : undefined
      ),
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

    const namedAliasLiveOnly = await manager.resolve('named-resume-token')
    expect(namedAliasLiveOnly).toMatchObject({
      kind: 'resolved',
      readiness: 'live_only',
      liveSessionId: 'sdk-live',
      timelineSessionId: 'named-resume-token',
    })
    if (namedAliasLiveOnly.kind !== 'resolved') throw new Error('expected resolved')
    expect(namedAliasLiveOnly.revision).toBe(initialRevision)

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

    const namedAliasMerged = await manager.resolve('named-resume-token')
    expect(namedAliasMerged).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-live',
      timelineSessionId: '00000000-0000-4000-8000-000000000123',
    })
    if (namedAliasMerged.kind !== 'resolved') throw new Error('expected resolved')
    expect(namedAliasMerged.revision).toBe(merged.revision)
    expect(namedAliasMerged.turns.map((turn) => turn.messageId)).toEqual([
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

  it('promotes late durable backlog while one authoritative live ledger serves both aliases', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000424'
    const liveSession = makeSession({
      sessionId: 'sdk-authority',
      cliSessionId: canonicalSessionId,
      messages: [
        makeMessage('user', 'prompt', { messageId: 'live-user-1' }),
      ],
    })
    const durableBacklog = [
      makeMessage('assistant', 'older durable reply', { messageId: 'durable-assistant-1' }),
    ]
    const loadSessionHistory = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(durableBacklog)
      .mockResolvedValue(durableBacklog)

    const manager = createRestoreLedgerManager({
      loadSessionHistory,
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => (queryId === canonicalSessionId ? liveSession : undefined),
    })

    const first = await manager.resolve('sdk-authority')
    const second = await manager.resolve(canonicalSessionId)

    expect(first).toMatchObject({
      kind: 'resolved',
      readiness: 'live_only',
      liveSessionId: 'sdk-authority',
      timelineSessionId: canonicalSessionId,
    })
    expect(loadSessionHistory).toHaveBeenCalledTimes(2)
    expect(second).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-authority',
      timelineSessionId: canonicalSessionId,
    })
    if (first.kind !== 'resolved' || second.kind !== 'resolved') throw new Error('expected resolved')
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(second.turns.map((turn) => turn.messageId)).toEqual([
      'durable-assistant-1',
      'live-user-1',
    ])

    liveSession.messages.push(
      makeMessage('assistant', 'late live delta', { messageId: 'live-assistant-2' }),
    )
    await manager.syncLiveSession(liveSession)

    expect(loadSessionHistory).toHaveBeenCalledTimes(2)

    const third = await manager.resolve('sdk-authority')

    expect(loadSessionHistory).toHaveBeenCalledTimes(3)
    expect(third).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-authority',
      timelineSessionId: canonicalSessionId,
    })
    if (third.kind !== 'resolved') throw new Error('expected resolved')
    expect(third.revision).toBeGreaterThan(second.revision)
    expect(third.turns.map((turn) => turn.messageId)).toEqual([
      'durable-assistant-1',
      'live-user-1',
      'live-assistant-2',
    ])
  })

  it('refreshes a non-empty durable backlog while the live ledger remains authoritative', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000555'
    const liveSession = makeSession({
      sessionId: 'sdk-live-refresh',
      cliSessionId: canonicalSessionId,
      messages: [
        makeMessage('user', 'live prompt', { messageId: 'live-1' }),
      ],
    })
    const firstDurableBacklog = [
      makeMessage('user', 'durable one', { messageId: 'durable-1' }),
    ]
    const secondDurableBacklog = [
      makeMessage('user', 'durable one', { messageId: 'durable-1' }),
      makeMessage('assistant', 'durable two', { messageId: 'durable-2' }),
    ]
    const loadSessionHistory = vi.fn()
      .mockResolvedValueOnce(firstDurableBacklog)
      .mockResolvedValueOnce(secondDurableBacklog)
      .mockResolvedValue(secondDurableBacklog)

    const manager = createRestoreLedgerManager({
      loadSessionHistory,
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => (queryId === canonicalSessionId ? liveSession : undefined),
    })

    const first = await manager.resolve('sdk-live-refresh')
    const second = await manager.resolve('sdk-live-refresh')

    expect(loadSessionHistory).toHaveBeenCalledTimes(2)
    expect(first).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-live-refresh',
      timelineSessionId: canonicalSessionId,
    })
    expect(second).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-live-refresh',
      timelineSessionId: canonicalSessionId,
    })
    if (first.kind !== 'resolved' || second.kind !== 'resolved') throw new Error('expected resolved')
    expect(first.turns.map((turn) => turn.messageId)).toEqual([
      'durable-1',
      'live-1',
    ])
    expect(second.turns.map((turn) => turn.messageId)).toEqual([
      'durable-1',
      'durable-2',
      'live-1',
    ])
    expect(second.revision).toBeGreaterThan(first.revision)
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
    const loadSessionHistory = vi.fn()
      .mockResolvedValueOnce(firstDurable)
      .mockResolvedValueOnce(rewrittenDurable)

    const manager = createRestoreLedgerManager({
      loadSessionHistory,
      getLiveSessionBySdkSessionId: () => undefined,
      getLiveSessionByCliSessionId: () => undefined,
    })

    const first = await manager.resolve('00000000-0000-4000-8000-000000000124')
    const second = await manager.resolve('00000000-0000-4000-8000-000000000124')

    expect(first).toMatchObject({ kind: 'resolved', readiness: 'durable_only' })
    expect(second).toMatchObject({ kind: 'resolved', readiness: 'durable_only' })
    if (first.kind !== 'resolved' || second.kind !== 'resolved') throw new Error('expected resolved')
    expect(loadSessionHistory).toHaveBeenCalledTimes(2)
    expect(second.revision).toBe(first.revision)
    expect(first.turns[0]?.messageId).toBe(second.turns[0]?.messageId)
    expect(first.turns[1]?.messageId).toBe('upstream-assistant-id')
    expect(second.turns[1]?.messageId).toBe('upstream-assistant-id')
  })

  it('includes upstream parent/reference ids in durable fingerprints when present', () => {
    const baseMessage = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'same reply' }],
      model: 'claude',
    }

    expect(createDurableMessageFingerprint({
      ...baseMessage,
      parentId: 'parent-a',
      referenceId: 'ref-a',
    })).not.toBe(createDurableMessageFingerprint({
      ...baseMessage,
      parentId: 'parent-b',
      referenceId: 'ref-b',
    }))
  })

  it('rebuilds durable-only state from JSONL on repeated reads and bumps the revision when the transcript changes', async () => {
    const timelineSessionId = '00000000-0000-4000-8000-000000000998'
    const firstDurable = [
      makeMessage('user', 'first', { messageId: 'durable-1' }),
    ]
    const expandedDurable = [
      ...firstDurable,
      makeMessage('assistant', 'second', { messageId: 'durable-2' }),
    ]
    const loadSessionHistory = vi.fn()
      .mockResolvedValueOnce(firstDurable)
      .mockResolvedValueOnce(expandedDurable)

    const manager = createRestoreLedgerManager({
      loadSessionHistory,
      getLiveSessionBySdkSessionId: () => undefined,
      getLiveSessionByCliSessionId: () => undefined,
    })

    const first = await manager.resolve(timelineSessionId)
    const second = await manager.resolve(timelineSessionId)

    expect(first).toMatchObject({ kind: 'resolved', readiness: 'durable_only' })
    expect(second).toMatchObject({ kind: 'resolved', readiness: 'durable_only' })
    if (first.kind !== 'resolved' || second.kind !== 'resolved') throw new Error('expected resolved')
    expect(loadSessionHistory).toHaveBeenCalledTimes(2)
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(second.turns.map((turn) => turn.messageId)).toEqual(['durable-1', 'durable-2'])
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
      getLiveSessionByCliSessionId: () => undefined,
    })

    await expect(manager.resolve('sdk-gone')).resolves.toMatchObject({
      kind: 'resolved',
      readiness: 'live_only',
      liveSessionId: 'sdk-gone',
      timelineSessionId: 'named-only',
    })

    const beforeTeardown = await manager.resolve('named-only')
    expect(beforeTeardown).toMatchObject({ kind: 'resolved', readiness: 'live_only' })

    manager.teardownLiveSession('sdk-gone', { recoverable: false })

    const afterTeardown = await manager.resolve('named-only')
    expect(afterTeardown).toEqual({ kind: 'missing', code: 'RESTORE_NOT_FOUND' })
  })

  it('rebuilds durable-only history once a previously live canonical session is no longer live', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000123'
    let liveAvailable = true
    const liveSession = makeSession({
      sessionId: 'sdk-live',
      cliSessionId: canonicalSessionId,
      resumeSessionId: 'named-token',
      messages: [makeMessage('user', 'live prompt', { messageId: 'live-msg-1' })],
    })
    const loadSessionHistory = vi.fn().mockResolvedValue([
      makeMessage('user', 'durable prompt', { messageId: 'durable-msg-1' }),
    ])

    const manager = createRestoreLedgerManager({
      loadSessionHistory,
      getLiveSessionBySdkSessionId: (id) => (
        liveAvailable && id === liveSession.sessionId ? liveSession : undefined
      ),
      getLiveSessionByCliSessionId: (id) => (
        liveAvailable && (id === liveSession.cliSessionId || id === liveSession.resumeSessionId)
          ? liveSession
          : undefined
      ),
    })

    const first = await manager.resolve('sdk-live')
    expect(first).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-live',
      timelineSessionId: canonicalSessionId,
    })
    expect(loadSessionHistory).toHaveBeenCalledTimes(1)

    liveAvailable = false

    const second = await manager.resolve(canonicalSessionId)
    expect(second).toMatchObject({
      kind: 'resolved',
      readiness: 'durable_only',
      liveSessionId: undefined,
      timelineSessionId: canonicalSessionId,
    })
    if (second.kind !== 'resolved') throw new Error('expected resolved')
    expect(loadSessionHistory).toHaveBeenCalledTimes(2)
    expect(second.turns.map((turn) => turn.messageId)).toEqual(['durable-msg-1'])
  })

  it('stops resolving a stale named alias once canonical durable identity remains without a live session', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000777'
    let liveAvailable = true
    const liveSession = makeSession({
      sessionId: 'sdk-1',
      cliSessionId: canonicalSessionId,
      resumeSessionId: 'named-resume',
      messages: [makeMessage('user', 'hello')],
    })

    const manager = createRestoreLedgerManager({
      loadSessionHistory: vi.fn(async (sessionId: string) => (
        sessionId === canonicalSessionId
          ? [makeMessage('user', 'hello', { messageId: 'durable-hello' })]
          : null
      )),
      getLiveSessionBySdkSessionId: (id) => (
        liveAvailable && id === liveSession.sessionId ? liveSession : undefined
      ),
      getLiveSessionByCliSessionId: (id) => (
        liveAvailable && (id === liveSession.cliSessionId || id === liveSession.resumeSessionId)
          ? liveSession
          : undefined
      ),
    })

    await expect(manager.resolve('sdk-1')).resolves.toMatchObject({
      kind: 'resolved',
      liveSessionId: 'sdk-1',
      timelineSessionId: canonicalSessionId,
    })

    liveAvailable = false

    await expect(manager.resolve('named-resume')).resolves.toEqual({
      kind: 'missing',
      code: 'RESTORE_NOT_FOUND',
    })
    await expect(manager.resolve(canonicalSessionId)).resolves.toMatchObject({
      kind: 'resolved',
      readiness: 'durable_only',
      liveSessionId: undefined,
      timelineSessionId: canonicalSessionId,
    })
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

  it('reconciles a single compatible idless live turn with its durable canonical turn', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000999'
    const liveSession = makeSession({
      sessionId: 'sdk-direct',
      cliSessionId: canonicalSessionId,
      messages: [makeMessage('user', 'alpha')],
    })

    const manager = createRestoreLedgerManager({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'alpha', { messageId: 'durable-alpha' }),
      ]),
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => (queryId === canonicalSessionId ? liveSession : undefined),
    })

    const resolved = await manager.resolve('sdk-direct')

    expect(resolved).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-direct',
      timelineSessionId: canonicalSessionId,
    })
    if (resolved.kind !== 'resolved') throw new Error('expected resolved')
    expect(resolved.turns.map((turn) => turn.messageId)).toEqual(['durable-alpha'])
  })

  it('reconciles later durable catch-up for runtime live deltas after backlog promotion', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000998'
    const liveSession = makeSession({
      sessionId: 'sdk-catchup',
      cliSessionId: canonicalSessionId,
      messages: [
        makeMessage('user', 'alpha', { messageId: 'live:sdk-catchup:0' }),
        makeMessage('assistant', 'beta', { messageId: 'live:sdk-catchup:1' }),
      ],
    })

    const durableAfterPromotion = [
      makeMessage('user', 'alpha', { messageId: 'durable-alpha' }),
      makeMessage('assistant', 'beta', { messageId: 'durable-beta' }),
    ]
    const durableAfterCatchup = [
      ...durableAfterPromotion,
      makeMessage('user', 'gamma', { messageId: 'durable-gamma' }),
    ]
    const loadSessionHistory = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(durableAfterPromotion)
      .mockResolvedValueOnce(durableAfterPromotion)
      .mockResolvedValueOnce(durableAfterCatchup)
      .mockResolvedValue(durableAfterCatchup)

    const manager = createRestoreLedgerManager({
      loadSessionHistory,
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => (queryId === canonicalSessionId ? liveSession : undefined),
    })

    const first = await manager.resolve('sdk-catchup')
    expect(first).toMatchObject({
      kind: 'resolved',
      readiness: 'live_only',
      liveSessionId: 'sdk-catchup',
      timelineSessionId: canonicalSessionId,
    })

    const second = await manager.resolve('sdk-catchup')
    expect(second).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-catchup',
      timelineSessionId: canonicalSessionId,
    })
    if (second.kind !== 'resolved') throw new Error('expected resolved')
    expect(second.turns.map((turn) => turn.messageId)).toEqual([
      'durable-alpha',
      'durable-beta',
    ])

    liveSession.messages.push(makeMessage('user', 'gamma', { messageId: 'live:sdk-catchup:2' }))
    await manager.syncLiveSession(liveSession)

    const third = await manager.resolve('sdk-catchup')
    expect(third).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-catchup',
      timelineSessionId: canonicalSessionId,
    })
    if (third.kind !== 'resolved') throw new Error('expected resolved')
    expect(third.turns.map((turn) => turn.messageId)).toEqual([
      'durable-alpha',
      'durable-beta',
      'live:sdk-catchup:2',
    ])

    const fourth = await manager.resolve('sdk-catchup')
    expect(fourth).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-catchup',
      timelineSessionId: canonicalSessionId,
    })
    if (fourth.kind !== 'resolved') throw new Error('expected resolved')
    expect(fourth.turns.map((turn) => turn.messageId)).toEqual([
      'durable-alpha',
      'durable-beta',
      'durable-gamma',
    ])
    expect(fourth.revision).toBeGreaterThan(third.revision)
  })

  it('bumps the ledger revision when a canonical turn changes under a stable message id', async () => {
    const liveSession = makeSession({
      sessionId: 'sdk-revision',
      messages: [
        makeMessage('assistant', 'first', { messageId: 'live-msg-1' }),
      ],
    })

    const manager = createRestoreLedgerManager({
      loadSessionHistory: vi.fn().mockResolvedValue(null),
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: () => undefined,
    })

    const first = await manager.resolve('sdk-revision')
    if (first.kind !== 'resolved') throw new Error('expected resolved')

    liveSession.messages = [
      makeMessage('assistant', 'second', { messageId: 'live-msg-1' }),
    ]

    const second = await manager.resolve('sdk-revision')

    expect(second).toMatchObject({ kind: 'resolved' })
    if (second.kind !== 'resolved') throw new Error('expected resolved')
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(second.turns[0]?.message.content[0]).toEqual({ type: 'text', text: 'second' })
  })

  it('keeps repeated live content as a distinct turn when durable backlog already exists', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000555'
    const liveSession = makeSession({
      sessionId: 'sdk-repeat',
      cliSessionId: canonicalSessionId,
      messages: [
        makeMessage('user', 'hello', { messageId: 'live:sdk-repeat:0' }),
      ],
    })

    const manager = createRestoreLedgerManager({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'hello', { messageId: 'durable-hello-0' }),
      ]),
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => (queryId === canonicalSessionId ? liveSession : undefined),
    })

    const resolved = await manager.resolve('sdk-repeat')

    expect(resolved).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-repeat',
      timelineSessionId: canonicalSessionId,
    })
    if (resolved.kind !== 'resolved') throw new Error('expected resolved')
    expect(resolved.turns.map((turn) => turn.messageId)).toEqual([
      'durable-hello-0',
      'live:sdk-repeat:0',
    ])
  })

  it('drops live authority for durable aliases after unrecoverable teardown', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000123'
    const liveSession = makeSession({
      sessionId: 'sdk-kill',
      cliSessionId: canonicalSessionId,
      resumeSessionId: 'named-token',
      messages: [makeMessage('user', 'hello', { messageId: 'live-msg-1' })],
    })

    const manager = createRestoreLedgerManager({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'hello', { messageId: 'durable-msg-1' }),
      ]),
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => (queryId === canonicalSessionId ? liveSession : undefined),
    })

    const beforeTeardown = await manager.resolve('sdk-kill')
    expect(beforeTeardown).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      liveSessionId: 'sdk-kill',
      timelineSessionId: canonicalSessionId,
    })

    manager.teardownLiveSession('sdk-kill', { recoverable: false })

    const afterTeardown = await manager.resolve(canonicalSessionId)

    expect(afterTeardown).toMatchObject({
      kind: 'resolved',
      readiness: 'durable_only',
      timelineSessionId: canonicalSessionId,
    })
    if (afterTeardown.kind !== 'resolved') throw new Error('expected resolved')
    expect(afterTeardown.liveSessionId).toBeUndefined()
    expect(afterTeardown.turns.map((turn) => turn.messageId)).toEqual(['durable-msg-1'])
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

  it('classifies interleaved exact-id overlap as RESTORE_DIVERGED instead of reordering the transcript', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000919'
    const durablePrompt = makeMessage('user', 'alpha', { messageId: 'shared-alpha' })
    const durableReply = makeMessage('assistant', 'omega', { messageId: 'shared-omega' })
    const liveSession = makeSession({
      sessionId: 'sdk-exact-diverge',
      cliSessionId: canonicalSessionId,
      messages: [
        makeMessage('user', 'alpha', { messageId: 'shared-alpha' }),
        makeMessage('assistant', 'interleaved live delta', { messageId: 'live-delta' }),
        makeMessage('assistant', 'omega', { messageId: 'shared-omega' }),
      ],
    })
    const logDivergence = vi.fn()

    const manager = createRestoreLedgerManager({
      loadSessionHistory: vi.fn().mockResolvedValue([durablePrompt, durableReply]),
      getLiveSessionBySdkSessionId: (queryId) => (queryId === liveSession.sessionId ? liveSession : undefined),
      getLiveSessionByCliSessionId: (queryId) => (queryId === liveSession.cliSessionId ? liveSession : undefined),
      logDivergence,
    })

    await expect(manager.resolve('sdk-exact-diverge')).resolves.toEqual({
      kind: 'fatal',
      code: 'RESTORE_DIVERGED',
      message: 'Live restore state diverged from durable history',
    })
    expect(logDivergence).toHaveBeenCalledWith(expect.objectContaining({
      queryId: 'sdk-exact-diverge',
      reason: 'ambiguous-live-overlap',
    }))
  })
})
