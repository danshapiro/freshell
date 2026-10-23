// The Claude CLI simulator: a drop-in `query()` for the sidecar's
// FRESHELL_CLAUDE_SDK_QUERY_MODULE seam that behaves like the pinned Claude
// Agent SDK 0.3.237 driving its bundled CLI 2.1.237.
//
// It is valid only while test/integration/providers/claude-cli-conformance.ts
// is green: that suite runs every scenario on the real CLI and on this module
// and requires equal normalized traces. The facts it reproduces are pinned by
// claude-cli-contract.test.ts (T1-T19 of
// docs/plans/2026-10-22-freshclaude-core-runtime.md §2):
//   - boot without a prompt (initializationResult), typed boot refusals, the
//     "already in use" exit, and a stand-in CLI process whose pid and death
//     behave like the real one (stand-in-cli.mjs);
//   - per-turn system/init, command_lifecycle for uuid-stamped sends,
//     replays, session_state_changed (CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS);
//   - sends absorbed during a tool call versus queued during text;
//   - interrupts: receipts (cold-start shape knob), aborted_streaming /
//     aborted_tools results with diagnostic errors, cancelled lifecycles;
//   - lazy transcripts under CLAUDE_CONFIG_DIR for fresh, resumed and forked
//     sessions (transcript.mjs); /compact, /clear, local slash commands;
//   - tool heartbeats every 30 s, Bash task promotion and the
//     BASH_MAX_TIMEOUT_MS cap, background agents and the CLI-initiated turn
//     their completion starts, API errors, canUseTool with suggestions and
//     ExitPlanMode;
//   - stdio MCP servers started with the CLI's environment, listed once
//     connected, and called for their tools (mcp.mjs).
//
// The model's side of each turn comes from prompt markers
// (prompt-markers.mjs, shared with the real-CLI loopback provider) or from a
// scenario program (program.mjs). A program can also retry failed API
// requests (api_retry, F11) and replay the model's side of a turn the pinned
// CLI really ran, with its transcript and subagent files (replay.mjs). Layout: this module owns the session (boot,
// input, the command queue, turns, interrupts, results); tools.mjs runs tool
// calls; local-commands.mjs runs slash commands; replay.mjs plays recorded
// turns; transcript.mjs persists the JSONL; sdk-shapes.mjs holds the recorded catalog and fixed shapes.
//
// Knobs (read from options.env, then process.env):
//   FRESHELL_CLAUDE_SIM_TIME_SCALE      multiply every simulated delay (default 1);
//                                       reported elapsed seconds stay virtual
//   FRESHELL_CLAUDE_SIM_COLD_STOP_RECEIPT  'empty' (default) or 'queued': whether a
//                                       Stop sent while the CLI boots overtakes the
//                                       pending send (both shapes are real, T13)
//   FRESHELL_CLAUDE_SIM_COLD_COMMAND    'empty', 'queued' or 'started': the first
//                                       uuid-stamped command after the boot starts cold.
//                                       A Stop that arrives while it is still starting
//                                       misses it (T13; the real CLI's order of receipt
//                                       and lifecycle is racy, this makes one shape
//                                       deterministic): 'empty' overtakes it (receipt
//                                       [] before its queued), 'queued' finds it queued
//                                       (receipt [uuid]), 'started' is answered as it
//                                       starts (receipt [] after its queued and
//                                       started). The command then runs to its result
//                                       unless another interrupt arrives once it runs.
//                                       With no Stop it starts after T.coldStart.
//   FRESHELL_CLAUDE_SIM_STALL_STDIN     '1'/'boot' or 'prompt': the host process
//                                       stops reading stdin after boot / at the
//                                       first prompt
//   FRESHELL_CLAUDE_SIM_TERMINAL_COMMANDS  comma-separated names: the terminal-only
//                                       commands each init lists, in place of the
//                                       pinned CLI's (a CLI whose list changed)
//   FRESHELL_CLAUDE_SIM_LEDGER          JSONL path, for tests that need to see what
//                                       the SDK side received. Every row carries
//                                       `query`, the ordinal of its query() call in
//                                       this process. Rows: `query` (the options, env
//                                       reduced to key names plus short sha256
//                                       digests of credential values and the
//                                       Freshell context values), `boot` (the session id
//                                       and the stand-in CLI's pid), `prompt` (each
//                                       command as it starts: uuid, text, content and
//                                       the model, effort and permission mode it runs
//                                       under), `can_use_tool` (each answer the host's
//                                       canUseTool gave), `interrupt` (each interrupt
//                                       the CLI took: the receipt's stillQueued and
//                                       whether a turn was running), `control` (each settings call
//                                       the CLI handles: setModel, setPermissionMode,
//                                       applyFlagSettings, with its arguments) and
//                                       `emission` (program steps)

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { HANG_MCP_QUALIFIED_TOOL, parsePromptMarkers, PLAN_TEXT, SLOW_DELAY_MS } from './prompt-markers.mjs'
import { loadProgram, ProgramEngine } from './program.mjs'
import { runLocalCommand } from './local-commands.mjs'
import { replayTurn } from './replay.mjs'
import {
  CATALOG,
  CAVEAT,
  commandLine,
  FAKE_MODEL,
  INTERRUPTED,
  INTERRUPTED_FOR_TOOL,
  isUuid,
  PERMISSION_MODES,
  SUBAGENT_TEXT,
  T,
  textOf,
  TOOL_REJECTED,
  usage,
} from './sdk-shapes.mjs'
import { toolCall } from './tools.mjs'
import { McpServers } from './mcp.mjs'
import {
  claudeConfigDir,
  CLI_VERSION,
  dropsTurnRefusal,
  findTranscript,
  forkPrefix,
  readTranscriptLines,
  Transcript,
} from './transcript.mjs'

export const SIMULATED_CLI_VERSION = CLI_VERSION

const here = path.dirname(fileURLToPath(import.meta.url))
const STAND_IN = path.join(here, 'stand-in-cli.mjs')

/** query() calls made in this process, for the ledger's `query` ordinal. */
let queryCount = 0

