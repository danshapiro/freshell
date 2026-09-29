import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig } from '../../e2e-browser/helpers/managed-runtime.js'

type Provider = 'claude' | 'codex' | 'opencode' | 'amplifier'
type RecordRow = { provider: Provider; kind: 'launch' | 'mcp' | 'identity'; [key: string]: any }
const root = path.resolve(import.meta.dirname, '../../..')
const fixture = path.join(root, 'test/fixtures/providers/parity-provider.mjs')
const providers: Provider[] = ['claude', 'codex', 'opencode', 'amplifier']

async function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
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
      capabilities: managed ? { managedRuntimeV1: true } : {},
    })
    const ready = await wire.wait(frame => frame.type === 'ready', 10_000)
    if (managed) expect(ready.capabilities?.managedRuntimeV1).toBe(true)
    return wire
  }

  send(frame: unknown): void { this.socket.send(JSON.stringify(frame)) }

  recentFrames(): any[] { return this.frames.slice(-12) }
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
    const attachRequestId = `provider-parity-attach-${randomUUID()}`
    this.send({ type: 'terminal.attach', terminalId: frame.terminalId, intent: 'viewport_hydrate',
      cols: 80, rows: 24, sinceSeq: 0, attachRequestId, priority: 'background' })
    await this.wait(message => message.type === 'terminal.attach.ready'
      && message.terminalId === frame.terminalId && message.attachRequestId === attachRequestId, 10_000)
    return { requestId, terminalId: frame.terminalId }
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
      OPENCODE_TUI_CONFIG_PRESENT: Boolean(env.OPENCODE_TUI_CONFIG),
    },
    providerConfig: record.providerConfig,
    providerPlugin: record.providerPlugin,
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
  let inheritedFreshellUrl: string | undefined
  const sockets: TerminalWire[] = []

  beforeAll(async () => {
    inheritedFreshellUrl = process.env.FRESHELL_URL
    delete process.env.FRESHELL_URL
    workspace = fs.mkdtempSync(path.join(root, '.provider-parity-'))
    fs.chmodSync(workspace, 0o777)
    fs.mkdirSync(path.join(workspace, '.opencode'), { mode: 0o777 })
    fs.writeFileSync(path.join(workspace, 'opencode.jsonc'), '{ // provider parity\n  "plugin": ["file://parity-plugin.js"]\n}\n')
    fs.writeFileSync(path.join(workspace, '.opencode/opencode.json'), JSON.stringify({ plugin: ['file://parity-plugin.js'] }))
    fs.writeFileSync(path.join(workspace, 'parity-plugin.js'), 'export default {}\n')
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
      FRESHELL_BIND_HOST: '0.0.0.0',
      ...Object.fromEntries(
        providers.map(provider => [`${provider.toUpperCase()}_CMD`, path.join(workspace, `parity-${provider}`)]),
      ),
    }, {}, 'test', {
      enabledProviders: providers,
      providerSettings: {
        claude: { model: 'haiku', effort: 'low' },
        codex: { model: 'gpt-5.6-luna', effort: 'low' },
        opencode: { model: 'openai/gpt-5.6-luna', effort: 'low' },
        amplifier: { model: 'glm-5.3', effort: 'provider-default' },
      },
    })
    await rig.start()
    for (const [directory, filename, content] of [
      ['.claude', 'settings.json', JSON.stringify({ paritySetting: true })],
      ['.codex', 'config.toml', 'parity_setting = true\n'],
      ['.config/opencode', 'opencode.jsonc', '{ "plugin": ["file://user-parity-plugin.js"] }\n'],
      ['.amplifier', 'config.yaml', 'parity_setting: true\n'],
    ]) {
      const location = path.join(rig.info.homeDir, directory)
      fs.mkdirSync(location, { recursive: true })
      fs.writeFileSync(path.join(location, filename), content)
    }
    for (const [directory, relative, content] of [
      ['.claude', 'plugins/parity-plugin.txt', 'claude parity plugin\n'],
      ['.codex', 'skills/parity/SKILL.md', 'codex parity skill\n'],
      ['.config/opencode', 'plugins/parity-plugin.js', 'export default { name: "parity" }\n'],
      ['.amplifier', 'bundles/parity-bundle.yaml', 'name: parity\n'],
    ]) {
      const target = path.join(rig.info.homeDir, directory, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
  }, 900_000)

  afterAll(async () => {
    try {
      await Promise.allSettled(sockets.map(socket => socket.close()))
      if (rig) {
        const cleanup = await rig.stop()
        expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
      }
    } finally {
      if (workspace) fs.rmSync(workspace, { recursive: true, force: true })
      if (inheritedFreshellUrl === undefined) delete process.env.FRESHELL_URL
      else process.env.FRESHELL_URL = inheritedFreshellUrl
    }
  }, 180_000)

  it.each(providers)('%s preserves provider-visible launch and MCP behavior', async provider => {
    const observed: RecordRow[] = []
    const mcpResults: RecordRow[] = []
    const identities: RecordRow[] = []
    for (const managed of [false, true]) {
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
        throw new Error(`${String(error)}; recent frames: ${JSON.stringify(wire.recentFrames())}`)
      })
      observed.push(launch)
      const mcp = await waitFor(`${provider} ${managed ? 'managed' : 'ordinary'} MCP probe`, () => (
        wire.recordRows().find(row => row.provider === provider && row.kind === 'mcp')
      ))
      mcpResults.push(mcp)
      if (provider !== 'amplifier') {
        expect(mcp.error).toBeUndefined()
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
  }, 180_000)
})
