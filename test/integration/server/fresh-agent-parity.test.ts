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

import { configureStore } from '@reduxjs/toolkit'
import { FreshAgentSnapshotSchema } from '../../../shared/fresh-agent-contract.js'
import { handleFreshAgentMessage } from '../../../src/lib/fresh-agent-ws.js'
import { streamBatcherFor } from '../../../src/lib/fresh-agent-stream-batcher.js'
import { mergeFreshAgentTranscriptProjection, readTranscriptProjection } from '../../../src/lib/fresh-agent-transcript-projection.js'
import freshAgentReducer, { sessionCreated } from '../../../src/store/freshAgentSlice.js'
import freshAgentLiveReducer, { transcriptProjectionSnapshotReceived } from '../../../src/store/freshAgentLiveSlice.js'
import panesReducer, { initLayout } from '../../../src/store/panesSlice.js'
import turnCompletionReducer from '../../../src/store/turnCompletionSlice.js'
import type { AppDispatch } from '../../../src/store/store.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig } from '../../e2e-browser/helpers/managed-runtime.js'
import { ensureMcpServerBuilt, McpStdioClient } from '../../e2e-browser/helpers/mcp-stdio-client.js'
import { authorizeFreshAgentParityRequest, readProviderParitySource, type ProviderParitySource } from '../../helpers/provider-parity-broker.js'
import { makeProviderParityResourcesReadable, prepareProviderParityUserRoots, supervisorRegistrySecretScan } from '../../helpers/provider-parity-environment.js'
import { exposeGrantsToHarness, fakeOnecliGrants, withMissingGrant } from '../../helpers/provider-parity-onecli.js'
import type { InitialProviderVolumeAuthorization } from '../../../scripts/testing/runtime-test-broker.js'
// @ts-expect-error The native model-wire fixture is also used by the offline Node runner.
import { startInManagedContext } from '../providers/codex-local-provider.mjs'
import { cleanupProviderParity } from '../../helpers/provider-parity-cleanup.js'
import { cleanupManagedCodexParity, collectManagedCodexProviderDiagnostics, createManagedCodexFixtureWork, readManagedCodexFixtureTraffic } from '../../helpers/codex-managed-cleanup.js'
import { awaitManagedCodexWork, initializeManagedCodexStandaloneMcp, readManagedCodexCreateFailureFiles, recordManagedCodexMcpResults, runManagedCodexAwaitedPlanControl, runManagedCodexParityBody, sendManagedCodexMessage, waitForManagedCodexContextualAnswer } from '../../helpers/codex-managed-body.js'

const root = path.resolve(import.meta.dirname, '../../..')
const runFile = promisify(execFile)
const providers = [
  { provider: 'claude', sessionType: 'freshclaude', config: '.claude/settings.json' },
  { provider: 'codex', sessionType: 'freshcodex', config: '.codex/config.toml' },
  { provider: 'opencode', sessionType: 'freshopencode', config: 'custom-xdg/opencode/opencode.jsonc' },
] as const

type ManagedCodexTrafficRecord = {
  index: number
  method?: string
  path?: string
  loopback: boolean
  body: unknown
}

