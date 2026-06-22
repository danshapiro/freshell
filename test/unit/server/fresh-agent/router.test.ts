import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const observabilityMocks = vi.hoisted(() => ({
  recordFreshAgentObservabilityEvent: vi.fn(),
}))

vi.mock('../../../../server/fresh-agent/observability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../server/fresh-agent/observability.js')>()
  return { ...actual, recordFreshAgentObservabilityEvent: observabilityMocks.recordFreshAgentObservabilityEvent }
})

import { createCodexFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/codex/adapter.js'
import { FreshAgentProviderRegistry } from '../../../../server/fresh-agent/provider-registry.js'
import { createFreshAgentRouter } from '../../../../server/fresh-agent/router.js'
import { FreshAgentRuntimeManager, FreshAgentStaleThreadRevisionError } from '../../../../server/fresh-agent/runtime-manager.js'

function makeCodexThread(id: string, turns: unknown[] = []) {
  return {
    id,
    sessionId: id,
    preview: 'Codex summary',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1770000000,
    updatedAt: 7,
    status: { type: 'idle' },
    cwd: '/repo',
    cliVersion: 'codex-cli 0.129.0',
    source: 'appServer',
    turns,
  }
}

function makeMixedCodexTurn(id: string) {
  return {
    id,
    status: 'completed',
    items: [
      {
        type: 'userMessage',
        id: `${id}:user`,
        content: [{ type: 'text', text: 'Review the diff.' }],
      },
      {
        type: 'reasoning',
        id: `${id}:reasoning`,
        summary: ['Checking changes'],
        content: [],
      },
      {
        type: 'agentMessage',
        id: `${id}:assistant`,
        text: 'The patch is safe.',
      },
    ],
  }
}

function makeCodexTurn(id: string) {
  return {
    id,
    status: 'completed',
    items: [{
      type: 'agentMessage',
      id: `${id}:item-1`,
      text: 'Codex summary',
      phase: null,
      memoryCitation: null,
    }],
  }
}

describe('fresh-agent router', () => {
  it('returns 409 for stale thread revisions instead of mixing bodies from different revisions', async () => {
    const manager = {
      getTurnBody: vi.fn().mockRejectedValue(new FreshAgentStaleThreadRevisionError(7)),
    } as unknown as FreshAgentRuntimeManager

    const app = express()
    app.use('/api', createFreshAgentRouter({ runtimeManager: manager }))

    const response = await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-1/turns/turn-9?revision=4')

    expect(response.status).toBe(409)
    expect(response.body.code).toBe('STALE_THREAD_REVISION')
    expect(response.body.currentRevision).toBe(7)
  })

  it('serves Freshcodex split display turns and maps Codex boundary errors intentionally', async () => {
    const durableTurn = makeMixedCodexTurn('turn-1')
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-new-1', [durableTurn]),
      }),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: null,
        turns: [durableTurn],
      }),
      readThreadTurn: vi.fn().mockResolvedValue(durableTurn),
    }
    const adapter = createCodexFreshAgentAdapter({
      displayIdSecret: 'router-task-4-secret',
      runtime: runtime as any,
    })
    const registry = new FreshAgentProviderRegistry([{
      sessionType: 'freshcodex',
      runtimeProvider: 'codex',
      adapter,
    }])
    const runtimeManager = new FreshAgentRuntimeManager({ registry })
    const app = express()
    app.use('/api', createFreshAgentRouter({ runtimeManager }))

    const snapshot = await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-new-1')
      .expect(200)
    expect(snapshot.body.turns).toHaveLength(2)
    expect(snapshot.body.turns.map((turn: any) => turn.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(snapshot.body)).not.toContain('providerTurnId')

    const firstPage = await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-new-1/turns?revision=7&limit=1')
      .expect(200)
    expect(firstPage.body.turns).toHaveLength(1)
    expect(firstPage.body.turns[0]).toMatchObject({ role: 'user' })
    expect(firstPage.body.nextCursor).toMatch(/^codex-cursor:v1:/)
    expect(JSON.stringify(firstPage.body)).not.toContain('providerTurnId')

    const secondPage = await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-new-1/turns')
      .query({ revision: '7', limit: '1', cursor: firstPage.body.nextCursor })
      .expect(200)
    expect(secondPage.body.turns).toHaveLength(1)
    expect(secondPage.body.turns[0]).toMatchObject({ role: 'assistant' })
    expect(JSON.stringify(secondPage.body)).not.toContain('providerTurnId')

    const body = await request(app)
      .get(`/api/fresh-agent/threads/freshcodex/codex/thread-new-1/turns/${encodeURIComponent(secondPage.body.turns[0].turnId)}?revision=7`)
      .expect(200)
    expect(body.body).toMatchObject({
      turnId: secondPage.body.turns[0].turnId,
      role: 'assistant',
      threadId: 'thread-new-1',
      revision: 7,
    })
    expect(runtime.readThreadTurn).toHaveBeenCalledWith({
      threadId: 'thread-new-1',
      turnId: 'turn-1',
      revision: 7,
    })
    expect(JSON.stringify(body.body)).not.toContain('providerTurnId')

    runtime.readThreadTurn.mockResolvedValueOnce(makeCodexTurn('turn-1'))
    const unprovableBody = await request(app)
      .get(`/api/fresh-agent/threads/freshcodex/codex/thread-new-1/turns/${encodeURIComponent(secondPage.body.turns[0].turnId)}?revision=7`)
      .expect(409)
    expect(unprovableBody.body.code).toBe('UNPROVABLE_THREAD_REVISION')
    expect(unprovableBody.body.requestedRevision).toBe(7)

    const malformedCursor = await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-new-1/turns?revision=7&cursor=bad-cursor')
      .expect(400)
    expect(malformedCursor.body.code).toBe('INVALID_TURN_CURSOR')

    const malformedDisplayId = await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-new-1/turns/codex-display:v1:not-a-valid-envelope?revision=7')
      .expect(400)
    expect(malformedDisplayId.body.code).toBe('INVALID_DISPLAY_ID')

    runtime.listThreadTurns.mockResolvedValueOnce({
      revision: 9,
      nextCursor: null,
      turns: [durableTurn],
    })
    const staleRevision = await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-new-1/turns/codex-display:v1:abcdefghijklmnopqrstu1?revision=7')
      .expect(409)
    expect(staleRevision.body.code).toBe('STALE_THREAD_REVISION')

    const ambiguousNativeId = await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-new-1/turns/turn-1?revision=7')
      .expect(409)
    expect(ambiguousNativeId.body.code).toBe('AMBIGUOUS_NATIVE_TURN_ID')

    runtime.listThreadTurns.mockResolvedValueOnce({
      revision: 7,
      nextCursor: null,
      turns: [durableTurn],
    })
    const exactMiss = await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-new-1/turns/codex-display:v1:abcdefghijklmnopqrstu1?revision=7')
      .expect(404)
    expect(exactMiss.body.code).toBe('TURN_NOT_FOUND')
  })
})

