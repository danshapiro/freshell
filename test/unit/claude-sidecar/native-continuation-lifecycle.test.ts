import { nativeProtocolRequest } from './native-protocol.js'
// @vitest-environment node
// Native-process teardown regressions run only in scripts/sandbox-test.sh.
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const nativeSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const launch = { incarnationId: 'owned-incarnation', launchNonce: 'owned-nonce', evidenceRevision: 1,
  executionGeneration: 1, requestedNativeSessionId: nativeSessionId }

async function sidecar(extraEnv: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'native-continuation-lifecycle-'))
  await writeFile(join(home, 'native.jsonl'), JSON.stringify({ type: 'system', sessionId: nativeSessionId }) + '\n')
  const child = spawn(process.execPath, [resolve('crates/freshell-claude-sidecar/index.mjs')], {
    env: { ...process.env, HOME: home, CLAUDE_HOME: join(home, '.claude'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
      FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(launch), FRESHELL_SIDECAR_TEST_CHECKPOINT: '1',
      FRESHELL_SIDECAR_TEST_NATIVE_EXIT_DELAY: '1',
      FRESHELL_CLAUDE_SDK_QUERY_MODULE: resolve('test/unit/claude-sidecar/fixtures/native-startup-query.mjs'), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames: any[] = []
  let buffer = ''
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    buffer += chunk
    let boundary
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, boundary)))
      buffer = buffer.slice(boundary + 1)
    }
  })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  const send = (value: unknown) => child.stdin.write(JSON.stringify(nativeProtocolRequest(value)) + '\n')
  let closedPids: number[] = []
  let cleanup: Promise<number | null> | undefined
  const wait = async (type: string, after = 0, timeout = 8_000) => {
    try {
      await expect.poll(() => frames.slice(after).find(frame => frame.type === type), { timeout }).toBeTruthy()
    } catch (error) {
      throw new Error(`missing ${type}; frames: ${JSON.stringify(frames)}; stderr: ${stderr}`, { cause: error })
    }
    return frames.slice(after).find(frame => frame.type === type)
  }
  return { home, frames, send, wait, stderr: () => stderr, closedPids: () => closedPids,
    close: () => cleanup ??= (async () => {
      if (child.exitCode === null && !frames.some(frame => frame.type === 'sdk.stream.ended' || frame.type === 'create.failed')) send({ type: 'shutdown', awaitNativeShutdown: true })
      const code = await exited
      const observations = await readFile(join(home, 'native-closed.jsonl'), 'utf8').catch(() => '')
      closedPids = observations.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).pid)
      await rm(home, { recursive: true, force: true })
      return code
    })(),
  }
}

