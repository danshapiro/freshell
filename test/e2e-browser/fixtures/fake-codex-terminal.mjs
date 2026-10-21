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
//   `-c` overrides): resumes the exact thread through the managed proxy when
//   present, prints `codex: resumed session <id>`, writes nothing.
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
 *
 * OPT-IN persistent plugin/list mode (FAKE_CODEX_TERMINAL_PLUGIN_LIST=1,
 * delivered via installDualRoleCodexCli's terminalEnv): after the
 * initialize/thread-start handshake the connection is NOT closed. Instead —
 * the real TUI's mention-autocomplete poll shape — plugin/list is requested
 * ASYNCHRONOUSLY ON THE SAME persistent socket (startup never blocks on
 * it), the full (deliberately oversized) response is consumed, and two
 * PTY-observable markers are echoed:
 *   `codex: plugin list consumed <N> bytes` (N = bytes actually received)
 *   `codex: followup rpc ok <json>` (a follow-up RPC on the same socket,
 *   proving the connection survived the large frame)
 * Best-effort like the rest of the handshake: a plugin/list failure (the
 * 2026-10-19 incident's Capacity teardown at the proxy's frame cap) is
 * swallowed, so the visible symptom is exactly the incident's — the markers
 * never appear.
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

function writeRollout(threadId, firstPrompt) {
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
  const lines = [JSON.stringify(meta)]
  // Unified agent names (Task 8): the first prompt's user records — the same
  // record pair the real CLI writes and the server's rollout parser reads
  // for the first-message fallback + generation arming.
  const prompt = String(firstPrompt ?? '').trim()
  if (prompt.length > 0) {
    lines.push(JSON.stringify({
      timestamp: now.toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
    }))
    lines.push(JSON.stringify({
      timestamp: now.toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: prompt, kind: 'plain' },
    }))
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

// Best-effort managed-topology handshake; resolves the app-server's thread
// id (or null when absent/unreachable). Never delays rollout materialization
// by more than a bounded budget: the pane contract is Enter-anchored.
async function managedThread(sessionId) {
  const remoteIdx = argv.indexOf('--remote')
  if (remoteIdx === -1 || !argv[remoteIdx + 1]) return null
  try {
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(argv[remoteIdx + 1])
    const rpc = (method, params, timeoutMs = 3000) => new Promise((resolve, reject) => {
      const id = `${method}-${Date.now()}`
      const to = setTimeout(() => reject(new Error('rpc timeout')), timeoutMs)
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
    const result = sessionId
      ? await rpc('thread/resume', { threadId: sessionId, cwd: process.cwd() })
      : await rpc('thread/start', { cwd: process.cwd() })
    const threadId = result?.thread?.id ?? null
    if (process.env.FAKE_CODEX_TERMINAL_PLUGIN_LIST === '1') {
      // Detached continuation — the real TUI's mention-autocomplete poll is
      // async and never blocks startup: the session marker lands promptly,
      // and the plugin markers appear only if the large frame actually
      // relays (the incident shape: startup succeeds, then the connection
      // dies on plugin/list). The generous budgets cover a multi-MB relay
      // under load; a failure stays best-effort (markers absent).
      void (async () => {
        try {
          const pluginList = await rpc('plugin/list', {}, 30_000)
          const bytes = Buffer.byteLength(JSON.stringify(pluginList))
          process.stdout.write(`codex: plugin list consumed ${bytes} bytes\r\n`)
          const followUp = await rpc('thread/loaded/list', {}, 30_000)
          process.stdout.write(`codex: followup rpc ok ${JSON.stringify(followUp)}\r\n`)
        } catch { /* incident shape: the connection died; markers never appear */ }
      })()
      return threadId // persistent connection: skip ws.close()
    }
    ws.close()
    return threadId
  } catch {
    return null
  }
}

const resumeIndex = argv.indexOf('resume')
if (resumeIndex !== -1) {
  const sessionId = argv[resumeIndex + 1] ?? ''
  managedThread(sessionId).then(resumedId => {
    if (resumedId && resumedId !== sessionId) {
      process.stderr.write(`codex: resumed wrong session ${resumedId}\r\n`)
      process.exitCode = 1
    }
  })
  process.stdout.write(`codex: resumed session ${sessionId}\r\n`)
} else {

  process.stdout.write('codex> \r\n')
  let wrote = false
  process.stdin.on('data', (chunk) => {
    if (wrote) return
    const s = String(chunk)
    // Enter-anchored, like real codex (Premise 7): typing alone must not
    // create the rollout — only the first Enter does.
    if (!s.includes('\r') && !s.includes('\n')) return
    wrote = true
    // Unified agent names (Task 8): the first prompt's text is the durable
    // user-message metadata the server's rollout/naming lanes parse —
    // mirror the real CLI's `response_item` user `input_text` + `event_msg`
    // `user_message` records in the rollout (strip the Enter).
    const firstPrompt = s.replace(/[\r\n]+$/, '').trim()
    const finish = (maybeThreadId) => {
      const threadId = maybeThreadId ?? crypto.randomUUID()
      writeRollout(threadId, firstPrompt)
      process.stdout.write(`codex: session ${threadId} started\r\n`)
    }
    const gate = process.env.FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH
    managedThread().then((managedThreadId) => {
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
