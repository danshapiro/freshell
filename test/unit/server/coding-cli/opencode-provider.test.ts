import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { OpencodeProvider } from '../../../../server/coding-cli/providers/opencode'

describe('OpencodeProvider', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-provider-'))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('lists root sessions from the OpenCode database', async () => {
    const dbPath = path.join(tempDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER
      );
      INSERT INTO project (id, worktree) VALUES ('project-1', '/repo/root');
      INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)
      VALUES
        ('session-root', 'project-1', NULL, '/repo/root/packages/app', 'OpenCode root session', 1000, 2000, NULL),
        ('session-child', 'project-1', 'session-root', '/repo/root/packages/app', 'Child session', 1001, 2001, NULL),
        ('session-archived', 'project-1', NULL, '/repo/root/packages/app', 'Archived session', 1002, 2002, 9999);
    `)
    db.close()

    const provider = new OpencodeProvider(tempDir)
    const sessions = await provider.listSessionsDirect()

    expect(provider.getSessionRoots()).toEqual([dbPath])
    expect(provider.supportsSessionResume()).toBe(true)
    expect(sessions).toEqual([
      {
        provider: 'opencode',
        sessionId: 'session-root',
        projectPath: '/repo/root',
        cwd: '/repo/root/packages/app',
        title: 'OpenCode root session',
        createdAt: 1000,
        updatedAt: 2000,
      },
    ])
  })
})
