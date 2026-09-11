import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  assertProviderResults,
  type ProviderQualificationRow,
} from '../../../scripts/testing/provider-test-results.js'
import { RuntimeHarness, type SupervisorInstance } from '../../../scripts/testing/runtime-sandbox.js'
import { RustServer } from './rust-server.js'
import type { TestServerInfo } from './test-server.js'
import {
  assertFreshAgentResults,
  type FreshAgentQualificationRow,
} from '../../../scripts/testing/fresh-agent-test-results.js'

export const P2_OPENCODE_VERSION = '1.18.21'
export const P2_OPENCODE_FREE_MODEL = 'opencode/big-pickle'

export type ManagedRuntimeView = {
  soulId: string
  incarnationId: string
  launchState: string
  cleanupState?: string
  intentRevision: number
  executionGeneration?: number
  effectiveLimits?: {
    cpuMilli: number
    memoryBytes: number
    swapBytes: number
    pidsMax: number
  }
  desiredState?: string
  recoveryState?: string
  durabilityState?: string
  allocationState?: string
  containerId?: string
  hostBootId?: string
  terminalId?: string
  terminalStreamId?: string
  terminalMode?: string
  terminalCwd?: string
  terminalCreateRequestId?: string
  terminalResumeSessionId?: string
  freshAgentSessionId?: string
  freshAgentSessionType?: string
  freshAgentRuntimeVariant?: string
  projectKey?: string
  profile?: string
  provider?: string
  nativeSessionId?: string
  recoveryReason?: string
  priorIncarnationId?: string
  recoveryAttemptId?: string
  evidenceRevision?: number
  successfulRecoveriesInWindow?: number
}

/**
 * Owned managed-runtime browser rig: restricted Docker broker + supervisor +
 * a feature-enabled Rust web server. Web restart methods touch only the web
 * process; dynamic session-host containers are outside its process tree and
 * remain owned by the supervisor/harness receipts.
 */
export class ManagedRuntimeBrowserRig {
  readonly repoRoot: string
  readonly runtime: RuntimeHarness
  supervisor!: SupervisorInstance
  web!: RustServer
  info!: TestServerInfo
  private serverBin = ''
  private readonly serverEnv: Record<string, string>
  private readonly supervisorEnv: Record<string, string>
  private readonly supervisorBinaryKind: 'test' | 'release'
  private readonly enabledProviders: string[]
  private readonly providerSettings: Record<string, Record<string, unknown>>
  private readonly freshAgentModes: string[]
  private readonly fixtureFreshAgentModes: string[]

  constructor(
    repoRoot = process.cwd(),
    phase: 2 | 3 | 4 | 5 = 2,
    serverEnv: Record<string, string> = {},
    supervisorEnv: Record<string, string> = {},
    supervisorBinaryKind: 'test' | 'release' = 'test',
    qualificationProviders: {
      enabledProviders: string[]
      providerSettings?: Record<string, Record<string, unknown>>
      freshAgentModes?: string[]
      fixtureFreshAgentModes?: string[]
    } = { enabledProviders: ['opencode'] },
  ) {
    this.repoRoot = fs.realpathSync(repoRoot)
    this.runtime = new RuntimeHarness(this.repoRoot, undefined, phase)
    this.serverEnv = { ...serverEnv }
    this.supervisorEnv = { ...supervisorEnv }
    this.supervisorBinaryKind = supervisorBinaryKind
    this.enabledProviders = [...qualificationProviders.enabledProviders]
    this.providerSettings = { ...qualificationProviders.providerSettings }
    this.freshAgentModes = [...(qualificationProviders.freshAgentModes ?? [])]
    this.fixtureFreshAgentModes = [...(qualificationProviders.fixtureFreshAgentModes ?? [])]
    if (this.fixtureFreshAgentModes.length > 0 && supervisorBinaryKind !== 'test') {
      throw new Error('deterministic fresh-agent fixtures require the test session-host build')
    }
  }

