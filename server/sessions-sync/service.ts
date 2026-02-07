import type { ProjectGroup } from '../coding-cli/types.js'
import { diffProjects } from './diff.js'

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

    // Patch-first: send diffs to capable clients; snapshots only to legacy clients.
    // If we later find patch messages can become too large, we can add a size guard
    // that falls back to broadcastSessionsUpdated(next).
    this.ws.broadcastSessionsPatch({
      type: 'sessions.patch',
      upsertProjects: diff.upsertProjects,
      removeProjectPaths: diff.removeProjectPaths,
    })
    this.ws.broadcastSessionsUpdatedToLegacy(next)
  }
}

