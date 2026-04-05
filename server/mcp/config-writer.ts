/**
 * MCP config injection for per-agent spawn-time MCP server configuration.
 *
 * Each coding CLI agent has its own mechanism for accepting MCP server config.
 * This module generates the appropriate args/env for each agent mode and
 * handles cleanup when terminals exit.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Walk up to find the repo root (contains package.json with name "freshell")
function findRepoRoot(): string {
  let dir = __dirname
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(resolve(dir, 'package.json'), 'utf-8'))
      if (pkg.name === 'freshell') return dir
    } catch { /* keep walking */ }
    dir = dirname(dir)
  }
  // Fallback: assume 2 levels up from server/mcp/
  return resolve(__dirname, '..', '..')
}

function getTmpDir(): string {
  return path.join(os.tmpdir(), 'freshell-mcp')
}

function getTmpFilePath(terminalId: string): string {
  return path.join(getTmpDir(), `${terminalId}.json`)
}

/**
 * Detect whether we're running inside WSL (Windows Subsystem for Linux).
 */
function isWslEnvironment(): boolean {
  return process.platform === 'linux' && (
    !!process.env.WSL_DISTRO_NAME ||
    !!process.env.WSL_INTEROP ||
    !!process.env.WSLENV
  )
}

/**
 * Convert a Linux path to a Windows UNC path using wslpath.
 * Only works inside WSL. Returns the original path if conversion fails.
 */
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
    // wslpath not available or failed -- return original path
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
export function buildMcpServerCommandArgs(platform?: 'unix' | 'windows'): string[] {
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

/**
 * Write a JSON config file for agents that use file-based MCP config
 * (Claude, Gemini, Kimi).
 *
 * When platform is 'windows', the returned file path is converted to a
 * Windows UNC path (on WSL) so Windows-native agent processes can read it.
 * The config file itself is always written to the Linux tmp directory.
 */
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

  // Return Windows path if the agent is a Windows process on WSL
  if (platform === 'windows' && isWslEnvironment()) {
    return convertToWindowsPath(filePath)
  }
  return filePath
}

/**
 * Escape a string for use as a TOML value (double-quoted string).
 */
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

/**
 * Acquire a simple lock file for serializing concurrent sidecar read/writes.
 * Uses writeFileSync with O_EXCL (wx flag) for atomic creation.
 * Retries up to 5 times with a small delay via busy-wait.
 * Returns true if the lock was acquired, allowing releaseLock to be idempotent.
 */
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
      return // Lock acquired
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Check if the lock is stale (> 30 seconds old)
        try {
          const stat = fs.statSync(lockPath)
          if (Date.now() - stat.mtimeMs > 30_000) {
            // Stale lock; remove and retry
            try { fs.unlinkSync(lockPath) } catch { /* race */ }
            continue
          }
        } catch { /* stat failed, retry */ }
        // Synchronous sleep without CPU burn (Atomics.wait blocks the thread
        // for the specified duration without spinning)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
        continue
      }
      throw err
    }
  }
  // After max retries, throw instead of proceeding without lock
  throw new Error(
    `Failed to acquire lock at ${lockPath} after ${maxRetries} retries. `
    + `Another process may be holding it. Check for stale lock files.`,
  )
}

/**
 * Release the lock file. Only removes the lock if this process acquired it,
 * preventing removal of another process's active lock.
 */
