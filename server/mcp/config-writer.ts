// MCP config injection for per-agent spawn-time MCP server configuration.
// Generates args/env for each agent mode and handles cleanup on terminal exit.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function findRepoRoot(): string {
  let dir = __dirname
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(resolve(dir, 'package.json'), 'utf-8'))
      if (pkg.name === 'freshell') return dir
    } catch { /* keep walking */ }
    dir = dirname(dir)
  }
  return resolve(__dirname, '..', '..')
}

function getTmpDir(): string {
  return path.join(os.tmpdir(), 'freshell-mcp')
}

function getTmpFilePath(terminalId: string): string {
  return path.join(getTmpDir(), `${terminalId}.json`)
}

function isWslEnvironment(): boolean {
  return process.platform === 'linux' && (
    !!process.env.WSL_DISTRO_NAME ||
    !!process.env.WSL_INTEROP ||
    !!process.env.WSLENV
  )
}

function convertToWindowsPath(linuxPath: string): string {
  if (!isWslEnvironment()) return linuxPath
  try {
    const result = execFileSync('wslpath', ['-w', linuxPath], {
      timeout: 3000,
      encoding: 'utf-8',
    })
    const trimmed = result.trim()
    return trimmed || linuxPath
  } catch {
    return linuxPath
  }
}

function resolveDependencyPath(specifier: string): string {
  try {
    return require.resolve(specifier)
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` ${error.message}` : ''
    throw new Error(`Unable to resolve MCP dependency "${specifier}". Ensure project dependencies are installed.${detail}`)
  }
}

/**
 * Build the MCP server command + args for the given environment.
 * In production: node <repoRoot>/dist/server/mcp/server.js
 * In development: node --import <repoRoot>/node_modules/tsx/dist/esm/index.mjs <repoRoot>/server/mcp/server.ts
 *
 * When platform is 'windows' and running on WSL, paths are converted to
 * Windows UNC format so Windows-native agent processes can resolve them.
 */
function buildMcpServerCommandArgs(platform?: 'unix' | 'windows'): string[] {
  const repoRoot = findRepoRoot()
  const needsWinPaths = platform === 'windows' && isWslEnvironment()
  const resolveRepoPath = (p: string) => needsWinPaths ? convertToWindowsPath(resolve(repoRoot, p)) : resolve(repoRoot, p)
  const resolveDependencyForPlatform = (specifier: string) => {
    const resolved = resolveDependencyPath(specifier)
    return needsWinPaths ? convertToWindowsPath(resolved) : resolved
  }

  if (process.env.NODE_ENV === 'production') {
    return [resolveRepoPath('dist/server/mcp/server.js')]
  }
  return [
    '--import',
    resolveDependencyForPlatform('tsx'),
    resolveRepoPath('server/mcp/server.ts'),
  ]
}

function writeMcpConfigFile(terminalId: string, platform?: 'unix' | 'windows'): string {
  const tmpDir = getTmpDir()
  fs.mkdirSync(tmpDir, { recursive: true })
  const filePath = getTmpFilePath(terminalId)
  const serverArgs = buildMcpServerCommandArgs(platform)
  const config = {
    mcpServers: {
      freshell: {
        command: 'node',
        args: serverArgs,
      },
    },
  }
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 })

  if (platform === 'windows' && isWslEnvironment()) {
    return convertToWindowsPath(filePath)
  }
  return filePath
}

