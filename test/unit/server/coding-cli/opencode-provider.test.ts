import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}))
loggerMock.child.mockReturnValue(loggerMock)

vi.mock('../../../../server/logger.js', () => ({
  logger: loggerMock,
  sessionLifecycleLogger: loggerMock,
}))

type FakeProjectRow = {
  id: string
  worktree: string
}

type FakeSessionRow = {
  id: string
  project_id: string
  parent_id: string | null
  directory: string
  title: string
  time_created: number | null
  time_updated: number | null
  time_archived: number | null
}

const fakeDatabaseState = new Map<string, {
  projects: FakeProjectRow[]
  sessions: FakeSessionRow[]
  hasParentId?: boolean
}>()

class FakeDatabaseSync {
  private static openFailures: Error[] = []
  private static rootQueryFailures: Error[] = []

  static seed(
    dbPath: string,
    rows: {
      projects: FakeProjectRow[]
      sessions: FakeSessionRow[]
      hasParentId?: boolean
    },
  ): void {
    fakeDatabaseState.set(dbPath, rows)
  }

  static failOpenOnce(err: Error): void {
    this.openFailures.push(err)
  }

  static failRootQueryOnce(err: Error): void {
    this.rootQueryFailures.push(err)
  }

  static reset(): void {
    this.openFailures = []
    this.rootQueryFailures = []
  }

  constructor(private readonly dbPath: string) {
    const failure = FakeDatabaseSync.openFailures.shift()
    if (failure) throw failure
  }

  prepare(sql: string) {
    return {
      all: (...params: unknown[]) => {
        const rows = fakeDatabaseState.get(this.dbPath) ?? { projects: [], sessions: [], hasParentId: true }
        const hasParentId = rows.hasParentId ?? true
        if (/PRAGMA\s+table_info\(session\)/i.test(sql)) {
          return [
            { name: 'id' },
            { name: 'project_id' },
            ...(hasParentId ? [{ name: 'parent_id' }] : []),
            { name: 'directory' },
            { name: 'title' },
            { name: 'time_created' },
            { name: 'time_updated' },
            { name: 'time_archived' },
          ]
        }
        if (/SELECT\s+id,\s+parent_id\s+FROM\s+session/i.test(sql)) {
          const failure = FakeDatabaseSync.rootQueryFailures.shift()
          if (failure) throw failure
          if (!hasParentId) throw new Error('no such column: parent_id')
          const requested = new Set(params)
          return rows.sessions
            .filter((session) => requested.has(session.id))
            .map((session) => ({
              id: session.id,
              parent_id: session.parent_id,
            }))
        }
        if (!hasParentId && /parent_id/i.test(sql)) {
          throw new Error('no such column: parent_id')
        }
        return rows.sessions
          .filter((session) => (
            session.time_archived === null
            && (!hasParentId || session.parent_id === null)
          ))
          .sort((left, right) => (right.time_updated ?? 0) - (left.time_updated ?? 0))
          .map((session) => ({
            sessionId: session.id,
            cwd: session.directory,
            title: session.title,
            createdAt: session.time_created,
            lastActivityAt: session.time_updated,
            projectPath: rows.projects.find((project) => project.id === session.project_id)?.worktree ?? null,
          }))
      },
    }
  }

  exec(): void {}

  close(): void {}
}

vi.mock('node:sqlite', () => ({
  DatabaseSync: FakeDatabaseSync,
}))

import { OpencodeProvider } from '../../../../server/coding-cli/providers/opencode'

