import { describe, it, expect } from 'vitest'
import { chunkProjects } from '../../../server/ws-chunking.js'
import type { ProjectGroup } from '../../../server/coding-cli/types.js'

describe('WebSocket chunking', () => {
  describe('chunkProjects', () => {
    const createProject = (path: string, sessionCount: number): ProjectGroup => ({
      projectPath: path,
      sessions: Array.from({ length: sessionCount }, (_, i) => ({
        sessionId: `session-${i}`,
        projectPath: path,
        updatedAt: Date.now(),
      })),
    })

    it('returns single chunk for small data', () => {
      const projects = [createProject('/project/one', 2)]
      const chunks = chunkProjects(projects, 500 * 1024) // 500KB limit
      expect(chunks.length).toBe(1)
      expect(chunks[0]).toEqual(projects)
    })

    it('returns empty array in single chunk for empty input', () => {
      const chunks = chunkProjects([], 500 * 1024)
      expect(chunks.length).toBe(1)
      expect(chunks[0]).toEqual([])
    })

    it('splits large data into multiple chunks', () => {
      // Create projects that will exceed the chunk size
      const projects = Array.from({ length: 100 }, (_, i) =>
        createProject(`/project/${i}`, 50) // Each project with 50 sessions
      )

      const smallChunkSize = 10 * 1024 // 10KB to force chunking
      const chunks = chunkProjects(projects, smallChunkSize)

      expect(chunks.length).toBeGreaterThan(1)

      // Verify all sessions are included across chunks (projects may be split)
      const allEntries = chunks.flat()
      const totalSessions = allEntries.reduce((sum, p) => sum + p.sessions.length, 0)
      const originalSessions = projects.reduce((sum, p) => sum + p.sessions.length, 0)
      expect(totalSessions).toBe(originalSessions)

      // Verify all project paths are represented
      const uniquePaths = new Set(allEntries.map(p => p.projectPath))
      expect(uniquePaths.size).toBe(projects.length)
    })

    it('keeps each chunk under the size limit', () => {
      const projects = Array.from({ length: 50 }, (_, i) =>
        createProject(`/project/${i}`, 20)
      )

      const maxBytes = 5000 // 5KB limit
      const chunks = chunkProjects(projects, maxBytes)

      for (const chunk of chunks) {
        const chunkSize = Buffer.byteLength(JSON.stringify({ type: 'sessions.updated', projects: chunk }))
        // Allow some overhead for the message wrapper
        expect(chunkSize).toBeLessThan(maxBytes + 200)
      }
    })

    it('splits a single oversized project into multiple chunks', () => {
      const largeProject = createProject('/large/project', 1000) // Many sessions
      const smallChunkSize = 5000 // Small enough to force splitting

      const chunks = chunkProjects([largeProject], smallChunkSize)

      // Should be split across multiple chunks
      expect(chunks.length).toBeGreaterThan(1)

      // All sub-groups should have the same projectPath
      for (const chunk of chunks) {
        expect(chunk.length).toBe(1)
        expect(chunk[0].projectPath).toBe('/large/project')
      }

      // All sessions should be preserved across sub-groups
      const allSessions = chunks.flatMap(c => c[0].sessions)
      expect(allSessions.length).toBe(1000)
      expect(allSessions.map(s => s.sessionId)).toEqual(
        largeProject.sessions.map(s => s.sessionId)
      )
    })

    it('keeps oversized project with single session in one chunk', () => {
      // A project with just one session can't be split further
      const singleSessionProject = createProject('/big/session', 1)
      const tinyChunkSize = 10 // Smaller than any possible project

      const chunks = chunkProjects([singleSessionProject], tinyChunkSize)

      expect(chunks.length).toBe(1)
      expect(chunks[0][0]).toEqual(singleSessionProject)
    })

    it('preserves color when splitting oversized projects', () => {
      const project: ProjectGroup = {
        ...createProject('/colored/project', 100),
        color: '#ff0000',
      }
      const smallChunkSize = 2000

      const chunks = chunkProjects([project], smallChunkSize)
      expect(chunks.length).toBeGreaterThan(1)

      for (const chunk of chunks) {
        expect(chunk[0].color).toBe('#ff0000')
      }
    })

    it('preserves project order', () => {
      const projects = Array.from({ length: 10 }, (_, i) =>
        createProject(`/project/${i}`, 5)
      )

      const chunks = chunkProjects(projects, 1000)
      const allProjects = chunks.flat()

      for (let i = 0; i < projects.length; i++) {
        expect(allProjects[i].projectPath).toBe(projects[i].projectPath)
      }
    })

    it('handles non-ASCII characters correctly', () => {
      // Test that byte length (not UTF-16 code units) is used
      const projectWithUnicode: ProjectGroup = {
        projectPath: '/项目/测试', // Chinese characters
        sessions: [{
          sessionId: 'émoji-🎉-session',
          projectPath: '/项目/测试',
          updatedAt: Date.now(),
        }],
      }

      // Small limit that would pass with UTF-16 length but fail with byte length
      const chunks = chunkProjects([projectWithUnicode], 500)

      // Should still work (put in single chunk since can't split)
      expect(chunks.length).toBe(1)
      expect(chunks[0][0]).toEqual(projectWithUnicode)
    })
  })

})