  async start(): Promise<TestServerInfo> {
    await this.runtime.prepare()
    this.serverBin = this.buildManagedServer()
    this.runtime.recordBrowserBuild({
      kind: this.fixtureFreshAgentModes.length ? 'deterministic_fixture'
        : this.supervisorBinaryKind === 'test' ? 'test_faults' : 'production',
      serverFeatures: [this.fixtureFreshAgentModes.length ? 'managed-fresh-agent-fixtures' : 'managed-runtime-v1'],
      supervisorFeatures: this.supervisorBinaryKind === 'test' ? ['runtime-test-faults'] : [],
      serverBinary: this.serverBin,
      supervisorBinary: (this.supervisorBinaryKind === 'test'
          ? this.runtime.testSupervisorBinary
          : this.runtime.releaseSupervisorBinary),
    })
    if (this.freshAgentModes.length > 0) {
      const supervisorBinary = (this.supervisorBinaryKind === 'test'
          ? this.runtime.testSupervisorBinary
          : this.runtime.releaseSupervisorBinary)
      this.runtime.recordFreshAgentBuild({
        kind: this.fixtureFreshAgentModes.length > 0 ? 'deterministic_fixture' : 'production',
        serverFeatures: [this.fixtureFreshAgentModes.length > 0
          ? 'managed-fresh-agent-fixtures'
          : 'managed-runtime-v1'],
        sessionHostFeatures: this.supervisorBinaryKind === 'test' ? ['fresh-agent-fixtures'] : [],
        selectedModes: this.freshAgentModes,
        fixtureModes: this.fixtureFreshAgentModes,
        serverBinary: this.serverBin,
        supervisorBinary,
        sessionHostBinary: this.supervisorBinaryKind === 'test'
          ? this.runtime.testHostBinary
          : this.runtime.releaseHostBinary,
      })
    }
    this.supervisor = await this.runtime.startSupervisor({
      scenarioId: 'browser-managed-runtime',
      binaryKind: this.supervisorBinaryKind,
      env: { ...this.supervisorEnv, ...this.managedEnvironment() },
    })
    this.web = new RustServer({
      preserveHomeOnStop: true,
      env: {
        FRESHELL_MANAGED_RUNTIME_V1: '1',
        ...(this.freshAgentModes.length > 0
          ? { FRESHELL_MANAGED_FRESH_AGENT_V1: '1' }
          : {}),
        ...(this.fixtureFreshAgentModes.length > 0
          ? { FRESHELL_MANAGED_FRESH_AGENT_FIXTURE_MODES: this.fixtureFreshAgentModes.join(',') }
          : {}),
        FRESHELL_RUNTIME_CONTROL_SOCKET: this.supervisor.controlSocket,
        FRESHELL_RUNTIME_CONTROL_SECRET_FILE: this.supervisor.controlSecretFile,
        ...this.serverEnv,
        ...this.managedEnvironment(),
      },
      setupHome: async (homeDir) => {
        const freshell = path.join(homeDir, '.freshell')
        await fsp.mkdir(freshell, { recursive: true })
        await fsp.writeFile(path.join(freshell, 'config.json'), JSON.stringify({
          version: 1,
          settings: {
            defaultCwd: this.repoRoot,
            codingCli: {
              enabledProviders: this.enabledProviders,
              providers: {
                ...(this.enabledProviders.includes('opencode')
                  ? { opencode: { model: P2_OPENCODE_FREE_MODEL } }
                  : {}),
                ...this.providerSettings,
              },
            },
            ...(this.freshAgentModes.length > 0
              ? {
                  freshAgent: {
                    enabled: true,
                    providers: this.providerSettings,
                  },
                }
              : {}),
          },
        }, null, 2))
      },
    })
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = this.serverBin
    try {
      this.info = await this.web.start()
    } finally {
      if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous
    }
    return this.info
  }

  async restartWebGracefully(): Promise<TestServerInfo> {
    return this.withManagedBin(() => this.web.restart())
  }

  async restartWeb(): Promise<TestServerInfo> {
    return this.restartWebGracefully()
  }

  async crashAndRestartWeb(): Promise<TestServerInfo> {
    return this.withManagedBin(() => this.web.restartAbrupt())
  }

  async crashWeb(): Promise<TestServerInfo> {
    return this.crashAndRestartWeb()
  }

  async restartSupervisor(): Promise<SupervisorInstance> {
    return this.replaceSupervisor('graceful')
  }

  async restartSupervisorAbrupt(): Promise<SupervisorInstance> {
    return this.replaceSupervisor('abrupt')
  }

  private async replaceSupervisor(mode: 'graceful' | 'abrupt'): Promise<SupervisorInstance> {
    const previous = this.supervisor
    if (mode === 'abrupt') this.runtime.killTrackedContainerExact(previous.containerId)
    else this.runtime.stopSupervisorExact(previous)
    this.runtime.removeContainerExact(previous.containerId)
    this.supervisor = await this.runtime.startSupervisor({
      scenarioId: previous.scenarioId,
      volumeName: previous.volumeName,
      binaryKind: previous.binaryKind,
      reuseSecret: true,
      env: { ...this.supervisorEnv, ...this.managedEnvironment() },
    })
    return this.supervisor
  }

  async stopSoul(soulId: string): Promise<any> {
    const epoch = await this.controlEpoch()
    const result = await this.runtime.adminOk(this.supervisor, this.runtime.stopBody(soulId, epoch))
    return this.dataOf(result, 'stop')
  }

  async stop(): Promise<{ ok: boolean; errors: string[] }> {
    await this.web?.stop().catch(() => undefined)
    return this.runtime.cleanup()
  }

  async destroyTestRig(): Promise<{ ok: boolean; errors: string[] }> {
    return this.stop()
  }

  async controlEpoch(): Promise<number> {
    const health = await this.runtime.adminOk(this.supervisor, { method: 'health' })
    const data = this.dataOf(health, 'health')
    return data.controlEpoch ?? data.control_epoch
  }

