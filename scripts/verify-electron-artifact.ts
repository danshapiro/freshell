/** Verify an unpacked Electron runtime before an installer is published. */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  FORBIDDEN_RUNTIME_NAMES,
  getRuntimePaths,
  type ElectronRuntimePlatform,
} from './prepare-electron-runtime.js'

const AUTHENTICATION_REFUSAL = 'AUTH_TOKEN is required. Refusing to start without authentication.'
const PROBE_TIMEOUT_MS = 5_000

export interface ElectronArtifactProbeOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
}

export interface ElectronArtifactProbeResult {
  status: number | null
  stdout: string
  stderr: string
  signal?: NodeJS.Signals | null
  error?: Error
}

export interface VerifyElectronArtifactOptions {
  probe?: (command: string, options: ElectronArtifactProbeOptions) => ElectronArtifactProbeResult
  probeTimeoutMs?: number
  hostPlatform?: NodeJS.Platform
}

export interface ElectronArtifactVerificationReceipt {
  ok: true
  artifactPath: string
  platform: ElectronRuntimePlatform
  executed: boolean
  requiredFiles: string[]
  forbiddenFiles: string[]
}

const REQUIRED_RELATIVE_PATHS = [
  'client/index.html',
  'claude-sidecar/index.mjs',
  'claude-sidecar/package.json',
  'claude-sidecar/package-lock.json',
  'claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
  'mcp/server.js',
  'mcp/package.json',
  'mcp/package-lock.json',
  'mcp/node_modules/@modelcontextprotocol/sdk/package.json',
  'mcp/node_modules/zod/package.json',
  'node-client-runtime/keys.js',
  'node-client-runtime/action-capabilities.js',
]

function binaryRelativePath(platform: ElectronRuntimePlatform): string {
  return platform === 'win32' ? 'bin/freshell-server.exe' : 'bin/freshell-server'
}

function nodeRelativePath(platform: ElectronRuntimePlatform): string {
  return platform === 'win32' ? 'node/bin/node.exe' : 'node/bin/node'
}

function walkFiles(root: string): string[] {
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

function isForbidden(relativePath: string): boolean {
  const normalized = relativePath.replaceAll(path.sep, '/')
  if (normalized.endsWith('.node')) return true
  return FORBIDDEN_RUNTIME_NAMES.some((name) =>
    normalized === name || normalized.startsWith(`${name}/`) || normalized.includes(`/${name}/`),
  )
}

function checkBinaryFormat(binaryPath: string, platform: ElectronRuntimePlatform): void {
  const bytes = readFileSync(binaryPath).subarray(0, 4)
  const isElf = bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
  const isWindows = bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a
  const magic = bytes.readUInt32BE(0)
  const isMachO = magic === 0xfeedface || magic === 0xcefaedfe || magic === 0xfeedfacf || magic === 0xcffaedfe
  if ((platform === 'linux' && !isElf) || (platform === 'win32' && !isWindows) || (platform === 'darwin' && !isMachO)) {
    throw new Error(`Rust server binary has the wrong format for ${platform}`)
  }
}

function createProbeEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('FRESHELL_')) delete env[key]
  }
  for (const key of [
    'AUTH_TOKEN',
    'NODE_ENV',
    'NODE_PATH',
    'PORT',
    'HOST',
    'DOTENV_CONFIG_PATH',
    'XDG_CONFIG_HOME',
    'APPDATA',
    'LOCALAPPDATA',
  ]) delete env[key]
  // Point conventional config roots at the empty probe directory so a host
  // user's ~/.freshell cannot make the missing-token check pass accidentally.
  env.HOME = cwd
  env.USERPROFILE = cwd
  env.XDG_CONFIG_HOME = cwd
  env.APPDATA = cwd
  env.LOCALAPPDATA = cwd
  return env
}

function defaultProbe(command: string, options: ElectronArtifactProbeOptions): ElectronArtifactProbeResult {
  const result = spawnSync(command, [], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal,
    error: result.error,
  }
}

function readPackageName(packageJsonPath: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown }
    return typeof value.name === 'string' ? value.name : undefined
  } catch {
    return undefined
  }
}

