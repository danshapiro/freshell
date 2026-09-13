import fs from 'fs/promises'
import path from 'path'
import { test as base, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'

const BROWSER_PREFERENCES_STORAGE_KEY = 'freshell.browser-preferences.v1'

/**
 *
 * Checklist validation text (docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md):
 * assert every visible preference, reload twice, and verify the one-time
 * migration marker prevents stale seed values from overwriting a later user
 * change."
 *
 * browser-local preferences still live INSIDE `settings` (no top-level
 * theme, browser-local sidebar presentation, scale, terminal font, and sound —
 * alongside the server-backed `sidebar.excludeFirstChat*` knobs (those must
 * REMAIN in `config.json`; SESSION-13's surface, not this item's).
 *
 * Routed through the generalized E2eServerHandle seam (HARNESS-02), so the
 *
 * df1 campaign posture: `deferred` — authored but intentionally NOT executed by
 * the CFG-04 worker (see docs/plans/df1-evidence/CFG-04.md); the close-out
 * `settings_store.rs` (`frs-cfg04-*` tests).
 */
const test = base.extend({
  testServer: [async ({}, use) => {
    const server = await createE2eServerHandle(process.env, {
      construct: {
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
              codingCli: {
                providers: {
                  claude: {
                    cwd: homeDir,
                  },
                },
              },
              theme: 'light',
              uiScale: 1.25,
              terminal: {
                scrollback: 4000,
                fontSize: 18,
                fontFamily: 'Fira Code',
              },
              // NOTE: `collapsed` is deliberately NOT seeded here — a collapsed
              // sidebar unmounts the sidebar nav (including the Settings
              // button, `App.tsx`'s `{!sidebarCollapsed && <Sidebar/>}`), which
              // the user-change step below needs. `sortMode`+`width` fully
              // represent the "browser-local sidebar presentation" category;
              // the collapsed member IS covered at crate level
              sidebar: {
                excludeFirstChatSubstrings: ['welcome'],
                excludeFirstChatMustStart: false,
                sortMode: 'project',
                width: 280,
              },
              notifications: {
                soundEnabled: false,
              },
            },
          }, null, 2))
        },
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
  await expect(page.getByRole('tab', { name: /^Appearance$/i })).toBeVisible({ timeout: 10_000 })
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

async function expectSeededPreferencesResolved(page: any): Promise<void> {
  await expect.poll(async () => (await getResolvedSettings(page))?.theme).toBe('light')
  const resolved = await getResolvedSettings(page)
  // scale
  expect(resolved?.uiScale).toBe(1.25)
  // terminal font
  expect(resolved?.terminal?.fontSize).toBe(18)
  expect(resolved?.terminal?.fontFamily).toBe('Fira Code')
  // browser-local sidebar presentation
  expect(resolved?.sidebar?.sortMode).toBe('project')
  expect(resolved?.sidebar?.width).toBe(280)
  // sound
  expect(resolved?.notifications?.soundEnabled).toBe(false)
  // server-backed first-chat exclusions (SESSION-13) stay server-backed
  expect(resolved?.sidebar?.excludeFirstChatSubstrings).toEqual(['welcome'])
}

test.describe('CFG-04 legacy browser-preference seeding', () => {
  test('legacy seed migrates into browser preferences exactly once', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    // 1. Empty browser storage (fresh WebView/browser profile): open and
    //    assert every seeded preference is resolved.
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await expectSeededPreferencesResolved(page)

    // 2. The consumption is recorded in the browser-preferences blob, with
    //    the one-time migration marker set.
    let preferences = await getBrowserPreferences(page)
    expect(preferences?.settings?.theme).toBe('light')
    expect(preferences?.settings?.uiScale).toBe(1.25)
    expect(preferences?.legacyLocalSettingsSeedApplied).toBe(true)

    // 3. Reload twice: the seeded preferences keep resolving (served from the
    //    browser blob now), and the marker stays set.
    await page.reload()
    await waitForReady(page)
    await expectSeededPreferencesResolved(page)
    await page.reload()
    await waitForReady(page)
    await expectSeededPreferencesResolved(page)
    preferences = await getBrowserPreferences(page)
    expect(preferences?.legacyLocalSettingsSeedApplied).toBe(true)

    // 4. The one-time marker protects a later user change from the (still
    //    stale) server-side seed: switch to dark, reload, and the stale
    //    `theme: 'light'` seed must NOT be re-applied.
    await openSettings(page)
    await page.getByRole('button', { name: /^dark$/i }).click()
    await page.waitForFunction(
      (storageKey) => {
        const raw = window.localStorage.getItem(storageKey)
        if (!raw) return false
        try {
          return JSON.parse(raw)?.settings?.theme === 'dark'
        } catch {
          return false
        }
      },
      BROWSER_PREFERENCES_STORAGE_KEY,
      { timeout: 10_000 },
    )
    await page.reload()
    await waitForReady(page)
    await expect.poll(async () => (await getResolvedSettings(page))?.theme).toBe('dark')
    preferences = await getBrowserPreferences(page)
    expect(preferences?.settings?.theme).toBe('dark')
    expect(preferences?.legacyLocalSettingsSeedApplied).toBe(true)

    // 5. Boot normalization wrote the seed to `config.json` top-level and
    //    stripped the local keys out of `settings`, while the server-backed
    //    first-chat exclusions remain in place (SESSION-13 boundary).
    const configPath = path.join(serverInfo.homeDir, '.freshell', 'config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    expect(config.legacyLocalSettingsSeed).toMatchObject({
      theme: 'light',
      uiScale: 1.25,
      terminal: { fontSize: 18, fontFamily: 'Fira Code' },
      sidebar: { sortMode: 'project', width: 280 },
      notifications: { soundEnabled: false },
    })
    expect(config.settings.theme).toBeUndefined()
    expect(config.settings.uiScale).toBeUndefined()
    expect(config.settings.notifications).toBeUndefined()
    expect(config.settings.terminal.fontSize).toBeUndefined()
    expect(config.settings.terminal.fontFamily).toBeUndefined()
    expect(config.settings.terminal.scrollback).toBe(4000)
    expect(config.settings.sidebar.sortMode).toBeUndefined()
    expect(config.settings.sidebar.width).toBeUndefined()
    expect(config.settings.sidebar.excludeFirstChatSubstrings).toEqual(['welcome'])

    await context.close()
  })
})
