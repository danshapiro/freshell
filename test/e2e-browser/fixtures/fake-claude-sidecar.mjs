#!/usr/bin/env node
// Fake Claude SDK-bridge sidecar for e2e (freshclaude). Enabled via the
// production env seam: FRESHELL_CLAUDE_SIDECAR=<this file>. Speaks the
// newline-JSON stdio protocol from crates/freshell-freshagent/src/claude.rs:
//   in : {"type":"create",requestId,cwd,model,permissionMode,effort,resumeSessionId}
//        {"type":"send",sessionId,text} {"type":"interrupt",sessionId} {"type":"shutdown"}
//   out: {"type":"created","sessionId"} FIRST (any earlier sdk.* line is
//        DISCARDED by read_created, claude.rs:551; 45s budget claude.rs:71),
//        then sdk.* event lines (renamed sdk.X -> freshAgent.X server-side).
// FIELD shapes come from the REAL sidecar (crates/freshell-claude-sidecar/
// index.mjs:15-30) + the client consumer (src/lib/fresh-agent-ws.ts:195-284):
//   - sdk.assistant content MUST be an ARRAY of blocks (fresh-agent-ws.ts:260-265);
//   - sdk.turn.complete MUST carry a numeric `at` (fresh-agent-ws.ts:233-240);
//   - sdk.session.init cliSessionId MUST be a canonical UUID
//     (shared/session-contract.ts:34) or no durable sessionRef ever lands.
// The process MUST stay alive (no EOF) until shutdown/kill -- an early exit
// stops the server's consumer.
// FAKE_CLAUDE_SIDECAR_HOLD_TURN=1 -> a send starts running and never
// completes (busy-restart wedge scenario).
// NEW knobs (Task 7):
// - FAKE_CLAUDE_SIDECAR_LOG=<path> -> append request log (JSONL: {pid, t, msg})
// - FAKE_CLAUDE_SIDECAR_HOLD_TURN_ONCE_MARKER=<path> -> first send wedges, rest work
// - resumeSessionId on create -> cliSessionId uses that (resume continuity)
// - transcripts: create ensures, each send appends to <store>/projects/-fixture/<cliSessionId>.jsonl
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const HOLD_TURN = process.env.FAKE_CLAUDE_SIDECAR_HOLD_TURN === '1'
const HOLD_ONCE_MARKER = process.env.FAKE_CLAUDE_SIDECAR_HOLD_TURN_ONCE_MARKER
// RANDOM canonical UUID per sidecar PROCESS (council follow-up, PR #562/#563
// close-out): the old static 44444444-... default made every resume-less
// create in every sidecar process mint the SAME id, so a regression that
// silently lost the durable identity across a restart would be re-stamped
// with the identical constant and collide onto the same transcript file --
// structurally collision-blind. With a per-process random default, any
// identity-losing bare create after a restart (new sidecar process) mints a
// DIFFERENT id and the identity assertions in the specs go red. The env
// override remains for specs that need a caller-chosen id.
const CLI_SESSION_ID = process.env.FAKE_CLAUDE_SIDECAR_CLI_SESSION_ID ?? randomUUID()
const REQUEST_LOG = process.env.FAKE_CLAUDE_SIDECAR_LOG

// sessionId (bridge nanoid) -> { cliSessionId (durable uuid), cwd }
const sessions = new Map()

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function logRequest(msg) {
  if (!REQUEST_LOG) return
  fs.mkdirSync(path.dirname(REQUEST_LOG), { recursive: true })
  fs.appendFileSync(REQUEST_LOG, `${JSON.stringify({ pid: process.pid, t: Date.now(), msg })}\n`)
}

function claudeHome() {
  // Mirror the REAL CLI's resolution (CLAUDE_CONFIG_DIR first -- ledger A3), then
  // the freshell-legacy CLAUDE_HOME the harness sets, then ~/.claude -- the same
  // candidate order as the Rust claude_home_candidates().
  return (
    process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude')
  )
}

