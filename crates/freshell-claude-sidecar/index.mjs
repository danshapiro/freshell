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
//     { type:'send',               sessionId, uuid, text, images?, checkpointAttempt?:{logicalAttemptId, requestId} }
//                                  — `uuid` is the id the server minted for this send (required): the
//                                    SDKUserMessage carries it, so the CLI reports the command's lifecycle
//                                    under it and writes the user line with it; a checkpoint attempt binds
//                                    under the same uuid (checkpoint-identity.mjs)
//     { type:'interrupt',          sessionId, stopId }
//                                  — the user's Stop; `stopId` is echoed on its receipt
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
//     { type:'sdk.session.init',        sessionId, cliSessionId, model, cwd, tools, capabilities? }  // durable Claude UUID;
//                                  capabilities: the CLI's (msg_lifecycle_v1 says it reports every sent command's lifecycle)
//     { type:'sdk.assistant',           sessionId, content, model }
//     { type:'sdk.stream',              sessionId, event, parentToolUseId }
//     { type:'sdk.result',              sessionId, result, durationMs, costUsd, usage }
//     { type:'sdk.session.changed',     sessionId, reason:'session-commands', commands }
//                                  — the command catalog without the terminal-only commands (the pinned
//                                    CLI's until a turn's init names its own): from the boot, then
//                                    whenever a turn's init or commands_changed changes it
//     { type:'sdk.status',              sessionId, status }               // compacting (an ended stream sends
//                                  no status: the server reports the session as exited)
//     { type:'sdk.error',               sessionId, message }              // a request-level failure only
//     { type:'sdk.stream.ended',        sessionId, reason, message }      // the session's SDK stream ended
//                                  unrequested (reason cli_exited | stream_error | stream_eof, stream-end.mjs):
//                                  always the LAST line; the sidecar then exits with code 3 (G02)
//     { type:'sdk.permission.request',  sessionId, requestId, subtype:'can_use_tool', tool:{name,input}, toolUseID, suggestions, blockedPath, decisionReason }
//     { type:'sdk.question.request',    sessionId, requestId, questions }
//     { type:'sdk.permission.cancelled', sessionId, requestId }
//     { type:'sdk.question.cancelled',  sessionId, requestId }
//     { type:'sdk.interrupt_settled',   sessionId, stopId, ok, stillQueued?, message? }
//                                  — the interrupt() receipt, echoing the Stop's id: `stillQueued` lists the
//                                    sent commands the CLI says will still run (T12, T13; absent when the CLI
//                                    sends no receipt); ok:false when the session is not hosted here or the
//                                    CLI refused
//     { type:'sdk.send.rejected',       sessionId, uuid, code:'INVALID_IMAGE'|'INVALID_SEND'|'SESSION_NOT_FOUND', message }
//                                  — the send never reached the CLI (a bad image, no valid uuid, a session
//                                    this sidecar does not host); the session lives on
//   Lifecycle facts for the server's turn accounting (lifecycle-frames.mjs, never client content):
//     { type:'sdk.command',             sessionId, uuid, state }          // a sent command's lifecycle (T8):
//                                  queued | started | completed | cancelled | discarded, or replayed (its first replay)
//     { type:'sdk.session.state',       sessionId, state }                // running | idle | requires_action (T9;
//                                  the sidecar sets CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 for the CLI)
//     { type:'sdk.status',              sessionId, status:null, compactResult?, compactError?, permissionMode? }
//                                  — a status ended (T15); { status:'requesting' } is a model request
//     { type:'sdk.heartbeat',           sessionId, kind:'tool'|'task'|'retry', toolUseId?, elapsedMs? }
//                                  — liveness only (T17), at most one per kind every 5 s
//   `sdk.result` also carries subtype, isError, terminalReason?, numTurns? and errorText? (the CLI's own
//   error text without diagnostics), the facts the server's result verdict reads.
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
// This sidecar makes no turn or attention decision (design §3.1, C18): it
// forwards facts, and the server owns busy, the user's Stop, and every
// attention edge (`freshAgent.turn.complete`, `freshAgent.turn.waiting`) and
// failure banner, minted from those facts. Nothing here mints an edge.
//
// Process lifetime: one sidecar hosts one session. A boot the CLI refused ends
// the sidecar with `create.failed` and exit code 2. When the session's SDK
// stream ends without a request, the sidecar writes `sdk.stream.ended` last
// and exits with code 3, so the Rust end-of-output path ends the session. A
// requested teardown (shutdown, SIGTERM, stdin closing) exits 0 and reports
// nothing. If the PROCESS itself dies mid-turn, stdout simply ends with no
// `sdk.stream.ended`; the server's end-of-output path handles both ends.
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
import { resultFrames } from './sdk-message-frames.mjs'
import { checkpointAttemptOf, isUuid, rememberCheckpointAttempt, takeCheckpointIdentity } from './checkpoint-identity.mjs'
import { managedSdkSpawn } from './exec-profile.mjs'
import { hostedMcpServers } from './hosted-mcp.mjs'
import { cliStderrLogger, errorText, log } from './log.mjs'
import { isHostedSidecar } from './hosted.mjs'
import { STREAM_ENDED_EXIT_CODE, streamEnd } from './stream-end.mjs'
import { BOOT_FAILED_EXIT_CODE, bootOptions, classifyBootError, SIDECAR_PROTOCOL } from './boot.mjs'
import { usableCommands } from './terminal-commands.mjs'
import { createLifecycleState, lifecycleFrames, rememberSend, stillQueuedOf } from './lifecycle-frames.mjs'
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
function createInputStream() {
  const queue = []
  let waiting = null
  let done = false
  const handle = {
    push: (msg) => {
      if (waiting) {
        const r = waiting; waiting = null;
        r({ value: msg, done: false })
      } else {
        queue.push(msg)
      }
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

/** @type {Map<string, {inputStream:{push:Function,end:Function}, abort:AbortController, permissionMode?:string, cliSessionId?:string, pendingPermissions?:Map<string,any>, pendingQuestions?:Map<string,any>}>} */
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
  // The lifecycle facts this message carries, for the server's turn
  // accounting (lifecycle-frames.mjs): command lifecycles, session state,
  // status ends, heartbeats.
  for (const frame of lifecycleFrames(sessionId, msg, st.lifecycle)) emit(frame)

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
          // The server's turn ledger reads msg_lifecycle_v1 from them (T8).
          ...(Array.isArray(msg.capabilities) ? { capabilities: msg.capabilities.filter((cap) => typeof cap === 'string') } : {}),
        })
        publishCommandsIfChanged(sessionId, st)
      } else if (msg.subtype === 'commands_changed') {
        const commands = normalizeCommands(msg.commands, true)
        if (commands !== undefined) {
          st.commandCatalog = commands
          publishCommandsIfChanged(sessionId, st)
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
      // The facts the server's verdict reads (sdk-message-frames.mjs); the
      // server decides whether the turn rings and whether it failed.
      for (const frame of resultFrames(sessionId, msg)) emit(frame)
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
    if (!requested) {
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
  const state = {
    abort,
    permissionMode: req.permissionMode,
    settings: { model: req.model, effort: req.effort, permissionMode: req.permissionMode, cwd: req.cwd },
    // False until `created` is sent; until then nothing reaches Rust and
    // bootEvidence collects what a refusal is named from (boot.mjs).
    booted: false,
    bootEvidence: { resultErrors: [], stderr: '', streamEnded: undefined },
    // The commands this session sent and its heartbeat allowance (lifecycle-frames.mjs).
    lifecycle: createLifecycleState(),
    pendingCheckpointAttempts: new Map(),
  }
  const { iterable, handle } = createInputStream()
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
        // The CLI reports when the session starts and stops working (T9):
        // the server's turn accounting reads it (sdk.session.state).
        env: { ...createClaudeSdkCleanEnv(process.env), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        settingSources: ['user', 'project', 'local'],
        spawnClaudeCodeProcess: managedSdkSpawn(sdkStderr),
        stderr: sdkStderr,
        canUseTool: async (toolName, input, options) => {
          const s = sessions.get(sessionId)
          if (!s) return { behavior: 'allow', updatedInput: input }
          // AskUserQuestion routes first (even under bypassPermissions), then the
          // bypass fast-path, else park-and-surface a pending request — legacy
          // ordering, sdk-bridge.ts:203-214.
          return routeCanUseTool({ session: s, emit, nanoid, sessionId, toolName, input, options })
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

/** Why a malformed send is refused (the server mints a uuid for every send, and sends text). */
const SEND_WITHOUT_UUID = 'This message has no valid message id, so it was not given to Claude.'
const SEND_WITHOUT_TEXT = 'This message has no text, so it was not given to Claude.'
const SESSION_NOT_HOSTED = 'Claude session is no longer available.'

/**
 * Refuse a send before it reaches the CLI. Nothing was queued, so the session
 * goes on as it was; the server takes the send back (sdk.send.rejected).
 */
function rejectSend(req, code, message) {
  const uuid = req.uuid ?? null
  log('warn', 'send.rejected', { sessionId: req.sessionId, uuid, code, error: message })
  emit({ type: 'sdk.send.rejected', sessionId: req.sessionId, uuid, code, message })
}

function handleSend(req) {
  const st = sessions.get(req.sessionId)
  // Not a session this sidecar hosts: refused like any send the CLI never
  // saw, so the server takes it back.
  if (!st) { rejectSend(req, 'SESSION_NOT_FOUND', SESSION_NOT_HOSTED); return }
  // Every send carries the uuid the server minted for it. The SDKUserMessage
  // carries it, so the CLI reports the command's lifecycle under it (T8) and
  // writes the user line with it: it is the turn id the server announced.
  if (!isUuid(req.uuid)) { rejectSend(req, 'INVALID_SEND', SEND_WITHOUT_UUID); return }
  if (typeof req.text !== 'string') { rejectSend(req, 'INVALID_SEND', SEND_WITHOUT_TEXT); return }
  let content
  try {
    content = userMessageContent(req.text, req.images)
  } catch (error) {
    rejectSend(req, error?.code ?? 'INVALID_SEND', errorText(error))
    return
  }
  // A checkpoint attempt binds under the send's own uuid.
  const checkpointAttempt = checkpointAttemptOf(req.checkpointAttempt && { ...req.checkpointAttempt, uuid: req.uuid })
  const userMessage = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: st.cliSessionId || 'default',
    uuid: req.uuid,
  }
  if (checkpointAttempt) rememberCheckpointAttempt(st.pendingCheckpointAttempts, checkpointAttempt)
  rememberSend(st.lifecycle, req.uuid)
  st.inputStream.push(userMessage)
}

async function handleConfigure(req) {
  const st = sessions.get(req.sessionId)
  if (!st) {
    emit({ type: 'sdk.configured', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'Claude session is no longer available.' })
    return
  }
  try {
    // The server refuses a settings change while the session is busy (its
    // turn ledger); a request that says it is busy is refused here too.
    const settings = await configureSession(st, req.settings ?? {}, { busy: req.busy === true })
    emit({ type: 'sdk.configured', sessionId: req.sessionId, requestId: req.requestId, ok: true, settings })
  } catch (err) {
    log('warn', 'configure.failed', { sessionId: req.sessionId, requestId: req.requestId, error: errorText(err) })
    emit({ type: 'sdk.configured', sessionId: req.sessionId, requestId: req.requestId, ok: false, settings: { ...st.settings }, message: String(err?.message || err) })
  }
}

// The user's Stop (design §5.4). The server decides when to send it (never for
// an idle session) and whether the stopped turn rings; the sidecar calls the
// SDK's interrupt() and reports its receipt, echoing the Stop's id so the
// server reads only its own receipt.
function handleInterrupt(req) {
  const st = sessions.get(req.sessionId)
  const settled = (fields) => emit({ type: 'sdk.interrupt_settled', sessionId: req.sessionId, stopId: req.stopId ?? null, ...fields })
  if (!st) { settled({ ok: false, message: SESSION_NOT_HOSTED }); return }
  // The transport is still open here (interrupt only signals), so resolving the
  // parked requests with deny is safe — and required so the SDK's canUseTool
  // await settles instead of hanging the interrupted turn.
  cancelPending(st, emit, req.sessionId, { resolveDeny: true })
  if (!st.query?.interrupt) {
    settled({ ok: false, message: 'no in-flight SDK query' })
    return
  }
  st.query.interrupt()
    .then((receipt) => {
      // The receipt names the sent commands that survive the Stop and will
      // still run (T12; a cold Stop may list the command it missed, T13).
      const stillQueued = stillQueuedOf(receipt, st.lifecycle)
      settled({ ok: true, ...(stillQueued ? { stillQueued } : {}) })
    })
    .catch((err) => {
      log('warn', 'interrupt.failed', { sessionId: req.sessionId, stopId: req.stopId ?? null, error: errorText(err) })
      settled({ ok: false, message: String(err?.message || err) })
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
