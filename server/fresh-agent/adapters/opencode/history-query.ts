import type { OpencodeExport } from './normalize.js'

export type OpencodeSessionInfo = NonNullable<OpencodeExport['info']> & {
  id: string
  directory?: string
}

export type OpencodeHistoryPage = {
  exported: OpencodeExport
  revision: number
  nextCursor: string | null
  hasMoreBefore: boolean
  totalMessages?: number
}

export type OpencodeTurnBodyResult = {
  message: NonNullable<OpencodeExport['messages']>[number]
  revision: number
}

export type OpencodeLegacySessionResolveInput = {
  cwd?: string
  title?: string
  createdAt?: number
  updatedAt?: number
}

export type OpencodeHistoryExportPage = OpencodeHistoryPage & OpencodeExport
export type OpencodeHistoryTurnBody = OpencodeTurnBodyResult & NonNullable<OpencodeExport['messages']>[number]

export type OpencodeHistoryReadRequest =
  | { type: 'session_info'; sessionId: string }
  | { type: 'legacy_session'; query: OpencodeLegacySessionResolveInput }
  | { type: 'snapshot_page'; sessionId: string; limit?: number }
  | { type: 'turn_page'; sessionId: string; query?: { cursor?: string; limit?: number } }
  | { type: 'turn_body'; sessionId: string; turnId: string }

export type OpencodeHistoryReadResult =
  | { type: 'session_info'; sessionInfo: OpencodeSessionInfo }
  | { type: 'legacy_session'; sessionInfo: OpencodeSessionInfo }
  | { type: 'snapshot_page'; page: OpencodeHistoryExportPage }
  | { type: 'turn_page'; page: OpencodeHistoryExportPage }
  | { type: 'turn_body'; body: OpencodeHistoryTurnBody }

type StatementLike = {
  all: (...params: any[]) => unknown[]
  get: (...params: any[]) => unknown
}

type DatabaseLike = {
  exec: (sql: string) => unknown
  prepare: (sql: string) => StatementLike
}

type SessionRow = Record<string, unknown> & {
  id?: unknown
  directory?: unknown
  title?: unknown
  model?: unknown
  cost?: unknown
  tokens_input?: unknown
  tokens_output?: unknown
  tokens_reasoning?: unknown
  tokens_cache_read?: unknown
  tokens_cache_write?: unknown
  time_created?: unknown
  time_updated?: unknown
}

type MessageRow = {
  id: unknown
  session_id: unknown
  time_created: unknown
  time_updated: unknown
  data: unknown
}

type PartRow = {
  id: unknown
  message_id: unknown
  session_id: unknown
  time_created: unknown
  time_updated: unknown
  data: unknown
}

type HydratedMessage = NonNullable<OpencodeExport['messages']>[number]

const OPENCODE_DB_BUSY_TIMEOUT_MS = 5000

export const DEFAULT_SNAPSHOT_TURN_LIMIT = 200

const LEGACY_PLACEHOLDER_LOOKAHEAD_MS = 24 * 60 * 60_000
const LEGACY_PLACEHOLDER_LOOKBEHIND_MS = 5 * 60_000
const LEGACY_PLACEHOLDER_CANDIDATE_LIMIT = 50
const LEGACY_TITLE_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'from',
  'into',
  'onto',
  'that',
  'this',
  'with',
  'your',
  'ours',
  'mine',
  'have',
  'has',
  'had',
  'are',
  'was',
  'were',
  'can',
  'cannot',
  'cant',
  'dont',
  'list',
  'all',
  'each',
  'one',
])

const SESSION_REQUIRED_COLUMNS = [
  'id',
  'directory',
  'title',
  'model',
  'cost',
  'tokens_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write',
  'time_created',
  'time_updated',
] as const

const SESSION_OPTIONAL_COLUMNS = [
  'project_id',
  'workspace_id',
  'parent_id',
  'slug',
  'path',
  'version',
  'share_url',
  'summary_additions',
  'summary_deletions',
  'summary_files',
  'summary_diffs',
  'metadata',
  'revert',
  'permission',
  'agent',
  'time_compacting',
  'time_archived',
] as const

const MESSAGE_REQUIRED_COLUMNS = [
  'id',
  'session_id',
  'time_created',
  'time_updated',
  'data',
] as const

