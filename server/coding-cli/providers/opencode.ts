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

type SqliteModule = Pick<typeof import('node:sqlite'), 'DatabaseSync'>
type SqliteModuleLoader = () => Promise<SqliteModule>

function defaultOpencodeDataHome(): string {
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

  constructor(
    readonly homeDir: string = defaultOpencodeDataHome(),
    private readonly loadSqlite: SqliteModuleLoader = () => import('node:sqlite'),
  ) {}

  private getDatabasePath(): string {
    return path.join(this.homeDir, 'opencode.db')
  }

  async listSessionsDirect(): Promise<CodingCliSession[]> {
    const dbPath = this.getDatabasePath()
    try {
      await fsp.access(dbPath)
    } catch {
      return []
    }

    let sqlite: SqliteModule
    try {
      sqlite = await this.loadSqlite()
    } catch {
      logger.warn({ provider: this.name, nodeVersion: process.version }, 'node:sqlite unavailable — OpenCode sessions will not appear. Upgrade to Node 22.5+ to enable.')
      return []
    }

    let db: InstanceType<typeof sqlite.DatabaseSync> | undefined
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
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
        WHERE s.parent_id IS NULL
          AND s.time_archived IS NULL
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

  getSessionGlob(): string {
    return this.getDatabasePath()
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
