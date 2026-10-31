import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig } from '../../e2e-browser/helpers/managed-runtime.js'
import { ensureMcpServerBuilt, McpStdioClient } from '../../e2e-browser/helpers/mcp-stdio-client.js'
import { authorizeFreshAgentParityRequest, captureProviderParityVolumes, cleanupProviderParityVolumes, readProviderParitySource, type ProviderParitySource } from '../../helpers/provider-parity-broker.js'
import { makeProviderParityResourcesReadable, prepareProviderParityUserRoots, supervisorRegistrySecretScan } from '../../helpers/provider-parity-environment.js'
import { exposeGrantsToHarness, fakeOnecliGrants, withMissingGrant } from '../../helpers/provider-parity-onecli.js'
import type { InitialProviderVolumeAuthorization } from '../../../scripts/testing/runtime-test-broker.js'
// @ts-expect-error The native model-wire fixture is also used by the offline Node runner.
import { startInManagedContext } from '../providers/codex-local-provider.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const runFile = promisify(execFile)
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
    // Pace one-read observation callbacks; other API calls share the budget.
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${label}`)
}

class FreshWire {
  readonly frames: any[] = []
  readonly sentControls: any[] = []

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

  send(frame: unknown): void {
    if (frame && typeof frame === 'object' && 'type' in frame && ['freshAgent.approval.respond', 'freshAgent.question.respond', 'freshAgent.elicitation.respond'].includes(String(frame.type))) this.sentControls.push(frame)
    this.socket.send(JSON.stringify(frame))
  }

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
  let retainedModelTraffic: any[] = []
  let finalObservation: (() => Promise<unknown>) | undefined
  const namingRequests: string[] = []
  const owners: InitialProviderVolumeAuthorization[] = []

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'freshcodex-managed-native-'))
    workspace = path.join(home, 'workspace')
    fs.mkdirSync(workspace)
    fs.mkdirSync(path.join(workspace, 'allowed'))
    // Match the qualified native sandbox fixture: these read-only mount
    // targets have the same empty protected directories as native qualification.
    fs.mkdirSync(path.join(workspace, '.agents'))
    fs.mkdirSync(path.join(workspace, '.codex'))
    fs.writeFileSync(path.join(workspace, 'child-input.txt'), 'managed-child-command-ran\n')
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
      { XDG_CONFIG_HOME: xdg, ...grants.serverEnv, RUST_LOG: 'info', GOOGLE_GENERATIVE_AI_API_KEY: 'managed-naming-fixture',
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
    const mcpModule = path.join(workspace, 'managed-mcp.mjs')
    fs.copyFileSync(path.join(root, 'test/integration/providers/codex-local-provider.mjs'), mcpModule)
    fs.writeFileSync(path.join(home, '.codex/config.toml'), `model = "contract-model"
