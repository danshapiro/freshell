import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionsSyncService } from '../../../../server/sessions-sync/service.js'
import type { ProjectGroup } from '../../../../server/coding-cli/types.js'

function createWsMocks() {
  return {
    broadcastSessionsChanged: vi.fn(),
  }
}

function createProject(path: string, lastActivityAt: number): ProjectGroup {
  return {
    projectPath: path,
    sessions: [{ provider: 'claude', sessionId: `${path}-${lastActivityAt}`, projectPath: path, lastActivityAt }],
  }
}

function createDetailedProject(
  path: string,
  session: NonNullable<ProjectGroup['sessions']>[number],
  color?: string,
): ProjectGroup {
  return {
    projectPath: path,
    sessions: [{ provider: 'claude', projectPath: path, lastActivityAt: 1, sessionId: 's1', ...session }],
    ...(color ? { color } : {}),
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

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
    expect(ws.broadcastSessionsChanged).toHaveBeenLastCalledWith(1)

    vi.advanceTimersByTime(151)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
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

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(2)
    expect(ws.broadcastSessionsChanged).toHaveBeenLastCalledWith(2)
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

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(3)
    expect(ws.broadcastSessionsChanged).toHaveBeenLastCalledWith(3)
  })

  it('shutdown clears pending trailing timer and state', () => {
    vi.useFakeTimers()
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 150 })

    const a = [createProject('/p1', 1)]
    const b = [createProject('/p1', 2)]

    svc.publish(a)
    svc.publish(b)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)

    svc.shutdown()
    vi.advanceTimersByTime(1_000)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
  })

  it('disables coalescing when coalesceMs is zero', () => {
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 0 })

    svc.publish([createProject('/p1', 1)])
    svc.publish([createProject('/p1', 2)])
    svc.publish([createProject('/p1', 3)])

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(3)
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

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(500)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)

    svc.publish(b)
    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(2)
  })

  it('broadcasts the same lightweight invalidation even when the changed snapshot is large', () => {
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 0 })

    svc.publish([
      {
        projectPath: '/p1',
        sessions: Array.from({ length: 200 }, (_, index) => ({
          provider: 'claude',
          sessionId: `s-${index}`,
          projectPath: '/p1',
          lastActivityAt: index,
          summary: 'x'.repeat(2_000),
        })),
      },
    ])

    expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
    expect(ws.broadcastSessionsChanged).toHaveBeenLastCalledWith(1)
  })

  it('broadcasts only when directory-visible fields change', () => {
    const ws = createWsMocks()
    const svc = new SessionsSyncService(ws as any, { coalesceMs: 0 })

    svc.publish([
      createDetailedProject('/repo', {
        provider: 'codex',
        sessionId: 's1',
        projectPath: '/repo',
        lastActivityAt: 100,
        title: 'Deploy',
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 2,
          cachedTokens: 0,
          totalTokens: 3,
        },
      }, '#f00'),
    ])
    svc.publish([
      createDetailedProject('/repo', {
        provider: 'codex',
        sessionId: 's1',
        projectPath: '/repo',
        lastActivityAt: 100,
        title: 'Deploy',
        tokenUsage: {
          inputTokens: 9,
          outputTokens: 9,
          cachedTokens: 9,
          totalTokens: 27,
        },
        sourceFile: '/tmp/other.jsonl',
      }, '#0f0'),
    ])
    svc.publish([
      createDetailedProject('/repo', {
        provider: 'codex',
        sessionId: 's1',
        projectPath: '/repo',
        lastActivityAt: 101,
        title: 'Deploy',
      }, '#0f0'),
    ])
    svc.publish([
      createDetailedProject('/repo', {
        provider: 'codex',
        sessionId: 's1',
        projectPath: '/repo',
        lastActivityAt: 101,
        title: 'Deploy v2',
      }, '#0f0'),
    ])

    expect(ws.broadcastSessionsChanged.mock.calls).toEqual([
      [1],
      [2],
      [3],
    ])
  })
})
