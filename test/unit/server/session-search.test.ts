import { describe, it, expect } from 'vitest'
import {
  SearchTier,
  SearchResultSchema,
  searchTitleTier,
  type SearchResult,
  type SearchMatch,
} from '../../../server/session-search.js'
import type { ProjectGroup } from '../../../server/claude-indexer.js'

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
  })
})

describe('searchTitleTier()', () => {
  const mockProjects: ProjectGroup[] = [
    {
      projectPath: '/home/user/project-a',
      sessions: [
        {
          sessionId: 'session-1',
          projectPath: '/home/user/project-a',
          updatedAt: 1000,
          title: 'Fix the login bug',
          cwd: '/home/user/project-a',
        },
        {
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
})
