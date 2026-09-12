import { test, expect } from '../helpers/fixtures.js'

test.describe('server-owned machine identity', () => {
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
