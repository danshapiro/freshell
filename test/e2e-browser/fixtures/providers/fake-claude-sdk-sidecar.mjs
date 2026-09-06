#!/usr/bin/env node
// HARNESS-03 deterministic fake Claude-SDK bridge sidecar — covers the
// checklist's "Kilroy/Claude-SDK" entry with ONE executable: both kilroy and
// freshclaude ride the claude provider's sidecar protocol
// (crates/freshell-freshagent/src/claude.rs), differing only in the
// sessionType flavour — select it via FRESHELL_FAKE_PROVIDER (default
// 'kilroy').
//
// Wire protocol (mirrors crates/freshell-claude-sidecar/index.mjs and the
// realism notes in fixtures/fake-claude-sidecar.mjs):
//   in : {"type":"create",requestId,cwd,model,permissionMode,effort,resumeSessionId}
//        {"type":"send",sessionId,text} {"type":"interrupt",sessionId} {"type":"shutdown"}
//        {"type":"permission.respond",sessionId,requestId,decision}
//        {"type":"question.respond",sessionId,requestId,answers}
//        {"type":"settings.update",sessionId,model?,permissionMode?,effort?}
//        (AGENT-12 mid-session knobs — the Rust server writes it immediately
//        BEFORE the send it applies to; the fake merges the presented knobs
//        onto the fake session state and echoes sdk.session.metadata)
//        out: {"type":"created",requestId,sessionId} FIRST (claude.rs read_created
//        discards any earlier line), then sdk.* frames:
//        sdk.session.init {cliSessionId: CANONICAL UUID}, sdk.status,
//        sdk.assistant (content MUST be an ARRAY), sdk.result {result} on EVERY
//        turn result + sdk.turn.complete (numeric `at`) ONLY on subtype
//        'success' (index.mjs:177-185 — the AGENTS.md invariant), sdk.permission.request
//        / sdk.question.request (server sdk-bridge-types.ts shapes),
//        sdk.permission.cancelled / sdk.question.cancelled (interrupt-time
//        pending cancellation, the real sidecar's cancelPending —
//        index.mjs:289-295), sdk.turn.waiting (0→≥1 pending edge),
//        sdk.session.metadata {sessionId, cliSessionId, model} (the post-apply
//        settings.update echo — the Rust consumer re-normalizes it to
//        freshAgent.session.metadata),
//        sdk.session.snapshot (resume).
//
// Turn semantics: `send` ALWAYS opens with sdk.status running (bookkeeping the
// real bridge performs unconditionally); a matching program rule then owns
// the turn; when no rule emitted completion/crash — AND no approval/question
// parked the turn — the canned assistant+turn.complete+idle success turn
// closes it. A turn that raised an approval/question PARKS: it stays open
// until a matching permission.respond/question.respond (or interrupt) arrives,
// exactly like the real sidecar's parked canUseTool promise.
//
// Respond arms (AGENT-05/06 e2e): permission.respond/question.respond are
// routed into the program engine (decision points `msg:permission.respond` /
// `msg:question.respond` — e.g. a `kind:'completion'` emission continues the
// turn). Each respond REMOVES the tracked pending entry and DECREMENTS the
// per-session pending counter, so a later raise re-crosses 0→≥1 and
// `sdk.turn.waiting` re-fires. Unknown requestIds are lose-safely ignored
// (the Rust dispatch validates against its own pending set first).
//
// Interrupt semantics: every parked entry gets ONE sdk.permission.cancelled /
// sdk.question.cancelled frame, the pending counter resets, and the turn ends
// with sdk.status idle — NEVER an sdk.exit (the real sidecar keeps the session
// alive across interrupt; AGENT-03's interrupt/kill separation).
//
// Raw-stdin audit (AGENT-05/06 e2e): when FRESHELL_FAKE_STDIN=<path> is set,
// EVERY raw stdin line is appended there as a JSONL row {t, pid, line} —
// the spec's ground truth for "the exact respond/compact frames the Rust
// server wrote to the sidecar" and for zero-before-click proofs.
// (FRESHELL_FAKE_* keys are auto-recorded into the launch ledger.)
//
// Wire-truth completion invariant (AGENTS.md; real sidecar index.mjs:177-185):
// a closing turn emits `sdk.result{result:<subtype>}` ALWAYS and the positive
// completion edge `sdk.turn.complete{sessionId,at}` ONLY on subtype
// 'success' — a denied/errored turn must NEVER chime green through the
// Rust `sdk.turn.complete → freshAgent.turn.complete` rename (D1-F2; the
// pre-fix fixture emitted turn.complete on every completion, fabricating a
// success the real sidecar structurally cannot).
//
// Wire audit (D1-F2): every OUTBOUND frame is ALSO recorded into the
// FRESHELL_FAKE_EVENTS ledger as a `{t,pid,provider,kind:'wire',frame}` row,
// so specs assert on what actually crossed stdout (e.g. the ABSENCE of
// sdk.turn.complete on a denied turn) instead of trusting the program
// emission ledger alone. Program rows and wire rows coexist there; filter on
// `kind === 'wire'` for wire truth (event-kind consumers see no shape change).
//
// Transcript realism (AGENT-05 reload-while-pending): the cards render
// EXCLUSIVELY from the REST snapshot, which 404s without a durable transcript
// — so `create` ensures an EMPTY JSONL transcript at
// <claudeHome>/projects/<cwd-mangled>/<cliSessionId>.jsonl, every `send`
// appends one {"type":"user", cwd, message:{role,content:[{type:'text',text}]}}
// entry, and every completion appends the matching assistant entry. The line
// shape mirrors `parse_transcript_turns`' accepted shape
// (crates/freshell-freshagent/src/claude_snapshot.rs:367-420); the cwd
// mangling (`[^A-Za-z0-9]` → '-') mirrors the real CLI's project-dir slug —
// though the Rust locator scans EVERY projects dir, so only the filename
// portion (the canonical cliSessionId) is load-bearing. claudeHome resolves
// CLAUDE_CONFIG_DIR > CLAUDE_HOME > ~/.claude, the same candidate order the
// Rust server uses; the sidecar inherits the harness's isolated HOME.
//
// The process stays alive until `shutdown` (exit 0), a scripted `crash`
// (exit code), or kill — an early exit would stop the server-side consumer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import { appendJsonl, appendLaunchLedger, EVENTS_ENV, FixtureEngine, keepAlive, loadProgram } from './fixture-core.mjs'

