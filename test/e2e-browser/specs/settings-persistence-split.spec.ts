import fs from 'fs/promises'
import path from 'path'
import { test as base, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'

const BROWSER_PREFERENCES_STORAGE_KEY = 'freshell.browser-preferences.v1'

// Routed through the generalized E2eServerHandle seam (HARNESS-02) so this
// SAME spec exercises the legacy Node server or the owned Rust server
// depending on the active project's `rustFixture` option. `setupHome` is
// part of the owned Rust fixture's construction-options surface.
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
            },
            legacyLocalSettingsSeed: {
              theme: 'light',
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

test.describe('Settings Persistence Split', () => {
  // HARNESS-02 Finding 2 -- the seed half of this scenario depends on
  // `legacyLocalSettingsSeed` (seeded into `.freshell/config.json` by this
  // file's `testServer` override above and asserted back out of the
  // persisted config at the end of each test) round-tripping through the
  // server's settings-load path.
  // HISTORY: the Rust server originally lacked `legacyLocalSettingsSeed`
  // entirely, AND did not surface a PATCHed server-shared `defaultCwd`
  // through its WS/bootstrap settings resolution -- this spec's rust leg
  // carried a committed describe-wide `test.fail` citing CFG-04/SESSION-13
  // for both gaps together. CFG-04 (df1, merge b6aa86d79) ported the seed
  // extraction/merge/persist/bootstrap-return into the Rust server
  // (`crates/freshell-server/src/legacy_local_seed.rs` + `settings_store.rs`
  // + `boot.rs`) and flipped the whole leg to expected-pass, which exposed
  // the still-open second gap. This spec therefore splits its expectations
  // per-test (Playwright's `test.fail` granularity is per `test(...)`):
  //   - seed/browser-local test below: expected-PASS on BOTH projects (the
  //     deeper one-shot-consumption acceptance lives in
  //     `cfg04-legacy-browser-seed.spec.ts`; triage entry point for a seed
  //     regression is docs/plans/df1-evidence/CFG-04.md);
  //   - defaultCwd replication test at the bottom: expected-PASS on BOTH
  //     projects. This was pinned `test.fail` on `Rust browser lane` with owner
  //     CFG-12; CFG-12 (df1) then made the rust `/ws` connect handshake
  //     resolve the LIVE settings store per connection
  //     (`crates/freshell-ws/src/lib.rs` `WsState::handshake_settings` +
  //     `SettingsStore::shared_settings_lock()`, mirroring the original's
  //     per-connection `handshakeSnapshotProvider`, `server/index.ts:415-427`)
  //     and the pin was deleted; triage entry point for a replication
  //     regression is docs/plans/df1-evidence/CFG-12.md.
  test('browser-local settings stay local across isolated profiles and reloads', async ({ browser, serverInfo }) => {
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

    // Server-side proof the browser-local override stayed local: the theme
    // never lands in `settings`, and the original seed survives verbatim
    // for future fresh profiles.
    const configPath = path.join(serverInfo.homeDir, '.freshell', 'config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    expect(config.legacyLocalSettingsSeed).toMatchObject({
      theme: 'light',
    })
    expect(config.settings.theme).toBeUndefined()

    await contextB.close()
    await contextA.close()
  })

  test('server-shared defaultCwd set by one profile replicates to another and persists to config.json', async ({ browser, serverInfo }) => {
    const contextA = await browser.newContext()
    const pageA = await contextA.newPage()
    await pageA.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(pageA)

    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    await pageB.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(pageB)

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

    await contextB.close()
    await contextA.close()
  })
})
