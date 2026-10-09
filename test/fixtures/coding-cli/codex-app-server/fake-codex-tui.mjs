#!/usr/bin/env node
// Realistic Codex TUI fake: `codex --remote <ws url> [-c ...] [resume <id>]`.
//
// Mirrors the Codex 0.162 TUI facts the pane-lifecycle work depends on:
// - a --remote URL with a path is refused at startup (exit 1);
// - a lost app-server connection never ends the TUI: it reconnects (0, 1, 2, 4 s,
//   then every 8 s) and re-resumes its thread, and after the reconnect deadline it
//   gives up but keeps running until the user quits;
// - every user turn first starts a short ephemeral title thread, unsubscribed once
//   its turn completes;
// - BEL rings only for a turn that completed.
//
// Output lines (each ends with \r\n): FAKE_TUI_READY thread=<id>,
// FAKE_TUI_TURN_COMPLETED status=<status>, FAKE_TUI_RECONNECTING,
// FAKE_TUI_ERROR <message>, plus Codex's own conflict / no-session / give-up text.
// Input lines (CR or LF): quit, crash, fork, resume <id>, turn <text>.
import WebSocket from 'ws'

const CONFLICT_LINE = 'This conversation is open in another app. Close it there and press R to continue here.'
const RETRY_DELAYS_MS = [0, 1000, 2000, 4000]
const STEADY_RETRY_MS = 8000
const reconnectDeadlineMs = Number(process.env.FAKE_TUI_RECONNECT_DEADLINE_MS ?? 120000)

function say(line) {
  process.stdout.write(`${line}\r\n`)
}

function exitAfterOutput(code, line) {
  if (line === undefined) process.exit(code)
  process.stdout.write(`${line}\r\n`, () => process.exit(code))
}

function parseArgs(argv) {
  const parsed = { remote: null, resume: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--remote') parsed.remote = argv[++i] ?? null
    else if (arg === '-c') i += 1 // config overrides are accepted and ignored
    else if (arg === 'resume') parsed.resume = argv[++i] ?? null
  }
  return parsed
}

function isValidRemote(raw) {
  try {
    const url = new URL(raw)
    return (url.protocol === 'ws:' || url.protocol === 'wss:')
      && (url.pathname === '' || url.pathname === '/')
      && url.search === ''
      && url.hash === ''
  } catch {
    return false
  }
}

const args = parseArgs(process.argv.slice(2))
if (!args.remote || !isValidRemote(args.remote)) {
  exitAfterOutput(1, `Error: invalid remote address '${args.remote ?? ''}'; expected 'ws://host:port', 'wss://host:port', 'unix://', or 'unix://PATH'`)
} else {
  runTui(args.remote, args.resume)
}

