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
//                                    cwd?, model?, permissionMode?, effort?, plugins?, hostedMcp?,
//                                    freshellMcp?:{command,args}, freshellContext?:{tabId?,paneId?} }
//                                  — `boot` picks the conversation the CLI boots (bootOptions): a
//                                    fork keeps the parent through-AND-including resumeSessionAt
//                                    over the raw parentUuid chain, writes a NEW conversation and
//                                    never rewrites the parent's JSONL; dropsTurn arms the SDK's
//                                    fork-time discard guard. `sessionId` is the id Rust minted for
//                                    a fresh or forked boot, when it minted one. `hostedMcp` and
//                                    `freshellMcp` pick the Freshell MCP recipe (mcp-servers.mjs);
//                                    `freshellContext` names the pane the CLI's environment carries.
//                                    One sidecar hosts one session: a second create is refused.
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
//                                    T2); sessionId is the bridge's control id (the requested UUID
//                                    when provided), and cliPid the CLI's pid. The command catalog
//                                    follows it. Control messages keep using this bridge id after
//                                    a conversation reset; Rust follows the new durable id below.
//     { type:'create.failed',           requestId, code, message }
//                                  — the CLI refused the boot (boot.mjs names the codes) or the
//                                    request is not protocol v2. Nothing from the refused boot is
//                                    forwarded (its error result is the refusal's evidence, not a
//                                    turn), and the sidecar then exits with code 2.
//     { type:'sdk.configured',          sessionId, requestId, ok, settings?, message? }
//     { type:'sdk.session.init',        sessionId, cliSessionId, model, cwd, tools, capabilities? }  // durable Claude UUID;
//                                  capabilities: the CLI's (msg_lifecycle_v1 says it reports every sent command's lifecycle)
//     { type:'sdk.session.rekeyed',     sessionId, newSessionId, reason:'conversation_reset' }
//                                  — before the post-reset init, names its actual durable UUID.
//                                    conversation_reset.new_conversation_id is only a reset nonce.
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
//                                    INFORMATIONAL (the CLI's own warning or suggestion text, or a message
//                                    that stops the turn; its quiet info/notice levels are not sent),
//                                    COMPACTION_FAILED (the CLI's reason); never a turn end
//     { type:'sdk.result',              sessionId, result, durationMs, costUsd, usage }
//     { type:'sdk.session.changed',     sessionId, reason:'session-commands', commands }
//                                  — the command catalog without the terminal-only commands (the pinned
//                                    CLI's until a turn's init names its own): from the boot, then
//                                    whenever a turn's init or commands_changed changes it
//     { type:'sdk.session.changed',     sessionId, reason:'transcript', uuid, parentToolUseId }
//                                  — the CLI writes this message (assistant, user, compaction boundary,
//                                    local command output) to its transcript under `uuid`, about 100 ms
//                                    later; sent right after the message's own frames
//                                    (sdk-message-frames.mjs)
//     { type:'sdk.status',              sessionId, status }               // compacting or null; the
//                                  server's turn ledger owns the effective status
//     { type:'sdk.session.metadata',    sessionId, permissionMode }       // the CLI changed its own
//                                  permission mode (an ExitPlanMode approval); the session adopts it first
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
// Rust maps content facts into `freshAgent.event` envelopes. Its per-session
// turn ledger owns busy status, single-command Stop targets, and attention
// edges; process EOF owns death and recovery. This bridge forwards CLI facts.
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
// The Freshell MCP server (G19): the create line names the recipe, the hosted
// one or the ordinary one the Rust server resolved while
// settings.codingCli.mcpServer is on (mcp-servers.mjs; never both, never an env
// key, since the SDK puts the MCP config on the CLI's argv). The endpoint and
// token reach the MCP child through the inherited environment the Rust server
// set on this process, and the pane context (`freshellContext`) is merged into
// the SDK env here. The interactive permission/question RESPONSE channel IS in
// scope (permission-channel.mjs, a faithful port of
// server/sdk-bridge.ts): canUseTool parks a pending request, surfaces
// sdk.permission.request / sdk.question.request, and waits for the Rust side's
// permission.respond / question.respond (unknown respond ids are stderr-log-only
// no-ops). The auto-allow shortcut remains ONLY for bypassPermissions sessions
// (AskUserQuestion still routes to the question path first, per legacy ordering).