const provider = process.env.FRESHELL_FAKE_PROVIDER ?? 'kilroy'
const env = process.env
appendLaunchLedger({ provider, argv: process.argv.slice(2), env })
const program = loadProgram(env)

// AGENT-05/06 e2e audit: one JSONL row per RAW stdin line, before parsing —
// a malformed line is audited too, and the spec never has to trust the
// fixture's own parse to prove what the server wrote.
const STDIN_LOG = env.FRESHELL_FAKE_STDIN

// bridge sessionId -> { cliSessionId, cwd, model, permissionMode, effort, pending, pendingEntries }
// (model/permissionMode/effort are the settings knob baseline: seeded at
// create, merged per settings.update — an absent knob carries the stored
// baseline forward, so the echoed sdk.session.metadata never fabricates a value)
const sessions = new Map()
let activeSessionId = null
let createCounter = 0

function emit(obj) {
  // Wire audit (D1-F2, see the header): record the ACTUAL outbound frame so
  // specs assert on wire truth (what crossed stdout), not just program intent.
  appendJsonl(env[EVENTS_ENV], { t: Date.now(), pid: process.pid, provider, kind: 'wire', frame: obj })
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function claudeHome() {
  // Candidate order matches the Rust `claude_home_candidates` (ledger A3).
  return (
    env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || path.join(os.homedir(), '.claude')
  )
}

function mangleCwd(cwd) {
  return String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-')
}

function transcriptPath(cliSessionId, cwd) {
  return path.join(claudeHome(), 'projects', mangleCwd(cwd), `${cliSessionId}.jsonl`)
}

/** Append one transcript line in parse_transcript_turns' accepted shape. */
function appendTranscript(cliSessionId, cwd, role, text) {
  const line = {
    type: role,
    timestamp: new Date().toISOString(),
    cwd: cwd ?? process.cwd(),
    message: { role, content: [{ type: 'text', text }] },
  }
  appendJsonl(transcriptPath(cliSessionId, cwd), line)
}

// ── pending-request tracking (mirrors the real sidecar's permission-channel) ──
/** Waiting edge on the 0→>=1 pending transition (sdk-bridge.ts emitWaitingEdge). */
function waitingEdgeIfFirstPending(sessionId) {
  const st = sessions.get(sessionId)
  if (!st) return
  if (st.pending === 0) {
    emit({ type: 'sdk.turn.waiting', sessionId, at: Date.now() })
  }
  st.pending += 1
}

function trackPending(sessionId, kind, requestId) {
  const st = sessions.get(sessionId)
  if (!st) return
  st.pendingEntries.push({ kind, requestId })
}

/**
 * Resolve ONE parked request (permission.respond/question.respond): drop the
 * tracked entry and decrement the counter so a later raise re-fires the
 * 0→≥1 waiting edge. Unknown requestIds are a lose-safely no-op — the
 * decrement is gated on having actually resolved a tracked entry, or a
 * foreign respond would desync pending vs pendingEntries and let the next
 * raise spuriously re-fire the waiting edge (task-008-review N-2).
 */
function resolvePending(sessionId, kind, requestId) {
  const st = sessions.get(sessionId)
  if (!st) return
  const idx = st.pendingEntries.findIndex(
    (entry) => entry.kind === kind && entry.requestId === String(requestId),
  )
  if (idx === -1) return
  st.pendingEntries.splice(idx, 1)
  if (st.pending > 0) st.pending -= 1
}

async function render(event) {
  const { kind, data } = event
  const sessionId = data.sessionId ?? activeSessionId
  switch (kind) {
    case 'session':
      emit({
        type: 'sdk.session.init',
        sessionId,
        cliSessionId: data.cliSessionId,
        model: data.model ?? 'fixture-model',
        cwd: data.cwd ?? process.cwd(),
        tools: [],
      })
      break
    case 'resume':
      emit({ type: 'sdk.session.snapshot', sessionId, messages: data.messages ?? [] })
      break
    case 'activity':
      emit({ type: 'sdk.status', sessionId, status: data.status ?? 'running' })
      break
    case 'approval': {
      waitingEdgeIfFirstPending(sessionId)
      const input = typeof data.input === 'object' && data.input !== null ? data.input : { command: data.input }
      const requestId = String(data.id ?? `perm-${randomUUID()}`)
      trackPending(sessionId, 'permission', requestId)
      emit({
        type: 'sdk.permission.request',
        sessionId,
        requestId,
        subtype: 'can_use_tool',
        tool: { name: data.tool ?? 'Bash', input },
      })
      break
    }
    case 'question': {
      waitingEdgeIfFirstPending(sessionId)
      const questions = Array.isArray(data.questions)
        ? data.questions
        : [{ question: data.text ?? '', header: 'Fixture', options: [], multiSelect: false }]
      const requestId = String(data.id ?? `q-${randomUUID()}`)
      trackPending(sessionId, 'question', requestId)
      emit({
        type: 'sdk.question.request',
        sessionId,
        requestId,
        questions,
      })
      break
    }
    case 'completion': {
      emit({
        type: 'sdk.assistant',
        sessionId,
        content: [{ type: 'text', text: data.text ?? 'Fixture turn' }],
        model: 'fixture-model',
      })
      const st = sessions.get(sessionId)
      if (st) appendTranscript(st.cliSessionId, st.cwd, 'assistant', data.text ?? 'Fixture turn')
      const subtype = data.subtype ?? 'success'
      // AGENTS.md invariant (real sidecar index.mjs:177-185): sdk.result rides
      // EVERY turn result; sdk.turn.complete is the positive edge ONLY on
      // subtype 'success' — a denied/errored turn NEVER chimes green (D1-F2).
      emit({ type: 'sdk.result', sessionId, result: subtype })
      if (subtype === 'success') {
        emit({ type: 'sdk.turn.complete', sessionId, at: Date.now() })
      }
      emit({ type: 'sdk.status', sessionId, status: 'idle' })
      break
    }
    case 'marker':
      if (data.signal === 'interrupt') {
        emit({ type: 'sdk.exit', sessionId })
        emit({ type: 'sdk.status', sessionId, status: 'idle' })
      }
      break
    case 'crash':
      // A real crash screams no protocol frame; the ledger holds the record.
      break
    default:
      break
  }
}

const engine = new FixtureEngine({
  provider,
  program,
  env,
  write: (event) => render(event),
})

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  appendJsonl(STDIN_LOG, { t: Date.now(), pid: process.pid, line })
  void handleInput(line).catch((err) => {
    emit({ type: 'sdk.error', sessionId: activeSessionId, message: String(err?.message ?? err) })
  })
})

