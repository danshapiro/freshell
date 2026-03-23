import fsp from 'fs/promises'
import path from 'path'
import { logger } from './logger.js'
import { makeSessionKey, type CodingCliProviderName } from './coding-cli/types.js'

export interface SessionMetadataEntry {
  sessionType?: string
}

interface MetadataFileV1 {
  version: 1
  sessions: Record<string, Record<string, SessionMetadataEntry>>
}

interface MetadataFile {
  version: 2
  sessions: Record<string, SessionMetadataEntry>
}

/**
 * Simple promise-based mutex to serialize write operations.
 * Prevents TOCTOU race conditions in read-modify-write cycles.
 */
class Mutex {
  private queue: Promise<void> = Promise.resolve()

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.queue
    let resolve: () => void
    this.queue = new Promise((r) => (resolve = r))
    await release
    try {
      return await fn()
    } finally {
      resolve!()
    }
  }
}

/** Create a null-prototype object, safe from __proto__ pollution. */
function safeRecord<V>(): Record<string, V> {
  return Object.create(null) as Record<string, V>
}

/** Convert a parsed JSON object to a null-prototype record. */
function toSafeRecord<V>(obj: Record<string, V>): Record<string, V> {
  const result = safeRecord<V>()
  for (const [key, value] of Object.entries(obj)) {
    result[key] = value
  }
  return result
}

export class SessionMetadataStore {
  private dir: string
  private cache: MetadataFile | null = null
  private writeMutex = new Mutex()

  constructor(dir: string) {
    this.dir = dir
  }

  private filePath(): string {
    return path.join(this.dir, 'session-metadata.json')
  }

  private async load(): Promise<MetadataFile> {
    if (this.cache) return this.cache
    try {
      const raw = await fsp.readFile(this.filePath(), 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed?.version === 2 && parsed?.sessions) {
        this.cache = {
          version: 2,
          sessions: toSafeRecord(parsed.sessions as Record<string, SessionMetadataEntry>),
        }
        return this.cache
      }
      if (parsed?.version === 1 && parsed?.sessions) {
        const sessions = safeRecord<SessionMetadataEntry>()
        for (const [provider, providerSessions] of Object.entries((parsed as MetadataFileV1).sessions)) {
          for (const [sessionId, entry] of Object.entries(providerSessions)) {
            sessions[makeSessionKey(provider as CodingCliProviderName, sessionId)] = { ...entry }
          }
        }
        this.cache = { version: 2, sessions }
        return this.cache
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, event: 'session_metadata_read_error' }, 'Failed to read session metadata')
      }
    }
    this.cache = { version: 2, sessions: safeRecord() }
    return this.cache
  }

  private async save(data: MetadataFile): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    const tmpPath = `${this.filePath()}.tmp-${process.pid}-${Date.now()}`
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    try {
      await fsp.rename(tmpPath, this.filePath())
    } finally {
      await fsp.rm(tmpPath, { force: true })
    }
    this.cache = data
  }

  async get(provider: string, sessionId: string, cwd?: string): Promise<SessionMetadataEntry | undefined> {
    const data = await this.load()
    const entry = data.sessions[makeSessionKey(provider as CodingCliProviderName, sessionId, cwd)]
    return entry ? { ...entry } : undefined
  }

  async getAll(): Promise<Record<string, SessionMetadataEntry>> {
    const data = await this.load()
    const result: Record<string, SessionMetadataEntry> = {}
    for (const [sessionKey, entry] of Object.entries(data.sessions)) {
      result[sessionKey] = { ...entry }
    }
    return result
  }

  async set(provider: string, sessionId: string, entry: SessionMetadataEntry, cwd?: string): Promise<void> {
    return this.writeMutex.acquire(async () => {
      const current = await this.load()
      const sessions = safeRecord<SessionMetadataEntry>()
      for (const [sessionKey, currentEntry] of Object.entries(current.sessions)) {
        sessions[sessionKey] = { ...currentEntry }
      }
      sessions[makeSessionKey(provider as CodingCliProviderName, sessionId, cwd)] = { ...entry }
      await this.save({ version: 2, sessions })
    })
  }
}
