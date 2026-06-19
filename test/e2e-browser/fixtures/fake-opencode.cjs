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

const argv = process.argv.slice(2)
const command = argv[0]

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

const dataHome = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, 'opencode')
  : path.join(os.homedir(), '.local', 'share', 'opencode')
const dbPath = path.join(dataHome, 'opencode.db')

function openDatabase() {
  fs.mkdirSync(dataHome, { recursive: true })
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

function ensureSchema(db) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id text PRIMARY KEY,
        worktree text
      );
      CREATE TABLE IF NOT EXISTS session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        workspace_id text,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        path text,
        title text NOT NULL,
        version text NOT NULL,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        metadata text,
        cost real NOT NULL DEFAULT 0,
        tokens_input integer NOT NULL DEFAULT 0,
        tokens_output integer NOT NULL DEFAULT 0,
        tokens_reasoning integer NOT NULL DEFAULT 0,
        tokens_cache_read integer NOT NULL DEFAULT 0,
        tokens_cache_write integer NOT NULL DEFAULT 0,
        revert text,
        permission text,
        agent text,
        model text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_compacting integer,
        time_archived integer
      );
      CREATE TABLE IF NOT EXISTS message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id text PRIMARY KEY,
        message_id text NOT NULL,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `)
}

function sessionModel() {
  return JSON.stringify({ providerID: 'opencode', modelID: 'fake-opencode' })
}

function insertSession(db, input) {
  db.prepare('INSERT OR REPLACE INTO project (id, worktree) VALUES (?, ?)').run(input.projectId, input.directory)
  db.prepare(`
      INSERT OR REPLACE INTO session
        (
          id, project_id, workspace_id, parent_id, slug, directory, path, title, version,
          share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
          metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
          tokens_cache_write, revert, permission, agent, model, time_created, time_updated,
          time_compacting, time_archived
        )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?, ?, ?, NULL, NULL)
    `).run(
      input.sessionId,
      input.projectId,
      input.parentId ?? null,
      input.slug,
      input.directory,
      input.directory,
      input.title,
      'fake-opencode-e2e',
      'fake',
      sessionModel(),
      input.createdAt,
      input.updatedAt,
    )
}

function countMessages(db, sessionId) {
  const row = db.prepare('SELECT COUNT(*) AS count FROM message WHERE session_id = ?').get(sessionId)
  return Number(row?.count ?? 0)
}

function insertTextMessage(db, input) {
  db.prepare(`
      INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.messageId,
      input.sessionId,
      input.now,
      input.now,
      JSON.stringify({ role: input.role }),
    )
  db.prepare(`
      INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.partId,
      input.messageId,
      input.sessionId,
      input.now,
      input.now,
      JSON.stringify({ type: 'text', text: input.text }),
    )
}

function serverProjectDirectory() {
  if (process.env.FAKE_OPENCODE_PROJECT_CWD) return process.env.FAKE_OPENCODE_PROJECT_CWD
  try {
    return path.dirname(fs.realpathSync(dataHome))
  } catch {
    return process.cwd()
  }
}

function seedServerDatabase(rootSessionId, childSessionId) {
  const now = Date.now()
  const directory = serverProjectDirectory()
  const db = openDatabase()
  try {
    ensureSchema(db)
    insertSession(db, {
      sessionId: rootSessionId,
      projectId: 'proj-test',
      parentId: null,
      slug: rootSessionId,
      directory,
      title: `Root ${rootSessionId}`,
      createdAt: now,
      updatedAt: now,
    })
    insertSession(db, {
      sessionId: childSessionId,
      projectId: 'proj-test',
      parentId: rootSessionId,
      slug: childSessionId,
      directory,
      title: `Child ${childSessionId}`,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

function seedRunDatabase(input) {
  const db = openDatabase()
  try {
    ensureSchema(db)
    const existing = db.prepare('SELECT time_created FROM session WHERE id = ?').get(input.sessionId)
    const sequence = countMessages(db, input.sessionId) + 1
    const userTime = Date.now()
    const assistantTime = userTime + 1
    insertSession(db, {
      sessionId: input.sessionId,
      projectId: 'proj-run',
      parentId: null,
      slug: input.sessionId,
      directory: process.cwd(),
      title: `Freshopencode ${input.sessionId}`,
      createdAt: Number(existing?.time_created ?? userTime),
      updatedAt: assistantTime,
    })
    const userMessageId = `${input.sessionId}_msg_${sequence}_user`
    const assistantMessageId = `${input.sessionId}_msg_${sequence + 1}_assistant`
    insertTextMessage(db, {
      sessionId: input.sessionId,
      messageId: userMessageId,
      partId: `${userMessageId}_part_text`,
      role: 'user',
      text: input.prompt,
      now: userTime,
    })
    insertTextMessage(db, {
      sessionId: input.sessionId,
      messageId: assistantMessageId,
      partId: `${assistantMessageId}_part_text`,
      role: 'assistant',
      text: input.responseText,
      now: assistantTime,
    })
    return { userMessageId, assistantMessageId, assistantPartId: `${assistantMessageId}_part_text`, assistantTime }
  } finally {
    db.close()
  }
}

function parseJsonText(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return JSON.parse(value)
}

function readExport(sessionId) {
  const db = openDatabase()
  try {
    ensureSchema(db)
    const infoRow = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId)
    if (!infoRow) return { info: { id: sessionId }, messages: [] }
    const messageRows = db.prepare(`
      SELECT id, session_id, time_created, time_updated, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
    `).all(sessionId)
    const messages = messageRows.map((message) => {
      const partRows = db.prepare(`
        SELECT id, message_id, session_id, time_created, time_updated, data
        FROM part
        WHERE session_id = ? AND message_id = ?
        ORDER BY id ASC
      `).all(sessionId, message.id)
      return {
        info: {
          ...(parseJsonText(message.data) ?? {}),
          id: message.id,
          sessionID: message.session_id,
          time: { created: message.time_created, updated: message.time_updated },
        },
        parts: partRows.map((part) => ({
          ...(parseJsonText(part.data) ?? {}),
          id: part.id,
          sessionID: part.session_id,
          messageID: part.message_id,
          time: { created: part.time_created, updated: part.time_updated },
        })),
      }
    })
    return {
      info: {
        id: infoRow.id,
        directory: infoRow.directory,
        title: infoRow.title,
        model: parseJsonText(infoRow.model),
        tokens: {
          input: infoRow.tokens_input,
          output: infoRow.tokens_output,
          reasoning: infoRow.tokens_reasoning,
          cache: { read: infoRow.tokens_cache_read, write: infoRow.tokens_cache_write },
        },
        time: { created: infoRow.time_created, updated: infoRow.time_updated },
      },
      messages,
    }
  } finally {
    db.close()
  }
}

if (command === 'run') {
  const sessionId = argValue('--session') || `ses_run_${Date.now()}_${process.pid}`
  const prompt = typeof argv[1] === 'string' && !argv[1].startsWith('-') ? argv[1] : ''
  const responseText = process.env.FAKE_OPENCODE_RESPONSE_TEXT || `Fake OpenCode response: ${prompt}`
  const seeded = seedRunDatabase({ sessionId, prompt, responseText })
  const omitRunSessionId = process.env.FAKE_OPENCODE_RUN_NO_SESSION_ID === '1'
  appendAudit({
    event: 'run',
    sessionId,
    prompt,
    omitRunSessionId,
    dbPath,
  })
  if (!omitRunSessionId) {
    process.stdout.write(JSON.stringify({
      type: 'text',
      timestamp: seeded.assistantTime,
      sessionID: sessionId,
      part: {
        id: seeded.assistantPartId,
        sessionID: sessionId,
        messageID: seeded.assistantMessageId,
        type: 'text',
        text: responseText,
      },
    }) + '\n')
  } else {
    process.stdout.write(JSON.stringify({
      type: 'text',
      timestamp: seeded.assistantTime,
      part: { type: 'text', text: responseText },
    }) + '\n')
  }
  process.exit(0)
}

if (command === 'export') {
  const sessionId = argv[1]
  appendAudit({ event: 'export', sessionId, dbPath })
  if (process.env.FAKE_OPENCODE_TRUNCATE_EXPORT === '1') {
    process.stdout.write(`Exporting session: ${sessionId}\n{"info":`)
    process.exit(0)
  }
  process.stdout.write(`Exporting session: ${sessionId}\n${JSON.stringify(readExport(sessionId))}\n`)
  process.exit(0)
}

const hostname = argValue('--hostname') || '127.0.0.1'
const port = Number(argValue('--port'))
const sessionArg = argValue('--session')
const sessionEventGatePath = process.env.FAKE_OPENCODE_SESSION_EVENT_GATE_PATH

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  process.stdout.write('fake opencode: no server port requested\n')
  process.exit(0)
}

const rootSessionId = sessionArg || `ses_root_${port}`
const childSessionId = `ses_child_${rootSessionId.replace(/[^a-zA-Z0-9_]/g, '_')}`

seedServerDatabase(rootSessionId, childSessionId)

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

function emitSessionEvents(res) {
  if (res.destroyed) return
  appendAudit({
    event: 'session_events_emitted',
    rootSessionId,
    childSessionId,
  })
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
}

function scheduleSessionEvents(res) {
  if (sessionEventGatePath) {
    const interval = setInterval(() => {
      if (res.destroyed) {
        clearInterval(interval)
        return
      }
      if (!fs.existsSync(sessionEventGatePath)) return
      clearInterval(interval)
      emitSessionEvents(res)
    }, 50)
    interval.unref?.()
    return
  }

  setTimeout(() => emitSessionEvents(res), 100)
}

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
    scheduleSessionEvents(res)
    req.on('close', () => {
      eventClients.delete(res)
    })
    return
  }

  if (url.pathname === '/session') {
    if (req.method === 'POST') {
      appendAudit({
        event: 'session_create_requested',
        rootSessionId,
        childSessionId,
      })
      if (process.env.FAKE_OPENCODE_HANG_SESSION_CREATE === '1') {
        req.on('close', () => {
          appendAudit({
            event: 'session_create_request_closed',
            rootSessionId,
            childSessionId,
          })
        })
        return
      }
      let bodyText = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        bodyText += chunk
      })
      req.on('end', () => {
        const input = parseJsonText(bodyText) || {}
        const now = Date.now()
        const sessionId = `ses_http_${now}_${process.pid}`
        const directory = typeof input.directory === 'string' && input.directory.length > 0
          ? input.directory
          : serverProjectDirectory()
        const title = typeof input.title === 'string' && input.title.length > 0
          ? input.title
          : `Freshopencode ${sessionId}`
        const db = openDatabase()
        try {
          ensureSchema(db)
          insertSession(db, {
            sessionId,
            projectId: 'proj-http',
            parentId: typeof input.parentID === 'string' ? input.parentID : null,
            slug: sessionId,
            directory,
            title,
            createdAt: now,
            updatedAt: now,
          })
        } finally {
          db.close()
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: sessionId, directory, title }))
      })
      return
    }
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
