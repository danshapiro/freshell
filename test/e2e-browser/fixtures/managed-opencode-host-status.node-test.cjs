const assert = require('node:assert/strict')
const { createHmac } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { after, before, test } = require('node:test')

const { readHostAdoptionStatus } = require('./managed-opencode-host-status.cjs')

const incarnationId = 'incarnation-test-123'
const hostBootId = 'hostboot-test-123'
const secret = Buffer.from('test-host-secret-123456789')
let runtimeDir
let server
let adoption = { state: 'awaiting_observation' }
let forgeHelloProof = false
const commands = []

function proof(challenge) {
  return createHmac('sha256', secret)
    .update(`${challenge}\0${hostBootId}\0${incarnationId}`)
    .digest('hex')
}

before(async () => {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-host-status-'))
  fs.writeFileSync(path.join(runtimeDir, 'secret'), secret)
  server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      const size = buffer.readUInt32BE(0)
      if (buffer.length < size + 4) return
      const request = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'))
      commands.push(request)
      let result
      if (request.body.method === 'hello') {
        assert.equal(request.body.params.incarnation_id, incarnationId)
        result = { kind: 'hello', data: {
          host_boot_id: hostBootId,
          proof: forgeHelloProof ? 'forged' : proof(request.body.params.challenge),
        } }
      } else {
        assert.equal(request.body.method, 'status')
        assert.equal(request.body.params.incarnation_id, incarnationId)
        assert.equal(request.auth, proof('command-auth'))
        result = { kind: 'status', data: {
          host_boot_id: hostBootId,
          opencode_adoption: adoption,
        } }
      }
      const payload = Buffer.from(JSON.stringify({ requestId: request.requestId, result: { Ok: result } }))
      const frame = Buffer.alloc(4 + payload.length)
      frame.writeUInt32BE(payload.length, 0)
      payload.copy(frame, 4)
      socket.end(frame)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path.join(runtimeDir, 'host.sock'), resolve)
  })
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (runtimeDir) fs.rmSync(runtimeDir, { recursive: true, force: true })
})

test('reads an authenticated observation from the exact session host', async () => {
  assert.deepEqual(await readHostAdoptionStatus(runtimeDir, incarnationId, hostBootId), { state: 'awaiting_observation' })
  adoption = { state: 'observed', data: { observation: {
    terminalId: 'terminal-test',
    rootSessionId: 'session-test',
    tailMessageId: 'message-test',
    evidenceGeneration: 'a'.repeat(64),
    incarnationId,
    launchNonce: 'nonce-test',
    hydrated: true,
    messagesRead: 'success',
  } } }
  assert.deepEqual(await readHostAdoptionStatus(runtimeDir, incarnationId, hostBootId), adoption)
  assert.equal(commands.length, 4)
  assert.equal(commands[0].protocolVersion, 2)
  assert.equal(commands[0].body.method, 'hello')
  assert.equal(commands[1].body.method, 'status')
})

test('rejects forged host identity before asking for status', async () => {
  const beforeCount = commands.length
  forgeHelloProof = true
  await assert.rejects(readHostAdoptionStatus(runtimeDir, incarnationId, hostBootId), /challenge proof mismatch/)
  forgeHelloProof = false
  assert.equal(commands.length, beforeCount + 1)
  assert.equal(commands.at(-1).body.method, 'hello')
})

test('rejects a host boot that differs from the captured running view', async () => {
  await assert.rejects(readHostAdoptionStatus(runtimeDir, incarnationId, 'different-host-boot'), /boot ID changed/)
})
