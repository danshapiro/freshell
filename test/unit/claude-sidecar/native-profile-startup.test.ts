import { nativeProtocolRequest } from './native-protocol.js'
// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('starts an accepted large cyclic plugin once, reuses it for idle settings, and rechecks pending release', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-profile-startup-'))
  const root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const plugin = join(home, 'plugin')
  const dependency = join(home, 'dependency')
  const payload = join(dependency, 'index.js')
  await mkdir(join(plugin, 'node_modules'), { recursive: true })
  await mkdir(join(dependency, 'node_modules'), { recursive: true })
  await symlink(dependency, join(plugin, 'node_modules/dependency'), 'dir')
  await symlink(plugin, join(dependency, 'node_modules/plugin'), 'dir')
  await writeFile(payload, Buffer.alloc(33 * 1024 * 1024, 'a'))
  await writeFile(join(home, 'native.jsonl'), JSON.stringify({ type: 'system', sessionId: root }) + '\n')
  const child = spawn(process.execPath, [process.env.FRESHELL_TEST_PROFILE_ENTRYPOINT
    ?? resolve('crates/freshell-claude-sidecar/index.mjs')], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
      FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify({ incarnationId: 'current-incarnation',
        launchNonce: 'current-nonce', evidenceRevision: 1, executionGeneration: 1, requestedNativeSessionId: root }),
      FRESHELL_SIDECAR_TEST_CHECKPOINT: '1', FRESHELL_SIDECAR_TEST_NATIVE_EXIT_DELAY: '0',
      FRESHELL_TEST_PROFILE_PAYLOAD: payload,
      FRESHELL_CLAUDE_SDK_QUERY_MODULE: resolve('test/unit/claude-sidecar/fixtures/profile-resource-query.mjs') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames: any[] = []
  let pending = ''
  let stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  child.stdout.on('data', bytes => {
    pending += bytes
    while (pending.includes('\n')) {
      const boundary = pending.indexOf('\n')
      frames.push(JSON.parse(pending.slice(0, boundary)))
      pending = pending.slice(boundary + 1)
    }
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  const send = (value: unknown) => child.stdin.write(JSON.stringify(nativeProtocolRequest(value)) + '\n')
  const wait = async (type: string) => {
    await expect.poll(() => frames.find(frame => frame.type === type), { timeout: 10_000,
      message: `Expected ${type}; stderr: ${stderr}` }).toBeTruthy()
    return frames.find(frame => frame.type === type)
  }
  const resourceReads = () => frames.filter(frame => frame.type === 'probe.profile.resource.read').length
  try {
    send({ type: 'create', requestId: 'current-create', cwd: home, resumeSessionId: root,
      plugins: [plugin], model: 'original', permissionMode: 'default' })
    const { sessionId } = await wait('created')
    await wait('sdk.session.init')
    expect(resourceReads()).toBe(1)
    send({ type: 'configure', sessionId, requestId: 'idle-settings', settings: { model: 'updated' } })
    expect(await wait('sdk.configured')).toMatchObject({ ok: true, settings: { model: 'updated' } })
    expect(resourceReads()).toBe(1)
    send({ type: 'send', sessionId, text: 'owned original operation' })
    const card = await wait('sdk.permission.request')
    expect(resourceReads()).toBeGreaterThan(1)
    await writeFile(payload, 'changed selected dependency')
    send({ type: 'permission.respond', sessionId, requestId: card.requestId,
      decision: { behavior: 'allow', updatedInput: card.tool.input } })
    expect(await wait('sdk.permission.dispatch')).toMatchObject({ ok: false,
      message: 'current checkpoint input or profile changed' })
    await expect(readFile(join(home, 'effect-count'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(payload, Buffer.alloc(33 * 1024 * 1024, 'a'))
    send({ type: 'permission.respond', sessionId, requestId: card.requestId,
      decision: { behavior: 'deny', message: 'owned test completes without an effect' } })
    expect((await wait('sdk.tool.result')).content[0].is_error).toBe(true)
    await wait('sdk.result')
  } finally {
    // This loader starts no native child; only its completed hook process ran.
    if (child.exitCode === null) send({ type: 'shutdown' })
    const code = await exited
    await rm(home, { recursive: true, force: true })
    expect(code, `sidecar stderr: ${stderr}; frames: ${JSON.stringify(frames)}`).toBe(0)
  }
}, 20_000)
