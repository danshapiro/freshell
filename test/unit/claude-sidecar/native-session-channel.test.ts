import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createNativeSessionChannel, inspectNativeDeferredCheckpoint } from '../../../crates/freshell-claude-sidecar/native-session-channel.mjs'

const root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const launch = { incarnationId: 'current-incarnation', launchNonce: 'current-nonce', evidenceRevision: 3, executionGeneration: 4, requestedNativeSessionId: root }
const native = { hook_event_name: 'SessionStart', session_id: root, source: 'resume', cwd: '/owned', transcript_path: '/owned/native.jsonl' }
async function withChannel(run: (channel: any) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'native-channel-test-'))
  try { await run(await createNativeSessionChannel({ launch, directory, timeoutMs: 100 })) }
  finally { await rm(directory, { recursive: true, force: true }) }
}
async function hook(channel: any) {
  const child = spawn(process.execPath, [resolve('crates/freshell-claude-sidecar/native-session-channel.mjs')], { env: { ...process.env, ...channel.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  child.stdin.end(JSON.stringify(native))
  expect(await exited).toBe(0)
}
describe('managed native startup channel', () => {
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
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n')
    const wait = async (type: string) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const frame = frames.find((frame) => frame.type === type)
        if (frame) return frame
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`missing ${type}: ${JSON.stringify(frames)}`)
    }
    try {
      send({ type: 'create', requestId: 'current-create', resumeSessionId: root, cwd: '/owned' })
      const created = await wait('created')
      send({ type: 'send', sessionId: created.sessionId, text: 'must-stay-blocked' })
      const error = await wait('sdk.error')
      expect(error.message).toContain('not observed')
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
    message: { content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input }] } }
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
    expect(await inspect([{ ...assistant, message: { content: [...assistant.message.content, { type: 'tool_use', id: 'toolu_second1', name: 'Bash', input }] } }, checkpoint])).toBeNull()
  })
  it('refuses consumed native operations and incomplete EOF rather than replaying', async () => {
    const result = { type: 'user', sessionId: root, message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error: true }] } }
    expect(await inspect([assistant, checkpoint, result])).toBeNull()
    expect(await inspect([assistant, checkpoint], false)).toBeNull()
  })
})
