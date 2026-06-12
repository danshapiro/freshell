/**
 * Prepare bundled Node.js binary and recompile native modules.
 *
 * This script is the critical piece of the Electron packaging pipeline.
 * It performs three sequential tasks:
 * 1. Download the standalone Node.js binary from nodejs.org
 * 2. Download Node.js headers (required by node-gyp for native module compilation)
 * 3. Recompile node-pty against the bundled Node's headers
 *
 * The script is run as a pre-step before electron-builder packages the app.
 *
 * Usage: npx tsx scripts/prepare-bundled-node.ts
 *
 * Helper functions are exported for unit testing.
 */

import { execFileSync } from 'child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
  createWriteStream,
  readdirSync,
} from 'fs'
import http from 'http'
import https from 'https'
import { createRequire } from 'module'
import path from 'path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'url'
import tar from 'tar'

const extractZip = (await import('extract-zip')).default
const require = createRequire(import.meta.url)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

function removePath(targetPath: string): void {
  rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  })
}

// --- Exported helper functions (testable) ---

/**
 * Validate that the headers directory contains the required node_api.h file.
 * Throws if the headers are missing or incomplete.
 */
export function validateHeaders(
  headersDir: string,
  existsFn: (p: string) => boolean = existsSync
): void {
  const nodeApiHeader = path.join(headersDir, 'include', 'node', 'node_api.h')
  if (!existsFn(nodeApiHeader)) {
    throw new Error(
      `Missing node_api.h in headers directory: expected at ${nodeApiHeader}. ` +
        'Ensure the Node.js headers tarball was extracted correctly.'
    )
  }
}

/**
 * Build the node-gyp rebuild command string with the correct target and nodedir flags.
 */
export function buildNodeGypCommand(
  version: string,
  headersDir: string
): string {
  return `npx node-gyp rebuild --target=${version} --nodedir=${headersDir}`
}

/**
 * Read the bundled Node.js version from bundled-node-version.json.
 */
export function getBundledNodeVersion(
  readFileFn: (p: string, enc: string) => string = (p, enc) =>
    readFileSync(p, enc as BufferEncoding)
): string {
  const versionFile = path.join(PROJECT_ROOT, 'scripts', 'bundled-node-version.json')
  const { version } = JSON.parse(readFileFn(versionFile, 'utf-8'))
  return version
}

/**
 * Get the download URL for the standalone Node.js binary.
 */
export function getNodeDownloadUrl(
  version: string,
  platform: string,
  arch: string
): string {
  const base = `https://nodejs.org/dist/v${version}`
  if (platform === 'win32') {
    return `${base}/node-v${version}-win-${arch}.zip`
  }
  return `${base}/node-v${version}-${platform}-${arch}.tar.gz`
}

/**
 * Get the download URL for Node.js headers.
 */
export function getHeadersDownloadUrl(version: string): string {
  return `https://nodejs.org/dist/v${version}/node-v${version}-headers.tar.gz`
}

/**
 * electron-builder expands ${os} to win/mac/linux, not Node's win32/darwin.
 * Stage bundled binaries under those directory names so extraResources can
 * resolve them consistently on native Windows builds.
 */
export function getElectronBuilderOs(platform: string): string {
  if (platform === 'win32') return 'win'
  if (platform === 'darwin') return 'mac'
  return platform
}

export function getBundledNodeBinaryName(platform: string): string {
  return platform === 'win32' ? 'node.exe' : 'node'
}

export function getBundledNodeBinaryPath(
  bundledNodeDir: string,
  platform: string,
  arch: string,
): string {
  return path.join(
    bundledNodeDir,
    getElectronBuilderOs(platform),
    arch,
    getBundledNodeBinaryName(platform),
  )
}

export function getWindowsNodeImportLibraryPath(headersDir: string): string {
  return path.join(headersDir, 'Release', 'node.lib')
}

export function getWindowsNodeImportLibraryDownloadUrl(
  version: string,
  arch: string,
): string {
  return `https://nodejs.org/dist/v${version}/win-${arch}/node.lib`
}

export function getCompiledNativeModuleFilenames(
  releaseDir: string,
  readDirFn: (dir: string) => string[] = readdirSync,
): string[] {
  return readDirFn(releaseDir).filter((entry) => entry.endsWith('.node'))
}

/**
 * Get paths for staging native modules.
 */
export function getStagingPaths(): {
  nativeModulesDir: string
  nodePtyTarget: string
  bundledNodeDir: string
} {
  const bundledNodeDir = path.join(PROJECT_ROOT, 'bundled-node')
  const nativeModulesDir = path.join(bundledNodeDir, 'native-modules')
  const nodePtyTarget = path.join(nativeModulesDir, 'node-pty')
  return { nativeModulesDir, nodePtyTarget, bundledNodeDir }
}

function resolvePackageRoot(packageName: string): string {
  const localPackageRoot = path.join(PROJECT_ROOT, 'node_modules', packageName)
  if (existsSync(path.join(localPackageRoot, 'package.json'))) {
    return localPackageRoot
  }

  return path.dirname(require.resolve(`${packageName}/package.json`))
}

