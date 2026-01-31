/**
 * Session Cache
 *
 * Caches scan results with mtime+size invalidation.
 * Stays in Node.js even after Rust scanner replacement.
 */

import { promises as fs } from 'fs'
import type { SessionScanResult } from './types.js'

/**
 * Cache entry with file metadata for invalidation.
 */
export interface CacheEntry {
  /** File modification time in milliseconds */
  mtime: number
  /** File size in bytes */
  size: number
  /** Cached scan result */
  result: SessionScanResult
}

/**
 * Serializable cache data for persistence.
 */
interface CacheData {
  version: 1
  entries: Record<string, CacheEntry>
}

/**
 * Session cache with mtime+size invalidation.
 */
export class SessionCache {
  private cache: Map<string, CacheEntry> = new Map()
  private persistPath: string

  constructor(persistPath: string) {
    this.persistPath = persistPath
  }

  /**
   * Get cached result if file hasn't changed.
   * Returns null if cache miss or file modified.
   */
  async get(filePath: string): Promise<SessionScanResult | null> {
    const entry = this.cache.get(filePath)
    if (!entry) return null

    // Cheap stat() check
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch {
      // File deleted - remove from cache
      this.cache.delete(filePath)
      return null
    }

    // Invalidate if file changed
    if (stat.mtimeMs !== entry.mtime || stat.size !== entry.size) {
      this.cache.delete(filePath)
      return null
    }

    return entry.result
  }

  /**
   * Store scan result with file metadata for invalidation.
   */
  async set(filePath: string, result: SessionScanResult): Promise<void> {
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch {
      // Can't cache if file doesn't exist
      return
    }

    this.cache.set(filePath, {
      mtime: stat.mtimeMs,
      size: stat.size,
      result,
    })
  }

  /**
   * Invalidate entry (called when file changes detected).
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Persist cache to disk (graceful shutdown).
   */
  async persist(): Promise<void> {
    const data: CacheData = {
      version: 1,
      entries: Object.fromEntries(this.cache),
    }

    const content = JSON.stringify(data, null, 2)

    // Atomic write: write to temp file then rename
    const tempPath = `${this.persistPath}.tmp`
    await fs.writeFile(tempPath, content, 'utf8')
    await fs.rename(tempPath, this.persistPath)
  }

  /**
   * Load cache from disk (server start).
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.persistPath, 'utf8')
      const data = JSON.parse(content) as CacheData

      if (data.version !== 1) {
        // Unknown version - start fresh
        return
      }

      this.cache = new Map(Object.entries(data.entries))
    } catch {
      // File missing or corrupted - start with empty cache
      this.cache = new Map()
    }
  }
}
