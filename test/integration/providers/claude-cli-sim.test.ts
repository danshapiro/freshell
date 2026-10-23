// @vitest-environment node
//
// The CLI simulator's own features that have no real-CLI counterpart to
// compare against: scenario programs (FRESHELL_CLAUDE_SIM_PROGRAM and its
// aliases), the options ledger, and the sidecar seam it plugs into; plus what
// a normalized trace cannot see (nothing reaches the disk after the stream
// ends). The behavior it shares with the real CLI is covered by
// claude-cli-conformance.ts.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../fixtures/claude-cli-sim/query.mjs'
import { dropsTurnRefusal } from '../../fixtures/claude-cli-sim/transcript.mjs'
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

describe('Claude CLI simulator ids a normalized trace cannot see', () => {
  it('each assistant message carries the API message id of the message_start it was streamed under, as on the real CLI (F2)', async () => {
    const s = await open({ includePartialMessages: true }, { FRESHELL_CLAUDE_SIM_TIME_SCALE: '0.1' })
    s.prompt.push('TOOL:sleep=0')
    await s.until(() => results(s.messages).length === 1)
    s.prompt.push('SLOW')
    await s.until(() => results(s.messages).length === 2)
    const pairs: Array<[string, string]> = []
    let streaming: string | undefined
    for (const m of s.messages) {
      if (m.type === 'stream_event' && m.event.type === 'message_start') streaming = m.event.message.id
      if (m.type === 'assistant' && m.parent_tool_use_id === null) pairs.push([streaming!, m.message.id])
    }
    // The tool call, its follow-up reply and the slow reply: three messages, three ids.
    expect(pairs).toHaveLength(3)
    for (const [started, assistant] of pairs) expect(assistant).toBe(started)
    expect(new Set(pairs.map(([id]) => id)).size).toBe(3)
  })
})

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

  it('an MCP tool step calls the session\'s stdio server, and a text step can repeat what it returned', async () => {
    const probe = path.join(REPO_ROOT, 'test/integration/providers/claude-freshell-mcp-probe-server.mjs')
    const program = { rules: [{ on: 'msg:prompt', match: { text: 'what did the server see' }, emit: [
      { kind: 'tool', data: { name: 'mcp__freshell__context', input: {} } },
      { kind: 'text', data: { text: 'The server saw: ', echoToolResult: true } },
    ] }] }
    const s = await open(
      { mcpServers: { freshell: { type: 'stdio', command: process.execPath, args: [probe] } } },
      { FRESHELL_CLAUDE_SIM_PROGRAM: JSON.stringify(program), FRESHELL: '1', FRESHELL_TAB_ID: 'tab-p', FRESHELL_PANE_ID: 'pane-p' },
    )
    s.prompt.push('what did the server see')
    await s.until(() => results(s.messages).length === 1)
    const reply = s.messages.filter((m) => m.type === 'assistant').at(-1).message.content[0].text as string
    expect(reply.startsWith('The server saw: ')).toBe(true)
    expect(JSON.parse(reply.slice('The server saw: '.length))).toMatchObject({ FRESHELL: '1', FRESHELL_TAB_ID: 'tab-p', FRESHELL_PANE_ID: 'pane-p' })
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

  // T13 after the boot: a command the CLI is still starting is missed by a
  // Stop, in each receipt shape the real CLI shows (the order of the receipt
  // and the command's lifecycle is racy there; the knob makes each shape
  // deterministic). The command then runs to success, unless an interrupt
  // sent once it runs aborts it.
  it.each([
    ['empty', [], [], []],
    ['queued', ['55555555-5555-4555-8555-555555555555'], ['queued'], ['queued']],
    ['started', [], [], ['queued', 'started']],
  ] as const)('FRESHELL_CLAUDE_SIM_COLD_COMMAND=%s: a Stop while the first command starts misses it with that receipt', async (shape, stillQueued, beforeStop, beforeReceipt) => {
    const uuid = '55555555-5555-4555-8555-555555555555'
    const s = await open({}, { FRESHELL_CLAUDE_SIM_COLD_COMMAND: shape, FRESHELL_CLAUDE_SIM_TIME_SCALE: '0.1' })
    await s.q.initializationResult()
    const lifecycle = () => s.messages.filter((m) => m.type === 'command_lifecycle' && m.command_uuid === uuid).map((m) => m.state)
    s.prompt.push('SLOW cold', uuid)
    // The command is still starting, at the point each shape names.
    if (beforeStop.length) await s.until(() => lifecycle().length === beforeStop.length)
    else await new Promise((resolve) => setTimeout(resolve, 20))
    expect(lifecycle(), 'the command lifecycle the CLI reported before the Stop').toEqual(beforeStop)
    const receipt = await s.q.interrupt()
    expect(lifecycle(), 'the command lifecycle the CLI reported before its receipt').toEqual(beforeReceipt)
    expect(receipt).toEqual({ still_queued: stillQueued })
    await s.until(() => results(s.messages).length === 1)
    expect(results(s.messages)[0]).toMatchObject({ subtype: 'success', terminal_reason: 'completed' })
    await s.until(() => lifecycle().at(-1) === 'completed')
    expect(lifecycle()).toEqual(['queued', 'started', 'completed'])

    // Only the first command starts cold: a Stop once the next one runs aborts it.
    s.prompt.push('SLOW warm', '66666666-6666-4666-8666-666666666666')
    await s.until(() => s.messages.some((m) => m.type === 'stream_event' || (m.type === 'user' && m.isReplay && m.uuid === '66666666-6666-4666-8666-666666666666')))
    await s.q.interrupt()
    await s.until(() => results(s.messages).length === 2)
    expect(results(s.messages)[1]).toMatchObject({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' })
  })

  it('FRESHELL_CLAUDE_SIM_COLD_COMMAND: an interrupt sent once the cold command runs aborts it', async () => {
    const uuid = '77777777-7777-4777-8777-777777777777'
    const s = await open({}, { FRESHELL_CLAUDE_SIM_COLD_COMMAND: 'empty', FRESHELL_CLAUDE_SIM_TIME_SCALE: '0.1' })
    await s.q.initializationResult()
    s.prompt.push('SLOW cold', uuid)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(s.q.interrupt()).resolves.toEqual({ still_queued: [] })
    await s.until(() => s.messages.some((m) => m.type === 'command_lifecycle' && m.command_uuid === uuid && m.state === 'started'))
    await s.q.interrupt()
    await s.until(() => results(s.messages).length === 1)
    expect(results(s.messages)[0]).toMatchObject({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' })
  })

  it('records every interrupt the CLI receives in the ledger, with the receipt it answered', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-sim-ledger-'))
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    const ledger = path.join(dir, 'ledger.jsonl')
    const s = await open({}, { FRESHELL_CLAUDE_SIM_LEDGER: ledger, FRESHELL_CLAUDE_SIM_TIME_SCALE: '0.1' })
    await s.q.initializationResult()
    await s.q.interrupt()
    const rows = (await fs.readFile(ledger, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(rows.filter((row) => row.kind === 'interrupt')).toEqual([
      expect.objectContaining({ kind: 'interrupt', stillQueued: [], running: false }),
    ])
  })

  it('a /compact whose summary request hangs (HANG in its instructions) stays compacting with no result', async () => {
    // The marker reaches the compaction's summary request the way APIERR does
    // on the real CLI (T15 scenario `compact`), so the local provider's HANG
    // mode would leave the real CLI compacting too. Only a CLI death ends it.
    const s = await open({}, { FRESHELL_CLAUDE_SIM_TIME_SCALE: '0.1' })
    s.prompt.push('something to compact')
    await s.until(() => results(s.messages).length === 1)
    s.prompt.push('/compact HANG', '33333333-3333-4333-8333-333333333333')
    await s.until(() => s.messages.some((m) => m.type === 'system' && m.subtype === 'status' && m.status === 'compacting'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const statuses = s.messages.filter((m) => m.type === 'system' && m.subtype === 'status').map((m) => m.status)
    expect(statuses.at(-1), 'the compaction is still in progress').toBe('compacting')
    expect(results(s.messages), 'the hung compaction has no result').toHaveLength(1)
    expect(s.ended).toBeNull()
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

  it('records every settings call the CLI handles in the ledger, in order, including a refused one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-sim-ledger-'))
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    const ledger = path.join(dir, 'ledger.jsonl')
    const s = await open({ permissionMode: 'default' }, { FRESHELL_CLAUDE_SIM_LEDGER: ledger })
    await s.q.initializationResult()
    await s.q.setPermissionMode('plan')
    await s.q.setModel('opus')
    await s.q.applyFlagSettings({ effortLevel: 'low' })
    await expect(s.q.setPermissionMode('no-such-mode')).rejects.toThrow()
    const rows = (await fs.readFile(ledger, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(rows.filter((row) => row.kind === 'control').map(({ name, args }) => ({ name, args }))).toEqual([
      { name: 'setPermissionMode', args: ['plan'] },
      { name: 'setModel', args: ['opus'] },
      { name: 'applyFlagSettings', args: [{ effortLevel: 'low' }] },
      { name: 'setPermissionMode', args: ['no-such-mode'] },
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

  it('a tool step with inputStreamMs streams the model\'s tool input in pieces for that long before the call completes', async () => {
    const input = { file_path: '/workspace/notes.md', content: 'a long file\n'.repeat(40) }
    const s = await open({ includePartialMessages: true }, {
      ...program([{ on: 'msg:prompt', emit: [{ kind: 'tool', data: { name: 'Write', input, inputStreamMs: 800 } }] }]),
      FRESHELL_CLAUDE_SIM_TIME_SCALE: '1',
    })
    const receivedAt = new Map<any, number>()
    const done = s.until(() => {
      for (const message of s.messages) if (!receivedAt.has(message)) receivedAt.set(message, Date.now())
      return results(s.messages).length === 1
    })
    s.prompt.push('write the notes')
    await done

    const events = s.messages.filter((m) => m.type === 'stream_event').map((m) => m.event)
    const start = s.messages.find((m) => m.type === 'stream_event' && m.event.type === 'content_block_start' && m.event.content_block?.type === 'tool_use')
    const call = s.messages.find((m) => m.type === 'assistant' && m.message.content.some((b: any) => b.type === 'tool_use'))
    expect(start.event.content_block).toMatchObject({ name: 'Write', input: {} })
    const pieces = events.filter((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta').map((e) => e.delta.partial_json)
    expect(pieces.length).toBeGreaterThan(1)
    expect(JSON.parse(pieces.join(''))).toEqual(input)
    expect(call.message.content.find((b: any) => b.type === 'tool_use').input).toEqual(input)
    // The block started well before the model finished the call.
    expect(receivedAt.get(call)! - receivedAt.get(start)!).toBeGreaterThanOrEqual(700)
    expect(results(s.messages)[0]).toMatchObject({ subtype: 'success', is_error: false })
  })
})

describe('Claude CLI simulator api_retry steps', () => {
  it('each failed attempt is one system/api_retry with the SDK\'s fields, before the reply streams; the turn then succeeds', async () => {
    const s = await open({ includePartialMessages: true }, program([{ on: 'msg:prompt', emit: [{ kind: 'api_retry', data: { status: 529, attempts: 2 } }, { kind: 'text', data: { text: 'recovered' } }] }]))
    s.prompt.push('try')
    await s.until(() => results(s.messages).length === 1)
    const retries = s.messages.filter((m) => m.type === 'system' && m.subtype === 'api_retry')
    // SDKAPIRetryMessage (sdk.d.ts) and F11: attempt, max_retries, retry_delay_ms, error_status, error.
    expect(retries.map((m) => Object.keys(m).sort())).toEqual(Array(2).fill(['attempt', 'error', 'error_status', 'max_retries', 'retry_delay_ms', 'session_id', 'subtype', 'type', 'uuid']))
    expect(retries.map((m) => [m.attempt, m.max_retries, m.error_status, m.error])).toEqual([[1, 10, 529, 'overloaded'], [2, 10, 529, 'overloaded']])
    expect(retries[1].retry_delay_ms).toBeGreaterThan(retries[0].retry_delay_ms)
    const firstStream = s.messages.findIndex((m) => m.type === 'stream_event')
    expect(s.messages.indexOf(retries[1])).toBeLessThan(firstStream)
    expect(results(s.messages)[0]).toMatchObject({ subtype: 'success', is_error: false, result: 'recovered' })
  })
})

const TOOLS_SYNC = path.join(REPO_ROOT, 'test/fixtures/fresh-agent/claude/real-cli-2.1.237/tools-sync')
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

const jsonlFile = async (file: string) => (await fs.readFile(file, 'utf8')).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))

/** A recorded or replayed value with its ids and the session's paths masked, for comparison. */
function masked(value: unknown, home?: { cwd: string, env: { CLAUDE_CONFIG_DIR: string } }): unknown {
  let text = JSON.stringify(value)
  if (home) {
    const inJson = (p: string) => JSON.stringify(p).slice(1, -1)
    text = text.split(inJson(home.env.CLAUDE_CONFIG_DIR)).join('/fixture/home/.claude').split(inJson(home.cwd)).join('/fixture/ws')
      // The CLI's project slug of the workspace (transcript.mjs projectSlug).
      .split(home.cwd.replace(/[^A-Za-z0-9]/g, '-')).join('-fixture-ws')
  }
  return JSON.parse(text
    .replace(UUID_TEXT, 'UUID')
    .replace(/\b(toolu|msg)_[A-Za-z0-9]+/g, '$1_ID')
    .replace(/\ba[0-9a-f]{16}\b/g, 'AGENT_ID'))
}

/** The model's side of the first turn: the messages after its prompt replay, up to its result. */
function modelSide(messages: any[]) {
  const prompt = messages.findIndex((m) => m.type === 'user' && m.isReplay === true && !m.parent_tool_use_id)
  const result = messages.findIndex((m, index) => index > prompt && m.type === 'result')
  return messages.slice(prompt + 1, result)
}

async function transcriptOf(home: { env: { CLAUDE_CONFIG_DIR: string } }) {
  const tree = await snapshotTree(path.join(home.env.CLAUDE_CONFIG_DIR, 'projects'))
  const main = Object.keys(tree).find((file) => file.endsWith('.jsonl') && !file.includes('/subagents/'))
  return { tree, main }
}

describe('Claude CLI simulator replay of a recorded real-CLI turn', () => {
  it('replays the recording\'s messages, transcript lines and subagent files, under fresh ids and the session\'s paths', async () => {
    const recorded = (await jsonlFile(path.join(TOOLS_SYNC, 'sdk.jsonl'))).map((row) => row.msg)
    const s = await open({ includePartialMessages: true }, program([{ on: 'msg:prompt', emit: [{ kind: 'replay', data: { recording: 'tools-sync' } }] }]))
    s.prompt.push('GO write then edit then delegate')
    await s.until(() => results(s.messages).length === 1)

    const replayed = modelSide(s.messages)
    expect(replayed.map((m) => masked(m, s.home))).toEqual(modelSide(recorded).map((m) => masked(m)))
    // Fresh ids: none of the recording's, and as many distinct ones.
    const uuidsOf = (value: unknown) => new Set(JSON.stringify(value).match(UUID_TEXT))
    const recordedUuids = uuidsOf(modelSide(recorded))
    const replayedUuids = uuidsOf(replayed)
    expect([...replayedUuids].filter((id) => recordedUuids.has(id))).toEqual([])
    expect(replayedUuids.size).toBe(recordedUuids.size)
    expect(replayed.every((m) => m.session_id === s.messages[0].session_id)).toBe(true)
    expect(results(s.messages)[0]).toMatchObject({ subtype: 'success', result: 'All done.' })

    // Every persisted message's line lands in the session's transcript, in the
    // recorded order, after the simulator's own prompt lines.
    const persisted = replayed.filter((m) => m.uuid && m.type !== 'stream_event' && (m.type === 'assistant' || m.type === 'user'))
    let tree: Record<string, string> = {}
    let main: string | undefined
    for (let i = 0; i < 100; i += 1) {
      ({ tree, main } = await transcriptOf(s.home))
      const text = main ? tree[main] : ''
      if (persisted.filter((m) => !m.parent_tool_use_id).every((m) => text.includes(m.uuid))) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const lines = tree[main!].split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const firstReplayed = lines.findIndex((line) => line.uuid === persisted[0].uuid)
    expect(firstReplayed).toBeGreaterThan(0)
    const recordedLines = (await jsonlFile(path.join(TOOLS_SYNC, 'session.jsonl')))
    const recordedFirst = recordedLines.findIndex((line) => line.uuid && modelSide(recorded).some((m) => m.uuid === line.uuid))
    expect(lines.slice(firstReplayed).map((line) => masked(line, s.home)))
      .toEqual(recordedLines.slice(recordedFirst).filter((line) => line.type !== 'last-prompt').map((line) => masked(line)))
    // The replayed lines continue the session's own chain.
    expect(lines[firstReplayed].parentUuid).toBe(lines.slice(0, firstReplayed).filter((line) => line.uuid).at(-1).uuid)

    // The subagent's transcript and meta file, next to the session's transcript.
    const sessionDir = main!.replace(/\.jsonl$/, '')
    const subagentFiles = Object.keys(tree).filter((file) => file.startsWith(`${sessionDir}/subagents/`)).sort()
    expect(subagentFiles.map((file) => path.basename(file).replace(/a[0-9a-f]{16}/, 'AGENT_ID'))).toEqual(['agent-AGENT_ID.jsonl', 'agent-AGENT_ID.meta.json'])
    const agentCall = replayed.flatMap((m) => (m.type === 'assistant' ? m.message.content : [])).find((block: any) => block.type === 'tool_use' && block.name === 'Agent')
    const meta = JSON.parse(tree[subagentFiles[1]])
    expect(meta.toolUseId).toBe(agentCall.id)
    const recordedSubagent = path.join(TOOLS_SYNC, 'session/subagents/agent-a2645ac0e225b257e')
    expect(masked(meta)).toEqual(masked(JSON.parse(await fs.readFile(`${recordedSubagent}.meta.json`, 'utf8'))))
    expect(tree[subagentFiles[0]].split('\n').filter(Boolean).map((line) => masked(JSON.parse(line), s.home)))
      .toEqual((await jsonlFile(`${recordedSubagent}.jsonl`)).map((line) => masked(line)))
  })

  it('a hold keeps the turn before that recorded message: the subagent\'s tool call is on disk and still running', async () => {
    const SUBAGENT_TOOL_RESULT = '1ee90712-3476-4188-b310-22a881bf6e20'
    const s = await open({ includePartialMessages: true }, { ...program([{ on: 'msg:prompt', emit: [{ kind: 'replay', data: { recording: 'tools-sync', holdBeforeMs: { [SUBAGENT_TOOL_RESULT]: 3000 } } }] }]), FRESHELL_CLAUDE_SIM_TIME_SCALE: '1' })
    s.prompt.push('GO')
    const subagentToolCall = () => s.messages.find((m) => m.type === 'assistant' && m.parent_tool_use_id && m.message.content.some((b: any) => b.type === 'tool_use'))
    await s.until(() => Boolean(subagentToolCall()))
    const subagentFile = async () => {
      const { tree } = await transcriptOf(s.home)
      const file = Object.keys(tree).find((name) => name.includes('/subagents/') && name.endsWith('.jsonl'))
      return file ? tree[file].split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
    }
    let lines: any[] = []
    for (let i = 0; i < 100 && !lines.some((line) => line.uuid === subagentToolCall().uuid); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      lines = await subagentFile()
    }
    expect(lines.some((line) => line.uuid === subagentToolCall().uuid)).toBe(true)
    const isToolResult = (line: any) => Array.isArray(line.message?.content) && line.message.content.some((b: any) => b.type === 'tool_result')
    expect(lines.filter(isToolResult)).toEqual([])
    expect(results(s.messages)).toEqual([])

    await s.until(() => results(s.messages).length === 1, 10_000)
    for (let i = 0; i < 100 && !(await subagentFile()).some(isToolResult); i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await subagentFile()).filter(isToolResult)).toHaveLength(1)
  })

  it('with `workspace`, each recorded Write and Edit changes the session\'s files before the CLI reports its result; without it, none', async () => {
    const replayWith = (data: Record<string, unknown>) => program([{ on: 'msg:prompt', emit: [{ kind: 'replay', data: { recording: 'tools-sync', ...data } }] }])
    const s = await open({ includePartialMessages: false }, replayWith({ workspace: true }))
    // What the workspace held at the moment each tool result was reported.
    const seen: Array<{ tool: string, a: string | null, b: string | null }> = []
    const read = (name: string) => {
      try { return readFileSync(path.join(s.home.cwd, name), 'utf8') } catch { return null }
    }
    const toolNames = new Map<string, string>()
    const record = () => {
      const message = s.messages.at(-1)
      if (message?.type === 'assistant') {
        for (const block of message.message.content) if (block.type === 'tool_use') toolNames.set(block.id, block.name)
      }
      if (message?.type !== 'user' || message.parent_tool_use_id) return
      const result = Array.isArray(message.message.content) ? message.message.content.find((b: any) => b.type === 'tool_result') : undefined
      if (result) seen.push({ tool: toolNames.get(result.tool_use_id) ?? 'unknown', a: read('a.txt'), b: read('b.txt') })
    }
    const done = s.until(() => {
      record()
      return results(s.messages).length === 1
    })
    s.prompt.push('GO write then edit then delegate')
    await done

    expect(seen.map((row) => row.tool)).toEqual(['Write', 'Edit', 'Edit', 'Read', 'Edit', 'Agent'])
    // Write created a.txt; the first Edit changed it; the failed Edit changed nothing.
    expect(seen[0]).toMatchObject({ a: 'one\n', b: null })
    expect(seen[1]).toMatchObject({ a: 'two\n', b: null })
    expect(seen[2]).toMatchObject({ a: 'two\n', b: null })
    // The Edit of b.txt writes the file the recording read, edited.
    expect(seen[4]).toMatchObject({ a: 'two\n', b: 'alpha\nbeta\ngamma\n' })

    const plain = await open({ includePartialMessages: false }, replayWith({}))
    plain.prompt.push('GO write then edit then delegate')
    await plain.until(() => results(plain.messages).length === 1)
    expect(await fs.readdir(plain.home.cwd)).toEqual([])
  })
})

// The simulator's port of the CLI's --resume-drops-turn validator. The
// absorbed-send refusal is compared with the real CLI (absorbed-undo in
// claude-cli-conformance.ts); these pin the other ranges a rollback relies on.
describe('the drops-turn guard port', () => {
  const U = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
  const prompt = (uuid: string, text = 'hi') => ({ type: 'user', uuid, message: { role: 'user', content: text }, promptSource: 'sdk' })
  const reply = (uuid: string) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
  const tokens = (uuid: string) => ({ type: 'attachment', uuid, attachment: { type: 'total_tokens_reminder' } })

  it('accepts a range that is the declared turn alone, its furniture included', () => {
    expect(dropsTurnRefusal([prompt(U(1)), tokens(U(2)), reply(U(3))], U(1))).toBeNull()
  })

  it('refuses a range holding a second prompt: one guard declares one turn', () => {
    expect(dropsTurnRefusal([prompt(U(1)), reply(U(2)), prompt(U(3)), reply(U(4))], U(1)))
      .toBe(`range contains a user entry not attributable to the declared turn; entry 2 [type=user, uuid=${U(3)}]`)
  })

  it('refuses a range holding a task notification (an externally-sourced user entry)', () => {
    const notification = { ...prompt(U(3), '<task-notification>done</task-notification>'), origin: { kind: 'task-notification' } }
    expect(dropsTurnRefusal([prompt(U(1)), reply(U(2)), notification, reply(U(4))], U(1)))
      .toBe(`range contains an externally-sourced user entry; entry 2 [type=user, uuid=${U(3)}]`)
  })

  it('refuses a range that does not start with the declared prompt', () => {
    expect(dropsTurnRefusal([reply(U(2)), prompt(U(1))], U(1)))
      .toBe(`range does not start with the declared turn prompt; first discarded entry 0 [type=assistant, uuid=${U(2)}]`)
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

  it('creates a session, runs a turn and reports its result through the sidecar protocol', async () => {
    const { home, frames, until, send } = await startSidecar()
    send({ type: 'create', protocol: 2, boot: { kind: 'fresh' }, requestId: 'r1', cwd: home.cwd, permissionMode: 'bypassPermissions' })
    expect(await until(() => frames.some((f) => f.type === 'created'))).toBe(true)
    const sessionId = frames.find((f) => f.type === 'created').sessionId
    send({ type: 'send', sessionId, uuid: randomUUID(), text: 'hello' })
    expect(await until(() => frames.some((f) => f.type === 'sdk.result' && f.subtype === 'success'))).toBe(true)
    expect(frames.find((f) => f.type === 'sdk.session.init')).toMatchObject({ sessionId, cliSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(frames.find((f) => f.type === 'sdk.result')).toMatchObject({ sessionId, result: 'success' })
    expect(frames.find((f) => f.type === 'sdk.assistant')?.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('FRESHELL_CLAUDE_SIM_STALL_STDIN makes the sidecar stop reading its stdin once the CLI has booted', async () => {
    for (const [stall, readsLaterLines] of [[undefined, true], ['boot', false]] as const) {
      const { home, frames, until, send } = await startSidecar(stall ? { FRESHELL_CLAUDE_SIM_STALL_STDIN: stall } : {})
      send({ type: 'create', protocol: 2, boot: { kind: 'fresh' }, requestId: 'r1', cwd: home.cwd, permissionMode: 'bypassPermissions' })
      expect(await until(() => frames.some((f) => f.type === 'created'))).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      send({ type: 'create', protocol: 2, boot: { kind: 'fresh' }, requestId: 'r2', cwd: home.cwd, permissionMode: 'bypassPermissions' })
      // One sidecar hosts one session, so a reading sidecar refuses the second
      // create; any answer at all shows it read the line.
      expect(await until(() => frames.some((f) => (f.type === 'created' || f.type === 'create.failed') && f.requestId === 'r2'), 1500), `stall=${stall}`).toBe(readsLaterLines)
    }
  })
})