import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { nativeProfileDigest, nativeResourceDigest } from './native-profile-digest.mjs'
import { createNativeSessionChannel, inspectNativeForkSource, nativeInputDigest } from './native-session-channel.mjs'
import { createNativeCheckpointStore } from './native-checkpoint-state.mjs'
import { spawnObservedNative } from './native-process.mjs'
import { configureSession, userMessageContent } from './session-settings.mjs'
import { createFrameState, frameLogRecord, framesForSdkMessage, resultFrames } from './sdk-message-frames.mjs'
import { checkpointAttemptOf, isUuid, rememberCheckpointAttempt, takeCheckpointIdentity } from './checkpoint-identity.mjs'
import { checkSdkExec, managedSdkSpawn } from './exec-profile.mjs'
import { mcpServersFor, withFreshellContext } from './mcp-servers.mjs'
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
function logerr(message) { log('warn', 'native.operation_failed', { error: String(message) }) }

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
const nativeChildClosures = new Set()

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
async function handleSdkMessage(sessionId, msg) {
  const st = sessions.get(sessionId)
  if (!st) return
  // Until `created` is sent nothing reaches Rust: a refused boot's
  // error_during_execution result (T5) is the refusal's evidence, not a turn.
  if (!st.booted) {
    if (st.nativeChannel && msg.type === 'system' && msg.subtype === 'init') st.pendingNativeInit = msg
    if (msg.type === 'result' && Array.isArray(msg.errors)) st.bootEvidence.resultErrors.push(...msg.errors)
    return
  }
  if (msg.type === 'user') {
    const content = Array.isArray(msg.message?.content) ? msg.message.content.filter(block => block.type === 'tool_result') : []
    if (st.nativeContinuation && msg.session_id === st.cliSessionId) for (const block of content) {
      if (await st.nativeStore.finishNativeResult(block.tool_use_id, block.is_error)) st.nativeContinuation = undefined
    }
    if (content.length) emit({ type: 'sdk.tool.result', sessionId, nativeSessionId: msg.session_id,
      uuid: msg.uuid, parentToolUseId: msg.parent_tool_use_id, content })
  }
  if (await handleNativeSdkMessage(sessionId, st, msg)) return
  // The lifecycle facts this message carries, for the server's turn
  // accounting (lifecycle-frames.mjs): command lifecycles, session state,
  // status ends, heartbeats.
  for (const frame of lifecycleFrames(sessionId, msg, st.lifecycle)) emit(frame)

  switch (msg.type) {
    case 'conversation_reset': {
      // The reset's new_conversation_id is a nonce, not the next session UUID
      // (pinned CLI T16). Its next init identifies the conversation to follow.
      st.pendingConversationReset = true
      if (st.nativeChannel) {
        st.nativeReady = false
        emit({ type: 'sdk.session.loading', sessionId,
          nativeBinding: { launch: st.launch, queryGeneration: st.queryGeneration } })
      }
      break
    }
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
        if (st.nativeChannel && msg.session_id !== st.cliSessionId) {
          if (!st.pendingConversationReset || !isUuid(msg.session_id)) throw new Error('native root changed without a conversation reset')
          const previousNativeSessionId = st.cliSessionId
          const observation = await st.nativeChannel.waitReady(st.query,
            { clearFrom: previousNativeSessionId, clearTo: msg.session_id })
          st.nativePendingOperation?.release(false)
          cancelPending(st, emit, sessionId, { resolveDeny: true })
          st.nativeContinuation = undefined
          st.parentFork = undefined
          st.nativeClearTransition = { previousNativeSessionId, nativeSessionId: observation.nativeSessionId }
          st.nativeObservation = observation
          st.nativeIdentityEvidence = { launch: st.launch, digest: observation.evidenceDigest,
            source: observation.native.source, queryGeneration: st.queryGeneration, previousNativeSessionId }
          st.nativeStore = createNativeCheckpointStore({ nativeSessionId: observation.nativeSessionId,
            transcriptPath: observation.native.transcript_path,
            recordPath: join(process.env.HOME, '.freshell', 'native-checkpoints', 'claude', observation.nativeSessionId + '.json'),
            profileDigest: st.nativeProfileDigest, allowMissingTranscript: true, nativeClear: st.nativeClearTransition })
          st.createRequest = { ...st.createRequest, boot: { kind: 'resume', resume: observation.nativeSessionId },
            resumeSessionId: observation.nativeSessionId, sessionId: undefined }
          st.nativeReady = true
        }
        if (st.pendingConversationReset && isUuid(msg.session_id)) {
          st.pendingConversationReset = false
          emit({ type: 'sdk.session.rekeyed', sessionId, newSessionId: msg.session_id, reason: 'conversation_reset' })
        }
        st.cliSessionId = msg.session_id
        st.settings.cwd ??= msg.cwd
        st.terminalCommandNames = Array.isArray(msg.terminal_slash_commands) ? msg.terminal_slash_commands : []
        emit({
          type: 'sdk.session.init',
          sessionId,
          cliSessionId: msg.session_id,
          cliVersion: msg.claude_code_version,
          model: msg.model,
          cwd: msg.cwd,
          ...(st.nativeIdentityEvidence ? { nativeIdentityEvidence: st.nativeIdentityEvidence } : {}),
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
      }
      break
    }
    case 'result': {
      // The facts the server's verdict reads (sdk-message-frames.mjs); the
      // server decides whether the turn rings and whether it failed.
      for (const frame of resultFrames(sessionId, msg)) emit({ ...frame,
        nativeSessionId: msg.session_id, uuid: msg.uuid, stopReason: msg.stop_reason,
        permissionDenials: msg.permission_denials, deferredToolUse: msg.deferred_tool_use })
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
    for await (const msg of sdkQuery) {
      if (st?.query === sdkQuery && sessions.get(sessionId) === st) await handleSdkMessage(sessionId, msg)
    }
  } catch (error) {
    failure = { error }
  } finally {
    if (st?.query !== sdkQuery || sessions.get(sessionId) !== st) return
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
    if (st?.nativeChannel) {
      st.nativeReady = false
      emit({ type: 'sdk.session.closed', sessionId, nativeSessionId: st.cliSessionId, queryGeneration: st.queryGeneration,
        nativeBinding: { launch: st.launch, queryGeneration: st.queryGeneration }, reason: requested ? 'aborted' : 'stream_end' })
      await st.nativeChannel.cleanup()
    }
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
    const binding = { launch, queryGeneration: generation, nativeRequestId: options?.requestId,
      ...(session.nativeClearTransition ? { nativeClear: session.nativeClearTransition } : {}) }
    if (toolName !== 'Bash' || await nativeProfileDigest(req, session.settings) !== record.profileDigest
      || !await session.nativeStore.parkPermission(options?.toolUseID, nativeInputDigest(input), binding)
      || session.queryGeneration !== generation || !session.nativeReady) {
      return { behavior: 'deny', message: 'Current original native checkpoint is unavailable' }
    }
    currentOptions = { ...options, publicDecisionId: 'checkpoint-' + record.checkpoint.checkpointUuid,
      nativeCheckpoint: { ...record.checkpoint, profileDigest: record.profileDigest }, nativeBinding: binding }
  }
  return routeCanUseTool({ session, emit, nanoid, sessionId, toolName, input, options: currentOptions })
}

function nativeSoloTool(state) {
  const batch = state.nativeBatch
  if (!batch?.complete || batch.tools.size !== 1) return undefined
  const tool = batch.tools.values().next().value
  return batch.assistantToolIds.has(tool.id) ? tool : undefined
}

async function continueNativeCheckpoint(sessionId, state, record) {
  const previousQuery = state.query
  const previousAbort = state.abort
  const previousNativeClosed = state.nativeChildClosed
  state.query = undefined
  state.nativeContinuation = record
  state.nativeCheckpointTransition = true
  state.nativeReady = false
  emit({ type: 'sdk.session.loading', sessionId,
    nativeBinding: { launch: state.launch, queryGeneration: state.queryGeneration + 1 } })
  state.abort = new AbortController()
  try {
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
    await openSessionQuery(sessionId, state, { ...state.createRequest, boot: { kind: 'resume', resume: record.nativeSessionId }, resumeSessionId: record.nativeSessionId, sessionId: undefined }, state.launch, false)
    await state.nativeReadyPromise
    await deliverNativeContinuation(sessionId, state, record)
  } catch (error) {
    // The previous stream no longer owns state.query, and a replacement might
    // not exist yet. This transition owns failure until continuation is live.
    previousAbort.abort()
    if (sessions.get(sessionId) === state) {
      log('warn', 'native.continuation_failed', { sessionId, error: errorText(error) })
      emit({ type: 'sdk.error', sessionId, message: `native continuation: ${error?.message || error}` })
      await closeSession(sessionId, state, 'stream_error', true)
    }
    throw error
  } finally {
    previousAbort.abort()
    state.nativeCheckpointTransition = false
  }
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
    receipt(true)
  } catch (error) {
    receipt(false, error?.message ?? 'native continuation release failed')
  }
}

