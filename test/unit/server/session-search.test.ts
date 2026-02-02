import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  SearchTier,
  SearchResultSchema,
  searchTitleTier,
  extractUserMessages,
  extractAllMessages,
  searchSessionFile,
  searchSessions,
  type SearchResult,
} from '../../../server/session-search.js'
import { claudeProvider } from '../../../server/coding-cli/providers/claude.js'
import { codexProvider } from '../../../server/coding-cli/providers/codex.js'
import type { ProjectGroup } from '../../../server/coding-cli/types.js'

describe('session-search types', () => {
  describe('SearchTier enum', () => {
    it('has three tiers: title, userMessages, fullText', () => {
      expect(SearchTier.Title).toBe('title')
      expect(SearchTier.UserMessages).toBe('userMessages')
      expect(SearchTier.FullText).toBe('fullText')
    })
  })

  describe('SearchResultSchema', () => {
    it('validates a valid search result', () => {
      const result: SearchResult = {
        sessionId: 'abc123',
        provider: 'claude',
        projectPath: '/home/user/project',
        title: 'Fix the bug',
        matchedIn: 'title',
        snippet: 'Fix the bug in login',
        updatedAt: Date.now(),
      }
      expect(() => SearchResultSchema.parse(result)).not.toThrow()
    })

    it('requires sessionId and projectPath', () => {
      const invalid = { title: 'Test' }
      expect(() => SearchResultSchema.parse(invalid)).toThrow()
    })

    it('requires provider', () => {
      const invalid = {
        sessionId: 'abc123',
        projectPath: '/home/user/project',
        matchedIn: 'title',
        updatedAt: Date.now(),
      }
      expect(() => SearchResultSchema.parse(invalid)).toThrow()
    })
  })
})

describe('searchTitleTier()', () => {
  const mockProjects: ProjectGroup[] = [
    {
      projectPath: '/home/user/project-a',
      sessions: [
        {
          provider: 'claude',
          sessionId: 'session-1',
          projectPath: '/home/user/project-a',
          updatedAt: 1000,
          title: 'Fix the login bug',
          cwd: '/home/user/project-a',
        },
        {
          provider: 'claude',
          sessionId: 'session-2',
          projectPath: '/home/user/project-a',
          updatedAt: 2000,
          title: 'Add user authentication',
          cwd: '/home/user/project-a',
        },
      ],
    },
    {
      projectPath: '/home/user/project-b',
      sessions: [
        {
          provider: 'claude',
          sessionId: 'session-3',
          projectPath: '/home/user/project-b',
          updatedAt: 3000,
          title: 'Implement dark mode',
          summary: 'User requested dark mode feature',
          cwd: '/home/user/project-b',
        },
      ],
    },
  ]

  it('finds sessions matching query in title', () => {
    const results = searchTitleTier(mockProjects, 'login')
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('session-1')
    expect(results[0].provider).toBe('claude')
    expect(results[0].matchedIn).toBe('title')
  })

  it('is case-insensitive', () => {
    const results = searchTitleTier(mockProjects, 'LOGIN')
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('session-1')
  })

  it('matches partial words', () => {
    const results = searchTitleTier(mockProjects, 'auth')
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('session-2')
  })

  it('also searches summary field', () => {
    const results = searchTitleTier(mockProjects, 'dark mode feature')
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('session-3')
  })

  it('returns empty array for no matches', () => {
    const results = searchTitleTier(mockProjects, 'nonexistent')
    expect(results).toHaveLength(0)
  })

  it('respects limit parameter', () => {
    const results = searchTitleTier(mockProjects, 'a', 1)
    expect(results).toHaveLength(1)
  })

  it('sorts by updatedAt descending', () => {
    const results = searchTitleTier(mockProjects, 'a')
    expect(results[0].updatedAt).toBeGreaterThanOrEqual(results[results.length - 1].updatedAt)
  })

  it('sorts non-archived before archived and by updatedAt within groups', () => {
    const projects: ProjectGroup[] = [
      {
        projectPath: '/home/user/project-a',
        sessions: [
          {
            sessionId: 's1',
            projectPath: '/home/user/project-a',
            updatedAt: 2000,
            title: 'Alpha task',
            archived: false,
          },
          {
            sessionId: 's2',
            projectPath: '/home/user/project-a',
            updatedAt: 3000,
            title: 'Albatross review',
            archived: true,
          },
          {
            sessionId: 's3',
            projectPath: '/home/user/project-a',
            updatedAt: 1000,
            title: 'Alaska note',
            archived: false,
          },
        ],
      },
    ]

    const results = searchTitleTier(projects, 'al')
    expect(results.map((r) => r.sessionId)).toEqual(['s1', 's3', 's2'])
  })
})