const PART_REQUIRED_COLUMNS = [
  'id',
  'message_id',
  'session_id',
  'time_created',
  'time_updated',
  'data',
] as const

export class OpencodeHistorySchemaError extends Error {
  readonly code = 'OPENCODE_HISTORY_SCHEMA_ERROR'
  readonly table: string
  readonly missingColumns: string[]

  constructor(table: string, missingColumns: string[]) {
    super(`OpenCode history table "${table}" is missing required columns: ${missingColumns.join(', ')}`)
    this.name = 'OpencodeHistorySchemaError'
    this.table = table
    this.missingColumns = missingColumns
  }
}

function inspectColumns(db: DatabaseLike, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string'))
}

function requireColumns(db: DatabaseLike, table: string, required: readonly string[]): Set<string> {
  const columns = inspectColumns(db, table)
  const missingColumns = required.filter((column) => !columns.has(column))
  if (missingColumns.length > 0) {
    throw new OpencodeHistorySchemaError(table, missingColumns)
  }
  return columns
}

function requireHistorySchema(db: DatabaseLike): { sessionColumns: Set<string> } {
  const sessionColumns = requireColumns(db, 'session', SESSION_REQUIRED_COLUMNS)
  requireColumns(db, 'message', MESSAGE_REQUIRED_COLUMNS)
  requireColumns(db, 'part', PART_REQUIRED_COLUMNS)
  return { sessionColumns }
}

function normalizeLimit(value: number | undefined, defaultValue: number): number {
  if (!Number.isFinite(value) || value === undefined) return defaultValue
  return Math.max(1, Math.min(defaultValue, Math.trunc(value)))
}

