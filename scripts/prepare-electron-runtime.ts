/**
 * Build the files that electron-builder places beside the application.
 *
 * The desktop application has one backend: the native Rust executable.  The
 * standalone Node runtime is deliberately kept as a client runtime for the
 * Claude SDK sidecar and the stdio MCP client only.  Keeping this layout in a
 * small, declarative producer makes it possible for the verifier and the
 * checkout-free integration test to inspect the exact same artifact.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const PROJECT_ROOT = path.resolve(__dirname, '..')

export type ElectronRuntimePlatform = 'darwin' | 'linux' | 'win32'
export type ElectronRuntimeArch = 'x64' | 'arm64'

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
  claudePackage: 'claude-sidecar/package.json',
  claudeLock: 'claude-sidecar/package-lock.json',
  claudeDependencies: 'claude-sidecar/node_modules',
  mcpEntry: 'mcp/server.js',
  mcpPackage: 'mcp/package.json',
  mcpLock: 'mcp/package-lock.json',
  mcpDependencies: 'mcp/node_modules',
  nodeClientRuntime: 'node-client-runtime',
  receipt: '.electron-runtime-receipt.json',
  electronArchive: 'app.asar',
  electronUnpackedClaudeSdk: 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk',
  launchChooser: 'launch-chooser',
  trayAssets: 'assets',
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
 * Recursive entries are intentional: client assets and the locked sidecar/MCP
 * dependency trees contain many files. Everything else must be named here or
 * the verifier rejects it, including an otherwise innocuous extra script. The
 * Electron-only entries account for the app archive, tray/chooser resources,
 * and the SDK package that electron-builder unpacks from the app archive.
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
    RUNTIME_LAYOUT.claudePackage,
    RUNTIME_LAYOUT.claudeLock,
    `${RUNTIME_LAYOUT.claudeDependencies}/@anthropic-ai/claude-agent-sdk/package.json`,
    RUNTIME_LAYOUT.mcpEntry,
    RUNTIME_LAYOUT.mcpPackage,
    RUNTIME_LAYOUT.mcpLock,
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

interface LockPackage {
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optional?: boolean
  os?: string[]
  cpu?: string[]
}

export interface NpmLockfile {
  name?: string
  version?: string
  lockfileVersion?: number
  requires?: boolean
  packages?: Record<string, LockPackage>
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
  claudeSidecarDir?: string
  /** Root dist/tools directory containing freshell-mcp and node-client-runtime. */
  mcpDistDir?: string
  rootNodeModulesDir?: string
  rootPackageLockPath?: string
  sidecarNodeModulesDir?: string
  sidecarPackageLockPath?: string
  /** Injected archive downloader for offline/unit tests. */
  downloadNodeBinary?: (args: {
    version: string
    platform: ElectronRuntimePlatform
    arch: ElectronRuntimeArch
    destination: string
  }) => Promise<void>
}

export interface ElectronRuntimeStageReceipt {
  severity: 'info'
  event: 'electron_runtime_prepared'
  runtimeDir: string
  platform: ElectronRuntimePlatform
  arch: ElectronRuntimeArch
  releaseVersion: string
  nodeVersion: string
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

/**
 * Resolve an npm package location using npm lockfile v3's physical layout.
 * Starting at the importing package and walking parents mirrors Node's
 * node_modules lookup, including nested packages selected by npm.
 */
function resolveLockedPackagePath(
  packages: Record<string, LockPackage>,
  packageName: string,
  fromPackagePath = '',
): string | undefined {
  let parent = fromPackagePath
  while (true) {
    const candidate = parent
      ? `${parent}/node_modules/${packageName}`
      : `node_modules/${packageName}`
    if (packages[candidate]) return candidate

    const nestedMarker = parent.lastIndexOf('/node_modules/')
    if (nestedMarker >= 0) {
      parent = parent.slice(0, nestedMarker)
    } else {
      parent = ''
    }
    if (!parent && packages[`node_modules/${packageName}`]) {
      return `node_modules/${packageName}`
    }
    if (!parent) return undefined
  }
}

function packageNameFromLockPath(lockPath: string): string {
  return lockPath.startsWith('node_modules/')
    ? lockPath.slice('node_modules/'.length)
    : lockPath
}

/**
 * Return the sorted physical package paths needed by the requested roots.
 * Peer dependencies are opt-in: MCP supplies zod as an explicit root, while
 * the sidecar asks for peers because its SDK declares them as peers.
 */
export function collectProductionDependencyClosure(
  lockfile: NpmLockfile,
  roots: string[],
  options: {
    includePeerDependencies?: boolean
    platform?: ElectronRuntimePlatform
    arch?: ElectronRuntimeArch
  } = {},
): string[] {
  const packages = lockfile.packages ?? {}
  const queue: Array<{ name: string; from: string }> = roots.map((name) => ({ name, from: '' }))
  const visited = new Set<string>()
  const selected = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()!
    const lockPath = resolveLockedPackagePath(packages, current.name, current.from)
    if (!lockPath || visited.has(lockPath)) continue
    const metadata = packages[lockPath]
    const compatibleOs = !metadata.os || metadata.os.length === 0 || metadata.os.includes(options.platform ?? process.platform)
    const compatibleCpu = !metadata.cpu || metadata.cpu.length === 0 || metadata.cpu.includes(options.arch ?? process.arch)
    if (!compatibleOs || !compatibleCpu) continue
    visited.add(lockPath)
    selected.add(lockPath)
    for (const name of Object.keys(metadata.dependencies ?? {})) queue.push({ name, from: lockPath })
    for (const name of Object.keys(metadata.optionalDependencies ?? {})) queue.push({ name, from: lockPath })
    if (options.includePeerDependencies) {
      for (const name of Object.keys(metadata.peerDependencies ?? {})) queue.push({ name, from: lockPath })
    }
  }

