// @vitest-environment node
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createFreshAgentProviderRegistry } from '../../../server/fresh-agent/provider-registry.js'
import { createFreshAgentRouter } from '../../../server/fresh-agent/router.js'
import { FreshAgentRuntimeManager } from '../../../server/fresh-agent/runtime-manager.js'
import { createClaudeFreshAgentAdapter } from '../../../server/fresh-agent/adapters/claude/adapter.js'
import {
  ClaudeFreshAgentHistoryResolutionError,
  ClaudeFreshAgentStaleHistoryRevisionError,
  createClaudeFreshAgentHistoryService,
} from '../../../server/fresh-agent/history/claude/history-service.js'
import type { ChatMessage } from '../../../server/session-history-loader.js'
import type { FreshAgentRuntimeAdapter } from '../../../server/fresh-agent/runtime-adapter.js'

function makeApp(adapter: FreshAgentRuntimeAdapter) {
  const registry = createFreshAgentProviderRegistry([
    {
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      adapter,
    },
  ])
  const runtimeManager = new FreshAgentRuntimeManager({ registry })
  const app = express()
  app.use(express.json())
  app.use('/api', createFreshAgentRouter({ runtimeManager }))
  return app
}

function makeTextMessage(index: number): ChatMessage {
  return {
    role: index % 2 === 0 ? 'user' : 'assistant',
    timestamp: `2026-03-10T10:${String(index).padStart(2, '0')}:00.000Z`,
    messageId: `message-${index}`,
    content: [{ type: 'text', text: `turn body ${index}` }],
  }
}

function makeResolvedHistory(messageCount: number) {
  return {
    kind: 'resolved' as const,
    queryId: 'thread-parity',
    timelineSessionId: '00000000-0000-4000-8000-000000000888',
    readiness: 'durable_only' as const,
    revision: 7,
    latestTurnId: `turn:message-${messageCount - 1}`,
    turns: Array.from({ length: messageCount }, (_, index) => ({
      turnId: `turn-${index}`,
      messageId: `message-${index}`,
      ordinal: index,
      source: 'durable' as const,
      message: makeTextMessage(index),
    })),
  }
}

function encodeCursor(payload: { offset: number; revision: number }) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

