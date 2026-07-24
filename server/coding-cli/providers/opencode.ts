import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { logger } from '../../logger.js'
import type { CodingCliProvider } from '../provider.js'
import type { CodingCliSession, NormalizedEvent, ParsedSessionMeta } from '../types.js'
import { resolveGitRepoRoot } from '../utils.js'
import { createWorkerListingRunner, type OpencodeListingQueryRunner } from './opencode-listing-runner.js'
import { THREE_VIEWS_MARKER_SQL_PATTERN } from './opencode-listing-query.js'
export { THREE_VIEWS_MARKER_SQL_PATTERN } from './opencode-listing-query.js'
export type { OpencodeSessionRow } from './opencode-listing-query.js'

type OpencodeSessionSchema = {
  hasParentId: boolean
}

type OpencodeDatabaseMessageClass =
  | 'missing_db'
  | 'empty_db'
  | 'sqlite_unavailable'
  | 'sqlite_open_failed'
  | 'schema_error'
  | 'read_error'
  | 'schema_missing_parent_id'

type OpencodeDatabaseLogLevel = 'debug' | 'info' | 'warn'

const OPENCODE_DB_BUSY_TIMEOUT_MS = 5000
const OPENCODE_ROOT_RESOLUTION_ATTEMPTS = 3
const OPENCODE_ROOT_RESOLUTION_RETRY_MS = 50

export type OpencodeRootResolution = {
  rootsBySessionId: Map<string, string>
  unresolvedSessionIds: Set<string>
}

export function defaultOpencodeDataHome(): string {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'opencode')
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'opencode')
  }
  return path.join(os.homedir(), '.local', 'share', 'opencode')
}

