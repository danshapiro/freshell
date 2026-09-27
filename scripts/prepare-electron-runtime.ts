/**
 * Build the files that electron-builder places beside the application.
 *
 * The desktop application has one backend: the native Rust executable.  The
 * standalone Node runtime is deliberately kept as a client runtime for the
 * Claude SDK sidecar and the stdio MCP client only.  The sidecar and MCP
 * dependency trees are exported by pnpm's filtered production deploy into
 * self-contained output directories, materialized into ordinary files, and
 * only then staged beside the Rust binary.  Keeping this layout in a small,
 * declarative producer makes it possible for the verifier and the
 * checkout-free integration test to inspect the exact same artifact.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

import {
  detectProjectManager,
  resolveManagerCommand,
} from './lib/package-manager.js'

/** Convert a module URL to its requested platform path dialect before joining files. */
export function moduleDirectoryFromUrl(moduleUrl: string, windows = process.platform === 'win32'): string {
  const modulePath = fileURLToPath(moduleUrl, { windows })
  return (windows ? path.win32 : path.posix).dirname(modulePath)
}

const __dirname = moduleDirectoryFromUrl(import.meta.url)
export const PROJECT_ROOT = path.resolve(__dirname, '..')

export type ElectronRuntimePlatform = 'darwin' | 'linux' | 'win32'
export type ElectronRuntimeArch = 'x64' | 'arm64'
export type DeployableRuntimePackage = 'freshell-claude-sidecar' | 'freshell-mcp-runtime'

export interface RuntimePaths {
  root: string
  serverBinary: string
  clientDir: string
  nodeBinary: string
  claudeSidecarDir: string
  claudeSidecarEntry: string
  claudeSidecarNodeModulesDir: string
  mcpDir: string
  mcpEntry: string
  mcpNodeModulesDir: string
  mcpPackageJson: string
  nodeClientRuntimeDir: string
}

/** Paths which are allowed in an Electron runtime, relative to its root. */
export const RUNTIME_LAYOUT = Object.freeze({
  serverBinary: 'bin/freshell-server',
  serverBinaryWindows: 'bin/freshell-server.exe',
  clientIndex: 'client/index.html',
  nodeBinary: 'node/bin/node',
  nodeBinaryWindows: 'node/bin/node.exe',
  claudeEntry: 'claude-sidecar/index.mjs',
  claudeSessionSettings: 'claude-sidecar/session-settings.mjs',
  claudeSessionNames: 'claude-sidecar/session-names.mjs',
  claudeModelCatalog: 'claude-sidecar/model-catalog.mjs',
  claudePackage: 'claude-sidecar/package.json',
  claudeDependencies: 'claude-sidecar/node_modules',
  mcpEntry: 'mcp/server.js',
  mcpPackage: 'mcp/package.json',
  mcpDependencies: 'mcp/node_modules',
  nodeClientRuntime: 'node-client-runtime',
  receipt: '.electron-runtime-receipt.json',
  electronArchive: 'app.asar',
  electronUnpackedClaudeSdk: 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk',
  launchChooser: 'launch-chooser',
  trayAssets: 'assets',
  macIcon: 'icon.icns',
  windowsElevate: 'elevate.exe',
})

export interface RuntimeAllowlist {
  /** Platform-specific executable paths. */
  serverBinary: string
  nodeBinary: string
  /** Files which may exist at the runtime root or outside recursive trees. */
  exactFiles: readonly string[]
  /** Directory prefixes whose complete contents are part of the runtime. */
  recursiveDirectories: readonly string[]
  /** Files required before an artifact can be considered runnable. */
  requiredFiles: readonly string[]
}

/**
 * The single runtime/artifact path contract shared by the producer and verifier.
 *
 * Recursive entries are intentional: client assets and the deployed
 * sidecar/MCP dependency trees contain many files. Everything else must be
 * named here or the verifier rejects it, including an otherwise innocuous
 * extra script. The Electron-only entries account for the app archive,
 * tray/chooser resources, and the SDK package that electron-builder unpacks
 * from the app archive.
 */