  async inventory(): Promise<ManagedRuntimeView[]> {
    const result = await this.runtime.adminOk(this.supervisor, { method: 'inventory' })
    return this.dataOf(result, 'inventory') as ManagedRuntimeView[]
  }

  async inventorySnapshot(): Promise<any> {
    const result = await this.runtime.adminOk(this.supervisor, { method: 'inventory_snapshot' })
    return this.dataOf(result, 'inventory_snapshot')
  }

  async qualificationWriterClaim(input: {
    provider: string
    nativeSessionId: string
    soulId: string
    incarnationId: string
  }): Promise<any> {
    const result = await this.runtime.adminOk(this.supervisor, {
      method: 'qualification_writer_claim',
      params: input,
    })
    return this.dataOf(result, 'qualification_writer_claim')
  }

  async runningViewForTerminal(terminalId: string): Promise<ManagedRuntimeView | null> {
    return (await this.inventory()).find((row) => row.terminalId === terminalId && row.launchState === 'running') ?? null
  }

  async runningViewForFreshSession(sessionId: string): Promise<ManagedRuntimeView | null> {
    return (await this.inventory()).find((row: any) => (
      row.freshAgentSessionId === sessionId && row.launchState === 'running'
    )) ?? null
  }

  ownedContainerExec(containerId: string, args: string[]): string {
    return this.runtime.execOwnedContainerExact(containerId, args)
  }

  ownedProviderExec(containerId: string, args: string[]): string {
    return this.runtime.execOwnedContainerAsExact(containerId, '65534:0', args)
  }

  ownedContainerHasPid(containerId: string, pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    const result = this.runtime.execOwnedContainerExact(containerId, [
      'sh',
      '-lc',
      `if test -d /proc/${pid}; then printf alive; fi`,
    ])
    return result.trim() === 'alive'
  }

  ownedContainerProcessTable(containerId: string): string {
    return this.runtime.topOwnedContainerExact(containerId, ['-eo', 'pid,args'])
  }

  writeBrowserResult(value: unknown): string { return this.writeResult('browser-continuity.json', value) }
  writeOpenCodeResult(value: unknown): string { return this.writeResult('opencode-continuity.json', value) }
  writeResurrectionResult(value: unknown): string { return this.writeResult('provider-resurrection.json', value) }
  writeRehydrateResult(value: unknown): string { return this.writeResult('tabs-rehydrate.json', value) }
  writeLossResult(value: unknown): string { return this.writeResult('loss-results.json', value) }
  writeChaosResult(value: unknown): string { return this.writeResult('chaos-results.json', value) }

  writeProviderResults(providers: ProviderQualificationRow[]) {
    assertProviderResults(this.repoRoot, providers)
    const report = { schemaVersion: 2, status: 'PASS', providers,
      buildCommit: this.runtime.candidateSha, runtimeImage: this.runtime.imageRef }
    return { report, paths: [this.writeResult('provider-results.json', report)] }
  }

  writeFreshAgentResults(rows: FreshAgentQualificationRow[]) {
    const selectedModes = rows.map(({ mode }) => mode)
    assertFreshAgentResults(this.repoRoot, selectedModes, rows)
    const report = { schemaVersion: 1, status: 'PASS', selectedModes, rows,
      buildCommit: this.runtime.candidateSha, runtimeImage: this.runtime.imageRef }
    return { report, paths: [this.writeResult('fresh-agent-results.json', report)] }
  }

  private writeResult(fileName: string, value: unknown): string {
    const target = path.join(this.runtime.browserDir, fileName)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, JSON.stringify(value, null, 2), { mode: 0o600 })
    return target
  }

  private buildManagedServer(): string {
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    execFileSync(mise, [
      'exec', 'rust@1.96', '--', 'cargo', 'build', '--release', '-p', 'freshell-server',
      '--features', this.fixtureFreshAgentModes.length > 0
        ? 'managed-fresh-agent-fixtures'
        : 'managed-runtime-v1',
    ], { cwd: this.repoRoot, stdio: 'inherit' })
    const source = path.join(this.repoRoot, 'target', 'release', 'freshell-server')
    const target = path.join(this.runtime.buildDir, 'freshell-server-managed')
    fs.copyFileSync(source, target)
    fs.chmodSync(target, 0o755)
    return target
  }

  private managedEnvironment(): Record<string, string> {
    const providers = new Set(['shell', ...this.enabledProviders])
    for (const mode of this.freshAgentModes) {
      providers.add(mode === 'kilroy' || mode === 'freshclaude' ? 'claude'
        : mode === 'freshcodex' ? 'codex' : 'opencode')
    }
    return { FRESHELL_MANAGED_PROVIDERS: [...providers].join(',') }
  }

  private async withManagedBin<T>(operation: () => Promise<T>): Promise<T> {
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = this.serverBin
    try {
      return await operation()
    } finally {
      if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous
    }
  }

  private dataOf(result: any, expectedKind: string): any {
    if (!result || result.kind !== expectedKind) {
      throw new Error(`expected ${expectedKind} supervisor result, got ${JSON.stringify(result)}`)
    }
    return result.data
  }
}
