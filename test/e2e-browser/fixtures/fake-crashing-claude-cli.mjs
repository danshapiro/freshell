#!/usr/bin/env node
// test/e2e-browser/fixtures/fake-crashing-claude-cli.mjs
// Fake claude CLI for crash-resilience e2e. Behavior selection:
//   FAKE_CRASH_UNTIL=N — crash (exit 1) while invocation <= N, then SURVIVE.
//                        Takes PRECEDENCE over FAKE_CRASH_MODE: when set, the
//                        mode checks are never reached, so the 'clean' default
//                        cannot make the surviving invocation exit 0.
//   FAKE_CRASH_MODE (only when FAKE_CRASH_UNTIL is unset):
//     once   — invocation #1 prints output then exits 1; later invocations stay alive
//     always — every invocation prints then exits 1 immediately
//     clean  — prints then exits 0 (the default when neither env is set)
//   FAKE_CRASH_LIVE_MS=N — with FAKE_CRASH_MODE=always: stay alive N ms, then
//     exit 1 (a "healthy flap": long enough to reset the retry budget when the
//     server's healthy-lifetime knob is shrunk below N).
//   FAKE_CRASH_ON_LINE=<text> — takes precedence over both: invocation #1
//     stays alive until it reads the stdin line <text>, then exits 1 (a crash
//     the test triggers after setting up state, e.g. a saved name); later
//     invocations survive.
//   FAKE_CLAUDE_TRANSCRIPT=1 — mirror the real CLI's durable transcript: every
//     invocation appends one user record under
//     <CLAUDE_CONFIG_DIR|~/.claude>/projects/<mangled-cwd>/<sessionId>.jsonl
//     (the session id from `--session-id`/`--resume`), the artifact the
//     server's claude naming lane verifies a pending name's bind against.
// Every invocation appends {pid,t,argv} to FAKE_CLAUDE_ARGV_LOG (JSONL) and
// bumps the invocation counter in FAKE_CRASH_STATE_FILE.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
const logPath = process.env.FAKE_CLAUDE_ARGV_LOG
if (logPath) fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, t: Date.now(), argv }) + '\n')

let invocation = 1
const stateFile = process.env.FAKE_CRASH_STATE_FILE
if (stateFile) {
  try { invocation = (parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0) + 1 } catch { /* first run */ }
  fs.writeFileSync(stateFile, String(invocation))
}

process.stdout.write(`fake-claude invocation ${invocation} argv=${argv.join(' ')}\r\n`)

if (process.env.FAKE_CLAUDE_TRANSCRIPT === '1') {
  const flag = argv.includes('--resume') ? '--resume' : '--session-id'
  const sessionId = argv[argv.indexOf(flag) + 1]
  if (argv.includes(flag) && sessionId) {
    const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const cwd = process.cwd()
    const file = path.join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      timestamp: new Date().toISOString(),
      cwd,
      sessionId,
      isSidechain: false,
      message: { role: 'user', content: `invocation ${invocation}` },
    })}\n`)
  }
}

/** Behave like a long-running interactive CLI. */
function survive() {
  process.stdin.resume()
  setInterval(() => {}, 60_000)
}

const crashOnLine = process.env.FAKE_CRASH_ON_LINE
const crashUntil = Number(process.env.FAKE_CRASH_UNTIL || 0)
if (crashOnLine) {
  if (invocation === 1) {
    let buffered = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buffered += chunk
      const lines = buffered.split(/\r?\n|\r/)
      buffered = lines.pop() ?? ''
      if (lines.some((line) => line.trim() === crashOnLine)) {
        process.stdout.write('fake-claude: simulated crash\r\n')
        process.exit(1)
      }
    })
  }
  survive()
} else if (crashUntil > 0) {
  if (invocation <= crashUntil) {
    process.stdout.write('fake-claude: simulated crash\r\n')
    process.exit(1)
  }
  // invocation > N: survive WITHOUT consulting FAKE_CRASH_MODE (its 'clean'
  // default would exit 0 and vacuously satisfy liveness assertions on a dead
  // pane).
  survive()
} else {
  const mode = process.env.FAKE_CRASH_MODE || 'clean'
  if (mode === 'always' || (mode === 'once' && invocation === 1)) {
    process.stdout.write('fake-claude: simulated crash\r\n')
    const liveMs = Number(process.env.FAKE_CRASH_LIVE_MS || '0')
    if (liveMs > 0) {
      // Flap mode (kata znhn item 2 e2e): stay alive liveMs, THEN exit 1 —
      // keep the event loop alive exactly like the SURVIVE path does.
      setTimeout(() => process.exit(1), liveMs)
      process.stdin.resume()
    } else {
      process.exit(1)
    }
  } else if (mode === 'clean') {
    process.stdout.write('fake-claude: clean exit\r\n')
    process.exit(0)
  } else {
    survive()
  }
}
