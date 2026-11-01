#!/usr/bin/env node
// HARNESS-03 deterministic fake `codex` APP-SERVER (the freshcodex sidecar),
// launched as `fake-codex-app-server.mjs --listen ws://host:port`.
//
// Wire surface mirrors test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs
// (itself mirroring the real codex app-server + the consumers in
// crates/freshell-freshagent/src/codex.rs):
//   - every RPC before `initialize` is rejected ("initialize must complete
//     before other RPC methods");
//   - `initialize` -> { userAgent, codexHome, platformFamily, platformOs };
//   - `thread/start` -> { thread: { id, path, ephemeral }, cwd, model,
//     approvalPolicy: 'never', ... } AND writes the durable rollout file
//     (<CODEX_HOME>/sessions/yyyy/mm/dd/rollout-<ts>-<id>.jsonl) whose FIRST
//     line is the session_meta record (payload.id is the identity);
//   - `thread/resume` keeps params.threadId (durable identity);
//   - `turn/start` -> { turn } result, then notifications: turn/started
//     (activity) ... turn/completed with turn.status 'completed' (completion).
//
// Approval/question: freshcodex advertises approvals:false/questions:false
// (codex.rs) — the real bridge has no approval surface to mirror — so the
// controllable events render as fixture-namespaced notifications
// `freshell.fixture/approval` / `freshell.fixture/question` (params = data).
//
// Unified agent names (Task 8) — the metadata events the naming lanes need:
//   - `thread/name/set` persists the thread's name in-process and answers
//     `{}` + a `thread/name/updated` notification (the real app-server's
//     own observation event); `thread/read` answers the stored name. With
//     FAKE_CODEX_HOLD_NAME_SET_FILE=<path> set, a name/set whose hold file
//     exists does NOT answer until the file disappears (the in-flight
//     native write the restart case needs).
//   - `turn/start` appends the prompt's user records (`response_item` user
//     `input_text` + `event_msg` `user_message`) to the thread's rollout —
//     the durable metadata the server's rollout parser reads for the
//     first-message fallback and generation arming.
//   - With FAKE_CODEX_DEFER_ROLLOUT=1, `thread/start` returns its
//     id/path WITHOUT writing the rollout (the REAL app-server's
//     prospective-start semantics — F08: the fresh thread's returned path
//     does not yet exist); the first `turn/start` materializes it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { appendLaunchLedger, FixtureEngine, keepAlive, loadProgram } from './fixture-core.mjs'

const provider = process.env.FRESHELL_FAKE_PROVIDER ?? 'codex-app-server'
const argv = process.argv.slice(2)
const env = process.env

function argValue(name) {
  const index = argv.indexOf(name)
  if (index === -1 || index === argv.length - 1) return undefined
  return argv[index + 1]
}

const listenRaw = argValue('--listen')
if (!listenRaw) {
  console.error('fake-codex-app-server: --listen ws://host:port is required')
  process.exit(64)
}
const listenUrl = new URL(listenRaw)
const host = listenUrl.hostname
const port = Number(listenUrl.port)

appendLaunchLedger({ provider, argv, env })
const program = loadProgram(env)

const sockets = new Set()
let activeThreadId = null
let activeTurnId = null

function broadcast(obj) {
  const frame = JSON.stringify(obj)
  for (const socket of sockets) {
    try {
      socket.send(frame)
    } catch {
      // sinking socket; the test will see the close
    }
  }
}

function render(event) {
  const { kind, data } = event
  const threadId = data.threadId ?? activeThreadId
  const turnId = data.turnId ?? activeTurnId
  switch (kind) {
    case 'activity':
      broadcast({
        method: 'turn/started',
        params: { threadId, turn: { id: turnId, status: 'inProgress' } },
      })
      break
    case 'approval':
      broadcast({ method: 'freshell.fixture/approval', params: { ...data, threadId } })
      break
    case 'question':
      broadcast({ method: 'freshell.fixture/question', params: { ...data, threadId } })
      break
    case 'completion':
      broadcast({
        method: 'turn/completed',
        params: {
          threadId,
          turn: { id: turnId, status: data.subtype === 'interrupted' ? 'interrupted' : 'completed' },
        },
      })
      break
    case 'marker':
      broadcast({ method: 'freshell.fixture/marker', params: { ...data, threadId } })
      break
    default:
      // session/resume/crash carry their meaning in results + the ledger.
      break
  }
}

const engine = new FixtureEngine({ provider, program, env, write: render })

function codexHome() {
  return env.CODEX_HOME && env.CODEX_HOME.length > 0
    ? env.CODEX_HOME
    : path.join(os.homedir(), '.codex')
}

