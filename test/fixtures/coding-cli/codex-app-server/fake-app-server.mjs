#!/usr/bin/env node

import { WebSocketServer } from 'ws'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (process.argv[2] === 'fake-native-child') {
  process.on('SIGTERM', () => {
    if (process.env.FAKE_CODEX_NATIVE_CHILD_IGNORE_SIGTERM === '1') {
      return
    }
    process.exit(0)
  })

  setInterval(() => undefined, 1_000)
  process.stdin.resume()
  await new Promise(() => undefined)
}

function parseListenUrl(argv) {
  const listenIndex = argv.indexOf('--listen')
  if (listenIndex === -1 || listenIndex === argv.length - 1) {
    throw new Error('Expected --listen <ws://host:port>')
  }
  return argv[listenIndex + 1]
}

function loadBehavior() {
  const raw = process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
  if (!raw) return {}
  return JSON.parse(raw)
}

function getCodexHome() {
  // Mirror the REAL codex CLI's resolution: CODEX_HOME env else ~/.codex.
  // The old '/tmp/fake-codex-home' fallback wrote durable artifacts OUTSIDE
  // the server's isolated HOME, so the Rust session-existence probe (which
  // scans <home>/.codex/sessions and now gates reconcile verdicts) reported
  // every fixture thread as artifact-missing -> dead_session, wiping the
  // pane's durable identity across restart.
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function hasExplicitCodexHome() {
  return typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME.trim().length > 0
}

function allowsDurableFixtureWrites() {
  return process.env.FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES === '1'
}

function rolloutFilename(threadId) {
  // Thread ids are data, never path segments. Percent encoding keeps the familiar
  // rollout-<id>.jsonl shape for ordinary Codex ids while escaping path separators
  // and filesystem metacharacters into one stable safe filename component.
  return `rollout-${encodeURIComponent(threadId)}.jsonl`
}

function getRolloutSessionDir() {
  const now = new Date()
  const year = String(now.getUTCFullYear())
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const day = String(now.getUTCDate()).padStart(2, '0')
  return path.join(getCodexHome(), 'sessions', year, month, day)
}

// ── AGENT-04/07 e2e (fresh-agent-control-rust): per-thread turn recording ────
// OPT-IN via behavior.recordTurns: when on, every turn/start RECORDS a turn
// (id `turn-<k>`, user+assistant items so the snapshot splits each turn into
// `turn-<k>:row-0`/`:row-1` display rows — the synthetic-id form Task 6's
// lastTurnId normalization strips), thread/read(includeTurns:true) returns the
// recorded list, and forks persist the checkpointed prefix. Records persist to
// <codexHome>/fake-turns/<threadId>.json so the CHILD sidecar process (a
// separate fake process) reads the same history the parent process recorded —
// fork durability is cross-process, like the rollout files themselves.
// Default OFF: every legacy consumer (static makeTurn world) is untouched.
const recordedTurnsByThread = new Map()

function recordedTurnsPath(threadId) {
  return path.join(getCodexHome(), 'fake-turns', `${threadId}.json`)
}

function loadRecordedTurns(threadId) {
  if (!threadId) return []
  if (recordedTurnsByThread.has(threadId)) return recordedTurnsByThread.get(threadId)
  let turns = []
  try {
    const parsed = JSON.parse(fs.readFileSync(recordedTurnsPath(threadId), 'utf8'))
    if (Array.isArray(parsed)) turns = parsed
  } catch {
    // no persisted record yet — empty history
  }
  recordedTurnsByThread.set(threadId, turns)
  return turns
}

function persistRecordedTurns(threadId, turns) {
  const file = recordedTurnsPath(threadId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(turns))
}

function makeRecordedTurn(turnId, promptText) {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    id: turnId,
    status: 'completed',
    itemsView: 'full',
    items: [
      { type: 'userMessage', id: `${turnId}:user`, content: [{ type: 'text', text: promptText ?? '' }] },
      { type: 'agentMessage', id: `${turnId}:item-0`, text: 'Fixture turn' },
    ],
    error: null,
    startedAt: nowSec,
    completedAt: nowSec + 1,
    durationMs: 1000,
  }
}

