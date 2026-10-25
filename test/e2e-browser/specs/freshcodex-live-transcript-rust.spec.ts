import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, createFreshE2ePage } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const source = fileURLToPath(new URL('../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs', import.meta.url))

test('Freshcodex shows native text and command progress before completion, then one saved answer after reload', async ({ browser }) => {
  test.setTimeout(180_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshcodex-live-'))
  const wrapper = path.join(root, 'codex.mjs')
  const release = path.join(root, 'release')
  const nativeLog = path.join(root, 'native.jsonl')
  await fs.writeFile(wrapper, `#!/usr/bin/env node\nimport ${JSON.stringify(source)}\n`)
  await fs.chmod(wrapper, 0o755)
  const server = new RustServer({ env: {
    CODEX_CMD: wrapper,
    FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
    FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ recordTurns: true, liveTranscript: true, waitForTurnReleasePath: release, appendNativeNotificationLogPath: nativeLog }),
  }, setupHome: async (home) => {
    await fs.mkdir(path.join(home, '.freshell'), { recursive: true })
    await fs.writeFile(path.join(home, '.freshell/config.json'), JSON.stringify({ version: 1, settings: {
      freshAgent: { enabled: true }, codingCli: { enabledProviders: ['codex'] },
    } }))
  } })
  let context: Awaited<ReturnType<typeof createFreshE2ePage>>['context'] | undefined
  try {
    const info = await server.start()
    const owned = await createFreshE2ePage(browser, info)
    context = owned.context
    const page = owned.page
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'connection/setAvailableClis', payload: { claude: false, codex: true } }))
    const picker = await openPanePicker(page)
    await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
    const directory = page.getByRole('combobox', { name: 'Starting directory for Freshcodex' })
    await directory.fill(root)
    await directory.press('Enter')
    const pane = page.locator('[data-context="fresh-agent"]').last()
    const input = pane.getByRole('textbox', { name: 'Chat message input' })
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill('Show native live progress')
    await pane.getByRole('button', { name: 'Send' }).click()
    await expect.poll(async () => (await fs.readFile(nativeLog, 'utf8')).includes('item/agentMessage/delta')).toBe(true)
    expect(await fs.readFile(nativeLog, 'utf8')).not.toContain('turn/completed')
    await expect(pane.getByText('Native streaming fragment', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(pane.getByText('Inspect progress', { exact: true })).toBeVisible()
    await expect(pane.getByText('Old plan', { exact: true })).toHaveCount(0)
    await expect(pane.getByText('Latest usage 20 tokens', { exact: true })).toBeVisible()
    await expect(pane.getByRole('meter', { name: 'Context window used' })).toHaveCount(0)
    await pane.getByRole('button', { name: 'Diff: Turn changes' }).click()
    await expect(pane.getByText('+replacement', { exact: true })).toBeVisible()
    await expect(pane.getByText('+previous', { exact: true })).toHaveCount(0)
    await pane.getByRole('button', { name: 'Toggle activity details' }).first().click()
    await pane.getByRole('button', { name: 'Bash tool call' }).click()
    await expect(pane.getByText('command progress before completion', { exact: true })).toBeVisible()
    const reasoning = pane.getByText('Native reasoning in progress', { exact: true })
    if (!await reasoning.isVisible()) await pane.getByRole('button', { name: 'Thinking', exact: true }).last().click()
    await expect(reasoning).toBeVisible()
    expect(await fs.readFile(nativeLog, 'utf8')).not.toContain('turn/completed')
    await expect(pane.getByRole('button', { name: 'Stop' })).toBeVisible()
    await fs.writeFile(release, 'release')
    await expect(pane.getByText('Native streaming fragment and final answer', { exact: true })).toHaveCount(1, { timeout: 30_000 })
    await expect(pane.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 30_000 })
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    await expect(page.getByText('Native streaming fragment and final answer', { exact: true })).toHaveCount(1, { timeout: 30_000 })
  } finally {
    await fs.writeFile(release, 'release').catch(() => {})
    await context?.close()
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
