import { describe, expect, it, vi } from 'vitest'
import * as owner from '../../../../scripts/testing/runtime-sandbox.js'
import * as external from '../../../../scripts/testing/runtime-external-browser.js'
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runTask2RetainedFixture } from '../../../../scripts/testing/task002-config-legacy-fixtures.js'
import { RustServer } from '../../../e2e-browser/helpers/rust-server.js'
import * as retained from '../../../../scripts/testing/task002-retained-fixture.js'
import { RestrictedDockerBroker } from '../../../../scripts/testing/runtime-test-broker.js'

const { DatabaseSync }: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite')

const handle = {
  runId: 'run-owned', candidateSha: 'a'.repeat(40), soulId: 'soul-owned',
  incarnationId: 'incarnation-owned', containerId: 'b'.repeat(64),
  hostBootId: 'boot-owned', nativeSessionId: 'native-owned',
}

describe('fixed observations of an owned prior enclosure', () => {
  it('distinguishes stopped, running, absent and failed Docker inspection for the exact recorded boot', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-container-state-'))
    const modeFile = path.join(root, 'mode')
    const calls = path.join(root, 'calls.jsonl')
    const docker = path.join(root, 'docker')
    await fsp.writeFile(docker, `#!${process.execPath}\nconst fs=require('node:fs');const mode=fs.readFileSync(${JSON.stringify(modeFile)},'utf8');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(mode==='failed')process.exit(9);if(args[0]==='ps'){if(mode!=='absent')process.stdout.write('${handle.containerId}\\n');if(mode==='ambiguous')process.stdout.write('other-container\\n')}else if(args[0]==='inspect')process.stdout.write(JSON.stringify([{Id:'${handle.containerId}',State:{Running:mode==='malformed'?'unknown':mode==='running'}}]));else process.exit(10)\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') })
    const address = rig.runtimeEnclosureHandle(handle)
    await fsp.writeFile(path.join(root, 'host-state.json'), JSON.stringify({ hostBootId: address.hostBootId }))
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([{ ...address, runtimeDir: root, imageRef: 'owned-image',
      createdAt: new Date().toISOString(), requestDigest: 'd'.repeat(64) }])
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set([address.containerId]))
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    try {
      for (const [mode, expected] of [
        ['stopped', { present: true, running: false }], ['running', { present: true, running: true }], ['absent', { present: false, running: false }],
      ] as const) {
        await fsp.writeFile(modeFile, mode)
        await expect(rig.ownedContainerState(address)).resolves.toEqual(expected)
      }
      await fsp.writeFile(modeFile, 'failed')
      await expect(rig.ownedContainerState(address)).rejects.toThrow(/probe|inspection/)
      await fsp.writeFile(modeFile, 'ambiguous')
      await expect(rig.ownedContainerState(address)).rejects.toThrow(/ambiguous|differs/)
      await fsp.writeFile(modeFile, 'malformed')
      await expect(rig.ownedContainerState(address)).rejects.toThrow()
      const before = await fsp.readFile(calls, 'utf8')
      await expect(rig.ownedContainerState({ ...address, hostBootId: 'foreign' })).rejects.toThrow(/boot|address/)
      await expect(rig.ownedContainerState({ ...address, runId: 'foreign' })).rejects.toThrow(/owned|address/)
      expect(await fsp.readFile(calls, 'utf8')).toBe(before)
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed fresh-agent launch observations', () => {
  it('crashes the matching fresh provider child rather than its adapter PID', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, process.cwd(), 5, {}, {}, 'release', {
      enabledProviders: [], freshAgentModes: ['freshclaude'],
    })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'claude', freshAgentSessionType: 'freshclaude',
      launchState: 'running', intentRevision: 1 }])
    const launch = vi.spyOn(rig, 'freshAgentLaunchFacts').mockResolvedValue({ provider: 'claude', version: '2.1.263', workerPid: 42 })
    const host = vi.spyOn(rig, 'chaosHostFacts').mockResolvedValue({ workerPid: 99, workerLaunchCount: 1, unsafeBrokerAttempts: 0,
      limits: { cpuMax: '200000 100000', memoryMax: '4294967296', swapMax: '0', pidsMax: '512' } })
    const kill = vi.spyOn(rig.runtime, 'killOwnedRuntimePidExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    await rig.crashProviderWorker(current)
    expect(kill).toHaveBeenCalledExactlyOnceWith(current.containerId, 42)
    expect(launch).toHaveBeenCalledExactlyOnceWith(rig.runtimeEnclosureHandle(current))
    expect(host).not.toHaveBeenCalled()
  })
  it.each([
    { mode: 'freshclaude', provider: 'claude', version: '2.1.263', command: 'claude --session owned' },
    { mode: 'kilroy', provider: 'claude', registeredProvider: 'kilroy', version: '2.1.263', command: 'claude --session owned' },
    { mode: 'freshcodex', provider: 'codex', version: '0.147.0', command: 'codex app-server' },
    { mode: 'freshopencode', provider: 'opencode', version: '1.18.21', command: 'opencode serve' },
  ])('observes $mode native-family version/PID without requiring a pre-turn native ID', async ({ mode, provider, registeredProvider = provider, version, command }) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-fresh-launch-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, process.cwd(), 5, {}, {}, 'release', {
      enabledProviders: [], freshAgentModes: [mode],
    })
    const enclosure = rig.runtimeEnclosureHandle(handle)
    const row = { ...enclosure, provider: registeredProvider, freshAgentSessionType: mode, launchState: 'running', intentRevision: 1 }
    const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([row])
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([{ ...enclosure, imageRef: 'owned-image', runtimeDir: root,
      createdAt: new Date().toISOString(), requestDigest: 'd'.repeat(64) }])
    const probe = vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (_container, args) => (
      args[0] === provider ? `${version} (provider)\n` : `1 session-host\n42 ${command}\n`
    ))
    try {
      await expect(rig.freshAgentLaunchFacts(enclosure)).resolves.toEqual({ provider, version, workerPid: 42 })
      expect(probe).toHaveBeenNthCalledWith(1, enclosure.containerId, [provider, '--version'])
      expect(probe).toHaveBeenNthCalledWith(2, enclosure.containerId, ['ps', '-eo', 'pid,args'])
      probe.mockImplementation(async (_container, args) => args[0] === provider ? version : '1 session-host\n')
      await expect(rig.freshAgentLaunchFacts(enclosure)).rejects.toThrow(/provider.*PID/)
      probe.mockClear()
      inventory.mockResolvedValue([{ ...row, provider: registeredProvider === provider ? 'kilroy' : provider }])
      await expect(rig.freshAgentLaunchFacts(enclosure)).rejects.toThrow(/registration/)
      expect(probe).not.toHaveBeenCalled()
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement' }])
      await expect(rig.freshAgentLaunchFacts(enclosure)).rejects.toThrow(/current|enclosure/)
      expect(probe).not.toHaveBeenCalled()
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed owned fresh Codex saved history', () => {
  it('prepares the original large fixture in its owned provider and detects later changes', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-codex-saved-history-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused saved-history web') }, process.cwd(), 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'codex',
      freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 1 }])
    const file = path.join(root, 'retained.jsonl')
    const probe = vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (container, args) => {
      expect(container).toBe(current.containerId)
      if (args[0] === 'cat') return fsp.readFile(file, 'utf8')
      expect(args.slice(0, 3)).toEqual(['node', '--input-type=module', '-e'])
      return execFileSync(process.execPath, [args[1], args[2], args[3], file, args[5]], { encoding: 'utf8' })
    })
    try {
      const prepared = await rig.prepareFreshCodexSavedHistory(current)
      const raw = await fsp.readFile(file, 'utf8')
      const rows = raw.trim().split('\n').map(line => JSON.parse(line))
      expect(prepared.bytes).toBe(Buffer.byteLength(raw))
      expect(prepared.bytes).toBeGreaterThan(1024 * 1024)
      expect(rows).toHaveLength(241)
      expect(rows[0].payload.id).toBe(current.nativeSessionId)
      expect(rows.at(-1).payload.last_agent_message).toBe(`Managed fixture saved answer\n${'x'.repeat(20_000)}`)
      await expect(rig.freshCodexSavedHistoryUnchanged(current)).resolves.toBe(true)
      await fsp.appendFile(file, 'changed\n')
      await expect(rig.freshCodexSavedHistoryUnchanged(current)).resolves.toBe(false)
      Object.assign(rig, { web: { info: { homeDir: root } } })
      await rig.prepareCoincidentFreshCodexHistory(current)
      const coincident = path.join(root, '.codex', 'sessions', `rollout-${current.nativeSessionId}.jsonl`)
      expect(await fsp.readFile(coincident, 'utf8')).toContain('Wrong web-local answer')
      await expect(rig.coincidentFreshCodexHistoryUnchanged(current)).resolves.toBe(true)
      await fsp.appendFile(coincident, 'changed\n')
      await expect(rig.coincidentFreshCodexHistoryUnchanged(current)).resolves.toBe(false)
      const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
        FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
        FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
      const control = external.createExternalRuntimeControl(rig, descriptor)
      const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
        new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
      ))
      await expect(remote.freshCodexSavedHistoryUnchanged(current)).resolves.toBe(false)
      await expect(remote.coincidentFreshCodexHistoryUnchanged(current)).resolves.toBe(false)
      await expect(remote.prepareFreshCodexSavedHistory(current)).resolves.toEqual(prepared)
      await remote.prepareCoincidentFreshCodexHistory(current)
      await expect(remote.freshCodexSavedHistoryUnchanged(current)).resolves.toBe(true)
      await expect(remote.coincidentFreshCodexHistoryUnchanged(current)).resolves.toBe(true)
      probe.mockClear()
      await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha,
        scenarioId: 'browser-managed-runtime', operationId: 'foreign-codex-history-path', action: 'freshcodex-history-prepare',
        handle: current, outputPath: '/foreign/file' })).rejects.toThrow(/operation/)
      expect(probe).not.toHaveBeenCalled()
      inventory.mockResolvedValue([{ ...current, provider: 'codex', freshAgentSessionType: 'freshclaude', launchState: 'running', intentRevision: 1 }])
      probe.mockClear()
      await expect(rig.prepareFreshCodexSavedHistory(current)).rejects.toThrow(/fixture/)
      expect(probe).not.toHaveBeenCalled()
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed fresh Codex controller snapshot facts', () => {
  it('observes the original retained-row predicates without returning history text', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused snapshot web') }, process.cwd(), 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'codex', freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 1 }])
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(17)
    const snapshot = { threadId: current.nativeSessionId, turns: Array.from({ length: 160 }, (_, index) => ({
      turnId: `retained-${Math.floor(index / 2)}:row-${index % 2}`, items: [{ text: index % 2 === 0 ? `Managed prompt ${index / 2}`
        : `${index === 159 ? 'Managed fixture saved answer' : `Managed retained answer ${Math.floor(index / 2)}`}\n${'x'.repeat(20_000)}` }],
    })), extensions: { codex: {} } }
    const admin = vi.spyOn(rig.runtime, 'adminOk').mockResolvedValue({ kind: 'fresh_agent_snapshot', data: snapshot })
    const facts = await rig.freshCodexRetainedSnapshotFacts(current)
    expect(facts).toEqual({ threadId: current.nativeSessionId, bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      turnCount: 160, firstTurnId: 'retained-0:row-0', lastTurnId: 'retained-79:row-1',
      firstAnswerMatches: true, lastAnswerMatches: true, retentionAbsent: true })
    expect(JSON.stringify(facts)).not.toContain('Managed fixture saved answer')
    expect(facts.bytes).toBeGreaterThan(1024 * 1024)
    expect(admin).toHaveBeenCalledExactlyOnceWith(rig.supervisor, { method: 'fresh_agent_read_snapshot',
      params: { soulId: current.soulId, expectedControlEpoch: 17 } })
    const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
      FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
      FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
    const control = external.createExternalRuntimeControl(rig, descriptor)
    const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
      new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
    ))
    await expect(remote.freshCodexRetainedSnapshotFacts(current)).resolves.toEqual(facts)
    const beforeRefusal = admin.mock.calls.length
    await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
      operationId: 'foreign-snapshot-query', action: 'freshcodex-history-snapshot', handle: current, sql: 'SELECT * FROM history' })).rejects.toThrow(/operation/)
    expect(admin.mock.calls).toHaveLength(beforeRefusal)

    snapshot.turns[1].items[0].text = 'changed answer'
    await expect(rig.freshCodexRetainedSnapshotFacts(current)).resolves.toMatchObject({ firstAnswerMatches: false })
    admin.mockResolvedValue({ kind: 'fresh_agent_snapshot', data: { ...snapshot, extensions: { codex: { nativeHistoryRetention: { limit: 1 } } } } })
    await expect(rig.freshCodexRetainedSnapshotFacts(current)).resolves.toMatchObject({ retentionAbsent: false })
    admin.mockResolvedValue({ kind: 'fresh_agent_snapshot', data: { threadId: current.nativeSessionId } })
    await expect(rig.freshCodexRetainedSnapshotFacts(current)).rejects.toThrow()
  })
})

describe('fixed fresh Codex controller startup facts', () => {
  it('reads actual owned lifecycle startup and ready events with the same controller health', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-controller-startup-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused startup web') }, process.cwd(), 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'codex', freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 1 }])
    Object.assign(rig, { supervisor: { runtimeRoot: path.join(root, 'runtime') } })
    const health = vi.spyOn(rig.runtime, 'adminOk').mockResolvedValue({ kind: 'health', data: { control_epoch: 17, installation_id: 'owned-installation' } })
    const startupFinished = { event: 'supervisor.startup_scan.finished', at: 100, data: { scanned: 1, blockedSubsystems: [] } }
    const controllerReady = { event: 'supervisor.ready', at: 101, data: { controlEpoch: 17, installationId: 'owned-installation' } }
    const file = path.join(root, 'evidence', 'lifecycle.jsonl')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, `${JSON.stringify({ event: 'gate.prepare.started', at: new Date().toISOString(), data: {} })}\n${JSON.stringify(startupFinished)}\n${JSON.stringify(controllerReady)}\n`)
    try {
      await expect(rig.freshCodexControllerStartupFacts(current)).resolves.toEqual({ controllerHealth: {
        control_epoch: 17, installation_id: 'owned-installation' }, startupFinished, controllerReady })
      expect(health).toHaveBeenCalledExactlyOnceWith(rig.supervisor, { method: 'health' })
      const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
        FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
        FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
      const control = external.createExternalRuntimeControl(rig, descriptor)
      const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
        new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
      ))
      await expect(remote.freshCodexControllerStartupFacts(current)).resolves.toEqual({ controllerHealth: {
        control_epoch: 17, installation_id: 'owned-installation' }, startupFinished, controllerReady })
      const beforeRefusal = health.mock.calls.length
      await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
        operationId: 'foreign-startup-path', action: 'freshcodex-controller-startup', handle: current, path: '/foreign/lifecycle' })).rejects.toThrow(/operation/)
      expect(health.mock.calls).toHaveLength(beforeRefusal)

      await fsp.appendFile(file, `${JSON.stringify({ ...startupFinished, at: 200, data: { scanned: 2, blockedSubsystems: ['fixture-blocker'] } })}\n`)
      await expect(rig.freshCodexControllerStartupFacts(current)).resolves.toMatchObject({ startupFinished: {
        at: 200, data: { scanned: 2, blockedSubsystems: ['fixture-blocker'] } } })
      await fsp.writeFile(file, `${JSON.stringify(startupFinished)}\n`)
      await expect(rig.freshCodexControllerStartupFacts(current)).rejects.toThrow()
      await fsp.writeFile(file, 'malformed\n')
      await expect(rig.freshCodexControllerStartupFacts(current)).rejects.toThrow()
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed owned session-host process state', () => {
  it('reads the exact tracked host PID and refuses absent or unobserved enclosures', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused host state web') })
    const enclosure = rig.runtimeEnclosureHandle(handle)
    const container = vi.spyOn(rig, 'ownedContainerState').mockResolvedValue({ present: true, running: true })
    const pid = vi.spyOn(rig.runtime, 'ownedContainerHostPidExact').mockReturnValue(process.pid)
    await expect(rig.ownedRuntimeHostState(enclosure)).resolves.toEqual({ pid: process.pid, stopped: false })
    expect(container).toHaveBeenCalledExactlyOnceWith(enclosure)
    expect(pid).toHaveBeenCalledExactlyOnceWith(enclosure.containerId)
    const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
      FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
      FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
    const control = external.createExternalRuntimeControl(rig, descriptor)
    const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
      new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
    ))
    await expect(remote.ownedRuntimeHostState(enclosure)).resolves.toEqual({ pid: process.pid, stopped: false })
    const beforeRefusal = pid.mock.calls.length
    await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
      operationId: 'foreign-host-status-path', action: 'host-process-state', enclosure, pid: 1, path: '/proc/1/status' })).rejects.toThrow(/operation/)
    expect(pid.mock.calls).toHaveLength(beforeRefusal)

    const read = vi.spyOn(fsp, 'readFile')
    try {
      read.mockResolvedValueOnce('Name: fixture-host\nState:\tT (stopped)\n')
      await expect(rig.ownedRuntimeHostState(enclosure)).resolves.toEqual({ pid: process.pid, stopped: true })
      expect(read).toHaveBeenCalledWith(`/proc/${process.pid}/status`, 'utf8')
      container.mockResolvedValue({ present: false, running: false })
      pid.mockClear(); read.mockClear()
      await expect(rig.ownedRuntimeHostState(enclosure)).rejects.toThrow(/running/)
      expect(pid).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      container.mockRejectedValue(new Error('recorded host boot mismatch'))
      await expect(rig.ownedRuntimeHostState(enclosure)).rejects.toThrow(/boot mismatch/)
      expect(pid).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
  })
})

describe('finite Phase 4 browser receipt publication', () => {
  it('writes the existing observation privately on its owner and refuses worker paths or transcript fields', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-phase4-receipt-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused phase4 web') }, process.cwd(), 4)
    const file = path.join(root, 'phase4.json')
    vi.stubEnv('FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT', file)
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const browser = { browserInteraction: true, coldStartAgents: 3, restartCycles: 3, deterministicPlacement: true,
      singleViewPerIntent: true, existingLayoutPreserved: true, focusStable: false,
      expectedFocus: { activeTabId: 'saved-tab', activePaneId: 'saved-pane' },
      focusObservations: [{ stage: 'rehydration', activeTabId: 'other-tab', activePaneId: null }],
      sameSoulIds: true, noBlankSubstitution: true, closeViewKeepsAgent: true,
      closeViewNotRecreatedAfterInventoryRefresh: true, stopAgentStopsRuntime: true, oldClientNoDuplicate: true,
      initialSoulIds: ['soul1', 'soul2', 'soul3'], expectedTabIds: ['tab1', 'tab2', 'tab3'],
      expectedPaneIds: ['pane1', 'pane2', 'pane3'], browserTabId: 'saved-tab', createdTabIds: ['tab1', 'tab2', 'tab3'] }
    try {
      const result = await rig.publishPhase4BrowserReceipt(browser)
      const raw = await fsp.readFile(file, 'utf8')
      expect(JSON.parse(raw)).toEqual({ schemaVersion: 1, status: 'PASS', candidateSha: rig.runtime.candidateSha, browser })
      expect(JSON.parse(raw).browser.focusStable).toBe(false)
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
      const { createHash } = await import('node:crypto')
      expect(result).toEqual({ artifactRef: `phase4-browser:${createHash('sha256').update(raw).digest('hex')}` })
      expect(JSON.stringify(result)).not.toContain(root)
      const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
        FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
        FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
      const control = external.createExternalRuntimeControl(rig, descriptor)
      const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
        new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
      ))
      await expect(remote.publishPhase4BrowserReceipt(browser)).resolves.toEqual(result)
      expect(await fsp.readFile(file, 'utf8')).toBe(raw)
      await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, operationId: 'foreign-phase4-path', scenarioId: 'browser-managed-runtime',
        action: 'phase4-browser-receipt', phase4Browser: browser, outputPath: '/foreign/file' })).rejects.toThrow(/operation/)
      await expect(control({ runId: 'foreign', candidateSha: descriptor.candidateSha, operationId: 'foreign-phase4-run', scenarioId: 'browser-managed-runtime',
        action: 'phase4-browser-receipt', phase4Browser: browser })).rejects.toThrow(/owned run/)
      await expect(rig.publishPhase4BrowserReceipt({ ...browser, transcript: 'private text' })).rejects.toThrow()
      await expect(rig.publishPhase4BrowserReceipt({ ...browser, outputPath: '/foreign/file' })).rejects.toThrow()
      const other = new owner.ManagedRuntimeOwner(() => { throw new Error('unused phase3 web') }, process.cwd(), 3)
      await expect(other.publishPhase4BrowserReceipt(browser)).rejects.toThrow(/Phase 4/)
      expect(await fsp.readFile(file, 'utf8')).toBe(raw)
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('finite Phase 3 approval effect operations', () => {
  it('publishes the existing browser observation on the owner without returning a filesystem path', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-p3-receipt-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, process.cwd(), 3)
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const file = path.join(root, 'browser.json')
    vi.stubEnv('FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT', file)
    const browser: owner.Phase3BrowserObservation = { browserInteraction: true, provider: 'opencode', providerVersion: '1.18.21', model: 'openai/gpt-5.6-luna',
      paneId: 'pane', terminalId: 'terminal', soulId: current.soulId, incarnationIdBefore: 'old-incarnation', incarnationIdAfter: current.incarnationId,
      providerSessionIdBefore: current.nativeSessionId, providerSessionIdAfter: current.nativeSessionId, approvalPromptNativeId: current.nativeSessionId,
      permissionPromptHandled: true, approvalSurvived: true, samePane: true, visibleRecoveryState: true, rejectedInputWhileRecovering: true,
      accidentalApproval: false, toolCompletedExactlyOnce: true, providerHostSurvivedWebRestart: true, followUpCompleted: true,
      followUpResponse: 'P3_FOLLOWUP_OK' }
    try {
      const result = await rig.publishPhase3BrowserReceipt(current, browser)
      expect(result).toEqual({ artifactRef: expect.stringMatching(/^phase3-browser:[a-f0-9]{64}$/) })
      expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, status: 'PASS', candidateSha: current.candidateSha, browser })
      await expect(rig.publishPhase3BrowserReceipt(current, { ...browser, providerSessionIdAfter: 'foreign' })).rejects.toThrow(/address|native/)
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
  it('resets and counts only the existing owned marker file before native identity materializes', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-p3-effect-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, process.cwd(), 3)
    const enclosure = rig.runtimeEnclosureHandle(handle)
    const row = { ...enclosure, provider: 'opencode', nativeSessionId: undefined, launchState: 'running', intentRevision: 1 }
    const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([row])
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([{ ...enclosure, imageRef: 'owned-image', runtimeDir: root,
      createdAt: new Date().toISOString(), requestDigest: 'd'.repeat(64) }])
    const probe = vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (containerId, args) => {
      expect(containerId).toBe(enclosure.containerId)
      return execFileSync(args[0], [...args.slice(1)], { env: { ...process.env, HOME: root }, encoding: 'utf8' })
    })
    try {
      await fsp.writeFile(path.join(root, 'p3-tool-effect-count'), 'old\nold\n')
      await expect(rig.phase3ApprovalEffectCount(enclosure)).resolves.toBe(2)
      await rig.resetPhase3ApprovalEffect(enclosure)
      await expect(rig.phase3ApprovalEffectCount(enclosure)).resolves.toBe(0)
      await fsp.writeFile(path.join(root, 'p3-tool-effect-count'), 'P3_APPROVAL_EFFECT\n')
      await expect(rig.phase3ApprovalEffectCount(enclosure)).resolves.toBe(1)
      probe.mockClear()
      await expect(rig.resetPhase3ApprovalEffect({ ...enclosure, hostBootId: 'foreign' })).rejects.toThrow(/current|enclosure/)
      expect(probe).not.toHaveBeenCalled()
      inventory.mockResolvedValue([{ ...row, provider: 'codex' }])
      await expect(rig.phase3ApprovalEffectCount(enclosure)).rejects.toThrow(/OpenCode/)
      expect(probe).not.toHaveBeenCalled()
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('owner-side synthetic OpenCode source preparation', () => {
  it('returns only a new matching no-tool follow-up ID from the existing private native history', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, process.cwd(), 3)
    vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    try {
      const source = await rig.prepareSyntheticOpenCodeSource()
      const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha, nativeSessionId: source.rootId }
      const marker = `SYNTHETIC_FOLLOWUP_${source.nonce}`
      const turns = [
        { messageId: source.lastMessageId, text: marker, toolCalls: [] },
        { messageId: 'new-tool-turn', text: marker, toolCalls: [{ id: 'tool-call' }] },
        { messageId: 'other-marker-turn', text: 'other synthetic marker', toolCalls: [] },
        { messageId: 'new-matching-turn', text: marker, toolCalls: [] },
      ]
      const probe = vi.spyOn(rig, 'ownedProviderExec').mockResolvedValue(JSON.stringify({ turns }))
      await expect(rig.syntheticOpenCodeFollowUpMessageId(current)).resolves.toBe('new-matching-turn')
      probe.mockResolvedValue(JSON.stringify({ turns: turns.slice(0, 3) }))
      await expect(rig.syntheticOpenCodeFollowUpMessageId(current)).resolves.toBeNull()
    } finally { vi.unstubAllEnvs(); await rig.stop() }
  })

  it('binds the existing authenticated adoption result to the registered source and current native address', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, process.cwd(), 3)
    vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    try {
      const source = await rig.prepareSyntheticOpenCodeSource()
      const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha, nativeSessionId: source.rootId }
      const view = { ...current, terminalId: 'owned-source-terminal', launchState: 'running', intentRevision: 1 }
      vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...view, incarnationId: 'prior-source-incarnation',
        containerId: 'c'.repeat(64), hostBootId: 'prior-source-boot', launchState: 'stopped' }, view])
      const observation = { terminalId: view.terminalId, rootSessionId: source.rootId, tailMessageId: source.lastMessageId,
        evidenceGeneration: 'a'.repeat(64), incarnationId: view.incarnationId, launchNonce: 'owned-launch',
        hydrated: true, messagesRead: 'success' as const }
      const read = vi.spyOn(rig, 'ownedOpenCodeAdoptionStatus').mockResolvedValue({ state: 'observed', data: { observation } })
      await expect(rig.syntheticOpenCodeAdoptionStatus(current)).resolves.toEqual({ state: 'observed', data: { observation } })
      expect(read).toHaveBeenCalledWith(view)
      read.mockResolvedValue({ state: 'observed', data: { observation: { ...observation, rootSessionId: 'foreign-root' } } })
      await expect(rig.syntheticOpenCodeAdoptionStatus(current)).rejects.toThrow(/source|root/)
    } finally { vi.unstubAllEnvs(); await rig.stop() }
  })

  it.each(['history', 'excluded'] as const)('reads actual SQLite %s facts only for the registered source root', async mode => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, process.cwd(), 3)
    const lifecycle = vi.spyOn(rig.runtime, 'recordLifecycle')
    vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    try {
      const source = await rig.prepareSyntheticOpenCodeSource()
      const detail = lifecycle.mock.calls.find(([event]) => event === 'source-fixture.prepared')?.[1]
      const reference = Object.getOwnPropertyDescriptor(detail ?? {}, 'sourceReference')?.value
      if (typeof reference !== 'string') throw new Error('actual source path required')
      const database = path.join(reference, 'web-home', '.local/share/opencode/opencode.db')
      const probe = vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (_container, args) =>
        execFileSync(process.execPath, args.slice(1).map(arg => arg === '/home/freshell/provider/.local/share/opencode/opencode.db' ? database : arg),
          { encoding: 'utf8' }))
      const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha, nativeSessionId: source.rootId }
      const read = (address: owner.ExactRuntimeHandle) => mode === 'history'
        ? rig.syntheticOpenCodeHistoryFacts(address) : rig.syntheticOpenCodeExcludedSentinels(address)
      const facts = await read(current)
      if (mode === 'history') {
        expect(facts).toEqual({ sessions: [source.childId, source.grandchildId, source.rootId].sort(),
          messages: source.baselineMessages, parts: source.baselineParts })
      } else {
        expect(facts).toEqual([...owner.EXCLUDED_SOURCE_SENTINELS].sort())
      }
      probe.mockClear()
      await expect(read({ ...current, nativeSessionId: 'foreign-root' })).rejects.toThrow(/registered.*source|source.*root/)
      expect(probe).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs(); await rig.stop() }
  })

  it('owns source setup and teardown while returning only IDs, digests and observed counts', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, process.cwd(), 3)
    const lifecycle = vi.spyOn(rig.runtime, 'recordLifecycle')
    vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    let sourceRoot: string | undefined
    try {
      const source = await rig.prepareSyntheticOpenCodeSource()
      expect(source.rootMessageCount).toBe(106)
      expect(Object.keys(source.baselineMessages)).toHaveLength(108)
      expect(source).not.toHaveProperty('databasePath')
      expect(source).not.toHaveProperty('selectedSentinel')
      const preparation = lifecycle.mock.calls.find(([event]) => event === 'source-fixture.prepared')
      const reference = Object.getOwnPropertyDescriptor(preparation?.[1] ?? {}, 'sourceReference')?.value
      if (typeof reference !== 'string') throw new Error('actual owned source reference required')
      sourceRoot = reference
      expect(sourceRoot).toMatch(/\.freshell-opencode-resume-/)
      const database = path.join(sourceRoot, 'web-home', '.local/share/opencode/opencode.db')
      const db = new DatabaseSync(database)
      try { db.prepare('DELETE FROM message WHERE id = ?').run(source.lastMessageId) } finally { db.close() }
      expect((await rig.syntheticOpenCodeSourceFacts()).rootMessageCount).toBe(105)
      expect((await rig.prepareSyntheticOpenCodeSource()).rootId).toBe(source.rootId)
      expect((await rig.stop()).ok).toBe(true)
      await expect(fsp.stat(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.unstubAllEnvs()
      await rig.stop()
    }
  })

  it('seeds the actual default conversation graph and keeps unrelated history outside its baselines', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-source-owner-'))
    const databasePath = path.join(root, 'opencode.db')
    try {
      const source = owner.seedManagedOpenCodeSource({ repoRoot: process.cwd(), databasePath,
        workspace: root, nonce: 'owner-source-default' })
      const db = new DatabaseSync(databasePath, { readOnly: true })
      try {
        const count = db.prepare('SELECT COUNT(*) AS count FROM message WHERE session_id = ?')
        expect(count.get(source.rootId)).toEqual({ count: 106 })
        expect(count.get(source.unrelatedId)).toEqual({ count: 1 })
        expect(db.prepare('SELECT parent_id FROM session WHERE id = ?').get(source.childId))
          .toEqual({ parent_id: source.rootId })
        expect(db.prepare('SELECT parent_id FROM session WHERE id = ?').get(source.grandchildId))
          .toEqual({ parent_id: source.childId })
        expect(source.baselineMessages.size).toBe(108)
        expect(source.baselineMessages.has(source.lastMessageId)).toBe(true)
        const unrelated = db.prepare('SELECT id FROM message WHERE session_id = ?').get(source.unrelatedId)
        expect(unrelated).toBeDefined()
        expect(source.baselineMessages.has(String(unrelated?.id))).toBe(false)
      } finally { db.close() }
      const invalidPath = path.join(root, 'invalid.db')
      expect(() => owner.seedManagedOpenCodeSource({ repoRoot: process.cwd(), databasePath: invalidPath,
        workspace: root, nonce: 'invalid', messageCount: 3 })).toThrow('even integer of at least two')
      await expect(fsp.stat(invalidPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('retained fixture owner web injection', () => {
  it('uses the injected owner factory rather than launching its browser fixture dependency', async () => {
    const h = new owner.RuntimeHarness(process.cwd(), undefined, 3)
    const supervisor: owner.SupervisorInstance = { scenarioId: 'task2-config-jsonc', containerId: 'c'.repeat(64),
      controlSocket: path.join(h.testRoot, 'control.sock'), controlSecret: 'owned-unit-secret',
      controlSecretFile: path.join(h.testRoot, 'control-secret'), runtimeRoot: h.testRoot,
      volumeName: 'owned-unit-volume', binaryKind: 'test' }
    vi.spyOn(h, 'startSupervisor').mockResolvedValue(supervisor)
    vi.spyOn(h, 'adminOk').mockResolvedValue({ kind: 'health', data: { controlEpoch: 1 } })
    vi.spyOn(h, 'assert').mockImplementation(() => {})
    const browserStart = vi.spyOn(RustServer.prototype, 'start').mockRejectedValue(new Error('old browser web dependency entered'))
    const factory = vi.fn<owner.RuntimeWebFactory>().mockImplementation(() => { throw new Error('injected owner web entered') })
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    await fsp.mkdir(h.testRoot, { recursive: true, mode: 0o700 })
    try {
      await expect(runTask2RetainedFixture(h, false, undefined, 'jsonc', factory)).rejects.toThrow('injected owner web entered')
      expect(factory).toHaveBeenCalledOnce()
      expect(browserStart).not.toHaveBeenCalled()
    } finally {
      browserStart.mockRestore()
      vi.unstubAllEnvs()
      await fsp.rm(h.testRoot, { recursive: true, force: true })
    }
  })
})

describe('finite retained browser stage protocol (source coverage only)', () => {
  it('requires the exact observed stage before advancing and accepts only the actual soul retry response', async () => {
    const h = new owner.RuntimeHarness(process.cwd(), undefined, 3)
    const info: owner.RuntimeWebInfo = { baseUrl: 'https://owned.example.invalid', wsUrl: 'wss://owned.example.invalid/ws',
      token: 'synthetic-unit-token', port: 443, configDir: h.testRoot, homeDir: h.testRoot, logsDir: h.testRoot,
      debugLogPath: path.join(h.testRoot, 'log'), pid: 1, runtimeRoot: h.repoRoot }
    const web = new RustServer()
    vi.spyOn(web, 'info', 'get').mockReturnValue(info)
    const context: retained.Task2RetainedBrowserContext = { h, web,
      supervisor: { scenarioId: 'owned-stage', containerId: 'b'.repeat(64), controlSocket: path.join(h.testRoot, 'control.sock'),
        controlSecret: 'synthetic-unit-control', controlSecretFile: path.join(h.testRoot, 'secret'), runtimeRoot: h.testRoot,
        volumeName: 'owned-stage-volume', binaryKind: 'test' },
      soulId: 'owned-stage-soul', rootSessionId: 'ses_owned', childSessionId: 'ses_child',
      oldContainerId: 'c'.repeat(64), oldIncarnationId: 'owned-incarnation', providerVolumeName: 'owned-stage-provider',
      configFile: path.join(h.testRoot, 'opencode.json'), preferredTabId: 'owned-tab', preferredPaneId: 'owned-pane', title: 'owned fixture' }
    let advanced = 0
    const session = new retained.RetainedFixtureBrowserSession()
    try {
      await fsp.mkdir(h.testRoot, { recursive: true, mode: 0o700 })
      await fsp.writeFile(context.configFile, '{}', { mode: 0o644 })
      session.start(async hooks => {
        await hooks.observe(context, 'store_blocked')
        advanced++
        const reply = await hooks.retry(context, 'repaired')
        expect(reply.requestId).toBe('actual-ui-request')
        advanced++
      })
      const first = session.status()
      expect(first).toMatchObject({ kind: 'observe', phase: 'store_blocked', sequence: 1 })
      expect(() => session.advance(2)).toThrow(/stage|sequence/)
      expect(advanced).toBe(0)
      session.advance(1)
      await new Promise(resolve => setImmediate(resolve))
      expect(session.status()).toMatchObject({ kind: 'retry', phase: 'repaired', sequence: 2 })
      expect(() => session.captureRetry('foreign-soul', 'actual-ui-request', { view: { soulId: context.soulId }, outcome: 'replaced' })).toThrow(/soul/)
      expect(advanced).toBe(1)
      session.captureRetry(context.soulId, 'actual-ui-request', { view: { soulId: context.soulId }, outcome: 'replaced' })
      await session.settled()
      expect(advanced).toBe(2)
      expect(session.status().kind).toBe('finished')
      const preparing = new retained.RetainedFixtureBrowserSession()
      let release!: () => void
      const setup = new Promise<void>(resolve => { release = resolve })
      preparing.start(async hooks => { await setup; await hooks.observe(context, 'store_blocked') })
      const cancellation = preparing.cancel()
      release()
      try {
        await new Promise(resolve => setImmediate(resolve))
        expect(preparing.status().kind).toBe('failed')
        await cancellation
      } finally {
        const late = preparing.status()
        if (late.kind === 'observe') preparing.advance(late.sequence)
        await cancellation
      }
    } finally {
      await session.cancel()
      await fsp.rm(h.testRoot, { recursive: true, force: true })
    }
  })
})

function fixture() {
  const row = { ...handle, launchState: 'running' }
  const read = vi.fn().mockResolvedValue({
    workerPid: 42, workerLaunchCount: 1,
    limits: { cpuMax: '50000 100000', memoryMax: '268435456', swapMax: '0', pidsMax: '64' },
    unsafeBrokerAttempts: 0,
  })
  const adapter = {
    runId: handle.runId, candidateSha: handle.candidateSha,
    inventory: vi.fn().mockResolvedValue([row]),
    receipts: () => [{ containerId: handle.containerId, soulId: handle.soulId, incarnationId: handle.incarnationId }],
    readHostFacts: read,
  }
  return { adapter, read, row }
}

describe('exact owned runtime facts', () => {
  it('reads only the unique running incarnation when stopped history belongs to the same soul', async () => {
    const { adapter, read, row } = fixture()
    const prior = { ...row, incarnationId: 'prior-incarnation', containerId: 'c'.repeat(64), hostBootId: 'prior-boot', launchState: 'stopped' }
    adapter.inventory.mockResolvedValue([prior, row])
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).resolves.toMatchObject({ workerPid: 42 })
    expect(read).toHaveBeenCalledExactlyOnceWith(handle)
    read.mockClear()
    vi.spyOn(adapter, 'receipts').mockReturnValue([prior, row])
    await expect(owner.readExactRuntimeHostFacts(adapter, { ...handle, incarnationId: prior.incarnationId,
      containerId: prior.containerId, hostBootId: prior.hostBootId })).rejects.toThrow(/current/)
    expect(read).not.toHaveBeenCalled()
  })
  it.each(['launchState', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId'] as const)(
    'identifies the changed %s before reading owner facts', async field => {
    const { adapter, read, row } = fixture()
    row[field] = 'replacement-value'
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toMatchObject({
      runtimeHandleMismatches: [field],
    })
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps absent and duplicate current inventory unknown and unread', async () => {
    const { adapter, read, row } = fixture()
    for (const rows of [[], [row, row]]) {
      adapter.inventory.mockResolvedValue(rows)
      await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toMatchObject({
        runtimeHandleMismatches: ['inventoryMembership'],
      })
    }
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps owner control responsive while cgroup facts are read for the exact native host', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-cgroup-child-'))
    const command = path.join(root, 'docker')
    const limits = { cpuMax: '50000 100000', memoryMax: '268435456', swapMax: '0', pidsMax: '64' }
    await fsp.writeFile(command, `#!${process.execPath}\nsetTimeout(()=>process.stdout.write('${JSON.stringify(limits)}'),150)\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    rig.supervisor = { scenarioId: 'owned-cgroup', containerId: 'd'.repeat(64), controlSocket: path.join(root, 'control.sock'),
      controlSecret: 'synthetic-secret', controlSecretFile: path.join(root, 'secret'), runtimeRoot: root,
      volumeName: 'owned-cgroup-volume', binaryKind: 'test' }
    await fsp.mkdir(path.join(root, current.incarnationId))
    await fsp.writeFile(path.join(root, current.incarnationId, 'host-state.json'), JSON.stringify({
      hostBootId: current.hostBootId, workerPid: 42, workerLaunchCount: 1,
    }))
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([{ ...current, runtimeDir: path.join(root, current.incarnationId), imageRef: 'owned-image',
      createdAt: new Date().toISOString(), requestDigest: 'd'.repeat(64) }])
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set([current.containerId]))
    vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, launchState: 'running', intentRevision: 1 }])
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    let settled = false
    const responsive = new Promise<boolean>(resolve => setTimeout(() => resolve(!settled), 20))
    const probe = rig.chaosHostFacts(current).then(result => { settled = true; return result })
    try {
      try { expect(await responsive).toBe(true) } finally {
        await expect(probe).resolves.toEqual({ workerPid: 42, workerLaunchCount: 1, limits, unsafeBrokerAttempts: 0 })
      }
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
  it('keeps owner control responsive while the fixed supervisor adoption probe runs', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-adoption-child-'))
    const command = path.join(root, 'docker')
    await fsp.writeFile(command, `#!${process.execPath}\nsetTimeout(()=>process.stdout.write(JSON.stringify({state:'awaiting_observation'})),150)\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') })
    rig.supervisor = { scenarioId: 'owned-adoption', containerId: 'd'.repeat(64), controlSocket: path.join(root, 'control.sock'),
      controlSecret: 'synthetic-secret', controlSecretFile: path.join(root, 'secret'), runtimeRoot: root,
      volumeName: 'owned-adoption-volume', binaryKind: 'test' }
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'unused-proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set([rig.supervisor.containerId]))
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    let settled = false
    const response = new Promise<boolean>(resolve => setTimeout(() => resolve(!settled), 20))
    try {
      const probe = rig.ownedOpenCodeAdoptionStatus({ ...handle, terminalId: 'owned-terminal', launchState: 'running', intentRevision: 1 })
        .then(result => { settled = true; return result })
      try { expect(await response).toBe(true) } finally {
        await expect(probe).resolves.toEqual({ state: 'awaiting_observation' })
      }
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
  it('keeps owner control responsive while an actual owned probe child is running', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-probe-child-'))
    const command = path.join(root, 'docker')
    await fsp.writeFile(command, `#!${process.execPath}\nsetTimeout(()=>process.stdout.write(JSON.stringify({requestIds:['actual-probe-result'],resultIds:['actual-probe-result'],replayCount:0})),150)\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'unused-proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set([current.containerId]))
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const challenge = await rig.registerNativeChallenge(current, 'chaos-approval')
      let heartbeat = false
      timer = setTimeout(() => { heartbeat = true }, 20)
      const result = await rig.nativeToolEvidence(current, challenge.challengeId)
      expect(result.requestIds).toEqual(['actual-probe-result'])
      expect(heartbeat).toBe(true)
    } finally {
      clearTimeout(timer)
      vi.unstubAllEnvs()
      await fsp.rm(root, { recursive: true })
    }
  })
  it('settles an in-flight owned probe and verifies its PID is absent during owner cleanup', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-probe-cancel-'))
    const pidFile = path.join(root, 'probe.pid')
    const command = path.join(root, 'docker')
    await fsp.writeFile(command, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') })
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'unused-proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set([handle.containerId]))
    const cleanup = vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig.runtime, 'writeArtifact').mockReturnValue('/owned/cleanup.json')
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    let observedFailure = false
    const probe = rig.ownedProviderExec(handle.containerId, ['node', '--version']).catch(() => { observedFailure = true })
    let pid: number | undefined
    try {
      await vi.waitFor(async () => { pid = Number(await fsp.readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(1) })
      await expect(rig.stop()).resolves.toEqual({ ok: true, errors: [] })
      await probe
      expect(observedFailure).toBe(true)
      await expect(fsp.stat(`/proc/${pid}`)).rejects.toThrow()
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      await rig.stop()
      await probe
      vi.unstubAllEnvs()
      await fsp.rm(root, { recursive: true })
    }
  })
  it('reads challenge IDs from actual SQLite rows while retaining transcript bytes on the owner', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-fixed-native-probe-'))
    const file = path.join(root, 'opencode.db')
    const seed = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
      db.exec('CREATE TABLE session(id TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT)');
      db.prepare('INSERT INTO session VALUES(?)').run('native-owned');
      db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('actual-message','native-owned',1,JSON.stringify({role:'assistant',time:{completed:2},providerID:'synthetic',modelID:'synthetic'}));
      const insert=db.prepare('INSERT INTO part VALUES(?,?,?,?,?)');
      insert.run('actual-text','native-owned','actual-message',1,JSON.stringify({type:'text',text:'P5_CHAOS_FOLLOWUP synthetic owner-only response'}));
      insert.run('actual-tool','native-owned','actual-message',2,JSON.stringify({type:'tool',tool:'bash',state:{status:'completed',input:'p5-chaos-approval-count'}}));db.close();`
    execFileSync(process.execPath, ['--no-warnings', '-e', seed, file])
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (containerId, args) => {
      expect(containerId).toBe(current.containerId)
      expect(args[0]).toBe('node')
      expect(args[4]).toBe('/home/freshell/provider/.local/share/opencode/opencode.db')
      const nodeArgs = args.slice(1)
      nodeArgs[3] = file
      return execFileSync(process.execPath, nodeArgs, { encoding: 'utf8' })
    })
    try {
      const approval = await rig.registerNativeChallenge(current, 'chaos-approval')
      const followUp = await rig.registerNativeChallenge(current, 'chaos-follow-up')
      expect(await rig.nativeToolEvidence(current, approval.challengeId)).toEqual({ requestIds: ['actual-tool'], resultIds: ['actual-tool'], replayCount: 0 })
      const ids = await rig.nativeFollowUpMessageIds(current, followUp.challengeId)
      expect(ids).toEqual(['actual-message'])
      expect(JSON.stringify(ids)).not.toContain('synthetic owner-only response')
      await expect(rig.nativeFollowUpMessageIds({ ...current, nativeSessionId: 'foreign-root' }, followUp.challengeId)).rejects.toThrow(/challenge/)
    } finally {
      await fsp.rm(root, { recursive: true })
    }
  })
  it('reads fixed facts only for the current exact owned runtime', async () => {
    const { adapter, read } = fixture()
    const value = await owner.readExactRuntimeHostFacts(adapter, handle)
    expect(value.workerPid).toBe(42)
    expect(value.workerLaunchCount).toBe(1)
    expect(value.limits.swapMax).toBe('0')
    expect(read).toHaveBeenCalledExactlyOnceWith(handle)
  })

  it.each([
    { runId: 'another-run' }, { candidateSha: 'c'.repeat(40) },
    { soulId: 'another-soul' }, { incarnationId: 'old-incarnation' },
    { containerId: 'b'.repeat(12) }, { containerId: 'c'.repeat(64) },
    { hostBootId: 'old-boot' }, { nativeSessionId: 'another-root' },
  ])('refuses a mismatched handle %j before any owner read', async (changed) => {
    const { adapter, read } = fixture()
    await expect(owner.readExactRuntimeHostFacts(adapter, { ...handle, ...changed })).rejects.toThrow(/exact|owned|current/)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses a replaced current incarnation before reading retained evidence', async () => {
    const { adapter, read, row } = fixture()
    row.incarnationId = 'replacement'
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toThrow(/current/)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses an inventory identity without a broker ownership receipt', async () => {
    const { adapter, read } = fixture()
    adapter.receipts = () => []
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toThrow(/owned/)
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    { workerPid: 0 }, { workerLaunchCount: -1 }, { unsafeBrokerAttempts: NaN },
    { limits: { cpuMax: '50000 100000', memoryMax: 'truncated', swapMax: '0', pidsMax: '64' } },
  ])('refuses malformed observed owner facts %j', async (changed) => {
    const { adapter, read } = fixture()
    read.mockResolvedValue({ ...await read(), ...changed })
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toThrow(/facts/)
  })
})

describe('registered fresh fixture state decoder', () => {
  it('returns actual native state without treating the requested root as evidence', () => {
    expect(owner.decodeFixtureNativeState({
      nativeSessionId: 'native-actual', pendingDecisionId: null, dispatchCount: 2, completionCount: 1,
    }, 'native-actual')).toEqual({ nativeSessionId: 'native-actual', pendingDecisionId: null, dispatchCount: 2, completionCount: 1 })
  })
  it.each([
    { nativeSessionId: 'wrong-root' }, { pendingDecisionId: 5 },
    { pendingDecisionId: '' }, { dispatchCount: 1.5 }, { completionCount: -1 },
  ])('rejects wrong-root or truncated native fixture observations %j', (changed) => {
    expect(() => owner.decodeFixtureNativeState({
      nativeSessionId: 'native-actual', pendingDecisionId: null, dispatchCount: 2, completionCount: 1, ...changed,
    }, 'native-actual')).toThrow(/fixture/)
  })
})

describe('owned rig cleanup settlement', () => {
  it('attempts every held host release, web stop and runtime cleanup after a release failure', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') })
    const first = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    const second = { ...first, soulId: 'second-owned-soul', incarnationId: 'second-owned-incarnation', containerId: 'd'.repeat(64) }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    const signal = vi.spyOn(rig, 'signalOwnedSessionHostExact').mockImplementation((_container, incarnation, signal) => {
      if (signal === 'SIGCONT' && incarnation === first.incarnationId) throw new Error('owned release failed')
      return incarnation === first.incarnationId ? 1234 : 1235
    })
    const web = new RustServer()
    rig.web = web
    const stopWeb = vi.spyOn(web, 'stop').mockResolvedValue(undefined)
    const cleanup = vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig.runtime, 'writeArtifact').mockReturnValue('/owned/cleanup.json')
    await rig.holdRuntimeHost(first)
    await rig.holdRuntimeHost(second)
    const result = await rig.stop()
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/held|release/)
    expect(signal).toHaveBeenCalledWith(first.containerId, first.incarnationId, 'SIGCONT', 1234)
    expect(signal).toHaveBeenCalledWith(second.containerId, second.incarnationId, 'SIGCONT', 1235)
    expect(stopWeb).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })
  it('retains web stop failure and still cleans its runtime resources', async () => {
    const stopWeb = vi.fn().mockRejectedValue(new Error('owned web did not stop'))
    const cleanupRuntime = vi.fn().mockResolvedValue({ ok: true, errors: [] })
    await expect(owner.settleOwnedRuntimeCleanup(stopWeb, cleanupRuntime)).resolves.toEqual({
      ok: false, errors: ['web stop: owned web did not stop'],
    })
    expect(stopWeb).toHaveBeenCalledOnce()
    expect(cleanupRuntime).toHaveBeenCalledOnce()
  })
  it('retains every observed runtime cleanup failure', async () => {
    const stopWeb = vi.fn().mockResolvedValue(undefined)
    const cleanupRuntime = vi.fn().mockResolvedValue({ ok: false, errors: ['owned host remains', 'owned volume remains'] })
    await expect(owner.settleOwnedRuntimeCleanup(stopWeb, cleanupRuntime)).resolves.toEqual({
      ok: false, errors: ['owned host remains', 'owned volume remains'],
    })
  })
  it('settles a rejected runtime cleanup as a failure', async () => {
    await expect(owner.settleOwnedRuntimeCleanup(async () => {}, async () => { throw new Error('owner cleanup failed') }))
      .resolves.toEqual({ ok: false, errors: ['runtime cleanup: owner cleanup failed'] })
  })
  it('settles actual owner cleanup rejection even when runtime produced no cleanup artifact', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') })
    vi.spyOn(rig.runtime, 'cleanup').mockRejectedValue(new Error('owned cleanup rejected'))
    const write = vi.spyOn(rig.runtime, 'writeArtifact').mockReturnValue('/owned/cleanup.json')
    await expect(rig.stop()).resolves.toEqual({ ok: false, errors: ['runtime cleanup: owned cleanup rejected'] })
    expect(write).toHaveBeenCalledWith('cleanup.json', expect.objectContaining({ ok: false }))
  })
  it('settles repeated successful owner finish once', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') })
    const cleanup = vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig.runtime, 'writeArtifact').mockReturnValue('/owned/cleanup.json')
    await expect(rig.stop()).resolves.toEqual({ ok: true, errors: [] })
    await expect(rig.stop()).resolves.toEqual({ ok: true, errors: [] })
    expect(cleanup).toHaveBeenCalledOnce()
  })
})

describe('run-scoped owner operation settlement', () => {
  it('serializes owner mutations and settles a timed-out duplicate operation only once', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const actions: string[] = []
    const perform = vi.fn(async (request: { action: string }) => {
      actions.push(request.action)
      if (request.action === 'replace-web') await blocked
      return { action: request.action }
    })
    const queue = new owner.RuntimeOwnerOperationQueue(handle.runId, handle.candidateSha, 'fixture-owned', perform)
    const first = queue.perform({ runId: handle.runId, candidateSha: handle.candidateSha, scenarioId: 'fixture-owned', operationId: 'operation-one', action: 'replace-web' })
    const duplicate = queue.perform({ runId: handle.runId, candidateSha: handle.candidateSha, scenarioId: 'fixture-owned', operationId: 'operation-one', action: 'replace-web' })
    const next = queue.perform({ runId: handle.runId, candidateSha: handle.candidateSha, scenarioId: 'fixture-owned', operationId: 'operation-two', action: 'replace-supervisor' })
    await Promise.resolve()
    expect(actions).toEqual(['replace-web'])
    release()
    await expect(first).resolves.toEqual({ action: 'replace-web' })
    await expect(duplicate).resolves.toEqual({ action: 'replace-web' })
    await expect(next).resolves.toEqual({ action: 'replace-supervisor' })
    expect(perform).toHaveBeenCalledTimes(2)
  })

  it.each([{ runId: 'other-run' }, { candidateSha: 'c'.repeat(40) }, { scenarioId: 'other-fixture' }, { action: 'exec' }])(
    'refuses an unowned or unsupported owner request %j', async (changed) => {
      const perform = vi.fn().mockResolvedValue({})
      const queue = new owner.RuntimeOwnerOperationQueue(handle.runId, handle.candidateSha, 'fixture-owned', perform)
      await expect(queue.perform({ runId: handle.runId, candidateSha: handle.candidateSha,
        scenarioId: 'fixture-owned', operationId: 'operation-one', action: 'inventory', ...changed,
      })).rejects.toThrow(/owned|operation/)
      expect(perform).not.toHaveBeenCalled()
    },
  )

  it('refuses reuse of an operation ID for a different mutation', async () => {
    const perform = vi.fn().mockResolvedValue({})
    const queue = new owner.RuntimeOwnerOperationQueue(handle.runId, handle.candidateSha, 'fixture-owned', perform)
    const request = { runId: handle.runId, candidateSha: handle.candidateSha,
      scenarioId: 'fixture-owned', operationId: 'operation-one', action: 'replace-web' }
    await queue.perform(request)
    await expect(queue.perform({ ...request, action: 'replace-supervisor' })).rejects.toThrow(/operation/)
    expect(perform).toHaveBeenCalledOnce()
  })
})

describe('current handle admission before owner mutation', () => {
  function rigFixture() {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('web is not used by this unit') }, process.cwd(), 3, {}, {}, 'test', {
      enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'],
    })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    const row = { ...current, launchState: 'running', intentRevision: 1, provider: 'codex', freshAgentSessionType: 'freshcodex' }
    vi.spyOn(rig, 'inventory').mockResolvedValue([row])
    Object.defineProperty(rig.runtime, 'broker', { value: { receipts: () => [{ ...current, providerVolumeName: 'volume-owned' }] } })
    const kill = vi.spyOn(rig.runtime, 'killOwnedRuntimeExact').mockImplementation(() => {})
    return { rig, current, row, kill }
  }
  it('crashes only the current receipt-owned host', async () => {
    const { rig, current, kill } = rigFixture()
    await rig.crashRuntimeHost(current)
    expect(kill).toHaveBeenCalledExactlyOnceWith(current.containerId)
  })
  it('keeps stopped history out of current address and fixture-registration selection', async () => {
    const { rig, current, row } = rigFixture()
    const prior = { ...row, incarnationId: 'prior-incarnation', containerId: 'c'.repeat(64), hostBootId: 'prior-boot',
      launchState: 'stopped', freshAgentSessionType: 'freshclaude', provider: 'claude' }
    vi.spyOn(rig, 'inventory').mockResolvedValue([prior, row])
    await expect(rig.providerVolumeFacts(current)).resolves.toEqual({ providerVolumeName: 'volume-owned' })
    const state = { nativeSessionId: current.nativeSessionId, pendingDecisionId: 'pending-owned', dispatchCount: 2, completionCount: 1 }
    const read = vi.spyOn(rig.runtime, 'fixtureNativeState').mockResolvedValue(state)
    await expect(rig.fixtureNativeState(current)).resolves.toEqual(state)
    expect(read).toHaveBeenCalledExactlyOnceWith(rig.supervisor, current)
  })
  it('refuses stale incarnation and boot before signalling a host', async () => {
    const { rig, current, row, kill } = rigFixture()
    row.hostBootId = 'replacement-boot'
    await expect(rig.crashRuntimeHost(current)).rejects.toThrow(/current/)
    expect(kill).not.toHaveBeenCalled()
  })
  it('refuses an ambiguous inventory even when the second row lacks native identity', async () => {
    const { rig, current, row, kill } = rigFixture()
    vi.mocked(rig.inventory).mockResolvedValue([row, { soulId: row.soulId, incarnationId: 'ambiguous', launchState: 'starting', intentRevision: 2 }])
    await expect(rig.crashRuntimeHost(current)).rejects.toThrow(/ambiguous|current/)
    expect(kill).not.toHaveBeenCalled()
  })
  it('returns provider-volume facts only for the exact current owner', async () => {
    const { rig, current } = rigFixture()
    await expect(rig.providerVolumeFacts(current)).resolves.toEqual({ providerVolumeName: 'volume-owned' })
    await expect(rig.providerVolumeFacts({ ...current, nativeSessionId: 'foreign-root' })).rejects.toThrow(/current/)
  })
  it('queries only the exact writer incarnation while retaining its stopped zero-claim observation', async () => {
    const { rig, current, row } = rigFixture()
    const prior = { ...row, incarnationId: 'prior-incarnation', containerId: 'c'.repeat(64), hostBootId: 'prior-boot',
      launchState: 'stopped', provider: 'claude' }
    const inventory = vi.mocked(rig.inventory).mockResolvedValue([prior, row])
    const facts = { provider: row.provider, providerStoreId: 'owned-store', nativeSessionId: current.nativeSessionId,
      soulId: current.soulId, incarnationId: current.incarnationId, activeClaimCount: 1, globalConflictingClaimCount: 0 }
    const claim = vi.spyOn(rig, 'qualificationWriterClaim').mockResolvedValue(facts)
    await expect(rig.writerClaimFacts(current)).resolves.toEqual(facts)
    expect(claim).toHaveBeenCalledExactlyOnceWith({ provider: row.provider, nativeSessionId: current.nativeSessionId,
      soulId: current.soulId, incarnationId: current.incarnationId })
    row.launchState = 'stopped'
    claim.mockResolvedValue({ ...facts, activeClaimCount: 0 })
    await expect(rig.writerClaimFacts(current)).resolves.toMatchObject({ activeClaimCount: 0 })
    claim.mockClear()
    for (const changed of [{ hostBootId: 'foreign-boot' }, { nativeSessionId: 'foreign-root' },
      { runId: 'foreign-run' }, { candidateSha: 'f'.repeat(40) }]) {
      await expect(rig.writerClaimFacts({ ...current, ...changed })).rejects.toThrow(/writer|owned|root/)
    }
    expect(claim).not.toHaveBeenCalled()
    inventory.mockResolvedValue([prior, row, row])
    await expect(rig.writerClaimFacts(current)).rejects.toThrow(/writer|current/)
    expect(claim).not.toHaveBeenCalled()
  })
  it('observes and crashes the registered fixture worker using owner-derived PID only', async () => {
    const { rig, current } = rigFixture()
    const read = vi.spyOn(rig.runtime, 'execOwnedContainerExact').mockReturnValue('PID COMMAND\n42 node fresh-agent-fixture-worker.mjs --provider codex\n')
    const kill = vi.spyOn(rig.runtime, 'killOwnedRuntimePidExact').mockImplementation(() => {})
    await expect(rig.fixtureWorkerFacts(current)).resolves.toEqual({ provider: 'codex', workerPid: 42 })
    await rig.crashFixtureWorker(current)
    expect(read).toHaveBeenCalledWith(current.containerId, ['ps', '-eo', 'pid,args'])
    expect(kill).toHaveBeenCalledExactlyOnceWith(current.containerId, 42)
  })
  it('refuses ambiguous workers and non-fixture registrations before signalling', async () => {
    const { rig, current, row } = rigFixture()
    vi.spyOn(rig.runtime, 'execOwnedContainerExact').mockReturnValue('42 node fresh-agent-fixture-worker --provider codex\n43 node fresh-agent-fixture-worker --provider codex\n')
    const kill = vi.spyOn(rig.runtime, 'killOwnedRuntimePidExact').mockImplementation(() => {})
    await expect(rig.crashFixtureWorker(current)).rejects.toThrow(/fixture/)
    row.freshAgentSessionType = 'unregistered-mode'
    await expect(rig.crashFixtureWorker(current)).rejects.toThrow(/fixture/)
    expect(kill).not.toHaveBeenCalled()
  })
  it('allows only the actually pending deterministic fixture decision', async () => {
    const { rig, current } = rigFixture()
    vi.spyOn(rig, 'fixtureNativeState').mockResolvedValue({ nativeSessionId: current.nativeSessionId,
      pendingDecisionId: 'pending-owned', dispatchCount: 2, completionCount: 1 })
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(2)
    const admin = vi.spyOn(rig.runtime, 'adminOk').mockResolvedValue({ kind: 'ack' })
    await expect(rig.allowFixtureDecision(current, 'foreign-decision')).rejects.toThrow(/pending/)
    expect(admin).not.toHaveBeenCalled()
    await rig.allowFixtureDecision(current, 'pending-owned')
    expect(admin).toHaveBeenCalledExactlyOnceWith(rig.supervisor,
      rig.runtime.freshAgentResolveBody(current.soulId, 'pending-owned', { behavior: 'allow' }, 2))
  })
})

describe('run-owned workload image build', () => {
  it('builds and resolves only the exact run tag instead of the shared runtime tag', () => {
    const runId = '7aab49a4-08ed-4ca7-a4b2-6501f4821a63'
    const child = vi.fn<typeof execFileSync>().mockReturnValue(`sha256:${'c'.repeat(64)}\n`)
    const result = owner.buildRunOwnedRuntimeImage(process.cwd(), runId, handle.candidateSha, child)
    expect(result.digest).toBe(`sha256:${'c'.repeat(64)}`)
    expect(result.tag).toContain(runId)
    expect(child).toHaveBeenNthCalledWith(1, 'docker', expect.arrayContaining(['build', '-t', result.tag]), expect.objectContaining({ cwd: process.cwd() }))
    expect(child).toHaveBeenNthCalledWith(2, 'docker', ['image', 'inspect', result.tag, '--format', '{{.Id}}'], expect.objectContaining({ encoding: 'utf8' }))
    expect(child.mock.calls.flatMap(call => call[1] ?? [])).not.toContain(owner.PHASE2_RUNTIME_IMAGE_TAG)
  })
  it('refuses an invalid observed image digest instead of certifying a tag as an artifact', () => {
    const child = vi.fn<typeof execFileSync>().mockReturnValue('not-a-digest')
    expect(() => owner.buildRunOwnedRuntimeImage(process.cwd(), '7aab49a4-08ed-4ca7-a4b2-6501f4821a63', handle.candidateSha, child)).toThrow(/pinned|digest/)
  })
  it('admits image deletion only for the actual run tag, labels and immutable digest', () => {
    const context = { tag: 'freshell-managed-runtime:owned-test', runId: handle.runId,
      candidateSha: handle.candidateSha, digest: `sha256:${'c'.repeat(64)}` }
    const image = { Id: context.digest, RepoTags: [context.tag], Config: { Labels: {
      'com.freshell.runtime-test-run-id': context.runId,
      'com.freshell.runtime-test-candidate': context.candidateSha,
    } } }
    expect(() => owner.assertRunOwnedRuntimeImage([image], context)).not.toThrow()
    expect(() => owner.assertRunOwnedRuntimeImage([{ ...image, Id: `sha256:${'d'.repeat(64)}` }], context)).toThrow(/owned/)
    expect(() => owner.assertRunOwnedRuntimeImage([{ ...image, RepoTags: ['foreign-image:tag'] }], context)).toThrow(/owned/)
    expect(() => owner.assertRunOwnedRuntimeImage([{ ...image, Config: { Labels: {} } }], context)).toThrow(/owned/)
  })
  it('removes only a verified owned tag and verifies its absence, retaining unrelated images', () => {
    const context = { tag: 'freshell-managed-runtime:owned-test', runId: handle.runId,
      candidateSha: handle.candidateSha, digest: `sha256:${'c'.repeat(64)}` }
    const image = { Id: context.digest, RepoTags: [context.tag], Config: { Labels: {
      'com.freshell.runtime-test-run-id': context.runId,
      'com.freshell.runtime-test-candidate': context.candidateSha,
    } } }
    let removed = false
    const execute = vi.fn<typeof execFileSync>().mockImplementation((_command, args) => {
      if (args?.[1] === 'ls') return `${removed ? '' : `${context.tag}\n`}unrelated-image:tag\n`
      if (args?.[1] === 'inspect') return JSON.stringify([image])
      if (args?.[1] === 'rm') { removed = true; return '' }
      throw new Error('unexpected image operation')
    })
    expect(() => owner.removeRunOwnedRuntimeImage(context, execute)).not.toThrow()
    expect(execute).toHaveBeenCalledWith('docker', ['image', 'rm', context.tag], expect.anything())
    expect(execute.mock.calls.some(call => call[1]?.includes('unrelated-image:tag'))).toBe(false)
    removed = false
    const retained = vi.fn<typeof execFileSync>().mockImplementation((_command, args) =>
      args?.[1] === 'inspect' ? JSON.stringify([image]) : `${context.tag}\n`)
    expect(() => owner.removeRunOwnedRuntimeImage(context, retained)).toThrow(/remains/)
    const foreign = vi.fn<typeof execFileSync>().mockImplementation((_command, args) =>
      args?.[1] === 'inspect' ? JSON.stringify([{ ...image, Config: { Labels: {} } }]) : `${context.tag}\n`)
    expect(() => owner.removeRunOwnedRuntimeImage(context, foreign)).toThrow(/owned/)
    expect(foreign.mock.calls.some(call => call[1]?.[1] === 'rm')).toBe(false)
  })
})

describe('external owner provider-root isolation', () => {
  it('keeps operator homes out of the owner registration while preserving existing local root discovery', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-root-admission-'))
    try {
      await fsp.mkdir(path.join(home, '.codex'))
      await fsp.mkdir(path.join(home, '.config/opencode'), { recursive: true })
      expect(owner.runtimeProviderUserRoots(true, home)).toEqual([])
      expect(owner.runtimeProviderUserRoots(false, home)).toEqual([
        path.join(home, '.codex'), path.join(home, '.config/opencode'),
      ])
    } finally { await fsp.rm(home, { recursive: true }) }
  })
})

describe('actual owned runtime cleanup observations', () => {
  const expected = { containerIds: ['b'.repeat(64)], volumes: ['owned-volume'] }
  it('requires exact owned containers and volumes absent while retaining unrelated resources', () => {
    expect(() => owner.verifyRuntimeCleanupAbsence(expected, { containerIds: ['c'.repeat(64)], volumes: ['unrelated-volume'] })).not.toThrow()
    expect(() => owner.verifyRuntimeCleanupAbsence(expected, { containerIds: expected.containerIds, volumes: [] })).toThrow(/remains/)
    expect(() => owner.verifyRuntimeCleanupAbsence(expected, { containerIds: [], volumes: expected.volumes })).toThrow(/remains/)
  })
  it('refuses unread, partial or malformed resource observations as cleanup proof', () => {
    expect(() => owner.verifyRuntimeCleanupAbsence(expected, {})).toThrow(/observation/)
    expect(() => owner.verifyRuntimeCleanupAbsence(expected, { containerIds: ['b'.repeat(12)], volumes: [] })).toThrow(/observation/)
  })
  it('retains helper-name absence as required evidence when create acknowledgement was lost', () => {
    const helperNames = ['freshell-history-11111111-1111-4111-8111-111111111111']
    expect(() => owner.verifyRuntimeCleanupAbsence({ ...expected, helperNames }, { containerIds: [], volumes: [] })).toThrow(/observation/)
    expect(() => owner.verifyRuntimeCleanupAbsence({ ...expected, helperNames }, { containerIds: [], volumes: [], containerNames: helperNames })).toThrow(/remains/)
    expect(() => owner.verifyRuntimeCleanupAbsence({ ...expected, helperNames }, { containerIds: [], volumes: [], containerNames: ['unrelated-helper'] })).not.toThrow()
  })
})
