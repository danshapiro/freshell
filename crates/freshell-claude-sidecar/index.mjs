#!/usr/bin/env node
// freshell-claude-sidecar — the ONE sanctioned Node sidecar (ADR Decision 2).
// ---------------------------------------------------------------------------
// A THIN stdio JSON protocol server wrapping @anthropic-ai/claude-agent-sdk's
// query()/session, which has NO Rust equivalent (a JS-only vendor SDK). The Rust
// harness (crates/freshell-freshagent, claude WS slice) speaks newline-delimited
// JSON to this process:
//
//   Rust → sidecar (stdin, one JSON per line), protocol v2 (boot.mjs):
//     { type:'create',             protocol:2, requestId, sessionType?, sessionId?,
//                                    boot:{kind:'fresh'} | {kind:'resume', resume}
//                                         | {kind:'fork', resume, resumeSessionAt?, dropsTurn?},
//                                    cwd?, model?, permissionMode?, effort?, plugins?, hostedMcp? }
//                                  — `boot` picks the conversation the CLI boots (bootOptions): a
//                                    fork keeps the parent through-AND-including resumeSessionAt
//                                    over the raw parentUuid chain, writes a NEW conversation and
//                                    never rewrites the parent's JSONL; dropsTurn arms the SDK's
//                                    fork-time discard guard. `sessionId` is the id Rust minted for
//                                    a fresh or forked boot, when it minted one. One sidecar hosts
//                                    one session: a second create is refused.
//     { type:'configure',          sessionId, requestId, settings }
//     { type:'send',               sessionId, text, images? }
//     { type:'interrupt',          sessionId }
//     { type:'permission.respond', sessionId, requestId, decision }   // decision forwarded VERBATIM
//     { type:'question.respond',   sessionId, requestId, answers }
//     { type:'shutdown' }
//
//   sidecar → Rust (stdout, one JSON per line):
//     { type:'created',                 requestId, sessionId, protocol:2, cliPid }
//                                  — sent only once the CLI booted (initializationResult() resolved,
//                                    T2); sessionId is the SDK bridge's BARE nanoid placeholder and
//                                    cliPid the CLI's pid. The command catalog follows it.
//     { type:'create.failed',           requestId, code, message }
//                                  — the CLI refused the boot (boot.mjs names the codes) or the
//                                    request is not protocol v2. Nothing from the refused boot is
//                                    forwarded (its error result is the refusal's evidence, not a
//                                    turn), and the sidecar then exits with code 2.
//     { type:'sdk.configured',          sessionId, requestId, ok, settings?, message? }
//     { type:'sdk.session.init',        sessionId, cliSessionId, model, cwd, tools }  // durable Claude UUID
//     { type:'sdk.assistant',           sessionId, content, model, uuid, messageId, parentToolUseId }
//                                  — one per completed content block (blocks of one API message share
//                                    messageId); parentToolUseId is set inside a subagent, else null
//     { type:'sdk.stream',              sessionId, event, parentToolUseId:null, messageId }
//                                  — the main thread's message_start, content_block_start/stop and
//                                    text/thinking deltas only, stamped with the API message id of the
//                                    message being streamed (a subagent's events, tool input JSON,
//                                    signatures, message_delta and message_stop are not sent)
//     { type:'sdk.retry',               sessionId, attempt, maxRetries, delayMs, errorStatus, error }
//                                  — the CLI will retry a failed API request (errorStatus null: no HTTP
//                                    response); live only, never a turn end
//     { type:'sdk.notice',              sessionId, level:'info'|'warning'|'error', code, message, rateLimit? }
//                                  — a non-terminal provider notice: RATE_LIMIT_WARNING / RATE_LIMITED
//                                    (rateLimit {status, resetsAt?, rateLimitType?, utilization?}),
//                                    INFORMATIONAL (the CLI's own banner text), COMPACTION_FAILED (the
//                                    CLI's reason); never a turn end
//     { type:'sdk.result',              sessionId, result, durationMs, costUsd, usage }
//     { type:'sdk.turn.complete',       sessionId, at }                   // EVERY result (any subtype) except
//                                  the stopped turn's own aborted result (an accepted user interrupt's mark
//                                  silences only that — turn-complete-gate.mjs); also minted from consumeStream's finally
//                                  when a turn ends with NO result frame (the CLI died or the stream ended
//                                  with a send still pending) — the abort/sdk.exit requested-teardown path
//                                  stays silent
//     { type:'sdk.turn.waiting',        sessionId, at }                   // 0->>=1 pending edge (written by this sidecar; codex controls emits its own waiting edge outside the sidecar lane)
//     { type:'sdk.session.changed',     sessionId, reason:'session-commands', commands }
//                                  — the command catalog without the terminal-only commands (the pinned
//                                    CLI's until a turn's init names its own): from the boot, then
//                                    whenever a turn's init or commands_changed changes it
//     { type:'sdk.session.changed',     sessionId, reason:'transcript', uuid, parentToolUseId }
//                                  — the CLI writes this message (assistant, user, compaction boundary,
//                                    local command output) to its transcript under `uuid`, about 100 ms
//                                    later; sent right after the message's own frames
//                                    (sdk-message-frames.mjs)
//     { type:'sdk.status',              sessionId, status }               // compacting; running when a
//                                  compaction ends while a send still waits for its result (interim, core
//                                  N2); an ended stream sends no status: the server reports it as exited
//     { type:'sdk.session.metadata',    sessionId, permissionMode }       // the CLI changed its own
//                                  permission mode (an ExitPlanMode approval); the session adopts it first
//     { type:'sdk.error',               sessionId, message, turnFailure? } // turnFailure: a failed turn's result
//                                  (sanitized text, no [ede_diagnostic] lines); never for the user's own Stop
//     { type:'sdk.stream.ended',        sessionId, reason, message }      // the session's SDK stream ended
//                                  unrequested (reason cli_exited | stream_error | stream_eof, stream-end.mjs):
//                                  always the LAST line; the sidecar then exits with code 3 (G02)
//     { type:'sdk.exit',                sessionId }                       // a requested teardown (abort)
//     { type:'sdk.permission.request',  sessionId, requestId, subtype:'can_use_tool', tool:{name,input}, toolUseID, suggestions, blockedPath, decisionReason }
//     { type:'sdk.question.request',    sessionId, requestId, questions }
//     { type:'sdk.permission.cancelled', sessionId, requestId }
//     { type:'sdk.question.cancelled',  sessionId, requestId }
//
//   sidecar → Rust (stderr): log records only, one JSON object per line
//     ({ severity, component, event, ...ids }, log.mjs). Rust re-emits each
//     through `tracing` at its severity (claude_sidecar_io.rs).
//
// The Rust side normalizes `sdk.* -> freshAgent.*` (a port of
// server/fresh-agent/sdk-events.ts) and wraps each in a `freshAgent.event`
// envelope — so this sidecar is the faithful analog of server/sdk-bridge.ts's
// SdkBridge (it emits the SAME `sdk.*` shapes SdkBridge broadcasts).
//
// A sidecar death mid-turn can therefore NEVER produce a false completion
// from this process's own stdout: `sdk.turn.complete` rides every SDK
// `result` (the unified needs-attention edge — only the stopped turn's own
// aborted result is silenced, by the accepted-interrupt mark) plus the
// consumeStream finally mint for a result-less turn end (the CLI died or the
// stream ended with a send pending; never the aborted/sdk.exit teardown).
//
// Process lifetime: one sidecar hosts one session. A boot the CLI refused ends
// the sidecar with `create.failed` and exit code 2. When the session's SDK
// stream ends without a request, the sidecar writes `sdk.stream.ended` last
// and exits with code 3, so the Rust end-of-output path ends the session. A
// requested teardown (shutdown, SIGTERM, stdin closing) exits 0 and reports
// nothing. If the PROCESS itself dies mid-turn, stdout simply ends with no
// `sdk.stream.ended` — the one end the Rust side rings for itself.
//
// Scope discipline (ADR "keep it minimal — only what the claude T2 invariant set
// needs"): the freshell MCP-server injection (createClaudeSdkMcpServers) is
// DELIBERATELY OMITTED — a pinned pure-text T2 turn never calls a tool, MCP tools
// are not in the T2 baseline, and injecting the MCP server would spawn an extra
// node grandchild bound to the REST API. The interactive permission/question
// RESPONSE channel IS in scope (permission-channel.mjs, a faithful port of
// server/sdk-bridge.ts): canUseTool parks a pending request, surfaces
// sdk.permission.request / sdk.question.request, and waits for the Rust side's
// permission.respond / question.respond (unknown respond ids are stderr-log-only
// no-ops). The auto-allow shortcut remains ONLY for bypassPermissions sessions
// (AskUserQuestion still routes to the question path first, per legacy ordering).

