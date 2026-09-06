#!/usr/bin/env node
// freshell-claude-sidecar — the ONE sanctioned Node sidecar (ADR Decision 2).
// ---------------------------------------------------------------------------
// A THIN stdio JSON protocol server wrapping @anthropic-ai/claude-agent-sdk's
// query()/session, which has NO Rust equivalent (a JS-only vendor SDK). The Rust
// harness (crates/freshell-freshagent, claude WS slice) speaks newline-delimited
// JSON to this process:
//
//   Rust → sidecar (stdin, one JSON per line):
//     { type:'create',             requestId, cwd?, model?, permissionMode?, effort?, resumeSessionId? }
//     { type:'send',               sessionId, text }
//     { type:'settings.update',    sessionId, model?, permissionMode?, effort? }   // mid-session knobs; serialized on the per-session op chain BEFORE any following send
//     { type:'interrupt',          sessionId }
//     { type:'permission.respond', sessionId, requestId, decision }   // decision forwarded VERBATIM
//     { type:'question.respond',   sessionId, requestId, answers }
//     { type:'shutdown' }
//
//   sidecar → Rust (stdout, one JSON per line):
//     { type:'created',                 requestId, sessionId }            // the SDK bridge's BARE nanoid placeholder
//     { type:'create.failed',           requestId, message }
//     { type:'sdk.session.init',        sessionId, cliSessionId, model, cwd, tools }  // durable Claude UUID
//     { type:'sdk.session.metadata',    sessionId, cliSessionId?, model? }            // post-apply settings echo (drives the client status chip)
//     { type:'sdk.assistant',           sessionId, content, model }
//     { type:'sdk.stream',              sessionId, event, parentToolUseId }
//     { type:'sdk.result',              sessionId, result, durationMs, costUsd, usage }
//     { type:'sdk.turn.complete',       sessionId, at }                   // ONLY on result subtype==='success'
//     { type:'sdk.turn.waiting',        sessionId, at }                   // 0->>=1 pending edge (claude only)
//     { type:'sdk.status',              sessionId, status }               // compacting / idle (stream end)
//     { type:'sdk.error',               sessionId, message }
//     { type:'sdk.exit',                sessionId }
//     { type:'sdk.permission.request',  sessionId, requestId, subtype:'can_use_tool', tool:{name,input}, toolUseID, suggestions, blockedPath, decisionReason }
//     { type:'sdk.question.request',    sessionId, requestId, questions }
//     { type:'sdk.permission.cancelled', sessionId, requestId }
//     { type:'sdk.question.cancelled',  sessionId, requestId }
//
// The Rust side normalizes `sdk.* -> freshAgent.*` (a port of
// server/fresh-agent/sdk-events.ts) and wraps each in a `freshAgent.event`
// envelope — so this sidecar is the faithful analog of server/sdk-bridge.ts's
// SdkBridge (it emits the SAME `sdk.*` shapes SdkBridge broadcasts).
//
// A sidecar death mid-turn can therefore NEVER produce a false completion: a
// `sdk.turn.complete` is emitted ONLY when the SDK `result` carries
// subtype==='success' — if the process dies, stdout simply ends and no completion
// is ever written. That is the new failure mode the ADR (Decision 2.1) requires.
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

// ── stdout writer (newline-JSON; stderr is the only log sink) ────────────────
function emit(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}
function logerr(msg) {
  process.stderr.write(`[claude-sidecar] ${msg}\n`)
}

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

// ── clean env (server/sdk-bridge.ts:64-66) ──────────────────────────────────
function createClaudeSdkCleanEnv(env = process.env) {
  const { CLAUDECODE: _c, ANTHROPIC_API_KEY: _k, ...cleanEnv } = env
  return cleanEnv
}

// ── streaming input stream (server/sdk-bridge.ts:274-316) ────────────────────
function createInputStream() {
  const queue = []
  let waiting = null
  let done = false
  const handle = {
    push: (msg) => {
      if (waiting) { const r = waiting; waiting = null; r({ value: msg, done: false }) }
      else queue.push(msg)
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
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { waiting = resolve })
        },
      }
    },
  }
  return { iterable, handle }
}

// ── per-session monotonic turn-complete/waiting clock (turn-complete-clock.ts) ─
function nextMonotonic(last, now) {
  return last != null && now <= last ? last + 1 : now
}

