#!/usr/bin/env node
// HARNESS-03 deterministic fake `claude` terminal CLI. Records argv/env to the
// launch ledger and renders the scripted event program (session, activity,
// approval, question, completion, crash, resume) per terminal-cli.mjs.
// Hermetic: never resolves or spawns a real provider binary.
//
// Unified agent names (Task 8): this fixture additionally mirrors the real
// CLI's durable transcript artifact — the metadata event the server's claude
// identity/naming lanes consume. The session id comes from the launch argv
// (`--session-id <uuid>` preallocated by freshell's create path, or
// `--resume <id>`), and the FIRST stdin line appends one ordinary user
// record (the `parse_transcript_turns`-accepted shape the sidecar fixture
// also writes) under
// `<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<sessionId>.jsonl`. Opt out
// with FRESHELL_FAKE_CLAUDE_NO_TRANSCRIPT=1 (legacy specs that only pin the
// TUI surface).
//
// Name reliability (Task 10): the stdin line `/clear` is a CONVERSATION
// SWITCH, as in the real CLI: the fake starts a new session id (later lines
// append to the NEW session's transcript) and emits what the real CLI's
// injected SessionStart hook emits — the hook's stdin JSON written
// atomically to
// `$HOME/.freshell/session-signals/claude/<FRESHELL_TERMINAL_ID>__<nonce>.json`
// with `source: "clear"`, the signal the server's claude rebind lane drains.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runTerminalCli } from './terminal-cli.mjs'

const argv = process.argv.slice(2)

function claudeHome() {
  return (
    process.env.CLAUDE_CONFIG_DIR
    || process.env.CLAUDE_HOME
    || path.join(os.homedir(), '.claude')
  )
}

function mangleCwd(cwd) {
  return String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-')
}

function transcriptPath(sessionId, cwd) {
  return path.join(claudeHome(), 'projects', mangleCwd(cwd), `${sessionId}.jsonl`)
}

function appendUserRecord(sessionId, cwd, text) {
  if (process.env.FRESHELL_FAKE_CLAUDE_NO_TRANSCRIPT === '1') return
  const file = transcriptPath(sessionId, cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const line = {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    timestamp: new Date().toISOString(),
    cwd,
    sessionId,
    isSidechain: false,
    message: { role: 'user', content: text },
  }
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`)
}

const resumeIdx = argv.indexOf('--resume')
const sessionIdx = argv.indexOf('--session-id')
const launchSessionId = resumeIdx !== -1
  ? argv[resumeIdx + 1]
  : sessionIdx !== -1
    ? argv[sessionIdx + 1]
    : randomUUID()
const cwd = process.cwd()
let currentSessionId = launchSessionId

/** Width-stable, timestamp-first nonce (the hook's filename sort order). */
function signalNonce() {
  const nanos = process.hrtime.bigint() % 1_000_000n
  return `${Date.now()}${String(nanos).padStart(6, '0')}-${process.pid}`
}

function writeSessionStartSignal(sessionId, source) {
  const terminalId = process.env.FRESHELL_TERMINAL_ID
  if (!terminalId) return
  const dir = path.join(os.homedir(), '.freshell', 'session-signals', 'claude')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${terminalId}__${signalNonce()}.json`)
  const body = {
    session_id: sessionId,
    transcript_path: transcriptPath(sessionId, cwd),
    cwd,
    hook_event_name: 'SessionStart',
    source,
  }
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(body))
  fs.renameSync(`${file}.tmp`, file)
}

await runTerminalCli({
  provider: 'claude',
  detectLaunch: (argv, sessionId) => {
    if (resumeIdx !== -1) return { kind: 'resume', id: launchSessionId }
    if (sessionIdx !== -1) return { kind: 'fresh', id: launchSessionId }
    return { kind: 'fresh', id: sessionId, silent: true }
  },
  onStdinLine: (line) => {
    // Mirror the real CLI: EVERY user input appends its user record to the
    // transcript (the durable identity artifact the naming lanes consume —
    // and the parity parser's interactivity rule counts user-authored
    // records, so a real multi-turn exchange is what makes the session a
    // realistic directory entry).
    const text = String(line).trim()
    if (text === '/clear') {
      currentSessionId = randomUUID()
      writeSessionStartSignal(currentSessionId, 'clear')
      return
    }
    if (text.length > 0) appendUserRecord(currentSessionId, cwd, text)
  },
})
