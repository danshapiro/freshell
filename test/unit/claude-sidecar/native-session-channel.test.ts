import { nativeProtocolRequest } from './native-protocol.js'
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createNativeSessionChannel, inspectNativeDeferredCheckpoint } from '../../../crates/freshell-claude-sidecar/native-session-channel.mjs'
import { stageSdkInitFieldFault } from '../../../scripts/testing/runtime-native-feasibility.js'

const root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const launch = { incarnationId: 'current-incarnation', launchNonce: 'current-nonce', evidenceRevision: 3, executionGeneration: 4, requestedNativeSessionId: root }
const native = { hook_event_name: 'SessionStart', session_id: root, source: 'resume', cwd: '/owned', transcript_path: '/owned/native.jsonl' }
async function withChannel(run: (channel: any) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'native-channel-test-'))
  try { await run(await createNativeSessionChannel({ launch, directory, timeoutMs: 100 })) }
  finally { await rm(directory, { recursive: true, force: true }) }
}
async function hook(channel: any, input = native) {
  const child = spawn(process.execPath, [resolve('crates/freshell-claude-sidecar/native-session-channel.mjs')], { env: { ...process.env, ...channel.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  child.stdin.end(JSON.stringify(input))
  expect(await exited).toBe(0)
}
function checkpointSidecar(directory: string, nativeRequestId = 'native-current', delayedTranscript = false, delayedNativeExit = false, providerHome = directory, eagerResume = false, eagerCallbackOnly = false, splitBatch: boolean | 'incomplete' = false) {
  const child = spawn(process.execPath, [resolve('crates/freshell-claude-sidecar/index.mjs')], {
    env: { ...process.env, HOME: providerHome, FRESHELL_SIDECAR_TEST_CHECKPOINT: '1',
      FRESHELL_SIDECAR_TEST_NATIVE_REQUEST_ID: nativeRequestId,
      FRESHELL_SIDECAR_TEST_DEFERRED_TRANSCRIPT_DELAY: delayedTranscript ? '1' : '0',
      FRESHELL_SIDECAR_TEST_NATIVE_EXIT_DELAY: delayedNativeExit ? '1' : '0',
      FRESHELL_SIDECAR_TEST_CHECKPOINT_EAGER_RESUME: eagerResume ? '1' : '0',
      FRESHELL_SIDECAR_TEST_CHECKPOINT_EAGER_CALLBACK_ONLY: eagerCallbackOnly ? '1' : '0',
      FRESHELL_SIDECAR_TEST_SPLIT_BATCH: splitBatch === 'incomplete' ? splitBatch : splitBatch ? '1' : '0',
      FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(launch),
      FRESHELL_CLAUDE_SDK_QUERY_MODULE: resolve('test/unit/claude-sidecar/fixtures/native-startup-query.mjs') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames: any[] = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const boundary = buffer.indexOf('\n')
      frames.push(JSON.parse(buffer.slice(0, boundary)))
      buffer = buffer.slice(boundary + 1)
    }
  })
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()) })
  const send = (value: unknown) => child.stdin.write(JSON.stringify(nativeProtocolRequest(value)) + '\n')
  return { frames, send,
    wait: async (type: string) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const frame = frames.find((frame) => frame.type === type)
        if (frame) return frame
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`missing ${type}: ${JSON.stringify(frames)}`)
    },
    close: async (awaitNativeShutdown = false) => {
      // A refused v2 boot has already closed its input and is flushing its
      // final frame; the OS exit notification may arrive a moment later.
      if (child.exitCode === null && !frames.some(frame => frame.type === 'create.failed' || frame.type === 'sdk.stream.ended')) {
        send({ type: 'shutdown', awaitNativeShutdown })
      }
      await exited
    },
  }
}
describe('managed native startup channel', () => {
  it('joins the old native writer before acknowledging managed rollback shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-rollback-shutdown-'))
    const worker = checkpointSidecar(directory, 'current', false, true)
    try {
      worker.send({ type: 'create', requestId: 'join-native-writer', cwd: directory })
      await worker.wait('sdk.session.init')
      await worker.wait('probe.native-child')
      const before = Date.now()
      await worker.close(true)
      expect(Date.now() - before).toBeGreaterThanOrEqual(100)
    } finally { await worker.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it('reopens the same acknowledged unmaterialized child from its guarded parent before accepting input', async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-parent-backed-'))
    const directory = join(home, '.claude/projects/work')
    await mkdir(directory, { recursive: true })
    const parent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const cutoff = '11111111-1111-4111-8111-111111111111'
    const dropped = '22222222-2222-4222-8222-222222222222'
    const source = JSON.stringify({ type: 'user', sessionId: parent, uuid: cutoff, parentUuid: null,
      message: { content: 'retained parent input' } }) + '\n' + JSON.stringify({ type: 'user', sessionId: parent,
      uuid: dropped, parentUuid: cutoff, message: { content: 'undone input' } }) + '\n'
    await writeFile(join(directory, parent + '.jsonl'), source)
    const recipe = { childSessionId: root, parentSessionId: parent,
      parentTranscript: '.claude/projects/work/' + parent + '.jsonl', childTranscript: '.claude/projects/work/' + root + '.jsonl',
      parentSha256: createHash('sha256').update(source).digest('hex'), target: { kind: 'prefix', cutoffUuid: cutoff, dropTurnUuid: dropped } }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const worker = checkpointSidecar(directory, 'native-current', false, false, home)
        try {
          worker.send({ type: 'create', requestId: 'reopen-parent-' + attempt, cwd: directory, resumeSessionId: root,
            nativeForkRecipe: recipe, permissionMode: 'default' })
          const observed = await worker.wait('sdk.session.init')
          expect(observed.cliSessionId).toBe(root)
          expect(observed.nativeIdentityEvidence.source).toBe('fork')
          expect(worker.frames.some(frame => frame.type === 'probe.native-input')).toBe(false)
          await expect(readFile(join(directory, root + '.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally { await worker.close() }
      }
      expect(await readFile(join(directory, parent + '.jsonl'), 'utf8')).toBe(source)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
  it('observes an authorized first-turn Undo as a new empty native startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-reroot-empty-'))
    const sidecar = checkpointSidecar(directory)
    try {
      sidecar.send({ type: 'create', requestId: 'empty-rollback', cwd: directory, model: 'empty-rollback-native',
        nativeIdentityTransition: { parentNativeSessionId: root,
          launch: { ...launch, evidenceRevision: launch.evidenceRevision + 1, requestedNativeSessionId: null } } })
      const observed = await sidecar.wait('sdk.session.init')
      expect(observed.cliSessionId).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
      expect(observed.nativeIdentityEvidence.source).toBe('startup')
      expect(sidecar.frames.some(frame => frame.type === 'probe.native-input')).toBe(false)
    } finally { await sidecar.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it('admits an authorized native rollback child while preserving ordinary exact-resume refusal', async () => {
    for (const authorized of [true, false]) {
      const directory = await mkdtemp(join(tmpdir(), 'native-reroot-'))
      const sidecar = checkpointSidecar(directory)
      try {
        sidecar.send({ type: 'create', requestId: 'rollback-owned', cwd: directory,
          resumeSessionId: root, resumeSessionAt: 'retained-turn', forkSession: true,
          ...(authorized ? { nativeIdentityTransition: { parentNativeSessionId: root,
            launch: { ...launch, evidenceRevision: launch.evidenceRevision + 1, requestedNativeSessionId: null } } } : {}) })
        if (authorized) {
          const observed = await sidecar.wait('sdk.session.init')
          expect(observed.cliSessionId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
          expect(observed.nativeIdentityEvidence.source).toBe('fork')
          expect(observed.nativeIdentityEvidence.launch.evidenceRevision).toBe(launch.evidenceRevision + 1)
          expect(sidecar.frames.some(frame => frame.type === 'probe.native-input')).toBe(false)
        } else {
          await sidecar.wait('sdk.error')
          expect(sidecar.frames.some(frame => frame.type === 'sdk.session.init')).toBe(false)
        }
      } finally {
        await sidecar.close()
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
  it('refuses an unsolicited native fork even when it names the requested root', async () => withChannel(async (channel) => {
    await hook(channel, { ...native, source: 'fork' })
    await expect(channel.waitReady({ initializationResult: async () => ({}) })).rejects.toThrow('unexpected native fork')
  }))
  it.each([
    ['fork-retained-parent', 'native rollback retained the retired root'],
    ['fork-without-native-ack', 'native rollback did not acknowledge a fork'],
  ])('refuses an authorized transition without actual child fork evidence (%s)', async (model, message) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-reroot-unobserved-'))
    const sidecar = checkpointSidecar(directory)
    try {
      sidecar.send({ type: 'create', requestId: 'unobserved-rollback', cwd: directory, model,
        resumeSessionId: root, resumeSessionAt: 'retained-turn', forkSession: true,
        nativeIdentityTransition: { parentNativeSessionId: root,
          launch: { ...launch, evidenceRevision: launch.evidenceRevision + 1, requestedNativeSessionId: null } } })
      expect((await sidecar.wait('sdk.error')).message).toContain(message)
      expect(sidecar.frames.some(frame => frame.type === 'sdk.session.init' || frame.type === 'probe.native-input')).toBe(false)
    } finally { await sidecar.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it.each(['incarnationId', 'launchNonce', 'executionGeneration', 'evidenceRevision', 'requestedNativeSessionId'] as const)(
    'rejects a rollback create with stale %s before opening a native query', async (field) => {
      const directory = await mkdtemp(join(tmpdir(), 'native-reroot-stale-'))
      const sidecar = checkpointSidecar(directory)
      try {
        const next: Record<string, unknown> = { ...launch, evidenceRevision: launch.evidenceRevision + 1, requestedNativeSessionId: null }
        next[field] = field === 'executionGeneration' ? 0 : field === 'evidenceRevision' ? launch.evidenceRevision : 'stale'
        sidecar.send({ type: 'create', requestId: 'stale-rollback', cwd: directory, resumeSessionId: root,
          resumeSessionAt: 'retained-turn', forkSession: true, nativeIdentityTransition: { parentNativeSessionId: root, launch: next } })
        await sidecar.wait('create.failed')
        expect(sidecar.frames.some(frame => frame.type === 'sdk.session.init' || frame.type === 'created' || frame.type === 'probe.native-input')).toBe(false)
      } finally { await sidecar.close(); await rm(directory, { recursive: true, force: true }) }
    })
  it.each(['freshclaude', 'kilroy'].flatMap(mode => ['missing-native-id', 'placeholder-id'].map(caseId => ({ mode, caseId }))))(
    'executes the production sidecar native init field fault for $mode/$caseId without input', async ({ mode, caseId }) => {
      const directory = await mkdtemp(join('/tmp', 'finite-native-init-'))
      const ownedRoot = join('/tmp/frs', randomUUID().slice(0, 12))
      const workspace = join(ownedRoot, `${mode}-${caseId}-workspace`)
      await mkdir(workspace, { recursive: true })
      const modules = (await readdir(resolve('crates/freshell-claude-sidecar'))).filter(name => name.endsWith('.mjs'))
      const producer = await readFile(resolve('crates/freshell-claude-sidecar/index.mjs'), 'utf8')
      for (const module of modules) await writeFile(join(directory, module), module === 'index.mjs'
        ? stageSdkInitFieldFault(producer) : await readFile(resolve('crates/freshell-claude-sidecar', module), 'utf8'))
      await writeFile(join(workspace, 'native-init-field-fault-control.json'), JSON.stringify({ mode, caseId }))
      const selectedLaunch = { ...launch, requestedNativeSessionId: null }
      const child = spawn(process.execPath, [join(directory, 'index.mjs')], {
        env: { ...process.env, HOME: directory, FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(selectedLaunch),
          FRESHELL_CLAUDE_SDK_QUERY_MODULE: resolve('test/unit/claude-sidecar/fixtures/native-startup-query.mjs') },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const frames: any[] = []; let buffered = ''
      child.stdout.on('data', chunk => {
        buffered += chunk
        while (buffered.includes('\n')) { const end = buffered.indexOf('\n'); frames.push(JSON.parse(buffered.slice(0, end))); buffered = buffered.slice(end + 1) }
      })
      const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()) })
      try {
        child.stdin.write(JSON.stringify(nativeProtocolRequest({ type: 'create', requestId: 'owned-init-fault', cwd: workspace })) + '\n')
        for (let attempt = 0; attempt < 300 && !frames.some(frame => frame.type === 'sdk.session.init'); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        const init = frames.find(frame => frame.type === 'sdk.session.init')
        expect(init, `received sidecar frame types: ${frames.map(frame => frame.type).join(', ')}`).toBeDefined()
        expect(init.cliSessionId).toBe(caseId === 'missing-native-id' ? undefined : init.sessionId)
        const captured = JSON.parse(await readFile(join(workspace, 'native-init-field-fault-observation.json'), 'utf8'))
        expect(captured.actualNativeSessionId).toBe(root)
        expect(captured.frame).toEqual(init); expect(captured.frame.nativeIdentityEvidence.launch).toEqual(selectedLaunch)
        expect(frames.some(frame => frame.type === 'probe.native-input')).toBe(false)
      } finally {
        child.stdin.end(JSON.stringify({ type: 'shutdown' }) + '\n'); await closed
        await rm(directory, { recursive: true, force: true }); await rm(ownedRoot, { recursive: true, force: true })
      }
    },
  )
  it('writes current terminal post-load evidence and preserves the selected ordinary status output', async () => withChannel(async (channel) => {
    const home = await mkdtemp(join(tmpdir(), 'terminal-status-home-'))
    const cwd = join(home, 'workspace')
    await mkdir(join(home, '.claude'))
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'printf user' } }))
    await writeFile(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: "node -e 'let x=\"\";process.stdin.on(\"data\",c=>x+=c);process.stdin.on(\"end\",()=>process.stdout.write(JSON.parse(x).session_id))'" } }))
    const child = spawn(process.execPath, [resolve('crates/freshell-claude-sidecar/native-session-channel.mjs'), '--status-line'], {
      cwd, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ...channel.env }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    const status = { session_id: root, transcript_path: '/owned/native.jsonl', version: '2.1.263',
      model: { id: 'claude-haiku-4-5-20251001' }, workspace: { current_dir: cwd }, context_window: { context_window_size: 200000, current_usage: null } }
    child.stdin.end(JSON.stringify(status))
    try {
      expect(await exited).toBe(0)
      expect(output).toBe(root)
      expect(JSON.parse(await readFile(join(channel.directory, 'statusline-loaded.json'), 'utf8'))).toEqual({ launch, native: status })
    } finally { await rm(home, { recursive: true, force: true }) }
  }))
  it('production sidecar emits the normalized native identity before any input and blocks early input', async () => {
    const child = spawn(process.execPath, [resolve('crates/freshell-claude-sidecar/index.mjs')], {
      env: { ...process.env, FRESHELL_SIDECAR_TEST_PREINIT_PERMISSION: '1', FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(launch), FRESHELL_CLAUDE_SDK_QUERY_MODULE: resolve('test/unit/claude-sidecar/fixtures/native-startup-query.mjs') }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const frames: any[] = []
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const boundary = buffer.indexOf('\n')
        frames.push(JSON.parse(buffer.slice(0, boundary)))
        buffer = buffer.slice(boundary + 1)
      }
    })
    const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()) })
    const send = (value: unknown) => child.stdin.write(JSON.stringify(nativeProtocolRequest(value)) + '\n')
    const wait = async (type: string) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const frame = frames.find((frame) => frame.type === type)
        if (frame) return frame
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`missing ${type}: ${JSON.stringify(frames)}`)
    }
    try {
      send({ type: 'create', requestId: 'current-create', sessionId: root, resumeSessionId: root, cwd: '/owned' })
      send({ type: 'send', sessionId: root, text: 'must-stay-blocked' })
      const rejected = await wait('sdk.send.rejected')
      expect(rejected).toMatchObject({ sessionId: root, code: 'INVALID_SEND', message: expect.stringContaining('starting') })
      const created = await wait('created')
      const init = await wait('sdk.session.init')
      expect(init.cliSessionId).toBe(root)
      expect(init.sessionId).toBe(created.sessionId)
      expect(init.nativeIdentityEvidence.launch).toEqual(launch)
      expect(frames.some((frame) => frame.type === 'probe.native-input')).toBe(false)
      expect(frames.some((frame) => frame.type === 'sdk.permission.request')).toBe(false)
      expect((await wait('probe.preinit-permission')).decision.behavior).toBe('deny')
    } finally { send({ type: 'shutdown' }); await exited }
  })
  it('runs a genuine synchronous command hook and requires successful loader completion with no prompt', async () => withChannel(async (channel) => {
    await hook(channel)
    let initializationCalls = 0
    const observation = await channel.waitReady({ initializationResult: async () => { initializationCalls++; return {} } })
    expect(observation.nativeSessionId).toBe(root)
    expect(initializationCalls).toBe(1)
  }))
  it('refuses a real hook followed by native loader failure', async () => withChannel(async (channel) => {
    await hook(channel)
    await expect(channel.waitReady({ initializationResult: async () => { throw new Error('restore failed') } })).rejects.toThrow('restore failed')
  }))
  it('refuses successful initialization without the current native hook', async () => withChannel(async (channel) => {
    await expect(channel.waitReady({ initializationResult: async () => ({}) })).rejects.toThrow('timeout')
  }))
  it('refuses stale launch and wrong root acknowledgements', async () => withChannel(async (channel) => {
    const file = join(channel.directory, 'session-start.json')
    await writeFile(file, JSON.stringify({ launch: { ...launch, launchNonce: 'old' }, native }))
    await expect(channel.waitReady({ initializationResult: async () => ({}) })).rejects.toThrow('stale')
    await writeFile(file, JSON.stringify({ launch, native: { ...native, session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }))
    await expect(channel.waitReady({ initializationResult: async () => ({}) })).rejects.toThrow('wrong native root')
  }))
})