model_provider = "contract-loopback"
approval_policy = "untrusted"
model_catalog_json = ${JSON.stringify(catalog)}
web_search = "disabled"
[features]
apps = false
default_mode_request_user_input = true
auth_elicitation = true
non_prefixed_mcp_tool_names = false
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
[mcp_servers.contract]
command = "node"
args = ${JSON.stringify([mcpModule, "--mcp-fixture", "/home/freshell/provider/.codex/managed-mcp-traffic.jsonl", "http://127.0.0.1:51991"])}
enabled = true
required = true
startup_readiness = "connection"
startup_timeout_sec = 15
tool_timeout_sec = 120
`)
    makeProviderParityResourcesReadable(home)
    // The managed RW bind preserves POSIX permissions. Unlike the generic
    // read-only resource fixture, a selected writable project must let its
    // intended provider group create native sandbox mountpoints. Grant only
    // this owned synthetic workspace group access, never provider HOME.
    fs.chmodSync(workspace, 0o770)
    fs.chmodSync(path.join(workspace, "allowed"), 0o770)
    wire = await FreshWire.connect(rig.info)
  }, 900_000)

  afterAll(async () => {
    try {
      if (rig && finalObservation) {
        try { rig.runtime.writeIncident('freshcodex-managed-native-final-state', await finalObservation()) }
        catch (error) { rig.runtime.writeIncident('freshcodex-managed-native-final-state-error', { error: String(error) }) }
      }
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
    if (created.type !== 'freshAgent.created') {
      const inventory = await rig.inventory()
      const providerFiles = inventory.filter(row => row.containerId).map(row => {
        try { return { containerId: row.containerId, files: rig.ownedProviderExec(row.containerId!, ['node', '-e', `const fs=require('node:fs');process.stdout.write(JSON.stringify({mcpModulePresent:fs.existsSync(${JSON.stringify(path.join(workspace, 'managed-mcp.mjs'))}),config:fs.readFileSync('/home/freshell/provider/.codex/config.toml','utf8')}))`]) } }
        catch { return { containerId: row.containerId, unavailable: true } }
      })
      const nativeLogs = [...rig.runtime.broker.receiptIds()].map(containerId => {
        try { return { containerId, logs: rig.runtime.containerLogs(containerId) } }
        catch { return { containerId, unavailable: true } }
      })
      rig.runtime.writeIncident('freshcodex-managed-native-create-failure', { created, inventory, nativeLogs, providerFiles,
        supervisor: rig.runtime.containerLogs(rig.supervisor.containerId), web: rig.web.capturedOutput() })
    }
    expect(created.type, JSON.stringify(created)).toBe('freshAgent.created')
    const view = await waitFor('native managed provider', async () => {
      const row = await rig.runningViewForFreshSession(created.sessionId)
      return row?.containerId && row.nativeSessionId ? row : undefined
    })
    let providerContainerId = view.containerId!
    expect(rig.ownedProviderExec(providerContainerId, ['/opt/freshell-codex/launch', '--version'])).toContain('0.164.0')
    const inspectNativeContext = () => JSON.parse(rig.ownedProviderExec(providerContainerId, ['node', '-e', `
      const fs=require('node:fs');const layout=JSON.parse(fs.readFileSync('/opt/freshell-codex/layout.json','utf8'));
      const candidates=fs.readdirSync('/proc').filter(p=>Number.isInteger(Number(p))).flatMap(pid=>{try{
        const status=fs.readFileSync('/proc/'+pid+'/status','utf8');const field=k=>status.split(String.fromCharCode(10)).find(line=>line.startsWith(k+':'))?.slice(k.length+1).trim();
        let executable,exeError,appServer=false;try{executable=fs.readlinkSync('/proc/'+pid+'/exe')}catch(error){exeError=error.code}
        try{appServer=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split(String.fromCharCode(0)).includes('app-server')}catch{}
        if(executable!==layout.nativeExecutable&&!appServer&&field('Name')!=='codex')return[];
        let cwd,cwdError,workspace;try{cwd=fs.readlinkSync('/proc/'+pid+'/cwd');const s=fs.statSync(cwd);let writable=false;try{fs.accessSync(cwd,fs.constants.W_OK);writable=true}catch{}workspace={uid:s.uid,gid:s.gid,mode:(s.mode&511).toString(8),writable}}catch(error){cwdError=error.code}
        return[{pid:Number(pid),parentPid:Number(field('PPid')),state:field('State'),uid:Number(field('Uid')?.split(String.fromCharCode(9))[0]),gid:Number(field('Gid')?.split(String.fromCharCode(9))[0]),
          executable,exeError,appServer,cwd,cwdError,workspace,noNewPrivs:field('NoNewPrivs'),capEff:field('CapEff')}];
      }catch{return[]}});const found=candidates.filter(row=>row.executable===layout.nativeExecutable&&row.appServer);
      if(found.length!==1)throw Error('Expected one actual installed native Codex app-server: '+JSON.stringify({expectedNative:layout.nativeExecutable,matches:found.length,candidates}));process.stdout.write(JSON.stringify(found[0]));`]))
    const nativeContext = inspectNativeContext()
    expect(nativeContext).toMatchObject({ uid: 65534, gid: 0, cwd: workspace, noNewPrivs: '1', capEff: '0000000000000000',
      workspace: { gid: 0, mode: '770', writable: true } })
    const handlerSource = `async record => {
      const input=record.body.input;
      const user=input.filter(item=>item.role==='user').at(-1);
      const prompt=JSON.stringify(user);
      const call=(name,args,id)=>{
        let namespace;let tool=record.body.tools.find(tool=>tool.type==='function'&&tool.name===name);
        if(!tool){const group=record.body.tools.find(tool=>tool.type==='namespace'&&tool.tools?.some(member=>member.name===name));tool=group?.tools.find(member=>member.name===name);namespace=group?.name;}
        if(!tool)throw Error('Native model did not advertise '+name);
        return {items:[{id:'fc_'+id,type:'function_call',call_id:'call_'+id,...(namespace?{namespace}:{}),name,arguments:JSON.stringify(args),status:'completed'}]};
      };
      const output=id=>input.find(item=>item.type==='function_call_output'&&item.call_id==='call_'+id);
      const mcpRoute=['form','openai/form','openaiForm','url'].find(route=>prompt.includes('MANAGED_MCP_'+route));
      if(mcpRoute){const id='mcp_'+mcpRoute.replaceAll('/','_');if(!output(id))return call('elicit',{route:mcpRoute,sequence:'matrix'},id);if(!JSON.stringify(output(id)).includes('Fixture sequence completed'))throw Error('Actual MCP roundtrip did not complete');return{text:'Managed MCP '+mcpRoute+' completed.'};}
      if(prompt.includes('MANAGED_EFFECT_')){const denied=prompt.includes('MANAGED_EFFECT_DECLINE');const readonly=prompt.includes('MANAGED_EFFECT_READONLY');const restricted=prompt.includes('MANAGED_EFFECT_RESTRICTED');const id=denied?'effect_decline':readonly?'effect_readonly':restricted?'effect_restricted':'effect_accept';if(!output(id))return call('exec_command',{cmd:'id -u; printf managed-'+id+' > allowed/'+id,shell:'/bin/sh',login:false,max_output_tokens:1000},id);return{text:'Managed '+id+' result: '+JSON.stringify(output(id))};}
      if(prompt.includes('MANAGED_CHILD_NATIVE')){if(!output('child_command'))return call('exec_command',{cmd:'cat child-input.txt',shell:'/bin/sh',login:false,max_output_tokens:1000},'child_command');if(!JSON.stringify(output('child_command')).includes('managed-child-command-ran'))throw Error('Actual child command output missing');return{text:'Managed child final answer.',pauseAfterDelta:async()=>{const fs=await import('node:fs');const deadline=Date.now()+90000;while(!fs.existsSync('/home/freshell/provider/.freshell-fixture/release-child')){if(Date.now()>deadline)throw Error('Managed child release deadline');await new Promise(resolve=>setTimeout(resolve,50));}}};}
      if(prompt.includes('MANAGED_DURABLE_CHILD')){if(!output('managed_child'))return call('spawn_agent',{message:'MANAGED_CHILD_NATIVE: run the controlled child command and return its result.',fork_context:false},'managed_child');return{text:'Managed parent registered child.'};}
      if(prompt.includes('AWAITED_PLAN')&&!input.some(item=>item.call_id==='call_awaited'))return call('request_user_input',{questions:[{id:'managed_choice',header:'Choice',question:'Which managed result?',options:[{label:'Alpha',description:'First result'},{label:'Beta',description:'Second result'}]}]},'awaited');
      if(prompt.includes('ASYNC_QUESTION')&&!input.some(item=>item.call_id==='call_async'))return call('request_user_input_async',{questions:[{title:'Which managed environment?',options:['Staging','Production']}]},'async');
      if(prompt.includes('MANAGED_RECOVERY_SECOND'))return{text:'Managed recovery second answer.'};
      return {text:prompt.includes('ASYNC_QUESTION')?'Managed work continued before the answer.':prompt.includes('AWAITED_PLAN')?'Managed awaited answer completed.':'Managed native final answer.'};
    }`
    model = await startInManagedContext(rig, { containerId: providerContainerId, handlerSource })
    expect(model.context).toMatchObject({ uid: 65534, gid: 0 })
    const headers = { 'x-auth-token': rig.info.token }
    const observationReadTraffic: { route: string; requestedAt: number; completedAt: number; status: number; retryAfter: string | null }[] = []
    const observeRead = async (route: string, init: RequestInit) => {
      const requestedAt = Date.now()
      const response = await fetch(`${rig.info.baseUrl}${route}`, init)
      observationReadTraffic.push({ route, requestedAt, completedAt: Date.now(), status: response.status, retryAfter: response.headers.get('retry-after') })
      return response
    }
    const snapshot = async () => {
      const response = await observeRead(`/api/fresh-agent/threads/freshcodex/codex/${created.sessionId}`, { headers })
      expect(response.ok, await response.clone().text()).toBe(true)
      return response.json()
    }
    const ownedHostEvidence = () => {
      const runtimeRoot = rig.supervisor.runtimeRoot
      const lifecycle = fs.readdirSync(runtimeRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith('incarnation-'))
        .map(entry => {
          const file = path.join(runtimeRoot, entry.name, 'host-lifecycle.jsonl')
          return { incarnationId: entry.name, events: fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] }
        })
      const soulsRoot = path.join(runtimeRoot, 'souls')
      const actorProfiles = fs.existsSync(soulsRoot) ? fs.readdirSync(soulsRoot).flatMap(entry => {
        const file = path.join(soulsRoot, entry, 'actor/fresh-agent-state.json')
        if (!fs.existsSync(file)) return []
        const { profile } = JSON.parse(fs.readFileSync(file, 'utf8'))
        const fields = ['provider', 'runtimeVariant', 'providerStoreId', 'nativeSessionId', 'sessionRef', 'namingHandle',
          'cwd', 'model', 'effort', 'permissionMode', 'sandbox', 'collaborationMode']
        return [{ directory: entry, profile: Object.fromEntries(fields.filter(key => key in profile).map(key => [key, profile[key]])) }]
      }) : []
      return { lifecycle, actorProfiles }
    }
    finalObservation = async () => {
      let final: unknown
      try { final = await snapshot() } catch (error) { final = { error: String(error) } }
      const currentViews = await rig.inventory()
      const hostDiagnostics = [...rig.runtime.broker.receiptIds()].map(containerId => {
        let state: unknown
        try { const inspected = rig.runtime.inspectContainer(containerId); state = inspected.State }
        catch (error) { state = { error: String(error) } }
        return { containerId, state, logs: rig.runtime.containerLogs(containerId).slice(-64 * 1024) }
      })
      let nativeFiles: unknown
      try { nativeFiles = JSON.parse(rig.ownedProviderExec(providerContainerId, ['node', '-e', `
        const fs=require('node:fs'),p='/home/freshell/provider/.codex/managed-mcp-traffic.jsonl';
        process.stdout.write(JSON.stringify({mcp:fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(JSON.parse):[],effects:fs.readdirSync(${JSON.stringify(path.join(workspace, 'allowed'))}).map(name=>{const p=${JSON.stringify(path.join(workspace, 'allowed'))}+'/'+name;return{name,uid:fs.statSync(p).uid,content:fs.readFileSync(p,'utf8')}})}));`]))
      } catch (error) { nativeFiles = { error: String(error) } }
      let traffic: unknown = retainedModelTraffic
      try { if (model) traffic = model.traffic } catch (error) { traffic = { retained: retainedModelTraffic, error: String(error) } }
      const logDirectory = path.join(home, '.freshell', 'logs')
      const requestLogFiles = fs.readdirSync(logDirectory).filter(name => name.startsWith('rust-server.jsonl'))
      const publicHttpRequests = requestLogFiles.flatMap(name => fs.readFileSync(path.join(logDirectory, name), 'utf8').split('\n')).flatMap(line => {
        let row: any
        try { row = JSON.parse(line) } catch { return [] }
        if (row.msg !== 'http_request') return []
        return [{ timestamp: row.ts, requestId: row.request_id, serverPid: row.server_pid, method: row.method,
          route: String(row.route).split('?')[0], status: row.status, durationMs: row.duration_ms }]
      })
      const apiRequests = publicHttpRequests.filter(row => row.route.startsWith('/api/') && row.route !== '/api/health')
      const publicApiCounts = { total: apiRequests.length,
        byRoute: apiRequests.reduce<Record<string, number>>((counts, row) => { counts[row.route] = (counts[row.route] ?? 0) + 1; return counts }, {}),
        byStatus: apiRequests.reduce<Record<string, number>>((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts }, {}) }
      return { created, initialView: view, currentViews, nativeContext, final,
        fixtureContext: model?.context, traffic, sentControls: wire.sentControls, frames: wire.frames,
        nativeFiles, hostDiagnostics, observationReadTraffic, publicHttpRequests, publicApiCounts, ownedHostEvidence: ownedHostEvidence() }
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
    const standalone = ensureMcpServerBuilt(root)
    const standaloneEnvironment = { ...process.env, FRESHELL_URL: rig.info.baseUrl, FRESHELL_TOKEN: rig.info.token }
    const cliEntry = path.join(root, 'dist/tools/freshell-cli/index.js')
    const cliCapture = await runFile(process.execPath, [cliEntry, 'capture-pane', '--target', paneId], {
      cwd: root, env: standaloneEnvironment, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    })
    expect(cliCapture.stdout).toContain('MANAGED_NATIVE_FIRST')
    expect(cliCapture.stdout).toContain('Managed native final answer.')
    const standaloneMcp = new McpStdioClient({ command: process.execPath, args: [standalone.path], env: standaloneEnvironment, requestTimeoutMs: 60_000 })
    try {
      await standaloneMcp.initialize()
      const mcpCapture = await standaloneMcp.callFreshellAction('capture-pane', { target: paneId })
      expect(mcpCapture).toContain('MANAGED_NATIVE_FIRST')
      expect(mcpCapture).toContain('Managed native final answer.')
      const mcpWait = await standaloneMcp.callFreshellAction('wait-for', { target: paneId, pattern: 'Managed native final answer.', timeout: 0 })
      expect(mcpWait).toMatchObject({ status: 'ok', data: { matched: true } })
      rig.runtime.writeIncident('freshcodex-managed-native-standalone-integration', { paneId, userRef: created.sessionId,
        nativeSessionId: view.nativeSessionId, cli: { entry: cliEntry, capture: cliCapture.stdout },
        mcp: { entry: standalone.path, capture: mcpCapture, wait: mcpWait } })
    } finally {
      await standaloneMcp.close()
    }
    expect(inspectNativeContext().pid).toBe(nativeContext.pid)
    const durableNameRef = { kind: 'session', provider: 'codex', sessionId: view.nativeSessionId }
    const readNameFor = async (ref: unknown) => {
      const response = await observeRead('/api/session-names/read', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ refs: [ref] }) })
      expect(response.ok, `name read ${response.status}: ${await response.clone().text()}`).toBe(true)
      return (await response.json()).names[0]?.record
    }
    const readName = () => readNameFor(durableNameRef)
    const nativeMetadata = JSON.parse(rig.ownedProviderExec(providerContainerId, ['node', '-e', `
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
    const hostMetadataAccess = JSON.parse(rig.ownedContainerExec(providerContainerId, ['node', '-e', `
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
    const readNativeName = (nativeId = view.nativeSessionId, context = nativeContext) => JSON.parse(rig.ownedProviderExec(providerContainerId, ['node', '-e', `
      const fs=require('node:fs');const argv=fs.readFileSync('/proc/${context.pid}/cmdline','utf8').split(String.fromCharCode(0));
      const endpoint=argv[argv.indexOf('--listen')+1];const target=new URL(endpoint);
      if(target.protocol!=='ws:'||target.hostname!=='127.0.0.1'||!target.port)throw Error('Expected the existing native loopback endpoint');
      const socket=new WebSocket(endpoint);let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.close();
        if(error){process.stderr.write(String(error));process.exit(1)}process.stdout.write(JSON.stringify(value),()=>process.exit(0));};
      const timer=setTimeout(()=>finish('Existing native metadata observer timed out'),8000);
      socket.addEventListener('error',()=>finish('Existing native metadata connection failed'));
      socket.addEventListener('open',()=>socket.send(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'freshell_name_read_probe',version:'1'}}})));
      socket.addEventListener('message',event=>{const frame=JSON.parse(String(event.data));if(frame.error)return finish(frame.error.message);
        if(frame.id===1){socket.send(JSON.stringify({method:'initialized'}));socket.send(JSON.stringify({id:2,method:'thread/read',params:{threadId:${JSON.stringify(nativeId)},includeTurns:false}}));}
        if(frame.id===2)finish(null,{id:frame.result.thread.id,title:frame.result.thread.name??null});});`]))
    const nativeNameBeforeWait = readNativeName()
    rig.runtime.writeIncident('freshcodex-managed-native-name-writeback', { canonicalName, nativeNameBeforeWait, view, nativeContext })
    await waitFor('managed native name writeback', () => {
      const observation = readNativeName()
      return observation.id === view.nativeSessionId && observation.title === canonicalName.name ? observation : undefined
    }, 15_000)
    rig.runtime.writeIncident('freshcodex-managed-native-journey', { created, view, nativeContext, context: model.context,
      traffic: model.traffic, saved, asyncSnapshot, canonicalName, nativeName: readNativeName(), final: await snapshot() })

    const approval = async (decision: 'accept' | 'cancel', threadId = view.nativeSessionId) => {
      const pending = await waitFor('actual managed native approval', async () => {
        const value = await snapshot()
        return value.pendingApprovals?.find((item: any) => item.providerRequest?.threadId === threadId)
      })
      expect(pending.providerRequest.threadId).toBe(threadId)
      expect(pending.native.availableDecisions).toContain(decision)
      wire.send({ type: 'freshAgent.approval.respond', provider: 'codex', sessionType: 'freshcodex', sessionId: created.sessionId,
        requestId: pending.requestId, decision: { nativeDecision: decision } })
      return pending
    }
    const effects: any[] = []
    for (const choice of ['ACCEPT', 'DECLINE', 'RESTRICTED', 'READONLY'] as const) {
      const file = `effect_${choice.toLowerCase() === 'readonly' ? 'readonly' : choice.toLowerCase()}`
      const physical = () => JSON.parse(rig.ownedProviderExec(providerContainerId, ['node', '-e', `
        const fs=require('node:fs'),p=${JSON.stringify(path.join(workspace, 'allowed'))}+'/'+${JSON.stringify(file)};
        process.stdout.write(JSON.stringify(fs.existsSync(p)?{exists:true,uid:fs.statSync(p).uid,content:fs.readFileSync(p,'utf8')}:{exists:false}));`]))
      expect(physical()).toEqual({ exists: false })
      const frameCursor = wire.frames.length
      const accepted = await send(`MANAGED_EFFECT_${choice}`, { sandbox: choice === 'READONLY' ? 'read-only' : 'workspace-write', permissionMode: choice === 'READONLY' || choice === 'RESTRICTED' ? 'never' : 'untrusted' })
      const decision = choice === 'ACCEPT' ? 'accept' : 'cancel'
      const control = choice === 'READONLY' || choice === 'RESTRICTED' ? undefined : await approval(decision)
      const completed = await waitFor(`managed ${choice} command result`, async () => {
        const value = await snapshot()
        return value.status === 'idle' && JSON.stringify(value.turns).includes('MANAGED_EFFECT_'+choice)
          && !value.pendingApprovals.some((pending: any) => pending.requestId === control?.requestId)
          && wire.frames.slice(frameCursor).some(frame => {
            const event = frame.type === 'freshAgent.event' ? frame.event : frame
            const nativeTurn = value.turns.find((turn: any) => turn.role === 'user' && turn.items?.some((item: any) => item.text === 'MANAGED_EFFECT_'+choice))?.nativeTurnId
            return event.type === 'freshAgent.transcript.patch' && event.sessionId === created.sessionId
              && event.ops?.some((op: any) => op.op === 'settleTurn' && op.nativeTurnId === nativeTurn && ['completed', 'interrupted', 'failed'].includes(op.status))
          })
          && (choice === 'DECLINE' || JSON.stringify(value.turns).includes('Managed '+file+' result:')) ? value : undefined
      })
      const effect = physical()
      if (choice === 'ACCEPT' || choice === 'RESTRICTED') expect(effect).toMatchObject({ exists: true, uid: 65534, content: 'managed-'+file })
      else expect(effect).toEqual({ exists: false })
      if (choice === 'READONLY') {
        // Native0.164 can return a failed unifiedExec result to the model
        // without persisting a commandExecution history item. Read the real
        // native tool result, never the fixture's repeated assistant phrase.
        const command = model.traffic.flatMap((row: any) => row.body?.input ?? [])
          .filter((item: any) => item.type === 'function_call_output' && item.call_id === 'call_effect_readonly').at(-1)
        expect(command?.output).toMatch(/Process exited with code [1-9][0-9]*/)
        expect(command?.output).toContain('Output:\n65534\n')
        expect(command?.output).toContain('Read-only file system')
        expect(command?.output).not.toContain('bwrap:')
      }
      if (control) expect(wire.sentControls.filter(frame => frame.type === 'freshAgent.approval.respond' && frame.requestId === control.requestId)).toEqual([{
        type: 'freshAgent.approval.respond', provider: 'codex', sessionType: 'freshcodex', sessionId: created.sessionId,
        requestId: control.requestId, decision: { nativeDecision: decision },
      }])
      effects.push({ choice, nativeDecision: control ? decision : null, accepted, control, effect, terminal: completed, settings: completed.settings })
      rig.runtime.writeIncident('freshcodex-managed-native-command-effects', effects)
    }
    const mcpResults: any[] = []
    for (const route of ['form', 'openai/form', 'openaiForm', 'url']) {
      await send(`MANAGED_MCP_${route}`, { sandbox: 'workspace-write', permissionMode: 'untrusted' })
      const ids = new Set<string>()
      for (const action of ['accept', 'decline', 'cancel']) {
        const pending = await waitFor(`managed ${route} ${action} elicitation`, async () => {
          const value = await snapshot()
          return value.pendingElicitations?.find((item: any) => !ids.has(item.requestId))
        })
        ids.add(pending.requestId)
        // Fetching the URL is a read; the explicit native decision is separate.
        if (route === 'url') {
          expect(rig.ownedProviderExec(providerContainerId, ['node', '-e', `fetch('http://127.0.0.1:51991/elicitation/example').then(r=>{if(!r.ok)throw Error('URL fixture failed');process.stdout.write('opened')})`])).toBe('opened')
          expect((await snapshot()).pendingElicitations.some((item: any) => item.requestId === pending.requestId)).toBe(true)
        }
        wire.send({ type: 'freshAgent.elicitation.respond', provider: 'codex', sessionType: 'freshcodex', sessionId: created.sessionId,
          requestId: pending.requestId, action, content: action === 'accept' && route !== 'url' ? { name: 'fixture', count: 2.5, enabled: true, color: 'blue' } : null })
      }
      await waitFor(`managed ${route} MCP completion`, async () => {
        const value = await snapshot()
        return value.status === 'idle' && JSON.stringify(value.turns).includes('Managed MCP '+route+' completed.') ? true : undefined
      })
      const traffic = JSON.parse(rig.ownedProviderExec(providerContainerId, ['node', '-e', `const fs=require('node:fs');process.stdout.write(JSON.stringify(fs.readFileSync('/home/freshell/provider/.codex/managed-mcp-traffic.jsonl','utf8').trim().split(String.fromCharCode(10)).map(JSON.parse)))`]))
      const results = traffic.filter((row: any) => row.event === 'elicitation_result' && row.route === route)
      expect(results.map((row: any) => row.result.action)).toEqual(['accept', 'decline', 'cancel'])
      expect(traffic.some((row: any) => row.event === 'fixture_error')).toBe(false)
      mcpResults.push({ route, results })
      rig.runtime.writeIncident('freshcodex-managed-native-mcp-results', mcpResults)
    }
    await send('MANAGED_DURABLE_CHILD')
    const registered = await waitFor('public managed registered child', async () => {
      const value = await snapshot()
      return value.childThreads?.find((item: any) => item.threadId) ? value : undefined
    })
    const child = registered.childThreads[0]
    const childId = child.threadId
    const childControl = await approval('accept', childId)
    const childResponse = await waitFor('public managed active child read', async () => {
      const response = await fetch(`${rig.info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${created.sessionId}/children/${childId}`, { headers })
      expect(response.ok, await response.clone().text()).toBe(true)
      const value = await response.json()
      return value.status === 'live' && JSON.stringify(value.snapshot?.turns).includes('MANAGED_CHILD_NATIVE') ? value : undefined
    })
    expect(childResponse).toMatchObject({ parentThreadId: view.nativeSessionId, childThreadId: childId, status: 'live',
      snapshot: { threadId: childId, capabilities: { send: false, interrupt: false, fork: false, undo: false } } })
    expect(inspectNativeContext().pid).toBe(nativeContext.pid)
    rig.ownedProviderExec(providerContainerId, ['node', '-e', "require('node:fs').writeFileSync('/home/freshell/provider/.freshell-fixture/release-child','release')"])
    const childSaved = await waitFor('public managed saved child after completion', async () => {
      const response = await fetch(`${rig.info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${created.sessionId}/children/${childId}`, { headers })
      expect(response.ok).toBe(true)
      const value = await response.json()
      return value.status === 'saved' && JSON.stringify(value).includes('Managed child final answer.') ? value : undefined
    })
    expect(childSaved).toMatchObject({ parentThreadId: view.nativeSessionId, childThreadId: childId, status: 'saved' })
    await waitFor('managed child control drained', async () => !(await snapshot()).pendingApprovals.length ? true : undefined)
    rig.runtime.writeIncident('freshcodex-managed-native-durable-child', { registered, childControl, childResponse, childSaved, parent: await snapshot() })
    const beforeRestart = { view: await rig.runningViewForFreshSession(created.sessionId), snapshot: await snapshot(), name: await readName() }
    expect(beforeRestart.name).toEqual(canonicalName)
    const previousTraffic = model.traffic
    retainedModelTraffic = previousTraffic
    rig.runtime.writeIncident('freshcodex-managed-native-before-host-restart', { beforeRestart, canonicalName, effects, mcpResults, registered, childControl, childResponse, childSaved, traffic: previousTraffic })
    await model.stop()
    model = undefined
    rig.runtime.restartOwnedRuntimeExact(providerContainerId)
    const restarted = await waitFor('ordinary same-conversation host recovery readiness', async () => {
      const current = await rig.runningViewForFreshSession(created.sessionId)
      const diagnostics = [...rig.runtime.broker.receiptIds()].map(containerId => ({ containerId,
        logs: rig.runtime.containerLogs(containerId).slice(-32 * 1024) }))
      rig.runtime.writeIncident('freshcodex-managed-native-host-restart-status', { current, diagnostics, ownedHostEvidence: ownedHostEvidence() })
      if (!current?.containerId || !current.hostBootId
        || current.hostBootId === beforeRestart.view!.hostBootId
        || !rig.runtime.isContainerRunning(current.containerId)) return undefined
      providerContainerId = current.containerId
      try {
        const context = inspectNativeContext()
        expect(context).toMatchObject({ uid: 65534, gid: 0, noNewPrivs: '1', capEff: '0000000000000000' })
        const value = await snapshot()
        return value.threadId === view.nativeSessionId && value.status !== 'unavailable' ? current : undefined
      } catch { return undefined }
    })
    expect(restarted.nativeSessionId).toBe(view.nativeSessionId)
    model = await startInManagedContext(rig, { containerId: providerContainerId, handlerSource })
    await send('MANAGED_AFTER_HOST_RESTART')
    const afterRestart = await waitFor('same-conversation restarted send saved', async () => {
      const value = await snapshot()
      return value.status === 'idle' && JSON.stringify(value.turns).includes('MANAGED_AFTER_HOST_RESTART') ? value : undefined
    })
    expect(afterRestart.settings).toEqual(beforeRestart.snapshot.settings)
    expect(afterRestart.threadId).toBe(view.nativeSessionId)
    expect(JSON.stringify(afterRestart.turns)).toContain('MANAGED_NATIVE_FIRST')
    expect(await readName()).toEqual(canonicalName)
    expect(model.traffic.filter((row: any) => row.path === '/v1/responses')).toHaveLength(1)
    rig.runtime.writeIncident('freshcodex-managed-native-tools-restart', { created, nativeContext, canonicalName, effects, mcpResults,
      registered, childControl, childResponse, childSaved, beforeRestart, restarted, afterRestart, traffic: previousTraffic, restartedTraffic: model.traffic, finalName: await readName() })

    const recoveryCwd = path.join(workspace, 'recovery-cwd')
    fs.mkdirSync(recoveryCwd)
    fs.chmodSync(recoveryCwd, 0o755)
    await send('MANAGED_RECOVERY_READY', { cwd: recoveryCwd, model: 'contract-model', effort: 'xhigh',
      collaborationMode: 'plan', permissionMode: 'never', sandbox: 'read-only' })
    const recoverySettings = await waitFor('saved exact settings before native crash', async () => {
      const value = await snapshot()
      return value.status === 'idle' && value.settings?.cwd === recoveryCwd ? value.settings : undefined
    })
    expect(recoverySettings).toMatchObject({ cwd: recoveryCwd, model: 'contract-model', effort: 'xhigh',
      collaborationMode: 'plan', permissionMode: 'never', sandbox: 'read-only' })
    const beforeCrash = { view: await rig.runningViewForFreshSession(created.sessionId), snapshot: await snapshot(),
      name: await readName(), nativeContext: inspectNativeContext(), trafficCursor: model.traffic.length }
    expect(beforeCrash.name).toEqual(canonicalName)
    rig.runtime.writeIncident('freshcodex-managed-native-before-crash', beforeCrash)
    // Kill only this receipt-owned, inspected release native PID. Archive its
    // REAL native-generated history after exit, keeping every original byte.
    // The host stays live; no internal exited flag or Started event is forged.
    rig.runtime.killOwnedRuntimePidExact(providerContainerId, beforeCrash.nativeContext.pid)
    const nativeExit = await waitFor('exact native process terminal state before history archive', () => {
      const state = JSON.parse(rig.ownedProviderExec(providerContainerId, ['node', '-e', `
        const fs=require('node:fs'),p='/proc/${beforeCrash.nativeContext.pid}/status';
        process.stdout.write(JSON.stringify(fs.existsSync(p)?{exists:true,state:fs.readFileSync(p,'utf8').split(String.fromCharCode(10)).find(line=>line.startsWith('State:')).slice(6).trim()}:{exists:false}));`]))
      return !state.exists || state.state.startsWith('Z') ? state : undefined
    })
    const originalRollout = nativeMetadata.headers.find((header: any) => header.id === view.nativeSessionId).path
    const archived = JSON.parse(rig.ownedProviderExec(providerContainerId, ['node', '-e', `
      const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
      const root='/home/freshell/provider/.codex';const original=${JSON.stringify(originalRollout)};
      const directory='/home/freshell/provider/.freshell-fixture/native-crash-history';fs.mkdirSync(directory,{mode:448});
      const selected=[original,...fs.readdirSync(root).filter(name=>/^state_[0-9]+[.]sqlite(?:-wal|-shm)?$/.test(name)||name==='session_index.jsonl').map(name=>path.join(root,name))];
      const files=selected.filter(file=>fs.existsSync(file)).map((file,index)=>{const bytes=fs.readFileSync(file);const destination=path.join(directory,String(index)+'-'+path.basename(file));fs.renameSync(file,destination);return{source:file,archive:destination,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,base64:bytes.toString('base64')}});
      if(!files.some(file=>file.source===original))throw Error('Exact real native rollout was not archived');process.stdout.write(JSON.stringify({directory,files}));`]))
    const archiveDirectory = path.join(rig.runtime.evidenceDir, 'native-crash-history')
    fs.mkdirSync(archiveDirectory, { mode: 0o700 })
    const archiveManifest = archived.files.map((file: any, index: number) => {
      const bytes = Buffer.from(file.base64, 'base64')
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256)
      const copy = path.join(archiveDirectory, `${index}-${path.basename(file.source)}`)
      fs.writeFileSync(copy, bytes, { mode: 0o600 })
      const { base64, ...metadata } = file
      return { ...metadata, copy }
    })
    fs.writeFileSync(path.join(archiveDirectory, 'manifest.json'), JSON.stringify(archiveManifest, null, 2), { mode: 0o600 })
    const recoveryAccepted = await send('AWAITED_PLAN_RECOVERY')
    const recovered = await rig.runningViewForFreshSession(created.sessionId)
    rig.runtime.writeIncident('freshcodex-managed-native-crash-first-send', { userRef: created.sessionId, beforeCrash,
      archiveManifest, nativeExit, recoveryAccepted, recovered, newTraffic: model.traffic.slice(beforeCrash.trafficCursor), frames: wire.frames.slice(-30) })
    // Acceptance must durably commit the new native source before returning.
    expect(recovered?.nativeSessionId).toBeTruthy()
    expect(recovered!.nativeSessionId).not.toBe(view.nativeSessionId)
    expect(recovered!.freshAgentSessionId).toBe(created.sessionId)
    const recoveredId = recovered!.nativeSessionId!
    const recoveryControl = await waitFor('new native source control through original durable user reference', async () => {
      const value = await snapshot()
      expect(value.threadId).toBe(recoveredId)
      expect(value.settings).toEqual(recoverySettings)
      return value.pendingQuestions?.find((question: any) => question.providerRequest.threadId === recoveredId)
    })
    wire.send({ type: 'freshAgent.question.respond', provider: 'codex', sessionType: 'freshcodex', sessionId: created.sessionId,
      requestId: recoveryControl.requestId, answers: { managed_choice: 'Alpha' } })
    await waitFor('recovered native exact control resolution', async () => {
      const value = await snapshot()
      return value.status === 'idle' && !value.pendingQuestions.length ? true : undefined
    })
    await send('MANAGED_RECOVERY_SECOND')
    const second = await waitFor('second send on same durable user reference', async () => {
      const value = await snapshot()
      return value.status === 'idle' && JSON.stringify(value.turns).includes('Managed recovery second answer.') ? value : undefined
    })
    expect(second.threadId).toBe(recoveredId)
    expect(second.settings).toEqual(recoverySettings)
    expect(JSON.stringify(second.turns)).not.toContain('MANAGED_NATIVE_FIRST')
    expect(await readName()).toEqual(canonicalName)
    const recoveredNameRef = { kind: 'session', provider: 'codex', sessionId: recoveredId }
    const recoveredName = await waitFor('policy-correct new conversation name record', async () => {
      const name = await readNameFor(recoveredNameRef)
      return name?.ref?.sessionId === recoveredId ? name : undefined
    })
    expect(recoveredName.ref).toEqual(recoveredNameRef)
    expect(recoveredName.name).not.toBe(canonicalName.name)
    const renamedRecovery = await fetch(`${rig.info.baseUrl}/api/session-names`, { method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ target: recoveredNameRef,
        name: 'Managed recovered saved name', nameIntent: 'user' }) })
    expect(renamedRecovery.ok, await renamedRecovery.clone().text()).toBe(true)
    rig.runtime.writeIncident('freshcodex-managed-native-recovery-name-progress', { userRef: created.sessionId,
      oldNativeRef: durableNameRef, newNativeRef: recoveredNameRef, oldName: await readName(), firstNewName: recoveredName,
      manualNewName: await readNameFor(recoveredNameRef), recovered, recoveryControl, second, archiveManifest })
    const recoveredNativeContext = inspectNativeContext()
    expect(recoveredNativeContext).toMatchObject({ uid: 65534, gid: 0, noNewPrivs: '1', capEff: '0000000000000000' })
    await waitFor('recovered source native name writeback', () => readNativeName(recoveredId, recoveredNativeContext).title === 'Managed recovered saved name' ? true : undefined, 15_000)
    const recoveredCapture = await fetch(`${rig.info.baseUrl}/api/panes/${paneId}/capture`, { headers })
    expect(recoveredCapture.ok, await recoveredCapture.clone().text()).toBe(true)
    const capture = await recoveredCapture.text()
    expect(capture).toContain('Managed recovery second answer.')
    expect(capture).not.toContain('MANAGED_NATIVE_FIRST')
    const newTraffic = model.traffic.slice(beforeCrash.trafficCursor).filter((row: any) => row.path === '/v1/responses')
    expect(newTraffic.filter((row: any) => row.body.input.filter((item: any) => item.role === 'user').at(-1)?.content?.some((part: any) => part.text?.includes('MANAGED_RECOVERY_SECOND')))).toHaveLength(1)
    expect(newTraffic.every((row: any) => !JSON.stringify(row.body.input).includes('MANAGED_NATIVE_FIRST'))).toBe(true)
    expect((await rig.inventory()).filter(row => row.provider === 'codex' && row.nativeSessionId === recoveredId && row.launchState === 'running')).toHaveLength(1)
    rig.runtime.writeIncident('freshcodex-managed-native-recovery', { userRef: created.sessionId, oldNativeRef: created.sessionRef,
      newNativeRef: recoveredNameRef, beforeCrash, archiveManifest, nativeExit, recoveryAccepted, recovered, recoveryControl, second, capture,
      oldName: await readName(), firstNewName: recoveredName, finalNewName: await readNameFor(recoveredNameRef),
      nativeName: readNativeName(recoveredId, recoveredNativeContext), recoveredNativeContext, newTraffic })

  }, 360_000)
})
