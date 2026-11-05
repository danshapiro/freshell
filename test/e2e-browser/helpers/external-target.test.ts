import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createE2eServerHandle, ExternalServer } from './external-target.js'

const externalTargetScript = String.raw`
const http = require('node:http')
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true }))
})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    process.stdout.write('signal:' + signal + '\n')
    process.exit(0)
  })
}
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('ready:' + server.address().port + '\n')
})
`

const managedEnvironmentProbeServer = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
fs.writeFileSync(
  process.env.FRESHELL_E2E_MANAGED_ENV_CAPTURE,
  process.env.FRESHELL_MANAGED_RUNTIME_V1 ?? '<unset>',
  { mode: 0o600 },
)
const server = http.createServer((request, response) => {
  response.writeHead(request.url === '/api/health' || request.url === '/api/server-info' ? 200 : 404, {
    'content-type': 'application/json',
  })
  if (request.url === '/api/health') return response.end(JSON.stringify({ ok: true }))
  if (request.url === '/api/server-info') return response.end(JSON.stringify({ runtime: 'rust', commit: 'fixture' }))
  response.end('{}')
})
server.listen(Number(process.env.PORT), '127.0.0.1')
`

async function waitForReady(child: ChildProcess, output: () => string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const ready = output().match(/ready:(\d+)/)
    if (ready) return Number(ready[1])
    if (child.exitCode !== null) throw new Error(`external target exited before readiness: ${output()}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for external target readiness: ${output()}`)
}

async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
}

describe('ExternalServer lifecycle', () => {
  it('never signals or stops an explicitly external target', async () => {
    const child = spawn(process.execPath, ['-e', externalTargetScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

    try {
      const port = await waitForReady(child, () => output)
      const env = {
        FRESHELL_E2E_TARGET_URL: `http://127.0.0.1:${port}`,
        FRESHELL_E2E_TARGET_TIMEOUT_MS: '1000',
      }
      const external = await createE2eServerHandle(env)
      expect(external).toBeInstanceOf(ExternalServer)

      await external.start()
      await external.stop()

      expect(child.exitCode).toBeNull()
      expect(output).not.toMatch(/signal:/)
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true)
    } finally {
      await stopOwnedChild(child)
    }
  })
})

describe('owned generic E2E server environment', () => {
  it('drops ambient managed-runtime opt-in but preserves an explicit managed fixture opt-in', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-managed-env-'))
    const serverBinary = path.join(root, 'server-probe')
    const captureFile = path.join(root, 'managed-runtime-flag')
    await fsp.writeFile(serverBinary, managedEnvironmentProbeServer, { mode: 0o755 })
    await fsp.chmod(serverBinary, 0o755)

    const keys = ['FRESHELL_MANAGED_RUNTIME_V1', 'FRESHELL_E2E_RUST_SERVER_BIN', 'FRESHELL_E2E_MANAGED_ENV_CAPTURE']
    const saved = new Map(keys.map(key => [key, process.env[key]]))
    const servers: Array<{ stop(): Promise<void> }> = []
    try {
      process.env.FRESHELL_E2E_RUST_SERVER_BIN = serverBinary
      process.env.FRESHELL_E2E_MANAGED_ENV_CAPTURE = captureFile
      process.env.FRESHELL_MANAGED_RUNTIME_V1 = '1'

      const generic = await createE2eServerHandle({})
      servers.push(generic)
      await generic.start()
      expect(await fsp.readFile(captureFile, 'utf8')).toBe('<unset>')
      await generic.stop()
      servers.pop()

      await fsp.rm(captureFile, { force: true })
      process.env.FRESHELL_MANAGED_RUNTIME_V1 = '0'
      const managed = await createE2eServerHandle({}, {
        construct: { env: { FRESHELL_MANAGED_RUNTIME_V1: '1' } },
      })
      servers.push(managed)
      await managed.start()
      expect(await fsp.readFile(captureFile, 'utf8')).toBe('1')
    } finally {
      for (const server of servers.reverse()) await server.stop().catch(() => undefined)
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})
