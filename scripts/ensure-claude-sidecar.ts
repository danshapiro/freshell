/**
 * Install and verify the isolated Claude SDK sidecar dependencies.
 *
 * The sidecar is intentionally a separate npm package because it is the one
 * sanctioned Node client in the Rust application. Its node_modules directory
 * is a build artifact, so every clean source or Electron checkout must
 * recreate it from the committed lockfile before the Rust runtime starts or
 * the desktop runtime is staged.
 */

import { execFileSync as defaultExecFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SIDECAR_PACKAGE_NAME = 'freshell-claude-sidecar'
const SDK_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk'
const INSTALL_ARGS = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] as const

export type NpmExecFileCommand = {
  command: string
  args: string[]
}

export interface ClaudeSidecarInstallReceipt {
  severity: 'info'
  event: 'claude_sidecar_dependencies_ready'
  sidecarDir: string
  packageName: string
  packageVersion: string
  installCommand: string[]
}

export interface EnsureClaudeSidecarDependenciesOptions {
  /** Sidecar package directory; defaults to the repository sidecar. */
  sidecarDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  nodeExecPath?: string
  execFileSync?: typeof defaultExecFileSync
}

type JsonObject = Record<string, unknown>

function readJson(filePath: string): JsonObject {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as JsonObject
  } catch (error) {
    throw new Error(`Unable to read JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function packageDependency(packageJson: JsonObject, packageName: string): string | undefined {
  const dependencies = packageJson.dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return undefined
  const version = (dependencies as Record<string, unknown>)[packageName]
  return typeof version === 'string' ? version : undefined
}

/**
 * Resolve npm without invoking a shell. npm_execpath is used by npm itself and
 * is the most reliable way to select the native CLI on Windows installations.
 */
export function resolveNpmExecFileCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  nodeExecPath = process.execPath,
): NpmExecFileCommand {
  const npmExecPath = env.npm_execpath
  if (npmExecPath && /\.js$/i.test(npmExecPath)) {
    return {
      command: nodeExecPath,
      args: [npmExecPath, ...args],
    }
  }

  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [...args],
  }
}

function defaultSidecarDir(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(scriptDir, '..', 'crates', 'freshell-claude-sidecar')
}

function validateSidecarLock(sidecarDir: string): { packageName: string; packageVersion: string } {
  const packagePath = path.join(sidecarDir, 'package.json')
  const lockPath = path.join(sidecarDir, 'package-lock.json')
  const packageJson = readJson(packagePath)
  const lockJson = readJson(lockPath)

  if (packageJson.name !== SIDECAR_PACKAGE_NAME) {
    throw new Error(`Claude sidecar package.json must name ${SIDECAR_PACKAGE_NAME}`)
  }
  if (lockJson.lockfileVersion !== 3) {
    throw new Error('Claude sidecar package-lock.json must use lockfileVersion 3')
  }

  const lockPackages = lockJson.packages
  if (!lockPackages || typeof lockPackages !== 'object' || Array.isArray(lockPackages)) {
    throw new Error('Claude sidecar package-lock.json is missing its packages table')
  }
  const lockRoot = (lockPackages as Record<string, unknown>)['']
  const lockSdk = (lockPackages as Record<string, unknown>)[`node_modules/${SDK_PACKAGE_NAME}`]
  if (!lockRoot || typeof lockRoot !== 'object' || Array.isArray(lockRoot)) {
    throw new Error('Claude sidecar package-lock.json is missing its root package metadata')
  }
  if (!lockSdk || typeof lockSdk !== 'object' || Array.isArray(lockSdk)) {
    throw new Error(`Claude sidecar lockfile is missing ${SDK_PACKAGE_NAME}`)
  }

  const root = lockRoot as JsonObject
  if (root.name !== packageJson.name || root.version !== packageJson.version) {
    throw new Error('Claude sidecar package.json and package-lock.json root metadata differ')
  }

  const declaredSdkVersion = packageDependency(packageJson, SDK_PACKAGE_NAME)
  const lockedRootSdkVersion = packageDependency(root, SDK_PACKAGE_NAME)
  const lockedSdkVersion = (lockSdk as JsonObject).version
  if (!declaredSdkVersion || lockedRootSdkVersion !== declaredSdkVersion || typeof lockedSdkVersion !== 'string') {
    throw new Error(`Claude sidecar package-lock.json does not lock ${SDK_PACKAGE_NAME} to the declared dependency`)
  }

  return {
    packageName: SDK_PACKAGE_NAME,
    packageVersion: lockedSdkVersion,
  }
}

function installedSdkPackage(sidecarDir: string): JsonObject {
  const packagePath = path.join(sidecarDir, 'node_modules', ...SDK_PACKAGE_NAME.split('/'), 'package.json')
  if (!existsSync(packagePath)) {
    throw new Error(`Claude sidecar dependency is missing after npm ci: ${SDK_PACKAGE_NAME}`)
  }
  return readJson(packagePath)
}

export function ensureClaudeSidecarDependencies(
  options: EnsureClaudeSidecarDependenciesOptions = {},
): ClaudeSidecarInstallReceipt {
  const sidecarDir = path.resolve(options.sidecarDir ?? defaultSidecarDir())
  const { packageName, packageVersion } = validateSidecarLock(sidecarDir)
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const npm = resolveNpmExecFileCommand(
    [...INSTALL_ARGS],
    env,
    platform,
    options.nodeExecPath ?? process.execPath,
  )
  const execFileSync = options.execFileSync ?? defaultExecFileSync

  execFileSync(npm.command, npm.args, {
    cwd: sidecarDir,
    env,
    stdio: 'inherit',
  })

  const installed = installedSdkPackage(sidecarDir)
  if (installed.name !== packageName || installed.version !== packageVersion) {
    throw new Error(
      `Claude sidecar dependency version mismatch: expected ${packageName}@${packageVersion}, got ${String(installed.name)}@${String(installed.version)}`,
    )
  }

  return {
    severity: 'info',
    event: 'claude_sidecar_dependencies_ready',
    sidecarDir,
    packageName,
    packageVersion,
    installCommand: [npm.command, ...npm.args],
  }
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectInvocation()) {
  try {
    console.log(JSON.stringify(ensureClaudeSidecarDependencies()))
  } catch (error) {
    console.error(JSON.stringify({
      severity: 'error',
      event: 'claude_sidecar_dependencies_failed',
      error: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  }
}