export function getRuntimeAllowlist(
  platform: ElectronRuntimePlatform | string,
): RuntimeAllowlist {
  assertPlatform(platform)
  const serverBinary = platform === 'win32'
    ? RUNTIME_LAYOUT.serverBinaryWindows
    : RUNTIME_LAYOUT.serverBinary
  const nodeBinary = platform === 'win32'
    ? RUNTIME_LAYOUT.nodeBinaryWindows
    : RUNTIME_LAYOUT.nodeBinary
  const requiredFiles = [
    serverBinary,
    nodeBinary,
    RUNTIME_LAYOUT.clientIndex,
    RUNTIME_LAYOUT.claudeEntry,
    RUNTIME_LAYOUT.claudeSessionSettings,
    RUNTIME_LAYOUT.claudeSessionNames,
    RUNTIME_LAYOUT.claudeModelCatalog,
    RUNTIME_LAYOUT.claudePackage,
    `${RUNTIME_LAYOUT.claudeDependencies}/@anthropic-ai/claude-agent-sdk/package.json`,
    RUNTIME_LAYOUT.mcpEntry,
    RUNTIME_LAYOUT.mcpPackage,
    `${RUNTIME_LAYOUT.mcpDependencies}/@modelcontextprotocol/sdk/package.json`,
    `${RUNTIME_LAYOUT.mcpDependencies}/zod/package.json`,
    `${RUNTIME_LAYOUT.nodeClientRuntime}/keys.js`,
    `${RUNTIME_LAYOUT.nodeClientRuntime}/action-capabilities.js`,
  ]
  return Object.freeze({
    serverBinary,
    nodeBinary,
    exactFiles: Object.freeze([
      serverBinary,
      nodeBinary,
      RUNTIME_LAYOUT.receipt,
      RUNTIME_LAYOUT.electronArchive,
      ...(platform === 'darwin' ? [RUNTIME_LAYOUT.macIcon] : []),
      ...(platform === 'win32' ? [RUNTIME_LAYOUT.windowsElevate] : []),
    ]),
    recursiveDirectories: Object.freeze([
      path.posix.dirname(RUNTIME_LAYOUT.clientIndex),
      path.posix.dirname(RUNTIME_LAYOUT.claudeEntry),
      path.posix.dirname(RUNTIME_LAYOUT.mcpEntry),
      RUNTIME_LAYOUT.nodeClientRuntime,
      RUNTIME_LAYOUT.electronUnpackedClaudeSdk,
      RUNTIME_LAYOUT.launchChooser,
      RUNTIME_LAYOUT.trayAssets,
    ]),
    requiredFiles: Object.freeze(requiredFiles),
  })
}

function normalizeRuntimePath(relativePath: string): string | undefined {
  const slashPath = relativePath.replaceAll('\\', '/')
  if (!slashPath || slashPath.startsWith('/') || slashPath.includes('\u0000')) return undefined
  const normalized = path.posix.normalize(slashPath)
  if (normalized !== slashPath || normalized === '..' || normalized.startsWith('../')) return undefined
  return normalized
}

function matchesRuntimeAllowlist(relativePath: string, allowlist: RuntimeAllowlist): boolean {
  const normalized = normalizeRuntimePath(relativePath)
  if (!normalized) return false
  if (allowlist.exactFiles.includes(normalized)) return true
  return allowlist.recursiveDirectories.some((directory) => normalized.startsWith(`${directory}/`))
}

export function isRuntimePathAllowed(
  relativePath: string,
  platform: ElectronRuntimePlatform | string,
): boolean {
  return matchesRuntimeAllowlist(relativePath, getRuntimeAllowlist(platform))
}

