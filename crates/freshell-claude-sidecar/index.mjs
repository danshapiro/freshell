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
//     { type:'sdk.turn.complete',       sessionId, at }                   // EVERY result (any subtype) except
//                                  the interrupted turn's own (an accepted user interrupt's mark consumes
//                                  it — turn-complete-gate.mjs); also minted from consumeStream's finally
//                                  when a turn ends with NO result frame (stream exception or natural EOF
//                                  with a send still pending) — the abort/sdk.exit requested-teardown path
//                                  stays silent
//     { type:'sdk.turn.waiting',        sessionId, at }                   // 0->>=1 pending edge (written by this sidecar; codex controls emits its own waiting edge outside the sidecar lane)
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
// A sidecar death mid-turn can therefore NEVER produce a false completion
// from this process's own stdout: `sdk.turn.complete` rides every SDK
// `result` (the unified needs-attention edge — the interrupted turn's own
// result is consumed silently by the accepted-interrupt mark) plus the
// consumeStream finally mint for a result-less turn end (stream exception or
// natural EOF with a send pending; never the aborted/sdk.exit teardown). If
// the PROCESS dies mid-turn, stdout simply ends and no completion is ever
// written — that unrequested death is what the Rust-side death synthesis
// (ADR Decision 2.1) rings for.
//
// Scope discipline (ADR "keep it minimal — only what the claude T2 invariant set
// needs"): the freshell MCP-server injection (createClaudeSdkMcpServers) is
// DELIBERATELY OMITTED — a pinned pure-text T2 turn never calls a tool, MCP tools
// are not in the T2 baseline, and injecting the MCP server would spawn an extra
// node grandchild bound to the REST API. The interactive permission/question
// RESPONSE channel IS in scope (permission-channel.mjs, a faithful port of
// server/sdk-bridge.ts): canUseTool parks a pending request, surfaces
// sdk.permission.request / sdk.question.request, and waits for the Rust side's
// permission.respond / question.respond (unknown respond ids return a typed
// rejection). Managed dispatch acknowledgements follow the actual native stdin
// control write; they do not certify a tool effect. The auto-allow shortcut remains ONLY for unbound legacy bypassPermissions sessions
// (AskUserQuestion still routes to the question path first, per legacy ordering).

import { createInterface } from 'node:readline'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { configureSession, userMessageContent, resultErrorMessage } from './session-settings.mjs'
import { createTurnCompleteGate } from './turn-complete-gate.mjs'
import { nextMonotonic } from './monotonic-clock.mjs'
import { createNativeSessionChannel, inspectNativeForkSource, nativeInputDigest } from './native-session-channel.mjs'
import { createNativeCheckpointStore } from './native-checkpoint-state.mjs'
import { spawnObservedNative } from './native-process.mjs'
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
  const { CLAUDECODE: _c, ANTHROPIC_API_KEY: apiKey, FRESHELL_CLAUDE_ONECLI_API_KEY: onecliApiKey, ...cleanEnv } = env
  if (onecliApiKey === '1' && apiKey) cleanEnv.ANTHROPIC_API_KEY = apiKey
  return cleanEnv
}

// Bind only the selected native profile, excluding rotating grant/auth files.
// These are known settings/plugin resources, never a native identity search.
async function nativeProfileDigest(req, settings) {
  const digest = createHash('sha256')
  digest.update(JSON.stringify({ cwd: req.cwd ?? null, model: settings.model ?? null,
    effort: settings.effort ?? null, permissionMode: settings.permissionMode ?? null,
    plugins: req.plugins ?? [] }))
  const userDirectory = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? '', '.claude')
  const projectDirectory = join(resolve(req.cwd ?? process.cwd()), '.claude')
  let bytesRead = 0
  async function addFile(path) {
    try {
      const bytes = await readFile(path)
      bytesRead += bytes.length
      if (bytesRead > 32 * 1024 * 1024) throw new Error('selected native profile exceeds bounded read')
      digest.update(path).update('\0').update(bytes).update('\0')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      digest.update(path).update('\0absent\0')
    }
  }
  for (const path of [join(userDirectory, 'settings.json'), join(projectDirectory, 'settings.json'),
    join(projectDirectory, 'settings.local.json')]) await addFile(path)
  async function addPlugin(directory) {
    for (const name of (await readdir(directory)).sort()) {
      if (name === '.git') continue
      const path = join(directory, name)
      const metadata = await lstat(path)
      if (metadata.isDirectory()) await addPlugin(path)
      else if (metadata.isFile()) await addFile(path)
      else throw new Error('selected native plugin resource is unsupported')
    }
  }
  for (const plugin of req.plugins ?? []) await addPlugin(plugin)
  return digest.digest('hex')
}

