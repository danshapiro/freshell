/**
 * LRU parsed content cache for .jsonl session files.
 * Stat-based invalidation, request coalescing, configurable byte budget.
 */

import fsp from 'fs/promises'
import { extractChatMessagesFromJsonl, type ChatMessage } from './session-history-loader.js'

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
  private cache = new Map<string, SessionContentCacheEntry>()
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

  async get(filePath: string): Promise<ChatMessage[] | null> {
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

  invalidate(filePath: string): void {
    const entry = this.cache.get(filePath)
    if (entry) {
      this.totalBytes -= entry.byteSize
      this.cache.delete(filePath)
    }
  }

  clear(): void {
    this.cache.clear()
    this.inflight.clear()
    this.totalBytes = 0
  }

  stats(): { entries: number; totalBytes: number; maxBytes: number } {
    return {
      entries: this.cache.size,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
    }
  }

  private async _doGet(filePath: string): Promise<ChatMessage[] | null> {
    let stat: Awaited<ReturnType<typeof fsp.stat>>
    try {
      stat = await fsp.stat(filePath)
    } catch {
      this.invalidate(filePath)
      return null
    }

    const cached = this.cache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      // LRU touch: move to end
      this.cache.delete(filePath)
      this.cache.set(filePath, cached)
      return cached.messages
    }

    let content: string
    try {
      content = await fsp.readFile(filePath, 'utf-8')
    } catch {
      this.invalidate(filePath)
      return null
    }

    const messages = extractChatMessagesFromJsonl(content)
    const byteSize = content.length * 2 + ENTRY_OVERHEAD_BYTES

    if (cached) {
      this.totalBytes -= cached.byteSize
      this.cache.delete(filePath)
    }

    const entry: SessionContentCacheEntry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      messages,
      byteSize,
    }
    this.cache.set(filePath, entry)
    this.totalBytes += byteSize

    this.evict()

    return messages
  }

  private evict(): void {
    for (const [key, entry] of this.cache) {
      if (this.totalBytes <= this.maxBytes) break
      this.cache.delete(key)
      this.totalBytes -= entry.byteSize
    }
  }
}