function resolveNodeGypBin(): string {
  const localNodeGypBin = path.join(
    PROJECT_ROOT,
    'node_modules',
    'node-gyp',
    'bin',
    'node-gyp.js',
  )
  if (existsSync(localNodeGypBin)) {
    return localNodeGypBin
  }

  return require.resolve('node-gyp/bin/node-gyp.js')
}

export function resolveNpmCli(
  npmExecPath = process.env.npm_execpath,
  existsFn = existsSync,
): string {
  if (npmExecPath && existsFn(npmExecPath)) {
    return npmExecPath
  }

  const localNpmCli = path.join(
    PROJECT_ROOT,
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  )
  if (existsFn(localNpmCli)) {
    return localNpmCli
  }

  return require.resolve('npm/bin/npm-cli.js')
}

async function downloadFile(url: string, destination: string): Promise<void> {
  mkdirSync(path.dirname(destination), { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const request = (sourceUrl: string): void => {
      const client = sourceUrl.startsWith('https:') ? https : http
      const req = client.get(sourceUrl, (res) => {
        const statusCode = res.statusCode ?? 0
        const location = res.headers.location

        if (statusCode >= 300 && statusCode < 400 && location) {
          res.resume()
          request(new URL(location, sourceUrl).toString())
          return
        }

        if (statusCode !== 200) {
          res.resume()
          reject(new Error(`Download failed for ${sourceUrl}: HTTP ${statusCode}`))
          return
        }

        pipeline(res, createWriteStream(destination)).then(resolve, reject)
      })

      req.on('error', reject)
    }

    request(url)
  })
}

async function extractNodeBinary(
  version: string,
  platform: string,
  arch: string,
  archivePath: string,
  binaryPath: string,
): Promise<void> {
  const tmpDir = path.join(path.dirname(archivePath), `extract-${platform}-${arch}`)
  removePath(tmpDir)
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(path.dirname(binaryPath), { recursive: true })

  try {
    if (platform === 'win32') {
      await extractZip(archivePath, { dir: tmpDir })
      cpSync(
        path.join(tmpDir, `node-v${version}-win-${arch}`, 'node.exe'),
        binaryPath,
      )
      return
    }

    const member = `node-v${version}-${platform}-${arch}/bin/node`
    await tar.x({
      file: archivePath,
      cwd: tmpDir,
      strip: 2,
      filter: (entryPath: string) => entryPath === member,
    })
    cpSync(path.join(tmpDir, 'node'), binaryPath)
  } finally {
    removePath(tmpDir)
  }
}

async function prepareWindowsNodeImportLibrary(
  version: string,
  arch: string,
  bundledNodeDir: string,
  headersDir: string,
): Promise<void> {
  if (process.platform !== 'win32') return

  const nodeLibPath = getWindowsNodeImportLibraryPath(headersDir)
  if (existsSync(nodeLibPath)) {
    console.log(`Windows Node.js import library already exists at ${nodeLibPath}, skipping`)
    return
  }

  const downloadUrl = getWindowsNodeImportLibraryDownloadUrl(version, arch)

  console.log(`Downloading Windows Node.js import library from ${downloadUrl}...`)
  await downloadFile(downloadUrl, nodeLibPath)
  console.log(`Windows Node.js import library placed at ${nodeLibPath}`)
}

async function prepareNodeBinary(
  version: string,
  platform: string,
  arch: string,
  bundledNodeDir: string,
): Promise<void> {
  const binaryPath = getBundledNodeBinaryPath(bundledNodeDir, platform, arch)
  if (existsSync(binaryPath)) {
    console.log(`Bundled Node.js binary already exists at ${binaryPath}, skipping`)
    return
  }

  const downloadUrl = getNodeDownloadUrl(version, platform, arch)
  const archivePath = path.join(
    bundledNodeDir,
    `node-${platform}-${arch}${platform === 'win32' ? '.zip' : '.tar.gz'}`,
  )

  console.log(`Downloading Node.js binary from ${downloadUrl}...`)
  await downloadFile(downloadUrl, archivePath)
  await extractNodeBinary(version, platform, arch, archivePath, binaryPath)
  removePath(archivePath)
  console.log(`Node.js binary placed at ${binaryPath}`)
}

// --- Main script execution ---

