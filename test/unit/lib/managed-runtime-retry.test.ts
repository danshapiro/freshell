import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppStore } from '@/store/store'
import type { ManagedRuntimeProjectionFields } from '@shared/managed-runtime'
import { retryManagedConversation } from '@/lib/managed-runtime-retry'

const { retryManagedRuntimeSoul, queueManagedRuntimeRefresh } = vi.hoisted(() => ({
  retryManagedRuntimeSoul: vi.fn(),
  queueManagedRuntimeRefresh: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ retryManagedRuntimeSoul }))
vi.mock('@/lib/recovery/managed-runtime-recovery', () => ({ queueManagedRuntimeRefresh }))

type Conversation = ManagedRuntimeProjectionFields & { createRequestId: string }

function conversation(
  recoveryState: NonNullable<ManagedRuntimeProjectionFields['recoverySummary']>['recoveryState'],
): Conversation {
  return {
    createRequestId: 'pane-request-1',
    soulId: 'soul-1',
    soulIntentRevision: 19,
    recoverySummary: {
      desiredState: 'running',
      recoveryState,
      durabilityState: 'resume_captured',
      allocationState: 'verified_durable',
    },
  }
}

const store = {} as Pick<AppStore, 'dispatch' | 'getState'>

describe('retryManagedConversation', () => {
  beforeEach(() => {
    retryManagedRuntimeSoul.mockReset()
    retryManagedRuntimeSoul.mockResolvedValue({
      outcome: 'started',
      view: { soulId: 'soul-1', intentRevision: 19 },
      probe: null,
    })
    queueManagedRuntimeRefresh.mockReset()
    queueManagedRuntimeRefresh.mockResolvedValue(undefined)
  })

  it('resumes the same repaired conversation and succeeds when the refreshed pane leaves the resume decision', async () => {
    const content = conversation('data_repair_complete')
    let current = content
    queueManagedRuntimeRefresh.mockImplementation(async () => {
      current = conversation('recovering')
    })

    await expect(retryManagedConversation(content, () => current, store)).resolves.toBeUndefined()

    expect(retryManagedRuntimeSoul).toHaveBeenCalledWith('soul-1', 19)
    expect(queueManagedRuntimeRefresh).toHaveBeenCalledWith(store, 'pane-recovery-retry')
  })

  it('keeps a still-repaired pane actionable and reports that it has not resumed yet', async () => {
    const content = conversation('data_repair_complete')

    await expect(retryManagedConversation(content, () => content, store))
      .rejects.toThrow(/restored conversation has not resumed yet/i)

    expect(retryManagedRuntimeSoul).toHaveBeenCalledWith('soul-1', 19)
    expect(queueManagedRuntimeRefresh).toHaveBeenCalledWith(store, 'pane-recovery-retry')
  })

  it.each([
    ['pane identity', { createRequestId: 'pane-request-2' }],
    ['soul identity', { soulId: 'soul-2' }],
    ['intent revision', { soulIntentRevision: 20 }],
    ['recovery decision', { recoverySummary: conversation('recovering').recoverySummary }],
  ] as const)('ignores a stale response after the current %s changes', async (_changedField, change) => {
    const content = conversation('data_repair_complete')
    let current = content
    let resolveRetry!: (response: unknown) => void
    retryManagedRuntimeSoul.mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve }))
    const retry = retryManagedConversation(content, () => current, store)
    current = { ...content, ...change }
    resolveRetry({
      outcome: 'started',
      view: { soulId: 'soul-1', intentRevision: 19 },
      probe: null,
    })

    await expect(retry).resolves.toBeUndefined()
    expect(queueManagedRuntimeRefresh).not.toHaveBeenCalled()
  })

  it('keeps existing blocked retry guidance when the blocked decision remains after refresh', async () => {
    const content = {
      ...conversation('blocked'),
      recoverySummary: {
        ...conversation('blocked').recoverySummary!,
        reason: 'STORE_UNREADABLE',
      },
    }

    await expect(retryManagedConversation(content, () => content, store))
      .rejects.toThrow(/saved conversation store is readable/i)
  })
})
