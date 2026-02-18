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

/**
 * Chunk a terminal snapshot into byte-safe frame payloads for terminal.attached.chunk.
 * Uses UTF-8 byte sizing for the full serialized message envelope.
 */
export function chunkTerminalSnapshot(snapshot: string, maxBytes: number, terminalId: string): string[] {
  if (!snapshot) return []
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('Invalid max byte budget for terminal snapshot chunking')
  }

  const prefix = `{"type":"terminal.attached.chunk","terminalId":${JSON.stringify(terminalId)},"chunk":`
  const suffix = '}'
  const fixedEnvelopeBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix)
  const payloadBytes = (chunk: string): number => fixedEnvelopeBytes + Buffer.byteLength(JSON.stringify(chunk))
  const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
  const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

  if (payloadBytes('') > maxBytes) {
    throw new Error('Max byte budget too small for terminal.attached.chunk envelope')
  }

  const chunks: string[] = []
  let cursor = 0

  while (cursor < snapshot.length) {
    let lo = cursor + 1
    let hi = snapshot.length
    let best = cursor

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const candidate = snapshot.slice(cursor, mid)
      if (payloadBytes(candidate) <= maxBytes) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    if (best < snapshot.length && best > cursor) {
      const prev = snapshot.charCodeAt(best - 1)
      const next = snapshot.charCodeAt(best)
      const prevIsHigh = isHighSurrogate(prev)
      const nextIsLow = isLowSurrogate(next)
      if (prevIsHigh && nextIsLow) {
        best -= 1
      }
    }

    if (best === cursor) {
      const cp = snapshot.codePointAt(cursor)
      const next = Math.min(snapshot.length, cursor + (cp !== undefined && cp > 0xffff ? 2 : 1))
      const candidate = snapshot.slice(cursor, next)
      if (payloadBytes(candidate) > maxBytes) {
        throw new Error('Unable to advance chunk cursor safely within max byte budget')
      }
      best = next
    }

    chunks.push(snapshot.slice(cursor, best))
    cursor = best
  }

  return chunks
}