export function findUnapprovedRuntimePaths(
  relativePaths: string[],
  platform: ElectronRuntimePlatform | string,
): string[] {
  const allowlist = getRuntimeAllowlist(platform)
  return relativePaths
    .filter((relativePath) => !matchesRuntimeAllowlist(relativePath, allowlist))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * These names are rejected by the verifier even when nested below a benign
 * directory.  The list covers the old Node backend and native addon output.
 */
export const FORBIDDEN_RUNTIME_NAMES = Object.freeze([
  'server-node-modules',
  'server-node-modules-staging',
  'bundled-node',
  'native-modules',
  'node-pty',
  'node-gyp',
  'dist/server',
])

export interface DeployRuntimeArgs {
  packageName: DeployableRuntimePackage
  destination: string
}

export interface ExportedPackageIdentity {
  name: string
  version: string
}

/**
 * Exact pnpm argv for exporting a runtime package.  Normal filtered
 * production deploy resolves from the shared workspace lock and installs
 * the filtered graph frozen.  The hoisted node linker produces a flat,
 * npm-style tree of ordinary files so the staged runtime needs no
 * resolution-bearing links (the only links a hoisted deploy emits are
 * relative .bin shims, which materialization replaces safely).  There is
 * deliberately no `--` separator, no `--legacy`, and no mutable recovery
 * path here.
 */
export function buildDeployArgs(packageName: DeployableRuntimePackage, destination: string): string[] {
  return ['--filter', packageName, '--prod', '--config.node-linker=hoisted', 'deploy', destination]
}

export interface ElectronRuntimeStageOptions {
  /** Destination directory; defaults to <repo>/electron-runtime. */
  runtimeDir?: string
  /** Repository root; defaults to the checkout containing this script. */
  rootDir?: string
  platform?: ElectronRuntimePlatform
  arch?: ElectronRuntimeArch
  nodeVersion?: string
  releaseVersion?: string
  serverBinary?: string
  clientDir?: string
  /** A pre-downloaded Node executable, mainly useful for tests. */
  nodeBinary?: string
  /** Root dist/tools directory containing freshell-mcp and node-client-runtime. */
  mcpDistDir?: string
  /** Injected archive downloader for offline/unit tests. */
  downloadNodeBinary?: (args: {
    version: string
    platform: ElectronRuntimePlatform
    arch: ElectronRuntimeArch
    destination: string
  }) => Promise<void>
  /** Injected deploy runner for unit tests; defaults to a real pnpm deploy. */
  deployRuntime?: (args: DeployRuntimeArgs) => void
  /** Override for the receipt's package-manager version, mainly for tests. */
  packageManagerVersion?: string
}

export interface ElectronRuntimeStageReceipt {
  severity: 'info'
  event: 'electron_runtime_prepared'
  runtimeDir: string
  platform: ElectronRuntimePlatform
  arch: ElectronRuntimeArch
  releaseVersion: string
  nodeVersion: string
  packageManager: { name: 'pnpm'; version: string }
  sourceLockFingerprint: string
  exportedPackages: ExportedPackageIdentity[]
  files: string[]
  fileHashes: Record<string, string>
}

function assertPlatform(platform: string): asserts platform is ElectronRuntimePlatform {
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`Unsupported Electron runtime platform: ${platform}`)
  }
}

function assertArch(arch: string): asserts arch is ElectronRuntimeArch {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported Electron runtime architecture: ${arch}`)
  }
}

export function getRuntimeBinaryName(platform: ElectronRuntimePlatform | string): string {
  return platform === 'win32' ? 'freshell-server.exe' : 'freshell-server'
}

export function getNodeBinaryName(platform: ElectronRuntimePlatform | string): string {
  return platform === 'win32' ? 'node.exe' : 'node'
}

export function getRuntimePaths(
  runtimeDir: string,
  platform: ElectronRuntimePlatform | string,
): RuntimePaths {
  assertPlatform(platform)
  const root = path.resolve(runtimeDir)
  const serverBinary = path.join(root, 'bin', getRuntimeBinaryName(platform))
  const clientDir = path.join(root, 'client')
  const nodeBinary = path.join(root, 'node', 'bin', getNodeBinaryName(platform))
  const claudeSidecarDir = path.join(root, 'claude-sidecar')
  const mcpDir = path.join(root, 'mcp')
  return {
    root,
    serverBinary,
    clientDir,
    nodeBinary,
    claudeSidecarDir,
    claudeSidecarEntry: path.join(claudeSidecarDir, 'index.mjs'),
    claudeSidecarNodeModulesDir: path.join(claudeSidecarDir, 'node_modules'),
    mcpDir,
    mcpEntry: path.join(mcpDir, 'server.js'),
    mcpNodeModulesDir: path.join(mcpDir, 'node_modules'),
    mcpPackageJson: path.join(mcpDir, 'package.json'),
    nodeClientRuntimeDir: path.join(root, 'node-client-runtime'),
  }
}

export function getNodeDownloadUrl(
  version: string,
  platform: ElectronRuntimePlatform | string,
  arch: ElectronRuntimeArch | string,
): string {
  assertPlatform(platform)
  assertArch(arch)
  const base = `https://nodejs.org/dist/v${version}`
  if (platform === 'win32') return `${base}/node-v${version}-win-${arch}.zip`
  return `${base}/node-v${version}-${platform}-${arch}.tar.gz`
}

