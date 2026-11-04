/**
 * Readiness and repair gate for the Claude SDK sidecar dependencies.
 *
 * The sidecar is a pnpm workspace member whose dependencies are installed
 * by the root workspace install. Before the Rust runtime starts, this
 * script verifies the installed tree (exact SDK version pin, required
 * SDK entrypoint, and the target-platform native package) against a
 * recorded fingerprint of the sidecar manifest, the workspace lockfile,
 * and the workspace config. A current installation returns a readiness
 * receipt without installing anything; a missing or stale installation is
 * repaired with one frozen, sidecar-filtered pnpm install at the workspace
 * root. Failures happen before server spawn and never fall back to a
 * mutable install.
 */

import { execFileSync as defaultExecFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectProjectManager, resolveManagerCommand } from './lib/package-manager.js'
import { dependencyCacheIdentity } from '../docker/sandbox/dependency-cache.mjs'

const SIDECAR_PACKAGE_NAME = 'freshell-claude-sidecar'
const SDK_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk'
// --config.confirmModulesPurge=false: pnpm 10.34.5 stops a FILTERED install
// to ask about touching module state outside the filter ("If you are running
// pnpm in CI ... set confirmModulesPurge to 'false'"), and a non-interactive
// child refuses with exit 1. The flag means "proceed WITHOUT purging modules
// outside the filter" — exactly the bootstrap's intent: it must never prune
// the root tree. Reproduced: the source-runtime start-script lane timed out
// (30s health window) in fresh checkouts because this refusal killed the
// prestart; with the flag the cold filtered install completes in seconds and
// the root node_modules stays intact.
const FROZEN_FILTERED_INSTALL_ARGS = ['install', '--filter', SIDECAR_PACKAGE_NAME, '--frozen-lockfile', '--config.confirmModulesPurge=false']
const READY_RECEIPT_FILENAME = '.claude-sidecar-ready.json'
const NATIVE_PLATFORMS = new Set<NodeJS.Platform>(['linux', 'darwin', 'win32'])

export interface ClaudeSidecarInstallReceipt {
  severity: 'info'
  event: 'claude_sidecar_dependencies_ready'
  sidecarDir: string
  packageName: string
  packageVersion: string
  installCommand: string[]
  packageManagerVersion?: string
  fingerprint?: {
    manifestMd5: string
    lockMd5: string
    workspaceMd5: string
  }
  repaired?: boolean
}

export interface EnsureClaudeSidecarDependenciesOptions {
  /** Sidecar package directory; defaults to the repository sidecar. */
  sidecarDir?: string
  /** Workspace root that owns the pnpm lockfile; defaults to sidecarDir/../... */
  repoRoot?: string
  env?: NodeJS.ProcessEnv
  envPath?: string
  platform?: NodeJS.Platform
  nodeExecPath?: string
  execFileSync?: typeof defaultExecFileSync
  /** Installed sandbox metadata; defaults to the normal image's metadata directory. */
  sandboxMetadataDir?: string
}

type JsonObject = Record<string, unknown>

type InstallIntegrity = { ok: true; sdkVersion: string } | { ok: false; reason: string }

interface Fingerprint {
  manifestMd5: string
  lockMd5: string
  workspaceMd5: string
}

function readJsonOrNull(filePath: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    return parsed as JsonObject
  } catch {
    return undefined
  }
}

function dependencyVersion(manifest: JsonObject, packageName: string): string | undefined {
  const dependencies = manifest.dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return undefined
  const version = (dependencies as Record<string, unknown>)[packageName]
  return typeof version === 'string' ? version : undefined
}

function md5OfFile(filePath: string): string | undefined {
  try {
    return createHash('md5').update(readFileSync(filePath)).digest('hex')
  } catch {
    return undefined
  }
}

function computeFingerprint(
  manifestPath: string,
  lockPath: string,
  workspacePath: string,
): Fingerprint | undefined {
  const manifestMd5 = md5OfFile(manifestPath)
  const lockMd5 = md5OfFile(lockPath)
  const workspaceMd5 = md5OfFile(workspacePath)
  if (manifestMd5 === undefined || lockMd5 === undefined || workspaceMd5 === undefined) {
    return undefined
  }
  return { manifestMd5, lockMd5, workspaceMd5 }
}

