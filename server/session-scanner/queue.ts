/**
 * Session Repair Queue
 *
 * Prioritized queue for scanning and repairing sessions.
 * Priority order: active > visible > background > disk
 */

import { EventEmitter } from 'events'
import type {
  SessionScanner,
  SessionScanResult,
  SessionRepairResult,
} from './types.js'
import type { SessionCache } from './cache.js'

export type Priority = 'active' | 'visible' | 'background' | 'disk'

const PRIORITY_ORDER: Record<Priority, number> = {
  active: 0,
  visible: 1,
  background: 2,
  disk: 3,
}

const MAX_PROCESSED_CACHE = 1000
export const ACTIVE_CACHE_GRACE_MS = 15000

export interface QueueItem {
  sessionId: string
  filePath: string
  priority: Priority
  addedAt: number
}

interface WaitingPromise {
  resolve: (result: SessionScanResult) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/**
 * Session repair queue with priority ordering.
 */
export class SessionRepairQueue extends EventEmitter {
  private queue: QueueItem[] = []
  private queuedBySessionId: Map<string, QueueItem> = new Map()
  private processing: Set<string> = new Set()
  private processed: Map<string, SessionScanResult> = new Map()
  private scanner: SessionScanner
  private cache: SessionCache
  private running = false
  private stopped = false
  private hasStarted = false
  private waiting: Map<string, WaitingPromise[]> = new Map()
  private maxProcessedCache: number

  constructor(scanner: SessionScanner, cache: SessionCache, options?: { maxProcessedCache?: number }) {
    super()
    this.scanner = scanner
    this.cache = cache
    this.maxProcessedCache = options?.maxProcessedCache ?? MAX_PROCESSED_CACHE
  }

  /**
   * Add sessions to queue with priority.
   * Higher priority items are processed first.
   * Deduplicates - won't add if already queued or processing.
   *
   * If filePath is empty and the session already exists in queue,
   * only the priority will be updated (used for re-prioritization).
   */
  enqueue(
    sessions: Array<{ sessionId: string; filePath: string; priority: Priority }>
  ): void {
    let needsSort = false
    const now = Date.now()
    let order = 0

    for (const session of sessions) {
      // Skip if currently processing
      if (this.processing.has(session.sessionId)) continue

      // Check if already in queue
      const existing = this.queuedBySessionId.get(session.sessionId)

      if (existing) {
        if (session.filePath && session.filePath !== existing.filePath) {
          existing.filePath = session.filePath
        }
        // Re-prioritize if new priority is higher (lower number)
        if (PRIORITY_ORDER[session.priority] < PRIORITY_ORDER[existing.priority]) {
          existing.priority = session.priority
          needsSort = true
        }
      } else if (session.filePath) {
        // Only add new item if we have a filePath
        const item: QueueItem = {
          sessionId: session.sessionId,
          filePath: session.filePath,
          priority: session.priority,
          addedAt: now + order,
        }
        order += 1
        this.queue.push(item)
        this.queuedBySessionId.set(session.sessionId, item)
        needsSort = true
      }
      // If no existing entry and no filePath, skip silently
      // (session will be picked up on next full scan if it exists on disk)
    }

    if (needsSort) {
      this.sortQueue()
    }

    if (this.hasStarted && !this.running && !this.stopped && this.queue.length > 0) {
      this.start()
    }
  }

