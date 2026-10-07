import { describe, expect, it, vi } from 'vitest'
import * as owner from '../../../../scripts/testing/runtime-sandbox.js'

const handle = {
  runId: 'run-owned', candidateSha: 'a'.repeat(40), soulId: 'soul-owned',
  incarnationId: 'incarnation-owned', containerId: 'b'.repeat(64),
  hostBootId: 'boot-owned', nativeSessionId: 'native-owned',
}

function fixture() {
  const row = { ...handle, launchState: 'running' }
  const read = vi.fn().mockResolvedValue({
    workerPid: 42, workerLaunchCount: 1,
    limits: { cpuMax: '50000 100000', memoryMax: '268435456', swapMax: '0', pidsMax: '64' },
    unsafeBrokerAttempts: 0,
  })
  const adapter = {
    runId: handle.runId, candidateSha: handle.candidateSha,
    inventory: vi.fn().mockResolvedValue([row]),
    receipts: () => [{ containerId: handle.containerId, soulId: handle.soulId, incarnationId: handle.incarnationId }],
    readHostFacts: read,
  }
  return { adapter, read, row }
}

describe('exact owned runtime facts', () => {
  it('reads fixed facts only for the current exact owned runtime', async () => {
    const { adapter, read } = fixture()
    const value = await owner.readExactRuntimeHostFacts(adapter, handle)
    expect(value.workerPid).toBe(42)
    expect(value.workerLaunchCount).toBe(1)
    expect(value.limits.swapMax).toBe('0')
    expect(read).toHaveBeenCalledExactlyOnceWith(handle)
  })

  it.each([
    { runId: 'another-run' }, { candidateSha: 'c'.repeat(40) },
    { soulId: 'another-soul' }, { incarnationId: 'old-incarnation' },
    { containerId: 'b'.repeat(12) }, { containerId: 'c'.repeat(64) },
    { hostBootId: 'old-boot' }, { nativeSessionId: 'another-root' },
  ])('refuses a mismatched handle %j before any owner read', async (changed) => {
    const { adapter, read } = fixture()
    await expect(owner.readExactRuntimeHostFacts(adapter, { ...handle, ...changed })).rejects.toThrow(/exact|owned|current/)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses a replaced current incarnation before reading retained evidence', async () => {
    const { adapter, read, row } = fixture()
    row.incarnationId = 'replacement'
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toThrow(/current/)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses an inventory identity without a broker ownership receipt', async () => {
    const { adapter, read } = fixture()
    adapter.receipts = () => []
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toThrow(/owned/)
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    { workerPid: 0 }, { workerLaunchCount: -1 }, { unsafeBrokerAttempts: NaN },
    { limits: { cpuMax: '50000 100000', memoryMax: 'truncated', swapMax: '0', pidsMax: '64' } },
  ])('refuses malformed observed owner facts %j', async (changed) => {
    const { adapter, read } = fixture()
    read.mockResolvedValue({ ...await read(), ...changed })
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toThrow(/facts/)
  })
})

describe('registered fresh fixture state decoder', () => {
  it('returns actual native state without treating the requested root as evidence', () => {
    expect(owner.decodeFixtureNativeState({
      nativeSessionId: 'native-actual', pendingDecisionId: null, dispatchCount: 2, completionCount: 1,
    }, 'native-actual')).toEqual({ nativeSessionId: 'native-actual', pendingDecisionId: null, dispatchCount: 2, completionCount: 1 })
  })
  it.each([
    { nativeSessionId: 'wrong-root' }, { pendingDecisionId: 5 },
    { pendingDecisionId: '' }, { dispatchCount: 1.5 }, { completionCount: -1 },
  ])('rejects wrong-root or truncated native fixture observations %j', (changed) => {
    expect(() => owner.decodeFixtureNativeState({
      nativeSessionId: 'native-actual', pendingDecisionId: null, dispatchCount: 2, completionCount: 1, ...changed,
    }, 'native-actual')).toThrow(/fixture/)
  })
})
