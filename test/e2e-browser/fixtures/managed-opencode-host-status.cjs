#!/usr/bin/env node
// Read-only test client for the exact owned session host. It never sends input.
const { createHmac, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const CONTROL_PROTOCOL_VERSION = 2

function proof(secret, challenge, hostBootId, incarnationId) {
  return createHmac('sha256', secret)
    .update(`${challenge}\0${hostBootId}\0${incarnationId}`)
    .digest('hex')
}

function exchange(socketPath, body, auth) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const payload = Buffer.from(JSON.stringify({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      requestId,
      role: 'supervisor',
      ...(auth ? { auth } : {}),
      body,
    }))
    const frame = Buffer.allocUnsafe(payload.length + 4)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    const socket = net.createConnection(socketPath)
    let buffer = Buffer.alloc(0)
    let settled = false
    const settle = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => settle(new Error('owned host status timed out')), 5000)
    socket.once('connect', () => socket.write(frame))
    socket.once('error', (error) => settle(error))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      const size = buffer.readUInt32BE(0)
      if (size > 1024 * 1024) return settle(new Error('owned host status frame exceeds bound'))
      if (buffer.length < size + 4) return
      try {
        const reply = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'))
        if (reply.requestId !== requestId) throw new Error('owned host status request ID mismatch')
        if (reply.result?.Err) throw new Error(`owned host status rejected: ${reply.result.Err.code}`)
        settle(null, reply.result?.Ok)
      } catch (error) {
        settle(error)
      }
    })
    socket.once('close', () => {
      if (!settled) settle(new Error('owned host status socket closed before reply'))
    })
  })
}

async function readHostAdoptionStatus(runtimeDir, incarnationId, expectedHostBootId) {
  if (!/^incarnation-[A-Za-z0-9-]+$/.test(incarnationId)) {
    throw new Error('invalid owned host incarnation ID')
  }
  if (typeof expectedHostBootId !== 'string' || expectedHostBootId.length === 0) {
    throw new Error('invalid expected owned host boot ID')
  }
  const socketPath = path.join(runtimeDir, 'host.sock')
  const secret = fs.readFileSync(path.join(runtimeDir, 'secret'))
  const challenge = randomUUID()
  const hello = await exchange(socketPath, { method: 'hello', params: { incarnation_id: incarnationId, challenge } })
  if (hello?.kind !== 'hello' || typeof hello.data?.host_boot_id !== 'string') {
    throw new Error('owned host did not return a hello reply')
  }
  const hostBootId = hello.data.host_boot_id
  if (hostBootId !== expectedHostBootId) {
    throw new Error('owned host boot ID changed before status read')
  }
  if (hello.data.proof !== proof(secret, challenge, hostBootId, incarnationId)) {
    throw new Error('owned host challenge proof mismatch')
  }
  const status = await exchange(socketPath, {
    method: 'status', params: { incarnation_id: incarnationId },
  }, proof(secret, 'command-auth', hostBootId, incarnationId))
  if (status?.kind !== 'status' || status.data?.host_boot_id !== hostBootId
    || !status.data.opencode_adoption) {
    throw new Error('owned host did not return bound OpenCode adoption status')
  }
  return status.data.opencode_adoption
}

module.exports = { readHostAdoptionStatus }

if (require.main === module) {
  readHostAdoptionStatus(process.argv[2], process.argv[3], process.argv[4])
    .then((status) => process.stdout.write(`${JSON.stringify(status)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
}
