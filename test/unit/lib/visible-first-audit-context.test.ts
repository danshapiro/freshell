// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { applyProfileNetworkConditions, buildAuditContextOptions } from '@test/e2e-browser/perf/create-audit-context'

describe('buildAuditContextOptions', () => {
  it('blocks service workers and disables cache for both profiles', async () => {
    const desktop = buildAuditContextOptions({ profileId: 'desktop_local' })
    const mobile = buildAuditContextOptions({ profileId: 'mobile_restricted' })
    expect(desktop.serviceWorkers).toBe('block')
    expect(mobile.serviceWorkers).toBe('block')

    const send = vi.fn().mockResolvedValue(undefined)
    await applyProfileNetworkConditions({ send } as never, 'mobile_restricted')
    expect(send).toHaveBeenCalledWith('Network.setCacheDisabled', { cacheDisabled: true })
    expect(send).toHaveBeenCalledWith('Network.emulateNetworkConditions', expect.objectContaining({
      latency: 150,
    }))
  })
})
