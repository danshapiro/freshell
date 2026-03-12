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

import { execSync } from 'child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
} from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

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

// --- Main script execution ---

async function main(): Promise<void> {
  const version = getBundledNodeVersion()
  const platform = process.platform
  const arch = process.arch

  console.log(`Preparing bundled Node.js v${version} for ${platform}-${arch}`)

  const { bundledNodeDir, nativeModulesDir, nodePtyTarget } = getStagingPaths()

  // Step 1: Download Node.js binary
  const binaryDir = path.join(bundledNodeDir, platform, arch)
  mkdirSync(binaryDir, { recursive: true })

  const downloadUrl = getNodeDownloadUrl(version, platform, arch)
  console.log(`Downloading Node.js binary from ${downloadUrl}...`)

  if (platform === 'win32') {
    // Download and extract zip on Windows
    execSync(
      `curl -sL "${downloadUrl}" -o "${path.join(bundledNodeDir, 'node.zip')}" && ` +
        `cd "${bundledNodeDir}" && unzip -o node.zip "node-v${version}-win-${arch}/node.exe" -d tmp && ` +
        `mv "tmp/node-v${version}-win-${arch}/node.exe" "${binaryDir}/node.exe" && ` +
        'rm -rf tmp node.zip',
      { stdio: 'inherit' }
    )
  } else {
    // Download and extract tar.gz on macOS/Linux
    execSync(
      `curl -sL "${downloadUrl}" | tar xz -C "${bundledNodeDir}" --strip-components=1 ` +
        `"node-v${version}-${platform}-${arch}/bin/node" && ` +
        `mkdir -p "${binaryDir}" && mv "${path.join(bundledNodeDir, 'bin', 'node')}" "${binaryDir}/node" && ` +
        `rmdir "${path.join(bundledNodeDir, 'bin')}" 2>/dev/null || true`,
      { stdio: 'inherit' }
    )
  }

  console.log(`Node.js binary placed at ${binaryDir}`)

  // Step 1b: Download Node.js binaries for cross-build targets
  // When building on Linux, also download the Windows binary so
  // electron-builder can package it for Windows.
  const crossTargets: Array<{ plat: string; ar: string }> = []
  if (platform !== 'win32') crossTargets.push({ plat: 'win32', ar: arch })
  if (platform !== 'linux') crossTargets.push({ plat: 'linux', ar: arch })

  for (const target of crossTargets) {
    const targetDir = path.join(bundledNodeDir, target.plat === 'win32' ? 'win' : target.plat, target.ar)
    if (existsSync(path.join(targetDir, target.plat === 'win32' ? 'node.exe' : 'node'))) {
      console.log(`Cross-target ${target.plat}-${target.ar} already exists, skipping`)
      continue
    }
    mkdirSync(targetDir, { recursive: true })
    const targetUrl = getNodeDownloadUrl(version, target.plat, target.ar)
    console.log(`Downloading cross-target Node.js for ${target.plat}-${target.ar} from ${targetUrl}...`)

    if (target.plat === 'win32') {
      execSync(
        `curl -sL "${targetUrl}" -o "${path.join(bundledNodeDir, 'node-cross.zip')}" && ` +
          `cd "${bundledNodeDir}" && unzip -o node-cross.zip "node-v${version}-win-${target.ar}/node.exe" -d tmp-cross && ` +
          `mv "tmp-cross/node-v${version}-win-${target.ar}/node.exe" "${targetDir}/node.exe" && ` +
          'rm -rf tmp-cross node-cross.zip',
        { stdio: 'inherit' }
      )
    } else {
      execSync(
        `curl -sL "${targetUrl}" | tar xz -C "${bundledNodeDir}" --strip-components=1 ` +
          `"node-v${version}-${target.plat}-${target.ar}/bin/node" && ` +
          `mkdir -p "${targetDir}" && mv "${path.join(bundledNodeDir, 'bin', 'node')}" "${targetDir}/node" && ` +
          `rmdir "${path.join(bundledNodeDir, 'bin')}" 2>/dev/null || true`,
        { stdio: 'inherit' }
      )
    }
    console.log(`Cross-target Node.js binary placed at ${targetDir}`)
  }

  // Step 2: Download Node.js headers
  const headersBaseDir = path.join(bundledNodeDir, 'headers')
  mkdirSync(headersBaseDir, { recursive: true })

  const headersUrl = getHeadersDownloadUrl(version)
  console.log(`Downloading Node.js headers from ${headersUrl}...`)

  execSync(
    `curl -sL "${headersUrl}" | tar xz -C "${headersBaseDir}"`,
    { stdio: 'inherit' }
  )

  const headersDir = path.join(headersBaseDir, `node-v${version}`)
  validateHeaders(headersDir)
  console.log(`Node.js headers extracted to ${headersDir}`)

  // Step 3: Recompile node-pty against bundled Node headers
  const nodePtyDir = path.resolve(PROJECT_ROOT, 'node_modules', 'node-pty')
  const gypCmd = buildNodeGypCommand(version, headersDir)

  console.log(`Recompiling node-pty with: ${gypCmd}`)
  execSync(gypCmd, { cwd: nodePtyDir, stdio: 'inherit' })

  // Stage the compiled native module
  mkdirSync(path.join(nodePtyTarget, 'build', 'Release'), { recursive: true })

  // Copy the compiled .node file
  cpSync(
    path.join(nodePtyDir, 'build', 'Release', 'pty.node'),
    path.join(nodePtyTarget, 'build', 'Release', 'pty.node')
  )

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
  rmSync(serverNodeModulesDir, { recursive: true, force: true })
  rmSync(stagingDir, { recursive: true, force: true })
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
  execSync('npm ci --omit=dev', { cwd: stagingDir, stdio: 'inherit' })

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
    rmSync(prunedNodePtyBuild, { recursive: true, force: true })
  }

  // Clean up staging
  rmSync(stagingDir, { recursive: true, force: true })

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