import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { configureSession, userMessageContent } from './session-settings.mjs'
import { createFrameState, frameLogRecord, framesForSdkMessage, resultFrames } from './sdk-message-frames.mjs'
import { createTurnCompleteGate } from './turn-complete-gate.mjs'
import { checkpointAttemptOf, rememberCheckpointAttempt, takeCheckpointIdentity } from './checkpoint-identity.mjs'
import { nextMonotonic } from './monotonic-clock.mjs'
import { managedSdkSpawn } from './exec-profile.mjs'
import { hostedMcpServers } from './hosted-mcp.mjs'
import { cliStderrLogger, errorText, log } from './log.mjs'
import { isHostedSidecar } from './hosted.mjs'
import { STREAM_ENDED_EXIT_CODE, streamEnd } from './stream-end.mjs'
import { BOOT_FAILED_EXIT_CODE, bootOptions, classifyBootError, SIDECAR_PROTOCOL } from './boot.mjs'
import { usableCommands } from './terminal-commands.mjs'
import { createClaudeSdkCleanEnv } from './sdk-env.mjs'
import {
  canUseTool as routeCanUseTool,
  cancelPending,
  respondPermission,
  respondQuestion,
} from './permission-channel.mjs'

// Env-injected SDK seam: FRESHELL_CLAUDE_SDK_QUERY_MODULE overrides the vendored
// SDK import (tests inject a scripted fake query module; default resolution is
// unchanged without the env).
const sdkModule = await import(process.env.FRESHELL_CLAUDE_SDK_QUERY_MODULE || '@anthropic-ai/claude-agent-sdk')
const { query } = sdkModule

