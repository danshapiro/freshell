import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig } from '../../e2e-browser/helpers/managed-runtime.js'

type Provider = 'claude' | 'codex' | 'opencode' | 'amplifier'
type RecordRow = { provider: Provider; kind: 'launch' | 'mcp' | 'identity'; [key: string]: any }
const root = path.resolve(import.meta.dirname, '../../..')
const fixture = path.join(root, 'test/fixtures/providers/parity-provider.mjs')
const providers: Provider[] = ['claude', 'codex', 'opencode', 'amplifier']
const nestedSecretMarker = 'nested-secret-byte'

async function waitFor<T>(label: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

class TerminalWire {
  private readonly socket: WebSocket
  private readonly frames: any[] = []
  private readonly records: RecordRow[] = []
  private outputBuffer = ''

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', data => {
      try {
        const frame = JSON.parse(String(data))
        this.frames.push(frame)
        if (frame.type !== 'terminal.output' || typeof frame.data !== 'string') return
        this.outputBuffer += frame.data
        const marker = /FRESHELL_PROVIDER_PARITY_ROW:([A-Za-z0-9+/=]+)\r?\n/g
        let consumed = 0
        for (let match; (match = marker.exec(this.outputBuffer));) {
          this.records.push(JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')))
          consumed = marker.lastIndex
        }
        this.outputBuffer = this.outputBuffer.slice(consumed).slice(-65_536)
      } catch {}
    })
  }

  static async connect(info: { wsUrl: string; token: string }, managed: boolean): Promise<TerminalWire> {
    const socket = new WebSocket(info.wsUrl)
    const wire = new TerminalWire(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    wire.send({
      type: 'hello', token: info.token, protocolVersion: WS_PROTOCOL_VERSION,
      capabilities: managed ? { managedRuntimeV1: true, paneReconcileV1: true } : {},
    })
    const ready = await wire.wait(frame => frame.type === 'ready', 10_000)
    if (managed) expect(ready.capabilities?.managedRuntimeV1).toBe(true)
    return wire
  }

  send(frame: unknown): void { this.socket.send(JSON.stringify(frame)) }

  recentFrames(): any[] { return this.frames.slice(-12) }
  terminalOutput(): string { return this.frames.filter(frame => frame.type === 'terminal.output').map(frame => frame.data).join('').slice(-4000) }
  recordRows(): RecordRow[] { return this.records }

  wait(predicate: (frame: any) => boolean, timeoutMs: number): Promise<any> {
    return waitFor('WebSocket frame', () => this.frames.find(predicate), timeoutMs).catch(error => {
      throw new Error(`${String(error)}; received ${JSON.stringify(this.frames.slice(-12))}`)
    })
  }

  async create(provider: Provider, cwd: string): Promise<{ requestId: string; terminalId: string }> {
    const requestId = `provider-parity-${provider}-${randomUUID()}`
    this.send({ type: 'terminal.create', requestId, mode: provider, shell: 'system', cwd, tabId: `tab-${provider}`, paneId: `pane-${provider}` })
    const frame = await this.wait(message => (
      message.requestId === requestId && (message.type === 'terminal.created' || message.type === 'error')
    ), 90_000)
    if (frame.type === 'error') throw new Error(`${provider} terminal.create failed: ${JSON.stringify(frame)}`)
    await this.attach(frame.terminalId)
    return { requestId, terminalId: frame.terminalId }
  }

  async attach(terminalId: string): Promise<void> {
    const attachRequestId = `provider-parity-attach-${randomUUID()}`
    this.send({ type: 'terminal.attach', terminalId, intent: 'viewport_hydrate',
      cols: 80, rows: 24, sinceSeq: 0, attachRequestId, priority: 'background' })
    await this.wait(message => message.type === 'terminal.attach.ready'
      && message.terminalId === terminalId && message.attachRequestId === attachRequestId, 10_000)
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve() }, 2_000)
      this.socket.once('close', () => { clearTimeout(timer); resolve() })
      this.socket.close()
    })
  }
}

