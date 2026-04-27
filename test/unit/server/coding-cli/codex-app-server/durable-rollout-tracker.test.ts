import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexDurableRolloutTracker } from '../../../../../server/coding-cli/codex-app-server/durable-rollout-tracker.js'

describe('CodexDurableRolloutTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('checks only the exact rollout path when a matching fs/changed event arrives', async () => {
    const rolloutPath = '/tmp/codex/sessions/2026/04/23/rollout-thread-new-1.jsonl'
    const existsCalls: string[] = []
    let rolloutExists = false
    let fsChangedHandler: ((event: { watchId: string; changedPaths: string[] }) => void) | null = null
    const onDurableRollout = vi.fn()

    const tracker = new CodexDurableRolloutTracker({
      watchPath: vi.fn(async (targetPath) => ({ path: targetPath })),
      unwatchPath: vi.fn(async () => undefined),
      subscribeToFsChanged: (handler) => {
        fsChangedHandler = handler
        return () => {
          fsChangedHandler = null
        }
      },
      pathExists: vi.fn(async (targetPath) => {
        existsCalls.push(targetPath)
        return rolloutExists
      }),
      onDurableRollout,
    })

    tracker.trackThread({
      id: 'thread-new-1',
      path: rolloutPath,
      ephemeral: false,
    })
    await Promise.resolve()

    rolloutExists = true
    fsChangedHandler?.({
      watchId: 'freshell-codex-rollout:thread-new-1',
      changedPaths: [rolloutPath],
    })
    await vi.advanceTimersByTimeAsync(250)

    expect(onDurableRollout).toHaveBeenCalledWith('thread-new-1')
    expect(new Set(existsCalls)).toEqual(new Set([rolloutPath]))

    await tracker.dispose()
  })

  it('keeps retrying exact-path probes after the old 10 second cutoff until the rollout exists', async () => {
    const rolloutPath = '/tmp/codex/sessions/2026/04/23/rollout-thread-late.jsonl'
    const onDurableRollout = vi.fn()

    const tracker = new CodexDurableRolloutTracker({
      watchPath: vi.fn(async (targetPath) => ({ path: targetPath })),
      unwatchPath: vi.fn(async () => undefined),
      subscribeToFsChanged: () => () => undefined,
      pathExists: vi.fn(async () => Date.now() >= 11_000),
      onDurableRollout,
      initialProbeDelayMs: 1_000,
      maxProbeDelayMs: 5_000,
    })

    tracker.trackThread({
      id: 'thread-late',
      path: rolloutPath,
      ephemeral: false,
    })
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(onDurableRollout).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    expect(onDurableRollout).toHaveBeenCalledWith('thread-late')

    await tracker.dispose()
  })

  it('falls back to exact-path probes when fs/watch registration fails', async () => {
    const rolloutPath = '/tmp/codex/sessions/2026/04/23/rollout-thread-fallback.jsonl'
    const log = { warn: vi.fn() }
    const onDurableRollout = vi.fn()
    const unwatchPath = vi.fn(async () => undefined)

    const tracker = new CodexDurableRolloutTracker({
      watchPath: vi.fn(async () => {
        throw new Error('watch registration failed')
      }),
      unwatchPath,
      subscribeToFsChanged: () => () => undefined,
      pathExists: vi.fn(async () => Date.now() >= 6_000),
      onDurableRollout,
      initialProbeDelayMs: 1_000,
      maxProbeDelayMs: 5_000,
      log,
    })

    tracker.trackThread({
      id: 'thread-fallback',
      path: rolloutPath,
      ephemeral: false,
    })
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(7_000)
    expect(onDurableRollout).toHaveBeenCalledWith('thread-fallback')
    expect(log.warn).toHaveBeenCalled()
    expect(unwatchPath).not.toHaveBeenCalled()

    await tracker.dispose()
  })

  it('lets a later trackThread replace an earlier pending rollout without overlapping state', async () => {
    const firstPath = '/tmp/codex/sessions/2026/04/23/rollout-thread-first.jsonl'
    const secondPath = '/tmp/codex/sessions/2026/04/23/rollout-thread-second.jsonl'
    const onDurableRollout = vi.fn()

    const tracker = new CodexDurableRolloutTracker({
      watchPath: vi.fn(async (targetPath) => ({ path: targetPath })),
      unwatchPath: vi.fn(async () => undefined),
      subscribeToFsChanged: () => () => undefined,
      pathExists: vi.fn(async (targetPath) => targetPath === secondPath && Date.now() >= 1_000),
      onDurableRollout,
      initialProbeDelayMs: 500,
      maxProbeDelayMs: 500,
    })

    tracker.trackThread({
      id: 'thread-first',
      path: firstPath,
      ephemeral: false,
    })
    tracker.trackThread({
      id: 'thread-second',
      path: secondPath,
      ephemeral: false,
    })
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(onDurableRollout).toHaveBeenCalledTimes(1)
    expect(onDurableRollout).toHaveBeenCalledWith('thread-second')

    await tracker.dispose()
  })
})
