// @vitest-environment node
//
// The CLI simulator's own features that have no real-CLI counterpart to
// compare against: scenario programs (FRESHELL_CLAUDE_SIM_PROGRAM and its
// aliases), the options ledger, and the sidecar seam it plugs into; plus what
// a normalized trace cannot see (nothing reaches the disk after the stream
// ends). The behavior it shares with the real CLI is covered by
// claude-cli-conformance.ts.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../fixtures/claude-cli-sim/query.mjs'
import { REPO_ROOT } from './claude-cli-trace'

const SIDECAR = path.join(REPO_ROOT, 'crates/freshell-claude-sidecar/index.mjs')
const SIM = path.join(REPO_ROOT, 'test/fixtures/claude-cli-sim/query.mjs')
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-claude-sim-'))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  const cwd = path.join(root, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  return { root, cwd, env: { HOME: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'), PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } }
}

function input() {
  const queue: any[] = []
  let waiting: ((value: IteratorResult<any>) => void) | null = null
  return {
    push(text: string, uuid?: string) {
      const message = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: 'default', ...(uuid ? { uuid } : {}) }
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: message, done: false })
      } else {
        queue.push(message)
      }
    },
    [Symbol.asyncIterator]() {
      return { next: () => (queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise<IteratorResult<any>>((resolve) => { waiting = resolve })) }
    },
  }
}

/** Open a simulated session that records every message; `until` resolves on the first match. */
async function open(options: Record<string, unknown>, env: Record<string, string> = {}) {
  const home = await tempHome()
  const prompt = input()
  const q: any = query({ prompt, options: { cwd: home.cwd, env: { ...home.env, ...env }, includePartialMessages: false, permissionMode: 'bypassPermissions', ...options } })
  const messages: any[] = []
  let ended: { error?: string } | null = null
  const listeners = new Set<() => void>()
  const done = (async () => {
    try {
      for await (const message of q) {
        messages.push(message)
        for (const listener of [...listeners]) listener()
      }
      ended = {}
    } catch (error) {
      ended = { error: String((error as Error).message) }
    }
    for (const listener of [...listeners]) listener()
  })()
  cleanups.push(async () => {
    q.close()
    await done
  })
  const until = (predicate: () => boolean, ms = 10_000) => new Promise<void>((resolve, reject) => {
    if (predicate()) return resolve()
    const timer = setTimeout(() => reject(new Error(`timed out; messages=${JSON.stringify(messages.map((m) => [m.type, m.subtype, m.state]))}`)), ms)
    const check = () => {
      if (!predicate()) return
      clearTimeout(timer)
      listeners.delete(check)
      resolve()
    }
    listeners.add(check)
  })
  return { q, prompt, messages, until, home, get ended() { return ended } }
}

/** Every file under `root` (relative path to contents). */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (directory: string) => {
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(target)
      else out[path.relative(root, target)] = await fs.readFile(target, 'utf8')
    }
  }
  await walk(root)
  return out
}

const program = (rules: unknown[]) => ({ FRESHELL_CLAUDE_SIM_PROGRAM: JSON.stringify({ rules }), FRESHELL_CLAUDE_SIM_TIME_SCALE: '0.1' })
const results = (messages: any[]) => messages.filter((m) => m.type === 'result')

