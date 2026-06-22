import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  executeHistory,
  OPENCODE_HISTORY_WORKER_KIND,
} from '../../../../server/fresh-agent/adapters/opencode/history-worker.js'

vi.unmock('node:sqlite')

type SqliteModule = typeof import('node:sqlite')
type DatabaseSyncConstructor = SqliteModule['DatabaseSync']
type DatabaseSyncInstance = InstanceType<DatabaseSyncConstructor>

const queryModuleUrl = new URL('../../../../server/fresh-agent/adapters/opencode/history-query.ts', import.meta.url).href

describe('opencode history worker executeHistory', () => {
  let tempDir: string
  let DatabaseSync: DatabaseSyncConstructor

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-history-worker-'))
    DatabaseSync = (await import('node:sqlite')).DatabaseSync
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  function createDatabase(name = 'opencode.db'): DatabaseSyncInstance {
    return new DatabaseSync(path.join(tempDir, name))
  }

  function createOpenCodeSchema(db: DatabaseSyncInstance): void {
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        directory text NOT NULL,
        title text NOT NULL,
        model text,
        cost real NOT NULL DEFAULT 0,
        tokens_input integer NOT NULL DEFAULT 0,
        tokens_output integer NOT NULL DEFAULT 0,
        tokens_reasoning integer NOT NULL DEFAULT 0,
        tokens_cache_read integer NOT NULL DEFAULT 0,
        tokens_cache_write integer NOT NULL DEFAULT 0,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
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

  function insertSession(db: DatabaseSyncInstance, overrides: { id?: string; model?: string } = {}): void {
    db.prepare(`
      INSERT INTO session (
        id,
        directory,
        title,
        model,
        cost,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write,
        time_created,
        time_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      overrides.id ?? 'ses-history-worker',
      '/repo',
      'Worker fixture',
      overrides.model ?? JSON.stringify({ providerID: 'opencode-go', id: 'deepseek-v4-flash' }),
      0,
      1,
      2,
      3,
      4,
      5,
      1000,
      2000,
    )
  }

  it('dynamically imports the query module and returns a structured result', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = createDatabase()
    try {
      createOpenCodeSchema(db)
      insertSession(db)
    } finally {
      db.close()
    }

    const response = await executeHistory({
      queryModuleUrl,
      dbPath,
      request: { type: 'session_info', sessionId: 'ses-history-worker' },
    })

    expect(response).toMatchObject({
      ok: true,
      result: {
        type: 'session_info',
        sessionInfo: { id: 'ses-history-worker', title: 'Worker fixture' },
      },
    })
  })

  it('returns missing_db before importing the query module', async () => {
    const response = await executeHistory({
      queryModuleUrl,
      dbPath: path.join(tempDir, 'missing-opencode.db'),
      request: { type: 'session_info', sessionId: 'missing' },
    })

    expect(response).toEqual({ ok: false, reason: 'missing_db' })
  })

  it('returns not_found when the query has no matching session', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = createDatabase()
    try {
      createOpenCodeSchema(db)
    } finally {
      db.close()
    }

    const response = await executeHistory({
      queryModuleUrl,
      dbPath,
      request: { type: 'session_info', sessionId: 'missing-session' },
    })

    expect(response).toEqual({ ok: false, reason: 'not_found' })
  })

  it('returns schema_mismatch with typed schema details', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = createDatabase()
    try {
      db.exec(`
        CREATE TABLE session (
          id text PRIMARY KEY,
          title text NOT NULL,
          model text,
          cost real NOT NULL DEFAULT 0,
          tokens_input integer NOT NULL DEFAULT 0,
          tokens_output integer NOT NULL DEFAULT 0,
          tokens_reasoning integer NOT NULL DEFAULT 0,
          tokens_cache_read integer NOT NULL DEFAULT 0,
          tokens_cache_write integer NOT NULL DEFAULT 0,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        );
      `)
    } finally {
      db.close()
    }

    const response = await executeHistory({
      queryModuleUrl,
      dbPath,
      request: { type: 'session_info', sessionId: 'ses-history-worker' },
    })

    expect(response).toMatchObject({
      ok: false,
      reason: 'schema_mismatch',
      error: {
        name: 'OpencodeHistorySchemaError',
        code: 'OPENCODE_HISTORY_SCHEMA_ERROR',
        table: 'session',
        missingColumns: expect.arrayContaining(['directory']),
      },
    })
  })

  it('returns read_error with serialized error details for non-schema read failures', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = createDatabase()
    try {
      createOpenCodeSchema(db)
      insertSession(db, { model: '{not-json' })
    } finally {
      db.close()
    }

    const response = await executeHistory({
      queryModuleUrl,
      dbPath,
      request: { type: 'session_info', sessionId: 'ses-history-worker' },
    })

    expect(response).toMatchObject({
      ok: false,
      reason: 'read_error',
      error: { name: 'Error' },
    })
    expect(response.ok === false ? response.error?.message : '').toContain('Failed to parse OpenCode session.model JSON')
  })

  it('does not auto-run on import under the threaded test runtime because of the sentinel guard', () => {
    expect(typeof executeHistory).toBe('function')
    expect(OPENCODE_HISTORY_WORKER_KIND).toBe('opencode-history-worker')
    expect(queryModuleUrl).toContain('history-query')
  })
})
