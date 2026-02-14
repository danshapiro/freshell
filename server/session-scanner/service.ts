/**
 * Session Repair Service
 *
 * High-level service that manages session scanning and repair.
 * Initializes at server startup, provides waitForSession for terminal.create.
 */

import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { glob } from 'glob'
import { EventEmitter } from 'events'
import { logger } from '../logger.js'
import { getClaudeProjectsDir } from '../claude-home.js'
import { createSessionScanner } from './scanner.js'
import { SessionCache } from './cache.js'
import { SessionRepairQueue, type Priority, ACTIVE_CACHE_GRACE_MS } from './queue.js'
import type { SessionScanner, SessionScanResult, SessionRepairResult } from './types.js'

const BACKUP_RETENTION_DAYS = 30
const CACHE_FILENAME = 'session-cache.json'

export interface SessionRepairServiceOptions {
  /** Directory to store cache file. Defaults to ~/.freshell */
  cacheDir?: string
  /** Scanner implementation (for testing) */
  scanner?: SessionScanner
  /** Optional resolver for canonical session IDs */
  getFilePathForSession?: (sessionId: string) => string | undefined
}

/**
 * Session repair service singleton.
 */
export class SessionRepairService extends EventEmitter {
  private scanner: SessionScanner
  private cache: SessionCache
  private queue: SessionRepairQueue
  private initialized = false
  private cacheDir: string
  private claudeBase: string
  private sessionPathIndex = new Map<string, string>()
  private indexInitialized = false
  private filePathResolver?: (sessionId: string) => string | undefined

  constructor(options: SessionRepairServiceOptions = {}) {
    super()
    this.cacheDir = options.cacheDir || path.join(os.homedir(), '.freshell')
    this.scanner = options.scanner || createSessionScanner()
    this.cache = new SessionCache(path.join(this.cacheDir, CACHE_FILENAME))
    this.queue = new SessionRepairQueue(this.scanner, this.cache)
    this.claudeBase = getClaudeProjectsDir()
    this.filePathResolver = options.getFilePathForSession

    // Forward queue events
    this.queue.on('scanned', (result: SessionScanResult) => {
      if (result.status === 'missing') {
        this.sessionPathIndex.delete(result.sessionId)
      } else if (result.filePath) {
        this.sessionPathIndex.set(result.sessionId, result.filePath)
      }
      this.emit('scanned', result)
    })
    this.queue.on('repaired', (result: SessionRepairResult) => this.emit('repaired', result))
    this.queue.on('error', (sessionId: string, error: Error) => this.emit('error', sessionId, error))
  }

  /**
   * Initialize the service: load cache, discover sessions, start queue.
   */
  async start(): Promise<void> {
    if (this.initialized) return

    // Ensure cache directory exists
    await fs.mkdir(this.cacheDir, { recursive: true })

    // Load cache from disk
    await this.cache.load()

    // Seed session index from cached entries (no disk scan).
    this.ensureSessionIndex()

    // Cleanup old backups
    await this.cleanupOldBackups()

    // Start background processing
    this.queue.start()
    this.initialized = true

    logger.info('Session repair service started')
  }

  /**
   * Stop the service gracefully.
   */
  async stop(): Promise<void> {
    await this.queue.stop()
    await this.cache.persist()
    logger.info('Session repair service stopped')
  }

  setFilePathResolver(resolver: (sessionId: string) => string | undefined): void {
    this.filePathResolver = resolver
  }

  /**
   * Prioritize sessions from a client's hello message.
   * Called when a client connects with session IDs.
   */
  prioritizeSessions(sessions: {
    active?: string
    visible?: string[]
    background?: string[]
  }): void {
    const items: Array<{ sessionId: string; priority: Priority }> = []
    if (sessions.active) {
      items.push({
        sessionId: sessions.active,
        priority: 'active',
      })
    }

    for (const id of sessions.visible || []) {
      items.push({
        sessionId: id,
        priority: 'visible',
      })
    }

    for (const id of sessions.background || []) {
      items.push({
        sessionId: id,
        priority: 'background',
      })
    }

    if (items.length === 0) return

    this.enqueueResolved(items)
  }

  /**
   * Wait for a session to be scanned/repaired.
   * Used by terminal.create before spawning Claude with --resume.
   */
  async waitForSession(sessionId: string, timeoutMs = 30000): Promise<SessionScanResult> {
    // Check if already processed
    const existing = this.queue.getResult(sessionId)
    if (existing) {
      return existing
    }

    if (this.queue.has(sessionId)) {
      return this.queue.waitFor(sessionId, timeoutMs)
    }

    // Not enqueued - try to resolve the file path
    const filePath = await this.resolveFilePath(sessionId)
    if (!filePath) {
      // Session file doesn't exist - reject rather than returning 'missing'
      throw new Error(`Session ${sessionId} not in queue and file not found`)
    }

    const fileSessionId = path.basename(filePath, '.jsonl')
    const legacyResult = this.queue.getResult(fileSessionId)
    if (legacyResult) {
      const normalized = legacyResult.sessionId === sessionId
        ? legacyResult
        : { ...legacyResult, sessionId }
      if (fileSessionId !== sessionId) {
        this.queue.seedResult(sessionId, normalized)
      }
      return normalized
    }
    if (fileSessionId !== sessionId && this.queue.has(fileSessionId)) {
      const result = await this.queue.waitFor(fileSessionId, timeoutMs)
      const normalized = result.sessionId === sessionId
        ? result
        : { ...result, sessionId }
      this.queue.seedResult(sessionId, normalized)
      return normalized
    }

    // Check cache for recent result
    const cached = await this.cache.get(filePath, { allowStaleMs: ACTIVE_CACHE_GRACE_MS })
    if (cached) {
      if (cached.status === 'missing') {
        this.sessionPathIndex.delete(sessionId)
      }
      const normalized = cached.sessionId === sessionId
        ? cached
        : { ...cached, sessionId }
      this.queue.seedResult(sessionId, normalized)
      return normalized
    }

    // Enqueue and wait (avoid duplicate work if legacy ID is already queued)
    if (!this.queue.has(sessionId) && !this.queue.has(fileSessionId)) {
      this.queue.enqueue([{ sessionId, filePath, priority: 'active' }])
    }
    return this.queue.waitFor(sessionId, timeoutMs)
  }

