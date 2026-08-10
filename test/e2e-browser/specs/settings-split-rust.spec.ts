import fs from 'node:fs/promises'
import path from 'node:path'
import { test as base, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'

const BROWSER_PREFERENCES_STORAGE_KEY = 'freshell.browser-preferences.v1'

/**
 * SETTINGS SPLIT (CFG-12, Task 21, rust-only).
 *
 * Two isolated browser contexts against ONE Rust server prove the settings
 * split: browser-local preferences (appearance/theme, persisted per-browser
 * in localStorage under `freshell.browser-preferences.v1`) never replicate
 * to another context, while server-backed settings (`defaultCwd`, persisted
 * in `<home>/.freshell/config.json`) replicate to every context AND survive
 * a full server restart on the same home/port/token (`RustServer.restart()`).
 *
 * The companion spec `settings-persistence-split.spec.ts` covers the SAME
 * split on the matrix, but its journey depends on `legacyLocalSettingsSeed`
 * (CFG-04/SESSION-13, unimplemented in Rust -- it is `test.fail`-annotated on
 * rust-chromium). This spec is the rust-green closure: seed-free, relative
 * theme assertions (toggle AWAY from whatever the context starts with), plus
 * the restart durability leg the matrix spec never exercises.
 */

// Rust-only by registration (playwright.config.ts) AND by construction: the
// restart leg exercises the owned RustServer's same-home/port/token reboot.
//
// Deliberately NO `setupHome`: the fixture's own wizard-bypass write
// (`ensureSetupWizardBypassConfig`, rust-server.ts) covers the only seed this
// spec needs (network.configured), and `boot()` re-runs `setupHome` on every
// `restart()` -- a wholesale config.json seed here would clobber the PATCHed
// server setting across the restart leg and break the very durability this
// spec proves.
const test = base.extend({
  testServer: [async ({}, use) => {
    const server = await createE2eServerHandle(process.env, {
      kind: 'rust',
      construct: {},
    })
    await server.start()
    await use(server)
    await server.stop()
  }, { scope: 'worker' }],
})

async function waitForReady(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__FRESHELL_TEST_HARNESS__, { timeout: 15_000 })
  await page.waitForFunction(
    () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready',
    { timeout: 15_000 },
  )
}

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /settings/i }).click()
  await expect(page.getByRole('tab', { name: /^Appearance$/i })).toBeVisible({ timeout: 10_000 })
}

/** The rendered appearance: `useThemeEffect` toggles `dark` on <html>. */
async function htmlIsDark(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains('dark'))
}

async function getServerSettings(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
): Promise<any> {
  const res = await page.request.get(`${info.baseUrl}/api/settings`, {
    headers: { 'x-auth-token': info.token },
  })
  if (!res.ok()) return null
  return res.json()
}

test.describe('Settings split (rust)', () => {
  test.setTimeout(120_000)

  test('browser-local appearance stays per-context while server settings replicate and survive a restart', async ({ browser, serverInfo, testServer }) => {
    const contextA = await browser.newContext()
    const pageA = await contextA.newPage()
    await pageA.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(pageA)

    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    await pageB.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(pageB)

    // Relative theme journey: flip A to the OPPOSITE of its initial rendered
    // appearance so the change is a real change regardless of the default.
    const initialDarkA = await htmlIsDark(pageA)
    const initialDarkB = await htmlIsDark(pageB)
    const targetTheme = initialDarkA ? 'light' : 'dark'
    const expectedDarkA = !initialDarkA

    await openSettings(pageA)
    await pageA.getByRole('button', { name: new RegExp(`^${targetTheme}$`, 'i') }).click()

    // A's rendered appearance flips, and the preference lands in A's OWN
    // localStorage (the browser-local half of the split). Both are polled --
    // the localStorage persist is asynchronous relative to the click (same
    // reason settings-persistence-split.spec.ts uses waitForFunction here).
    await expect.poll(() => htmlIsDark(pageA), { timeout: 10_000 }).toBe(expectedDarkA)
    await expect.poll(async () => {
      const preferences = await pageA.evaluate((storageKey) => {
        const raw = window.localStorage.getItem(storageKey)
        return raw ? JSON.parse(raw) : null
      }, BROWSER_PREFERENCES_STORAGE_KEY)
      return preferences?.settings?.theme ?? null
    }, { timeout: 10_000 }).toBe(targetTheme)

    // ...while a server setting PATCHed from A replicates to B.
    const sharedDefaultCwd = path.join(serverInfo.homeDir, 'shared-default-cwd')
    await fs.mkdir(sharedDefaultCwd, { recursive: true })
    const patchRes = await pageA.request.patch(`${serverInfo.baseUrl}/api/settings`, {
      headers: { 'x-auth-token': serverInfo.token, 'content-type': 'application/json' },
      data: { defaultCwd: sharedDefaultCwd },
    })
    expect(patchRes.ok()).toBe(true)

    // B sees the server setting (polled via GET /api/settings from B's own
    // context)...
    await expect.poll(
      async () => (await getServerSettings(pageB, serverInfo))?.defaultCwd ?? null,
      { timeout: 10_000 },
    ).toBe(sharedDefaultCwd)
    // ...but B's local appearance is untouched by A's theme change.
    expect(await htmlIsDark(pageB)).toBe(initialDarkB)

    // The theme never leaked into the server-side config; defaultCwd did.
    const configPath = path.join(serverInfo.homeDir, '.freshell', 'config.json')
    const configBefore = JSON.parse(await fs.readFile(configPath, 'utf8'))
    expect(configBefore.settings.defaultCwd).toBe(sharedDefaultCwd)
    expect(configBefore.settings.theme).toBeUndefined()

    // Reload both: each context keeps its OWN appearance.
    await pageA.reload()
    await waitForReady(pageA)
    await pageB.reload()
    await waitForReady(pageB)
    await expect.poll(() => htmlIsDark(pageA), { timeout: 10_000 }).toBe(expectedDarkA)
    expect(await htmlIsDark(pageB)).toBe(initialDarkB)

    // Restart the server (same home/port/token) and reload: the server
    // setting persisted across the process boundary, and each context STILL
    // kept its own local appearance.
    await testServer.restart!()
    await pageA.reload()
    await waitForReady(pageA)
    await pageB.reload()
    await waitForReady(pageB)

    await expect.poll(
      async () => (await getServerSettings(pageB, serverInfo))?.defaultCwd ?? null,
      { timeout: 10_000 },
    ).toBe(sharedDefaultCwd)
    await expect.poll(() => htmlIsDark(pageA), { timeout: 10_000 }).toBe(expectedDarkA)
    expect(await htmlIsDark(pageB)).toBe(initialDarkB)

    await contextB.close()
    await contextA.close()
  })
})
