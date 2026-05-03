import { describe, expect, it, vi } from 'vitest'
import { CodexLaunchPlanner } from '../../../../../server/coding-cli/codex-app-server/launch-planner.js'

describe('CodexLaunchPlanner', () => {
  it('starts a fresh Codex thread and returns an exact remote endpoint handoff', async () => {
    const runtime = {
      ensureReady: vi.fn(),
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
    }
    const planner = new CodexLaunchPlanner(runtime as any)

    const plan = await planner.planCreate({
      cwd: '/repo/worktree',
      model: 'codex-default',
      sandbox: 'workspace-write',
    })

    expect(runtime.startThread).toHaveBeenCalledWith({
      cwd: '/repo/worktree',
      model: 'codex-default',
      sandbox: 'workspace-write',
      approvalPolicy: undefined,
    })
    expect(plan.sessionId).toBe('thread-new-1')
    expect(plan.remote.wsUrl).toBe('ws://127.0.0.1:43123')
  })

  it('reuses an existing Codex session id and only ensures the remote runtime is ready', async () => {
    const runtime = {
      ensureReady: vi.fn().mockResolvedValue({
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      startThread: vi.fn(),
    }
    const planner = new CodexLaunchPlanner(runtime as any)

    const plan = await planner.planCreate({
      cwd: '/repo/worktree',
      resumeSessionId: '019d9859-5670-72b1-851f-794ad7fef112',
    })

    expect(runtime.ensureReady).toHaveBeenCalledTimes(1)
    expect(runtime.startThread).not.toHaveBeenCalled()
    expect(plan.sessionId).toBe('019d9859-5670-72b1-851f-794ad7fef112')
    expect(plan.remote.wsUrl).toBe('ws://127.0.0.1:43123')
  })

  it('uses the runtime-reported wsUrl from the same thread create call', async () => {
    const runtime = {
      ensureReady: vi.fn(),
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-2',
        wsUrl: 'ws://127.0.0.1:43199',
      }),
    }
    const planner = new CodexLaunchPlanner(runtime as any)

    const plan = await planner.planCreate({ cwd: '/repo/worktree' })

    expect(plan).toEqual({
      sessionId: 'thread-new-2',
      remote: {
        wsUrl: 'ws://127.0.0.1:43199',
      },
    })
  })
})