async function waitFor<T>(label: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 90_000, signal?: AbortSignal): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const value = await probe()
    signal?.throwIfAborted()
    if (value !== undefined) return value
    // Pace one-read observation callbacks; other API calls share the budget.
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  signal?.throwIfAborted()
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

  wait(predicate: (frame: any) => boolean, signal?: AbortSignal): Promise<any> {
    return waitFor('fresh-agent frame', () => this.frames.find(predicate), 90_000, signal).catch(error => {
      if (signal?.aborted) throw error
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
    const createFrameCursor = wire.frames.length
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

    if (row.provider === 'codex') {
      expect(created.sessionId).not.toBe(recorded.nativeSessionId)
      expect(created.sessionRef).toEqual({ provider: 'codex', sessionId: recorded.nativeSessionId })
      expect(view.nativeSessionId).toBe(recorded.nativeSessionId)
    }
    const sendId = `send-${randomUUID()}`
    const sendFrameCursor = wire.frames.length
    wire.send({ type: 'freshAgent.send', provider: row.provider, sessionType: row.sessionType,
      sessionId: created.sessionId, requestId: sendId, text: 'fixture prompt' })
    if (row.provider === 'codex') {
      const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
      const turnId = `turn-${shortHash(sendId)}-1`
      const assistantMessageId = `assistant-${shortHash(turnId)}-1`
      const delivered = await waitFor('the Codex fixture assistant and its completion', () => {
        const frames = wire.frames.slice(sendFrameCursor)
        const assistant = frames.findIndex(frame => frame.type === 'freshAgent.event'
          && frame.provider === 'codex' && frame.sessionId === created.sessionId
          && frame.event?.type === 'fixture.provider_native.assistant_message'
          && frame.event.turnId === turnId && frame.event.assistantMessageId === assistantMessageId)
        if (assistant < 0) return undefined
        const complete = frames.findIndex((frame, index) => index > assistant
          && frame.type === 'freshAgent.event' && frame.provider === 'codex'
          && frame.sessionId === created.sessionId && frame.event?.type === 'freshAgent.turn.complete')
        return complete < 0 ? undefined : { frames, complete }
      })
      const completion = delivered.frames[delivered.complete]
      expect(completion.sessionType).toBe('freshcodex')
      expect(completion.event.sessionId).toBe(created.sessionId)
      expect(Number.isFinite(completion.event.at)).toBe(true)
      expect(completion.event.outcome).toBe('completed')
      expect(delivered.frames.slice(0, delivered.complete + 1).filter(frame =>
        frame.type === 'freshAgent.event' && frame.provider === 'codex'
          && frame.sessionId === created.sessionId && frame.event?.type === 'freshAgent.turn.complete')).toHaveLength(1)
      expect(wire.frames.slice(createFrameCursor, sendFrameCursor + delivered.complete + 1).filter(frame =>
        frame.type === 'freshAgent.session.materialized' && frame.provider === 'codex'
          && frame.previousSessionId === created.sessionId)).toHaveLength(0)
    } else {
      const materialized = await wire.wait(frame => frame.type === 'freshAgent.session.materialized'
        && frame.provider === row.provider && frame.previousSessionId === created.sessionId)
      expect(materialized.sessionId).toBe(recorded.nativeSessionId)
      await wire.wait(frame => frame.type === 'freshAgent.turn.complete'
        && frame.provider === row.provider && frame.sessionId === materialized.sessionId)
    }

    const resumeId = `resume-${randomUUID()}`
    wire.send({ type: 'freshAgent.create', requestId: resumeId,
      provider: row.provider, sessionType: row.sessionType, cwd,
      sessionRef: { provider: row.provider, sessionId: recorded.nativeSessionId } })
    const resumed = await wire.wait(frame => frame.requestId === resumeId
      && (frame.type === 'freshAgent.created' || frame.type === 'freshAgent.create.failed'))
    expect(resumed.type, JSON.stringify(resumed)).toBe('freshAgent.created')
    expect(resumed.sessionRef?.sessionId).toBe(recorded.nativeSessionId)
    if (row.provider === 'codex') {
      expect(resumed.sessionId).toBe(recorded.nativeSessionId)
      expect(resumed.sessionRef).toEqual({ provider: 'codex', sessionId: recorded.nativeSessionId })
      const resumedView = await waitFor('the original Codex soul after exact native resume', async () =>
        (await rig.runningViewForFreshSession(resumed.sessionId)) ?? undefined)
      expect(resumedView.soulId).toBe(view.soulId)
      expect(resumedView.nativeSessionId).toBe(recorded.nativeSessionId)
      const response = await fetch(`${rig.info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${encodeURIComponent(resumed.sessionId)}`, {
        headers: { 'x-auth-token': rig.info.token },
      })
      expect(response.ok).toBe(true)
      const snapshot = await response.json()
      expect(snapshot.threadId).toBe(recorded.nativeSessionId)
      expect(JSON.stringify(snapshot.turns)).toContain('deterministic fixture completion')
    }
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
  let retainedModelTraffic: ManagedCodexTrafficRecord[] = []
  let finalObservation: ((signal: AbortSignal) => Promise<unknown>) | undefined
  const fixtureWork = createManagedCodexFixtureWork()
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
    naming = http.createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        namingRequests.push(Buffer.concat(chunks).toString('utf8'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Managed native suggested name' }] } }] }))
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))))
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

  // The owner can also need time to settle native captures and drain its broker.
  afterAll(() => cleanupManagedCodexParity({
    rig, owners, wire, model, fixtureWork, finalObservation, naming, restoreGrants,
    grantsDirectory: grants?.directory, home,
  }), 600_000)

  it('uses the installed wrapper for catalog, settings, saved output and exact native controls', ({ signal }) => runManagedCodexParityBody(fixtureWork, signal, async () => {
    const managedWaitFor: typeof waitFor = (label, probe, timeoutMs) => waitFor(label, probe, timeoutMs, fixtureWork.signal)
    const step = <T,>(operation: () => Promise<T>) => awaitManagedCodexWork(fixtureWork, operation)
    const bodyFetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
      fixtureWork.throwIfAborted()
      return fetch(input, { ...init, signal: fixtureWork.signal })
    }
    const sendBodyFrame = (frame: unknown) => {
      fixtureWork.throwIfAborted()
      wire.send(frame)
    }
    const writeBodyIncident = (name: string, value: unknown) => {
      fixtureWork.throwIfAborted()
      rig.runtime.writeIncident(name, value)
    }
    const requestId = `native-managed-${randomUUID()}`
    owners.push(authorizeFreshAgentParityRequest(rig.runtime.broker, source, 'codex', requestId))
    sendBodyFrame({ type: 'freshAgent.create', requestId, provider: 'codex', sessionType: 'freshcodex',
      cwd: workspace, model: 'contract-model', effort: 'xhigh', sandbox: 'workspace-write', permissionMode: 'untrusted',
      namingHandle: `name-${requestId}`, tabId: `tab-${requestId}` })
    const created = await step(() => wire.wait(frame => frame.requestId === requestId
      && ['freshAgent.created', 'freshAgent.create.failed'].includes(frame.type), fixtureWork.signal))
    if (created.type !== 'freshAgent.created') {
      const inventory = await step(() => rig.inventory())
      const providerFiles = await step(() => readManagedCodexCreateFailureFiles(fixtureWork, inventory,
        containerId => rig.ownedProviderExec(containerId, ['node', '-e', `const fs=require('node:fs');process.stdout.write(JSON.stringify({mcpModulePresent:fs.existsSync(${JSON.stringify(path.join(workspace, 'managed-mcp.mjs'))}),config:fs.readFileSync('/home/freshell/provider/.codex/config.toml','utf8')}))`])))
      fixtureWork.throwIfAborted()
      const nativeLogs = [...rig.runtime.broker.receiptIds()].map(containerId => {
        try { return { containerId, logs: rig.runtime.containerLogs(containerId) } }
        catch { return { containerId, unavailable: true } }
      })
      writeBodyIncident('freshcodex-managed-native-create-failure', { created, inventory, nativeLogs, providerFiles,
        supervisor: rig.runtime.containerLogs(rig.supervisor.containerId), web: rig.web.capturedOutput() })
    }
    expect(created.type, JSON.stringify(created)).toBe('freshAgent.created')
    const view = await step(() => managedWaitFor('native managed provider', async () => {
      const row = await step(() => rig.runningViewForFreshSession(created.sessionId))
      return row?.containerId && row.nativeSessionId ? row : undefined
    }))
    let providerContainerId = view.containerId!
    expect(await step(() => rig.ownedProviderExec(providerContainerId, ['/opt/freshell-codex/launch', '--version']))).toContain('0.164.0')
    const inspectNativeContext = async () => JSON.parse(await step(() => rig.ownedProviderExec(providerContainerId, ['node', '-e', `
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
      if(found.length!==1)throw Error('Expected one actual installed native Codex app-server: '+JSON.stringify({expectedNative:layout.nativeExecutable,matches:found.length,candidates}));process.stdout.write(JSON.stringify(found[0]));`])))
    const nativeContext = await step(() => inspectNativeContext())
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
    const initialModel = await step(() => fixtureWork.run(signal => startInManagedContext(rig, { containerId: providerContainerId, handlerSource, signal })))
    fixtureWork.throwIfAborted()
    model = initialModel
    const readModelTraffic = () => readManagedCodexFixtureTraffic<ManagedCodexTrafficRecord[]>(fixtureWork, model!)
    expect(model.context).toMatchObject({ uid: 65534, gid: 0 })
    const headers = { 'x-auth-token': rig.info.token }
    const observationReadTraffic: { route: string; requestedAt: number; completedAt: number; status: number; retryAfter: string | null }[] = []
    const observeRead = async (route: string, init: RequestInit) => {
      const signal = init.signal ?? fixtureWork.signal
      signal.throwIfAborted()
      const requestedAt = Date.now()
      const response = await fetch(`${rig.info.baseUrl}${route}`, { ...init, signal })
      signal.throwIfAborted()
      observationReadTraffic.push({ route, requestedAt, completedAt: Date.now(), status: response.status, retryAfter: response.headers.get('retry-after') })
      return response
    }
    const snapshot = async (signal = fixtureWork.signal) => {
      const response = await observeRead(`/api/fresh-agent/threads/freshcodex/codex/${created.sessionId}`, { headers, signal })
      signal.throwIfAborted()
      const detail = await response.clone().text()
      signal.throwIfAborted()
      expect(response.ok, detail).toBe(true)
      const value = await response.json()
      signal.throwIfAborted()
      return value
    }
    const ownedHostEvidence = (signal = fixtureWork.signal) => {
      signal.throwIfAborted()
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
    finalObservation = async signal => {
      let final: unknown
      try { final = await snapshot(signal) }
      catch (error) {
        if (signal.aborted) throw error
        final = { error: String(error) }
      }
      signal.throwIfAborted()
      // Unlike ordinary inventory reads, teardown cannot spend the owner's
      // whole transport timeout waiting before it can finish joining work.
      const inventory = await rig.runtime.adminOk(rig.supervisor, { method: 'inventory' }, { timeoutMs: 10_000 })
      if (!inventory || inventory.kind !== 'inventory') throw new Error('managed Codex final inventory is unavailable')
      const currentViews = inventory.data
      signal.throwIfAborted()
      const hostDiagnostics: { containerId: string; state: unknown; logs: string }[] = []
      for (const containerId of rig.runtime.broker.receiptIds()) {
        let state: unknown
        try { const inspected = await rig.ownedContainerInspection(containerId); state = inspected.State }
        catch (error) {
          if (signal.aborted) throw error
          state = { error: String(error) }
        }
        signal.throwIfAborted()
        let logs: string
        try { logs = await rig.ownedContainerLogs(containerId) }
        catch (error) {
          if (signal.aborted) throw error
          logs = `container logs unavailable: ${String(error)}`
        }
        signal.throwIfAborted()
        hostDiagnostics.push({ containerId, state, logs })
      }
      signal.throwIfAborted()
      const { nativeFiles, traffic } = await collectManagedCodexProviderDiagnostics(
        signal,
        async () => JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `
        const fs=require('node:fs'),p='/home/freshell/provider/.codex/managed-mcp-traffic.jsonl';
        process.stdout.write(JSON.stringify({mcp:fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(JSON.parse):[],effects:fs.readdirSync(${JSON.stringify(path.join(workspace, 'allowed'))}).map(name=>{const p=${JSON.stringify(path.join(workspace, 'allowed'))}+'/'+name;return{name,uid:fs.statSync(p).uid,content:fs.readFileSync(p,'utf8')}})}));`])),
        async () => model ? model.traffic() : retainedModelTraffic,
        retainedModelTraffic,
      )
      signal.throwIfAborted()
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
        nativeFiles, hostDiagnostics, observationReadTraffic, publicHttpRequests, publicApiCounts, ownedHostEvidence: ownedHostEvidence(signal) }
    }
    const catalogResponse = await step(() => bodyFetch(`${rig.info.baseUrl}/api/fresh-agent/model-capabilities/freshcodex?${new URLSearchParams({ sessionId: created.sessionId, sessionRef: JSON.stringify(created.sessionRef), cwd: workspace })}`, { headers }))
    expect(catalogResponse.ok, await step(() => catalogResponse.clone().text())).toBe(true)
    expect((await step(() => catalogResponse.json())).models).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'contract-model', supportedEffortLevels: ['low', 'xhigh'] })]))
    const send = (text: string, settings?: unknown) => sendManagedCodexMessage({ fixtureWork, wire, sessionId: created.sessionId, text, settings })
    await step(() => send('MANAGED_NATIVE_FIRST'))
    const saved = await step(() => managedWaitFor('managed native saved first answer', async () => {
      const value = await step(() => snapshot())
      return value.status === 'idle' && JSON.stringify(value.turns).includes('Managed native final answer.') ? value : undefined
    }))
    expect(saved.settings).toMatchObject({ model: 'contract-model', effort: 'xhigh', sandbox: 'workspace-write', permissionMode: 'untrusted', cwd: workspace })
    const firstModelTraffic = await step(() => readModelTraffic())
    fixtureWork.throwIfAborted()
    expect((firstModelTraffic[0].body as { reasoning: { effort: unknown } }).reasoning.effort).toBe('xhigh')
    await step(() => runManagedCodexAwaitedPlanControl({ fixtureWork, send, snapshot, waitFor: managedWaitFor, wire, sessionId: created.sessionId }))
    const asyncSnapshot = await step(() => managedWaitFor('managed native async continuation without answer', async () => {
      const value = await step(() => snapshot())
      return value.status === 'idle' && JSON.stringify(value.turns).includes('Managed work continued before the answer.') ? value : undefined
    }))
    expect(asyncSnapshot.pendingQuestions).toHaveLength(0)
    expect(JSON.stringify(asyncSnapshot.turns)).toContain('Which managed environment?')
    await step(() => send('Question: Which managed environment? Answer: Staging.', { effort: null }))
    await step(() => waitForManagedCodexContextualAnswer({ readModelTraffic, waitFor: managedWaitFor }))
    await step(() => managedWaitFor('managed contextual answer completion', async () => (await step(() => snapshot())).status === 'idle' ? true : undefined))
    const resumedResponse = await step(() => bodyFetch(`${rig.info.baseUrl}/api/tabs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'codex', cwd: workspace, sessionRef: { provider: 'codex', sessionId: view.nativeSessionId } }) }))
    expect(resumedResponse.ok, await step(() => resumedResponse.clone().text())).toBe(true)
    const resumed = await step(() => resumedResponse.json())
    const paneId = resumed.data?.paneId ?? resumed.paneId
    expect(paneId).toBeTruthy()
    const captureResponse = await step(() => bodyFetch(`${rig.info.baseUrl}/api/panes/${paneId}/capture`, { headers }))
    expect(captureResponse.ok, await step(() => captureResponse.clone().text())).toBe(true)
    expect(await step(() => captureResponse.text())).toContain('Managed native final answer.')
    fixtureWork.throwIfAborted()
    const standalone = ensureMcpServerBuilt(root)
    const standaloneEnvironment = { ...process.env, FRESHELL_URL: rig.info.baseUrl, FRESHELL_TOKEN: rig.info.token }
    const cliEntry = path.join(root, 'dist/tools/freshell-cli/index.js')
    const cliCapture = await step(() => runFile(process.execPath, [cliEntry, 'capture-pane', '--target', paneId], {
      cwd: root, env: standaloneEnvironment, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, signal: fixtureWork.signal,
    }))
    expect(cliCapture.stdout).toContain('MANAGED_NATIVE_FIRST')
    expect(cliCapture.stdout).toContain('Managed native final answer.')
    fixtureWork.throwIfAborted()
    const standaloneMcp = new McpStdioClient({ command: process.execPath, args: [standalone.path], env: standaloneEnvironment, requestTimeoutMs: 60_000 })
    try {
      await step(() => initializeManagedCodexStandaloneMcp(fixtureWork, standaloneMcp))
      const mcpCapture = await step(() => standaloneMcp.callFreshellAction('capture-pane', { target: paneId }))
      expect(mcpCapture).toContain('MANAGED_NATIVE_FIRST')
      expect(mcpCapture).toContain('Managed native final answer.')
      const mcpWait = await step(() => standaloneMcp.callFreshellAction('wait-for', { target: paneId, pattern: 'Managed native final answer.', timeout: 0 }))
      expect(mcpWait).toMatchObject({ status: 'ok', data: { matched: true } })
      writeBodyIncident('freshcodex-managed-native-standalone-integration', { paneId, userRef: created.sessionId,
        nativeSessionId: view.nativeSessionId, cli: { entry: cliEntry, capture: cliCapture.stdout },
        mcp: { entry: standalone.path, capture: mcpCapture, wait: mcpWait } })
    } finally {
      await standaloneMcp.close()
    }
    expect((await step(() => inspectNativeContext())).pid).toBe(nativeContext.pid)
    const durableNameRef = { kind: 'session', provider: 'codex', sessionId: view.nativeSessionId }
    const readNameFor = async (ref: unknown) => {
      const response = await step(() => observeRead('/api/session-names/read', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ refs: [ref] }) }))
      expect(response.ok, `name read ${response.status}: ${await step(() => response.clone().text())}`).toBe(true)
      return (await step(() => response.json())).names[0]?.record
    }
    const readName = () => readNameFor(durableNameRef)
    const nativeMetadata = JSON.parse(await step(() => rig.ownedProviderExec(providerContainerId, ['node', '-e', `
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
      process.stdout.write(JSON.stringify({env,roots,directories,headers,errors,hostStatus}));`])))
    fixtureWork.throwIfAborted()
    const hostMetadataAccess = JSON.parse(rig.ownedContainerExec(providerContainerId, ['node', '-e', `
      const fs=require('node:fs');const root='/home/freshell/provider';const s=fs.statSync(root);
      let readError;try{fs.readdirSync(root+'/.codex/sessions')}catch(error){readError=error.code}
      process.stdout.write(JSON.stringify({uid:process.getuid(),root:{uid:s.uid,gid:s.gid,mode:(s.mode&511).toString(8)},readError}));`]))
    expect(hostMetadataAccess).toMatchObject({ uid: 0, root: { uid: 65534, mode: '700' }, readError: 'EACCES' })
    expect(nativeMetadata.headers).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'session_meta', id: view.nativeSessionId })]))
    const beforeNamingTraffic = await step(() => readModelTraffic())
    fixtureWork.throwIfAborted()
    writeBodyIncident('freshcodex-managed-native-before-naming', { created, view, nativeContext, nativeMetadata, fixtureContext: model.context, saved, asyncSnapshot,
      hostMetadataAccess, traffic: beforeNamingTraffic, final: await step(() => snapshot()) })
    const durableName = await step(() => managedWaitFor('managed native durable shared name', async () => {
      const record = await step(() => readName())
      return record?.ref?.sessionId === view.nativeSessionId ? record : undefined
    }, 15_000))
    expect(durableName.ref).toEqual(durableNameRef)
    await step(() => managedWaitFor('managed first-message naming request', () => namingRequests.some(body => body.includes('MANAGED_NATIVE_FIRST')) ? true : undefined))
    const renamed = await step(() => bodyFetch(`${rig.info.baseUrl}/api/session-names`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ target: durableNameRef, name: 'Managed native saved name', nameIntent: 'user' }) }))
    expect(renamed.ok, await step(() => renamed.clone().text())).toBe(true)
    const canonicalName = await step(() => readName())
    expect(canonicalName).toMatchObject({ ref: durableNameRef, name: 'Managed native saved name', source: 'manual' })
    const readNativeName = async (nativeId = view.nativeSessionId, context = nativeContext) => JSON.parse(await step(() => rig.ownedProviderExec(providerContainerId, ['node', '-e', `
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
        if(frame.id===2)finish(null,{id:frame.result.thread.id,title:frame.result.thread.name??null});});`])))
    const nativeNameBeforeWait = await step(() => readNativeName())
    writeBodyIncident('freshcodex-managed-native-name-writeback', { canonicalName, nativeNameBeforeWait, view, nativeContext })
    await step(() => managedWaitFor('managed native name writeback', async () => {
      const observation = await step(() => readNativeName())
      return observation.id === view.nativeSessionId && observation.title === canonicalName.name ? observation : undefined
    }, 15_000))
    const journeyTraffic = await step(() => readModelTraffic())
    fixtureWork.throwIfAborted()
    writeBodyIncident('freshcodex-managed-native-journey', { created, view, nativeContext, context: model.context,
      traffic: journeyTraffic, saved, asyncSnapshot, canonicalName, nativeName: await step(() => readNativeName()), final: await step(() => snapshot()) })

    const approval = async (decision: 'accept' | 'cancel', threadId = view.nativeSessionId) => {
      const pending = await step(() => managedWaitFor('actual managed native approval', async () => {
        const value = await step(() => snapshot())
        return value.pendingApprovals?.find((item: any) => item.providerRequest?.threadId === threadId)
      }))
      expect(pending.providerRequest.threadId).toBe(threadId)
      expect(pending.native.availableDecisions).toContain(decision)
      sendBodyFrame({ type: 'freshAgent.approval.respond', provider: 'codex', sessionType: 'freshcodex', sessionId: created.sessionId,
        requestId: pending.requestId, decision: { nativeDecision: decision } })
      return pending
    }
    const effects: any[] = []
    for (const choice of ['ACCEPT', 'DECLINE', 'RESTRICTED', 'READONLY'] as const) {
      const file = `effect_${choice.toLowerCase() === 'readonly' ? 'readonly' : choice.toLowerCase()}`
      const physical = async () => JSON.parse(await step(() => rig.ownedProviderExec(providerContainerId, ['node', '-e', `
        const fs=require('node:fs'),p=${JSON.stringify(path.join(workspace, 'allowed'))}+'/'+${JSON.stringify(file)};
        process.stdout.write(JSON.stringify(fs.existsSync(p)?{exists:true,uid:fs.statSync(p).uid,content:fs.readFileSync(p,'utf8')}:{exists:false}));`])))
      expect(await step(() => physical())).toEqual({ exists: false })
      const frameCursor = wire.frames.length
      const accepted = await step(() => send(`MANAGED_EFFECT_${choice}`, { sandbox: choice === 'READONLY' ? 'read-only' : 'workspace-write', permissionMode: choice === 'READONLY' || choice === 'RESTRICTED' ? 'never' : 'untrusted' }))
      const decision = choice === 'ACCEPT' ? 'accept' : 'cancel'
      const control = choice === 'READONLY' || choice === 'RESTRICTED' ? undefined : await step(() => approval(decision))
      const completed = await step(() => managedWaitFor(`managed ${choice} command result`, async () => {
        const value = await step(() => snapshot())
        return value.status === 'idle' && JSON.stringify(value.turns).includes('MANAGED_EFFECT_'+choice)
          && !value.pendingApprovals.some((pending: any) => pending.requestId === control?.requestId)
          && wire.frames.slice(frameCursor).some(frame => {
            const event = frame.type === 'freshAgent.event' ? frame.event : frame
            const nativeTurn = value.turns.find((turn: any) => turn.role === 'user' && turn.items?.some((item: any) => item.text === 'MANAGED_EFFECT_'+choice))?.nativeTurnId
            return event.type === 'freshAgent.transcript.patch' && event.sessionId === created.sessionId
              && event.ops?.some((op: any) => op.op === 'settleTurn' && op.nativeTurnId === nativeTurn && ['completed', 'interrupted', 'failed'].includes(op.status))
          })
          && (choice === 'DECLINE' || JSON.stringify(value.turns).includes('Managed '+file+' result:')) ? value : undefined
      }))
      const effect = await step(() => physical())
      if (choice === 'ACCEPT' || choice === 'RESTRICTED') expect(effect).toMatchObject({ exists: true, uid: 65534, content: 'managed-'+file })
      else expect(effect).toEqual({ exists: false })
      if (choice === 'READONLY') {
        // Native0.164 can return a failed unifiedExec result to the model
        // without persisting a commandExecution history item. Read the real
        // native tool result, never the fixture's repeated assistant phrase.
        const traffic = await step(() => readModelTraffic())
        fixtureWork.throwIfAborted()
        const command = traffic.flatMap((row: any) => row.body?.input ?? [])
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
      fixtureWork.throwIfAborted()
      effects.push({ choice, nativeDecision: control ? decision : null, accepted, control, effect, terminal: completed, settings: completed.settings })
      writeBodyIncident('freshcodex-managed-native-command-effects', effects)
    }
    const mcpResults: any[] = []
    for (const route of ['form', 'openai/form', 'openaiForm', 'url']) {
      await step(() => send(`MANAGED_MCP_${route}`, { sandbox: 'workspace-write', permissionMode: 'untrusted' }))
      const ids = new Set<string>()
      for (const action of ['accept', 'decline', 'cancel']) {
        const pending = await step(() => managedWaitFor(`managed ${route} ${action} elicitation`, async () => {
          const value = await step(() => snapshot())
          return value.pendingElicitations?.find((item: any) => !ids.has(item.requestId))
        }))
        ids.add(pending.requestId)
        // Fetching the URL is a read; the explicit native decision is separate.
        if (route === 'url') {
          expect(await step(() => rig.ownedProviderExec(providerContainerId, ['node', '-e', `fetch('http://127.0.0.1:51991/elicitation/example').then(r=>{if(!r.ok)throw Error('URL fixture failed');process.stdout.write('opened')})`]))).toBe('opened')
          expect((await step(() => snapshot())).pendingElicitations.some((item: any) => item.requestId === pending.requestId)).toBe(true)
        }
        sendBodyFrame({ type: 'freshAgent.elicitation.respond', provider: 'codex', sessionType: 'freshcodex', sessionId: created.sessionId,
          requestId: pending.requestId, action, content: action === 'accept' && route !== 'url' ? { name: 'fixture', count: 2.5, enabled: true, color: 'blue' } : null })
      }
      await step(() => managedWaitFor(`managed ${route} MCP completion`, async () => {
        const value = await step(() => snapshot())
        return value.status === 'idle' && JSON.stringify(value.turns).includes('Managed MCP '+route+' completed.') ? true : undefined
      }))
      await step(() => recordManagedCodexMcpResults({ fixtureWork, route, mcpResults,
        readTraffic: () => rig.ownedProviderExec(providerContainerId, ['node', '-e', `const fs=require('node:fs');process.stdout.write(JSON.stringify(fs.readFileSync('/home/freshell/provider/.codex/managed-mcp-traffic.jsonl','utf8').trim().split(String.fromCharCode(10)).map(JSON.parse)))`]),
        writeIncident: (name, value) => writeBodyIncident(name, value),
      }))
    }
    await step(() => send('MANAGED_DURABLE_CHILD'))
    const registered = await step(() => managedWaitFor('public managed registered child', async () => {
      const value = await step(() => snapshot())
      return value.childThreads?.find((item: any) => item.threadId) ? value : undefined
    }))
    const child = registered.childThreads[0]
    const childId = child.threadId
    const childControl = await step(() => approval('accept', childId))
    const childResponse = await step(() => managedWaitFor('public managed active child read', async () => {
      const response = await step(() => bodyFetch(`${rig.info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${created.sessionId}/children/${childId}`, { headers }))
      expect(response.ok, await step(() => response.clone().text())).toBe(true)
      const value = await step(() => response.json())
      return value.status === 'live' && JSON.stringify(value.snapshot?.turns).includes('MANAGED_CHILD_NATIVE') ? value : undefined
    }))
    expect(childResponse).toMatchObject({ parentThreadId: view.nativeSessionId, childThreadId: childId, status: 'live',
      snapshot: { threadId: childId, capabilities: { send: false, interrupt: false, fork: false, undo: false } } })
    expect((await step(() => inspectNativeContext())).pid).toBe(nativeContext.pid)
    await step(() => rig.ownedProviderExec(providerContainerId, ['node', '-e', "require('node:fs').writeFileSync('/home/freshell/provider/.freshell-fixture/release-child','release')"]))
    const childSaved = await step(() => managedWaitFor('public managed saved child after completion', async () => {
      const response = await step(() => bodyFetch(`${rig.info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${created.sessionId}/children/${childId}`, { headers }))
      expect(response.ok).toBe(true)
      const value = await step(() => response.json())
      return value.status === 'saved' && JSON.stringify(value).includes('Managed child final answer.') ? value : undefined
    }))
    expect(childSaved).toMatchObject({ parentThreadId: view.nativeSessionId, childThreadId: childId, status: 'saved' })
    await step(() => managedWaitFor('managed child control drained', async () => !(await step(() => snapshot())).pendingApprovals.length ? true : undefined))
    writeBodyIncident('freshcodex-managed-native-durable-child', { registered, childControl, childResponse, childSaved, parent: await step(() => snapshot()) })
    const beforeRestart = { view: await step(() => rig.runningViewForFreshSession(created.sessionId)), snapshot: await step(() => snapshot()), name: await step(() => readName()) }
    expect(beforeRestart.name).toEqual(canonicalName)
    const previousTraffic = await step(() => readModelTraffic())
    fixtureWork.throwIfAborted()
    retainedModelTraffic = previousTraffic
    writeBodyIncident('freshcodex-managed-native-before-host-restart', { beforeRestart, canonicalName, effects, mcpResults, registered, childControl, childResponse, childSaved, traffic: previousTraffic })
    const restarted = await step(() => fixtureWork.run(async signal => {
      await step(() => model!.stop(signal))
      signal.throwIfAborted()
      model = undefined
      rig.runtime.restartOwnedRuntimeExact(providerContainerId)
      signal.throwIfAborted()
      const currentHost = await step(() => managedWaitFor('ordinary same-conversation host recovery readiness', async () => {
        signal.throwIfAborted()
        const current = await step(() => rig.runningViewForFreshSession(created.sessionId))
        signal.throwIfAborted()
        const diagnostics: { containerId: string; logs: string }[] = []
        for (const containerId of rig.runtime.broker.receiptIds()) {
          let logs: string
          try { logs = await step(() => rig.ownedContainerLogs(containerId)) }
          catch (error) {
            if (signal.aborted) throw error
            logs = `container logs unavailable: ${String(error)}`
          }
          signal.throwIfAborted()
          diagnostics.push({ containerId, logs })
        }
        writeBodyIncident('freshcodex-managed-native-host-restart-status', { current, diagnostics, ownedHostEvidence: ownedHostEvidence() })
        if (!current?.containerId || !current.hostBootId
          || current.hostBootId === beforeRestart.view!.hostBootId) return undefined
        let running: boolean
        try { running = await step(() => rig.ownedContainerRunning(current.containerId!)) }
        catch (error) {
          if (signal.aborted) throw error
          return undefined
        }
        signal.throwIfAborted()
        if (!running) return undefined
        providerContainerId = current.containerId
        try {
          const context = await step(() => inspectNativeContext())
          signal.throwIfAborted()
          expect(context).toMatchObject({ uid: 65534, gid: 0, noNewPrivs: '1', capEff: '0000000000000000' })
          const value = await step(() => snapshot(signal))
          signal.throwIfAborted()
          return value.threadId === view.nativeSessionId && value.status !== 'unavailable' ? current : undefined
        } catch (error) {
          if (signal.aborted) throw error
          return undefined
        }
      }))
      signal.throwIfAborted()
      const nextModel = await step(() => startInManagedContext(rig, { containerId: providerContainerId, handlerSource, signal }))
      signal.throwIfAborted()
      model = nextModel
      return currentHost
    }))
    fixtureWork.throwIfAborted()
    expect(restarted.nativeSessionId).toBe(view.nativeSessionId)
    if (!model) throw new Error('managed Codex fixture did not restart')
    await step(() => send('MANAGED_AFTER_HOST_RESTART'))
    const afterRestart = await step(() => managedWaitFor('same-conversation restarted send saved', async () => {
      const value = await step(() => snapshot())
      return value.status === 'idle' && JSON.stringify(value.turns).includes('MANAGED_AFTER_HOST_RESTART') ? value : undefined
    }))
    expect(afterRestart.settings).toEqual(beforeRestart.snapshot.settings)
    expect(afterRestart.threadId).toBe(view.nativeSessionId)
    expect(JSON.stringify(afterRestart.turns)).toContain('MANAGED_NATIVE_FIRST')
    expect(await step(() => readName())).toEqual(canonicalName)
    const postRestartTraffic = await step(() => readModelTraffic())
    fixtureWork.throwIfAborted()
    expect(postRestartTraffic.filter((row: any) => row.path === '/v1/responses')).toHaveLength(1)
    const restartIncidentTraffic = await step(() => readModelTraffic())
    fixtureWork.throwIfAborted()
    writeBodyIncident('freshcodex-managed-native-tools-restart', { created, nativeContext, canonicalName, effects, mcpResults,
      registered, childControl, childResponse, childSaved, beforeRestart, restarted, afterRestart, traffic: previousTraffic, restartedTraffic: restartIncidentTraffic, finalName: await step(() => readName()) })

    fixtureWork.throwIfAborted()
    const recoveryCwd = path.join(workspace, 'recovery-cwd')
    fs.mkdirSync(recoveryCwd)
    fs.chmodSync(recoveryCwd, 0o755)
    await step(() => send('MANAGED_RECOVERY_READY', { cwd: recoveryCwd, model: 'contract-model', effort: 'xhigh',
      collaborationMode: 'plan', permissionMode: 'never', sandbox: 'read-only' }))
    const recoverySettings = await step(() => managedWaitFor('saved exact settings before native crash', async () => {
      const value = await step(() => snapshot())
      return value.status === 'idle' && value.settings?.cwd === recoveryCwd ? value.settings : undefined
    }))
    expect(recoverySettings).toMatchObject({ cwd: recoveryCwd, model: 'contract-model', effort: 'xhigh',
      collaborationMode: 'plan', permissionMode: 'never', sandbox: 'read-only' })
    const beforeCrash = { view: await step(() => rig.runningViewForFreshSession(created.sessionId)), snapshot: await step(() => snapshot()),
      name: await step(() => readName()), nativeContext: await step(() => inspectNativeContext()), trafficCursor: (await step(() => readModelTraffic())).length }
    fixtureWork.throwIfAborted()
    expect(beforeCrash.name).toEqual(canonicalName)
    writeBodyIncident('freshcodex-managed-native-before-crash', beforeCrash)
    const recoveryFrameCursor = wire.frames.length
    // Start with the real pre-crash snapshot of A, as an already hydrated pane.
    // Recovery itself must come only from frames actually received on this wire.
    const clientStore = configureStore({ reducer: {
      freshAgent: freshAgentReducer, freshAgentLive: freshAgentLiveReducer,
      panes: panesReducer, turnCompletion: turnCompletionReducer,
    } })
    const clientLocator = { provider: 'codex', sessionType: 'freshcodex', sessionId: created.sessionId } as const
    const clientKey = `freshcodex:codex:${created.sessionId}`
    const clientTabId = `recovery-tab-${requestId}`
    const clientPaneId = `recovery-pane-${requestId}`
    clientStore.dispatch(initLayout({ tabId: clientTabId, paneId: clientPaneId, content: {
      kind: 'fresh-agent', ...clientLocator, createRequestId: requestId, status: 'idle',
      sessionRef: { provider: 'codex', sessionId: view.nativeSessionId! },
    } }))
    clientStore.dispatch(sessionCreated({ ...clientLocator, requestId }))
    clientStore.dispatch(transcriptProjectionSnapshotReceived({ ...clientLocator,
      snapshot: FreshAgentSnapshotSchema.parse(beforeCrash.snapshot) }))
    expect(clientStore.getState().freshAgentLive.bySession[clientKey]?.projection).toBeDefined()
    // Match the existing four-reducer handler tests. These handlers use only
    // these slices for the captured frames; no application singleton is started.
    const clientDispatch = clientStore.dispatch as AppDispatch
    let clientCursor = recoveryFrameCursor
    const receiveCapturedRecoveryFrames = () => {
      fixtureWork.throwIfAborted()
      const through = wire.frames.length
      for (const frame of wire.frames.slice(clientCursor, through)) {
        handleFreshAgentMessage(clientDispatch, frame)
      }
      streamBatcherFor(clientDispatch).flush()
      clientCursor = through
    }
    const originalClientPane = () => {
      const layout = clientStore.getState().panes.layouts[clientTabId]
      if (layout?.type !== 'leaf') throw new Error('expected the original recovery pane')
      return layout.content
    }
    const capturedClientTurns = (key: string) => {
      const live = clientStore.getState().freshAgentLive.bySession[key]
      return live?.retainedSnapshot ? mergeFreshAgentTranscriptProjection(live.retainedSnapshot, live.projection)
        : live?.projection?.turns ?? []
    }
    // Kill only this receipt-owned, inspected release native PID. Archive its
    // REAL native-generated history after exit, keeping every original byte.
    // The host stays live; no internal exited flag or Started event is forged.
    fixtureWork.throwIfAborted()
    rig.runtime.killOwnedRuntimePidExact(providerContainerId, beforeCrash.nativeContext.pid)
    const nativeExit = await step(() => managedWaitFor('exact native process terminal state before history archive', async () => {
      const state = JSON.parse(await step(() => rig.ownedProviderExec(providerContainerId, ['node', '-e', `
        const fs=require('node:fs'),p='/proc/${beforeCrash.nativeContext.pid}/status';
        process.stdout.write(JSON.stringify(fs.existsSync(p)?{exists:true,state:fs.readFileSync(p,'utf8').split(String.fromCharCode(10)).find(line=>line.startsWith('State:')).slice(6).trim()}:{exists:false}));`])))
      return !state.exists || state.state.startsWith('Z') ? state : undefined
    }))
    const originalRollout = nativeMetadata.headers.find((header: any) => header.id === view.nativeSessionId).path
    const archived = JSON.parse(await step(() => rig.ownedProviderExec(providerContainerId, ['node', '-e', `
      const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
      const root='/home/freshell/provider/.codex';const original=${JSON.stringify(originalRollout)};
      const directory='/home/freshell/provider/.freshell-fixture/native-crash-history';fs.mkdirSync(directory,{mode:448});
      const selected=[original,...fs.readdirSync(root).filter(name=>/^state_[0-9]+[.]sqlite(?:-wal|-shm)?$/.test(name)||name==='session_index.jsonl').map(name=>path.join(root,name))];
      const files=selected.filter(file=>fs.existsSync(file)).map((file,index)=>{const bytes=fs.readFileSync(file);const destination=path.join(directory,String(index)+'-'+path.basename(file));fs.renameSync(file,destination);return{source:file,archive:destination,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,base64:bytes.toString('base64')}});
      if(!files.some(file=>file.source===original))throw Error('Exact real native rollout was not archived');process.stdout.write(JSON.stringify({directory,files}));`])))
    fixtureWork.throwIfAborted()
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
    const recoveryAccepted = await step(() => send('AWAITED_PLAN_RECOVERY'))
    const recovered = await step(() => rig.runningViewForFreshSession(created.sessionId))
    const recoveryTraffic = await step(() => readModelTraffic())
    fixtureWork.throwIfAborted()
    writeBodyIncident('freshcodex-managed-native-crash-first-send', { userRef: created.sessionId, beforeCrash,
      archiveManifest, nativeExit, recoveryAccepted, recovered, newTraffic: recoveryTraffic.slice(beforeCrash.trafficCursor), frames: wire.frames.slice(-30) })
    // Acceptance must durably commit the new native source before returning.
    expect(recovered?.nativeSessionId).toBeTruthy()
    expect(recovered!.nativeSessionId).not.toBe(view.nativeSessionId)
    expect(recovered!.freshAgentSessionId).toBe(created.sessionId)
    const recoveredId = recovered!.nativeSessionId!
    const replacementAnnouncement = await step(() => managedWaitFor('replacement B announced at original presentation', () =>
      wire.frames.slice(recoveryFrameCursor).find(frame => frame.type === 'freshAgent.session.materialized'
        && frame.provider === 'codex' && frame.sessionType === 'freshcodex'
        && frame.previousSessionId === created.sessionId && frame.sessionId === created.sessionId
        && frame.sessionRef?.provider === 'codex' && frame.sessionRef.sessionId === recoveredId)))
    const memoryLossWarning = await step(() => managedWaitFor('replacement B memory warning at original presentation', () =>
      wire.frames.slice(recoveryFrameCursor).find(frame => frame.type === 'freshAgent.event'
        && frame.provider === 'codex' && frame.sessionType === 'freshcodex'
        && frame.sessionId === created.sessionId && frame.event?.sessionId === created.sessionId
        && frame.event.type === 'freshAgent.error' && frame.event.code === 'THREAD_MEMORY_LOST'
        && frame.event.journalIdentity?.nativeSessionId === recoveredId
        && frame.event.journalIdentity?.soulId === recovered!.soulId)))
    expect(typeof memoryLossWarning.event.message === 'string' && memoryLossWarning.event.message.length > 0).toBe(true)
    expect(wire.frames.indexOf(replacementAnnouncement)).toBeLessThan(wire.frames.indexOf(memoryLossWarning))
    // Keep the delivered ordering and routing identities without recording
    // arbitrary provider text, payloads, or credentials in this observation.
    const recoveryPublicFrames = () => {
      const identity = (id: unknown) => id === created.sessionId ? 'managed'
        : id === view.nativeSessionId ? 'original' : id === recoveredId ? 'replacement'
          : id == null ? null : 'other'
      const types = new Set(['freshAgent.session.materialized', 'freshAgent.send.accepted', 'freshAgent.event'])
      const eventTypes = new Set(['freshAgent.error', 'freshAgent.turn.complete', 'freshAgent.session.changed',
        'freshAgent.session.snapshot', 'freshAgent.session.init', 'freshAgent.transcript.patch',
        'freshAgent.host.backpressure'])
      const frames = wire.frames.slice(recoveryFrameCursor).flatMap((frame, offset) => {
        if (frame.provider !== 'codex' || !types.has(frame.type)) return []
        const eventType = eventTypes.has(frame.event?.type) ? frame.event.type : null
        if (frame.type === 'freshAgent.event' && !eventType) return []
        return [{ offset, type: frame.type, eventType, sessionId: identity(frame.sessionId),
          previousSessionId: identity(frame.previousSessionId), sessionRef: identity(frame.sessionRef?.sessionId),
          eventSessionId: identity(frame.event?.sessionId),
          retainedNativeId: identity(frame.event?.retainedState?.snapshot?.threadId),
          memoryLost: frame.event?.code === 'THREAD_MEMORY_LOST',
          recoveryRequest: frame.requestId === recoveryAccepted.requestId }]
      })
      return { cursor: recoveryFrameCursor, count: frames.length, frames: frames.slice(-200) }
    }
    const recoveryControl = await step(() => managedWaitFor('new native source control through original durable user reference', async () => {
      const value = await step(() => snapshot())
      expect(value.threadId).toBe(recoveredId)
      expect(value.settings).toEqual(recoverySettings)
      return value.pendingQuestions?.find((question: any) => question.providerRequest.threadId === recoveredId)
    }))
    receiveCapturedRecoveryFrames()
    expect(originalClientPane()).toMatchObject({ sessionId: created.sessionId,
      sessionRef: { provider: 'codex', sessionId: recoveredId } })
    expect(clientStore.getState().freshAgent.sessions[clientKey]?.lastErrorCode).toBe('THREAD_MEMORY_LOST')
    expect(clientStore.getState().freshAgent.sessions[clientKey]?.lastError === memoryLossWarning.event.message).toBe(true)
    // Reusing the newly accepted native root must keep its public resume ID,
    // while both presentations continue receiving events from this one soul.
    const recoveredResumeRequest = `resume-recovered-${randomUUID()}`
    const recoveredResumeCursor = wire.frames.length
    sendBodyFrame({ type: 'freshAgent.create', requestId: recoveredResumeRequest, provider: 'codex',
      sessionType: 'freshcodex', cwd: workspace, sessionRef: { provider: 'codex', sessionId: recoveredId } })
    const recoveredResume = await step(() => managedWaitFor('accepted replacement native resume', () =>
      wire.frames.slice(recoveredResumeCursor).find(frame => frame.requestId === recoveredResumeRequest
        && (frame.type === 'freshAgent.created' || frame.type === 'freshAgent.create.failed'))))
    expect(recoveredResume.type).toBe('freshAgent.created')
    expect(recoveredResume.sessionId).toBe(recoveredId)
    expect(recoveredResume.sessionRef).toEqual({ provider: 'codex', sessionId: recoveredId })
    const resumedRecoveredView = await step(() => rig.runningViewForFreshSession(recoveredResume.sessionId))
    expect(resumedRecoveredView?.soulId).toBe(recovered!.soulId)
    expect(resumedRecoveredView?.nativeSessionId).toBe(recoveredId)
    // Resume reads from journal cursor zero: the hosted Codex route sends its
    // actual retained projection and the current source's replayed warning.
    const recoveredReplay = await step(() => managedWaitFor('replacement B retained resume and warning', () => {
      const frames = wire.frames.slice(recoveredResumeCursor).filter(frame =>
        frame.provider === 'codex' && frame.sessionType === 'freshcodex' && frame.sessionId === recoveredId)
      const announcement = frames.find(frame => frame.type === 'freshAgent.session.materialized'
        && frame.previousSessionId === recoveredId && frame.sessionRef?.provider === 'codex'
        && frame.sessionRef.sessionId === recoveredId)
      const retained = frames.find(frame => frame.type === 'freshAgent.event'
        && ['freshAgent.host.backpressure', 'freshAgent.host.journal.reset'].includes(frame.event?.type)
        && frame.event.retainedState?.source?.soulId === recovered!.soulId
        && frame.event.retainedState?.source?.nativeSessionId === recoveredId
        && frame.event.retainedState?.snapshot?.threadId === recoveredId)
      const warning = frames.find(frame => frame.type === 'freshAgent.event' && frame.event?.sessionId === recoveredId
        && frame.event.type === 'freshAgent.error' && frame.event.code === 'THREAD_MEMORY_LOST'
        && frame.event.retainedReplay === true
        && frame.event.journalIdentity?.nativeSessionId === recoveredId
        && frame.event.journalIdentity?.soulId === recovered!.soulId)
      return announcement && retained && warning ? { announcement, retained, warning } : undefined
    }))
    expect(wire.frames.indexOf(recoveredReplay.announcement)).toBeLessThan(wire.frames.indexOf(recoveredReplay.retained))
    expect(wire.frames.indexOf(recoveredReplay.announcement)).toBeLessThan(wire.frames.indexOf(recoveredReplay.warning))
    receiveCapturedRecoveryFrames()
    expect(originalClientPane()).toMatchObject({ sessionId: created.sessionId,
      sessionRef: { provider: 'codex', sessionId: recoveredId } })
    const replayedLive = clientStore.getState().freshAgentLive.bySession[`freshcodex:codex:${recoveredId}`]
    expect(replayedLive?.retainedSnapshot?.threadId).toBe(recoveredId)
    expect(replayedLive?.projection?.id).toBe(recoveredReplay.retained.event.retainedState.snapshot.extensions.codex.projection.id)
    expect(clientStore.getState().freshAgent.sessions[`freshcodex:codex:${recoveredId}`]?.lastErrorCode).toBe('THREAD_MEMORY_LOST')
    // The native rekey carries A's attention into B. Read that actual floor
    // while B's first question is unanswered, before its own completion exists.
    expect(recoveredReplay.retained.event.retainedState.snapshot.pendingQuestions?.some((question: any) =>
      question.requestId === recoveryControl.requestId && question.providerRequest?.threadId === recoveredId)).toBe(true)
    const inheritedAttention = recoveredReplay.retained.event.retainedState.attentionMarks?.find((mark: any) =>
      mark.sessionId === recoveredId)
    const recoveryAttentionFloor = inheritedAttention?.lastTurnCompleteAt ?? 0
    expect(typeof recoveryAttentionFloor === 'number' && Number.isFinite(recoveryAttentionFloor)
      && recoveryAttentionFloor >= 0).toBe(true)
    sendBodyFrame({ type: 'freshAgent.question.respond', provider: 'codex', sessionType: 'freshcodex', sessionId: created.sessionId,
      requestId: recoveryControl.requestId, answers: { managed_choice: 'Alpha' } })
    const recoverySettled = await step(() => managedWaitFor('recovered native exact control resolution', async () => {
      const value = await step(() => snapshot())
      return value.status === 'idle' && !value.pendingQuestions.length ? value : undefined
    }))
    const recoveryTurn = recoverySettled.turns.find((turn: any) => turn.role === 'user'
      && turn.items?.some((item: any) => item.text === 'AWAITED_PLAN_RECOVERY'))
    expect(recoveryTurn?.nativeTurnId).toBeTruthy()
    const recoveryProjection = readTranscriptProjection(FreshAgentSnapshotSchema.parse(recoverySettled))
    expect(recoveryProjection).toBeDefined()
    // Native-final groups can outlive the event-owned settled-ID list. The saved
    // representation is equally valid; do not require obsolete live rows.
    const retainedTurnAt = (frame: any, nativeTurnId: string, projectionId: string) => {
      const event = frame.event
      const retained = event?.retainedState
      if (!['freshAgent.host.backpressure', 'freshAgent.host.journal.reset'].includes(event?.type)
        || retained?.source?.soulId !== recovered!.soulId || retained?.source?.nativeSessionId !== recoveredId
        || retained?.snapshot?.threadId !== recoveredId) return undefined
      const parsed = FreshAgentSnapshotSchema.safeParse(retained.snapshot)
      const metadata = parsed.success ? readTranscriptProjection(parsed.data) : undefined
      return metadata?.id === projectionId && retained.source.projectionId === projectionId
        && (metadata.settledTurnIds?.includes(nativeTurnId) || metadata.nativeFinalTurnIds.includes(nativeTurnId))
        ? retained : undefined
    }
    // Public completion edges have no turn ID. Correlate using the exact M
    // settlement position and a witnessed preceding completion on B's clock.
    const capturedCompletionAfter = (frames: typeof wire.frames, settlementIndex: number,
      nativeTurnId: string, projectionId: string, baseline: number) => {
      for (let index = settlementIndex; index < frames.length; index++) {
        const frame = frames[index]
        if (frame.type !== 'freshAgent.event' || frame.provider !== 'codex'
          || frame.sessionType !== 'freshcodex' || frame.sessionId !== created.sessionId) continue
        const event = frame.event
        if (index > settlementIndex && event?.type === 'freshAgent.turn.complete' && event.sessionId === created.sessionId
          && event.outcome === 'completed' && typeof event.at === 'number' && Number.isFinite(event.at)
          && event.at > baseline) return { at: event.at, retained: false }
        const retained = retainedTurnAt(frame, nativeTurnId, projectionId)
        const mark = retained?.attentionMarks?.find((mark: any) => mark.sessionId === created.sessionId
          && typeof mark.lastTurnCompleteAt === 'number' && Number.isFinite(mark.lastTurnCompleteAt)
          && mark.lastTurnCompleteAt > baseline)
        if (mark) return { at: mark.lastTurnCompleteAt, retained: true }
      }
      return undefined
    }
    // An idle REST read and a cursor-zero replay can precede the outstanding
    // recovery notification. Wait for its actual completion/attention first.
    // This is B's first turn; no later send is issued until this boundary.
    const recoveryCompletion = await step(() => managedWaitFor('recovery turn completion boundary at original presentation', () => {
      const settlementIndex = wire.frames.findIndex((frame, index) => index > wire.frames.indexOf(replacementAnnouncement)
        && frame.type === 'freshAgent.event' && frame.provider === 'codex' && frame.sessionType === 'freshcodex'
        && frame.sessionId === created.sessionId
        && ((frame.event?.sessionId === created.sessionId && frame.event?.type === 'freshAgent.transcript.patch'
          && frame.event.projectionId === recoveryProjection!.id && frame.event.ops?.some((op: any) =>
            op.op === 'settleTurn' && op.nativeTurnId === recoveryTurn.nativeTurnId && op.status === 'completed'))
          || retainedTurnAt(frame, recoveryTurn.nativeTurnId, recoveryProjection!.id)))
      return settlementIndex < 0 ? undefined : capturedCompletionAfter(wire.frames, settlementIndex,
        recoveryTurn.nativeTurnId, recoveryProjection!.id, recoveryAttentionFloor)
    }))
    receiveCapturedRecoveryFrames()
    const clientCompletionBaseline = clientStore.getState().turnCompletion.lastAtByTerminalId[`codex:${created.sessionId}`] ?? 0
    expect(clientCompletionBaseline).toBeGreaterThanOrEqual(recoveryCompletion.at)
    const followupFrameCursor = wire.frames.length
    const followupAccepted = await step(() => send('MANAGED_RECOVERY_SECOND'))
    const second = await step(() => managedWaitFor('second send on same durable user reference', async () => {
      const value = await step(() => snapshot())
      return value.status === 'idle' && JSON.stringify(value.turns).includes('Managed recovery second answer.') ? value : undefined
    }))
    const followupTurn = second.turns.find((turn: any) => turn.role === 'user'
      && turn.items?.some((item: any) => item.text === 'MANAGED_RECOVERY_SECOND'))
    expect(followupTurn?.nativeTurnId).toBeTruthy()
    const delivery = await step(() => managedWaitFor('same recovered native turn at both presentations', () => {
      const presentations = [created.sessionId, recoveredResume.sessionId]
      const matching = presentations.map(sessionId => wire.frames.slice(followupFrameCursor).find(frame =>
        frame.type === 'freshAgent.event' && frame.provider === 'codex' && frame.sessionType === 'freshcodex'
        && frame.sessionId === sessionId && frame.event?.sessionId === sessionId
        && frame.event?.type === 'freshAgent.transcript.patch' && frame.event.ops?.some((op: any) =>
          op.op === 'settleTurn' && op.nativeTurnId === followupTurn.nativeTurnId && op.status === 'completed')))
      return matching.every(Boolean) ? matching : undefined
    }))
    const settledOps = delivery.map(frame => frame.event.ops.find((op: any) =>
      op.op === 'settleTurn' && op.nativeTurnId === followupTurn.nativeTurnId))
    expect(delivery[0].event.projectionId).toBe(delivery[1].event.projectionId)
    expect(settledOps[0].revision).toBe(settledOps[1].revision)
    const firstReplacementProjectionFrame = wire.frames.slice(recoveryFrameCursor).find(frame =>
      frame.type === 'freshAgent.event' && frame.provider === 'codex' && frame.sessionType === 'freshcodex'
      && frame.sessionId === created.sessionId && (frame.event?.projectionId === delivery[0].event.projectionId
        || frame.event?.retainedState?.snapshot?.threadId === recoveredId))
    expect(firstReplacementProjectionFrame).toBeDefined()
    expect(wire.frames.indexOf(replacementAnnouncement)).toBeLessThan(wire.frames.indexOf(firstReplacementProjectionFrame))
    // Bind this completion to the exact correlated M settlement, never to the
    // send acknowledgement or merely to the start of the follow-up interval.
    const followupSettlementIndex = wire.frames.indexOf(delivery[0])
    expect(followupSettlementIndex).toBeGreaterThanOrEqual(followupFrameCursor)
    const followupCompletion = await step(() => managedWaitFor('replacement B completion at original presentation', () =>
      capturedCompletionAfter(wire.frames, followupSettlementIndex, followupTurn.nativeTurnId,
        delivery[0].event.projectionId, clientCompletionBaseline)))
    receiveCapturedRecoveryFrames()
    expect(originalClientPane()).toMatchObject({ sessionId: created.sessionId,
      sessionRef: { provider: 'codex', sessionId: recoveredId } })
    const clientSession = clientStore.getState().freshAgent.sessions[clientKey]
    expect(clientSession?.lastErrorCode).toBe('THREAD_MEMORY_LOST')
    expect(clientSession?.lastError === memoryLossWarning.event.message).toBe(true)
    const clientLive = clientStore.getState().freshAgentLive.bySession[clientKey]
    const clientProjection = clientLive?.projection
    expect(clientProjection?.id).toBe(delivery[0].event.projectionId)
    expect(clientProjection?.settledTurns?.[followupTurn.nativeTurnId]).toBe(true)
    const retainedProjection = clientLive?.retainedSnapshot ? readTranscriptProjection(clientLive.retainedSnapshot) : undefined
    const followupRows = new Set([...(clientProjection?.turnRows?.[followupTurn.nativeTurnId] ?? []),
      ...(retainedProjection?.turnRows[followupTurn.nativeTurnId] ?? [])])
    const clientTurns = capturedClientTurns(clientKey)
    const clientItems = clientTurns.filter(row => followupRows.has(row.turnId)).flatMap(row => row.items)
    expect(clientItems.some(item => item.kind === 'text' && item.text === 'MANAGED_RECOVERY_SECOND')).toBe(true)
    expect(clientItems.some(item => item.kind === 'text' && item.text === 'Managed recovery second answer.')).toBe(true)
    expect(clientTurns.some(row => row.items.some(item => item.kind === 'text' && item.text === 'MANAGED_NATIVE_FIRST'))).toBe(false)
    expect(clientStore.getState().turnCompletion.pendingEvents.some(event => event.tabId === clientTabId
      && event.paneId === clientPaneId && event.terminalId === `codex:${created.sessionId}`
      && event.source === 'freshAgent' && event.at === followupCompletion.at
      && (followupCompletion.retained || event.outcome === 'completed'))).toBe(true)
    const capturedClientEvidence = { originalPublicIdPreserved: true, replacementAdopted: true,
      warningVisible: true, replacementReplayHydrated: true, correlatedTurnSettled: true,
      correlatedTurnOutputPresent: true, originalHistoryAbsent: true, completionQueuedForOriginalPane: true,
      completionFromRetainedState: followupCompletion.retained, priorCompletionBoundaryObserved: true }
    const resumedDeliveryEvidence = { resumeAcknowledged: recoveredResume.type === 'freshAgent.created',
      nativeRefMatches: recoveredResume.sessionRef?.sessionId === recoveredId,
      sameSoul: resumedRecoveredView?.soulId === recovered!.soulId,
      followupAccepted: followupAccepted.type === 'freshAgent.send.accepted',
      originalAndResumedReceivedSameTurn: true, sameProjection: true, sameRevision: true }
    expect(second.threadId).toBe(recoveredId)
    expect(second.settings).toEqual(recoverySettings)
    expect(JSON.stringify(second.turns)).not.toContain('MANAGED_NATIVE_FIRST')
    expect(await step(() => readName())).toEqual(canonicalName)
    const recoveredNameRef = { kind: 'session', provider: 'codex', sessionId: recoveredId }
    const recoveredName = await step(() => managedWaitFor('policy-correct new conversation name record', async () => {
      const name = await step(() => readNameFor(recoveredNameRef))
      return name?.ref?.sessionId === recoveredId ? name : undefined
    }))
    expect(recoveredName.ref).toEqual(recoveredNameRef)
    expect(recoveredName.name).not.toBe(canonicalName.name)
    const renamedRecovery = await step(() => bodyFetch(`${rig.info.baseUrl}/api/session-names`, { method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ target: recoveredNameRef,
        name: 'Managed recovered saved name', nameIntent: 'user' }) }))
    expect(renamedRecovery.ok, await step(() => renamedRecovery.clone().text())).toBe(true)
    writeBodyIncident('freshcodex-managed-native-recovery-name-progress', { userRef: created.sessionId,
      oldNativeRef: durableNameRef, newNativeRef: recoveredNameRef, oldName: await step(() => readName()), firstNewName: recoveredName,
      manualNewName: await step(() => readNameFor(recoveredNameRef)), recovered, recoveryControl, second, archiveManifest })
    const recoveredNativeContext = await step(() => inspectNativeContext())
    expect(recoveredNativeContext).toMatchObject({ uid: 65534, gid: 0, noNewPrivs: '1', capEff: '0000000000000000' })
    await step(() => managedWaitFor('recovered source native name writeback', async () => (await step(() => readNativeName(recoveredId, recoveredNativeContext))).title === 'Managed recovered saved name' ? true : undefined, 15_000))
    const recoveredCapture = await step(() => bodyFetch(`${rig.info.baseUrl}/api/panes/${paneId}/capture`, { headers }))
    expect(recoveredCapture.ok, await step(() => recoveredCapture.clone().text())).toBe(true)
    const capture = await step(() => recoveredCapture.text())
    expect(capture).toContain('Managed recovery second answer.')
    expect(capture).not.toContain('MANAGED_NATIVE_FIRST')
    const newTraffic = (await step(() => readModelTraffic())).slice(beforeCrash.trafficCursor).filter((row: any) => row.path === '/v1/responses')
    fixtureWork.throwIfAborted()
    expect(newTraffic.filter((row: any) => row.body.input.filter((item: any) => item.role === 'user').at(-1)?.content?.some((part: any) => part.text?.includes('MANAGED_RECOVERY_SECOND')))).toHaveLength(1)
    expect(newTraffic.every((row: any) => !JSON.stringify(row.body.input).includes('MANAGED_NATIVE_FIRST'))).toBe(true)
    expect((await step(() => rig.inventory())).filter(row => row.provider === 'codex' && row.nativeSessionId === recoveredId && row.launchState === 'running')).toHaveLength(1)
    writeBodyIncident('freshcodex-managed-native-recovery', { userRef: created.sessionId, oldNativeRef: created.sessionRef,
      newNativeRef: recoveredNameRef, beforeCrash, archiveManifest, nativeExit, recoveryAccepted, recovered, recoveryControl, second, capture,
      recoveryPublicFrames: recoveryPublicFrames(), resumedDeliveryEvidence, capturedClientEvidence,
      oldName: await step(() => readName()), firstNewName: recoveredName, finalNewName: await step(() => readNameFor(recoveredNameRef)),
      nativeName: await step(() => readNativeName(recoveredId, recoveredNativeContext)), recoveredNativeContext, newTraffic })

  }), 360_000)
})
