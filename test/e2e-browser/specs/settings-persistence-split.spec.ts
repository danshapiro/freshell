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

async function enableFreshclaude(page: any): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true },
    })
    harness?.dispatch({
      type: 'settings/updateSettingsLocal',
      payload: {
        codingCli: {
          enabledProviders: ['claude'],
        },
      },
    })
  })
}

async function openPanePicker(page: any) {
  const existingPicker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (await existingPicker.isVisible().catch(() => false)) {
    return existingPicker
  }

  const termContainer = page.locator('.xterm').first()
  if (await termContainer.isVisible().catch(() => false)) {
    await termContainer.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /split horizontally/i }).click()
  } else {
    await page.getByRole('button', { name: /add pane/i }).click()
  }
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  await expect(picker).toBeVisible({ timeout: 10_000 })
  return picker
}

async function openFreshclaudeSettings(page: any) {
  const pane = page.getByRole('group', { name: /pane: freshclaude/i }).last()
  await expect(pane).toBeVisible({ timeout: 10_000 })

  const dialog = pane.getByRole('dialog', { name: 'Agent chat settings' })
  if (!await dialog.isVisible().catch(() => false)) {
    await pane.getByRole('button', { name: /^settings$/i }).click()
  }

  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

async function confirmFreshclaudeDirectory(page: any, cwd: string) {
  const directoryInput = page.getByRole('combobox', { name: /starting directory for freshclaude/i }).last()
  const pickerAppeared = await directoryInput
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false)
  if (!pickerAppeared) {
    return
  }

  const waitForDismissal = async (timeout: number) => {
    try {
      await directoryInput.waitFor({ state: 'hidden', timeout })
      return true
    } catch {
      return false
    }
  }

  const suggestionList = page.getByRole('listbox').last()
  if (await suggestionList.isVisible().catch(() => false)) {
    await suggestionList.getByRole('option').first().click({ force: true })
    if (await waitForDismissal(2_000)) {
      return
    }
  }

  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await directoryInput.waitFor({ state: 'hidden', timeout: 10_000 })
}

async function createFreshclaudePane(page: any, cwd: string): Promise<void> {
  const initialCount = await page.getByRole('group', { name: /pane: freshclaude/i }).count()
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
  await confirmFreshclaudeDirectory(page, cwd)
  await expect.poll(async () => (
    await page.getByRole('group', { name: /pane: freshclaude/i }).count()
  )).toBe(initialCount + 1)
}

async function clearSentWsMessages(page: any): Promise<void> {
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.clearSentWsMessages?.()
  })
}

async function getSentWsMessages(page: any): Promise<any[]> {
  return page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? [])
}

async function getResolvedSettings(page: any) {
  return page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings ?? null)
}

