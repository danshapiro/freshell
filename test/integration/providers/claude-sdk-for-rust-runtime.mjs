// Rust runtime tests use the production index.mjs over the contract simulator.
// This adapter records actual SDK options and subsequent sidecar input; it
// never emits a sidecar protocol frame. Faults stay at SDK method boundaries.
import fs from 'node:fs'
import path from 'node:path'
import { query as simulateQuery } from '../../fixtures/claude-cli-sim/query.mjs'

function append(file, row) {
  if (file) fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
}

let recording = false
function recordInput() {
  if (recording) return
  recording = true
  let partial = ''
  // Installed during query(), after production readline consumed create.
  // Observe the same stream without replacing its consumer or its replies.
  process.stdin.on('data', (chunk) => {
    partial += String(chunk)
    for (;;) {
      const end = partial.indexOf('\n')
      if (end < 0) break
      const line = partial.slice(0, end)
      partial = partial.slice(end + 1)
      let request
      try { request = JSON.parse(line) } catch { continue }
      if (['configure', 'send', 'permission.respond', 'question.respond'].includes(request.type)) {
        append(process.env.FRESHELL_TEST_CLAUDE_RESPOND_LOG, request)
      }
      if (request.type === 'interrupt' && process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_LOG) {
        fs.appendFileSync(process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_LOG, `${request.sessionId}\n`)
      }
    }
  })
}

function closeWhenGuardEnds(runtime) {
  const guard = process.env.FRESHELL_TEST_CLAUDE_RUNTIME_GUARD
  if (!guard) return
  let watcher
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    watcher?.close()
    runtime.close()
  }
  const ended = () => !fs.existsSync(guard) || fs.existsSync(`${guard}.stop`)
  try {
    watcher = fs.watch(path.dirname(guard), { persistent: false }, () => {
      if (ended()) close()
    })
    watcher.unref()
    watcher.on('error', close)
    if (ended()) close()
  } catch {
    close()
  }
}

export function query(params) {
  // Keep credentials and callbacks out of fixture diagnostics.
  const { env, ...options } = params.options
  append(process.env.FRESHELL_TEST_CLAUDE_SPAWN_LOG, {
    pid: process.pid,
    options: { ...options, envKeys: Object.keys(env ?? {}).sort() },
  })
  recordInput()
  const runtime = simulateQuery(params)
  closeWhenGuardEnds(runtime)
  const initialize = runtime.initializationResult.bind(runtime)
  runtime.initializationResult = async () => {
    const delay = Number(process.env.FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS ?? 0)
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    if (process.env.FRESHELL_TEST_CLAUDE_FAIL_CREATE === '1') throw new Error('Injected SDK initialization failure')
    return initialize()
  }
  for (const [method, key] of [
    ['setModel', 'FRESHELL_TEST_CLAUDE_REJECT_MODEL'],
    ['applyFlagSettings', 'FRESHELL_TEST_CLAUDE_REJECT_EFFORT'],
  ]) {
    const original = runtime[method].bind(runtime)
    runtime[method] = async (value) => {
      const requested = method === 'setModel' ? value : value?.effortLevel
      if (process.env[key] !== undefined && requested === process.env[key]) {
        throw new Error(`Injected SDK ${method} rejection: ${JSON.stringify(requested)}`)
      }
      return original(value)
    }
  }
  return runtime
}