export function verifyElectronArtifact(
  artifactPath: string,
  platform: ElectronRuntimePlatform,
  options: VerifyElectronArtifactOptions = {},
): ElectronArtifactVerificationReceipt {
  const root = path.resolve(artifactPath)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Electron artifact directory is missing: ${root}`)
  const paths = getRuntimePaths(root, platform)
  const required = [
    binaryRelativePath(platform),
    nodeRelativePath(platform),
    ...REQUIRED_RELATIVE_PATHS,
  ]
  for (const relative of required) {
    if (!existsSync(path.join(root, relative))) throw new Error(`Electron artifact is missing required file: ${relative}`)
  }
  if (readPackageName(paths.mcpPackageJson) !== 'freshell') throw new Error('Electron MCP package metadata must use name "freshell"')
  const mcpVersion = (() => {
    try {
      const value = JSON.parse(readFileSync(paths.mcpPackageJson, 'utf8')) as { version?: unknown }
      return typeof value.version === 'string' && value.version.length > 0 ? value.version : undefined
    } catch {
      return undefined
    }
  })()
  if (!mcpVersion) throw new Error('Electron MCP package metadata must include a release version')
  try {
    const lock = JSON.parse(readFileSync(path.join(root, 'mcp', 'package-lock.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (lock.name !== 'freshell' || lock.version !== mcpVersion) {
      throw new Error('MCP package-lock metadata does not match the staged package version')
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MCP package-lock metadata')) throw error
    throw new Error('MCP package-lock metadata is invalid')
  }

  const forbidden = walkFiles(root).filter(isForbidden)
  if (forbidden.length > 0) throw new Error(`Electron artifact contains forbidden files: ${forbidden.join(', ')}`)

  const serverBinary = path.join(root, binaryRelativePath(platform))
  checkBinaryFormat(serverBinary, platform)
  if (platform !== 'win32' && (statSync(serverBinary).mode & 0o111) === 0) {
    throw new Error('Rust server binary is not executable')
  }

  const hostPlatform = options.hostPlatform ?? process.platform
  if (platform !== hostPlatform) {
    return {
      ok: true,
      artifactPath: root,
      platform,
      executed: false,
      requiredFiles: required,
      forbiddenFiles: [],
    }
  }

  const probeCwd = mkdtempSync(path.join(tmpdir(), 'freshell-electron-probe-'))
  const timeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  let result: ElectronArtifactProbeResult
  try {
    result = (options.probe ?? defaultProbe)(serverBinary, {
      cwd: probeCwd,
      env: createProbeEnvironment(probeCwd),
      timeout,
    })
  } finally {
    rmSync(probeCwd, { recursive: true, force: true })
  }
  const output = `${result.stdout}\n${result.stderr}`
  if (result.error) throw new Error(`Rust server execution probe failed: ${result.error.message}`)
  if (result.status !== 1) throw new Error(`Rust server execution probe must exit with code 1, received ${String(result.status)}`)
  if (!output.includes(AUTHENTICATION_REFUSAL)) {
    throw new Error('Rust server execution probe did not report the expected authentication refusal')
  }
  if (/\blisten(?:ing)?\b/i.test(output)) {
    throw new Error('Rust server execution probe emitted a listen event before refusing authentication')
  }
  return {
    ok: true,
    artifactPath: root,
    platform,
    executed: true,
    requiredFiles: required,
    forbiddenFiles: [],
  }
}

function defaultArtifactPath(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return path.join(process.cwd(), 'release', 'mac', 'Freshell.app', 'Contents', 'Resources')
  if (platform === 'win32') return path.join(process.cwd(), 'release', 'win-unpacked', 'resources')
  return path.join(process.cwd(), 'release', 'linux-unpacked', 'resources')
}

function parsePlatform(value: string | undefined): ElectronRuntimePlatform {
  const platform = value ?? process.platform
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') throw new Error(`Unsupported Electron artifact platform: ${platform}`)
  return platform
}

function main(): void {
  const args = process.argv.slice(2)
  const pathArg = args[0] && !args[0].startsWith('--') ? args[0] : undefined
  const platformArgIndex = args.indexOf('--platform')
  const platform = parsePlatform(platformArgIndex >= 0 ? args[platformArgIndex + 1] : undefined)
  const artifactPath = pathArg ?? process.env.ELECTRON_ARTIFACT_PATH ?? defaultArtifactPath(platform)
  const receipt = verifyElectronArtifact(artifactPath, platform)
  process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'electron_artifact_verified', ...receipt })}\n`)
}

const isMainModule = process.argv[1]
  && (process.argv[1].endsWith('verify-electron-artifact.ts') || process.argv[1].endsWith('verify-electron-artifact.js'))

if (isMainModule) {
  try {
    main()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown Electron artifact verification failure'
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'electron_artifact_verification_failed', message })}\n`)
    process.exitCode = 1
  }
}
