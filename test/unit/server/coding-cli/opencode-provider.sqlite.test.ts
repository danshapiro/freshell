import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpencodeProvider } from '../../../../server/coding-cli/providers/opencode'
import { inProcessListingRunner } from '../../../../server/coding-cli/providers/opencode-listing-runner'

vi.unmock('node:sqlite')

type SqliteModule = typeof import('node:sqlite')
type DatabaseSyncConstructor = SqliteModule['DatabaseSync']
type DatabaseSyncInstance = InstanceType<DatabaseSyncConstructor>

const threeViewsMarker = '<freshell-session-metadata origin=3-views noninteractive=true>'

describe('OpencodeProvider SQLite marker detection', () => {
  let tempDir: string
  let DatabaseSync: DatabaseSyncConstructor

  beforeAll(async () => {
    vi.resetModules()
    try {
      const sqlite = await import('node:sqlite')
      DatabaseSync = sqlite.DatabaseSync
    } catch (error) {
      throw new Error(
        `OpencodeProvider SQLite marker detection tests require Node.js with node:sqlite support. Current Node: ${process.version}`,
        { cause: error },
      )
    }
  })

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-sqlite-'))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  function createOpencodeSchema(db: DatabaseSyncInstance): void {
    db.exec(`
      CREATE TABLE project (
        id text PRIMARY KEY,
        worktree text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        sandboxes text NOT NULL
      );

      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        title text NOT NULL,
        version text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_archived integer
      );

      CREATE TABLE message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );

      CREATE TABLE part (
        id text PRIMARY KEY,
        message_id text NOT NULL,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `)
  }

  function insertSession(db: DatabaseSyncInstance, id: string, title: string, timeUpdated: number): void {
    db.prepare(`
      INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'project-1', null, id, '/repo/root', title, 'test', 1000, timeUpdated, null)
  }

  function insertMessage(db: DatabaseSyncInstance, id: string, sessionId: string, data: string): void {
    db.prepare(`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, sessionId, 1100, 1100, data)
  }

  function insertPart(db: DatabaseSyncInstance, id: string, messageId: string, sessionId: string, data: string): void {
    db.prepare(`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, messageId, sessionId, 1100, 1100, data)
  }

  it('marks 3-views OpenCode sessions as subagent and non-interactive without changing the title', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      createOpencodeSchema(db)
      db.prepare(`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES (?, ?, ?, ?, ?)
      `).run('project-1', '/repo/root', 900, 4000, '[]')

      insertSession(db, 'session-part-marker', 'Review OpenCode session state restoration', 3000)
      insertSession(db, 'session-message-marker', 'Review marker from message payload', 2500)
      insertSession(db, 'session-normal', 'Normal OpenCode session', 2000)

      insertMessage(db, 'message-part-marker', 'session-part-marker', JSON.stringify({ role: 'user' }))
      insertPart(
        db,
        'part-marked',
        'message-part-marker',
        'session-part-marker',
        JSON.stringify({
          type: 'text',
          synthetic: true,
          text: `attached prompt\n${threeViewsMarker}`,
        }),
      )

      insertMessage(
        db,
        'message-message-marker',
        'session-message-marker',
        JSON.stringify({ role: 'user', text: `attached prompt\n${threeViewsMarker}` }),
      )
      insertMessage(
        db,
        'message-normal',
        'session-normal',
        JSON.stringify({ role: 'user', text: 'ordinary OpenCode prompt' }),
      )
    } finally {
      db.close()
    }

    const provider = new OpencodeProvider(tempDir, { queryRunner: inProcessListingRunner })
    const sessions = await provider.listSessionsDirect()

    expect(sessions).toEqual([
      {
        provider: 'opencode',
        sessionId: 'session-part-marker',
        projectPath: '/repo/root',
        cwd: '/repo/root',
        title: 'Review OpenCode session state restoration',
        createdAt: 1000,
        lastActivityAt: 3000,
        isSubagent: true,
        isNonInteractive: true,
      },
      {
        provider: 'opencode',
        sessionId: 'session-message-marker',
        projectPath: '/repo/root',
        cwd: '/repo/root',
        title: 'Review marker from message payload',
        createdAt: 1000,
        lastActivityAt: 2500,
        isSubagent: true,
        isNonInteractive: true,
      },
      {
        provider: 'opencode',
        sessionId: 'session-normal',
        projectPath: '/repo/root',
        cwd: '/repo/root',
        title: 'Normal OpenCode session',
        createdAt: 1000,
        lastActivityAt: 2000,
      },
    ])
  })
})
