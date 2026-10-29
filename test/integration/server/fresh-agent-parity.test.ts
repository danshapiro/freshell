import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig } from '../../e2e-browser/helpers/managed-runtime.js'
import { authorizeFreshAgentParityRequest, captureProviderParityVolumes, cleanupProviderParityVolumes, readProviderParitySource, type ProviderParitySource } from '../../helpers/provider-parity-broker.js'
import { makeProviderParityResourcesReadable, prepareProviderParityUserRoots, supervisorRegistrySecretScan } from '../../helpers/provider-parity-environment.js'
import { exposeGrantsToHarness, fakeOnecliGrants, withMissingGrant } from '../../helpers/provider-parity-onecli.js'
import type { InitialProviderVolumeAuthorization } from '../../../scripts/testing/runtime-test-broker.js'
// @ts-expect-error The native model-wire fixture is also used by the offline Node runner.
import { startInManagedContext } from '../providers/codex-local-provider.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const providers = [
  { provider: 'claude', sessionType: 'freshclaude', config: '.claude/settings.json' },
  { provider: 'codex', sessionType: 'freshcodex', config: '.codex/config.toml' },
  { provider: 'opencode', sessionType: 'freshopencode', config: 'custom-xdg/opencode/opencode.jsonc' },
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
  readonly frames: any[] = []

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
  let workspace: string
  let opencodeProject: string
  let homeDir: string
  let onecli: ReturnType<typeof fakeOnecliGrants>
  let restoreOnecliEnvironment: (() => void) | undefined
  let providerSource: ProviderParitySource
  const wires: FreshWire[] = []
  const registeredVolumes: (InitialProviderVolumeAuthorization & { requestId: string })[] = []

  // The restricted broker serves a soul's initial provider volume only after
  // the fixture registers that soul, so register each create before sending it.
  function authorizeFreshRequest(provider: typeof providers[number]['provider'], requestId: string) {
    const authorization = authorizeFreshAgentParityRequest(rig.runtime.broker, providerSource, provider, requestId)
    registeredVolumes.push({ ...authorization, requestId })
    rig.runtime.writeIncident('fresh-agent-parity-registered-requests', registeredVolumes)
    return authorization
  }

  beforeAll(async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-provider-parity-home-'))
    workspace = path.join(homeDir, 'workspace')
    fs.mkdirSync(workspace)
    execFileSync('git', ['init', '--quiet', workspace])
    onecli = fakeOnecliGrants(providers.map(row => row.provider))
    restoreOnecliEnvironment = exposeGrantsToHarness(onecli.serverEnv)
    const xdgConfigHome = path.join(homeDir, 'custom-xdg')
    // The harness validates and captures the selected provider roots when it
    // prepares, so they must exist before the rig starts.
    prepareProviderParityUserRoots(homeDir, xdgConfigHome)
    rig = new ManagedRuntimeBrowserRig(root, 2, {
      FRESHELL_BIND_HOST: '0.0.0.0', XDG_CONFIG_HOME: xdgConfigHome,
      ...onecli.serverEnv,
    }, { XDG_CONFIG_HOME: xdgConfigHome }, 'test', {
      enabledProviders: [],
      providerSettings: {},
      freshAgentModes: providers.map(row => row.sessionType),
      fixtureFreshAgentModes: providers.map(row => row.sessionType),
    }, homeDir, {
      workspaceRoots: [workspace],
      providerInputRoots: [],
      bootstrapFiles: Object.values(onecli.grants),
      defaultCwd: workspace,
    })
    await rig.start()
    const health = await rig.runtime.adminOk(rig.supervisor, { method: 'health' })
    expect(health.kind).toBe('health')
    providerSource = await readProviderParitySource(rig.runtime, health.data.installation_id)
    // Select a synthetic project, so providers never inherit this checkout's
    // own skills, installed dependencies, or linked-worktree Git topology.
    // Keep it under the owned synthetic HOME: installed-package ancestor
    // discovery then stops at this boundary instead of capturing a shared
    // /tmp/node_modules directory outside the broker's selected roots.
    // Every create selects this plugin directory relative to its cwd.
    fs.mkdirSync(path.join(workspace, 'fixture-plugin/.claude-plugin'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'fixture-plugin/.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture-plugin' }))
    opencodeProject = fs.mkdtempSync(path.join(workspace, '.opencode-parity-'))
    fs.mkdirSync(path.join(opencodeProject, '.opencode'), { recursive: true })
    const projectPlugin = path.join(opencodeProject, 'project-plugin.ts')
    fs.writeFileSync(projectPlugin, 'export const Project = async () => ({})\n')
    fs.writeFileSync(path.join(opencodeProject, '.opencode/opencode.json'), JSON.stringify({
      provider: { project_fixture: { name: 'project fixture' } },
      mcp: { project_fixture: { type: 'local', command: ['project-mcp'] } },
    }))
    fs.writeFileSync(path.join(opencodeProject, '.opencode/opencode.jsonc'),
      `{ // project JSONC remains a user source\n "plugin": [${JSON.stringify(pathToFileURL(projectPlugin).href)},], "theme": "project", }`)
    // Providers read their selected project inputs as the provider user.
    makeProviderParityResourcesReadable(workspace)
    const globalPlugin = path.join(rig.info.homeDir, 'custom-xdg/opencode/global-plugin.ts')
    for (const row of providers) {
      const file = path.join(rig.info.homeDir, row.config)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
      const contents = row.provider === 'codex'
        ? 'fixture_setting = true\n\n[mcp_servers.user_fixture]\ncommand = "user-fixture-mcp"\n'
        : row.provider === 'opencode'
          ? `{ // global JSONC\n "provider":{"global_fixture":{"name":"global fixture"}}, "mcp":{"user_fixture":{"type":"local","command":["user-fixture-mcp"]}}, "plugin":[${JSON.stringify(pathToFileURL(globalPlugin).href)},], }`
        : JSON.stringify({ fixtureSetting: true, mcpServers: { user_fixture: { command: 'user-fixture-mcp' } } }) + '\n'
      fs.writeFileSync(file, contents)
      fs.chmodSync(path.dirname(file), 0o755)
      fs.chmodSync(file, 0o644)
    }
    fs.writeFileSync(globalPlugin, 'export const Global = async () => ({})\n')
    fs.chmodSync(globalPlugin, 0o644)
    fs.writeFileSync(path.join(rig.info.homeDir, 'custom-xdg/opencode/opencode.json'), JSON.stringify({
      mcp: { other_global: { type: 'local', command: ['other-global-mcp'] } },
    }))
    const opencodePlugin = path.join(rig.info.homeDir, 'custom-xdg/opencode/plugin')
    fs.mkdirSync(opencodePlugin, { recursive: true, mode: 0o755 })
    fs.writeFileSync(path.join(opencodePlugin, 'user-plugin.ts'), 'export const User = async () => ({})\n')
  }, 900_000)

  afterAll(async () => {
    try {
      await Promise.allSettled(wires.map(wire => wire.close()))
      if (rig) {
        let volumes: ReturnType<typeof captureProviderParityVolumes> = []
        let captureError: unknown
        try {
          volumes = captureProviderParityVolumes(registeredVolumes)
          rig.runtime.writeIncident('fresh-agent-parity-registered-volumes', volumes)
        } catch (error) { captureError = error }
        const cleanup = await rig.stop()
        expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
        if (captureError) throw captureError
        rig.runtime.writeIncident('fresh-agent-parity-registered-volume-cleanup', {
          removed: cleanupProviderParityVolumes(volumes),
        })
      }
    } finally {
      if (workspace) fs.rmSync(workspace, { recursive: true, force: true })
      if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true })
      if (onecli) fs.rmSync(onecli.directory, { recursive: true, force: true })
      restoreOnecliEnvironment?.()
    }
  }, 180_000)

  it.each(providers)('$sessionType retains create settings and exact native resume', async row => {
    const wire = await FreshWire.connect(rig.info)
    wires.push(wire)
    const requestId = `fresh-parity-${randomUUID()}`
    const namingHandle = `nh-${randomUUID()}`
    const cwd = row.provider === 'opencode' ? opencodeProject : workspace
    const createRequest = {
      type: 'freshAgent.create', requestId, sessionType: row.sessionType,
      provider: row.provider, cwd, model: 'fixture-model',
      modelSelection: { kind: 'exact', modelId: 'fixture-model' },
      effort: 'low', permissionMode: 'default', sandbox: 'workspace-write',
      plugins: ['fixture-plugin'], namingHandle, tabId: `tab-${requestId}`,
    }
    const owner = authorizeFreshRequest(row.provider, requestId)
    wire.send(createRequest)
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
    expect(view.soulId).toBe(owner.soulId)
    const recorded = JSON.parse(rig.ownedProviderExec(view.containerId!, [
      'cat', '/home/freshell/provider/.freshell-fixture/provider-native-state.json',
    ]))
    const profile = recorded.createProfile
    expect(profile).toMatchObject({
      provider: row.provider, cwd, model: 'fixture-model', effort: 'low',
      permissionMode: 'default', sandbox: 'workspace-write',
      plugins: ['fixture-plugin'],
      modelSelection: { kind: 'exact', modelId: 'fixture-model' },
    })
    // Ordinary user configuration reaches the provider through the prepared
    // generation's config binds; staged references still carry directories.
    const launchContext = profile.providerLaunchContext
    const stagedConfig: any[] = launchContext.config ?? []
    const deliveredConfigFiles: string[] = [
      ...(launchContext.preparedInputs?.configBinds ?? []).map((bind: any) => bind.effectiveDestination),
      ...stagedConfig.filter(config => config.format !== 'directory')
        .map(config => path.posix.join('/home/freshell/provider', config.providerRelativePath)),
    ]
    expect(deliveredConfigFiles.length).toBeGreaterThan(0)
    expect(profile.providerLaunchContext.mcpCapability.grantId).toMatch(/^grant-/)
    expect(profile.providerSecretReferences).toHaveLength(1)
    for (const reference of profile.providerSecretReferences) {
      expect(reference.sourcePath).toMatch(/onecli/)
      expect(reference.profile).toMatch(new RegExp(`^${row.provider}_onecli_`))
    }
    const childObservation = await waitFor('redacted fresh provider worker observation', () => {
      try {
        return JSON.parse(rig.ownedProviderExec(view.containerId!, [
          'cat', '/home/freshell/provider/.freshell-fixture/provider-child-observation.json',
        ]))
      } catch { return undefined }
    })
    expect(childObservation.argv).toEqual(['fresh-agent-fixture-worker', '--provider', row.provider])
    expect(childObservation.env[onecli.childKeys[row.provider]]).toBe(onecli.childDigests[row.provider])
    expect(childObservation.onecliControlPresent).toBe(false)
    expect(JSON.stringify(recorded)).not.toContain('fixture-secret-byte')
    const preparation = profile.providerLaunchContext.preparation
    // Hosted fresh Claude and Codex keep the managed Freshell MCP recipe
    // (pinned by the managed_provider_fresh_* tests in fresh_agent_proxy_tests.rs).
    if (row.provider === 'claude') {
      expect(preparation.claude?.mcp_args).toEqual(['--mcp-config', '.claude/freshell-mcp.json'])
    } else if (row.provider === 'codex') {
      expect(preparation.codex.tui_args).toEqual(expect.arrayContaining([
        'mcp_servers.freshell.command="node"', 'mcp_servers.freshell.args=["/opt/freshell-mcp/server.js"]',
      ]))
      expect(preparation.codex.sidecar_args).toEqual(preparation.codex.tui_args)
    } else {
      expect(preparation.opencode).toMatchObject({ inline_config: false, tui_config: null })
      expect(JSON.stringify(preparation)).not.toContain('freshell-mcp')
      expect(preparation.opencode.project_config.map((source: any) => source.relativePath)).toEqual(
        expect.arrayContaining([
          `${path.basename(opencodeProject)}/.opencode/opencode.json`,
          `${path.basename(opencodeProject)}/.opencode/opencode.jsonc`,
        ]),
      )
      const tuiConfig = rig.ownedProviderExec(view.containerId!, [
        'cat', '/home/freshell/provider/.freshell/opencode/tui.json',
      ])
      expect(JSON.parse(tuiConfig).plugin).toEqual([
        expect.stringContaining('freshell-rebind-plugin.ts'),
      ])
    }
    for (const config of stagedConfig) {
      if (row.provider === 'opencode' && config.format === 'directory' && config.relativePath === 'plugin') {
        expect(rig.ownedProviderExec(view.containerId!, [
          'cat', path.posix.join('/home/freshell/provider', config.providerRelativePath, 'user-plugin.ts'),
        ])).toContain('export const User')
      }
    }
    for (const file of deliveredConfigFiles) {
      const contents = rig.ownedProviderExec(view.containerId!, ['cat', file])
      if (row.provider === 'opencode') {
        expect(contents).toMatch(/global_fixture|other_global|project_fixture|project JSONC/)
      } else {
        expect(contents).toContain(row.provider === 'codex' ? 'fixture_setting' : 'fixtureSetting')
        expect(contents).toContain('user-fixture-mcp')
      }
    }

    const sendId = `send-${randomUUID()}`
    wire.send({ type: 'freshAgent.send', provider: row.provider, sessionType: row.sessionType,
      sessionId: created.sessionId, requestId: sendId, text: 'fixture prompt' })
    await wire.wait(frame => frame.type === 'freshAgent.turn.complete'
      && frame.sessionId === created.sessionId)

    const resumeId = `resume-${randomUUID()}`
    wire.send({ type: 'freshAgent.create', requestId: resumeId,
      provider: row.provider, sessionType: row.sessionType, cwd,
      sessionRef: { provider: row.provider, sessionId: recorded.nativeSessionId } })
    const resumed = await wire.wait(frame => frame.requestId === resumeId
      && (frame.type === 'freshAgent.created' || frame.type === 'freshAgent.create.failed'))
    expect(resumed.type, JSON.stringify(resumed)).toBe('freshAgent.created')
    expect(resumed.sessionRef?.sessionId).toBe(recorded.nativeSessionId)
    let rejectedCreate: { requestType: string; responseType: string } | undefined
    await withMissingGrant(onecli.grants[row.provider], async () => {
      const badRequestId = `bad-grant-${randomUUID()}`
      // Registered like any create, so only the missing grant can refuse it.
      authorizeFreshRequest(row.provider, badRequestId)
      wire.send({ ...createRequest, requestId: badRequestId,
        namingHandle: `nh-${badRequestId}`, tabId: `tab-${badRequestId}` })
      const bad = await wire.wait(frame => frame.requestId === badRequestId
        && (frame.type === 'freshAgent.created' || frame.type === 'freshAgent.create.failed'))
      if (bad.type === 'freshAgent.create.failed') {
        rejectedCreate = { requestType: 'freshAgent.create', responseType: bad.type }
      }
    })
    expect(rejectedCreate).toBeDefined()
    const evidenceDir = process.env.FRESHELL_PROVIDER_PARITY_ROWS_DIR
    if (evidenceDir) {
      const sentinel = 'fixture-secret-byte'
      rig.runtime.execOwnedContainerExact(rig.supervisor.containerId, supervisorRegistrySecretScan([sentinel]))
      for (const material of [
        JSON.stringify(rig.runtime.inspectContainer(view.containerId!)),
        rig.runtime.containerLogs(view.containerId!),
        rig.runtime.containerLogs(rig.supervisor.containerId),
        fs.readFileSync(path.join(rig.runtime.evidenceDir, 'lifecycle.jsonl'), 'utf8'),
      ]) expect(material).not.toContain(sentinel)
      fs.writeFileSync(path.join(evidenceDir, `fresh-hosted-${row.provider}.json`), JSON.stringify({
        provider: row.provider, nativeSessionId: recorded.nativeSessionId,
        configCount: deliveredConfigFiles.length,
        plugin: profile.plugins,
        secretHygiene: { registry: true, supervisor: true, eventJournal: true, docker: true },
        onecli: {
          reference: { provider: row.provider, profile: profile.providerSecretReferences[0].profile,
            sourcePath: profile.providerSecretReferences[0].sourcePath,
            environmentKey: onecli.childKeys[row.provider], grantValueSha256: onecli.childDigests[row.provider] },
          child: { provider: row.provider, argv: childObservation.argv,
            environmentKey: onecli.childKeys[row.provider],
            valueSha256: childObservation.env[onecli.childKeys[row.provider]],
            onecliControlPresent: childObservation.onecliControlPresent },
          rejection: { provider: row.provider, sourcePath: onecli.grants[row.provider], ...rejectedCreate! },
        },
      }))
    }
  }, 240_000)
})

