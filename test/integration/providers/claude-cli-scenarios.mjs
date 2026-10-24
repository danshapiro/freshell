// Scenario runner for the Claude CLI contract and conformance suites.
//
//   node claude-cli-scenarios.mjs <real|sim> <scenario>
//
// Each scenario drives one target through the SDK `query()` surface the
// sidecar uses and prints ONE JSON line: the recorded trace (every SDK
// message, push, interrupt receipt and stream end, in arrival order, with
// relative times) plus scenario observations (files on disk, boot results).
//
//   real  the pinned SDK 0.3.237 + bundled CLI 2.1.237 against the loopback
//         provider in claude-local-provider.mjs (never the real API)
//   sim   the CLI simulator, test/fixtures/claude-cli-sim/query.mjs, loaded
//         the way the sidecar loads it (FRESHELL_CLAUDE_SDK_QUERY_MODULE)
//
// The same scenario code runs on both targets, so their traces can be
// compared after normalization (claude-cli-normalize.ts).

import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createClaudeFixture,
  DEFAULT_REPO_ROOT,
  FAKE_MODEL,
  HANG_MCP_SERVER_SCRIPT,
  resolvePinnedClaude,
  startLocalProvider,
} from './claude-local-provider.mjs'
import { HANG_MCP_SERVER_NAME } from '../../fixtures/claude-cli-sim/prompt-markers.mjs'

/** The stdio MCP server the `mcp` scenario connects (it stands in for tools/freshell-mcp). */
const FRESHELL_MCP_PROBE_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-freshell-mcp-probe-server.mjs')

export const SIM_QUERY_MODULE = path.join(DEFAULT_REPO_ROOT, 'test/fixtures/claude-cli-sim/query.mjs')
const SESSION_STATE_ENV = { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── trace recording ──────────────────────────────────────────────────────────

const STRING_LIMIT = 600

function trimDeep(value, depth = 0) {
  if (typeof value === 'string') return value.length > STRING_LIMIT ? `${value.slice(0, STRING_LIMIT)}…` : value
  if (Array.isArray(value)) return depth > 6 ? `[array ${value.length}]` : value.map((v) => trimDeep(v, depth + 1))
  if (value && typeof value === 'object') {
    if (depth > 6) return '[object]'
    const out = {}
    for (const [key, v] of Object.entries(value)) out[key] = trimDeep(v, depth + 1)
    return out
  }
  return value
}

/** Keep every SDK message except stream_event payloads, which shrink to their kind. */
function recordable(message) {
  if (message?.type === 'stream_event') {
    const event = message.event ?? {}
    return {
      type: 'stream_event',
      event: { type: event.type, index: event.index, delta: event.delta?.type, block: event.content_block?.type },
      parent_tool_use_id: message.parent_tool_use_id ?? null,
      session_id: message.session_id,
    }
  }
  return trimDeep(message)
}

class Trace {
  constructor() {
    this.t0 = Date.now()
    this.events = []
  }

  add(row) {
    const event = { t: Date.now() - this.t0, ...row }
    this.events.push(event)
    return event
  }
}

// ── sessions ─────────────────────────────────────────────────────────────────

function createInput() {
  const queue = []
  let waiting = null
  let done = false
  return {
    push(message) {
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: message, done: false })
      } else {
        queue.push(message)
      }
    },
    end() {
      done = true
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: undefined, done: true })
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { waiting = resolve })
        },
      }
    },
  }
}

