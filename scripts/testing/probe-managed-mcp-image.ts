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
let proxyRequests = 0
const endpoint = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/api/health' || request.headers['x-auth-token'] !== token) {
    response.writeHead(403).end()
    return
  }
  acceptedRequests++
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ probe: 'freshell-mcp-image' }))
})
const proxy = createServer((_request, response) => {
  proxyRequests++
  const body = 'the model proxy must not receive Freshell API traffic'
  response.writeHead(502, { connection: 'close', 'content-length': String(body.length) })
  response.end(body)
})
proxy.on('connect', (_request, socket) => {
  proxyRequests++
  socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
})

endpoint.listen(0, '127.0.0.1')
await once(endpoint, 'listening')
proxy.listen(0, '127.0.0.1')
await once(proxy, 'listening')
const address = endpoint.address()
const proxyAddress = proxy.address()
if (!address || typeof address === 'string') throw new Error('Probe endpoint has no TCP port')
if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Probe proxy has no TCP port')
const containerName = `freshell-mcp-probe-${process.pid}`

try {
  const { stdout } = await execFileAsync('docker', [
    'run', '--rm', '--name', containerName, '--network', 'host', '--read-only',
    '--cap-drop', 'ALL',
    '--env', `FRESHELL_URL=http://127.0.0.1:${address.port}`,
    '--env', `FRESHELL_TOKEN=${token}`,
    '--env', 'NODE_USE_ENV_PROXY=1',
    '--env', `HTTP_PROXY=http://127.0.0.1:${proxyAddress.port}`,
    '--env', `http_proxy=http://127.0.0.1:${proxyAddress.port}`,
    '--env', `HTTPS_PROXY=http://127.0.0.1:${proxyAddress.port}`,
    '--env', `https_proxy=http://127.0.0.1:${proxyAddress.port}`,
    '--env', 'NO_PROXY=',
    '--env', 'no_proxy=',
    image, 'node', '/opt/freshell-mcp/server.js', '--self-test',
  ], { timeout: 60_000 })
  const result = JSON.parse(stdout.trim())
  if (result.tool !== 'freshell' || result.action !== 'health' || result.ok !== true || acceptedRequests !== 1 || proxyRequests !== 0) {
    throw new Error(`MCP image probe returned an unexpected result: ${stdout.trim()}; endpointRequests=${acceptedRequests}; proxyRequests=${proxyRequests}`)
  }
  process.stdout.write(JSON.stringify({ image, ...result, endpointRequests: acceptedRequests, proxyRequests }) + '\n')
} finally {
  const closeServer = (server: typeof endpoint) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
  // execFile timeout kills the Docker client, so remove only this named probe
  // container if it outlived the client. A successful --rm run is already gone.
  await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined)
  await Promise.all([closeServer(endpoint), closeServer(proxy)])
}
