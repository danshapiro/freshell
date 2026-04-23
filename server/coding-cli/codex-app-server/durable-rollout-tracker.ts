import fsp from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../../logger.js'
import type { CodexThreadHandle } from './protocol.js'

const DEFAULT_INITIAL_PROBE_DELAY_MS = 250
const DEFAULT_MAX_PROBE_DELAY_MS = 5_000

export type CodexFsChangedEvent = {
  watchId: string
  changedPaths: string[]
}

export type CodexDurableRolloutTrackerOptions = {
  watchPath: (targetPath: string, watchId: string) => Promise<{ path: string }>
  unwatchPath: (watchId: string) => Promise<void>
  subscribeToFsChanged: (handler: (event: CodexFsChangedEvent) => void) => () => void
  onDurableRollout: (sessionId: string) => void
  pathExists?: (targetPath: string) => Promise<boolean>
  initialProbeDelayMs?: number
  maxProbeDelayMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  createWatchId?: (kind: 'rollout' | 'parent', threadId: string) => string
  log?: Pick<typeof logger, 'warn'>
}

type PendingRollout = {
  thread: CodexThreadHandle
  rolloutPath: string
  parentPath: string
  rolloutWatchId: string
  parentWatchId: string
  registeredWatchIds: Set<string>
  nextProbeDelayMs: number
  timer: ReturnType<typeof setTimeout> | null
  probeInFlight: boolean
  immediateProbeQueued: boolean
}

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

export class CodexDurableRolloutTracker {
  private readonly pathExists: (targetPath: string) => Promise<boolean>
  private readonly initialProbeDelayMs: number
  private readonly maxProbeDelayMs: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly createWatchId: (kind: 'rollout' | 'parent', threadId: string) => string
  private readonly log: Pick<typeof logger, 'warn'>
  private readonly cleanupFsChangedSubscription: () => void

  private disposed = false
  private promotedThreadId: string | null = null
  private pending: PendingRollout | null = null

  constructor(private readonly options: CodexDurableRolloutTrackerOptions) {
    this.pathExists = options.pathExists ?? defaultPathExists
    this.initialProbeDelayMs = options.initialProbeDelayMs ?? DEFAULT_INITIAL_PROBE_DELAY_MS
    this.maxProbeDelayMs = options.maxProbeDelayMs ?? DEFAULT_MAX_PROBE_DELAY_MS
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
    this.createWatchId = options.createWatchId ?? ((kind, threadId) => `freshell-codex-${kind}:${threadId}`)
    this.log = options.log ?? logger
    this.cleanupFsChangedSubscription = options.subscribeToFsChanged((event) => {
      this.handleFsChanged(event)
    })
  }