async function patchServerSettings(page: any, serverInfo: any, patch: Record<string, unknown>) {
  const response = await page.evaluate(async ({ baseUrl, token, patchPayload }) => {
    const result = await fetch(`${baseUrl}/api/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': token,
      },
      body: JSON.stringify(patchPayload),
    })
    return { ok: result.ok, status: result.status }
  }, {
    baseUrl: serverInfo.baseUrl,
    token: serverInfo.token,
    patchPayload: patch,
  })

  expect(response.ok).toBe(true)
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

  test('freshclaude create-time validation clears unsupported provider-default effort from persisted settings', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.route('**/api/agent-chat/capabilities/freshclaude', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: 2_222,
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: false,
                supportedEffortLevels: [],
                supportsAdaptiveThinking: true,
              },
              {
                id: 'haiku',
                displayName: 'Haiku',
                description: 'Fast path',
                supportsEffort: false,
                supportedEffortLevels: [],
                supportsAdaptiveThinking: false,
              },
            ],
          },
        }),
      })
    })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await enableFreshclaude(page)

    await patchServerSettings(page, serverInfo, {
      agentChat: {
        providers: {
          freshclaude: {
            effort: 'turbo',
          },
        },
      },
    })

    await page.reload()
    await waitForReady(page)
    await enableFreshclaude(page)

    await clearSentWsMessages(page)
    await createFreshclaudePane(page, serverInfo.homeDir)

    await expect.poll(async () => {
      const sent = await getSentWsMessages(page)
      const create = sent.find((message) => message?.type === 'sdk.create')
      return create
        ? {
            model: create.model ?? null,
            effort: Object.prototype.hasOwnProperty.call(create, 'effort') ? create.effort : null,
          }
        : null
    }).toEqual({
      model: 'opus',
      effort: null,
    })

    await expect.poll(async () => {
      const settings = await getResolvedSettings(page)
      return settings?.agentChat?.providers?.freshclaude?.effort ?? null
    }).toBeNull()

    const configPath = path.join(serverInfo.homeDir, '.freshell', 'config.json')
    await expect.poll(async () => {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
      return config.settings.agentChat?.providers?.freshclaude?.effort ?? null
    }).toBeNull()

    await page.reload()
    await waitForReady(page)
    await enableFreshclaude(page)

    await clearSentWsMessages(page)
    await createFreshclaudePane(page, serverInfo.homeDir)

    await expect.poll(async () => {
      const sent = await getSentWsMessages(page)
      const create = sent.find((message) => message?.type === 'sdk.create')
      return create
        ? {
            model: create.model ?? null,
            effort: Object.prototype.hasOwnProperty.call(create, 'effort') ? create.effort : null,
          }
        : null
    }).toEqual({
      model: 'opus',
      effort: null,
    })

    await context.close()
  })

  test('freshclaude tracked model selections persist across reload and provider-default clears the override', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.route('**/api/agent-chat/capabilities/freshclaude', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: 1_234,
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo'],
                supportsAdaptiveThinking: true,
              },
              {
                id: 'opus[1m]',
                displayName: 'Opus 1M',
                description: 'Long context window',
                supportsEffort: true,
                supportedEffortLevels: ['warp'],
                supportsAdaptiveThinking: true,
              },
            ],
          },
        }),
      })
    })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await enableFreshclaude(page)

    await createFreshclaudePane(page, serverInfo.homeDir)

    const dialog = await openFreshclaudeSettings(page)
    await dialog.getByRole('combobox', { name: /^Model$/i }).selectOption({ label: 'Opus 1M' })

    await expect.poll(async () => {
      const settings = await getResolvedSettings(page)
      return settings?.agentChat?.providers?.freshclaude?.modelSelection?.modelId ?? null
    }).toBe('opus[1m]')
    await expect.poll(async () => {
      const settings = await getResolvedSettings(page)
      return settings?.agentChat?.providers?.freshclaude?.effort ?? null
    }).toBeNull()

    await page.reload()
    await waitForReady(page)
    await enableFreshclaude(page)

    await clearSentWsMessages(page)
    await createFreshclaudePane(page, serverInfo.homeDir)

    await expect.poll(async () => {
      const sent = await getSentWsMessages(page)
      const create = sent.find((message) => message?.type === 'sdk.create')
      return create
        ? {
            model: create.model ?? null,
            effort: Object.prototype.hasOwnProperty.call(create, 'effort') ? create.effort : null,
          }
        : null
    }).toEqual({
      model: 'opus[1m]',
      effort: null,
    })

    const refreshedDialog = await openFreshclaudeSettings(page)
    await refreshedDialog.getByRole('combobox', { name: /^Model$/i }).selectOption({
      label: 'Provider default (track latest Opus)',
    })

    await expect.poll(async () => {
      const settings = await getResolvedSettings(page)
      return settings?.agentChat?.providers?.freshclaude?.modelSelection
    }).toBeUndefined()
    await expect.poll(async () => {
      const settings = await getResolvedSettings(page)
      return settings?.agentChat?.providers?.freshclaude?.effort ?? null
    }).toBeNull()

    await page.reload()
    await waitForReady(page)
    await enableFreshclaude(page)

    await clearSentWsMessages(page)
    await createFreshclaudePane(page, serverInfo.homeDir)

    await expect.poll(async () => {
      const sent = await getSentWsMessages(page)
      const create = sent.find((message) => message?.type === 'sdk.create')
      return create
        ? {
            model: create.model ?? null,
            effort: Object.prototype.hasOwnProperty.call(create, 'effort') ? create.effort : null,
          }
        : null
    }).toEqual({
      model: 'opus',
      effort: null,
    })

    const configPath = path.join(serverInfo.homeDir, '.freshell', 'config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    expect(config.settings.agentChat?.providers?.freshclaude?.effort).toBeUndefined()
    expect(config.settings.agentChat?.providers?.freshclaude?.defaultEffort).toBeUndefined()

    await context.close()
  })

  test('freshclaude saved tracked selections stay visible and still launch when the live catalog drops them', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.route('**/api/agent-chat/capabilities/freshclaude', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: 2_468,
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo'],
                supportsAdaptiveThinking: true,
              },
              {
                id: 'opus[1m]',
                displayName: 'Opus 1M',
                description: 'Long context window',
                supportsEffort: true,
                supportedEffortLevels: ['warp'],
                supportsAdaptiveThinking: true,
              },
            ],
          },
        }),
      })
    })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await enableFreshclaude(page)

    await patchServerSettings(page, serverInfo, {
      agentChat: {
        providers: {
          freshclaude: {
            modelSelection: { kind: 'tracked', modelId: 'haiku' },
            effort: null,
          },
        },
      },
    })

    await page.reload()
    await waitForReady(page)
    await enableFreshclaude(page)

    await clearSentWsMessages(page)
    await createFreshclaudePane(page, serverInfo.homeDir)

    await expect.poll(async () => {
      const sent = await getSentWsMessages(page)
      const create = sent.find((message) => message?.type === 'sdk.create')
      return create
        ? {
            model: create.model ?? null,
            effort: Object.prototype.hasOwnProperty.call(create, 'effort') ? create.effort : null,
          }
        : null
    }).toEqual({
      model: 'haiku',
      effort: null,
    })

    const dialog = await openFreshclaudeSettings(page)
    await expect(
      dialog.getByRole('combobox', { name: /^Model$/i }).locator('option:checked'),
    ).toHaveText('haiku (Saved selection)')
    await expect(dialog.getByText('Saved tracked model is not in the latest capability catalog.')).toBeVisible()

    await context.close()
  })

  test('freshclaude legacy exact selections stay visible after reload instead of silently migrating', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.route('**/api/agent-chat/capabilities/freshclaude', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: 3_456,
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo'],
                supportsAdaptiveThinking: true,
              },
            ],
          },
        }),
      })
    })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await enableFreshclaude(page)

    await patchServerSettings(page, serverInfo, {
      agentChat: {
        providers: {
          freshclaude: {
            modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
            effort: null,
          },
        },
      },
    })

    await page.reload()
    await waitForReady(page)
    await enableFreshclaude(page)

    await clearSentWsMessages(page)
    await createFreshclaudePane(page, serverInfo.homeDir)

    await expect(page.getByText('Session start failed')).toBeVisible()
    await expect(page.getByText('Selected model claude-opus-4-6 is no longer available.')).toBeVisible()
    await expect.poll(async () => {
      const sent = await getSentWsMessages(page)
      return sent.filter((message) => message?.type === 'sdk.create').length
    }).toBe(0)

    const dialog = await openFreshclaudeSettings(page)
    await expect(
      dialog.getByRole('combobox', { name: /^Model$/i }).locator('option:checked'),
    ).toHaveText('claude-opus-4-6 (Unavailable)')
    await expect(dialog.getByText('Saved legacy model is no longer available.')).toBeVisible()

    await context.close()
  })

  test('freshclaude unfamiliar effort strings render and round-trip correctly across reload', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.route('**/api/agent-chat/capabilities/freshclaude', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: 4_567,
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo'],
                supportsAdaptiveThinking: true,
              },
              {
                id: 'opus[1m]',
                displayName: 'Opus 1M',
                description: 'Long context window',
                supportsEffort: true,
                supportedEffortLevels: ['warp-core', 'plaid'],
                supportsAdaptiveThinking: true,
              },
            ],
          },
        }),
      })
    })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await enableFreshclaude(page)

    await patchServerSettings(page, serverInfo, {
      agentChat: {
        providers: {
          freshclaude: {
            modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
            effort: 'warp-core',
          },
        },
      },
    })

    await page.reload()
    await waitForReady(page)
    await enableFreshclaude(page)

    await clearSentWsMessages(page)
    await createFreshclaudePane(page, serverInfo.homeDir)

    const dialog = await openFreshclaudeSettings(page)
    await expect(
      dialog.getByRole('combobox', { name: /^Model$/i }).locator('option:checked'),
    ).toHaveText('Opus 1M')

    const effortSelect = dialog.getByRole('combobox', { name: /^Effort$/i })
    const effortLabels = await effortSelect.locator('option').evaluateAll(
      (options) => options.map((option) => option.textContent),
    )
    expect(effortLabels).toEqual(['Model default', 'warp-core', 'plaid'])
    await expect(effortSelect).toBeDisabled()
    await expect(effortSelect.locator('option:checked')).toHaveText('warp-core')

    await expect.poll(async () => {
      const sent = await getSentWsMessages(page)
      const create = sent.find((message) => message?.type === 'sdk.create')
      return create
        ? {
            model: create.model ?? null,
            effort: Object.prototype.hasOwnProperty.call(create, 'effort') ? create.effort : null,
          }
        : null
    }).toEqual({
      model: 'opus[1m]',
      effort: 'warp-core',
    })

    const configPath = path.join(serverInfo.homeDir, '.freshell', 'config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    expect(config.settings.agentChat?.providers?.freshclaude?.effort).toBe('warp-core')

    await context.close()
  })
})
