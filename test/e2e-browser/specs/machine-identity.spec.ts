import { test, expect } from '../helpers/fixtures.js'

test.describe('server-owned machine identity', () => {
  test.use({ machineIdentityHandling: 'manual' })

  test('a fresh browser chooses a machine before it opens a websocket or pushes tabs', async ({
    page,
    serverInfo,
    harness,
  }) => {
    await page.addInitScript(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
    await page.route('**/api/machines', async (route) => {
      await route.fulfill({
        json: {
          machines: [{
            id: 'machine-existing',
            label: 'Existing coding machine',
            createdAt: 1_789_171_200_000,
            lastSeenAt: 1_789_171_200_000,
          }],
        },
      })
    })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()

    await expect(page.getByRole('dialog', { name: 'Choose a machine' })).toBeVisible()
    await expect(page.getByRole('button', { name: /use existing coding machine/i })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add this machine' })).toBeVisible()

    expect(await harness.getSentWsMessages()).toEqual([])
    expect(await harness.getConnectionStatus()).not.toBe('ready')
  })
})

test.describe.serial('default E2E machine selection', () => {
  test('retries machine discovery across a long outage without reloading', async ({
    page,
    serverInfo,
    harness,
    e2eMachineId,
  }) => {
    test.setTimeout(120_000)
    let endpointAvailable = false
    let failedRequests = 0
    let documentNavigations = 0
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) documentNavigations += 1
    })
    // Keep the real app document mounted while its discovery request has the
    // same network failure as a cached desktop client starting offline.
    await page.route('**/api/machines', async route => {
      if (endpointAvailable) await route.continue()
      else {
        failedRequests += 1
        await route.abort('connectionrefused')
      }
    })
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await expect(page.getByRole('heading', { name: 'Could not choose a machine' })).toBeVisible()
    const outageStarted = Date.now()
    await expect.poll(() => failedRequests, { timeout: 15_000 }).toBeGreaterThanOrEqual(4)
    await expect.poll(() => Date.now() - outageStarted, { timeout: 70_000 }).toBeGreaterThan(65_000)
    expect(await harness.getSentWsMessages()).toEqual([])
    expect(await harness.getConnectionStatus()).not.toBe('ready')

    // Restoration changes only the endpoint. Supply no UI, navigation,
    // websocket-ready, online or visibility event to trigger recovery.
    endpointAvailable = true
    await harness.waitForConnection()
    await expect(page.getByRole('heading', { name: 'Could not choose a machine' })).not.toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('freshell.machine-id.v1'))).toBe(e2eMachineId)
    expect(documentNavigations).toBe(1)
    expect(await harness.getConnectionStatus()).toBe('ready')
  })

  for (const ordinal of ['first', 'second']) {
    test(`${ordinal} fresh browser context reaches ready on its isolated test machine`, async ({
      page,
      serverInfo,
      harness,
      machineIdentityHandling,
      e2eMachineId,
    }) => {
      expect(machineIdentityHandling).toBe('auto-select')
      expect(e2eMachineId).toBeTruthy()
      await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
      await harness.waitForHarness()
      expect(await page.evaluate(() => localStorage.getItem('freshell.machine-id.v1'))).toBe(e2eMachineId)
      await harness.waitForConnection()
      expect(await harness.getConnectionStatus()).toBe('ready')
    })
  }
})