  return [...selected]
    .map(packageNameFromLockPath)
    .sort((a, b) => a.localeCompare(b))
}

function removePath(targetPath: string): void {
  rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
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

function copyDirectoryContents(source: string, destination: string): void {
  if (!existsSync(source)) throw new Error(`Required Electron runtime directory is missing: ${source}`)
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(path.join(source, entry.name), path.join(destination, entry.name), { recursive: entry.isDirectory() })
  }
}

function packageSourcePath(nodeModulesDir: string, packagePath: string): string {
  return path.join(nodeModulesDir, packagePath)
}

function copyDependencyClosure(
  sourceNodeModulesDir: string,
  destinationNodeModulesDir: string,
  lockfile: NpmLockfile,
  packageNames: string[],
  options: {
    includePeerDependencies?: boolean
    platform?: ElectronRuntimePlatform
    arch?: ElectronRuntimeArch
  } = {},
): string[] {
  const packagePaths = collectProductionDependencyClosure(lockfile, packageNames, options)
  for (const packagePath of packagePaths) {
    copyRequiredDirectory(
      packageSourcePath(sourceNodeModulesDir, packagePath),
      path.join(destinationNodeModulesDir, packagePath),
    )
  }
  return packagePaths
}

function packageSpec(rootPackage: Record<string, unknown>, name: string, version: string): string {
  const dependencies = rootPackage.dependencies
  if (dependencies && typeof dependencies === 'object' && name in dependencies) {
    const requested = (dependencies as Record<string, unknown>)[name]
    if (typeof requested === 'string') return requested
  }
  return version
}

function makeSubsetLockfile(
  rootLockfile: NpmLockfile,
  packagePaths: string[],
  rootDependencies: string[],
  packageJson: Record<string, unknown>,
  releaseVersion: string,
): NpmLockfile {
  const sourcePackages = rootLockfile.packages ?? {}
  const packages: Record<string, LockPackage> = {
    '': {
      version: releaseVersion,
      dependencies: {},
    },
  }
  for (const packagePath of packagePaths) {
    const lockPath = `node_modules/${packagePath}`
    const metadata = sourcePackages[lockPath]
    if (metadata) packages[lockPath] = metadata
  }
  for (const name of rootDependencies) {
    const lockPath = `node_modules/${name}`
    const metadata = sourcePackages[lockPath]
    if (!metadata?.version || !packages[''].dependencies) {
      throw new Error(`Locked package metadata is missing for MCP dependency ${name}`)
    }
    packages[''].dependencies[name] = packageSpec(packageJson, name, metadata.version)
  }
  return {
    name: 'freshell',
    version: releaseVersion,
    lockfileVersion: 3,
    requires: true,
    packages,
  }
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
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
  const destination = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    `.checksums-${process.pid}-${Date.now()}.txt`,
  )
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

