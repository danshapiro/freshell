import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig } from '../../e2e-browser/helpers/managed-runtime.js'
import { authorizeFreshAgentParityRequest, readProviderParitySource, type ProviderParitySource } from '../../helpers/provider-parity-broker.js'
import { makeProviderParityResourcesReadable, prepareProviderParityUserRoots, supervisorRegistrySecretScan } from '../../helpers/provider-parity-environment.js'
import { exposeGrantsToHarness, fakeOnecliGrants, withMissingGrant } from '../../helpers/provider-parity-onecli.js'
import type { InitialProviderVolumeAuthorization } from '../../../scripts/testing/runtime-test-broker.js'
import { cleanupProviderParity } from '../../helpers/provider-parity-cleanup.js'

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
  let workspace: string
  let opencodeProject: string
  let homeDir: string
  let fixturePlugin: string
  let guestProbe: string
  let parityFixture: string
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
    // Keep package discovery and every provider fixture inside the selected owned workspace.
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    const probes = path.join(workspace, '.fixture-probes')
    fs.mkdirSync(probes)
    guestProbe = path.join(probes, 'fresh-provider-input-probe.mjs')
    parityFixture = path.join(probes, 'parity-provider.mjs')
    for (const destination of [guestProbe, parityFixture]) {
      fs.copyFileSync(path.join(root, 'test/fixtures/providers', path.basename(destination)), destination)
    }
    opencodeProject = fs.mkdtempSync(path.join(workspace, '.opencode-parity-'))
    fs.mkdirSync(path.join(opencodeProject, '.opencode'), { recursive: true })
    fixturePlugin = path.join(workspace, 'fixture-plugin')
    fs.mkdirSync(path.join(fixturePlugin, '.claude-plugin'), { recursive: true })
    fs.writeFileSync(path.join(fixturePlugin, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }))
    fs.writeFileSync(path.join(fixturePlugin, 'package.json'), JSON.stringify({ type: 'commonjs' }))
    fs.writeFileSync(path.join(fixturePlugin, 'asset'), 'fixture-plugin-resource')
    fs.writeFileSync(path.join(fixturePlugin, 'command'),
      "#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(__dirname+'/asset','utf8'))\n",
      { mode: 0o751 })
    const userMcp = path.join(fixturePlugin, 'user-mcp.cjs')
    fs.writeFileSync(userMcp, `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line); if(request.id==null)return;
  const result=request.method==='initialize'
    ? {protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
    : request.method==='tools/list' ? {tools:[{name:'fixture',inputSchema:{type:'object'}}]}
    : {content:[{type:'text',text:JSON.stringify({source:process.argv[2]})}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});\n`)
    const globalPlugin = path.join(homeDir, 'custom-xdg/opencode/global-plugin.ts')
    const projectPlugin = path.join(opencodeProject, '.opencode/project-plugin.ts')
    fs.writeFileSync(globalPlugin, 'export const Global = async () => ({})\n')
    fs.writeFileSync(projectPlugin, 'export const Project = async () => ({})\n')
    fs.writeFileSync(path.join(opencodeProject, '.opencode/opencode.json'), JSON.stringify({
      provider: { project_fixture: { name: 'project fixture' } },
      mcp: { project_fixture: { type: 'local', command: ['node', userMcp, 'project'] } },
    }))
    fs.writeFileSync(path.join(opencodeProject, '.opencode/opencode.jsonc'),
      `{ // project JSONC remains a user source\n "plugin": [${JSON.stringify(pathToFileURL(projectPlugin).href)},], "theme": "project", }`)
    // Providers read their selected project inputs as the provider user.
    makeProviderParityResourcesReadable(workspace)
    for (const row of providers) {
      const file = path.join(rig.info.homeDir, row.config)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
      const contents = row.provider === 'codex'
        ? `fixture_setting = true\n\n[mcp_servers.user_fixture]\ncommand = "node"\nargs = ${JSON.stringify([userMcp, 'user'])}\n`
        : row.provider === 'opencode'
          ? `{ // global JSONC\n "provider":{"global_fixture":{"name":"global fixture"}}, "mcp":{"user_fixture":{"type":"local","command":${JSON.stringify(['node', userMcp, 'user'])}}}, "plugin":[${JSON.stringify(pathToFileURL(globalPlugin).href)},], }`
        : JSON.stringify({ fixtureSetting: true, mcpServers: { user_fixture: { command: 'node', args: [userMcp, 'user'] } } }) + '\n'
      fs.writeFileSync(file, contents)
      fs.chmodSync(path.dirname(file), 0o755)
      fs.chmodSync(file, 0o644)
    }
    fs.writeFileSync(globalPlugin, 'export const Global = async () => ({})\n')
    fs.chmodSync(globalPlugin, 0o644)
    fs.writeFileSync(path.join(rig.info.homeDir, 'custom-xdg/opencode/opencode.json'), JSON.stringify({
      mcp: { other_global: { type: 'local', command: ['node', userMcp, 'other-global'] } },
    }))
    const opencodePlugin = path.join(rig.info.homeDir, 'custom-xdg/opencode/plugin')
    fs.mkdirSync(opencodePlugin, { recursive: true, mode: 0o755 })
    fs.writeFileSync(path.join(opencodePlugin, 'user-plugin.ts'), 'export const User = async () => ({})\n')
    makeProviderParityResourcesReadable(workspace)
  }, 900_000)

  afterAll(() => cleanupProviderParity({
    connections: wires, rig, registeredVolumes, restoreOnecliEnvironment,
    directories: [workspace, homeDir, onecli?.directory],
  }), 180_000)

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
      plugins: [fixturePlugin], namingHandle, tabId: `tab-${requestId}`,
    }
    const owner = authorizeFreshRequest(row.provider, requestId)
    wire.send(createRequest)
    const created = await wire.wait(frame => frame.requestId === requestId
      && (frame.type === 'freshAgent.created' || frame.type === 'freshAgent.create.failed'))
    if (created.type === 'freshAgent.create.failed') {
      let providerInputs: unknown[] = []
      try {
        providerInputs = fs.readFileSync(path.join(rig.info.homeDir, '.freshell/logs/rust-server.jsonl'), 'utf8')
          .split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
          .filter(row => ['WARN', 'ERROR'].includes(row.level)).slice(-16)
          .map(row => Object.fromEntries(['event', 'msg', 'reason', 'error', 'provider', 'runtime_code']
            .filter(key => typeof row[key] === 'string').map(key => [key,
              row[key].replace(/fixture-secret-byte(?:-[a-z]+)?/g, '<redacted>')])))
      } catch { /* The original create failure remains the primary diagnostic. */ }
      rig.runtime.writeIncident(`fresh-parity-${row.provider}-create-failure`, { providerInputs })
      throw new Error(`${JSON.stringify(created)}; providerInputs=${JSON.stringify(providerInputs)}; inventory=${JSON.stringify(await rig.inventory())}; web=${JSON.stringify(rig.web.capturedOutput())}; supervisor=${rig.runtime.containerLogs(rig.supervisor.containerId).slice(-6000)}`)
    }
    expect(created.type, JSON.stringify(created)).toBe('freshAgent.created')
    expect(created.nameRef).toEqual({ kind: 'pending', id: namingHandle })
    expect(created.sessionName?.name).toBeTruthy()
    const view = await waitFor('hosted fresh-agent soul', async () => {
      const candidate = await rig.runningViewForFreshSession(created.sessionId)
      return candidate?.containerId ? candidate : undefined
    })
    expect(view.soulId).toBe(owner.soulId)
    const recorded = JSON.parse((await rig.ownedProviderExec(view.containerId!, [
      'cat', '/home/freshell/provider/.freshell-fixture/provider-native-state.json',
    ])))
    const profile = recorded.createProfile
    expect(profile).toMatchObject({
      provider: row.provider, cwd, model: 'fixture-model', effort: 'low',
      permissionMode: 'default', sandbox: 'workspace-write',
      plugins: [fixturePlugin],
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
    const context = profile.providerLaunchContext
    expect(context.preparedInputs.generationId).toBe(context.mcpCapability.grantId)
    expect(profile.providerLaunchContext.mcpCapability.grantId).toMatch(/^grant-/)
    const onecliReferences = profile.providerSecretReferences.filter((reference: any) =>
      reference.profile.startsWith(`${row.provider}_onecli_`))
    expect(onecliReferences).toHaveLength(1)
    for (const reference of onecliReferences) {
      expect(reference.sourcePath).toMatch(/onecli/)
      expect(reference.profile).toMatch(new RegExp(`^${row.provider}_onecli_`))
    }
    const childObservation = await waitFor('redacted fresh provider worker observation', async () => {
      try {
        return JSON.parse((await rig.ownedProviderExec(view.containerId!, [
          'cat', '/home/freshell/provider/.freshell-fixture/provider-child-observation.json',
        ])))
      } catch { return undefined }
    })
    expect(childObservation.argv).toEqual(['fresh-agent-fixture-worker', '--provider', row.provider])
    expect(childObservation.env[onecli.childKeys[row.provider]]).toBe(onecli.childDigests[row.provider])
    expect(childObservation.onecliControlPresent).toBe(false)
    expect(JSON.stringify(recorded)).not.toContain('fixture-secret-byte')
    const consumed = JSON.parse(rig.ownedContainerExec(view.containerId!, [
      'bun', guestProbe,
      JSON.stringify({ provider: row.provider, context, cwd, fixturePlugin,
        parityFixture }),
    ]))
    expect(consumed.configCount).toBeGreaterThan(0)
    expect(consumed.userMcp.user_fixture).toEqual({ source: 'user' })
    expect(consumed.mcpHealth).toEqual(row.provider === 'codex' ? [true, true] : [true])
    const preparation = profile.providerLaunchContext.preparation
    // Hosted fresh Claude and Codex keep the managed Freshell MCP recipe
    // (pinned by the managed_provider_fresh_* tests in fresh_agent_proxy_tests.rs).
    if (row.provider === 'claude') {
      expect(preparation.claude?.mcp_args).toEqual(['--mcp-config', '.claude/freshell-mcp.json'])
      expect(consumed.selectedExecutable).toBe('fixture-plugin-resource')
    } else if (row.provider === 'codex') {
      expect(preparation.codex.tui_args).toEqual(expect.arrayContaining([
        'mcp_servers.freshell.command="node"', 'mcp_servers.freshell.args=["/opt/freshell-mcp/server.js"]',
      ]))
      expect(preparation.codex.sidecar_args).toEqual(preparation.codex.tui_args)
    } else {
      expect(preparation.opencode).toMatchObject({ inline_config: false, tui_config: null })
      expect(preparation.opencode.project_config.map((source: any) =>
        path.resolve(workspace, source.relativePath))).toEqual(
        expect.arrayContaining([
          path.join(cwd, '.opencode/opencode.json'),
          path.join(cwd, '.opencode/opencode.jsonc'),
        ]),
      )
      expect(consumed.userMcp.other_global).toEqual({ source: 'other-global' })
      expect(consumed.userMcp.project_fixture).toEqual({ source: 'project' })
      expect(consumed.pluginResults).toEqual({ Global: {}, Project: {}, User: {} })
      expect(consumed.rebind).toMatchObject({ hello: true, sessionId: 'ses_parity' })
      const tuiConfig = await rig.ownedProviderExec(view.containerId!, [
        'cat', '/home/freshell/provider/.freshell/opencode/tui.json',
      ])
      expect(JSON.parse(tuiConfig).plugin).toEqual([
        expect.stringContaining('freshell-rebind-plugin.ts'),
      ])
    }
    for (const config of stagedConfig) {
      if (row.provider === 'opencode' && config.format === 'directory' && config.relativePath === 'plugin') {
        expect(await rig.ownedProviderExec(view.containerId!, [
          'cat', path.posix.join('/home/freshell/provider', config.providerRelativePath, 'user-plugin.ts'),
        ])).toContain('export const User')
      }
    }
    for (const file of deliveredConfigFiles) {
      const contents = await rig.ownedProviderExec(view.containerId!, ['cat', file])
      if (row.provider === 'opencode') {
        expect(contents).toMatch(/global_fixture|other_global|project_fixture|project JSONC/)
      } else {
        expect(contents).toContain(row.provider === 'codex' ? 'fixture_setting' : 'fixtureSetting')
        expect(contents).toContain('user-mcp.cjs')
      }
    }

    const sendId = `send-${randomUUID()}`
    wire.send({ type: 'freshAgent.send', provider: row.provider, sessionType: row.sessionType,
      sessionId: created.sessionId, requestId: sendId, text: 'fixture prompt' })
    const materialized = await wire.wait(frame => frame.type === 'freshAgent.session.materialized'
      && frame.provider === row.provider && frame.previousSessionId === created.sessionId)
    expect(materialized.sessionId).toBe(recorded.nativeSessionId)
    await wire.wait(frame => frame.type === 'freshAgent.turn.complete'
      && frame.provider === row.provider && frame.sessionId === materialized.sessionId)

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
        configCount: consumed.configCount,
        plugin: profile.plugins,
        secretHygiene: { registry: true, supervisor: true, eventJournal: true, docker: true },
        onecli: {
          reference: { provider: row.provider, profile: onecliReferences[0].profile,
            sourcePath: onecliReferences[0].sourcePath,
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