async function main(): Promise<void> {
  const version = getBundledNodeVersion()
  const platform = process.platform
  const arch = process.arch

  console.log(`Preparing bundled Node.js v${version} for ${platform}-${arch}`)

  const { bundledNodeDir, nativeModulesDir, nodePtyTarget } = getStagingPaths()

  // Step 1: Download Node.js binary for the current native platform.
  await prepareNodeBinary(version, platform, arch, bundledNodeDir)

  // Step 1b: Download Node.js binaries for cross-build targets
  // When building on Linux, also download the Windows binary so
  // electron-builder can package it for Windows.
  const crossTargets: Array<{ platform: string; arch: string }> = []
  if (platform !== 'win32') crossTargets.push({ platform: 'win32', arch })
  if (platform !== 'linux') crossTargets.push({ platform: 'linux', arch })

  for (const target of crossTargets) {
    await prepareNodeBinary(version, target.platform, target.arch, bundledNodeDir)
  }

  // Step 2: Download Node.js headers
  const headersBaseDir = path.join(bundledNodeDir, 'headers')
  mkdirSync(headersBaseDir, { recursive: true })

  const headersUrl = getHeadersDownloadUrl(version)
  console.log(`Downloading Node.js headers from ${headersUrl}...`)

  const headersArchivePath = path.join(headersBaseDir, `node-v${version}-headers.tar.gz`)
  await downloadFile(headersUrl, headersArchivePath)
  await tar.x({ file: headersArchivePath, cwd: headersBaseDir })
  removePath(headersArchivePath)

  const headersDir = path.join(headersBaseDir, `node-v${version}`)
  validateHeaders(headersDir)
  console.log(`Node.js headers extracted to ${headersDir}`)
  await prepareWindowsNodeImportLibrary(version, arch, bundledNodeDir, headersDir)

  // Step 3: Recompile node-pty against bundled Node headers
  const nodePtyDir = resolvePackageRoot('node-pty')
  const gypCmd = buildNodeGypCommand(version, headersDir)

  console.log(`Recompiling node-pty with: ${gypCmd}`)
  execFileSync(process.execPath, [
    resolveNodeGypBin(),
    'rebuild',
    `--target=${version}`,
    `--nodedir=${headersDir}`,
  ], { cwd: nodePtyDir, stdio: 'inherit' })

  // Stage the compiled native module
  mkdirSync(path.join(nodePtyTarget, 'build', 'Release'), { recursive: true })

  const nodePtyReleaseDir = path.join(nodePtyDir, 'build', 'Release')
  const compiledNativeModules = getCompiledNativeModuleFilenames(nodePtyReleaseDir)
  if (compiledNativeModules.length === 0) {
    throw new Error(`No compiled node-pty .node files found in ${nodePtyReleaseDir}`)
  }

  for (const filename of compiledNativeModules) {
    cpSync(
      path.join(nodePtyReleaseDir, filename),
      path.join(nodePtyTarget, 'build', 'Release', filename)
    )
  }

  // Copy node-pty JS files (excluding the build directory, except for the Release binary)
  cpSync(nodePtyDir, nodePtyTarget, {
    recursive: true,
    filter: (src) =>
      !src.includes('build') ||
      src.endsWith('Release/pty.node') ||
      src.includes('Release'),
  })

  console.log(`Recompiled node-pty staged at ${nodePtyTarget}`)

  // Step 4: Prune and stage server node_modules
  const serverNodeModulesDir = path.join(PROJECT_ROOT, 'server-node-modules')
  const stagingDir = path.join(PROJECT_ROOT, 'server-node-modules-staging')

  console.log('Pruning and staging server node_modules...')

  // Clean up any previous staging
  removePath(serverNodeModulesDir)
  removePath(stagingDir)
  mkdirSync(stagingDir, { recursive: true })

  // Copy package.json to staging, stripping comment entries (keys starting
  // with "//") that newer npm versions reject as invalid package names.
  const pkgRaw = readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw)
  for (const section of ['dependencies', 'devDependencies']) {
    if (pkg[section]) {
      for (const key of Object.keys(pkg[section])) {
        if (key.startsWith('//')) delete pkg[section][key]
      }
    }
  }
  writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify(pkg, null, 2))
  if (existsSync(path.join(PROJECT_ROOT, 'package-lock.json'))) {
    cpSync(
      path.join(PROJECT_ROOT, 'package-lock.json'),
      path.join(stagingDir, 'package-lock.json')
    )
  }

  // Install production-only dependencies
  execFileSync(process.execPath, [resolveNpmCli(), 'ci', '--omit=dev'], { cwd: stagingDir, stdio: 'inherit' })

  // Move the resulting node_modules
  cpSync(
    path.join(stagingDir, 'node_modules'),
    serverNodeModulesDir,
    { recursive: true }
  )

  // Remove node-pty's native binary from pruned modules
  // (it was compiled against the dev machine's Node, not the bundled one)
  const prunedNodePtyBuild = path.join(serverNodeModulesDir, 'node-pty', 'build')
  if (existsSync(prunedNodePtyBuild)) {
    removePath(prunedNodePtyBuild)
  }

  // Clean up staging
  removePath(stagingDir)

  console.log(`Server node_modules staged at ${serverNodeModulesDir}`)
  console.log('Bundled Node.js preparation complete!')
}

// Only run main() when executed directly (not imported by tests)
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('prepare-bundled-node.ts') ||
    process.argv[1].endsWith('prepare-bundled-node.js'))

if (isMainModule) {
  main().catch((err) => {
    console.error('Failed to prepare bundled Node.js:', err)
    process.exit(1)
  })
}