async function handleInput(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.type === 'create') {
    createCounter += 1
    const sessionId = `${provider}-fake-${process.pid}-${createCounter}`
    activeSessionId = sessionId
    const cliSessionId = msg.resumeSessionId ?? program.sessionId ?? randomUUID()
    const cwd = msg.cwd ?? process.cwd()
    sessions.set(sessionId, {
      cliSessionId,
      cwd,
      model: msg.model ?? 'fixture-model',
      permissionMode: msg.permissionMode,
      effort: msg.effort,
      pending: 0,
      pendingEntries: [],
    })
    // A durable transcript EXISTS from create on (the reload-while-pending
    // snapshot route reads it before any turn completes) — touch, no bogus row.
    const transcript = transcriptPath(cliSessionId, cwd)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.closeSync(fs.openSync(transcript, 'a'))
    // created FIRST — a real consumer discards anything earlier.
    emit({ type: 'created', requestId: msg.requestId, sessionId })
    const emitted = await engine.handleMessage(msg)
    if (emitted.has('crash')) return
    if (!emitted.has('session')) {
      await engine.emitEvent(
        'session',
        { cliSessionId, model: msg.model ?? 'fixture-model', cwd },
        'msg:create:default',
      )
    }
    if (msg.resumeSessionId) {
      await engine.emitResume(cliSessionId)
    }
    emit({ type: 'sdk.status', sessionId, status: 'idle' })
  } else if (msg.type === 'send') {
    activeSessionId = msg.sessionId ?? activeSessionId
    const st = sessions.get(msg.sessionId)
    if (st) appendTranscript(st.cliSessionId, st.cwd, 'user', msg.text)
    // Turn-open bookkeeping is unconditional (the real bridge always goes busy).
    await engine.emitEvent('activity', { status: 'running' }, 'msg:send:open')
    const emitted = await engine.handleMessage(msg)
    if (emitted.has('crash')) return
    // A turn that raised an approval/question PARKS until the matching
    // respond (or an interrupt) arrives — the canned success turn must NOT
    // close it early, or the card would clear with an invented resolution.
    if (emitted.has('completion') || emitted.has('approval') || emitted.has('question')) return
    await engine.emitEvent('completion', { subtype: 'success' }, 'msg:send:default')
  } else if (
    msg.type === 'permission.respond'
    || msg.type === 'question.respond'
  ) {
    activeSessionId = msg.sessionId ?? activeSessionId
    const kind = msg.type === 'question.respond' ? 'question' : 'permission'
    resolvePending(msg.sessionId, kind, msg.requestId)
    const emitted = await engine.handleMessage(msg)
    if (emitted.has('crash')) return
  } else if (msg.type === 'settings.update') {
    // AGENT-12 mid-session knobs (per-send settings): the Rust server writes
    // this frame immediately BEFORE the send it applies to (stdin line order
    // + the serialized per-session op chain are the ordering guarantee).
    // Merge the presented knobs onto the fake session state — an omitted knob
    // carries the stored baseline forward — then echo the real sidecar's
    // post-apply sdk.session.metadata over stdout (the Rust consumer
    // re-normalizes it to freshAgent.session.metadata). The echo rides emit(),
    // so it lands in the FRESHELL_FAKE_EVENTS ledger as a kind:'wire' row —
    // the spec asserts on what actually crossed stdout. An unknown session id
    // is a lose-safe no-op (same posture as an unknown respond). Every OTHER
    // unknown type still falls through silently below.
    activeSessionId = msg.sessionId ?? activeSessionId
    const st = sessions.get(msg.sessionId)
    if (st) {
      if (typeof msg.model === 'string') st.model = msg.model
      if (typeof msg.permissionMode === 'string') st.permissionMode = msg.permissionMode
      if (typeof msg.effort === 'string') st.effort = msg.effort
      emit({
        type: 'sdk.session.metadata',
        sessionId: msg.sessionId,
        cliSessionId: st.cliSessionId,
        model: st.model,
      })
    }
  } else if (msg.type === 'interrupt') {
    activeSessionId = msg.sessionId ?? activeSessionId
    const st = sessions.get(msg.sessionId)
    if (st) {
      // Mirror the real sidecar's interrupt path (index.mjs:289-295 — the
      // transport is still open, so cancelPending emits one cancel frame per
      // parked entry, never a fabricated user respond), then NO sdk.exit:
      // interrupt ends the TURN, never the session (AGENT-03).
      for (const entry of st.pendingEntries.splice(0)) {
        emit({
          type: entry.kind === 'question' ? 'sdk.question.cancelled' : 'sdk.permission.cancelled',
          sessionId: msg.sessionId,
          requestId: entry.requestId,
        })
      }
      st.pending = 0
    }
    const emitted = await engine.handleMessage(msg)
    if (emitted.has('crash')) return
    if (!emitted.has('activity') && !emitted.has('marker')) {
      await engine.emitEvent('activity', { status: 'idle' }, 'msg:interrupt:idle')
    }
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
}

keepAlive()
