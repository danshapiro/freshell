import { beforeEach, describe, expect, it, vi } from 'vitest'

// Repo-standard hoisted logger double: every test gets a no-op logger; only
// the retry test asserts on the calls.
const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/lib/client-logger', () => ({
  createLogger: () => logSpies,
}))

import { renamePaneWithMirrorRetry } from '@/lib/pane-rename'

const patchOk = () => Promise.resolve({ status: 'ok', data: { paneId: 'pane-1', tabId: 'tab-1' }, message: 'pane renamed' } as object) as never
const patchNotFound = () => Promise.resolve({ status: 'ok', message: 'pane not found' } as object) as never

describe('renamePaneWithMirrorRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('succeeds on the first attempt without sleeping', async () => {
    const patch = vi.fn().mockImplementation(patchOk)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await renamePaneWithMirrorRetry('pane-1', 'Ops desk', { patch, sleep })
    expect(result).toEqual({ ok: true, response: expect.objectContaining({ message: 'pane renamed' }) })
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith('/api/panes/pane-1', { name: 'Ops desk' })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries the transient pane-not-found no-op until the mirror lands', async () => {
    const patch = vi.fn().mockImplementationOnce(patchNotFound).mockImplementation(patchOk)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await renamePaneWithMirrorRetry('pane-1', 'Ops desk', { patch, sleep, retryDelaysMs: [5, 10, 20] })
    expect(result.ok).toBe(true)
    expect(patch).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(5)
    // Review M2: a retried attempt must be observable in the field. Exactly one
    // debug event, emitted before/at the sleep, carrying the retry evidence.
    expect(logSpies.debug).toHaveBeenCalledTimes(1)
    expect(logSpies.debug).toHaveBeenCalledWith(
      expect.stringContaining('pane-not-found'),
      { paneId: 'pane-1', attempt: 1, delayMs: 5 },
    )
    expect(logSpies.debug.mock.invocationCallOrder[0])
      .toBeLessThanOrEqual(sleep.mock.invocationCallOrder[0])
  })

  it('gives up after the retry budget with the last pane-not-found message', async () => {
    const patch = vi.fn().mockImplementation(patchNotFound)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await renamePaneWithMirrorRetry('pane-1', 'Ops desk', { patch, sleep, retryDelaysMs: [5, 10, 20] })
    expect(result).toEqual({ ok: false, message: 'pane not found' })
    expect(patch).toHaveBeenCalledTimes(4)
  })

  it('does not retry a non-retryable mismatch message', async () => {
    const patch = vi.fn().mockResolvedValue({ status: 'ok', message: 'name too long' })
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await renamePaneWithMirrorRetry('pane-1', 'Ops desk', { patch, sleep })
    expect(result).toEqual({ ok: false, message: 'name too long' })
    expect(patch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('falls back to the generic message when the response carries none', async () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    const result = await renamePaneWithMirrorRetry('pane-1', 'Ops desk', { patch, sleep: vi.fn() })
    expect(result).toEqual({ ok: false, message: 'Failed to rename pane' })
  })

  it('propagates patch rejections (caller surfaces them)', async () => {
    const patch = vi.fn().mockRejectedValue(new Error('network down'))
    await expect(renamePaneWithMirrorRetry('pane-1', 'Ops desk', { patch, sleep: vi.fn() })).rejects.toThrow('network down')
  })
})
