// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAiRouter } from '../../server/ai-router.js'
import { PROMPTS } from '../../server/ai-prompts.js'

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

describe('AI prompts', () => {
  it('codingCliSummary prompt includes the user messages and correct framing', () => {
    const userMessages = 'Fix bug 123.\n...\nNow fix bug 456.'
    const prompt = PROMPTS.codingCliSummary.build(userMessages)
    expect(prompt).toContain('coding agent session')
    expect(prompt).toContain('user messages')
    expect(prompt).toContain('assistant replies are removed')
    expect(prompt).toContain('250 characters')
    expect(prompt).toContain('bias towards recency')
    expect(prompt).toContain(userMessages)
  })
})

describe('AI API - coding CLI aware summary', () => {
  let app: express.Express
  let mockRegistry: { get: ReturnType<typeof vi.fn> }
  let mockSessionFileReader: ReturnType<typeof vi.fn>

  beforeEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY

    mockRegistry = { get: vi.fn() }
    mockSessionFileReader = vi.fn()

    app = express()
    app.use(express.json())
    app.use('/api/ai', createAiRouter({
      registry: mockRegistry,
      perfConfig: { slowAiSummaryMs: 500 },
      readSessionContent: mockSessionFileReader,
    }))
  })

  it('uses coding-CLI path for non-shell terminal with session file', async () => {
    const sessionContent = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the login bug.' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Now add tests.' } }),
    ].join('\n')

    mockRegistry.get.mockReturnValue({
      buffer: { snapshot: () => 'some scrollback output' },
      mode: 'claude',
      resumeSessionId: 'session-abc',
    })

    mockSessionFileReader.mockResolvedValue(sessionContent)

    const res = await request(app)
      .post('/api/ai/terminals/term-cli/summary')

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('heuristic')
    expect(res.body.description).toBeTruthy()
    // Verify readSessionContent was called with the session ID and provider
    expect(mockSessionFileReader).toHaveBeenCalledWith('session-abc', 'claude', undefined)
  })

  it('falls back to scrollback for shell-mode terminals', async () => {
    mockRegistry.get.mockReturnValue({
      buffer: { snapshot: () => 'npm install\nDone in 2.3s' },
      mode: 'shell',
    })

    const res = await request(app)
      .post('/api/ai/terminals/term-shell/summary')

    expect(res.status).toBe(200)
    expect(res.body.description).toContain('npm install')
    // readSessionContent should not be called for shell terminals
    expect(mockSessionFileReader).not.toHaveBeenCalled()
  })

  it('falls back to scrollback when no session file is found', async () => {
    mockRegistry.get.mockReturnValue({
      buffer: { snapshot: () => 'claude running\nAssistant output' },
      mode: 'claude',
      resumeSessionId: 'session-xyz',
    })

    mockSessionFileReader.mockResolvedValue(null)

    const res = await request(app)
      .post('/api/ai/terminals/term-no-session/summary')

    expect(res.status).toBe(200)
    expect(res.body.description).toContain('claude running')
    // readSessionContent was still called, but returned null
    expect(mockSessionFileReader).toHaveBeenCalledWith('session-xyz', 'claude', undefined)
  })

  it('falls back to scrollback when readSessionContent throws an error', async () => {
    mockRegistry.get.mockReturnValue({
      buffer: { snapshot: () => 'scrollback fallback content\nmore output' },
      mode: 'claude',
      resumeSessionId: 'session-err',
    })

    mockSessionFileReader.mockRejectedValue(new Error('disk error'))

    const res = await request(app)
      .post('/api/ai/terminals/term-disk-error/summary')

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('heuristic')
    // Falls back to scrollback-based heuristic
    expect(res.body.description).toContain('scrollback fallback content')
    expect(mockSessionFileReader).toHaveBeenCalledWith('session-err', 'claude', undefined)
  })

  it('passes cwd when summarizing a Kimi terminal and prefers transcript content over scrollback', async () => {
    const sessionContent = [
      JSON.stringify({ role: 'user', content: 'Transcript-first task' }),
      JSON.stringify({ role: 'assistant', content: 'I handled it.' }),
    ].join('\n')

    mockRegistry.get.mockReturnValue({
      buffer: { snapshot: () => 'scrollback fallback content only' },
      mode: 'kimi',
      resumeSessionId: 'team:alpha',
      cwd: '/repo/worktrees/app',
    })

    mockSessionFileReader.mockResolvedValue(sessionContent)

    const res = await request(app)
      .post('/api/ai/terminals/term-kimi/summary')

    expect(res.status).toBe(200)
    expect(res.body.description).toContain('Transcript-first task')
    expect(res.body.description).not.toContain('scrollback fallback content only')
    expect(mockSessionFileReader).toHaveBeenCalledWith('team:alpha', 'kimi', '/repo/worktrees/app')
  })
})
