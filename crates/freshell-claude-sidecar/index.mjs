#!/usr/bin/env node
// freshell-claude-sidecar — the ONE sanctioned Node sidecar (ADR Decision 2).
// ---------------------------------------------------------------------------
// A THIN stdio JSON protocol server wrapping @anthropic-ai/claude-agent-sdk's
// query()/session, which has NO Rust equivalent (a JS-only vendor SDK). The Rust
// harness (crates/freshell-freshagent, claude WS slice) speaks newline-delimited
// JSON to this process:
//
//   Rust → sidecar (stdin, one JSON per line):
//     { type:'create',             requestId, cwd?, model?, permissionMode?, effort?, resumeSessionId?,
//                                    resumeSessionAt?, forkSession?, resumeDropsTurn? }
//                                  — kata 1wxv Task 4 fork-at-point keys ride the SDK query() options
//                                    verbatim (resumeSessionAt keeps through-AND-including the named
//                                    uuid over the raw parentUuid chain; forkSession mints a NEW
//                                    durable session id and never rewrites the original's JSONL;
//                                    resumeDropsTurn arms the fork-time discard-guard). Covered by
//                                    crates/freshell-ws/tests/freshagent_claude_rollback.rs + the
//                                    rust-chromium e2e rollback spec.
//     { type:'configure',          sessionId, requestId, settings }
//     { type:'send',               sessionId, text, images? }
//     { type:'interrupt',          sessionId }
//     { type:'permission.respond', sessionId, requestId, decision }   // decision forwarded VERBATIM
//     { type:'question.respond',   sessionId, requestId, answers }
//     { type:'shutdown' }
//
//   sidecar → Rust (stdout, one JSON per line):
//     { type:'created',                 requestId, sessionId }            // the SDK bridge's BARE nanoid placeholder
//     { type:'create.failed',           requestId, message }
//     { type:'sdk.configured',          sessionId, requestId, ok, settings?, message? }
//     { type:'sdk.session.init',        sessionId, cliSessionId, model, cwd, tools }  // durable Claude UUID
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
import { configureSession, userMessageContent, resultErrorMessage } from './session-settings.mjs'
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
  process.stderr.write(`${JSON.stringify({ severity: 'warn', component: 'claude-sidecar', message: msg })}\n`)
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

// ── per-session monotonic turn-complete/waiting clock (turn-complete-clock.ts) ─
function nextMonotonic(last, now) {
  return last != null && now <= last ? last + 1 : now
}

/** @type {Map<string, {inputStream:{push:Function,end:Function}, abort:AbortController, permissionMode?:string, cliSessionId?:string, lastTurnCompleteAt?:number, lastWaitingAt?:number, pendingPermissions?:Map<string,any>, pendingQuestions?:Map<string,any>}>} */
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

function publishCommands(sessionId, state) {
  if (!state.commandsInitSeen || state.commandCatalog === undefined) return
  const terminal = new Set(state.terminalCommandNames ?? [])
  const commands = state.commandCatalog.filter((row) => !terminal.has(row.name))
  emit({ type: 'sdk.session.changed', sessionId, reason: 'session-commands', commands })
}

