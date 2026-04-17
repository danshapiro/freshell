import { describe, expect, it, vi } from 'vitest'
import { CodexLaunchPlanner } from '../../../../../server/coding-cli/codex-app-server/launch-planner.js'

describe('CodexLaunchPlanner', () => {
  it('starts a fresh Codex thread and returns an exact remote endpoint handoff', async () => {
    const runtime = {
      ensureReady: vi.fn().mockResolvedValue({ wsUrl: 'ws://127.0.0.1:43123', processPid: 1234 }),
      startThread: vi.fn().mockResolvedValue({ threadId: 'thread-new-1' }),
      resumeThread: vi.fn(),
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

  it('resumes an existing Codex thread before spawn', async () => {
    const runtime = {
      ensureReady: vi.fn().mockResolvedValue({ wsUrl: 'ws://127.0.0.1:43123', processPid: 1234 }),
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({ threadId: '019d9859-5670-72b1-851f-794ad7fef112' }),
    }
    const planner = new CodexLaunchPlanner(runtime as any)

    const plan = await planner.planCreate({
      cwd: '/repo/worktree',
      resumeSessionId: '019d9859-5670-72b1-851f-794ad7fef112',
    })

    expect(runtime.resumeThread).toHaveBeenCalledWith({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      cwd: '/repo/worktree',
      model: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
    })
    expect(plan.sessionId).toBe('019d9859-5670-72b1-851f-794ad7fef112')
    expect(plan.remote.wsUrl).toBe('ws://127.0.0.1:43123')
  })
})
