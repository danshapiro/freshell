#!/usr/bin/env node
// Fake codex TERMINAL CLI for the rollout-locator e2e specs (Lane B2).
// Mirrors fake-opencode-terminal.mjs's contract, on codex's substrate: the
// identity artifact is a rollout JSONL under CODEX_HOME/sessions whose FIRST
// line is the session_meta ownership record (payload.id — never the
// filename — is the identity; payload.cwd is the locator's disambiguator).
// - fresh: prints `codex> `; on the FIRST stdin chunk containing an Enter
//   (CR/LF) writes the rollout (gated by
//   FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH when set) and prints
//   `codex: session <uuid> started`. Enter-gating mirrors real codex
//   (Premise 7: the rollout materializes only at the first user prompt) and
//   keeps the fixture on the safe side of the server's first-submit
//   known_files re-snapshot, which completes before the Enter reaches this
//   process.
// - resume (`resume` ANYWHERE in argv — resumeArgs are appended LAST after
//   `-c` overrides): prints `codex: resumed session <id>`, writes nothing.
// - argv mirrored to FAKE_CODEX_TERMINAL_ARGV_LOG as JSONL.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import process from 'node:process'

/**
 * Managed-topology handshake — the Rust server runs codex terminals through a
 * `codex app-server` sidecar proxy (argv carries `--remote ws://…`). The disk
 * locator is deliberately SUPPRESSED for managed panes (D-03): identity binds
 * from the proxy's candidate stream, i.e. from a `thread/started`
 * notification riding this terminal's own proxied connection. A real codex
 * TUI performs `initialize` → `thread/start` on that connection. So on the
 * first Enter this fixture does the same handshake (best-effort, async, only
 * when `--remote` is present), then writes the rollout with the APP-SERVER'S
 * thread id, so the proxy-bound identity and the on-disk artifact agree.
 */

const argv = process.argv.slice(2)

function appendArgvLog() {
  const logPath = process.env.FAKE_CODEX_TERMINAL_ARGV_LOG
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, t: Date.now(), argv })}\n`)
}
appendArgvLog()

function codexSessionsDir() {
  const home = process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : path.join(process.env.HOME ?? '', '.codex')
  const now = new Date()
  const yyyy = String(now.getUTCFullYear())
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return path.join(home, 'sessions', yyyy, mm, dd)
}

function writeRollout(threadId) {
  const now = new Date()
  const ts = now.toISOString().slice(0, 19).replace(/:/g, '-')
  const dir = codexSessionsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${ts}-${threadId}.jsonl`)
  const meta = {
    timestamp: now.toISOString(),
    type: 'session_meta',
    payload: { id: threadId, cwd: process.cwd() },
  }
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n`)
}

const resumeIndex = argv.indexOf('resume')
if (resumeIndex !== -1) {
  const sessionId = argv[resumeIndex + 1] ?? ''
  process.stdout.write(`codex: resumed session ${sessionId}\r\n`)
} else {
  // Best-effort managed-topology handshake; resolves the app-server's thread
  // id (or null when absent/unreachable). Never delays rollout materialization
  // by more than a bounded budget: the pane contract is Enter-anchored.
  async function startManagedThread() {
    const remoteIdx = argv.indexOf('--remote')
    if (remoteIdx === -1 || !argv[remoteIdx + 1]) return null
    try {
      const { WebSocket } = await import('ws')
      const ws = new WebSocket(argv[remoteIdx + 1])
      const rpc = (method, params) => new Promise((resolve, reject) => {
        const id = `${method}-${Date.now()}`
        const to = setTimeout(() => reject(new Error('rpc timeout')), 3000)
        const onMsg = (data) => {
          try {
            const m = JSON.parse(data.toString())
            if (m.id === id) {
              clearTimeout(to)
              ws.off('message', onMsg)
              m.error ? reject(new Error(m.error.message || 'rpc error')) : resolve(m.result)
            }
          } catch { /* ignore stray frames */ }
        }
        ws.on('message', onMsg)
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
      await new Promise((resolve, reject) => {
        ws.on('open', resolve)
        ws.on('error', reject)
        setTimeout(() => reject(new Error('connect timeout')), 3000)
      })
      await rpc('initialize', { clientInfo: { name: 'fake-codex-terminal', version: '1.0.0' } })
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))
      const result = await rpc('thread/start', { cwd: process.cwd() })
      ws.close()
      return result?.thread?.id ?? null
    } catch {
      return null
    }
  }

  process.stdout.write('codex> \r\n')
  let wrote = false
  process.stdin.on('data', (chunk) => {
    if (wrote) return
    const s = String(chunk)
    // Enter-anchored, like real codex (Premise 7): typing alone must not
    // create the rollout — only the first Enter does.
    if (!s.includes('\r') && !s.includes('\n')) return
    wrote = true
    const finish = (maybeThreadId) => {
      const threadId = maybeThreadId ?? crypto.randomUUID()
      writeRollout(threadId)
      process.stdout.write(`codex: session ${threadId} started\r\n`)
    }
    const gate = process.env.FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH
    startManagedThread().then((managedThreadId) => {
      const finishWith = () => finish(managedThreadId)
      if (gate) {
        const poll = setInterval(() => {
          if (fs.existsSync(gate)) {
            clearInterval(poll)
            finishWith()
          }
        }, 50)
      } else {
        finishWith()
      }
    })
  })
}
process.stdin.resume()