/** Write the durable rollout file (session_meta first line) and return its path. */
function writeRollout(threadId) {
  const now = new Date()
  const dir = path.join(
    codexHome(),
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  )
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${threadId}.jsonl`)
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      timestamp: now.toISOString(),
      type: 'session_meta',
      payload: { id: threadId, cwd: process.cwd() },
    })}\n`,
  )
  return file
}

/**
 * Locate the thread's EXISTING rollout anywhere under the
 * <CODEX_HOME>/sessions year/month/day tree (rollout-<ts>-<threadId>.jsonl).
 * A REAL app-server process resumed by id reads the durable thread FROM DISK
 * and continues THAT file — a restarted app-server never mints a second
 * rollout for the same id (two would collide in freshell's identity
 * quarantine, hiding the session from the directory).
 */
function findRollout(threadId) {
  const sessionsRoot = path.join(codexHome(), 'sessions')
  if (!fs.existsSync(sessionsRoot)) return null
  const years = fs.readdirSync(sessionsRoot).sort().reverse()
  for (const year of years) {
    const yearDir = path.join(sessionsRoot, year)
    if (!fs.statSync(yearDir).isDirectory()) continue
    for (const month of fs.readdirSync(yearDir).sort().reverse()) {
      const monthDir = path.join(yearDir, month)
      if (!fs.statSync(monthDir).isDirectory()) continue
      for (const day of fs.readdirSync(monthDir).sort().reverse()) {
        const dayDir = path.join(monthDir, day)
        if (!fs.statSync(dayDir).isDirectory()) continue
        const match = fs.readdirSync(dayDir)
          .find((name) => name.endsWith(`-${threadId}.jsonl`))
        if (match) return path.join(dayDir, match)
      }
    }
  }
  return null
}

/** Unified agent names (Task 8): append the prompt's user records — the
 * metadata pair the server's rollout parser reads for the first-message
 * fallback and generation arming. */
