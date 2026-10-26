import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, createFreshE2ePage } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const source = fileURLToPath(new URL('../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs', import.meta.url))

test('Freshcodex retains a refused prompt with its delivery reason', async ({ browser }) => {
  test.setTimeout(180_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshcodex-delivery-'))
  const wrapper = path.join(root, 'codex.mjs')
  await fs.writeFile(wrapper, `#!/usr/bin/env node\nimport ${JSON.stringify(source)}\n`)
  await fs.chmod(wrapper, 0o755)
  const server = new RustServer({ env: {
    CODEX_CMD: wrapper,
    FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
    FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ overrides: { 'turn/start': { error: { code: -32602, message: 'This input was refused before admission' } } } }),
  }, setupHome: async (home) => {
    await fs.mkdir(path.join(home, '.freshell'), { recursive: true })
    await fs.writeFile(path.join(home, '.freshell/config.json'), JSON.stringify({ version: 1, settings: { freshAgent: { enabled: true }, codingCli: { enabledProviders: ['codex'] } } }))
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
    await input.fill('Keep the original prompt')
    await pane.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(input).toHaveValue('Keep the original prompt', { timeout: 15_000 })
    await expect(pane.getByText(/Message not sent:.*refused before admission/)).toBeVisible()
  } finally {
    await context?.close().catch(() => {})
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