// ── stdout writer (newline-JSON; stderr is the only log sink: log.mjs) ───────
function emit(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

/** Set once the sidecar is exiting on its own (a refused boot, or an unrequested stream end). */
let exiting = false
/** How long an exiting sidecar waits for stdout and stderr to flush. */
const EXIT_FLUSH_BUDGET_MS = 2000
/** Set by the first `create`: one sidecar hosts one session. */
let createReceived = false
/** The most CLI stderr kept while the CLI boots (a refusal may be named there, T4). */
const BOOT_STDERR_MAX_CHARS = 8192
/**
 * After initializationResult() rejected: how long the refusal waits for the
 * SDK stream to end, so the CLI's last stderr line is part of its evidence.
 */
const BOOT_FAILURE_SETTLE_MS = 2000

// ── nanoid()-compatible bare id: 21 url-safe chars ([A-Za-z0-9_-]) ───────────
// Faithful shape of server/sdk-bridge.ts's `const sessionId = nanoid()` (the
// placeholder the claude adapter surfaces verbatim). The T2 invariant checks the
// SHAPE (`^[A-Za-z0-9_-]{16,32}$`), which this exactly matches.
const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'
function nanoid(size = 21) {
  const bytes = randomBytes(size)
  let id = ''
  for (let i = 0; i < size; i++) id += NANOID_ALPHABET[bytes[i] & 63]
  return id
}

// ── streaming input stream (server/sdk-bridge.ts:274-316) ────────────────────
// `onHandoff(isCompact)` fires on EVERY permanent handoff into the SDK
// consumer — BOTH the same-tick push-into-a-waiting-consumer path and the
// later `next()` queue-shift path (ep4-r4: the latter equally crosses the
// un-cancellable boundary; an absorbed compact pulled mid-window must arm the
// busy verdict just as the immediate handoff does).
function createInputStream(onHandoff) {
  // Items are { msg, isCompact } — the wrapper lets rollback's quiesce drain
  // never-yet-handed compacts (kata 1wxv ep4-r3: the SDK's queued-input
  // surface cannot cancel UUID-less items, so cancellation authority lives at
  // THIS queue, before handoff).
  const queue = []
  let waiting = null
  let done = false
  const handle = {
    push: (msg, isCompact = false) => {
      if (waiting) {
        const r = waiting; waiting = null;
        r({ value: msg, done: false })
        // A push into an AWAITING SDK consumer hands the item over in this
        // same tick — un-cancellable from here (the SDK has it).
        if (isCompact) onHandoff(true)
      } else {
        queue.push({ msg, isCompact })
      }
    },
    // kata 1wxv ep4-r1 F1 → rollback quiesce: every queued compact is
    // provably never handed to the SDK (the handoffs above/below are the only
    // pulls) — dropping them here cancels them permanently.
    drainCompacts: () => {
      let cancelled = 0
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].isCompact) { queue.splice(i, 1); cancelled += 1 }
      }
      return cancelled
    },
    end: () => {
      done = true
      if (waiting) { const r = waiting; waiting = null; r({ value: undefined, done: true }) }
    },
  }
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) {
            const item = queue.shift()
            // ep4-r4: a later pull of a QUEUED compact is the same
            // un-cancellable handoff as the same-tick push — arm it too.
            if (item.isCompact) onHandoff(true)
            return Promise.resolve({ value: item.msg, done: false })
          }
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { waiting = resolve })
        },
      }
    },
  }
  return { iterable, handle }
}

// ── per-session monotonic turn-complete/waiting clock ────────────────────────
// nextMonotonic lives in monotonic-clock.mjs (shared with the e2e fake so the
// fixture clamps identically — ONE implementation of the clamp).

/** @type {Map<string, {inputStream:{push:Function,end:Function}, abort:AbortController, permissionMode?:string, cliSessionId?:string, lastTurnCompleteAt?:number, lastWaitingAt?:number, pendingPermissions?:Map<string,any>, pendingQuestions?:Map<string,any>, turnCompleteGate?:{noteInterruptRequest:Function,noteInterruptSettled:Function,resultEmitsAttention:Function}, pendingResults?:number}>} */
const sessions = new Map()

function normalizeCommands(rows, strict = false) {
  if (!Array.isArray(rows)) return undefined
  const result = []
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !row.name || (Array.isArray(row.aliases) && !row.aliases.every((alias) => typeof alias === 'string'))) {
      if (strict) return undefined
      continue
    }
    result.push({
      name: row.name,
      description: typeof row.description === 'string' ? row.description : '',
      ...(typeof row.argumentHint === 'string' ? { argumentHint: row.argumentHint } : {}),
      ...(Array.isArray(row.aliases) ? { aliases: row.aliases } : {}),
    })
  }
  return result
}

/**
 * Publish the session's command catalog when it differs from the last one
 * published. The catalog comes from the boot (initializationResult().commands)
 * and from commands_changed, and leaves out the CLI's terminal-only commands:
 * the ones each turn's init names, or the pinned CLI's before the first init
 * (terminal-commands.mjs). Every init repeats the same lists, so an unchanged
 * catalog is never sent again.
 */
function publishCommandsIfChanged(sessionId, state) {
  if (!state.booted || state.commandCatalog === undefined) return
  const commands = usableCommands(state.commandCatalog, state.terminalCommandNames)
  const published = JSON.stringify(commands)
  if (published === state.publishedCommands) return
  state.publishedCommands = published
  emit({ type: 'sdk.session.changed', sessionId, reason: 'session-commands', commands })
}

