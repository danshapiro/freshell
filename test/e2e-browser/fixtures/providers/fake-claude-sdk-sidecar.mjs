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
//   in : {"type":"create",protocol:2,requestId,cwd,model,permissionMode,effort,
//         boot:{kind:'fresh'}|{kind:'resume',resume}|{kind:'fork',resume,resumeSessionAt?,dropsTurn?}}
//        (protocol v2, crates/freshell-claude-sidecar/boot.mjs; kata 1wxv fork-at-point:
//        a fork boot of `resume` at resumeSessionAt
//        mints a NEW durable cliSessionId and writes the parent's transcript PREFIX
//        through the addressed uuid verbatim; a dropsTurn guard that is NOT the
//        raw-chain successor of the resume point refuses with the SDK-documented
//        "Resume rejected by --resume-drops-turn:" prefix — NO init, NO durable session;
//        plain resume keeps the same-id behavior)
//        {"type":"send",sessionId,text} {"type":"interrupt",sessionId} {"type":"shutdown"}
//        {"type":"permission.respond",sessionId,requestId,decision}
//        {"type":"question.respond",sessionId,requestId,answers}
//        out: {"type":"created",requestId,sessionId,protocol:2} FIRST (claude_handshake.rs
//        discards any earlier line), then sdk.* frames:
//        sdk.session.init {cliSessionId: CANONICAL UUID}, sdk.status,
//        sdk.assistant (content MUST be an ARRAY), sdk.result {result} on EVERY
//        turn result + sdk.turn.complete (numeric `at`) on EVERY result subtype
//        EXCEPT the interrupted turn's own (the accepted-interrupt mark consumes
//        it — the REAL gate, imported from crates/freshell-claude-sidecar/
//        turn-complete-gate.mjs), sdk.permission.request
//        / sdk.question.request (server sdk-bridge-types.ts shapes),
//        sdk.permission.cancelled / sdk.question.cancelled (interrupt-time
//        pending cancellation, the real sidecar's cancelPending —
//        index.mjs:289-295), sdk.turn.waiting (0→≥1 pending edge),
//        sdk.session.snapshot (resume).
//
// Turn semantics: `send` ALWAYS opens with sdk.status running (bookkeeping the
// real bridge performs unconditionally); a matching program rule then owns
// the turn; when no rule emitted completion/crash — AND no approval/question
// parked the turn — the canned assistant+result+turn.complete success turn
// closes it. Like the real sidecar, a turn ends with its result alone: there
// is no per-turn idle (the real sidecar sends no idle at all).
// A turn that raised an approval/question PARKS: it stays open
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
// sdk.question.cancelled frame and the pending counter resets. The arm
// condition mirrors the real sidecar exactly: a turn plausibly awaiting a
// terminal frame (pendingResults > 0) arms the gate BEFORE the "interrupt()"
// call, the settle is ok:true, and the interrupted turn's own NON-SUCCESS
// sdk.result follows (the real SDK contract orders the receipt BEFORE the
// result — sdk.d.ts:3765); the armed gate consumes that result's ring, so an
// interrupt stays silent while the next turn rings again. With NOTHING
// pending the settle is STILL ok:true — the SDK contract documents
// RESOLUTION, not rejection, for interrupting with nothing in flight
// (sdk.d.ts:2384-2394; the real sidecar's ok:false 'no in-flight SDK query'
// shape fires only when the SDK surface lacks the interrupt method entirely)
// — and NOTHING arms, so no stray mark survives to eat the NEXT unrelated
// turn's ring. Either way it is NEVER an sdk.exit (the real sidecar keeps the
// session alive across interrupt; AGENT-03's interrupt/kill separation).
//
// Raw-stdin audit (AGENT-05/06 e2e): when FRESHELL_FAKE_STDIN=<path> is set,
// EVERY raw stdin line is appended there as a JSONL row {t, pid, line} —
// the spec's ground truth for "the exact respond/compact frames the Rust
// server wrote to the sidecar" and for zero-before-click proofs.
// (FRESHELL_FAKE_* keys are auto-recorded into the launch ledger.)
//
// Wire-truth completion invariant (unified needs-attention contract; the REAL
// gate imported above): a closing turn emits `sdk.result{result:<subtype>}`
// ALWAYS and the attention edge `sdk.turn.complete{sessionId,at}` on EVERY
// subtype — success, error, max-turns, denied — EXCEPT the stopped turn's own
// aborted result under a pending accepted user-interrupt mark (the user's own
// interrupt never rings).
// The `stream-error` lane models the real sidecar's end of stream (its
// consumeStream finally): cancel the parked cards, the finally-minted edge for
// a turn that ends with no result, then
// `sdk.stream.ended {reason, message}` as the LAST line and exit code 3 (each
// sidecar hosts one session, so its stream's end is the sidecar's end). The
// Rust server reports the exit (SIDECAR_EXITED) and, because the end was
// reported, does not ring again. The `crash` lane stays as-is (a real Node
// death screams no protocol frame and exits — the Rust unrequested-death
// synthesis rings for it, and an edge from the crash lane would double-ring).
//
// Wire audit (D1-F2): every OUTBOUND frame is ALSO recorded into the
// FRESHELL_FAKE_EVENTS ledger as a `{t,pid,provider,kind:'wire',frame}` row,
// so specs assert on what actually crossed stdout (e.g. the unified
// sdk.turn.complete edge ringing for a denied/errored turn) instead of
// trusting the program emission ledger alone. Program rows and wire rows
// coexist there; filter on `kind === 'wire'` for wire truth (event-kind
// consumers see no shape change).
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
// (exit code), a `stream-error` (exit 3), or kill.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import { appendJsonl, appendLaunchLedger, EVENTS_ENV, FixtureEngine, keepAlive, loadProgram } from './fixture-core.mjs'
import { createTurnCompleteGate } from '../../../../crates/freshell-claude-sidecar/turn-complete-gate.mjs'
import { nextMonotonic } from '../../../../crates/freshell-claude-sidecar/monotonic-clock.mjs'

