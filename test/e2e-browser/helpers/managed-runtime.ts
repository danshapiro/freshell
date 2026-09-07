import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { RuntimeHarness, type SupervisorInstance } from '../../../scripts/testing/runtime-sandbox.js'
import { RustServer } from './rust-server.js'
import type { TestServerInfo } from './test-server.js'

export type ManagedRuntimeView = {
  soulId: string
  incarnationId: string
  launchState: string
  containerId?: string
  hostBootId?: string
  terminalId?: string
  projectKey?: string
  profile?: string
}

/**
 * Owned Phase-2 browser rig: restricted Docker broker + supervisor + a
 * feature-enabled Rust web server. Web restart methods touch only the web
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

  constructor(repoRoot = process.cwd()) {
    this.repoRoot = fs.realpathSync(repoRoot)
    this.runtime = new RuntimeHarness(this.repoRoot, undefined, 2)
  }

  async start(): Promise<TestServerInfo> {
    await this.runtime.prepare()
    this.supervisor = await this.runtime.startSupervisor({ scenarioId: 'browser-managed-runtime' })
    this.serverBin = this.buildManagedServer()
    this.web = new RustServer({
      preserveHomeOnStop: true,
      env: {
        FRESHELL_MANAGED_RUNTIME_V1: '1',
        FRESHELL_RUNTIME_CONTROL_SOCKET: this.supervisor.controlSocket,
        FRESHELL_RUNTIME_CONTROL_SECRET_FILE: this.supervisor.controlSecretFile,
      },
      setupHome: async (homeDir) => {
        const freshell = path.join(homeDir, '.freshell')
        await fsp.mkdir(freshell, { recursive: true })
        await fsp.writeFile(path.join(freshell, 'config.json'), JSON.stringify({
          version: 1,
          settings: {
            defaultCwd: this.repoRoot,
            codingCli: {
              enabledProviders: ['claude'],
              providers: { claude: { permissionMode: 'bypassPermissions' } },
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

  async crashAndRestartWeb(): Promise<TestServerInfo> {
    return this.withManagedBin(() => this.web.restartAbrupt())
  }

  async stop(): Promise<{ ok: boolean; errors: string[] }> {
    await this.web?.stop().catch(() => undefined)
    return this.runtime.cleanup()
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

  async runningViewForTerminal(terminalId: string): Promise<ManagedRuntimeView | null> {
    return (await this.inventory()).find((row) => row.terminalId === terminalId && row.launchState === 'running') ?? null
  }

  ownedContainerExec(containerId: string, args: string[]): string {
    return this.runtime.execOwnedContainerExact(containerId, args)
  }

  writeBrowserReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_BROWSER_RECEIPT
      || path.join(this.runtime.browserDir, 'p2-g01-browser-continuity.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(value, null, 2))
    return target
  }

  writeClaudeReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_CLAUDE_RECEIPT
      || path.join(this.runtime.browserDir, 'p2-g04-real-claude-continuity.json')
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
