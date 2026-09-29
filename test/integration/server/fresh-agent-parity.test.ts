import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig } from '../../e2e-browser/helpers/managed-runtime.js'

const root = path.resolve(import.meta.dirname, '../../..')
const providers = [
  { provider: 'claude', sessionType: 'freshclaude', config: '.claude/settings.json' },
  { provider: 'codex', sessionType: 'freshcodex', config: '.codex/config.toml' },
  { provider: 'opencode', sessionType: 'freshopencode', config: '.config/opencode/opencode.jsonc' },
] as const

async function waitFor<T>(label: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

class FreshWire {
  private readonly frames: any[] = []

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', data => {
      try { this.frames.push(JSON.parse(String(data))) } catch { /* Other frames are irrelevant. */ }
    })
  }

  static async connect(info: { wsUrl: string; token: string }): Promise<FreshWire> {
    const socket = new WebSocket(info.wsUrl)
    const wire = new FreshWire(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    wire.send({ type: 'hello', token: info.token, protocolVersion: WS_PROTOCOL_VERSION })
    await wire.wait(frame => frame.type === 'ready')
    return wire
  }

  send(frame: unknown): void { this.socket.send(JSON.stringify(frame)) }

  wait(predicate: (frame: any) => boolean): Promise<any> {
    return waitFor('fresh-agent frame', () => this.frames.find(predicate)).catch(error => {
      throw new Error(`${String(error)}; recent frames: ${JSON.stringify(this.frames.slice(-12))}`)
    })
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve() }, 2000)
      this.socket.once('close', () => { clearTimeout(timer); resolve() })
      this.socket.close()
    })
  }
}

