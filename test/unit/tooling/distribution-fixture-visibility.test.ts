// @vitest-environment node
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

const fixturePaths = [
  'test/fixtures/distribution/rust-only/dist/client/index.html',
  'test/fixtures/distribution/node-server/node_modules/node-pty/index.js',
  'test/fixtures/distribution/node-server/dist/server/index.js',
]

describe('distribution fixture visibility', () => {
  it('keeps nested node_modules and dist fixture files visible to Git', () => {
    for (const fixturePath of fixturePaths) {
      const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', fixturePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      })

      expect(result.error).toBeUndefined()
      expect(result.status, fixturePath).toBe(1)
    }
  })
})
