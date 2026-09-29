// @vitest-environment node
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

describe('MCP image entry self-test', () => {
  it('lists the real tool and calls it through the configured endpoint', async () => {
    const token = 'probe-token'
    let requestCount = 0
    const endpoint = createServer((req, res) => {
      requestCount++
      if (req.url !== '/api/health' || req.headers['x-auth-token'] !== token) {
        res.writeHead(403).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ probe: 'freshell-mcp-image' }))
    })
    endpoint.listen(0, '127.0.0.1')
    await once(endpoint, 'listening')
    const address = endpoint.address()
    if (!address || typeof address === 'string') throw new Error('Missing endpoint port')

    try {
      const child = spawn(process.execPath, [
        '--import', 'tsx', resolve(root, 'tools/freshell-mcp/server.ts'), '--self-test',
      ], {
        cwd: root,
        env: {
          ...process.env,
          FRESHELL_URL: `http://127.0.0.1:${address.port}`,
          FRESHELL_TOKEN: token,
        },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      const [code] = await once(child, 'exit')
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ tool: 'freshell', action: 'health', ok: true })
      expect(requestCount).toBe(1)
    } finally {
      endpoint.close()
    }
  })
})
