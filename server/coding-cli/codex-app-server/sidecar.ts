import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../../logger.js'
import { CodexAppServerRuntime } from './runtime.js'

const DEFAULT_ARTIFACT_POLL_MS = 100
const DEFAULT_ARTIFACT_TIMEOUT_MS = 10_000
const SIDECAR_OWNERSHIP_DIR = path.join(os.tmpdir(), 'freshell-codex-sidecars')

type CodexSidecarReady = {
  wsUrl: string
  processPid: number
  codexHome: string
}

type CodexTerminalAttachment = {
  terminalId: string
  onDurableSession: (sessionId: string) => void
  onFatal: (error: Error) => void
}

type CodexTerminalSidecarOptions = {
  runtime?: CodexAppServerRuntime
  artifactPollMs?: number
  artifactTimeoutMs?: number
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function listRolloutArtifacts(codexHome: string): Promise<string[]> {
  const sessionsRoot = path.join(codexHome, 'sessions')
  if (!(await pathExists(sessionsRoot))) {
    return []
  }

  const artifacts: string[] = []
  const years = await fsp.readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
  for (const year of years) {
    if (!year.isDirectory()) continue
    const yearDir = path.join(sessionsRoot, year.name)
    const months = await fsp.readdir(yearDir, { withFileTypes: true }).catch(() => [])
    for (const month of months) {
      if (!month.isDirectory()) continue
      const monthDir = path.join(yearDir, month.name)
      const days = await fsp.readdir(monthDir, { withFileTypes: true }).catch(() => [])
      for (const day of days) {
        if (!day.isDirectory()) continue
        const dayDir = path.join(monthDir, day.name)
        const files = await fsp.readdir(dayDir, { withFileTypes: true }).catch(() => [])
        for (const file of files) {
          if (!file.isFile() || !file.name.startsWith('rollout-') || !file.name.endsWith('.jsonl')) {
            continue
          }
          artifacts.push(path.join(dayDir, file.name))
        }
      }
    }
  }

  return artifacts
}

async function rolloutArtifactMatchesThread(
  artifactPath: string,
  threadId: string,
  startedAt: number,
): Promise<boolean> {
  const stat = await fsp.stat(artifactPath)
  if (stat.mtimeMs + 5 < startedAt) {
    return false
  }
  if (path.basename(artifactPath).includes(threadId)) {
    return true
  }

  const content = await fsp.readFile(artifactPath, 'utf8').catch(() => '')
  return content.includes(threadId)
}

export class CodexTerminalSidecar {
  private readonly runtime: CodexAppServerRuntime
  private readonly artifactPollMs: number
  private readonly artifactTimeoutMs: number
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
  private artifactPollPromise: Promise<void> | null = null
  private artifactThreadStartedAt = 0

  constructor(options: CodexTerminalSidecarOptions = {}) {
    this.runtime = options.runtime ?? new CodexAppServerRuntime()
    this.artifactPollMs = options.artifactPollMs ?? DEFAULT_ARTIFACT_POLL_MS
    this.artifactTimeoutMs = options.artifactTimeoutMs ?? DEFAULT_ARTIFACT_TIMEOUT_MS
    this.cleanupRuntimeExit = this.runtime.onExit((error) => {
      if (this.shuttingDown) {
        return
      }
      this.handleFatal(error ?? new Error('Codex app-server sidecar exited unexpectedly.'))
    })
    this.cleanupThreadStarted = this.runtime.onThreadStarted((threadId) => {
      this.noteThreadStarted(threadId)
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
    await this.runtime.shutdown()
    this.ready = null
    this.readyPromise = null
    this.attachedTerminal = null
    await fsp.rm(this.metadataPath, { force: true }).catch(() => undefined)
  }

  private noteThreadStarted(threadId: string): void {
    if (!threadId || this.shuttingDown || this.durableSessionId) {
      return
    }
    this.artifactThreadStartedAt = Date.now()
    if (!this.artifactPollPromise) {
      this.artifactPollPromise = this.waitForDurableArtifact(threadId, this.artifactThreadStartedAt)
        .finally(() => {
          this.artifactPollPromise = null
        })
    }
  }

  private async waitForDurableArtifact(threadId: string, startedAt: number): Promise<void> {
    const ready = await this.ensureReady()
    const deadline = Date.now() + this.artifactTimeoutMs

    while (!this.shuttingDown && Date.now() < deadline) {
      const artifacts = await listRolloutArtifacts(ready.codexHome)
      for (const artifact of artifacts) {
        if (await rolloutArtifactMatchesThread(artifact, threadId, startedAt)) {
          this.promoteDurableSession(threadId)
          return
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.artifactPollMs))
    }
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

    await fsp.mkdir(SIDECAR_OWNERSHIP_DIR, { recursive: true })
    await fsp.writeFile(this.metadataPath, JSON.stringify({
      pid: ready.processPid,
      wsUrl: ready.wsUrl,
      codexHome: ready.codexHome,
      terminalId: this.attachedTerminal?.terminalId ?? null,
      createdAt: new Date().toISOString(),
    }), 'utf8')
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
        const parsed = JSON.parse(raw)
        const pid = Number(parsed.pid)
        if (!Number.isInteger(pid) || pid <= 0) {
          await fsp.rm(metadataPath, { force: true })
          continue
        }
        try {
          process.kill(pid, 0)
          process.kill(pid, 'SIGTERM')
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ESRCH') {
            logger.warn({ err: error, pid, metadataPath }, 'Failed to reap orphaned Codex sidecar')
          }
        }
      } catch (error) {
        logger.warn({ err: error, metadataPath }, 'Failed to read Codex sidecar ownership metadata')
      } finally {
        await fsp.rm(metadataPath, { force: true }).catch(() => undefined)
      }
    }
  }
}