export function getNodeArchiveName(
  version: string,
  platform: ElectronRuntimePlatform,
  arch: ElectronRuntimeArch,
): string {
  return `node-v${version}-${platform === 'win32' ? 'win' : platform}-${arch}${platform === 'win32' ? '.zip' : '.tar.gz'}`
}

export function getNodeChecksumsUrl(version: string): string {
  return `https://nodejs.org/dist/v${version}/SHASUMS256.txt`
}

function removePath(targetPath: string): void {
  rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}

function ensureExecutable(filePath: string): void {
  const mode = statSync(filePath).mode & 0o777
  chmodSync(filePath, mode | 0o111)
}

function copyRequiredFile(source: string, destination: string): void {
  if (!existsSync(source)) throw new Error(`Required Electron runtime input is missing: ${source}`)
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(source, destination)
}

function copyRequiredDirectory(source: string, destination: string): void {
  if (!existsSync(source)) throw new Error(`Required Electron runtime directory is missing: ${source}`)
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true })
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
}

function resolvePnpm(rootDir: string, args: string[]) {
  const selection = detectProjectManager(rootDir)
  if (selection.manager !== 'pnpm') {
    throw new Error(
      `Electron runtime staging requires the pnpm workspace at ${rootDir}; ` +
        `detected ${selection.manager} via ${selection.source}.`,
    )
  }
  return resolveManagerCommand({ manager: selection.manager, args, env: process.env })
}

/**
 * Export one runtime package with a real filtered production deploy.  Deploy
 * resolves from the shared workspace lock and installs the filtered graph
 * frozen, so no mutable recovery path is offered here.
 */
