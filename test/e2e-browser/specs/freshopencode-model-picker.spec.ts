import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function enableFreshClientsAndOpencode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: true, opencode: true },
    })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: {
        codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
        freshAgent: { enabled: true },
      },
    })
  })
}

async function openFreshAgentSettings(page: Page, providerName: string) {
  const pane = page.getByRole('group').filter({
    has: page.getByText(providerName, { exact: true }),
  }).last()
  await expect(pane).toBeVisible({ timeout: 10_000 })

  const dialog = pane.getByRole('dialog', { name: 'Agent settings' })
  if (!(await dialog.isVisible().catch(() => false))) {
    await pane.getByRole('button', { name: /^agent settings$/i }).click()
  }

  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

test.describe('Freshopencode model picker', () => {
  test('shows MRU tiles, sorted modal sources, and client-side filtering', async ({
    freshellPage,
    page,
    harness,
    terminal,
  }) => {
    await terminal.waitForTerminal()

    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-model-picker-'))

    const fixture = {
      ok: true,
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      status: 'fresh' as const,
      fetchedAt: Date.now(),
      models: [
        {
          id: 'opencode-go/deepseek-v4-flash',
          displayName: 'DeepSeek V4 Flash',
          provider: 'opencode',
          source: { id: 'opencode-go', displayName: 'opencode-go' },
          supportsEffort: true,
          supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'opencode-go/glm-4.5',
          displayName: 'GLM 4.5',
          provider: 'opencode',
          source: { id: 'opencode-go', displayName: 'opencode-go' },
          supportsEffort: true,
          supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'opencode-go/glm-5.2',
          displayName: 'GLM 5.2',
          provider: 'opencode',
          source: { id: 'opencode-go', displayName: 'opencode-go' },
          supportsEffort: true,
          supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'opencode-go/kimi-k2.7',
          displayName: 'Kimi K2.7',
          provider: 'opencode',
          source: { id: 'opencode-go', displayName: 'opencode-go' },
          supportsEffort: true,
          supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'deepseek/deepseek-v4-pro',
          displayName: 'DeepSeek V4 Pro',
          provider: 'opencode',
          source: { id: 'deepseek', displayName: 'deepseek' },
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'glm-vast/glm-vast-alpha',
          displayName: 'GLM Vast Alpha',
          provider: 'opencode',
          source: { id: 'glm-vast', displayName: 'glm-vast' },
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'glm-vast/glm-vast-beta',
          displayName: 'GLM Vast Beta',
          provider: 'opencode',
          source: { id: 'glm-vast', displayName: 'glm-vast' },
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: true,
        },
      ],
    }

    let capabilityRequests = 0
    let capturedUrl: string | undefined
    await page.route('**/api/fresh-agent/model-capabilities/freshopencode?**', async (route) => {
      capabilityRequests += 1
      capturedUrl = route.request().url()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture),
      })
    })
    await page.route('**/api/files/candidate-dirs', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ directories: ['/tmp'] }),
      })
    })
    await page.route('**/api/files/validate-dir', async (route) => {
      const body = route.request().postDataJSON() as { path?: string }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: true, resolvedPath: body?.path ?? cwd }),
      })
    })

    await enableFreshClientsAndOpencode(page)

    const mruEntries = [
      {
        id: 'opencode-go/deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        cwdKey: cwd,
        lastVerifiedAt: Date.now(),
      },
      {
        id: 'deepseek/deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        source: { id: 'deepseek', displayName: 'deepseek' },
        cwdKey: cwd,
        lastVerifiedAt: Date.now(),
      },
      {
        id: 'glm-vast/glm-vast-alpha',
        displayName: 'GLM Vast Alpha',
        source: { id: 'glm-vast', displayName: 'glm-vast' },
        cwdKey: cwd,
        lastVerifiedAt: Date.now(),
      },
      {
        id: 'opencode-go/glm-5.2',
        displayName: 'GLM 5.2',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        cwdKey: cwd,
        lastVerifiedAt: Date.now(),
      },
    ]
    await page.evaluate((mru) => {
      window.localStorage.setItem('freshopencode.modelMru.v2', JSON.stringify(mru))
    }, mruEntries)

    const picker = await openPanePicker(page)
    await expect(picker.getByRole('button', { name: /^Freshopencode$/i })).toBeVisible({ timeout: 10_000 })
    const targetPaneId = await picker.getAttribute('data-pane-id')
    expect(targetPaneId).toBeTruthy()
    await page.evaluate((paneId) => {
      window.__FRESHELL_TEST_HARNESS__?.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    }, targetPaneId!)
    await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })
    const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
    await expect(directoryInput).toBeVisible({ timeout: 15_000 })
    await directoryInput.fill(cwd)
    await directoryInput.press('Enter')
    await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })

    let dialog = await openFreshAgentSettings(page, 'Freshopencode')

    await expect.poll(async () => capabilityRequests).toBeGreaterThanOrEqual(1)
    expect(capturedUrl).toContain('cwd=')

    const labels = (await dialog.locator('.font-medium').allTextContents()).map((s) => s.trim())
    const styleIndex = labels.indexOf('Style')
    const thinkingIndex = labels.indexOf('Thinking')
    const modelIndex = labels.indexOf('Model')
    expect(styleIndex).toBeGreaterThanOrEqual(0)
    expect(thinkingIndex).toBeGreaterThan(styleIndex)
    expect(modelIndex).toBeGreaterThan(thinkingIndex)

    await expect(page.getByRole('dialog', { name: 'Choose Freshopencode model' })).toHaveCount(0)
    const mruTiles = dialog.getByRole('button', { name: /(Use model|Current model):/i })
    await expect(mruTiles).toHaveCount(4)
    await expect(dialog.getByRole('heading', { name: 'deepseek' })).toHaveCount(0)
    await expect(dialog.getByRole('heading', { name: 'glm-vast' })).toHaveCount(0)
    await expect(dialog.getByRole('heading', { name: 'opencode-go' })).toHaveCount(0)

    await dialog.getByRole('button', { name: /Use model: DeepSeek V4 Pro/i }).click()
    await expect.poll(async () => {
      const settings = await harness.getSettings()
      return settings?.freshAgent?.providers?.freshopencode?.modelSelection?.modelId
    }).toBe('deepseek/deepseek-v4-pro')

    const searchEntry = dialog.getByRole('searchbox', { name: /Search enabled models/i })
    await searchEntry.click()
    const modal = page.getByRole('dialog', { name: 'Choose Freshopencode model' })
    await expect(modal).toBeVisible({ timeout: 10_000 })

    const headingTexts = await modal.getByRole('heading').allTextContents()
    expect(headingTexts).toEqual(['deepseek', 'glm-vast', 'opencode-go'])

    const opencodeGoHeading = modal.getByRole('heading', { name: 'opencode-go' })
    const opencodeGoGroup = opencodeGoHeading.locator('xpath=..')
    const opencodeGoButtons = opencodeGoGroup.getByRole('button', { name: /Use model:/i })
    const opencodeGoModelNames = (await opencodeGoButtons.allTextContents()).map((s) => s.trim())
    expect(opencodeGoModelNames).toEqual(['DeepSeek V4 Flash', 'GLM 4.5', 'GLM 5.2', 'Kimi K2.7'])

    await modal.getByRole('searchbox', { name: /Filter enabled models/i }).fill('glm')
    await modal.getByRole('searchbox', { name: /Filter enabled models/i }).fill('glm 5.2')
    expect(capabilityRequests).toBe(1)

    await expect(modal.getByRole('button', { name: /Use model: GLM 5\.2/i })).toBeVisible()
    await expect(modal.getByRole('button', { name: /Use model: DeepSeek V4 Pro/i })).toHaveCount(0)

    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    await page.setViewportSize({ width: 400, height: 800 })
    dialog = await openFreshAgentSettings(page, 'Freshopencode')
    const narrowMruTiles = dialog.getByRole('button', { name: /(Use model|Current model):/i })
    await expect(narrowMruTiles.nth(0)).toBeVisible({ timeout: 10_000 })
    await expect(narrowMruTiles.nth(1)).toBeVisible()
    await expect(narrowMruTiles.nth(2)).toBeVisible()
    await expect(narrowMruTiles.nth(3)).toBeHidden()
  })
})