// ── SDK message -> sdk.* event (faithful port of SdkBridge.handleSdkMessage) ──
function handleSdkMessage(sessionId, msg) {
  const st = sessions.get(sessionId)
  if (!st) return
  // Until `created` is sent nothing reaches Rust: a refused boot's
  // error_during_execution result (T5) is the refusal's evidence, not a turn.
  if (!st.booted) {
    if (msg.type === 'result' && Array.isArray(msg.errors)) st.bootEvidence.resultErrors.push(...msg.errors)
    return
  }

  // ep4-r6 quiesce bookkeeping (fail-closed approximations; the discharge rule
  // is tight per ep4-r5 F1):
  // - a `result` closes whatever turn was open (`turnOpen`);
  // - an assistant/system frame marks a TURN boundary (`turnOpen`);
  // - ONLY a `compacting` status discharges `handedCompactLikely`: the handed
  //   compact's OWN evidence finally carrying the busy truth (an unrelated
  //   earlier result — the SDK drains the iterable independently — must never
  //   drop it, or a rollback probe between that result and the compact's
  //   status sees a false all-clear; the reviewer repro).
  if (msg.type === 'result') {
    st.turnOpen = false
  } else if (
    msg.type === 'assistant' ||
    (msg.type === 'system' && msg.subtype === 'status')
  ) {
    st.turnOpen = true
    if (msg.type === 'system' && msg.subtype === 'status' && msg.status === 'compacting') {
      st.handedCompactLikely = false
    }
  }

  switch (msg.type) {
    case 'user': {
      // The SDK replays actual persisted user messages when this query opts in.
      // Only the unique UUID that this sidecar supplied for a checkpointed send
      // can resolve its attempt (checkpoint-identity.mjs).
      const identity = takeCheckpointIdentity(st.pendingCheckpointAttempts, sessionId, msg)
      if (identity) emit(identity)
      break
    }
    case 'system': {
      if (msg.subtype === 'init') {
        st.cliSessionId = msg.session_id
        st.settings.cwd ??= msg.cwd
        st.terminalCommandNames = Array.isArray(msg.terminal_slash_commands) ? msg.terminal_slash_commands : []
        emit({
          type: 'sdk.session.init',
          sessionId,
          cliSessionId: msg.session_id,
          model: msg.model,
          cwd: msg.cwd,
          tools: Array.isArray(msg.tools) ? msg.tools.map((t) => ({ name: t })) : undefined,
        })
        publishCommandsIfChanged(sessionId, st)
      } else if (msg.subtype === 'commands_changed') {
        const commands = normalizeCommands(msg.commands, true)
        if (commands !== undefined) {
          st.commandCatalog = commands
          publishCommandsIfChanged(sessionId, st)
        }
      }
      break
    }
    case 'result': {
      // The awaited turn's terminal frame arrived: drop one pending send
      // (clamped at 0 — an unsolicited result must not underflow the counter).
      st.pendingResults = Math.max(0, st.pendingResults - 1)
      // The gate's verdict comes first: the stopped turn's own (aborted)
      // result is the user's Stop, so it carries neither a bell nor a failure
      // banner (G03). Any other turn end rings, including one a Stop missed
      // (G06); a failed one also reports why. No outcome rides the edge — the
      // client treats all ends identically.
      const rings = st.turnCompleteGate.resultEmitsAttention(msg)
      for (const frame of resultFrames(sessionId, msg, { userStopped: !rings })) emit(frame)
      if (rings) {
        const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
        st.lastTurnCompleteAt = at
        emit({ type: 'sdk.turn.complete', sessionId, at })
      }
      break
    }
    default:
      break
  }
  // The content kinds (assistant, user, stream events, status, retries and
  // notices): a pure mapping, sdk-message-frames.mjs. Any kind it does not
  // map is dropped there.
  const frames = framesForSdkMessage(sessionId, msg, {
    stream: st.frameState,
    permissionMode: st.settings.permissionMode,
    turnPending: st.pendingResults > 0,
  })
  for (const frame of frames) {
    // The CLI changed its own permission mode (an ExitPlanMode approval): the
    // session adopts it before saying so, so a configure to that mode applies
    // nothing and the permission channel sees the mode the CLI is in.
    if (frame.type === 'sdk.session.metadata' && frame.permissionMode !== undefined) {
      st.settings.permissionMode = frame.permissionMode
      st.permissionMode = frame.permissionMode
    }
    emit(frame)
    const record = frameLogRecord(frame)
    if (record) log(record.severity, record.event, record.fields)
  }
}

