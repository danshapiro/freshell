/**
 * ExtensionManager — discovers, validates, and manages extension processes.
 *
 * Scans configured directories for subdirectories containing `freshell.json`,
 * validates each manifest against the Zod schema, maintains an in-memory
 * registry, and manages server extension process lifecycles.
 */
import fs from 'fs'
import net from 'net'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { ExtensionManifestSchema, type ExtensionManifest } from './extension-manifest.js'
import { logger } from './logger.js'
import type { ClientExtensionEntry } from '../shared/extension-types.js'

// Re-export so existing consumers don't break
export type { ClientExtensionEntry } from '../shared/extension-types.js'

// ──────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────

export interface ExtensionRegistryEntry {
  manifest: ExtensionManifest
  path: string            // filesystem path to extension dir
  serverPort?: number     // allocated port (server panes, set later)
}

// ──────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────

interface RunningProcess {
  process: ChildProcess
  port: number
}

// ──────────────────────────────────────────────────────────────
// ExtensionManager
// ──────────────────────────────────────────────────────────────

const MANIFEST_FILE = 'freshell.json'
const GRACEFUL_SHUTDOWN_MS = 5000

export class ExtensionManager {
  private registry = new Map<string, ExtensionRegistryEntry>()
  private processes = new Map<string, RunningProcess>()

  /**
   * Scan directories for extensions. Clears existing registry first.
   *
   * For each directory in `dirs`:
   * - Skip if it doesn't exist
   * - Read directory entries (only directories and symlinks)
   * - For each subdirectory, check if `freshell.json` exists
   * - Read and validate the manifest; skip invalid ones with a warning
   * - Skip duplicate names with a warning (first one wins)
   */
  scan(dirs: string[]): void {
    this.registry.clear()

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        logger.debug({ dir }, 'Extension scan: directory does not exist, skipping')
        continue
      }

      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (err) {
        logger.warn({ dir, err }, 'Extension scan: failed to read directory')
        continue
      }