// Hold an original operation that reaches its native hook or permission
// callback during exact resume behind the current managed release fence.
// The native permission resolver retains its ordinary policy afterward.
async function waitForNativeCheckpointRelease(state, input, generation, hookSignal) {
  if (state.nativePendingOperation) return false
  let release
  const released = new Promise((resolve) => { release = resolve })
  const pending = { generation, toolUseID: input.tool_use_id,
    inputDigest: nativeInputDigest(input.tool_input), release }
  state.nativePendingOperation = pending
  const cancelled = () => release(false)
  state.abort.signal.addEventListener('abort', cancelled, { once: true })
  hookSignal?.addEventListener('abort', cancelled, { once: true })
  try {
    const record = await state.nativeStore.readRecoverable()
    if (state.nativeContinuation) {
      const original = state.nativeContinuation.checkpoint
      return original.toolUseID === pending.toolUseID && original.inputDigest === pending.inputDigest
    }
    if (!record) return await state.nativeStore.inputState() === 'clear' ? null : false
    if (record.toolUseID !== pending.toolUseID || record.inputDigest !== pending.inputDigest) return false
    if (state.abort.signal.aborted || hookSignal?.aborted) return false
    return await released && state.queryGeneration === generation && state.nativeReady
      && state.nativeContinuation?.toolUseID === pending.toolUseID
      && state.nativeContinuation?.inputDigest === pending.inputDigest
  } catch {
    return false
  } finally {
    state.abort.signal.removeEventListener('abort', cancelled)
    hookSignal?.removeEventListener('abort', cancelled)
    if (state.nativePendingOperation === pending) state.nativePendingOperation = undefined
  }
}

