import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig } from '../../e2e-browser/helpers/managed-runtime.js'
import { exposeGrantsToHarness, fakeOnecliGrants, withMissingGrant } from '../../helpers/provider-parity-onecli.js'
import { makeProviderParityResourcesReadable, prepareProviderParityUserRoots, providerParityCommands, providerParityFailureDiagnostics, writeProviderParityEnvironment } from '../../helpers/provider-parity-environment.js'
import { authorizeProviderParityRequest, captureProviderParityVolumes, cleanupProviderParityVolumes } from '../../helpers/provider-parity-broker.js'
import type { InitialProviderVolumeAuthorization } from '../../../scripts/testing/runtime-test-broker.js'

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

  wait(predicate: (frame: any) => boolean, timeoutMs: number, fromIndex = 0): Promise<any> {
    return waitFor('WebSocket frame', () => this.frames.slice(fromIndex).find(predicate), timeoutMs).catch(error => {
      throw new Error(`${String(error)}; received ${JSON.stringify(this.frames.slice(-12))}`)
    })
  }

  async create(provider: Provider, cwd: string, authorize?: (requestId: string) => void): Promise<{ requestId: string; terminalId: string }> {
    const requestId = `provider-parity-${provider}-${randomUUID()}`
    authorize?.(requestId)
    this.send({ type: 'terminal.create', requestId, mode: provider, shell: 'system', cwd, tabId: `tab-${provider}`, paneId: `pane-${provider}` })
    const frame = await this.wait(message => (
      message.requestId === requestId && (message.type === 'terminal.created' || message.type === 'error')
    ), 90_000)
    if (frame.type === 'error') throw new Error(`${provider} terminal.create failed: ${JSON.stringify(frame)}`)
    await this.attach(frame.terminalId)
    return { requestId, terminalId: frame.terminalId }
  }

  async attach(terminalId: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const attachRequestId = `provider-parity-attach-${randomUUID()}`
      const fromIndex = this.frames.length
      this.send({ type: 'terminal.attach', terminalId, intent: 'viewport_hydrate',
        cols: 80, rows: 24, sinceSeq: 0, attachRequestId, priority: 'background' })
      const frame = await this.wait(message => message.terminalId === terminalId && (
        (message.type === 'terminal.attach.ready' && message.attachRequestId === attachRequestId)
        || (message.type === 'error' && message.code === 'INTERNAL_ERROR'
          && message.message?.includes('managed output read timed out'))
      ), 10_000, fromIndex)
      if (frame.type === 'terminal.attach.ready') return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`managed output replay timed out repeatedly for ${terminalId}`)
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
    if (arg === '--mcp-config' || arg === '--mcp-config-file') {
      result.push(arg, '<managed-mcp-config>')
      index++
      continue
    }
    if (arg === '-c' && argv[index + 1]?.startsWith('mcp_servers.freshell.')) {
      const setting = argv[index + 1].slice(0, argv[index + 1].indexOf('=') + 1)
      result.push(arg, `${setting}<managed-mcp-command>`)
      index++
      continue
    }
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

