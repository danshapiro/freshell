import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OpencodeProvider } from '../../../../server/coding-cli/providers/opencode'

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
}>()

class FakeDatabaseSync {
  static seed(
    dbPath: string,
    rows: {
      projects: FakeProjectRow[]
      sessions: FakeSessionRow[]
    },
  ) {
    fakeDatabaseState.set(dbPath, rows)
  }

  constructor(private readonly dbPath: string) {}

  prepare() {
    return {
      all: () => {
        const rows = fakeDatabaseState.get(this.dbPath) ?? { projects: [], sessions: [] }
        return rows.sessions
          .filter((session) => session.parent_id === null && session.time_archived === null)
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

  close() {}
}

describe('OpencodeProvider', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-provider-'))
  })

  afterEach(async () => {
    fakeDatabaseState.clear()
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

    const provider = new OpencodeProvider(
      tempDir,
      async () => ({
        DatabaseSync: FakeDatabaseSync as unknown as typeof import('node:sqlite').DatabaseSync,
      }),
    )
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
})