function toValidTimestamp(value: unknown): number | undefined {
  // SQLite columns are dynamically typed, so time_updated/time_created can arrive
  // as REAL. Downstream read-model schemas require integer epoch-ms, so floor.
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toSqliteBoolean(value: unknown): boolean {
  return value === true || value === 1
}

export type OpencodeProviderOptions = { queryRunner?: OpencodeListingQueryRunner }

export class OpencodeProvider implements CodingCliProvider {
  readonly name = 'opencode' as const
  readonly displayName = 'OpenCode'
  private sessionSchemaCache?: OpencodeSessionSchema
  private readonly loggedDatabaseStates = new Set<string>()
  private readonly queryRunner: OpencodeListingQueryRunner

  constructor(
    readonly homeDir: string = defaultOpencodeDataHome(),
    options: OpencodeProviderOptions = {},
  ) {
    this.queryRunner = options.queryRunner ?? createWorkerListingRunner()
  }

  private getDatabasePath(): string {
    return path.join(this.homeDir, 'opencode.db')
  }

  private getWatchedDatabasePaths(): [string, string] {
    const dbPath = this.getDatabasePath()
    return [dbPath, `${dbPath}-wal`]
  }

  private databaseLogFields(
    messageClass: OpencodeDatabaseMessageClass,
    error?: unknown,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      provider: this.name,
      dbPathLabel: '<opencode-data>/opencode.db',
      dbFile: 'opencode.db',
      pathSanitized: true,
      messageClass,
      ...(error instanceof Error ? { errorName: error.name } : {}),
      ...(extra ?? {}),
    }
  }

  private logDatabaseStateOnce(
    level: OpencodeDatabaseLogLevel,
    messageClass: OpencodeDatabaseMessageClass,
    message: string,
    options: {
      scope?: string
      error?: unknown
      extra?: Record<string, unknown>
    } = {},
  ): void {
    const key = `${options.scope ?? 'default'}:${messageClass}:${level}`
    if (this.loggedDatabaseStates.has(key)) return
    this.loggedDatabaseStates.add(key)
    logger[level](this.databaseLogFields(messageClass, options.error, options.extra), message)
  }

  private classifyDatabaseFailure(phase: 'open' | 'schema' | 'query' | 'map'): OpencodeDatabaseMessageClass {
    switch (phase) {
      case 'open':
        return 'sqlite_open_failed'
      case 'schema':
        return 'schema_error'
      case 'query':
      case 'map':
        return 'read_error'
    }
  }

  private configureReadOnlyDatabase(db: { exec?: (sql: string) => unknown }): void {
    db.exec?.(`PRAGMA busy_timeout = ${OPENCODE_DB_BUSY_TIMEOUT_MS}`)
  }

  async listSessionsDirect(): Promise<CodingCliSession[]> {
    const dbPath = this.getDatabasePath()
    try {
      await fsp.access(dbPath)
    } catch {
      this.logDatabaseStateOnce('info', 'missing_db', 'OpenCode sessions database is not available')
      return []
    }

    // Availability probe (cheap; cached). Preserves the exact sqlite_unavailable
    // behavior even though the heavy query runs off-thread. Same Node => same
    // availability inside the worker.
    try {
      await import('node:sqlite')
    } catch (err) {
      this.logDatabaseStateOnce('warn', 'sqlite_unavailable', 'node:sqlite unavailable — OpenCode sessions will not appear. Upgrade to Node 22.5+ to enable.', {
        error: err,
        extra: { nodeVersion: process.version },
      })
      return []
    }

    let result
    try {
      // The heavy open+schema+marker query runs OFF the event loop (worker thread).
      result = await this.queryRunner({ dbPath, markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN })
    } catch (err) {
      // A worker/read failure is transient infrastructure failure, NOT "no sessions".
      // Log once (sanitized) and re-throw: refreshDirectProvider catches this and
      // returns early WITHOUT pruning, preserving the previously-listed OpenCode
      // sessions. Returning [] here would make the indexer prune the whole sidebar.
      this.logDatabaseStateOnce('warn', 'read_error', 'Failed to read OpenCode sessions database', { error: err })
      throw err
    }

    if (result.schemaMissingParentId) {
      this.logDatabaseStateOnce('warn', 'schema_missing_parent_id', 'OpenCode session schema does not expose parent_id; treating sessions as flat roots')
    }
    if (result.rows.length === 0) {
      this.logDatabaseStateOnce('info', 'empty_db', 'OpenCode sessions database has no active root sessions', {
        extra: { rowCount: 0 },
      })
    }

    const sessions: CodingCliSession[] = []
    for (const row of result.rows) {
      if (typeof row.cwd !== 'string' || !row.cwd) continue
      const projectPath = row.projectPath || await resolveGitRepoRoot(row.cwd)
      const isThreeViewsSession = toSqliteBoolean(row.hasThreeViewsMarker)
      sessions.push({
        provider: this.name,
        sessionId: row.sessionId,
        projectPath,
        cwd: row.cwd,
        title: typeof row.title === 'string' ? row.title : undefined,
        lastActivityAt: toValidTimestamp(row.lastActivityAt) ?? Date.now(),
        createdAt: toValidTimestamp(row.createdAt),
        isSubagent: isThreeViewsSession || undefined,
        isNonInteractive: isThreeViewsSession || undefined,
      })
    }
    return sessions
  }

  async resolveOpencodeSessionRoots(sessionIds: readonly string[]): Promise<OpencodeRootResolution> {
    const requestedIds = Array.from(new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0)))
    const rootsBySessionId = new Map<string, string>()
    const unresolvedSessionIds = new Set<string>()
    if (requestedIds.length === 0) {
      return { rootsBySessionId, unresolvedSessionIds }
    }

    const dbPath = this.getDatabasePath()
    try {
      await fsp.access(dbPath)
    } catch {
      for (const id of requestedIds) unresolvedSessionIds.add(id)
      this.logDatabaseStateOnce('debug', 'missing_db', 'OpenCode database missing during root resolution', {
        scope: 'resolve',
        extra: { requestedSessionCount: requestedIds.length },
      })
      return { rootsBySessionId, unresolvedSessionIds }
    }

    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch (err) {
      this.logDatabaseStateOnce('warn', 'sqlite_unavailable', 'node:sqlite unavailable while resolving OpenCode roots', {
        scope: 'resolve',
        error: err,
        extra: {
          nodeVersion: process.version,
          requestedSessionCount: requestedIds.length,
        },
      })
      for (const id of requestedIds) unresolvedSessionIds.add(id)
      return { rootsBySessionId, unresolvedSessionIds }
    }

    let lastError: unknown
    let lastPhase: 'open' | 'schema' | 'query' | 'map' = 'open'
    for (let attempt = 1; attempt <= OPENCODE_ROOT_RESOLUTION_ATTEMPTS; attempt += 1) {
      let db: InstanceType<typeof sqlite.DatabaseSync> | undefined
      let phase: 'open' | 'schema' | 'query' | 'map' = 'open'
      try {
        db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
        this.configureReadOnlyDatabase(db)
        phase = 'schema'
        const schema = this.inspectSessionSchema(db)
        if (!schema.hasParentId) {
          for (const id of requestedIds) rootsBySessionId.set(id, id)
          return { rootsBySessionId, unresolvedSessionIds }
        }

        const rowsById = new Map<string, string | null>()
        let pending = requestedIds
        phase = 'query'
        while (pending.length > 0) {
          const placeholders = pending.map(() => '?').join(',')
          const rows = db.prepare(
            `SELECT id, parent_id FROM session WHERE id IN (${placeholders})`,
          ).all(...pending) as Array<{ id: string; parent_id: string | null }>
          const nextPending: string[] = []
          for (const row of rows) {
            if (typeof row.id !== 'string') continue
            rowsById.set(row.id, typeof row.parent_id === 'string' ? row.parent_id : null)
            if (row.parent_id && !rowsById.has(row.parent_id)) {
              nextPending.push(row.parent_id)
            }
          }
          pending = Array.from(new Set(nextPending))
        }

        phase = 'map'
        for (const requestedId of requestedIds) {
          let current: string | null | undefined = requestedId
          const seen = new Set<string>()
          while (current) {
            if (seen.has(current)) {
              unresolvedSessionIds.add(requestedId)
              break
            }
            seen.add(current)
            if (!rowsById.has(current)) {
              unresolvedSessionIds.add(requestedId)
              break
            }
            const parentId = rowsById.get(current)
            if (!parentId) {
              rootsBySessionId.set(requestedId, current)
              break
            }
            current = parentId
          }
        }
        return { rootsBySessionId, unresolvedSessionIds }
      } catch (err) {
        lastError = err
        lastPhase = phase
        if (attempt < OPENCODE_ROOT_RESOLUTION_ATTEMPTS) {
          await sleep(OPENCODE_ROOT_RESOLUTION_RETRY_MS)
        }
      } finally {
        db?.close()
      }
    }

    this.logDatabaseStateOnce('warn', this.classifyDatabaseFailure(lastPhase), 'Failed to resolve OpenCode root sessions', {
      scope: 'resolve',
      error: lastError,
      extra: { requestedSessionCount: requestedIds.length },
    })
    for (const id of requestedIds) unresolvedSessionIds.add(id)
    return { rootsBySessionId, unresolvedSessionIds }
  }

  private inspectSessionSchema(db: { prepare: (sql: string) => { all: (...args: any[]) => unknown[] } }): OpencodeSessionSchema {
    if (this.sessionSchemaCache) return this.sessionSchemaCache
    const rows = db.prepare('PRAGMA table_info(session)').all()
    const columnNames = new Set(rows
      .map((row) => (row as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string'))
    const schema = {
      hasParentId: columnNames.has('parent_id'),
    }
    if (!schema.hasParentId) {
      this.logDatabaseStateOnce('warn', 'schema_missing_parent_id', 'OpenCode session schema does not expose parent_id; treating sessions as flat roots')
    }
    this.sessionSchemaCache = schema
    return schema
  }

  getSessionGlob(): string[] {
    return this.getWatchedDatabasePaths()
  }

  getSessionRoots(): string[] {
    return [this.getDatabasePath()]
  }

  getSessionWatchBases(): string[] {
    return [path.dirname(this.homeDir)]
  }

  async listSessionFiles(): Promise<string[]> {
    return []
  }

  async parseSessionFile(): Promise<ParsedSessionMeta> {
    return {}
  }

  async resolveProjectPath(filePath: string, meta: ParsedSessionMeta): Promise<string> {
    return meta.cwd || path.dirname(filePath)
  }

  extractSessionId(filePath: string, meta?: ParsedSessionMeta): string {
    return meta?.sessionId || path.basename(filePath, path.extname(filePath))
  }

  getCommand(): string {
    return 'opencode'
  }

  getStreamArgs(): string[] {
    return []
  }

  getResumeArgs(sessionId: string): string[] {
    return ['--session', sessionId]
  }

  parseEvent(): NormalizedEvent[] {
    return []
  }

  supportsLiveStreaming(): boolean {
    return false
  }

  supportsSessionResume(): boolean {
    return true
  }
}

export const opencodeProvider = new OpencodeProvider()
