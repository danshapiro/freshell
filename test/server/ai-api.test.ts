// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAiRouter } from '../../server/ai-router.js'

describe('AI API', () => {
  let app: express.Express
  let mockRegistry: { get: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    // Clear AI key to ensure heuristic fallback
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY

    mockRegistry = {
      get: vi.fn(),
    }

    app = express()
    app.use(express.json())
    app.use('/api/ai', createAiRouter({
      registry: mockRegistry,
      perfConfig: { slowAiSummaryMs: 500 },
    }))
  })

  it('returns 404 for unknown terminal', async () => {
    mockRegistry.get.mockReturnValue(undefined)

    const res = await request(app)
      .post('/api/ai/terminals/nonexistent/summary')

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Terminal not found')
  })

  it('returns heuristic fallback when AI is not configured', async () => {
    mockRegistry.get.mockReturnValue({
      buffer: {
        snapshot: () => 'npm install\nInstalling dependencies...\nDone in 2.3s',
      },
    })

    const res = await request(app)
      .post('/api/ai/terminals/term-1/summary')

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('heuristic')
    expect(res.body.description).toBeTruthy()
    expect(res.body.description).toContain('npm install')
  })

  it('returns "Terminal session" for empty buffer', async () => {
    mockRegistry.get.mockReturnValue({
      buffer: {
        snapshot: () => '',
      },
    })

    const res = await request(app)
      .post('/api/ai/terminals/term-2/summary')

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('heuristic')
    expect(res.body.description).toBe('Terminal session')
  })

  it('strips ANSI escape codes in heuristic mode', async () => {
    mockRegistry.get.mockReturnValue({
      buffer: {
        snapshot: () => '\x1b[32mSuccess\x1b[0m: build completed',
      },
    })

    const res = await request(app)
      .post('/api/ai/terminals/term-3/summary')

    expect(res.status).toBe(200)
    expect(res.body.description).not.toContain('\x1b[')
    expect(res.body.description).toContain('Success')
  })
})
