import { describe, it, expect } from 'vitest'
import { chunkProjects, chunkTerminalSnapshot } from '../../../server/ws-handler.js'
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

  describe('chunkTerminalSnapshot', () => {
    const createEnvelopeBytes = (terminalId: string, chunk: string): number =>
      Buffer.byteLength(JSON.stringify({
        type: 'terminal.attached.chunk',
        terminalId,
        chunk,
      }))

    it('returns single chunk for small snapshot', () => {
      const terminalId = 'term-small'
      const snapshot = 'hello world'
      const maxBytes = 1024

      const chunks = chunkTerminalSnapshot(snapshot, maxBytes, terminalId)

      expect(chunks).toEqual([snapshot])
      expect(createEnvelopeBytes(terminalId, chunks[0])).toBeLessThanOrEqual(maxBytes)
    })

    it('splits large snapshot into multiple chunks under byte limit using real envelope', () => {
      const terminalId = 'term-large'
      const snapshot = 'A'.repeat(150_000)
      const maxBytes = 16 * 1024

      const chunks = chunkTerminalSnapshot(snapshot, maxBytes, terminalId)

      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.join('')).toBe(snapshot)
      for (const chunk of chunks) {
        expect(createEnvelopeBytes(terminalId, chunk)).toBeLessThanOrEqual(maxBytes)
      }
    })

    it('handles unicode text and round-trips exactly', () => {
      const terminalId = 'term-unicode'
      const snapshot = '中文🙂 café — line 1\n🙂🙂🙂\n終わり'
      const maxBytes = 128

      const chunks = chunkTerminalSnapshot(snapshot, maxBytes, terminalId)

      expect(chunks.join('')).toBe(snapshot)
      for (const chunk of chunks) {
        expect(createEnvelopeBytes(terminalId, chunk)).toBeLessThanOrEqual(maxBytes)
      }
    })

    it('does not split surrogate pairs across chunk boundaries', () => {
      const terminalId = 'term-surrogate'
      const snapshot = `${'x'.repeat(70)}🙂${'y'.repeat(70)}🙂${'z'.repeat(70)}`
      const maxBytes = 120

      const chunks = chunkTerminalSnapshot(snapshot, maxBytes, terminalId)

      for (let i = 0; i < chunks.length - 1; i++) {
        const left = chunks[i]
        const right = chunks[i + 1]
        const lastCode = left.charCodeAt(left.length - 1)
        const firstCode = right.charCodeAt(0)
        const leftHigh = lastCode >= 0xd800 && lastCode <= 0xdbff
        const rightLow = firstCode >= 0xdc00 && firstCode <= 0xdfff
        expect(leftHigh && rightLow).toBe(false)
      }
      expect(chunks.join('')).toBe(snapshot)
    })

    it('handles tight surrogate boundaries without stalling at cursor', () => {
      const terminalId = 'term-stepback'
      const snapshot = `🙂${'x'.repeat(200)}`
      const maxBytes = createEnvelopeBytes(terminalId, '🙂')

      const chunks = chunkTerminalSnapshot(snapshot, maxBytes, terminalId)

      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks[0]).toBe('🙂')
      expect(chunks.join('')).toBe(snapshot)
      for (const chunk of chunks) {
        expect(createEnvelopeBytes(terminalId, chunk)).toBeLessThanOrEqual(maxBytes)
      }
    })

    it('honors long terminal IDs', () => {
      const terminalId = `term-${'x'.repeat(64)}`
      const snapshot = 'data '.repeat(20_000)
      const maxBytes = 32 * 1024

      const chunks = chunkTerminalSnapshot(snapshot, maxBytes, terminalId)

      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.join('')).toBe(snapshot)
      for (const chunk of chunks) {
        expect(createEnvelopeBytes(terminalId, chunk)).toBeLessThanOrEqual(maxBytes)
      }
    })

    it('throws clear error when maxBytes is too small for minimal chunk envelope', () => {
      const terminalId = 'term-small-budget'
      const snapshot = 'x'
      const maxBytes = 8
      expect(() => chunkTerminalSnapshot(snapshot, maxBytes, terminalId)).toThrow(
        /max byte budget|cursor/i
      )
    })

    it('preserves empty snapshot behavior (returns empty chunks)', () => {
      const terminalId = 'term-empty'
      const chunks = chunkTerminalSnapshot('', 1024, terminalId)
      expect(chunks).toEqual([])
    })

    it('handles 2MB snapshot payload without pathological chunk growth', () => {
      const terminalId = 'term-perf'
      const snapshot = 'x'.repeat(2_000_000)
      const maxBytes = 500 * 1024

      const chunks = chunkTerminalSnapshot(snapshot, maxBytes, terminalId)

      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.length).toBeLessThanOrEqual(8)
      expect(chunks.join('')).toBe(snapshot)
      for (const chunk of chunks) {
        expect(createEnvelopeBytes(terminalId, chunk)).toBeLessThanOrEqual(maxBytes)
      }
    })
  })
})
