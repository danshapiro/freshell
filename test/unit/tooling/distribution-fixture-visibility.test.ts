// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const fixturePaths = [
  'test/fixtures/distribution/rust-only/dist/client/index.html',
  'test/fixtures/distribution/node-server/node_modules/node-pty/index.js',
  'test/fixtures/distribution/node-server/dist/server/index.js',
]

describe('distribution fixture visibility', () => {
  it('keeps nested node_modules and dist fixture files visible to Git', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../../..')
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'freshell-distribution-visibility-'))

    try {
      writeFileSync(
        path.join(fixtureRoot, '.gitignore'),
        readFileSync(path.join(projectRoot, '.gitignore'), 'utf8'),
      )
      for (const fixturePath of fixturePaths) {
        const filePath = path.join(fixtureRoot, fixturePath)
        mkdirSync(path.dirname(filePath), { recursive: true })
        writeFileSync(filePath, 'fixture')
      }

      const init = spawnSync('git', ['init', '--quiet'], {
        cwd: fixtureRoot,
        encoding: 'utf8',
      })
      expect(init.error, 'Git is required to evaluate the ignore fixture').toBeUndefined()
      expect(init.status, init.stderr).toBe(0)

      for (const fixturePath of fixturePaths) {
        const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', fixturePath], {
          cwd: fixtureRoot,
          encoding: 'utf8',
        })

        expect(result.error, fixturePath).toBeUndefined()
        expect(result.status, fixturePath).toBe(1)
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })
})
