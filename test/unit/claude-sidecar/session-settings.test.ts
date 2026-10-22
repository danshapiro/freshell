// @vitest-environment node

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
// The sidecar runs directly in Node, so its shared settings logic is plain ESM.
// @ts-expect-error JavaScript sidecar module has no declaration file.
import { configureSession, userMessageContent } from '../../../crates/freshell-claude-sidecar/session-settings.mjs'
import { startRealSidecar, type RealSidecar } from './harness'

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

describe('Claude message content', () => {
  it('forwards native images together with text', () => {
    expect(userMessageContent('Describe it', [{ kind: 'data', mediaType: 'image/png', data: 'YWJj' }])).toEqual([
      { type: 'text', text: 'Describe it' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
    ])
  })
})

// The process-level cases run the real index.mjs over the CLI simulator
// (harness.ts). What the SDK received is read from the simulator's ledger: the
// query() options (MCP servers, the child environment's key names) and each
// prompt with the model, effort and permission mode it ran under. The CLI
// accepts any model or effort name and refuses only an unknown permission mode
// (claude-cli-contract.test.ts, T7), so that is the refusal these cases use.
const FAILING_TURN_PROGRAM = {
  rules: [{
    on: 'msg:prompt',
    match: { text: '__fail__' },
    // The CLI puts an internal diagnostic line next to the real error; only
    // the real error may reach the user.
    emit: [{ kind: 'completion', data: { subtype: 'error_during_execution', errors: ['[ede_diagnostic] result_type=assistant last_content_type=text stop_reason=null', 'Request timed out'] } }],
  }],
}
const UNKNOWN_MODE_REFUSAL = 'Cannot set permission mode: must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan'

async function sidecar(extraEnv: Record<string, string> = {}) {
  const harness = await startRealSidecar({ env: extraEnv, program: FAILING_TURN_PROGRAM })
  const waitFor = (type: string, requestId?: string) =>
    harness.waitFor((frame) => frame.type === type && (!requestId || frame.requestId === requestId), requestId ? `${type} ${requestId}` : type)
  return { ...harness, waitFor }
}

/** The query() options the simulated CLI received (the sidecar makes one query per create). */
const queryOptions = async (bridge: Pick<RealSidecar, 'waitForLedger'>) =>
  (await bridge.waitForLedger((row) => row.kind === 'query', 'query() options')).options

/** Whether the fixed hosted MCP recipe reached the SDK's mcpServers option. */
async function hostedMcpProbe(bridge: Pick<RealSidecar, 'waitForLedger'>) {
  const mcp = (await queryOptions(bridge)).mcpServers?.freshell
  return { selected: !!mcp, fixedRecipe: mcp?.command === 'node' && JSON.stringify(mcp?.args) === JSON.stringify(['/opt/freshell-mcp/server.js']) && mcp?.env === undefined }
}

/** The short digest the simulator's ledger records for a credential value (never the value itself). */
const credentialDigest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12)

/** Which credentials the SDK child environment carries, and digests of their values. */
async function authEnvProbe(bridge: Pick<RealSidecar, 'waitForLedger'>) {
  const options = await queryOptions(bridge)
  const envKeys: string[] = options.envKeys ?? []
  const digests: Record<string, string> = options.envDigests ?? {}
  return {
    apiKeyVisible: envKeys.includes('ANTHROPIC_API_KEY'),
    oauthVisible: envKeys.includes('CLAUDE_CODE_OAUTH_TOKEN'),
    apiKeyDigest: digests.ANTHROPIC_API_KEY,
    oauthDigest: digests.CLAUDE_CODE_OAUTH_TOKEN,
  }
}

describe('Claude sidecar OneCLI child environment', () => {
  it('passes the fixed selected hosted MCP recipe through the supported SDK option', async () => {
    const bridge = await sidecar({ FRESHELL_HOSTED_FRESH_AGENT: 'claude' })
    await bridge.create({ requestId: 'hosted-mcp', hostedMcp: true })
    expect(await hostedMcpProbe(bridge)).toMatchObject({ selected: true, fixedRecipe: true })
  })

  it('keeps unselected and ordinary Claude SDK sessions free of the hosted recipe', async () => {
    const hosted = await sidecar({ FRESHELL_HOSTED_FRESH_AGENT: 'claude' })
    await hosted.create({ requestId: 'unselected-mcp', hostedMcp: false })
    expect(await hostedMcpProbe(hosted)).toMatchObject({ selected: false })
    const ordinary = await sidecar({ FRESHELL_HOSTED_FRESH_AGENT: '' })
    await ordinary.create({ requestId: 'ordinary-mcp', hostedMcp: true })
    expect(await hostedMcpProbe(ordinary)).toMatchObject({ selected: false })
  })

  it('passes a managed OneCLI API key to the SDK child without inheriting ambient keys', async () => {
    const unmanaged = await sidecar({ ANTHROPIC_API_KEY: 'onecli-test-key' })
    await unmanaged.create({ requestId: 'unmanaged' })
    expect((await authEnvProbe(unmanaged)).apiKeyVisible).toBe(false)

    const managed = await sidecar({ ANTHROPIC_API_KEY: 'onecli-test-key', CLAUDE_CODE_OAUTH_TOKEN: 'onecli-test-oauth', FRESHELL_CLAUDE_ONECLI_API_KEY: '1' })
    await managed.create({ requestId: 'managed' })
    // The child gets the managed values themselves, not some other or empty key.
    expect(await authEnvProbe(managed)).toMatchObject({
      apiKeyVisible: true,
      oauthVisible: true,
      apiKeyDigest: credentialDigest('onecli-test-key'),
      oauthDigest: credentialDigest('onecli-test-oauth'),
    })
  })
})

