/**
 * Probe "server" for pinning exactly which `FRESHELL_MANAGED_RUNTIME_V1`
 * value reaches a spawned test server's environment. Used through the
 * `FRESHELL_E2E_RUST_SERVER_BIN` override: a plain Node script that writes
 * the value it observed (or '<unset>') to the file named by
 * `FRESHELL_E2E_MANAGED_ENV_CAPTURE`, then answers the two endpoints
 * RustServer's boot sequence requires (`/api/health` poll plus the
 * `/api/server-info` token-identity check). Shared by the factory-path
 * pin (external-target.test.ts) and the direct-construction pins
 * (rust-server.test.ts) so both seams observe the SAME spawned-env
 * contract.
 */
export const managedEnvironmentProbeServer = String.raw`#!/usr/bin/env node
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
