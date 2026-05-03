import {
  CodexDurableRolloutTracker,
  type CodexDurableRolloutTrackerOptions,
} from './durable-rollout-tracker.js'
import type { CodexThreadHandle } from './protocol.js'
import type { CodexThreadLifecycleEvent } from './client.js'
import {
  CodexAppServerRuntime,
  reapOrphanedCodexAppServerSidecarsOnStartup,
  type CodexAppServerRuntimeFailureSource,
} from './runtime.js'

const MAX_PENDING_LIFECYCLE_EVENTS = 10

type CodexSidecarReady = {
  wsUrl: string
  processPid: number
  codexHome: string
}

type CodexTerminalFatalSource = CodexAppServerRuntimeFailureSource | 'sidecar_fatal'

type CodexTerminalAttachment = {
  terminalId: string
  onDurableSession: (sessionId: string) => void
  onThreadLifecycle: (event: CodexThreadLifecycleEvent) => void
  onFatal: (error: Error, source: CodexTerminalFatalSource) => void
}

type CodexTerminalSidecarOptions = {
  cwd?: string
  commandArgs?: string[]
  env?: NodeJS.ProcessEnv
  runtime?: CodexAppServerRuntime
  createDurableRolloutTracker?: (
    options: CodexDurableRolloutTrackerOptions,
  ) => Pick<CodexDurableRolloutTracker, 'trackThread' | 'dispose'>
}

export class CodexTerminalSidecar {
  private readonly runtime: CodexAppServerRuntime
  private readonly durableRolloutTracker: Pick<CodexDurableRolloutTracker, 'trackThread' | 'dispose'>
  private readonly cleanupRuntimeExit: () => void
  private readonly cleanupThreadStarted: () => void
  private readonly cleanupThreadLifecycle: () => void

  private ready: CodexSidecarReady | null = null
  private readyPromise: Promise<CodexSidecarReady> | null = null
  private attachedTerminal: CodexTerminalAttachment | null = null
  private shuttingDown = false
  private pendingFatal: { error: Error; source: CodexTerminalFatalSource } | null = null
  private durableSessionId: string | null = null
  private readonly pendingLifecycleEvents: CodexThreadLifecycleEvent[] = []
  private readonly observedThreadStartedIds = new Set<string>()

  constructor(options: CodexTerminalSidecarOptions = {}) {
    this.runtime = options.runtime ?? new CodexAppServerRuntime(
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.commandArgs ? { commandArgs: options.commandArgs } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
    )
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
    this.cleanupRuntimeExit = this.runtime.onExit((error, source) => {
      if (this.shuttingDown) {
        return
      }
      this.handleFatal(
        error ?? new Error('Codex app-server sidecar exited unexpectedly.'),
        source ?? 'app_server_exit',
      )
    })
    this.cleanupThreadLifecycle = this.runtime.onThreadLifecycle((event) => {
      this.noteThreadLifecycle(event)
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
        await this.updateOwnershipMetadata()
        return ready
      })
      .finally(() => {
        this.readyPromise = null
      })

    return this.readyPromise
  }

  attachTerminal(input: CodexTerminalAttachment): void {
    this.attachedTerminal = input
    void this.updateOwnershipMetadata()
    if (this.durableSessionId) {
      input.onDurableSession(this.durableSessionId)
    }
    for (const event of this.pendingLifecycleEvents) {
      input.onThreadLifecycle(event)
    }
    if (this.pendingFatal) {
      input.onFatal(this.pendingFatal.error, this.pendingFatal.source)
      return
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.cleanupRuntimeExit()
    this.cleanupThreadLifecycle()
    this.cleanupThreadStarted()
    this.pendingLifecycleEvents.length = 0
    await this.durableRolloutTracker.dispose()
    await this.runtime.shutdown()
    this.ready = null
    this.readyPromise = null
    this.attachedTerminal = null
  }

  private noteThreadStarted(thread: CodexThreadHandle): void {
    if (!this.recordThreadStarted(thread)) {
      return
    }
    this.forwardThreadLifecycle({
      kind: 'thread_started',
      thread,
    })
  }

  private noteThreadLifecycle(event: CodexThreadLifecycleEvent): void {
    if (this.shuttingDown) {
      return
    }
    if (event.kind === 'thread_started') {
      if (!this.recordThreadStarted(event.thread)) {
        return
      }
    }
    this.forwardThreadLifecycle(event)
  }

  private recordThreadStarted(thread: CodexThreadHandle): boolean {
    if (!thread.id || this.shuttingDown || this.observedThreadStartedIds.has(thread.id)) {
      return false
    }
    this.observedThreadStartedIds.add(thread.id)
    if (!this.durableSessionId) {
      this.durableRolloutTracker.trackThread(thread)
    }
    return true
  }

  private forwardThreadLifecycle(event: CodexThreadLifecycleEvent): void {
    const terminal = this.attachedTerminal
    if (terminal) {
      terminal.onThreadLifecycle(event)
      return
    }
    this.pendingLifecycleEvents.push(event)
    if (this.pendingLifecycleEvents.length > MAX_PENDING_LIFECYCLE_EVENTS) {
      this.pendingLifecycleEvents.splice(0, this.pendingLifecycleEvents.length - MAX_PENDING_LIFECYCLE_EVENTS)
    }
  }

  private promoteDurableSession(threadId: string): void {
    if (this.durableSessionId || this.shuttingDown) {
      return
    }
    this.durableSessionId = threadId
    this.attachedTerminal?.onDurableSession(threadId)
  }

  private handleFatal(error: Error, source: CodexTerminalFatalSource = 'sidecar_fatal'): void {
    this.pendingFatal = { error, source }
    this.attachedTerminal?.onFatal(error, source)
  }

  private async updateOwnershipMetadata(): Promise<void> {
    const ready = this.ready
    if (!ready) {
      return
    }

    await this.runtime.updateOwnershipMetadata({
      codexHome: ready.codexHome,
      terminalId: this.attachedTerminal?.terminalId ?? null,
    })
  }

  static async reapOrphanedSidecars(): Promise<void> {
    await reapOrphanedCodexAppServerSidecarsOnStartup()
  }
}