describe('Claude sidecar configuration protocol', () => {
  it('preserves conversation identity and applies new effort to the next prompt', async () => {
    const bridge = await sidecar()
    const sessionId = await bridge.create({ requestId: 'create', model: 'opus', effort: 'high', permissionMode: 'plan' })
    bridge.send({ type: 'configure', sessionId, requestId: 'settings', settings: { effort: 'max' } })
    expect(await bridge.waitFor('sdk.configured', 'settings')).toMatchObject({ ok: true, settings: { effort: 'max', model: 'opus', permissionMode: 'plan' } })
    bridge.send({ type: 'send', sessionId, text: 'Continue', images: [{ mediaType: 'image/png', data: 'YWJj' }] })
    // The CLI reports the conversation's identity in the init that opens each turn (T1).
    const { cliSessionId } = await bridge.waitFor('sdk.session.init')
    const prompt = await bridge.waitForPrompt()
    expect(prompt).toMatchObject({ generation: 1, durable: cliSessionId, effort: 'max', model: 'opus', permissionMode: 'plan' })
    expect(prompt.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } })
    expect(bridge.frames.some((frame) => frame.type === 'sdk.exit')).toBe(false)
  })

  it('correlates rejected settings and leaves the existing query available', async () => {
    const bridge = await sidecar()
    const sessionId = await bridge.create({ requestId: 'create', model: 'opus', permissionMode: 'acceptEdits' })
    bridge.send({ type: 'configure', sessionId, requestId: 'bad-mode', settings: { permissionMode: 'no-such-mode' } })
    // The refused mode is neither reported nor kept: the previous one stands.
    expect(await bridge.waitFor('sdk.configured', 'bad-mode')).toMatchObject({ ok: false, message: UNKNOWN_MODE_REFUSAL, settings: { permissionMode: 'acceptEdits' } })
    bridge.send({ type: 'send', sessionId, text: 'Still works' })
    expect(await bridge.waitForPrompt()).toMatchObject({ generation: 1, model: 'opus', permissionMode: 'acceptEdits' })
  })

  it('publishes usable provider commands and removes terminal-only commands', async () => {
    const bridge = await sidecar()
    const sessionId = await bridge.create({ requestId: 'create', model: 'opus' })
    // The boot publishes the catalog (boot-handshake.test.ts); a turn's init
    // then names the CLI's terminal-only commands, which takes a prompt (T1).
    bridge.send({ type: 'send', sessionId, text: 'hello' })
    await bridge.waitFor('sdk.result')
    const catalogs = bridge.frames.filter((frame) => frame.type === 'sdk.session.changed')
    const changed = catalogs[catalogs.length - 1]
    expect(changed).toMatchObject({ sessionId, reason: 'session-commands' })
    // A usable command keeps its description and argument hint; the CLI's
    // terminal-only commands (doctor, color) are removed.
    expect(changed.commands).toContainEqual({ name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>' })
    expect(changed.commands.map((command: { name: string }) => command.name)).not.toContain('doctor')
    expect(changed.commands.map((command: { name: string }) => command.name)).not.toContain('color')
  })

  it('keeps the conversation usable after a settings change fails part way', async () => {
    const bridge = await sidecar()
    const sessionId = await bridge.create({ requestId: 'create', model: 'opus', effort: 'high', permissionMode: 'plan' })
    // The model change applies, then the permission mode is refused: the
    // answer reports the settings as they now stand, with the refused mode
    // left at its previous value.
    bridge.send({ type: 'configure', sessionId, requestId: 'failed-settings', settings: { model: 'sonnet', effort: 'high', permissionMode: 'no-such-mode' } })
    expect(await bridge.waitFor('sdk.configured', 'failed-settings')).toMatchObject({ ok: false, settings: { model: 'sonnet', effort: 'high', permissionMode: 'plan' } })
    bridge.send({ type: 'configure', sessionId, requestId: 'recover', settings: { model: 'opus', effort: 'high' } })
    expect(await bridge.waitFor('sdk.configured', 'recover')).toMatchObject({ ok: true, settings: { permissionMode: 'plan' } })
    bridge.send({ type: 'send', sessionId, text: 'Continue' })
    const { cliSessionId } = await bridge.waitFor('sdk.session.init')
    expect(await bridge.waitForPrompt()).toMatchObject({ generation: 1, durable: cliSessionId, model: 'opus', effort: 'high', permissionMode: 'plan' })
    expect(bridge.frames.some((frame) => frame.type === 'sdk.exit')).toBe(false)
  })

  it('surfaces failed turn details and rings the unified attention edge', async () => {
    const bridge = await sidecar()
    const sessionId = await bridge.create({ requestId: 'create', model: 'opus' })
    bridge.send({ type: 'send', sessionId, text: '__fail__' })
    expect(await bridge.waitFor('sdk.error')).toMatchObject({ message: 'Request timed out', turnFailure: true })
    // Unified needs-attention contract: EVERY result subtype rings — the
    // failed turn's edge is identical to a success turn's (no outcome rides
    // the wire); only a result consumed by a pending accepted user-interrupt
    // mark stays silent (turn-complete-gate.mjs).
    expect(await bridge.waitFor('sdk.turn.complete')).toMatchObject({ sessionId })
  })
})