describe('native solo deferred checkpoint inspection', () => {
  const toolUseID = 'toolu_original1'
  const input = { command: 'printf harmless >> /owned/effect-count' }
  const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const assistant = { type: 'assistant', sessionId: root, uuid: 'assistant-original', version: '2.1.237',
    message: { id: 'msg_original', content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input }] } }
  const checkpoint = { type: 'attachment', sessionId: root, uuid: 'checkpoint-original', version: '2.1.237',
    attachment: { type: 'hook_deferred_tool', toolUseID, toolName: 'Bash', toolInput: input,
      hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', permissionMode: 'default' } }
  async function inspect(rows: unknown[], eof = true) {
    const directory = await mkdtemp(join(tmpdir(), 'native-checkpoint-test-'))
    try {
      const path = join(directory, root + '.jsonl')
      await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + (eof ? '\n' : ''))
      return await inspectNativeDeferredCheckpoint({ path, nativeSessionId: root, toolUseID, inputDigest })
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  it('binds the actual native attachment to the exact original solo assistant operation', async () => {
    const observed = await inspect([assistant, checkpoint])
    expect(observed).toMatchObject({ nativeSessionId: root, toolUseID, inputDigest,
      toolName: 'Bash', checkpointUuid: 'checkpoint-original', assistantUuid: 'assistant-original', nativeVersion: '2.1.237' })
    expect(observed.checkpointDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(observed)).not.toContain(input.command)
  })
  it('refuses changed native input, root, and a non-solo original batch', async () => {
    expect(await inspect([assistant, { ...checkpoint, attachment: { ...checkpoint.attachment, toolInput: { command: 'changed' } } }])).toBeNull()
    expect(await inspect([assistant, { ...checkpoint, sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }])).toBeNull()
    expect(await inspect([{ ...assistant, message: { ...assistant.message, content: [...assistant.message.content, { type: 'tool_use', id: 'toolu_second1', name: 'Bash', input }] } }, checkpoint])).toBeNull()
  })
  it('refuses consumed native operations and incomplete EOF rather than replaying', async () => {
    const result = { type: 'user', sessionId: root, message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error: true }] } }
    expect(await inspect([assistant, checkpoint, result])).toBeNull()
    expect(await inspect([assistant, checkpoint], false)).toBeNull()
  })
  it('refuses two operations serialized as separate rows of one native model response', async () => {
    const second = { ...assistant, uuid: 'assistant-second', message: { id: assistant.message.id,
      content: [{ type: 'tool_use', id: 'toolu_second1', name: 'Bash', input }] } }
    expect(await inspect([second, assistant, checkpoint])).toBeNull()
    expect(await inspect([assistant, checkpoint, second])).toBeNull()
  })
  it('requires a native response ID while permitting separate thinking rows and prior turns', async () => {
    expect(await inspect([{ ...assistant, message: { content: assistant.message.content } }, checkpoint])).toBeNull()
    const thinking = { ...assistant, uuid: 'thinking', message: { id: assistant.message.id,
      content: [{ type: 'thinking', thinking: 'owned fixture' }] } }
    const prior = { ...assistant, uuid: 'prior', message: { ...assistant.message, id: 'msg_prior' } }
    expect(await inspect([prior, thinking, assistant, checkpoint])).not.toBeNull()
  })
})