function transcriptPath(cliSessionId) {
  const dir = path.join(claudeHome(), 'projects', '-fixture')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${cliSessionId}.jsonl`)
}

// Claude-code transcript line shape (what the Rust snapshot adapter parses).
// `cwd` is load-bearing: the attach arm resumes with the transcript's ORIGINAL
// cwd (ledger A15 -- real lines carry cwd on 100% of user/assistant lines).
function appendTranscript(cliSessionId, role, text, cwd) {
  const line = {
    type: role,
    timestamp: new Date().toISOString(),
    cwd: cwd ?? process.cwd(),
    message: { role, content: [{ type: 'text', text }] },
  }
  fs.appendFileSync(transcriptPath(cliSessionId), `${JSON.stringify(line)}\n`)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  logRequest(msg)
  if (msg.type === 'create') {
    const sessionId = `fc-e2e-${process.pid}-${Date.now()}`
    // Resume continuity: a resumed session keeps its durable id (what the real
    // CLI's transcript filename stem provides across restarts).
    const cliSessionId = msg.resumeSessionId ?? CLI_SESSION_ID
    const cwd = msg.cwd ?? process.cwd()
    sessions.set(sessionId, { cliSessionId, cwd, model: msg.model ?? 'claude-opus-4-6', effort: msg.effort, permissionMode: msg.permissionMode })
    // Ensure the transcript file EXISTS from create (the attach arm's
    // transcript-present gate reads it before any send happens post-restart).
    fs.closeSync(fs.openSync(transcriptPath(cliSessionId), 'a'))
    emit({ type: 'created', requestId: msg.requestId, sessionId })
    emit({
      type: 'sdk.session.init',
      sessionId,
      cliSessionId,
      model: msg.model ?? 'claude-opus-4-6',
      cwd,
      tools: [],
    })
    if (msg.resumeSessionId) {
      emit({ type: 'sdk.session.snapshot', sessionId, messages: [] })
    }
    emit({ type: 'sdk.status', sessionId, status: 'idle' })
  } else if (msg.type === 'configure') {
    const session = sessions.get(msg.sessionId)
    if (!session) {
      emit({ type: 'sdk.configured', sessionId: msg.sessionId, requestId: msg.requestId, ok: false, message: 'Session not found' })
      return
    }
    for (const key of ['model', 'effort', 'permissionMode', 'cwd']) {
      if (msg.settings?.[key] != null || (key === 'effort' && msg.settings?.effort === null)) session[key] = msg.settings[key]
    }
    emit({ type: 'sdk.configured', sessionId: msg.sessionId, requestId: msg.requestId, ok: true, settings: session })
  } else if (msg.type === 'send') {
    const { cliSessionId, cwd, model, effort, permissionMode } = sessions.get(msg.sessionId) ?? { cliSessionId: CLI_SESSION_ID }
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'running' })
    appendTranscript(cliSessionId, 'user', msg.text, cwd)
    const holdOnce = HOLD_ONCE_MARKER && !fs.existsSync(HOLD_ONCE_MARKER)
    if (holdOnce) {
      fs.mkdirSync(path.dirname(HOLD_ONCE_MARKER), { recursive: true })
      fs.writeFileSync(HOLD_ONCE_MARKER, '1')
      return // wedged: running forever (busy-restart scenario)
    }
    if (HOLD_TURN) return
    const text = process.env.FAKE_CLAUDE_SIDECAR_ECHO_SETTINGS === '1'
      ? `Fixture claude turn (${model}, ${effort ?? 'default'}, ${permissionMode ?? 'default'})`
      : 'Fixture claude turn'
    appendTranscript(cliSessionId, 'assistant', text, cwd)
    emit({
      type: 'sdk.assistant',
      sessionId: msg.sessionId,
      content: [{ type: 'text', text }],
      model,
    })
    emit({ type: 'sdk.turn.complete', sessionId: msg.sessionId, subtype: 'success', at: Date.now() })
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'idle' })
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
