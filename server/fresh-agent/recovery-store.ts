import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../logger.js'
import { getFreshellConfigDir } from '../freshell-home.js'

export type RecoveryStoreData = {
  version: 1
  /** sessionId -> ms timestamp of the user's explicit stop. */
  interrupts: Record<string, number>
  /** sessionId -> messageId -> ms timestamp of the injected continuation. */
  recoveries: Record<string, Record<string, number>>
}

/** Keep the file small: at most this many interrupts, and this many recoveries per session. */
const MAX_ENTRIES = 100

function emptyData(): RecoveryStoreData {
  return { version: 1, interrupts: {}, recoveries: {} }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecoveryStoreData(value: unknown): value is RecoveryStoreData {
  return (
    isPlainObject(value) &&
    value.version === 1 &&
    isPlainObject(value.interrupts) &&
    isPlainObject(value.recoveries)
  )
}

/** Drop the oldest entries (by timestamp, insertion order on ties) until the record fits the cap. */
function pruneOldest(record: Record<string, number>, max: number): void {
  const excess = Object.keys(record).length - max
  if (excess <= 0) return
  const oldestFirst = Object.entries(record).sort((a, b) => a[1] - b[1])
  for (const [key] of oldestFirst.slice(0, excess)) {
    delete record[key]
  }
}

/**
 * Durable store for fresh-agent restart recovery decisions:
 * - `interrupts`: explicit user stop intent per session ("never auto-recover after explicit stop").
 * - `recoveries`: at-most-one-recovery-per-(session, message) ledger.
 *
 * Persists to `~/.freshell/fresh-agent-recovery.json` via atomic temp-file + rename writes.
 * Holds only session/message ids and timestamps — never prompt or assistant text.
 */
export class FreshAgentRecoveryStore {
  private readonly filePath: string
  private cache: RecoveryStoreData | null = null
  /** Serializes load-mutate-write cycles so concurrent mutators cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options?: { filePath?: string }) {
    this.filePath = options?.filePath ?? path.join(getFreshellConfigDir(), 'fresh-agent-recovery.json')
  }

  async recordInterrupt(sessionId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      data.interrupts[sessionId] = Date.now()
      pruneOldest(data.interrupts, MAX_ENTRIES)
      await this.save(data)
    })
  }

  async clearInterrupt(sessionId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      if (!Object.hasOwn(data.interrupts, sessionId)) return
      delete data.interrupts[sessionId]
      await this.save(data)
    })
  }

  async hasInterrupt(sessionId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const data = await this.load()
      return Object.hasOwn(data.interrupts, sessionId)
    })
  }

  async recordRecovery(sessionId: string, messageId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const forSession = (data.recoveries[sessionId] ??= {})
      forSession[messageId] = Date.now()
      pruneOldest(forSession, MAX_ENTRIES)
      await this.save(data)
    })
  }

  async hasRecovery(sessionId: string, messageId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const data = await this.load()
      const forSession = data.recoveries[sessionId]
      return forSession !== undefined && Object.hasOwn(forSession, messageId)
    })
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn)
    // Keep the chain alive even if this operation rejects.
    this.queue = result.catch(() => undefined)
    return result
  }

  private async load(): Promise<RecoveryStoreData> {
    if (this.cache) return this.cache
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isRecoveryStoreData(parsed)) {
        this.cache = parsed
        return this.cache
      }
      logger.warn(
        { event: 'fresh_agent_recovery_store_invalid', filePath: this.filePath },
        'Fresh-agent recovery store file has unexpected shape; starting empty',
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(
          { err, event: 'fresh_agent_recovery_store_read_error', filePath: this.filePath },
          'Failed to read fresh-agent recovery store; starting empty',
        )
      }
    }
    this.cache = emptyData()
    return this.cache
  }

  private async save(data: RecoveryStoreData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8')
    try {
      await rename(tmpPath, this.filePath)
    } finally {
      await rm(tmpPath, { force: true })
    }
    this.cache = data
  }
}

let singleton: FreshAgentRecoveryStore | null = null

/** Lazy process-wide singleton backed by the default `~/.freshell` path. */
export function getFreshAgentRecoveryStore(): FreshAgentRecoveryStore {
  if (!singleton) singleton = new FreshAgentRecoveryStore()
  return singleton
}

/**
 * Test hook: with a `filePath`, pins the singleton to a store backed by that file;
 * without one, clears the singleton so the next get() lazily recreates the default.
 */
export function resetFreshAgentRecoveryStoreForTests(filePath?: string): void {
  singleton = filePath ? new FreshAgentRecoveryStore({ filePath }) : null
}