async function routeNativePermission({ session, sessionId, req, launch, generation, toolName, input, options }) {
  let currentOptions = options
  if (session.nativeStore && req.resumeSessionId && !session.nativeContinuation) {
    const resumed = await waitForNativeCheckpointRelease(session,
      { tool_use_id: options?.toolUseID, tool_input: input }, generation, options?.signal)
    if (resumed === false) return { behavior: 'deny', message: 'Original native checkpoint has no current fenced release' }
  }
  const record = session.nativeContinuation
  if (record) {
    const binding = { launch, queryGeneration: generation, nativeRequestId: options?.requestId }
    if (toolName !== 'Bash' || await nativeProfileDigest(req, session.settings) !== record.profileDigest
      || !await session.nativeStore.parkPermission(options?.toolUseID, nativeInputDigest(input), binding)
      || session.queryGeneration !== generation || !session.nativeReady) {
      return { behavior: 'deny', message: 'Current original native checkpoint is unavailable' }
    }
    currentOptions = { ...options, publicDecisionId: 'checkpoint-' + record.checkpoint.checkpointUuid,
      nativeCheckpoint: { ...record.checkpoint, profileDigest: record.profileDigest }, nativeBinding: binding }
  }
  return routeCanUseTool({ session, emit, nanoid, nextMonotonic, sessionId, toolName, input, options: currentOptions })
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

function publishCommands(sessionId, state) {
  if (!state.commandsInitSeen || state.commandCatalog === undefined) return
  const terminal = new Set(state.terminalCommandNames ?? [])
  const commands = state.commandCatalog.filter((row) => !terminal.has(row.name))
  emit({ type: 'sdk.session.changed', sessionId, reason: 'session-commands', commands })
}

// ── SDK message -> sdk.* event (faithful port of SdkBridge.handleSdkMessage) ──
async function handleSdkMessage(sessionId, msg) {
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
        if (st.nativeChannel && !st.nativeReady) return
        if (st.nativeReady && st.cliSessionId !== msg.session_id) {
          emit({ type: 'sdk.error', sessionId, message: 'native root changed after startup' })
          st.abort.abort()
          return
        }
        st.cliSessionId = msg.session_id
        st.settings.cwd ??= msg.cwd
        st.commandsInitSeen = true
        st.terminalCommandNames = Array.isArray(msg.terminal_slash_commands) ? msg.terminal_slash_commands : []
        emit({
          type: 'sdk.session.init',
          sessionId,
          cliSessionId: msg.session_id,
          cliVersion: msg.claude_code_version,
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
      const tools = content.filter((block) => block.type === 'tool_use')
      if (st.nativeChannel && msg.session_id === st.cliSessionId && msg.parent_tool_use_id == null
        && st.nativeBatch?.id === msg.message?.id) {
        for (const tool of tools) {
          st.nativeBatch.tools.set(tool.id, tool)
          st.nativeBatch.assistantToolIds.add(tool.id)
        }
      }
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
    case 'user': {
      const content = Array.isArray(msg.message?.content) ? msg.message.content.filter((block) => block.type === 'tool_result') : []
      if (st.nativeContinuation && msg.session_id === st.cliSessionId) {
        for (const block of content) {
          if (await st.nativeStore.finishNativeResult(block.tool_use_id, block.is_error)) st.nativeContinuation = undefined
        }
      }
      if (content.length) emit({ type: 'sdk.tool.result', sessionId, nativeSessionId: msg.session_id,
        uuid: msg.uuid, parentToolUseId: msg.parent_tool_use_id, content })
      break
    }
    case 'result': {
      if (st.nativeChannel && msg.stop_reason === 'tool_deferred') {
        const tool = msg.deferred_tool_use
        if (!tool || tool.name !== 'Bash' || msg.session_id !== st.cliSessionId
          || nativeSoloTool(st)?.id !== tool.id || nativeInputDigest(nativeSoloTool(st).input) !== nativeInputDigest(tool.input)) {
          throw new Error('native deferred result does not match the original solo operation')
        }
        // The native result can precede its asynchronous JSONL publication.
        // Wait boundedly for the real checkpoint, retaining the same query and
        // no-effect fence; a result alone never exposes a pending card.
        const query = st.query
        const deadline = Date.now() + 3_000
        let record
        while (Date.now() < deadline) {
          if (st.query !== query || st.abort.signal.aborted) throw new Error('native checkpoint publication cancelled')
          record = await st.nativeStore.publish(tool.id, nativeInputDigest(tool.input))
          if (record) break
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        if (!record) throw new Error('native deferred checkpoint is unavailable or ambiguous')
        if (st.query !== query || st.abort.signal.aborted) throw new Error('native checkpoint publication cancelled')
        await continueNativeCheckpoint(sessionId, st, record)
        break
      }
      // The awaited turn's terminal frame arrived: drop one pending send
      // (clamped at 0 — an unsolicited result must not underflow the counter).
      st.pendingResults = Math.max(0, st.pendingResults - 1)
      const usage = msg.usage
        ? {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
            cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
            cache_read_input_tokens: msg.usage.cache_read_input_tokens,
          }
        : undefined
      emit({ type: 'sdk.result', sessionId, result: msg.subtype, durationMs: msg.duration_ms, costUsd: msg.total_cost_usd, usage,
        nativeSessionId: msg.session_id, uuid: msg.uuid, isError: msg.is_error, stopReason: msg.stop_reason,
        permissionDenials: msg.permission_denials, deferredToolUse: msg.deferred_tool_use })
      const failure = resultErrorMessage(msg)
      if (failure) emit({ type: 'sdk.error', sessionId, message: failure, turnFailure: true })
      // Unified attention edge: any turn end rings unless this result is the
      // interrupted turn's own (the SDK contract orders the settle receipt
      // before it). No outcome rides the wire — the client treats all ends
      // identically.
      if (st.turnCompleteGate.resultEmitsAttention()) {
        const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
        st.lastTurnCompleteAt = at
        emit({ type: 'sdk.turn.complete', sessionId, at })
      }
      break
    }
    case 'stream_event': {
      if (st.nativeChannel && msg.session_id === st.cliSessionId && msg.parent_tool_use_id == null) {
        const event = msg.event
        if (event?.type === 'message_start') {
          st.nativeBatch = typeof event.message?.id === 'string' && event.message.id
            ? { id: event.message.id, tools: new Map(), assistantToolIds: new Set(), complete: false } : undefined
        } else if (st.nativeBatch && event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          st.nativeBatch.tools.set(event.content_block.id, event.content_block)
        } else if (st.nativeBatch && event?.type === 'message_stop') {
          st.nativeBatch.complete = true
        }
      }
      emit({ type: 'sdk.stream', sessionId, event: msg.event, parentToolUseId: msg.parent_tool_use_id })
      break
    }
    default:
      // Unhandled SDK message type — ignored (matches SdkBridge default).
      break
  }
}

function nativeSoloTool(state) {
  const batch = state.nativeBatch
  if (!batch?.complete || batch.tools.size !== 1) return undefined
  const tool = batch.tools.values().next().value
  return batch.assistantToolIds.has(tool.id) ? tool : undefined
}

async function consumeStream(sessionId, sdkQuery) {
  const st = sessions.get(sessionId)
  const nativeChannel = st?.nativeChannel
  const abort = st?.abort
  try {
    for await (const msg of sdkQuery) {
      if (st?.query === sdkQuery && sessions.get(sessionId) === st) await handleSdkMessage(sessionId, msg)
    }
  } catch (err) {
    if (st?.query === sdkQuery) emit({ type: 'sdk.error', sessionId, message: `SDK error: ${err?.message || 'Unknown error'}` })
  } finally {
    if (st?.query !== sdkQuery) {
      abort?.abort()
      await nativeChannel?.cleanup()
      return
    }
    // Stream ended (natural end, error, or abort). The transport is closing:
    // clear any parked cards WITHOUT resolving their promises (LB-04: a late
    // resolve lands inside the SDK's floating promise chain → unhandled
    // rejection → crash under Node 22 throw-mode).
    if (st) {
      cancelPending(st, emit, sessionId, { resolveDeny: false })
    }
    // A turn that ends with NO result frame — stream exception OR natural
    // EOF with a result still pending — IS a turn end the user didn't
    // witness: ring the unified edge (the abort/sdk.exit path is a
    // REQUESTED teardown and deliberately stays silent). pendingResults
    // covers the accept→first-message window turnOpen cannot see, and
    // counts queued sends a boolean would lose. The gate consult is LAST in
    // the guard so a no-mint path never consumes an interrupt mark.
    if (st && st.pendingResults > 0 && !st.abort.signal.aborted && st.turnCompleteGate.resultEmitsAttention()) {
      const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
      st.lastTurnCompleteAt = at
      emit({ type: 'sdk.turn.complete', sessionId, at })
    }
    // Mirror SdkBridge: an aborted session surfaces sdk.exit; a natural end
    // surfaces an idle status. NEITHER is a completion chime, so a mid-turn
    // death cannot fake a turn.complete.
    if (st?.abort.signal.aborted) emit({ type: 'sdk.exit', sessionId })
    else emit({ type: 'sdk.status', sessionId, status: 'idle' })
    sessions.delete(sessionId)
    st?.abort.abort()
    await st?.nativeChannel?.cleanup()
  }
}

// ── request handlers ─────────────────────────────────────────────────────────
async function openSessionQuery(sessionId, state, req, launch, announceCreated = true) {
  const abort = state.abort
  const fork = state.parentFork
  const prefix = fork?.target.kind === 'prefix'
  const generation = state.queryGeneration = (state.queryGeneration ?? 0) + 1
  state.nativeBatch = undefined
  state.nativeReady = false
  state.commandsInitSeen = false
  const { iterable, handle } = createInputStream((isCompact) => {
    if (isCompact) state.handedCompactLikely = true
  })
  state.inputStream = handle
  if (launch) state.nativeChannel = await createNativeSessionChannel({ launch, signal: abort.signal,
    allowFork: prefix || (!!state.nativeIdentityTransition && req.forkSession === true) })

  const sdkQuery = query({
    prompt: iterable,
    options: {
      cwd: req.cwd || undefined,
      resume: fork ? prefix ? fork.parentTranscript : undefined : req.resumeSessionId,
      sessionId: fork?.childSessionId,
      // kata 1wxv Task 4 (fork-at-point emulation): the ONLY sanctioned lane is
      // the query() options triple — NEVER the standalone forkSession() fn (it
      // remaps every uuid).
      resumeSessionAt: fork ? prefix ? fork.target.cutoffUuid : undefined : req.resumeSessionAt || undefined,
      forkSession: fork ? prefix || undefined : req.forkSession === true || undefined,
      resumeDropsTurn: fork ? prefix ? fork.target.dropTurnUuid || undefined : undefined : req.resumeDropsTurn || undefined,
      model: req.model,
      permissionMode: req.permissionMode,
      // Enables the user's in-session permission selector; the selected mode
      // still controls whether approval is required for each tool.
      allowDangerouslySkipPermissions: true,
      effort: req.effort,
      plugins: Array.isArray(req.plugins)
        ? req.plugins.map(path => ({ type: 'local', path }))
        : undefined,
      pathToClaudeCodeExecutable: process.env.CLAUDE_CMD || undefined,
      includePartialMessages: true,
      abortController: abort,
      env: { ...createClaudeSdkCleanEnv(process.env), ...state.nativeChannel?.env },
      settings: state.nativeChannel?.settings,
      hooks: state.nativeChannel ? { PreToolUse: [{ matcher: 'Bash', hooks: [async (input, _toolUseID, hookOptions) => {
        const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse',
          permissionDecision: 'deny', permissionDecisionReason: reason } })
        if (state.queryGeneration !== generation || !state.nativeReady || input.session_id !== state.cliSessionId) {
          return deny('Current native query is not observed')
        }
        const original = state.nativeContinuation?.checkpoint
        if (original) {
          if (original.toolUseID !== input.tool_use_id || original.inputDigest !== nativeInputDigest(input.tool_input)) {
            return deny('Native continuation changed its original operation')
          }
          return {}
        }
        if (req.resumeSessionId && state.nativeStore) {
          const resumed = await waitForNativeCheckpointRelease(state, input, generation, hookOptions?.signal)
          if (resumed !== null) return resumed ? {} : deny('Original native checkpoint has no current fenced release')
        }
        // SDK control callbacks and the output iterator have independent
        // consumers. Wait briefly for the actual assistant batch; never infer
        // solo execution from the hook's one-tool view alone.
        const deadline = Date.now() + 100
        while (!state.nativeBatch?.complete && Date.now() < deadline
          && state.queryGeneration === generation && !abort.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        if (state.queryGeneration !== generation || !state.nativeReady || abort.signal.aborted) {
          return deny('Current native query was replaced')
        }
        const solo = nativeSoloTool(state)
        if (solo?.name !== 'Bash' || solo.id !== input.tool_use_id
          || nativeInputDigest(solo.input) !== nativeInputDigest(input.tool_input)) return {}
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer',
          permissionDecisionReason: 'Managed native no-effect continuation checkpoint' } }
      }] }] } : undefined,
      spawnClaudeCodeProcess: state.nativeChannel ? (options) => {
        const child = spawnObservedNative(options, {
          onStderr: (data) => logerr(`sdk stderr: ${String(data).trimEnd()}`),
          onControlWrite: (frame, error) => {
            if (state.queryGeneration !== generation) return
            const binding = state.nativeRequests?.get(frame.response.request_id)
            if (!binding) return
            state.nativeRequests.delete(frame.response.request_id)
            emit({ type: `sdk.${binding.kind}.dispatch`, sessionId, requestId: binding.requestId,
              nativeRequestId: frame.response.request_id, ok: !error && frame.response.subtype === 'success',
              acceptanceAmbiguous: !!error, message: error?.message ?? frame.response.error })
          },
        })
        state.nativeChildClosed = new Promise((resolve) => child.once('close', resolve))
        return child
      } : undefined,
      settingSources: ['user', 'project', 'local'],
      stderr: (data) => logerr(`sdk stderr: ${String(data).trimEnd()}`),
      canUseTool: async (toolName, input, options) => {
        const s = sessions.get(sessionId)
        if (!s || s !== state || state.queryGeneration !== generation || (s.nativeChannel && !s.nativeReady)) {
          return { behavior: 'deny', message: 'Current native session is not ready' }
        }
        // AskUserQuestion routes first (even under bypassPermissions), then the
        // bypass fast-path, else park-and-surface a pending request — legacy
        // ordering, sdk-bridge.ts:203-214.
        return routeNativePermission({ session: s, sessionId, req, launch, generation, toolName, input, options })
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
  if (announceCreated) emit({ type: 'created', requestId: req.requestId, sessionId })
  consumeStream(sessionId, sdkQuery).catch((err) => logerr(`consume error: ${err?.message}`))
  if (state.nativeChannel) {
    state.nativeReadyPromise = state.nativeChannel.waitReady(sdkQuery).then(async (observation) => {
      if (sessions.get(sessionId) !== state || state.queryGeneration !== generation || abort.signal.aborted) return
      if (fork) {
        if (observation.nativeSessionId !== fork.childSessionId
          || observation.native.source !== (prefix ? 'fork' : 'startup')
          || observation.native.transcript_path !== fork.childTranscript) throw new Error('native parent-backed fork did not observe its exact child')
        await inspectNativeForkSource(fork, observation.nativeSessionId)
        if (state.queryGeneration !== generation || abort.signal.aborted) return
      } else if (state.nativeIdentityTransition) {
        const expectedSource = req.forkSession === true ? 'fork' : 'startup'
        if (observation.native.source !== expectedSource) throw new Error(`native rollback did not acknowledge a ${expectedSource}`)
        if (observation.nativeSessionId === state.nativeIdentityTransition.parentNativeSessionId) throw new Error('native rollback retained the retired root')
      } else if (req.resumeSessionId && observation.nativeSessionId !== req.resumeSessionId) throw new Error('native exact resume changed root')
      if (await nativeProfileDigest(req, state.settings) !== state.nativeProfileDigest) throw new Error('selected native profile changed during startup')
      if (state.queryGeneration !== generation || abort.signal.aborted) return
      if (!process.env.HOME || !isAbsolute(process.env.HOME)) throw new Error('managed native checkpoint HOME is unavailable')
      state.nativeStore = createNativeCheckpointStore({ nativeSessionId: observation.nativeSessionId,
        transcriptPath: observation.native.transcript_path,
        recordPath: join(process.env.HOME, '.freshell', 'native-checkpoints', 'claude', observation.nativeSessionId + '.json'),
        profileDigest: state.nativeProfileDigest, allowMissingTranscript: !req.resumeSessionId && !fork, parentFork: fork })
      state.nativeReady = true
      state.cliSessionId = observation.nativeSessionId
      if (state.nativeIdentityTransition || fork) {
        // The operation selected this child once. Any later checkpoint query
        // must resume it exactly, without repeating the original fork options.
        state.createRequest = { ...req, resumeSessionId: observation.nativeSessionId }
        delete state.createRequest.nativeIdentityTransition
        delete state.createRequest.forkSession
        delete state.createRequest.resumeSessionAt
        delete state.createRequest.resumeDropsTurn
        delete state.createRequest.nativeForkRecipe
      }
      state.nativeIdentityTransition = undefined
      emit({ type: 'sdk.session.init', sessionId, cliSessionId: observation.nativeSessionId,
        cwd: observation.native.cwd, model: req.model, nativeIdentityEvidence: {
          launch, digest: observation.evidenceDigest, source: observation.native.source, queryGeneration: generation,
        } })
    }).catch((error) => {
      if (state.queryGeneration !== generation) return
      emit({ type: 'sdk.error', sessionId, message: `native startup: ${error.message}` })
      abort.abort()
    })
  }
}

async function continueNativeCheckpoint(sessionId, state, record) {
  const previousQuery = state.query
  const previousAbort = state.abort
  const previousNativeClosed = state.nativeChildClosed
  state.query = undefined
  state.nativeContinuation = record
  state.nativeReady = false
  emit({ type: 'sdk.session.loading', sessionId,
    nativeBinding: { launch: state.launch, queryGeneration: state.queryGeneration + 1 } })
  state.abort = new AbortController()
  previousQuery.close?.()
  previousAbort.abort()
  if (previousNativeClosed) {
    let timeout
    try {
      await Promise.race([previousNativeClosed, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('original native writer did not close')), 5_000)
      })])
    } finally { clearTimeout(timeout) }
  }
  if (sessions.get(sessionId) !== state || state.abort.signal.aborted) throw new Error('native continuation cancelled before exact resume')
  await openSessionQuery(sessionId, state, { ...state.createRequest, resumeSessionId: record.nativeSessionId }, state.launch, false)
  await state.nativeReadyPromise
  await deliverNativeContinuation(sessionId, state, record)
}