describe('hosted fresh-agent provider inputs', () => {
  let rig: ManagedRuntimeBrowserRig
  const wires: FreshWire[] = []

  beforeAll(async () => {
    rig = new ManagedRuntimeBrowserRig(root, 2, { FRESHELL_BIND_HOST: '0.0.0.0' }, {}, 'test', {
      enabledProviders: [],
      providerSettings: {},
      freshAgentModes: providers.map(row => row.sessionType),
      fixtureFreshAgentModes: providers.map(row => row.sessionType),
    })
    await rig.start()
    for (const row of providers) {
      const file = path.join(rig.info.homeDir, row.config)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
      const contents = row.provider === 'codex'
        ? 'fixture_setting = true\n\n[mcp_servers.user_fixture]\ncommand = "user-fixture-mcp"\n'
        : JSON.stringify({ fixtureSetting: true, mcpServers: { user_fixture: { command: 'user-fixture-mcp' } } }) + '\n'
      fs.writeFileSync(file, contents)
      fs.chmodSync(path.dirname(file), 0o755)
      fs.chmodSync(file, 0o644)
    }
  }, 900_000)

  afterAll(async () => {
    await Promise.allSettled(wires.map(wire => wire.close()))
    if (rig) {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  }, 180_000)

  it.each(providers)('$sessionType retains create settings and exact native resume', async row => {
    const wire = await FreshWire.connect(rig.info)
    wires.push(wire)
    const requestId = `fresh-parity-${randomUUID()}`
    const namingHandle = `nh-${randomUUID()}`
    wire.send({
      type: 'freshAgent.create', requestId, sessionType: row.sessionType,
      provider: row.provider, cwd: root, model: 'fixture-model',
      modelSelection: { kind: 'exact', modelId: 'fixture-model' },
      effort: 'low', permissionMode: 'default', sandbox: 'workspace-write',
      plugins: ['fixture-plugin'], namingHandle, tabId: `tab-${requestId}`,
    })
    const created = await wire.wait(frame => frame.requestId === requestId
      && (frame.type === 'freshAgent.created' || frame.type === 'freshAgent.create.failed'))
    if (created.type === 'freshAgent.create.failed') {
      throw new Error(`${JSON.stringify(created)}; inventory=${JSON.stringify(await rig.inventory())}; web=${JSON.stringify(rig.web.capturedOutput())}; supervisor=${rig.runtime.containerLogs(rig.supervisor.containerId).slice(-6000)}`)
    }
    expect(created.type, JSON.stringify(created)).toBe('freshAgent.created')
    expect(created.nameRef).toEqual({ kind: 'pending', id: namingHandle })
    expect(created.sessionName?.name).toBeTruthy()
    const view = await waitFor('hosted fresh-agent soul', async () => {
      const candidate = await rig.runningViewForFreshSession(created.sessionId)
      return candidate?.containerId ? candidate : undefined
    })
    const recorded = JSON.parse(rig.ownedProviderExec(view.containerId!, [
      'cat', '/home/freshell/provider/.freshell-fixture/provider-native-state.json',
    ]))
    const profile = recorded.createProfile
    expect(profile).toMatchObject({
      provider: row.provider, cwd: root, model: 'fixture-model', effort: 'low',
      permissionMode: 'default', sandbox: 'workspace-write',
      plugins: ['fixture-plugin'],
      modelSelection: { kind: 'exact', modelId: 'fixture-model' },
    })
    expect(profile.providerLaunchContext.config.length).toBeGreaterThan(0)
    expect(profile.providerLaunchContext.mcpCapability.grantId).toMatch(/^grant-/)
    for (const reference of profile.providerSecretReferences ?? []) {
      expect(reference.sourcePath).toMatch(/onecli/)
      expect(reference.profile).toMatch(new RegExp(`^${row.provider}_onecli_`))
    }
    expect(JSON.stringify(recorded)).not.toContain('fixture-secret-byte')
    const preparation = profile.providerLaunchContext.preparation
    if (row.provider === 'claude') {
      expect(preparation.claude?.mcp_args).toEqual([])
    } else if (row.provider === 'codex') {
      expect(preparation.codex).toMatchObject({ tui_args: [], sidecar_args: [] })
    } else {
      expect(preparation.opencode).toMatchObject({ inline_config: false, tui_config: null })
      expect(JSON.stringify(preparation)).not.toContain('freshell-mcp')
      const tuiConfig = rig.ownedProviderExec(view.containerId!, [
        'cat', '/home/freshell/provider/.freshell/opencode/tui.json',
      ])
      expect(JSON.parse(tuiConfig).plugin).toEqual([
        expect.stringContaining('freshell-rebind-plugin.ts'),
      ])
    }
    for (const config of profile.providerLaunchContext.config) {
      const contents = rig.ownedProviderExec(view.containerId!, [
        'cat', path.posix.join('/home/freshell/provider', config.providerRelativePath),
      ])
      expect(contents).toContain(row.provider === 'codex' ? 'fixture_setting' : 'fixtureSetting')
      expect(contents).toContain('user-fixture-mcp')
    }

    const sendId = `send-${randomUUID()}`
    wire.send({ type: 'freshAgent.send', provider: row.provider, sessionType: row.sessionType,
      sessionId: created.sessionId, requestId: sendId, text: 'fixture prompt' })
    await wire.wait(frame => frame.type === 'freshAgent.turn.complete'
      && frame.sessionId === created.sessionId)

    const resumeId = `resume-${randomUUID()}`
    wire.send({ type: 'freshAgent.create', requestId: resumeId,
      provider: row.provider, sessionType: row.sessionType, cwd: root,
      sessionRef: { provider: row.provider, sessionId: recorded.nativeSessionId } })
    const resumed = await wire.wait(frame => frame.requestId === resumeId
      && (frame.type === 'freshAgent.created' || frame.type === 'freshAgent.create.failed'))
    expect(resumed.type, JSON.stringify(resumed)).toBe('freshAgent.created')
    expect(resumed.sessionRef?.sessionId).toBe(recorded.nativeSessionId)
  }, 240_000)
})
