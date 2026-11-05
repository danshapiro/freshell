import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig } from '../../e2e-browser/helpers/managed-runtime.js'
import { ensureMcpServerBuilt, McpStdioClient } from '../../e2e-browser/helpers/mcp-stdio-client.js'
import { authorizeFreshAgentParityRequest, captureProviderParityVolumes, cleanupProviderParityVolumes, readProviderParitySource, type ProviderParitySource } from '../../helpers/provider-parity-broker.js'
import { makeProviderParityResourcesReadable, prepareProviderParityUserRoots, supervisorRegistrySecretScan } from '../../helpers/provider-parity-environment.js'
import { exposeGrantsToHarness, fakeOnecliGrants, withMissingGrant } from '../../helpers/provider-parity-onecli.js'
import type { InitialProviderVolumeAuthorization } from '../../../scripts/testing/runtime-test-broker.js'
// @ts-expect-error The native model-wire fixture is also used by the offline Node runner.
import { startInManagedContext } from '../providers/codex-local-provider.mjs'
import { cleanupProviderParity } from '../../helpers/provider-parity-cleanup.js'
import { waitFor, waitForFreshAgentFrame } from '../../helpers/fresh-agent-wait.js'
import {
  startSupervisorCrashDiagnostics,
  type SafeGdbSummary,
  type SupervisorCrashDiagnosticHandle,
} from '../../helpers/supervisor-crash-diagnostics.js'
import {
  appendNativeSyncSample,
  readNativeTitleDiagnosticFacts,
  summarizeNativeLifecycleBusyRefusals,
  summarizeNativeNameDurableState,
  summarizeNativeNameWorkerLogs,
  type NativeSyncDiagnosticSample,
} from '../../helpers/native-name-timeout-diagnostics.js'


const root = path.resolve(import.meta.dirname, '../../..')
const runFile = promisify(execFile)
const providers = [
  { provider: 'claude', sessionType: 'freshclaude', config: '.claude/settings.json' },
  { provider: 'codex', sessionType: 'freshcodex', config: '.codex/config.toml' },
  { provider: 'opencode', sessionType: 'freshopencode', config: 'custom-xdg/opencode/opencode.jsonc' },
] as const

type DiagnosticRead<T> = { ok: true; value: T } | { ok: false; error: { name: string; code?: string } }

function readBoundedTail(filePath: string, maxBytes: number): string {
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const size = fs.fstatSync(descriptor).size
    const length = Math.min(size, maxBytes)
    const bytes = Buffer.alloc(length)
    fs.readSync(descriptor, bytes, 0, length, size - length)
    return bytes.toString('utf8')
  } finally {
    fs.closeSync(descriptor)
  }
}

async function captureDiagnosticRead<T>(read: () => T | Promise<T>): Promise<DiagnosticRead<T>> {
  try { return { ok: true, value: await read() } }
  catch (error) {
    const value = error as NodeJS.ErrnoException
    const name = typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(value.name)
      ? value.name : 'Error'
    const code = typeof value.code === 'string' && /^[A-Z0-9_]+$/.test(value.code) ? value.code : undefined
    return { ok: false, error: { name, ...(code ? { code } : {}) } }
  }
}

type CreateFailureRig = Pick<ManagedRuntimeBrowserRig, 'runtime' | 'supervisor' | 'web' | 'inventory'>

function safeCreateFailureFrame(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { present: false }
  const frame = value as Record<string, unknown>
  const code = typeof frame.code === 'string' && /^[A-Z0-9_]+$/.test(frame.code) ? frame.code : undefined
  const requestId = typeof frame.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(frame.requestId)
    ? frame.requestId : undefined
  return {
    present: true,
    type: frame.type === 'freshAgent.create.failed' ? frame.type : 'unknown',
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
    ...(typeof frame.retryable === 'boolean' ? { retryable: frame.retryable } : {}),
    ...(frame.ownerKind === 'terminal' || frame.ownerKind === 'fresh-agent' ? { ownerKind: frame.ownerKind } : {}),
    ...(typeof frame.ownerGeneration === 'number' ? { ownerGeneration: frame.ownerGeneration } : {}),
    ...(typeof frame.ownerEpoch === 'number' ? { ownerEpoch: frame.ownerEpoch } : {}),
    messageCaptured: false,
  }
}

function summarizeCreateFailureLogs(value: string) {
  const tail = value.slice(-6000)
  const records = tail.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      const event = typeof row.event === 'string' && /^[a-z][a-z0-9_.-]{0,159}$/.test(row.event)
        ? row.event : undefined
      const severityValue = row.severity ?? row.level
      const severity = typeof severityValue === 'string'
        && ['trace', 'debug', 'info', 'warn', 'warning', 'error'].includes(severityValue.toLowerCase())
        ? severityValue.toLowerCase() : undefined
      const runtimeCodeValue = row.runtime_code ?? row.runtimeCode
      const runtimeCode = typeof runtimeCodeValue === 'string' && /^[A-Z0-9_]+$/.test(runtimeCodeValue)
        ? runtimeCodeValue : undefined
      return event || severity || runtimeCode ? [{ ...(severity ? { severity } : {}), ...(event ? { event } : {}), ...(runtimeCode ? { runtimeCode } : {}) }] : []
    } catch { return [] }
  }).slice(-24)
  return {
    lineCount: tail.split('\n').filter(line => line.length > 0).length,
    records,
    markers: {
      connectionRefused: /connection refused/i.test(tail),
      missingFile: /no such file or directory/i.test(tail),
      permissionDenied: /permission denied/i.test(tail),
      panic: /\bpanic\b/i.test(tail),
    },
  }
}

function safeCreateFailureWarnings(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.slice(-16).flatMap(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return []
    const warning = row as Record<string, unknown>
    const event = typeof warning.event === 'string' && /^[a-z][a-z0-9_.-]{0,159}$/.test(warning.event)
      ? warning.event : undefined
    const provider = ['claude', 'codex', 'opencode', 'amplifier'].includes(String(warning.provider))
      ? String(warning.provider) : undefined
    const runtimeCodeValue = warning.runtime_code
    const runtimeCode = typeof runtimeCodeValue === 'string' && /^[A-Z0-9_]+$/.test(runtimeCodeValue)
      ? runtimeCodeValue : undefined
    return event || provider || runtimeCode
      ? [{ ...(event ? { event } : {}), ...(provider ? { provider } : {}), ...(runtimeCode ? { runtimeCode } : {}) }]
      : []
  })
}

function summarizeContainerState(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { available: false }
  const state = value as Record<string, unknown>
  const status = ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']
    .includes(String(state.Status)) ? String(state.Status) : undefined
  return {
    available: true,
    ...(status ? { status } : {}),
    ...(typeof state.Running === 'boolean' ? { running: state.Running } : {}),
    ...(typeof state.ExitCode === 'number' ? { exitCode: state.ExitCode } : {}),
    ...(typeof state.OOMKilled === 'boolean' ? { oomKilled: state.OOMKilled } : {}),
    ...(typeof state.Error === 'string' ? { errorPresent: state.Error.length > 0 } : {}),
  }
}

async function captureCreateFailureEvidence(
  provider: typeof providers[number]['provider'],
  created: unknown,
  providerWarnings: unknown,
  rig: CreateFailureRig,
) {
  const { containerId, controlSocket } = rig.supervisor
  const [state, logs, socket, web] = await Promise.all([
    captureDiagnosticRead(() => summarizeContainerState(rig.runtime.inspectContainer(containerId).State)),
    captureDiagnosticRead(() => summarizeCreateFailureLogs(rig.runtime.containerLogs(containerId))),
    captureDiagnosticRead(() => {
      const info = fs.lstatSync(controlSocket)
      return { exists: true, isSocket: info.isSocket() }
    }),
    captureDiagnosticRead(() => summarizeCreateFailureLogs(
      Object.values(rig.web.capturedOutput()).join('\n'))),
  ])
  return {
    provider,
    originalCreateFailure: safeCreateFailureFrame(created),
    providerWarnings: safeCreateFailureWarnings(providerWarnings),
    supervisor: { containerId, state, logs, controlSocketPresent: Boolean(controlSocket), socket },
    web,
  }
}

describe('hosted fresh-agent create-failure diagnostics', () => {
  it('keeps the original failure and captures each available source independently', async () => {
    const created = { type: 'freshAgent.create.failed', requestId: 'create-1', code: 'SUPERVISOR_IO', message: 'private provider output' }
    const inventory = vi.fn(() => { throw new Error('inventory must not mask the create failure') })
    const rig = {
      supervisor: { containerId: 'supervisor-1', controlSocket: '/tmp/supervisor.sock' },
      runtime: {
        inspectContainer: () => { throw Object.assign(new Error('inspect unavailable'), { code: 'ENOENT' }) },
        containerLogs: () => '{"severity":"ERROR","event":"fresh_agent.create.inventory_failed","runtime_code":"SUPERVISOR_IO","error":"private provider output"}\npanic details fixture-secret-byte-alpha',
      },
      web: { capturedOutput: () => ({ stdout: 'server output private provider output', stderr: '' }) },
      inventory,
    } as unknown as CreateFailureRig

    const evidence = await captureCreateFailureEvidence('codex', created, [{
      event: 'fresh_agent.create.inventory_failed', provider: 'codex', runtime_code: 'SUPERVISOR_IO', error: 'private provider output',
    }], rig)

    expect(evidence.originalCreateFailure).toEqual({
      present: true, type: 'freshAgent.create.failed', requestId: 'create-1', code: 'SUPERVISOR_IO', messageCaptured: false,
    })
    expect(evidence.supervisor.state).toEqual({ ok: false, error: { name: 'Error', code: 'ENOENT' } })
    expect(evidence.supervisor.logs).toEqual({ ok: true, value: {
      lineCount: 2,
      records: [{ severity: 'error', event: 'fresh_agent.create.inventory_failed', runtimeCode: 'SUPERVISOR_IO' }],
      markers: { connectionRefused: false, missingFile: false, permissionDenied: false, panic: true },
    } })
    expect(evidence.supervisor.socket).toEqual({ ok: false, error: { name: 'Error', code: 'ENOENT' } })
    expect(evidence.web).toEqual({ ok: true, value: {
      lineCount: 1, records: [],
      markers: { connectionRefused: false, missingFile: false, permissionDenied: false, panic: false },
    } })
    expect(evidence.providerWarnings).toEqual([{
      event: 'fresh_agent.create.inventory_failed', provider: 'codex', runtimeCode: 'SUPERVISOR_IO',
    }])
    expect(JSON.stringify(evidence)).not.toContain('fixture-secret-byte-alpha')
    expect(JSON.stringify(evidence)).not.toContain('private provider output')
    expect(inventory).not.toHaveBeenCalled()
  })
})