/** @type {Map<string, {inputStream:{push:Function,end:Function}, abort:AbortController, chain:Promise<void>, model?:string, permissionMode?:string, effort?:string, cliSessionId?:string, lastTurnCompleteAt?:number, lastWaitingAt?:number, pendingPermissions?:Map<string,any>, pendingQuestions?:Map<string,any>}>} */
const sessions = new Map()

// ── per-session serialized op chain (Task z7j7-3) ────────────────────────────
// The stdin dispatch loop's handlers are SYNCHRONOUS, so a naive `await` inside
// a settings update would let the FOLLOWING `send` line race past the in-flight
// control requests. `enqueue` re-arms every ordered op (settings application,
// user-message push) on a per-session promise chain: a user message NEVER
// overtakes a pending settings application. The chain self-heals — a rejected
// op is swallowed into the chain state so one failure never wedges the session.
function enqueue(st, op) {
  const run = st.chain.then(op, op)
  st.chain = run.catch(() => {})
  return st.chain
}

// The mid-session knob sets — EXACTLY the client's offered values
// (shared/fresh-agent-models.ts / FreshAgentSettingsButton.tsx; the Rust side
// validates the same lists before writing the frame).
const SIDECAR_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const SIDECAR_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan'])

// Every SDK control call is bounded (Task z7j7-3): a never-answering SDK
// surface must surface an sdk.error and RELEASE the op chain, never wedge it.
const CONTROL_CALL_TIMEOUT_MS = 10_000
function withControlCallTimeout(promise, label) {
  let timer
  const bounded = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${CONTROL_CALL_TIMEOUT_MS}ms`)), CONTROL_CALL_TIMEOUT_MS)
  })
  // Once the race settles, drop the pending bound: a settled control call must
  // not leave a 10s timer alive (its eventual reject on an already-settled race
  // would be a no-op, but the timer itself is dead weight). On the timeout path
  // the timer has already fired, so clearing it is a no-op and that path's
  // behavior is unchanged.
  return Promise.race([promise, bounded]).finally(() => clearTimeout(timer))
}

// ── SDK message -> sdk.* event (faithful port of SdkBridge.handleSdkMessage) ──
function handleSdkMessage(sessionId, msg) {
  const st = sessions.get(sessionId)
  if (!st) return

  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        st.cliSessionId = msg.session_id
        emit({
          type: 'sdk.session.init',
          sessionId,
          cliSessionId: msg.session_id,
          model: msg.model,
          cwd: msg.cwd,
          tools: Array.isArray(msg.tools) ? msg.tools.map((t) => ({ name: t })) : undefined,
        })
      } else if (msg.subtype === 'status' && msg.status === 'compacting') {
        emit({ type: 'sdk.status', sessionId, status: 'compacting' })
      }
      break
    }
    case 'assistant': {
      const content = msg.message?.content || []
      const blocks = content.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text }
        if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking }
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
        if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error }
        return b
      })
      emit({ type: 'sdk.assistant', sessionId, content: blocks, model: msg.message?.model })
      break
    }
    case 'result': {
      const usage = msg.usage
        ? {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
            cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
            cache_read_input_tokens: msg.usage.cache_read_input_tokens,
          }
        : undefined
      emit({ type: 'sdk.result', sessionId, result: msg.subtype, durationMs: msg.duration_ms, costUsd: msg.total_cost_usd, usage })
      // Server-authoritative completion edge: ONLY a positively-completed turn
      // ('success') chimes. Interrupts yield no result at all; errored turns carry
      // a non-success subtype — so this never fires green on an aborted/errored turn.
      if (msg.subtype === 'success') {
        const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
        st.lastTurnCompleteAt = at
        emit({ type: 'sdk.turn.complete', sessionId, at })
      }
      break
    }
    case 'stream_event': {
      emit({ type: 'sdk.stream', sessionId, event: msg.event, parentToolUseId: msg.parent_tool_use_id })
      break
    }
    default:
      // Unhandled SDK message type — ignored (matches SdkBridge default).
      break
  }
}

async function consumeStream(sessionId, sdkQuery) {
  const st = sessions.get(sessionId)
  try {
    for await (const msg of sdkQuery) handleSdkMessage(sessionId, msg)
  } catch (err) {
    emit({ type: 'sdk.error', sessionId, message: `SDK error: ${err?.message || 'Unknown error'}` })
  } finally {
    // Stream ended (natural end, error, or abort). The transport is closing:
    // clear any parked cards WITHOUT resolving their promises (LB-04: a late
    // resolve lands inside the SDK's floating promise chain → unhandled
    // rejection → crash under Node 22 throw-mode).
    if (st) {
      cancelPending(st, emit, sessionId, { resolveDeny: false })
    }
    // Mirror SdkBridge: an aborted session surfaces sdk.exit; a natural end
    // surfaces an idle status. NEITHER is a completion chime, so a mid-turn
    // death cannot fake a turn.complete.
    if (st?.abort.signal.aborted) emit({ type: 'sdk.exit', sessionId })
    else emit({ type: 'sdk.status', sessionId, status: 'idle' })
    sessions.delete(sessionId)
  }
}

// ── request handlers ─────────────────────────────────────────────────────────
function handleCreate(req) {
  const requestId = req.requestId
  let sessionId
  try {
    sessionId = nanoid()
    const abort = new AbortController()
    const { iterable, handle } = createInputStream()
    // Liveness IS session-map membership: consumeStream's finally removes the
    // session synchronously after cancelPending (LB-04 — a parked canUseTool
    // promise must never be resolved after transport close), and stdin line
    // events (macrotasks) cannot interleave inside that finally.
    // Task z7j7-3: state gains the serialized op chain + the session's settings
    // baseline copies (seeded from the create frame; handleSettingsUpdate moves
    // them ONLY on control-call success — no baseline mutation on failure).
    const state = {
      inputStream: handle,
      abort,
      chain: Promise.resolve(),
      model: req.model,
      permissionMode: req.permissionMode,
      effort: req.effort,
    }
    sessions.set(sessionId, state)

    const sdkQuery = query({
      prompt: iterable,
      options: {
        cwd: req.cwd || undefined,
        resume: req.resumeSessionId,
        model: req.model,
        permissionMode: req.permissionMode,
        effort: req.effort,
        pathToClaudeCodeExecutable: process.env.CLAUDE_CMD || undefined,
        includePartialMessages: true,
        abortController: abort,
        env: createClaudeSdkCleanEnv(process.env),
        settingSources: ['user', 'project', 'local'],
        stderr: (data) => logerr(`sdk stderr: ${String(data).trimEnd()}`),
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
    state.query = sdkQuery

    // Placeholder returns IMMEDIATELY (the SDK query is lazy) — exactly as
    // SdkBridge.createSession returns the nanoid before system/init arrives.
    emit({ type: 'created', requestId, sessionId })
    consumeStream(sessionId, sdkQuery).catch((err) => logerr(`consume error: ${err?.message}`))
  } catch (err) {
    if (sessionId) sessions.delete(sessionId)
    emit({ type: 'create.failed', requestId, message: err?.message || String(err) })
  }
}

function handleSend(req) {
  const st = sessions.get(req.sessionId)
  if (!st) { emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'session not found' }); return }
  // Re-arm the push through the per-session op chain: a user message never
  // overtakes a pending settings application (Task z7j7-3).
  enqueue(st, () => {
    st.inputStream.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: req.text }] },
      parent_tool_use_id: null,
      session_id: st.cliSessionId || 'default',
    })
  })
}

// Task z7j7-3: mid-session settings application. Validates the incoming knobs
// BEFORE enqueuing anything (defense in depth on the internal frame — Rust's
// handle_send validates the same lists first): an invalid knob refuses the
// WHOLE update loudly on sdk.error and applies nothing. A valid update applies
// the CHANGED knobs on the serialized op chain (setPermissionMode → setModel →
// applyFlagSettings, each 10s-bounded), moving each baseline copy ONLY after
// its control call succeeds — on failure nothing mutates, an sdk.error is
// emitted, and a later retry of the same knob re-fires its control call
// (baseline diff). The unchanged-knob skip keeps the client's always-shipped
// selection from costing three control round-trips per message. On success the
// fresh baseline echoes back as sdk.session.metadata (the Rust consumer
// normalizes it to freshAgent.session.metadata → the client status chip).
function handleSettingsUpdate(req) {
  const st = sessions.get(req.sessionId)
  if (!st) { emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'session not found' }); return }
  if (req.effort != null && !SIDECAR_EFFORT_LEVELS.has(req.effort)) {
    emit({ type: 'sdk.error', sessionId: req.sessionId, message: `invalid effort level for settings.update: ${req.effort}` })
    return
  }
  if (req.permissionMode != null && !SIDECAR_PERMISSION_MODES.has(req.permissionMode)) {
    emit({ type: 'sdk.error', sessionId: req.sessionId, message: `invalid permission mode for settings.update: ${req.permissionMode}` })
    return
  }
  enqueue(st, async () => {
    try {
      if (req.permissionMode != null && req.permissionMode !== st.permissionMode) {
        await withControlCallTimeout(st.query.setPermissionMode(req.permissionMode), 'setPermissionMode')
        st.permissionMode = req.permissionMode
      }
      if (req.model != null && req.model !== st.model) {
        await withControlCallTimeout(st.query.setModel(req.model), 'setModel')
        st.model = req.model
      }
      if (req.effort != null && req.effort !== st.effort) {
        await withControlCallTimeout(st.query.applyFlagSettings({ effortLevel: req.effort }), 'applyFlagSettings')
        st.effort = req.effort
      }
    } catch (err) {
      emit({ type: 'sdk.error', sessionId: req.sessionId, message: `settings update failed: ${err?.message || err}` })
      return
    }
    emit({ type: 'sdk.session.metadata', sessionId: req.sessionId, cliSessionId: st.cliSessionId, model: st.model })
  })
}

// Faithful port of `server/sdk-bridge.ts:785-793`'s `interrupt(sessionId)`:
// `sp.query.interrupt().catch((err) => log.warn(...))` -- fire-and-forget, no reply on
// success (the Rust side mirrors this: no confirmation frame is broadcast either).
function handleInterrupt(req) {
  const st = sessions.get(req.sessionId)
  if (!st) { emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'session not found' }); return }
  // The transport is still open here (interrupt only signals), so resolving the
  // parked requests with deny is safe — and required so the SDK's canUseTool
  // await settles instead of hanging the interrupted turn.
  cancelPending(st, emit, req.sessionId, { resolveDeny: true })
  st.query?.interrupt?.().catch((err) => {
    logerr(`interrupt failed: ${err?.message || err}`)
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
  const trimmed = line.trim()
  if (!trimmed) return
  let req
  try { req = JSON.parse(trimmed) } catch { logerr(`unparseable request: ${trimmed.slice(0, 200)}`); return }
  switch (req?.type) {
    case 'create': handleCreate(req); break
    case 'send': handleSend(req); break
    case 'settings.update': handleSettingsUpdate(req); break
    case 'interrupt': handleInterrupt(req); break
    case 'permission.respond': {
      const st = sessions.get(req.sessionId)
      if (!st) break
      // Missing decision: NEVER resolve — `undefined` is not a PermissionResult,
      // and a synthesized default would fabricate the user's choice. Log-only
      // no-op; the entry stays parked for a later valid respond (mirrors the
      // coerced-answers asymmetry one arm below).
      if (req.decision == null) {
        logerr(`permission.respond: missing decision for request ${req.requestId} (session ${req.sessionId})`)
        break
      }
      // Unknown requestId: lose-safely (Rust validates its pending set first) —
      // stderr log only, no frame.
      if (!respondPermission(st, String(req.requestId), req.decision)) {
        logerr(`permission.respond: no pending request ${req.requestId} for session ${req.sessionId}`)
      }
      break
    }
    case 'question.respond': {
      const st = sessions.get(req.sessionId)
      if (!st) break
      const answers = req.answers && typeof req.answers === 'object' ? req.answers : {}
      if (!respondQuestion(st, String(req.requestId), answers)) {
        logerr(`question.respond: no pending request ${req.requestId} for session ${req.sessionId}`)
      }
      break
    }
    case 'shutdown': shutdown(); process.exit(0); break
    default: logerr(`unknown request type: ${req?.type}`)
  }
})
// stdin closed (Rust reaped us): abort every query and exit so no claude CLI
// grandchild is left mid-stream.
rl.on('close', () => { shutdown(); process.exit(0) })
process.on('SIGTERM', () => { shutdown(); process.exit(0) })
process.on('SIGINT', () => { shutdown(); process.exit(0) })

logerr('ready')
