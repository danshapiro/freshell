// The native app-server role (FAKE_CODEX_ROLE=native, set by the launcher).
//
// Reproduces the Codex 0.162 native app-server facts the pane-lifecycle work
// depends on: a real per-thread writer lock (fake-lock.mjs), signal semantics
// (SIGTERM drains, SIGINT stops at once and reports running turns completed),
// realistic descendants (a helper in its own process group, an MCP child, shell
// commands in their own session, a detached job), and Codex's thread
// announcements, subscriptions and delayed unloads.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { acquireThreadLock, heldThreadIds, releaseThreadLock } from './fake-lock.mjs'

export function createNativeRole({ behavior, codexHome, broadcast, openConnections, sendTo }) {
  // The native creates, locks and deletes real thread lock files, so it never falls
  // back to the user's own ~/.codex: an unset or empty CODEX_HOME is a startup error.
  if (!codexHome) {
    process.stderr.write('FAKE_CODEX_ROLE=native requires an explicit CODEX_HOME (it never uses the real ~/.codex)\n')
    process.exit(1)
  }
  if (process.platform !== 'linux' && !process.env.FAKE_CODEX_LOCK_HOLDER) {
    process.stderr.write('FAKE_CODEX_LOCK_HOLDER is required off Linux\n')
    process.exit(1)
  }

  const manifestDir = process.env.FAKE_CODEX_MANIFEST_DIR
  const children = { helper: null, mcp: null, shell: [], detached: [] }
  // pid -> start time for every process the manifest reports, read while the pid
  // certainly names that process (this native, or a child it has just spawned), so
  // tests signal only that exact process (pid AND start time).
  const startTimes = {}
  pin(process.pid)
  const shellProcesses = []
  const signals = []
  const activeTurns = new Map() // `${threadId}\0${turnId}` -> { threadId, settled, finish }
  const helperTurns = new Map() // helper thread id -> { turnId, timer }
  const spawningHelpers = new Set()
  // thread id -> { ephemeral, preloaded, subscribers: Set<socket>, unloadTimer }
  const threads = new Map()
  const unloadDelayMs = Number(behavior.threadUnloadDelayMs ?? 60000)
  let draining = false
  let sigtermCount = 0
  let exiting = false
  let helperTurnCounter = 0

  function writeManifest() {
    if (!manifestDir) return
    fs.mkdirSync(manifestDir, { recursive: true })
    const file = path.join(manifestDir, `native-${process.pid}.json`)
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ role: 'native', pid: process.pid, threads: heldThreadIds(), children, startTimes, signals }))
    fs.renameSync(`${file}.tmp`, file)
  }
  function pin(pid) {
    // /proc/<pid>/stat field 22 (Linux only; off Linux nothing is pinned).
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
      if (Number.isSafeInteger(start)) startTimes[pid] = start
    } catch {
      // no /proc
    }
    return pid
  }
  async function lockOrError(threadId) {
    const r = await acquireThreadLock(codexHome, threadId)
    writeManifest()
    return r.ok ? null : { code: -32600, message: r.message }
  }
  function spawnOwnGroupHelper() {
    // code-mode-host analogue: own process group, same session.
    const p = spawn('perl', ['-e', 'setpgrp(0,0); sleep 600'], { stdio: 'ignore' })
    children.helper = pin(p.pid)
  }
  // Codex's stdio MCP launcher gives a server only the variables its
  // `mcp_servers.<name>.env_vars` list names, plus PATH and HOME. A native
  // started without `-c mcp_servers.freshell.env_vars=[…]` keeps handing the
  // child its full environment, as before.
  function mcpChildEnvironment() {
    const argv = process.argv.slice(2)
    for (let i = 0; i + 1 < argv.length; i += 1) {
      if (argv[i] !== '-c') continue
      const match = /^mcp_servers\.freshell\.env_vars=\[(.*)\]$/.exec(argv[i + 1])
      if (!match) continue
      const names = [...match[1].matchAll(/"([^"\\]*)"/g)].map((m) => m[1])
      const env = {}
      for (const name of [...names, 'PATH', 'HOME']) {
        if (process.env[name] !== undefined) env[name] = process.env[name]
      }
      return env
    }
    return process.env
  }
  function spawnMcpChild() {
    const p = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { stdio: ['pipe', 'ignore', 'ignore'], env: mcpChildEnvironment() })
    children.mcp = pin(p.pid)
  }
  function spawnShellCommand() {
    const p = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' }) // setsid
    p.unref()
    shellProcesses.push(p)
    children.shell.push(pin(p.pid))
  }
  function spawnDetachedJob() {
    // A `nohup` job whose parent shell exits at once, so it is reparented away.
    // Pinned right away, while its `sleep 600` certainly still runs.
    const out = spawnSync('sh', ['-c', 'nohup sleep 600 >/dev/null 2>&1 & echo $!'])
    const pid = Number(String(out.stdout).trim())
    if (Number.isFinite(pid) && pid > 0) children.detached.push(pin(pid))
  }

  // Unit record state at signal time (Stage 2: LB-32): the per-unit record is the
  // only place persisted Stopping lives, so tests can prove it was written first.
  function recordStateSnapshot() {
    const dir = process.env.FAKE_UNIT_RECORD_DIR
    const unitId = process.env.FRESHELL_UNIT_ID
    if (!dir || !unitId) return null
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, `${unitId}.json`), 'utf8'))
      return record.state === undefined ? null : JSON.stringify(record.state)
    } catch {
      return null
    }
  }

  function exitSoon(ms) {
    if (exiting) return
    exiting = true
    setTimeout(() => process.exit(0), ms)
  }
  function finishDrainIfIdle() {
    if (draining && activeTurns.size === 0 && helperTurns.size === 0) exitSoon(100)
  }

  // ── Thread registry: loads, subscriptions, delayed unloads ──────────────────
  function threadRunsTurn(threadId) {
    if (helperTurns.has(threadId)) return true
    for (const turn of activeTurns.values()) {
      if (turn.threadId === threadId) return true
    }
    return false
  }
  function evaluateUnload(threadId) {
    const thread = threads.get(threadId)
    if (!thread) return
    const eligible = !thread.preloaded && thread.subscribers.size === 0 && !threadRunsTurn(threadId)
    if (eligible && !thread.unloadTimer) {
      thread.unloadTimer = setTimeout(() => { void unloadThread(threadId) }, unloadDelayMs)
    } else if (!eligible && thread.unloadTimer) {
      clearTimeout(thread.unloadTimer)
      thread.unloadTimer = null
    }
  }
  function registerThread(threadId, kind, subscribers) {
    let thread = threads.get(threadId)
    if (!thread) {
      thread = { ephemeral: kind.ephemeral === true, preloaded: kind.preloaded === true, subscribers: new Set(), unloadTimer: null }
      threads.set(threadId, thread)
    }
    for (const socket of subscribers) thread.subscribers.add(socket)
    evaluateUnload(threadId)
    return thread
  }
  async function dropThread(threadId) {
    const thread = threads.get(threadId)
    if (!thread) return
    if (thread.unloadTimer) clearTimeout(thread.unloadTimer)
    threads.delete(threadId)
    if (!thread.ephemeral) await releaseThreadLock(codexHome, threadId)
    writeManifest()
  }
  async function unloadThread(threadId) {
    await dropThread(threadId)
    broadcast('thread/status/changed', { threadId, status: { type: 'notLoaded' } })
    broadcast('thread/closed', { threadId })
  }
  function isEphemeral(threadId) {
    return threads.get(threadId)?.ephemeral === true
  }
  function hasRollout(threadId) {
    const wanted = `rollout-${encodeURIComponent(threadId)}.jsonl`
    try {
      return fs.readdirSync(path.join(codexHome, 'sessions'), { recursive: true })
        .some((entry) => path.basename(String(entry)) === wanted)
    } catch {
      return false
    }
  }

  // ── Helper threads (Codex collab agents) ────────────────────────────────────
  async function spawnHelperThread(rootThreadId, spec) {
    const helperId = String(spec.id)
    spawningHelpers.add(helperId)
    try {
      if (await lockOrError(helperId)) return
      const thread = registerThread(helperId, {}, openConnections())
      broadcast('thread/status/changed', { threadId: helperId, status: { type: 'idle' } })
      broadcast('thread/status/changed', { threadId: helperId, status: { type: 'active', activeFlags: [] } })
      broadcast('item/completed', {
        threadId: rootThreadId,
        item: { type: 'collabAgentToolCall', id: `${helperId}-spawn`, tool: 'spawnAgent', receiverThreadIds: [helperId] },
      })
      helperTurnCounter += 1
      const turnId = `${helperId}-turn-${helperTurnCounter}`
      const timer = setTimeout(() => endHelperTurn(helperId, 'completed'), Number(spec.durationMs ?? 0))
      helperTurns.set(helperId, { turnId, timer })
      evaluateUnload(helperId)
      for (const socket of thread.subscribers) {
        sendTo(socket, 'turn/started', { threadId: helperId, turn: { id: turnId, status: 'inProgress' } })
      }
      if (spec.closeAfterMs !== undefined && spec.closeAfterMs !== null) {
        setTimeout(() => { void closeHelperThread(helperId) }, Number(spec.closeAfterMs))
      }
    } finally {
      spawningHelpers.delete(helperId)
    }
  }
  function endHelperTurn(helperId, status) {
    const turn = helperTurns.get(helperId)
    if (!turn) return
    clearTimeout(turn.timer)
    helperTurns.delete(helperId)
    for (const socket of threads.get(helperId)?.subscribers ?? []) {
      sendTo(socket, 'turn/completed', { threadId: helperId, turn: { id: turn.turnId, status } })
    }
    broadcast('thread/status/changed', { threadId: helperId, status: { type: 'idle' } })
    evaluateUnload(helperId)
    finishDrainIfIdle()
  }
  // Codex's close_agent: the parent ends the helper; it is reported notLoaded
  // only (no thread/closed).
  async function closeHelperThread(helperId) {
    endHelperTurn(helperId, 'interrupted')
    if (!threads.has(helperId)) return
    await dropThread(helperId)
    broadcast('thread/status/changed', { threadId: helperId, status: { type: 'notLoaded' } })
  }

  // ── Root turns ───────────────────────────────────────────────────────────────
  function turnKey(threadId, turnId) {
    return `${threadId}\u0000${turnId}`
  }
  function turnDelay(threadId, turnId, delayMs) {
    const ephemeral = isEphemeral(threadId)
    if (!ephemeral) {
      if (behavior.turnSpawnsShellCommand) spawnShellCommand()
      if (behavior.detachedJobOnTurn) spawnDetachedJob()
      writeManifest()
      const helper = behavior.helperThreadOnTurn
      const helperId = helper?.id === undefined ? null : String(helper.id)
      if (helperId && !threads.has(helperId) && !spawningHelpers.has(helperId)) void spawnHelperThread(threadId, helper)
    }
    return new Promise((resolve) => {
      const turn = { threadId, settled: false, finish: null }
      // Title (ephemeral) turns are short and never run tools.
      const timer = setTimeout(() => turn.finish('completed'), ephemeral ? 50 : delayMs)
      turn.finish = (status) => {
        if (turn.settled) return
        turn.settled = true
        clearTimeout(timer)
        resolve(status)
      }
      activeTurns.set(turnKey(threadId, turnId), turn)
      evaluateUnload(threadId)
    })
  }
  function turnEnded(threadId, turnId) {
    activeTurns.delete(turnKey(threadId, turnId))
    evaluateUnload(threadId)
    finishDrainIfIdle()
  }

  // ── Signals ──────────────────────────────────────────────────────────────────
  process.on('SIGTERM', () => {
    sigtermCount += 1
    signals.push({ sig: 'SIGTERM', atMs: Date.now(), recordState: recordStateSnapshot() })
    writeManifest()
    if (behavior.ignoreSigterm) return // never finishes a polite stop (cleanup escalation test)
    if (sigtermCount > 1) process.exit(0) // second SIGTERM: fast exit, commands left alive
    draining = true
    finishDrainIfIdle()
  })
  process.on('SIGINT', () => {
    signals.push({ sig: 'SIGINT', atMs: Date.now(), recordState: recordStateSnapshot() })
    writeManifest()
    if (behavior.ignoreSigint) return // a wedged agent only the whole-unit kill ends
    for (const p of shellProcesses) {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
    }
    // Codex 0.162 reports a SIGINT-ended turn as completed (Stage 2: LB-37).
    for (const turn of activeTurns.values()) turn.finish('completed')
    exitSoon(100)
  })
  process.on('SIGHUP', () => {
    signals.push({ sig: 'SIGHUP', atMs: Date.now(), recordState: recordStateSnapshot() })
    writeManifest()
  })

  // Preloaded threads stay loaded and locked for the native's whole life, like
  // conversations opened earlier in the pane. They are locked before any child
  // starts, and one held elsewhere is a setup mistake: the native fails at startup
  // (stderr, exit 1) instead of running without it. The app-server listens only
  // after this.
  const ready = (async () => {
    for (const id of behavior.preloadedThreads ?? []) {
      const lock = await acquireThreadLock(codexHome, id)
      if (!lock.ok) {
        writeManifest()
        process.stderr.write(`preloaded thread ${id} could not be locked: ${lock.message}\n`)
        process.exit(1)
      }
      registerThread(id, { preloaded: true }, [])
    }
    if (behavior.spawnHelperProcess) spawnOwnGroupHelper()
    if (behavior.mcpChild) spawnMcpChild()
    writeManifest()
  })()

  // ── JSON-RPC interception ────────────────────────────────────────────────────
  // Returns `{ error }` or `{ result }` to answer, or `null` to fall through to the
  // shared dispatcher. `ctx` carries per-request choices (the started thread's id
  // and ephemeral flag) to `successResult`, never through shared state.
  async function intercept(method, params, socket, ctx) {
    const threadId = params?.threadId
    switch (method) {
      case 'thread/start': {
        if (params?.ephemeral === true) {
          const id = randomUUID()
          registerThread(id, { ephemeral: true }, [socket])
          ctx.threadId = id
          ctx.ephemeral = true
          return null
        }
        const id = behavior.threadStartThreadId || randomUUID()
        const lockError = await lockOrError(id)
        if (lockError) return { error: lockError }
        registerThread(id, {}, [socket])
        ctx.threadId = id
        ctx.ephemeral = false
        return null
      }
      case 'thread/resume': {
        const id = threadId || 'thread-new-1'
        if (threads.has(id)) {
          // Warm resume (Codex's resume_running_thread): no lock attempt, no broadcast.
          registerThread(id, {}, [socket])
          return null
        }
        if (behavior.resumeNeedsRollout && !hasRollout(id)) {
          return { error: { code: -32600, message: `no rollout found for thread id ${id}` } }
        }
        const lockError = await lockOrError(id)
        if (lockError) return { error: lockError }
        registerThread(id, {}, [socket])
        broadcast('thread/status/changed', { threadId: id, status: { type: 'notLoaded' } })
        broadcast('thread/status/changed', { threadId: id, status: { type: 'idle' } })
        return null
      }
      case 'thread/unsubscribe': {
        const thread = threads.get(threadId)
        if (!thread) return { result: { status: 'notLoaded' } }
        if (!thread.subscribers.delete(socket)) return { result: { status: 'notSubscribed' } }
        evaluateUnload(threadId)
        return { result: { status: 'unsubscribed' } }
      }
      case 'turn/start':
        return draining ? { error: { code: -32001, message: 'app-server is draining' } } : null
      case 'turn/interrupt':
        for (const turn of activeTurns.values()) {
          if (turn.threadId === threadId) turn.finish('interrupted')
        }
        return null
      case 'thread/loaded/list': {
        const ids = [...threads.keys()].sort()
        const offset = typeof params?.cursor === 'string' && /^\d+$/.test(params.cursor) ? Number(params.cursor) : 0
        const limit = Number.isInteger(params?.limit) && params.limit > 0 ? params.limit : ids.length
        const data = ids.slice(offset, offset + limit)
        const next = offset + data.length
        return { result: { data, nextCursor: next < ids.length ? String(next) : null } }
      }
      case 'thread/queue/list': {
        if (isEphemeral(threadId)) {
          return { error: { code: -32600, message: `ephemeral thread does not support queued submissions: ${threadId}` } }
        }
        const count = Number(behavior.queuedSubmissions?.[threadId] ?? 0)
        const data = Array.from({ length: count }, (_, i) => ({
          id: `queued-${threadId}-${i + 1}`,
          clientUserMessageId: `client-${threadId}-${i + 1}`,
          input: [{ type: 'text', text: `queued ${i + 1}` }],
        }))
        return { result: { data, nextCursor: null } }
      }
      case 'thread/goal/get': {
        if (isEphemeral(threadId)) {
          return { error: { code: -32600, message: `ephemeral thread does not support goals: ${threadId}` } }
        }
        const goal = behavior.goals?.[threadId]
        if (!goal) return { result: { goal: null } }
        const now = Math.floor(Date.now() / 1000)
        return {
          result: {
            goal: {
              threadId,
              objective: goal.objective ?? 'fixture goal',
              status: goal.status,
              createdAt: now,
              updatedAt: now,
              timeUsedSeconds: 0,
              tokenBudget: null,
              tokensUsed: 0,
            },
          },
        }
      }
      default:
        // thread/read falls through; the shared result consults statusFor.
        return null
    }
  }

  // A fork child: the native holds both the original's and the fork's locks.
  async function noteLoaded(threadId, socket) {
    if (!(await lockOrError(threadId))) registerThread(threadId, {}, socket ? [socket] : [])
  }

  function statusFor(threadId) {
    if (behavior.approvalWaiting?.includes(threadId)) return { type: 'active', activeFlags: ['waitingOnApproval'] }
    if (threadRunsTurn(threadId)) return { type: 'active', activeFlags: [] }
    return null
  }

  function connectionClosed(socket) {
    for (const [threadId, thread] of threads) {
      if (thread.subscribers.delete(socket)) evaluateUnload(threadId)
    }
  }

  return {
    get draining() { return draining },
    ready,
    intercept,
    noteLoaded,
    statusFor,
    isEphemeral,
    turnDelay,
    turnEnded,
    connectionClosed,
  }
}