describe('installed Codex through the managed gateway and durable actor', () => {
  let rig: ManagedRuntimeBrowserRig
  let home: string
  let workspace: string
  let grants: ReturnType<typeof fakeOnecliGrants>
  let restoreGrants: (() => void) | undefined
  let source: ProviderParitySource
  let wire: FreshWire
  let model: Awaited<ReturnType<typeof startInManagedContext>> | undefined
  let naming: http.Server
  const namingRequests: string[] = []
  const owners: InitialProviderVolumeAuthorization[] = []

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'freshcodex-managed-native-'))
    workspace = path.join(home, 'workspace')
    fs.mkdirSync(workspace)
    execFileSync('git', ['init', '--quiet', workspace])
    const xdg = path.join(home, 'xdg')
    prepareProviderParityUserRoots(home, xdg)
    grants = fakeOnecliGrants(['codex'])
    restoreGrants = exposeGrantsToHarness(grants.serverEnv)
    naming = http.createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      namingRequests.push(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Managed native suggested name' }] } }] }))
    })
    await new Promise<void>(resolve => naming.listen(0, '127.0.0.1', resolve))
    const namingAddress = naming.address()
    if (!namingAddress || typeof namingAddress === 'string') throw new Error('Owned naming fixture has no TCP port')
    rig = new ManagedRuntimeBrowserRig(root, 2,
      { XDG_CONFIG_HOME: xdg, ...grants.serverEnv, GOOGLE_GENERATIVE_AI_API_KEY: 'managed-naming-fixture',
        FRESHELL_GEMINI_BASE_URL: `http://127.0.0.1:${namingAddress.port}` }, { XDG_CONFIG_HOME: xdg }, 'test',
      { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: [] }, home,
      { workspaceRoots: [workspace], providerInputRoots: [], bootstrapFiles: Object.values(grants.grants), defaultCwd: workspace })
    await rig.start()
    const health = await rig.runtime.adminOk(rig.supervisor, { method: 'health' })
    source = await readProviderParitySource(rig.runtime, health.data.installation_id)
    const catalog = path.join(home, '.codex', 'models.json')
    fs.writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'contract-model', display_name: 'Managed native model',
      description: 'Owned native managed contract', default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'low', description: 'Low' }, { effort: 'xhigh', description: 'Extra high' }],
      shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0, support_verbosity: false,
      truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 128000,
      experimental_supported_tools: ['request_user_input_async'], supports_search_tool: false,
      tool_mode: 'direct', use_responses_lite: false, model_messages: { instructions_template: 'Use the available tools to follow the user request.' } }] }))
    fs.writeFileSync(path.join(home, '.codex/config.toml'), `model = "contract-model"
model_provider = "contract-loopback"
approval_policy = "untrusted"
model_catalog_json = ${JSON.stringify(catalog)}
web_search = "disabled"
[features]
apps = false
default_mode_request_user_input = true
unified_exec = true
[tools.experimental_request_user_input]
enabled = true
[model_providers.contract-loopback]
name = "Managed owned loopback"
base_url = "http://127.0.0.1:51991/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`)
    makeProviderParityResourcesReadable(home)
    wire = await FreshWire.connect(rig.info)
  }, 900_000)

  afterAll(async () => {
    try {
      await wire?.close()
      await model?.stop()
      if (rig) {
        const volumes = captureProviderParityVolumes(owners)
        const cleanup = await rig.stop()
        expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
        cleanupProviderParityVolumes(volumes)
      }
    } finally {
      if (naming) {
        naming.closeAllConnections()
        await new Promise<void>(resolve => naming.close(() => resolve()))
      }
      restoreGrants?.()
      if (grants) fs.rmSync(grants.directory, { recursive: true, force: true })
      if (home) fs.rmSync(home, { recursive: true, force: true })
    }
  }, 180_000)

  it('uses the installed wrapper for catalog, settings, saved output and exact native controls', async () => {
    const requestId = `native-managed-${randomUUID()}`
    owners.push(authorizeFreshAgentParityRequest(rig.runtime.broker, source, 'codex', requestId))
    wire.send({ type: 'freshAgent.create', requestId, provider: 'codex', sessionType: 'freshcodex',
      cwd: workspace, model: 'contract-model', effort: 'xhigh', sandbox: 'workspace-write', permissionMode: 'untrusted',
      namingHandle: `name-${requestId}`, tabId: `tab-${requestId}` })
    const created = await wire.wait(frame => frame.requestId === requestId
      && ['freshAgent.created', 'freshAgent.create.failed'].includes(frame.type))
    expect(created.type, JSON.stringify(created)).toBe('freshAgent.created')
    const view = await waitFor('native managed provider', async () => {
      const row = await rig.runningViewForFreshSession(created.sessionId)
      return row?.containerId && row.nativeSessionId ? row : undefined
    })
    expect(rig.ownedProviderExec(view.containerId!, ['/opt/freshell-codex/launch', '--version'])).toContain('0.164.0')
    const nativeContext = JSON.parse(rig.ownedProviderExec(view.containerId!, ['node', '-e', `
      const fs=require('node:fs');const layout=JSON.parse(fs.readFileSync('/opt/freshell-codex/layout.json','utf8'));
      const found=fs.readdirSync('/proc').filter(p=>Number.isInteger(Number(p))).flatMap(pid=>{try{
        if(fs.readlinkSync('/proc/'+pid+'/exe')!==layout.nativeExecutable)return[];
        if(!fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split(String.fromCharCode(0)).includes('app-server'))return[];
        const status=fs.readFileSync('/proc/'+pid+'/status','utf8');const field=k=>status.split(String.fromCharCode(10)).find(line=>line.startsWith(k+':'))?.slice(k.length+1).trim();
        return[{pid:Number(pid),uid:Number(field('Uid')?.split(String.fromCharCode(9))[0]),gid:Number(field('Gid')?.split(String.fromCharCode(9))[0]),
          executable:layout.nativeExecutable,cwd:fs.readlinkSync('/proc/'+pid+'/cwd'),noNewPrivs:field('NoNewPrivs'),capEff:field('CapEff')}];
      }catch{return[]}});if(found.length!==1)throw Error('Expected one actual installed native Codex app-server');process.stdout.write(JSON.stringify(found[0]));`]))
    expect(nativeContext).toMatchObject({ uid: 65534, gid: 0, cwd: workspace, noNewPrivs: '1', capEff: '0000000000000000' })
    model = await startInManagedContext(rig, { containerId: view.containerId!, handlerSource: `async record => {
      const input=record.body.input;
      const user=input.filter(item=>item.role==='user').at(-1);
      const prompt=JSON.stringify(user);
      const call=(name,args,id)=>{
        let namespace;let tool=record.body.tools.find(tool=>tool.type==='function'&&tool.name===name);
        if(!tool){const group=record.body.tools.find(tool=>tool.type==='namespace'&&tool.tools?.some(member=>member.name===name));tool=group?.tools.find(member=>member.name===name);namespace=group?.name;}
        if(!tool)throw Error('Native model did not advertise '+name);
        return {items:[{id:'fc_'+id,type:'function_call',call_id:'call_'+id,...(namespace?{namespace}:{}),name,arguments:JSON.stringify(args),status:'completed'}]};
      };
      if(prompt.includes('AWAITED_PLAN')&&!input.some(item=>item.call_id==='call_awaited'))return call('request_user_input',{questions:[{id:'managed_choice',header:'Choice',question:'Which managed result?',options:[{label:'Alpha',description:'First result'},{label:'Beta',description:'Second result'}]}]},'awaited');
      if(prompt.includes('ASYNC_QUESTION')&&!input.some(item=>item.call_id==='call_async'))return call('request_user_input_async',{questions:[{title:'Which managed environment?',options:['Staging','Production']}]},'async');
      return {text:prompt.includes('ASYNC_QUESTION')?'Managed work continued before the answer.':prompt.includes('AWAITED_PLAN')?'Managed awaited answer completed.':'Managed native final answer.'};
    }` })
    expect(model.context).toMatchObject({ uid: 65534, gid: 0 })
    const headers = { 'x-auth-token': rig.info.token }
    const snapshot = async () => {
      const response = await fetch(`${rig.info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${created.sessionId}`, { headers })
      expect(response.ok, await response.clone().text()).toBe(true)
      return response.json()
    }
    const catalogResponse = await fetch(`${rig.info.baseUrl}/api/fresh-agent/model-capabilities/freshcodex?${new URLSearchParams({ sessionId: created.sessionId, sessionRef: JSON.stringify(created.sessionRef), cwd: workspace })}`, { headers })
    expect(catalogResponse.ok, await catalogResponse.clone().text()).toBe(true)
    expect((await catalogResponse.json()).models).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'contract-model', supportedEffortLevels: ['low', 'xhigh'] })]))
    const send = async (text: string, settings?: unknown) => {
      const id = `send-${randomUUID()}`
      wire.send({ type: 'freshAgent.send', sessionType: 'freshcodex', provider: 'codex', sessionId: created.sessionId, requestId: id, text, ...(settings ? { settings } : {}) })
      const accepted = await wire.wait(frame => frame.requestId === id && ['freshAgent.send.accepted', 'error'].includes(frame.type))
      expect(accepted.type, JSON.stringify(accepted)).toBe('freshAgent.send.accepted')
      return accepted
    }
    await send('MANAGED_NATIVE_FIRST')
    const saved = await waitFor('managed native saved first answer', async () => {
      const value = await snapshot()
      return value.status === 'idle' && JSON.stringify(value.turns).includes('Managed native final answer.') ? value : undefined
    })
    expect(saved.settings).toMatchObject({ model: 'contract-model', effort: 'xhigh', sandbox: 'workspace-write', permissionMode: 'untrusted', cwd: workspace })
    expect(model.traffic[0].body.reasoning.effort).toBe('xhigh')
    await send('AWAITED_PLAN', { collaborationMode: 'plan' })
    const pending = await waitFor('managed native awaited Plan control', async () => {
      const value = await snapshot()
      return value.pendingQuestions?.length ? value.pendingQuestions[0] : undefined
    })
    expect(pending.questions[0].id).toBe('managed_choice')
    wire.send({ type: 'freshAgent.question.respond', sessionType: 'freshcodex', provider: 'codex', sessionId: created.sessionId,
      requestId: pending.requestId, answers: { managed_choice: 'Alpha' } })
    await waitFor('managed native awaited decision drained', async () => {
      const value = await snapshot()
      return value.status === 'idle' && !value.pendingQuestions.length && JSON.stringify(value.turns).includes('Managed awaited answer completed.') ? true : undefined
    })
    await send('ASYNC_QUESTION', { collaborationMode: 'default' })
    const asyncSnapshot = await waitFor('managed native async continuation without answer', async () => {
      const value = await snapshot()
      return value.status === 'idle' && JSON.stringify(value.turns).includes('Managed work continued before the answer.') ? value : undefined
    })
    expect(asyncSnapshot.pendingQuestions).toHaveLength(0)
    expect(JSON.stringify(asyncSnapshot.turns)).toContain('Which managed environment?')
    await send('Question: Which managed environment? Answer: Staging.', { effort: null })
    await waitFor('managed contextual answer at loopback model', () => model!.traffic.some((row: any) => JSON.stringify(row.body.input).includes('Answer: Staging.')) ? true : undefined)
    await waitFor('managed contextual answer completion', async () => (await snapshot()).status === 'idle' ? true : undefined)
    const resumedResponse = await fetch(`${rig.info.baseUrl}/api/tabs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'codex', cwd: workspace, sessionRef: { provider: 'codex', sessionId: view.nativeSessionId } }) })
    expect(resumedResponse.ok, await resumedResponse.clone().text()).toBe(true)
    const resumed = await resumedResponse.json()
    const paneId = resumed.data?.paneId ?? resumed.paneId
    expect(paneId).toBeTruthy()
    const captureResponse = await fetch(`${rig.info.baseUrl}/api/panes/${paneId}/capture`, { headers })
    expect(captureResponse.ok, await captureResponse.clone().text()).toBe(true)
    expect(await captureResponse.text()).toContain('Managed native final answer.')
    const durableNameRef = { kind: 'session', provider: 'codex', sessionId: view.nativeSessionId }
    const readName = async () => {
      const response = await fetch(`${rig.info.baseUrl}/api/session-names/read`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ refs: [durableNameRef] }) })
      expect(response.ok).toBe(true)
      return (await response.json()).names[0]?.record
    }
    const nativeMetadata = JSON.parse(rig.ownedProviderExec(view.containerId!, ['node', '-e', `
      const fs=require('node:fs'),path=require('node:path');
      const env=Object.fromEntries(fs.readFileSync('/proc/${nativeContext.pid}/environ','utf8').split(String.fromCharCode(0)).flatMap(entry=>{
        const at=entry.indexOf('=');const key=entry.slice(0,at);return ['HOME','CODEX_HOME'].includes(key)?[[key,entry.slice(at+1)]]:[];
      }));
      const errors=[],headers=[],directories=[];let visited=0;
      const stat=p=>{const s=fs.statSync(p);return{uid:s.uid,gid:s.gid,mode:(s.mode&511).toString(8)}};
      const roots=[...new Set([env.CODEX_HOME,env.HOME&&path.join(env.HOME,'.codex')].filter(Boolean))];
      const walk=(dir,depth)=>{if(depth>8||visited++>1024)return;try{
        directories.push({path:dir,...stat(dir)});
        for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
          const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file,depth+1);
          else if(entry.isFile()&&entry.name.endsWith('.jsonl')){
            const fd=fs.openSync(file,'r');let first;try{const b=Buffer.alloc(65536);first=b.toString('utf8',0,fs.readSync(fd,b,0,b.length,0)).split(String.fromCharCode(10))[0]}finally{fs.closeSync(fd)}
            let meta;try{meta=JSON.parse(first)}catch{}
            headers.push({path:file,...stat(file),type:meta?.type,id:meta?.payload?.id??meta?.payload?.session_id});
          }
        }
      }catch(error){errors.push({path:dir,code:error.code})}};
      for(const root of roots)walk(path.join(root,'sessions'),0);
      const hostStatus=fs.readFileSync('/proc/1/status','utf8').split(String.fromCharCode(10)).filter(line=>/^(Uid|Gid|CapEff|NoNewPrivs):/.test(line));
      process.stdout.write(JSON.stringify({env,roots,directories,headers,errors,hostStatus}));`]))
    const hostMetadataAccess = JSON.parse(rig.ownedContainerExec(view.containerId!, ['node', '-e', `
      const fs=require('node:fs');const root='/home/freshell/provider';const s=fs.statSync(root);
      let readError;try{fs.readdirSync(root+'/.codex/sessions')}catch(error){readError=error.code}
      process.stdout.write(JSON.stringify({uid:process.getuid(),root:{uid:s.uid,gid:s.gid,mode:(s.mode&511).toString(8)},readError}));`]))
    expect(hostMetadataAccess).toMatchObject({ uid: 0, root: { uid: 65534, mode: '700' }, readError: 'EACCES' })
    expect(nativeMetadata.headers).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'session_meta', id: view.nativeSessionId })]))
    rig.runtime.writeIncident('freshcodex-managed-native-before-naming', { created, view, nativeContext, nativeMetadata, fixtureContext: model.context, saved, asyncSnapshot,
      hostMetadataAccess, traffic: model.traffic, final: await snapshot() })
    const durableName = await waitFor('managed native durable shared name', async () => {
      const record = await readName()
      return record?.ref?.sessionId === view.nativeSessionId ? record : undefined
    }, 15_000)
    expect(durableName.ref).toEqual(durableNameRef)
    await waitFor('managed first-message naming request', () => namingRequests.some(body => body.includes('MANAGED_NATIVE_FIRST')) ? true : undefined)
    const renamed = await fetch(`${rig.info.baseUrl}/api/session-names`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ target: durableNameRef, name: 'Managed native saved name', nameIntent: 'user' }) })
    expect(renamed.ok, await renamed.clone().text()).toBe(true)
    const canonicalName = await readName()
    expect(canonicalName).toMatchObject({ ref: durableNameRef, name: 'Managed native saved name', source: 'manual' })
    const readNativeName = () => JSON.parse(rig.ownedProviderExec(view.containerId!, ['node', '-e', `
      const fs=require('node:fs');const argv=fs.readFileSync('/proc/${nativeContext.pid}/cmdline','utf8').split(String.fromCharCode(0));
      const endpoint=argv[argv.indexOf('--listen')+1];const target=new URL(endpoint);
      if(target.protocol!=='ws:'||target.hostname!=='127.0.0.1'||!target.port)throw Error('Expected the existing native loopback endpoint');
      const socket=new WebSocket(endpoint);let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.close();
        if(error){process.stderr.write(String(error));process.exit(1)}process.stdout.write(JSON.stringify(value),()=>process.exit(0));};
      const timer=setTimeout(()=>finish('Existing native metadata observer timed out'),8000);
      socket.addEventListener('error',()=>finish('Existing native metadata connection failed'));
      socket.addEventListener('open',()=>socket.send(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'freshell_name_read_probe',version:'1'}}})));
      socket.addEventListener('message',event=>{const frame=JSON.parse(String(event.data));if(frame.error)return finish(frame.error.message);
        if(frame.id===1){socket.send(JSON.stringify({method:'initialized'}));socket.send(JSON.stringify({id:2,method:'thread/read',params:{threadId:${JSON.stringify(view.nativeSessionId)},includeTurns:false}}));}
        if(frame.id===2)finish(null,{id:frame.result.thread.id,title:frame.result.thread.name??null});});`]))
    const nativeNameBeforeWait = readNativeName()
    rig.runtime.writeIncident('freshcodex-managed-native-name-writeback', { canonicalName, nativeNameBeforeWait, view, nativeContext })
    await waitFor('managed native name writeback', () => {
      const observation = readNativeName()
      return observation.id === view.nativeSessionId && observation.title === canonicalName.name ? observation : undefined
    }, 15_000)
    rig.runtime.writeIncident('freshcodex-managed-native-journey', { created, view, nativeContext, context: model.context,
      traffic: model.traffic, saved, asyncSnapshot, canonicalName, nativeName: readNativeName(), final: await snapshot() })
  }, 240_000)
})
