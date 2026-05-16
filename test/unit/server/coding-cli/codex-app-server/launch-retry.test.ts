import { describe, expect, it, vi } from 'vitest'

import { CodexLaunchConfigError } from '../../../../../server/coding-cli/codex-launch-config.js'
import { planCodexLaunchWithRetry } from '../../../../../server/coding-cli/codex-app-server/launch-retry.js'

describe('planCodexLaunchWithRetry', () => {
  it('retries transient launch-planning failures with linear backoff', async () => {
    const plan = { sidecar: { shutdown: vi.fn() } }
    const planner = {
      planCreate: vi.fn()
        .mockRejectedValueOnce(new Error('sidecar not ready'))
        .mockRejectedValueOnce(new Error('port not ready'))
        .mockResolvedValue(plan),
    }
    const logger = { warn: vi.fn() }

    await expect(planCodexLaunchWithRetry({
      planner: planner as any,
      input: { cwd: '/workspace' } as any,
      retryDelayMs: 1,
      logger,
    })).resolves.toBe(plan)

    expect(planner.planCreate).toHaveBeenCalledTimes(3)
    expect(logger.warn).toHaveBeenNthCalledWith(1, expect.objectContaining({
      attempt: 1,
      attempts: 5,
      delayMs: 1,
      cwd: '/workspace',
      hasResumeSessionId: false,
    }), 'Codex launch planning failed; retrying')
    expect(logger.warn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      attempt: 2,
      attempts: 5,
      delayMs: 2,
    }), 'Codex launch planning failed; retrying')
  })

  it('does not retry configuration errors', async () => {
    const planner = {
      planCreate: vi.fn().mockRejectedValue(new CodexLaunchConfigError('Codex is disabled')),
    }

    await expect(planCodexLaunchWithRetry({
      planner: planner as any,
      input: { cwd: '/workspace' } as any,
      retryDelayMs: 1,
    })).rejects.toThrow('Codex is disabled')

    expect(planner.planCreate).toHaveBeenCalledTimes(1)
  })

  it('wraps non-Error failures after attempts are exhausted', async () => {
    const planner = {
      planCreate: vi.fn().mockRejectedValue('temporary failure'),
    }

    await expect(planCodexLaunchWithRetry({
      planner: planner as any,
      input: { cwd: '/workspace', resumeSessionId: 'thread-1' } as any,
      attempts: 2,
      retryDelayMs: 1,
    })).rejects.toThrow('temporary failure')

    expect(planner.planCreate).toHaveBeenCalledTimes(2)
  })
})