function tomlEscape(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// ---------------------------------------------------------------------------
// OpenCode sidecar tracking
// ---------------------------------------------------------------------------

type OpenCodeSidecar = {
  managedKey: string
  refCount: number
  createdDir: boolean
  createdFile: boolean
  createdEntry: boolean
}

function getOpenCodeConfigPath(cwd: string): string {
  return path.join(cwd, '.opencode', 'opencode.json')
}

function getOpenCodeSidecarPath(cwd: string): string {
  return path.join(cwd, '.opencode', '.freshell-mcp-state.json')
}

function getOpenCodeLockPath(cwd: string): string {
  return path.join(cwd, '.opencode', '.freshell-mcp-state.lock')
}

let _lockAcquired = false

function acquireLock(cwd: string): void {
  _lockAcquired = false
  const lockPath = getOpenCodeLockPath(cwd)
  const dirPath = path.dirname(lockPath)
  try { fs.mkdirSync(dirPath, { recursive: true }) } catch { /* may exist */ }

  const maxRetries = 5
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 })
      _lockAcquired = true
      return
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockPath)
          if (Date.now() - stat.mtimeMs > 30_000) {
            try { fs.unlinkSync(lockPath) } catch { /* race */ }
            continue
          }
        } catch { /* stat failed, retry */ }
        const end = Date.now() + 100
        while (Date.now() < end) { /* spin */ }
        continue
      }
      throw err
    }
  }
  throw new Error(
    `Failed to acquire lock at ${lockPath} after ${maxRetries} retries. `
    + `Another process may be holding it. Check for stale lock files.`,
  )
}

function releaseLock(cwd: string): void {
  if (!_lockAcquired) return
  try {
    fs.unlinkSync(getOpenCodeLockPath(cwd))
  } catch {
    // Best-effort cleanup
  } finally {
    _lockAcquired = false
  }
}

function readSidecar(cwd: string): OpenCodeSidecar | null {
  try {
    return JSON.parse(fs.readFileSync(getOpenCodeSidecarPath(cwd), 'utf-8'))
  } catch {
    return null
  }
}

