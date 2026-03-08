import type { ProjectGroup } from './coding-cli/types.js'

/**
 * Chunk projects array into batches that fit within MAX_CHUNK_BYTES when serialized.
 * This ensures mobile browsers with limited WebSocket buffers can receive the data.
 * Uses Buffer.byteLength for accurate UTF-8 byte counting (not UTF-16 code units).
 *
 * When a single project exceeds maxBytes (e.g. a project with hundreds of sessions),
 * its sessions are split across multiple chunks. Each sub-group keeps the same
 * projectPath and color so the client can merge them via the append protocol.
 */
export function chunkProjects(projects: ProjectGroup[], maxBytes: number): ProjectGroup[][] {
  if (projects.length === 0) return [[]]

  const chunks: ProjectGroup[][] = []
  let currentChunk: ProjectGroup[] = []
  let currentSize = 0
  // Base overhead for message wrapper, plus max flag length ('"append":true' is longer than '"clear":true')
  const baseOverhead = Buffer.byteLength(JSON.stringify({ type: 'sessions.updated', projects: [] }))
  const flagOverhead = Buffer.byteLength(',"append":true')
  const overhead = baseOverhead + flagOverhead

  for (const project of projects) {
    const projectJson = JSON.stringify(project)
    const projectSize = Buffer.byteLength(projectJson)

    // If a single project exceeds maxBytes and has multiple sessions, split it
    if (projectSize + overhead > maxBytes && project.sessions.length > 1) {
      // Flush the current chunk first
      if (currentChunk.length > 0) {
        chunks.push(currentChunk)
        currentChunk = []
        currentSize = 0
      }

      // Split this project's sessions into sub-groups that fit within maxBytes
      const shell: Omit<ProjectGroup, 'sessions'> = { projectPath: project.projectPath }
      if (project.color) shell.color = project.color
      const shellOverhead = Buffer.byteLength(JSON.stringify({ ...shell, sessions: [] }))

      let subSessions: typeof project.sessions = []
      let subSize = 0

      for (const session of project.sessions) {
        const sessionJson = JSON.stringify(session)
        const sessionSize = Buffer.byteLength(sessionJson)
        const separatorSize = subSessions.length > 0 ? 1 : 0 // comma between array elements

        if (subSessions.length > 0 && subSize + separatorSize + sessionSize + shellOverhead + overhead > maxBytes) {
          chunks.push([{ ...shell, sessions: subSessions }])
          subSessions = []
          subSize = 0
        }
        subSessions.push(session)
        subSize += (subSessions.length > 1 ? 1 : 0) + sessionSize
      }

      if (subSessions.length > 0) {
        // Start a new chunk with the remaining sessions
        currentChunk = [{ ...shell, sessions: subSessions }]
        currentSize = subSize + shellOverhead
      }
      continue
    }

    // Normal path: add whole project to current chunk
    const separatorSize = currentChunk.length > 0 ? 1 : 0
    if (currentChunk.length > 0 && currentSize + separatorSize + projectSize + overhead > maxBytes) {
      chunks.push(currentChunk)
      currentChunk = []
      currentSize = 0
    }
    currentChunk.push(project)
    currentSize += (currentChunk.length > 1 ? 1 : 0) + projectSize // Add comma for non-first elements
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}