async function deliverNativeContinuation(sessionId, state, record) {
  const generation = state.queryGeneration
  const matchesOperation = (hook) => !hook || (hook.generation === generation
    && hook.toolUseID === record.toolUseID && hook.inputDigest === record.inputDigest)
  if (!state.nativeReady || !matchesOperation(state.nativePendingOperation)
    || !await state.nativeStore.beginContinuation()) throw new Error('current native continuation could not be claimed')
  if (sessions.get(sessionId) !== state || state.queryGeneration !== generation || !state.nativeReady || state.abort.signal.aborted) {
    throw new Error('native continuation query changed before delivery')
  }
  state.nativeContinuation = record
  const pendingOperation = state.nativePendingOperation
  if (!matchesOperation(pendingOperation)) throw new Error('current native operation changed before release')
  if (pendingOperation) {
    pendingOperation.release(true)
    return
  }
  state.inputStream.push({ type: 'user', message: { role: 'user', content: 'Continue only the original pending native operation. Do not select another tool.' },
    parent_tool_use_id: null, session_id: record.nativeSessionId })
}

async function handleCheckpointResume(req) {
  const state = sessions.get(req.sessionId)
  const receipt = (ok, message) => emit({ type: 'sdk.checkpoint.dispatch', sessionId: req.sessionId,
    requestId: req.requestId, nativeRequestId: req.requestId, ok, message })
  try {
    const binding = req.nativeBinding
    if (!state?.nativeReady || !state.nativeStore || state.nativeContinuation
      || typeof req.requestId !== 'string' || !req.requestId
      || !Array.isArray(req.checkpoints) || req.checkpoints.length > 32
      || binding?.queryGeneration !== state.queryGeneration
      || !binding.launch || !Object.keys(state.launch).every((key) => binding.launch[key] === state.launch[key])) {
      receipt(false, 'current native checkpoint release is unavailable')
      return
    }
    const record = await state.nativeStore.readRecoverable()
    const expected = record && { ...record.checkpoint, profileDigest: record.profileDigest }
    if (!expected || !req.checkpoints.some((checkpoint) => checkpoint &&
      Object.keys(expected).every((key) => checkpoint[key] === expected[key]))
      || await nativeProfileDigest(state.createRequest, state.settings) !== record.profileDigest) {
      receipt(false, 'trusted original native checkpoint does not match current source/profile')
      return
    }
    await deliverNativeContinuation(req.sessionId, state, record)
    state.pendingResults += 1
    receipt(true)
  } catch (error) {
    receipt(false, error?.message ?? 'native continuation release failed')
  }
}

