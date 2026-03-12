// @vitest-environment node
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedVisibleFirstAuditServerHome } from '@test/e2e-browser/perf/seed-server-home'

describe('seedVisibleFirstAuditServerHome', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
    tmpDirs.length = 0
  })

  it('writes the accepted session corpus, long-history session, and backlog script', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'visible-first-home-'))
    tmpDirs.push(tmpHome)

    const result = await seedVisibleFirstAuditServerHome(tmpHome)
    expect(result.sessionCount).toBe(180)
    expect(result.alphaSessionCount).toBe(36)
    expect(result.longHistoryTurnCount).toBe(240)
    expect(result.backlogScriptPath).toContain('audit-terminal-backlog')
    expect(await fs.readFile(result.backlogScriptPath, 'utf8')).toContain('tail line')
  })
})
