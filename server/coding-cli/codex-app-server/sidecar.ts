import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../../logger.js'
import {
  CodexDurableRolloutTracker,
  type CodexDurableRolloutTrackerOptions,
} from './durable-rollout-tracker.js'
import type { CodexThreadHandle } from './protocol.js'
import { CodexAppServerRuntime } from './runtime.js'
const SIDECAR_OWNERSHIP_DIR = path.join(os.tmpdir(), 'freshell-codex-sidecars')

type CodexSidecarReady = {
  wsUrl: string
  processPid: number
  codexHome: string
}

type SidecarProcessIdentity = {
  commandLine: string[]
  cwd: string
  startTimeTicks: string
}

type SidecarOwnershipMetadata = {
  pid: number
  wsUrl: string
  codexHome: string
  terminalId: string | null
  createdAt: string
  process?: SidecarProcessIdentity
}

type CodexTerminalAttachment = {
  terminalId: string
  onDurableSession: (sessionId: string) => void
  onFatal: (error: Error) => void
}

type CodexTerminalSidecarOptions = {
  runtime?: CodexAppServerRuntime
  createDurableRolloutTracker?: (
    options: CodexDurableRolloutTrackerOptions,
  ) => Pick<CodexDurableRolloutTracker, 'trackThread' | 'dispose'>
}

async function readLinuxProcessIdentity(pid: number): Promise<SidecarProcessIdentity | undefined> {
  if (process.platform !== 'linux') {
    return undefined
  }

  try {
    const [cmdlineRaw, cwd, statRaw] = await Promise.all([
      fsp.readFile(`/proc/${pid}/cmdline`, 'utf8'),
      fsp.readlink(`/proc/${pid}/cwd`),
      fsp.readFile(`/proc/${pid}/stat`, 'utf8'),
    ])

    const commandLine = cmdlineRaw.split('\0').filter(Boolean)
    const statClosingParen = statRaw.lastIndexOf(')')
    const trailingFields = statClosingParen >= 0
      ? statRaw.slice(statClosingParen + 2).trim().split(/\s+/)
      : statRaw.trim().split(/\s+/)
    const startTimeTicks = trailingFields[19]

    if (commandLine.length === 0 || !cwd || !startTimeTicks) {
      return undefined
    }

    return {
      commandLine,
      cwd,
      startTimeTicks,
    }
  } catch {
    return undefined
  }
}

function processIdentityMatches(
  metadata: SidecarOwnershipMetadata,
  current: SidecarProcessIdentity | undefined,
): boolean {
  const recorded = metadata.process
  if (!recorded || !current) {
    return false
  }

  return (
    recorded.cwd === current.cwd
    && recorded.startTimeTicks === current.startTimeTicks
    && recorded.commandLine.length > 0
    && recorded.commandLine.length === current.commandLine.length
    && recorded.commandLine.every((value, index) => value === current.commandLine[index])
    && current.commandLine.includes('app-server')
    && current.commandLine.includes('--listen')
    && current.commandLine.includes(metadata.wsUrl)
  )
}

export class CodexTerminalSidecar {
  private readonly runtime: CodexAppServerRuntime
  private readonly durableRolloutTracker: Pick<CodexDurableRolloutTracker, 'trackThread' | 'dispose'>
  private readonly metadataId = randomUUID()
  private readonly metadataPath = path.join(SIDECAR_OWNERSHIP_DIR, `${this.metadataId}.json`)
  private readonly cleanupRuntimeExit: () => void
  private readonly cleanupThreadStarted: () => void

  private ready: CodexSidecarReady | null = null
  private readyPromise: Promise<CodexSidecarReady> | null = null
  private attachedTerminal: CodexTerminalAttachment | null = null
  private shuttingDown = false
  private pendingFatalError: Error | null = null
  private durableSessionId: string | null = null

  constructor(options: CodexTerminalSidecarOptions = {}) {
    this.runtime = options.runtime ?? new CodexAppServerRuntime()
    const createDurableRolloutTracker = options.createDurableRolloutTracker
      ?? ((trackerOptions: CodexDurableRolloutTrackerOptions) => new CodexDurableRolloutTracker(trackerOptions))
    this.durableRolloutTracker = createDurableRolloutTracker({
      watchPath: (targetPath, watchId) => this.runtime.watchPath(targetPath, watchId),
      unwatchPath: async (watchId) => {
        if (this.runtime.status() !== 'running') {
          return
        }
        await this.runtime.unwatchPath(watchId)
      },
      subscribeToFsChanged: (handler) => this.runtime.onFsChanged(handler),
      onDurableRollout: (sessionId) => {
        this.promoteDurableSession(sessionId)
      },
    })
    this.cleanupRuntimeExit = this.runtime.onExit((error) => {
      if (this.shuttingDown) {
        return
      }
      this.handleFatal(error ?? new Error('Codex app-server sidecar exited unexpectedly.'))
    })
    this.cleanupThreadStarted = this.runtime.onThreadStarted((thread) => {
      this.noteThreadStarted(thread)
    })
  }

