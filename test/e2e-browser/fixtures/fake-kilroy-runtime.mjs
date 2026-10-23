#!/usr/bin/env node
// HARNESS-06 fake Kilroy runtime — the harness-level "full Kilroy runtime"
// fixture (NOT the production Kilroy). Speaks the REAL claude-sidecar
// newline-JSON protocol verbatim (crates/freshell-claude-sidecar/index.mjs,
// doc comment lines 9-29) with kilroy flavour, so any harness that can drive a
// fresh-agent claude/kilroy sidecar can drive this one deterministically:
//
//   in : {"type":"create",protocol:2,requestId,cwd,model,permissionMode,effort,
//         boot:{kind:'fresh'}|{kind:'resume',resume}}  (protocol v2, crates/freshell-claude-sidecar/boot.mjs)
//        {"type":"send",sessionId,uuid,text} {"type":"interrupt",sessionId,stopId} {"type":"shutdown"}
//   out: {"type":"created","requestId","sessionId",protocol:2} FIRST (bare nanoid placeholder,
//        read_created discards any earlier sdk.* line), then:
//        sdk.session.init {sessionId,cliSessionId,model,cwd,tools:[]}
//        sdk.session.snapshot {sessionId,messages}   (resume only)
//        sdk.status {sessionId,status}               (running at a send; idle only after
//                                                  create and an interrupt with nothing
//                                                  in flight: a turn ends with its result)
//        sdk.permission.request {sessionId,requestId,subtype,tool}  (approval knob; before
//                                                  the assistant, then cancelled when the
//                                                  fake allows it on its own)
//        sdk.assistant {sessionId,content:[<blocks>],model}
//        sdk.result {sessionId,result,subtype,isError,terminalReason?,numTurns,…}
//                                                  the facts the server's verdict reads
//        sdk.interrupt_settled {sessionId,stopId,ok} (interrupt; the interrupted turn's
//                                                  own aborted sdk.result follows)
//
// Like the real sidecar (C18) it mints NO attention edge: the server rings
// every turn end itself from the results, minus the one the user's own Stop
// landed on, and mints the waiting edge from the pending approval.
//
// Every inbound request is appended to FAKE_KILROY_LOG as JSONL
// ({pid,t,msg}) BEFORE handling — "records Kilroy invocations".
//
// Knobs (env):
//   FAKE_KILROY_LOG                 JSONL request ledger path
//   FAKE_KILROY_CLI_SESSION_ID      fixed durable UUID (default: per-process random)
//   FAKE_KILROY_HOLD_TURN=1         send starts running and never completes on its
//                                   own (interrupt is the only turn exit)
//   FAKE_KILROY_APPROVAL=1          send surfaces an approval request first, then
//                                   allows it on its own after
//                                   FAKE_KILROY_APPROVAL_DELAY_MS (default 250)
//   FAKE_KILROY_FAIL_RESULT=1       the turn ends error_during_execution (a failed turn)
//   FAKE_KILROY_CRASH_ON_SEND=1     process.exit(3) mid-turn — no completion ever
//                                   (a real crash screams no protocol frame; the
//                                   server rings the death of an owed turn)
//
// Interrupt ends the TURN, never the session: NO sdk.exit, the session stays
// alive, and the NEXT turn runs as usual.

import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

const LOG = process.env.FAKE_KILROY_LOG
const HOLD_TURN = process.env.FAKE_KILROY_HOLD_TURN === '1'
const APPROVAL = process.env.FAKE_KILROY_APPROVAL === '1'
const APPROVAL_DELAY_MS = Number(process.env.FAKE_KILROY_APPROVAL_DELAY_MS ?? 250)
const FAIL_RESULT = process.env.FAKE_KILROY_FAIL_RESULT === '1'
const CRASH_ON_SEND = process.env.FAKE_KILROY_CRASH_ON_SEND === '1'
const CLI_SESSION_ID = process.env.FAKE_KILROY_CLI_SESSION_ID ?? randomUUID()
/** The result facts the real sidecar forwards for a turn a Stop landed on (T11). */
const STOPPED_RESULT = Object.freeze({ subtype: 'error_during_execution', isError: true, terminalReason: 'aborted_streaming', numTurns: 1 })
/** The result facts of a turn that ran to its end. */
const ENDED_RESULT = Object.freeze({ subtype: 'success', isError: false, terminalReason: 'completed', numTurns: 1 })
/** The result facts of a failed turn (FAKE_KILROY_FAIL_RESULT). */
const FAILED_RESULT = Object.freeze({ subtype: 'error_during_execution', isError: true, numTurns: 1, errorText: 'Fixture turn failed' })

/** One `sdk.result` frame with `facts`, in the real sidecar's shape. */
function resultFrame(sessionId, facts) {
  return { type: 'sdk.result', sessionId, result: facts.subtype, ...facts, durationMs: 1, costUsd: 0, usage: { input_tokens: 1, output_tokens: 1 } }
}