function ordinaryProviderArgs(argv: string[], provider: Provider): string[] {
  const result: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--mcp-config' || arg === '--mcp-config-file') { index++; continue }
    if (arg === '-c' && argv[index + 1]?.startsWith('mcp_servers.freshell.')) { index++; continue }
    if (provider === 'codex' && argv[index - 1] === '--remote') {
      result.push('<codex-local-endpoint>')
    } else if (provider === 'opencode' && argv[index - 1] === '--port') {
      result.push('<opencode-port>')
    } else if (['--session-id', '--resume'].includes(argv[index - 1])
      || (provider === 'amplifier' && argv.includes('resume') && index === argv.length - 1)) {
      result.push('<provider-session-id>')
    } else {
      result.push(arg)
    }
  }
  return result
}

function normalized(record: RecordRow): unknown {
  const env = record.env as Record<string, unknown>
  const tuiConfig = record.provider === 'opencode' && typeof record.tuiConfig === 'string'
    ? JSON.parse(record.tuiConfig) as { plugin?: string[]; [key: string]: unknown }
    : record.tuiConfig
  if (tuiConfig && typeof tuiConfig === 'object' && Array.isArray(tuiConfig.plugin)) {
    tuiConfig.plugin = tuiConfig.plugin.map(plugin => plugin.endsWith('/freshell-rebind-plugin.ts')
      ? '<freshell-rebind-plugin>' : plugin)
  }
  return {
    provider: record.provider,
    argv: ordinaryProviderArgs(record.argv, record.provider),
    cwd: '<workspace>',
    env: {
      FRESHELL: env.FRESHELL,
      FRESHELL_URL_PRESENT: typeof env.FRESHELL_URL === 'string' && env.FRESHELL_URL.length > 0,
      FRESHELL_TOKEN_PRESENT: env.FRESHELL_TOKEN_PRESENT,
      FRESHELL_TERMINAL_ID_PRESENT: Boolean(env.FRESHELL_TERMINAL_ID),
      FRESHELL_TAB_ID: env.FRESHELL_TAB_ID,
      FRESHELL_PANE_ID: env.FRESHELL_PANE_ID,
      ...(record.provider === 'opencode'
        ? { OPENCODE_TUI_CONFIG_PRESENT: Boolean(env.OPENCODE_TUI_CONFIG) }
        : {}),
    },
    providerConfig: record.providerConfig,
    providerPlugin: record.providerPlugin,
    projectedProjectConfig: record.projectedProjectConfig,
    tuiConfig,
    inlineConfig: record.inlineConfig,
    projectPlugin: record.projectPlugin,
    projectConfig: record.projectConfig,
    nativeSession: record.nativeSession?.source === 'argv'
      ? { source: 'argv', value: '<provider-session-id>' }
      : record.nativeSession,
    mcpRecipePresent: record.mcpRecipePresent,
  }
}

function makeReadableTree(directory: string): void {
  fs.chmodSync(directory, 0o755)
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      fs.chmodSync(file, 0o755)
      makeReadableTree(file)
    } else {
      fs.chmodSync(file, 0o644)
    }
  }
}

