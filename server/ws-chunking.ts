import type { ProjectGroup } from './coding-cli/types.js'

/**
 * Chunk projects array into batches that fit within MAX_CHUNK_BYTES when serialized.
 * This ensures mobile browsers with limited WebSocket buffers can receive the data.
 * Uses Buffer.byteLength for accurate UTF-8 byte counting (not UTF-16 code units).
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
    // Account for comma separator between array elements (except first element)
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