const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'
function nanoid(size = 21) {
  const bytes = randomBytes(size)
  let id = ''
  for (let i = 0; i < size; i++) id += NANOID_ALPHABET[bytes[i] & 63]
  return id
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function logRequest(msg) {
  if (!LOG) return
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, t: Date.now(), msg })}\n`)
}

// sessionId -> { cliSessionId, cwd, pendingResults, sendInFlight, interrupted }
const sessions = new Map()

/** Per-session turn bookkeeping: the turns owed a result, and the in-flight
 * and interrupt render flags. */
function sessionState(cliSessionId, cwd) {
  return { cliSessionId, cwd, pendingResults: 0, sendInFlight: false, interrupted: false }
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
  void handle(msg)
})

async function handle(msg) {
  if (msg.type === 'create') {
    const sessionId = msg.sessionId ?? nanoid()
    const resumeSessionId = msg.boot?.resume
    const cliSessionId = resumeSessionId ?? msg.sessionId ?? CLI_SESSION_ID
    const cwd = msg.cwd ?? process.cwd()
    sessions.set(sessionId, sessionState(cliSessionId, cwd))
    // `created` MUST be the first line written for this request.
    emit({ type: 'created', requestId: msg.requestId, sessionId, protocol: 2 })
    emit({
      type: 'sdk.session.init',
      sessionId,
      cliSessionId,
      model: msg.model ?? 'claude-opus-4-6',
      cwd,
      tools: [],
    })
    if (resumeSessionId) {
      emit({ type: 'sdk.session.snapshot', sessionId, messages: [] })
    }
    emit({ type: 'sdk.status', sessionId, status: 'idle' })
    return
  }

  if (msg.type === 'send') {
    const st = sessions.get(msg.sessionId) ?? sessionState(CLI_SESSION_ID, process.cwd())
    sessions.set(msg.sessionId, st)
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'running' })
    if (CRASH_ON_SEND) {
      process.stderr.write('[fake-kilroy] FAKE_KILROY_CRASH_ON_SEND: exiting 3 mid-turn\n')
      process.exit(3)
    }
    // A turn is owed until its result, so an interrupt arriving mid-render
    // ends it.
    st.pendingResults += 1
    if (HOLD_TURN) return // wedged mid-turn; interrupt is the only turn exit

    st.sendInFlight = true
    try {
      if (APPROVAL) {
        // The real sidecar's approval shape: the request (the server mints the
        // waiting edge from it), then the fake allows it on its own.
        const requestId = nanoid()
        emit({ type: 'sdk.permission.request', sessionId: msg.sessionId, requestId, subtype: 'can_use_tool', tool: { name: 'Bash', input: { command: 'ls' } } })
        await new Promise((r) => setTimeout(r, APPROVAL_DELAY_MS))
        emit({ type: 'sdk.permission.cancelled', sessionId: msg.sessionId, requestId })
      }

      emit({
        type: 'sdk.assistant',
        sessionId: msg.sessionId,
        content: [{ type: 'text', text: `kilroy fixture reply: ${msg.text}` }],
        model: 'claude-opus-4-6',
      })
      // An in-flight interrupt deferred to this scripted completion: the
      // interrupted turn's own result is the CLI's aborted shape (T11 — an
      // interrupted turn never ends 'success').
      const facts = st.interrupted ? STOPPED_RESULT : FAIL_RESULT ? FAILED_RESULT : ENDED_RESULT
      st.interrupted = false
      st.pendingResults = Math.max(0, st.pendingResults - 1)
      // The result ends the turn: no idle follows (the real sidecar sends none).
      emit(resultFrame(msg.sessionId, facts))
    } finally {
      st.sendInFlight = false
    }
    return
  }

  if (msg.type === 'interrupt') {
    const st = sessions.get(msg.sessionId)
    const settled = (fields) => emit({ type: 'sdk.interrupt_settled', sessionId: msg.sessionId, stopId: msg.stopId ?? null, ...fields })
    if (!st) {
      // Real-sidecar parity (index.mjs handleInterrupt): a session this fake
      // does not host settles ok:false.
      settled({ ok: false, message: 'Claude session is no longer available.' })
      return
    }
    if (st.pendingResults > 0) {
      // A turn is owed: settle ok:true (the receipt comes before the stopped
      // turn's result, sdk.d.ts:3765), then the stopped turn's own aborted
      // result. NEVER an sdk.exit: interrupt ends the TURN, never the session.
      st.pendingResults = 0
      st.interrupted = true
      settled({ ok: true, stillQueued: [] })
      if (st.sendInFlight) {
        // The scripted turn is still mid-render (the approval lane's await):
        // its completion lands next with the aborted result.
        return
      }
      // Held turn: nothing else will end it, so the stopped turn's own result
      // follows here. The result ends the turn (no idle follows).
      st.interrupted = false
      emit(resultFrame(msg.sessionId, STOPPED_RESULT))
      return
    }
    // Nothing owed: the SDK resolves an idle interrupt (sdk.d.ts:2384-2394).
    settled({ ok: true, stillQueued: [] })
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'idle' })
    return
  }

  if (msg.type === 'shutdown') {
    process.exit(0)
  }
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`[fake-kilroy] uncaught: ${err}\n`)
  process.exit(4)
})