const provider = process.env.FRESHELL_FAKE_PROVIDER ?? 'kilroy'
/** The real sidecar's exit code after its SDK stream ends (stream-end.mjs). */
const STREAM_ENDED_EXIT_CODE = 3
/** Set by the stream-error lane: the fake is exiting and reads no more requests. */
let exiting = false
/** The SDK result the pinned CLI reports for a turn a Stop landed on (T11). */
const STOPPED_RESULT = Object.freeze({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' })
const env = process.env
appendLaunchLedger({ provider, argv: process.argv.slice(2), env })
const program = loadProgram(env)

// AGENT-05/06 e2e audit: one JSONL row per RAW stdin line, before parsing —
// a malformed line is audited too, and the spec never has to trust the
// fixture's own parse to prove what the server wrote.
const STDIN_LOG = env.FRESHELL_FAKE_STDIN

// bridge sessionId -> { cliSessionId, cwd, pending, pendingEntries }
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

// kata 1wxv Task 7 (fork-at-point): the rollback resume math runs over the RAW
// parentUuid chain, so every appended transcript line now carries a real
// uuid + parentUuid backbone, chained per cliSessionId (the real CLI's shape).
const lastUuidBySession = new Map()

/**
 * Append one transcript line in parse_transcript_turns' accepted shape. A
 * user line takes the send's own uuid when the server gave one: the real CLI
 * writes the prompt under the uuid of its SDKUserMessage, which is the turn
 * id the server announced as submittedTurnId.
 */
function appendTranscript(cliSessionId, cwd, role, text, transcriptOverride, lineUuid) {
  const parentUuid = lastUuidBySession.get(cliSessionId) ?? null
  const uuid = typeof lineUuid === 'string' && lineUuid ? lineUuid : randomUUID()
  lastUuidBySession.set(cliSessionId, uuid)
  const line = {
    type: role,
    uuid,
    parentUuid,
    timestamp: new Date().toISOString(),
    cwd: cwd ?? process.cwd(),
    message: { role, content: [{ type: 'text', text }] },
  }
  appendJsonl(transcriptOverride ?? transcriptPath(cliSessionId, cwd), line)
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
      const st = sessions.get(sessionId)
      // Real-sidecar parity (index.mjs handleSdkMessage drops the whole
      // message for a missing session): a completion targeting a session
      // that no longer exists (e.g. after the stream-error lane's teardown)
      // is dropped ENTIRELY — no assistant, no result, no edge, no idle.
      // The fake must not invent frames the real sidecar never emits.
      if (!st) return
      emit({
        type: 'sdk.assistant',
        sessionId,
        content: [{ type: 'text', text: data.text ?? 'Fixture turn' }],
        model: st.settings.model ?? 'fixture-model',
      })
      appendTranscript(st.cliSessionId, st.cwd, 'assistant', data.text ?? 'Fixture turn', st.transcriptOverride)
      // An in-flight interrupt deferred to this scripted completion: the
      // interrupted turn's own terminal result is the CLI's aborted shape
      // (T11 — an interrupted turn never ends 'success').
      const result = st.interrupted
        ? STOPPED_RESULT
        : { type: 'result', subtype: data.subtype ?? 'success' }
      st.interrupted = false
      st.pendingResults = Math.max(0, st.pendingResults - 1)
      emit({ type: 'sdk.result', sessionId, result: result.subtype })
      // Unified attention edge (the REAL gate): every result rings except the
      // stopped turn's own aborted result under a pending accepted user
      // interrupt mark. The `at` mint clamps through the REAL sidecar's shared
      // clock (monotonic-clock.mjs) — two same-ms edges stay strictly
      // increasing, or the client's `at <= last` dedupe silently drops the
      // second ring.
      if (st.turnCompleteGate.resultEmitsAttention(result)) {
        const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
        st.lastTurnCompleteAt = at
        emit({ type: 'sdk.turn.complete', sessionId, at })
      }
      st.turnOpen = false
      break
    }
    case 'stream-error': {
      // The real sidecar's end of stream (index.mjs consumeStream finally):
      // cancel every parked entry, mint the unified attention edge (a turn
      // ended with NO result frame: pendingResults > 0; a pending Stop mark
      // never silences a result-less end), then sdk.stream.ended as the LAST
      // line and exit code 3 (no stream-end status: the server reports the
      // ended session as exited). The separate
      // `crash` lane deliberately stays different: no protocol frame + exit.
      const st = sessions.get(sessionId)
      if (st) {
        for (const entry of st.pendingEntries.splice(0)) {
          emit({
            type: entry.kind === 'question' ? 'sdk.question.cancelled' : 'sdk.permission.cancelled',
            sessionId,
            requestId: entry.requestId,
          })
        }
        st.pending = 0
        if (st.pendingResults > 0) {
          const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
          st.lastTurnCompleteAt = at
          emit({ type: 'sdk.turn.complete', sessionId, at })
        }
      }
      if (st) sessions.delete(sessionId)
      emit({
        type: 'sdk.stream.ended',
        sessionId,
        reason: data.reason ?? 'stream_error',
        message: data.message ?? 'Fixture stream error',
      })
      exiting = true
      process.stdout.write('', () => process.exit(STREAM_ENDED_EXIT_CODE))
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
  // Like the real sidecar: once its stream ended, sdk.stream.ended stays the last line.
  if (exiting) return
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
    // kata 1wxv Task 7 (fork-at-point, s2rk correction): a `forkSession:true`
    // create mints a NEW durable cliSessionId — real `claude --fork-session`
    // NEVER reuses the parent's id; plain resume keeps the same-id behavior.
    // A PATH-shaped resumeSessionId (the server's cwd-gone fallback lane:
    // `--resume <path>.jsonl` bypasses the CLI's project-slug scoping) names
    // the transcript file to CONTINUE — the session's durable id stays the
    // file's stem, and every record lands in THAT file (never a
    // path-flattened `<...>.jsonl.jsonl` phantom).
    // Protocol v2 (crates/freshell-claude-sidecar/boot.mjs): the boot names
    // the conversation to start.
    const boot = msg.boot ?? {}
    const resumeSessionId = typeof boot.resume === 'string' ? boot.resume : undefined
    const forking = boot.kind === 'fork'
    const resumeRaw = resumeSessionId ?? null
    const resumeIsPath = resumeRaw !== null
      && (resumeRaw.includes('/') || resumeRaw.endsWith('.jsonl'))
    const resumePath = !forking && resumeIsPath ? resumeRaw : null
    const cliSessionId = forking
      ? randomUUID()
      : (resumePath
        ? path.basename(resumePath).replace(/\.jsonl$/, '')
        : (resumeRaw ?? program.sessionId ?? randomUUID()))
    const cwd = msg.cwd ?? process.cwd()
    sessions.set(sessionId, { cliSessionId, cwd, pending: 0, pendingEntries: [],
      transcriptOverride: resumePath,
      settings: { model: msg.model, effort: msg.effort, permissionMode: msg.permissionMode, cwd },
      // Unified attention bookkeeping (mirrors the real sidecar's per-session
      // state): the gate, the accepted-sends counter, and the last minted
      // monotonic `at` — the interrupt arm, the stream-error lane, and every
      // turn-complete mint consult them.
      turnCompleteGate: createTurnCompleteGate(), pendingResults: 0,
      lastTurnCompleteAt: undefined,
      turnOpen: false, sendInFlight: false, interrupted: false })
    // A durable transcript EXISTS from create on (the reload-while-pending
    // snapshot route reads it before any turn completes) — touch, no bogus row.
    // A path-resumed session's transcript IS the named file.
    const transcript = resumePath ?? transcriptPath(cliSessionId, cwd)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    if (forking && resumeSessionId) {
      // created FIRST — a real consumer discards anything earlier. The
      // resumeDropsTurn refusal watch runs BEFORE any durable state moves:
      // the guard must name the RAW-chain successor of the resume point (the
      // SDK-armed discard guard); anything else refuses with the SDK's
      // documented prefix and NO sdk.session.init / durable session is ever
      // minted (freshell retries ONCE with the guard omitted).
      emit({ type: 'created', requestId: msg.requestId, sessionId, protocol: 2 })
      const parentPath = transcriptPath(resumeSessionId, cwd)
      const parentLines = fs.existsSync(parentPath)
        ? fs.readFileSync(parentPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : []
      const cut = typeof boot.resumeSessionAt === 'string'
        ? parentLines.findIndex((l) => l.uuid === boot.resumeSessionAt)
        : parentLines.length - 1
      if (typeof boot.dropsTurn === 'string') {
        const successor = cut >= 0 ? (parentLines[cut + 1]?.uuid ?? null) : null
        if (boot.dropsTurn !== successor) {
          emit({
            type: 'sdk.error',
            sessionId,
            message: `Resume rejected by --resume-drops-turn: ${boot.dropsTurn} is not the raw-chain successor of the resume point (drop-guard mismatch)`,
          })
          return
        }
      }
      // The child file is the parent's transcript PREFIX through
      // resumeSessionAt, uuids preserved verbatim (a real fork keeps original
      // message ids), so freshell's transcript readers see a real durable
      // JSONL; the chain cursor seeds onto the fork point's uuid.
      const prefix = parentLines.slice(0, cut < 0 ? undefined : cut + 1)
      const lastPrefixUuid = prefix.length > 0 ? prefix[prefix.length - 1]?.uuid : null
      fs.writeFileSync(transcript, prefix.map((l) => JSON.stringify(l)).join('\n') + (prefix.length ? '\n' : ''))
      if (typeof lastPrefixUuid === 'string') lastUuidBySession.set(cliSessionId, lastPrefixUuid)
    } else {
      fs.closeSync(fs.openSync(transcript, 'a'))
      // created FIRST — a real consumer discards anything earlier.
      emit({ type: 'created', requestId: msg.requestId, sessionId, protocol: 2 })
      // A plain resume CONTINUES the parent's chain: seed the uuid cursor from
      // the transcript tail so the next appended line's parentUuid is right.
      if (typeof resumeSessionId === 'string' && fs.existsSync(transcript)) {
        const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean)
        const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null
        if (typeof last?.uuid === 'string') lastUuidBySession.set(cliSessionId, last.uuid)
      }
    }
    const emitted = await engine.handleMessage(msg)
    if (emitted.has('crash')) return
    if (!emitted.has('session')) {
      await engine.emitEvent(
        'session',
        { cliSessionId, model: msg.model ?? 'fixture-model', cwd },
        'msg:create:default',
      )
    }
    if (resumeSessionId) {
      await engine.emitResume(cliSessionId)
    }
    emit({ type: 'sdk.status', sessionId, status: 'idle' })
  } else if (msg.type === 'configure') {
    const st = sessions.get(msg.sessionId)
    if (!st) {
      emit({ type: 'sdk.configured', sessionId: msg.sessionId, requestId: msg.requestId, ok: false, message: 'Session not found' })
      return
    }
    for (const key of ['model', 'effort', 'permissionMode', 'cwd']) {
      if (msg.settings?.[key] != null || (key === 'effort' && msg.settings?.effort === null)) st.settings[key] = msg.settings[key]
    }
    st.cwd = st.settings.cwd
    emit({ type: 'sdk.configured', sessionId: msg.sessionId, requestId: msg.requestId, ok: true, settings: st.settings })
  } else if (msg.type === 'send') {
    activeSessionId = msg.sessionId ?? activeSessionId
    const st = sessions.get(msg.sessionId)
    if (st) appendTranscript(st.cliSessionId, st.cwd, 'user', msg.text, st.transcriptOverride, msg.uuid)
    if (st) {
      // Unified attention bookkeeping (mirrors the real sidecar): the send is
      // ACCEPTED (pendingResults += 1) and a turn is open until its terminal
      // frame; sendInFlight marks the awaited program-handling window, so an
      // interrupt arriving during a delayed scripted emission defers to that
      // completion instead of synthesizing a second terminal frame.
      st.pendingResults += 1
      st.turnOpen = true
      st.sendInFlight = true
    }
    try {
      // Turn-open bookkeeping is unconditional (the real bridge always goes busy).
      await engine.emitEvent('activity', { status: 'running' }, 'msg:send:open')
      const emitted = await engine.handleMessage(msg)
      if (emitted.has('crash')) return
      // A turn that raised an approval/question PARKS until the matching
      // respond (or an interrupt) arrives — the canned success turn must NOT
      // close it early, or the card would clear with an invented resolution.
      if (emitted.has('completion') || emitted.has('approval') || emitted.has('question')) return
      await engine.emitEvent('completion', { subtype: 'success' }, 'msg:send:default')
    } finally {
      if (st) st.sendInFlight = false
    }
  } else if (
    msg.type === 'permission.respond'
    || msg.type === 'question.respond'
  ) {
    activeSessionId = msg.sessionId ?? activeSessionId
    const kind = msg.type === 'question.respond' ? 'question' : 'permission'
    resolvePending(msg.sessionId, kind, msg.requestId)
    const emitted = await engine.handleMessage(msg)
    if (emitted.has('crash')) return
  } else if (msg.type === 'interrupt') {
    activeSessionId = msg.sessionId ?? activeSessionId
    const st = sessions.get(msg.sessionId)
    if (!st) {
      // Real-sidecar parity (index.mjs handleInterrupt): an interrupt against
      // an unknown session is a session-scoped error frame, never a settle.
      emit({ type: 'sdk.error', sessionId: msg.sessionId, message: 'session not found', sessionNotFound: true })
      return
    }
    let interruptedInFlight = false
    if (st) {
      // Mirror the real sidecar's interrupt path (index.mjs — the transport is
      // still open, so cancelPending emits one cancel frame per parked entry,
      // never a fabricated user respond), then NO sdk.exit: interrupt ends the
      // TURN, never the session (AGENT-03).
      for (const entry of st.pendingEntries.splice(0)) {
        emit({
          type: entry.kind === 'question' ? 'sdk.question.cancelled' : 'sdk.permission.cancelled',
          sessionId: msg.sessionId,
          requestId: entry.requestId,
        })
      }
      st.pending = 0
      if (st.pendingResults > 0) {
        // A turn is plausibly awaiting a terminal frame — arm the REAL gate
        // BEFORE the "interrupt()" call, exactly like the real sidecar
        // (index.mjs: `if (st.pendingResults > 0)
        // st.turnCompleteGate.noteInterruptRequest()`); the SDK contract
        // orders the settle receipt BEFORE the interrupted turn's own result
        // (sdk.d.ts:3765), so the mark deterministically consumes that
        // result's ring (the interrupt stays silent; the next turn rings).
        st.turnCompleteGate.noteInterruptRequest()
        interruptedInFlight = true
      }
    }
    if (interruptedInFlight) {
      // Force the interrupted turn's eventual completion to the non-success
      // subtype BEFORE program rules run, so a completion scripted on
      // msg:interrupt renders the interrupted turn truthfully.
      st.interrupted = true
      emit({ type: 'sdk.interrupt_settled', sessionId: msg.sessionId, ok: true })
      const emitted = await engine.handleMessage(msg)
      if (emitted.has('crash')) return
      // The program ended the interrupted turn itself (its completion render
      // already forced the non-success subtype and consumed the gate mark).
      if (emitted.has('completion')) return
      // A delayed scripted completion is still mid-flight: let it land (it
      // renders the forced subtype with the gate-suppressed edge).
      if (st.sendInFlight) return
      // Parked/plain in-flight turn: nothing else will end it, so synthesize
      // the interrupted turn's own non-success terminal result — the armed
      // gate consumes its ring. Still NEVER an sdk.exit. The
      // counter goes to ZERO, not minus one: the fake models ONE in-flight
      // turn, so the interrupt ends everything pending — a stale-positive
      // counter here would let a later stream-error lane mint a phantom ring
      // (task-004-review F-N1).
      st.pendingResults = 0
      emit({ type: 'sdk.result', sessionId: msg.sessionId, result: STOPPED_RESULT.subtype })
      st.turnCompleteGate.resultEmitsAttention(STOPPED_RESULT)
      st.turnOpen = false
      st.interrupted = false
      return
    }
    // No turn awaits a terminal frame — real-sidecar parity: the SDK RESOLVES
    // an idle-session interrupt (sdk.d.ts:2384-2394 — resolution, not
    // rejection; the ok:false 'no in-flight SDK query' shape fires only when
    // the SDK surface lacks the interrupt method entirely), so the settle
    // lands ok:true and NOTHING armed — no stray mark can eat the NEXT
    // unrelated turn's ring. The receipt must precede any of the frames
    // below in stream order (the consumer folds the receipt only after
    // provably-earlier evidence).
    emit({ type: 'sdk.interrupt_settled', sessionId: msg.sessionId, ok: true })
    const emitted = await engine.handleMessage(msg)
    if (emitted.has('crash')) return
    if (!emitted.has('activity') && !emitted.has('marker')) {
      await engine.emitEvent('activity', { status: 'idle' }, 'msg:interrupt:idle')
    }
  } else if (msg.type === 'rollback.quiesce') {
    // kata 1wxv ep4-r3: rollback's pre-teardown quiesce probe. This faker has
    // no SDK-input queue — every sent turn settles immediately on the drive
    // side — so the answer is always all-clear with a probeId echo.
    emit({
      type: 'sdk.rollback.quiesced',
      sessionId: msg.sessionId,
      probeId: msg.probeId ?? null,
      cancelledQueue: 0,
      inFlightTurn: false,
      handedCompactLikely: false,
    })
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
}

keepAlive()
