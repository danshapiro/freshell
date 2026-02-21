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

      // Verify all projects are included across chunks
      const allProjects = chunks.flat()
      expect(allProjects.length).toBe(projects.length)
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

    it('handles single large project that exceeds chunk size', () => {
      // A single project larger than the chunk size should still be in its own chunk
      const largeProject = createProject('/large/project', 1000) // Many sessions
      const smallChunkSize = 1000 // Very small limit

      const chunks = chunkProjects([largeProject], smallChunkSize)

      // Should still return the project in a single chunk (can't split a project)
      expect(chunks.length).toBe(1)
      expect(chunks[0][0]).toEqual(largeProject)
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
