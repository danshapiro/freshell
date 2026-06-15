// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createFreshAgentProviderRegistry } from '../../../server/fresh-agent/provider-registry.js'
import { createFreshAgentRouter } from '../../../server/fresh-agent/router.js'
import { FreshAgentRuntimeManager } from '../../../server/fresh-agent/runtime-manager.js'
import type { FreshAgentRuntimeAdapter } from '../../../server/fresh-agent/runtime-adapter.js'

const repoRoot = path.resolve(__dirname, '../../..')

function createProductionFreshAgentRouteApp() {
  const adapter = {
    runtimeProvider: 'claude',
    create: vi.fn(),
    getSnapshot: vi.fn(async (thread: { threadId: string }) => ({
      sessionType: 'freshclaude',
      provider: 'claude',
      threadId: thread.threadId,
      sessionId: thread.threadId,
      revision: 1,
      status: 'idle',
      capabilities: {
        send: true,
        interrupt: false,
        approvals: false,
        questions: false,
        fork: false,
      },
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      pendingApprovals: [],
      pendingQuestions: [],
      worktrees: [],
      diffs: [],
      childThreads: [],
      turns: [],
      extensions: {},
    })),
  } as unknown as FreshAgentRuntimeAdapter
  const runtimeManager = new FreshAgentRuntimeManager({
    registry: createFreshAgentProviderRegistry([
      {
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        adapter,
      },
    ]),
  })
  const app = express()
  app.use(express.json())
  app.use('/api', createFreshAgentRouter({ runtimeManager }))
  return app
}

describe('fresh-agent removes legacy Claude history routes', () => {
  it('does not register legacy agent-session routes in the production entrypoint', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'server/index.ts'), 'utf8')

    expect(source).not.toContain('/api/agent-sessions')
    expect(source).not.toContain('createAgentTimelineRouter')
    expect(source).not.toContain('createAgentTimelineService')
    expect(source).toMatch(/app\.use\('\/api', createFreshAgentRouter\(\{\s*runtimeManager: freshAgentRuntimeManager/)
  })

  it('does not mount /api/agent-sessions routes while fresh-agent threads still resolve', async () => {
    const app = createProductionFreshAgentRouteApp()

    const legacyTimeline = await request(app)
      .get('/api/agent-sessions/sdk-session-1/timeline?revision=1')
    const legacyTurnBody = await request(app)
      .get('/api/agent-sessions/sdk-session-1/turns/turn-1?revision=1')
    const freshAgentThread = await request(app)
      .get('/api/fresh-agent/threads/freshclaude/claude/sdk-session-1?revision=1')

    expect(legacyTimeline.status).toBe(404)
    expect(legacyTurnBody.status).toBe(404)
    expect(freshAgentThread.status).toBe(200)
    expect(freshAgentThread.body).toMatchObject({
      sessionType: 'freshclaude',
      provider: 'claude',
      threadId: 'sdk-session-1',
      revision: 1,
    })
  })
})