describe('fresh-agent Claude history route parity', () => {
  it.each([
    ['not-found', 404, 'RESTORE_NOT_FOUND'],
    ['unavailable', 503, 'RESTORE_UNAVAILABLE'],
    ['diverged', 409, 'RESTORE_DIVERGED'],
    ['stale', 409, 'RESTORE_STALE_REVISION'],
  ] as const)('maps %s restore failures through fresh-agent thread routes', async (threadId, status, code) => {
    const adapter = {
      runtimeProvider: 'claude',
      create: vi.fn(),
      getSnapshot: vi.fn(async () => {
        switch (threadId) {
          case 'not-found':
            throw new ClaudeFreshAgentHistoryResolutionError('RESTORE_NOT_FOUND', 'Restore session not found')
          case 'unavailable':
            throw new ClaudeFreshAgentHistoryResolutionError('RESTORE_UNAVAILABLE', 'Restore history unavailable')
          case 'diverged':
            throw new ClaudeFreshAgentHistoryResolutionError('RESTORE_DIVERGED', 'Restore history diverged')
          case 'stale':
            throw new ClaudeFreshAgentStaleHistoryRevisionError(1, 8)
        }
      }),
    } as unknown as FreshAgentRuntimeAdapter
    const app = makeApp(adapter)

    const response = await request(app)
      .get(`/api/fresh-agent/threads/freshclaude/claude/${threadId}?revision=1`)

    expect(response.status).toBe(status)
    expect(response.body.code).toBe(code)
    if (code === 'RESTORE_STALE_REVISION') {
      expect(response.body.currentRevision).toBe(8)
    }
  })

  it('preserves paged turns, inline bodies, turn body lookup, revision pinning, cursor checks, and limits', async () => {
    const historySource = {
      resolve: vi.fn().mockResolvedValue(makeResolvedHistory(35)),
    }
    const historyService = createClaudeFreshAgentHistoryService({
      agentHistorySource: historySource,
    })
    const adapter = createClaudeFreshAgentAdapter({
      sdkBridge: {
        getSession: vi.fn(),
        findSessionByCliSessionId: vi.fn(),
      } as any,
      historyService,
    })
    const app = makeApp(adapter)

    const defaultPage = await request(app)
      .get('/api/fresh-agent/threads/freshclaude/claude/thread-parity/turns?revision=7')

    expect(defaultPage.status).toBe(200)
    expect(defaultPage.body.revision).toBe(7)
    expect(defaultPage.body.turns).toHaveLength(20)
    expect(defaultPage.body.turns.map((turn: { turnId: string }) => turn.turnId)).toEqual(
      Array.from({ length: 20 }, (_, offset) => `turn-${15 + offset}`),
    )
    expect(defaultPage.body.nextCursor).toEqual(expect.any(String))

    const maxPage = await request(app)
      .get('/api/fresh-agent/threads/freshclaude/claude/thread-parity/turns?revision=7&limit=30')

    expect(maxPage.status).toBe(200)
    expect(maxPage.body.turns).toHaveLength(30)

    const inlineBodies = await request(app)
      .get('/api/fresh-agent/threads/freshclaude/claude/thread-parity/turns?includeBodies=true&revision=7&limit=2')

    expect(inlineBodies.status).toBe(200)
    expect(inlineBodies.body.revision).toBe(7)
    expect(inlineBodies.body.nextCursor).toEqual(expect.any(String))
    expect(inlineBodies.body.turns.map((turn: { turnId: string }) => turn.turnId)).toEqual(['turn-33', 'turn-34'])
    expect(Object.keys(inlineBodies.body.bodies).sort()).toEqual(['turn-33', 'turn-34'])
    expect(inlineBodies.body.bodies['turn-34'].items[0]).toMatchObject({
      kind: 'text',
      text: 'turn body 34',
    })

    const turnBody = await request(app)
      .get('/api/fresh-agent/threads/freshclaude/claude/thread-parity/turns/turn-34?revision=7')

    expect(turnBody.status).toBe(200)
    expect(turnBody.body.turnId).toBe('turn-34')
    expect(turnBody.body.revision).toBe(7)
    expect(turnBody.body.items[0]).toMatchObject({
      kind: 'text',
      text: 'turn body 34',
    })

    const missingTurnBody = await request(app)
      .get('/api/fresh-agent/threads/freshclaude/claude/thread-parity/turns/turn-missing?revision=7')

    expect(missingTurnBody.status).toBe(404)

    const unpinnedPage = await request(app)
      .get('/api/fresh-agent/threads/freshclaude/claude/thread-parity/turns')

    expect(unpinnedPage.status).toBe(200)
    expect(unpinnedPage.body.revision).toBe(7)

    const cursorWithoutRevision = await request(app)
      .get(`/api/fresh-agent/threads/freshclaude/claude/thread-parity/turns?cursor=${encodeURIComponent(defaultPage.body.nextCursor)}`)

    expect(cursorWithoutRevision.status).toBe(400)

    const unpinnedTurnBody = await request(app)
      .get('/api/fresh-agent/threads/freshclaude/claude/thread-parity/turns/turn-34')

    expect(unpinnedTurnBody.status).toBe(400)

    const malformedCursor = await request(app)
      .get('/api/fresh-agent/threads/freshclaude/claude/thread-parity/turns?revision=7&cursor=not-a-valid-cursor')

    expect(malformedCursor.status).toBe(400)
    expect(malformedCursor.body.error).toMatch(/cursor/i)

    const staleCursor = encodeCursor({ offset: 1, revision: 6 })
    const cursorMismatch = await request(app)
      .get(`/api/fresh-agent/threads/freshclaude/claude/thread-parity/turns?revision=7&cursor=${encodeURIComponent(staleCursor)}`)

    expect(cursorMismatch.status).toBe(409)
    expect(cursorMismatch.body).toMatchObject({
      code: 'RESTORE_STALE_REVISION',
      currentRevision: 7,
    })
  })
})