function normalized(record: RecordRow) {
  const env = record.env as Record<string, unknown>
  const tuiConfig = record.provider === 'opencode' && typeof record.tuiConfig === 'string'
    ? JSON.parse(record.tuiConfig) as { plugin?: string[]; [key: string]: unknown }
    : record.tuiConfig
  if (tuiConfig && typeof tuiConfig === 'object' && Array.isArray(tuiConfig.plugin)) {
    tuiConfig.plugin = tuiConfig.plugin.map((plugin: string) => plugin === record.rebindPlugin?.spec
      && record.rebindPlugin?.hello === true && record.rebindPlugin?.sessionId === 'ses_parity'
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
    providerConfig: Object.fromEntries(Object.entries(record.providerConfig ?? {}).map(([name, value]) => {
      if (record.provider !== 'opencode' || name !== 'opencode.jsonc') return [name, value]
      const config = typeof value === 'string' ? JSON.parse(value) : structuredClone(value)
      // The actual child separately consumes both references. Their transported
      // paths legitimately differ between ordinary and managed HOME.
      if (config.agent?.parity) config.agent.parity = { prompt: '<selected-reference>', description: '<selected-reference>' }
      return [name, config]
    })),
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

describe('managed provider parity argv comparison', () => {
  it.each([
    {
      provider: 'claude' as const,
      first: ['--model', 'haiku', '--effort', 'low', '-p', 'prompt'],
      reordered: ['--effort', 'low', '--model', 'haiku', '-p', 'prompt'],
    },
    {
      provider: 'codex' as const,
      first: ['--model', 'gpt-5.6-luna', '--sandbox', 'workspace-write', 'app-server'],
      reordered: ['--sandbox', 'workspace-write', '--model', 'gpt-5.6-luna', 'app-server'],
    },
  ])('$provider flag order remains provider-visible', ({ provider, first, reordered }) => {
    const record = (argv: string[]): RecordRow => ({
      provider,
      kind: 'launch',
      argv,
      env: {},
    })

    expect(normalized(record(first))).not.toEqual(normalized(record(reordered)))
  })
})

describe('ordinary and managed terminal provider parity', () => {
  let rig: ManagedRuntimeBrowserRig
  let initialProviderSource: Omit<InitialProviderVolumeAuthorization, 'soulId' | 'providerVolumeName'>
  let workspace: string
  let webHome: string
  let xdgConfigHome: string
  let inheritedFreshellUrl: string | undefined
  let inheritedProviderEnvironment: Record<string, string | undefined> = {}
  let onecli: ReturnType<typeof fakeOnecliGrants>
  let restoreOnecliEnvironment: (() => void) | undefined
  const sockets: TerminalWire[] = []
  const registeredVolumes: (InitialProviderVolumeAuthorization & { requestId: string })[] = []
  const userOpencodeConfig = () => JSON.stringify({
    plugin: [pathToFileURL(path.join(xdgConfigHome, 'opencode/plugins/parity-plugin.js')).href],
    agent: { parity: {
      prompt: '{file:./parity-policy.txt}',
      description: `{file:${path.join(webHome, 'absolute-policy.txt')}}`,
    } },
  })
  const homeTuiConfig = () => JSON.stringify({
    plugin: [pathToFileURL(path.join(xdgConfigHome, 'opencode/home-selected-tui.js')).href],
  })
  const projectOpencodeConfig = () => JSON.stringify({
    plugin: [pathToFileURL(path.join(workspace, 'parity-plugin.js')).href],
  })

  beforeAll(async () => {
    inheritedFreshellUrl = process.env.FRESHELL_URL
    delete process.env.FRESHELL_URL
    workspace = fs.mkdtempSync(path.join(root, '.provider-parity-'))
    // Select this synthetic project, without inheriting repository-local skills.
    execFileSync('git', ['init', '--quiet', workspace])
    webHome = fs.mkdtempSync(path.join(root, '.provider-parity-home-'))
    onecli = fakeOnecliGrants(providers)
    restoreOnecliEnvironment = exposeGrantsToHarness(onecli.serverEnv)
    xdgConfigHome = path.join(webHome, 'custom-xdg')
    prepareProviderParityUserRoots(webHome, xdgConfigHome)
    fs.writeFileSync(path.join(xdgConfigHome, 'opencode/tui.jsonc'), homeTuiConfig())
    fs.writeFileSync(path.join(xdgConfigHome, 'opencode/home-selected-tui.js'), 'export default { name: "home-selected-tui" }\n')
    fs.chmodSync(workspace, 0o777)
    fs.mkdirSync(path.join(workspace, '.opencode'), { mode: 0o777 })
    fs.writeFileSync(path.join(workspace, 'opencode.jsonc'), projectOpencodeConfig())
    fs.writeFileSync(path.join(workspace, '.opencode/opencode.json'), projectOpencodeConfig())
    fs.writeFileSync(path.join(workspace, 'parity-plugin.js'), 'export default {}\n')
    fs.writeFileSync(path.join(workspace, 'user-tui.jsonc'), JSON.stringify({ plugin: [pathToFileURL(path.join(workspace, 'user-selected-tui.js')).href] }))
    fs.writeFileSync(path.join(workspace, 'user-selected-tui.js'), 'export default { name: "user-selected-tui" }\n')
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
    makeProviderParityResourcesReadable(path.join(workspace, 'node_modules'))
    for (const provider of providers) {
      const wrapper = path.join(workspace, `parity-${provider}`)
      const script = provider === 'codex' || provider === 'opencode'
        ? `#!/usr/bin/env node\nconst target = process.argv.includes(${JSON.stringify(provider === 'codex' ? 'app-server' : 'serve')}) ? ${JSON.stringify(provider === 'codex' ? './fake-app-server.mjs' : './fake-opencode.cjs')} : './parity-provider.mjs'\nvoid import(new URL(target, import.meta.url)).catch(error => { console.error(error); process.exitCode = 1 })\n`
        : `#!/usr/bin/env node\nimport './parity-provider.mjs'\n`
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
      ...onecli.serverEnv,
    }, { NODE_OPTIONS: '', XDG_CONFIG_HOME: xdgConfigHome }, 'test', {
      enabledProviders: providers,
      providerSettings: {
        claude: { model: 'haiku', effort: 'low' },
        codex: { model: 'gpt-5.6-luna', effort: 'low' },
        opencode: { model: 'openai/gpt-5.6-luna', effort: 'low' },
        amplifier: { model: 'glm-5.3', effort: 'provider-default' },
      },
    }, webHome)
    // The controller validates executables before setting a child's cwd.
    // The worker environment selects installed commands and owned OpenCode roots.
    const providerEnvironment = providerParityCommands(path.join(rig.runtime.testRoot, 'workspace'))
    inheritedProviderEnvironment = Object.fromEntries(Object.keys(providerEnvironment).map(key => [key, process.env[key]]))
    Object.assign(process.env, providerEnvironment)
    await rig.start()
    // prepare() recreates this run's root. Populate the project afterwards so
    // provider configuration discovery cannot inherit the repository's inputs.
    const preparedWorkspace = workspace
    workspace = path.join(rig.runtime.testRoot, 'workspace')
    fs.cpSync(preparedWorkspace, workspace, { recursive: true })
    // cpSync creates a private destination directory. Restore only the owned
    // project leaf's shared mode so the provider user can traverse its mount.
    fs.chmodSync(workspace, 0o777)
    makeProviderParityResourcesReadable(path.join(workspace, 'node_modules'))
    fs.rmSync(preparedWorkspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'opencode.jsonc'), projectOpencodeConfig())
    fs.writeFileSync(path.join(workspace, '.opencode/opencode.json'), projectOpencodeConfig())
    fs.writeFileSync(path.join(workspace, 'user-tui.jsonc'), JSON.stringify({ plugin: [pathToFileURL(path.join(workspace, 'user-selected-tui.js')).href] }))
    const health = await rig.runtime.adminOk(rig.supervisor, { method: 'health' })
    expect(health.kind).toBe('health')
    const daemon = await new Promise<{ ID: string }>((resolve, reject) => {
      const request = http.get({ socketPath: rig.runtime.broker.proxySocketPath, path: '/v1.47/info' }, response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', chunk => {
          size += chunk.length
          if (size > 64 * 1024) request.destroy(new Error('owned daemon metadata exceeds fixture bound'))
          else chunks.push(Buffer.from(chunk))
        })
        response.once('error', reject)
        response.once('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('owned daemon metadata unavailable')
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) { reject(error) }
        })
      })
      request.once('error', reject)
    })
    initialProviderSource = {
      installationId: health.data.installation_id,
      imageRef: rig.runtime.imageRef,
      hostBinaryPath: rig.runtime.testHostBinary,
      binarySha256: createHash('sha256').update(fs.readFileSync(rig.runtime.testHostBinary)).digest('hex'),
      daemonId: daemon.ID,
    }
    for (const [directory, filename, content] of [
      ['.claude', 'settings.json', JSON.stringify({ paritySetting: true })],
      ['.codex', 'config.toml', 'parity_setting = true\n'],
      ['custom-xdg/opencode', 'opencode.jsonc', userOpencodeConfig()],
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
    for (const [directory, relative] of [
      ['.claude', 'plugins/parity-environment'], ['.codex', 'skills/parity-environment'],
      ['custom-xdg/opencode', 'plugins/parity-environment'], ['.amplifier', 'bundles/parity-environment'],
    ]) writeProviderParityEnvironment(path.join(rig.info.homeDir, directory), relative)
    fs.writeFileSync(path.join(xdgConfigHome, 'opencode/parity-policy.txt'), 'relative-config-reference-nonce')
    fs.writeFileSync(path.join(webHome, 'absolute-policy.txt'), 'absolute-config-reference-nonce')
  }, 900_000)

  beforeEach(() => {
    // Vitest shuffles cases. Each case sees the same user-owned inputs even
    // when a prior recovery case edited them to exercise refresh semantics.
    fs.writeFileSync(path.join(xdgConfigHome, 'opencode/tui.jsonc'), homeTuiConfig())
    fs.writeFileSync(path.join(workspace, '.opencode/opencode.json'), projectOpencodeConfig())
    // Every provider observes this shared project file. Prepare the selected
    // owned subtree for the provider user independently of shuffled case order.
    makeProviderParityResourcesReadable(path.join(workspace, '.opencode'))
    const userConfig = path.join(xdgConfigHome, 'opencode')
    fs.writeFileSync(path.join(userConfig, 'opencode.jsonc'), userOpencodeConfig())
    fs.rmSync(path.join(userConfig, 'new-provider.jsonc'), { force: true })
    fs.writeFileSync(path.join(userConfig, 'plugins/parity-plugin.js'), 'export default { name: "parity" }\n')
  })

  afterAll(async () => {
    try {
      await Promise.allSettled(sockets.map(socket => socket.close()))
      if (rig) {
        let volumes: ReturnType<typeof captureProviderParityVolumes> = []
        let captureError: unknown
        try {
          volumes = captureProviderParityVolumes(registeredVolumes)
          rig.runtime.writeIncident('provider-parity-registered-volumes', volumes)
        } catch (error) { captureError = error }
        const cleanup = await rig.stop()
        expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
        if (captureError) throw captureError
        rig.runtime.writeIncident('provider-parity-registered-volume-cleanup', {
          removed: cleanupProviderParityVolumes(volumes),
        })
      }
    } finally {
      if (workspace) fs.rmSync(workspace, { recursive: true, force: true })
      if (webHome) fs.rmSync(webHome, { recursive: true, force: true })
      if (onecli) fs.rmSync(onecli.directory, { recursive: true, force: true })
      restoreOnecliEnvironment?.()
      for (const [key, value] of Object.entries(inheritedProviderEnvironment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (inheritedFreshellUrl === undefined) delete process.env.FRESHELL_URL
      else process.env.FRESHELL_URL = inheritedFreshellUrl
    }
  }, 180_000)

  it.each(providers)('%s preserves provider-visible launch and MCP behavior', async provider => {
    const observed: RecordRow[] = []
    const mcpResults: RecordRow[] = []
    const identities: RecordRow[] = []
    let managedSoulId: string | undefined
    let managedTerminalId: string | undefined
    for (const managed of [false, true]) {
      const wire = await TerminalWire.connect(rig.info, managed)
      sockets.push(wire)
      let terminalId: string
      let managedRequest: InitialProviderVolumeAuthorization | undefined
      try {
        ;({ terminalId } = await wire.create(provider, workspace, managed
          ? requestId => {
            managedRequest = authorizeProviderParityRequest(rig.runtime.broker, initialProviderSource, requestId)
            registeredVolumes.push({ ...managedRequest, requestId })
            rig.runtime.writeIncident('provider-parity-registered-requests', registeredVolumes)
          }
          : undefined))
      } catch (error) {
        if (managedRequest) {
          const receipt = rig.runtime.broker.receipts().findLast(value => value.soulId === managedRequest!.soulId && value.workspacePath === workspace)
          if (receipt) {
            const diagnostic: Record<string, unknown> = { containerId: receipt.containerId, soulId: receipt.soulId }
            const logs = rig.runtime.containerLogs(receipt.containerId)
            Object.assign(diagnostic, providerParityFailureDiagnostics(logs))
            try {
              diagnostic.guest = JSON.parse(rig.runtime.execOwnedContainerAsExact(receipt.containerId, '65534:0', [
                '/usr/local/bin/node', '-e', `
const fs=require('node:fs'),path=require('node:path');
const workspace=process.argv[1],command=process.argv[2];
function metadata(file){try{const s=fs.lstatSync(file);let executable=false,readable=false;try{fs.accessSync(file,fs.constants.X_OK);executable=true}catch{}try{fs.accessSync(file,fs.constants.R_OK);readable=true}catch{}return{mode:s.mode&511,uid:s.uid,gid:s.gid,executable,readable}}catch{return{available:false}}}
const ancestors=[];for(let current=path.dirname(command),depth=0;depth<64;depth++){ancestors.push(metadata(current));const parent=path.dirname(current);if(parent===current)break;current=parent}
const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\\n').map(line=>line.split(' ')).filter(fields=>workspace===fields[4]||workspace.startsWith(fields[4]+'/')).sort((a,b)=>b[4].length-a[4].length);
const mount=mounts[0],separator=mount?.indexOf('-');
process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),command:metadata(command),dependency:{parent:metadata(path.join(workspace,'node_modules')),package:metadata(path.join(workspace,'node_modules/ws')),entry:metadata(path.join(workspace,'node_modules/ws/index.js'))},ancestors,mount:mount?{options:mount[5],filesystem:mount[separator+1],superOptions:mount[separator+3]}:null}));
`, workspace, path.join(workspace, `parity-${provider}`),
              ]))
            } catch { diagnostic.guest = { available: false } }
            rig.runtime.writeIncident(`provider-parity-${provider}-create-failure`, diagnostic)
          }
        }
        throw new Error(`${managed ? 'managed' : 'ordinary'} ${provider} create: ${String(error)}`)
      }
      const launch = await waitFor(`${provider} ${managed ? 'managed' : 'ordinary'} launch`, () => (
        wire.recordRows().find(row => row.provider === provider && row.kind === 'launch')
      )).catch(error => {
        throw new Error(`${String(error)}; records: ${JSON.stringify(wire.recordRows())}; output: ${wire.terminalOutput()}`)
      })
      observed.push(launch)
      expect(launch.selectedEnvironment).toEqual({
        dependency: 'installed-dependency-nonce', resource: 'selected-resource-nonce', entries: 4201,
      })
      expect(launch.selectedConfigReferences).toEqual(provider === 'opencode'
        ? ['relative-config-reference-nonce', 'absolute-config-reference-nonce'] : [])
      for (const sentinel of [nestedSecretMarker, 'fixture-secret-byte']) expect(JSON.stringify(launch)).not.toContain(sentinel)
      if (managed) {
        expect(launch.childIdentity).toEqual({ uid: 65534, gid: 0 })
        expect(launch.privateTopology).toEqual({ uid: 0, gid: 0, mode: 0o710 })
        managedTerminalId = terminalId
        expect(launch.onecliChildDigest).toBe(onecli.childDigests[provider])
      } else {
        expect(launch.onecliChildDigest).not.toBe(onecli.childDigests[provider])
      }
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
      for (const sentinel of [nestedSecretMarker, 'fixture-secret-byte']) expect(JSON.stringify(mcp)).not.toContain(sentinel)
      if (provider !== 'amplifier') {
        expect(mcp.error, `${provider} ${managed ? 'managed' : 'ordinary'} MCP probe`).toBeUndefined()
        expect(mcp.tools).toContain('freshell')
        expect(mcp.isError).toBe(false)
        expect(mcp.call?.ok).toBe(true)
        expect(mcp.authenticatedCall).toMatchObject({ isError: false, count: 0, truncated: false })
      }
      wire.send({ type: 'terminal.input', terminalId, data: 'provider parity prompt\r' })
      if (provider === 'codex' || provider === 'opencode') {
        identities.push(await waitFor(`${provider} ${managed ? 'managed' : 'ordinary'} native identity`, () => (
          wire.recordRows().find(row => row.provider === provider && row.kind === 'identity' && row.terminalId === terminalId)
        )))
      }
    }
    expect(normalized(observed[1])).toEqual(normalized(observed[0]))
    if (provider === 'opencode') {
      const selected = JSON.parse(observed[1].tuiConfig)
      expect(selected.plugin, `managed TUI: ${observed[1].tuiConfig}; direct TUI: ${observed[0].tuiConfig}`)
        .toContain(pathToFileURL(path.join(xdgConfigHome, 'opencode/home-selected-tui.js')).href)
      expect(selected.plugin).toContain(observed[1].rebindPlugin.spec)
      for (const launch of observed) {
        expect(launch.rebindPlugin).toMatchObject({ entrypoint: 'freshell-rebind-plugin.ts', hello: true, sessionId: 'ses_parity' })
      }
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
    const evidenceDir = process.env.FRESHELL_PROVIDER_PARITY_ROWS_DIR
    if (evidenceDir) {
      const before = await waitFor('managed provider view for receipt', async () => {
        const view = await rig.runningViewForTerminal(managedTerminalId!)
        return view?.containerId && view.nativeSessionId ? view : undefined
      }).catch(async error => {
        throw new Error(`${String(error)}; inventory=${JSON.stringify(await rig.inventory())}`)
      })
      const probe = await rig.runtime.adminOk(rig.supervisor,
        rig.runtime.probeRecoveryBody(before.soulId))
      await waitFor(`${provider} verified resume evidence`, async () => {
        const view = await rig.runningViewForTerminal(managedTerminalId!)
        return view?.durabilityState === 'resume_captured' ? view : undefined
      }).catch(async error => {
        throw new Error(`${String(error)}; probe=${JSON.stringify(probe)}; inventory=${JSON.stringify(await rig.inventory())}`)
      })
      rig.runtime.killOwnedRuntimeExact(before.containerId!)
      const after = await waitFor(`${provider} replacement incarnation`, async () => {
        const view = await rig.runningViewForTerminal(managedTerminalId!)
        return view?.containerId && view.incarnationId !== before.incarnationId
          && view.recoveryState === 'live' ? view : undefined
      }, 90_000).catch(async error => {
        throw new Error(`${String(error)}; inventory=${JSON.stringify(await rig.inventory())}`)
      })
      expect(after.soulId).toBe(before.soulId)
      expect(after.nativeSessionId).toBe(before.nativeSessionId)
      const recoveryWire = await TerminalWire.connect(rig.info, true)
      sockets.push(recoveryWire)
      await recoveryWire.attach(managedTerminalId!).catch(async error => {
        throw new Error(`${String(error)}; before=${JSON.stringify(before)}; after=${JSON.stringify(after)}; inventory=${JSON.stringify(await rig.inventory())}; supervisor=${rig.runtime.containerLogs(rig.supervisor.containerId).slice(-4000)}`)
      })
      const resumed = await waitFor(`${provider} resumed child`, () => recoveryWire.recordRows().find(row =>
        row.provider === provider && row.kind === 'launch' && row.launchId !== observed[1].launchId), 90_000)
      expect(resumed.providerConfig).toEqual(observed[1].providerConfig)
      expect(resumed.providerPlugin).toEqual(observed[1].providerPlugin)
      const resumedMcp = await waitFor(`${provider} resumed MCP`, () => recoveryWire.recordRows().find(row =>
        row.provider === provider && row.kind === 'mcp'), 90_000)
      expect(resumedMcp.error).toBe(mcpResults[1].error)
      if (!resumedMcp.error) expect(resumedMcp.call).toEqual(mcpResults[1].call)
      const managedView = after.containerId!
      const inspect = JSON.stringify(rig.runtime.inspectContainer(managedView))
      const approvedReference = inspect.includes(onecli.grants[provider])
        && observed[1].onecliChildDigest === onecli.childDigests[provider]
      expect(approvedReference).toBe(true)
      expect(observed[1].onecliControlPresent).toBe(false)
      const supervisorLogs = rig.runtime.containerLogs(rig.supervisor.containerId)
      const providerLogs = rig.runtime.containerLogs(managedView)
      rig.runtime.execOwnedContainerExact(rig.supervisor.containerId, [
        'node', '-e', `const fs=require('fs');const p='/var/lib/freshell-supervisor';for(const f of fs.readdirSync(p).filter(x=>x.startsWith('runtime.sqlite3'))){const value=fs.readFileSync(p+'/'+f);if(['${nestedSecretMarker}','fixture-secret-byte'].some(marker=>value.includes(marker)))process.exit(4)}`,
      ])
      for (const material of [inspect, supervisorLogs, providerLogs, fs.readFileSync(rig.runtime.evidenceDir + '/lifecycle.jsonl', 'utf8')]) {
        expect(material).not.toContain(nestedSecretMarker)
        expect(material).not.toContain('fixture-secret-byte')
      }
      let rejectedCreate: { requestType: string; responseType: string } | undefined
      await withMissingGrant(onecli.grants[provider], async () => {
        try {
          await recoveryWire.create(provider, workspace)
        } catch (error) {
          if (/OneCLI grant unavailable|OneCLI grant/i.test(String(error))) {
            rejectedCreate = { requestType: 'terminal.create', responseType: 'error' }
          }
        }
      })
      expect(rejectedCreate).toBeDefined()
      const launch = observed.map(row => normalized(row))
      fs.writeFileSync(path.join(evidenceDir, `terminal-${provider}.json`), JSON.stringify({
        provider,
        direct: { launch: launch[0], mcp: mcpResults[0], nativeIdentity: identities[0] ?? observed[0].nativeSession },
        managed: { launch: launch[1], mcp: mcpResults[1], nativeIdentity: identities[1] ?? observed[1].nativeSession },
        recovery: { replacementObserved: true, sameNativeSession: after.nativeSessionId === before.nativeSessionId },
        secretHygiene: { registry: true, supervisor: true, eventJournal: true, docker: true },
        onecli: {
          reference: { provider, profile: `${provider}_onecli_environment`, sourcePath: onecli.grants[provider],
            environmentKey: onecli.childKeys[provider], grantValueSha256: onecli.childDigests[provider] },
          child: { provider, argv: launch[1].argv, environmentKey: onecli.childKeys[provider],
            valueSha256: observed[1].onecliChildDigest,
            onecliControlPresent: observed[1].onecliControlPresent },
          rejection: { provider, sourcePath: onecli.grants[provider], ...rejectedCreate! },
        },
      }))
    }
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
      throw new Error(`${String(error)}; inventory: ${JSON.stringify(await rig.inventory())}; web: ${JSON.stringify(providerParityFailureDiagnostics(Object.values(rig.web.capturedOutput()).join('\n'))).slice(-3000)}`)
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
      throw new Error(`${String(error)}; inventory: ${JSON.stringify(await rig.inventory())}; supervisor: ${rig.runtime.containerLogs(rig.supervisor.containerId).slice(-4000)}; web: ${JSON.stringify(providerParityFailureDiagnostics(Object.values(rig.web.capturedOutput()).join('\n'))).slice(-4000)}`)
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