function parseJsonText(value: unknown, label: string): unknown {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') return value
  if (value.length === 0) return undefined
  try {
    return JSON.parse(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse OpenCode ${label} JSON: ${message}`)
  }
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJsonText(value, label)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizedTitleTokens(value: unknown): Set<string> {
  const text = stringValue(value)
  if (!text) return new Set()
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !LEGACY_TITLE_STOP_WORDS.has(token))
    .map((token) => token.endsWith('s') && token.length > 4 ? token.slice(0, -1) : token)
  return new Set(tokens)
}

function titleOverlapScore(left: Set<string>, right: Set<string>): number {
  let overlap = 0
  for (const token of left) {
    if (right.has(token)) overlap += 1
  }
  return overlap
}

function hasLegacyTitleMatch(queryTokens: Set<string>, candidateTitle: unknown): boolean {
  if (queryTokens.size === 0) return true
  const candidateTokens = normalizedTitleTokens(candidateTitle)
  if (candidateTokens.size === 0) return false
  const overlap = titleOverlapScore(queryTokens, candidateTokens)
  const requiredOverlap = Math.min(2, queryTokens.size, candidateTokens.size)
  return overlap >= requiredOverlap
}

function setIfString(target: Record<string, unknown>, key: string, value: unknown): void {
  const str = stringValue(value)
  if (str !== undefined) target[key] = str
}

function setIfNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  const number = numberValue(value)
  if (number !== undefined) target[key] = number
}

function sessionSelectList(columns: Set<string>): string {
  const names = [...SESSION_REQUIRED_COLUMNS, ...SESSION_OPTIONAL_COLUMNS]
  return names
    .map((column) => columns.has(column) ? `s.${column} AS ${column}` : `NULL AS ${column}`)
    .join(', ')
}

function readSessionRow(db: DatabaseLike, sessionId: string, columns: Set<string>): SessionRow | undefined {
  return db.prepare(`
    SELECT ${sessionSelectList(columns)}
    FROM session s
    WHERE s.id = ?
    LIMIT 1
  `).get(sessionId) as SessionRow | undefined
}

function hydrateSessionInfo(row: SessionRow): OpencodeSessionInfo {
  const info: Record<string, unknown> = {
    id: String(row.id),
    tokens: {
      input: numberValue(row.tokens_input) ?? 0,
      output: numberValue(row.tokens_output) ?? 0,
      reasoning: numberValue(row.tokens_reasoning) ?? 0,
      cache: {
        read: numberValue(row.tokens_cache_read) ?? 0,
        write: numberValue(row.tokens_cache_write) ?? 0,
      },
    },
    time: {
      created: numberValue(row.time_created) ?? 0,
      updated: numberValue(row.time_updated) ?? 0,
    },
  }

  setIfString(info, 'directory', row.directory)
  setIfString(info, 'title', row.title)
  setIfString(info, 'projectID', row.project_id)
  setIfString(info, 'workspaceID', row.workspace_id)
  setIfString(info, 'parentID', row.parent_id)
  setIfString(info, 'slug', row.slug)
  setIfString(info, 'path', row.path)
  setIfString(info, 'version', row.version)
  setIfString(info, 'shareURL', row.share_url)
  setIfString(info, 'permission', row.permission)
  setIfString(info, 'agent', row.agent)
  setIfNumber(info, 'cost', row.cost)

  const model = parseJsonText(row.model, 'session.model')
  if (model !== undefined) info.model = model

  const metadata = parseJsonText(row.metadata, 'session.metadata')
  if (metadata !== undefined) info.metadata = metadata

  const summaryDiffs = parseJsonText(row.summary_diffs, 'session.summary_diffs')
  const summary = {
    additions: numberValue(row.summary_additions) ?? 0,
    deletions: numberValue(row.summary_deletions) ?? 0,
    files: numberValue(row.summary_files) ?? 0,
    ...(summaryDiffs !== undefined ? { diffs: summaryDiffs } : {}),
  }
  if (
    summary.additions !== 0
    || summary.deletions !== 0
    || summary.files !== 0
    || 'diffs' in summary
  ) {
    info.summary = summary
  }

  const revert = parseJsonText(row.revert, 'session.revert')
  if (revert !== undefined) info.revert = revert

  const compacting = numberValue(row.time_compacting)
  const archived = numberValue(row.time_archived)
  const time = info.time as Record<string, unknown>
  if (compacting !== undefined) time.compacting = compacting
  if (archived !== undefined) time.archived = archived

  return info as OpencodeSessionInfo
}

function hydrateMessage(row: MessageRow, parts: Record<string, unknown>[]): HydratedMessage {
  const data = parseJsonObject(row.data, 'message.data')
  return {
    info: {
      ...data,
      id: String(row.id),
      sessionID: String(row.session_id),
      time: {
        created: numberValue(row.time_created) ?? 0,
        updated: numberValue(row.time_updated) ?? 0,
      },
    },
    parts,
  }
}

function hydratePart(row: PartRow): Record<string, unknown> {
  const data = parseJsonObject(row.data, 'part.data')
  return {
    ...data,
    id: String(row.id),
    sessionID: String(row.session_id),
    messageID: String(row.message_id),
    time: {
      created: numberValue(row.time_created) ?? 0,
      updated: numberValue(row.time_updated) ?? 0,
    },
  }
}

function readPartsByMessageId(
  db: DatabaseLike,
  sessionId: string,
  messageIds: readonly string[],
): Map<string, Record<string, unknown>[]> {
  const partsByMessageId = new Map<string, Record<string, unknown>[]>()
  if (messageIds.length === 0) return partsByMessageId
  const placeholders = messageIds.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT id, message_id, session_id, time_created, time_updated, data
    FROM part
    WHERE session_id = ?
      AND message_id IN (${placeholders})
    ORDER BY id ASC
  `).all(sessionId, ...messageIds) as PartRow[]
  for (const row of rows) {
    const messageId = String(row.message_id)
    const parts = partsByMessageId.get(messageId) ?? []
    parts.push(hydratePart(row))
    partsByMessageId.set(messageId, parts)
  }
  return partsByMessageId
}

function hydrateMessages(db: DatabaseLike, sessionId: string, rows: MessageRow[]): HydratedMessage[] {
  const messageIds = rows.map((row) => String(row.id))
  const partsByMessageId = readPartsByMessageId(db, sessionId, messageIds)
  return rows.map((row) => hydrateMessage(row, partsByMessageId.get(String(row.id)) ?? []))
}

function countMessages(db: DatabaseLike, sessionId: string): number | undefined {
  const row = db.prepare('SELECT COUNT(*) AS count FROM message WHERE session_id = ?').get(sessionId) as { count?: unknown } | undefined
  return numberValue(row?.count)
}

function revisionFromInfo(info: OpencodeSessionInfo): number {
  const updated = numberValue((info.time as Record<string, unknown> | undefined)?.updated)
  return Math.max(0, Math.trunc(updated ?? 0))
}

function makePage(
  exported: OpencodeExport,
  metadata: Omit<OpencodeHistoryPage, 'exported'>,
): OpencodeHistoryExportPage {
  return {
    ...exported,
    exported,
    ...metadata,
  }
}

function withReadTransaction<T>(db: DatabaseLike, read: () => T): T {
  db.exec('BEGIN')
  try {
    const result = read()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Ignore rollback failures and preserve the original read error.
    }
    throw error
  }
}