function appendUserRecords(rolloutPath, text) {
  const prompt = (Array.isArray(text)
    ? text.map(part => (part && typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n')
    : String(text ?? '')).trim()
  if (!rolloutPath || prompt.length === 0) return
  const now = new Date().toISOString()
  const lines = [
    JSON.stringify({
      timestamp: now,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
    }),
    JSON.stringify({
      timestamp: now,
      type: 'event_msg',
      payload: { type: 'user_message', message: prompt, kind: 'plain' },
    }),
  ]
  fs.appendFileSync(rolloutPath, `${lines.join('\n')}\n`)
}

// Unified agent names (Task 8): the in-process thread-name store (the
// metadata `thread/read` answers) keyed by thread id.
const threadNames = new Map()
// threadId -> the rollout path this fixture wrote (or deferred).
const threadRollouts = new Map()
const deferRollout = env.FAKE_CODEX_DEFER_ROLLOUT === '1'
const nameSetHoldFile = env.FAKE_CODEX_HOLD_NAME_SET_FILE

/** The rollout path `thread/start` WOULD write (deferred mode returns it
 * without creating it — the real app-server's prospective path). */
function deferredRolloutPath(threadId) {
  const now = new Date()
  const dir = path.join(
    codexHome(),
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  )
  return path.join(dir, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${threadId}.jsonl`)
}

function threadResult(threadId, rolloutPath) {
  return {
    thread: { id: threadId, path: rolloutPath, ephemeral: false },
    cwd: process.cwd(),
    model: 'fixture-model',
    modelProvider: 'fixture',
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'danger-full-access',
  }
}

const wss = new WebSocketServer({ host, port })

wss.on('listening', () => {
  // Readiness line the launcher greps for.
  process.stdout.write(`fake codex app-server listening on ws://${host}:${port}\n`)
})

wss.on('connection', (socket) => {
  sockets.add(socket)
  let initialized = false
  socket.on('close', () => sockets.delete(socket))
  socket.on('message', (raw) => {
    void handleMessage(socket, raw).catch(() => {})
  })

  async function handleMessage(socket, raw) {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (message.id === undefined) return // client notifications (e.g. initialized)
    const respond = (result) => socket.send(JSON.stringify({ id: message.id, result }))
    const respondError = (msg) =>
      socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: msg } }))

    if (!initialized && message.method !== 'initialize') {
      respondError('initialize must complete before other RPC methods')
      return
    }

    switch (message.method) {
      case 'initialize': {
        initialized = true
        respond({
          userAgent: 'freshell-fake-codex/1.0.0',
          codexHome: codexHome(),
          platformFamily: 'unix',
          platformOs: process.platform,
        })
        break
      }
      case 'thread/start': {
        const emitted = await engine.handleRpc('thread/start', message.params)
        if (emitted.has('crash')) return
        const threadId = program.sessionId ?? `thread-${randomUUID()}`
        activeThreadId = threadId
        // Unified agent names (Task 8): by default this fixture writes the
        // rollout eagerly (its historical contract); FAKE_CODEX_DEFER_ROLLOUT=1
        // restores the REAL app-server's prospective-start semantics — the
        // returned path does not exist until the first turn materializes it.
        const rolloutPath = deferRollout
          ? deferredRolloutPath(threadId)
          : writeRollout(threadId)
        threadRollouts.set(threadId, rolloutPath)
        if (!emitted.has('session')) {
          await engine.emitEvent('session', { id: threadId }, 'rpc:thread/start:default')
        }
        respond(threadResult(threadId, rolloutPath))
        break
      }
      case 'thread/resume': {
        const emitted = await engine.handleRpc('thread/resume', message.params)
        if (emitted.has('crash')) return
        const threadId = message.params?.threadId ?? `thread-${randomUUID()}`
        activeThreadId = threadId
        // A resumed thread CONTINUES its existing rollout (the real
        // app-server reads the durable thread from disk); only a thread
        // with no rollout on disk gets a fresh file.
        const rolloutPath = findRollout(threadId) ?? writeRollout(threadId)
        threadRollouts.set(threadId, rolloutPath)
        await engine.emitResume(threadId, 'rpc:thread/resume')
        respond(threadResult(threadId, rolloutPath))
        break
      }
      case 'thread/read': {
        respond({
          thread: {
            id: message.params?.threadId ?? activeThreadId,
            ephemeral: false,
            ...(threadNames.get(message.params?.threadId ?? activeThreadId) !== undefined
              ? { name: threadNames.get(message.params?.threadId ?? activeThreadId) }
              : {}),
          },
        })
        break
      }
      case 'thread/turns/list': {
        const threadId = message.params?.threadId ?? activeThreadId
        const rolloutPath = threadRollouts.get(threadId)
        // A prospective thread has no native history until its first real
        // turn materializes the deferred rollout. Snapshot startup must see
        // an actual empty page, never the unknown-method {} response.
        if (rolloutPath && !fs.existsSync(rolloutPath)) {
          respond({ data: [], nextCursor: null })
        } else {
          // This fixture exercises naming, not committed-history paging.
          // Do not silently present a materialized conversation as empty.
          respondError('turn history paging is unavailable for a materialized fixture rollout')
        }
        break
      }
      case 'thread/name/set': {
        // Unified agent names (Task 8): the real metadata surface — set the
        // thread's name, observe it back on thread/read, and emit the
        // app-server's own thread/name/updated observation event. The hold
        // gate models an in-flight native write (the restart case).
        const threadId = message.params?.threadId ?? activeThreadId
        const name = String(message.params?.name ?? '')
        const applyAndAnswer = () => {
          threadNames.set(threadId, name)
          respond({})
          broadcast({
            method: 'thread/name/updated',
            params: { threadId, threadName: name },
          })
        }
        if (nameSetHoldFile && fs.existsSync(nameSetHoldFile)) {
          const poll = setInterval(() => {
            if (!fs.existsSync(nameSetHoldFile)) {
              clearInterval(poll)
              applyAndAnswer()
            }
          }, 25)
          poll.unref?.()
          return
        }
        applyAndAnswer()
        break
      }
      case 'turn/start': {
        // Result first (the real server acks the RPC, turn lifecycle then
        // arrives as notifications), then the controllable turn flow.
        activeThreadId = message.params?.threadId ?? activeThreadId
        activeTurnId = `turn-${randomUUID()}`
        respond({ turn: { id: activeTurnId, status: 'inProgress' } })
        // Unified agent names (Task 8): the prompt's user records land in the
        // rollout (the naming metadata), materializing a deferred rollout.
        const rolloutPath = threadRollouts.get(activeThreadId)
        if (rolloutPath && !fs.existsSync(rolloutPath)) {
          const now = new Date()
          const dir = path.dirname(rolloutPath)
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(rolloutPath, `${JSON.stringify({
            timestamp: now.toISOString(),
            type: 'session_meta',
            payload: { id: activeThreadId, cwd: process.cwd() },
          })}\n`)
        }
        appendUserRecords(rolloutPath, message.params?.input ?? message.params?.prompt ?? '')
        // Turn-open bookkeeping is unconditional (the real server always
        // broadcasts turn/started); a matching rule then owns the middle.
        await engine.emitEvent('activity', { state: 'busy' }, 'rpc:turn/start:open')
        const emitted = await engine.handleRpc('turn/start', message.params)
        if (emitted.has('crash')) return
        if (!emitted.has('completion')) {
          await engine.emitEvent('completion', { subtype: 'success' }, 'rpc:turn/start:default')
        }
        break
      }
      default:
        respond({})
    }
  }
})

keepAlive()