describe('fresh-agent router: snapshot served observability', () => {
  function findSnapshotServedEvents(): Array<Record<string, unknown>> {
    return observabilityMocks.recordFreshAgentObservabilityEvent.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .filter((event) => event.kind === 'fresh_agent_snapshot_served')
  }

  it('logs fresh_agent_snapshot_served with metadata when a snapshot is served', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const durableTurn = makeMixedCodexTurn('turn-1')
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-snap-1', [durableTurn]),
      }),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: null,
        turns: [durableTurn],
      }),
      readThreadTurn: vi.fn().mockResolvedValue(durableTurn),
    }
    const adapter = createCodexFreshAgentAdapter({
      displayIdSecret: 'router-snap-secret',
      runtime: runtime as any,
    })
    const registry = new FreshAgentProviderRegistry([{
      sessionType: 'freshcodex',
      runtimeProvider: 'codex',
      adapter,
    }])
    const runtimeManager = new FreshAgentRuntimeManager({ registry })
    const app = express()
    app.use('/api', createFreshAgentRouter({ runtimeManager }))

    await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-snap-1')
      .expect(200)

    const events = findSnapshotServedEvents()
    expect(events).toHaveLength(1)
    const payload = events[0]
    expect(payload.provider).toBe('codex')
    expect(payload.sessionType).toBe('freshcodex')
    expect(payload.httpStatus).toBe(200)
    expect(payload.turnCount).toBeGreaterThan(0)
    expect(payload.durationMs).toBeGreaterThanOrEqual(0)
    expect(payload.payloadBytes).toBeGreaterThan(0)
    expect(payload.threadIdHash).toBeDefined()
    // No raw thread id in the observability event
    expect(JSON.stringify(payload)).not.toContain('thread-snap-1')
  })

  it('does not log fresh_agent_snapshot_served when the snapshot request fails', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const manager = {
      getSnapshot: vi.fn().mockRejectedValue(new FreshAgentStaleThreadRevisionError(7)),
    } as unknown as FreshAgentRuntimeManager

    const app = express()
    app.use('/api', createFreshAgentRouter({ runtimeManager: manager }))

    await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-fail-1')
      .expect(409)

    expect(findSnapshotServedEvents()).toHaveLength(0)
  })

  it('includes lastTurnIdHash and revision when available', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const manager = {
      getSnapshot: vi.fn().mockResolvedValue({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'thread-snap-2',
        sessionId: 'ses_real_2',
        revision: 7,
        latestTurnId: 'msg_last_1',
        status: 'idle',
        turns: [{ id: 'msg_last_1', role: 'assistant' }],
      }),
    } as unknown as FreshAgentRuntimeManager

    const app = express()
    app.use('/api', createFreshAgentRouter({ runtimeManager: manager }))

    await request(app)
      .get('/api/fresh-agent/threads/freshopencode/opencode/thread-snap-2')
      .expect(200)

    const events = findSnapshotServedEvents()
    expect(events).toHaveLength(1)
    expect(events[0].lastTurnIdHash).toBeDefined()
    expect(events[0].revision).toBe(7)
    expect(JSON.stringify(events[0])).not.toContain('msg_last_1')
  })

  it('includes cwdHash when cwd query param is present', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const durableTurn = makeMixedCodexTurn('turn-cwd')
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-snap-cwd', [durableTurn]),
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({
      displayIdSecret: 'router-snap-secret-cwd',
      runtime: runtime as any,
    })
    const registry = new FreshAgentProviderRegistry([{
      sessionType: 'freshcodex',
      runtimeProvider: 'codex',
      adapter,
    }])
    const runtimeManager = new FreshAgentRuntimeManager({ registry })
    const app = express()
    app.use('/api', createFreshAgentRouter({ runtimeManager }))

    await request(app)
      .get('/api/fresh-agent/threads/freshcodex/codex/thread-snap-cwd?cwd=/repo/work')
      .expect(200)

    const events = findSnapshotServedEvents()
    expect(events).toHaveLength(1)
    expect(events[0].cwdHash).toBeDefined()
    expect(JSON.stringify(events[0])).not.toContain('/repo/work')
  })
})
