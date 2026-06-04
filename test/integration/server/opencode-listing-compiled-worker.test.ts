import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THREE_VIEWS_MARKER_SQL_PATTERN } from '../../../server/coding-cli/providers/opencode-listing-query'

vi.unmock('node:sqlite')

// The server vitest globalSetup (test/setup/server-global-setup.ts) rebuilds dist/
// unconditionally via `npm run build:server`, so the COMPILED .js worker is always
// present here. Importing the COMPILED runner means the spawned worker loads as
// plain .js — no native type-stripping required — which proves the real off-thread
// spawn works on ANY supported Node (>=22.5), unlike the source-mode `.ts` real-worker
// tests (opencode-listing-offthread/discovery) that need Node >=22.18.
const distRunnerPath = path.join(process.cwd(), 'dist', 'server', 'coding-cli', 'providers', 'opencode-listing-runner.js')
const distRunnerUrl = pathToFileURL(distRunnerPath).href

describe('OpenCode listing — compiled (.js) worker spawns on any supported Node', () => {
  let tempDir: string
  beforeEach(async () => { tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-compiled-')) })
  afterEach(async () => { await fsp.rm(tempDir, { recursive: true, force: true }) })

  it('spawns the compiled worker and returns rows with marker→hasThreeViewsMarker', async () => {
    // dist is guaranteed by globalSetup; fail loudly (do not skip) if it is absent,
    // since that would mean the compiled production artifact was never exercised.
    expect(existsSync(distRunnerPath), `compiled runner missing at ${distRunnerPath} (server globalSetup should build dist)`).toBe(true)

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
      db.prepare(`INSERT INTO project VALUES (?, ?, ?, ?, ?)`).run('p', '/repo/root', 900, 4000, '[]')
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('marked', 'p', null, 'marked', '/repo/root', 'Marked', 'v', 1000, 3000, null)
      db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('plain', 'p', null, 'plain', '/repo/root', 'Plain', 'v', 1000, 2000, null)
      db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
        .run('m1', 'marked', 1100, 1100, JSON.stringify({ role: 'user', text: '<freshell-session-metadata origin=3-views noninteractive=true>' }))
    } finally {
      db.close()
    }

    const mod = await import(distRunnerUrl) as typeof import('../../../server/coding-cli/providers/opencode-listing-runner.js')
    const runner = mod.createWorkerListingRunner()
    const result = await runner({ dbPath, markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN })

    expect(result.rows.map((r) => [r.sessionId, !!r.hasThreeViewsMarker])).toEqual([['marked', true], ['plain', false]])
  })
})