export function encodeOpencodeCursor(input: { time: number; id: string } | { timeCreated: number; id: string }): string {
  const time = 'time' in input ? input.time : input.timeCreated
  return Buffer.from(JSON.stringify({ time, id: input.id }), 'utf8').toString('base64url')
}

function decodeOpencodeCursor(cursor: string): { time: number; id: string } {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { time?: unknown; timeCreated?: unknown; id?: unknown }
  const time = numberValue(parsed.time) ?? numberValue(parsed.timeCreated)
  if (time === undefined || typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new Error('Invalid OpenCode history cursor.')
  }
  return { time, id: parsed.id }
}

export function readOpencodeSessionInfo(
  db: DatabaseLike,
  input: { sessionId: string },
): OpencodeSessionInfo | undefined {
  return withReadTransaction(db, () => {
    const sessionColumns = requireColumns(db, 'session', SESSION_REQUIRED_COLUMNS)
    const row = readSessionRow(db, input.sessionId, sessionColumns)
    return row ? hydrateSessionInfo(row) : undefined
  })
}

export function resolveOpencodeLegacySession(
  db: DatabaseLike,
  input: OpencodeLegacySessionResolveInput,
): OpencodeSessionInfo | undefined {
  const cwd = stringValue(input.cwd)
  if (!cwd) return undefined
  const createdAt = numberValue(input.createdAt)
  const updatedAt = numberValue(input.updatedAt)
  const titleTokens = normalizedTitleTokens(input.title)
  if (createdAt === undefined && updatedAt === undefined && titleTokens.size === 0) return undefined

  return withReadTransaction(db, () => {
    const sessionColumns = requireColumns(db, 'session', SESSION_REQUIRED_COLUMNS)
    const filters = ['s.id LIKE ?', 's.directory = ?']
    const params: unknown[] = ['ses_%', cwd]

    if (sessionColumns.has('time_archived')) {
      filters.push('s.time_archived IS NULL')
    }
    if (sessionColumns.has('parent_id')) {
      filters.push('s.parent_id IS NULL')
    }
    const anchor = createdAt ?? updatedAt
    if (anchor !== undefined) {
      filters.push('s.time_created >= ?')
      params.push(anchor - LEGACY_PLACEHOLDER_LOOKBEHIND_MS)
      filters.push('s.time_created <= ?')
      params.push(anchor + LEGACY_PLACEHOLDER_LOOKAHEAD_MS)
    }

    const rows = db.prepare(`
      SELECT ${sessionSelectList(sessionColumns)}
      FROM session s
      WHERE ${filters.join('\n        AND ')}
      ORDER BY s.time_created DESC, s.id DESC
      LIMIT ?
    `).all(...params, LEGACY_PLACEHOLDER_CANDIDATE_LIMIT) as SessionRow[]

    const matches = rows
      .filter((row) => hasLegacyTitleMatch(titleTokens, row.title))
      .map(hydrateSessionInfo)

    return matches.length === 1 ? matches[0] : undefined
  })
}

export function readOpencodeSnapshotPage(
  db: DatabaseLike,
  input: { sessionId: string; limit?: number },
): OpencodeHistoryExportPage | undefined {
  const limit = normalizeLimit(input.limit, DEFAULT_SNAPSHOT_TURN_LIMIT)
  return withReadTransaction(db, () => {
    const { sessionColumns } = requireHistorySchema(db)
    const sessionRow = readSessionRow(db, input.sessionId, sessionColumns)
    if (!sessionRow) return undefined
    const info = hydrateSessionInfo(sessionRow)
    const rows = db.prepare(`
      SELECT id, session_id, time_created, time_updated, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created DESC, id DESC
      LIMIT ?
    `).all(input.sessionId, limit + 1) as MessageRow[]
    const pageRows = rows.slice(0, limit).reverse()
    const messages = hydrateMessages(db, input.sessionId, pageRows)
    const exported = { info, messages }
    return makePage(exported, {
      revision: revisionFromInfo(info),
      nextCursor: null,
      hasMoreBefore: rows.length > limit,
      totalMessages: countMessages(db, input.sessionId),
    })
  })
}

