import { describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'

describe('OpenCode serve real-provider smoke suite configuration', () => {
  it('keeps the real-provider smoke out of the default server suite and exposes an opt-in command', async () => {
    const root = process.cwd()
    const serverConfig = await fsp.readFile(path.join(root, 'config/vitest/vitest.server.config.ts'), 'utf8')
    expect(serverConfig).toContain("'test/integration/server/opencode-serve-real-provider-smoke.test.ts'")

    const packageJson = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(packageJson.scripts?.['test:opencode-serve-smoke'])
      .toContain('config/vitest/vitest.opencode-serve-real-provider-smoke.config.ts')

    const optInConfig = await fsp.readFile(path.join(root, 'config/vitest/vitest.opencode-serve-real-provider-smoke.config.ts'), 'utf8')
    expect(optInConfig).toContain("'test/integration/server/opencode-serve-real-provider-smoke.test.ts'")
  })
})