function deployRuntimeDefault(rootDir: string, args: DeployRuntimeArgs): void {
  const command = resolvePnpm(rootDir, buildDeployArgs(args.packageName, args.destination))
  const result = spawnSync(command.command, command.args, {
    cwd: rootDir,
    shell: command.viaShell ?? false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (result.error) {
    throw new Error(`pnpm deploy failed to start for ${args.packageName}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const stderrTail = (result.stderr ?? '')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-10)
      .join('\n')
    throw new Error(
      `pnpm deploy failed for ${args.packageName} with exit code ${String(result.status)}.\n${stderrTail}`,
    )
  }
}

function capturePackageManagerVersion(rootDir: string, override: string | undefined): string {
  if (override) return override
  const command = resolvePnpm(rootDir, ['--version'])
  const result = spawnSync(command.command, command.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  const version = result.status === 0 ? (result.stdout ?? '').trim() : ''
  if (!version) {
    throw new Error('Unable to capture the pinned pnpm version for the Electron runtime receipt.')
  }
  return version
}

function readDeployIdentity(deployDir: string, expectedName: DeployableRuntimePackage): ExportedPackageIdentity {
  const manifest = readJson(path.join(deployDir, 'package.json'))
  const name = typeof manifest.name === 'string' ? manifest.name : undefined
  const version = typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : undefined
  if (name !== expectedName || !version) {
    throw new Error(
      `Unexpected package identity in the ${expectedName} deploy output: ${String(name)}@${String(version)}`,
    )
  }
  return { name, version }
}

function structuredLinkError(
  packageName: DeployableRuntimePackage,
  message: string,
  linkPath: string,
): Error {
  return new Error(`Electron runtime staging rejected a link in the ${packageName} deploy tree at ${linkPath}: ${message}`)
}

/**
 * Copy a deploy-exported tree into the staging runtime, replacing every
 * link with the ordinary content it resolves to.  Targets are resolved with
 * realpath so broken and cyclic chains fail loudly, and every target must
 * stay inside the deploy root so nothing can escape the exported closure.
 */
function materializeTree(
  source: string,
  destination: string,
  deployRoot: string,
  packageName: DeployableRuntimePackage,
): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    materializeEntry(path.join(source, entry.name), path.join(destination, entry.name), deployRoot, packageName)
  }
}

function materializeEntry(
  source: string,
  destination: string,
  deployRoot: string,
  packageName: DeployableRuntimePackage,
): void {
  const stats = lstatSync(source)
  if (stats.isSymbolicLink()) {
    let resolved: string
    try {
      resolved = realpathSync(source)
    } catch {
      throw structuredLinkError(packageName, 'the link target is broken or cyclic', source)
    }
    if (!resolved.startsWith(`${deployRoot}${path.sep}`)) {
      throw structuredLinkError(packageName, `the link target escapes the deploy tree (${resolved})`, source)
    }
    const target = lstatSync(resolved)
    if (target.isFile()) {
      copyRequiredFile(resolved, destination)
    } else if (target.isDirectory()) {
      materializeTree(resolved, destination, deployRoot, packageName)
    } else {
      throw structuredLinkError(packageName, `the link target has an unsupported type (${resolved})`, source)
    }
    return
  }
  if (stats.isFile()) {
    copyRequiredFile(source, destination)
    return
  }
  if (stats.isDirectory()) {
    materializeTree(source, destination, deployRoot, packageName)
    return
  }
  throw new Error(`Electron runtime staging cannot copy the unsupported filesystem entry: ${source}`)
}

function assertNoLinks(root: string): void {
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) {
        throw new Error(`Electron runtime staging contains a link that was not materialized: ${absolute}`)
      }
      if (stats.isDirectory()) walk(absolute)
    }
  }
  walk(root)
}

/**
 * Stage fresh, run-owned compiled tool output into the MCP packaging
 * project's ignored generated directory so the deploy export includes it.
 * A stale or deleted generated tree cannot survive this copy.
 */
function stageGeneratedRuntimeTree(rootDir: string, mcpDistDir: string): void {
  const generatedDir = path.join(rootDir, 'packages', 'freshell-mcp-runtime', 'generated')
  const freshellMcpSource = path.join(mcpDistDir, 'freshell-mcp')
  const nodeClientSource = path.join(mcpDistDir, 'node-client-runtime')
  for (const required of [freshellMcpSource, nodeClientSource]) {
    if (!existsSync(required)) {
      throw new Error(`Required Electron runtime input is missing (run build:tools first): ${required}`)
    }
  }
  removePath(generatedDir)
  copyRequiredDirectory(freshellMcpSource, path.join(generatedDir, 'freshell-mcp'))
  copyRequiredDirectory(nodeClientSource, path.join(generatedDir, 'node-client-runtime'))
}

/**
 * Stage a deploy export's node_modules while dropping pnpm's install-state
 * directory: in a hoisted deploy `node_modules/.pnpm` holds only the
 * modules-state lock.yaml, not runtime content, and the installed runtime
 * must not carry lock machinery (plan section 6.2, item 5).
 */
function stageDeployNodeModules(
  source: string,
  destination: string,
  deployRoot: string,
  packageName: DeployableRuntimePackage,
): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.pnpm') continue
    materializeEntry(path.join(source, entry.name), path.join(destination, entry.name), deployRoot, packageName)
  }
}

/**
 * Map the sidecar deploy export onto claude-sidecar/.  Every root-level
 * entry is copied except the deploy lock; node_modules is materialized so
 * the staged sidecar has zero links.
 */
function stageSidecarFromDeploy(
  deployDir: string,
  destinationDir: string,
  deployRoot: string,
): void {
  for (const entry of readdirSync(deployDir, { withFileTypes: true })) {
    if (entry.name === 'pnpm-lock.yaml') continue
    if (entry.name === 'node_modules') {
      stageDeployNodeModules(path.join(deployDir, entry.name), path.join(destinationDir, 'node_modules'), deployRoot, 'freshell-claude-sidecar')
      continue
    }
    materializeEntry(path.join(deployDir, entry.name), path.join(destinationDir, entry.name), deployRoot, 'freshell-claude-sidecar')
  }
  if (!existsSync(path.join(destinationDir, 'package.json'))) {
    throw new Error('The freshell-claude-sidecar deploy output must include package.json')
  }
}

/**
 * pnpm's deploy writes peer-resolution annotations like "1.30.0(zod@4.3.6)"
 * into the exported manifest's dependency specs.  The staged public metadata
 * keeps plain specs; peer resolution is proven by execution, not by the
 * installed runtime's manifest.
 */
function stripPeerSuffixAnnotation(spec: string): string {
  return spec.replace(/\([^)]*\)$/, '')
}

/**
 * Map the MCP runtime deploy export onto mcp/ and node-client-runtime/.
 * The deploy's own package.json is the private packaging manifest; the
 * staged metadata rewrites the public identity to name "freshell" with the
 * release version so the MCP handshake keeps reporting the application
 * version (the compiled server discovers its version by searching for that
 * name).
 */
function stageMcpFromDeploy(
  deployDir: string,
  mcpDestinationDir: string,
  nodeClientRuntimeDir: string,
  releaseVersion: string,
  deployRoot: string,
): void {
  const generatedDir = path.join(deployDir, 'generated')
  const mcpGenerated = path.join(generatedDir, 'freshell-mcp')
  const nodeClientGenerated = path.join(generatedDir, 'node-client-runtime')
  for (const required of [mcpGenerated, nodeClientGenerated]) {
    if (!existsSync(required)) {
      throw new Error(`The freshell-mcp-runtime deploy output is missing the generated runtime tree: ${required}`)
    }
  }
  materializeTree(mcpGenerated, mcpDestinationDir, deployRoot, 'freshell-mcp-runtime')
  materializeTree(nodeClientGenerated, nodeClientRuntimeDir, deployRoot, 'freshell-mcp-runtime')
  stageDeployNodeModules(path.join(deployDir, 'node_modules'), path.join(mcpDestinationDir, 'node_modules'), deployRoot, 'freshell-mcp-runtime')

  const packaging = readJson(path.join(deployDir, 'package.json'))
  const dependencies = packaging.dependencies && typeof packaging.dependencies === 'object'
    ? packaging.dependencies as Record<string, unknown>
    : {}
  const stagedManifest = {
    name: 'freshell',
    version: releaseVersion,
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(
      Object.entries(dependencies).map(([name, spec]) => [name, stripPeerSuffixAnnotation(String(spec))]),
    ),
  }
  writeFileSync(path.join(mcpDestinationDir, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`)
}

async function downloadFile(url: string, destination: string): Promise<void> {
  mkdirSync(path.dirname(destination), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const request = (sourceUrl: string): void => {
      const client = sourceUrl.startsWith('https:') ? https : http
      const req = client.get(sourceUrl, (response) => {
        const statusCode = response.statusCode ?? 0
        const location = response.headers.location
        if (statusCode >= 300 && statusCode < 400 && location) {
          response.resume()
          request(new URL(location, sourceUrl).toString())
          return
        }
        if (statusCode !== 200) {
          response.resume()
          reject(new Error(`Download failed for ${sourceUrl}: HTTP ${statusCode}`))
          return
        }
        pipeline(response, createWriteStream(destination)).then(resolve, reject)
      })
      req.on('error', reject)
    }
    request(url)
  })
}

async function downloadText(url: string): Promise<string> {
  const destination = path.join(__dirname, `.checksums-${process.pid}-${Date.now()}.txt`)
  try {
    await downloadFile(url, destination)
    return readFileSync(destination, 'utf8')
  } finally {
    removePath(destination)
  }
}

export function sha256File(filePath: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(filePath))
  return hash.digest('hex')
}

export function expectedNodeArchiveSha256(
  checksumsText: string,
  archiveName: string,
): string {
  const row = checksumsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith(`  ${archiveName}`) || line.endsWith(` *${archiveName}`))
  if (!row) throw new Error(`Node checksum is missing for ${archiveName}`)
  const digest = row.split(/\s+/)[0]
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error(`Node checksum is malformed for ${archiveName}`)
  return digest.toLowerCase()
}