function getThreadHandle(threadId) {
  return {
    id: threadId,
    path: path.join(getRolloutSessionDir(), rolloutFilename(threadId)),
    ephemeral: false,
  }
}

function ensureDurableArtifact(threadId) {
  const thread = getThreadHandle(threadId)
  const codexHome = getCodexHome()
  const now = new Date()
  const sessionDir = path.dirname(thread.path)
  fs.mkdirSync(sessionDir, { recursive: true })
  // session_meta first line, the shape the real codex rollout writer produces
  // and the Rust indexer parses (parse_codex_session_content requires an id +
  // cwd -- the R10b cwd-less exclusion gate skips files without one).
  fs.writeFileSync(thread.path, JSON.stringify({
    timestamp: now.toISOString(),
    type: 'session_meta',
    payload: { id: threadId, cwd: process.cwd(), createdAt: now.toISOString() },
  }) + '\n', 'utf8')
  return {
    codexHome,
    thread,
  }
}

function writeBytes(stream, totalBytes, chunkSize = 16 * 1024) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return Promise.resolve()
  }

  const chunk = Buffer.alloc(Math.max(1, Math.min(chunkSize, totalBytes)), 'x')
  let remaining = totalBytes

  return new Promise((resolve, reject) => {
    const writeNext = () => {
      while (remaining > 0) {
        const size = Math.min(chunk.length, remaining)
        const payload = size === chunk.length ? chunk : chunk.subarray(0, size)
        remaining -= size
        const canContinue = stream.write(payload)
        if (!canContinue) {
          stream.once('drain', writeNext)
          return
        }
      }
      resolve()
    }

    stream.once('error', reject)
    writeNext()
  })
}

function makeTurn(id = 'turn-1') {
  return {
    id,
    status: 'completed',
    itemsView: 'full',
    items: [{
      type: 'agentMessage',
      id: `${id}:item-0`,
      text: 'Fixture turn',
      phase: null,
      memoryCitation: null,
    }],
    error: null,
    startedAt: 1770000001,
    completedAt: 1770000002,
    durationMs: 1000,
  }
}

function projectTurnItemsView(turn, itemsView = 'summary') {
  if (itemsView === 'full') {
    return { ...turn, itemsView: 'full' }
  }
  if (itemsView === 'notLoaded') {
    return { ...turn, itemsView: 'notLoaded', items: [] }
  }
  return {
    ...turn,
    itemsView: 'summary',
    items: turn.items.map((item) => ({
      type: item.type,
      id: item.id,
      summary: item.summary ?? item.text ?? item.command ?? item.type,
    })),
  }
}

function makeThread(id, params = {}) {
  const handle = getThreadHandle(id)
  return {
    id,
    sessionId: id,
    preview: 'Fixture turn',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1770000000,
    updatedAt: 1770000007,
    status: { type: 'idle' },
    cwd: params.cwd ?? process.cwd(),
    cliVersion: 'codex-cli 0.129.0',
    source: 'appServer',
    turns: params.includeTurns ? [makeTurn()] : [],
    path: handle.path,
  }
}

function makeThreadTurnsPage(params = {}) {
  const configuredTurns = Array.isArray(behavior.threadTurns)
    ? behavior.threadTurns
    : [makeTurn()]
  const orderedTurns = params.sortDirection === 'asc'
    ? configuredTurns.slice()
    : configuredTurns.slice().reverse()
  const offset = typeof params.cursor === 'string' && /^\d+$/.test(params.cursor)
    ? Number(params.cursor)
    : 0
  const limit = Number.isInteger(params.limit) && params.limit > 0
    ? params.limit
    : orderedTurns.length
  const turns = orderedTurns
    .slice(offset, offset + limit)
    .map((turn) => projectTurnItemsView(turn, params.itemsView))
  const nextOffset = offset + turns.length
  return {
    revision: 1770000007,
    data: turns,
    nextCursor: nextOffset < orderedTurns.length ? String(nextOffset) : null,
    backwardsCursor: null,
    bodies: Object.fromEntries(turns.map((turn) => [turn.id, turn])),
  }
}