async function extractNodeArchive(
  version: string,
  platform: ElectronRuntimePlatform,
  arch: ElectronRuntimeArch,
  archivePath: string,
  binaryPath: string,
): Promise<void> {
  const extractionDir = path.join(path.dirname(archivePath), `extract-${platform}-${arch}`)
  removePath(extractionDir)
  mkdirSync(extractionDir, { recursive: true })
  mkdirSync(path.dirname(binaryPath), { recursive: true })
  try {
    if (platform === 'win32') {
      const extractZip = (await import('extract-zip')).default
      await extractZip(archivePath, { dir: extractionDir })
      copyRequiredFile(
        path.join(extractionDir, `node-v${version}-win-${arch}`, 'node.exe'),
        binaryPath,
      )
    } else {
      // tar does not ship declarations; keep this dynamic import isolated to
      // the archive-extraction branch so staging retains the existing runtime
      // dependency without adding a type-only package.
      // @ts-expect-error tar has no bundled TypeScript declarations.
      const tar = await import('tar')
      const member = `node-v${version}-${platform}-${arch}/bin/node`
      await tar.x({
        file: archivePath,
        cwd: extractionDir,
        strip: 2,
        filter: (entryPath: string) => entryPath === member,
      })
      copyRequiredFile(path.join(extractionDir, 'node'), binaryPath)
    }
    if (platform !== 'win32') chmodSync(binaryPath, 0o755)
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
  runtimeDir: string,
): Promise<void> {
  if (options.nodeBinary) {
    copyRequiredFile(options.nodeBinary, destination)
    if (platform !== 'win32') chmodSync(destination, statSync(destination).mode & 0o777)
    return
  }
  const archivePath = path.join(runtimeDir, `.download-${getNodeArchiveName(version, platform, arch)}`)
  try {
    await (options.downloadNodeBinary ?? (async ({ version: v, platform: p, arch: a, destination: d }) => {
      await downloadNodeArchive(v, p, a, archivePath)
      await extractNodeArchive(v, p, a, archivePath, d)
    }))({ version, platform, arch, destination })
  } finally {
    removePath(archivePath)
  }
  if (!existsSync(destination)) throw new Error(`Node runtime downloader did not produce ${destination}`)
}

function copySidecar(
  sourceDir: string,
  destinationDir: string,
  sourceNodeModulesDir: string,
  sourceLockfile: NpmLockfile,
  platform: ElectronRuntimePlatform,
  arch: ElectronRuntimeArch,
): void {
  for (const name of ['index.mjs', 'permission-channel.mjs', 'package.json', 'package-lock.json']) {
    const source = path.join(sourceDir, name)
    if (existsSync(source)) copyRequiredFile(source, path.join(destinationDir, name))
  }
  const packageJson = path.join(destinationDir, 'package.json')
  if (!existsSync(packageJson)) throw new Error('Claude sidecar package.json is required')
  copyDependencyClosure(
    sourceNodeModulesDir,
    path.join(destinationDir, 'node_modules'),
    sourceLockfile,
    ['@anthropic-ai/claude-agent-sdk'],
    { includePeerDependencies: true, platform, arch },
  )
}

function copyMcp(
  sourceDistDir: string,
  destinationDir: string,
  nodeClientRuntimeDir: string,
  sourceNodeModulesDir: string,
  sourceLockfile: NpmLockfile,
  rootPackageJson: Record<string, unknown>,
  releaseVersion: string,
  platform: ElectronRuntimePlatform,
  arch: ElectronRuntimeArch,
): void {
  // The compiled MCP entrypoint is intentionally rooted at mcp/server.js.
  // Its imports use ./freshell-tool.js and ../node-client-runtime, so retain
  // the two compiled directories' contents while dropping their source-only
  // dist/tools parent.
  copyDirectoryContents(path.join(sourceDistDir, 'freshell-mcp'), destinationDir)
  copyDirectoryContents(path.join(sourceDistDir, 'node-client-runtime'), nodeClientRuntimeDir)

  const packageNames = ['@modelcontextprotocol/sdk', 'zod']
  const packagePaths = collectProductionDependencyClosure(sourceLockfile, packageNames, { platform, arch })
  for (const packageName of packageNames) {
    if (!packagePaths.includes(packageName)) {
      throw new Error(`Locked MCP dependency is missing: ${packageName}`)
    }
  }
  for (const packagePath of packagePaths) {
    copyRequiredDirectory(
      packageSourcePath(sourceNodeModulesDir, packagePath),
      path.join(destinationDir, 'node_modules', packagePath),
    )
  }
  const packageJson: Record<string, unknown> = {
    name: 'freshell',
    version: releaseVersion,
    private: true,
    type: 'module',
    dependencies: {
      '@modelcontextprotocol/sdk': packageSpec(rootPackageJson, '@modelcontextprotocol/sdk', sourceLockfile.packages?.['node_modules/@modelcontextprotocol/sdk']?.version ?? 'latest'),
      zod: packageSpec(rootPackageJson, 'zod', sourceLockfile.packages?.['node_modules/zod']?.version ?? 'latest'),
    },
  }
  mkdirSync(destinationDir, { recursive: true })
  writeFileSync(path.join(destinationDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
  writeFileSync(path.join(destinationDir, 'package-lock.json'), `${JSON.stringify(makeSubsetLockfile(sourceLockfile, packagePaths, packageNames, packageJson, releaseVersion), null, 2)}\n`)
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
  const runtimeDir = path.resolve(options.runtimeDir ?? path.join(rootDir, 'electron-runtime'))
  const paths = getRuntimePaths(runtimeDir, platform)
  const rootPackageJsonPath = path.join(rootDir, 'package.json')
  const rootPackageJson = readJson(rootPackageJsonPath)
  const releaseVersion = options.releaseVersion
    ?? (typeof rootPackageJson.version === 'string' ? rootPackageJson.version : undefined)
  if (!releaseVersion) throw new Error('The root package.json must contain a release version')
  const nodeVersion = options.nodeVersion
    ?? (readJson(path.join(rootDir, 'scripts', 'bundled-node-version.json')).version as string | undefined)
  if (!nodeVersion) throw new Error('bundled-node-version.json must contain a Node version')

  const serverBinary = options.serverBinary
    ?? path.join(rootDir, 'target', 'release', getRuntimeBinaryName(platform))
  const clientDir = options.clientDir ?? path.join(rootDir, 'dist', 'client')
  const nodeBinary = options.nodeBinary
  const sidecarDir = options.claudeSidecarDir ?? path.join(rootDir, 'crates', 'freshell-claude-sidecar')
  const mcpDistDir = options.mcpDistDir ?? path.join(rootDir, 'dist', 'tools')
  const rootNodeModulesDir = options.rootNodeModulesDir ?? path.join(rootDir, 'node_modules')
  const rootPackageLockPath = options.rootPackageLockPath ?? path.join(rootDir, 'package-lock.json')
  const sourceRootLock = readJson(rootPackageLockPath) as NpmLockfile
  const sidecarPackageLockPath = options.sidecarPackageLockPath ?? path.join(sidecarDir, 'package-lock.json')
  const sidecarLock = existsSync(sidecarPackageLockPath)
    ? readJson(sidecarPackageLockPath) as NpmLockfile
    : { packages: {} }
  const sidecarNodeModulesDir = options.sidecarNodeModulesDir ?? path.join(sidecarDir, 'node_modules')

  removePath(runtimeDir)
  mkdirSync(runtimeDir, { recursive: true })
  copyRequiredFile(serverBinary, paths.serverBinary)
  if (platform !== 'win32') chmodSync(paths.serverBinary, statSync(paths.serverBinary).mode & 0o777)
  copyRequiredDirectory(clientDir, paths.clientDir)
  await ensureNodeBinary(options, nodeVersion, platform, arch, paths.nodeBinary, runtimeDir)
  copySidecar(sidecarDir, paths.claudeSidecarDir, sidecarNodeModulesDir, sidecarLock, platform, arch)
  copyMcp(mcpDistDir, paths.mcpDir, paths.nodeClientRuntimeDir, rootNodeModulesDir, sourceRootLock, rootPackageJson, releaseVersion, platform, arch)

  const files = listFiles(runtimeDir)
  const unapproved = findUnapprovedRuntimePaths(files, platform)
  if (unapproved.length > 0) {
    throw new Error(`Electron runtime staging produced unapproved files: ${unapproved.join(', ')}`)
  }
  const fileHashes = Object.fromEntries(
    files.map((relativePath) => [relativePath, sha256File(path.join(runtimeDir, relativePath))]),
  )
  const receipt: ElectronRuntimeStageReceipt = {
    severity: 'info',
    event: 'electron_runtime_prepared',
    runtimeDir,
    platform,
    arch,
    releaseVersion,
    nodeVersion,
    files,
    fileHashes,
  }
  writeFileSync(path.join(runtimeDir, '.electron-runtime-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt
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