  /**
   * Get the scan result for a session if already processed.
   */
  getResult(sessionId: string): SessionScanResult | undefined {
    return this.queue.getResult(sessionId)
  }

  /**
   * Clean up backup files older than retention period.
   */
  private async cleanupOldBackups(): Promise<void> {
    const claudeBase = this.claudeBase
    const retentionMs = BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000
    const cutoff = Date.now() - retentionMs

    try {
      const backups = await glob('*/*.jsonl.backup-*', {
        cwd: claudeBase,
        absolute: true,
        nodir: true,
      })

      let cleaned = 0
      for (const backup of backups) {
        // Extract timestamp from filename: session.jsonl.backup-1706644800000
        const match = backup.match(/\.backup-(\d+)$/)
        if (match) {
          const timestamp = parseInt(match[1], 10)
          if (timestamp < cutoff) {
            try {
              await fs.unlink(backup)
              cleaned++
            } catch (err) {
              logger.debug({ err, backup }, 'Failed to delete old backup')
            }
          }
        }
      }

      if (cleaned > 0) {
        logger.info({ cleaned }, 'Cleaned up old session backups')
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to cleanup backups')
    }
  }

  private ensureSessionIndex(): void {
    if (this.indexInitialized) return
    for (const filePath of this.cache.listPaths()) {
      const sessionId = path.basename(filePath, '.jsonl')
      this.sessionPathIndex.set(sessionId, filePath)
    }
    this.indexInitialized = true
  }

  private resolveCachedPath(sessionId: string): string | null {
    this.ensureSessionIndex()
    return this.sessionPathIndex.get(sessionId) || null
  }

  private async resolveFilePath(sessionId: string): Promise<string | null> {
    if (this.filePathResolver) {
      const resolved = this.filePathResolver(sessionId)
      if (resolved) {
        this.sessionPathIndex.set(sessionId, resolved)
        return resolved
      }
    }

    const cached = this.resolveCachedPath(sessionId)
    if (cached) return cached

    try {
      const matches = await glob(`*/${sessionId}.jsonl`, {
        cwd: this.claudeBase,
        absolute: true,
        nodir: true,
      })
      const match = matches[0] || null
      if (match) {
        this.sessionPathIndex.set(sessionId, match)
      }
      return match
    } catch (err) {
      logger.debug({ err, sessionId }, 'Failed to resolve session file path')
      return null
    }
  }

  private enqueueResolved(items: Array<{ sessionId: string; priority: Priority }>): void {
    // Always re-prioritize any existing queue entries, even if we can't resolve a path yet.
    this.queue.enqueue(
      items.map((item) => ({
        ...item,
        filePath: '',
      }))
    )

    const immediate: Array<{ sessionId: string; filePath: string; priority: Priority }> = []
    const pending: Array<{ sessionId: string; priority: Priority }> = []

    for (const item of items) {
      const cached = this.resolveCachedPath(item.sessionId)
      if (cached) {
        const fileSessionId = path.basename(cached, '.jsonl')
        if (this.queue.has(item.sessionId) || this.queue.has(fileSessionId)) continue
        immediate.push({ ...item, filePath: cached })
      } else {
        pending.push(item)
      }
    }

    if (immediate.length > 0) {
      this.queue.enqueue(immediate)
    }

    if (pending.length > 0) {
      void (async () => {
        const resolved: Array<{ sessionId: string; filePath: string; priority: Priority }> = []
        for (const item of pending) {
          const filePath = await this.resolveFilePath(item.sessionId)
          if (filePath) {
            const fileSessionId = path.basename(filePath, '.jsonl')
            if (this.queue.has(item.sessionId) || this.queue.has(fileSessionId)) continue
            resolved.push({ ...item, filePath })
          }
        }
        if (resolved.length > 0) {
          this.queue.enqueue(resolved)
        }
      })().catch((err) => {
        logger.warn({ err, sessionIds: pending.map((i) => i.sessionId) }, 'Failed to resolve pending session file paths')
      })
    }
  }
}

// Singleton instance
let instance: SessionRepairService | null = null

/**
 * Get or create the session repair service singleton.
 */
export function getSessionRepairService(options?: SessionRepairServiceOptions): SessionRepairService {
  if (!instance) {
    instance = new SessionRepairService(options)
  }
  return instance
}

/**
 * Reset the singleton (for testing).
 */
export function resetSessionRepairService(): void {
  instance = null
}