describe('extractUserMessages()', () => {
  it('extracts user messages from simple format', () => {
    const content = [
      '{"type":"user","message":"Hello world","uuid":"1"}',
      '{"type":"assistant","message":"Hi there","uuid":"2"}',
      '{"type":"user","message":"How are you?","uuid":"3"}',
    ].join('\n')

    const messages = extractUserMessages(content)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toBe('Hello world')
    expect(messages[1]).toBe('How are you?')
  })

  it('extracts user messages from nested message.content format', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"Nested message"},"uuid":"1"}',
    ].join('\n')

    const messages = extractUserMessages(content)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe('Nested message')
  })

  it('extracts user messages from content array format', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Array format"}]},"uuid":"1"}',
    ].join('\n')

    const messages = extractUserMessages(content)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe('Array format')
  })

  it('skips non-user messages', () => {
    const content = [
      '{"type":"assistant","message":"Response","uuid":"1"}',
      '{"type":"system","subtype":"init","uuid":"2"}',
    ].join('\n')

    const messages = extractUserMessages(content)

    expect(messages).toHaveLength(0)
  })

  it('handles malformed JSON gracefully', () => {
    const content = [
      'not valid json',
      '{"type":"user","message":"Valid","uuid":"1"}',
    ].join('\n')

    const messages = extractUserMessages(content)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe('Valid')
  })
})

describe('extractAllMessages()', () => {
  it('extracts both user and assistant messages', () => {
    const content = [
      '{"type":"user","message":"User says hello","uuid":"1"}',
      '{"type":"assistant","message":"Assistant responds","uuid":"2"}',
    ].join('\n')

    const messages = extractAllMessages(content)

    expect(messages).toHaveLength(2)
    expect(messages).toContain('User says hello')
    expect(messages).toContain('Assistant responds')
  })

  it('extracts text from assistant content arrays', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Main response"},{"type":"thinking","thinking":"Internal thought"}]},"uuid":"1"}',
    ].join('\n')

    const messages = extractAllMessages(content)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Main response')
    expect(messages[0]).toContain('Internal thought')
  })

  it('skips system and progress messages', () => {
    const content = [
      '{"type":"system","subtype":"init","uuid":"1"}',
      '{"type":"progress","content":"Loading...","uuid":"2"}',
      '{"type":"user","message":"Hello","uuid":"3"}',
    ].join('\n')

    const messages = extractAllMessages(content)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe('Hello')
  })
})