function sdkEntryTarget(sdkManifest: JsonObject): string | undefined {
  const exportsField = sdkManifest.exports
  if (exportsField !== undefined && exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const dotExport = (exportsField as Record<string, unknown>)['.']
    if (typeof dotExport === 'string') {
      return dotExport
    }
    if (dotExport !== undefined && dotExport !== null && typeof dotExport === 'object' && !Array.isArray(dotExport)) {
      const conditions = dotExport as Record<string, unknown>
      const target = conditions.import ?? conditions.default
      if (typeof target === 'string') {
        return target
      }
    }
  }
  const main = sdkManifest.main
  return typeof main === 'string' && main.length > 0 ? main : undefined
}

function resolveNativePackageManifest(sdkManifestPath: string, nativeName: string): string | undefined {
  try {
    const requireFromSdk = createRequire(realpathSync(sdkManifestPath))
    return requireFromSdk.resolve(`${nativeName}/package.json`)
  } catch {
    return undefined
  }
}

function inspectInstallIntegrity(sidecarDir: string, platform: NodeJS.Platform): InstallIntegrity {
  const manifestPath = path.join(sidecarDir, 'package.json')
  const manifest = readJsonOrNull(manifestPath)
  if (manifest === undefined) {
    return { ok: false, reason: `the sidecar manifest is missing or unreadable at ${manifestPath}` }
  }
  if (manifest.name !== SIDECAR_PACKAGE_NAME) {
    return { ok: false, reason: `the sidecar manifest must name ${SIDECAR_PACKAGE_NAME} (found ${String(manifest.name)})` }
  }
  const declaredSdkVersion = dependencyVersion(manifest, SDK_PACKAGE_NAME)
  if (declaredSdkVersion === undefined || declaredSdkVersion.length === 0) {
    return { ok: false, reason: `the sidecar manifest does not declare a ${SDK_PACKAGE_NAME} dependency` }
  }

  const sdkDir = path.join(sidecarDir, 'node_modules', ...SDK_PACKAGE_NAME.split('/'))
  const sdkManifestPath = path.join(sdkDir, 'package.json')
  const sdkManifest = readJsonOrNull(sdkManifestPath)
  if (sdkManifest === undefined) {
    return { ok: false, reason: `${SDK_PACKAGE_NAME} is not installed in the sidecar node_modules` }
  }
  if (sdkManifest.name !== SDK_PACKAGE_NAME) {
    return { ok: false, reason: `the installed SDK package at ${sdkManifestPath} must name ${SDK_PACKAGE_NAME}` }
  }
  if (sdkManifest.version !== declaredSdkVersion) {
    return {
      ok: false,
      reason: `installed ${SDK_PACKAGE_NAME} version ${String(sdkManifest.version)} does not match the sidecar manifest pin ${declaredSdkVersion}`,
    }
  }

  const entryTarget = sdkEntryTarget(sdkManifest)
  if (entryTarget === undefined) {
    return { ok: false, reason: `${SDK_PACKAGE_NAME} declares no resolvable entrypoint` }
  }
  if (!existsSync(path.join(sdkDir, entryTarget))) {
    return { ok: false, reason: `${SDK_PACKAGE_NAME} entrypoint ${entryTarget} is missing on disk` }
  }

  if (NATIVE_PLATFORMS.has(platform)) {
    const nativeName = `${SDK_PACKAGE_NAME}-${platform}-${process.arch}`
    const nativeManifestPath = resolveNativePackageManifest(sdkManifestPath, nativeName)
    if (nativeManifestPath === undefined) {
      return { ok: false, reason: `the platform native package ${nativeName} is not installed` }
    }
    const nativeManifest = readJsonOrNull(nativeManifestPath)
    if (nativeManifest?.name !== nativeName || nativeManifest.version !== declaredSdkVersion) {
      return { ok: false, reason: `the platform native package ${nativeName} does not match the SDK pin ${declaredSdkVersion}` }
    }
  }

  return { ok: true, sdkVersion: sdkManifest.version as string }
}

function readCurrentReceiptPnpmVersion(receiptPath: string, fingerprint: Fingerprint): string | undefined {
  const receiptFile = readJsonOrNull(receiptPath)
  if (receiptFile === undefined) return undefined
  if (receiptFile.manifestMd5 !== fingerprint.manifestMd5) return undefined
  if (receiptFile.lockMd5 !== fingerprint.lockMd5) return undefined
  if (receiptFile.workspaceMd5 !== fingerprint.workspaceMd5) return undefined
  if (typeof receiptFile.pnpmVersion !== 'string' || receiptFile.pnpmVersion.length === 0) return undefined
  if (typeof receiptFile.sdkVersion !== 'string' || receiptFile.sdkVersion.length === 0) return undefined
  return receiptFile.pnpmVersion
}