function runTui(remote, startupResume) {
  let socket = null // the open connection, if any
  let everOpened = false
  let displayedThread = startupResume
  const titleThreads = new Set()
  const pending = new Map() // request id -> { resolve, reject }
  let nextRequestId = 1
  let reconnect = null // { attempt, retryTimer, deadlineTimer, attemptSocket, gaveUp }

  // The TUI keeps running until `quit` even with no connection and no input.
  setInterval(() => undefined, 2 ** 30)

  function errorMessage(error) {
    return typeof error?.message === 'string' ? error.message : String(error)
  }

  function request(method, params) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('disconnected'))
    const id = nextRequestId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  function notify(method, params) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method, params }))
  }

  function onMessage(raw) {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (message.method === undefined) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(message.error)
      else waiter.resolve(message.result)
      return
    }
    if (message.id !== undefined) return // server requests (approvals) are not modeled
    if (message.method === 'turn/completed') {
      const threadId = message.params?.threadId
      const status = message.params?.turn?.status
      if (titleThreads.delete(threadId)) {
        request('thread/unsubscribe', { threadId }).catch(() => undefined)
        return
      }
      if (threadId === displayedThread) {
        // One write, so the BEL always follows its line.
        process.stdout.write(`FAKE_TUI_TURN_COMPLETED status=${status}\r\n${status === 'completed' ? '\x07' : ''}`)
      }
    }
  }

  async function openSequence() {
    try {
      await request('initialize', {
        clientInfo: { name: 'fake-codex-tui', version: '1' },
        capabilities: { experimentalApi: true },
      })
      notify('initialized')
      const cwd = process.cwd()
      const result = displayedThread
        ? await request('thread/resume', { threadId: displayedThread, cwd })
        : await request('thread/start', { cwd })
      displayedThread = result?.thread?.id ?? displayedThread
      say(`FAKE_TUI_READY thread=${displayedThread}`)
    } catch (error) {
      const message = errorMessage(error)
      if (message.includes('active writer')) say(CONFLICT_LINE)
      else if (message.includes('no rollout found')) exitAfterOutput(1, `No saved session found with ID ${displayedThread}`)
      else say(`FAKE_TUI_ERROR ${message}`)
    }
  }

  function connect() {
    const ws = new WebSocket(remote)
    let opened = false
    if (reconnect) reconnect.attemptSocket = ws
    ws.on('open', () => {
      opened = true
      everOpened = true
      socket = ws
      if (reconnect) {
        clearTimeout(reconnect.deadlineTimer)
        reconnect = null
      }
      void openSequence()
    })
    ws.on('message', onMessage)
    ws.on('error', () => undefined) // 'close' follows
    ws.on('close', () => {
      if (socket === ws) socket = null
      for (const waiter of pending.values()) waiter.reject(new Error('disconnected'))
      pending.clear()
      if (opened) {
        startReconnecting()
      } else if (!everOpened) {
        exitAfterOutput(1, `FAKE_TUI_ERROR could not connect to ${remote}`)
      } else {
        scheduleRetry()
      }
    })
  }

  function startReconnecting() {
    say('FAKE_TUI_RECONNECTING')
    reconnect = { attempt: 0, retryTimer: null, attemptSocket: null, gaveUp: false, deadlineTimer: null }
    reconnect.deadlineTimer = setTimeout(giveUp, reconnectDeadlineMs)
    scheduleRetry()
  }

  function scheduleRetry() {
    if (!reconnect || reconnect.gaveUp) return
    const delay = RETRY_DELAYS_MS[reconnect.attempt] ?? STEADY_RETRY_MS
    reconnect.attempt += 1
    reconnect.retryTimer = setTimeout(connect, delay)
  }

  function giveUp() {
    if (!reconnect) return
    reconnect.gaveUp = true
    clearTimeout(reconnect.retryTimer)
    reconnect.attemptSocket?.terminate()
    say('Server connection could not be restored')
  }

  async function startTurn(text) {
    const cwd = process.cwd()
    try {
      // Per-turn title generation on a short-lived ephemeral thread.
      const title = await request('thread/start', { ephemeral: true, cwd })
      const titleId = title?.thread?.id
      if (titleId) {
        titleThreads.add(titleId)
        await request('turn/start', { threadId: titleId, input: [{ type: 'text', text: 'title' }] })
      }
    } catch {
      // Title generation is best effort, as in Codex.
    }
    try {
      await request('turn/start', { threadId: displayedThread, input: [{ type: 'text', text }] })
    } catch (error) {
      say(`FAKE_TUI_ERROR ${errorMessage(error)}`)
    }
  }

  async function switchThread(method, params) {
    try {
      const result = await request(method, params)
      displayedThread = result?.thread?.id ?? params.threadId
      say(`FAKE_TUI_READY thread=${displayedThread}`)
    } catch (error) {
      const message = errorMessage(error)
      say(message.includes('active writer') ? CONFLICT_LINE : `FAKE_TUI_ERROR ${message}`)
    }
  }

  function handleInput(line) {
    if (line === 'quit') process.exit(0) // also mid-turn: Codex's "run in background"
    if (line === 'crash') process.exit(1)
    if (!socket) {
      say('FAKE_TUI_ERROR disconnected')
      return
    }
    if (line === 'fork') {
      void switchThread('thread/fork', { threadId: displayedThread })
    } else if (line.startsWith('resume ')) {
      const threadId = line.slice('resume '.length).trim()
      void switchThread('thread/resume', { threadId, cwd: process.cwd() })
    } else if (line.startsWith('turn ')) {
      void startTurn(line.slice('turn '.length))
    }
  }

  let inputBuffer = ''
  process.stdin.on('data', (chunk) => {
    inputBuffer += chunk.toString()
    const lines = inputBuffer.split(/[\r\n]/)
    inputBuffer = lines.pop()
    for (const raw of lines) {
      const line = raw.trim()
      if (line) handleInput(line)
    }
  })

  connect()
}