describe('production sidecar native checkpoint continuation', () => {
  it('continues an authorized rollback child checkpoint without forking again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-rollback-checkpoint-'))
    const child = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await writeFile(join(directory, 'native.jsonl'), JSON.stringify({ type: 'system', sessionId: child }) + '\n')
    const worker = checkpointSidecar(directory)
    try {
      worker.send({ type: 'create', requestId: 'rollback-child', cwd: directory, resumeSessionId: root,
        resumeSessionAt: 'retained-turn', forkSession: true, permissionMode: 'default', nativeIdentityTransition: {
          parentNativeSessionId: root, launch: { ...launch, evidenceRevision: launch.evidenceRevision + 1, requestedNativeSessionId: null } } })
      const session = await worker.wait('created')
      expect((await worker.wait('sdk.session.init')).cliSessionId).toBe(child)
      worker.send({ type: 'send', sessionId: session.sessionId, text: 'owned child operation' })
      const card = await worker.wait('sdk.permission.request')
      expect(card.nativeCheckpoint.nativeSessionId).toBe(child)
      expect(worker.frames.filter(frame => frame.type === 'sdk.session.init').map(frame => frame.cliSessionId)).toEqual([child, child])
      worker.send({ type: 'permission.respond', sessionId: session.sessionId, requestId: card.requestId,
        decision: { behavior: 'deny', message: 'owned denial' } })
      expect((await worker.wait('sdk.tool.result')).content[0].is_error).toBe(true)
    } finally { await worker.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it.each([true, 'incomplete'] as const)('keeps split-row native batch hooks on ordinary policy (completion: %s)', async (completion) => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-native-batch-'))
    await writeFile(join(directory, 'native.jsonl'), JSON.stringify({ type: 'system', sessionId: root }) + '\n')
    const worker = checkpointSidecar(directory, 'native-batch', false, false, directory, false, false, completion)
    try {
      worker.send({ type: 'create', requestId: 'batch-create', cwd: directory, resumeSessionId: root, permissionMode: 'default' })
      const created = await worker.wait('created')
      await worker.wait('sdk.session.init')
      worker.send({ type: 'send', sessionId: created.sessionId, text: 'two independent operations' })
      expect((await worker.wait('probe.batch-hooks')).outcomes).toEqual([{}, {}])
      expect(worker.frames.some((frame) => frame.nativeCheckpoint)).toBe(false)
    } finally { await worker.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it('persists managed continuation state outside provider-native project artifacts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sidecar-native-census-'))
    const directory = join(home, '.claude', 'projects', 'owned-project')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'native.jsonl'), JSON.stringify({ type: 'system', sessionId: root }) + '\n')
    const worker = checkpointSidecar(directory, 'native-isolated', false, false, home)
    try {
      worker.send({ type: 'create', requestId: 'isolated-checkpoint', cwd: directory, resumeSessionId: root, permissionMode: 'default' })
      const session = await worker.wait('created'); await worker.wait('sdk.session.init')
      worker.send({ type: 'send', sessionId: session.sessionId, text: 'owned original operation' })
      const card = await worker.wait('sdk.permission.request')
      const record = JSON.parse(await readFile(join(home, '.freshell', 'native-checkpoints', 'claude', root + '.json'), 'utf8'))
      expect(record.checkpoint.toolUseID).toBe(card.nativeCheckpoint.toolUseID)
      expect(await inspectNativeDeferredCheckpoint({ path: join(directory, 'native.jsonl'), nativeSessionId: root,
        toolUseID: card.nativeCheckpoint.toolUseID, inputDigest: card.nativeCheckpoint.inputDigest })).not.toBeNull()
    } finally { await worker.close(); await rm(home, { recursive: true, force: true }) }
  })
  it('waits for the original native child to close before spawning its exact-resume writer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-native-writer-'))
    await writeFile(join(directory, 'native.jsonl'), JSON.stringify({ type: 'system', sessionId: root }) + '\n')
    const worker = checkpointSidecar(directory, 'native-writer', false, true)
    try {
      worker.send({ type: 'create', requestId: 'writer-close', cwd: directory, resumeSessionId: root, permissionMode: 'default' })
      const session = await worker.wait('created')
      await worker.wait('sdk.session.init')
      worker.send({ type: 'send', sessionId: session.sessionId, text: 'owned original operation' })
      await worker.wait('sdk.permission.request')
      expect(worker.frames.filter((frame) => frame.type === 'probe.native-child')).toHaveLength(2)
      expect(worker.frames.some((frame) => frame.type === 'probe.native-overlap')).toBe(false)
    } finally {
      await worker.close()
      const pids = worker.frames.filter((frame) => frame.type === 'probe.native-child').map((frame) => frame.pid)
      for (let attempt = 0; attempt < 100; attempt++) {
        if (pids.every((pid) => { try { process.kill(pid, 0); return false } catch { return true } })) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('waits for the genuine deferred native transcript publication before exposing its pending card', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-deferred-publication-'))
    await writeFile(join(directory, 'native.jsonl'), JSON.stringify({ type: 'system', sessionId: root }) + '\n')
    const worker = checkpointSidecar(directory, 'native-delayed', true)
    try {
      worker.send({ type: 'create', requestId: 'delayed-native', cwd: directory, resumeSessionId: root, permissionMode: 'default' })
      const session = await worker.wait('created')
      await worker.wait('sdk.session.init')
      worker.send({ type: 'send', sessionId: session.sessionId, text: 'owned original operation' })
      const card = await worker.wait('sdk.permission.request')
      expect(card.nativeCheckpoint.toolUseID).toBe('toolu_original1')
      expect(worker.frames.some((frame) => frame.type === 'sdk.error')).toBe(false)
      worker.send({ type: 'permission.respond', sessionId: session.sessionId, requestId: card.requestId,
        decision: { behavior: 'deny', message: 'owned denial' } })
      expect((await worker.wait('sdk.tool.result')).content[0].is_error).toBe(true)
    } finally { await worker.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it.each(['current', 'current-callback-only', 'wrong-input', 'stale-binding', 'dispatching', 'corrupt-journal', 'missing-journal'])('fences an already resumed original native operation before exposing a current approval card (%s)', async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-eager-resume-'))
    await writeFile(join(directory, 'native.jsonl'), JSON.stringify({ type: 'system', sessionId: root }) + '\n')
    let worker = checkpointSidecar(directory, 'native-old')
    try {
      worker.send({ type: 'create', requestId: 'original', cwd: directory, resumeSessionId: root, permissionMode: 'default' })
      const original = await worker.wait('created')
      await worker.wait('sdk.session.init')
      worker.send({ type: 'send', sessionId: original.sessionId, text: 'owned original operation' })
      const oldCard = await worker.wait('sdk.permission.request')
      await worker.close()
      if (['dispatching', 'corrupt-journal', 'missing-journal'].includes(scenario)) {
        const recordPath = join(directory, '.freshell', 'native-checkpoints', 'claude', root + '.json')
        const record = JSON.parse(await readFile(recordPath, 'utf8'))
        if (scenario === 'missing-journal') await rm(recordPath)
        else await writeFile(recordPath, scenario === 'corrupt-journal' ? '{broken' : JSON.stringify({ ...record, phase: 'dispatching' }) + '\n')
      }
      worker = checkpointSidecar(directory, 'native-eager-current', false, false, directory, true, scenario === 'current-callback-only')
      worker.send({ type: 'create', requestId: 'current', cwd: directory, resumeSessionId: root, permissionMode: 'default' })
      const current = await worker.wait('created')
      const init = await worker.wait('sdk.session.init')
      await worker.wait('probe.native-eager-operation')
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(worker.frames.some((frame) => frame.type === 'sdk.permission.request')).toBe(false)
      expect(worker.frames.some((frame) => frame.type === 'probe.native-input')).toBe(false)
      const before = await readFile(join(directory, 'native.jsonl'))
      const checkpoint = { ...oldCard.nativeCheckpoint }
      if (scenario === 'wrong-input') checkpoint.inputDigest = 'c'.repeat(64)
      worker.send({ type: 'checkpoint.resume', sessionId: current.sessionId, requestId: 'fenced-release',
        checkpoints: [checkpoint], nativeBinding: { launch,
          queryGeneration: init.nativeIdentityEvidence.queryGeneration + (scenario === 'stale-binding' ? 1 : 0) } })
      expect((await worker.wait('sdk.checkpoint.dispatch')).ok).toBe(scenario.startsWith('current'))
      if (!scenario.startsWith('current')) {
        expect(worker.frames.some((frame) => frame.type === 'sdk.permission.request')).toBe(false)
        expect(worker.frames.some((frame) => frame.type === 'probe.native-input')).toBe(false)
        return
      }
      const card = await worker.wait('sdk.permission.request')
      expect(card.nativeCheckpoint).toEqual(oldCard.nativeCheckpoint)
      expect(card.requestId).toBe(oldCard.requestId)
      expect(card.nativeRequestId).toBe('native-eager-current')
      expect(worker.frames.some((frame) => frame.type === 'probe.native-input')).toBe(false)
      expect(await readFile(join(directory, 'native.jsonl'))).toEqual(before)
      worker.send({ type: 'permission.respond', sessionId: current.sessionId, requestId: card.requestId,
        decision: { behavior: 'deny', message: 'owned original denial' } })
      expect((await worker.wait('sdk.tool.result')).content[0].is_error).toBe(true)
    } finally { await worker.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it.each(['current', 'current-reordered', 'current-changed-decision-input', 'current-missing-decision-input', 'current-changed-profile', 'wrong-input', 'dispatching'])('releases only a trusted recoverable checkpoint after explicit current control (%s)', async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-explicit-resume-'))
    await writeFile(join(directory, 'native.jsonl'), JSON.stringify({ type: 'system', sessionId: root }) + '\n')
    let worker = checkpointSidecar(directory, 'native-old')
    const create = async () => {
      worker.send({ type: 'create', requestId: 'explicit-resume', cwd: directory, resumeSessionId: root, permissionMode: 'default' })
      const session = await worker.wait('created')
      const init = await worker.wait('sdk.session.init')
      return { sessionId: session.sessionId, init }
    }
    try {
      const first = await create()
      worker.send({ type: 'send', sessionId: first.sessionId, text: 'owned original operation' })
      const oldCard = await worker.wait('sdk.permission.request')
      await worker.close()
      if (scenario === 'dispatching') {
        const path = join(directory, '.freshell', 'native-checkpoints', 'claude', root + '.json')
        const record = JSON.parse(await readFile(path, 'utf8'))
        await writeFile(path, JSON.stringify({ ...record, phase: 'dispatching' }) + '\n')
      }
      worker = checkpointSidecar(directory, 'native-new')
      const current = await create()
      expect(worker.frames.some((frame) => frame.type === 'probe.native-input')).toBe(false)
      const checkpoint = { ...oldCard.nativeCheckpoint }
      if (scenario === 'wrong-input') checkpoint.inputDigest = 'c'.repeat(64)
      const currentLaunch = scenario === 'current-reordered' ? Object.fromEntries(Object.entries(launch).reverse()) : launch
      worker.send({ type: 'checkpoint.resume', sessionId: current.sessionId, requestId: 'current-release',
        checkpoints: [checkpoint], nativeBinding: { launch: currentLaunch, queryGeneration: current.init.nativeIdentityEvidence.queryGeneration } })
      const receipt = await worker.wait('sdk.checkpoint.dispatch')
      expect(receipt.requestId).toBe('current-release')
      expect(receipt.nativeRequestId).toBe('current-release')
      expect(receipt.ok).toBe(scenario.startsWith('current'))
      if (scenario.startsWith('current')) {
        const card = await worker.wait('sdk.permission.request')
        expect(card.requestId).toBe(oldCard.requestId)
        expect(card.nativeCheckpoint).toEqual(oldCard.nativeCheckpoint)
        expect(card.nativeRequestId).toBe('native-new')
        expect(card.nativeBinding.queryGeneration).toBe(1)
        if (scenario.startsWith('current-') && scenario !== 'current-reordered') {
          const profile = join(directory, '.claude', 'settings.json')
          if (scenario === 'current-changed-profile') {
            await mkdir(join(directory, '.claude'), { recursive: true })
            await writeFile(profile, JSON.stringify({ permissions: { allow: ['Bash'] } }))
          }
          worker.send({ type: 'permission.respond', sessionId: current.sessionId, requestId: card.requestId,
            decision: { behavior: 'allow', updatedInput: scenario === 'current-changed-decision-input'
              ? { command: 'changed operation' } : scenario === 'current-missing-decision-input' ? undefined : card.tool.input } })
          expect((await worker.wait('sdk.permission.dispatch')).ok).toBe(false)
          expect(worker.frames.some((frame) => frame.type === 'sdk.tool.result')).toBe(false)
          const parked = JSON.parse(await readFile(join(directory, '.freshell', 'native-checkpoints', 'claude', root + '.json'), 'utf8'))
          expect(parked.phase).toBe('approval_waiting')
          if (scenario === 'current-changed-profile') await rm(profile)
        }
        worker.send({ type: 'permission.respond', sessionId: current.sessionId, requestId: card.requestId,
          decision: { behavior: 'deny', message: 'owned denial after recovery' } })
        expect((await worker.wait('sdk.tool.result')).content[0].is_error).toBe(true)
      } else {
        expect(worker.frames.some((frame) => frame.type === 'probe.native-input')).toBe(false)
        expect(worker.frames.some((frame) => frame.type === 'sdk.permission.request')).toBe(false)
      }
    } finally { await worker.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it.each(['unregistered', 'incomplete', 'consumed'])('admits resume input only after native marker consumption (%s)', async (state) => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-resume-input-'))
    const input = { command: 'fixture owned harmless counter' }
    const assistant = { type: 'assistant', sessionId: root, uuid: 'assistant-original', version: '2.1.237',
      message: { id: 'msg_original', content: [{ type: 'tool_use', id: 'toolu_original1', name: 'Bash', input }] } }
    const checkpoint = { type: 'attachment', sessionId: root, uuid: 'checkpoint-original', version: '2.1.237',
      attachment: { type: 'hook_deferred_tool', toolUseID: 'toolu_original1', toolName: 'Bash', toolInput: input,
        hookEvent: 'PreToolUse', permissionMode: 'default' } }
    const rows: unknown[] = [assistant, checkpoint]
    if (state === 'consumed') rows.push({ type: 'user', sessionId: root,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_original1', is_error: true }] } })
    await writeFile(join(directory, 'native.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + (state === 'incomplete' ? '' : '\n'))
    const child = spawn(process.execPath, [resolve('crates/freshell-claude-sidecar/index.mjs')], {
      env: { ...process.env, HOME: directory, FRESHELL_SIDECAR_TEST_CHECKPOINT: '1',
        FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(launch),
        FRESHELL_CLAUDE_SDK_QUERY_MODULE: resolve('test/unit/claude-sidecar/fixtures/native-startup-query.mjs') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const frames: any[] = []
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const boundary = buffer.indexOf('\n')
        frames.push(JSON.parse(buffer.slice(0, boundary)))
        buffer = buffer.slice(boundary + 1)
      }
    })
    const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()) })
    const send = (value: unknown) => child.stdin.write(JSON.stringify(nativeProtocolRequest(value)) + '\n')
    const wait = async (types: string[]) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const frame = frames.find((frame) => types.includes(frame.type))
        if (frame) return frame
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`missing ${types.join(',')}`)
    }
    try {
      send({ type: 'create', requestId: 'resume-input', cwd: directory, resumeSessionId: root, permissionMode: 'default' })
      const created = await wait(['created'])
      await wait(['sdk.session.init'])
      send({ type: 'send', sessionId: created.sessionId, text: 'ordinary next input' })
      const admission = await wait(['sdk.send.rejected', 'probe.native-input'])
      expect(admission.type).toBe(state === 'consumed' ? 'probe.native-input' : 'sdk.send.rejected')
      if (state !== 'consumed') {
        expect(admission.message).toContain('checkpoint')
        expect(frames.some((frame) => frame.type === 'probe.native-input')).toBe(false)
        expect(frames.some((frame) => frame.type === 'sdk.permission.request')).toBe(false)
      }
    } finally {
      send({ type: 'shutdown' })
      await exited
      await rm(directory, { recursive: true, force: true })
    }
  })
  it.each([false, true])('surfaces a recoverable card after native defer/resume/current ask (hook first: %s)', async (hookFirst) => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-native-checkpoint-'))
    await writeFile(join(directory, 'native.jsonl'), JSON.stringify({ type: 'system', sessionId: root, version: '2.1.237' }) + '\n')
    const child = spawn(process.execPath, [resolve('crates/freshell-claude-sidecar/index.mjs')], {
      env: { ...process.env, HOME: directory, FRESHELL_SIDECAR_TEST_CHECKPOINT: '1',
        FRESHELL_SIDECAR_TEST_CHECKPOINT_HOOK_FIRST: hookFirst ? '1' : '0',
        FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(launch),
        FRESHELL_CLAUDE_SDK_QUERY_MODULE: resolve('test/unit/claude-sidecar/fixtures/native-startup-query.mjs') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const frames: any[] = []
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const boundary = buffer.indexOf('\n')
        frames.push(JSON.parse(buffer.slice(0, boundary)))
        buffer = buffer.slice(boundary + 1)
      }
    })
    const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()) })
    const send = (value: unknown) => child.stdin.write(JSON.stringify(nativeProtocolRequest(value)) + '\n')
    const wait = async (type: string) => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const found = frames.find((frame) => frame.type === type)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`missing ${type}: ${JSON.stringify(frames)}`)
    }
    try {
      send({ type: 'create', requestId: 'checkpoint-create', cwd: directory,
        resumeSessionId: root, permissionMode: 'default' })
      const created = await wait('created')
      await wait('sdk.session.init')
      send({ type: 'send', sessionId: created.sessionId, text: 'owned original operation' })
      const card = await wait('sdk.permission.request')
      expect(card.nativeCheckpoint).toMatchObject({ nativeSessionId: root, toolUseID: 'toolu_original1',
        toolName: 'Bash', checkpointUuid: 'checkpoint-original', assistantUuid: 'assistant-original' })
      expect(card.nativeCheckpoint.profileDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(card.requestId).toBe('checkpoint-checkpoint-original')
      expect(card.nativeBinding).toMatchObject({ launch, queryGeneration: 2, nativeRequestId: 'native-query-current' })
      expect(frames.filter((frame) => frame.type === 'sdk.session.init').map((frame) => frame.nativeIdentityEvidence.queryGeneration)).toEqual([1, 2])
      expect(frames.findIndex((frame) => frame.type === 'sdk.session.loading')).toBeLessThan(frames.indexOf(card))
      const transcript = await readFile(join(directory, 'native.jsonl'), 'utf8')
      expect(transcript).toContain('hook_deferred_tool')
      send({ type: 'permission.respond', sessionId: created.sessionId, requestId: card.requestId,
        decision: { behavior: 'deny', message: 'owned user denial' } })
      expect((await wait('sdk.tool.result')).content[0]).toMatchObject({ tool_use_id: 'toolu_original1', is_error: true })
    } finally {
      send({ type: 'shutdown' })
      await exited
      await rm(directory, { recursive: true, force: true })
    }
  })
})
