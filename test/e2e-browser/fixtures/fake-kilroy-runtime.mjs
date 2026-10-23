#!/usr/bin/env node
// HARNESS-06 fake Kilroy runtime — the harness-level "full Kilroy runtime"
// fixture (NOT the production Kilroy). Speaks the REAL claude-sidecar
// newline-JSON protocol verbatim (crates/freshell-claude-sidecar/index.mjs,
// doc comment lines 9-29) with kilroy flavour, so any harness that can drive a
// fresh-agent claude/kilroy sidecar can drive this one deterministically:
//
//   in : {"type":"create",protocol:2,requestId,cwd,model,permissionMode,effort,
//         boot:{kind:'fresh'}|{kind:'resume',resume}}  (protocol v2, crates/freshell-claude-sidecar/boot.mjs)
//        {"type":"send",sessionId,text} {"type":"interrupt",sessionId} {"type":"shutdown"}
//   out: {"type":"created","requestId","sessionId",protocol:2} FIRST (bare nanoid placeholder,
//        read_created discards any earlier sdk.* line), then:
//        sdk.session.init {sessionId,cliSessionId,model,cwd,tools:[]}
//        sdk.session.snapshot {sessionId,messages}   (resume only)
//        sdk.status {sessionId,status}               (running at a send; idle only after
//                                                  create and an interrupt with nothing
//                                                  in flight: a turn ends with its result)
//        sdk.turn.waiting {sessionId,at}             (approval edge; before assistant)
//        sdk.assistant {sessionId,content:[<blocks>],model}
//        sdk.result {sessionId,result:<subtype>,durationMs,costUsd,usage}
//        sdk.turn.complete {sessionId,at}            on EVERY result subtype — success,
//                                                  error, … — EXCEPT the stopped turn's
//                                                  own aborted result under a pending
//                                                  accepted user-interrupt mark
//                                                  (the REAL gate, imported from
//                                                  crates/freshell-claude-sidecar/)
//        sdk.interrupt_settled {sessionId,ok}        (interrupt; the interrupted turn's
//                                                  own non-success sdk.result follows)
//
// Every inbound request is appended to FAKE_KILROY_LOG as JSONL
// ({pid,t,msg}) BEFORE handling — "records Kilroy invocations".
//
// Knobs (env):
//   FAKE_KILROY_LOG                 JSONL request ledger path
//   FAKE_KILROY_CLI_SESSION_ID      fixed durable UUID (default: per-process random)
//   FAKE_KILROY_HOLD_TURN=1         send starts running and never completes on its
//                                   own (interrupt is the only turn exit; its result
//                                   is consumed by the armed gate)
//   FAKE_KILROY_APPROVAL=1          send surfaces sdk.turn.waiting first, then
//                                   auto-allows after FAKE_KILROY_APPROVAL_DELAY_MS
//                                   (default 250) — the real sidecar's waiting-edge
//                                   shape ("surfaced, then allowed")
//   FAKE_KILROY_FAIL_RESULT=1       result subtype 'error' — rings the unified
//                                   attention edge like any error turn end
//   FAKE_KILROY_CRASH_ON_SEND=1     process.exit(3) mid-turn — no completion ever
//                                   (a real crash screams no protocol frame; the
//                                   Rust unrequested-death synthesis rings for it)
//
// Turn semantics mirror the real sidecar exactly: sdk.result carries the
// subtype in `result`; the unified attention edge `sdk.turn.complete` fires on
// EVERY result subtype unless the REAL gate's pending accepted user-interrupt
// mark silences it as the stopped turn's aborted result (an interrupt arms the mark only while a turn is awaiting a
// terminal frame; the settle is ok:true — the SDK contract documents
// RESOLUTION, not rejection — and the interrupted turn's own NON-SUCCESS
// result follows, silently). Interrupt ends the TURN, never the session: NO
// sdk.exit, the session stays alive, and the NEXT turn rings again. `at`
// clocks are per-session monotonic via the sidecar package's shared
// monotonic-clock.mjs (never go backwards, strictly increasing across
// same-ms edges).

import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createTurnCompleteGate } from '../../../crates/freshell-claude-sidecar/turn-complete-gate.mjs'
import { nextMonotonic } from '../../../crates/freshell-claude-sidecar/monotonic-clock.mjs'