function writeSidecar(cwd: string, sidecar: OpenCodeSidecar): void {
  fs.writeFileSync(getOpenCodeSidecarPath(cwd), JSON.stringify(sidecar, null, 2), { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Per-agent config generation
// ---------------------------------------------------------------------------

export type McpInjection = {
  args: string[]
  env: Record<string, string>
}

export function generateMcpInjection(
  mode: string,
  terminalId: string,
  cwd?: string,
  platform?: 'unix' | 'windows',
): McpInjection {
  switch (mode) {
    case 'claude': {
      const filePath = writeMcpConfigFile(terminalId, platform)
      return { args: ['--mcp-config', filePath], env: {} }
    }

    case 'codex': {
      const serverArgs = buildMcpServerCommandArgs(platform)
      const tomlArgs = serverArgs.map(a => tomlEscape(a)).join(', ')
      return {
        args: [
          '-c', `mcp_servers.freshell.command=${tomlEscape('node')}`,
          '-c', `mcp_servers.freshell.args=[${tomlArgs}]`,
        ],
        env: {},
      }
    }

    case 'gemini': {
      const filePath = writeMcpConfigFile(terminalId, platform)
      return { args: [], env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: filePath } }
    }

    case 'kimi': {
      const filePath = writeMcpConfigFile(terminalId, platform)
      return { args: ['--mcp-config-file', filePath], env: {} }
    }

    case 'opencode': {
      if (!cwd) {
        throw new Error(
          'Cannot inject MCP config for OpenCode: cwd is required to write project-local '
          + '.opencode/opencode.json but was not provided.',
        )
      }

      if (!fs.existsSync(cwd)) {
        throw new Error(
          `Cannot inject MCP config for OpenCode: cwd directory does not exist: ${cwd}. `
          + 'Verify the terminal working directory is correct.',
        )
      }

      const configPath = getOpenCodeConfigPath(cwd)
      const dirPath = path.dirname(configPath)

      acquireLock(cwd)
      try {
        const dirExists = fs.existsSync(dirPath)
        const fileExists = fs.existsSync(configPath)

        let existingConfig: any = {}
        if (fileExists) {
          let parsed: unknown
          try {
            parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
          } catch {
            throw new Error(
              `Cannot inject MCP config: existing ${configPath} contains malformed JSON. `
              + `Please fix or remove the file manually, then retry.`,
            )
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(
              `Cannot inject MCP config: existing ${configPath} is not a valid object `
              + `(found ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}). `
              + `Expected a JSON object like {"mcp": {...}}. `
              + `Please fix or remove the file manually, then retry.`,
            )
          }
          existingConfig = parsed
          if (existingConfig.mcp != null && (typeof existingConfig.mcp !== 'object' || Array.isArray(existingConfig.mcp))) {
            throw new Error(
              `Cannot inject MCP config: the "mcp" field in ${configPath} is not a valid object `
              + `(found ${Array.isArray(existingConfig.mcp) ? 'array' : typeof existingConfig.mcp}). `
              + `Expected "mcp" to be an object like {"freshell": {...}}. `
              + `Please fix or remove the file manually, then retry.`,
            )
          }
        }

        const existingSidecar = readSidecar(cwd)

        const preExistingFreshell = existingConfig.mcp?.freshell != null
        const userManaged = preExistingFreshell && (
          !existingSidecar || existingSidecar.createdEntry === false
        )

        if (!userManaged) {
          const serverArgs = buildMcpServerCommandArgs(platform)
          if (!existingConfig.mcp) existingConfig.mcp = {}
          existingConfig.mcp.freshell = {
            type: 'local',
            command: ['node', ...serverArgs],
          }

          if (!dirExists) fs.mkdirSync(dirPath, { recursive: true })
          fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), { mode: 0o600 })
        } else {
          if (!dirExists) fs.mkdirSync(dirPath, { recursive: true })
        }

        const createdEntry = !preExistingFreshell

        const sidecar: OpenCodeSidecar = existingSidecar
          ? { ...existingSidecar, refCount: existingSidecar.refCount + 1 }
          : {
              managedKey: 'freshell',
              refCount: 1,
              createdDir: !dirExists,
              createdFile: !fileExists,
              createdEntry,
            }
        writeSidecar(cwd, sidecar)
      } finally {
        releaseLock(cwd)
      }

      return { args: [], env: {} }
    }

    case 'shell':
      return { args: [], env: {} }

    default:
      return { args: [], env: {} }
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function cleanupMcpConfig(
  terminalId: string,
  mode?: string,
  cwd?: string,
): void {
  try {
    const tmpPath = getTmpFilePath(terminalId)
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath)
    }
  } catch {
    // Best-effort cleanup
  }

  if (mode === 'opencode' && cwd) {
    cleanupOpenCode(cwd)
  }
}

function cleanupOpenCode(cwd: string): void {
  try {
    acquireLock(cwd)
    try {
      const sidecar = readSidecar(cwd)
      if (!sidecar) return

      if (sidecar.refCount > 1) {
        writeSidecar(cwd, { ...sidecar, refCount: sidecar.refCount - 1 })
        return
      }

      const configPath = getOpenCodeConfigPath(cwd)
      const sidecarPath = getOpenCodeSidecarPath(cwd)

      if (sidecar.createdEntry === false) {
        try { fs.unlinkSync(sidecarPath) } catch { /* best-effort */ }
        return
      }

      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        if (config.mcp) {
          delete config.mcp.freshell
        }

        const remainingMcpKeys = config.mcp ? Object.keys(config.mcp) : []
        const otherTopLevelKeys = Object.keys(config).filter(k => k !== 'mcp')

        if (remainingMcpKeys.length === 0 && otherTopLevelKeys.length === 0 && sidecar.createdFile) {
          fs.unlinkSync(configPath)
          fs.unlinkSync(sidecarPath)
          if (sidecar.createdDir) {
            try { fs.rmdirSync(path.dirname(configPath)) } catch { /* may not be empty */ }
          }
        } else {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
          fs.unlinkSync(sidecarPath)
        }
      } catch {
        try { fs.unlinkSync(sidecarPath) } catch { /* best-effort */ }
      }
    } finally {
      releaseLock(cwd)
    }
  } catch {
    // Best-effort cleanup
  }
}