async function downloadNodeArchive(
  version: string,
  platform: ElectronRuntimePlatform,
  arch: ElectronRuntimeArch,
  archivePath: string,
): Promise<void> {
  const archiveName = getNodeArchiveName(version, platform, arch)
  await downloadFile(getNodeDownloadUrl(version, platform, arch), archivePath)
  const checksums = await downloadText(getNodeChecksumsUrl(version))
  const expected = expectedNodeArchiveSha256(checksums, archiveName)
  const actual = sha256File(archivePath)
  if (actual !== expected) {
    throw new Error(`Node archive integrity check failed for ${archiveName}`)
  }
}

async function extractZipMember(archivePath: string, member: string, destination: string): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (error, file) => {
      if (error) reject(error)
      else resolve(file)
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', () => reject(new Error(`Node archive is missing ${member}`)))
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== member) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (error, input) => {
          if (error) {
            reject(error)
            return
          }
          if (!input) {
            reject(new Error(`Cannot read ${member} from Node archive`))
            return
          }
          void pipeline(input, createWriteStream(destination)).then(resolve, reject)
        })
      })
      zip.readEntry()
    })
  } catch (error) {
    removePath(destination)
    throw error
  } finally {
    zip.close()
  }
}

export async function extractNodeArchive(
  version: string,
  platform: ElectronRuntimePlatform,
  arch: ElectronRuntimeArch,
  archivePath: string,
  binaryPath: string,
): Promise<void> {
  mkdirSync(path.dirname(binaryPath), { recursive: true })
  if (platform === 'win32') {
    await extractZipMember(archivePath, `node-v${version}-win-${arch}/node.exe`, binaryPath)
    return
  }
  const extractionDir = path.join(path.dirname(archivePath), `extract-${platform}-${arch}`)
  removePath(extractionDir)
  mkdirSync(extractionDir, { recursive: true })
  try {
    // Keep tar isolated to the Unix archive-extraction branch.
    const tar = await import('tar')
    const member = `node-v${version}-${platform}-${arch}/bin/node`
    await tar.x({
      file: archivePath,
      cwd: extractionDir,
      strip: 2,
      filter: (entryPath: string) => entryPath === member,
    })
    copyRequiredFile(path.join(extractionDir, 'node'), binaryPath)
    ensureExecutable(binaryPath)
  } finally {
    removePath(extractionDir)
  }
}