class Session {
  constructor(ctx, label, { options = {}, env = {}, permissions } = {}) {
    this.ctx = ctx
    this.label = label
    this.frames = []
    this.listeners = new Set()
    this.ended = null
    this.stderr = []
    this.child = null
    this.childExit = null
    this.input = createInput()
    this.abort = new AbortController()
    const trace = ctx.trace
    const self = this
    this.query = ctx.query({
      prompt: this.input,
      options: {
        cwd: ctx.fixture.cwd,
        env: ctx.fixture.env(ctx.provider.url, { ...SESSION_STATE_ENV, ...env }),
        model: FAKE_MODEL,
        pathToClaudeCodeExecutable: ctx.nativeCli,
        abortController: this.abort,
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        extraArgs: { 'replay-user-messages': null },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        stderr: (data) => { self.stderr.push(String(data)) },
        ...(permissions ? { canUseTool: (toolName, input, opts) => self.canUseTool(permissions, toolName, input, opts) } : {}),
        spawnClaudeCodeProcess(spawnOptions) {
          const child = spawn(spawnOptions.command, spawnOptions.args, {
            cwd: spawnOptions.cwd,
            env: spawnOptions.env,
            signal: spawnOptions.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          child.stderr.on('data', (data) => { self.stderr.push(String(data)) })
          child.once('exit', (code, signal) => {
            self.childExit = { code, signal }
            trace.add({ s: label, k: 'cli-exit', code, signal })
          })
          self.child = child
          return child
        },
        ...options,
      },
    })
    trace.add({ s: label, k: 'open', options: trimDeep({ ...options, mcpServers: options.mcpServers ? Object.keys(options.mcpServers) : undefined }) })
    this.done = (async () => {
      try {
        for await (const message of this.query) {
          trace.add({ s: label, k: 'msg', m: recordable(message) })
          this.frames.push(message)
          for (const listener of [...this.listeners]) listener(message)
        }
        this.ended = { kind: 'end' }
        trace.add({ s: label, k: 'end' })
      } catch (error) {
        this.ended = { kind: 'throw', message: String(error?.message ?? error) }
        trace.add({ s: label, k: 'throw', message: this.ended.message })
      }
      for (const listener of [...this.listeners]) listener(null)
    })()
  }

  /** Record a permission request, then answer it with `decide(toolName, input, options)`. */
  async canUseTool(decide, toolName, input, options) {
    const { signal, ...rest } = options ?? {}
    this.ctx.trace.add({ s: this.label, k: 'can-use-tool', toolName, input: trimDeep(input), options: trimDeep(rest), aborted: signal?.aborted === true })
    const decision = await decide(toolName, input, options)
    this.ctx.trace.add({ s: this.label, k: 'can-use-tool-answered', toolName, behavior: decision.behavior })
    return decision
  }

  /** Push a user prompt stamped with a fresh uuid registered under `label`. */
  push(text, label) {
    const uuid = label ? this.ctx.uuid(label) : undefined
    this.ctx.trace.add({ s: this.label, k: 'push', uuid, text })
    this.input.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: 'default',
      ...(uuid ? { uuid } : {}),
    })
    return uuid
  }

  async interrupt(tag) {
    this.ctx.trace.add({ s: this.label, k: 'interrupt', tag })
    try {
      const receipt = await this.query.interrupt()
      this.ctx.trace.add({ s: this.label, k: 'interrupt-settled', tag, receipt: receipt ?? null })
      return { ok: true, receipt }
    } catch (error) {
      this.ctx.trace.add({ s: this.label, k: 'interrupt-rejected', tag, message: String(error?.message ?? error) })
      return { ok: false }
    }
  }

  /** Await initializationResult() and record its shape (never its private values). */
  async init() {
    try {
      const result = await this.query.initializationResult()
      const summary = {
        keys: Object.keys(result ?? {}).sort(),
        pidIsNumber: Number.isInteger(result?.pid),
        pidIsCli: Number.isInteger(result?.pid) && result.pid === this.child?.pid,
        current_permission_mode: result?.current_permission_mode,
        commands: Array.isArray(result?.commands) ? result.commands.length : null,
        models: Array.isArray(result?.models) ? result.models.length : null,
        account: result?.account && typeof result.account === 'object' ? Object.keys(result.account).sort() : null,
      }
      this.ctx.trace.add({ s: this.label, k: 'init-resolved', result: summary })
      return { ok: true, result }
    } catch (error) {
      const message = String(error?.message ?? error)
      this.ctx.trace.add({ s: this.label, k: 'init-rejected', message })
      return { ok: false, message }
    }
  }

  async call(name, ...args) {
    try {
      await this.query[name](...args)
      this.ctx.trace.add({ s: this.label, k: 'call', name, args, ok: true })
      return true
    } catch (error) {
      this.ctx.trace.add({ s: this.label, k: 'call', name, args, ok: false, message: String(error?.message ?? error) })
      return false
    }
  }

  messages(predicate = () => true) {
    return this.frames.filter(predicate)
  }

  results() {
    return this.messages((m) => m.type === 'result')
  }

  /** Resolve with the first message (seen or future) matching `predicate`, or null on timeout/stream end. */
  waitFor(predicate, ms = 20_000, what = 'message') {
    const hit = this.frames.find(predicate)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        if (value === null) this.ctx.trace.add({ s: this.label, k: 'wait-missed', what })
        resolve(value)
      }
      const listener = (message) => {
        if (message === null) finish(null)
        else if (predicate(message)) finish(message)
      }
      const timer = setTimeout(() => finish(null), ms)
      this.listeners.add(listener)
      if (this.ended) finish(null)
    })
  }

  waitForResults(count, ms = 20_000) {
    return this.waitFor(() => this.results().length >= count, ms, `${count} results`)
  }

  /** Resolve once `count` messages matching `predicate` have arrived. */
  waitForCount(predicate, count, ms = 20_000, what = 'messages') {
    return this.waitFor(() => this.messages(predicate).length >= count, ms, `${count} ${what}`)
  }

  /** Watch for `predicate` and run `action` once, the first time it matches. */
  once(predicate, action) {
    let fired = false
    const listener = (message) => {
      if (fired || message === null || !predicate(message)) return
      fired = true
      this.listeners.delete(listener)
      action(message)
    }
    this.listeners.add(listener)
  }

  cliPid() {
    return this.child?.pid
  }

  async close() {
    if (!this.closed) this.ctx.trace.add({ s: this.label, k: 'close' })
    this.closed = true
    this.input.end()
    try { this.query.close() } catch { /* already closed */ }
    await Promise.race([this.done, sleep(5000)])
    if (this.child && !this.childExit) {
      this.child.kill('SIGKILL')
      await Promise.race([new Promise((resolve) => this.child.once('exit', resolve)), sleep(3000)])
    }
  }
}

