#!/usr/bin/env node
// HARNESS-03 deterministic fake `opencode` SERVER (the freshopencode
// sidecar), launched as `fake-opencode-server.mjs serve --port N
// [--hostname H]`.
//
// Wire surface mirrors the consumer contract in
// the Rust OpenCode event adapter (flat SSE frames
// `data: {"type":…,"properties":…}\n\n`; `server.connected` on connect;
// `session.status {status:{type:'busy'|'idle'}}` + `session.idle`) and the
// durable-resume probe in freshell-freshagent/src/opencode_ws.rs
// (`GET /session/:id` -> 200/exists vs 404/lost). Session state is in-memory:
// the fixture's contract is the HTTP/SSE surface, not opencode's sqlite
// layout (the legacy fake-opencode.cjs already covers DB realism).
//
// Turn semantics on POST /session/:id/message: the HTTP 200 lands
// immediately; the SSE flow is session.status busy (unconditional turn-open
// bookkeeping) -> program-rule events (approval -> `permission.asked`,
// question -> `question.asked`) -> completion default: session.idle +
// session.status idle.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendLaunchLedger, FixtureEngine, keepAlive, loadProgram } from './fixture-core.mjs'

const provider = process.env.FRESHELL_FAKE_PROVIDER ?? 'opencode-server'
const argv = process.argv.slice(2)
const env = process.env

function argValue(name) {
  const index = argv.indexOf(name)
  if (index === -1 || index === argv.length - 1) return undefined
  return argv[index + 1]
}

const command = argv[0]
const port = Number(argValue('--port'))
const hostname = argValue('--hostname') ?? '127.0.0.1'
if (command !== 'serve' || !Number.isFinite(port)) {
  console.error('fake-opencode-server: usage: serve --port N [--hostname H]')
  process.exit(64)
}

appendLaunchLedger({ provider, argv, env })
const program = loadProgram(env)

const sseClients = new Set()
let activeSessionId = null

function broadcast(type, properties) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`
  for (const res of sseClients) {
    try {
      res.write(frame)
    } catch {
      // client went away; cleanup happens on close
    }
  }
}

function render(event) {
  const { kind, data } = event
  const sessionId = data.sessionId ?? activeSessionId
  switch (kind) {
    case 'activity':
      broadcast('session.status', { sessionID: sessionId, status: { type: data.status ?? 'busy' } })
      break
    case 'approval':
      broadcast('permission.asked', {
        id: String(data.id ?? `perm-${randomUUID()}`),
        sessionID: sessionId,
        permission: data.permission ?? data.tool ?? 'bash',
        patterns: data.patterns ?? [],
        always: [],
        metadata: data.input ?? {},
      })
      break
    case 'question':
      broadcast('question.asked', {
        id: String(data.id ?? `q-${randomUUID()}`),
        sessionID: sessionId,
        questions: Array.isArray(data.questions)
          ? data.questions
          : [{ question: data.text ?? '', header: 'Fixture', options: [], multiple: false }],
      })
      break
    case 'completion':
      broadcast('session.idle', { sessionID: sessionId })
      broadcast('session.status', { sessionID: sessionId, status: { type: 'idle' } })
      break
    case 'marker':
      broadcast('freshell.fixture/marker', { ...data, sessionID: sessionId })
      break
    default:
      // session/resume/crash: results/exits + ledger rows carry the meaning.
      break
  }
}

const engine = new FixtureEngine({ provider, program, env, write: render })

const sessions = new Map()

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  void route(req, res).catch(() => {
    if (!res.headersSent) json(res, 500, { error: 'fixture internal error' })
    else res.end()
  })
})

async function route(req, res) {
  const url = new URL(req.url ?? '/', `http://${hostname}:${port}`)
  const method = req.method ?? 'GET'

  if (method === 'GET' && (url.pathname === '/event' || url.pathname === '/global/event')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    sseClients.add(res)
    res.on('close', () => sseClients.delete(res))
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
    return
  }

  if (method === 'POST' && url.pathname === '/session') {
    const body = await readBody(req)
    const id = `sess-${randomUUID()}`
    const now = Date.now()
    sessions.set(id, {
      id,
      directory: body.directory ?? process.cwd(),
      title: 'fixture session',
      version: 'fixture',
      time: { created: now, updated: now },
    })
    activeSessionId = id
    const emitted = await engine.handleHttp(method, url.pathname, body)
    if (emitted.has('crash')) return
    if (!emitted.has('session')) {
      await engine.emitSession(id, 'http:POST /session')
    }
    json(res, 200, sessions.get(id))
    return
  }

  const sessionMatch = url.pathname.match(/^\/session\/([^/]+)(\/message)?$/)
  if (sessionMatch) {
    const [, sessionId, tail] = sessionMatch
    if (method === 'GET' && !tail) {
      const row = sessions.get(sessionId)
      if (!row) {
        json(res, 404, { error: 'session not found' })
        return
      }
      // The durable-resume probe (opencode_ws.rs resume_durable_session).
      await engine.emitResume(sessionId, 'http:GET /session/:id')
      json(res, 200, row)
      return
    }
    if (method === 'POST' && tail === '/message') {
      const body = await readBody(req)
      if (!sessions.has(sessionId)) {
        json(res, 404, { error: 'session not found' })
        return
      }
      activeSessionId = sessionId
      json(res, 200, { info: { id: `msg-${randomUUID()}`, sessionID: sessionId } })
      // Unconditional turn-open; a matching rule owns the middle; the
      // completion default closes the turn when the program didn't.
      await engine.emitEvent('activity', { state: 'busy' }, 'http:message:open')
      const emitted = await engine.handleHttp(method, url.pathname, body)
      if (emitted.has('crash')) return
      if (!emitted.has('completion')) {
        await engine.emitEvent('completion', { subtype: 'success' }, 'http:message:default')
      }
      return
    }
  }

  if (method === 'GET' && url.pathname === '/session/status') {
    json(res, 200, {})
    return
  }

  json(res, 404, { error: `fake opencode: no route ${method} ${url.pathname}` })
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

server.listen(port, hostname, () => {
  // Readiness line the launcher greps for.
  process.stdout.write(`fake opencode server listening on http://${hostname}:${port}\n`)
})

keepAlive()