// ── SDK message -> sdk.* event (faithful port of SdkBridge.handleSdkMessage) ──
function handleSdkMessage(sessionId, msg) {
  const st = sessions.get(sessionId)
  if (!st) return

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
    case 'system': {
      if (msg.subtype === 'init') {
        st.cliSessionId = msg.session_id
        st.settings.cwd ??= msg.cwd
        st.commandsInitSeen = true
        st.terminalCommandNames = Array.isArray(msg.terminal_slash_commands) ? msg.terminal_slash_commands : []
        emit({
          type: 'sdk.session.init',
          sessionId,
          cliSessionId: msg.session_id,
          model: msg.model,
          cwd: msg.cwd,
          tools: Array.isArray(msg.tools) ? msg.tools.map((t) => ({ name: t })) : undefined,
        })
        publishCommands(sessionId, st)
      } else if (msg.subtype === 'commands_changed') {
        const commands = normalizeCommands(msg.commands, true)
        if (commands !== undefined) {
          st.commandCatalog = commands
          st.commandsChangedSeen = true
          publishCommands(sessionId, st)
        }
      } else if (msg.subtype === 'status' && msg.status === 'compacting') {
        emit({ type: 'sdk.status', sessionId, status: 'compacting' })
      } else if (msg.subtype === 'compact_boundary') {
        // kata 1wxv ep3-r1 F1: the bare compacting STATUS frame carries no
        // trigger — the SDK fires it for an explicit `/compact` AND for its
        // own automatic context compaction, and misattributing the automatic
        // one to a queued explicit compact wedges the rollback busy gate
        // (the phantom compact absorbs the turn's own terminal edge). Only the
        // compact COMPLETION boundary discriminates the trigger; relay it.
        // Fail toward 'auto' on a missing/unknown trigger so promotion to a
        // queued explicit compact never happens without a proven manual run.
        const trigger = msg.compact_metadata?.trigger === 'manual' ? 'manual' : 'auto'
        emit({ type: 'sdk.compact_boundary', sessionId, trigger })
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
      const failure = resultErrorMessage(msg)
      if (failure) emit({ type: 'sdk.error', sessionId, message: failure, turnFailure: true })
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
    // ep4-r3/ep4-r4 quiesce state (declared first so the stream can arm it):
    // turnOpen — an SDK turn is mid-flight (cleared at its result);
    // handedCompactLikely — a compact crossed the un-cancellable SDK handoff
    // (same-tick push OR queued pull — either path); cleared at the next
    // result or observed status frame (its evidence has by then reached Rust).
    const state = {
      abort,
      permissionMode: req.permissionMode,
      settings: { model: req.model, effort: req.effort, permissionMode: req.permissionMode, cwd: req.cwd },
      turnOpen: false,
      handedCompactLikely: false,
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

    const sdkQuery = query({
      prompt: iterable,
      options: {
        cwd: req.cwd || undefined,
        resume: req.resumeSessionId,
        // kata 1wxv Task 4 (fork-at-point emulation): the ONLY sanctioned lane is
        // the query() options triple — NEVER the standalone forkSession() fn (it
        // remaps every uuid).
        resumeSessionAt: req.resumeSessionAt || undefined,
        forkSession: req.forkSession === true || undefined,
        resumeDropsTurn: req.resumeDropsTurn || undefined,
        model: req.model,
        permissionMode: req.permissionMode,
        // Enables the user's in-session permission selector; the selected mode
        // still controls whether approval is required for each tool.
        allowDangerouslySkipPermissions: true,
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
    state.commandsChangedSeen = false
    if (typeof sdkQuery.supportedCommands === 'function') {
      Promise.resolve().then(() => sdkQuery.supportedCommands()).then((rows) => {
        if (state.query !== sdkQuery || state.commandsChangedSeen) return
        const commands = normalizeCommands(rows)
        if (commands === undefined) return
        state.commandCatalog = commands
        publishCommands(sessionId, state)
      }).catch((error) => logerr(`session commands unavailable: ${error?.message || error}`))
    }

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
  // ep3-r2 F2: the signed frame — when the JS session is gone but stdout stays
  // open (consumeStream deleted it), NO terminal edge or EOF follows; the Rust
  // busy tracker must fold this specific failure as provider-session death.
  if (!st) { emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'session not found', sessionNotFound: true }); return }
  // ep4-r3: /compact is the only dispatch rollback ever absorbs; mark it so
  // the quiesce handler can drain never-handed compacts from the input queue
  // and so a same-tick handoff arms the BUSY-forcing handed flag.
  const isCompact = /^\s*\/compact(\s|$)/.test(String(req.text ?? ''))
  st.inputStream.push(
    {
      type: 'user',
      message: { role: 'user', content: userMessageContent(req.text, req.images) },
      parent_tool_use_id: null,
      session_id: st.cliSessionId || 'default',
    },
    isCompact,
  )
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
    logerr(`session settings failed: ${err?.message || err}`)
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
  st.query.interrupt()
    .then(() => emit({ type: 'sdk.interrupt_settled', sessionId: req.sessionId, ok: true }))
    .catch((err) => {
      logerr(`interrupt failed: ${err?.message || err}`)
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
  const trimmed = line.trim()
  if (!trimmed) return
  let req
  try { req = JSON.parse(trimmed) } catch { logerr(`unparseable request: ${trimmed.slice(0, 200)}`); return }
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
