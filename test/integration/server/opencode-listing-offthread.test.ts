import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkerListingRunner } from '../../../server/coding-cli/providers/opencode-listing-runner'
import { runOpencodeListingQuery, THREE_VIEWS_MARKER_SQL_PATTERN } from '../../../server/coding-cli/providers/opencode-listing-query'
import { supportsNativeTsWorker } from './fixtures/ts-worker-support'

vi.unmock('node:sqlite')

const threeViewsMarker = '<freshell-session-metadata origin=3-views noninteractive=true>'
// Exact (.ts in dev/test) URL of the slow fixture — same resolution strategy as the runner.
const slowQueryModuleUrl = new URL('./fixtures/slow-opencode-listing-query.ts', import.meta.url).href

// Spawns a REAL worker that loads the .ts query module via native type-stripping
// (Node >= 22.18). Skip below that (prod uses compiled .js; orchestration covered
// by fake-spawn unit tests). See fixtures/ts-worker-support.ts.
describe.skipIf(!supportsNativeTsWorker())('OpenCode listing off-thread (real worker)', () => {
  let tempDir: string
  beforeEach(async () => { tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-offthread-')) })
  afterEach(async () => { await fsp.rm(tempDir, { recursive: true, force: true }) })

  it('returns the same rows as the synchronous baseline', async () => {
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
        .run('marked', 'project-1', null, 'marked', '/repo/root', 'Marked', 'test', 1000, 3000, null)
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('plain', 'project-1', null, 'plain', '/repo/root', 'Plain', 'test', 1000, 2000, null)
      db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run('m1', 'marked', 1100, 1100, JSON.stringify({ role: 'user', text: threeViewsMarker }))
      db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run('m2', 'plain', 1100, 1100, JSON.stringify({ role: 'user', text: 'ordinary' }))
    } finally {
      db.close()
    }

    const runner = createWorkerListingRunner()
    const result = await runner({ dbPath, markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN })
    const baseline = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(result.rows).toEqual(baseline.rows)
    expect(result.rows.map((r) => [r.sessionId, !!r.hasThreeViewsMarker])).toEqual([['marked', true], ['plain', false]])
  })

  it('does not block the event loop while the worker runs a slow query', async () => {
    const runner = createWorkerListingRunner({ queryModuleUrl: slowQueryModuleUrl })
    let ticks = 0
    const interval = setInterval(() => { ticks += 1 }, 10)
    try {
      const result = await runner({ dbPath: path.join(tempDir, 'unused.db'), markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN })
      expect(result.rows.map((r) => r.sessionId)).toEqual(['slow-1'])
      // The worker busy-blocks its OWN thread for ~250 ms. If the main loop were
      // blocked, the interval could not fire. We expect many ticks (>= ~10).
      expect(ticks).toBeGreaterThanOrEqual(10)
    } finally {
      clearInterval(interval)
    }
  })
})
