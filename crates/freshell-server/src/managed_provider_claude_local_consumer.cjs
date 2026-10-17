const fs = require('node:fs')
const crypto = require('node:crypto')
const readline = require('node:readline')
const hash = value => crypto.createHash('sha256').update(value || '').digest('hex')
fs.writeFileSync(process.argv[2], JSON.stringify({
  selectedSha256: hash(process.env.FRESHELL_LOCAL_SELECTED_NONCE),
  cwdOnlySha256: hash(process.env.FRESHELL_LOCAL_CWD_ONLY_NONCE),
  consumerUid: process.geteuid(), consumerGid: process.getegid(),
}))
readline.createInterface({ input: process.stdin }).on('line', line => {
  let request
  try { request = JSON.parse(line) } catch { return }
  if (request.id === undefined) return
  let result
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'closed-local-observer', version: '1.0.0' } }
      break
    case 'tools/list': result = { tools: [] }; break
    case 'ping': result = {}; break
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32601, message: 'unsupported fixture method' } }) + '\n')
      return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
})
