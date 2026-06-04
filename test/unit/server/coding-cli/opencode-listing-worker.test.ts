import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeListing, OPENCODE_LISTING_WORKER_KIND } from '../../../../server/coding-cli/providers/opencode-listing.worker'
import { THREE_VIEWS_MARKER_SQL_PATTERN } from '../../../../server/coding-cli/providers/opencode-listing-query'

vi.unmock('node:sqlite')

const queryModuleUrl = new URL('../../../../server/coding-cli/providers/opencode-listing-query.ts', import.meta.url).href

describe('opencode listing worker executeListing', () => {
  let tempDir: string
  beforeEach(async () => { tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-worker-')) })
  afterEach(async () => { await fsp.rm(tempDir, { recursive: true, force: true }) })

  it('dynamically imports the query module and returns its result', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
        CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
        CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
        CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      `)
      db.prepare(`INSERT INTO project VALUES (?, ?, ?, ?, ?)`).run('project-1', '/repo/root', 900, 4000, '[]')
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('s1', 'project-1', null, 's1', '/repo/root', 'Title', 'test', 1000, 2000, null)
    } finally {
      db.close()
    }

    const result = await executeListing({ queryModuleUrl, dbPath, markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN })
    expect(result.schemaMissingParentId).toBe(false)
    expect(result.rows.map((r) => r.sessionId)).toEqual(['s1'])
  })

  it('does not auto-run on import under the threaded test runtime (sentinel guard)', () => {
    // The server Vitest config uses pool: 'threads', so this test file runs inside
    // a worker thread (parentPort is non-null). Importing the worker module at the
    // top of this file must NOT have triggered executeListing against Vitest's
    // workerData — the sentinel guard (workerData.kind !== OPENCODE_LISTING_WORKER_KIND)
    // prevents it. If the guard were broken, the import would have posted to Vitest's
    // parent port and likely corrupted the run; reaching this assertion proves it didn't.
    expect(typeof executeListing).toBe('function')
    expect(OPENCODE_LISTING_WORKER_KIND).toBe('opencode-listing-worker')
    expect(queryModuleUrl).toContain('opencode-listing-query')
  })
})