// Native name synchronization allows retries no sooner than 5s and then
// 30s after the first two failed cycles. Include one 20s Codex metadata
// request and worker scheduling margin for the final attempt.
const NATIVE_NAME_SYNC_TIMEOUT_MS = 60_000
const HOSTED_PROVIDER_CASE_TIMEOUT_MS = 240_000

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

  wait(predicate: (frame: any) => boolean, deadline?: number): Promise<any> {
    return waitForFreshAgentFrame(this.frames, predicate, deadline)
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
    execFileSync('git', ['init', '--quiet', workspace], { timeout: 30_000, killSignal: 'SIGKILL' })
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
    // Managed input preparation and native startup have separate bounds. Let
    // the first outcome use the remaining case budget, without renewing it
    // for handshake or intermediate frames. All later assertions still run
    // within the same existing test timeout.
    const deadline = Date.now() + HOSTED_PROVIDER_CASE_TIMEOUT_MS
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
      && (frame.type === 'freshAgent.created' || frame.type === 'freshAgent.create.failed'), deadline)
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
      const evidence = await captureCreateFailureEvidence(row.provider, created, providerInputs, rig)
      const incidentSaved = await captureDiagnosticRead(() =>
        rig.runtime.writeIncident(`fresh-parity-${row.provider}-create-failure`, evidence))
      throw new Error(`${JSON.stringify(safeCreateFailureFrame(created))}; create-failure evidence ${incidentSaved.ok ? 'saved' : 'could not be saved'}`)
    }
    expect(created.type, JSON.stringify(safeCreateFailureFrame(created))).toBe('freshAgent.created')
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
    if (row.provider === 'codex') {
      expect(created.sessionRef).toEqual({ provider: 'codex', sessionId: recorded.nativeSessionId })
      await wire.wait(frame => frame.type === 'freshAgent.turn.complete'
        && frame.provider === 'codex' && frame.sessionId === created.sessionId)
      expect(wire.frames.filter(frame => frame.type === 'freshAgent.session.materialized'
        && frame.provider === 'codex' && frame.previousSessionId === created.sessionId)).toEqual([])
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
  }, HOSTED_PROVIDER_CASE_TIMEOUT_MS)
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
  let supervisorCrashDiagnostics: SupervisorCrashDiagnosticHandle | undefined
  let supervisorObserverSummary: SafeGdbSummary | undefined
  let supervisorObserverFinalizeFailed = false
  let pausedSessionHost: { containerId: string; incarnationId: string; pid: number } | undefined
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
    execFileSync('git', ['init', '--quiet', workspace], { timeout: 30_000, killSignal: 'SIGKILL' })
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
    const captureSupervisorCrash = process.env.FRESHELL_CAPTURE_SUPERVISOR_CRASH === '1'
    if (captureSupervisorCrash) rig.runtime.enableSupervisorPtraceForDiagnostics()
    await rig.start()
    if (captureSupervisorCrash) supervisorCrashDiagnostics = await startSupervisorCrashDiagnostics(rig)
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
    let cleanupConfirmed: boolean | undefined
    let teardownError: unknown
    const serverFailureFacts = () => {
      let serverProcessAlive = false
      try { rig.web.processEvidence(); serverProcessAlive = true } catch { /* The owned server may have exited. */ }
      const output = rig.web.capturedOutput()
      const stdoutTail = output.stdout.slice(-256 * 1024)
      const stderrTail = output.stderr.slice(-256 * 1024)
      const combinedTail = `${stdoutTail}\n${stderrTail}`
      const count = (pattern: RegExp) => (combinedTail.match(pattern) ?? []).length
      return {
        serverProcessAlive,
        supervisorControlSocketPresent: fs.existsSync(rig.supervisor.controlSocket),
        capturedStdoutBytes: Buffer.byteLength(output.stdout),
        capturedStderrBytes: Buffer.byteLength(output.stderr),
        inspectedTailBytes: Buffer.byteLength(combinedTail),
        markerCounts: {
          stackOverflow: count(/stack overflow|stack limit exceeded/gi),
          rustPanic: count(/panicked at|fatal runtime error|panic in a function that cannot unwind/gi),
          abortOrSegfault: count(/SIGABRT|SIGSEGV|signal (?:6|11)\b/gi),
          outOfMemory: count(/out of memory|memory allocation of .* failed|oom-kill/gi),
        },
      }
    }
    const rememberTeardownError = (error: unknown) => {
      teardownError = teardownError === undefined
        ? error
        : new AggregateError([teardownError, error], 'multiple installed-Codex rig teardown steps failed')
    }
    const retirePausedSessionHost = () => {
      if (!rig || !pausedSessionHost) return
      try {
        if (rig.runtime.isContainerRunning(pausedSessionHost.containerId)) {
          rig.runtime.killOwnedRuntimeExact(pausedSessionHost.containerId)
        }
        pausedSessionHost = undefined
      } catch (error) { rememberTeardownError(error) }
    }
    // Retire a paused host before final observations or fixture shutdown can
    // wait on it. Keep the finalizer retry below in case Docker is transiently
    // unavailable on this first exact-container cleanup attempt.
    retirePausedSessionHost()
    try {
      if (rig && finalObservation) {
        try { rig.runtime.writeIncident('freshcodex-managed-native-final-state', await finalObservation()) }
        catch (error) {
          rig.runtime.writeIncident('freshcodex-managed-native-final-state-error', {
            error: String(error), serverFailureFacts: serverFailureFacts(),
          })
        }
      }
      await wire?.close()
      await model?.stop()
    } catch (error) {
      rememberTeardownError(error)
    } finally {
      if (supervisorCrashDiagnostics) {
        try { supervisorObserverSummary = await supervisorCrashDiagnostics.finalizeObserver() }
        catch { supervisorObserverFinalizeFailed = true }
      }
      if (rig) {
        retirePausedSessionHost()
        let volumes: ReturnType<typeof captureProviderParityVolumes> | undefined
        try { volumes = captureProviderParityVolumes(owners) }
        catch (error) { rememberTeardownError(error) }
        try {
          const cleanup = await rig.stop()
          cleanupConfirmed = cleanup.ok
          if (!cleanup.ok) rememberTeardownError(new Error(cleanup.errors.join('\n') || 'managed rig cleanup failed'))
          else if (volumes) cleanupProviderParityVolumes(volumes)
        } catch (error) {
          cleanupConfirmed = false
          rememberTeardownError(error)
        }
      }
    }
    try {
      if (teardownError !== undefined) throw teardownError
    } finally {
      if (supervisorCrashDiagnostics) {
        try {
          rig.runtime.writeIncident('freshcodex-managed-supervisor-gdb-diagnostics', {
            policy: supervisorCrashDiagnostics.policy,
            probes: supervisorCrashDiagnostics.probes,
            observer: supervisorObserverSummary ?? supervisorCrashDiagnostics.collectObserver(),
            observerFinalizeFailed: supervisorObserverFinalizeFailed,
            cleanupConfirmed,
          })
        } catch { /* optional diagnostics never replace the product-test result */ }
        if (cleanupConfirmed === true) {
          try { supervisorCrashDiagnostics.removeTemporaryFiles() } catch { /* task-owned temp cleanup is best effort */ }
        }
      }
      if (naming) {
        naming.closeAllConnections()
        await new Promise<void>(resolve => naming.close(() => resolve()))
      }
      restoreGrants?.()
      if (grants) fs.rmSync(grants.directory, { recursive: true, force: true })
      if (home) fs.rmSync(home, { recursive: true, force: true })
    }
  }, 180_000)

  it('keeps supervisor crash diagnostics opt-in', () => {
    const enabled = process.env.FRESHELL_CAPTURE_SUPERVISOR_CRASH === '1'
    const inspected = rig.runtime.inspectContainer(rig.supervisor.containerId)
    const capAdd = (inspected.HostConfig.CapAdd ?? []).map((value: string) => value.replace(/^CAP_/, '')).sort()
    expect(capAdd).toEqual(['CHOWN', 'DAC_OVERRIDE', ...(enabled ? ['SYS_PTRACE'] : [])])
    if (!enabled) {
      expect(supervisorCrashDiagnostics).toBeUndefined()
      return
    }

    expect(supervisorCrashDiagnostics).toBeDefined()
    const diagnostics = supervisorCrashDiagnostics!
    expect(diagnostics.policy).toMatchObject({ defaultSeccomp: true, network: 'none', privileged: false,
      threadDbMatchesTarget: true })
    expect(diagnostics.collectObserver()).toMatchObject({ attached: true })
    expect(diagnostics.probes.sigsegv).toMatchObject({ targetExitCode: 139, gdbExitCode: 0,
      threadCount: expect.any(Number), workerThreadCount: 3 })
    expect(diagnostics.probes.sigterm).toMatchObject({ targetExitCode: 0, gdbExitCode: 0,
      handlerCleanup: true, targetReaped: true })
    for (const frame of diagnostics.probes.sigsegv.frames) {
      expect(Object.keys(frame).sort()).toEqual(['frame', 'symbol', 'thread'])
      expect(frame.symbol).not.toContain('(')
    }
  })

  it('uses the installed wrapper for catalog, settings, saved output and exact native controls', async () => {
    const requestId = `native-managed-${randomUUID()}`
    owners.push(authorizeFreshAgentParityRequest(rig.runtime.broker, source, 'codex', requestId))
    wire.send({ type: 'freshAgent.create', requestId, provider: 'codex', sessionType: 'freshcodex',
      cwd: workspace, model: 'contract-model', effort: 'xhigh', sandbox: 'workspace-write', permissionMode: 'untrusted',
      namingHandle: `name-${requestId}`, tabId: `tab-${requestId}` })
    const created = await wire.wait(frame => frame.requestId === requestId
      && ['freshAgent.created', 'freshAgent.create.failed'].includes(frame.type))
    if (created.type !== 'freshAgent.created') {
      const evidence = await captureCreateFailureEvidence('codex', created, [], rig)
      const incidentSaved = await captureDiagnosticRead(() =>
        rig.runtime.writeIncident('freshcodex-managed-native-create-failure', evidence))
      if (!incidentSaved.ok) {
        throw new Error(`${JSON.stringify(safeCreateFailureFrame(created))}; create-failure evidence could not be saved`)
      }
    }
    expect(created.type, JSON.stringify(safeCreateFailureFrame(created))).toBe('freshAgent.created')
    const view = await waitFor('native managed provider', async () => {
      const row = await rig.runningViewForFreshSession(created.sessionId)
      return row?.containerId && row.nativeSessionId ? row : undefined
    })
    let providerContainerId = view.containerId!
    expect(await rig.ownedProviderExec(providerContainerId, ['/opt/freshell-codex/launch', '--version'])).toContain('0.164.0')
    const inspectNativeContext = async (expectedCwd = workspace) => JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `
      const fs=require('node:fs');const layout=JSON.parse(fs.readFileSync('/opt/freshell-codex/layout.json','utf8'));
      const expectedCwd=${JSON.stringify(expectedCwd)};
      const candidates=fs.readdirSync('/proc').filter(p=>Number.isInteger(Number(p))).flatMap(pid=>{try{
        const status=fs.readFileSync('/proc/'+pid+'/status','utf8');const field=k=>status.split(String.fromCharCode(10)).find(line=>line.startsWith(k+':'))?.slice(k.length+1).trim();
        let executable,exeError,appServer=false;try{executable=fs.readlinkSync('/proc/'+pid+'/exe')}catch(error){exeError=error.code}
        try{appServer=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split(String.fromCharCode(0)).includes('app-server')}catch{}
        if(executable!==layout.nativeExecutable&&!appServer&&field('Name')!=='codex')return[];
        let cwd,cwdError,workspace;try{cwd=fs.readlinkSync('/proc/'+pid+'/cwd');const s=fs.statSync(cwd);let writable=false;try{fs.accessSync(cwd,fs.constants.W_OK);writable=true}catch{}workspace={uid:s.uid,gid:s.gid,mode:(s.mode&511).toString(8),writable}}catch(error){cwdError=error.code}
        return[{pid:Number(pid),parentPid:Number(field('PPid')),state:field('State'),uid:Number(field('Uid')?.split(String.fromCharCode(9))[0]),gid:Number(field('Gid')?.split(String.fromCharCode(9))[0]),
          executable,exeError,appServer,cwd,cwdError,workspace,noNewPrivs:field('NoNewPrivs'),capEff:field('CapEff')}];
      }catch{return[]}});const found=candidates.filter(row=>row.executable===layout.nativeExecutable&&row.appServer&&row.cwd===expectedCwd);
      if(found.length!==1)throw Error('Expected one actual installed native Codex app-server for the accepted working directory: '+JSON.stringify({expectedNative:layout.nativeExecutable,expectedCwd,matches:found.length,candidates}));process.stdout.write(JSON.stringify(found[0]));`]))
    const inspectNativeAppServers = async () => JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `
      const fs=require('node:fs');const layout=JSON.parse(fs.readFileSync('/opt/freshell-codex/layout.json','utf8'));
      const servers=fs.readdirSync('/proc').filter(pid=>Number.isInteger(Number(pid))).flatMap(pid=>{try{
        if(fs.readlinkSync('/proc/'+pid+'/exe')!==layout.nativeExecutable)return[];
        const cmdline=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split(String.fromCharCode(0));
        if(!cmdline.includes('app-server'))return[];
        const cwd=fs.readlinkSync('/proc/'+pid+'/cwd');
        return[{pid:Number(pid),cwd}];
      }catch{return[]}});
      process.stdout.write(JSON.stringify(servers));`]))
    const nativeContext = await inspectNativeContext()
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
    const supervisorLifecyclePath = path.join(path.dirname(rig.supervisor.runtimeRoot), 'evidence', 'lifecycle.jsonl')
    const readSupervisorLifecycle = () => {
      try {
        return readBoundedTail(supervisorLifecyclePath, 8 * 1024 * 1024).split('\n').flatMap(line => {
          try { return [JSON.parse(line)] } catch { return [] }
        })
      } catch { return [] }
    }
    const coldRecoveryFailureStages = new Set([
      'authorization', 'persisted_receipt', 'missing_authorization', 'absence_census',
      'absence_probe_ready', 'absence_probe_blocked', 'absence_probe_unexpected',
      'absence_census_selection_mismatch', 'absence_census_environment_mismatch',
      'absence_census_reference_missing', 'absence_evidence_invalid',
      'replacement_identity', 'before_rebind_evidence', 'rebound_receipt',
      'after_rebind_evidence', 'startup_evidence',
    ])
    const coldRecoveryProviderStartCauses = new Set([
      'exact_resume_validation', 'exact_resume_app_server_start', 'exact_resume_rpc',
      'exact_resume_create_rejected', 'exact_resume_identity', 'exact_resume_settings_reapply',
      'replacement_validation', 'replacement_app_server_start', 'replacement_thread_start',
      'replacement_create_finalize', 'replacement_create_rejected', 'replacement_identity',
      'unsupported',
    ])
    const coldRecoveryProviderStartDiagnostics = new Set([
      'authentication', 'arguments', 'listener', 'configuration', 'network',
      'unclassified', 'no_diagnostic',
    ])
    const coldRecoveryProbeKinds = new Set(['ready', 'blocked', 'unexpected'])
    const coldRecoveryProbeReasons = new Set([
      'CAPABILITY_PENDING', 'CREDENTIALS_EXPIRED', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE',
      'STORE_UNREADABLE', 'STORE_MISSING', 'WORKSPACE_UNAVAILABLE', 'INCOMPATIBLE_BINARY',
      'UNSUPPORTED_PROTOCOL', 'AMBIGUOUS_IDENTITY', 'IMPLEMENTATION_UNAVAILABLE',
      'INSUFFICIENT_RESOURCES', 'RETRY_BUDGET', 'STOP_INTENT', 'OLD_RUNTIME_NOT_EMPTY',
      'WRONG_NATIVE_IDENTITY', 'COMMAND_AMBIGUOUS',
    ])
    const coldRecoveryStoreStates = new Set(['unknown', 'not_applicable', 'missing', 'present_readable', 'present_unreadable'])
    const coldRecoveryDiagnostics = () => {
      const lifecycleRows = readSupervisorLifecycle()
      const supervisorEvents = lifecycleRows
        .filter(row => [
          'supervisor.runtime_observer.recovery_scheduled', 'supervisor.recovery_retry.settled',
          'supervisor.recovery_retry.exhausted', 'supervisor.recovery.activation_failed',
        ].includes(row.event))
        .slice(-32)
        .map(row => ({
          sequence: Number.isSafeInteger(row.sequence) ? row.sequence : undefined,
          event: row.event,
          trigger: typeof row.data?.trigger === 'string' ? row.data.trigger : undefined,
          reason: typeof row.data?.reason === 'string' ? row.data.reason : undefined,
          incarnationId: typeof row.data?.incarnationId === 'string' ? row.data.incarnationId : undefined,
          nativeReadinessFailureStage: coldRecoveryFailureStages.has(row.data?.nativeReadinessFailureStage)
            ? row.data.nativeReadinessFailureStage : undefined,
          nativeReadinessProbeKind: coldRecoveryProbeKinds.has(row.data?.nativeReadinessProbeKind)
            ? row.data.nativeReadinessProbeKind : undefined,
          nativeReadinessProbeReason: coldRecoveryProbeReasons.has(row.data?.nativeReadinessProbeReason)
            ? row.data.nativeReadinessProbeReason : undefined,
          nativeReadinessStoreState: coldRecoveryStoreStates.has(row.data?.nativeReadinessStoreState)
            ? row.data.nativeReadinessStoreState : undefined,
        }))
      const storeProbeSelections = lifecycleRows
        .filter(row => [
          'supervisor.recovery.codex_readiness_store_probe', 'supervisor.recovery.store_probe',
          'supervisor.recovery.unconfirmed_worker_store_probe',
        ].includes(row.event))
        .slice(-16)
        .map(row => {
          const probe = row.data?.probe
          const probeData = probe?.data
          const resumeSpec = probeData?.resumeSpec ?? probeData?.resume_spec
          const providerSession = resumeSpec?.providerSession ?? resumeSpec?.provider_session
          const environment = resumeSpec?.environment ?? {}
          const providerHome = resumeSpec?.providerHome ?? resumeSpec?.provider_home
          const selectedCodexHome = typeof environment.CODEX_HOME === 'string'
            ? environment.CODEX_HOME
            : typeof providerHome === 'string' ? path.join(providerHome, '.codex') : undefined
          return {
            sequence: Number.isSafeInteger(row.sequence) ? row.sequence : undefined,
            event: row.event,
            probeKind: ['resume_ready', 'definitively_unavailable', 'blocked'].includes(probe?.kind)
              ? probe.kind : undefined,
            provider: providerSession?.provider === 'codex' ? 'codex' : undefined,
            expectedNativeRootMatches: providerSession?.nativeSessionId === view.nativeSessionId
              || providerSession?.native_session_id === view.nativeSessionId,
            providerHome: typeof providerHome === 'string' ? providerHome : undefined,
            selectedCodexHome,
            selectedHomeMatchesNativeProcess: selectedCodexHome === effectiveCodexHome,
          }
        })
      const hostEvents = fs.readdirSync(rig.supervisor.runtimeRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith('incarnation-'))
        .flatMap(entry => {
          const file = path.join(rig.supervisor.runtimeRoot, entry.name, 'host-lifecycle.jsonl')
          if (!fs.existsSync(file)) return []
          const events = readBoundedTail(file, 256 * 1024).split('\n').flatMap(line => {
            try { return [JSON.parse(line)] } catch { return [] }
          })
          return events.filter(row => [
            'host.fresh_agent.open_failed', 'host.native_identity.readiness_receipt_committed', 'host.grant_timing',
          ].includes(row.event)).slice(-16).map(row => ({
            incarnationId: entry.name,
            event: row.event,
            nativeReadinessFailureStage: coldRecoveryFailureStages.has(row.data?.nativeReadinessFailureStage)
              ? row.data.nativeReadinessFailureStage : undefined,
            nativeReadinessProviderStartCause: coldRecoveryProviderStartCauses.has(row.data?.nativeReadinessProviderStartCause)
              ? row.data.nativeReadinessProviderStartCause : undefined,
            providerStartDiagnostic: coldRecoveryProviderStartDiagnostics.has(row.data?.providerStartDiagnostic)
              ? row.data.providerStartDiagnostic : undefined,
            nativeReadinessProbeKind: coldRecoveryProbeKinds.has(row.data?.nativeReadinessProbeKind)
              ? row.data.nativeReadinessProbeKind : undefined,
            nativeReadinessProbeReason: coldRecoveryProbeReasons.has(row.data?.nativeReadinessProbeReason)
              ? row.data.nativeReadinessProbeReason : undefined,
            nativeReadinessStoreState: coldRecoveryStoreStates.has(row.data?.nativeReadinessStoreState)
              ? row.data.nativeReadinessStoreState : undefined,
            outcome: ['accepted', 'refused'].includes(row.data?.outcome) ? row.data.outcome : undefined,
            errorCode: typeof row.data?.errorCode === 'string' && /^[A-Z0-9_]+$/.test(row.data.errorCode)
              ? row.data.errorCode : undefined,
            completedStages: Array.isArray(row.data?.stages)
              ? row.data.stages.flatMap((stage: any) => typeof stage?.stage === 'string'
                && /^[a-z_]+$/.test(stage.stage) ? [stage.stage] : []) : undefined,
          }))
        })
      return { supervisorEvents, hostEvents, storeProbeSelections }
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
      try { nativeFiles = JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `
        const fs=require('node:fs'),p='/home/freshell/provider/.codex/managed-mcp-traffic.jsonl';
        process.stdout.write(JSON.stringify({mcp:fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(JSON.parse):[],effects:fs.readdirSync(${JSON.stringify(path.join(workspace, 'allowed'))}).map(name=>{const p=${JSON.stringify(path.join(workspace, 'allowed'))}+'/'+name;return{name,uid:fs.statSync(p).uid,content:fs.readFileSync(p,'utf8')}})}));`]))
      } catch (error) { nativeFiles = { error: String(error) } }
      let traffic: unknown = retainedModelTraffic
      try { if (model) traffic = await model.readTraffic() } catch (error) { traffic = { retained: retainedModelTraffic, error: String(error) } }
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
      const relevantNativeNameLogs = (output: string) => output.split('\n')
        .filter(line => /freshagent\.native_name_refused|freshagent\.codex\.native_name_failed|session_names\.native_route_unavailable/i.test(line))
        .slice(-100)
      const captureNativeNameLogs = (capture: () => string) => {
        try { return relevantNativeNameLogs(capture()) }
        catch (error) { return [`capture_failed: ${String(error).slice(0, 500)}`] }
      }
      const nativeNameDiagnostics = {
        supervisorLifecycle: captureNativeNameLogs(() =>
          fs.readFileSync(path.join(path.dirname(rig.supervisor.runtimeRoot), 'evidence', 'lifecycle.jsonl'), 'utf8')),
      }
      return { created, initialView: view, currentViews, nativeContext, final,
        fixtureContext: model?.context, traffic, sentControls: wire.sentControls, frames: wire.frames,
        nativeFiles, hostDiagnostics, observationReadTraffic, publicHttpRequests, publicApiCounts, nativeNameDiagnostics,
        ownedHostEvidence: ownedHostEvidence() }
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
    expect((await model.readTraffic())[0].body.reasoning.effort).toBe('xhigh')
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
    const contextualAnswer = await send('Question: Which managed environment? Answer: Staging.', { effort: null })
    expect(contextualAnswer.submittedTurnId).toBeTruthy()
    await waitFor('managed contextual answer at loopback model', async () => (await model!.readTraffic()).some((row: any) => JSON.stringify(row.body.input).includes('Answer: Staging.')) ? true : undefined)
    const contextualTurnId = contextualAnswer.submittedTurnId
    const contextualCompletion = await wire.wait(frame => frame.type === 'freshAgent.event'
      && frame.event?.type === 'freshAgent.transcript.patch'
      && frame.provider === 'codex'
      && frame.sessionType === 'freshcodex'
      && frame.event.ops?.some((operation: any) => operation.op === 'settleTurn'
        && operation.nativeTurnId === contextualTurnId
        && operation.status === 'completed'))
    const adoptionFrameCursor = wire.frames.length
    const resumedResponse = await fetch(`${rig.info.baseUrl}/api/tabs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'codex', cwd: workspace, sessionRef: { provider: 'codex', sessionId: view.nativeSessionId } }) })
    expect(resumedResponse.ok, await resumedResponse.clone().text()).toBe(true)
    const resumed = await resumedResponse.json()
    const { paneId, tabId, sessionId: adoptedStreamSessionId } = resumed.data
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(paneId).toMatch(uuidPattern)
    expect(tabId).toMatch(uuidPattern)
    expect(adoptedStreamSessionId).toBe(view.nativeSessionId)
    expect(adoptedStreamSessionId).toBe(created.sessionRef.sessionId)
    const adoptedTab = await waitFor('native adoption tab acknowledgement', () => wire.frames.slice(adoptionFrameCursor)
      .find(frame => frame.type === 'ui.command' && frame.command === 'tab.create'
        && frame.payload?.id === tabId && frame.payload?.paneId === paneId))
    expect(adoptedTab.payload.paneContent).toMatchObject({ kind: 'fresh-agent', provider: 'codex',
      sessionType: 'freshcodex', sessionId: adoptedStreamSessionId, status: 'connected' })
    const adoptionRequestId = adoptedTab.payload.paneContent.createRequestId
    expect(adoptionRequestId).toEqual(expect.any(String))
    expect(adoptionRequestId).not.toHaveLength(0)
    const adoptedCreated = await waitFor('native adoption create acknowledgement', () => wire.frames.slice(adoptionFrameCursor)
      .find(frame => frame.type === 'freshAgent.created' && frame.requestId === adoptionRequestId))
    expect(adoptedCreated).toMatchObject({ provider: 'codex', runtimeProvider: 'codex',
      sessionType: 'freshcodex', sessionId: adoptedStreamSessionId })
    expect(adoptedCreated.sessionRef).toEqual({ provider: 'codex', sessionId: view.nativeSessionId })
    const aliasView = await rig.runningViewForFreshSession(created.sessionId)
    expect(aliasView).toMatchObject({ soulId: view.soulId, incarnationId: view.incarnationId,
      containerId: providerContainerId, hostBootId: view.hostBootId, nativeSessionId: view.nativeSessionId,
      provider: 'codex', freshAgentSessionType: 'freshcodex', freshAgentSessionId: created.sessionId })
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
        adoption: { response: resumed, tab: adoptedTab, created: adoptedCreated, aliasView,
          before: { contextualTurnId, completion: contextualCompletion }, frameCursor: adoptionFrameCursor },
        nativeSessionId: view.nativeSessionId, cli: { entry: cliEntry, capture: cliCapture.stdout },
        mcp: { entry: standalone.path, capture: mcpCapture, wait: mcpWait } })
    } finally {
      await standaloneMcp.close()
    }
    expect((await inspectNativeContext()).pid).toBe(nativeContext.pid)
    const durableNameRef = { kind: 'session', provider: 'codex', sessionId: view.nativeSessionId }
    const readNameUpdateFor = async (ref: unknown) => {
      const response = await observeRead('/api/session-names/read', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ refs: [ref] }) })
      expect(response.ok, `name read ${response.status}: ${await response.clone().text()}`).toBe(true)
      return (await response.json()).names[0]
    }
    const readNameFor = async (ref: unknown) => (await readNameUpdateFor(ref))?.record
    const readName = () => readNameFor(durableNameRef)
    const waitForNativeNameSync = async (
      ref: unknown,
      expected: any,
      label: string,
      expectedNativeSessionId: string,
      readNativeTitleOnce: () => Promise<unknown>,
      timeoutMs = NATIVE_NAME_SYNC_TIMEOUT_MS,
    ) => {
      const samples: NativeSyncDiagnosticSample[] = []
      let sample = 0
      try {
        return await waitFor(label, async () => {
          const update = await readNameUpdateFor(ref)
          appendNativeSyncSample(samples, update, ++sample)
          return update?.record?.revision === expected.revision
            && update.record.name === expected.name
            && update.nativeSync?.status === 'synced'
            && update.nativeSync.desiredRevision === expected.revision
            ? update
            : undefined
        }, timeoutMs)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== `timed out waiting for ${label}`) throw error

        const [serverDeferrals, durableState, supervisorBusyRefusals, nativeTitleAtTimeout] = await Promise.all([
          captureDiagnosticRead(() => summarizeNativeNameWorkerLogs(
            [Object.values(rig.web.capturedOutput()).join('\n'),
              readBoundedTail(path.join(rig.web.info.logsDir, 'rust-server.jsonl'), 64 * 1024)])),
          captureDiagnosticRead(() => summarizeNativeNameDurableState(
            fs.readFileSync(path.join(rig.web.info.homeDir, '.freshell', 'session-names.json'), 'utf8'),
            'codex', expectedNativeSessionId, expected.revision)),
          captureDiagnosticRead(() => summarizeNativeLifecycleBusyRefusals(
            readBoundedTail(path.join(path.dirname(rig.supervisor.runtimeRoot), 'evidence', 'lifecycle.jsonl'), 64 * 1024),
            expectedNativeSessionId)),
          readNativeTitleDiagnosticFacts(readNativeTitleOnce, expectedNativeSessionId, expected.name),
        ])
        const diagnostic = {
          waitLabel: label,
          ...(Number.isSafeInteger(expected.revision) ? { expectedRevision: expected.revision } : {}),
          syncSampleCount: samples.length,
          syncSamples: samples,
          serverDeferrals,
          durableState,
          supervisorBusyRefusals,
          nativeTitleAtTimeout,
        }
        try { rig.runtime.writeIncident('freshcodex-managed-native-sync-timeout', diagnostic) }
        catch { /* Keep the original synchronization timeout as the test failure. */ }
        throw error
      }
    }
    const nativeMetadata = JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `
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
      hostMetadataAccess, traffic: await model.readTraffic(), final: await snapshot() })
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
    const nativeSessionId = view.nativeSessionId
    if (typeof nativeSessionId !== 'string') throw new Error('Managed Codex view has no native session ID')
    const readNativeName = async (nativeId = view.nativeSessionId, context = nativeContext) => JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `
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
    const nativeNameBeforeWait = await readNativeName()
    rig.runtime.writeIncident('freshcodex-managed-native-name-writeback', { canonicalName, nativeNameBeforeWait, view, nativeContext })
    await waitForNativeNameSync(durableNameRef, canonicalName, 'managed native name synchronization',
      nativeSessionId, () => readNativeName(nativeSessionId, nativeContext), 150_000)
    await waitFor('managed native name writeback', async () => {
      const observation = await readNativeName()
      return observation.id === view.nativeSessionId && observation.title === canonicalName.name ? observation : undefined
    }, 15_000)
    rig.runtime.writeIncident('freshcodex-managed-native-journey', { created, view, nativeContext, context: model.context,
      traffic: await model.readTraffic(), saved, asyncSnapshot, canonicalName, nativeName: await readNativeName(), final: await snapshot() })

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
      const physical = async () => JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `
        const fs=require('node:fs'),p=${JSON.stringify(path.join(workspace, 'allowed'))}+'/'+${JSON.stringify(file)};
        process.stdout.write(JSON.stringify(fs.existsSync(p)?{exists:true,uid:fs.statSync(p).uid,content:fs.readFileSync(p,'utf8')}:{exists:false}));`]))
      expect(await physical()).toEqual({ exists: false })
      const frameCursor = wire.frames.length
      const accepted = await send(`MANAGED_EFFECT_${choice}`, { sandbox: choice === 'READONLY' ? 'read-only' : 'workspace-write', permissionMode: choice === 'READONLY' || choice === 'RESTRICTED' ? 'never' : 'untrusted' })
      const decision = choice === 'ACCEPT' ? 'accept' : 'cancel'
      const control = choice === 'READONLY' || choice === 'RESTRICTED' ? undefined : await approval(decision)
      const completed = await waitFor(`managed ${choice} command result`, async () => {
        const value = await snapshot()
        const nativeTurnId = value.turns.find((turn: any) => turn.role === 'user'
          && turn.items?.some((item: any) => item.text === 'MANAGED_EFFECT_'+choice))?.nativeTurnId
        return value.status === 'idle' && JSON.stringify(value.turns).includes('MANAGED_EFFECT_'+choice)
          && typeof nativeTurnId === 'string' && nativeTurnId.length > 0
          && !value.pendingApprovals.some((pending: any) => pending.requestId === control?.requestId)
          && wire.frames.slice(frameCursor).some(frame => {
            return frame.type === 'freshAgent.event' && frame.provider === 'codex' && frame.sessionType === 'freshcodex'
              && frame.sessionId === adoptedStreamSessionId && frame.event?.type === 'freshAgent.transcript.patch'
              && frame.event.sessionId === adoptedStreamSessionId
              && frame.event.ops?.some((op: any) => op.op === 'settleTurn' && op.nativeTurnId === nativeTurnId && ['completed', 'interrupted', 'failed'].includes(op.status))
          })
          && (choice === 'DECLINE' || JSON.stringify(value.turns).includes('Managed '+file+' result:')) ? value : undefined
      })
      const effect = await physical()
      if (choice === 'ACCEPT' || choice === 'RESTRICTED') expect(effect).toMatchObject({ exists: true, uid: 65534, content: 'managed-'+file })
      else expect(effect).toEqual({ exists: false })
      if (choice === 'READONLY') {
        // Native0.164 can return a failed unifiedExec result to the model
        // without persisting a commandExecution history item. Read the real
        // native tool result, never the fixture's repeated assistant phrase.
        const command = (await model.readTraffic()).flatMap((row: any) => row.body?.input ?? [])
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
          expect(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `fetch('http://127.0.0.1:51991/elicitation/example').then(r=>{if(!r.ok)throw Error('URL fixture failed');process.stdout.write('opened')})`])).toBe('opened')
          expect((await snapshot()).pendingElicitations.some((item: any) => item.requestId === pending.requestId)).toBe(true)
        }
        wire.send({ type: 'freshAgent.elicitation.respond', provider: 'codex', sessionType: 'freshcodex', sessionId: created.sessionId,
          requestId: pending.requestId, action, content: action === 'accept' && route !== 'url' ? { name: 'fixture', count: 2.5, enabled: true, color: 'blue' } : null })
      }
      await waitFor(`managed ${route} MCP completion`, async () => {
        const value = await snapshot()
        return value.status === 'idle' && JSON.stringify(value.turns).includes('Managed MCP '+route+' completed.') ? true : undefined
      })
      const traffic = JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `const fs=require('node:fs');process.stdout.write(JSON.stringify(fs.readFileSync('/home/freshell/provider/.codex/managed-mcp-traffic.jsonl','utf8').trim().split(String.fromCharCode(10)).map(JSON.parse)))`]))
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
    expect((await inspectNativeContext()).pid).toBe(nativeContext.pid)
    await rig.ownedProviderExec(providerContainerId, ['node', '-e', "require('node:fs').writeFileSync('/home/freshell/provider/.freshell-fixture/release-child','release')"])
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
    const previousTraffic = await model.readTraffic()
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
        const context = await inspectNativeContext()
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
    expect((await model.readTraffic()).filter((row: any) => row.path === '/v1/responses')).toHaveLength(1)
    rig.runtime.writeIncident('freshcodex-managed-native-tools-restart', { created, nativeContext, canonicalName, effects, mcpResults,
      registered, childControl, childResponse, childSaved, beforeRestart, restarted, afterRestart, traffic: previousTraffic, restartedTraffic: await model.readTraffic(), finalName: await readName() })

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
      name: await readName(), nativeContext: await inspectNativeContext(), trafficCursor: (await model.readTraffic()).length }
    expect(beforeCrash.name).toEqual(canonicalName)
    rig.runtime.writeIncident('freshcodex-managed-native-before-crash', beforeCrash)
    // Pause only this receipt-owned session host so it cannot take the live
    // readiness path while the provider history is removed. The supervisor
    // must recover through a new host and its durable cold-start receipt.
    const lifecycleBeforeHostPause = readSupervisorLifecycle()
    const supervisorSequenceBeforeHostPause = lifecycleBeforeHostPause.reduce((latest, row) =>
      Number.isSafeInteger(row.sequence) ? Math.max(latest, row.sequence) : latest, 0)
    const stoppedSessionHostPid = rig.signalOwnedSessionHostExact(
      providerContainerId, beforeCrash.view!.incarnationId, 'SIGSTOP')
    pausedSessionHost = {
      containerId: providerContainerId,
      incarnationId: beforeCrash.view!.incarnationId,
      pid: stoppedSessionHostPid,
    }
    // Kill only this receipt-owned, inspected release native PID. Archive its
    // REAL native-generated history after exit, keeping every original byte.
    rig.runtime.killOwnedRuntimePidExact(providerContainerId, beforeCrash.nativeContext.pid)
    const nativeExit = await waitFor('exact native process terminal state before history archive', async () => {
      const state = JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `
        const fs=require('node:fs'),p='/proc/${beforeCrash.nativeContext.pid}/status';
        process.stdout.write(JSON.stringify(fs.existsSync(p)?{exists:true,state:fs.readFileSync(p,'utf8').split(String.fromCharCode(10)).find(line=>line.startsWith('State:')).slice(6).trim()}:{exists:false}));`]))
      return !state.exists || state.state.startsWith('Z') ? state : undefined
    })
    const originalRollout = nativeMetadata.headers.find((header: any) => header.id === view.nativeSessionId).path
    const archived = JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `
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
    const effectiveCodexHome = nativeMetadata.env.CODEX_HOME
      ?? path.join(nativeMetadata.env.HOME, '.codex')
    const providerHome = nativeMetadata.env.HOME
    const digestPath = (value: string) => createHash('sha256').update(value).digest('hex')
    const archiveManifestDiagnostics = {
      fileCount: archiveManifest.length,
      fileSamples: archiveManifest.slice(0, 16).map((file: any) => ({
        sourcePathSha256: digestPath(file.source),
        archivePathSha256: digestPath(file.archive),
        contentSha256: file.sha256,
        bytes: file.bytes,
      })),
      fileSamplesTruncated: archiveManifest.length > 16,
      archivedTargetRollout: archiveManifest.some((file: any) => file.source === originalRollout),
      archivedStateDatabaseCount: archiveManifest.filter((file: any) => /^state_[0-9]+[.]sqlite(?:-wal|-shm)?$/.test(path.basename(file.source))).length,
      archivedSessionIndex: archiveManifest.some((file: any) => path.basename(file.source) === 'session_index.jsonl'),
    }
    const postArchiveCensus = JSON.parse(await rig.ownedProviderExec(providerContainerId, ['node', '-e', `
      const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{TextDecoder}=require('node:util');
      const codexHome=${JSON.stringify(effectiveCodexHome)},providerHome=${JSON.stringify(providerHome)},expected=${JSON.stringify(view.nativeSessionId)};
      const explicitCodexHome=${JSON.stringify(typeof nativeMetadata.env.CODEX_HOME==='string')},sessionRoot=path.join(codexHome,'sessions');
      const limits={entries:50000,files:8192,statBytes:536870912,bytesPerFile:1048576,totalReadBytes:268435456,depth:8,pathBytes:4096,pathComponents:128,errorSamples:16,matchSamples:16};
      const errorCodes=['unreadable','read_error','symlink','nonregular','non_jsonl','first_record_missing','malformed','conflicting_owner','truncated','limit_hit'];
      const errorCounts=Object.fromEntries(errorCodes.map(code=>[code,0])),errorSamples=[],matches=[],fileSummaries=[];
      let complete=true,stopped=false,totalEntries=0,totalFiles=0,totalStatBytes=0n,totalReadBytes=0,jsonlFiles=0,reproductionCandidate=null;
      let sessionDirectoryState='missing',matchingPathSamplesTruncated=false,fileSummariesTruncated=false;
      const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
      const mark=(code,file)=>{complete=false;errorCounts[code]++;if(errorSamples.length<limits.errorSamples)errorSamples.push({code,pathSha256:digest(file)})};
      const ioCode=error=>error?.code==='EACCES'||error?.code==='EPERM'?'unreadable':error?.code==='ELOOP'?'symlink':'read_error';
      const countEntry=file=>{if(totalEntries>=limits.entries){mark('limit_hit',file);stopped=true;fileSummariesTruncated=true;return false}totalEntries++;return true};
      const addStatBytes=(file,metadata)=>{if(!metadata.isFile())return true;const size=metadata.size;if(size>BigInt(limits.statBytes)-totalStatBytes){mark('limit_hit',file);stopped=true;fileSummariesTruncated=true;return false}totalStatBytes+=size;return true};
      const lstat=(file,allowMissing=false)=>{try{const metadata=fs.lstatSync(file,{bigint:true});if(!addStatBytes(file,metadata))return undefined;return metadata}catch(error){if(allowMissing&&error?.code==='ENOENT')return null;mark(ioCode(error),file);return undefined}};
      const access=(file,mode)=>{try{fs.accessSync(file,mode);return true}catch{return false}};
      const inspectDirectory=(target,requireRead)=>{
        const result={absolute:path.isAbsolute(target),exists:false,directory:false,canonical:false,readable:false,searchable:false};
        if(target.length>limits.pathBytes){mark('limit_hit',target);stopped=true;return result}
        if(!result.absolute){mark('read_error',target);return result}
        const parsed=path.parse(target),parts=target.slice(parsed.root.length).split(path.sep).filter(Boolean);
        if(parts.length>limits.pathComponents){mark('limit_hit',target);stopped=true;return result}
        let current=parsed.root;
        const components=parts.length?parts:[''];
        for(let index=0;index<components.length;index++){
          const part=components[index];if(part)current=path.join(current,part);
          if(!countEntry(current))return result;
          const metadata=lstat(current,true);
          if(metadata===null||!metadata)return result;
          if(index===components.length-1)result.exists=true;
          if(metadata.isSymbolicLink()){mark('symlink',current);return result}
          if(!metadata.isDirectory()){mark('nonregular',current);return result}
          const searchable=access(current,fs.constants.X_OK);
          if(!searchable){mark('unreadable',current);return result}
          if(index===components.length-1){
            result.exists=true;result.directory=true;result.searchable=searchable;
            result.readable=access(current,fs.constants.R_OK);
            try{result.canonical=fs.realpathSync.native(target)===path.resolve(target)}catch(error){mark(ioCode(error),current);return result}
            if(requireRead&&!result.readable)mark('unreadable',current);
            return result;
          }
        }
        return result;
      };
      const homeProbe=inspectDirectory(codexHome,false),rootProbe=inspectDirectory(sessionRoot,true);
      let matchingOwnerCount=0;
      const addMatch=file=>{matchingOwnerCount++;if(matches.length<limits.matchSamples)matches.push(digest(file));else matchingPathSamplesTruncated=true};
      const saveFileSummary=summary=>{if(fileSummaries.length<limits.files)fileSummaries.push(summary);else fileSummariesTruncated=true};
      const addUnavailableFileSummary=(file,listed,outcome)=>{
        saveFileSummary({pathSha256:digest(file),bytes:listed?Number(listed.size):null,
          mode:listed?Number(listed.mode&0o777n).toString(8):null,firstRecordType:'unreadable',ownerNonempty:false,
          ownerMatchesExpected:false,recordCount:0,complete:false,truncated:outcome==='prefix_incomplete',parseOutcome:outcome});
      };
      const inspectOwner=(file,listed)=>{
        let descriptor,owner,firstRecord=true,lineStart=0,finished=false,rawBytes=null;
        const summary={pathSha256:digest(file),bytes:Number(listed.size),mode:Number(listed.mode&0o777n).toString(8),
          firstRecordType:'missing',ownerNonempty:false,ownerMatchesExpected:false,recordCount:0,complete:false,truncated:false,parseOutcome:'unreadable'};
        const finish=()=>{
          if(finished)return owner;finished=true;
          summary.ownerNonempty=typeof owner==='string'&&owner.trim().length>0;
          summary.ownerMatchesExpected=owner===expected;
          if(summary.complete)summary.parseOutcome=summary.ownerMatchesExpected?'target_owner':'valid_other';
          if(summary.complete&&summary.parseOutcome==='valid_other'&&rawBytes&&rawBytes.length<=262144){reproductionCandidate={pathSha256:summary.pathSha256,bytes:rawBytes.length,contentSha256:digest(rawBytes),base64:rawBytes.toString('base64')}}
          if(summary.ownerMatchesExpected)addMatch(file);
          saveFileSummary(summary);
          return owner;
        };
        const fileIssue=(code,outcome,truncated=false)=>{
          mark(code,file);summary.complete=false;summary.parseOutcome=outcome;summary.truncated ||= truncated;
        };
        try{
          descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
          const opened=fs.fstatSync(descriptor,{bigint:true});
          if(!opened.isFile()){fileIssue('nonregular','unreadable');return finish()}
          if(opened.dev!==listed.dev||opened.ino!==listed.ino||opened.size!==listed.size){fileIssue('truncated','prefix_incomplete',true);return finish()}
          const extent=Number(opened.size);
          if(!Number.isSafeInteger(extent)){fileIssue('limit_hit','prefix_incomplete',true);return finish()}
          const remaining=limits.totalReadBytes-totalReadBytes;
          const byteLimit=Math.min(extent,limits.bytesPerFile,remaining);
          if(byteLimit<extent){fileIssue('truncated','prefix_incomplete',true);mark('limit_hit',file)}
          if(byteLimit===0&&extent>0){stopped=true;fileSummariesTruncated=true;return finish()}
          const buffer=Buffer.alloc(byteLimit);let count=0;
          while(count<byteLimit){const read=fs.readSync(descriptor,buffer,count,byteLimit-count,count);if(read===0)break;count+=read;totalReadBytes+=read}
          rawBytes=Buffer.from(buffer.subarray(0,count));
          if(count<byteLimit)fileIssue('truncated','prefix_incomplete',true);
          const after=fs.fstatSync(descriptor,{bigint:true});
          if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size)fileIssue('truncated','prefix_incomplete',true);
          const completeFile=count===extent&&after.size===opened.size;
          summary.complete=completeFile;
          const decoder=new TextDecoder('utf-8',{fatal:true});
          const inspectLine=(end)=>{
            const line=buffer.subarray(lineStart,end);lineStart=end+1;
            if(line.every(byte=>byte===9||byte===10||byte===13||byte===32))return true;
            let row;try{row=JSON.parse(decoder.decode(line))}catch{if(firstRecord)summary.firstRecordType='malformed';fileIssue('malformed','malformed');return false}
            summary.recordCount++;
            if(firstRecord){
              firstRecord=false;
              summary.firstRecordType=row&&typeof row==='object'&&!Array.isArray(row)&&row.type==='session_meta'?'session_meta':'other';
              if(!row||typeof row!=='object'||Array.isArray(row)||row.type!=='session_meta'){
                fileIssue('first_record_missing','malformed');return false
              }
            }
            if(row&&typeof row==='object'&&!Array.isArray(row)&&row.type==='session_meta'){
              const id=row.payload&&typeof row.payload==='object'&&!Array.isArray(row.payload)?row.payload.id:undefined;
              if(typeof id!=='string'||!id.trim()){fileIssue('malformed','malformed');return false}
              if(owner===undefined)owner=id;
              else if(owner!==id){fileIssue('conflicting_owner','owner_conflict');return false}
            }
            return true;
          };
          for(let index=0;index<count;index++){
            if(buffer[index]===10&&!inspectLine(index))return finish();
          }
          if(completeFile&&lineStart<count&&!inspectLine(count))return finish();
          if(firstRecord&&completeFile)fileIssue('first_record_missing','malformed');
          if(!completeFile){summary.complete=false;summary.truncated=true;if(summary.parseOutcome==='unreadable')summary.parseOutcome='prefix_incomplete'}
          return finish();
        }catch(error){fileIssue(ioCode(error),'unreadable');return finish()}
        finally{if(descriptor!==undefined){try{fs.closeSync(descriptor)}catch{fileIssue('read_error','unreadable')}}}
      };
      const walk=(directory,depth,isSelectedRoot=false)=>{
        if(stopped)return;
        if(depth>=limits.depth){mark('limit_hit',directory);stopped=true;fileSummariesTruncated=true;return}
        let handle;try{handle=fs.opendirSync(directory)}catch(error){mark(ioCode(error),directory);fileSummariesTruncated=true;if(isSelectedRoot)sessionDirectoryState='unreadable';return}
        try{
          while(!stopped){
            let entry;try{entry=handle.readSync()}catch(error){mark(ioCode(error),directory);fileSummariesTruncated=true;if(isSelectedRoot)sessionDirectoryState='unreadable';break}
            if(!entry)break;
            const file=path.join(directory,entry.name);if(!countEntry(file))break;
            const metadata=lstat(file);
            if(!metadata){if(entry.name.endsWith('.jsonl'))addUnavailableFileSummary(file,undefined,stopped?'prefix_incomplete':'unreadable');continue}
            if(metadata.isSymbolicLink()){mark('symlink',file);if(entry.name.endsWith('.jsonl'))addUnavailableFileSummary(file,metadata,'unreadable');continue}
            if(metadata.isDirectory()){walk(file,depth+1);continue}
            if(!metadata.isFile()){mark('nonregular',file);if(entry.name.endsWith('.jsonl'))addUnavailableFileSummary(file,metadata,'unreadable');continue}
            if(totalFiles>=limits.files){mark('limit_hit',file);stopped=true;fileSummariesTruncated=true;if(entry.name.endsWith('.jsonl'))addUnavailableFileSummary(file,metadata,'prefix_incomplete');break}
            totalFiles++;
            if(!entry.name.endsWith('.jsonl')){mark('non_jsonl',file);continue}
            jsonlFiles++;inspectOwner(file,metadata);
          }
        }finally{try{handle.closeSync()}catch(error){if(error?.code!=='ERR_DIR_CLOSED'){mark(ioCode(error),directory);if(isSelectedRoot)sessionDirectoryState='unreadable'}}}
      };
      if(rootProbe.exists&&rootProbe.directory&&rootProbe.readable&&rootProbe.searchable){sessionDirectoryState='readable';if(countEntry(sessionRoot))walk(sessionRoot,0,true)}
      else if(rootProbe.exists){sessionDirectoryState='unreadable'}
      process.stdout.write(JSON.stringify({localBoundedClassificationOnly:true,authenticatedRustProbeAuthoritative:true,complete,
        providerHomePathSha256:digest(providerHome||''),selectedCodexHomePathSha256:digest(codexHome),selectedSessionsRootPathSha256:digest(sessionRoot),
        selectedCodexHomeExplicit:explicitCodexHome,selectedCodexHomeAbsolute:homeProbe.absolute,selectedCodexHomeExists:homeProbe.exists,
        selectedCodexHomeAvailable:homeProbe.exists&&homeProbe.directory&&homeProbe.canonical&&homeProbe.searchable,
        selectedCodexHomeCanonical:homeProbe.canonical,selectedCodexHomeReadable:homeProbe.readable,selectedCodexHomeSearchable:homeProbe.searchable,
        selectedSessionsRootAbsolute:rootProbe.absolute,selectedSessionsRootExists:rootProbe.exists,selectedSessionsRootDirectory:rootProbe.directory,
        selectedSessionsRootAvailable:sessionDirectoryState==='readable',
        selectedSessionsRootCanonical:rootProbe.canonical,selectedSessionsRootReadable:rootProbe.readable,selectedSessionsRootSearchable:rootProbe.searchable,
        sessionDirectoryState,totalEntries,totalFiles,totalStatBytes:totalStatBytes.toString(),totalReadBytes,jsonlFiles,
        targetHeaderCount:matchingOwnerCount,targetPathSha256:matches,matchingPathSamplesTruncated,fileSummaries,fileSummariesTruncated,
        reproductionFile:complete&&jsonlFiles===1&&fileSummaries.length===1?reproductionCandidate:null,
        limits,errorCounts,errorSamples}));`]))
    const reproductionFile = postArchiveCensus.reproductionFile
    delete postArchiveCensus.reproductionFile
    let privateRolloutCopy: Record<string, unknown> = { outcome: 'not_available' }
    if (reproductionFile && postArchiveCensus.complete && postArchiveCensus.jsonlFiles === 1
      && postArchiveCensus.fileSummaries.length === 1 && reproductionFile.bytes <= 262_144) {
      try {
        const bytes = Buffer.from(reproductionFile.base64, 'base64')
        const valid = bytes.length === reproductionFile.bytes
          && createHash('sha256').update(bytes).digest('hex') === reproductionFile.contentSha256
          && postArchiveCensus.fileSummaries[0].pathSha256 === reproductionFile.pathSha256
          && postArchiveCensus.fileSummaries[0].parseOutcome === 'valid_other'
        if (valid) {
          const copy = path.join(archiveDirectory, `remaining-${reproductionFile.pathSha256}.jsonl`)
          fs.writeFileSync(copy, bytes, { mode: 0o600, flag: 'wx' })
          fs.chmodSync(copy, 0o600)
          const copiedMode = fs.statSync(copy).mode & 0o777
          privateRolloutCopy = {
            outcome: copiedMode === 0o600 ? 'preserved' : 'mode_mismatch',
            pathSha256: reproductionFile.pathSha256,
            contentSha256: reproductionFile.contentSha256,
            bytes: reproductionFile.bytes,
            mode: copiedMode.toString(8),
          }
        } else {
          privateRolloutCopy = { outcome: 'integrity_mismatch' }
        }
      } catch {
        privateRolloutCopy = { outcome: 'write_failed' }
      }
    }
    postArchiveCensus.privateRolloutCopy = privateRolloutCopy
    const preArchiveTargetPaths = nativeMetadata.headers
      .filter((header: any) => header.type === 'session_meta' && header.id === view.nativeSessionId)
      .map((header: any) => createHash('sha256').update(header.path).digest('hex'))
    rig.runtime.writeIncident('freshcodex-managed-native-crash-archive-census', {
      codexHomePathSha256: postArchiveCensus.selectedCodexHomePathSha256,
      providerHomePathSha256: postArchiveCensus.providerHomePathSha256,
      preArchiveHeaderCount: nativeMetadata.headers.length,
      preArchiveDirectoryErrorCount: nativeMetadata.errors.length,
      preArchiveTargetHeaderCount: preArchiveTargetPaths.length,
      preArchiveTargetPathSha256: preArchiveTargetPaths.slice(0, 16),
      preArchiveTargetPathSamplesTruncated: preArchiveTargetPaths.length > 16,
      archive: archiveManifestDiagnostics,
      postArchiveCensus,
    })
    expect(postArchiveCensus.complete).toBe(true)
    expect(postArchiveCensus.sessionDirectoryState).toBe('readable')
    expect(postArchiveCensus.targetHeaderCount).toBe(0)
    const beforeColdHostRetirement = await rig.runningViewForFreshSession(created.sessionId)
    expect(beforeColdHostRetirement?.incarnationId).toBe(beforeCrash.view!.incarnationId)
    expect(beforeColdHostRetirement?.nativeSessionId).toBe(view.nativeSessionId)
    expect(rig.runtime.isContainerRunning(providerContainerId)).toBe(true)
    const priorHostTraffic = await model.readTraffic()
    retainedModelTraffic = [...retainedModelTraffic, ...priorHostTraffic]
    // The actor is paused, so a provider-exit observer cannot complete an
    // in-place readiness change. Retire its exact container before waiting
    // for the observer, forcing recovery to open a new actor process.
    expect(stoppedSessionHostPid).toBeGreaterThan(1)
    rig.runtime.killOwnedRuntimeExact(providerContainerId)
    pausedSessionHost = undefined
    model = undefined
    let coldRecovery: { trigger: any; settled: any }
    try {
      coldRecovery = await waitFor('cold Codex replacement recovery settlement', async () => {
        const rows = readSupervisorLifecycle()
        const trigger = rows.find(row => row.sequence > supervisorSequenceBeforeHostPause
          && row.event === 'supervisor.runtime_observer.recovery_scheduled'
          && row.data?.soulId === beforeCrash.view!.soulId
          && row.data?.trigger === 'host_unreachable')
        if (!trigger) return undefined
        const settlements = rows.filter(row => row.sequence > trigger.sequence
          && row.data?.soulId === beforeCrash.view!.soulId
          && ['supervisor.recovery_retry.settled', 'supervisor.recovery_retry.exhausted']
            .includes(row.event))
        for (const settled of settlements.reverse()) {
          if (settled.event === 'supervisor.recovery_retry.exhausted') return { trigger, settled }
          if (settled.data?.reason !== 'recovered' || typeof settled.data?.incarnationId !== 'string') continue
          const hostPath = path.join(rig.supervisor.runtimeRoot,
            settled.data.incarnationId, 'host-lifecycle.jsonl')
          try {
            const hostEvents = readBoundedTail(hostPath, 1024 * 1024).split('\n').flatMap(line => {
              try { return [JSON.parse(line)] } catch { return [] }
            })
            if (hostEvents.some(row => row.event === 'host.native_identity.readiness_receipt_committed')) {
              return { trigger, settled }
            }
          } catch { /* A later settlement may still carry its host receipt. */ }
        }
        return undefined
      }, 150_000)
    } catch (error) {
      const diagnostic = coldRecoveryDiagnostics()
      try { rig.runtime.writeIncident('freshcodex-managed-native-cold-recovery-failed', diagnostic) } catch { /* Preserve the recovery failure. */ }
      throw new Error(`cold Codex host recovery did not settle: ${error instanceof Error ? error.message : String(error)}; ${JSON.stringify(diagnostic)}`)
    }
    const coldRecoveryDiagnostic = coldRecoveryDiagnostics()
    rig.runtime.writeIncident('freshcodex-managed-native-cold-recovery-settlement', coldRecoveryDiagnostic)
    expect(coldRecovery.trigger.data.trigger).toBe('host_unreachable')
    expect(coldRecovery.settled.event).toBe('supervisor.recovery_retry.settled')
    expect(coldRecovery.settled.data.reason).toBe('recovered')
    expect(coldRecovery.settled.data.incarnationId).not.toBe(beforeCrash.view!.incarnationId)
    const recovered = await waitFor('cold replacement Codex actor running', async () => {
      const current = await rig.runningViewForFreshSession(created.sessionId)
      if (!current || !current.containerId || !current.hostBootId
        || current.incarnationId !== coldRecovery.settled.data.incarnationId
        || !rig.runtime.isContainerRunning(current.containerId)) return undefined
      return current
    })
    expect(recovered.incarnationId).not.toBe(beforeCrash.view!.incarnationId)
    expect(recovered.hostBootId).not.toBe(beforeCrash.view!.hostBootId)
    expect(recovered.nativeSessionId).toBeTruthy()
    expect(recovered.nativeSessionId).not.toBe(view.nativeSessionId)
    providerContainerId = recovered.containerId!
    const recoveredHostLifecyclePath = path.join(rig.supervisor.runtimeRoot,
      recovered.incarnationId, 'host-lifecycle.jsonl')
    const recoveredHostEvents = readBoundedTail(recoveredHostLifecyclePath, 1024 * 1024)
      .split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    expect(recoveredHostEvents.some(row => row.event === 'host.native_identity.readiness_receipt_committed'))
      .toBe(true)
    model = await startInManagedContext(rig, { containerId: providerContainerId, handlerSource })
    const recoveryAccepted = await send('AWAITED_PLAN_RECOVERY')
    rig.runtime.writeIncident('freshcodex-managed-native-crash-first-send', { userRef: created.sessionId, beforeCrash,
      archive: archiveManifestDiagnostics, nativeExit, recoveryAccepted, recovered, coldRecovery: {
        trigger: coldRecovery.trigger.event, outcome: coldRecovery.settled.event,
        reason: coldRecovery.settled.data.reason, incarnationId: coldRecovery.settled.data.incarnationId,
        receiptCommitted: true,
      }, newTraffic: await model.readTraffic(), frames: wire.frames.slice(-30) })
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
    const recoveredCanonicalName = await readNameFor(recoveredNameRef)
    expect(recoveredCanonicalName).toMatchObject({ ref: recoveredNameRef, name: 'Managed recovered saved name', source: 'manual' })
    rig.runtime.writeIncident('freshcodex-managed-native-recovery-name-progress', { userRef: created.sessionId,
      oldNativeRef: durableNameRef, newNativeRef: recoveredNameRef, oldName: await readName(), firstNewName: recoveredName,
      manualNewName: await readNameFor(recoveredNameRef), recovered, recoveryControl, second, archive: archiveManifestDiagnostics })
    const recoveredNativeContext = await inspectNativeContext(recoveryCwd)
    expect(recoveredNativeContext).toMatchObject({ uid: 65534, gid: 0, cwd: recoveryCwd,
      noNewPrivs: '1', capEff: '0000000000000000' })
    let observedNativeAppServers: Array<{ pid: number; cwd: string }> = []
    const recoveredNativeAppServers = await waitFor('failed exact-resume app-server reaped after cold recovery', async () => {
      observedNativeAppServers = await inspectNativeAppServers()
      return observedNativeAppServers.length === 1
        && observedNativeAppServers[0].pid === recoveredNativeContext.pid
        && observedNativeAppServers[0].cwd === recoveryCwd
        ? observedNativeAppServers
        : undefined
    }, 10_000).catch(() => {
      throw new Error(`unexpected Codex app-server processes after cold recovery: ${JSON.stringify(observedNativeAppServers)}`)
    })
    expect(recoveredNativeAppServers).toEqual([{ pid: recoveredNativeContext.pid, cwd: recoveryCwd }])
    // Busy refusals back off to a durable 60s cooldown after six attempts.
    // Leave room for that retry and its provider read/write confirmation.
    await waitForNativeNameSync(recoveredNameRef, recoveredCanonicalName, 'recovered native name synchronization',
      recoveredId, () => readNativeName(recoveredId, recoveredNativeContext), 150_000)
    await waitFor('recovered source native name writeback', async () => (await readNativeName(recoveredId, recoveredNativeContext)).title === 'Managed recovered saved name' ? true : undefined, 15_000)
    const recoveredCapture = await fetch(`${rig.info.baseUrl}/api/panes/${paneId}/capture`, { headers })
    expect(recoveredCapture.ok, await recoveredCapture.clone().text()).toBe(true)
    const capture = await recoveredCapture.text()
    expect(capture).toContain('Managed recovery second answer.')
    expect(capture).not.toContain('MANAGED_NATIVE_FIRST')
    const newTraffic = (await model.readTraffic()).filter((row: any) => row.path === '/v1/responses')
    expect(newTraffic.filter((row: any) => row.body.input.filter((item: any) => item.role === 'user').at(-1)?.content?.some((part: any) => part.text?.includes('MANAGED_RECOVERY_SECOND')))).toHaveLength(1)
    expect(newTraffic.every((row: any) => !JSON.stringify(row.body.input).includes('MANAGED_NATIVE_FIRST'))).toBe(true)
    expect((await rig.inventory()).filter(row => row.provider === 'codex' && row.nativeSessionId === recoveredId && row.launchState === 'running')).toHaveLength(1)
    rig.runtime.writeIncident('freshcodex-managed-native-recovery', { userRef: created.sessionId, oldNativeRef: created.sessionRef,
      newNativeRef: recoveredNameRef, beforeCrash, archive: archiveManifestDiagnostics, nativeExit, recoveryAccepted, recovered, recoveryControl, second, capture,
      oldName: await readName(), firstNewName: recoveredName, finalNewName: await readNameFor(recoveredNameRef),
      nativeName: await readNativeName(recoveredId, recoveredNativeContext), recoveredNativeContext, newTraffic })

  }, 360_000)

  it('finalizes the supervisor GDB observer before teardown', async () => {
    if (process.env.FRESHELL_CAPTURE_SUPERVISOR_CRASH !== '1') return
    expect(supervisorCrashDiagnostics).toBeDefined()
    const summary = await supervisorCrashDiagnostics!.finalizeObserver()
    expect(summary).toMatchObject({
      attached: true,
      observerStopped: true,
      observerStopRequested: true,
      exitCode: expect.any(Number),
    })
    expect(rig.runtime.inspectContainer(rig.supervisor.containerId).State?.Running).toBe(true)
  })
})