  /**
   * Sort queue by priority, then by addedAt (FIFO within priority).
   */
  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
      if (priorityDiff !== 0) return priorityDiff
      return a.addedAt - b.addedAt
    })
  }

  /**
   * Get queue size.
   */
  size(): number {
    return this.queue.length
  }

  /**
   * Peek at next item without removing.
   */
  peek(): QueueItem | undefined {
    return this.queue[0]
  }

  /**
   * Remove and return next item.
   */
  dequeue(): QueueItem | undefined {
    const item = this.queue.shift()
    if (item) {
      this.queuedBySessionId.delete(item.sessionId)
    }
    return item
  }

  /**
   * Start processing queue. Emits events for each completed item.
   */
  start(): void {
    if (this.stopped) return
    if (this.running) return
    this.hasStarted = true
    this.running = true
    this.processNext()
  }

  /**
   * Process next item in queue.
   */
  private async processNext(): Promise<void> {
    if (this.stopped || !this.running) return

    const item = this.dequeue()
    if (!item) {
      this.running = false
      return
    }

    this.processing.add(item.sessionId)

    try {
      // Check cache first
      const cached = await this.cache.get(item.filePath, {
        allowStaleMs: item.priority === 'active' ? ACTIVE_CACHE_GRACE_MS : undefined,
      })
      if (cached) {
        this.setProcessed(item.sessionId, cached)
        this.emit('scanned', cached)
        this.resolveWaiting(item.sessionId, cached)
        this.processing.delete(item.sessionId)
        setImmediate(() => this.processNext())
        return
      }

      // Scan the session
      const scanResult = await this.scanner.scan(item.filePath)
      await this.cache.set(item.filePath, scanResult)
      this.emit('scanned', scanResult)

      // Repair if corrupted
      if (scanResult.status === 'corrupted') {
        const repairResult = await this.scanner.repair(item.filePath)
        this.emit('repaired', repairResult)

        // Re-scan to get updated result
        const newResult = await this.scanner.scan(item.filePath)
        await this.cache.set(item.filePath, newResult)
        this.setProcessed(item.sessionId, newResult)
        this.resolveWaiting(item.sessionId, newResult)
      } else {
        this.setProcessed(item.sessionId, scanResult)
        this.resolveWaiting(item.sessionId, scanResult)
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.emit('error', item.sessionId, error)
      this.rejectWaiting(item.sessionId, error)
    } finally {
      this.processing.delete(item.sessionId)
    }

    // Process next item
    setImmediate(() => this.processNext())
  }

  /**
   * Resolve all waiting promises for a session.
   */
  private resolveWaiting(sessionId: string, result: SessionScanResult): void {
    const waiting = this.waiting.get(sessionId)
    if (waiting) {
      for (const w of waiting) {
        clearTimeout(w.timeout)
        w.resolve(result)
      }
      this.waiting.delete(sessionId)
    }
  }

  /**
   * Reject all waiting promises for a session.
   */
  private rejectWaiting(sessionId: string, error: Error): void {
    const waiting = this.waiting.get(sessionId)
    if (waiting) {
      for (const w of waiting) {
        clearTimeout(w.timeout)
        w.reject(error)
      }
      this.waiting.delete(sessionId)
    }
  }

  private setProcessed(sessionId: string, result: SessionScanResult): void {
    if (this.processed.has(sessionId)) {
      this.processed.delete(sessionId)
    }
    this.processed.set(sessionId, result)

    if (this.processed.size > this.maxProcessedCache) {
      const oldest = this.processed.keys().next().value
      if (oldest) {
        this.processed.delete(oldest)
      }
    }
  }

  /**
   * Store a result and resolve any waiters without queueing work.
   */
  seedResult(sessionId: string, result: SessionScanResult): void {
    this.setProcessed(sessionId, result)
    this.resolveWaiting(sessionId, result)
  }

  /**
   * Stop processing (graceful shutdown).
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.running = false

    // Reject all waiting promises
    for (const [sessionId, waiting] of this.waiting) {
      for (const w of waiting) {
        clearTimeout(w.timeout)
        w.reject(new Error('Queue stopped'))
      }
    }
    this.waiting.clear()
  }

  /**
   * Wait for a session to be processed.
   */
  waitFor(sessionId: string, timeoutMs = 30000): Promise<SessionScanResult> {
    // Check if already processed
    const existing = this.processed.get(sessionId)
    if (existing) {
      return Promise.resolve(existing)
    }

    // Check if in queue or processing
    const inQueue = this.queuedBySessionId.has(sessionId)
    const isProcessing = this.processing.has(sessionId)

    if (!inQueue && !isProcessing) {
      return Promise.reject(new Error(`Session ${sessionId} not in queue (timeout)`))
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from waiting list
        const waiting = this.waiting.get(sessionId)
        if (waiting) {
          const idx = waiting.findIndex((w) => w.resolve === resolve)
          if (idx >= 0) waiting.splice(idx, 1)
          if (waiting.length === 0) this.waiting.delete(sessionId)
        }
        reject(new Error(`Timeout waiting for session ${sessionId}`))
      }, timeoutMs)

      const entry: WaitingPromise = { resolve, reject, timeout }

      if (!this.waiting.has(sessionId)) {
        this.waiting.set(sessionId, [])
      }
      this.waiting.get(sessionId)!.push(entry)
    })
  }

  /**
   * Check if a session is currently being processed.
   */
  isProcessing(sessionId: string): boolean {
    return this.processing.has(sessionId)
  }

  /**
   * Check if a session is in the queue (not yet processing).
   */
  isQueued(sessionId: string): boolean {
    return this.queuedBySessionId.has(sessionId)
  }

  /**
   * Get the last processed result for a session, if any.
   */
  getResult(sessionId: string): SessionScanResult | undefined {
    return this.processed.get(sessionId)
  }
}
