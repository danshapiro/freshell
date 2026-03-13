import type { ProjectGroup } from '../coding-cli/types.js'
import { hasSessionDirectorySnapshotChange } from '../session-directory/projection.js'

type SessionsSyncWs = {
  broadcastSessionsChanged: (revision: number) => void
}

type SessionsSyncOptions = { coalesceMs?: number }

function parseCoalesceMs(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

export class SessionsSyncService {
  private last: ProjectGroup[] = []
  private hasLast = false
  private pendingTrailing: ProjectGroup[] | null = null
  private timer: NodeJS.Timeout | null = null
  private coalesceMs: number
  private revision = 0

  constructor(
    private ws: SessionsSyncWs,
    options: SessionsSyncOptions = {}
  ) {
    this.coalesceMs = parseCoalesceMs(options.coalesceMs ?? process.env.SESSIONS_SYNC_COALESCE_MS ?? 150)
  }

  publish(next: ProjectGroup[]): void {
    if (this.coalesceMs <= 0) {
      this.flush(next)
      return
    }

    if (!this.timer) {
      this.flush(next)
      this.startWindowTimer()
      return
    }

    this.pendingTrailing = next
  }

  shutdown(): void {
    this.pendingTrailing = null
    this.stopWindowTimer()
  }

  private flush(next: ProjectGroup[]): void {
    const prev = this.hasLast ? this.last : []
    const changed = hasSessionDirectorySnapshotChange(prev, next)

    this.last = next
    this.hasLast = true

    if (!changed) {
      return
    }
    this.revision += 1
    this.ws.broadcastSessionsChanged(this.revision)
  }

  private onWindowElapsed = () => {
    this.stopWindowTimer()
    const pending = this.pendingTrailing
    this.pendingTrailing = null
    if (!pending) return

    this.flush(pending)
    this.startWindowTimer()
  }

  private startWindowTimer(): void {
    if (this.timer || this.coalesceMs <= 0) return
    this.timer = setTimeout(this.onWindowElapsed, this.coalesceMs)
  }

  private stopWindowTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