  trackThread(thread: CodexThreadHandle): void {
    if (this.disposed || this.promotedThreadId || !thread.id) {
      return
    }
    if (thread.ephemeral) {
      return
    }
    if (!thread.path) {
      this.log.warn({ threadId: thread.id }, 'Codex thread/started did not include a durable rollout path; promotion will stay pending')
      return
    }

    if (this.pending?.thread.id === thread.id && this.pending.rolloutPath === thread.path) {
      return
    }

    void this.replacePendingRollout({
      thread: {
        id: thread.id,
        path: thread.path,
        ephemeral: thread.ephemeral ?? false,
      },
      rolloutPath: thread.path,
      parentPath: path.dirname(thread.path),
      rolloutWatchId: this.createWatchId('rollout', thread.id),
      parentWatchId: this.createWatchId('parent', thread.id),
      registeredWatchIds: new Set<string>(),
      nextProbeDelayMs: this.initialProbeDelayMs,
      timer: null,
      probeInFlight: false,
      immediateProbeQueued: false,
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cleanupFsChangedSubscription()
    await this.clearPending(this.pending)
    this.pending = null
  }

  private async replacePendingRollout(nextPending: PendingRollout): Promise<void> {
    const previousPending = this.pending
    this.pending = nextPending
    await this.clearPending(previousPending)
    if (this.disposed || this.promotedThreadId) {
      return
    }
    if (this.pending !== nextPending) {
      return
    }
    void this.registerWatch(nextPending, nextPending.rolloutPath, nextPending.rolloutWatchId)
    void this.registerWatch(nextPending, nextPending.parentPath, nextPending.parentWatchId)
    this.requestImmediateProbe(nextPending)
  }

  private handleFsChanged(event: CodexFsChangedEvent): void {
    const pending = this.pending
    if (!pending || this.disposed || this.promotedThreadId) {
      return
    }
    const mentionsRolloutPath = event.changedPaths.includes(pending.rolloutPath)
    const matchesWatchId = (
      event.watchId === pending.rolloutWatchId
      || event.watchId === pending.parentWatchId
    )
    if (!mentionsRolloutPath && !matchesWatchId) {
      return
    }
    this.requestImmediateProbe(pending)
  }

  private requestImmediateProbe(pending: PendingRollout): void {
    if (this.pending !== pending || this.disposed || this.promotedThreadId) {
      return
    }
    if (pending.timer) {
      this.clearTimeoutFn(pending.timer)
      pending.timer = null
    }
    if (pending.probeInFlight) {
      pending.immediateProbeQueued = true
      return
    }
    void this.runProbe(pending)
  }

  private scheduleNextProbe(pending: PendingRollout): void {
    if (this.pending !== pending || this.disposed || this.promotedThreadId || pending.timer) {
      return
    }
    const delayMs = pending.nextProbeDelayMs
    pending.nextProbeDelayMs = Math.min(this.maxProbeDelayMs, pending.nextProbeDelayMs * 2)
    pending.timer = this.setTimeoutFn(() => {
      pending.timer = null
      void this.runProbe(pending)
    }, delayMs)
  }

  private async runProbe(pending: PendingRollout): Promise<void> {
    if (this.pending !== pending || this.disposed || this.promotedThreadId) {
      return
    }
    pending.probeInFlight = true

    try {
      if (await this.pathExists(pending.rolloutPath)) {
        this.promotedThreadId = pending.thread.id
        await this.clearPending(pending)
        if (!this.disposed) {
          this.options.onDurableRollout(pending.thread.id)
        }
        return
      }
    } finally {
      pending.probeInFlight = false
    }

    if (this.pending !== pending || this.disposed || this.promotedThreadId) {
      return
    }

    if (pending.immediateProbeQueued) {
      pending.immediateProbeQueued = false
      void this.runProbe(pending)
      return
    }

    this.scheduleNextProbe(pending)
  }

  private async registerWatch(pending: PendingRollout, targetPath: string, watchId: string): Promise<void> {
    try {
      await this.options.watchPath(targetPath, watchId)
      if (this.pending === pending && !this.disposed) {
        pending.registeredWatchIds.add(watchId)
      } else {
        await this.options.unwatchPath(watchId).catch(() => undefined)
      }
    } catch (error) {
      this.log.warn(
        {
          err: error,
          watchId,
          targetPath,
          threadId: pending.thread.id,
        },
        'Failed to register Codex rollout watch; falling back to exact-path probes.',
      )
    }
  }

  private async clearPending(pending: PendingRollout | null): Promise<void> {
    if (!pending) {
      return
    }
    if (pending.timer) {
      this.clearTimeoutFn(pending.timer)
      pending.timer = null
    }
    if (this.pending === pending) {
      this.pending = null
    }
    const watchIds = [...pending.registeredWatchIds]
    pending.registeredWatchIds.clear()
    await Promise.all(watchIds.map(async (watchId) => {
      try {
        await this.options.unwatchPath(watchId)
      } catch (error) {
        this.log.warn({ err: error, watchId }, 'Failed to unregister Codex rollout watch during cleanup.')
      }
    }))
  }
}
