import { describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'

describe('Codex real-provider smoke suite configuration', () => {
  it('keeps the real-provider smoke out of the default server suite and exposes an opt-in command', async () => {
    const root = process.cwd()
    const serverConfig = await fsp.readFile(path.join(root, 'vitest.server.config.ts'), 'utf8')
    expect(serverConfig).toContain("'test/integration/server/codex-real-provider-smoke.test.ts'")

    const packageJson = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(packageJson.scripts?.['test:codex-real-provider-smoke'])
      .toContain('vitest.codex-real-provider-smoke.config.ts')

    const optInConfig = await fsp.readFile(path.join(root, 'vitest.codex-real-provider-smoke.config.ts'), 'utf8')
    expect(optInConfig).toContain("'test/integration/server/codex-real-provider-smoke.test.ts'")
  })
})
