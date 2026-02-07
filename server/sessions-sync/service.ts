import type { ProjectGroup } from '../coding-cli/types.js'
import { diffProjects } from './diff.js'

function estimateBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

export class SessionsSyncService {
  private last: ProjectGroup[] = []
  private hasLast = false

  constructor(
    private ws: {
      broadcastSessionsPatch: (msg: { type: 'sessions.patch'; upsertProjects: ProjectGroup[]; removeProjectPaths: string[] }) => void
      broadcastSessionsUpdatedToLegacy: (projects: ProjectGroup[]) => void
      broadcastSessionsUpdated: (projects: ProjectGroup[]) => void
    }
  ) {}

  publish(next: ProjectGroup[]): void {
    const prev = this.hasLast ? this.last : []
    const diff = diffProjects(prev, next)

    this.last = next
    this.hasLast = true

    // No changes.
    if (diff.upsertProjects.length === 0 && diff.removeProjectPaths.length === 0) return

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
}