describe('ordinary and managed terminal provider parity', () => {
  let rig: ManagedRuntimeBrowserRig
  let workspace: string
  let webHome: string
  let xdgConfigHome: string
  let inheritedFreshellUrl: string | undefined
  const sockets: TerminalWire[] = []

  beforeAll(async () => {
    inheritedFreshellUrl = process.env.FRESHELL_URL
    delete process.env.FRESHELL_URL
    workspace = fs.mkdtempSync(path.join(root, '.provider-parity-'))
    webHome = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-parity-home-'))
    xdgConfigHome = path.join(webHome, 'custom-xdg')
    fs.mkdirSync(path.join(xdgConfigHome, 'opencode'), { recursive: true })
    fs.writeFileSync(path.join(xdgConfigHome, 'opencode/tui.jsonc'), '{ // home-selected\n  "plugin": ["file://home-selected-tui.js"]\n}\n')
    fs.chmodSync(workspace, 0o777)
    fs.mkdirSync(path.join(workspace, '.opencode'), { mode: 0o777 })
    fs.writeFileSync(path.join(workspace, 'opencode.jsonc'), '{ // provider parity\n  "plugin": ["file://parity-plugin.js"]\n}\n')
    fs.writeFileSync(path.join(workspace, '.opencode/opencode.json'), JSON.stringify({ plugin: ['file://parity-plugin.js'] }))
    fs.writeFileSync(path.join(workspace, 'parity-plugin.js'), 'export default {}\n')
    fs.writeFileSync(path.join(workspace, 'user-tui.jsonc'), '{ // user-selected\n  "plugin": ["file://user-selected-tui.js"]\n}\n')
    fs.chmodSync(path.join(workspace, '.opencode'), 0o777)
    for (const [source, target] of [
      [fixture, 'parity-provider.mjs'],
      [path.join(root, 'test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs'), 'fake-app-server.mjs'],
      [path.join(root, 'test/e2e-browser/fixtures/fake-codex-terminal.mjs'), 'fake-codex-terminal.mjs'],
      [path.join(root, 'test/e2e-browser/fixtures/fake-opencode-terminal.mjs'), 'fake-opencode-terminal.mjs'],
      [path.join(root, 'test/e2e-browser/fixtures/fake-opencode.cjs'), 'fake-opencode.cjs'],
    ] as const) fs.copyFileSync(source, path.join(workspace, target))
    fs.mkdirSync(path.join(workspace, 'node_modules'), { mode: 0o755 })
    fs.cpSync(fs.realpathSync(path.join(root, 'node_modules/ws')), path.join(workspace, 'node_modules/ws'), { recursive: true })
    makeReadableTree(path.join(workspace, 'node_modules/ws'))
    for (const provider of providers) {
      const wrapper = path.join(workspace, `parity-${provider}`)
      const script = provider === 'codex' || provider === 'opencode'
        ? `#!/usr/bin/env node\nconst target = process.argv.includes(${JSON.stringify(provider === 'codex' ? 'app-server' : 'serve')}) ? ${JSON.stringify(path.join(workspace, provider === 'codex' ? 'fake-app-server.mjs' : 'fake-opencode.cjs'))} : ${JSON.stringify(path.join(workspace, 'parity-provider.mjs'))}\nvoid import(target).catch(error => { console.error(error); process.exitCode = 1 })\n`
        : `#!/usr/bin/env node\nimport ${JSON.stringify(path.join(workspace, 'parity-provider.mjs'))}\n`
      fs.writeFileSync(wrapper, script, { mode: 0o755 })
      fs.chmodSync(wrapper, 0o755)
    }
    rig = new ManagedRuntimeBrowserRig(root, 2, {
      NODE_OPTIONS: '',
      FRESHELL_BIND_HOST: '0.0.0.0',
      XDG_CONFIG_HOME: xdgConfigHome,
      OPENCODE_TUI_CONFIG: path.join(xdgConfigHome, 'opencode/tui.jsonc'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { vendor: {
        type: 'local', command: ['vendor-tool', '--token', nestedSecretMarker],
        endpoint: `https://${nestedSecretMarker}.example`,
      } } }),
      ...Object.fromEntries(
        providers.map(provider => [`${provider.toUpperCase()}_CMD`, path.join(workspace, `parity-${provider}`)]),
      ),
    }, { NODE_OPTIONS: '', XDG_CONFIG_HOME: xdgConfigHome }, 'test', {
      enabledProviders: providers,
      providerSettings: {
        claude: { model: 'haiku', effort: 'low' },
        codex: { model: 'gpt-5.6-luna', effort: 'low' },
        opencode: { model: 'openai/gpt-5.6-luna', effort: 'low' },
        amplifier: { model: 'glm-5.3', effort: 'provider-default' },
      },
    }, webHome)
    await rig.start()
    for (const [directory, filename, content] of [
      ['.claude', 'settings.json', JSON.stringify({ paritySetting: true })],
      ['.codex', 'config.toml', 'parity_setting = true\n'],
      ['custom-xdg/opencode', 'opencode.jsonc', '{ "plugin": ["file://user-parity-plugin.js"] }\n'],
      ['.amplifier', 'config.yaml', 'parity_setting: true\n'],
    ]) {
      const location = path.join(rig.info.homeDir, directory)
      fs.mkdirSync(location, { recursive: true })
      fs.writeFileSync(path.join(location, filename), content)
    }
    for (const [directory, relative, content] of [
      ['.claude', 'plugins/parity-plugin.txt', 'claude parity plugin\n'],
      ['.codex', 'skills/parity/SKILL.md', 'codex parity skill\n'],
      ['custom-xdg/opencode', 'plugins/parity-plugin.js', 'export default { name: "parity" }\n'],
      ['.amplifier', 'bundles/parity-bundle.yaml', 'name: parity\n'],
    ]) {
      const target = path.join(rig.info.homeDir, directory, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
  }, 900_000)

  beforeEach(() => {
    // Vitest shuffles cases. Each case sees the same user-owned inputs even
    // when a prior recovery case edited them to exercise refresh semantics.
    fs.writeFileSync(path.join(xdgConfigHome, 'opencode/tui.jsonc'), '{ // home-selected\n  "plugin": ["file://home-selected-tui.js"]\n}\n')
    fs.writeFileSync(path.join(workspace, '.opencode/opencode.json'), JSON.stringify({ plugin: ['file://parity-plugin.js'] }))
    const userConfig = path.join(xdgConfigHome, 'opencode')
    fs.writeFileSync(path.join(userConfig, 'opencode.jsonc'), '{ "plugin": ["file://user-parity-plugin.js"] }\n')
    fs.rmSync(path.join(userConfig, 'new-provider.jsonc'), { force: true })
    fs.writeFileSync(path.join(userConfig, 'plugins/parity-plugin.js'), 'export default { name: "parity" }\n')
  })

  afterAll(async () => {
    try {
      await Promise.allSettled(sockets.map(socket => socket.close()))
      if (rig) {
        const cleanup = await rig.stop()
        expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
      }
    } finally {
      if (workspace) fs.rmSync(workspace, { recursive: true, force: true })
      if (webHome) fs.rmSync(webHome, { recursive: true, force: true })
      if (inheritedFreshellUrl === undefined) delete process.env.FRESHELL_URL
      else process.env.FRESHELL_URL = inheritedFreshellUrl
    }
  }, 180_000)

  it.each(providers)('%s preserves provider-visible launch and MCP behavior', async provider => {
    const observed: RecordRow[] = []
    const mcpResults: RecordRow[] = []
    const identities: RecordRow[] = []
    let managedSoulId: string | undefined
    for (const managed of [false, true]) {
      if (provider === 'opencode') makeReadableTree(path.join(workspace, '.opencode'))
      const wire = await TerminalWire.connect(rig.info, managed)
      sockets.push(wire)
      let terminalId: string
      try {
        ;({ terminalId } = await wire.create(provider, workspace))
      } catch (error) {
        throw new Error(`${managed ? 'managed' : 'ordinary'} ${provider} create: ${String(error)}`)
      }
      const launch = await waitFor(`${provider} ${managed ? 'managed' : 'ordinary'} launch`, () => (
        wire.recordRows().find(row => row.provider === provider && row.kind === 'launch')
      )).catch(error => {
        throw new Error(`${String(error)}; records: ${JSON.stringify(wire.recordRows())}; output: ${wire.terminalOutput()}`)
      })
      observed.push(launch)
      if (provider === 'opencode' && managed) {
        const view = await waitFor('managed OpenCode container for secret inspection', async () => {
          const value = await rig.runningViewForTerminal(terminalId)
          return value?.containerId ? value : undefined
        })
        if (!view.containerId) throw new Error('managed OpenCode container missing')
        managedSoulId = view.soulId
        expect(JSON.stringify(rig.runtime.inspectContainer(view.containerId))).not.toContain(nestedSecretMarker)
        expect(rig.runtime.containerLogs(view.containerId)).not.toContain(nestedSecretMarker)
        expect(rig.runtime.containerLogs(rig.supervisor.containerId)).not.toContain(nestedSecretMarker)
        if (fs.existsSync(rig.info.debugLogPath)) {
          expect(fs.readFileSync(rig.info.debugLogPath, 'utf8')).not.toContain(nestedSecretMarker)
        }
      }
      const mcp = await waitFor(`${provider} ${managed ? 'managed' : 'ordinary'} MCP probe`, () => (
        wire.recordRows().find(row => row.provider === provider && row.kind === 'mcp')
      ))
      mcpResults.push(mcp)
      if (provider !== 'amplifier') {
        expect(mcp.error, `${provider} ${managed ? 'managed' : 'ordinary'} MCP probe`).toBeUndefined()
        expect(mcp.tools).toContain('freshell')
        expect(mcp.isError).toBe(false)
        expect(mcp.call?.ok).toBe(true)
        expect(mcp.authenticatedCall).toMatchObject({ isError: false, count: 0, truncated: false })
      }
      if (provider === 'codex' || provider === 'opencode') {
        wire.send({ type: 'terminal.input', terminalId, data: 'provider parity prompt\r' })
        identities.push(await waitFor(`${provider} ${managed ? 'managed' : 'ordinary'} native identity`, () => (
          wire.recordRows().find(row => row.provider === provider && row.kind === 'identity' && row.terminalId === terminalId)
        )))
      }
    }
    expect(normalized(observed[1])).toEqual(normalized(observed[0]))
    if (provider === 'opencode') {
      const selected = JSON.parse(observed[1].tuiConfig)
      expect(selected.plugin, `managed TUI: ${observed[1].tuiConfig}; direct TUI: ${observed[0].tuiConfig}`).toContain('file://home-selected-tui.js')
      expect(selected.plugin.some((plugin: string) => plugin.endsWith('/freshell-rebind-plugin.ts'))).toBe(true)
      expect(observed[1].inlineConfig).toEqual(observed[0].inlineConfig)
      expect(observed[1].inlineConfig).toMatch(/^[a-f0-9]{64}$/)
    }
    if (provider === 'claude' || provider === 'amplifier') {
      expect(observed[0].nativeSession).toMatchObject({ source: 'argv', value: expect.any(String) })
      expect(observed[1].nativeSession).toMatchObject({ source: 'argv', value: expect.any(String) })
    } else {
      expect(observed.map(row => row.nativeSession?.source)).toEqual(['provider-store', 'provider-store'])
      expect(identities).toHaveLength(2)
      for (const identity of identities) {
        expect(identity.nativeSession).toMatchObject({ source: 'provider-store', value: expect.any(String) })
        expect(identity.nativeSession.value).not.toBe('')
      }
    }
    expect(mcpResults[1]).toMatchObject(provider === 'amplifier'
      ? { error: mcpResults[0].error }
      : { tools: mcpResults[0].tools, call: mcpResults[0].call })
    expect(observed[1].mcpRecipePresent).toBe(observed[0].mcpRecipePresent)
    if (managedSoulId) await rig.stopSoul(managedSoulId)
  }, 180_000)

  it('resumed OpenCode child sees refreshed config and keeps provider-owned state', async () => {
    const wire = await TerminalWire.connect(rig.info, true)
    sockets.push(wire)
    const { terminalId } = await wire.create('opencode', workspace)
    const first = await waitFor('initial OpenCode launch', () => wire.recordRows().find(row => (
      row.provider === 'opencode' && row.kind === 'launch'
    )))
    const initialMcp = await waitFor('initial OpenCode MCP probe', () => wire.recordRows().find(row => (
      row.provider === 'opencode' && row.kind === 'mcp'
    )))
    expect(initialMcp.authenticatedCall).toMatchObject({ isError: false, count: 0 })
    wire.send({ type: 'terminal.input', terminalId, data: 'replacement parity prompt\r' })
    await waitFor('OpenCode native identity', () => wire.recordRows().find(row => (
      row.kind === 'identity' && row.terminalId === terminalId
    )))
    await waitFor('OpenCode resume evidence before replacement', async () => {
      const view = (await rig.inventory()).find((row: any) => row.terminalId === terminalId)
      return view?.durabilityState === 'resume_captured' ? view : undefined
    }, 45_000)
    const before = await waitFor('running OpenCode incarnation', async () => {
      const view = await rig.runningViewForTerminal(terminalId)
      return view?.containerId ? view : undefined
    })
    if (!before.containerId) throw new Error('initial OpenCode container missing')
    rig.ownedProviderExec(before.containerId, ['sh', '-c',
      'printf provider-owned-state > /home/freshell/provider/.config/opencode/plugins/provider-owned.txt'])
    fs.writeFileSync(path.join(xdgConfigHome, 'opencode/new-provider.jsonc'), '{"replacement":true}\n')
    fs.writeFileSync(path.join(xdgConfigHome, 'opencode/opencode.jsonc'), '{"replacementOriginal":true}\n')
    fs.rmSync(path.join(xdgConfigHome, 'opencode/plugins/parity-plugin.js'))
    fs.rmSync(path.join(workspace, '.opencode/opencode.json'))
    const editedTui = '{ // changed before replacement\n  "theme": "light"\n}\n'
    fs.writeFileSync(path.join(xdgConfigHome, 'opencode/tui.jsonc'), editedTui)
    rig.runtime.killOwnedRuntimeExact(before.containerId)
    const after = await waitFor('replacement OpenCode incarnation', async () => {
      const view = await rig.runningViewForTerminal(terminalId)
      return view?.containerId && view.incarnationId !== before.incarnationId ? view : undefined
    }, 300_000).catch(async error => {
      const inventory = await rig.inventory()
      const supervisorLogs = rig.runtime.containerLogs(rig.supervisor.containerId)
      throw new Error(`${String(error)}; inventory: ${JSON.stringify(inventory)}; supervisor logs: ${supervisorLogs}`)
    })
    expect(after.soulId).toBe(before.soulId)
    await wire.wait(frame => frame.type === 'terminal.stream.changed'
      && frame.terminalId === terminalId
      && frame.reason === 'new_pty_session'
      && frame.streamId !== before.terminalStreamId, 10_000)
    await wire.attach(terminalId)
    const resumed = await waitFor('resumed OpenCode child observation', () => wire.recordRows().find(row => (
      row.provider === 'opencode' && row.kind === 'launch' && row.launchId !== first.launchId
    )), 90_000)
    expect(resumed.providerConfig['new-provider.jsonc']).toEqual({ replacement: true })
    expect(resumed.providerConfig['opencode.jsonc']).toEqual({ replacementOriginal: true })
    expect(resumed.providerPlugin).toBeNull()
    expect(resumed.projectConfig.dotOpencodeJson).toBeNull()
    expect(resumed.projectedProjectConfig).toBeNull()
    expect(resumed.providerOwned).toBe('provider-owned-state')
    expect(JSON.parse(resumed.tuiConfig)).toMatchObject({ theme: 'light' })
    expect(JSON.parse(resumed.tuiConfig).plugin.some((plugin: string) => plugin.endsWith('/freshell-rebind-plugin.ts'))).toBe(true)
    expect(fs.readFileSync(path.join(xdgConfigHome, 'opencode/tui.jsonc'), 'utf8')).toBe(editedTui)
    expect(resumed.tuiConfig).not.toBe(first.tuiConfig)
    const resumedMcp = await waitFor('resumed OpenCode MCP probe', () => wire.recordRows().filter(row => (
      row.provider === 'opencode' && row.kind === 'mcp'
    ))[1], 90_000).catch(error => {
      throw new Error(`${String(error)}; records: ${JSON.stringify(wire.recordRows())}; output: ${wire.terminalOutput()}`)
    })
    expect(resumedMcp.authenticatedCall).toMatchObject({ isError: false, count: 0 })
  }, 360_000)

  it('relays a managed OpenCode session switch and restores that native session', async () => {
    const wire = await TerminalWire.connect(rig.info, true)
    sockets.push(wire)
    const { terminalId } = await wire.create('opencode', workspace)
    wire.send({ type: 'terminal.input', terminalId, data: 'session switch setup\r' })
    const initial = await waitFor('initial managed OpenCode identity', () => wire.recordRows().find(row => (
      row.kind === 'identity' && row.terminalId === terminalId
    )))
    const before = await waitFor('managed OpenCode container before switch', async () => {
      const view = await rig.runningViewForTerminal(terminalId)
      return view?.containerId ? view : undefined
    })
    if (!before.containerId) throw new Error('managed OpenCode container missing')
    const switchedId = `ses_ParitySwitch${Date.now()}`
    const writeSignal = `
      const fs = require('node:fs')
      const path = require('node:path')
      const { DatabaseSync } = require('node:sqlite')
      const [previous, next, terminal] = process.argv.slice(1)
      const home = '/home/freshell/provider'
      const db = new DatabaseSync(path.join(home, '.local/share/opencode/opencode.db'))
      const changed = db.prepare('UPDATE session SET id = ? WHERE id = ?').run(next, previous)
      db.close()
      if (changed.changes !== 1) throw new Error('native session row was not available')
      const signals = path.join(home, '.freshell/session-signals/opencode')
      fs.mkdirSync(signals, { recursive: true })
      fs.writeFileSync(path.join(signals, terminal + '__' + Date.now() + '.json'),
        JSON.stringify({ session_id: next }))
    `
    rig.ownedProviderExec(before.containerId, [
      'node', '-e', writeSignal, initial.nativeSession.value, switchedId, terminalId,
    ])
    await wire.wait(frame => frame.type === 'terminal.session.associated'
      && frame.terminalId === terminalId && frame.sessionRef?.sessionId === switchedId, 30_000).catch(async error => {
      throw new Error(`${String(error)}; inventory: ${JSON.stringify(await rig.inventory())}; web: ${rig.web.capturedOutput().slice(-3000)}`)
    })
    await wire.wait(frame => frame.type === 'terminal.meta.updated'
      && frame.upsert?.some((row: any) => row.terminalId === terminalId && row.sessionId === switchedId), 30_000)
    await waitFor('switched OpenCode exact resume evidence', async () => {
      const view = (await rig.inventory()).find((row: any) => row.terminalId === terminalId)
      return view?.nativeSessionId === switchedId && view?.durabilityState === 'resume_captured' ? view : undefined
    }, 20_000).catch(async error => {
      throw new Error(`${String(error)}; inventory: ${JSON.stringify(await rig.inventory())}; supervisor: ${rig.runtime.containerLogs(rig.supervisor.containerId).slice(-4000)}`)
    })
    rig.runtime.killOwnedRuntimeExact(before.containerId)
    const after = await waitFor('replacement OpenCode incarnation after native switch', async () => {
      const view = await rig.runningViewForTerminal(terminalId)
      return view?.containerId && view.incarnationId !== before.incarnationId ? view : undefined
    }, 120_000).catch(async error => {
      throw new Error(`${String(error)}; inventory: ${JSON.stringify(await rig.inventory())}; supervisor: ${rig.runtime.containerLogs(rig.supervisor.containerId).slice(-4000)}; web: ${rig.web.capturedOutput().slice(-4000)}`)
    })
    expect(after.soulId).toBe(before.soulId)
    expect((await rig.inventory()).find((row: any) => row.terminalId === terminalId)?.nativeSessionId).toBe(switchedId)
    await wire.wait(frame => frame.type === 'terminal.stream.changed'
      && frame.terminalId === terminalId && frame.streamId !== before.terminalStreamId, 30_000)
    await wire.attach(terminalId)
    const resumed = await waitFor('resumed switched OpenCode launch', () => wire.recordRows().find(row => (
      row.provider === 'opencode' && row.kind === 'launch' && row.argv.includes(switchedId)
    )), 90_000)
    expect(resumed.argv).toContain(switchedId)
  }, 360_000)

  it('recovers OpenCode inline and home JSONC TUI inputs after web restart with its container down', async () => {
    const wire = await TerminalWire.connect(rig.info, true)
    sockets.push(wire)
    const { terminalId, requestId } = await wire.create('opencode', workspace)
    const first = await waitFor('initial OpenCode launch before web restart', () => wire.recordRows().find(row => (
      row.provider === 'opencode' && row.kind === 'launch'
    )))
    wire.send({ type: 'terminal.input', terminalId, data: 'restart recovery prompt\r' })
    await waitFor('OpenCode native identity before web restart', () => wire.recordRows().find(row => (
      row.kind === 'identity' && row.terminalId === terminalId
    )))
    const before = await waitFor('OpenCode container before web restart', async () => {
      const view = await rig.runningViewForTerminal(terminalId)
      return view?.containerId ? view : undefined
    })
    if (!before.containerId) throw new Error('initial OpenCode container missing')
    await rig.web.kill()
    const editedTui = '{ // changed while web is down\n  "theme": "solarized"\n}\n'
    fs.writeFileSync(path.join(xdgConfigHome, 'opencode/tui.jsonc'), editedTui)
    rig.runtime.killOwnedRuntimeExact(before.containerId)
    await rig.restartWebGracefully()
    const after = await waitFor('replacement after web restart', async () => {
      const view = await rig.runningViewForTerminal(terminalId)
      return view?.containerId && view.incarnationId !== before.incarnationId ? view : undefined
    }, 300_000)
    expect(after.soulId).toBe(before.soulId)
    const recoveredWire = await TerminalWire.connect(rig.info, true)
    sockets.push(recoveredWire)
    const reconcileId = `provider-parity-reconcile-${randomUUID()}`
    recoveredWire.send({
      type: 'pane.reconcile.request', reconcileId,
      panes: [{ paneKey: 'tab-opencode:pane-opencode', kind: 'terminal', mode: 'opencode',
        createRequestId: requestId, terminalId }],
    })
    const reconcile = await recoveredWire.wait(frame => frame.type === 'pane.reconcile.result'
      && frame.reconcileId === reconcileId, 30_000)
    expect(reconcile.verdicts[0].verdict).toBe('attach')
    await recoveredWire.attach(terminalId)
    const resumed = await waitFor('resumed OpenCode child after web restart', () => recoveredWire.recordRows().find(row => (
      row.provider === 'opencode' && row.kind === 'launch' && row.launchId !== first.launchId
    )), 90_000).catch(error => {
      throw new Error(`${String(error)}; records: ${JSON.stringify(recoveredWire.recordRows())}; output: ${recoveredWire.terminalOutput()}`)
    })
    expect(resumed.inlineConfig).toBe(first.inlineConfig)
    expect(resumed.inlineConfig).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(resumed.tuiConfig)).toMatchObject({ theme: 'solarized' })
    expect(JSON.parse(resumed.tuiConfig).plugin.some((plugin: string) => plugin.endsWith('/freshell-rebind-plugin.ts'))).toBe(true)
    expect(fs.readFileSync(path.join(xdgConfigHome, 'opencode/tui.jsonc'), 'utf8')).toBe(editedTui)
    expect(resumed.tuiConfig).not.toBe(first.tuiConfig)
    const resumedMcp = await waitFor('resumed OpenCode MCP after web restart', () => recoveredWire.recordRows().find(row => (
      row.provider === 'opencode' && row.kind === 'mcp'
    )), 90_000)
    expect(resumedMcp.authenticatedCall).toMatchObject({ isError: false, count: 0 })
  }, 360_000)
})
