import { describe, expect, it, vi } from 'vitest'
import { CodexLaunchPlanner } from '../../../../../server/coding-cli/codex-app-server/launch-planner.js'

describe('CodexLaunchPlanner', () => {
  function createSidecar() {
    return {
      ensureReady: vi.fn().mockResolvedValue({
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      attachTerminal: vi.fn(),
      shutdown: vi.fn(),
    }
  }

  it('starts a fresh Codex terminal without preallocating a thread id', async () => {
    const sidecar = createSidecar()
    const createSidecarWithInput = vi.fn(() => sidecar as any)
    const planner = new CodexLaunchPlanner(createSidecarWithInput)

    const plan = await planner.planCreate({
      cwd: '/repo/worktree',
      terminalId: 'term-codex-1',
      env: {
        FRESHELL_TERMINAL_ID: 'term-codex-1',
      },
      model: 'codex-default',
      sandbox: 'workspace-write',
    })

    expect(createSidecarWithInput).toHaveBeenCalledWith({
      cwd: '/repo/worktree',
      terminalId: 'term-codex-1',
      env: {
        FRESHELL_TERMINAL_ID: 'term-codex-1',
      },
      commandArgs: [
        '-c',
        expect.stringMatching(/^mcp_servers\.freshell\.command=/),
        '-c',
        expect.stringMatching(/^mcp_servers\.freshell\.args=\[/),
      ],
      model: 'codex-default',
      sandbox: 'workspace-write',
    })
    expect(sidecar.ensureReady).toHaveBeenCalledTimes(1)
    expect(plan.sessionId).toBeUndefined()
    expect(plan.remote.wsUrl).toBe('ws://127.0.0.1:43123')
    expect(plan.sidecar).toBe(sidecar)
  })

  it('reuses an existing Codex session id and only ensures the remote runtime is ready', async () => {
    const sidecar = createSidecar()
    const planner = new CodexLaunchPlanner(() => sidecar as any)

    const plan = await planner.planCreate({
      cwd: '/repo/worktree',
      terminalId: 'term-codex-restore',
      env: {
        FRESHELL_TERMINAL_ID: 'term-codex-restore',
      },
      resumeSessionId: '019d9859-5670-72b1-851f-794ad7fef112',
    })

    expect(sidecar.ensureReady).toHaveBeenCalledTimes(1)
    expect(plan.sessionId).toBe('019d9859-5670-72b1-851f-794ad7fef112')
    expect(plan.remote.wsUrl).toBe('ws://127.0.0.1:43123')
    expect(plan.sidecar).toBe(sidecar)
  })

  it('uses the ready runtime wsUrl for fresh launch handoff', async () => {
    const sidecar = {
      ensureReady: vi.fn().mockResolvedValue({
        wsUrl: 'ws://127.0.0.1:43199',
      }),
      attachTerminal: vi.fn(),
      shutdown: vi.fn(),
    }
    const planner = new CodexLaunchPlanner(() => sidecar as any)

    const plan = await planner.planCreate({
      cwd: '/repo/worktree',
      terminalId: 'term-codex-handoff',
      env: {
        FRESHELL_TERMINAL_ID: 'term-codex-handoff',
      },
    })

    expect(plan).toEqual({
      remote: {
        wsUrl: 'ws://127.0.0.1:43199',
      },
      sidecar,
    })
  })
})
