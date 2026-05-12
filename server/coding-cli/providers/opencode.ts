import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { logger } from '../../logger.js'
import type { CodingCliProvider } from '../provider.js'
import type { CodingCliSession, NormalizedEvent, ParsedSessionMeta } from '../types.js'
import { resolveGitRepoRoot } from '../utils.js'

type OpencodeSessionRow = {
  sessionId: string
  cwd: string
  title: string
  createdAt: number
  lastActivityAt: number
  projectPath: string | null
}

type OpencodeSessionSchema = {
  hasParentId: boolean
}

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
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export class OpencodeProvider implements CodingCliProvider {
  readonly name = 'opencode' as const
  readonly displayName = 'OpenCode'
  private sessionSchemaCache?: OpencodeSessionSchema

  constructor(readonly homeDir: string = defaultOpencodeDataHome()) {}

  private getDatabasePath(): string {
    return path.join(this.homeDir, 'opencode.db')
  }

  private getWatchedDatabasePaths(): [string, string] {
    const dbPath = this.getDatabasePath()
    return [dbPath, `${dbPath}-wal`]
  }

  async listSessionsDirect(): Promise<CodingCliSession[]> {
    const dbPath = this.getDatabasePath()
    try {
      await fsp.access(dbPath)
    } catch {
      return []
    }

    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch {
      logger.warn({ provider: this.name, nodeVersion: process.version }, 'node:sqlite unavailable — OpenCode sessions will not appear. Upgrade to Node 22.5+ to enable.')
      return []
    }

    let db: InstanceType<typeof sqlite.DatabaseSync> | undefined
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
      const schema = this.inspectSessionSchema(db)
      const rootFilter = schema.hasParentId ? 'AND s.parent_id IS NULL' : ''
      const rows = db.prepare(`
        SELECT
          s.id AS sessionId,
          s.directory AS cwd,
          s.title AS title,
          s.time_created AS createdAt,
          s.time_updated AS lastActivityAt,
          p.worktree AS projectPath
        FROM session s
        LEFT JOIN project p
          ON p.id = s.project_id
        WHERE s.time_archived IS NULL
          ${rootFilter}
        ORDER BY s.time_updated DESC
      `).all() as OpencodeSessionRow[]

      const sessions: CodingCliSession[] = []
      for (const row of rows) {
        if (typeof row.cwd !== 'string' || !row.cwd) continue
        const projectPath = row.projectPath || await resolveGitRepoRoot(row.cwd)
        sessions.push({
          provider: this.name,
          sessionId: row.sessionId,
          projectPath,
          cwd: row.cwd,
          title: typeof row.title === 'string' ? row.title : undefined,
          lastActivityAt: toValidTimestamp(row.lastActivityAt) ?? Date.now(),
          createdAt: toValidTimestamp(row.createdAt),
        })
      }
      return sessions
    } catch (err) {
      logger.warn({ err, dbPath, provider: this.name }, 'Failed to read OpenCode sessions database')
      return []
    } finally {
      db?.close()
    }
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
      logger.debug({ provider: this.name, dbPath, sessionIds: requestedIds }, 'OpenCode database missing during root resolution')
      return { rootsBySessionId, unresolvedSessionIds }
    }

    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch (err) {
      logger.warn({ err, provider: this.name, nodeVersion: process.version }, 'node:sqlite unavailable while resolving OpenCode roots')
      for (const id of requestedIds) unresolvedSessionIds.add(id)
      return { rootsBySessionId, unresolvedSessionIds }
    }

    let db: InstanceType<typeof sqlite.DatabaseSync> | undefined
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
      const schema = this.inspectSessionSchema(db)
      if (!schema.hasParentId) {
        for (const id of requestedIds) rootsBySessionId.set(id, id)
        return { rootsBySessionId, unresolvedSessionIds }
      }

      const rowsById = new Map<string, string | null>()
      let pending = requestedIds
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
      logger.warn({ err, dbPath, provider: this.name, sessionIds: requestedIds }, 'Failed to resolve OpenCode root sessions')
      for (const id of requestedIds) unresolvedSessionIds.add(id)
      return { rootsBySessionId, unresolvedSessionIds }
    } finally {
      db?.close()
    }
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
      logger.warn({ provider: this.name }, 'OpenCode session schema does not expose parent_id; treating sessions as flat roots')
    }
    this.sessionSchemaCache = schema
    return schema
  }

  getSessionGlob(): string {
    const [dbPath, walPath] = this.getWatchedDatabasePaths()
    return `{${dbPath},${walPath}}`
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