/** `/name args` when the text is a slash command, else null. */
function parseSlash(text) {
  const match = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(String(text).trim())
  return match ? { name: match[1], args: (match[2] ?? '').trim() } : null
}

/** The SDK's error kind for a failed API request's HTTP status (null: no response). */
function apiErrorKind(status) {
  if (status === 529) return 'overloaded'
  if (status === 429) return 'rate_limit'
  if (status === 401) return 'authentication_failed'
  if (status !== null && status >= 500) return 'server_error'
  return 'unknown'
}

/** The model steps a prompt's markers ask for (see prompt-markers.mjs). */
function markerSteps(text) {
  const marker = parsePromptMarkers(text)
  switch (marker.kind) {
    case 'slow': return [{ kind: 'text', data: { chunks: marker.chunks, delayMs: marker.delayMs } }]
    case 'tool': return [{ kind: 'tool', data: { name: 'Bash', input: { command: marker.command, description: 'local provider command', ...(marker.timeoutMs ? { timeout: marker.timeoutMs } : {}) }, seconds: marker.seconds } }]
    case 'api_error': return [{ kind: 'api_error', data: { status: marker.status } }]
    case 'retry': return [{ kind: 'api_retry', data: { status: marker.status, attempts: marker.attempts } }, { kind: 'text', data: { text: 'ok' } }]
    case 'hang': return [{ kind: 'hang', data: {} }]
    case 'mcp_hang': return [{ kind: 'tool', data: { name: HANG_MCP_QUALIFIED_TOOL, input: {}, hang: true } }]
    case 'mcp_call': return [{ kind: 'tool', data: { name: marker.tool, input: {} } }]
    case 'agent_async': return [{ kind: 'agent', data: {} }]
    case 'exit_plan': return [{ kind: 'exit_plan', data: { plan: PLAN_TEXT } }]
    default: return [{ kind: 'text', data: { text: 'ok' } }]
  }
}

/** The `<task-notification>` a finished background task leaves in the transcript. */
function taskNotificationXml(task) {
  return [
    '<task-notification>',
    `<task-id>${task.task_id}</task-id>`,
    ...(task.toolUseId ? [`<tool-use-id>${task.toolUseId}</tool-use-id>`] : []),
    '<status>completed</status>',
    `<summary>Agent "${task.description ?? 'background task'}" finished</summary>`,
    `<result>${SUBAGENT_TEXT}</result>`,
    '</task-notification>',
  ].join('\n')
}

class AbortError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AbortError'
  }
}

