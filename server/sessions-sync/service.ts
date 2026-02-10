import type { ProjectGroup } from '../coding-cli/types.js'
import { diffProjects } from './diff.js'

function estimateBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

type SessionsSyncWs = {
  broadcastSessionsPatch: (msg: { type: 'sessions.patch'; upsertProjects: ProjectGroup[]; removeProjectPaths: string[] }) => void
  broadcastSessionsUpdatedToLegacy: (projects: ProjectGroup[]) => void
  broadcastSessionsUpdated: (projects: ProjectGroup[]) => void
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
    const diff = diffProjects(prev, next)

    this.last = next
    this.hasLast = true

    // No changes between snapshots.
    if (diff.upsertProjects.length === 0 && diff.removeProjectPaths.length === 0) {
      return
    }

    const patchMsg = {
      type: 'sessions.patch',
      upsertProjects: diff.upsertProjects,
      removeProjectPaths: diff.removeProjectPaths,
    } as const

    const maxBytes = Number(process.env.MAX_WS_CHUNK_BYTES || 500 * 1024)
    if (estimateBytes(patchMsg) > maxBytes) {
      this.ws.broadcastSessionsUpdated(next)
      return
    }

    // Patch-first: send diffs to capable clients; snapshots only to legacy clients.
    this.ws.broadcastSessionsPatch(patchMsg)
    this.ws.broadcastSessionsUpdatedToLegacy(next)
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