async function closeSession(sessionId, state, reason = 'aborted', failed = false) {
  if (sessions.get(sessionId) !== state) return
  state.nativeReady = false
  state.inputStream?.end()
  cancelPending(state, emit, sessionId, { resolveDeny: false })
  sessions.delete(sessionId)
  if (state.nativeChannel) emit({ type: 'sdk.session.closed', sessionId,
    nativeSessionId: state.cliSessionId, queryGeneration: state.queryGeneration,
    nativeBinding: { launch: state.launch, queryGeneration: state.queryGeneration }, reason })
  try { state.abort.abort(); state.query?.close?.() } catch (error) { log('warn', 'native.close_failed', { sessionId, error: errorText(error) }) }
  await state.nativeChannel?.cleanup()
  if (failed) {
    // A continuation may have already retired a writer that is no longer in
    // the session map. Join it before a replacement sidecar can resume this
    // conversation; the Rust tree reaper remains the timeout backstop.
    try { await awaitNativeWriters([...nativeChildClosures]) }
    catch (error) { log('warn', 'native.shutdown_failed', { sessionId, error: errorText(error) }) }
    emit({ type: 'sdk.stream.ended', sessionId, reason: 'stream_error', message: 'The native Claude query could not continue.' })
    exitWithoutSession(state.query, STREAM_ENDED_EXIT_CODE)
  }
}

