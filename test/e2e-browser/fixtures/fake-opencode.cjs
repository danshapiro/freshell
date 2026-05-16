#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

function appendAudit(payload) {
  const auditPath = process.env.FAKE_OPENCODE_AUDIT_LOG
  if (!auditPath) return
  fs.mkdirSync(path.dirname(auditPath), { recursive: true })
  fs.appendFileSync(auditPath, `${JSON.stringify({
    pid: process.pid,
    t: Date.now(),
    argv: process.argv.slice(2),
    ...payload,
  })}\n`)
}

if (process.argv.includes('--version') || process.argv.includes('version')) {
  process.stdout.write('opencode fake 1.0.0\n')
  process.exit(0)
}

const hostname = argValue('--hostname') || '127.0.0.1'
const port = Number(argValue('--port'))
const sessionArg = argValue('--session')

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  process.stdout.write('fake opencode: no server port requested\n')
  process.exit(0)
}

const rootSessionId = sessionArg || `ses_root_${port}`
const childSessionId = `ses_child_${rootSessionId.replace(/[^a-zA-Z0-9_]/g, '_')}`
const now = Math.floor(Date.now() / 1000)
const dataHome = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, 'opencode')
  : path.join(os.homedir(), '.local', 'share', 'opencode')
const dbPath = path.join(dataHome, 'opencode.db')

function seedDatabase() {
  fs.mkdirSync(dataHome, { recursive: true })
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id text PRIMARY KEY,
        worktree text
      );
      CREATE TABLE IF NOT EXISTS session (
        id text PRIMARY KEY,
        parent_id text,
        project_id text,
        directory text,
        title text,
        time_created integer,
        time_updated integer,
        time_archived integer
      );
    `)
    db.prepare('INSERT OR REPLACE INTO project (id, worktree) VALUES (?, ?)').run('proj-test', process.cwd())
    db.prepare(`
      INSERT OR REPLACE INTO session
        (id, parent_id, project_id, directory, title, time_created, time_updated, time_archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(rootSessionId, null, 'proj-test', process.cwd(), `Root ${rootSessionId}`, now, now)
    db.prepare(`
      INSERT OR REPLACE INTO session
        (id, parent_id, project_id, directory, title, time_created, time_updated, time_archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(childSessionId, rootSessionId, 'proj-test', process.cwd(), `Child ${childSessionId}`, now, now)
  } finally {
    db.close()
  }
}

seedDatabase()

appendAudit({
  event: 'launch',
  hostname,
  port,
  rootSessionId,
  childSessionId,
  sessionArg,
  dbPath,
})

process.stdout.write(`fake opencode ready root=${rootSessionId} child=${childSessionId}\n`)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  appendAudit({
    event: 'stdin',
    rootSessionId,
    childSessionId,
    data,
  })
  process.stdout.write(`fake opencode received ${JSON.stringify(data)}\n`)
})

const eventClients = new Set()
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${hostname}:${port}`)
  if (url.pathname === '/global/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (url.pathname === '/session/status') {
    appendAudit({
      event: 'status',
      rootSessionId,
      childSessionId,
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      [rootSessionId]: { type: 'busy' },
      [childSessionId]: { type: 'busy' },
    }))
    return
  }

  if (url.pathname === '/event') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    eventClients.add(res)
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
    setTimeout(() => {
      if (res.destroyed) return
      res.write(`data: ${JSON.stringify({
        type: 'session.created',
        properties: {
          sessionID: childSessionId,
          info: {
            id: childSessionId,
            parentID: rootSessionId,
          },
        },
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        type: 'session.idle',
        properties: {
          sessionID: childSessionId,
        },
      })}\n\n`)
    }, 100)
    req.on('close', () => {
      eventClients.delete(res)
    })
    return
  }

  if (url.pathname === '/session') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([
      { id: rootSessionId, title: `Root ${rootSessionId}` },
      { id: childSessionId, parentID: rootSessionId, title: `Child ${childSessionId}` },
    ]))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

function shutdown(signal) {
  appendAudit({ event: 'shutdown', signal, rootSessionId, childSessionId })
  for (const client of eventClients) {
    try {
      client.end()
    } catch {
      // ignore
    }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGHUP', () => shutdown('SIGHUP'))

server.listen(port, hostname, () => {
  appendAudit({ event: 'listen', hostname, port, rootSessionId, childSessionId })
})
