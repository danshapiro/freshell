import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { createFreshAgentRouter } from '../../../../server/fresh-agent/router.js'
import { FreshAgentRuntimeManager, FreshAgentStaleThreadRevisionError } from '../../../../server/fresh-agent/runtime-manager.js'

describe('fresh-agent router', () => {
  it('returns 409 for stale thread revisions instead of mixing bodies from different revisions', async () => {
    const manager = {
      getTurnBody: vi.fn().mockRejectedValue(new FreshAgentStaleThreadRevisionError(7)),
    } as unknown as FreshAgentRuntimeManager

    const app = express()
    app.use('/api', createFreshAgentRouter({ runtimeManager: manager }))

    const response = await request(app)
      .get('/api/fresh-agent/threads/codex/thread-1/turns/turn-9?revision=4')

    expect(response.status).toBe(409)
    expect(response.body.code).toBe('STALE_THREAD_REVISION')
    expect(response.body.currentRevision).toBe(7)
  })
})
