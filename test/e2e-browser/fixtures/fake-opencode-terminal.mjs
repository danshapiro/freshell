#!/usr/bin/env node
// Fake `opencode` CLI for the opencode TERMINAL-pane restore-across-restart
// e2e (`docs/plans/2026-07-18-opencode-terminal-restore-spec.md` §7, test 21).
// Mirrors ONLY the restore-relevant behavior of the real CLI:
//
//   - FRESH launch (no `--session`, only the always-present `--hostname`/
//     `--port` terminal-mode flags): stays interactive and, on the FIRST
//     line of stdin it receives (the pane's first Enter/submit), writes a
//     real root `session` row into `<data_home>/opencode.db` -- the SAME
//     schema `crates/freshell-sessions/src/opencode_locator.rs`'s own unit
//     tests seed (id/project_id/parent_id/directory/title/version/
//     time_created/time_updated/time_archived). This exercises the
//     Enter-anchored correlation window (spec §4.4); the spawn-anchored
//     window (row written before any Enter) is separately and
//     deterministically proven by the Rust locator's own unit tests
//     (`row_created_at_spawn_before_any_enter_resolves_via_spawn_window`),
//     which control row-vs-arm timing precisely -- something an e2e driving
//     a real browser + WS round trip cannot pin to the millisecond.
//   - RESUME launch (`--session <id>`): never creates a new session row;
//     prints a deterministic, greppable marker naming which id it resumed,
//     and mirrors argv to `FAKE_OPENCODE_TERMINAL_ARGV_LOG` if set (same
//     pattern as `FAKE_AMPLIFIER_ARGV_LOG` in `fake-amplifier-cli.mjs`) so
//     the scenario has two independent, non-DOM ways to prove the resume
//     argv.
//
// Both modes stay alive (`stdin.resume()`) so the pane's terminal status
// remains 'running', matching a real interactive TUI rather than a one-shot
// process the exit-surfacing path would treat as exited.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)

function appendArgvLog() {
  const logPath = process.env.FAKE_OPENCODE_TERMINAL_ARGV_LOG
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, t: Date.now(), argv })}\n`)
}
appendArgvLog()

function argValue(name) {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  return argv[index + 1]
}

function opencodeDataHome() {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'opencode')
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || '.'
  return path.join(home, '.local', 'share', 'opencode')
}

// The schema mirrors fake-opencode.cjs's EXACT rich shape (the real
// opencode's layout): a spec may pre-create an empty schema'd db in the
// isolated home (the realistic machine where opencode ran before
// freshell), and the listing/first-message queries the server's naming
// lanes run must find the same columns in either fixture's db.
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
    CREATE TABLE IF NOT EXISTS message_seq (
      session_id text PRIMARY KEY,
      next integer NOT NULL
    );
  `)
}