/** An async message channel: the SDK message stream of one query. */
function createChannel() {
  const items = []
  let wake = null
  let ended = null
  const notify = () => {
    if (wake) {
      const resolve = wake
      wake = null
      resolve()
    }
  }
  return {
    push(item) {
      if (ended) return
      items.push(item)
      notify()
    },
    end(error) {
      if (ended) return
      ended = { error }
      notify()
    },
    get ended() { return ended !== null },
    async *iterate() {
      for (;;) {
        if (items.length) {
          yield items.shift()
          continue
        }
        if (ended) {
          if (ended.error) throw ended.error
          return
        }
        await new Promise((resolve) => { wake = resolve })
      }
    },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** The shapes FRESHELL_CLAUDE_SIM_COLD_COMMAND names (see the knobs above). */
const COLD_COMMAND_SHAPES = new Set(['empty', 'queued', 'started'])

/** One command or CLI-initiated turn being worked on. */
class Turn {
  constructor(cmd) {
    this.cmd = cmd
    this.absorbed = []
    this.absorbing = false
    this.aborted = false
    this.waiters = new Set()
    this.requests = 0
    this.denials = []
    this.lastText = ''
  }

  abort() {
    if (this.aborted) return
    this.aborted = true
    for (const wake of [...this.waiters]) wake()
  }
}

class SimulatedCli {
  constructor({ prompt, options = {} }) {
    this.options = options
    this.env = { ...process.env, ...(options.env ?? {}) }
    // What the CLI process itself (and so its MCP servers) gets: the SDK's
    // `env` option in place of this process's environment, as the SDK does.
    this.cliEnv = options.env ?? process.env
    this.scale = Math.max(0, Number(this.env.FRESHELL_CLAUDE_SIM_TIME_SCALE ?? 1) || 0)
    this.channel = createChannel()
    this.program = new ProgramEngine(loadProgram(this.env))
    this.configDir = claudeConfigDir(this.env)
    this.cwd = options.cwd || process.cwd()
    this.model = options.model || FAKE_MODEL
    this.effort = options.effort
    this.permissionMode = options.permissionMode || 'default'
    this.partial = options.includePartialMessages === true
    this.stateEvents = this.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1'
    this.coldShape = this.env.FRESHELL_CLAUDE_SIM_COLD_COMMAND || null
    if (this.coldShape && !COLD_COMMAND_SHAPES.has(this.coldShape)) {
      throw new Error(`FRESHELL_CLAUDE_SIM_COLD_COMMAND must be one of ${[...COLD_COMMAND_SHAPES].join(', ')}, not ${JSON.stringify(this.coldShape)}`)
    }
    // The cold command being started, while a Stop can still miss it, and the
    // receipt of a Stop that missed it, when it is answered at its start.
    this.cold = null
    this.coldReceipt = null
    this.queue = []
    this.cliTurns = []
    this.preBoot = []
    this.deferredPushes = []
    this.turn = null
    this.busy = false
    this.finishing = false
    this.booted = false
    this.dead = false
    this.closing = false
    this.inputDone = false
    this.toolSeq = 0
    this.modelTurnsSinceCompact = 0
    this.timers = new Set()
    this.init = deferred()
    this.ordinal = ++queryCount
    this.ledger('query', { options: describeOptions(options) })

    this.sessionId = options.forkSession ? (options.sessionId ?? randomUUID()) : (options.resume ?? options.sessionId ?? randomUUID())
    this.spawnCli()
    // The CLI starts its stdio MCP servers with its own environment (mcp.mjs).
    this.mcp = new McpServers(options.mcpServers, { env: this.cliEnv, cwd: this.cwd })
    this.background(this.pumpInput(prompt))
    this.background(this.boot())

    options.abortController?.signal?.addEventListener('abort', () => this.terminate(new AbortError('Claude Code process aborted by user')), { once: true })
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  ms(value) {
    return Math.round(value * this.scale)
  }

  ledger(kind, row) {
    const file = this.env.FRESHELL_CLAUDE_SIM_LEDGER
    if (!file) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), pid: process.pid, query: this.ordinal, kind, ...row })}\n`)
  }

  /** A command starts running: what the model is asked, and under which settings. */
  recordPrompt(cmd) {
    this.ledger('prompt', { sessionId: this.sessionId, uuid: cmd.uuid ?? null, text: cmd.text, content: cmd.content, model: this.model, effort: this.effort ?? null, permissionMode: this.permissionMode })
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.timers.delete(timer); resolve() }, this.ms(ms))
      this.timers.add(timer)
    })
  }

  /** Wait `ms`; resolves true early when `turn` is aborted (or already was). */
  wait(ms, turn) {
    if (turn?.aborted || this.dead) return Promise.resolve(true)
    return new Promise((resolve) => {
      // An unbounded wait (a hung request or tool) ends only by abort.
      const timer = Number.isFinite(ms)
        ? setTimeout(() => {
          this.timers.delete(timer)
          turn?.waiters.delete(onAbort)
          resolve(false)
        }, this.ms(ms))
        : undefined
      if (timer) this.timers.add(timer)
      const onAbort = () => {
        if (timer) {
          clearTimeout(timer)
          this.timers.delete(timer)
        }
        resolve(true)
      }
      turn?.waiters.add(onAbort)
    })
  }

  /** A simulator bug must end the stream loudly, never leave it hanging. */
  background(promise) {
    promise.catch((error) => {
      process.stderr.write(`${JSON.stringify({ severity: 'error', component: 'claude-cli-sim', event: 'simulator_failure', message: String(error?.stack ?? error).slice(0, 2000) })}\n`)
      this.terminate(new Error(`Claude CLI simulator failure: ${error?.message ?? error}`))
    })
  }

  /** A macrotask boundary: frames on either side reach the consumer separately. */
  tick() {
    return new Promise((resolve) => setTimeout(resolve, 1))
  }

  emit(message) {
    if (this.dead || this.closing) return
    // Fault injection for consumers that must follow an init identity even
    // when the reset announcement is missing. The default trace is intact.
    if (message.type === 'conversation_reset' && this.env.FRESHELL_CLAUDE_SIM_DROP_CONVERSATION_RESET === '1') return
    this.channel.push({ ...message, uuid: message.uuid ?? randomUUID(), session_id: message.session_id ?? this.sessionId })
  }

  emitState(state) {
    if (this.stateEvents) this.emit({ type: 'system', subtype: 'session_state_changed', state })
  }

  emitStream(event, parentToolUseId = null) {
    if (this.partial) this.emit({ type: 'stream_event', event, parent_tool_use_id: parentToolUseId })
  }

  // ── the stand-in CLI process ──────────────────────────────────────────────

  spawnCli() {
    const spawnOptions = {
      command: process.execPath,
      args: [STAND_IN],
      cwd: this.cwd,
      env: this.env,
      signal: this.options.abortController?.signal,
    }
    const child = this.options.spawnClaudeCodeProcess
      ? this.options.spawnClaudeCodeProcess(spawnOptions)
      : spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.on?.('error', () => {})
    child.stdin?.on?.('error', () => {})
    child.once('exit', (code, signal) => this.onCliExit(code, signal))
  }

  onCliExit(code, signal) {
    this.cliExited = true
    if (this.closing || this.dead) return
    // Like the SDK's process transport (getProcessExitError): a CLI that exits
    // with code 0 is no error, so the message stream just ends. A real CLI
    // does that, for one, after SIGINT (an aborted result, then exit 0).
    if (code === 0 && !signal && !this.bootError) {
      this.terminate(undefined)
      return
    }
    const message = this.bootError
      ?? (signal ? `Claude Code process terminated by signal ${signal}` : `Claude Code process exited with code ${code}`)
    this.terminate(new Error(message))
  }

  /** The stream ends with `error` (a CLI death) or normally (close). */
  terminate(error) {
    if (this.dead) return
    this.dead = true
    // Work still unwinding after the death (an aborted tool settling) must
    // not reach the disk: the real CLI is gone and writes nothing more.
    this.transcript?.close()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.turn?.abort()
    this.mcp?.stop()
    this.init.reject(error ?? new Error('Query closed before the CLI booted'))
    this.channel.end(error)
    if (!this.cliExited) {
      try { this.child.stdin?.end() } catch { /* already gone */ }
      try { this.child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }

  close() {
    if (this.dead) return
    this.closing = true
    this.terminate(undefined)
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  async boot() {
    await this.sleep(T.boot)
    if (this.dead) return
    const refusal = this.bootRefusal()
    if (refusal?.inUse) {
      this.options.stderr?.(`Error: Session ID ${this.sessionId} is already in use.\n`)
      this.child.stdin?.write('exit 1\n')
      return
    }
    if (refusal) {
      this.bootError = `Claude Code returned an error result: ${refusal.message}`
      this.emit({ ...this.resultBase(), subtype: 'error_during_execution', is_error: true, num_turns: 0, stop_reason: null, errors: [refusal.message], duration_ms: 0, duration_api_ms: 0, usage: usage(0, 0), modelUsage: {} })
      await this.tick()
      this.child.stdin?.write('exit 1\n')
      return
    }
    this.booted = true
    this.ledger('boot', { sessionId: this.sessionId, cliPid: this.child.pid })
    this.init.resolve(this.bootSummary())
    for (const emission of this.program.match('start', {}) ?? []) this.background(this.runBackgroundEmission(emission))
    if (/^(1|boot)$/.test(this.env.FRESHELL_CLAUDE_SIM_STALL_STDIN ?? '')) process.stdin.pause()
    const pending = this.preBoot.splice(0)
    const pushes = pending.filter((item) => item.kind === 'push')
    const controls = pending.filter((item) => item.kind !== 'push')
    if (this.env.FRESHELL_CLAUDE_SIM_COLD_STOP_RECEIPT === 'queued') {
      for (const item of pushes) this.accept(item.cmd, { start: false })
      for (const item of controls) item.run()
      this.startNextOrIdle()
    } else {
      for (const item of controls) item.run()
      for (const item of pushes) this.accept(item.cmd)
    }
    if (this.inputDone) this.endWhenIdle()
  }

  /** Validate the launch the way the CLI does before it reports init (T4, T5). */
  bootRefusal() {
    const { resume, resumeSessionAt, forkSession, resumeDropsTurn, sessionId } = this.options
    if (resume) {
      const parentFile = findTranscript(this.configDir, resume)
      if (!parentFile) return { message: `No conversation found with session ID: ${resume}` }
      const parentLines = readTranscriptLines(parentFile)
      let prefix
      try { prefix = forkPrefix(parentLines, resumeSessionAt) } catch (error) { return { message: error.message } }
      if (resumeDropsTurn) {
        const discarded = parentLines.slice(prefix.length).filter((line) => typeof line.uuid === 'string')
        const reason = dropsTurnRefusal(discarded, resumeDropsTurn)
        if (reason) return { message: `Resume rejected by --resume-drops-turn: resuming at ${resumeSessionAt} would discard entries not attributable to turn ${resumeDropsTurn}: ${reason}` }
      }
      this.transcript = forkSession
        ? new Transcript({ configDir: this.configDir, cwd: this.cwd, sessionId: this.sessionId, flushMs: (ms) => this.ms(ms), prefix })
        : new Transcript({ configDir: this.configDir, cwd: this.cwd, sessionId: this.sessionId, flushMs: (ms) => this.ms(ms), existing: parentFile })
      // A conversation with history has something to compact.
      this.modelTurnsSinceCompact = this.transcript.hasPrompt ? 1 : 0
      return null
    }
    if (sessionId && findTranscript(this.configDir, sessionId)) return { inUse: true }
    this.transcript = new Transcript({ configDir: this.configDir, cwd: this.cwd, sessionId: this.sessionId, flushMs: (ms) => this.ms(ms) })
    return null
  }

  /** What initializationResult() resolves with (T2): the recorded catalog plus this CLI's pid and mode. */
  bootSummary() {
    const { commands, agents, output_style, available_output_styles, models, account, ...rest } = CATALOG.initializationResult
    return {
      commands,
      agents,
      output_style,
      available_output_styles,
      models,
      account,
      pid: this.child.pid,
      current_permission_mode: this.permissionMode,
      ...rest,
    }
  }

  systemInit() {
    const mcpServers = this.mcp.statuses()
    const plugins = (this.options.plugins ?? []).map((plugin) => ({ name: path.basename(plugin.path ?? String(plugin)), path: plugin.path ?? String(plugin) }))
    return {
      type: 'system',
      subtype: 'init',
      cwd: this.cwd,
      session_id: this.sessionId,
      ...CATALOG.init,
      ...(this.env.FRESHELL_CLAUDE_SIM_TERMINAL_COMMANDS === undefined
        ? {}
        : { terminal_slash_commands: this.env.FRESHELL_CLAUDE_SIM_TERMINAL_COMMANDS.split(',').filter(Boolean) }),
      tools: [...CATALOG.init.tools, ...this.mcp.toolNames()],
      mcp_servers: mcpServers,
      plugins,
      model: this.model,
      permissionMode: this.permissionMode,
      memory_paths: { auto: path.join(this.configDir, 'projects', this.cwd.replace(/[^A-Za-z0-9]/g, '-'), 'memory') + path.sep },
    }
  }

  // ── input ─────────────────────────────────────────────────────────────────

  async pumpInput(prompt) {
    try {
      if (typeof prompt === 'string') {
        this.onPush({ type: 'user', message: { role: 'user', content: prompt } })
      } else if (prompt) {
        for await (const message of prompt) {
          if (this.dead) break
          this.onPush(message)
        }
      }
    } catch { /* the host's input stream failed; treat as end of input */ }
    this.inputDone = true
    if (this.booted) this.endWhenIdle()
  }

  onPush(message) {
    if (this.dead || message?.type !== 'user') return
    const content = message.message?.content ?? ''
    const cmd = { uuid: isUuid(message.uuid) ? message.uuid : undefined, content, text: textOf(content) }
    if (!this.booted) {
      this.preBoot.push({ kind: 'push', cmd })
      return
    }
    if (this.finishing) {
      this.deferredPushes.push(cmd)
      return
    }
    setImmediate(() => this.accept(cmd))
  }

  /** The CLI takes a command off stdin: announce it, absorb it into a running tool, or queue it. */
  accept(cmd, { start = true } = {}) {
    if (this.dead) return
    if (this.finishing) {
      this.deferredPushes.push(cmd)
      return
    }
    if (this.coldShape && cmd.uuid) {
      const shape = this.coldShape
      this.coldShape = null
      this.background(this.acceptCold(cmd, shape))
      return
    }
    if (!this.busy) {
      this.busy = true
      this.emitState('running')
    }
    if (cmd.uuid) this.emit({ type: 'command_lifecycle', command_uuid: cmd.uuid, state: 'queued' })
    if (this.turn?.absorbing) {
      this.turn.absorbed.push(cmd)
      return
    }
    this.queue.push(cmd)
    if (start && !this.turn) this.startNextOrIdle()
  }

  /**
   * Take the cold command (FRESHELL_CLAUDE_SIM_COLD_COMMAND): it is still
   * starting at the point `shape` names until a Stop misses it (or the cold
   * window ends), and only then goes on.
   */
  async acceptCold(cmd, shape) {
    const cold = { shape, uuid: cmd.uuid, missed: false, stopped: deferred() }
    this.cold = cold
    if (shape === 'queued') {
      this.accept(cmd, { start: false })
      await this.holdCold(cold)
      this.startNextOrIdle()
    } else {
      // 'empty': the Stop overtook the command; 'started': the CLI answers the
      // Stop only once it reported the command's start (runCommand).
      await this.holdCold(cold)
      this.accept(cmd)
    }
  }

  /** Wait for a Stop to miss the cold command, or for the cold window to end. */
  async holdCold(cold) {
    await Promise.race([cold.stopped.promise, this.sleep(T.coldStart)])
    if (this.cold === cold) this.cold = null
    // The receipt reaches the host before anything the command does next.
    await this.tick()
  }

  endWhenIdle() {
    if (!this.busy && !this.turn && !this.dead) {
      this.transcript?.close()
      this.closing = true
      this.channel.end()
      try { this.child.stdin?.end() } catch { /* already gone */ }
    }
  }

  // ── turns ─────────────────────────────────────────────────────────────────

  startNextOrIdle() {
    if (this.dead || this.turn) return
    const cmd = this.queue.shift()
    if (cmd) {
      this.background(this.runCommand(cmd))
      return
    }
    const task = this.cliTurns.shift()
    if (task) {
      this.background(this.runCliTurn(task))
      return
    }
    if (this.busy) {
      this.busy = false
      this.emitState('idle')
    }
    if (this.inputDone) this.endWhenIdle()
  }

  async runCommand(cmd) {
    const turn = new Turn(cmd)
    this.turn = turn
    await this.sleep(T.queuedToStarted)
    if (cmd.uuid) this.emit({ type: 'command_lifecycle', command_uuid: cmd.uuid, state: 'started' })
    if (this.coldReceipt && this.coldReceipt.uuid === cmd.uuid) {
      // The receipt of the Stop that missed this command comes after its start.
      const { resolve } = this.coldReceipt
      this.coldReceipt = null
      await this.tick()
      resolve()
    }
    this.recordPrompt(cmd)
    this.transcript.materialize()
    if (/^prompt$/.test(this.env.FRESHELL_CLAUDE_SIM_STALL_STDIN ?? '')) process.stdin.pause()
    const slash = parseSlash(cmd.text)
    if (slash) await runLocalCommand(this, turn, slash)
    else await this.runModelTurn(turn)
  }

  async runModelTurn(turn) {
    const { cmd } = turn
    await this.sleep(T.startedToInit)
    // A turn's request waits for the MCP servers to connect (or fail).
    await this.mcp.settled()
    this.emit(this.systemInit())
    await this.sleep(T.initToStatus)
    this.emit({ type: 'system', subtype: 'status', status: 'requesting' })
    turn.requests = 1
    const scripted = this.program.match('msg', { type: 'prompt', text: cmd.text, uuid: cmd.uuid })
    if (scripted) for (const emission of scripted) this.ledger('emission', { kind: emission.kind, data: emission.data })
    const steps = [...(scripted ?? markerSteps(cmd.text))]
    // A first request that fails is retried before the CLI replays the
    // prompt: the replay follows the request that is answered (conformance
    // scenario `retry`).
    if (steps[0]?.kind === 'api_retry') {
      if (await this.apiRetries(turn, steps.shift().data)) return this.abortBeforeContent(turn)
    }
    await this.sleep(T.requestLatency)
    const uuid = cmd.uuid ?? randomUUID()
    this.emit({ type: 'user', message: { role: 'user', content: cmd.content }, parent_tool_use_id: null, uuid, timestamp: new Date().toISOString(), isReplay: true })
    this.transcript.appendPrompt({ uuid, content: cmd.content, permissionMode: this.permissionMode })
    this.modelTurnsSinceCompact += 1
    await this.respond(turn, steps)
  }

  /** A turn the CLI starts by itself: a background task finished (T19). */
  async runCliTurn(task) {
    const turn = new Turn(null)
    this.turn = turn
    await this.sleep(T.queuedToStarted)
    // The CLI writes the completion into the transcript as a user line of
    // origin task-notification: no prompt of its own, and no SDK message.
    this.transcript.append({ type: 'user', message: { role: 'user', content: taskNotificationXml(task) }, origin: { kind: 'task-notification' } })
    this.transcript.append({ type: 'attachment', attachment: { type: 'total_tokens_reminder', text: '<total_tokens>15000000 tokens left</total_tokens>' } })
    await this.mcp.settled()
    this.emit(this.systemInit())
    await this.sleep(T.initToStatus)
    this.emit({ type: 'system', subtype: 'status', status: 'requesting' })
    turn.requests = 1
    await this.sleep(T.requestLatency)
    await this.respond(turn, [{ kind: 'text', data: { text: 'ok' } }])
  }

  /** Run the model's steps for the current request; tools start follow-up requests. */
  async respond(turn, steps) {
    let remaining = [...steps]
    while (remaining.length) {
      const step = remaining.shift()
      if (step.delayMs && await this.wait(step.delayMs, turn)) return this.abortBeforeContent(turn)
      if (turn.aborted) return this.abortBeforeContent(turn)
      switch (step.kind) {
        case 'text':
        case 'activity':
          if (!(await this.streamText(turn, step.data))) return
          break
        case 'tool':
        case 'approval':
        case 'question':
        case 'exit_plan':
        case 'agent': {
          const outcome = await toolCall(this, turn, step)
          if (outcome === 'aborted') return
          // The follow-up request reads what the user added after the tool
          // result (absorbed sends) the way the loopback provider does.
          const absorbedText = turn.absorbedTexts?.join('\n') ?? ''
          turn.absorbedTexts = []
          const markers = absorbedText ? parsePromptMarkers(absorbedText) : { kind: 'text' }
          if (markers.kind !== 'text') remaining = markerSteps(absorbedText)
          else if (remaining.length === 0) remaining = [{ kind: 'text', data: { text: 'done' } }]
          this.emit({ type: 'system', subtype: 'status', status: 'requesting' })
          turn.requests += 1
          if (await this.wait(T.requestLatency, turn)) return this.abortBeforeContent(turn)
          break
        }
        case 'completion':
          return this.finishTurn(turn, { subtype: step.data.subtype ?? 'success', text: step.data.text, errors: step.data.errors })
        case 'api_error':
          return this.apiError(turn, step.data)
        case 'api_retry':
          if (await this.apiRetries(turn, step.data)) return this.abortBeforeContent(turn)
          break
        case 'replay':
          if (await replayTurn(this, turn, step.data) === 'dead') return undefined
          break
        case 'hang':
          this.emitStream(this.messageStart())
          await this.wait(Number.POSITIVE_INFINITY, turn)
          return this.abortStreaming(turn, '')
        case 'crash':
          // A dead CLI says nothing more: wait for the death to end the stream.
          await this.runBackgroundEmission(step)
          await this.wait(Number.POSITIVE_INFINITY, turn)
          return undefined
        case 'stall_stdin':
        case 'cli_turn':
        case 'marker':
          await this.runBackgroundEmission(step)
          break
        default:
          break
      }
    }
    return this.finishTurn(turn, { subtype: 'success' })
  }

  /**
   * The start of one model response. Its id is the API message id every
   * content block of that response carries on its assistant message (F2).
   */
  messageStart() {
    this.streamedMessageId = `msg_${randomUUID().replaceAll('-', '')}`
    return {
      type: 'message_start',
      message: { id: this.streamedMessageId, type: 'message', role: 'assistant', model: FAKE_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }
  }

  /** One completed content block of the main thread's current response (or of a subagent's, with parent_tool_use_id). */
  assistant(content, extra = {}) {
    const uuid = randomUUID()
    const id = !extra.parent_tool_use_id && this.streamedMessageId ? this.streamedMessageId : `msg_${randomUUID().replaceAll('-', '')}`
    const message = {
      type: 'assistant',
      message: { id, type: 'message', role: 'assistant', model: FAKE_MODEL, content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, context_management: null },
      parent_tool_use_id: null,
      uuid,
      timestamp: new Date().toISOString(),
      request_id: randomUUID(),
      ...extra,
    }
    this.emit(message)
    if (!extra.parent_tool_use_id) this.transcript.append({ type: 'assistant', uuid, requestId: message.request_id, message: message.message })
    return message
  }

  trailingStream(stopReason) {
    this.emitStream({ type: 'content_block_stop', index: 0 })
    this.emitStream({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } })
    this.emitStream({ type: 'message_stop' })
  }

  /** One streamed text block. Returns false when the turn was aborted (and has been ended). */
  async streamText(turn, data) {
    // A model that repeats what its last tool call returned (`echoToolResult`,
    // after an optional `text` prefix).
    const reply = data.echoToolResult ? `${data.text ?? ''}${turn.lastToolResultText ?? ''}` : (data.text ?? 'ok')
    const pieces = data.chunks ? Array.from({ length: data.chunks }, (_, i) => `chunk${i} `) : [reply]
    const pace = data.chunks ? (data.delayMs ?? SLOW_DELAY_MS) : 0
    this.emitStream(this.messageStart())
    this.emitStream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    let text = ''
    for (const piece of pieces) {
      this.emitStream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
      text += piece
      if (pace && await this.wait(pace, turn)) {
        await this.abortStreaming(turn, text)
        return false
      }
    }
    this.assistant([{ type: 'text', text }])
    this.trailingStream('end_turn')
    turn.lastText = text
    return true
  }

  /**
   * The CLI's permission mode changes. Entering plan mode remembers the mode
   * it left: an approved ExitPlanMode returns there, not to default (B6).
   */
  changeMode(mode) {
    if (mode === 'plan' && this.permissionMode !== 'plan') this.modeBeforePlan = this.permissionMode
    this.permissionMode = mode
  }

  setMode(mode) {
    this.changeMode(mode)
    this.emit({ type: 'system', subtype: 'status', status: null, permissionMode: mode })
  }

  toolResult(toolUseId, content, { isError = false, toolUseResult, extra = {} } = {}) {
    const uuid = randomUUID()
    const block = { tool_use_id: toolUseId, type: 'tool_result', content, ...(isError ? { is_error: true } : { is_error: false }) }
    if (this.turn) this.turn.lastToolResultText = Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : String(content ?? '')
    this.emit({ type: 'user', message: { role: 'user', content: [block] }, parent_tool_use_id: null, uuid, timestamp: new Date().toISOString(), tool_use_result: toolUseResult, ...extra })
    this.transcript.append({ type: 'user', uuid, message: { role: 'user', content: [block] }, toolUseResult })
    // Sends absorbed while the tool ran join the turn as queued_command
    // attachments, never as prompts of their own (T10).
    for (const cmd of this.turn?.absorbed ?? []) {
      if (cmd.started || cmd.recorded) continue
      cmd.recorded = true
      this.transcript.append({ type: 'attachment', attachment: { type: 'queued_command', prompt: cmd.content, ...(cmd.uuid ? { source_uuid: cmd.uuid } : {}), commandMode: 'prompt', timestamp: new Date().toISOString() } })
    }
    this.transcript.append({ type: 'attachment', attachment: { type: 'total_tokens_reminder', text: '<total_tokens>15000000 tokens left</total_tokens>' } })
  }

  finishBackgroundTask(task, toolUseId) {
    if (this.dead) return
    if (toolUseId) this.assistant([{ type: 'text', text: SUBAGENT_TEXT }], { parent_tool_use_id: toolUseId, subagent_type: 'general-purpose', task_description: task.description })
    this.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    this.emit({ type: 'system', subtype: 'task_updated', task_id: task.task_id, patch: { status: 'completed', end_time: Date.now() } })
    this.emit({ type: 'system', subtype: 'task_notification', task_id: task.task_id, tool_use_id: toolUseId ?? null, status: 'completed', output_file: '', summary: SUBAGENT_TEXT, usage: { total_tokens: 1, tool_uses: 0, duration_ms: T.subagent } })
    this.cliTurns.push({ ...task, toolUseId })
    if (!this.turn && !this.finishing) {
      if (!this.busy) {
        this.busy = true
        this.emitState('running')
      }
      this.startNextOrIdle()
    }
  }

  async runBackgroundEmission(emission) {
    if (emission.delayMs) await this.sleep(emission.delayMs)
    this.ledger('emission', { kind: emission.kind, data: emission.data })
    switch (emission.kind) {
      case 'crash':
        if (emission.data?.code !== undefined) this.child.stdin?.write(`exit ${Number(emission.data.code)}\n`)
        else this.child.kill(emission.data?.signal ?? 'SIGKILL')
        break
      case 'stall_stdin':
        process.stdin.pause()
        break
      case 'cli_turn': {
        const timer = setTimeout(() => {
          this.timers.delete(timer)
          this.finishBackgroundTask({ task_id: randomUUID().replaceAll('-', '').slice(0, 17), description: 'background task' }, null)
        }, this.ms(Number(emission.data?.afterMs ?? 0)))
        this.timers.add(timer)
        break
      }
      default:
        break
    }
  }

  async apiError(turn, data) {
    const status = data.status ?? 500
    const text = `API Error: ${status} ${data.message ?? 'local provider error'}`
    const uuid = randomUUID()
    const message = {
      type: 'assistant',
      message: { id: randomUUID(), container: null, model: '<synthetic>', role: 'assistant', stop_details: null, stop_reason: 'stop_sequence', stop_sequence: '', type: 'message', usage: usage(0, 0), content: [{ type: 'text', text }], context_management: null },
      parent_tool_use_id: null,
      uuid,
      timestamp: new Date().toISOString(),
      error: 'unknown',
      request_id: randomUUID(),
      is_api_error_message: true,
    }
    this.emit(message)
    this.transcript.append({ type: 'assistant', uuid, requestId: message.request_id, error: 'unknown', isApiErrorMessage: true, apiErrorStatus: status, message: message.message })
    return this.finishTurn(turn, { subtype: 'success', isError: true, terminalReason: 'api_error', stopReason: 'stop_sequence', text, apiErrorStatus: status, lifecycle: 'cancelled' })
  }

  /**
   * The model request fails `attempts` times with `status` and the CLI
   * retries each (F11; live only, never in the transcript): a
   * system/api_retry, then the CLI's backoff. Returns true when the turn was
   * aborted meanwhile.
   */
  async apiRetries(turn, data) {
    const status = data.status === null ? null : Number(data.status ?? 529)
    const attempts = Math.max(1, Number(data.attempts ?? 1))
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const delay = Math.min(500 * 2 ** (attempt - 1), 32_000)
      this.emit({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: delay, error_status: status, error: apiErrorKind(status) })
      // A retried request is the same request: num_turns does not grow.
      if (await this.wait(delay, turn)) return true
    }
    return false
  }

  async abortBeforeContent(turn) {
    return this.abortStreaming(turn, '')
  }

  /** Stop during a model request: the partial text, the interruption notice, aborted_streaming (T11). */
  async abortStreaming(turn, partialText) {
    await this.sleep(T.abortSettle)
    if (partialText) this.assistant([{ type: 'text', text: partialText }])
    this.userNotice(INTERRUPTED)
    return this.finishTurn(turn, { subtype: 'error_during_execution', isError: true, terminalReason: 'aborted_streaming', numTurns: turn.requests + 1, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'], lifecycle: 'cancelled' })
  }

  /** Stop during a tool: the rejected tool result, the notice, aborted_tools (T11). */
  async abortTool(turn, toolUseId) {
    turn.absorbing = false
    await this.sleep(T.abortSettle)
    this.toolResult(toolUseId, TOOL_REJECTED, { isError: true, toolUseResult: `Error: ${TOOL_REJECTED}` })
    this.userNotice(INTERRUPTED_FOR_TOOL)
    await this.finishTurn(turn, { subtype: 'error_during_execution', isError: true, terminalReason: 'aborted_tools', numTurns: turn.requests + 2, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'], lifecycle: 'cancelled' })
    return 'aborted'
  }

  userNotice(text) {
    const uuid = randomUUID()
    this.emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid, timestamp: new Date().toISOString() })
    this.transcript.append({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  resultBase() {
    return {
      type: 'result',
      duration_ms: 20,
      duration_api_ms: 15,
      session_id: this.sessionId,
      total_cost_usd: 0.000018,
      usage: usage(),
      modelUsage: { [this.model]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.000018, contextWindow: 200000, maxOutputTokens: 32000 } },
      permission_denials: [],
      fast_mode_state: CATALOG.init.fast_mode_state,
      fast_mode_disabled_reason: CATALOG.init.fast_mode_disabled_reason,
    }
  }

  /** The result, then (as a separate delivery) the command's lifecycle end and the next turn or idle. */
  async finishTurn(turn, { subtype, isError = subtype !== 'success', terminalReason, numTurns, errors, text, stopReason = 'end_turn', apiErrorStatus = null, lifecycle, local = false } = {}) {
    if (this.dead) return
    const success = subtype === 'success' && !isError
    // Sends still waiting to be absorbed when the turn ends become ordinary queued commands.
    this.queue.unshift(...turn.absorbed.filter((cmd) => !cmd.started))
    for (const cmd of turn.absorbed) {
      if (cmd.started && cmd.uuid) this.emit({ type: 'command_lifecycle', command_uuid: cmd.uuid, state: success ? 'completed' : 'cancelled' })
    }
    const result = {
      ...this.resultBase(),
      is_error: isError,
      num_turns: numTurns ?? turn.requests,
      stop_reason: subtype === 'error_during_execution' ? null : stopReason,
      permission_denials: turn.denials,
      // Local commands (slash commands) report no terminal reason.
      ...(local ? {} : terminalReason || success ? { terminal_reason: terminalReason ?? 'completed' } : {}),
      subtype,
      ...(subtype === 'success' ? { api_error_status: apiErrorStatus, result: text ?? turn.lastText } : {}),
      ...(errors ? { errors } : subtype !== 'success' ? { errors: [text ?? `Claude Code ended the turn with ${subtype}`] } : {}),
      ...(turn.cmd?.uuid && subtype === 'success' ? { user_message_uuid: turn.cmd.uuid } : {}),
    }
    if (isError || subtype !== 'success') result.usage = usage(0, 0)
    this.emit(result)
    await this.endCommand(turn, lifecycle ?? (success ? 'completed' : 'cancelled'))
  }

  async endCommand(turn, state) {
    this.finishing = true
    await this.tick()
    if (turn.cmd?.uuid) this.emit({ type: 'command_lifecycle', command_uuid: turn.cmd.uuid, state })
    this.transcript.flush()
    this.transcript.schedule()
    this.turn = null
    this.finishing = false
    this.startNextOrIdle()
    const deferredPushes = this.deferredPushes.splice(0)
    for (const cmd of deferredPushes) this.accept(cmd)
  }

  // ── local commands ────────────────────────────────────────────────────────

  // ── control requests ──────────────────────────────────────────────────────

  /**
   * Run `fn` as a control request: once the CLI has booted (control requests
   * wait for the boot handshake), after the stdin/stdout round trip.
   */
  async control(fn) {
    await this.init.promise
    await this.tick()
    if (this.dead) throw new Error('Query closed')
    return fn()
  }

  interrupt() {
    if (this.dead) return Promise.reject(new Error('Query closed'))
    const receipt = deferred()
    const run = () => {
      const cold = this.cold
      if (cold && !cold.missed) {
        // The command is still starting: this Stop misses it (T13).
        cold.missed = true
        const stillQueued = cold.shape === 'queued' ? [cold.uuid] : []
        this.ledger('interrupt', { stillQueued, running: false, missed: cold.uuid })
        const answer = () => receipt.resolve({ still_queued: stillQueued })
        if (cold.shape === 'started') this.coldReceipt = { uuid: cold.uuid, resolve: answer }
        else answer()
        cold.stopped.resolve()
        return
      }
      const stillQueued = [...this.queue, ...(this.turn?.absorbed ?? []).filter((cmd) => !cmd.started)].filter((cmd) => cmd.uuid).map((cmd) => cmd.uuid)
      this.ledger('interrupt', { stillQueued, running: Boolean(this.turn) })
      receipt.resolve({ still_queued: stillQueued })
      this.turn?.abort()
    }
    if (!this.booted) this.preBoot.push({ kind: 'interrupt', run })
    else setImmediate(run)
    return receipt.promise
  }

  async setModel(model) {
    return this.control(async () => {
      this.ledger('control', { name: 'setModel', args: [model] })
      this.model = model ?? FAKE_MODEL
      const text = `<local-command-stdout>Set model to ${this.model}</local-command-stdout>`
      this.emit({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, timestamp: new Date().toISOString(), isReplay: true })
      this.transcript.append({ type: 'user', isMeta: true, message: { role: 'user', content: CAVEAT } })
      this.transcript.append({ type: 'user', message: { role: 'user', content: commandLine('model', this.model) } })
      this.transcript.append({ type: 'user', message: { role: 'user', content: text } })
      await this.tick()
    })
  }

  async setPermissionMode(mode) {
    return this.control(() => {
      this.ledger('control', { name: 'setPermissionMode', args: [mode] })
      // The only settings call the CLI validates (any model or effort name is accepted).
      if (!PERMISSION_MODES.includes(mode)) throw new Error(`Cannot set permission mode: must be one of ${PERMISSION_MODES.join(', ')}`)
      this.changeMode(mode)
      // Reported after the call resolves, before anything sent after it is taken.
      setImmediate(() => this.emit({ type: 'system', subtype: 'status', status: null, permissionMode: mode }))
    })
  }

  async applyFlagSettings(settings) {
    return this.control(() => {
      this.ledger('control', { name: 'applyFlagSettings', args: [settings] })
      this.flagSettings = { ...(this.flagSettings ?? {}), ...(settings ?? {}) }
      if (settings && 'effortLevel' in settings) this.effort = settings.effortLevel ?? undefined
    })
  }

  async setMaxThinkingTokens() {
    return this.control(() => {})
  }

  async supportedCommands() {
    return this.control(() => CATALOG.initializationResult.commands)
  }

  async supportedModels() {
    return this.control(() => CATALOG.initializationResult.models)
  }

  async supportedAgents() {
    return this.control(() => CATALOG.initializationResult.agents)
  }

  async mcpServerStatus() {
    return this.control(() => this.mcp.statuses())
  }

  async initializationResult() {
    return this.init.promise
  }
}

/** The credentials whose value a test may need to tell apart (as a digest, never the value). */
const DIGESTED_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'FRESHELL_TOKEN']

/** The non-secret Freshell context names whose values the ledger records (the token is digested). */
const RECORDED_CONTEXT = ['FRESHELL', 'FRESHELL_URL', 'FRESHELL_TERMINAL_ID', 'FRESHELL_TAB_ID', 'FRESHELL_PANE_ID']

/** A short sha256 digest of a credential value: enough to compare, useless to read. */
const credentialDigest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)

/**
 * The options as a ledger row: functions and controllers by kind, env by key
 * names only, plus a short digest of each credential the child got and the
 * values of the non-secret Freshell context names.
 */
function describeOptions(options) {
  const out = {}
  for (const [key, value] of Object.entries(options)) {
    if (key === 'env') {
      const env = value ?? {}
      out.envKeys = Object.keys(env).sort()
      out.envDigests = Object.fromEntries(DIGESTED_CREDENTIALS.filter((name) => env[name] !== undefined).map((name) => [name, credentialDigest(env[name])]))
      out.envContext = Object.fromEntries(RECORDED_CONTEXT.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]))
    } else if (key === 'abortController') out.abortController = Boolean(value)
    else if (typeof value === 'function') out[key] = '[function]'
    else out[key] = value
  }
  return out
}

/** The SDK's `query()`: an async generator of SDK messages with the Query control methods. */
export function query({ prompt, options } = {}) {
  const cli = new SimulatedCli({ prompt, options })
  const generator = (async function* () {
    try {
      yield* cli.channel.iterate()
    } finally {
      if (!cli.dead) cli.close()
    }
  })()
  const methods = [
    'interrupt', 'setModel', 'setPermissionMode', 'applyFlagSettings', 'setMaxThinkingTokens',
    'supportedCommands', 'supportedModels', 'supportedAgents', 'mcpServerStatus', 'initializationResult',
  ]
  for (const name of methods) generator[name] = (...args) => cli[name](...args)
  generator.close = () => cli.close()
  return generator
}
