export type OpencodeSessionRow = {
  sessionId: string
  cwd: string
  title: string
  createdAt: number
  lastActivityAt: number
  projectPath: string | null
  hasThreeViewsMarker?: number | null
}

export type OpencodeListingResult = {
  rows: OpencodeSessionRow[]
  schemaMissingParentId: boolean
}

export const THREE_VIEWS_MARKER_SQL_PATTERN = '%<freshell-session-metadata origin=3-views%'

const OPENCODE_DB_BUSY_TIMEOUT_MS = 5000

/**
 * OpenCode session listing query. Opens the DB read-only, inspects whether the
 * session table exposes parent_id, runs the root-session listing (including the
 * hasThreeViewsMarker LIKE subqueries), and returns the raw rows.
 *
 * The DB work is the heavy, thread-blocking part (~180 ms on a 531 MB DB) — which
 * is exactly why this runs inside a worker thread. The function is `async` ONLY
 * because it imports `node:sqlite` LAZILY: a static top-level import would be
 * eagerly triggered when opencode.ts loads and fire vi.mock('node:sqlite')'s
 * hoisted factory before the mock test's inline FakeDatabaseSync class is
 * initialized (TDZ ReferenceError). Lazy `await import('node:sqlite')` is the
 * same pattern the current production code uses and is intercepted correctly by
 * vi.mock. No logging, no fs-async — trivially worker-portable.
 */
export async function runOpencodeListingQuery(
  dbPath: string,
  markerPattern: string,
): Promise<OpencodeListingResult> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCODE_DB_BUSY_TIMEOUT_MS}`)
    const columns = db.prepare('PRAGMA table_info(session)').all() as Array<{ name?: unknown }>
    const hasParentId = columns.some((c) => c.name === 'parent_id')
    const rootFilter = hasParentId ? 'AND s.parent_id IS NULL' : ''
    // The 3-views marker lives in part.data and/or message.data. Older/partial
    // schemas (and the e2e fake-opencode fixture, which has only project+session)
    // may lack one or both tables; build the marker check from whichever tables
    // are present (the marker can live in either), and degrade to "unmarked" if
    // neither exists — instead of throwing "no such table: part".
    const tableNames = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: unknown }>)
        .map((row) => row.name),
    )
    const markerClauses: string[] = []
    const markerParams: string[] = []
    if (tableNames.has('part')) {
      markerClauses.push('EXISTS (SELECT 1 FROM part pa WHERE pa.session_id = s.id AND pa.data LIKE ?)')
      markerParams.push(markerPattern)
    }
    if (tableNames.has('message')) {
      markerClauses.push('EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.data LIKE ?)')
      markerParams.push(markerPattern)
    }
    const markerExpr = markerClauses.length > 0 ? `(${markerClauses.join(' OR ')})` : '0'
    const rows = db.prepare(`
      SELECT
        s.id AS sessionId,
        s.directory AS cwd,
        s.title AS title,
        s.time_created AS createdAt,
        s.time_updated AS lastActivityAt,
        p.worktree AS projectPath,
        ${markerExpr} AS hasThreeViewsMarker
      FROM session s
      LEFT JOIN project p ON p.id = s.project_id
      WHERE s.time_archived IS NULL
        ${rootFilter}
      ORDER BY s.time_updated DESC
    `).all(...markerParams) as OpencodeSessionRow[]
    return { rows, schemaMissingParentId: !hasParentId }
  } finally {
    db.close()
  }
}