async function ensureNodeBinary(
  options: ElectronRuntimeStageOptions,
  version: string,
  platform: ElectronRuntimePlatform,
  arch: ElectronRuntimeArch,
  destination: string,
  stagingDir: string,
): Promise<void> {
  if (options.nodeBinary) {
    copyRequiredFile(options.nodeBinary, destination)
    if (platform !== 'win32') ensureExecutable(destination)
    return
  }
  const archivePath = path.join(stagingDir, `.download-${getNodeArchiveName(version, platform, arch)}`)
  try {
    await (options.downloadNodeBinary ?? (async ({ version: v, platform: p, arch: a, destination: d }) => {
      await downloadNodeArchive(v, p, a, archivePath)
      await extractNodeArchive(v, p, a, archivePath, d)
    }))({ version, platform, arch, destination })
  } finally {
    removePath(archivePath)
  }
  if (!existsSync(destination)) throw new Error(`Node runtime downloader did not produce ${destination}`)
  if (platform !== 'win32') ensureExecutable(destination)
}

function listFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute, relative)
      else files.push(relative)
    }
  }
  walk(root, '')
  return files.sort()
}

export async function stageElectronRuntime(
  options: ElectronRuntimeStageOptions = {},
): Promise<ElectronRuntimeStageReceipt> {
  const rootDir = path.resolve(options.rootDir ?? PROJECT_ROOT)
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  assertPlatform(platform)
  assertArch(arch)
  // pnpm deploy resolves host-native dependencies (including the Claude SDK's
  // platform-specific optional package), so real staging must run on the
  // native runner for the requested target.  Fixture tests inject deploys.
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      `Electron runtime staging for ${platform}/${arch} must run on that native runner: ` +
        'pnpm deploy installs host-native dependencies (stage on the target platform instead).',
    )
  }
  const runtimeDir = path.resolve(options.runtimeDir ?? path.join(rootDir, 'electron-runtime'))
  const rootPackageJsonPath = path.join(rootDir, 'package.json')
  const rootPackageJson = readJson(rootPackageJsonPath)
  const releaseVersion = options.releaseVersion
    ?? (typeof rootPackageJson.version === 'string' ? rootPackageJson.version : undefined)
  if (!releaseVersion) throw new Error('The root package.json must contain a release version')
  const nodeVersion = options.nodeVersion
    ?? (readJson(path.join(rootDir, 'scripts', 'bundled-node-version.json')).version as string | undefined)
  if (!nodeVersion) throw new Error('bundled-node-version.json must contain a Node version')

  const serverBinary = options.serverBinary ?? path.join(rootDir, 'target', 'release', getRuntimeBinaryName(platform))
  const clientDir = options.clientDir ?? path.join(rootDir, 'dist', 'client')
  const mcpDistDir = options.mcpDistDir ?? path.join(rootDir, 'dist', 'tools')
  const workspaceLockPath = path.join(rootDir, 'pnpm-lock.yaml')
  if (!existsSync(workspaceLockPath)) {
    throw new Error(`The pnpm workspace lock is required for Electron runtime staging: ${workspaceLockPath}`)
  }

  stageGeneratedRuntimeTree(rootDir, mcpDistDir)

  const deploy = options.deployRuntime ?? ((args: DeployRuntimeArgs) => deployRuntimeDefault(rootDir, args))
  const sidecarDeployDir = mkdtempSync(path.join(tmpdir(), 'freshell-sidecar-deploy-'))
  const mcpDeployDir = mkdtempSync(path.join(tmpdir(), 'freshell-mcp-deploy-'))
  const stagingDir = `${runtimeDir}.staging`
  try {
    deploy({ packageName: 'freshell-claude-sidecar', destination: sidecarDeployDir })
    deploy({ packageName: 'freshell-mcp-runtime', destination: mcpDeployDir })
    const sidecarIdentity = readDeployIdentity(sidecarDeployDir, 'freshell-claude-sidecar')
    const mcpIdentity = readDeployIdentity(mcpDeployDir, 'freshell-mcp-runtime')
    const packageManagerVersion = capturePackageManagerVersion(rootDir, options.packageManagerVersion)
    const sourceLockFingerprint = sha256File(workspaceLockPath)

    removePath(stagingDir)
    mkdirSync(stagingDir, { recursive: true })
    const paths = getRuntimePaths(stagingDir, platform)
    copyRequiredFile(serverBinary, paths.serverBinary)
    if (platform !== 'win32') ensureExecutable(paths.serverBinary)
    copyRequiredDirectory(clientDir, paths.clientDir)
    await ensureNodeBinary(options, nodeVersion, platform, arch, paths.nodeBinary, stagingDir)
    const sidecarDeployRoot = realpathSync(sidecarDeployDir)
    const mcpDeployRoot = realpathSync(mcpDeployDir)
    stageSidecarFromDeploy(sidecarDeployDir, paths.claudeSidecarDir, sidecarDeployRoot)
    stageMcpFromDeploy(mcpDeployDir, paths.mcpDir, paths.nodeClientRuntimeDir, releaseVersion, mcpDeployRoot)

    for (const required of getRuntimeAllowlist(platform).requiredFiles) {
      if (!existsSync(path.join(stagingDir, required))) {
        throw new Error(`Electron runtime staging is missing required file: ${required}`)
      }
    }
    const files = listFiles(stagingDir)
    const unapproved = findUnapprovedRuntimePaths(files, platform)
    if (unapproved.length > 0) {
      throw new Error(`Electron runtime staging produced unapproved files: ${unapproved.join(', ')}`)
    }
    assertNoLinks(stagingDir)

    const fileHashes = Object.fromEntries(
      files.map((relativePath) => [relativePath, sha256File(path.join(stagingDir, relativePath))]),
    )
    const receipt: ElectronRuntimeStageReceipt = {
      severity: 'info',
      event: 'electron_runtime_prepared',
      runtimeDir,
      platform,
      arch,
      releaseVersion,
      nodeVersion,
      packageManager: { name: 'pnpm', version: packageManagerVersion },
      sourceLockFingerprint,
      exportedPackages: [
        sidecarIdentity,
        mcpIdentity,
        { name: 'freshell', version: releaseVersion },
      ],
      files,
      fileHashes,
    }
    writeFileSync(path.join(stagingDir, RUNTIME_LAYOUT.receipt), `${JSON.stringify(receipt, null, 2)}\n`)
    removePath(runtimeDir)
    renameSync(stagingDir, runtimeDir)
    return receipt
  } catch (error) {
    removePath(stagingDir)
    throw error
  } finally {
    removePath(sidecarDeployDir)
    removePath(mcpDeployDir)
  }
}

function parseOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const platform = (parseOption(args, '--platform') ?? process.platform) as ElectronRuntimePlatform
  const arch = (parseOption(args, '--arch') ?? process.arch) as ElectronRuntimeArch
  const receipt = await stageElectronRuntime({ platform, arch })
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

const isMainModule = process.argv[1]
  && (process.argv[1].endsWith('prepare-electron-runtime.ts') || process.argv[1].endsWith('prepare-electron-runtime.js'))

if (isMainModule) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown Electron runtime preparation failure'
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'electron_runtime_prepare_failed', message })}\n`)
    process.exitCode = 1
  })
}
