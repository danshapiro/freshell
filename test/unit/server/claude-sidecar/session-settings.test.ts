import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
// The sidecar runs directly in Node, so its shared settings logic is plain ESM.
// @ts-expect-error JavaScript sidecar module has no declaration file.
import { configureSession, userMessageContent, resultErrorMessage } from '../../../../crates/freshell-claude-sidecar/session-settings.mjs'

function session() {
  return {
    settings: { model: 'opus', effort: 'high', permissionMode: 'default', cwd: '/project' },
    permissionMode: 'default',
    query: { setModel: vi.fn().mockResolvedValue(undefined), setPermissionMode: vi.fn().mockResolvedValue(undefined), applyFlagSettings: vi.fn().mockResolvedValue(undefined) },
  }
}

describe('Claude sidecar settings', () => {
  it('awaits model and permission changes before accepting the settings', async () => {
    const current = session()
    const applied = await configureSession(current, { model: 'sonnet', effort: 'high', permissionMode: 'plan' })
    expect(current.query.setModel).toHaveBeenCalledWith('sonnet')
    expect(current.query.setPermissionMode).toHaveBeenCalledWith('plan')
    expect(current.permissionMode).toBe('plan')
    expect(applied).toEqual({ model: 'sonnet', effort: 'high', permissionMode: 'plan', cwd: '/project' })
    expect(current.query.applyFlagSettings).not.toHaveBeenCalled()
  })

  it('applies effort to the current query with all other options preserved', async () => {
    const current = session()
    await configureSession(current, { effort: 'max' })
    expect(current.query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' })
    expect(current.settings).toEqual({ model: 'opus', effort: 'max', permissionMode: 'default', cwd: '/project' })
  })

  it('does not reapply unchanged settings or accept changed settings during a turn', async () => {
    const current = session()
    await configureSession(current, { effort: 'high' }, { busy: true })
    await expect(configureSession(current, { effort: 'max' }, { busy: true })).rejects.toThrow('finish')
    expect(current.query.applyFlagSettings).not.toHaveBeenCalled()
    expect(current.settings.effort).toBe('high')
  })

  it('keeps failed changes uncommitted so a retry applies them again', async () => {
    const current = session()
    current.query.setModel.mockRejectedValueOnce(new Error('model unavailable'))
    await expect(configureSession(current, { model: 'sonnet', effort: 'high' })).rejects.toThrow('model unavailable')
    expect(current.settings.model).toBe('opus')
    await configureSession(current, { model: 'sonnet', effort: 'high' })
    expect(current.query.setModel).toHaveBeenCalledTimes(2)
    expect(current.settings.model).toBe('sonnet')
  })

  it('clears the previous effort when changing to a model with no thinking selection', async () => {
    const current = session()
    await configureSession(current, { model: 'no-thinking-model' })
    expect(current.query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: null })
    expect(current.settings.effort).toBeUndefined()
  })

  it('explains unsupported directory changes before applying other settings', async () => {
    const current = session()
    await expect(configureSession(current, { cwd: '/elsewhere', model: 'sonnet' })).rejects.toThrow('new conversation')
    expect(current.query.setModel).not.toHaveBeenCalled()
  })
})

