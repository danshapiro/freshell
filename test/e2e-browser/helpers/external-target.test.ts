import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
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