function successResult(method, params) {
  if (method === 'initialize') {
    return {
      userAgent: 'freshell-fixture/1.0.0',
      codexHome: getCodexHome(),
      platformFamily: 'unix',
      platformOs: 'linux',
    }
  }
  if (method === 'thread/start') {
    const threadId = behavior.threadStartThreadId || 'thread-new-1'
    const rolloutPath = behavior.threadStartRolloutPath || behavior.rolloutPath
    const thread = makeThread(threadId, params)
    if (rolloutPath) thread.path = rolloutPath
    if (typeof behavior.threadStartEphemeral === 'boolean') {
      thread.ephemeral = behavior.threadStartEphemeral
    }
    return {
      thread,
      cwd: params?.cwd ?? process.cwd(),
      model: 'fixture-model',
      modelProvider: 'openai',
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: params?.sandbox ?? 'danger-full-access',
    }
  }
  if (method === 'thread/resume') {
    const threadId = behavior.threadResumeThreadId || params?.threadId || 'thread-new-1'
    const rolloutPath = behavior.threadResumeRolloutPath || behavior.rolloutPath
    const thread = makeThread(threadId, params)
    if (rolloutPath) thread.path = rolloutPath
    if (typeof behavior.threadResumeEphemeral === 'boolean') {
      thread.ephemeral = behavior.threadResumeEphemeral
    }
    return {
      thread,
      cwd: params?.cwd ?? process.cwd(),
      model: 'fixture-model',
      modelProvider: 'openai',
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: params?.sandbox ?? 'danger-full-access',
    }
  }
  if (method === 'turn/start') {
    if (behavior.recordTurns) {
      const threadId = params?.threadId || 'thread-new-1'
      const turns = loadRecordedTurns(threadId)
      const promptText = Array.isArray(params?.input)
        ? params.input.map((part) => (part && typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n')
        : ''
      const turn = makeRecordedTurn(`turn-${turns.length + 1}`, promptText)
      turns.push(turn)
      recordedTurnsByThread.set(threadId, turns)
      persistRecordedTurns(threadId, turns)
      return { turn }
    }
    return {
      turn: makeTurn('turn-1'),
    }
  }
  if (method === 'thread/fork') {
    // AGENT-07 arm: rollouts are copy-on-write — the child is minted with the
    // recorded prefix through `lastTurnId` (when recordTurns is on; otherwise
    // an empty history, matching the old static-fixture world's silence), the
    // parent's records are never touched, and the child gets a durable rollout
    // + persisted turns so the CHILD sidecar process can resume it.
    const parentThreadId = params?.threadId
    forkCounter += 1
    const childThreadId = `thread-fork-${process.pid}-${forkCounter}`
    const child = makeThread(childThreadId, params)
    ensureDurableArtifact(childThreadId)
    let childTurns = []
    if (behavior.recordTurns) {
      const parentTurns = loadRecordedTurns(parentThreadId)
      const pin = typeof params?.lastTurnId === 'string' ? params.lastTurnId : null
      const pinIndex = pin ? parentTurns.findIndex((turn) => turn.id === pin) : -1
      childTurns = pin ? parentTurns.slice(0, pinIndex + 1) : parentTurns.slice()
      persistRecordedTurns(childThreadId, childTurns)
      child.turns = childTurns
    }
    return {
      thread: child,
      cwd: params?.cwd ?? process.cwd(),
      model: params?.model ?? 'fixture-model',
      modelProvider: 'openai',
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: params?.sandbox ?? 'danger-full-access',
    }
  }
  if (method === 'thread/compact/start') {
    // AGENT-04 arm: the probed 0.147.0 response is an empty object; the whole
    // compact lifecycle then arrives as NOTIFICATIONS (emitCompactSequence,
    // called after this result is sent — mirrors the real server's ordering).
    return {}
  }
  if (method === 'thread/revert') {
    // kata 1wxv arm (codex 0.149.0 EXPERIMENTAL): thread/revert {threadId,
    // beforeTurnId} — IN-PLACE, same-thread-id destructive history rollback.
    // The recorded turns become the prefix STRICTLY BEFORE beforeTurnId (an
    // accidental-empty prefix is LEGAL: it empties the thread). An unknown
    // beforeTurnId (findIndex -1) leaves the history unchanged, mirroring the
    // fork arm's silent-leniency. Loose `{}` result (fork's parse discipline);
    // the `thread/reverted` notification broadcast rides the post-result seam
    // in the message handler.
    const threadId = params?.threadId
    if (behavior.recordTurns) {
      const turns = loadRecordedTurns(threadId)
      const before = typeof params?.beforeTurnId === 'string' ? params.beforeTurnId : null
      const cut = before ? turns.findIndex((turn) => turn?.id === before) : -1
      if (cut !== -1) {
        const kept = turns.slice(0, cut)
        recordedTurnsByThread.set(threadId, kept)
        persistRecordedTurns(threadId, kept)
      }
    }
    return {}
  }
  if (method === 'thread/archive' || method === 'thread/unarchive') {
    return {}
  }
  if (method === 'fs/watch') {
    return {
      path: path.resolve(String(params?.path || '')),
    }
  }
  if (method === 'fs/unwatch') {
    return {}
  }
  if (method === 'thread/read') {
    const thread = makeThread(params?.threadId, {
      ...params,
      includeTurns: params?.includeTurns === true,
    })
    // recordTurns opt-in: the snapshot reads REAL recorded turns, so a forked
    // child's history provably stops at the fork point (checkpoint divergence).
    if (behavior.recordTurns && params?.includeTurns === true) {
      thread.turns = loadRecordedTurns(thread.id)
    }
    // Task 9 knob: per-thread scriptable status, consulted by thread/read only.
    // threadStatuses: {"<threadId>": "active"|"idle"} — an absent knob or an
    // unlisted thread id keeps makeThread's hardcoded { type: 'idle' }, so all
    // existing fixture consumers are untouched. (The `overrides` knob is a
    // per-METHOD blanket and cannot express per-thread status.)
    const scriptedStatus = behavior.threadStatuses?.[thread.id]
    if (typeof scriptedStatus === 'string') {
      thread.status = { type: scriptedStatus }
    }
    return { thread }
  }
  if (method === 'thread/turns/list') {
    return makeThreadTurnsPage(params)
  }
  if (method === 'thread/loaded/list') {
    return {
      data: behavior.loadedThreadIds || [],
    }
  }
  return {}
}

function maybeWriteRolloutForMethod(method, params) {
  const spec = behavior.writeRolloutOnMethods?.[method]
  if (!spec?.path) return
  const threadId = spec.threadId || params?.threadId || behavior.threadStartThreadId || 'thread-new-1'
  fs.mkdirSync(path.dirname(spec.path), { recursive: true })
  const line = JSON.stringify(spec.record || {
    type: 'session_meta',
    payload: { id: threadId },
  }) + '\n'
  if (spec.append) {
    fs.appendFileSync(spec.path, line, 'utf8')
  } else {
    fs.writeFileSync(spec.path, line, 'utf8')
  }
}

const listenUrl = parseListenUrl(process.argv.slice(2))
const behavior = loadBehavior()
if (process.env.FAKE_CODEX_APP_SERVER_ARG_LOG) {
  fs.writeFileSync(process.env.FAKE_CODEX_APP_SERVER_ARG_LOG, JSON.stringify({
    argv: process.argv.slice(2),
    env: {
      FRESHELL: process.env.FRESHELL,
      FRESHELL_URL: process.env.FRESHELL_URL,
      FRESHELL_TOKEN: process.env.FRESHELL_TOKEN,
      FRESHELL_TERMINAL_ID: process.env.FRESHELL_TERMINAL_ID,
      FRESHELL_TAB_ID: process.env.FRESHELL_TAB_ID,
      FRESHELL_PANE_ID: process.env.FRESHELL_PANE_ID,
    },
  }), 'utf8')
}
const closeSocketAfterMethodsOnce = new Set(behavior.closeSocketAfterMethodsOnce || [])
const exitProcessAfterMethodsOnce = new Set(behavior.exitProcessAfterMethodsOnce || [])
const threadClosedAfterMethodsOnce = new Set(behavior.threadClosedAfterMethodsOnce || [])
const url = new URL(listenUrl)
const host = url.hostname
const port = Number(url.port)

let nativeChild
if (behavior.spawnNativeChild) {
  nativeChild = spawn(process.execPath, [new URL(import.meta.url).pathname, 'fake-native-child'], {
    env: {
      ...process.env,
      FAKE_CODEX_NATIVE_CHILD_IGNORE_SIGTERM: behavior.nativeChildIgnoresSigterm ? '1' : '',
    },
    stdio: 'ignore',
  })
  nativeChild.unref()
  if (behavior.nativePidFile) {
    fs.writeFileSync(behavior.nativePidFile, `${nativeChild.pid}\n`, 'utf8')
  }
  if (behavior.exitAfterSpawningNative) {
    process.exit(Number(behavior.exitAfterSpawningNativeCode ?? 42))
  }
}

const wss = new WebSocketServer({ host, port })
const watches = new Map()
const activeThreadIds = new Set()
// kata 1wxv (LBC-1): thread/revert is paginated-only. Threads THIS process
// started with historyMode:"paginated" on thread/start land here; any other
// thread answers thread/revert with the VERIFIED -32600 refusal.
const paginatedThreadIds = new Set()
let forkCounter = 0

function broadcastNotification(method, params) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
  })
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload)
    }
  }
}

