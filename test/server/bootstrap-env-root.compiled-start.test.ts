import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TestServer } from '../e2e-browser/helpers/test-server.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

describe('issue 174 compiled startup regression', () => {
  let server: TestServer | undefined

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = undefined
    }
  })

  it('bootstraps AUTH_TOKEN into an isolated runtime root on the coordinated server suite path', async () => {
    server = new TestServer({
      authStrategy: 'bootstrap',
      runtimeRootMode: 'isolated',
    })

    const info = await server.start()
    expect(info.runtimeRoot).toContain(path.join(PROJECT_ROOT, '.worktrees', 'test-server-runtime-'))

    const envText = await fs.readFile(path.join(info.runtimeRoot, '.env'), 'utf8')
    expect(envText).toMatch(/^AUTH_TOKEN=[a-f0-9]{64}$/m)
    await expect(fs.stat(path.join(info.runtimeRoot, 'dist', '.env'))).rejects.toThrow()

    const healthRes = await fetch(`${info.baseUrl}/api/health`)
    expect(healthRes.status).toBe(200)
    await expect(healthRes.json()).resolves.toMatchObject({ ok: true })

    const settingsRes = await fetch(`${info.baseUrl}/api/settings`, {
      headers: { 'x-auth-token': info.token },
    })
    expect(settingsRes.status).toBe(200)
  })
})