const LOG = process.env.FAKE_KILROY_LOG
const HOLD_TURN = process.env.FAKE_KILROY_HOLD_TURN === '1'
const APPROVAL = process.env.FAKE_KILROY_APPROVAL === '1'
const APPROVAL_DELAY_MS = Number(process.env.FAKE_KILROY_APPROVAL_DELAY_MS ?? 250)
const FAIL_RESULT = process.env.FAKE_KILROY_FAIL_RESULT === '1'
const CRASH_ON_SEND = process.env.FAKE_KILROY_CRASH_ON_SEND === '1'
const CLI_SESSION_ID = process.env.FAKE_KILROY_CLI_SESSION_ID ?? randomUUID()
/** The SDK result the pinned CLI reports for a turn a Stop landed on (T11). */
const STOPPED_RESULT = Object.freeze({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' })

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

// sessionId -> { cliSessionId, cwd, lastTurnCompleteAt?, lastWaitingAt?,
//                turnCompleteGate, pendingResults, turnOpen, sendInFlight,
//                interrupted }
const sessions = new Map()

/** Unified per-session attention bookkeeping (mirrors the real sidecar and
 * the claude-SDK e2e fake): the REAL gate, the accepted-sends counter, the
 * last minted monotonic `at`, and the in-flight/interrupt render flags. */
function unifiedSessionState(cliSessionId, cwd) {
  return {
    cliSessionId,
    cwd,
    turnCompleteGate: createTurnCompleteGate(),
    pendingResults: 0,
    turnOpen: false,
    sendInFlight: false,
    interrupted: false,
  }
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
    const sessionId = nanoid()
    const resumeSessionId = msg.boot?.resume
    const cliSessionId = resumeSessionId ?? CLI_SESSION_ID
    const cwd = msg.cwd ?? process.cwd()
    sessions.set(sessionId, unifiedSessionState(cliSessionId, cwd))
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
    const st = sessions.get(msg.sessionId) ?? unifiedSessionState(CLI_SESSION_ID, process.cwd())
    sessions.set(msg.sessionId, st)
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'running' })
    if (CRASH_ON_SEND) {
      process.stderr.write('[fake-kilroy] FAKE_KILROY_CRASH_ON_SEND: exiting 3 mid-turn\n')
      process.exit(3)
    }
    // The send is ACCEPTED (mirrors the real sidecar's pendingResults
    // bookkeeping): a turn is open until its terminal frame, so an interrupt
    // arriving mid-render arms the REAL gate against it.
    st.pendingResults += 1
    st.turnOpen = true
    if (HOLD_TURN) return // wedged mid-turn; interrupt is the only turn exit

    st.sendInFlight = true
    try {
      if (APPROVAL) {
        const at = nextMonotonic(st.lastWaitingAt, Date.now())
        st.lastWaitingAt = at
        emit({ type: 'sdk.turn.waiting', sessionId: msg.sessionId, at })
        await new Promise((r) => setTimeout(r, APPROVAL_DELAY_MS))
      }

      emit({
        type: 'sdk.assistant',
        sessionId: msg.sessionId,
        content: [{ type: 'text', text: `kilroy fixture reply: ${msg.text}` }],
        model: 'claude-opus-4-6',
      })
      // An in-flight interrupt deferred to this scripted completion: the
      // interrupted turn's own terminal result is the CLI's aborted shape (T11
      // — an interrupted turn never ends 'success').
      const result = st.interrupted
        ? STOPPED_RESULT
        : { type: 'result', subtype: FAIL_RESULT ? 'error' : 'success' }
      st.interrupted = false
      st.pendingResults = Math.max(0, st.pendingResults - 1)
      emit({
        type: 'sdk.result',
        sessionId: msg.sessionId,
        result: result.subtype,
        durationMs: 1,
        costUsd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      // Unified attention edge (the REAL gate): every result rings except the
      // stopped turn's own aborted result under a pending accepted
      // user-interrupt mark. The `at`
      // clamps through the sidecar package's shared monotonic clock — two
      // same-ms edges stay strictly increasing or the client's `at <= last`
      // dedupe silently drops the second ring.
      if (st.turnCompleteGate.resultEmitsAttention(result)) {
        const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
        st.lastTurnCompleteAt = at
        emit({ type: 'sdk.turn.complete', sessionId: msg.sessionId, at })
      }
      // The result ends the turn: no idle follows (the real sidecar sends none).
      st.turnOpen = false
    } finally {
      st.sendInFlight = false
    }
    return
  }

  if (msg.type === 'interrupt') {
    const st = sessions.get(msg.sessionId)
    if (!st) {
      // Real-sidecar parity (index.mjs handleInterrupt): an interrupt against
      // an unknown session is a session-scoped error frame, never a silent
      // drop.
      emit({ type: 'sdk.error', sessionId: msg.sessionId, message: 'session not found', sessionNotFound: true })
      return
    }
    if (st.pendingResults > 0) {
      // A turn is plausibly awaiting a terminal frame — arm the REAL gate
      // BEFORE the "interrupt()" call (real-sidecar parity:
      // `if (st.pendingResults > 0) st.turnCompleteGate.noteInterruptRequest()`),
      // then settle ok:true (the SDK contract documents RESOLUTION, not
      // rejection, for interrupting — sdk.d.ts:2384-2394). The interrupted
      // turn's own NON-SUCCESS result follows with its ring consumed by the
      // mark — the interrupt stays silent while the next turn rings again.
      // NEVER an sdk.exit: interrupt ends the TURN, never the session.
      st.turnCompleteGate.noteInterruptRequest()
      st.pendingResults = 0
      // Force the interrupted turn's eventual completion to the non-success
      // subtype (the real SDK contract — an interrupted turn never ends
      // 'success'), for BOTH exits below: the deferred in-flight render and
      // the synthesized held-turn result.
      st.interrupted = true
      emit({ type: 'sdk.interrupt_settled', sessionId: msg.sessionId, ok: true })
      if (st.sendInFlight) {
        // The scripted turn is still mid-render (the approval lane's await):
        // its completion lands next with the forced non-success subtype and
        // the gate-consumed ring — do not synthesize a second terminal frame.
        return
      }
      // Held turn: nothing else will end it, so synthesize the interrupted
      // turn's own non-success terminal result — the armed gate consumes its
      // ring. The result ends the turn (no idle follows). Still NEVER an sdk.exit.
      st.interrupted = false
      st.turnOpen = false
      emit({ type: 'sdk.result', sessionId: msg.sessionId, result: STOPPED_RESULT.subtype })
      st.turnCompleteGate.resultEmitsAttention(STOPPED_RESULT)
      return
    }
    // No turn awaits a terminal frame — the SDK RESOLVES an idle-session
    // interrupt, so the settle lands ok:true and NOTHING arms: no stray mark
    // may survive to eat the NEXT unrelated turn's ring.
    emit({ type: 'sdk.interrupt_settled', sessionId: msg.sessionId, ok: true })
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
