// Finite, single-volume control for separately admitted disposable-guest
// cases. Its marker and input checks do not qualify the guest or daemon.
// A separate process lets synchronous Docker CLI calls leave its timers live.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

const mode = process.env.FRESHELL_TASK4_FORWARD_MODE
const listenPath = process.env.FRESHELL_TASK4_FORWARD_SOCKET
const upstreamPath = process.env.FRESHELL_TASK4_DOCKER_SOCKET
const privateRoot = process.env.FRESHELL_TASK4_PRIVATE_ROOT
const target = process.env.FRESHELL_TASK4_FORWARD_VOLUME
const daemonId = process.env.FRESHELL_TASK4_DAEMON_ID
const modes = new Set(['lost_ack', 'capture_timeout'])

function emit(event, details = {}) {
  const severity = /failed|timeout|unexpected|deadline/.test(event) ? 'error' : 'info'
  process.stdout.write(`${JSON.stringify({ severity, event, atMs: Date.now(), ...details })}\n`)
}

function insideOrEqual(root, value) {
  const relative = path.relative(root, value)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function requireInputs() {
  if (process.env.FRESHELL_TASK4_GUEST_QUALIFIED !== '1' || !modes.has(mode)
    || !listenPath || !upstreamPath || !privateRoot || !/^[a-zA-Z0-9:_-]{1,128}$/.test(daemonId ?? '')
    || !/^freshell-provider-[a-f0-9]{24}$/.test(target ?? '')
    || !path.isAbsolute(listenPath) || !path.isAbsolute(upstreamPath)) {
    throw new Error('admitted guest marker, exact sockets, target and control mode required')
  }
  const root = fs.realpathSync(privateRoot)
  if (!insideOrEqual(root, fs.realpathSync(path.dirname(listenPath))) || !fs.statSync(upstreamPath).isSocket()) {
    throw new Error('private control socket and daemon socket required')
  }
  try { fs.lstatSync(listenPath); throw new Error('control socket path already exists') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

// Only the exact fixture operation plus Docker's discovery requests are
// forwarded. Any other request fails closed and makes this control fail.
function classify(method, rawUrl, body) {
  const url = new URL(rawUrl, 'http://localhost')
  const endpoint = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/, '')
  if (['GET', 'HEAD'].includes(method) && (endpoint === '/_ping' || endpoint === '/version')) return 'discovery'
  if (mode === 'lost_ack' && method === 'POST' && endpoint === '/volumes/create') {
    const parsed = JSON.parse(body.toString('utf8'))
    return parsed.Name === target ? 'create' : 'unexpected'
  }
  if (mode === 'capture_timeout' && method === 'GET' && endpoint === '/volumes') {
    const filters = JSON.parse(url.searchParams.get('filters') ?? '{}')
    const names = filters.name
    const expected = `^${target}$`
    const exact = Array.isArray(names) ? names.length === 1 && names[0] === expected
      : names && typeof names === 'object' && Object.keys(names).length === 1 && names[expected] === true
    return exact && Object.keys(filters).length === 1 ? 'volume_list' : 'unexpected'
  }
  if (mode === 'capture_timeout' && method === 'GET' && endpoint === '/info') return 'info'
  return 'unexpected'
}

async function boundedBytes(stream, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > limit) throw new Error('control message exceeds bound')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

requireInputs()
let phase = 0
let outcome
let serverClosed = false
let reported = false
let active = 0
let deadline
const cancellation = new AbortController()
const upstreams = new Set()
const sockets = new Set()
const server = http.createServer((request, response) => {
  active++
  let responseClosed = false
  response.once('close', () => { responseClosed = true })
  void (async () => {
    const body = await boundedBytes(request, 64 * 1024)
    const kind = classify(request.method ?? '', request.url ?? '', body)
    if (kind === 'unexpected'
      || (kind === 'create' && phase !== 0)
      || (kind === 'volume_list' && phase !== 0)
      || (kind === 'info' && phase !== 2)) {
      emit('forwarder.unexpected_request', { mode })
      response.writeHead(403, { connection: 'close' }).end()
      finish(false)
      return
    }
    if (kind === 'create' || kind === 'volume_list') phase = 1
    if (kind === 'info') phase = 3
    const started = Date.now()
    const upstreamResult = await new Promise((resolve, reject) => {
      const upstream = http.request({ socketPath: upstreamPath, method: request.method, path: request.url,
        headers: { host: 'localhost', connection: 'close', 'content-type': 'application/json', 'content-length': body.length } }, result => {
        void boundedBytes(result, 1024 * 1024).then(bytes => resolve({ status: result.statusCode ?? 0, bytes, headers: result.headers }), reject)
      })
      upstreams.add(upstream)
      upstream.on('close', () => { upstreams.delete(upstream); maybeFinish() })
      upstream.on('error', reject)
      upstream.setTimeout(12_000, () => upstream.destroy(new Error('daemon response timeout')))
      upstream.end(body)
    })
    const { status, bytes, headers } = upstreamResult
    if (kind !== 'discovery' && (status < 200 || status >= 300)) throw new Error('daemon fixture request did not succeed')
    if (kind === 'create') {
      const observed = JSON.parse(bytes.toString('utf8'))
      if (observed.Name !== target || status !== 201) throw new Error('daemon did not acknowledge the exact creation')
      emit('forwarder.daemon_create_observed', { daemonId, volume: target, status })
      // The real daemon response has been fully received; only this downstream
      // acknowledgement is dropped. No daemon result is fabricated.
      response.destroy()
      emit('forwarder.acknowledgement_dropped', { volume: target })
      finish(true)
      return
    }
    if (kind === 'volume_list' || kind === 'info') {
      const holdMs = kind === 'volume_list' ? 4000 : 7000
      emit('forwarder.daemon_response_held', { daemonId, volume: target, kind, status, holdMs })
      const holdStarted = Date.now()
      await pause(holdMs, undefined, { signal: cancellation.signal })
      const clientClosed = responseClosed || response.destroyed
      emit('forwarder.hold_finished', { kind, elapsedMs: Date.now() - holdStarted, totalMs: Date.now() - started, clientClosed })
      if (kind === 'volume_list') phase = 2
      if (kind === 'info') phase = 4
      if (clientClosed) {
        if (kind === 'info') finish(true)
        else throw new Error('first capture command did not settle')
        return
      }
    }
    const responseHeaders = { connection: 'close', 'content-length': bytes.length }
    for (const key of ['api-version', 'docker-experimental', 'builder-version', 'ostype', 'content-type']) {
      if (typeof headers[key] === 'string') responseHeaders[key] = headers[key]
    }
    response.writeHead(status, responseHeaders)
    if (kind === 'info') response.once('finish', () => finish(false)) // the ten-second capture should already have timed out
    response.end(bytes)
  })().catch(() => {
    if (outcome === undefined) emit('forwarder.operation_failed', { mode })
    if (!response.destroyed) response.destroy()
    finish(false)
  }).finally(() => { active--; maybeFinish() })
})

server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); maybeFinish() }) })
server.on('error', () => { emit('forwarder.listen_failed', { mode }); finish(false) })

function finish(ok) {
  if (outcome !== undefined) return
  outcome = ok
  clearTimeout(deadline)
  cancellation.abort()
  for (const upstream of upstreams) upstream.destroy()
  for (const socket of sockets) socket.destroy()
  server.close(() => { serverClosed = true; maybeFinish() })
}

function maybeFinish() {
  if (reported || outcome === undefined || !serverClosed || active !== 0 || upstreams.size !== 0 || sockets.size !== 0) return
  reported = true
  let socketStillExists = false
  try { fs.lstatSync(listenPath); socketStillExists = true } catch (error) { if (error.code !== 'ENOENT') socketStillExists = true }
  emit('forwarder.settled', { mode, ok: outcome, phase, socketStillExists, active, upstreams: 0, sockets: 0 })
  process.exitCode = outcome && !socketStillExists ? 0 : 1
}

deadline = setTimeout(() => { emit('forwarder.deadline', { mode }); finish(false) }, 25_000)
server.listen(listenPath, () => {
  try {
    fs.chmodSync(listenPath, 0o600)
    emit('forwarder.ready', { mode, socket: listenPath, daemonId, volume: target })
  } catch { emit('forwarder.listen_failed', { mode }); finish(false) }
})