describe('searchSessionFile()', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-search-test-'))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  async function createTestSession(name: string, content: string): Promise<string> {
    const filePath = path.join(tempDir, `${name}.jsonl`)
    await fsp.writeFile(filePath, content)
    return filePath
  }

  it('finds match in user message (tier userMessages)', async () => {
    const filePath = await createTestSession('test1', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the authentication bug"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will fix that"}]}}',
    ].join('\n'))

    const result = await searchSessionFile(claudeProvider, filePath, 'authentication', 'userMessages')

    expect(result).not.toBeNull()
    expect(result?.matchedIn).toBe('userMessage')
    expect(result?.snippet).toContain('authentication')
  })

  it('does not search assistant messages in tier userMessages', async () => {
    const filePath = await createTestSession('test2', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The authentication is fixed"}]}}',
    ].join('\n'))

    const result = await searchSessionFile(claudeProvider, filePath, 'authentication', 'userMessages')

    expect(result).toBeNull()
  })

  it('searches assistant messages in tier fullText', async () => {
    const filePath = await createTestSession('test3', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The authentication is fixed"}]}}',
    ].join('\n'))

    const result = await searchSessionFile(claudeProvider, filePath, 'authentication', 'fullText')

    expect(result).not.toBeNull()
    expect(result?.matchedIn).toBe('assistantMessage')
  })

  it('extracts snippet context around match', async () => {
    const longMessage = 'A'.repeat(50) + 'TARGET' + 'B'.repeat(50)
    const filePath = await createTestSession('test4', [
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"${longMessage}"}]}}`,
    ].join('\n'))

    const result = await searchSessionFile(claudeProvider, filePath, 'TARGET', 'userMessages')

    expect(result?.snippet?.length).toBeLessThanOrEqual(120)
    expect(result?.snippet).toContain('TARGET')
  })

  it('returns null for non-existent file', async () => {
    await expect(
      searchSessionFile(claudeProvider, '/nonexistent/file.jsonl', 'test', 'fullText')
    ).rejects.toThrow()
  })

  it('is case-insensitive', async () => {
    const filePath = await createTestSession('test5', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the BUG"}]}}',
    ].join('\n'))

    const result = await searchSessionFile(claudeProvider, filePath, 'bug', 'userMessages')

    expect(result).not.toBeNull()
  })

  it('parses Codex user messages', async () => {
    const filePath = await createTestSession('codex-user', [
      '{"type":"session_meta","payload":{"id":"session-1","cwd":"/project"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the auth bug"}]}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Working on it"}]}}',
    ].join('\n'))

    const result = await searchSessionFile(codexProvider, filePath, 'auth bug', 'userMessages')

    expect(result).not.toBeNull()
    expect(result?.matchedIn).toBe('userMessage')
  })

  it('parses Codex assistant messages for fullText', async () => {
    const filePath = await createTestSession('codex-assistant', [
      '{"type":"session_meta","payload":{"id":"session-2","cwd":"/project"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The bug is fixed"}]}}',
    ].join('\n'))

    const result = await searchSessionFile(codexProvider, filePath, 'bug is fixed', 'fullText')

    expect(result).not.toBeNull()
    expect(result?.matchedIn).toBe('assistantMessage')
  })
})

describe('searchSessions() orchestrator', () => {
  let tempDir: string
  let projectDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'search-orchestrator-'))
    projectDir = path.join(tempDir, 'project-sessions')
    await fsp.mkdir(projectDir, { recursive: true })

    // Create test sessions
    await fsp.writeFile(
      path.join(projectDir, 'session-1.jsonl'),
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix login bug"}]},"cwd":"/project"}\n'
    )
    await fsp.writeFile(
      path.join(projectDir, 'session-2.jsonl'),
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"cwd":"/project"}\n' +
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The authentication system works"}]}}'
    )
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('tier title only searches metadata', async () => {
    const projects: ProjectGroup[] = [
      {
        projectPath: '/test-project',
        sessions: [
          {
            provider: 'claude',
            sessionId: 'session-1',
            projectPath: '/test-project',
            updatedAt: 1000,
            title: 'Fix login bug',
            cwd: '/project',
            sourceFile: path.join(projectDir, 'session-1.jsonl'),
          },
          {
            provider: 'claude',
            sessionId: 'session-2',
            projectPath: '/test-project',
            updatedAt: 2000,
            title: 'Hello',
            cwd: '/project',
            sourceFile: path.join(projectDir, 'session-2.jsonl'),
          },
        ],
      },
    ]

    const response = await searchSessions({
      projects,
      providers: [claudeProvider],
      query: 'login',
      tier: 'title',
    })

    expect(response.results).toHaveLength(1)
    expect(response.results[0].sessionId).toBe('session-1')
    expect(response.tier).toBe('title')
  })

  it('tier userMessages searches file content', async () => {
    const projects: ProjectGroup[] = [
      {
        projectPath: '/test-project',
        sessions: [
          {
            provider: 'claude',
            sessionId: 'session-1',
            projectPath: '/test-project',
            updatedAt: 1000,
            title: 'Fix login bug',
            cwd: '/project',
            sourceFile: path.join(projectDir, 'session-1.jsonl'),
          },
          {
            provider: 'claude',
            sessionId: 'session-2',
            projectPath: '/test-project',
            updatedAt: 2000,
            title: 'Hello',
            cwd: '/project',
            sourceFile: path.join(projectDir, 'session-2.jsonl'),
          },
        ],
      },
    ]

    const response = await searchSessions({
      projects,
      providers: [claudeProvider],
      query: 'login',
      tier: 'userMessages',
    })

    expect(response.results).toHaveLength(1)
    expect(response.results[0].sessionId).toBe('session-1')
  })

  it('tier fullText finds assistant message matches', async () => {
    const projects: ProjectGroup[] = [
      {
        projectPath: '/test-project',
        sessions: [
          {
            provider: 'claude',
            sessionId: 'session-1',
            projectPath: '/test-project',
            updatedAt: 1000,
            title: 'Login',
            cwd: '/project',
            sourceFile: path.join(projectDir, 'session-1.jsonl'),
          },
          {
            provider: 'claude',
            sessionId: 'session-2',
            projectPath: '/test-project',
            updatedAt: 2000,
            title: 'Hello',
            cwd: '/project',
            sourceFile: path.join(projectDir, 'session-2.jsonl'),
          },
        ],
      },
    ]

    const response = await searchSessions({
      projects,
      providers: [claudeProvider],
      query: 'authentication',
      tier: 'fullText',
    })

    expect(response.results).toHaveLength(1)
    expect(response.results[0].sessionId).toBe('session-2')
    expect(response.results[0].matchedIn).toBe('assistantMessage')
  })

  it('marks results partial when maxFiles budget is exceeded', async () => {
    const projects: ProjectGroup[] = [
      {
        projectPath: '/test-project',
        sessions: [
          {
            provider: 'claude',
            sessionId: 'session-1',
            projectPath: '/test-project',
            updatedAt: 1000,
            title: 'Login',
            cwd: '/project',
            sourceFile: path.join(projectDir, 'session-1.jsonl'),
          },
          {
            provider: 'claude',
            sessionId: 'session-2',
            projectPath: '/test-project',
            updatedAt: 2000,
            title: 'Hello',
            cwd: '/project',
            sourceFile: path.join(projectDir, 'session-2.jsonl'),
          },
        ],
      },
    ]

    const response = await searchSessions({
      projects,
      providers: [claudeProvider],
      query: 'authentication',
      tier: 'fullText',
      maxFiles: 1,
    })

    expect(response.results).toHaveLength(0)
    expect(response.totalScanned).toBe(1)
    expect(response.partial).toBe(true)
    expect(response.partialReason).toBe('budget')
  })

  it('marks results partial when a session file is missing', async () => {
    const missingFile = path.join(projectDir, 'missing.jsonl')
    const projects: ProjectGroup[] = [
      {
        projectPath: '/test-project',
        sessions: [
          {
            provider: 'claude',
            sessionId: 'session-missing',
            projectPath: '/test-project',
            updatedAt: 1000,
            title: 'Missing',
            cwd: '/project',
            sourceFile: missingFile,
          },
        ],
      },
    ]

    const response = await searchSessions({
      projects,
      providers: [claudeProvider],
      query: 'authentication',
      tier: 'fullText',
    })

    expect(response.results).toHaveLength(0)
    expect(response.totalScanned).toBe(1)
    expect(response.partial).toBe(true)
    expect(response.partialReason).toBe('io_error')
  })

  it('marks results partial when stream read fails', async () => {
    const filePath = path.join(projectDir, 'session-error.jsonl')
    await fsp.writeFile(
      filePath,
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix login bug"}]},"cwd":"/project"}\n'
    )

    const projects: ProjectGroup[] = [
      {
        projectPath: '/test-project',
        sessions: [
          {
            provider: 'claude',
            sessionId: 'session-error',
            projectPath: '/test-project',
            updatedAt: 1000,
            title: 'Error',
            cwd: '/project',
            sourceFile: filePath,
          },
        ],
      },
    ]

    const original = fs.promises.open
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((path, flags) => {
      if (path === filePath) {
        throw new Error('open failure')
      }
      return original(path as any, flags as any)
    }) as typeof fs.promises.open)

    try {
      const response = await searchSessions({
        projects,
        providers: [claudeProvider],
        query: 'login',
        tier: 'fullText',
      })

      expect(response.results).toHaveLength(0)
      expect(response.totalScanned).toBe(1)
      expect(response.partial).toBe(true)
      expect(response.partialReason).toBe('io_error')
    } finally {
      spy.mockRestore()
    }
  })
})
