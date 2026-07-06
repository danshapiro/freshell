#!/usr/bin/env node
// freshell-claude-sidecar — the ONE sanctioned Node sidecar (ADR Decision 2).
// ---------------------------------------------------------------------------
// A THIN stdio JSON protocol server wrapping @anthropic-ai/claude-agent-sdk's
// query()/session, which has NO Rust equivalent (a JS-only vendor SDK). The Rust
// harness (crates/freshell-freshagent, claude WS slice) speaks newline-delimited
// JSON to this process:
//
//   Rust → sidecar (stdin, one JSON per line):
//     { type:'create', requestId, cwd?, model?, permissionMode?, effort?, resumeSessionId? }
//     { type:'send',   sessionId, text }
//     { type:'shutdown' }
//
//   sidecar → Rust (stdout, one JSON per line):
//     { type:'created',           requestId, sessionId }            // the SDK bridge's BARE nanoid placeholder
//     { type:'create.failed',     requestId, message }
//     { type:'sdk.session.init',  sessionId, cliSessionId, model, cwd, tools }  // durable Claude UUID
//     { type:'sdk.assistant',     sessionId, content, model }
//     { type:'sdk.stream',        sessionId, event, parentToolUseId }
//     { type:'sdk.result',        sessionId, result, durationMs, costUsd, usage }
//     { type:'sdk.turn.complete', sessionId, at }                   // ONLY on result subtype==='success'
//     { type:'sdk.turn.waiting',  sessionId, at }                   // 0->>=1 pending edge (claude only)
//     { type:'sdk.status',        sessionId, status }               // compacting / idle (stream end)
//     { type:'sdk.error',         sessionId, message }
//     { type:'sdk.exit',          sessionId }
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
// node grandchild bound to the REST API. The full interactive permission/question
// RESPONSE channel is likewise out of scope (the T2 turn runs bypassPermissions);
// the 0->>=1 waiting edge IS surfaced (sdk.turn.waiting), then allowed, so an
// unattended turn can never hang.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'

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

/** @type {Map<string, {inputStream:{push:Function,end:Function}, abort:AbortController, permissionMode?:string, cliSessionId?:string, lastTurnCompleteAt?:number, lastWaitingAt?:number}>} */
const sessions = new Map()

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
    // Stream ended (natural end, error, or abort). Mirror SdkBridge: an aborted
    // session surfaces sdk.exit; a natural end surfaces an idle status. NEITHER is
    // a completion chime, so a mid-turn death cannot fake a turn.complete.
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
    const state = { inputStream: handle, abort, permissionMode: req.permissionMode }
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
        canUseTool: async (_toolName, input) => {
          const s = sessions.get(sessionId)
          if (s?.permissionMode === 'bypassPermissions') return { behavior: 'allow', updatedInput: input }
          // Surface the 0->>=1 pending waiting edge, then allow (unattended: never
          // hang). The interactive response channel is out of scope for the T2 slice.
          const at = nextMonotonic(s?.lastWaitingAt, Date.now())
          if (s) s.lastWaitingAt = at
          emit({ type: 'sdk.turn.waiting', sessionId, at })
          return { behavior: 'allow', updatedInput: input }
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
  st.inputStream.push({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: req.text }] },
    parent_tool_use_id: null,
    session_id: st.cliSessionId || 'default',
  })
}

function shutdown() {
  for (const [, st] of sessions) {
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