function emitConfiguredNotifications(method) {
  const onceNotifications = behavior.notifyAfterMethodsOnce?.[method]
  if (Array.isArray(onceNotifications) && onceNotifications.length > 0) {
    delete behavior.notifyAfterMethodsOnce[method]
    for (const notification of onceNotifications) {
      broadcastNotification(notification.method, notification.params)
    }
  }

  for (const notification of behavior.notificationsAfterMethods?.[method] || []) {
    socketSafeBroadcast(notification)
  }
}

function socketSafeBroadcast(notification) {
  if (notification?.method) {
    broadcastNotification(notification.method, notification.params)
    return
  }
  const payload = JSON.stringify(notification)
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload)
    }
  }
}

function appendThreadOperation(method, params, result) {
  const logPath = behavior.appendThreadOperationLogPath
  if (!logPath || !method.startsWith('thread/')) {
    return
  }
  const threadId = result?.thread?.id || params?.threadId || null
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, JSON.stringify({
    method,
    threadId,
    params,
    listenUrl,
    at: new Date().toISOString(),
  }) + '\n', 'utf8')
}

function claimCrossProcessOnce(markerPath, key) {
  if (!markerPath) {
    return true
  }

  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(markerPath, `${key}\n`, { flag: 'wx' })
    return true
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return false
    }
    throw error
  }
}