// ── scenario context ─────────────────────────────────────────────────────────

const isAssistantTool = (m) => m.type === 'assistant' && Array.isArray(m.message?.content) && m.message.content.some((b) => b.type === 'tool_use')
const isTextDelta = (m) => m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event?.delta?.type === 'text_delta'
const isStateIdle = (m) => m.type === 'system' && m.subtype === 'session_state_changed' && m.state === 'idle'

async function sha256(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

/**
 * What a turn that called an MCP tool showed: the servers and MCP tools its
 * init listed, and each tool result (its error flag and text; a JSON text
 * without the reporting process's pid).
 */
function mcpTurnShape(session) {
  const init = session.messages((m) => m.type === 'system' && m.subtype === 'init')[0]
  const results = session.messages((m) => m.type === 'user' && Array.isArray(m.message?.content))
    .flatMap((m) => m.message.content.filter((block) => block?.type === 'tool_result').map((block) => {
      const text = Array.isArray(block.content) ? block.content.map((part) => part?.text ?? '').join('') : String(block.content ?? '')
      let parsed
      try { parsed = JSON.parse(text); delete parsed.pid } catch { parsed = text }
      return {
        isError: block.is_error === true,
        content: Array.isArray(block.content) ? block.content.map((part) => part?.type) : typeof block.content,
        text: parsed,
        toolUseResult: Array.isArray(m.tool_use_result) ? m.tool_use_result.map((part) => part?.type) : typeof m.tool_use_result,
      }
    }))
  return {
    mcpServers: init?.mcp_servers ?? null,
    mcpTools: (init?.tools ?? []).filter((name) => String(name).startsWith('mcp__')),
    toolResults: results,
  }
}

/** The chain entries of a transcript (lines that carry a uuid), in file order, without their payloads. */
function transcriptShape(lines) {
  return (lines ?? []).filter((line) => typeof line.uuid === 'string').map((line) => ({
    type: line.type,
    uuid: line.uuid,
    parentUuid: line.parentUuid ?? null,
    ...(line.subtype ? { subtype: line.subtype } : {}),
    ...(line.isMeta ? { isMeta: true } : {}),
    ...(line.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
  }))
}

const SCENARIOS = {
  /** T1 T2 T3 T7 T8: fresh boot with our session id, settings before the first prompt, two turns. */
  async boot(ctx) {
    const X = ctx.uuid('X')
    const s = ctx.open('S', { options: { sessionId: X } })
    await s.init()
    await sleep(1500)
    ctx.observe('beforePrompt', { files: await ctx.files(), messages: s.frames.length })
    await s.call('setModel', 'claude-opus-4-1-20250805')
    await s.call('setPermissionMode', 'acceptEdits')
    await sleep(500)
    ctx.observe('afterSettings', { files: await ctx.files(), messages: s.frames.length })
    s.push('first prompt', 'u1')
    await s.waitForResults(1)
    const resultAt = Date.now()
    const appeared = await ctx.pollTranscript(X, 4000)
    ctx.observe('transcriptAfterFirstResult', { msAfterResult: appeared ? Date.now() - resultAt : null, shape: transcriptShape(appeared) })
    s.push('second prompt', 'u2')
    await s.waitForResults(2)
    await s.waitForCount(isStateIdle, 2, 3000, 'idle')
    await s.close()
  },

  /**
   * T7: which settings calls the CLI refuses. Any model or effort name is
   * accepted (a model change replays its /model command); only an unknown
   * permission mode is rejected, and the session keeps working.
   */
  async settings(ctx) {
    const s = ctx.open('S', { options: { permissionMode: 'default' } })
    await s.init()
    await s.call('setModel', 'no-such-model')
    await s.call('applyFlagSettings', { effortLevel: 'no-such-effort' })
    await s.call('setPermissionMode', 'no-such-mode')
    await s.call('setPermissionMode', 'plan')
    s.push('after settings', 'u1')
    await s.waitForResults(1)
    await s.waitForCount(isStateIdle, 1, 3000, 'idle')
    await s.close()
  },

  /** T4: booting a fresh session with an id whose transcript already exists. */
  async 'session-in-use'(ctx) {
    const X = ctx.uuid('X')
    const seed = ctx.open('seed', { options: { sessionId: X } })
    seed.push('seed prompt', 'u1')
    await seed.waitForResults(1)
    ctx.need(await ctx.pollTranscript(X, 4000), 'seed transcript')
    await seed.close()
    const s = ctx.open('S', { options: { sessionId: X } })
    await s.init()
    await Promise.race([s.done, sleep(8000)])
    await sleep(300)
    ctx.observe('rejected', { ended: s.ended, childExit: s.childExit, stderr: s.stderr.join('').slice(-2000) })
    await s.close()
  },

  /** T5 T6: lazy fork with a guard, re-spawned before its prompt; then the three boot refusals. */
  async fork(ctx) {
    const P = ctx.uuid('P')
    const seed = ctx.open('seed', { options: { sessionId: P } })
    seed.push('turn one', 'u1')
    await seed.waitForResults(1)
    seed.push('turn two', 'u2')
    await seed.waitForResults(2)
    // A turn ends with its result, then its lifecycle and idle frames. Close
    // only after them: frames after a close are dropped from the trace, so a
    // close racing them makes the real CLI's trace differ run to run.
    await seed.waitForCount(isStateIdle, 2, 5000, 'idle')
    ctx.need(await ctx.pollTranscript(P, 4000, 2), 'parent transcript')
    await seed.close()
    await sleep(300)
    const parentLinesSettled = await ctx.fixture.readTranscript(P)
    const u2 = ctx.uuidOf('u2')
    const u2Index = parentLinesSettled.findIndex((line) => line.uuid === u2)
    const keepAt = ctx.need(parentLinesSettled.slice(0, u2Index).reverse().find((line) => line.type === 'assistant')?.uuid, 'fork point')
    ctx.label(keepAt, 'keepAt')
    const parentFile = path.join(ctx.fixture.claudeConfigDir, (await ctx.files()).find((f) => f.endsWith(`${P}.jsonl`)))
    const parentHash = await sha256(parentFile)
    ctx.observe('parent', { shape: transcriptShape(parentLinesSettled) })

    const F = ctx.uuid('F')
    const forkOptions = { resume: P, resumeSessionAt: keepAt, forkSession: true, sessionId: F, resumeDropsTurn: u2 }
    const first = ctx.open('fork1', { options: forkOptions })
    await first.init()
    await sleep(1000)
    ctx.observe('forkBeforePrompt', { files: await ctx.files() })
    await first.close()
    const again = ctx.open('fork2', { options: forkOptions })
    await again.init()
    again.push('after fork', 'u3')
    await again.waitForResults(1)
    await again.waitForCount(isStateIdle, 1, 5000, 'idle')
    const forkLines = await ctx.pollTranscript(F, 4000)
    await again.close()
    await sleep(300)
    ctx.observe('forkAfterPrompt', {
      files: await ctx.files(),
      shape: transcriptShape(await ctx.fixture.readTranscript(F)),
      forkLinesSeen: Array.isArray(forkLines),
      parentUnchanged: (await sha256(parentFile)) === parentHash,
    })

    const refusals = {
      missingResume: { resume: ctx.uuid('Z') },
      badForkPoint: { resume: P, resumeSessionAt: ctx.uuid('nowhere'), forkSession: true, sessionId: ctx.uuid('F2') },
      guard: { resume: P, resumeSessionAt: keepAt, forkSession: true, sessionId: ctx.uuid('F3'), resumeDropsTurn: ctx.uuid('wrongTurn') },
    }
    for (const [name, options] of Object.entries(refusals)) {
      const r = ctx.open(name, { options })
      await r.init()
      await Promise.race([r.done, sleep(8000)])
      await r.close()
    }
    ctx.observe('afterRefusals', { files: await ctx.files() })
  },

  /**
   * T10 T5 (decision 2 of the core design): the transcript records a send
   * absorbed during a tool call as a `queued_command` attachment inside that
   * turn, so a guarded fork that undoes the turn is refused: the discarded
   * range holds content the declared turn's prompt did not bring.
   */
  async 'absorbed-undo'(ctx) {
    const P = ctx.uuid('P')
    const s = ctx.open('S', { options: { sessionId: P } })
    s.push('turn one', 'u1')
    await s.waitForResults(1)
    s.once(isAssistantTool, () => setTimeout(() => s.push('absorbed during tool', 'u3'), 500))
    // 1.5 s keeps the Bash call clear of the CLI's ~3 s background-task promotion.
    const u2 = s.push('please TOOL:sleep=1.5', 'u2')
    await s.waitForResults(2, 30_000)
    await s.waitForCount(isStateIdle, 2, 10_000, 'idle')
    ctx.need(await ctx.pollTranscript(P, 4000, 2), 'parent transcript')
    await s.close()
    await sleep(300)
    const lines = await ctx.fixture.readTranscript(P)
    const u2Index = lines.findIndex((line) => line.uuid === u2)
    const keepAt = ctx.need(lines.slice(0, u2Index).reverse().find((line) => typeof line.uuid === 'string')?.uuid, 'fork point')
    ctx.label(keepAt, 'keepAt')
    ctx.observe('parent', {
      shape: transcriptShape(lines),
      absorbed: lines
        .filter((line) => line.type === 'attachment' && line.attachment?.type === 'queued_command')
        .map((line) => ({ source: line.attachment.source_uuid, prompt: line.attachment.prompt, mode: line.attachment.commandMode })),
    })
    const guarded = ctx.open('guarded', { options: { resume: P, resumeSessionAt: keepAt, forkSession: true, sessionId: ctx.uuid('F'), resumeDropsTurn: u2 } })
    await guarded.init()
    await Promise.race([guarded.done, sleep(8000)])
    await guarded.close()
    ctx.observe('afterGuard', { files: await ctx.files() })
  },

  /**
   * T19 T5: a background agent's completion is written into the turn that
   * launched it as a user line of origin `task-notification` (no prompt of its
   * own), so a guarded fork that undoes the launching turn is refused: the
   * discarded range holds an externally-sourced entry.
   */
  async 'notification-undo'(ctx) {
    const P = ctx.uuid('P')
    const s = ctx.open('S', { options: { sessionId: P } })
    s.push('turn one', 'u1')
    await s.waitForResults(1)
    const u2 = s.push('AGENT:async', 'u2')
    await s.waitForResults(3, 30_000)
    await s.waitForCount(isStateIdle, 2, 10_000, 'idle')
    ctx.need(await ctx.pollTranscript(P, 4000, 2), 'parent transcript')
    await s.close()
    await sleep(300)
    const lines = await ctx.fixture.readTranscript(P)
    const u2Index = lines.findIndex((line) => line.uuid === u2)
    const keepAt = ctx.need(lines.slice(0, u2Index).reverse().find((line) => typeof line.uuid === 'string')?.uuid, 'fork point')
    ctx.label(keepAt, 'keepAt')
    ctx.observe('parent', {
      shape: transcriptShape(lines),
      notifications: lines.filter((line) => line.origin?.kind === 'task-notification').map((line) => ({ type: line.type, origin: line.origin.kind, xml: typeof line.message?.content === 'string' && line.message.content.startsWith('<task-notification>') })),
    })
    const guarded = ctx.open('guarded', { options: { resume: P, resumeSessionAt: keepAt, forkSession: true, sessionId: ctx.uuid('F'), resumeDropsTurn: u2 } })
    await guarded.init()
    await Promise.race([guarded.done, sleep(8000)])
    await guarded.close()
  },

  /** T8 T9 T10: a send absorbed during a tool call, then a send queued during streamed text. */
  async turns(ctx) {
    const s = ctx.open('S')
    s.once(isAssistantTool, () => setTimeout(() => s.push('absorbed during tool', 'u2'), 500))
    // 1.5 s keeps the Bash call clear of the CLI's ~3 s background-task promotion.
    s.push('please TOOL:sleep=1.5', 'u1')
    await s.waitForResults(1, 30_000)
    await s.waitForCount(isStateIdle, 1, 10_000, 'idle after absorb')
    await sleep(1500)
    const before = s.results().length
    s.once(isTextDelta, () => s.push('queued during text', 'u4'))
    s.push('SLOW reply', 'u3')
    await s.waitForResults(before + 2, 30_000)
    await sleep(1500)
    await s.close()
  },

  /** T8: slash commands, an unknown slash command, and the uuids the CLI replays on its own. */
  async slash(ctx) {
    const s = ctx.open('S')
    const steps = [['hello', 'u1'], ['/cost', 'u2'], ['/no-such-command-xyz', 'u3'], ['after slash', 'u4']]
    let count = 0
    for (const [text, label] of steps) {
      s.push(text, label)
      count += 1
      await s.waitForResults(count, 15_000)
      await sleep(400)
    }
    await sleep(800)
    await s.close()
  },

  /** T11 T12: warm Stop during text, during a tool, and with a second send queued. */
  async interrupts(ctx) {
    const s = ctx.open('S')
    s.once(isTextDelta, () => void s.interrupt('text'))
    s.push('SLOW interrupt me', 'u1')
    await s.waitForResults(1)
    await s.waitForCount(isStateIdle, 1, 5000, 'idle')
    s.once(isAssistantTool, () => setTimeout(() => void s.interrupt('tool'), 400))
    s.push('TOOL:sleep=5 interrupt me', 'u2')
    await s.waitForResults(2)
    await sleep(800)
    s.once(isTextDelta, () => {
      s.push('queued behind', 'u4')
      setTimeout(() => void s.interrupt('queued'), 400)
    })
    s.push('SLOW then stop', 'u3')
    await s.waitForResults(4, 30_000)
    await sleep(1000)
    await s.close()
  },

  /** T13: Stop while the CLI is still starting; without and with the re-send at `started`/replay. */
  async 'cold-stop'(ctx) {
    const a = ctx.open('noResend')
    a.push('SLOW cold', 'u1')
    void a.interrupt('cold')
    await a.waitForResults(1, 30_000)
    await a.close()

    const b = ctx.open('resend')
    const u2 = b.push('SLOW cold', 'u2')
    void b.interrupt('cold')
    b.once(
      (m) => (m.type === 'command_lifecycle' && m.command_uuid === u2 && m.state === 'started')
        || (m.type === 'user' && m.isReplay === true && m.uuid === u2),
      () => { if (b.results().length === 0) void b.interrupt('resend') },
    )
    await b.waitForResults(1, 30_000)
    await b.close()
  },

  /** T14: SIGKILL of the CLI mid-turn; a later push is lost. */
  async crash(ctx) {
    const s = ctx.open('S')
    s.once(isTextDelta, () => {
      ctx.trace.add({ s: 'S', k: 'kill-cli', signal: 'SIGKILL' })
      process.kill(ctx.need(s.cliPid(), 'cli pid'), 'SIGKILL')
    })
    s.push('SLOW kill me', 'u1')
    await Promise.race([s.done, sleep(15_000)])
    const atThrow = s.frames.length
    s.push('after crash', 'u2')
    await sleep(1500)
    ctx.observe('afterCrash', { messagesAfterThrow: s.frames.length - atThrow, results: s.results().length, nodeAlive: true })
    await s.close()
  },

  /** T15: a successful /compact, then a failed one (the summary request errors), one result each. */
  async compact(ctx) {
    const s = ctx.open('S')
    s.push('seed one', 'u1')
    await s.waitForResults(1)
    s.push('seed two', 'u2')
    await s.waitForResults(2)
    s.push('/compact', 'u3')
    await s.waitForResults(3, 30_000)
    await s.waitForCount(isStateIdle, 3, 5000, 'idle')
    s.push('after compact', 'u4')
    await s.waitForResults(4)
    await s.waitForCount(isStateIdle, 4, 5000, 'idle')
    s.push('/compact APIERR:400', 'u5')
    await s.waitForResults(5, 30_000)
    await sleep(1500)
    await s.close()
  },

  /** T16: /clear re-keys the conversation; the new session is on disk at once and resumable. */
  async clear(ctx) {
    const A = ctx.uuid('A')
    const s = ctx.open('S', { options: { sessionId: A } })
    s.push('hello', 'u1')
    await s.waitForResults(1)
    await sleep(300)
    s.push('/clear', 'u2')
    const reset = await s.waitFor((m) => m.type === 'conversation_reset', 15_000, 'conversation_reset')
    ctx.label(reset?.new_conversation_id, 'resetId')
    await s.waitForResults(2)
    const inits = s.messages((m) => m.type === 'system' && m.subtype === 'init')
    const B = ctx.need(inits.at(-1)?.session_id, 'post-reset session id')
    ctx.label(B, 'B')
    const cleared = ctx.need(await ctx.fixture.readTranscript(B), 'post-reset transcript exists')
    ctx.observe('afterClear', {
      files: await ctx.files(),
      hasModeMetadata: cleared.some((row) => row.type === 'mode' && row.mode === 'normal'),
    })
    const flushed = ctx.need(await ctx.pollTranscript(B, 5000, 1, (rows) =>
      rows.some((row) => row.type === 'user' && typeof row.message?.content === 'string'
        && row.message.content.includes('<command-name>/clear</command-name>'))
      && rows.some((row) => row.type === 'system' && row.subtype === 'local_command')),
    'post-reset local-command rows flushed')
    ctx.observe('afterClearFlush', {
      lineTypes: flushed.map((row) => row.type),
      messages: flushed.filter((row) => row.type === 'user' || row.type === 'assistant')
        .map((row) => ({ type: row.type, isMeta: row.isMeta === true, content: row.message?.content })),
      localCommands: flushed.filter((row) => row.type === 'system' && row.subtype === 'local_command')
        .map((row) => ({ subtype: row.subtype, content: row.content, isMeta: row.isMeta === true })),
    })
    s.push('after clear', 'u3')
    await s.waitForResults(3)
    await sleep(500)
    await s.close()
    const r = ctx.open('resumeB', { options: { resume: B } })
    await r.init()
    await r.close()
  },

  /** T17: tool heartbeats every 30 s (a hung MCP tool and a long Bash call), and the Bash timeout cap. */
  async heartbeat(ctx) {
    const cap = ctx.open('cap', { env: { BASH_DEFAULT_TIMEOUT_MS: '500', BASH_MAX_TIMEOUT_MS: '1000' } })
    const capStarted = Date.now()
    cap.push('TOOL:sleep=20,timeout=600000', 'u3')
    await cap.waitForResults(1, 25_000)
    ctx.observe('cap', { elapsedMs: Date.now() - capStarted })
    await cap.close()

    const mcp = ctx.open('mcp', {
      options: { mcpServers: { [HANG_MCP_SERVER_NAME]: { type: 'stdio', command: process.execPath, args: [HANG_MCP_SERVER_SCRIPT] } } },
    })
    const bash = ctx.open('bash')
    mcp.push('MCP:hang', 'u1')
    bash.push('TOOL:sleep=45', 'u2')
    const isHeartbeat = (m) => m.type === 'tool_progress' && m.heartbeat === true
    await Promise.all([mcp.waitFor(isHeartbeat, 45_000, 'mcp heartbeat'), bash.waitFor(isHeartbeat, 45_000, 'bash heartbeat')])
    await Promise.all([mcp.close(), bash.close()])
  },

  /**
   * G19: the CLI starts a stdio MCP server with its own environment, lists the
   * server's tools once it connected, and returns a tool call's text result;
   * a call of an MCP tool no configured server offers is an error result.
   */
  async mcp(ctx) {
    const report = path.join(ctx.fixture.root, 'mcp-probe-report.json')
    const s = ctx.open('S', {
      options: { mcpServers: { freshell: { type: 'stdio', command: process.execPath, args: [FRESHELL_MCP_PROBE_SERVER, report] } } },
      env: { FRESHELL: '1', FRESHELL_URL: 'http://127.0.0.1:9/probe', FRESHELL_TOKEN: 'probe-token', FRESHELL_TAB_ID: 'tab-s', FRESHELL_PANE_ID: 'pane-s' },
    })
    s.push('MCP:call=mcp__freshell__context', 'u1')
    await s.waitForResults(1, 30_000)
    ctx.observe('connected', mcpTurnShape(s))
    const seen = JSON.parse(await fs.readFile(report, 'utf8'))
    delete seen.pid
    ctx.observe('serverEnvironment', seen)
    await s.close()

    const m = ctx.open('M')
    m.push('MCP:call=mcp__freshell__freshell', 'u2')
    await m.waitForResults(1, 30_000)
    ctx.observe('missing', mcpTurnShape(m))
    await m.close()
  },

  /** T18: an API error ends the turn with a success-subtype error result. */
  async 'api-error'(ctx) {
    const X = ctx.uuid('X')
    const s = ctx.open('S', { options: { sessionId: X } })
    s.push('APIERR:400', 'u1')
    await s.waitForResults(1, 30_000)
    await ctx.pollTranscript(X, 4000, 2)
    await sleep(300)
    ctx.observe('transcript', { shape: transcriptShape(await ctx.fixture.readTranscript(X)) })
    await sleep(500)
    await s.close()
  },

  /** canUseTool in default mode (allow, then deny), then ExitPlanMode in plan mode. */
  async permission(ctx) {
    const s = ctx.open('S', {
      options: { permissionMode: 'default' },
      permissions: (toolName, input) => (ctx.denyNext
        ? { behavior: 'deny', message: 'denied by the scenario' }
        : { behavior: 'allow', updatedInput: input }),
    })
    s.push('TOOL:touch', 'u1')
    await s.waitForResults(1, 30_000)
    ctx.denyNext = true
    s.push('TOOL:touch', 'u2')
    await s.waitForResults(2, 30_000)
    ctx.denyNext = false
    await s.call('setPermissionMode', 'plan')
    s.push('PLAN:exit', 'u3')
    await s.waitForResults(3, 30_000)
    await sleep(500)
    await s.close()
  },

  /**
   * An approved ExitPlanMode returns the CLI to the mode it had before plan
   * mode: bypassPermissions here, not default (transcript-live B6).
   */
  async 'plan-return'(ctx) {
    const s = ctx.open('S', {
      options: { permissionMode: 'bypassPermissions' },
      permissions: (toolName, input) => ({ behavior: 'allow', updatedInput: input }),
    })
    await s.init()
    await s.call('setPermissionMode', 'plan')
    s.push('PLAN:exit', 'u1')
    await s.waitForResults(1, 30_000)
    await s.waitForCount(isStateIdle, 1, 3000, 'idle')
    await sleep(300)
    await s.close()
  },

  /** F11: the API answers 529 twice; the CLI reports each retry (system/api_retry), then answers. */
  async retry(ctx) {
    const s = ctx.open('S')
    s.push('RETRY:529x2', 'u1')
    await s.waitForResults(1, 60_000)
    await s.waitForCount(isStateIdle, 1, 3000, 'idle')
    await sleep(300)
    await s.close()
  },

  /** T19: a background Agent's completion starts a CLI-initiated turn with no uuid and no lifecycle. */
  async 'cli-turn'(ctx) {
    const s = ctx.open('S')
    s.push('AGENT:async', 'u1')
    await s.waitForResults(1, 30_000)
    await s.waitForResults(2, 30_000)
    await s.waitForCount(isStateIdle, 2, 10_000, 'idle')
    await sleep(800)
    await s.close()
  },
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS)

/** Load the `query` export of the target. */
async function loadTarget(target, repoRoot) {
  if (target === 'real') {
    const pinned = await resolvePinnedClaude(repoRoot)
    const sdk = await import(pathToFileURL(pinned.sdkEntry).href)
    return { query: sdk.query, nativeCli: pinned.nativeCli, versions: { sdk: pinned.sdkVersion, cli: pinned.cliVersion } }
  }
  if (target === 'sim') {
    const sim = await import(pathToFileURL(SIM_QUERY_MODULE).href)
    return { query: sim.query, nativeCli: undefined, versions: { sim: sim.SIMULATED_CLI_VERSION } }
  }
  throw new Error(`unknown target ${target}`)
}

export async function runScenario(target, name, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`unknown scenario ${name}`)
  const loaded = await loadTarget(target, repoRoot)
  const trace = new Trace()
  const provider = await startLocalProvider()
  const fixture = await createClaudeFixture()
  const sessions = []
  const labels = new Map()
  const observations = {}
  const ctx = {
    trace,
    provider,
    fixture,
    nativeCli: loaded.nativeCli,
    query: loaded.query,
    open(label, opts) {
      const session = new Session(ctx, label, opts)
      sessions.push(session)
      return session
    },
    uuid(label) {
      const value = randomUUID()
      labels.set(value, label)
      return value
    },
    label(value, label) {
      if (typeof value === 'string' && !labels.has(value)) labels.set(value, label)
    },
    uuidOf(label) {
      for (const [value, l] of labels) if (l === label) return value
      return undefined
    },
    observe(key, value) {
      observations[key] = value
      trace.add({ k: 'observe', key })
    },
    need(value, what) {
      if (value === undefined || value === null || value === false) throw new Error(`scenario prerequisite missing: ${what}`)
      return value
    },
    files: () => fixture.transcripts(),
    /** Poll until the saved lines satisfy the requested count and optional predicate. */
    async pollTranscript(id, ms, minLines = 1, predicate) {
      const started = Date.now()
      while (Date.now() - started <= ms) {
        const lines = await fixture.readTranscript(id)
        if (lines && lines.length >= minLines && (!predicate || predicate(lines))) {
          trace.add({ k: 'transcript-seen', id, lines: lines.length })
          return lines
        }
        await sleep(50)
      }
      trace.add({ k: 'transcript-missing', id })
      return null
    },
  }
  let failure
  try {
    await scenario(ctx)
  } catch (error) {
    failure = String(error?.stack ?? error)
  } finally {
    await Promise.all(sessions.map((s) => s.close().catch(() => {})))
    await provider.close()
    await fixture.cleanup()
  }
  return {
    target,
    scenario: name,
    versions: loaded.versions,
    failure,
    labels: Object.fromEntries(labels),
    observations,
    events: trace.events,
    providerRequests: provider.requests,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, name] = process.argv.slice(2)
  process.on('unhandledRejection', (error) => {
    process.stderr.write(`${JSON.stringify({ severity: 'warn', component: 'claude-cli-scenarios', event: 'unhandled_rejection', message: String(error?.message ?? error).slice(0, 300) })}\n`)
  })
  // A large result on a pipe is written asynchronously: exit only once it is flushed.
  const finish = (stream, text, code) => stream.write(text, () => process.exit(code))
  try {
    const result = await runScenario(target, name)
    finish(process.stdout, `${JSON.stringify(result)}\n`, 0)
  } catch (error) {
    finish(process.stderr, `${JSON.stringify({ severity: 'error', component: 'claude-cli-scenarios', event: 'scenario_failed', target, scenario: name, message: String(error?.message ?? error) })}\n`, 1)
  }
}
