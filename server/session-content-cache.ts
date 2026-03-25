/**
 * LRU parsed content cache for .jsonl session files.
 *
 * Keyed by absolute file path. Each entry stores parsed ChatMessage[] along
 * with the file's mtime and size at the time of reading. On each get(), the
 * file is stat'd to detect changes; if mtime+size match the cached entry,
 * the parsed messages are returned without re-reading.
 *
 * Features:
 *   - Size-aware LRU eviction (configurable byte budget, default 100 MB)
 *   - Request coalescing: concurrent get() calls for the same path share a
 *     single file read
 *   - Graceful handling of deleted/unreadable files
 */

import fsp from 'fs/promises'
import { extractChatMessagesFromJsonl, type ChatMessage } from './session-history-loader.js'

/** Per-entry overhead estimate in bytes (object headers, map slot, etc.) */
const ENTRY_OVERHEAD_BYTES = 512

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024 // 100 MB

interface SessionContentCacheEntry {
  mtimeMs: number
  size: number
  messages: ChatMessage[]
  byteSize: number
}

export interface SessionContentCacheOptions {
  maxBytes?: number
}

export class SessionContentCache {
  /** LRU cache: iteration order = insertion order (oldest first). */
  private cache = new Map<string, SessionContentCacheEntry>()
  /** In-flight reads for request coalescing. */
  private inflight = new Map<string, Promise<ChatMessage[] | null>>()
  private totalBytes = 0
  private readonly maxBytes: number

  constructor(options?: SessionContentCacheOptions) {
    const envMaxMb = process.env.FRESHELL_SESSION_CACHE_MAX_MB
    let envBytes: number | undefined
    if (envMaxMb) {
      const parsed = Number(envMaxMb)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
          `Invalid FRESHELL_SESSION_CACHE_MAX_MB: "${envMaxMb}" (must be a positive number)`,
        )
      }
      envBytes = parsed * 1024 * 1024
    }
    this.maxBytes = options?.maxBytes ?? envBytes ?? DEFAULT_MAX_BYTES
  }

  /**
   * Get parsed messages for a file path.
   *
   * - stat() to check mtime+size
   * - If cache hit and mtime+size match, return cached messages
   * - If cache miss or stale, read file, parse, store, return
   * - Concurrent calls for the same path coalesce into one read
   * - On read error (ENOENT, permission), return null and evict
   */
  async get(filePath: string): Promise<ChatMessage[] | null> {
    // Check for an in-flight request first (coalescing)
    const existing = this.inflight.get(filePath)
    if (existing) return existing

    const promise = this._doGet(filePath)
    this.inflight.set(filePath, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(filePath)
    }
  }

  /** Invalidate a specific entry (e.g. when chokidar detects a change). */
  invalidate(filePath: string): void {
    const entry = this.cache.get(filePath)
    if (entry) {
      this.totalBytes -= entry.byteSize
      this.cache.delete(filePath)
    }
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear()
    this.inflight.clear()
    this.totalBytes = 0
  }

  /** Stats for debugging/logging. */
  stats(): { entries: number; totalBytes: number; maxBytes: number } {
    return {
      entries: this.cache.size,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
    }
  }

  private async _doGet(filePath: string): Promise<ChatMessage[] | null> {
    // Stat the file to check freshness
    let stat: Awaited<ReturnType<typeof fsp.stat>>
    try {
      stat = await fsp.stat(filePath)
    } catch {
      // File gone or unreadable -- evict and return null
      this.invalidate(filePath)
      return null
    }

    // Check cache for a fresh hit
    const cached = this.cache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      // Move to end of LRU (most recently used)
      this.cache.delete(filePath)
      this.cache.set(filePath, cached)
      return cached.messages
    }

    // Cache miss or stale -- read and parse
    let content: string
    try {
      content = await fsp.readFile(filePath, 'utf-8')
    } catch {
      // File deleted between stat and read, or permission error
      this.invalidate(filePath)
      return null
    }

    const messages = extractChatMessagesFromJsonl(content)

    // Approximate byte size: V8 uses UTF-16 internally, so string cost is ~2x char count
    const byteSize = content.length * 2 + ENTRY_OVERHEAD_BYTES

    // Evict old entry if updating
    if (cached) {
      this.totalBytes -= cached.byteSize
      this.cache.delete(filePath)
    }

    // Store new entry
    const entry: SessionContentCacheEntry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      messages,
      byteSize,
    }
    this.cache.set(filePath, entry)
    this.totalBytes += byteSize

    // Evict LRU entries until under budget
    this.evict()

    return messages
  }

  private evict(): void {
    // Iterate from oldest (first) to newest
    for (const [key, entry] of this.cache) {
      if (this.totalBytes <= this.maxBytes) break
      this.cache.delete(key)
      this.totalBytes -= entry.byteSize
    }
  }
}