describe('OpencodeProvider', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-provider-'))
    fakeDatabaseState.clear()
    FakeDatabaseSync.reset()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    fakeDatabaseState.clear()
    FakeDatabaseSync.reset()
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('lists root sessions from the OpenCode database', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    await fsp.writeFile(dbPath, 'fake sqlite file', 'utf8')
    FakeDatabaseSync.seed(dbPath, {
      projects: [
        { id: 'project-1', worktree: '/repo/root' },
      ],
      sessions: [
        {
          id: 'session-root',
          project_id: 'project-1',
          parent_id: null,
          directory: '/repo/root/packages/app',
          title: 'OpenCode root session',
          time_created: 1000,
          time_updated: 2000,
          time_archived: null,
        },
        {
          id: 'session-child',
          project_id: 'project-1',
          parent_id: 'session-root',
          directory: '/repo/root/packages/app',
          title: 'Child session',
          time_created: 1001,
          time_updated: 2001,
          time_archived: null,
        },
        {
          id: 'session-archived',
          project_id: 'project-1',
          parent_id: null,
          directory: '/repo/root/packages/app',
          title: 'Archived session',
          time_created: 1002,
          time_updated: 2002,
          time_archived: 9999,
        },
      ],
    })

    const provider = new OpencodeProvider(tempDir)
    const sessions = await provider.listSessionsDirect()

    expect(provider.getSessionRoots()).toEqual([dbPath])
    expect(provider.supportsSessionResume()).toBe(true)
    expect(sessions).toEqual([
      {
        provider: 'opencode',
        sessionId: 'session-root',
        projectPath: '/repo/root',
        cwd: '/repo/root/packages/app',
        title: 'OpenCode root session',
        createdAt: 1000,
        lastActivityAt: 2000,
      },
    ])
  })

  it('watches OpenCode sqlite database and WAL but not SHM', () => {
    const provider = new OpencodeProvider(tempDir)
    const dbPath = path.join(tempDir, 'opencode.db')
    const glob = provider.getSessionGlob()

    expect(glob).toContain('opencode.db')
    expect(glob).toContain('opencode.db-wal')
    expect(glob).not.toContain('opencode.db-shm')
    expect(glob).not.toContain('*')
    expect(provider.getSessionRoots()).toEqual([dbPath])
    expect(provider.getSessionWatchBases()).toEqual([path.dirname(tempDir)])
  })

  it('logs missing OpenCode database as unavailable, not as a successful empty session list', async () => {
    const provider = new OpencodeProvider(tempDir)

    await expect(provider.listSessionsDirect()).resolves.toEqual([])

    expect(loggerMock.info).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      dbPathLabel: '<opencode-data>/opencode.db',
      dbFile: 'opencode.db',
      pathSanitized: true,
      messageClass: 'missing_db',
    }), 'OpenCode sessions database is not available')
    expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain(tempDir)
    expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain(os.tmpdir())
  })

  it('logs OpenCode database read failures distinctly from an empty database', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    await fsp.writeFile(dbPath, 'fake sqlite file', 'utf8')
    FakeDatabaseSync.failOpenOnce(new Error('bad sqlite'))
    const provider = new OpencodeProvider(tempDir)

    await expect(provider.listSessionsDirect()).resolves.toEqual([])

    expect(loggerMock.warn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      dbPathLabel: '<opencode-data>/opencode.db',
      dbFile: 'opencode.db',
      pathSanitized: true,
      errorName: 'Error',
      messageClass: 'sqlite_open_failed',
    }), 'Failed to read OpenCode sessions database')
    const serializedCalls = JSON.stringify(loggerMock.warn.mock.calls)
    expect(serializedCalls).not.toContain(tempDir)
    expect(serializedCalls).not.toContain(os.tmpdir())
    expect(serializedCalls).not.toContain('bad sqlite')
  })

  it('logs an empty OpenCode database as empty, not broken', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    await fsp.writeFile(dbPath, 'fake sqlite file', 'utf8')
    FakeDatabaseSync.seed(dbPath, {
      projects: [],
      sessions: [],
    })
    const provider = new OpencodeProvider(tempDir)

    await expect(provider.listSessionsDirect()).resolves.toEqual([])

    expect(loggerMock.info).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      dbPathLabel: '<opencode-data>/opencode.db',
      dbFile: 'opencode.db',
      pathSanitized: true,
      messageClass: 'empty_db',
      rowCount: 0,
    }), 'OpenCode sessions database has no active root sessions')
  })

  it('maps OpenCode child session ids to sqlite root session ids', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    await fsp.writeFile(dbPath, 'fake sqlite file', 'utf8')
    FakeDatabaseSync.seed(dbPath, {
      projects: [],
      sessions: [
        {
          id: 'root_session',
          project_id: 'project-1',
          parent_id: null,
          directory: '/repo/root',
          title: 'Root',
          time_created: 1000,
          time_updated: 2000,
          time_archived: null,
        },
        {
          id: 'child_session',
          project_id: 'project-1',
          parent_id: 'root_session',
          directory: '/repo/root',
          title: 'Child',
          time_created: 1001,
          time_updated: 2001,
          time_archived: null,
        },
      ],
    })

    const provider = new OpencodeProvider(tempDir)
    const resolved = await provider.resolveOpencodeSessionRoots(['child_session'])

    expect(resolved.rootsBySessionId.get('child_session')).toBe('root_session')
    expect(resolved.unresolvedSessionIds.size).toBe(0)
  })

  it('retries transient OpenCode root resolution read errors before marking sessions unresolved', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    await fsp.writeFile(dbPath, 'fake sqlite file', 'utf8')
    FakeDatabaseSync.seed(dbPath, {
      projects: [],
      sessions: [
        {
          id: 'root_session',
          project_id: 'project-1',
          parent_id: null,
          directory: '/repo/root',
          title: 'Root',
          time_created: 1000,
          time_updated: 2000,
          time_archived: null,
        },
        {
          id: 'child_session',
          project_id: 'project-1',
          parent_id: 'root_session',
          directory: '/repo/root',
          title: 'Child',
          time_created: 1001,
          time_updated: 2001,
          time_archived: null,
        },
      ],
    })
    FakeDatabaseSync.failRootQueryOnce(new Error('database is locked'))

    const provider = new OpencodeProvider(tempDir)
    const resolved = await provider.resolveOpencodeSessionRoots(['child_session'])

    expect(resolved.rootsBySessionId.get('child_session')).toBe('root_session')
    expect(resolved.unresolvedSessionIds.size).toBe(0)
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageClass: 'read_error' }),
      'Failed to resolve OpenCode root sessions',
    )
  })

  it('treats an OpenCode schema without parent_id as flat roots', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    await fsp.writeFile(dbPath, 'fake sqlite file', 'utf8')
    FakeDatabaseSync.seed(dbPath, {
      projects: [
        { id: 'project-1', worktree: '/repo/root' },
      ],
      hasParentId: false,
      sessions: [
        {
          id: 'flat_session',
          project_id: 'project-1',
          parent_id: null,
          directory: '/repo/root',
          title: 'Flat',
          time_created: 1000,
          time_updated: 2000,
          time_archived: null,
        },
      ],
    })

    const provider = new OpencodeProvider(tempDir)
    const resolved = await provider.resolveOpencodeSessionRoots(['flat_session'])
    const sessions = await provider.listSessionsDirect()

    expect(resolved.rootsBySessionId.get('flat_session')).toBe('flat_session')
    expect(resolved.unresolvedSessionIds.size).toBe(0)
    expect(sessions).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        sessionId: 'flat_session',
      }),
    ])
  })
})
