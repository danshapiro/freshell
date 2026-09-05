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
      -- kata 1wxv delta-r1 F6: message ids must NEVER repeat within a session,
      -- even after a native revert-tail deletion (real opencode mints a fresh id
      -- per message; a countMessages+1 scheme re-mints a deleted id when a
      -- resend lands behind it, which collides frozen marker rows with the new
      -- epoch's rows in the rollback ledger). Persistent per-session counter.
      CREATE TABLE IF NOT EXISTS message_seq (
        session_id text PRIMARY KEY,
        next integer NOT NULL
      );
    `)
}

/** Mint the next message sequence for a session — persistent across revert-tail
 * deletions (unlike COUNT(*)+1). */
function nextMessageSequence(db, sessionId) {
  const row = db.prepare('SELECT next FROM message_seq WHERE session_id = ?').get(sessionId)
  if (!row) {
    db.prepare('INSERT INTO message_seq (session_id, next) VALUES (?, ?)').run(sessionId, 3)
    return 1
  }
  const next = Number(row.next)
  db.prepare('UPDATE message_seq SET next = ? WHERE session_id = ?').run(next + 2, sessionId)
  return next
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

function sessionRow(db, sessionId) {
  return db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId)
}

function sessionRowsForDirectory(db, directory) {
  const rows = db.prepare('SELECT * FROM session').all()
  const expected = normalizeDirectoryForComparison(directory)
  return rows.filter((row) => normalizeDirectoryForComparison(row.directory) === expected)
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
    const sequence = nextMessageSequence(db, input.sessionId)
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
    const userMessageId = `msg_${input.sessionId}_${sequence}_user`
    const assistantMessageId = `msg_${input.sessionId}_${sequence + 1}_assistant`
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

function readRequestBody(req) {
  return new Promise((resolve) => {
    let bodyText = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      bodyText += chunk
    })
    req.on('end', () => resolve(bodyText))
  })
}

function normalizeDirectoryForComparison(directory) {
  if (typeof directory !== 'string' || directory.length === 0) return ''
  try {
    return fs.realpathSync(directory)
  } catch {
    return path.resolve(directory)
  }
}

function routeDirectory(url) {
  const value = url.searchParams.get('directory')
  return typeof value === 'string' && value.length > 0 ? value : undefined
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
const requireDirectoryRoute = process.env.FAKE_OPENCODE_REQUIRE_DIRECTORY_ROUTE === '1'

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
const sessionStatuses = new Map()

function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function currentSessionStatus(sessionId) {
  return sessionStatuses.get(sessionId) || 'idle'
}

function broadcastServeEvent(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const client of Array.from(eventClients)) {
    if (client.destroyed) {
      eventClients.delete(client)
      continue
    }
    client.write(frame)
  }
}

function emitSessionStatus(sessionId, statusType, extra = {}) {
  sessionStatuses.set(sessionId, statusType)
  appendAudit({
    event: 'session_status_emitted',
    sessionId,
    status: statusType,
    ...extra,
  })
  broadcastServeEvent({
    type: 'session.status',
    properties: {
      sessionID: sessionId,
      status: { type: statusType },
    },
  })
}

function emitSessionIdle(sessionId, extra = {}) {
  sessionStatuses.set(sessionId, 'idle')
  appendAudit({
    event: 'session_idle_emitted',
    sessionId,
    ...extra,
  })
  broadcastServeEvent({
    type: 'session.idle',
    properties: {
      sessionID: sessionId,
    },
  })
}

function rejectRoute(res, input) {
  appendAudit({
    event: 'route_rejected',
    routeEvent: input.routeEvent,
    method: input.method,
    pathname: input.pathname,
    sessionId: input.sessionId,
    routeDirectory: input.routeDirectory,
    expectedDirectory: input.expectedDirectory,
    bodyDirectory: input.bodyDirectory,
    reason: input.reason,
  })
  sendJson(res, input.statusCode ?? 409, {
    error: input.reason,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  })
  return false
}

function validateRouteForSession(res, input) {
  if (!requireDirectoryRoute) return true
  if (!input.routeDirectory) {
    return rejectRoute(res, {
      ...input,
      reason: 'missing_directory_route',
      statusCode: 400,
    })
  }
  if (!input.expectedDirectory) return true
  if (normalizeDirectoryForComparison(input.routeDirectory) !== normalizeDirectoryForComparison(input.expectedDirectory)) {
    return rejectRoute(res, {
      ...input,
      reason: 'mismatched_directory_route',
      statusCode: 409,
    })
  }
  return true
}

function messagesForSession(db, sessionId, input = {}) {
  let rows = db.prepare(`
    SELECT id, session_id, time_created, time_updated, data
    FROM message
    WHERE session_id = ?
    ORDER BY time_created DESC, id DESC
  `).all(sessionId)
  if (input.before) {
    const beforeIndex = rows.findIndex((row) => row.id === input.before)
    if (beforeIndex >= 0) rows = rows.slice(beforeIndex + 1)
  }
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : rows.length
  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit ? page[page.length - 1]?.id : undefined
  return {
    messages: page.reverse().map((message) => {
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
    }),
    nextCursor,
  }
}

function readSessionInfo(session) {
  return {
    id: session.id,
    directory: session.directory,
    title: session.title,
    parentID: session.parent_id ?? undefined,
    model: parseJsonText(session.model),
    // kata 1wxv (VERIFIED wire shape, load-bearing correction item 2): the
    // rollback pointer is TOP-LEVEL `revert = {messageID, ...}` — NEVER
    // `info.revert` — and the key is omitted entirely when no rollback is
    // active.
    ...(session.revert ? { revert: parseJsonText(session.revert) } : {}),
    time: { created: session.time_created, updated: session.time_updated },
  }
}

// kata 1wxv (verified opencode 1.18.21 semantics, LBC-2): any later
// send/command natively DELETES the reverted tail rows (at-or-after the
// INCLUSIVE boundary) AND clears the revert pointer — a new submission
// supersedes the tail (decision 5's belt under freshell's destroyed bit).
function clearRevertAndDeleteTail(sessionId) {
  const db = openDatabase()
  try {
    ensureSchema(db)
    const session = sessionRow(db, sessionId)
    if (!session) return
    let pointer = null
    if (session.revert) {
      try {
        pointer = JSON.parse(session.revert)?.messageID ?? null
      } catch {
        pointer = null
      }
    }
    if (pointer) {
      const rows = db
        .prepare('SELECT id FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC')
        .all(sessionId)
      const cut = rows.findIndex((row) => row.id === pointer)
      if (cut !== -1) {
        const deletePart = db.prepare('DELETE FROM part WHERE session_id = ? AND message_id = ?')
        const deleteMessage = db.prepare('DELETE FROM message WHERE session_id = ? AND id = ?')
        for (const row of rows.slice(cut)) {
          deletePart.run(sessionId, row.id)
          deleteMessage.run(sessionId, row.id)
        }
      }
    }
    db.prepare('UPDATE session SET revert = NULL WHERE id = ?').run(sessionId)
  } finally {
    db.close()
  }
}

function appendPromptMessages(input) {
  const db = openDatabase()
  try {
    ensureSchema(db)
    const existing = sessionRow(db, input.sessionId)
    if (!existing) return undefined
    const sequence = nextMessageSequence(db, input.sessionId)
    const userTime = Date.now()
    const assistantTime = userTime + 1
    const promptText = input.parts
      .map((part) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n')
    const responseText = process.env.FAKE_OPENCODE_RESPONSE_TEXT || `Fake OpenCode response: ${promptText}`
    const userMessageId = `msg_${input.sessionId}_${sequence}_user`
    const assistantMessageId = `msg_${input.sessionId}_${sequence + 1}_assistant`
    insertTextMessage(db, {
      sessionId: input.sessionId,
      messageId: userMessageId,
      partId: `${userMessageId}_part_text`,
      role: 'user',
      text: promptText,
      now: userTime,
    })
    insertTextMessage(db, {
      sessionId: input.sessionId,
      messageId: assistantMessageId,
      partId: `${assistantMessageId}_part_text`,
      role: 'assistant',
      text: responseText,
      now: assistantTime,
    })
    db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(assistantTime, input.sessionId)
    return { promptText, responseText, userMessageId, assistantMessageId, assistantTime }
  } finally {
    db.close()
  }
}

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${hostname}:${port}`)
  if (url.pathname === '/global/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (url.pathname === '/session/status') {
    const directory = routeDirectory(url)
    if (requireDirectoryRoute && !directory) {
      rejectRoute(res, {
        routeEvent: 'status',
        method: req.method,
        pathname: url.pathname,
        routeDirectory: directory,
        reason: 'missing_directory_route',
        statusCode: 400,
      })
      return
    }
    const statuses = {}
    if (directory) {
      const db = openDatabase()
      try {
        ensureSchema(db)
        const rows = sessionRowsForDirectory(db, directory)
        if (requireDirectoryRoute && rows.length === 0) {
          rejectRoute(res, {
            routeEvent: 'status',
            method: req.method,
            pathname: url.pathname,
            routeDirectory: directory,
            reason: 'unknown_directory_route',
            statusCode: 409,
          })
          return
        }
        for (const row of rows) {
          statuses[row.id] = { type: currentSessionStatus(row.id) }
        }
      } finally {
        db.close()
      }
    } else {
      statuses[rootSessionId] = { type: currentSessionStatus(rootSessionId) }
      statuses[childSessionId] = { type: currentSessionStatus(childSessionId) }
    }
    appendAudit({
      event: 'status',
      rootSessionId,
      childSessionId,
      routeDirectory: directory,
      sessionIds: Object.keys(statuses),
    })
    sendJson(res, 200, statuses)
    return
  }

  if (url.pathname === '/event' || url.pathname === '/global/event') {
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

  const sessionRouteMatch = url.pathname.match(/^\/session\/([^/]+)(?:\/(.*))?$/)
  if (sessionRouteMatch) {
    const sessionId = decodeURIComponent(sessionRouteMatch[1])
    const action = sessionRouteMatch[2] ?? ''
    const directory = routeDirectory(url)
    const db = openDatabase()
    let session
    try {
      ensureSchema(db)
      session = sessionRow(db, sessionId)
    } finally {
      db.close()
    }
    if (!session) {
      sendJson(res, 404, { error: 'session not found', sessionId })
      return
    }
    const routeEvent = action === ''
      ? 'session_get'
      : action === 'prompt_async'
        ? 'prompt_async'
        : action === 'message'
          ? 'message_list'
          : action.startsWith('message/')
            ? 'message_get'
            : action
    if (!validateRouteForSession(res, {
      routeEvent,
      method: req.method,
      pathname: url.pathname,
      sessionId,
      routeDirectory: directory,
      expectedDirectory: session.directory,
    })) {
      return
    }

    if (action === '' && req.method === 'GET') {
      appendAudit({
        event: 'session_get',
        sessionId,
        routeDirectory: directory,
        directory: session.directory,
      })
      sendJson(res, 200, readSessionInfo(session))
      return
    }

    if (action === 'prompt_async' && req.method === 'POST') {
      const body = parseJsonText(await readRequestBody(req)) || {}
      const parts = Array.isArray(body.parts) ? body.parts : []
      emitSessionStatus(sessionId, 'busy', {
        routeDirectory: directory,
        directory: session.directory,
      })
      // kata 1wxv: a new submission supersedes the reverted tail — the pointer
      // clears and the tail rows are deleted BEFORE the turn simulation.
      clearRevertAndDeleteTail(sessionId)
      const appended = appendPromptMessages({ sessionId, parts })
      if (!appended) {
        emitSessionIdle(sessionId, {
          routeDirectory: directory,
          directory: session.directory,
          reason: 'append_failed',
        })
        sendJson(res, 404, { error: 'session not found', sessionId })
        return
      }
      // kata 1wxv Task 7 (patch-turn fixture): with FAKE_OPENCODE_PATCH_TURN=N,
      // the turn-N simulation writes/modifies <session.directory>/patch-target.txt,
      // so the rollback spec reverts a PATCH-CARRYING turn and proves the
      // working tree stays byte-identical (conversation-only rollback).
      const patchTurn = Number.parseInt(process.env.FAKE_OPENCODE_PATCH_TURN ?? '', 10)
      const userSeq = Number(/^msg_.+_(\d+)_user$/.exec(appended.userMessageId)?.[1])
      if (Number.isInteger(patchTurn) && patchTurn > 0 && (userSeq + 1) / 2 === patchTurn) {
        const patchPath = path.join(session.directory, 'patch-target.txt')
        fs.writeFileSync(patchPath, `fake patch from turn ${patchTurn} (${appended.userMessageId})\n`)
        appendAudit({ event: 'patch_turn_written', sessionId, path: patchPath, turn: patchTurn })
      }
      appendAudit({
        event: 'prompt_async',
        sessionId,
        routeDirectory: directory,
        directory: session.directory,
        prompt: appended.promptText,
        // Parsed prompt-body settings (V4/A5): on the wire (build_prompt_body,
        // crates/freshell-opencode/src/serve.rs) `model` is an OBJECT
        // `{providerID, modelID}` and effort is the string field `variant`.
        body: { model: body.model, variant: body.variant },
      })
      sendJson(res, 200, { ok: true })
      setTimeout(() => {
        emitSessionIdle(sessionId, {
          routeDirectory: directory,
          directory: session.directory,
          prompt: appended.promptText,
        })
      }, 25).unref?.()
      return
    }

    if (action === 'message' && req.method === 'GET') {
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw ? Number(limitRaw) : undefined
      const before = url.searchParams.get('before') || undefined
      const messageDb = openDatabase()
      try {
        ensureSchema(messageDb)
        const page = messagesForSession(messageDb, sessionId, { limit, before })
        appendAudit({
          event: 'message_list',
          sessionId,
          routeDirectory: directory,
          directory: session.directory,
          limit,
          before,
          count: page.messages.length,
        })
        const headers = page.nextCursor ? { 'x-next-cursor': page.nextCursor } : {}
        sendJson(res, 200, page.messages, headers)
      } finally {
        messageDb.close()
      }
      return
    }

    if (action.startsWith('message/') && req.method === 'GET') {
      const messageId = decodeURIComponent(action.slice('message/'.length))
      const messageDb = openDatabase()
      try {
        ensureSchema(messageDb)
        const page = messagesForSession(messageDb, sessionId)
        const message = page.messages.find((candidate) => candidate.info.id === messageId)
        appendAudit({
          event: 'message_get',
          sessionId,
          messageId,
          routeDirectory: directory,
          directory: session.directory,
          found: Boolean(message),
        })
        if (!message) {
          sendJson(res, 404, { error: 'message not found', sessionId, messageId })
          return
        }
        sendJson(res, 200, message)
      } finally {
        messageDb.close()
      }
      return
    }

    if (action === 'fork' && req.method === 'POST') {
      // AGENT-07 e2e: opencode's `POST /session/:id/fork` — {messageID?: ^msg…}
      // pins the fork point; the child shares the parent's directory and carries
      // ONLY the messages up to the pin (rollout is copy-on-write: the parent's
      // rows are never touched).
      const body = parseJsonText(await readRequestBody(req)) || {}
      const messageId = typeof body.messageID === 'string' ? body.messageID : undefined
      appendAudit({
        event: 'fork',
        sessionId,
        routeDirectory: directory,
        directory: session.directory,
        parentId: sessionId,
        body,
        bodyKeys: Object.keys(body).sort(),
      })
      const now = Date.now()
      const childSessionId = `ses_fork_${now}_${process.pid}`
      const forkDb = openDatabase()
      try {
        ensureSchema(forkDb)
        insertSession(forkDb, {
          sessionId: childSessionId,
          projectId: 'proj-fork',
          parentId: sessionId,
          slug: childSessionId,
          directory: session.directory,
          title: `Fork of ${session.title ?? sessionId}`,
          createdAt: now,
          updatedAt: now,
        })
        const source = messagesForSession(forkDb, sessionId).messages
        let kept = source
        if (messageId) {
          const pinIndex = source.findIndex((m) => m.info.id === messageId)
          if (pinIndex !== -1) kept = source.slice(0, pinIndex + 1)
        }
        let forkSeq = 0
        for (const copied of kept) {
          forkSeq += 1
          const role = copied.info?.role === 'assistant' ? 'assistant' : 'user'
          const text = (copied.parts ?? [])
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
          const childMessageId = `msg_${childSessionId}_${forkSeq}_${role}`
          insertTextMessage(forkDb, {
            sessionId: childSessionId,
            messageId: childMessageId,
            partId: `${childMessageId}_part_text`,
            role,
            text,
            now: now + forkSeq,
          })
        }
        forkDb.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(now + forkSeq + 1, childSessionId)
        // Focused ep3-r1 F3: the copy loop mints `msg_<child>_<1..forkSeq>_*`
        // ids WITHOUT touching the child's persistent `message_seq` row, so the
        // first prompt to the fork minted sequence 1/2 and `INSERT OR REPLACE`
        // OVERWROTE the copied first turn. Seed the child's counter past the
        // copied tail (`nextMessageSequence` returns `next` then stores
        // `next + 2`, so `forkSeq + 1` is the first free user sequence) — the
        // fixture's forked history then appends exactly like real OpenCode.
        if (forkSeq > 0) {
          forkDb
            .prepare('INSERT OR REPLACE INTO message_seq (session_id, next) VALUES (?, ?)')
            .run(childSessionId, forkSeq + 1)
        }
      } finally {
        forkDb.close()
      }
      sessionStatuses.set(childSessionId, 'idle')
      appendAudit({ event: 'forked', sessionId: childSessionId, parentId: sessionId, pinnedMessageId: messageId ?? null })
      sendJson(res, 200, { id: childSessionId, directory: session.directory })
      return
    }

    if (action === 'revert' && req.method === 'POST') {
      // kata 1wxv: opencode's POST /session/:id/revert {messageID} —
      // message-targeted. VERIFIED semantics (LBC-2): the boundary is
      // INCLUSIVE of the named message; an ASSISTANT target normalizes to its
      // parent USER message; an UNKNOWN id is a silent 200 no-op (the pointer
      // provably does not move — freshell's post-verify triad depends on it).
      // The message LIST keeps serving the reverted tail UNFLAGGED (freshell
      // computes the active prefix itself); only a later send/command deletes
      // the tail rows (clearRevertAndDeleteTail).
      const body = parseJsonText(await readRequestBody(req)) || {}
      const requestedId = typeof body.messageID === 'string' ? body.messageID : undefined
      const revertDb = openDatabase()
      try {
        ensureSchema(revertDb)
        let resolvedId = null
        if (requestedId) {
          const rows = revertDb
            .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC')
            .all(sessionId)
          const targetIdx = rows.findIndex((row) => row.id === requestedId)
          if (targetIdx !== -1) {
            let target = rows[targetIdx]
            if (parseJsonText(target.data)?.role === 'assistant') {
              for (let i = targetIdx - 1; i >= 0; i -= 1) {
                if (parseJsonText(rows[i].data)?.role === 'user') {
                  target = rows[i]
                  break
                }
              }
            }
            resolvedId = target.id
          }
        }
        if (resolvedId) {
          revertDb
            .prepare('UPDATE session SET revert = ? WHERE id = ?')
            .run(JSON.stringify({ messageID: resolvedId }), sessionId)
        }
        appendAudit({
          event: 'reverted',
          sessionId,
          messageID: requestedId ?? null,
          resolvedMessageID: resolvedId,
        })
        sendJson(res, 200, true)
      } finally {
        revertDb.close()
      }
      return
    }

    if (action === 'unrevert' && req.method === 'POST') {
      // kata 1wxv: POST /session/:id/unrevert — all-or-nothing restore: the
      // pointer clears; the tail rows stay listed (they never hid).
      const unrevertDb = openDatabase()
      try {
        ensureSchema(unrevertDb)
        unrevertDb.prepare('UPDATE session SET revert = NULL WHERE id = ?').run(sessionId)
        appendAudit({ event: 'unreverted', sessionId })
        sendJson(res, 200, true)
      } finally {
        unrevertDb.close()
      }
      return
    }

    if (action === 'summarize' && req.method === 'POST') {
      // AGENT-04 e2e: opencode's `POST /session/:id/summarize` {providerID,
      // modelID} — the compact RPC. Busy → response → idle, the same SSE
      // lifecycle the prompt arm has (the Rust handle_compact awaits the idle
      // edge, so the idle edge is mandatory realism, not decoration).
      // kata 1wxv: a summarize is a "command" in the verified decision-5
      // sense — it supersedes (deletes) the reverted tail and clears the
      // pointer, exactly like a send.
      clearRevertAndDeleteTail(sessionId)
      const body = parseJsonText(await readRequestBody(req)) || {}
      appendAudit({
        event: 'summarize',
        sessionId,
        routeDirectory: directory,
        directory: session.directory,
        body: { providerID: body.providerID, modelID: body.modelID },
        bodyKeys: Object.keys(body).sort(),
      })
      emitSessionStatus(sessionId, 'busy', {
        routeDirectory: directory,
        directory: session.directory,
      })
      sendJson(res, 200, true)
      setTimeout(() => {
        emitSessionIdle(sessionId, {
          routeDirectory: directory,
          directory: session.directory,
        })
      }, 25).unref?.()
      return
    }

    sendJson(res, 404, { error: 'not found' })
    return
  }

  if (url.pathname === '/config' && req.method === 'GET') {
    // The compact model-pair resolution falls back to GET /config when the
    // session has no splittable model recorded (serve.rs handle_compact).
    appendAudit({ event: 'config_get' })
    sendJson(res, 200, { model: 'opencode/fake-opencode' })
    return
  }

  if (url.pathname === '/session') {
    if (req.method === 'POST') {
      appendAudit({
        event: 'session_create_requested',
        rootSessionId,
        childSessionId,
        routeDirectory: routeDirectory(url),
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
      try {
        const input = parseJsonText(await readRequestBody(req)) || {}
        const now = Date.now()
        const sessionId = `ses_http_${now}_${process.pid}`
        const queryDirectory = routeDirectory(url)
        if (requireDirectoryRoute && !queryDirectory) {
          rejectRoute(res, {
            routeEvent: 'session_create',
            method: req.method,
            pathname: url.pathname,
            sessionId,
            routeDirectory: queryDirectory,
            reason: 'missing_directory_route',
            statusCode: 400,
          })
          return
        }
        if (
          requireDirectoryRoute
          && queryDirectory
          && typeof input.directory === 'string'
          && input.directory.length > 0
          && normalizeDirectoryForComparison(input.directory) !== normalizeDirectoryForComparison(queryDirectory)
        ) {
          rejectRoute(res, {
            routeEvent: 'session_create',
            method: req.method,
            pathname: url.pathname,
            sessionId,
            routeDirectory: queryDirectory,
            expectedDirectory: queryDirectory,
            bodyDirectory: input.directory,
            reason: 'mismatched_body_directory',
            statusCode: 409,
          })
          return
        }
        const directory = typeof queryDirectory === 'string' && queryDirectory.length > 0
          ? queryDirectory
          : typeof input.directory === 'string' && input.directory.length > 0
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
        appendAudit({
          event: 'session_created',
          sessionId,
          routeDirectory: queryDirectory,
          directory,
          title,
        })
        sessionStatuses.set(sessionId, 'idle')
        sendJson(res, 200, { id: sessionId, directory, title })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
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