async function prepareNativeSession(state, req) {
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
    if (launch) {
      state.nativeResourceDigest = await nativeResourceDigest(req)
      state.nativeProfileDigest = await nativeProfileDigest(req, state.settings, process.env, state.nativeResourceDigest)
    }

    return launch
}

async function openSessionQuery(sessionId, state, req, launch, announceCreated = true) {
  const abort = state.abort
  const fork = state.parentFork
  const prefix = fork?.target.kind === 'prefix'
  const generation = state.queryGeneration = state.queryGeneration === undefined
    ? Number.isSafeInteger(req.nativeQueryGeneration) && req.nativeQueryGeneration > 0 ? req.nativeQueryGeneration : 1
    : state.queryGeneration + 1
  state.nativeBatch = undefined
  state.nativeReady = false
  state.nativeIdentityEvidence = undefined
  state.frameState = createFrameState()
  state.booted = false
  state.bootEvidence = { resultErrors: [], stderr: '', streamEnded: undefined }
  const { iterable, handle } = createInputStream()
  state.inputStream = handle
  if (launch) state.nativeChannel = await createNativeSessionChannel({ launch, signal: abort.signal,
    allowFork: prefix || req.boot?.kind === 'fork', expectedNativeSessionId: state.nativeClearTransition?.nativeSessionId })
  const logCliStderr = cliStderrLogger(log, { hosted: isHostedSidecar(), fields: { sessionId } })
  const sdkStderr = data => {
    if (!state.booted) state.bootEvidence.stderr = (state.bootEvidence.stderr + String(data)).slice(-BOOT_STDERR_MAX_CHARS)
    logCliStderr(data)
  }
  const sdkSpawn = managedSdkSpawn(sdkStderr)
  const sdkBoot = fork ? prefix ? { resume: fork.parentTranscript, resumeSessionAt: fork.target.cutoffUuid,
    forkSession: true, sessionId: fork.childSessionId, resumeDropsTurn: fork.target.dropTurnUuid || undefined }
    : { sessionId: fork.childSessionId } : bootOptions(req.boot, req.sessionId)
  const sdkQuery = query({ prompt: iterable, options: {
cwd: req.cwd || undefined,
...sdkBoot,
model: req.model,
permissionMode: req.permissionMode,
allowDangerouslySkipPermissions: true,
effort: req.effort,
plugins: Array.isArray(req.plugins)
          ? req.plugins.map(path => ({ type: 'local', path }))
          : undefined,
mcpServers: mcpServersFor(req, process.env, { fields: { sessionId } }),
pathToClaudeCodeExecutable: process.env.CLAUDE_CMD || undefined,
includePartialMessages: true,
extraArgs: { 'replay-user-messages': null },
abortController: abort,
env: { ...withFreshellContext({ ...createClaudeSdkCleanEnv(process.env), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }, req.freshellContext), ...state.nativeChannel?.env },
settingSources: ['user', 'project', 'local'],
stderr: sdkStderr,
canUseTool: async (toolName, input, options) => {
    const s = sessions.get(sessionId)
    if (!state.nativeChannel) return s ? routeCanUseTool({ session: s, emit, nanoid, sessionId, toolName, input, options })
      : { behavior: 'deny', message: 'Current native session is not ready' }
    if (!s || s !== state || state.queryGeneration !== generation || !state.nativeReady) return { behavior: 'deny', message: 'Current native session is not ready' }
    return routeNativePermission({ session: s, sessionId, req, launch, generation, toolName, input, options })
  },
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
        if (sdkSpawn) checkSdkExec(options)
        const child = spawnObservedNative(options, {
          onStderr: sdkStderr,
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
        const closed = new Promise((resolve) => child.once('close', resolve))
        state.nativeChildClosed = closed
        nativeChildClosures.add(closed)
        closed.then(() => nativeChildClosures.delete(closed))
        return child
      } : sdkSpawn
  } })
  state.query = sdkQuery
  const streamDone = consumeStream(sessionId, sdkQuery)
  streamDone.catch(error => log('error', 'stream.consume_failed', { sessionId, error: errorText(error) }))
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
      if (state.queryGeneration !== generation || abort.signal.aborted) return
      if (!process.env.HOME || !isAbsolute(process.env.HOME)) throw new Error('managed native checkpoint HOME is unavailable')
      state.nativeStore = createNativeCheckpointStore({ nativeSessionId: observation.nativeSessionId,
        transcriptPath: observation.native.transcript_path,
        recordPath: join(process.env.HOME, '.freshell', 'native-checkpoints', 'claude', observation.nativeSessionId + '.json'),
        profileDigest: state.nativeProfileDigest, allowMissingTranscript: !req.resumeSessionId && !fork, parentFork: fork,
        nativeClear: state.nativeClearTransition })
      state.nativeReady = true
      state.cliSessionId = observation.nativeSessionId
      if (state.nativeIdentityTransition || fork) {
        // The operation selected this child once. Any later checkpoint query
        // must resume it exactly, without repeating the original fork options.
        state.createRequest = { ...req, boot: { kind: 'resume', resume: observation.nativeSessionId },
          resumeSessionId: observation.nativeSessionId, sessionId: undefined }
        delete state.createRequest.nativeIdentityTransition
        delete state.createRequest.forkSession
        delete state.createRequest.resumeSessionAt
        delete state.createRequest.resumeDropsTurn
        delete state.createRequest.nativeForkRecipe
      }
      state.nativeIdentityTransition = undefined
      state.nativeIdentityEvidence = { launch, digest: observation.evidenceDigest,
        source: observation.native.source, queryGeneration: generation,
        ...(state.nativeClearTransition ? { previousNativeSessionId: state.nativeClearTransition.previousNativeSessionId } : {}) }
      state.nativeObservation = observation
      return observation
    }).catch((error) => {
      if (state.queryGeneration !== generation || sessions.get(sessionId) !== state) return
      log('warn', 'native.startup_failed', { sessionId, error: errorText(error) })
      emit({ type: 'sdk.error', sessionId, message: `native startup: ${error.message}` })
      abort.abort()
      throw error
    })
  }
  state.nativeReadyPromise?.catch(() => {})
  await bootSession({ req, sessionId, state, sdkQuery, streamDone, announceCreated })
}

