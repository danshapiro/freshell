import fs from 'fs/promises'
import path from 'path'
import { test as base, expect } from '../helpers/fixtures.js'
import { TestServer } from '../helpers/test-server.js'

const BROWSER_PREFERENCES_STORAGE_KEY = 'freshell.browser-preferences.v1'

const test = base.extend({
  testServer: [async ({}, use) => {
    const server = new TestServer({
      setupHome: async (homeDir) => {
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: {
            network: {
              configured: true,
              host: '127.0.0.1',
            },
          },
          legacyLocalSettingsSeed: {
            theme: 'light',
          },
        }, null, 2))
      },
    })
    await server.start()
    await use(server)
    await server.stop()
  }, { scope: 'worker' }],
})

async function waitForReady(page: any): Promise<void> {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 15_000 })
  await page.waitForFunction(
    () => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready',
    { timeout: 15_000 },
  )
}

async function openSettings(page: any): Promise<void> {
  await page.getByRole('button', { name: /settings/i }).click()
  await expect(page.getByText('Terminal').first()).toBeVisible({ timeout: 10_000 })
}

async function getResolvedSettings(page: any) {
  return page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings ?? null)
}

async function getBrowserPreferences(page: any) {
  return page.evaluate((storageKey) => {
    const raw = window.localStorage.getItem(storageKey)
    return raw ? JSON.parse(raw) : null
  }, BROWSER_PREFERENCES_STORAGE_KEY)
}

test.describe('Settings Persistence Split', () => {
  test('browser-local settings stay local while server-backed settings replicate', async ({ browser, serverInfo }) => {
    const contextA = await browser.newContext()
    const pageA = await contextA.newPage()
    await pageA.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(pageA)

    const initialSettingsA = await getResolvedSettings(pageA)
    expect(initialSettingsA?.theme).toBe('light')

    await openSettings(pageA)
    await pageA.getByRole('button', { name: /^dark$/i }).click()

    await pageA.waitForFunction(
      ({ storageKey, expected }) => {
        const raw = window.localStorage.getItem(storageKey)
        if (!raw) return false
        try {
          return JSON.parse(raw)?.settings?.theme === expected
        } catch {
          return false
        }
      },
      { storageKey: BROWSER_PREFERENCES_STORAGE_KEY, expected: 'dark' },
      { timeout: 10_000 },
    )

    await pageA.reload()
    await waitForReady(pageA)
    await expect.poll(async () => (await getResolvedSettings(pageA))?.theme).toBe('dark')

    const preferencesA = await getBrowserPreferences(pageA)
    expect(preferencesA?.settings?.theme).toBe('dark')

    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    await pageB.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(pageB)

    await expect.poll(async () => (await getResolvedSettings(pageB))?.theme).toBe('light')

    const preferencesB = await getBrowserPreferences(pageB)
    expect(preferencesB?.settings?.theme).toBe('light')

    const sharedDefaultCwd = path.join(serverInfo.homeDir, 'shared-default-cwd')
    await fs.mkdir(sharedDefaultCwd, { recursive: true })

    const patchResponse = await pageA.evaluate(async (info) => {
      const response = await fetch(`${info.baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': info.token,
        },
        body: JSON.stringify({
          defaultCwd: info.defaultCwd,
        }),
      })
      return { ok: response.ok, status: response.status }
    }, {
      baseUrl: serverInfo.baseUrl,
      token: serverInfo.token,
      defaultCwd: sharedDefaultCwd,
    })

    expect(patchResponse.ok).toBe(true)

    await pageB.reload()
    await waitForReady(pageB)
    await expect.poll(async () => (await getResolvedSettings(pageB))?.defaultCwd).toBe(sharedDefaultCwd)

    const configPath = path.join(serverInfo.homeDir, '.freshell', 'config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    expect(config.settings.defaultCwd).toBe(sharedDefaultCwd)
    expect(config.legacyLocalSettingsSeed).toMatchObject({
      theme: 'light',
    })
    expect(config.settings.theme).toBeUndefined()

    await contextB.close()
    await contextA.close()
  })
})
