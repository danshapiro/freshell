import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveDebugLogPath } from '../../../server/logger.js'
import {
  applyServerHomeEnvironment,
  ensureSetupWizardBypassConfig,
  findFreePort,
  type E2eServerInfo,
} from '../../../test/e2e-browser/helpers/server-fixture-support.js'

export interface LegacyNodeServerOptions {
  env?: Record<string, string>
  setupHome?: (homeDir: string) => Promise<void>
  startTimeoutMs?: number
  verbose?: boolean
  runtimeRootMode?: 'project' | 'isolated'
}

function findProjectRoot(start: string): string {
  let current = path.resolve(start)
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current
    current = path.dirname(current)
  }
  throw new Error('Could not find project root')
}

async function isolatedRuntimeRoot(projectRoot: string): Promise<string> {
  const entry = path.join(projectRoot, 'dist', 'server', 'index.js')
  if (!fs.existsSync(entry)) throw new Error(`Built Node server not found at ${entry}`)
  const parent = path.join(projectRoot, '.worktrees')
  await fsp.mkdir(parent, { recursive: true })
  const root = await fsp.mkdtemp(path.join(parent, 'oracle-node-runtime-'))
  try {
    await fsp.copyFile(path.join(projectRoot, 'package.json'), path.join(root, 'package.json'))
    await fsp.cp(path.join(projectRoot, 'dist'), path.join(root, 'dist'), { recursive: true })
    return root
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true })
    throw error
  }
}

/** Temporary oracle-local Node constructor. Task 5 removes it with Node oracle mode. */
export class LegacyNodeServer {
  private child: ChildProcess | null = null
  private homeDir: string | null = null
  private runtimeRoot: string | null = null
  private _info: E2eServerInfo | null = null

  constructor(private readonly options: LegacyNodeServerOptions = {}) {}

  get info(): E2eServerInfo {
    if (!this._info) throw new Error('LegacyNodeServer not started')
    return this._info
  }

  async start(): Promise<E2eServerInfo> {
    const projectRoot = findProjectRoot(import.meta.dirname)
    const port = await findFreePort()
    const token = randomUUID()
    this.homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-oracle-node-'))
    const freshellDir = path.join(this.homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })
    if (this.options.setupHome) await this.options.setupHome(this.homeDir)
    await ensureSetupWizardBypassConfig(path.join(freshellDir, 'config.json'))
    const logsDir = path.join(freshellDir, 'logs')
    await fsp.mkdir(logsDir, { recursive: true })
    this.runtimeRoot = this.options.runtimeRootMode === 'project'
      ? projectRoot
      : await isolatedRuntimeRoot(projectRoot)
    const entry = path.join(this.runtimeRoot, 'dist', 'server', 'index.js')
    const env = applyServerHomeEnvironment({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      NODE_ENV: 'production',
      AUTH_TOKEN: token,
      FRESHELL_LOG_DIR: logsDir,
      FRESHELL_BIND_HOST: '127.0.0.1',
      HIDE_STARTUP_TOKEN: 'true',
      ...this.options.env,
    }, this.homeDir, this.options.runtimeRootMode ?? 'isolated')
    this.child = spawn('node', [entry], { cwd: this.runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const pid = this.child.pid
    if (!pid) throw new Error('Node oracle server did not start')
    const baseUrl = `http://127.0.0.1:${port}`
    await this.waitForHealth(baseUrl, this.options.startTimeoutMs ?? 60_000)
    this._info = {
      port, baseUrl, wsUrl: `ws://127.0.0.1:${port}/ws`, token,
      configDir: this.homeDir, homeDir: this.homeDir, logsDir,
      debugLogPath: resolveDebugLogPath(env, this.homeDir) ?? path.join(logsDir, `server-debug.production.${port}.jsonl`),
      pid, runtimeRoot: this.runtimeRoot,
    }
    return this._info
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5_000)
        child.once('exit', () => { clearTimeout(timeout); resolve() })
        child.kill('SIGTERM')
      })
    }
    await Promise.all([
      this.homeDir ? fsp.rm(this.homeDir, { recursive: true, force: true }) : undefined,
      this.runtimeRoot && this.options.runtimeRootMode !== 'project'
        ? fsp.rm(this.runtimeRoot, { recursive: true, force: true }) : undefined,
    ])
    this.homeDir = null
    this.runtimeRoot = null
    this._info = null
  }

  private async waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
        throw new Error(`Node oracle server exited before becoming ready (${this.child.exitCode})`)
      }
      try {
        const response = await fetch(`${baseUrl}/api/health`)
        if (response.ok && (await response.json() as { ok?: boolean }).ok) return
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`Timed out waiting for Node oracle server health at ${baseUrl}`)
  }
}