async function handleNativeSdkMessage(sessionId, state, msg) {
  if (!state.nativeChannel) return false
  if (msg.type === 'stream_event' && msg.session_id === state.cliSessionId && msg.parent_tool_use_id == null) {
    const event = msg.event
    if (event?.type === 'message_start') state.nativeBatch = typeof event.message?.id === 'string' && event.message.id
      ? { id: event.message.id, tools: new Map(), assistantToolIds: new Set(), complete: false } : undefined
    else if (state.nativeBatch && event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') state.nativeBatch.tools.set(event.content_block.id, event.content_block)
    else if (state.nativeBatch && event?.type === 'message_stop') state.nativeBatch.complete = true
  }
  if (msg.type === 'assistant' && msg.session_id === state.cliSessionId && msg.parent_tool_use_id == null
      && state.nativeBatch?.id === msg.message?.id) {
    for (const tool of msg.message?.content ?? []) if (tool.type === 'tool_use') {
      state.nativeBatch.tools.set(tool.id, tool)
      state.nativeBatch.assistantToolIds.add(tool.id)
    }
  }
  if (msg.type !== 'result' || msg.stop_reason !== 'tool_deferred') return false
  const tool = msg.deferred_tool_use
  if (!tool || tool.name !== 'Bash' || msg.session_id !== state.cliSessionId
      || nativeSoloTool(state)?.id !== tool.id || nativeInputDigest(nativeSoloTool(state).input) !== nativeInputDigest(tool.input)) {
    throw new Error('native deferred result does not match the original solo operation')
  }
  const query = state.query
  const deadline = Date.now() + 3_000
  let record
  while (Date.now() < deadline) {
    if (state.query !== query || state.abort.signal.aborted) throw new Error('native checkpoint publication cancelled')
    record = await state.nativeStore.publish(tool.id, nativeInputDigest(tool.input))
    if (record) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (!record) throw new Error('native deferred checkpoint is unavailable or ambiguous')
  if (state.query !== query || state.abort.signal.aborted) throw new Error('native checkpoint publication cancelled')
  await continueNativeCheckpoint(sessionId, state, record)
  return true
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

async function handleCreate(req) {
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
  try {
    bootOptions(req.boot, req.sessionId)
  } catch (error) {
    failBoot(requestId, { code: error?.code ?? 'BOOT_FAILED', message: errorText(error) })
    return
  }

  // Rust assigns the durable identity before create. Retain the bare-id
  // fallback for an older host that has not adopted create-time UUIDs yet.
  const sessionId = isUuid(req.sessionId) ? req.sessionId : nanoid()
  const abort = new AbortController()
  const state = {
    abort,
    permissionMode: req.permissionMode,
    settings: { model: req.model, effort: req.effort, permissionMode: req.permissionMode, cwd: req.cwd },
    pendingConversationReset: false,
    // False until `created` is sent; until then nothing reaches Rust and
    // bootEvidence collects what a refusal is named from (boot.mjs).
    booted: false,
    bootEvidence: { resultErrors: [], stderr: '', streamEnded: undefined },
    // The commands this session sent and its heartbeat allowance (lifecycle-frames.mjs).
    lifecycle: createLifecycleState(),
    pendingCheckpointAttempts: new Map(),
    // The content mapping's own per-session state (sdk-message-frames.mjs).
    frameState: createFrameState(),
  }
  const { iterable, handle } = createInputStream()
  state.inputStream = handle
  // Liveness IS session-map membership: consumeStream's finally removes the
  // session synchronously after cancelPending (LB-04 — a parked canUseTool
  // promise must never be resolved after transport close), and stdin line
  // events (macrotasks) cannot interleave inside that finally.
  sessions.set(sessionId, state)

  try {
    req = { ...req, resumeSessionId: ['resume', 'fork'].includes(req.boot.kind) ? req.boot.resume : undefined,
      forkSession: req.boot.kind === 'fork', resumeSessionAt: req.boot.resumeSessionAt,
      resumeDropsTurn: req.boot.dropsTurn }
    const nativeLaunch = await prepareNativeSession(state, req)
    await openSessionQuery(sessionId, state, req, nativeLaunch)
  } catch (error) {
    sessions.delete(sessionId)
    try { state.abort.abort(); state.query?.close?.() } catch {}
    await state.nativeChannel?.cleanup()
    failBoot(requestId, classifyBootError({ error }), { sessionId }, state.query)
  }
}

/**
 * Wait for the CLI to boot (initializationResult(), T2: no prompt needed),
 * then answer `created` and publish the command catalog from the boot. A
 * refused boot (T4, T5) is answered `create.failed` with its typed code.
 */
async function bootSession({ req, sessionId, state, sdkQuery, streamDone, announceCreated = true }) {
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
    if (state.nativeChannel) await state.nativeReadyPromise
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
    if (announceCreated) {
      sessions.delete(sessionId)
      failBoot(requestId, classifyBootError({ error, resultErrors, stderr }), fields(), sdkQuery)
    } else await closeSession(sessionId, state, 'stream_error', true)
    return
  }
  // A shutdown or stdin close while the CLI booted: the sidecar is going away.
  if (!sessions.has(sessionId)) return
  state.booted = true
  state.bootEvidence = undefined
  const cliPid = Number.isInteger(init?.pid) ? init.pid : undefined
  if (announceCreated) emit({ type: 'created', requestId, sessionId, protocol: SIDECAR_PROTOCOL, ...(cliPid !== undefined ? { cliPid } : {}) })
  if (state.nativeIdentityEvidence) emit({ type: 'sdk.session.init', sessionId, cliSessionId: state.cliSessionId,
    cwd: state.nativeObservation.native.cwd, model: req.model, nativeIdentityEvidence: state.nativeIdentityEvidence,
    ...(Array.isArray(state.pendingNativeInit?.capabilities) ? { capabilities: state.pendingNativeInit.capabilities } : {}) })
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

async function handleSend(req) {
  const st = sessions.get(req.sessionId)
  // Not a session this sidecar hosts: refused like any send the CLI never
  // saw, so the server takes it back.
  if (!st) { rejectSend(req, 'SESSION_NOT_FOUND', SESSION_NOT_HOSTED); return }
  if (!st.booted) { rejectSend(req, 'INVALID_SEND', 'Claude is still starting; this message was not given to it.'); return }
  // Every send carries the uuid the server minted for it. The SDKUserMessage
  // carries it, so the CLI reports the command's lifecycle under it (T8) and
  // writes the user line with it: it is the turn id the server announced.
  if (!isUuid(req.uuid)) { rejectSend(req, 'INVALID_SEND', SEND_WITHOUT_UUID); return }
  if (typeof req.text !== 'string') { rejectSend(req, 'INVALID_SEND', SEND_WITHOUT_TEXT); return }
  if (st.nativeChannel) {
    const generation = st.queryGeneration
    try {
      if (!st.nativeReady || !st.nativeStore || await st.nativeStore.inputState() !== 'clear') {
        rejectSend(req, 'INVALID_SEND', 'Native checkpoint requires a current fenced continuation; ordinary input is blocked.'); return
      }
      if (sessions.get(req.sessionId) !== st || generation !== st.queryGeneration || !st.nativeReady || st.abort.signal.aborted) {
        rejectSend(req, 'SESSION_NOT_FOUND', SESSION_NOT_HOSTED); return
      }
      st.nativeStore.disableParentFork()
      st.parentFork = undefined
    } catch (error) { rejectSend(req, 'INVALID_SEND', errorText(error)); return }
  }
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
    const previousSettings = { ...st.settings }
    const busy = req.busy === true || (st.nativeChannel && !st.nativeReady)
      || (st.nativeStore && await st.nativeStore.inputState() !== 'clear')
    const configuration = await configureSession(st, req.settings ?? {}, { busy }).then(settings => ({ settings }), error => ({ error }))
    if (st.nativeStore && Object.keys(st.settings).some(key => st.settings[key] !== previousSettings[key])) {
      try {
        const resumeRequest = { ...st.createRequest, ...st.settings }
        const digest = await nativeProfileDigest(resumeRequest, st.settings, process.env, st.nativeResourceDigest)
        await st.nativeStore.setProfileDigest(digest)
        st.nativeProfileDigest = digest
        st.createRequest = resumeRequest
      } catch (error) { await closeSession(req.sessionId, st, 'stream_error', true); throw error }
    }
    if ('error' in configuration) throw configuration.error
    const settings = configuration.settings
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

let pendingShutdown
async function awaitNativeWriters(closures) {
  let timer
  try {
    await Promise.race([Promise.all(closures), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native writer shutdown timed out')), 4_000)
    })])
  } finally { clearTimeout(timer) }
}

function shutdownAndExit(awaitNativeShutdown = false) {
  if (pendingShutdown) return
  if (!awaitNativeShutdown) { shutdown(); process.exit(0) }
  const closures = [...nativeChildClosures, ...[...sessions.values()].map(state => state.nativeChannel && !state.nativeChildClosed
    ? Promise.reject(new Error('native writer closure is unavailable')) : state.nativeChildClosed)]
  shutdown()
  pendingShutdown = (async () => {
    try {
      await awaitNativeWriters(closures)
      process.exit(0)
    } catch { process.exit(1) }
  })()
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
    case 'send': {
      const st = sessions.get(req.sessionId)
      if (st?.nativeChannel) st.inputChain = (st.inputChain ?? Promise.resolve()).then(() => handleSend(req))
      else void handleSend(req)
      break
    }
    case 'checkpoint.resume': {
      const st = sessions.get(req.sessionId)
      if (st) st.controlChain = (st.controlChain ?? Promise.resolve()).then(() => handleCheckpointResume(req))
      else void handleCheckpointResume(req)
      break
    }
    case 'configure': {
      const st = sessions.get(req.sessionId)
      if (st?.nativeChannel) st.inputChain = (st.inputChain ?? Promise.resolve()).then(() => handleConfigure(req))
      else if (st) st.configureChain = (st.configureChain ?? Promise.resolve()).then(() => handleConfigure(req))
      else void handleConfigure(req)
      break
    }
    case 'interrupt': handleInterrupt(req); break
    case 'permission.respond': {
      const st = sessions.get(req.sessionId)
      if (!st) break
      // Missing decision: NEVER resolve — `undefined` is not a PermissionResult,
      // and a synthesized default would fabricate the user's choice. Reject
      // while the entry stays parked for a later valid respond (mirrors the
      // coerced-answers asymmetry one arm below).
      if (req.decision == null) {
        log('warn', 'respond.invalid', { kind: 'permission', sessionId: req.sessionId, requestId: req.requestId })
        if (st.nativeChannel) emit({ type: 'sdk.permission.dispatch', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'missing decision' })
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
          log('warn', 'respond.unknown', { kind: 'permission', sessionId: req.sessionId, requestId: req.requestId })
          if (st.nativeChannel) emit({ type: 'sdk.permission.dispatch', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'current callback unavailable' })
        }
      }).catch((error) => emit({ type: 'sdk.permission.dispatch', sessionId: req.sessionId, requestId: req.requestId,
        ok: false, message: error.message, acceptanceAmbiguous: true }))
      break
    }
    case 'question.respond': {
      const st = sessions.get(req.sessionId)
      if (!st) break
      const answers = req.answers && typeof req.answers === 'object' ? req.answers : {}
      if (!respondQuestion(st, String(req.requestId), answers)) {
        log('warn', 'respond.unknown', { kind: 'question', sessionId: req.sessionId, requestId: req.requestId })
        if (st.nativeChannel) emit({ type: 'sdk.question.dispatch', sessionId: req.sessionId, requestId: req.requestId, ok: false, message: 'current callback unavailable' })
      }
      break
    }
    case 'shutdown': shutdownAndExit(req.awaitNativeShutdown === true); break
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