async function handleCreate(req) {
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
      // Unified attention bookkeeping: the gate suppresses exactly the
      // interrupted turn's own result (ordering-scoped, NO reset-at-send —
      // see turn-complete-gate.mjs); pendingResults counts ACCEPTED sends
      // still awaiting their terminal result frame, so consumeStream's
      // finally can mint the edge for a result-less turn end.
      turnCompleteGate: createTurnCompleteGate(),
      pendingResults: 0,
    }
    // Liveness IS session-map membership: consumeStream's finally removes the
    // session synchronously after cancelPending (LB-04 — a parked canUseTool
    // promise must never be resolved after transport close), and stdin line
    // events (macrotasks) cannot interleave inside that finally.
    sessions.set(sessionId, state)

    let launch = process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH
      ? JSON.parse(process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH) : undefined
    if (req.nativeIdentityTransition) {
      const transition = req.nativeIdentityTransition
      const next = transition.launch
      if (!launch || !next || next.incarnationId !== launch.incarnationId
        || next.launchNonce !== launch.launchNonce || next.executionGeneration !== launch.executionGeneration
        || !Number.isSafeInteger(next.evidenceRevision) || next.evidenceRevision <= launch.evidenceRevision
        || next.requestedNativeSessionId !== null
        || typeof transition.parentNativeSessionId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transition.parentNativeSessionId)
        || (req.resumeSessionId && req.forkSession !== true)) throw new Error('invalid native rollback launch binding')
      launch = next
      state.nativeIdentityTransition = transition
    }
    if (req.nativeForkRecipe) {
      const recipe = req.nativeForkRecipe
      if (!launch || (!state.nativeIdentityTransition && launch.requestedNativeSessionId !== recipe.childSessionId)) {
        throw new Error('native fork recipe does not match the current exact launch')
      }
      const path = (value, root) => {
        if (typeof value !== 'string' || !value.startsWith('.claude/projects/') || value.split('/').some(part => !part || part === '..' || part === '.')
          || !value.endsWith('/' + root + '.jsonl') || !isAbsolute(process.env.HOME ?? '')) throw new Error('invalid native fork source path')
        return join(process.env.HOME, value)
      }
      state.parentFork = { ...recipe, parentTranscript: path(recipe.parentTranscript, recipe.parentSessionId),
        childTranscript: path(recipe.childTranscript, recipe.childSessionId) }
      await inspectNativeForkSource(state.parentFork, recipe.childSessionId)
    }
    state.createRequest = req
    state.launch = launch
    if (launch) state.nativeProfileDigest = await nativeProfileDigest(req, state.settings)
    await openSessionQuery(sessionId, state, req, launch)
  } catch (err) {
    if (sessionId) sessions.delete(sessionId)
    emit({ type: 'create.failed', requestId, message: err?.message || String(err) })
  }
}