async function consumeStream(sessionId, sdkQuery) {
  const st = sessions.get(sessionId)
  let failure
  try {
    for await (const msg of sdkQuery) handleSdkMessage(sessionId, msg)
  } catch (error) {
    failure = { error }
  } finally {
    // A stream that ends before the CLI booted is a refused boot: bootSession
    // reports it (create.failed) with this end as part of its evidence.
    if (st && !st.booted) {
      st.bootEvidence.streamEnded = failure ?? {}
      return
    }
    // An abort is a requested teardown (shutdown); any other end is the CLI
    // dying under the session or ending it.
    const requested = st?.abort.signal.aborted === true
    const ended = requested ? undefined : streamEnd(failure)
    if (requested) log('info', 'stream.ended', { sessionId, reason: 'aborted' })
    else log(failure ? 'warn' : 'info', 'stream.ended', { sessionId, reason: ended.reason, ...(failure ? { error: ended.message } : {}) })
    // The transport is closing: clear any parked cards WITHOUT resolving their
    // promises (LB-04: a late resolve lands inside the SDK's floating promise
    // chain → unhandled rejection → crash under Node 22 throw-mode).
    if (st) cancelPending(st, emit, sessionId, { resolveDeny: false })
    sessions.delete(sessionId)
    if (requested) {
      emit({ type: 'sdk.exit', sessionId })
    } else {
      // Interim, until Rust mints every edge (C18): a turn that ends with NO
      // result frame — the CLI died, or the stream ended, with a result still
      // pending — is a turn end the user didn't witness, so it rings here.
      // pendingResults covers the accept→first-message window and counts
      // queued sends. A pending Stop mark does not silence it: only an aborted
      // result is the stopped turn's own (turn-complete-gate.mjs). Rust rings
      // only for a death that reports no stream end, so this edge is the one.
      if (st && st.pendingResults > 0) {
        const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
        st.lastTurnCompleteAt = at
        emit({ type: 'sdk.turn.complete', sessionId, at })
      }
      // The end of the stream is the end of this sidecar (G02): report how
      // the stream ended, last, and exit, so the server's end-of-output path
      // ends the session instead of keeping a sidecar with no session.
      emit({ type: 'sdk.stream.ended', sessionId, ...ended })
      exitWithoutSession(st?.query, STREAM_ENDED_EXIT_CODE)
    }
  }
}

/**
 * The sidecar has no session left (a refused boot, or an unrequested stream
 * end): read no more requests (the frame just written stays the last line),
 * make sure the CLI is gone, and exit with `code` once stdout and stderr have
 * flushed.
 */
function exitWithoutSession(sdkQuery, code) {
  if (exiting) return
  exiting = true
  try { sdkQuery?.close?.() } catch (error) { log('warn', 'stream.close_failed', { error: errorText(error) }) }
  let unflushed = 2
  const flushed = () => { if (--unflushed === 0) process.exit(code) }
  process.stdout.write('', flushed)
  process.stderr.write('', flushed)
  // A pipe that never drains must not keep a sidecar with no session alive.
  setTimeout(() => process.exit(code), EXIT_FLUSH_BUDGET_MS)
}

// ── request handlers ─────────────────────────────────────────────────────────

/**
 * A boot that did not happen: answer `create.failed` (the last line this
 * sidecar writes) and exit with BOOT_FAILED_EXIT_CODE.
 */
function failBoot(requestId, { code, message }, fields = {}, sdkQuery = undefined) {
  log('warn', 'boot.failed', { requestId, code, error: message, ...fields })
  emit({ type: 'create.failed', requestId, code, message })
  exitWithoutSession(sdkQuery, BOOT_FAILED_EXIT_CODE)
}

