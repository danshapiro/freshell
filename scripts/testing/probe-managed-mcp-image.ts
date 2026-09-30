import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const imageIndex = process.argv.indexOf('--image')
const image = imageIndex >= 0 ? process.argv[imageIndex + 1] : undefined
if (!image || image.startsWith('--')) {
  throw new Error('Usage: pnpm exec tsx scripts/testing/probe-managed-mcp-image.ts --image IMAGE')
}

const token = 'freshell-mcp-image-probe-token'
let acceptedRequests = 0
const endpoint = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/api/health' || request.headers['x-auth-token'] !== token) {
    response.writeHead(403).end()
    return
  }
  acceptedRequests++
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ probe: 'freshell-mcp-image' }))
})

endpoint.listen(0, '127.0.0.1')
await once(endpoint, 'listening')
const address = endpoint.address()
if (!address || typeof address === 'string') throw new Error('Probe endpoint has no TCP port')
const containerName = `freshell-mcp-probe-${process.pid}`

try {
  const { stdout } = await execFileAsync('docker', [
    'run', '--rm', '--name', containerName, '--network', 'host', '--read-only',
    '--cap-drop', 'ALL',
    '--env', `FRESHELL_URL=http://127.0.0.1:${address.port}`,
    '--env', `FRESHELL_TOKEN=${token}`,
    image, 'node', '/opt/freshell-mcp/server.js', '--self-test',
  ], { timeout: 60_000 })
  const result = JSON.parse(stdout.trim())
  if (result.tool !== 'freshell' || result.action !== 'health' || result.ok !== true || acceptedRequests !== 1) {
    throw new Error(`MCP image probe returned an unexpected result: ${stdout.trim()}; requests=${acceptedRequests}`)
  }
  process.stdout.write(JSON.stringify({ image, ...result, requests: acceptedRequests }) + '\n')
} finally {
  endpoint.close()
  // execFile timeout kills the Docker client, so remove only this named probe
  // container if it outlived the client. A successful --rm run is already gone.
  await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined)
}
