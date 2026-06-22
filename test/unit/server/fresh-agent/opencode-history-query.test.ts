import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  encodeOpencodeCursor,
  resolveOpencodeLegacySession,
  readOpencodeSessionInfo,
  readOpencodeSnapshotPage,
  readOpencodeTurnBody,
  readOpencodeTurnPage,
} from '../../../../server/fresh-agent/adapters/opencode/history-query.js'

vi.unmock('node:sqlite')

type SqliteModule = typeof import('node:sqlite')
type DatabaseSyncConstructor = SqliteModule['DatabaseSync']
type DatabaseSyncInstance = InstanceType<DatabaseSyncConstructor>

const sessionId = 'ses_opencode_db_history'
const otherSessionId = 'ses_other_opencode_db_history'
const baseTime = 1_779_557_095_000
const modelFixture = {
  providerID: 'opencode-go',
  id: 'deepseek-v4-flash',
  variant: 'max',
}

describe('OpenCode DB history query', () => {
  let tempDir: string
  let DatabaseSync: DatabaseSyncConstructor

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-history-query-'))
    DatabaseSync = (await import('node:sqlite')).DatabaseSync
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  function createDatabase(name = 'opencode.db'): DatabaseSyncInstance {
    return new DatabaseSync(path.join(tempDir, name))
  }

  function instrumentReadDatabase(db: DatabaseSyncInstance): { reader: Parameters<typeof readOpencodeSessionInfo>[0]; events: string[] } {
    const events: string[] = []
    return {
      events,
      reader: {
        exec(sql: string) {
          events.push(sql.trim())
          return db.exec(sql)
        },
        prepare(sql: string) {
          events.push(`PREPARE:${sql.trim()}`)
          return db.prepare(sql) as any
        },
      },
    }
  }

  function createOpenCodeSchema(db: DatabaseSyncInstance): void {
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        workspace_id text,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        path text,
        title text NOT NULL,
        version text NOT NULL,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        metadata text,
        cost real NOT NULL DEFAULT 0,
        tokens_input integer NOT NULL DEFAULT 0,
        tokens_output integer NOT NULL DEFAULT 0,
        tokens_reasoning integer NOT NULL DEFAULT 0,
        tokens_cache_read integer NOT NULL DEFAULT 0,
        tokens_cache_write integer NOT NULL DEFAULT 0,
        revert text,
        permission text,
        agent text,
        model text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_compacting integer,
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

  function insertSession(db: DatabaseSyncInstance, overrides: {
    id?: string
    directory?: string
    title?: string
    model?: unknown
    timeCreated?: number
    timeUpdated?: number
  } = {}): void {
    db.prepare(`
      INSERT INTO session (
        id,
        project_id,
        workspace_id,
        parent_id,
        slug,
        directory,
        path,
        title,
        version,
        share_url,
        summary_additions,
        summary_deletions,
        summary_files,
        summary_diffs,
        metadata,
        cost,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write,
        revert,
        permission,
        agent,
        model,
        time_created,
        time_updated,
        time_compacting,
        time_archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      overrides.id ?? sessionId,
      'project-1',
      'workspace-1',
      null,
      'opencode-db-history',
      overrides.directory ?? '/repo/opencode',
      '/repo/opencode/.opencode/session',
      overrides.title ?? 'Review DB history reads',
      '1.16.2',
      null,
      7,
      2,
      3,
      JSON.stringify([{ file: 'src/app.ts', additions: 7, deletions: 2 }]),
      JSON.stringify({ source: 'unit-test' }),
      0.42,
      111,
      222,
      33,
      44,
      55,
      null,
      'ask',
      'build',
      JSON.stringify(overrides.model ?? modelFixture),
      overrides.timeCreated ?? baseTime,
      overrides.timeUpdated ?? baseTime + 9_000,
      null,
      null,
    )
  }

  function insertMessage(
    db: DatabaseSyncInstance,
    messageId: string,
    createdOffset: number,
    data: Record<string, unknown>,
    targetSessionId = sessionId,
  ): void {
    const createdAt = baseTime + createdOffset
    db.prepare(`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(messageId, targetSessionId, createdAt, createdAt + 17, JSON.stringify(data))
  }

  function insertPart(
    db: DatabaseSyncInstance,
    partId: string,
    messageId: string,
    data: Record<string, unknown>,
    targetSessionId = sessionId,
  ): void {
    db.prepare(`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(partId, messageId, targetSessionId, baseTime + 50_000, baseTime + 50_017, JSON.stringify(data))
  }

  function seedConversation(db: DatabaseSyncInstance): void {
    createOpenCodeSchema(db)
    insertSession(db)

    insertMessage(db, 'message-1', 1_000, { role: 'user' })
    insertPart(db, 'part-1', 'message-1', { type: 'text', text: 'Summarize the project state.' })

    insertMessage(db, 'message-2', 2_000, {
      role: 'assistant',
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
    })
    insertPart(db, 'part-2', 'message-2', { type: 'text', text: 'The project is ready for a DB reader.' })

    insertMessage(db, 'message-3', 3_000, { role: 'user' })
    insertPart(db, 'part-3', 'message-3', {
      type: 'file',
      path: 'server/fresh-agent/adapters/opencode/history-query.ts',
      mime: 'text/typescript',
      content: 'export {}',
    })

    insertMessage(db, 'message-4', 4_000, {
      role: 'assistant',
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
    })
    insertPart(db, 'part-4', 'message-4', {
      type: 'patch',
      files: [{ path: 'server/fresh-agent/adapters/opencode/history-query.ts', additions: 12, deletions: 0 }],
      diff: 'diff --git a/history-query.ts b/history-query.ts',
    })

    insertMessage(db, 'message-5', 5_000, { role: 'assistant' })
    insertPart(db, 'part-5', 'message-5', {
      type: 'compaction',
      summary: 'Compacted earlier DB history context.',
      beforeTokens: 10_000,
      afterTokens: 3_500,
    })
  }

  it('reads session info with parsed model JSON, token fields, and millisecond timestamps', () => {
    const db = createDatabase()
    try {
      createOpenCodeSchema(db)
      insertSession(db, {
        title: 'Typed session metadata',
        directory: '/workspace/project',
        timeCreated: baseTime + 101,
        timeUpdated: baseTime + 202,
      })

      const info = readOpencodeSessionInfo(db, { sessionId })

      expect(info).toMatchObject({
        id: sessionId,
        directory: '/workspace/project',
        title: 'Typed session metadata',
        model: modelFixture,
        tokens: {
          input: 111,
          output: 222,
          reasoning: 33,
          cache: {
            read: 44,
            write: 55,
          },
        },
        cost: 0.42,
        time: {
          created: baseTime + 101,
          updated: baseTime + 202,
        },
      })
      expect(typeof info.model).toBe('object')
    } finally {
      db.close()
    }
  })

  it('wraps schema inspection and reads in a transaction for each public read helper', () => {
    const db = createDatabase()
    try {
      seedConversation(db)
      const { reader, events } = instrumentReadDatabase(db)
      const reads: Array<[string, () => unknown]> = [
        ['session info', () => readOpencodeSessionInfo(reader, { sessionId })],
        ['snapshot page', () => readOpencodeSnapshotPage(reader, { sessionId, limit: 2 })],
        ['turn page', () => readOpencodeTurnPage(reader, { sessionId, limit: 2 })],
        ['turn body', () => readOpencodeTurnBody(reader, { sessionId, turnId: 'message-4' })],
      ]

      for (const [_label, read] of reads) {
        events.length = 0
        read()
        const beginIndex = events.indexOf('BEGIN')
        const commitIndex = events.indexOf('COMMIT')
        const firstSchemaPrepareIndex = events.findIndex((event) => event.startsWith('PREPARE:PRAGMA table_info'))

        expect(beginIndex).toBe(0)
        expect(firstSchemaPrepareIndex).toBeGreaterThan(beginIndex)
        expect(commitIndex).toBeGreaterThan(firstSchemaPrepareIndex)
      }
    } finally {
      db.close()
    }
  })

  it('reads the newest snapshot messages in chronological order and reports older history', () => {
    const db = createDatabase()
    try {
      seedConversation(db)

      const page = readOpencodeSnapshotPage(db, { sessionId, limit: 3 })

      expect(page.info).toMatchObject({ id: sessionId, title: 'Review DB history reads' })
      expect(page.messages.map((message) => message.info.id)).toEqual(['message-3', 'message-4', 'message-5'])
      expect(page.messages.map((message) => message.info.time.created)).toEqual([
        baseTime + 3_000,
        baseTime + 4_000,
        baseTime + 5_000,
      ])
      expect(page.hasMoreBefore).toBe(true)
    } finally {
      db.close()
    }
  })

  it('loads the newest turn page first and uses an opaque cursor for older history', () => {
    const db = createDatabase()
    try {
      seedConversation(db)

      const first = readOpencodeTurnPage(db, { sessionId, limit: 2 })
      const expectedCursor = encodeOpencodeCursor({ timeCreated: baseTime + 4_000, id: 'message-4' })

      expect(first.messages.map((message) => message.info.id)).toEqual(['message-4', 'message-5'])
      expect(first.nextCursor).toBe(expectedCursor)
      expect(first.nextCursor).not.toContain('message-4')
      expect(first.hasMoreBefore).toBe(true)

      const second = readOpencodeTurnPage(db, { sessionId, limit: 2, cursor: first.nextCursor })
      expect(second.messages.map((message) => message.info.id)).toEqual(['message-2', 'message-3'])
      expect(second.nextCursor).toEqual(expect.any(String))
      expect(second.nextCursor).not.toEqual(first.nextCursor)

      const third = readOpencodeTurnPage(db, { sessionId, limit: 2, cursor: second.nextCursor })
      expect(third.messages.map((message) => message.info.id)).toEqual(['message-1'])
      expect(third.nextCursor).toBeNull()
      expect(third.hasMoreBefore).toBe(false)
    } finally {
      db.close()
    }
  })

  it('uses message id as a cursor tie-breaker when messages share a timestamp', () => {
    const db = createDatabase()
    try {
      createOpenCodeSchema(db)
      insertSession(db)
      insertMessage(db, 'message-a', 1_000, { role: 'user' })
      insertPart(db, 'part-a', 'message-a', { type: 'text', text: 'First message.' })
      insertMessage(db, 'message-b', 2_000, { role: 'assistant' })
      insertPart(db, 'part-b', 'message-b', { type: 'text', text: 'First duplicate timestamp message.' })
      insertMessage(db, 'message-c', 2_000, { role: 'user' })
      insertPart(db, 'part-c', 'message-c', { type: 'text', text: 'Second duplicate timestamp message.' })
      insertMessage(db, 'message-d', 3_000, { role: 'assistant' })
      insertPart(db, 'part-d', 'message-d', { type: 'text', text: 'Final message.' })

      const first = readOpencodeTurnPage(db, { sessionId, limit: 2 })
      const expectedCursor = encodeOpencodeCursor({ timeCreated: baseTime + 2_000, id: 'message-c' })

      expect(first.messages.map((message) => message.info.id)).toEqual(['message-c', 'message-d'])
      expect(first.nextCursor).toBe(expectedCursor)

      const second = readOpencodeTurnPage(db, { sessionId, limit: 2, cursor: first.nextCursor })
      expect(second.messages.map((message) => message.info.id)).toEqual(['message-a', 'message-b'])
      expect(second.nextCursor).toBeNull()

      const pagedIds = [...second.messages, ...first.messages].map((message) => message.info.id)
      expect(pagedIds).toEqual(['message-a', 'message-b', 'message-c', 'message-d'])
      expect(new Set(pagedIds).size).toBe(pagedIds.length)
    } finally {
      db.close()
    }
  })

  it('isolates snapshot, page, and body reads to the requested session', () => {
    const db = createDatabase()
    try {
      createOpenCodeSchema(db)
      insertSession(db, { title: 'Primary session' })
      insertSession(db, {
        id: otherSessionId,
        title: 'Interleaved other session',
        directory: '/repo/other-opencode',
        timeCreated: baseTime + 500,
        timeUpdated: baseTime + 3_500,
      })

      insertMessage(db, 'primary-message-1', 1_000, { role: 'user' })
      insertPart(db, 'primary-part-1', 'primary-message-1', { type: 'text', text: 'Primary first.' })
      insertMessage(db, 'other-message-1', 1_500, { role: 'assistant' }, otherSessionId)
      insertPart(db, 'other-part-1', 'other-message-1', { type: 'text', text: 'Other first.' }, otherSessionId)
      insertMessage(db, 'primary-message-2', 2_000, { role: 'assistant' })
      insertPart(db, 'primary-part-2', 'primary-message-2', { type: 'text', text: 'Primary second.' })
      insertMessage(db, 'other-message-2', 2_500, { role: 'user' }, otherSessionId)
      insertPart(db, 'other-part-2', 'other-message-2', { type: 'text', text: 'Other second.' }, otherSessionId)

      const snapshot = readOpencodeSnapshotPage(db, { sessionId, limit: 10 })
      expect(snapshot.messages.map((message) => message.info.id)).toEqual(['primary-message-1', 'primary-message-2'])
      expect(snapshot.messages.flatMap((message) => message.parts).map((part) => part.id)).toEqual([
        'primary-part-1',
        'primary-part-2',
      ])

      const page = readOpencodeTurnPage(db, { sessionId, limit: 10 })
      expect(page.messages.map((message) => message.info.id)).toEqual(['primary-message-1', 'primary-message-2'])
      expect(page.nextCursor).toBeNull()

      const body = readOpencodeTurnBody(db, { sessionId, turnId: 'primary-message-2' })
      expect(body?.parts.map((part) => part.id)).toEqual(['primary-part-2'])
      expect(readOpencodeTurnBody(db, { sessionId, turnId: 'other-message-1' })).toBeNull()
    } finally {
      db.close()
    }
  })

  it('resolves a legacy freshopencode placeholder to one same-cwd title/time candidate', () => {
    const db = createDatabase()
    try {
      createOpenCodeSchema(db)
      insertSession(db, {
        id: 'ses_legacy_match',
        directory: '/home/dan/code',
        title: 'Skills from public repos',
        timeCreated: baseTime + 54 * 60_000,
        timeUpdated: baseTime + 2 * 60 * 60_000,
      })
      insertSession(db, {
        id: 'ses_same_cwd_unrelated',
        directory: '/home/dan/code',
        title: 'Audit build install scripts',
        timeCreated: baseTime + 55 * 60_000,
        timeUpdated: baseTime + 56 * 60_000,
      })
      insertSession(db, {
        id: 'ses_old_same_title',
        directory: '/home/dan/code',
        title: 'Skills from old repos',
        timeCreated: baseTime - 7 * 24 * 60 * 60_000,
        timeUpdated: baseTime - 7 * 24 * 60 * 60_000,
      })
      insertSession(db, {
        id: 'ses_other_cwd_same_title',
        directory: '/home/dan/other',
        title: 'Skills from public repos',
        timeCreated: baseTime + 54 * 60_000,
        timeUpdated: baseTime + 2 * 60 * 60_000,
      })

      const resolved = resolveOpencodeLegacySession(db, {
        cwd: '/home/dan/code',
        title: 'Identifying skills from GitHub repos',
        createdAt: baseTime,
        updatedAt: baseTime + 30_000,
      })

      expect(resolved?.id).toBe('ses_legacy_match')
      expect(resolved?.directory).toBe('/home/dan/code')
    } finally {
      db.close()
    }
  })

  it('does not resolve an ambiguous legacy freshopencode placeholder', () => {
    const db = createDatabase()
    try {
      createOpenCodeSchema(db)
      insertSession(db, {
        id: 'ses_legacy_match_a',
        directory: '/home/dan/code',
        title: 'Skills from public repos',
        timeCreated: baseTime + 54 * 60_000,
      })
      insertSession(db, {
        id: 'ses_legacy_match_b',
        directory: '/home/dan/code',
        title: 'Public repo skills inventory',
        timeCreated: baseTime + 55 * 60_000,
      })

      expect(resolveOpencodeLegacySession(db, {
        cwd: '/home/dan/code',
        title: 'Identifying skills from GitHub repos',
        createdAt: baseTime,
      })).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('reads a turn body with JSON-parsed parts ordered by part id', () => {
    const db = createDatabase()
    try {
      createOpenCodeSchema(db)
      insertSession(db)
      insertMessage(db, 'message-body', 1_000, { role: 'assistant', providerID: 'opencode-go', modelID: 'deepseek-v4-flash' })
      insertPart(db, 'part-c-text', 'message-body', { type: 'text', text: 'Finished.' })
      insertPart(db, 'part-a-file', 'message-body', {
        type: 'file',
        path: 'src/App.tsx',
        content: 'export function App() {}',
      })
      insertPart(db, 'part-b-patch', 'message-body', {
        type: 'patch',
        files: [{ path: 'src/App.tsx', additions: 1, deletions: 0 }],
        diff: '@@ -0,0 +1 @@',
      })

      const body = readOpencodeTurnBody(db, { sessionId, turnId: 'message-body' })

      expect(body).toMatchObject({
        info: {
          id: 'message-body',
          role: 'assistant',
          providerID: 'opencode-go',
          modelID: 'deepseek-v4-flash',
          time: {
            created: baseTime + 1_000,
            updated: baseTime + 1_017,
          },
        },
      })
      expect(body?.parts.map((part) => part.id)).toEqual(['part-a-file', 'part-b-patch', 'part-c-text'])
      expect(body?.parts).toEqual([
        expect.objectContaining({ id: 'part-a-file', type: 'file', path: 'src/App.tsx' }),
        expect.objectContaining({ id: 'part-b-patch', type: 'patch', files: [{ path: 'src/App.tsx', additions: 1, deletions: 0 }] }),
        expect.objectContaining({ id: 'part-c-text', type: 'text', text: 'Finished.' }),
      ])
    } finally {
      db.close()
    }
  })

  it('throws a typed schema error when required columns are missing instead of returning blank history', () => {
    const db = createDatabase()
    try {
      db.exec(`
        CREATE TABLE session (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          slug text NOT NULL,
          title text NOT NULL,
          version text NOT NULL,
          time_created integer NOT NULL
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

      let caught: unknown
      try {
        readOpencodeSnapshotPage(db, { sessionId, limit: 3 })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).name).toBe('OpencodeHistorySchemaError')
      expect((caught as { code?: unknown }).code).toBe('OPENCODE_HISTORY_SCHEMA_ERROR')
      expect((caught as { table?: unknown }).table).toBe('session')
      expect((caught as { missingColumns?: unknown }).missingColumns).toEqual(
        expect.arrayContaining(['directory', 'time_updated']),
      )
    } finally {
      db.close()
    }
  })

  it('throws a typed schema error when a message required column is missing', () => {
    const db = createDatabase()
    try {
      createOpenCodeSchema(db)
      db.exec('ALTER TABLE message DROP COLUMN data')
      insertSession(db)

      let caught: unknown
      try {
        readOpencodeTurnPage(db, { sessionId, limit: 2 })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).name).toBe('OpencodeHistorySchemaError')
      expect((caught as { code?: unknown }).code).toBe('OPENCODE_HISTORY_SCHEMA_ERROR')
      expect((caught as { table?: unknown }).table).toBe('message')
      expect((caught as { missingColumns?: unknown }).missingColumns).toEqual(expect.arrayContaining(['data']))
    } finally {
      db.close()
    }
  })

  it('parses message and part JSON strings and preserves file, patch, and compaction fixtures for normalization', () => {
    const db = createDatabase()
    try {
      seedConversation(db)

      const page = readOpencodeSnapshotPage(db, { sessionId, limit: 5 })

      expect(page.messages[1].info).toMatchObject({
        id: 'message-2',
        role: 'assistant',
        providerID: 'opencode-go',
        modelID: 'deepseek-v4-flash',
      })
      expect(typeof page.messages[1].info).toBe('object')
      expect(page.messages.flatMap((message) => message.parts).filter((part) => part.type === 'file')).toEqual([
        expect.objectContaining({
          id: 'part-3',
          type: 'file',
          path: 'server/fresh-agent/adapters/opencode/history-query.ts',
          content: 'export {}',
        }),
      ])
      expect(page.messages.flatMap((message) => message.parts).filter((part) => part.type === 'patch')).toEqual([
        expect.objectContaining({
          id: 'part-4',
          type: 'patch',
          files: [{ path: 'server/fresh-agent/adapters/opencode/history-query.ts', additions: 12, deletions: 0 }],
        }),
      ])
      expect(page.messages.flatMap((message) => message.parts).filter((part) => part.type === 'compaction')).toEqual([
        expect.objectContaining({
          id: 'part-5',
          type: 'compaction',
          summary: 'Compacted earlier DB history context.',
          beforeTokens: 10_000,
          afterTokens: 3_500,
        }),
      ])
    } finally {
      db.close()
    }
  })
})