function writeReadyReceipt(receiptPath: string, contents: Record<string, string>): void {
  mkdirSync(path.dirname(receiptPath), { recursive: true })
  const tempPath = `${receiptPath}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(contents, null, 2)}\n`)
  renameSync(tempPath, receiptPath)
}

function defaultSidecarDir(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(scriptDir, '..', 'crates', 'freshell-claude-sidecar')
}

function preparedSandboxFingerprint(repoRoot: string, pnpmVersion: string): string {
  // Match the normal entrypoint's frozen workspace installation policy. The
  // cache identity separately covers package-manager config and file: inputs.
  const digest = createHash('sha256')
    .update(`manager=pnpm@${pnpmVersion}\npolicy=install --frozen-lockfile --store-dir /home/sandbox/.local/share/pnpm/store\n`)
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'crates/freshell-claude-sidecar/package.json', 'packages/freshell-mcp-runtime/package.json']) {
    const absolute = path.join(repoRoot, file)
    if (existsSync(absolute)) {
      digest.update(`${createHash('sha256').update(readFileSync(absolute)).digest('hex')}  ${file}\n`)
    }
  }
  return digest.digest('hex')
}

function preparedSandboxPnpmVersion(repoRoot: string, metadataDir: string, env: NodeJS.ProcessEnv): string {
  try {
    const protocol = readJsonOrNull(path.join(metadataDir, 'protocol.json'))
    const currentProtocol = readJsonOrNull(path.join(repoRoot, 'docker', 'sandbox', 'protocol.json'))
    if (protocol === undefined || currentProtocol === undefined
      || protocol.version !== currentProtocol.version || protocol.image !== currentProtocol.image
      || protocol.cacheSuffix !== currentProtocol.cacheSuffix || typeof protocol.version !== 'number') {
      throw new Error('installed sandbox protocol does not match the current workspace')
    }
    const foundation = readFileSync(path.join(metadataDir, 'foundation-id'), 'utf8').trim()
    const identity = dependencyCacheIdentity(repoRoot, foundation, protocol.version)
    const state = Object.fromEntries(readFileSync(path.join(repoRoot, 'node_modules', '.sandbox-deps-state'), 'utf8')
      .trim().split('\n').map(line => line.split('=')))
    const manifest = readJsonOrNull(path.join(repoRoot, 'package.json'))
    if (env.FRESHELL_SANDBOX_DEPENDENCY_KEY !== identity || state.cache_identity !== identity
      || state.fingerprint !== preparedSandboxFingerprint(repoRoot, state.manager_version) || state.manager !== 'pnpm'
      || !state.manager_version || manifest?.packageManager !== `pnpm@${state.manager_version}`) {
      throw new Error('published dependency state does not match the current inputs and pinned package manager')
    }
    return state.manager_version
  } catch (error) {
    throw new Error(`Cannot use Claude sidecar dependencies in a read-only sandbox: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function buildReadyReceipt(params: {
  sidecarDir: string
  packageVersion: string
  installCommand: string[]
  pnpmVersion: string
  fingerprint: Fingerprint
  repaired: boolean
}): ClaudeSidecarInstallReceipt {
  return {
    severity: 'info',
    event: 'claude_sidecar_dependencies_ready',
    sidecarDir: params.sidecarDir,
    packageName: SDK_PACKAGE_NAME,
    packageVersion: params.packageVersion,
    installCommand: params.installCommand,
    packageManagerVersion: params.pnpmVersion,
    fingerprint: params.fingerprint,
    repaired: params.repaired,
  }
}

export function ensureClaudeSidecarDependencies(
  options: EnsureClaudeSidecarDependenciesOptions = {},
): ClaudeSidecarInstallReceipt {
  const sidecarDir = path.resolve(options.sidecarDir ?? defaultSidecarDir())
  const repoRoot = path.resolve(options.repoRoot ?? path.join(sidecarDir, '..', '..'))
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const execFileSync = options.execFileSync ?? defaultExecFileSync

  const manifestPath = path.join(sidecarDir, 'package.json')
  const lockPath = path.join(repoRoot, 'pnpm-lock.yaml')
  const workspacePath = path.join(repoRoot, 'pnpm-workspace.yaml')
  const receiptPath = path.join(sidecarDir, 'node_modules', READY_RECEIPT_FILENAME)

  const integrity = inspectInstallIntegrity(sidecarDir, platform)
  const fingerprint = computeFingerprint(manifestPath, lockPath, workspacePath)

  if (env.FRESHELL_SANDBOX_DEPENDENCY_READONLY === '1') {
    if (!integrity.ok || fingerprint === undefined) {
      throw new Error(`Cannot use Claude sidecar dependencies in a read-only sandbox: ${integrity.ok ? 'dependency inputs are unreadable' : integrity.reason}`)
    }
    const pnpmVersion = preparedSandboxPnpmVersion(repoRoot,
      options.sandboxMetadataDir ?? '/usr/local/share/freshell-sandbox', env)
    return buildReadyReceipt({
      sidecarDir,
      packageVersion: integrity.sdkVersion,
      installCommand: ['pnpm', ...FROZEN_FILTERED_INSTALL_ARGS],
      pnpmVersion,
      fingerprint,
      repaired: false,
    })
  }

  if (integrity.ok && fingerprint !== undefined) {
    const currentPnpmVersion = readCurrentReceiptPnpmVersion(receiptPath, fingerprint)
    if (currentPnpmVersion !== undefined) {
      return buildReadyReceipt({
        sidecarDir,
        packageVersion: integrity.sdkVersion,
        installCommand: ['pnpm', ...FROZEN_FILTERED_INSTALL_ARGS],
        pnpmVersion: currentPnpmVersion,
        fingerprint,
        repaired: false,
      })
    }
  }

  const selection = detectProjectManager(repoRoot)
  if (selection.manager !== 'pnpm') {
    throw new Error(
      `The Claude sidecar is a pnpm workspace member, but the workspace root at ${repoRoot} resolves to ` +
      `${selection.manager} (${selection.source}). Declare "packageManager": "pnpm@10.34.5" in the root package.json.`,
    )
  }

  const managerInputs = {
    manager: 'pnpm' as const,
    env,
    ...(options.envPath !== undefined ? { envPath: options.envPath } : {}),
    platform,
    nodeExecPath: options.nodeExecPath ?? process.execPath,
  }

  const versionSpec = resolveManagerCommand({ ...managerInputs, args: ['--version'] })
  const pnpmVersion = execFileSync(versionSpec.command, versionSpec.args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    shell: versionSpec.viaShell ?? false,
  }).trim()
  if (pnpmVersion.length === 0) {
    throw new Error('The resolved pnpm reported no version; unable to fingerprint the package manager.')
  }

  const installSpec = resolveManagerCommand({ ...managerInputs, args: [...FROZEN_FILTERED_INSTALL_ARGS] })
  try {
    execFileSync(installSpec.command, installSpec.args, {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      shell: installSpec.viaShell ?? false,
    })
  } catch (error) {
    const status = (error as { status?: unknown }).status
    if (typeof status !== 'number') {
      throw error
    }
    throw new Error(
      `Claude sidecar frozen pnpm install failed with exit code ${status}: ` +
      `pnpm ${FROZEN_FILTERED_INSTALL_ARGS.join(' ')} at ${repoRoot}. ` +
      'No mutable recovery is attempted; repair the workspace with a full frozen install ' +
      '(pnpm install --frozen-lockfile) and retry.',
    )
  }

  const repairedIntegrity = inspectInstallIntegrity(sidecarDir, platform)
  if (!repairedIntegrity.ok) {
    throw new Error(
      `Claude sidecar preparation still fails after the frozen install: ${repairedIntegrity.reason}. ` +
      'No readiness receipt was written.',
    )
  }

  const repairedFingerprint = computeFingerprint(manifestPath, lockPath, workspacePath)
  if (repairedFingerprint === undefined) {
    throw new Error(
      `Unable to fingerprint the workspace after the frozen install ` +
      `(${manifestPath}, ${lockPath}, ${workspacePath}). No readiness receipt was written.`,
    )
  }

  writeReadyReceipt(receiptPath, {
    sdkVersion: repairedIntegrity.sdkVersion,
    pnpmVersion,
    manifestMd5: repairedFingerprint.manifestMd5,
    lockMd5: repairedFingerprint.lockMd5,
    workspaceMd5: repairedFingerprint.workspaceMd5,
    at: new Date().toISOString(),
  })

  return buildReadyReceipt({
    sidecarDir,
    packageVersion: repairedIntegrity.sdkVersion,
    installCommand: [installSpec.command, ...installSpec.args],
    pnpmVersion,
    fingerprint: repairedFingerprint,
    repaired: true,
  })
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
