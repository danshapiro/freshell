import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { defaultReceiptFileName } from '../../../scripts/testing/runtime-receipts.js'
import {
  buildProviderQualificationReceipt,
  type ProviderQualificationReceiptV2,
  type ProviderQualificationRow,
} from '../../../scripts/testing/provider-qualification-receipt.js'
import { RuntimeHarness, type SupervisorInstance } from '../../../scripts/testing/runtime-sandbox.js'
import { RustServer } from './rust-server.js'
import type { TestServerInfo } from './test-server.js'

export const P2_OPENCODE_VERSION = '1.18.21'
export const P2_OPENCODE_FREE_MODEL = 'opencode/big-pickle'

export type ManagedRuntimeView = {
  soulId: string
  incarnationId: string
  launchState: string
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

  constructor(
    repoRoot = process.cwd(),
    phase: 2 | 3 | 4 | 5 = 2,
    serverEnv: Record<string, string> = {},
    supervisorEnv: Record<string, string> = {},
    supervisorBinaryKind: 'test' | 'release' = 'test',
    qualificationProviders: {
      enabledProviders: string[]
      providerSettings?: Record<string, Record<string, unknown>>
    } = { enabledProviders: ['opencode'] },
  ) {
    this.repoRoot = fs.realpathSync(repoRoot)
    this.runtime = new RuntimeHarness(this.repoRoot, undefined, phase)
    this.serverEnv = { ...serverEnv }
    this.supervisorEnv = { ...supervisorEnv }
    this.supervisorBinaryKind = supervisorBinaryKind
    this.enabledProviders = [...qualificationProviders.enabledProviders]
    this.providerSettings = { ...qualificationProviders.providerSettings }
  }

  async start(): Promise<TestServerInfo> {
    await this.runtime.prepare()
    this.supervisor = await this.runtime.startSupervisor({
      scenarioId: 'browser-managed-runtime',
      binaryKind: this.supervisorBinaryKind,
      env: this.supervisorEnv,
    })
    this.serverBin = this.buildManagedServer()
    this.web = new RustServer({
      preserveHomeOnStop: true,
      env: {
        FRESHELL_MANAGED_RUNTIME_V1: '1',
        FRESHELL_RUNTIME_CONTROL_SOCKET: this.supervisor.controlSocket,
        FRESHELL_RUNTIME_CONTROL_SECRET_FILE: this.supervisor.controlSecretFile,
        ...this.serverEnv,
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
    const previous = this.supervisor
    this.runtime.stopSupervisorExact(previous)
    this.runtime.removeContainerExact(previous.containerId)
    this.supervisor = await this.runtime.startSupervisor({
      scenarioId: previous.scenarioId,
      volumeName: previous.volumeName,
      binaryKind: previous.binaryKind,
      reuseSecret: true,
      env: this.supervisorEnv,
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

  async runningViewForTerminal(terminalId: string): Promise<ManagedRuntimeView | null> {
    return (await this.inventory()).find((row) => row.terminalId === terminalId && row.launchState === 'running') ?? null
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

  writeBrowserReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_BROWSER_RECEIPT
      || path.join(this.runtime.browserDir, defaultReceiptFileName('FRESHELL_RUNTIME_BROWSER_RECEIPT'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(value, null, 2))
    return target
  }

  writeOpencodeReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_OPENCODE_RECEIPT
      || path.join(this.runtime.browserDir, defaultReceiptFileName('FRESHELL_RUNTIME_OPENCODE_RECEIPT'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(value, null, 2))
    return target
  }

  writeProviderQualificationReceipt(
    value: unknown,
    defaultFileName = 'opencode-provider-qualification.json',
  ): string[] {
    const targets = new Set([
      process.env.FRESHELL_RUNTIME_PHASE3_PROVIDER_RECEIPT,
      process.env.FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT,
    ].filter((value): value is string => Boolean(value?.trim())))
    if (targets.size === 0) {
      targets.add(path.join(this.runtime.browserDir, defaultFileName))
    }
    const written: string[] = []
    for (const target of targets) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify(value, null, 2))
      written.push(target)
    }
    return written
  }

  finalizeProviderQualificationReceipt(providers: ProviderQualificationRow[]): {
    receipt: ProviderQualificationReceiptV2
    paths: string[]
  } {
    const receipt = buildProviderQualificationReceipt({
      repoRoot: this.repoRoot,
      evidenceDir: this.runtime.evidenceDir,
      candidateSha: this.runtime.candidateSha,
      receiptRunId: this.runtime.runId,
      runtimeImage: this.runtime.imageRef,
      providers,
    })
    return {
      receipt,
      paths: this.writeProviderQualificationReceipt(
        receipt,
        providers.length > 1
          ? 'managed-provider-qualification.json'
          : `${providers[0]?.provider ?? 'provider'}-provider-qualification.json`,
      ),
    }
  }

  writePhase3BrowserReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT
      || path.join(this.runtime.browserDir, defaultReceiptFileName('FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(value, null, 2))
    return target
  }

  writePhase4BrowserReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT
      || path.join(this.runtime.browserDir, defaultReceiptFileName('FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(value, null, 2))
    return target
  }

  writePhase5LossReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT
      || path.join(this.runtime.browserDir, defaultReceiptFileName('FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(value, null, 2))
    return target
  }

  writePhase5ChaosReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT
      || path.join(this.runtime.browserDir, defaultReceiptFileName('FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(value, null, 2))
    return target
  }

  private buildManagedServer(): string {
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    execFileSync(mise, [
      'exec', 'rust@1.96', '--', 'cargo', 'build', '--release', '-p', 'freshell-server',
      '--features', 'managed-runtime-v1',
    ], { cwd: this.repoRoot, stdio: 'inherit' })
    const source = path.join(this.repoRoot, 'target', 'release', 'freshell-server')
    const target = path.join(this.runtime.buildDir, 'freshell-server-managed')
    fs.copyFileSync(source, target)
    fs.chmodSync(target, 0o755)
    return target
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