function handleCreate(req) {
  const requestId = req.requestId
  if (createReceived) {
    log('warn', 'create.refused', { requestId, reason: 'second_create' })
    emit({ type: 'create.failed', requestId, code: 'BOOT_FAILED', message: 'This Claude sidecar already hosts a session.' })
    return
  }
  createReceived = true
  // A server and sidecar from different builds would misread each other:
  // fail before anything is launched.
  if (req.protocol !== SIDECAR_PROTOCOL) {
    failBoot(requestId, {
      code: 'SIDECAR_PROTOCOL_MISMATCH',
      message: `The server sent sidecar protocol ${req.protocol ?? 1}; this Claude sidecar speaks protocol ${SIDECAR_PROTOCOL}.`,
    })
    return
  }
  let launch
  try {
    launch = bootOptions(req.boot, req.sessionId)
  } catch (error) {
    failBoot(requestId, { code: error?.code ?? 'BOOT_FAILED', message: errorText(error) })
    return
  }

  const sessionId = nanoid()
  const abort = new AbortController()
  // ep4-r3/ep4-r4 quiesce state (declared first so the stream can arm it):
  // turnOpen — an SDK turn is mid-flight (cleared at its result);
  // handedCompactLikely — a compact crossed the un-cancellable SDK handoff
  // (same-tick push OR queued pull — either path); cleared at the next
  // result or observed status frame (its evidence has by then reached Rust).
  const state = {
    abort,
    permissionMode: req.permissionMode,
    settings: { model: req.model, effort: req.effort, permissionMode: req.permissionMode, cwd: req.cwd },
    // False until `created` is sent; until then nothing reaches Rust and
    // bootEvidence collects what a refusal is named from (boot.mjs).
    booted: false,
    bootEvidence: { resultErrors: [], stderr: '', streamEnded: undefined },
    turnOpen: false,
    handedCompactLikely: false,
    // Unified attention bookkeeping: the gate suppresses exactly the
    // interrupted turn's own result (ordering-scoped, NO reset-at-send —
    // see turn-complete-gate.mjs); pendingResults counts ACCEPTED sends
    // still awaiting their terminal result frame, so consumeStream's
    // finally can mint the edge for a result-less turn end.
    turnCompleteGate: createTurnCompleteGate(),
    pendingResults: 0,
    pendingCheckpointAttempts: new Map(),
    // The content mapping's own per-session state (sdk-message-frames.mjs).
    frameState: createFrameState(),
  }
  const { iterable, handle } = createInputStream((isCompact) => {
    if (isCompact) state.handedCompactLikely = true
  })
  state.inputStream = handle
  // Liveness IS session-map membership: consumeStream's finally removes the
  // session synchronously after cancelPending (LB-04 — a parked canUseTool
  // promise must never be resolved after transport close), and stdin line
  // events (macrotasks) cannot interleave inside that finally.
  sessions.set(sessionId, state)

  const logCliStderr = cliStderrLogger(log, { hosted: isHostedSidecar(), fields: { sessionId } })
  const sdkStderr = (data) => {
    if (!state.booted) state.bootEvidence.stderr = (state.bootEvidence.stderr + String(data)).slice(-BOOT_STDERR_MAX_CHARS)
    logCliStderr(data)
  }
  let sdkQuery
  try {
    sdkQuery = query({
      prompt: iterable,
      options: {
        cwd: req.cwd || undefined,
        // Which conversation the CLI boots: fresh, resumed or forked (boot.mjs).
        // A fork rides the query() options — NEVER the standalone forkSession()
        // fn (it remaps every uuid).
        ...launch,
        model: req.model,
        permissionMode: req.permissionMode,
        // Enables the user's in-session permission selector; the selected mode
        // still controls whether approval is required for each tool.
        allowDangerouslySkipPermissions: true,
        effort: req.effort,
        plugins: Array.isArray(req.plugins)
          ? req.plugins.map(path => ({ type: 'local', path }))
          : undefined,
        mcpServers: hostedMcpServers(req.hostedMcp),
        pathToClaudeCodeExecutable: process.env.CLAUDE_CMD || undefined,
        includePartialMessages: true,
        // This is the SDK's native persisted-user witness. Without the replay
        // flag a supplied SDKUserMessage UUID is not surfaced back to the
        // sidecar, so checkpoint identity must remain unbound.
        extraArgs: { 'replay-user-messages': null },
        abortController: abort,
        env: createClaudeSdkCleanEnv(process.env),
        settingSources: ['user', 'project', 'local'],
        spawnClaudeCodeProcess: managedSdkSpawn(sdkStderr),
        stderr: sdkStderr,
        canUseTool: async (toolName, input, options) => {
          const s = sessions.get(sessionId)
          if (!s) return { behavior: 'allow', updatedInput: input }
          // AskUserQuestion routes first (even under bypassPermissions), then the
          // bypass fast-path, else park-and-surface a pending request — legacy
          // ordering, sdk-bridge.ts:203-214.
          return routeCanUseTool({ session: s, emit, nanoid, nextMonotonic, sessionId, toolName, input, options })
        },
      },
    })
  } catch (error) {
    sessions.delete(sessionId)
    failBoot(requestId, classifyBootError({ error }), { sessionId })
    return
  }
  state.query = sdkQuery
  const streamDone = consumeStream(sessionId, sdkQuery)
  streamDone.catch((err) => log('error', 'stream.consume_failed', { sessionId, error: errorText(err) }))
  bootSession({ req, sessionId, state, sdkQuery, streamDone })
    .catch((err) => log('error', 'boot.handler_failed', { requestId, sessionId, error: errorText(err) }))
}

/**
 * Wait for the CLI to boot (initializationResult(), T2: no prompt needed),
 * then answer `created` and publish the command catalog from the boot. A
 * refused boot (T4, T5) is answered `create.failed` with its typed code.
 */
async function bootSession({ req, sessionId, state, sdkQuery, streamDone }) {
  const requestId = req.requestId
  const startedAt = Date.now()
  const fields = () => ({ sessionId, sessionType: req.sessionType, boot: req.boot?.kind, ms: Date.now() - startedAt })
  // A stream that ends first ends the boot too, whatever initializationResult() does.
  const streamEndedFirst = streamDone.then(() => {
    throw state.bootEvidence?.streamEnded?.error ?? new Error('The Claude CLI ended the session while it started.')
  })
  // Once the boot is settled a later stream end is the stream's own business (consumeStream).
  streamEndedFirst.catch(() => {})
  let init
  let error
  try {
    if (typeof sdkQuery.initializationResult !== 'function') throw new Error('The Claude SDK cannot report its boot (no initializationResult).')
    init = await Promise.race([sdkQuery.initializationResult(), streamEndedFirst])
  } catch (rejection) {
    error = rejection
  }
  // A CLI that died right after it booted did not boot.
  if (error === undefined && state.bootEvidence.streamEnded) {
    error = state.bootEvidence.streamEnded.error ?? new Error('The Claude CLI ended the session while it started.')
  }
  if (error !== undefined) {
    // The CLI writes its refusal before it exits, and the stream ends after
    // the exit: wait for that end (bounded) so all the evidence is in.
    await Promise.race([streamDone, new Promise((resolve) => setTimeout(resolve, BOOT_FAILURE_SETTLE_MS))])
    const { resultErrors, stderr } = state.bootEvidence
    sessions.delete(sessionId)
    failBoot(requestId, classifyBootError({ error, resultErrors, stderr }), fields(), sdkQuery)
    return
  }
  // A shutdown or stdin close while the CLI booted: the sidecar is going away.
  if (!sessions.has(sessionId)) return
  state.booted = true
  state.bootEvidence = undefined
  const cliPid = Number.isInteger(init?.pid) ? init.pid : undefined
  emit({ type: 'created', requestId, sessionId, protocol: SIDECAR_PROTOCOL, ...(cliPid !== undefined ? { cliPid } : {}) })
  log('info', 'boot.ok', { requestId, cliPid, ...fields() })
  const commands = normalizeCommands(init?.commands)
  if (commands !== undefined) {
    state.commandCatalog = commands
    publishCommandsIfChanged(sessionId, state)
  }
}

