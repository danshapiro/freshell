import { describe, it, expect, vi } from 'vitest'
import { SessionsSyncService } from '../../../../server/sessions-sync/service.js'
import type { ProjectGroup } from '../../../../server/coding-cli/types.js'

describe('SessionsSyncService', () => {
  it('broadcasts only diffs via sessions.patch', () => {
    const ws = {
      broadcastSessionsPatch: vi.fn(),
      broadcastSessionsUpdatedToLegacy: vi.fn(),
      broadcastSessionsUpdated: vi.fn(),
    }

    const svc = new SessionsSyncService(ws as any)

    const a: ProjectGroup[] = [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }] }]
    const b: ProjectGroup[] = [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 2 }] }]

    svc.publish(a)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(1)

    svc.publish(b)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(2)
    expect(ws.broadcastSessionsUpdated).not.toHaveBeenCalled()
  })

  it('falls back to sessions.updated when sessions.patch is too large', () => {
    const originalMax = process.env.MAX_WS_CHUNK_BYTES
    process.env.MAX_WS_CHUNK_BYTES = '1'

    try {
      const ws = {
        broadcastSessionsPatch: vi.fn(),
        broadcastSessionsUpdatedToLegacy: vi.fn(),
        broadcastSessionsUpdated: vi.fn(),
      }

      const svc = new SessionsSyncService(ws as any)

      const next: ProjectGroup[] = [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }] }]
      svc.publish(next)

      expect(ws.broadcastSessionsUpdated).toHaveBeenCalledTimes(1)
      expect(ws.broadcastSessionsPatch).not.toHaveBeenCalled()
      expect(ws.broadcastSessionsUpdatedToLegacy).not.toHaveBeenCalled()
    } finally {
      if (typeof originalMax === 'string') process.env.MAX_WS_CHUNK_BYTES = originalMax
      else delete process.env.MAX_WS_CHUNK_BYTES
    }
  })
})