describe('Claude CLI simulator programs', () => {
  it('a matching prompt rule replaces the marker behavior: a question goes through canUseTool and the answer ends the turn', async () => {
    const calls: any[] = []
    const s = await open({
      canUseTool: async (toolName: string, toolInput: any, options: any) => {
        calls.push({ toolName, toolInput, keys: Object.keys(options).sort() })
        return { behavior: 'allow', updatedInput: { ...toolInput, answers: { 'Pick one': 'A' } } }
      },
    }, program([{ on: 'msg:prompt', match: { text: 'please ask' }, emit: [{ kind: 'question', data: { questions: [{ question: 'Pick one', header: 'Choice', options: [{ label: 'A', description: 'a' }], multiSelect: false }] } }] }]))
    s.prompt.push('please ask', '11111111-1111-4111-8111-111111111111')
    await s.until(() => s.messages.some((m) => m.subtype === 'session_state_changed' && m.state === 'idle'))
    expect(calls).toEqual([{ toolName: 'AskUserQuestion', toolInput: { questions: [expect.objectContaining({ question: 'Pick one' })] }, keys: ['displayName', 'requestId', 'signal', 'toolUseID'] }])
    expect(s.messages.filter((m) => m.subtype === 'session_state_changed').map((m) => m.state)).toEqual(['running', 'requires_action', 'running', 'idle'])
    const toolResult = s.messages.find((m) => m.type === 'user' && m.message?.content?.[0]?.type === 'tool_result')
    expect(toolResult.message.content[0].content).toContain('"Pick one":"A"')
    expect(results(s.messages)[0]).toMatchObject({ subtype: 'success', is_error: false, terminal_reason: 'completed' })
  })

  it('an approval asks canUseTool, forwarding suggestions, blockedPath and decisionReason; a denial is recorded on the result', async () => {
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' }]
    const seen: any[] = []
    const s = await open({
      permissionMode: 'default',
      canUseTool: async (_toolName: string, _input: any, options: any) => {
        seen.push(options)
        return { behavior: 'deny', message: 'no thanks' }
      },
    }, program([{ on: 'msg:prompt', emit: [{ kind: 'approval', data: { tool: 'Bash', input: { command: 'npm test' }, suggestions, blockedPath: '/tmp/blocked', decisionReason: 'needs approval' } }] }]))
    s.prompt.push('run the tests')
    await s.until(() => results(s.messages).length === 1)
    expect(seen[0]).toMatchObject({ suggestions, blockedPath: '/tmp/blocked', decisionReason: 'needs approval', displayName: 'Bash' })
    const toolResult = s.messages.find((m) => m.type === 'user' && m.message?.content?.[0]?.type === 'tool_result')
    expect(toolResult.message.content[0]).toMatchObject({ is_error: true, content: 'no thanks' })
    expect(results(s.messages)[0].permission_denials).toEqual([expect.objectContaining({ tool_name: 'Bash', tool_input: { command: 'npm test' } })])
  })

  // The pinned CLI never asks canUseTool for a tool call under
  // bypassPermissions (only AskUserQuestion asks in every mode), so an
  // `approval` step there would pin a behavior the real CLI does not have.
  // It fails the stream loudly instead of asking.
  it('an approval step under bypassPermissions fails loudly instead of asking', async () => {
    const asked: string[] = []
    const s = await open({
      permissionMode: 'bypassPermissions',
      canUseTool: async (toolName: string) => {
        asked.push(toolName)
        return { behavior: 'allow' }
      },
    }, program([{ on: 'msg:prompt', emit: [{ kind: 'approval', data: { tool: 'Bash', input: { command: 'npm test' } } }] }]))
    s.prompt.push('run the tests')
    await s.until(() => s.ended !== null)
    expect(s.ended?.error).toMatch(/^Claude CLI simulator failure: .*bypassPermissions/)
    expect(asked).toEqual([])
    expect(results(s.messages)).toEqual([])
  })

  it('a completion rule ends the turn with the scripted subtype; a `once` rule then falls back to the prompt markers', async () => {
    const s = await open({}, program([{ on: 'msg:prompt', once: true, emit: [{ kind: 'text', data: { text: 'partial' } }, { kind: 'completion', data: { subtype: 'error_max_turns', text: 'too many turns' } }] }]))
    s.prompt.push('first')
    await s.until(() => results(s.messages).length === 1)
    s.prompt.push('APIERR:529')
    await s.until(() => results(s.messages).length === 2)
    const [first, second] = results(s.messages)
    expect(first).toMatchObject({ subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] })
    expect(second).toMatchObject({ subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 529 })
  })

  it('a crash rule kills the stand-in CLI: the stream throws the SDK\'s termination error and no result arrives', async () => {
    const killed = await open({}, program([{ on: 'msg:prompt', emit: [{ kind: 'crash' }] }]))
    killed.prompt.push('go')
    await killed.until(() => killed.ended !== null)
    expect(killed.ended).toEqual({ error: 'Claude Code process terminated by signal SIGKILL' })
    expect(results(killed.messages)).toEqual([])

    const exited = await open({}, program([{ on: 'msg:prompt', emit: [{ kind: 'crash', data: { code: 3 } }] }]))
    exited.prompt.push('go')
    await exited.until(() => exited.ended !== null)
    expect(exited.ended).toEqual({ error: 'Claude Code process exited with code 3' })
  })

  it('a CLI that exits with code 0 mid-turn ends the stream cleanly, with no error and no result', async () => {
    // The SDK reports no error for exit code 0 (sdk.mjs getProcessExitError),
    // so its message iterator simply ends: the natural end of stream that the
    // sidecar must treat as a session end (G23).
    const s = await open({}, program([{ on: 'msg:prompt', emit: [{ kind: 'text', data: { text: 'partial' } }, { kind: 'crash', data: { code: 0 } }] }]))
    s.prompt.push('go')
    await s.until(() => s.ended !== null)
    expect(s.ended).toEqual({})
    expect(s.messages.some((m) => m.type === 'assistant')).toBe(true)
    expect(results(s.messages)).toEqual([])
  })

  it('a hang rule keeps the turn open until an interrupt aborts it', async () => {
    const s = await open({}, program([{ on: 'msg:prompt', emit: [{ kind: 'hang' }] }]))
    s.prompt.push('wait forever', '22222222-2222-4222-8222-222222222222')
    await s.until(() => s.messages.some((m) => m.type === 'user' && m.isReplay))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(results(s.messages)).toEqual([])
    await expect(s.q.interrupt()).resolves.toEqual({ still_queued: [] })
    await s.until(() => results(s.messages).length === 1)
    expect(results(s.messages)[0]).toMatchObject({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' })
    await s.until(() => s.messages.some((m) => m.type === 'command_lifecycle' && m.state === 'cancelled'))
  })

  it('a start rule can schedule a CLI-initiated turn: init and a result with no lifecycle, bracketed by running and idle', async () => {
    const s = await open({}, program([{ on: 'start', emit: [{ kind: 'cli_turn', data: { afterMs: 50 } }] }]))
    await s.until(() => results(s.messages).length === 1)
    await s.until(() => s.messages.some((m) => m.subtype === 'session_state_changed' && m.state === 'idle'))
    expect(s.messages.map((m) => m.subtype ?? m.type)).toEqual(expect.arrayContaining(['task_notification', 'init', 'success']))
    expect(s.messages.filter((m) => m.type === 'command_lifecycle')).toEqual([])
    expect(s.messages.filter((m) => m.subtype === 'session_state_changed').map((m) => m.state)).toEqual(['running', 'idle'])
  })

  it('loads the program from a file or from the FRESHELL_CLAUDE_SDK_SCRIPT alias, and rejects an unknown emission kind', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-sim-program-'))
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    const file = path.join(dir, 'program.json')
    await fs.writeFile(file, JSON.stringify({ rules: [{ on: 'msg:prompt', emit: [{ kind: 'completion', data: { subtype: 'error_during_execution', text: 'from file' } }] }] }))
    for (const env of [{ FRESHELL_CLAUDE_SIM_PROGRAM_FILE: file }, { FRESHELL_CLAUDE_SDK_SCRIPT: file }]) {
      const s = await open({}, { ...env, FRESHELL_CLAUDE_SIM_TIME_SCALE: '0.1' })
      s.prompt.push('anything')
      await s.until(() => results(s.messages).length === 1)
      expect(results(s.messages)[0]).toMatchObject({ subtype: 'error_during_execution', errors: ['from file'] })
    }
    const home = await tempHome()
    expect(() => query({ prompt: input(), options: { cwd: home.cwd, env: { ...home.env, FRESHELL_CLAUDE_SIM_PROGRAM: JSON.stringify({ rules: [{ on: 'msg:prompt', emit: [{ kind: 'teleport' }] }] }) } } })).toThrow(/Unknown simulator emission kind "teleport"/)
  })

  it.each([
    ['a Bash call', 'TOOL:sleep=45'],
    ['a hung MCP tool', 'MCP:hang'],
  ])('a closed simulator writes nothing more under CLAUDE_CONFIG_DIR, even when it was closed during %s', async (_label, marker) => {
    const s = await open({}, { FRESHELL_CLAUDE_SIM_TIME_SCALE: '0.1' })
    s.prompt.push(marker, '33333333-3333-4333-8333-333333333333')
    await s.until(() => s.messages.some((m) => m.type === 'assistant' && m.message?.content?.some((b: any) => b.type === 'tool_use')))
    // Let the prompt's buffered lines reach the transcript, so it exists before the close.
    await new Promise((resolve) => setTimeout(resolve, 100))
    s.q.close()
    await s.until(() => s.ended !== null)
    const atClose = await snapshotTree(s.home.env.CLAUDE_CONFIG_DIR)
    expect(Object.keys(atClose).filter((file) => file.endsWith('.jsonl'))).toHaveLength(1)
    // Well past the simulator's transcript buffering window at this time scale.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await snapshotTree(s.home.env.CLAUDE_CONFIG_DIR)).toEqual(atClose)
  })

  it('records each query() call\'s options in FRESHELL_CLAUDE_SIM_LEDGER, with env reduced to its key names and credential digests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-sim-ledger-'))
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    const ledger = path.join(dir, 'ledger.jsonl')
    await open({ model: 'claude-test-model', plugins: [{ type: 'local', path: '/plugins/one' }], mcpServers: { freshell: { type: 'stdio', command: 'node' } } }, { FRESHELL_CLAUDE_SIM_LEDGER: ledger, ANTHROPIC_API_KEY: 'secret-value' })
    const rows = (await fs.readFile(ledger, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(rows[0]).toMatchObject({ kind: 'query', options: { model: 'claude-test-model', plugins: [{ type: 'local', path: '/plugins/one' }], mcpServers: { freshell: { type: 'stdio', command: 'node' } } } })
    expect(rows[0].options.envKeys).toContain('ANTHROPIC_API_KEY')
    // A credential is recorded as a short sha256 digest, so a test can tell
    // which value the child got without the ledger ever holding it.
    expect(rows[0].options.envDigests).toEqual({ ANTHROPIC_API_KEY: createHash('sha256').update('secret-value').digest('hex').slice(0, 12) })
    expect(JSON.stringify(rows)).not.toContain('secret-value')
  })

  it('records the boot, every prompt with the settings it ran under, and every canUseTool answer in the ledger, each tagged with its query() ordinal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-sim-ledger-'))
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    const ledger = path.join(dir, 'ledger.jsonl')
    const decision = { behavior: 'allow', updatedInput: { command: 'ls -la' } }
    const s = await open({
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      canUseTool: async () => decision,
    }, { ...program([{ on: 'msg:prompt', match: { text: 'ask' }, emit: [{ kind: 'approval', data: { tool: 'Bash', input: { command: 'ls' } } }] }]), FRESHELL_CLAUDE_SIM_LEDGER: ledger })
    s.prompt.push('first', '44444444-4444-4444-8444-444444444444')
    await s.until(() => results(s.messages).length === 1)
    await s.q.applyFlagSettings({ effortLevel: 'max' })
    await s.q.setModel('sonnet')
    s.prompt.push('ask')
    await s.until(() => results(s.messages).length === 2)
    const rows = (await fs.readFile(ledger, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const sessionId = results(s.messages)[0].session_id
    const query = rows[0].query
    expect(rows[0]).toMatchObject({ kind: 'query', query: expect.any(Number) })
    expect(rows.every((row) => row.query === query)).toBe(true)
    expect(rows.find((row) => row.kind === 'boot')).toMatchObject({ sessionId, cliPid: expect.any(Number) })
    expect(rows.filter((row) => row.kind === 'prompt')).toEqual([
      expect.objectContaining({ sessionId, uuid: '44444444-4444-4444-8444-444444444444', text: 'first', content: [{ type: 'text', text: 'first' }], model: 'opus', effort: 'high', permissionMode: 'default' }),
      expect.objectContaining({ sessionId, uuid: null, text: 'ask', model: 'sonnet', effort: 'max', permissionMode: 'default' }),
    ])
    expect(rows.filter((row) => row.kind === 'can_use_tool')).toEqual([
      expect.objectContaining({ toolName: 'Bash', toolUseID: expect.stringMatching(/^toolu_/), decision }),
    ])
  })

  it('a program chooses the tool_use id the model gives a tool call and the whole input of an AskUserQuestion call', async () => {
    const seen: any[] = []
    const s = await open({
      permissionMode: 'default',
      canUseTool: async (toolName: string, toolInput: any, options: any) => {
        seen.push({ toolName, toolInput, toolUseID: options.toolUseID })
        return toolName === 'AskUserQuestion'
          ? { behavior: 'allow', updatedInput: { ...toolInput, answers: { 'Pick one': 'A' } } }
          : { behavior: 'allow', updatedInput: toolInput }
      },
    }, program([{
      on: 'msg:prompt',
      emit: [
        { kind: 'approval', data: { id: 'toolu_fake_1', tool: 'Bash', input: { command: 'ls' } } },
        { kind: 'question', data: { id: 'toolu_fake_2', input: { questions: [{ question: 'Pick one', header: 'Choice', options: [{ label: 'A', description: 'a' }], multiSelect: false }], marker: 'keep-me' } } },
      ],
    }]))
    s.prompt.push('go')
    await s.until(() => results(s.messages).length === 1)
    expect(seen).toEqual([
      { toolName: 'Bash', toolInput: { command: 'ls' }, toolUseID: 'toolu_fake_1' },
      { toolName: 'AskUserQuestion', toolInput: { questions: [expect.objectContaining({ question: 'Pick one' })], marker: 'keep-me' }, toolUseID: 'toolu_fake_2' },
    ])
    const toolUses = s.messages.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content).filter((b: any) => b.type === 'tool_use')
    expect(toolUses.map((b: any) => b.id)).toEqual(['toolu_fake_1', 'toolu_fake_2'])
  })
})