// Unified agent names (Task 8): the first prompt's durable user message —
// the `message`/`part` rows the server's targeted first-message lookup
// parses (opencode's naming lane: the session row identifies, the message
// rows arm). Mirrors the shape the real CLI projects.
function writeFirstUserMessage(sessionId, prompt) {
  const dataHome = opencodeDataHome()
  fs.mkdirSync(dataHome, { recursive: true })
  const db = new DatabaseSync(path.join(dataHome, 'opencode.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    ensureSchema(db)
    const now = Date.now()
    const messageId = `msg_e2e_${now}_${process.pid}`
    db.prepare(
      'INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    ).run(messageId, sessionId, now, now, JSON.stringify({ role: 'user' }))
    db.prepare(
      'INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(`part_${messageId}`, messageId, sessionId, now, now, JSON.stringify({ type: 'text', text: prompt }))
  } finally {
    db.close()
  }
}

// With a title sequence the row starts with the placeholder title real
// opencode writes until it names the session (`New session - <ISO>`);
// FAKE_OPENCODE_UNNAMED=1 keeps that placeholder for good (a session
// opencode never names, e.g. its own title call failed: name-reliability
// Task 5's first-message journey); otherwise the historical fixture title
// (the session id) is kept.
function initialSessionTitle(sessionId) {
  const placeholder = titleSequence.length > 0 || process.env.FAKE_OPENCODE_UNNAMED === '1'
  return placeholder ? `New session - ${new Date().toISOString()}` : sessionId
}

function writeSessionRow(sessionId, cwd) {
  const dataHome = opencodeDataHome()
  fs.mkdirSync(dataHome, { recursive: true })
  const db = new DatabaseSync(path.join(dataHome, 'opencode.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    ensureSchema(db)
    const now = Date.now()
    db.prepare('INSERT OR REPLACE INTO project (id, worktree) VALUES (?, ?)').run(
      `proj-${sessionId}`,
      cwd,
    )
    db.prepare(
      `INSERT OR REPLACE INTO session
        (id, project_id, parent_id, slug, directory, title, version, model,
         time_created, time_updated, time_archived)
       VALUES (?, ?, NULL, ?, ?, ?, 'fake-opencode-terminal-e2e', ?, ?, ?, NULL)`,
    ).run(sessionId, `proj-${sessionId}`, sessionId, cwd, initialSessionTitle(sessionId), 'fake-model', now, now)
  } finally {
    db.close()
  }
}

// Name-reliability Task 4: FAKE_OPENCODE_TITLE_SEQUENCE (pipe-separated
// titles) turns on a minimal embedded `opencode serve` surface on the
// pane's `--hostname`/`--port` — exactly what the server's CLI opencode lane
// attaches to (`crates/freshell-ws/src/opencode_lane.rs`: `/global/health`
// with a 1.18 version, the `/event` SSE stream acked by `server.connected`,
// `/session/status`, `/permission`, `/question`). After the first prompt
// creates the session row, each title is written to the row and emitted as
// a `session.updated` event (`properties.info.{id,title}`), ~300 ms apart,
// starting FAKE_OPENCODE_TITLE_SEQUENCE_DELAY_MS (default 2500) after the
// prompt so the pane's naming binding exists. Like the real serve, the
// final title is re-reported on later session updates (every 2 s here).
// Off by default: every other spec keeps the plain terminal fake.
const titleSequence = (process.env.FAKE_OPENCODE_TITLE_SEQUENCE ?? '')
  .split('|')
  .map((title) => title.trim())
  .filter(Boolean)
const titleEventClients = new Set()

function broadcastTitleEvent(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const client of Array.from(titleEventClients)) {
    if (client.destroyed) {
      titleEventClients.delete(client)
      continue
    }
    client.write(frame)
  }
}

function setSessionTitle(sessionId, title) {
  const db = new DatabaseSync(path.join(opencodeDataHome(), 'opencode.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('UPDATE session SET title = ?, time_updated = ? WHERE id = ?').run(title, Date.now(), sessionId)
  } finally {
    db.close()
  }
}

function startTitleServer() {
  const hostname = argValue('--hostname') ?? '127.0.0.1'
  const port = Number(argValue('--port'))
  if (titleSequence.length === 0 || !Number.isFinite(port) || port <= 0) return
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${hostname}:${port}`)
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/global/health') return json(200, { healthy: true, version: '1.18.11' })
    if (url.pathname === '/session/status') return json(200, {})
    if (url.pathname === '/permission' || url.pathname === '/question') return json(200, [])
    if (url.pathname === '/event' || url.pathname === '/global/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      titleEventClients.add(res)
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
      req.on('close', () => titleEventClients.delete(res))
      return
    }
    return json(404, { error: `fake opencode terminal: no route ${url.pathname}` })
  })
  server.listen(port, hostname)
  server.unref?.()
}

function runTitleSequence(sessionId) {
  if (titleSequence.length === 0) return
  const delay = Number(process.env.FAKE_OPENCODE_TITLE_SEQUENCE_DELAY_MS ?? 2500)
  const emit = (title) => {
    setSessionTitle(sessionId, title)
    broadcastTitleEvent({ type: 'session.updated', properties: { sessionID: sessionId, info: { id: sessionId, title } } })
  }
  titleSequence.forEach((title, index) => {
    setTimeout(() => emit(title), delay + index * 300).unref?.()
  })
  const last = titleSequence[titleSequence.length - 1]
  setTimeout(() => {
    setInterval(() => emit(last), 2000).unref?.()
  }, delay + titleSequence.length * 300).unref?.()
}

startTitleServer()

const resumeSessionId = argValue('--session')

if (resumeSessionId) {
  process.stdout.write(`opencode: resumed session ${resumeSessionId}\r\n`)
  process.stdin.resume()
} else {
  process.stdout.write('opencode> \r\n')

  // Opt-in determinism gate for the restore-contract wall
  // (SIGKILL-inside-locator-window): when FAKE_OPENCODE_TERMINAL_ROW_GATE_PATH
  // is set, poll ~50ms for the gate file before writing the session row
  // (mirrors FAKE_OPENCODE_SESSION_EVENT_GATE_PATH in fake-opencode.cjs:636-652,
  // which gates SSE emission only and cannot gate this row write). The wall
  // test sets the env and never creates the file pre-kill, so the identity
  // deterministically never lands before the SIGKILL.
  const rowGatePath = process.env.FAKE_OPENCODE_TERMINAL_ROW_GATE_PATH

  function commitSessionRow(sessionId, cwd, firstPrompt) {
    writeSessionRow(sessionId, cwd)
    // Unified agent names (Task 8): the first prompt's user-message rows —
    // the metadata the naming lane's targeted first-message lookup reads.
    const prompt = String(firstPrompt ?? '').trim()
    if (prompt.length > 0) writeFirstUserMessage(sessionId, prompt)
    process.stdout.write(`opencode: session ${sessionId} started\r\n`)
    runTitleSequence(sessionId)
  }

  let sessionCreated = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    // Any input at all counts as "the first submit" for this fixture's
    // purposes -- the real locator arms only on Enter-shaped WS input, and
    // the pty's own cooked-mode line discipline already withholds bytes
    // from this process until the user presses Enter, so the first `data`
    // event this process ever sees IS that submit. The prompt text (minus
    // the Enter) is the durable first user message.
    if (sessionCreated) return
    sessionCreated = true

    const cwd = process.cwd()
    const sessionId = `ses_e2e_${Date.now()}_${process.pid}`
    const firstPrompt = String(chunk ?? '').replace(/[\r\n]+$/, '').trim()
    if (!rowGatePath) {
      commitSessionRow(sessionId, cwd, firstPrompt)
      return
    }
    const interval = setInterval(() => {
      if (!fs.existsSync(rowGatePath)) return
      clearInterval(interval)
      commitSessionRow(sessionId, cwd, firstPrompt)
    }, 50)
    interval.unref?.()
  })
  process.stdin.resume()
}
