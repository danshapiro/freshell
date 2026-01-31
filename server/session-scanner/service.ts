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
import { createSessionScanner } from './scanner.js'
import { SessionCache } from './cache.js'
import { SessionRepairQueue, type Priority } from './queue.js'
import type { SessionScanner, SessionScanResult, SessionRepairResult } from './types.js'

const BACKUP_RETENTION_DAYS = 30
const CACHE_FILENAME = 'session-cache.json'

export interface SessionRepairServiceOptions {
  /** Directory to store cache file. Defaults to ~/.freshell */
  cacheDir?: string
  /** Scanner implementation (for testing) */
  scanner?: SessionScanner
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

  constructor(options: SessionRepairServiceOptions = {}) {
    super()
    this.cacheDir = options.cacheDir || path.join(os.homedir(), '.freshell')
    this.scanner = options.scanner || createSessionScanner()
    this.cache = new SessionCache(path.join(this.cacheDir, CACHE_FILENAME))
    this.queue = new SessionRepairQueue(this.scanner, this.cache)

    // Forward queue events
    this.queue.on('scanned', (result: SessionScanResult) => this.emit('scanned', result))
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

    // Cleanup old backups
    await this.cleanupOldBackups()

    // Discover all session files
    const claudeBase = path.join(os.homedir(), '.claude', 'projects')
    let sessionFiles: string[] = []

    try {
      // Find all JSONL files (sessions) in project directories
      // Pattern: ~/.claude/projects/*/*.jsonl (session files are directly in project dirs)
      sessionFiles = await glob('*/*.jsonl', {
        cwd: claudeBase,
        absolute: true,
        nodir: true,
      })
    } catch (err) {
      logger.warn({ err }, 'Failed to glob session files')
    }

    // Queue all sessions at 'disk' priority
    if (sessionFiles.length > 0) {
      logger.info({ count: sessionFiles.length }, 'Discovered session files')
      this.queue.enqueue(
        sessionFiles.map((filePath) => ({
          sessionId: path.basename(filePath, '.jsonl'),
          filePath,
          priority: 'disk' as Priority,
        }))
      )
    }

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

  /**
   * Prioritize sessions from a client's hello message.
   * Called when a client connects with session IDs.
   */
  prioritizeSessions(sessions: {
    active?: string
    visible?: string[]
    background?: string[]
  }): void {
    const claudeBase = path.join(os.homedir(), '.claude', 'projects')
    const items: Array<{ sessionId: string; filePath: string; priority: Priority }> = []

    // Helper to find session file path
    const findSessionFile = async (sessionId: string): Promise<string | null> => {
      // Try to find the session file in any project directory
      const matches = await glob(`*/${sessionId}.jsonl`, {
        cwd: claudeBase,
        absolute: true,
        nodir: true,
      })
      return matches[0] || null
    }

    // We need to resolve paths synchronously, so we'll use a simple heuristic:
    // Just build paths and let the queue handle missing files gracefully

    if (sessions.active) {
      items.push({
        sessionId: sessions.active,
        filePath: '', // Will be resolved by queue or cached
        priority: 'active',
      })
    }

    for (const id of sessions.visible || []) {
      items.push({
        sessionId: id,
        filePath: '',
        priority: 'visible',
      })
    }

    for (const id of sessions.background || []) {
      items.push({
        sessionId: id,
        filePath: '',
        priority: 'background',
      })
    }

    // Re-prioritize in queue (queue will handle missing filePath by looking up existing entries)
    this.queue.enqueue(items)
  }

  /**
   * Wait for a session to be scanned/repaired.
   * Used by terminal.create before spawning Claude with --resume.
   */
  async waitForSession(sessionId: string, timeoutMs = 30000): Promise<SessionScanResult> {
    return this.queue.waitFor(sessionId, timeoutMs)
  }

  /**
   * Get the scan result for a session if already processed.
   */
  getResult(sessionId: string): SessionScanResult | undefined {
    // Check if in processed cache
    return undefined // Queue doesn't expose processed map, rely on waitFor
  }

  /**
   * Clean up backup files older than retention period.
   */
  private async cleanupOldBackups(): Promise<void> {
    const claudeBase = path.join(os.homedir(), '.claude', 'projects')
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