function releaseLock(cwd: string): void {
  if (!_lockAcquired) return // Never acquired -- nothing to release
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
      // Codex uses -c flags for inline TOML config (no temp file needed)
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

      // Validate that the cwd directory itself exists before creating .opencode/ inside it.
      // Per project philosophy: "Clear, user friendly errors are generally better than fallbacks."
      // Without this check, mkdirSync({recursive:true}) would silently create directories
      // for invalid/mistyped cwd paths, which is confusing to debug.
      //
      // Assumption: cwd is always a valid Linux/POSIX path by the time it reaches here.
      // On WSL, buildSpawnSpec passes the resolved unixCwd (via resolveUnixShellCwd which
      // converts Windows-style paths like D:\project to /mnt/d/project) to the MCP injection
      // pipeline, not the raw input cwd. This ensures existsSync works correctly on Linux.
      if (!fs.existsSync(cwd)) {
        throw new Error(
          `Cannot inject MCP config for OpenCode: cwd directory does not exist: ${cwd}. `
          + 'Verify the terminal working directory is correct.',
        )
      }

      // Design note (WSL cwd path handling):
      // On WSL, the cwd is a Linux path (e.g., /home/user/project). OpenCode processes
      // (even when spawned via Windows shells like cmd.exe or powershell.exe) access the
      // same filesystem via UNC paths (\\wsl.localhost\...) or /mnt/... mount points.
      // Writing .opencode/opencode.json under the Linux cwd is correct because the Linux
      // path and the Windows-accessible path resolve to the same physical file.
      const configPath = getOpenCodeConfigPath(cwd)
      const dirPath = path.dirname(configPath)

      // Acquire lock to serialize concurrent config + sidecar read-writes.
      // Config read MUST happen inside the locked section to prevent races
      // where two processes read the same config, then both write.
      acquireLock(cwd)
      try {
        // Track whether we're creating the directory/file
        const dirExists = fs.existsSync(dirPath)
        const fileExists = fs.existsSync(configPath)

        // Read existing config or start fresh (inside lock for serialization)
        let existingConfig: any = {}
        if (fileExists) {
          let parsed: unknown
          try {
            parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
          } catch {
            // Malformed JSON -- surface a clear error instead of silently replacing.
            // Per project philosophy: "Clear, user friendly errors are generally better than fallbacks."
            throw new Error(
              `Cannot inject MCP config: existing ${configPath} contains malformed JSON. `
              + `Please fix or remove the file manually, then retry.`,
            )
          }
          // Validate that the parsed value is a non-null, non-array object.
          // Valid-but-wrong shapes (null, 42, "string", []) would cause TypeErrors
          // when trying to access/set properties like .mcp.freshell.
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(
              `Cannot inject MCP config: existing ${configPath} is not a valid object `
              + `(found ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}). `
              + `Expected a JSON object like {"mcp": {...}}. `
              + `Please fix or remove the file manually, then retry.`,
            )
          }
          existingConfig = parsed
          // Validate the mcp field is an object if present (not a string, number, etc.)
          if (existingConfig.mcp != null && (typeof existingConfig.mcp !== 'object' || Array.isArray(existingConfig.mcp))) {
            throw new Error(
              `Cannot inject MCP config: the "mcp" field in ${configPath} is not a valid object `
              + `(found ${Array.isArray(existingConfig.mcp) ? 'array' : typeof existingConfig.mcp}). `
              + `Expected "mcp" to be an object like {"freshell": {...}}. `
              + `Please fix or remove the file manually, then retry.`,
            )
          }
        }

        // Read existing sidecar
        const existingSidecar = readSidecar(cwd)

        // Check if a pre-existing user-managed freshell entry exists.
        // User-managed means either:
        //   (a) mcp.freshell exists and there is no sidecar (first encounter), OR
        //   (b) mcp.freshell exists and the sidecar has createdEntry=false
        //       (subsequent spawns after the first encounter created a sidecar)
        const preExistingFreshell = existingConfig.mcp?.freshell != null
        const userManaged = preExistingFreshell && (
          !existingSidecar || existingSidecar.createdEntry === false
        )

        if (!userManaged) {
          // Merge freshell MCP entry (safe: either no entry exists, or sidecar
          // tracks it as Freshell-managed)
          const serverArgs = buildMcpServerCommandArgs(platform)
          if (!existingConfig.mcp) existingConfig.mcp = {}
          existingConfig.mcp.freshell = {
            type: 'local',
            command: ['node', ...serverArgs],
          }

          // Write config
          if (!dirExists) fs.mkdirSync(dirPath, { recursive: true })
          fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), { mode: 0o600 })
        } else {
          // User-managed: ensure directory exists for sidecar but do not touch config
          if (!dirExists) fs.mkdirSync(dirPath, { recursive: true })
        }

        // Track whether Freshell created the freshell entry
        const createdEntry = !preExistingFreshell

        // Update sidecar
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
  // Delete temp file (for claude, gemini, kimi)
  try {
    const tmpPath = getTmpFilePath(terminalId)
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath)
    }
  } catch {
    // Best-effort cleanup
  }

  // OpenCode-specific cleanup
  if (mode === 'opencode' && cwd) {
    cleanupOpenCode(cwd)
  }
}

function cleanupOpenCode(cwd: string): void {
  try {
    // Acquire lock to serialize concurrent sidecar read-writes
    acquireLock(cwd)
    try {
      const sidecar = readSidecar(cwd)
      if (!sidecar) return // No sidecar = user-managed; don't touch

      if (sidecar.refCount > 1) {
        // Decrement and rewrite sidecar only.
        writeSidecar(cwd, { ...sidecar, refCount: sidecar.refCount - 1 })
        return
      }

      // refCount <= 1: conditionally remove the freshell key
      const configPath = getOpenCodeConfigPath(cwd)
      const sidecarPath = getOpenCodeSidecarPath(cwd)

      // If Freshell did not create the entry (createdEntry === false),
      // the user had a pre-existing freshell entry. Do not remove it.
      if (sidecar.createdEntry === false) {
        // Just clean up sidecar
        try { fs.unlinkSync(sidecarPath) } catch { /* best-effort */ }
        return
      }

      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        if (config.mcp) {
          delete config.mcp.freshell
        }

        // Check if the config only had the freshell entry
        const remainingMcpKeys = config.mcp ? Object.keys(config.mcp) : []
        // Check for any other top-level keys besides "mcp"
        const otherTopLevelKeys = Object.keys(config).filter(k => k !== 'mcp')

        if (remainingMcpKeys.length === 0 && otherTopLevelKeys.length === 0 && sidecar.createdFile) {
          // Freshell created this file and it's now empty -- delete it
          fs.unlinkSync(configPath)
          // Also delete sidecar
          fs.unlinkSync(sidecarPath)
          // If we created the dir and it's now empty, remove it
          if (sidecar.createdDir) {
            try { fs.rmdirSync(path.dirname(configPath)) } catch { /* may not be empty */ }
          }
        } else {
          // Other MCP entries remain -- rewrite without freshell
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
          // Delete sidecar
          fs.unlinkSync(sidecarPath)
        }
      } catch {
        // Config read failed -- just clean up sidecar
        try { fs.unlinkSync(sidecarPath) } catch { /* best-effort */ }
      }
    } finally {
      releaseLock(cwd)
    }
  } catch {
    // Best-effort cleanup
  }
}
