import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionsSyncService } from '../../../../server/sessions-sync/service.js'
import type { ProjectGroup } from '../../../../server/coding-cli/types.js'

function createWsMocks() {
  return {
    broadcastSessionsPatch: vi.fn(),
    broadcastSessionsUpdatedToLegacy: vi.fn(),
    broadcastSessionsUpdated: vi.fn(),
  }
}

function createProject(path: string, updatedAt: number): ProjectGroup {
  return {
    projectPath: path,
    sessions: [{ provider: 'claude', sessionId: `${path}-${updatedAt}`, projectPath: path, updatedAt }],
  }
}

describe('SessionsSyncService', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes first publish immediately when coalescing is enabled', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    svc.publish(a)

    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(1)
    expect(ws.broadcastSessionsUpdatedToLegacy).toHaveBeenCalledTimes(1)
    expect(ws.broadcastSessionsUpdated).not.toHaveBeenCalled()

    vi.advanceTimersByTime(151)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(1)
  })

  it('coalesces rapid publishes into one trailing flush with latest state', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    const b = [createProject('/p1', 2)]
    const c = [createProject('/p1', 3)]

    svc.publish(a)
    svc.publish(b)
    svc.publish(c)

    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(2)
    const trailingPatch = ws.broadcastSessionsPatch.mock.calls[1][0]
    expect(trailingPatch.upsertProjects[0].sessions[0].updatedAt).toBe(3)
  })

  it('emits one trailing publish per window while burst updates continue', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    const b = [createProject('/p1', 2)]
    const c = [createProject('/p1', 3)]
    const d = [createProject('/p1', 4)]

    svc.publish(a)
    svc.publish(b)
    vi.advanceTimersByTime(150)

    svc.publish(c)
    svc.publish(d)
    vi.advanceTimersByTime(150)

    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(3)
    const secondWindowPatch = ws.broadcastSessionsPatch.mock.calls[2][0]
    expect(secondWindowPatch.upsertProjects[0].sessions[0].updatedAt).toBe(4)
  })

  it('shutdown clears pending trailing timer and state', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    const b = [createProject('/p1', 2)]

    svc.publish(a)
    svc.publish(b)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(1)

    svc.shutdown()
    vi.advanceTimersByTime(1_000)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(1)
  })

  it('disables coalescing when coalesceMs is zero', () => {
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 0 })

    svc.publish([createProject('/p1', 1)])
    svc.publish([createProject('/p1', 2)])
    svc.publish([createProject('/p1', 3)])

    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(3)
    expect(ws.broadcastSessionsUpdatedToLegacy).toHaveBeenCalledTimes(3)
  })

  it('suppresses no-change trailing flushes (A->B->A), updates baseline, and stops timer', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    const b = [createProject('/p1', 2)]
    const aAgain = [createProject('/p1', 1)]

    svc.publish(a)
    svc.publish(b)
    svc.publish(aAgain)

    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(500)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(1)

    svc.publish(b)
    expect(ws.broadcastSessionsPatch).toHaveBeenCalledTimes(2)
  })

  it('falls back to sessions.updated when sessions.patch payload exceeds configured max', () => {
    const originalMax = process.env.MAX_WS_CHUNK_BYTES
    process.env.MAX_WS_CHUNK_BYTES = '1'

    try {
      const ws = createWsMocks()
      const svc = new SessionsSyncService(ws as any, { coalesceMs: 0 })

      svc.publish([createProject('/p1', 1)])

      expect(ws.broadcastSessionsUpdated).toHaveBeenCalledTimes(1)
      expect(ws.broadcastSessionsPatch).not.toHaveBeenCalled()
      expect(ws.broadcastSessionsUpdatedToLegacy).not.toHaveBeenCalled()
    } finally {
      if (typeof originalMax === 'string') process.env.MAX_WS_CHUNK_BYTES = originalMax
      else delete process.env.MAX_WS_CHUNK_BYTES
    }
  })
})