describe('Claude message content and failures', () => {
  it('forwards native images together with text', () => {
    expect(userMessageContent('Describe it', [{ kind: 'data', mediaType: 'image/png', data: 'YWJj' }])).toEqual([
      { type: 'text', text: 'Describe it' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
    ])
  })

  it('explains unsuccessful results without treating successful results as errors', () => {
    expect(resultErrorMessage({ subtype: 'error_during_execution', errors: ['Request timed out'] })).toBe('Request timed out')
    expect(resultErrorMessage({ subtype: 'error_max_turns' })).toContain('turn limit')
    expect(resultErrorMessage({ subtype: 'success' })).toBeUndefined()
  })
})

const children = new Set<ChildProcess>()
afterEach(() => {
  for (const child of children) child.kill()
  children.clear()
})

function sidecar() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../../crates/freshell-claude-sidecar/index.mjs', import.meta.url))], {
    env: { ...process.env, FRESHELL_CLAUDE_SDK_QUERY_MODULE: fileURLToPath(new URL('./fixtures/settings-query-module.mjs', import.meta.url)) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  const frames: Record<string, any>[] = []
  const lines = createInterface({ input: child.stdout! })
  lines.on('line', (line) => frames.push(JSON.parse(line)))
  const send = (message: object) => child.stdin!.write(`${JSON.stringify(message)}\n`)
  const waitFor = async (type: string, requestId?: string) => {
    await expect.poll(() => frames.find((frame) => frame.type === type && (!requestId || frame.requestId === requestId)), { timeout: 5_000 }).toBeTruthy()
    return frames.find((frame) => frame.type === type && (!requestId || frame.requestId === requestId))!
  }
  return { send, waitFor, frames }
}

describe('Claude sidecar configuration protocol', () => {
  it('preserves conversation identity and applies new effort to the next prompt', async () => {
    const bridge = sidecar()
    bridge.send({ type: 'create', requestId: 'create', model: 'opus', effort: 'high', permissionMode: 'plan', cwd: '/project' })
    const { sessionId } = await bridge.waitFor('created')
    const { cliSessionId } = await bridge.waitFor('sdk.session.init')
    bridge.send({ type: 'configure', sessionId, requestId: 'settings', settings: { effort: 'max' } })
    expect(await bridge.waitFor('sdk.configured', 'settings')).toMatchObject({ ok: true, settings: { effort: 'max', model: 'opus', permissionMode: 'plan' } })
    bridge.send({ type: 'send', sessionId, text: 'Continue', images: [{ mediaType: 'image/png', data: 'YWJj' }] })
    const prompt = await bridge.waitFor('probe.prompt')
    expect(prompt).toMatchObject({ generation: 1, durable: cliSessionId, effort: 'max', model: 'opus', permissionMode: 'plan' })
    expect(prompt.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } })
    expect(bridge.frames.some((frame) => frame.type === 'sdk.exit')).toBe(false)
  })

  it('correlates rejected settings and leaves the existing query available', async () => {
    const bridge = sidecar()
    bridge.send({ type: 'create', requestId: 'create', model: 'opus' })
    const { sessionId } = await bridge.waitFor('created')
    bridge.send({ type: 'configure', sessionId, requestId: 'bad-model', settings: { model: 'unavailable' } })
    expect(await bridge.waitFor('sdk.configured', 'bad-model')).toMatchObject({ ok: false, message: 'Model is unavailable' })
    bridge.send({ type: 'send', sessionId, text: 'Still works' })
    expect(await bridge.waitFor('probe.prompt')).toMatchObject({ generation: 1, model: 'opus' })
  })

  it('publishes usable provider commands and removes terminal-only commands', async () => {
    const bridge = sidecar()
    bridge.send({ type: 'create', requestId: 'create', model: 'opus' })
    await bridge.waitFor('created')
    expect(await bridge.waitFor('sdk.session.changed')).toMatchObject({
      reason: 'session-commands', commands: [{ name: 'review', description: 'Review changes', argumentHint: '[path]' }],
    })
  })

  it('keeps the conversation usable after effort configuration fails', async () => {
    const bridge = sidecar()
    bridge.send({ type: 'create', requestId: 'create', model: 'opus', effort: 'high' })
    const { sessionId } = await bridge.waitFor('created')
    const { cliSessionId } = await bridge.waitFor('sdk.session.init')
    bridge.send({ type: 'configure', sessionId, requestId: 'failed-effort', settings: { model: 'sonnet', effort: 'invalid' } })
    expect(await bridge.waitFor('sdk.configured', 'failed-effort')).toMatchObject({ ok: false, settings: { model: 'sonnet', effort: 'high' } })
    bridge.send({ type: 'configure', sessionId, requestId: 'recover', settings: { model: 'opus', effort: 'high' } })
    expect(await bridge.waitFor('sdk.configured', 'recover')).toMatchObject({ ok: true })
    bridge.send({ type: 'send', sessionId, text: 'Continue' })
    expect(await bridge.waitFor('probe.prompt')).toMatchObject({ generation: 1, durable: cliSessionId, model: 'opus', effort: 'high' })
    expect(bridge.frames.some((frame) => frame.type === 'sdk.exit')).toBe(false)
  })

  it('surfaces failed turn details without emitting a success notification', async () => {
    const bridge = sidecar()
    bridge.send({ type: 'create', requestId: 'create', model: 'opus' })
    const { sessionId } = await bridge.waitFor('created')
    bridge.send({ type: 'send', sessionId, text: '__fail__' })
    expect(await bridge.waitFor('sdk.error')).toMatchObject({ message: 'Request timed out', turnFailure: true })
    expect(bridge.frames.some((frame) => frame.type === 'sdk.turn.complete')).toBe(false)
  })
})
