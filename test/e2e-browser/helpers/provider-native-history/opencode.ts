import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  MAX_NATIVE_TURNS,
  NATIVE_HISTORY_SCHEMA_VERSION,
  boundedText,
  boundedToolCalls,
  object,
  optionalString,
  requiredString,
  type NativeAssistantTurn,
  type NativeHistory,
} from './types.js'
import { safeOpaqueId } from './safe-io.js'

const MAX_MESSAGE_ROWS = 128
const MAX_PART_ROWS = 256
const MAX_SQLITE_JSON_BYTES = 256 * 1024

function requireRegularDatabase(filename: string): void {
  if (!path.isAbsolute(filename)) throw new Error('OpenCode database path must be absolute')
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('OpenCode database must be a regular non-symlink file')
  if (fs.realpathSync(filename) !== path.resolve(filename)) throw new Error('OpenCode database path must not traverse a symlink')
  for (const suffix of ['-wal', '-shm']) {
    const companion = `${filename}${suffix}`
    if (!fs.existsSync(companion)) continue
    const companionStat = fs.lstatSync(companion)
    if (!companionStat.isFile() || companionStat.isSymbolicLink()
      || fs.realpathSync(companion) !== path.resolve(companion)) {
      throw new Error(`OpenCode database ${suffix} companion must be a regular non-symlink file`)
    }
  }
}

function requireColumns(db: DatabaseSync, table: string, columns: string[]): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]
  const actual = new Set(rows.map((row) => row.name))
  if (columns.some((column) => !actual.has(column))) throw new Error(`OpenCode ${table} schema is missing required columns`)
}

/** OpenCode's SQLite reader uses a query-only read transaction for a consistent snapshot. */
export function readOpenCodeNativeHistory(filename: string, exactSessionId: string): NativeHistory {
  const sessionId = safeOpaqueId(exactSessionId, 'OpenCode native session id')
  requireRegularDatabase(filename)
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN;')
    requireColumns(db, 'session', ['id'])
    requireColumns(db, 'message', ['id', 'session_id', 'time_created', 'data'])
    requireColumns(db, 'part', ['id', 'session_id', 'message_id', 'time_created', 'data'])
    const sessions = db.prepare('SELECT id FROM session WHERE id = ? LIMIT 2').all(sessionId)
    if (sessions.length !== 1) throw new Error('OpenCode exact native session row is missing or ambiguous')
    const rows = db.prepare(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT ?',
    ).all(sessionId, MAX_MESSAGE_ROWS + 1) as { id: string, data: string }[]
    if (rows.length > MAX_MESSAGE_ROWS) throw new Error('OpenCode message rows exceed the evidence bound')
    const partsQuery = db.prepare(
      'SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created, id LIMIT ?',
    )
    const turns: NativeAssistantTurn[] = []
    for (const row of rows) {
      if (Buffer.byteLength(row.data, 'utf8') > MAX_SQLITE_JSON_BYTES) {
        throw new Error('OpenCode message JSON exceeds the evidence bound')
      }
      let message: Record<string, any>
      try { message = object(JSON.parse(row.data), 'OpenCode message data') } catch (error) {
        throw new Error(`OpenCode message data is not valid JSON: ${String(error)}`)
      }
      if (message.role !== 'assistant') continue
      if (!Number.isSafeInteger(message.time?.completed) || message.time.completed <= 0) continue
      const partRows = partsQuery.all(sessionId, row.id, MAX_PART_ROWS + 1) as { data: string }[]
      if (partRows.length > MAX_PART_ROWS) throw new Error('OpenCode part rows exceed the evidence bound')
      const parts = partRows.map((part) => {
        if (Buffer.byteLength(part.data, 'utf8') > MAX_SQLITE_JSON_BYTES) {
          throw new Error('OpenCode part JSON exceeds the evidence bound')
        }
        try { return object(JSON.parse(part.data), 'OpenCode part data') } catch (error) {
          throw new Error(`OpenCode part data is not valid JSON: ${String(error)}`)
        }
      })
      const text = boundedText(parts
        .filter((part) => part.type === 'text')
        .map((part) => typeof part.text === 'string' ? part.text : '')
        .join(''), 'OpenCode native assistant response')
      const toolCalls = boundedToolCalls(parts
        .filter((part) => part.type === 'tool')
        .map((part) => ({ type: 'tool', ...(optionalString(part.tool ?? part.name) ? { name: optionalString(part.tool ?? part.name)! } : {}) })),
      'OpenCode native tool calls')
      turns.push({
        turnId: requiredString(row.id, 'OpenCode assistant message id'),
        messageId: requiredString(row.id, 'OpenCode assistant message id'),
        parentMessageId: optionalString(message.parentID),
        completedAt: message.time.completed,
        text,
        toolCalls,
        resolvedProvider: requiredString(message.providerID, 'OpenCode assistant provider id'),
        resolvedModel: requiredString(message.modelID, 'OpenCode assistant model id'),
        resolvedReasoningEffort: 'provider-default',
        providerProvenance: 'opencode-message.providerID',
        modelProvenance: 'opencode-message.modelID',
        reasoningEffortProvenance: 'opencode-message.provider-default',
      })
      if (turns.length > MAX_NATIVE_TURNS) throw new Error('OpenCode native assistant turns exceed the evidence bound')
    }
    if (turns.length === 0) throw new Error('OpenCode exact native session has no completed assistant response')
    db.exec('COMMIT;')
    return { schemaVersion: NATIVE_HISTORY_SCHEMA_VERSION, provider: 'opencode', nativeSessionId: sessionId, turns }
  } catch (error) {
    try { db.exec('ROLLBACK;') } catch {}
    throw error
  } finally {
    db.close()
  }
}