describe('production native continuation lifecycle', () => {
  it('compacts with the exact input, follows a genuine clear, and resumes its new root for the next approval', async () => {
    const firstClearedRoot = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const clearedRoot = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const worker = await sidecar({ FRESHELL_SIDECAR_TEST_NATIVE_CLEAR: '1' })
    await writeFile(join(worker.home, nativeSessionId + '.jsonl'), JSON.stringify({ type: 'system', sessionId: nativeSessionId }) + '\n')
    try {
      worker.send({ type: 'create', requestId: 'clear-create', cwd: worker.home, resumeSessionId: nativeSessionId })
      const { sessionId } = await worker.wait('created')
      await worker.wait('sdk.session.init')
      worker.send({ type: 'send', sessionId, text: '/compact preserve the current task' })
      expect(await worker.wait('probe.native-compact-input')).toMatchObject({ text: '/compact preserve the current task', nativeSessionId })
      await worker.wait('sdk.result')
      for (const [previousNativeSessionId, nextRoot] of [[nativeSessionId, firstClearedRoot], [firstClearedRoot, clearedRoot]]) {
        const clearAt = worker.frames.length
        worker.send({ type: 'send', sessionId, text: '/clear' })
        const cleared = await worker.wait('sdk.session.init', clearAt)
        expect(cleared).toMatchObject({ cliSessionId: nextRoot, nativeIdentityEvidence: {
          source: 'clear', previousNativeSessionId, launch,
        } })
        expect(await worker.wait('sdk.session.rekeyed', clearAt)).toMatchObject({ sessionId, newSessionId: nextRoot })
        await worker.wait('sdk.result', clearAt)
      }

      const nextAt = worker.frames.length
      worker.send({ type: 'send', sessionId, text: 'an actual operation after clear' })
      const card = await worker.wait('sdk.permission.request', nextAt)
      expect(worker.frames.filter(frame => frame.type === 'probe.native-options').at(-1))
        .toMatchObject({ queryNumber: 2, resume: clearedRoot })
      const resumed = await worker.wait('sdk.session.init', nextAt)
      expect(resumed).toMatchObject({ cliSessionId: clearedRoot, nativeIdentityEvidence: {
        source: 'resume', previousNativeSessionId: firstClearedRoot, launch,
      } })
      worker.send({ type: 'permission.respond', sessionId, requestId: card.requestId,
        decision: { behavior: 'allow', updatedInput: card.tool.input } })
      expect(await worker.wait('sdk.tool.result', nextAt)).toMatchObject({ nativeSessionId: clearedRoot, content: [{ is_error: false }] })
      await worker.wait('sdk.result', nextAt)
      expect(await readFile(join(worker.home, 'effect-count'), 'utf8')).toBe('1\n')
      expect(worker.frames.some(frame => frame.type === 'sdk.send.rejected' || frame.type === 'sdk.error' || frame.type === 'sdk.session.closed')).toBe(false)
    } finally { expect(await worker.close(), JSON.stringify(worker.frames) + worker.stderr()).toBe(0) }
  })

  it.each(['queued-send', 'partial-setting-failure'])('keeps actual settings coherent at configuration boundaries: %s', async scenario => {
    const worker = await sidecar(scenario === 'queued-send'
      ? { FRESHELL_SIDECAR_TEST_CONFIGURE_DELAY: '1' } : { FRESHELL_SIDECAR_TEST_EFFORT_FAILURE: '1' })
    try {
      worker.send({ type: 'create', requestId: 'owned-create', cwd: worker.home, resumeSessionId: nativeSessionId,
        model: 'owned-original', effort: 'high', permissionMode: 'default' })
      const { sessionId } = await worker.wait('created')
      await worker.wait('sdk.session.init')
      worker.send({ type: 'configure', sessionId, requestId: 'owned-settings', settings: { model: 'owned-updated', effort: 'low' } })
      if (scenario === 'queued-send') worker.send({ type: 'send', sessionId, text: 'queued after settings' })
      const configured = await worker.wait('sdk.configured')
      expect(configured).toMatchObject({ ok: scenario === 'queued-send', settings: {
        model: 'owned-updated', effort: scenario === 'queued-send' ? 'low' : 'high', permissionMode: 'default' } })
      if (scenario === 'partial-setting-failure') worker.send({ type: 'send', sessionId, text: 'continue after partial setting failure' })
      const card = await worker.wait('sdk.permission.request')
      expect(worker.frames.filter(frame => frame.type === 'probe.native-options').at(-1)).toMatchObject({
        queryNumber: 2, model: 'owned-updated', effort: configured.settings.effort, permissionMode: 'default', resume: nativeSessionId,
      })
      worker.send({ type: 'permission.respond', sessionId, requestId: card.requestId,
        decision: { behavior: 'allow', updatedInput: card.tool.input } })
      expect((await worker.wait('sdk.tool.result')).content[0].is_error).toBe(false)
      await worker.wait('sdk.result')
      expect(await readFile(join(worker.home, 'effect-count'), 'utf8')).toBe('1\n')
      expect(worker.frames.some(frame => frame.type === 'sdk.error' || frame.type === 'sdk.session.closed')).toBe(false)
    } finally { expect(await worker.close()).toBe(0) }
  })

  it.each([
    { model: 'owned-updated' },
    { effort: 'max' },
    { effort: null },
    { permissionMode: 'plan' },
    { model: 'owned-updated', effort: 'low', permissionMode: 'plan' },
  ])('preserves accepted idle settings through future checkpoints: %j', async (settings) => {
    const worker = await sidecar()
    try {
      worker.send({ type: 'create', requestId: 'owned-create', cwd: worker.home, resumeSessionId: nativeSessionId,
        model: 'owned-original', effort: 'high', permissionMode: 'default' })
      const { sessionId } = await worker.wait('created')
      await worker.wait('sdk.session.init')
      worker.send({ type: 'configure', sessionId, requestId: 'owned-settings', settings })
      const configured = await worker.wait('sdk.configured')
      expect(configured.ok).toBe(true)
      const after = worker.frames.length
      worker.send({ type: 'send', sessionId, text: 'owned checkpoint after configuration' })
      const card = await worker.wait('sdk.permission.request', after)
      const resumed = worker.frames.filter(frame => frame.type === 'probe.native-options').at(-1)
      expect(resumed).toEqual({ type: 'probe.native-options', queryNumber: 2, resume: nativeSessionId,
        ...Object.fromEntries(['model', 'effort', 'permissionMode'].filter(key => configured.settings[key] !== undefined)
          .map(key => [key, configured.settings[key]])) })
      expect(worker.frames.some(frame => frame.type === 'sdk.error')).toBe(false)

      // A pending operation retains its exact original binding and settings.
      const pendingAt = worker.frames.length
      worker.send({ type: 'configure', sessionId, requestId: 'pending-settings', settings: { model: 'must-not-rebind' } })
      expect(await worker.wait('sdk.configured', pendingAt)).toMatchObject({ ok: false, settings: configured.settings })
      worker.send({ type: 'permission.respond', sessionId, requestId: card.requestId,
        decision: { behavior: 'allow', updatedInput: card.tool.input } })
      expect((await worker.wait('sdk.tool.result', after)).content[0].is_error).toBe(false)
      await worker.wait('sdk.result', after)

      const nextAt = worker.frames.length
      worker.send({ type: 'configure', sessionId, requestId: 'future-settings', settings: { effort: 'medium' } })
      expect(await worker.wait('sdk.configured', nextAt)).toMatchObject({ ok: true, settings: { effort: 'medium' } })
      worker.send({ type: 'send', sessionId, text: 'another owned checkpoint after configuration' })
      const nextCard = await worker.wait('sdk.permission.request', nextAt)
      expect(nextCard.nativeCheckpoint.profileDigest).not.toBe(card.nativeCheckpoint.profileDigest)
      expect(worker.frames.filter(frame => frame.type === 'probe.native-options').at(-1))
        .toMatchObject({ queryNumber: 3, effort: 'medium', model: configured.settings.model,
          permissionMode: configured.settings.permissionMode, resume: nativeSessionId })
      worker.send({ type: 'permission.respond', sessionId, requestId: nextCard.requestId,
        decision: { behavior: 'allow', updatedInput: nextCard.tool.input } })
      expect((await worker.wait('sdk.tool.result', nextAt)).content[0].is_error).toBe(false)
      await worker.wait('sdk.result', nextAt)
      expect(await readFile(join(worker.home, 'effect-count'), 'utf8')).toBe('1\n1\n')
      expect(worker.frames.some(frame => frame.type === 'sdk.session.closed')).toBe(false)
    } finally { expect(await worker.close()).toBe(0) }
  })

  it.each([
    ['close-timeout', 'original native writer did not close'],
    ['close-error', 'owned original query close failed'],
    ['query-setup', 'owned replacement query setup failed'],
    ['native-startup', 'owned replacement native startup failed'],
  ])('settles the failed turn and session after %s without overlapping native writers', async (scenario, diagnostic) => {
    const worker = await sidecar({ FRESHELL_SIDECAR_TEST_CONTINUATION_FAILURE: scenario })
    try {
      worker.send({ type: 'create', requestId: 'owned-create', cwd: worker.home, resumeSessionId: nativeSessionId, permissionMode: 'default' })
      const { sessionId } = await worker.wait('created')
      await worker.wait('sdk.session.init')
      worker.send({ type: 'send', sessionId, text: 'owned checkpoint operation' })
      await worker.wait('sdk.session.loading')
      expect(await worker.wait('sdk.error')).toMatchObject({ sessionId, message: expect.stringContaining(diagnostic) })
      expect(await worker.wait('sdk.stream.ended')).toMatchObject({ sessionId, reason: 'stream_error' })
      expect(await worker.wait('sdk.session.closed')).toMatchObject({ sessionId, nativeSessionId, reason: 'stream_error' })
      expect(worker.frames.filter(frame => frame.type === 'sdk.session.closed')).toHaveLength(1)
      expect(worker.frames.filter(frame => frame.type === 'sdk.stream.ended')).toHaveLength(1)
      expect(worker.frames.some(frame => frame.type === 'sdk.turn.complete' || frame.type === 'sdk.turn.waiting')).toBe(false)
      expect(worker.frames.filter(frame => frame.type === 'probe.native-child')).toHaveLength(scenario === 'native-startup' ? 2 : 1)
      expect(worker.frames.some(frame => frame.type === 'probe.native-overlap')).toBe(false)
      expect(worker.stderr()).toContain(diagnostic)
      expect(JSON.parse(await readFile(join(worker.home, '.freshell/native-checkpoints/claude', nativeSessionId + '.json'), 'utf8')))
        .toMatchObject({ phase: 'checkpointed', nativeSessionId, toolUseID: 'toolu_original1' })
      await expect(readFile(join(worker.home, 'effect-count'))).rejects.toMatchObject({ code: 'ENOENT' })
      // An ended SDKv2 stream is the last frame and exits the sidecar; Rust
      // settles its turn and may restore this native root in a new child.
      // All retired native writers must finish before that exit.
      expect(await worker.close()).toBe(3)
      expect(worker.frames.at(-1)).toMatchObject({ type: 'sdk.stream.ended', sessionId })
      expect(worker.closedPids().sort()).toEqual(worker.frames.filter(frame => frame.type === 'probe.native-child').map(frame => frame.pid).sort())
    } finally { await worker.close() }
  })
})