  async ensureReady(): Promise<CodexSidecarReady> {
    if (this.ready) {
      return this.ready
    }
    if (this.readyPromise) {
      return this.readyPromise
    }

    this.readyPromise = this.runtime.ensureReady()
      .then(async (ready) => {
        this.ready = ready
        await this.writeOwnershipMetadata()
        return ready
      })
      .finally(() => {
        this.readyPromise = null
      })

    return this.readyPromise
  }

  attachTerminal(input: CodexTerminalAttachment): void {
    this.attachedTerminal = input
    void this.writeOwnershipMetadata()
    if (this.pendingFatalError) {
      input.onFatal(this.pendingFatalError)
      return
    }
    if (this.durableSessionId) {
      input.onDurableSession(this.durableSessionId)
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.cleanupRuntimeExit()
    this.cleanupThreadStarted()
    await this.durableRolloutTracker.dispose()
    await this.runtime.shutdown()
    this.ready = null
    this.readyPromise = null
    this.attachedTerminal = null
    await fsp.rm(this.metadataPath, { force: true }).catch(() => undefined)
  }

  private noteThreadStarted(thread: CodexThreadHandle): void {
    if (!thread.id || this.shuttingDown || this.durableSessionId) {
      return
    }
    this.durableRolloutTracker.trackThread(thread)
  }

  private promoteDurableSession(threadId: string): void {
    if (this.durableSessionId || this.shuttingDown) {
      return
    }
    this.durableSessionId = threadId
    this.attachedTerminal?.onDurableSession(threadId)
  }

  private handleFatal(error: Error): void {
    this.pendingFatalError = error
    this.attachedTerminal?.onFatal(error)
  }

  private async writeOwnershipMetadata(): Promise<void> {
    const ready = this.ready
    if (!ready) {
      return
    }

    const processIdentity = await readLinuxProcessIdentity(ready.processPid)
    await fsp.mkdir(SIDECAR_OWNERSHIP_DIR, { recursive: true })
    const metadata: SidecarOwnershipMetadata = {
      pid: ready.processPid,
      wsUrl: ready.wsUrl,
      codexHome: ready.codexHome,
      terminalId: this.attachedTerminal?.terminalId ?? null,
      createdAt: new Date().toISOString(),
      ...(processIdentity ? { process: processIdentity } : {}),
    }
    await fsp.writeFile(this.metadataPath, JSON.stringify(metadata), 'utf8')
  }

  static async reapOrphanedSidecars(): Promise<void> {
    const entries = await fsp.readdir(SIDECAR_OWNERSHIP_DIR, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue
      }
      const metadataPath = path.join(SIDECAR_OWNERSHIP_DIR, entry.name)
      try {
        const raw = await fsp.readFile(metadataPath, 'utf8')
        const parsed = JSON.parse(raw) as SidecarOwnershipMetadata
        const pid = Number(parsed.pid)
        if (!Number.isInteger(pid) || pid <= 0) {
          await fsp.rm(metadataPath, { force: true })
          continue
        }
        try {
          process.kill(pid, 0)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ESRCH') {
            await fsp.rm(metadataPath, { force: true }).catch(() => undefined)
            continue
          }
          logger.warn({ err: error, pid, metadataPath }, 'Failed to inspect orphaned Codex sidecar PID')
          continue
        }

        const currentIdentity = await readLinuxProcessIdentity(pid)
        if (!processIdentityMatches(parsed, currentIdentity)) {
          // Orphan reaping is intentionally Linux-only because PID ownership
          // verification relies on /proc command line, cwd, and start-time data.
          // If we cannot prove the PID still belongs to this sidecar, we refuse
          // to signal it and drop the stale metadata instead.
          logger.warn({
            pid,
            metadataPath,
            wsUrl: parsed.wsUrl,
          }, 'Skipping orphaned Codex sidecar cleanup because PID ownership could not be verified')
          await fsp.rm(metadataPath, { force: true }).catch(() => undefined)
          continue
        }

        try {
          process.kill(pid, 'SIGTERM')
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ESRCH') {
            logger.warn({ err: error, pid, metadataPath }, 'Failed to reap orphaned Codex sidecar')
          }
        }
      } catch (error) {
        logger.warn({ err: error, metadataPath }, 'Failed to read Codex sidecar ownership metadata')
      }

      await fsp.rm(metadataPath, { force: true }).catch(() => undefined)
    }
  }
}