function handleSend(req) {
  const st = sessions.get(req.sessionId)
  // ep3-r2 F2: the signed frame — when the JS session is gone but stdout stays
  // open (consumeStream deleted it), NO terminal edge or EOF follows; the Rust
  // busy tracker must fold this specific failure as provider-session death.
  if (!st) { emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'session not found', sessionNotFound: true }); return }
  // ep4-r3: /compact is the only dispatch rollback ever absorbs; mark it so
  // the quiesce handler can drain never-handed compacts from the input queue
  // and so a same-tick handoff arms the BUSY-forcing handed flag.
  const isCompact = /^\s*\/compact(\s|$)/.test(String(req.text ?? ''))
  const checkpointAttempt = checkpointAttemptOf(req.checkpointAttempt)
  const userMessage = {
      type: 'user',
      message: { role: 'user', content: userMessageContent(req.text, req.images) },
      parent_tool_use_id: null,
      session_id: st.cliSessionId || 'default',
      ...(checkpointAttempt ? { uuid: checkpointAttempt.uuid } : {}),
    }
  if (checkpointAttempt) rememberCheckpointAttempt(st.pendingCheckpointAttempts, checkpointAttempt)
  st.inputStream.push(userMessage, isCompact)
  // Unified attention bookkeeping: this send is now ACCEPTED (the input-stream
  // push succeeded) and awaits exactly one terminal frame — a COUNTER, not a
  // boolean: two queued sends leave it at 2 and the first result must drop it
  // to 1, not 0 (a boolean would lose the second queued turn and its
  // stream-exception ring). Deliberately NOT turnOpen, which only arms after
  // the first assistant/system frame and cannot see the accept→first-message
  // window. The gate is NOT reset here — see turn-complete-gate.mjs.
  st.pendingResults += 1
}

async function handleConfigure(req) {
  const st = sessions.get(req.sessionId)
  if (!st) {
    emit({ type: 'sdk.configured', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'Claude session is no longer available.' })
    return
  }
  try {
    const settings = await configureSession(st, req.settings ?? {}, {
      busy: req.busy === true || st.turnOpen || st.handedCompactLikely,
    })
    emit({ type: 'sdk.configured', sessionId: req.sessionId, requestId: req.requestId, ok: true, settings })
  } catch (err) {
    log('warn', 'configure.failed', { sessionId: req.sessionId, requestId: req.requestId, error: errorText(err) })
    emit({ type: 'sdk.configured', sessionId: req.sessionId, requestId: req.requestId, ok: false, settings: { ...st.settings }, message: String(err?.message || err) })
  }
}

// kata 1wxv ep4 (rollback quiesce probe): rollback pre-teardown sends this
// request instead of a bare interrupt — the answer is stream-ordered AFTER
// every already-emitted frame and carries this sidecar's OWN queue truth:
// - cancelledQueue: compact items DROPPED from the still-unhanded input
//   queue (they provably never start — the SDK owns no reference to them);
// - inFlightTurn / handedCompactLikely: evidence that provider work already
//   crossed the un-cancellable handoff — rollback must refuse (BUSY).
// The probeId echos for correlation ONLY: a quiesced frame fires exclusively
// the rollback probe that registered it (stale/mismatched receipts never
// close a live probe).
function handleRollbackQuiesce(req) {
  const st = sessions.get(req.sessionId)
  if (!st) { emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'session not found', sessionNotFound: true }); return }
  const cancelledQueue = st.inputStream.drainCompacts()
  emit({
    type: 'sdk.rollback.quiesced',
    sessionId: req.sessionId,
    probeId: req.probeId ?? null,
    cancelledQueue,
    inFlightTurn: st.turnOpen === true,
    handedCompactLikely: st.handedCompactLikely === true,
  })
}

