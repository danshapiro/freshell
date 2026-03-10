import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppHydrationHarness } from '@test/helpers/visible-first/app-hydration-harness'
import { createSlowNetworkController } from '@test/helpers/visible-first/slow-network-controller'

describe('createAppHydrationHarness', () => {
  let harness: Awaited<ReturnType<typeof createAppHydrationHarness>> | null = null

  afterEach(async () => {
    await harness?.dispose()
    harness = null
  })

  it('renders App with a real store, seeded layout state, gated HTTP responses, and independently delayed websocket readiness', async () => {
    const network = createSlowNetworkController()

    harness = await createAppHydrationHarness({
      network,
      seedState: {
        tabs: [{ id: 'tab-visible', mode: 'shell', title: 'Visible' }],
        activeTabId: 'tab-visible',
        panes: {
          layouts: {},
          activePane: {},
        },
      },
      responses: {
        '/api/settings': { lane: 'critical', value: {} },
        '/api/platform': { lane: 'visible', value: { platform: 'linux' } },
      },
    })

    await harness.waitForRequest('/api/settings')

    expect(harness.getStore().getState().tabs.activeTabId).toBe('tab-visible')
    expect(harness.getRequestLog()).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/api/settings', lane: 'critical' })]),
    )
    expect(harness.isWsReady()).toBe(false)

    network.releaseNext('critical')
    await waitFor(() => {
      expect(harness?.getResolvedRequests().map((entry) => entry.path)).toContain('/api/settings')
    })

    network.releaseNext('visible')
    await waitFor(() => {
      expect(harness?.getResolvedRequests().map((entry) => entry.path)).toContain('/api/platform')
    })

    network.releaseNext('visible')
    network.releaseNext('visible')

    await harness.waitForConnect()
    expect(harness.getWsConnectCalls()).toBe(1)
    expect(harness.isWsReady()).toBe(false)

    network.releaseWsReady()
    await waitFor(() => {
      expect(harness?.isWsReady()).toBe(true)
    })
  })
})