export function readOpencodeTurnPage(
  db: DatabaseLike,
  input: { sessionId: string; cursor?: string; limit?: number },
): OpencodeHistoryExportPage | undefined {
  const limit = normalizeLimit(input.limit, DEFAULT_SNAPSHOT_TURN_LIMIT)
  const cursor = input.cursor ? decodeOpencodeCursor(input.cursor) : undefined
  return withReadTransaction(db, () => {
    const { sessionColumns } = requireHistorySchema(db)
    const sessionRow = readSessionRow(db, input.sessionId, sessionColumns)
    if (!sessionRow) return undefined
    const info = hydrateSessionInfo(sessionRow)
    const cursorClause = cursor
      ? 'AND (time_created < ? OR (time_created = ? AND id < ?))'
      : ''
    const cursorParams = cursor ? [cursor.time, cursor.time, cursor.id] : []
    const rows = db.prepare(`
      SELECT id, session_id, time_created, time_updated, data
      FROM message
      WHERE session_id = ?
        ${cursorClause}
      ORDER BY time_created DESC, id DESC
      LIMIT ?
    `).all(input.sessionId, ...cursorParams, limit + 1) as MessageRow[]
    const pageRows = rows.slice(0, limit)
    const messages = hydrateMessages(db, input.sessionId, [...pageRows].reverse())
    const oldestReturnedRow = pageRows.at(-1)
    const nextCursor = rows.length > limit && oldestReturnedRow
      ? encodeOpencodeCursor({ time: numberValue(oldestReturnedRow.time_created) ?? 0, id: String(oldestReturnedRow.id) })
      : null
    const exported = { info, messages }
    return makePage(exported, {
      revision: revisionFromInfo(info),
      nextCursor,
      hasMoreBefore: rows.length > limit,
      totalMessages: countMessages(db, input.sessionId),
    })
  })
}

export function readOpencodeTurnBody(
  db: DatabaseLike,
  input: { sessionId: string; turnId: string },
): OpencodeHistoryTurnBody | null {
  return withReadTransaction(db, () => {
    const { sessionColumns } = requireHistorySchema(db)
    const sessionRow = readSessionRow(db, input.sessionId, sessionColumns)
    if (!sessionRow) return null
    const info = hydrateSessionInfo(sessionRow)
    const row = db.prepare(`
      SELECT id, session_id, time_created, time_updated, data
      FROM message
      WHERE session_id = ?
        AND id = ?
      LIMIT 1
    `).get(input.sessionId, input.turnId) as MessageRow | undefined
    if (!row) return null
    const message = hydrateMessages(db, input.sessionId, [row])[0]
    return {
      ...message,
      message,
      revision: revisionFromInfo(info),
    }
  })
}

export async function runOpencodeHistoryQuery(
  input: { dbPath: string; request: OpencodeHistoryReadRequest },
): Promise<OpencodeHistoryReadResult | undefined> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(input.dbPath, { readOnly: true })
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCODE_DB_BUSY_TIMEOUT_MS}`)
    switch (input.request.type) {
      case 'session_info': {
        const sessionInfo = readOpencodeSessionInfo(db, { sessionId: input.request.sessionId })
        return sessionInfo ? { type: 'session_info', sessionInfo } : undefined
      }
      case 'legacy_session': {
        const sessionInfo = resolveOpencodeLegacySession(db, input.request.query)
        return sessionInfo ? { type: 'legacy_session', sessionInfo } : undefined
      }
      case 'snapshot_page': {
        const page = readOpencodeSnapshotPage(db, {
          sessionId: input.request.sessionId,
          limit: input.request.limit,
        })
        return page ? { type: 'snapshot_page', page } : undefined
      }
      case 'turn_page': {
        const page = readOpencodeTurnPage(db, {
          sessionId: input.request.sessionId,
          cursor: input.request.query?.cursor,
          limit: input.request.query?.limit,
        })
        return page ? { type: 'turn_page', page } : undefined
      }
      case 'turn_body': {
        const body = readOpencodeTurnBody(db, {
          sessionId: input.request.sessionId,
          turnId: input.request.turnId,
        })
        return body ? { type: 'turn_body', body } : undefined
      }
    }
  } finally {
    db.close()
  }
}