/**
 * AGENT-04 e2e: the PROBED codex 0.147.0 compact notification sequence (plan
 * Task 4/8; fresh-eyes round-3 F4): after the `thread/compact/start` RPC
 * result, the real app-server broadcasts, in order:
 *   thread/status/changed active → turn/started → item/started →
 *   thread/tokenUsage/updated → item/completed → thread/status/changed idle →
 *   turn/completed {turn:{status:'completed'}}
 * The fake mirrors EXACTLY that sequence (the Rust consumer's busy/idle and
 * chime gating ride it). `threadStatuses` is kept consistent so a subsequent
 * thread/read reports the same phase.
 */
async function emitCompactNotificationSequence(threadId) {
  const pauseMs = Number(behavior.compactSequenceDelayMs ?? 25)
  const pause = () => new Promise((resolve) => setTimeout(resolve, pauseMs))
  const turnId = `compact-turn-${Date.now()}`
  const item = { id: `${turnId}:item-0`, type: 'contextCompaction', summary: 'Compacted context' }
  behavior.threadStatuses = { ...(behavior.threadStatuses ?? {}), [threadId]: 'active' }
  broadcastNotification('thread/status/changed', { threadId, status: { type: 'active' } })
  await pause()
  broadcastNotification('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
  await pause()
  broadcastNotification('item/started', { threadId, item })
  await pause()
  broadcastNotification('thread/tokenUsage/updated', { threadId, tokenUsage: { totalTokens: 0 } })
  await pause()
  broadcastNotification('item/completed', { threadId, item })
  await pause()
  behavior.threadStatuses[threadId] = 'idle'
  broadcastNotification('thread/status/changed', { threadId, status: { type: 'idle' } })
  await pause()
  broadcastNotification('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })
}

function emitConfiguredThreadStatusChanges(method) {
  const byMethod = behavior.threadStatusChangedAfterMethodsOnce
  const entries = byMethod?.[method]
  if (!Array.isArray(entries) || entries.length === 0) {
    return
  }
  if (!claimCrossProcessOnce(behavior.threadStatusChangedAfterMethodsOnceMarkerPath, `thread-status:${method}`)) {
    return
  }
  delete byMethod[method]
  for (const entry of entries) {
    broadcastNotification('thread/status/changed', {
      threadId: entry.threadId,
      status: entry.status,
    })
  }
}

function claimCrossProcessCloseSocketOnce(method) {
  return claimCrossProcessOnce(behavior.closeSocketAfterMethodsOnceMarkerPath, `close-socket:${method}`)
}

wss.on('connection', (socket) => {
  let initialized = false
  let initializedNotification = false
  const pendingClientRequests = new Map()
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.method === undefined && ('result' in message || 'error' in message)) {
      const pending = pendingClientRequests.get(message.id)
      if (pending) {
        pendingClientRequests.delete(message.id)
        if (behavior.appendClientResponseLogPath) {
          fs.appendFileSync(behavior.appendClientResponseLogPath, JSON.stringify(message) + '\n')
        }
        pending.resolve(message)
      }
      return
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
      if (message.method === 'initialized') {
        initializedNotification = true
        initialized = true
      }
      return
    }
    if (behavior.requireJsonRpc && message.jsonrpc !== '2.0') {
      socket.send(JSON.stringify({
        id: message.id,
        error: {
          code: -32600,
          message: 'Expected jsonrpc: "2.0" request envelope',
        },
      }))
      return
    }
    if (behavior.rejectJsonRpc && Object.prototype.hasOwnProperty.call(message, 'jsonrpc')) {
      socket.send(JSON.stringify({
        id: message.id,
        error: {
          code: -32600,
          message: 'Expected Codex app-server request envelope without jsonrpc',
        },
      }))
      return
    }
    const method = message.method

    if (
      behavior.requireInitializeBeforeOtherMethods
      && method !== 'initialize'
      && (!initialized || (behavior.requireInitializedNotification && !initializedNotification))
    ) {
      socket.send(JSON.stringify({
        id: message.id,
        error: {
          code: -32000,
          message: 'initialize must complete before other RPC methods',
        },
      }))
      return
    }

    if (behavior.ignoreMethods?.includes(method)) {
      return
    }

    // This fixture writes realistic rollout files on turn/start. Require BOTH a test-owned
    // CODEX_HOME and a fixture-only opt-in so an ambient or production CODEX_HOME can never
    // accidentally authorize durable-looking fake sessions.
    if (
      method === 'turn/start'
      && message.params?.threadId
      && (!hasExplicitCodexHome() || !allowsDurableFixtureWrites())
    ) {
      socket.send(JSON.stringify({
        id: message.id,
        error: {
          code: -32002,
          message: 'Fake Codex app-server requires an explicit CODEX_HOME and fixture-only durable-write opt-in before writing a durable rollout.',
        },
      }))
      return
    }

    if (behavior.assertNoDuplicateActiveThread && method === 'thread/start' && activeThreadIds.size > 0) {
      socket.send(JSON.stringify({
        id: message.id,
        error: {
          code: -32001,
          message: `Duplicate active thread start attempted while ${[...activeThreadIds].join(', ')} is active`,
        },
      }))
      return
    }

    // behavior.crashOnPromptMarker + behavior.crashOnPromptMarkerOnceMarkerPath:
    // if the inbound turn input contains the marker AND this process wins the
    // cross-process once-claim (claimCrossProcessOnce's 'wx' marker file),
    // hard-exit(1) BEFORE responding to simulate a mid-turn sidecar crash.
    // The respawned process finds the marker file on disk and proceeds
    // normally. Cross-process (unlike exitProcessAfterMethodsOnce's
    // per-process "once" set, which would make the respawn exit again).
    if (
      method === 'turn/start' &&
      behavior.crashOnPromptMarker &&
      JSON.stringify(message.params?.input ?? '').includes(behavior.crashOnPromptMarker) &&
      claimCrossProcessOnce(behavior.crashOnPromptMarkerOnceMarkerPath, 'crashOnPromptMarker')
    ) {
      process.exit(1)
    }

    // recordTurns-on strict pin (AGENT-07): a lastTurnId that is not a recorded
    // turn of the parent fails loudly instead of silently forking the tip.
    if (
      method === 'thread/fork'
      && behavior.recordTurns
      && typeof message.params?.lastTurnId === 'string'
    ) {
      const pinIndex = loadRecordedTurns(message.params?.threadId)
        .findIndex((turn) => turn.id === message.params.lastTurnId)
      if (pinIndex === -1) {
        socket.send(JSON.stringify({
          id: message.id,
          error: {
            code: -32602,
            message: `lastTurnId ${message.params.lastTurnId} not found in thread ${message.params?.threadId}`,
          },
        }))
        return
      }
    }

    // kata 1wxv (LBC-1, VERIFIED): thread/revert refuses a legacy-mode thread —
    // only a thread THIS process started with historyMode:"paginated" may be
    // reverted. Threads freshell starts always set the mode (Task 2), so this
    // refusal exercises only the pre-feature legacy back-catalog.
    if (
      method === 'thread/revert'
      && !paginatedThreadIds.has(String(message.params?.threadId ?? ''))
    ) {
      socket.send(JSON.stringify({
        id: message.id,
        error: {
          code: -32600,
          message: 'thread/revert only supports paginated threads',
        },
      }))
      return
    }

    const override = behavior.overrides?.[method]
    const delayMs = Number(behavior.delayMethodsMs?.[method] || 0)
    const floodStdoutBytes = Number(behavior.floodStdoutBeforeMethodsBytes?.[method] || 0)
    const floodStderrBytes = Number(behavior.floodStderrBeforeMethodsBytes?.[method] || 0)
    if (override?.error) {
      setTimeout(() => {
        socket.send(JSON.stringify({
          id: message.id,
          error: override.error,
        }))
      }, delayMs)
      return
    }

    setTimeout(async () => {
      await writeBytes(process.stdout, floodStdoutBytes)
      await writeBytes(process.stderr, floodStderrBytes)
      const result = override?.result ?? successResult(method, message.params)
      socket.send(JSON.stringify({
        id: message.id,
        result,
      }))
      appendThreadOperation(method, message.params, result)
      maybeWriteRolloutForMethod(method, message.params)
      if (method === 'thread/compact/start') {
        // The compact RPC result is empty; the lifecycle rides notifications.
        await emitCompactNotificationSequence(message.params?.threadId)
      }
      if (method === 'turn/interrupt') {
        for (const [id, pending] of pendingClientRequests) {
          if (pending.threadId !== message.params?.threadId) continue
          pendingClientRequests.delete(id)
          broadcastNotification('serverRequest/resolved', { threadId: pending.threadId, requestId: id })
          pending.resolve({ cancelled: true })
        }
      }
      if (method === 'turn/start' && behavior.recordTurns && result?.turn?.id) {
        // recordTurns opt-in: a recorded turn closes with the real turn
        // lifecycle notifications (turn/started → turn/completed{completed})
        // so the consumer's active-turn tracking clears and the idle snapshot
        // edge (which re-fetches the recorded transcript) actually fires. The
        // gap MATTERS (never drop it): the server's send task records
        // active_turn when the RPC result lands; a same-tick turn/completed
        // could clear it BEFORE that record, leaving the session wedged busy —
        // a real provider never completes a turn within the result's tick.
        broadcastNotification('turn/started', {
          threadId: message.params?.threadId,
          turn: { id: result.turn.id, status: 'inProgress' },
        })
        const prompt = (message.params?.input ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
        const userRequest = behavior.serverRequestsByPrompt?.[prompt]
        let interrupted = false
        if (userRequest) {
          const id = userRequest.id ?? `request-${result.turn.id}`
          const response = await new Promise((resolve) => {
            pendingClientRequests.set(id, { resolve, threadId: message.params.threadId })
            socket.send(JSON.stringify({ id, method: userRequest.method, params: {
              threadId: message.params.threadId, turnId: result.turn.id, itemId: `item-${result.turn.id}`,
              ...userRequest.params,
            } }))
          })
          interrupted = response.cancelled === true
        }
        await new Promise((resolve) => setTimeout(resolve, Number(behavior.turnCompleteDelayMs ?? 150)))
        broadcastNotification('turn/completed', {
          threadId: message.params?.threadId,
          turn: { id: result.turn.id, status: interrupted ? 'interrupted' : 'completed' },
        })
      }
      if (method === 'initialize') {
        initialized = true
      }
      if (method === 'thread/start') {
        const thread = result?.thread || getThreadHandle(message.params?.threadId || 'thread-new-1')
        activeThreadIds.add(thread.id)
        // kata 1wxv (LBC-1): threads started paginated are the only threads
        // thread/revert accepts (the refusal gate above consults this set).
        if (message.params?.historyMode === 'paginated') {
          paginatedThreadIds.add(thread.id)
        }
        broadcastNotification('thread/started', {
          thread,
        })
      }
      if (method === 'thread/revert') {
        // kata 1wxv: the real app-server announces an applied revert to every
        // connected client (the result above already answered the requester).
        broadcastNotification('thread/reverted', {
          threadId: message.params?.threadId,
          beforeTurnId: message.params?.beforeTurnId,
        })
      }
      if (method === 'thread/resume') {
        const thread = result?.thread || getThreadHandle(message.params?.threadId || 'thread-new-1')
        activeThreadIds.add(thread.id)
        broadcastNotification('thread/started', {
          thread,
        })
      }
      if (method === 'fs/watch') {
        const watchId = message.params?.watchId
        const watchedPath = result?.path
        if (watchId && watchedPath) {
          watches.set(watchId, watchedPath)
        }
      }
      if (method === 'fs/unwatch') {
        const watchId = message.params?.watchId
        if (watchId) {
          watches.delete(watchId)
        }
      }
      if (method === 'turn/start' && message.params?.threadId) {
        const { thread } = ensureDurableArtifact(message.params.threadId)
        const rolloutPath = thread.path
        const rolloutParent = path.dirname(rolloutPath)
        for (const [watchId, watchedPath] of watches) {
          if (watchedPath !== rolloutPath && watchedPath !== rolloutParent) {
            continue
          }
          broadcastNotification('fs/changed', {
            watchId,
            changedPaths: [rolloutPath],
          })
        }
      }
      emitConfiguredNotifications(method)
      if (
        threadClosedAfterMethodsOnce.delete(method)
        && claimCrossProcessOnce(behavior.threadClosedAfterMethodsOnceMarkerPath, `thread-closed:${method}`)
      ) {
        const threadId = result?.thread?.id || message.params?.threadId || 'thread-new-1'
        activeThreadIds.delete(threadId)
        broadcastNotification('thread/closed', { threadId })
      }
      emitConfiguredThreadStatusChanges(method)
      if (closeSocketAfterMethodsOnce.delete(method) && claimCrossProcessCloseSocketOnce(method)) {
        setTimeout(() => socket.close(), 0)
      }
      if (exitProcessAfterMethodsOnce.delete(method)) {
        setTimeout(() => {
          if (behavior.stdoutBeforeExit) {
            process.stdout.write(String(behavior.stdoutBeforeExit))
          }
          if (behavior.stderrBeforeExit) {
            process.stderr.write(String(behavior.stderrBeforeExit))
          }
          process.exit(0)
        }, 0)
      }
    }, delayMs)
  })
})

process.on('SIGTERM', () => {
  if (process.env.FAKE_CODEX_APP_SERVER_IGNORE_SIGTERM === '1') {
    return
  }
  if (behavior.signalFileOnSigterm) {
    fs.writeFileSync(behavior.signalFileOnSigterm, `${process.pid}\n`, 'utf8')
  }
  if (!behavior.wrapperLeavesNativeOnSigterm) {
    nativeChild?.kill('SIGTERM')
  }
  const exit = () => wss.close(() => process.exit(0))
  const delayExitMs = Number(behavior.delayExitOnSigtermMs || 0)
  if (delayExitMs > 0) {
    setTimeout(exit, delayExitMs)
    return
  }
  exit()
})
