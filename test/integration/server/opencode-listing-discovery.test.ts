import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:sqlite')
vi.mock('../../../server/config-store', () => ({
  configStore: {
    getProjectColors: vi.fn().mockResolvedValue({}),
    snapshot: vi.fn().mockResolvedValue({ settings: { codingCli: { enabledProviders: ['opencode'], providers: {} } } }),
  },
}))

import { OpencodeProvider } from '../../../server/coding-cli/providers/opencode'
import { CodingCliSessionIndexer } from '../../../server/coding-cli/session-indexer.js'
import { supportsNativeTsWorker } from './fixtures/ts-worker-support'

const marker = '<freshell-session-metadata origin=3-views noninteractive=true>'

// Uses the DEFAULT worker runner (real .ts worker via native type-stripping,
// Node >= 22.18). Skip below that — see fixtures/ts-worker-support.ts.
describe.skipIf(!supportsNativeTsWorker())('OpenCode discovery via the off-thread worker (provider + indexer)', () => {
  let home: string
  beforeEach(async () => { home = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-discovery-')) })
  afterEach(async () => { await fsp.rm(home, { recursive: true, force: true }) })

  it('surfaces DB sessions (with marker→isSubagent) through a full refresh using the real worker', async () => {
    const dbPath = path.join(home, 'opencode.db')
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
        .run('normal', 'p', null, 'normal', '/repo/root', 'Normal', 'v', 1000, 2000, null)
      db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run('m1', 'marked', 1100, 1100, JSON.stringify({ role: 'user', text: marker }))
      db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`).run('m2', 'normal', 1100, 1100, JSON.stringify({ role: 'user', text: 'ordinary' }))
    } finally {
      db.close()
    }

    // DEFAULT runner = the real off-thread worker (no injection).
    const provider = new OpencodeProvider(home)
    const indexer = new CodingCliSessionIndexer([provider])
    await indexer.refresh()

    const sessions = indexer.getProjects().flatMap((g) => g.sessions)
    const marked = sessions.find((s) => s.sessionId === 'marked')
    const normal = sessions.find((s) => s.sessionId === 'normal')
    expect(marked).toBeDefined()
    expect(marked?.isSubagent).toBe(true)
    expect(marked?.isNonInteractive).toBe(true)
    expect(normal).toBeDefined()
    expect(normal?.isSubagent).toBeUndefined()
  })
})
