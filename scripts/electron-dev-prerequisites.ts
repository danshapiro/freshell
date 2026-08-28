#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..')

export interface ElectronDevPrerequisitePaths {
  serverBinary: string
  clientDir: string
  clientIndex: string
  mcpEntry: string
}

export interface ElectronDevPrerequisitePhase {
  command: string
  args: string[]
}

export type ElectronDevCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => void

export interface ElectronDevSpawnOptions {
  cwd: string
  shell: boolean
  stdio: 'inherit'
  windowsHide: boolean
}

export interface ElectronDevSpawnResult {
  error?: Error
  signal: NodeJS.Signals | null
  status: number | null
}

export type ElectronDevSpawn = (
  command: string,
  args: string[],
  options: ElectronDevSpawnOptions,
) => ElectronDevSpawnResult

const defaultSpawn: ElectronDevSpawn = (command, args, options) =>
  spawnSync(command, args, options)

export function npmCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function buildElectronDevPrerequisitePhases(
  npm = npmCommand(),
): ElectronDevPrerequisitePhase[] {
  return [
    { command: npm, args: ['run', 'prebuild'] },
    { command: npm, args: ['run', 'build:client'] },
    { command: npm, args: ['run', 'build:tools'] },
    { command: npm, args: ['run', 'build:rust:debug'] },
  ]
}

export function resolveElectronDevPrerequisitePaths(
  projectRoot: string = PROJECT_ROOT,
  platform: NodeJS.Platform = process.platform,
): ElectronDevPrerequisitePaths {
  const root = path.resolve(projectRoot)
  const executable = platform === 'win32' ? 'freshell-server.exe' : 'freshell-server'
  const clientDir = path.join(root, 'dist', 'client')

  return {
    serverBinary: path.join(root, 'target', 'debug', executable),
    clientDir,
    clientIndex: path.join(clientDir, 'index.html'),
    mcpEntry: path.join(root, 'dist', 'tools', 'freshell-mcp', 'server.js'),
  }
}

export function runElectronDevCommand(
  command: string,
  args: string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  spawn: ElectronDevSpawn = defaultSpawn,
): void {
  let result: ElectronDevSpawnResult
  try {
    result = spawn(command, args, {
      cwd,
      shell: platform === 'win32',
      stdio: 'inherit',
      windowsHide: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${command} ${args.join(' ')} failed to start: ${message}`)
  }

  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed to start: ${result.error.message}`)
  }

  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? 'unknown'}`
    throw new Error(`${command} ${args.join(' ')} failed with ${reason}`)
  }
}

export interface RunElectronDevPrerequisitesOptions {
  projectRoot?: string
  platform?: NodeJS.Platform
  npm?: string
  runCommand?: ElectronDevCommandRunner
  spawn?: ElectronDevSpawn
  pathExists?: (filePath: string) => boolean
}

export function runElectronDevPrerequisites({
  projectRoot = PROJECT_ROOT,
  platform = process.platform,
  npm,
  runCommand: injectedCommandRunner,
  spawn: injectedSpawn = defaultSpawn,
  pathExists = existsSync,
}: RunElectronDevPrerequisitesOptions = {}): ElectronDevPrerequisitePaths {
  const root = path.resolve(projectRoot)
  const paths = resolveElectronDevPrerequisitePaths(root, platform)
  const phases = buildElectronDevPrerequisitePhases(npm ?? npmCommand(platform))
  const commandRunner = injectedCommandRunner ?? ((command: string, args: string[], cwd: string) =>
    runElectronDevCommand(command, args, cwd, platform, injectedSpawn))

  for (const phase of phases) {
    commandRunner(phase.command, phase.args, root)
  }

  const requiredOutputs: Array<[string, string]> = [
    ['debug Rust server', paths.serverBinary],
    ['static client', paths.clientIndex],
    ['MCP tool bundle', paths.mcpEntry],
  ]
  const missingOutputs = requiredOutputs
    .filter(([, filePath]) => !pathExists(filePath))
    .map(([name, filePath]) => `${name} (${filePath})`)

  if (missingOutputs.length > 0) {
    throw new Error(`Electron dev prerequisites missing: ${missingOutputs.join(', ')}`)
  }

  return paths
}

function logError(error: unknown): void {
  process.stderr.write(`${JSON.stringify({
    severity: 'error',
    component: 'electron-dev-prerequisites',
    event: 'prerequisites_failed',
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runElectronDevPrerequisites()
  } catch (error) {
    logError(error)
    process.exitCode = 1
  }
}
