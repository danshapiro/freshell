import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runOpencodeListingQuery,
  THREE_VIEWS_MARKER_SQL_PATTERN,
} from '../../../../server/coding-cli/providers/opencode-listing-query'

vi.unmock('node:sqlite')

type SqliteModule = typeof import('node:sqlite')
type DatabaseSyncConstructor = SqliteModule['DatabaseSync']
type DatabaseSyncInstance = InstanceType<DatabaseSyncConstructor>

const threeViewsMarker = '<freshell-session-metadata origin=3-views noninteractive=true>'

describe('runOpencodeListingQuery', () => {
  let tempDir: string
  let DatabaseSync: DatabaseSyncConstructor

  beforeAll(async () => {
    DatabaseSync = (await import('node:sqlite')).DatabaseSync
  })
  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-query-'))
  })
  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  function createSchema(db: DatabaseSyncInstance, opts: { parentId?: boolean } = {}): void {
    const parentCol = opts.parentId === false ? '' : 'parent_id text,'
    db.exec(`
      CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
      CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, ${parentCol} slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
      CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    `)
  }
  function seedProject(db: DatabaseSyncInstance) {
    db.prepare(`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)`).run('project-1', '/repo/root', 900, 4000, '[]')
  }
  function seedSession(db: DatabaseSyncInstance, id: string, title: string, timeUpdated: number, parentId: string | null = null, archived: number | null = null) {
    db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, 'project-1', parentId, id, '/repo/root', title, 'test', 1000, timeUpdated, archived)
  }
  // For the parent_id-absent schema: an INSERT that does NOT reference the
  // missing parent_id column (seedSession would fail at bind time otherwise).
  function seedFlatSession(db: DatabaseSyncInstance, id: string, title: string, timeUpdated: number) {
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, 'project-1', id, '/repo/root', title, 'test', 1000, timeUpdated, null)
  }
  function seedMessage(db: DatabaseSyncInstance, id: string, sessionId: string, data: string) {
    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(id, sessionId, 1100, 1100, data)
  }
  function seedPart(db: DatabaseSyncInstance, id: string, messageId: string, sessionId: string, data: string) {
    db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(id, messageId, sessionId, 1100, 1100, data)
  }

  it('flags marker in a part, marker in a message, and leaves a normal session unmarked; sorted by time_updated desc', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      createSchema(db)
      seedProject(db)
      seedSession(db, 'session-part-marker', 'Part marker', 3000)
      seedSession(db, 'session-message-marker', 'Message marker', 2500)
      seedSession(db, 'session-normal', 'Normal', 2000)
      seedMessage(db, 'm-part', 'session-part-marker', JSON.stringify({ role: 'user' }))
      seedPart(db, 'p-marked', 'm-part', 'session-part-marker', JSON.stringify({ type: 'text', text: `hi\n${threeViewsMarker}` }))
      seedMessage(db, 'm-msg', 'session-message-marker', JSON.stringify({ role: 'user', text: `hi\n${threeViewsMarker}` }))
      seedMessage(db, 'm-normal', 'session-normal', JSON.stringify({ role: 'user', text: 'ordinary prompt' }))
    } finally {
      db.close()
    }

    const result = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)

    expect(result.schemaMissingParentId).toBe(false)
    expect(result.rows.map((r) => [r.sessionId, !!r.hasThreeViewsMarker])).toEqual([
      ['session-part-marker', true],
      ['session-message-marker', true],
      ['session-normal', false],
    ])
    expect(result.rows[0]).toMatchObject({ cwd: '/repo/root', title: 'Part marker', createdAt: 1000, lastActivityAt: 3000, projectPath: '/repo/root' })
  })

  it('excludes archived sessions and child sessions (parent_id not null)', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      createSchema(db)
      seedProject(db)
      seedSession(db, 'root', 'Root', 3000)
      seedSession(db, 'child', 'Child', 2900, 'root')
      seedSession(db, 'archived', 'Archived', 2800, null, 5000)
    } finally {
      db.close()
    }
    const result = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(result.rows.map((r) => r.sessionId)).toEqual(['root'])
  })

  it('reports schemaMissingParentId and returns all non-archived sessions when parent_id is absent', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      createSchema(db, { parentId: false })
      seedProject(db)
      seedFlatSession(db, 'a', 'A', 3000)
      seedFlatSession(db, 'b', 'B', 2000)
    } finally {
      db.close()
    }
    const result = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(result.schemaMissingParentId).toBe(true)
    expect(result.rows.map((r) => r.sessionId)).toEqual(['a', 'b'])
  })

  it('degrades to unmarked (no throw) when part/message tables are absent', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      // Only project + session — mirrors the e2e fake-opencode fixture's schema.
      db.exec(`
        CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
        CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
      `)
      seedProject(db)
      seedSession(db, 'only', 'Only', 2000)
    } finally {
      db.close()
    }
    const result = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(result.rows.map((r) => [r.sessionId, !!r.hasThreeViewsMarker])).toEqual([['only', false]])
  })

  it('still detects a marker when only the part table is present (no message table)', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
        CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
        CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      `)
      seedProject(db)
      seedSession(db, 'p-marked', 'PartMarked', 3000)
      seedSession(db, 'p-plain', 'PartPlain', 2000)
      seedPart(db, 'pp', 'mm', 'p-marked', JSON.stringify({ type: 'text', text: `x\n${threeViewsMarker}` }))
    } finally {
      db.close()
    }
    const result = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(result.rows.map((r) => [r.sessionId, !!r.hasThreeViewsMarker])).toEqual([['p-marked', true], ['p-plain', false]])
  })

  it('still detects a marker when only the message table is present (no part table)', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
        CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
        CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      `)
      seedProject(db)
      seedSession(db, 'm-marked', 'MsgMarked', 3000)
      seedSession(db, 'm-plain', 'MsgPlain', 2000)
      seedMessage(db, 'mm', 'm-marked', JSON.stringify({ role: 'user', text: `x\n${threeViewsMarker}` }))
    } finally {
      db.close()
    }
    const result = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(result.rows.map((r) => [r.sessionId, !!r.hasThreeViewsMarker])).toEqual([['m-marked', true], ['m-plain', false]])
  })
})