describe('the real sidecar over the simulator (FRESHELL_CLAUDE_SDK_QUERY_MODULE)', () => {
  const children: ChildProcess[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
  })

  async function startSidecar(env: Record<string, string> = {}) {
    const home = await tempHome()
    const child = spawn(process.execPath, [SIDECAR], {
      cwd: home.cwd,
      env: { ...home.env, FRESHELL_CLAUDE_SDK_QUERY_MODULE: SIM, FRESHELL_CLAUDE_SIM_TIME_SCALE: '0.1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    const frames: any[] = []
    const waiters = new Set<() => void>()
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      frames.push(JSON.parse(line))
      for (const waiter of [...waiters]) waiter()
    })
    const until = (predicate: () => boolean, ms = 10_000) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(check)
        resolve(false)
      }, ms)
      const check = () => {
        if (!predicate()) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve(true)
      }
      waiters.add(check)
      check()
    })
    const send = (message: unknown) => child.stdin!.write(`${JSON.stringify(message)}\n`)
    return { home, frames, until, send }
  }

  it('creates a session, runs a turn and reports its result through the unchanged sidecar protocol', async () => {
    const { home, frames, until, send } = await startSidecar()
    send({ type: 'create', requestId: 'r1', cwd: home.cwd, permissionMode: 'bypassPermissions' })
    expect(await until(() => frames.some((f) => f.type === 'created'))).toBe(true)
    const sessionId = frames.find((f) => f.type === 'created').sessionId
    send({ type: 'send', sessionId, text: 'hello' })
    expect(await until(() => frames.some((f) => f.type === 'sdk.turn.complete'))).toBe(true)
    expect(frames.find((f) => f.type === 'sdk.session.init')).toMatchObject({ sessionId, cliSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(frames.find((f) => f.type === 'sdk.result')).toMatchObject({ sessionId, result: 'success' })
    expect(frames.find((f) => f.type === 'sdk.assistant')?.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('FRESHELL_CLAUDE_SIM_STALL_STDIN makes the sidecar stop reading its stdin once the CLI has booted', async () => {
    for (const [stall, readsLaterLines] of [[undefined, true], ['boot', false]] as const) {
      const { home, frames, until, send } = await startSidecar(stall ? { FRESHELL_CLAUDE_SIM_STALL_STDIN: stall } : {})
      send({ type: 'create', requestId: 'r1', cwd: home.cwd, permissionMode: 'bypassPermissions' })
      expect(await until(() => frames.some((f) => f.type === 'created'))).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      send({ type: 'create', requestId: 'r2', cwd: home.cwd, permissionMode: 'bypassPermissions' })
      expect(await until(() => frames.some((f) => f.type === 'created' && f.requestId === 'r2'), 1500), `stall=${stall}`).toBe(readsLaterLines)
    }
  })
})
