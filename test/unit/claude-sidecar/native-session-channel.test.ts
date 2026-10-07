import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createNativeSessionChannel } from '../../../crates/freshell-claude-sidecar/native-session-channel.mjs'

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