      for (const entry of entries) {
        // Only consider directories and symlinks (symlinks may point to directories)
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue

        const extDir = path.join(dir, entry.name)
        const manifestPath = path.join(extDir, MANIFEST_FILE)

        if (!fs.existsSync(manifestPath)) continue

        let raw: string
        try {
          raw = fs.readFileSync(manifestPath, 'utf-8')
        } catch (err) {
          logger.warn({ manifestPath, err }, 'Extension scan: failed to read manifest file')
          continue
        }

        let json: unknown
        try {
          json = JSON.parse(raw)
        } catch (err) {
          logger.warn({ manifestPath, err }, 'Extension scan: invalid JSON in manifest')
          continue
        }

        const result = ExtensionManifestSchema.safeParse(json)
        if (!result.success) {
          logger.warn(
            { manifestPath, errors: result.error.format() },
            'Extension scan: invalid manifest',
          )
          continue
        }

        const manifest = result.data

        if (this.registry.has(manifest.name)) {
          logger.warn(
            { name: manifest.name, path: extDir, existingPath: this.registry.get(manifest.name)!.path },
            'Extension scan: duplicate name, skipping',
          )
          continue
        }

        this.registry.set(manifest.name, { manifest, path: extDir })
      }
    }

    logger.info(
      { count: this.registry.size, names: [...this.registry.keys()] },
      'Extension scan complete',
    )
  }

  /** Get a single registry entry by name. */
  get(name: string): ExtensionRegistryEntry | undefined {
    return this.registry.get(name)
  }

  /** Get all registry entries. */
  getAll(): ExtensionRegistryEntry[] {
    return [...this.registry.values()]
  }

  /** Serialize registry for the client — no filesystem paths, no process handles. */
  toClientRegistry(): ClientExtensionEntry[] {
    return this.getAll().map((entry): ClientExtensionEntry => {
      const { manifest, serverPort } = entry
      const running = this.isRunning(manifest.name)

      const clientEntry: ClientExtensionEntry = {
        name: manifest.name,
        version: manifest.version,
        label: manifest.label,
        description: manifest.description,
        category: manifest.category,
        serverRunning: running,
        serverPort,
      }

      if (manifest.icon) {
        clientEntry.iconUrl = `/api/extensions/${encodeURIComponent(manifest.name)}/icon`
      }

      if (manifest.url !== undefined) {
        clientEntry.url = manifest.url
      }

      if (manifest.contentSchema !== undefined) {
        clientEntry.contentSchema = manifest.contentSchema
      }

      if (manifest.picker !== undefined) {
        clientEntry.picker = manifest.picker
      }

      return clientEntry
    })
  }

  // ──────────────────────────────────────────────────────────────
  // Server process lifecycle
  // ──────────────────────────────────────────────────────────────

  /** Check if an extension's server process is running. */
  isRunning(name: string): boolean {
    return this.processes.has(name)
  }

  /** Get the allocated port for a running extension server. */
  getPort(name: string): number | undefined {
    return this.processes.get(name)?.port
  }

  /**
   * Start an extension's server process.
   *
   * 1. Look up extension — throw if not found or not category 'server'
   * 2. If already running, return existing port
   * 3. Allocate a free port (OS-assigned via net.createServer().listen(0))
   * 4. Build env vars from manifest, interpolating {{port}} and contentSchema defaults
   * 5. Spawn child process with server.command and server.args
   * 6. Watch stdout for server.readyPattern — resolve when matched
   * 7. If readyTimeout expires, kill process and reject
   */
  async startServer(name: string): Promise<number> {
    const entry = this.registry.get(name)
    if (!entry) {
      throw new Error(`Extension not found: '${name}'`)
    }
    if (entry.manifest.category !== 'server') {
      throw new Error(`Extension '${name}' is not a server extension (category: '${entry.manifest.category}')`)
    }

    // Already running — return existing port
    const existing = this.processes.get(name)
    if (existing) {
      return existing.port
    }

    const serverConfig = entry.manifest.server!
    const port = await allocateFreePort()

    // Set serverPort on registry entry
    entry.serverPort = port

    // Build environment variables with template interpolation
    const env = this.buildEnv(entry, port)

    const child = spawn(serverConfig.command, serverConfig.args, {
      cwd: entry.path,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const readyPattern = serverConfig.readyPattern
    const readyTimeout = serverConfig.readyTimeout

    try {
      await waitForReady(child, readyPattern, readyTimeout)
    } catch (err) {
      // Kill the process on failure and clean up
      child.kill('SIGKILL')
      entry.serverPort = undefined
      throw err
    }

    this.processes.set(name, { process: child, port })

    // If the process exits unexpectedly, clean up
    child.on('exit', () => {
      if (this.processes.get(name)?.process === child) {
        this.processes.delete(name)
        entry.serverPort = undefined
        logger.info({ name, port }, 'Extension server exited unexpectedly')
      }
    })

    logger.info({ name, port, pid: child.pid }, 'Extension server started')
    return port
  }

  /**
   * Stop an extension's server process.
   *
   * Sends SIGTERM, waits up to 5s for graceful exit, then SIGKILL.
   * No-op if not running or unknown.
   */
  async stopServer(name: string): Promise<void> {
    const running = this.processes.get(name)
    if (!running) return

    const { process: child, port } = running

    // Clean up bookkeeping immediately so isRunning() returns false
    this.processes.delete(name)
    const entry = this.registry.get(name)
    if (entry) {
      entry.serverPort = undefined
    }

    await killGracefully(child, GRACEFUL_SHUTDOWN_MS)

    logger.info({ name, port, pid: child.pid }, 'Extension server stopped')
  }

  /** Stop all running extension server processes. */
  async stopAll(): Promise<void> {
    const names = [...this.processes.keys()]
    await Promise.all(names.map((name) => this.stopServer(name)))
  }

  /**
   * Build env vars for a server extension, interpolating template variables.
   *
   * Template variables:
   * - {{port}} → allocated port number
   * - {{varName}} → contentSchema field's default value (if any)
   */
  private buildEnv(entry: ExtensionRegistryEntry, port: number): Record<string, string> {
    const serverConfig = entry.manifest.server!
    const rawEnv = serverConfig.env ?? {}

    // Build a lookup of contentSchema defaults
    const schemaDefaults: Record<string, string> = {}
    if (entry.manifest.contentSchema) {
      for (const [key, field] of Object.entries(entry.manifest.contentSchema)) {
        if (field.default !== undefined) {
          schemaDefaults[key] = String(field.default)
        }
      }
    }

    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawEnv)) {
      result[key] = value.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
        if (varName === 'port') return String(port)
        if (varName in schemaDefaults) return schemaDefaults[varName]
        return `{{${varName}}}` // Leave unresolved templates as-is
      })
    }

    return result
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers (module-private)
// ──────────────────────────────────────────────────────────────

/** Allocate a free port by letting the OS pick one. */
function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')))
        return
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

/**
 * Wait for a child process's stdout to emit a line matching readyPattern.
 * Rejects if the timeout expires or the process exits before matching.
 */
function waitForReady(
  child: ChildProcess,
  readyPattern: string | undefined,
  timeoutMs: number,
): Promise<void> {
  // No pattern to match — resolve immediately
  if (!readyPattern) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const pattern = new RegExp(readyPattern)
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`Extension server ready timeout after ${timeoutMs}ms (pattern: ${readyPattern})`))
    }, timeoutMs)

    const onData = (chunk: Buffer) => {
      if (settled) return
      const text = chunk.toString()
      if (pattern.test(text)) {
        settled = true
        cleanup()
        resolve()
      }
    }

    const onExit = (code: number | null) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`Extension server exited with code ${code} before ready`))
    }

    const onError = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`Extension server process error: ${err.message}`))
    }

    function cleanup() {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData) // Also check stderr
    child.on('exit', onExit)
    child.on('error', onError)
  })
}

/** Send SIGTERM, wait for graceful exit, then SIGKILL if still running. */
function killGracefully(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // Already exited
    if (child.exitCode !== null || child.killed) {
      resolve()
      return
    }

    let resolved = false

    const timer = setTimeout(() => {
      if (resolved) return
      // Force kill
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('exit', () => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      resolve()
    })

    child.kill('SIGTERM')
  })
}
