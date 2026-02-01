import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { searchSessions, SearchTier } from '../../server/session-search.js'
import { claudeProvider } from '../../server/coding-cli/providers/claude.js'
import { codexProvider } from '../../server/coding-cli/providers/codex.js'
import type { ProjectGroup } from '../../server/coding-cli/types.js'

describe('Session Search E2E', () => {
  let tempDir: string
  let mockProjects: ProjectGroup[]

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'search-e2e-'))

    // Create realistic session structure
    // Note: project path /home/user/myproject becomes home-user-myproject
    // (forward slashes become hyphens, leading hyphen is stripped)
    const claudeHome = path.join(tempDir, '.claude')
    const projectDir = path.join(claudeHome, 'projects', 'home-user-myproject')
    await fsp.mkdir(projectDir, { recursive: true })

    // Session 1: Login feature
    const claudeLoginPath = path.join(projectDir, 'session-login.jsonl')
    await fsp.writeFile(
      claudeLoginPath,
      [
        '{"type":"system","subtype":"init","session_id":"session-login","uuid":"1"}',
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Help me implement user authentication"}]},"uuid":"2","parentUuid":"1","cwd":"/home/user/myproject"}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll help you implement authentication. Let\'s start with JWT tokens."}]},"uuid":"3","parentUuid":"2"}',
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Can you also add password hashing?"}]},"uuid":"4","parentUuid":"3"}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Sure! I\'ll use bcrypt for password hashing."}]},"uuid":"5","parentUuid":"4"}',
      ].join('\n')
    )

    // Session 2: Bug fix
    const claudeBugfixPath = path.join(projectDir, 'session-bugfix.jsonl')
    await fsp.writeFile(
      claudeBugfixPath,
      [
        '{"type":"system","subtype":"init","session_id":"session-bugfix","uuid":"1"}',
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the memory leak in the worker"}]},"uuid":"2","parentUuid":"1","cwd":"/home/user/myproject"}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I found the issue - the event listeners aren\'t being cleaned up."}]},"uuid":"3","parentUuid":"2"}',
      ].join('\n')
    )

    const codexDir = path.join(tempDir, '.codex', 'sessions', '2026', '01', '29')
    await fsp.mkdir(codexDir, { recursive: true })
    const codexPath = path.join(codexDir, 'rollout-2026-01-29T10-00-00-0000.jsonl')
    await fsp.writeFile(
      codexPath,
      [
        '{"type":"session_meta","payload":{"id":"session-codex","cwd":"/home/user/myproject"}}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Investigate cache bug"}]}}',
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Cache bug fixed"}]}}',
      ].join('\n')
    )

    mockProjects = [
      {
        projectPath: '/home/user/myproject',
        sessions: [
          {
            provider: 'claude',
            sessionId: 'session-login',
            projectPath: '/home/user/myproject',
            updatedAt: 2000,
            title: 'Help me implement user authentication',
            cwd: '/home/user/myproject',
            sourceFile: claudeLoginPath,
          },
          {
            provider: 'claude',
            sessionId: 'session-bugfix',
            projectPath: '/home/user/myproject',
            updatedAt: 1000,
            title: 'Fix the memory leak in the worker',
            cwd: '/home/user/myproject',
            sourceFile: claudeBugfixPath,
          },
          {
            provider: 'codex',
            sessionId: 'session-codex',
            projectPath: '/home/user/myproject',
            updatedAt: 1500,
            title: 'Investigate cache bug',
            cwd: '/home/user/myproject',
            sourceFile: codexPath,
          },
        ],
      },
    ]
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('title tier finds session by title keyword', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'authentication',
      tier: SearchTier.Title,
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].sessionId).toBe('session-login')
  })

  it('userMessages tier finds session by user message content', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'password hashing',
      tier: SearchTier.UserMessages,
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].sessionId).toBe('session-login')
  })

  it('fullText tier finds session by assistant response', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'JWT tokens',
      tier: SearchTier.FullText,
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].sessionId).toBe('session-login')
    expect(result.results[0].matchedIn).toBe('assistantMessage')
  })

  it('fullText tier finds bcrypt mention in assistant response', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'bcrypt',
      tier: SearchTier.FullText,
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].sessionId).toBe('session-login')
  })

  it('returns empty for non-matching query', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'kubernetes deployment',
      tier: SearchTier.FullText,
    })

    expect(result.results).toHaveLength(0)
    expect(result.totalScanned).toBe(3)
  })

  it('finds memory leak session by title', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'memory leak',
      tier: SearchTier.Title,
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].sessionId).toBe('session-bugfix')
    expect(result.results[0].matchedIn).toBe('title')
  })

  it('fullText finds event listeners mention', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'event listeners',
      tier: SearchTier.FullText,
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].sessionId).toBe('session-bugfix')
    expect(result.results[0].matchedIn).toBe('assistantMessage')
  })

  it('sorts results by updatedAt descending', async () => {
    // Query that matches both sessions
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'the',
      tier: SearchTier.FullText,
    })

    expect(result.results.length).toBeGreaterThan(0)
    // Results should be sorted by updatedAt descending
    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i - 1].updatedAt).toBeGreaterThanOrEqual(result.results[i].updatedAt)
    }
  })

  it('userMessages tier does NOT find assistant-only content', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'bcrypt',
      tier: SearchTier.UserMessages,
    })

    // bcrypt is only mentioned in assistant message, not user message
    expect(result.results).toHaveLength(0)
  })

  it('respects limit parameter', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'the',
      tier: SearchTier.FullText,
      limit: 1,
    })

    expect(result.results.length).toBeLessThanOrEqual(1)
  })

  it('provides snippet with context', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'JWT',
      tier: SearchTier.FullText,
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].snippet).toContain('JWT')
  })

  it('finds Codex sessions in fullText tier', async () => {
    const result = await searchSessions({
      projects: mockProjects,
      providers: [claudeProvider, codexProvider],
      query: 'Cache bug fixed',
      tier: SearchTier.FullText,
    })

    const codexHit = result.results.find((r) => r.provider === 'codex')
    expect(codexHit).toBeDefined()
    expect(codexHit?.sessionId).toBe('session-codex')
  })
})