// Faithful port of `server/sdk-bridge.ts:785-793`'s `interrupt(sessionId)`:
// `sp.query.interrupt().catch((err) => log.warn(...))` -- fire-and-forget, no reply on
// success (the Rust side mirrors this: no confirmation frame is broadcast either).
function handleInterrupt(req) {
  const st = sessions.get(req.sessionId)
  if (!st) { emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'session not found', sessionNotFound: true }); return }
  // The transport is still open here (interrupt only signals), so resolving the
  // parked requests with deny is safe — and required so the SDK's canUseTool
  // await settles instead of hanging the interrupted turn.
  cancelPending(st, emit, req.sessionId, { resolveDeny: true })
  // kata 1wxv focused ep4-r1 F1: a fire-and-forget interrupt() write proved
  // NOTHING about completion — the gate's retirement at the request site once
  // admitted rollback while the provider turn still ran (a delayed or REJECTED
  // interrupt). The retirement evidence must be the SETTLED outcome: await the
  // SDK call and emit a signed settle event in either case (rejection = the
  // turn provably still running → the gate stays closed).
  if (!st.query?.interrupt) {
    emit({ type: 'sdk.interrupt_settled', sessionId: req.sessionId, ok: false, message: 'no in-flight SDK query' })
    return
  }
  // Unified attention gate: arm the mark BEFORE the interrupt call — and ONLY
  // while a turn is plausibly awaiting a terminal frame (pendingResults > 0).
  // The SDK contract documents RESOLUTION — not rejection — for interrupting
  // with NOTHING in flight (sdk.d.ts:2384-2394: "Interrupt the current query
  // execution ... Older CLIs resolve to `undefined`"), so an idle-session
  // interrupt (a late Stop click racing the busy-clear, or a double-click's
  // second Stop) must arm NOTHING: a stray mark there would survive and eat
  // the NEXT unrelated turn's result, silently suppressing exactly the ring
  // this feature exists to produce. While a turn IS pending, the settle
  // receipt (sdk.d.ts:3765) lands BEFORE the interrupted turn's own result,
  // so the mark is consumed by exactly that result, and silences it only if
  // the Stop landed (the result was aborted). A Stop that missed — the CLI was
  // still starting (T13), or the turn finished first — leaves a result that
  // rings. A REJECTED interrupt (the turn kept running) clears the mark;
  // noteInterruptSettled stays in both promise arms — settle(true) without a
  // mark is a no-op.
  if (st.pendingResults > 0) st.turnCompleteGate.noteInterruptRequest()
  st.query.interrupt()
    .then(() => {
      st.turnCompleteGate.noteInterruptSettled(true)
      emit({ type: 'sdk.interrupt_settled', sessionId: req.sessionId, ok: true })
    })
    .catch((err) => {
      st.turnCompleteGate.noteInterruptSettled(false)
      log('warn', 'interrupt.failed', { sessionId: req.sessionId, error: errorText(err) })
      emit({ type: 'sdk.interrupt_settled', sessionId: req.sessionId, ok: false, message: String(err?.message || err) })
    })
}

function shutdown() {
  for (const [sessionId, st] of sessions) {
    // Teardown: emit the card-clearing frames but NEVER resolve parked promises
    // (LB-04 — transport closing; a late resolve is an unhandled rejection).
    cancelPending(st, emit, sessionId, { resolveDeny: false })
    try { st.abort.abort(); st.query?.close?.() } catch { /* ignore */ }
  }
  sessions.clear()
}

// ── stdin dispatch loop (newline-JSON) ───────────────────────────────────────
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  // An exiting sidecar has no session left: sdk.stream.ended stays its last line.
  if (exiting) return
  const trimmed = line.trim()
  if (!trimmed) return
  let req
  // A request line may carry prompt text: log its size, never its content.
  try { req = JSON.parse(trimmed) } catch { log('warn', 'request.unparseable', { bytes: Buffer.byteLength(trimmed) }); return }
  switch (req?.type) {
    case 'create': handleCreate(req); break
    case 'send': handleSend(req); break
    case 'configure': {
      const st = sessions.get(req.sessionId)
      if (st) st.configureChain = (st.configureChain ?? Promise.resolve()).then(() => handleConfigure(req))
      else void handleConfigure(req)
      break
    }
    case 'interrupt': handleInterrupt(req); break
    case 'rollback.quiesce': handleRollbackQuiesce(req); break
    case 'permission.respond': {
      const st = sessions.get(req.sessionId)
      if (!st) break
      // Missing decision: NEVER resolve — `undefined` is not a PermissionResult,
      // and a synthesized default would fabricate the user's choice. Log-only
      // no-op; the entry stays parked for a later valid respond (mirrors the
      // coerced-answers asymmetry one arm below).
      if (req.decision == null) {
        log('warn', 'respond.invalid', { kind: 'permission', sessionId: req.sessionId, requestId: req.requestId })
        break
      }
      // Unknown requestId: lose-safely (Rust validates its pending set first) —
      // stderr log only, no frame.
      if (!respondPermission(st, String(req.requestId), req.decision)) {
        log('warn', 'respond.unknown', { kind: 'permission', sessionId: req.sessionId, requestId: req.requestId })
      }
      break
    }
    case 'question.respond': {
      const st = sessions.get(req.sessionId)
      if (!st) break
      const answers = req.answers && typeof req.answers === 'object' ? req.answers : {}
      if (!respondQuestion(st, String(req.requestId), answers)) {
        log('warn', 'respond.unknown', { kind: 'question', sessionId: req.sessionId, requestId: req.requestId })
      }
      break
    }
    case 'shutdown': shutdown(); process.exit(0); break
    default: log('warn', 'request.unknown_type', { requestType: String(req?.type) })
  }
})
// stdin closed (Rust reaped us): abort every query and exit so no claude CLI
// grandchild is left mid-stream.
rl.on('close', () => { if (!exiting) { shutdown(); process.exit(0) } })
// stdout lost (Rust dropped our reader, e.g. a kill aborted its consumer before
// it wrote the shutdown line): nobody hears us any more, the same request as
// stdin EOF. Unhandled, the next emit's EPIPE kills node with exit 1 before
// the SDK query is aborted, and nothing stops the claude CLI: it runs on until
// it next writes into its own closed pipe or Rust kills the process tree. A
// sidecar already exiting on its own (a refused boot, an unrequested stream
// end) has closed its query and keeps its own exit code: its flush wait
// (exitWithoutSession) still ends the process.
process.stdout.on('error', (err) => {
  log('warn', 'stdout.closed', { code: err?.code ?? null, error: errorText(err) })
  if (exiting) return
  shutdown()
  process.exit(0)
})
process.on('SIGTERM', () => { shutdown(); process.exit(0) })
process.on('SIGINT', () => { shutdown(); process.exit(0) })

log('info', 'sidecar.ready', { pid: process.pid })