async function handleSend(req) {
  const st = sessions.get(req.sessionId)
  // ep3-r2 F2: the signed frame — when the JS session is gone but stdout stays
  // open (consumeStream deleted it), NO terminal edge or EOF follows; the Rust
  // busy tracker must fold this specific failure as provider-session death.
  if (!st) { emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'session not found', sessionNotFound: true }); return }
  if (st.nativeChannel && !st.nativeReady) {
    emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'native startup is not observed' })
    return
  }
  if (st.nativeStore) {
    const generation = st.queryGeneration
    if (await st.nativeStore.inputState() !== 'clear') {
      emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'Native checkpoint requires a current fenced continuation; ordinary input is blocked' })
      return
    }
    if (sessions.get(req.sessionId) !== st || generation !== st.queryGeneration || !st.nativeReady || st.abort.signal.aborted) {
      emit({ type: 'sdk.error', sessionId: req.sessionId, message: 'Current native query changed before input admission' })
      return
    }
    st.nativeStore.disableParentFork()
    st.parentFork = undefined
  }
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
  // so the mark deterministically consumes exactly that result (including the
  // crash-order case where the result wins the race to the wire — the mark
  // was armed at request time and is still there to consume it). A REJECTED
  // interrupt (the turn kept running) clears the mark; noteInterruptSettled
  // stays in both promise arms — settle(true) without a mark is a no-op.
  if (st.pendingResults > 0) st.turnCompleteGate.noteInterruptRequest()
  st.query.interrupt()
    .then(() => {
      st.turnCompleteGate.noteInterruptSettled(true)
      emit({ type: 'sdk.interrupt_settled', sessionId: req.sessionId, ok: true })
    })
    .catch((err) => {
      st.turnCompleteGate.noteInterruptSettled(false)
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

let pendingShutdown
function shutdownAndExit(awaitNativeShutdown = false) {
  if (pendingShutdown) return
  if (!awaitNativeShutdown) { shutdown(); process.exit(0) }
  const closures = [...sessions.values()].map(state => state.nativeChannel && !state.nativeChildClosed
    ? Promise.reject(new Error('native writer closure is unavailable')) : state.nativeChildClosed)
  shutdown()
  pendingShutdown = (async () => {
    let timer
    try {
      await Promise.race([Promise.all(closures), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('native writer shutdown timed out')), 4_000)
      })])
      process.exit(0)
    } catch { process.exit(1) }
    finally { clearTimeout(timer) }
  })()
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
    case 'send': {
      const st = sessions.get(req.sessionId)
      if (st?.nativeStore) st.inputChain = (st.inputChain ?? Promise.resolve()).then(() => handleSend(req))
      else void handleSend(req)
      break
    }
    case 'configure': {
      const st = sessions.get(req.sessionId)
      if (st) st.configureChain = (st.configureChain ?? Promise.resolve()).then(() => handleConfigure(req))
      else void handleConfigure(req)
      break
    }
    case 'checkpoint.resume': {
      const st = sessions.get(req.sessionId)
      if (st) st.controlChain = (st.controlChain ?? Promise.resolve()).then(() => handleCheckpointResume(req))
      else void handleCheckpointResume(req)
      break
    }
    case 'interrupt': handleInterrupt(req); break
    case 'rollback.quiesce': handleRollbackQuiesce(req); break
    case 'permission.respond': {
      const st = sessions.get(req.sessionId)
      if (!st) { emit({ type: 'sdk.permission.dispatch', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'current session unavailable' }); break }
      // Missing decision: NEVER resolve — `undefined` is not a PermissionResult,
      // and a synthesized default would fabricate the user's choice. Reject
      // while the entry stays parked for a later valid respond (mirrors the
      // coerced-answers asymmetry one arm below).
      if (req.decision == null) {
        logerr(`permission.respond: missing decision for request ${req.requestId} (session ${req.sessionId})`)
        emit({ type: 'sdk.permission.dispatch', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'missing decision' })
        break
      }
      // Unknown requestId: reject without resolving any callback.
      st.controlChain = (st.controlChain ?? Promise.resolve()).then(async () => {
        const current = st.pendingPermissions?.get(String(req.requestId))
        if (current?.nativeCheckpoint && (!st.nativeReady
          || current.nativeBinding.queryGeneration !== st.queryGeneration
          || await nativeProfileDigest(st.createRequest, st.settings) !== current.nativeCheckpoint.profileDigest
          || (req.decision.behavior === 'allow'
            && (req.decision.updatedInput == null
              || nativeInputDigest(req.decision.updatedInput) !== current.nativeCheckpoint.inputDigest)))) {
          emit({ type: 'sdk.permission.dispatch', sessionId: req.sessionId, requestId: req.requestId,
            ok: false, message: 'current checkpoint input or profile changed' })
          return
        }
        if (current?.nativeCheckpoint && !await st.nativeStore.beginDecision(current.nativeBinding.nativeRequestId)) {
          emit({ type: 'sdk.permission.dispatch', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'current checkpoint decision is unavailable' })
          return
        }
        if (!respondPermission(st, String(req.requestId), req.decision)) {
          logerr(`permission.respond: no pending request ${req.requestId} for session ${req.sessionId}`)
          emit({ type: 'sdk.permission.dispatch', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'current callback unavailable' })
        }
      }).catch((error) => emit({ type: 'sdk.permission.dispatch', sessionId: req.sessionId, requestId: req.requestId,
        ok: false, message: error.message, acceptanceAmbiguous: true }))
      break
    }
    case 'question.respond': {
      const st = sessions.get(req.sessionId)
      if (!st) { emit({ type: 'sdk.question.dispatch', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'current session unavailable' }); break }
      const answers = req.answers && typeof req.answers === 'object' ? req.answers : {}
      if (!respondQuestion(st, String(req.requestId), answers)) {
        logerr(`question.respond: no pending request ${req.requestId} for session ${req.sessionId}`)
        emit({ type: 'sdk.question.dispatch', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'current callback unavailable' })
      }
      break
    }
    case 'shutdown': shutdownAndExit(req.awaitNativeShutdown === true); break
    default: logerr(`unknown request type: ${req?.type}`)
  }
})
// stdin closed (Rust reaped us): abort every query and exit so no claude CLI
// grandchild is left mid-stream.
rl.on('close', () => shutdownAndExit())
process.on('SIGTERM', () => shutdownAndExit())
process.on('SIGINT', () => shutdownAndExit())

logerr('ready')
