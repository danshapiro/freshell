import type { Browser, Locator, Page } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, createFreshE2ePage } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const source = fileURLToPath(new URL('../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs', import.meta.url))


function controlReplies(page: Page) {
  const frames: Array<Record<string, unknown>> = []
  page.on('websocket', (socket) => socket.on('framesent', (frame) => {
    try {
      const message = JSON.parse(String(frame.payload))
      if (message.type === 'freshAgent.question.respond' || message.type === 'freshAgent.elicitation.respond') frames.push(message)
    } catch { /* Non-JSON frames are unrelated to controls. */ }
  }))
  return frames
}

function controlRequests(page: Page) {
  const requests: Array<Record<string, unknown>> = []
  page.on('websocket', (socket) => socket.on('framereceived', (frame) => {
    try {
      const message = JSON.parse(String(frame.payload))
      if (['freshAgent.question.request', 'freshAgent.elicitation.request'].includes(message.event?.type)) requests.push(message.event)
    } catch { /* Non-JSON frames are unrelated to controls. */ }
  }))
  return requests
}

test('Freshcodex retains secret native question metadata after reload and sends its exact answer', async ({ browser }) => {
  test.setTimeout(180_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshcodex-controls-'))
  const wrapper = path.join(root, 'codex.mjs')
  await fs.writeFile(wrapper, `#!/usr/bin/env node\nimport ${JSON.stringify(source)}\n`)
  await fs.chmod(wrapper, 0o755)
  const server = new RustServer({ env: {
    CODEX_CMD: wrapper,
    FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
    FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ recordTurns: true, serverRequestsByPrompt: { 'Ask for token': { id: 51, method: 'item/tool/requestUserInput', params: { isBlocking: false, questions: [{ id: 'token', header: 'Token', question: 'Enter token', options: null, isOther: false, isSecret: true }] } } } }),
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
    const replies = controlReplies(page)
    const requests = controlRequests(page)
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
    await pane.getByRole('textbox', { name: 'Chat message input' }).fill('Ask for token')
    await pane.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(pane.getByRole('region', { name: 'Question from Codex' })).toBeVisible()
    const other = pane.getByRole('button', { name: 'Other', exact: true })
    if (await other.count()) await other.click()
    const secret = pane.getByLabel('Enter token')
    await expect(secret).toHaveAttribute('type', 'password')
    await secret.fill('unsent secret')
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    await expect(secret).toHaveAttribute('type', 'password')
    await expect(secret).toHaveValue('')
    await expect(pane.getByRole('button', { name: 'Other', exact: true })).toHaveCount(0)
    await secret.fill('  token, punctuation!  ')
    await pane.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(secret).toHaveCount(0)
    expect(requests[0]?.providerRequest).toMatchObject({ id: 51, method: 'item/tool/requestUserInput' })
    expect(replies).toEqual([{ type: 'freshAgent.question.respond', sessionId: 'thread-new-1', sessionType: 'freshcodex', provider: 'codex', requestId: requests[0]?.requestId, answers: { token: '  token, punctuation!  ' } }])
    await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  } finally {
    await context?.close().catch(() => {})
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})


async function withNativeControl(browser: Browser, params: Record<string, unknown>, run: (page: Page, pane: Locator, replies: Array<Record<string, unknown>>, requests: Array<Record<string, unknown>>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshcodex-elicitation-'))
  const wrapper = path.join(root, 'codex.mjs')
  await fs.writeFile(wrapper, `#!/usr/bin/env node\nimport ${JSON.stringify(source)}\n`)
  await fs.chmod(wrapper, 0o755)
  const server = new RustServer({ env: {
    CODEX_CMD: wrapper,
    FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
    FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ recordTurns: true, serverRequestsByPrompt: { 'Ask fixture': { id: 41, method: 'mcpServer/elicitation/request', params: { serverName: 'contract', message: 'A native MCP request', ...params } } } }),
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
    const replies = controlReplies(page)
    const requests = controlRequests(page)
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
    await pane.getByRole('textbox', { name: 'Chat message input' }).fill('Ask fixture')
    await pane.getByRole('button', { name: 'Send', exact: true }).click()
    await run(page, pane, replies, requests)
  } finally {
    await context?.close().catch(() => {})
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
}

for (const mode of ['form', 'openai/form', 'openaiForm']) {
  test(`Freshcodex answers native ${mode} with typed values after reload`, async ({ browser }) => {
    test.setTimeout(180_000)
    await withNativeControl(browser, { mode, requestedSchema: { type: 'object', properties: {
      token: { type: 'string', title: 'Token', writeOnly: true },
      count: { type: 'integer', title: 'Count', minimum: 1, maximum: 5 },
      enabled: { type: 'boolean', title: 'Enabled' },
      color: { type: 'string', title: 'Color', enum: ['blue', 'green'] },
      colors: { type: 'array', title: 'Colors', items: { type: 'string', enum: ['blue', 'green'] } },
    }, required: ['token', 'count', 'enabled', 'color', 'colors'] } }, async (page, pane, replies, requests) => {
      const banner = pane.getByRole('region', { name: 'Request from contract' })
      await expect(banner).toBeVisible()
      await expect(banner.getByLabel('Token', { exact: true })).toHaveAttribute('type', 'password')
      await banner.getByLabel('Token', { exact: true }).fill('unsent fixture value')
      await page.reload()
      await expect(banner).toBeVisible({ timeout: 30_000 })
      await expect(banner.getByLabel('Token', { exact: true })).toHaveValue('')
      expect(replies).toEqual([])
      await banner.getByLabel('Token', { exact: true }).fill(' exact, form answer! ')
      await banner.getByLabel('Count', { exact: true }).fill('3')
      await banner.getByLabel('Enabled', { exact: true }).selectOption('false')
      await banner.getByLabel('Color', { exact: true }).selectOption('blue')
      await banner.getByLabel('Colors', { exact: true }).selectOption(['blue', 'green'])
      await banner.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(banner).toHaveCount(0)
      expect(requests[0]?.providerRequest).toMatchObject({ id: 41, method: 'mcpServer/elicitation/request' })
      expect(replies).toEqual([{ type: 'freshAgent.elicitation.respond', sessionId: 'thread-new-1', sessionType: 'freshcodex', provider: 'codex', requestId: requests[0]?.requestId, action: 'accept', content: { token: ' exact, form answer! ', count: 3, enabled: false, color: 'blue', colors: ['blue', 'green'] } }])
    })
  })
}

test('Freshcodex opens native URL elicitation without accepting until Continue is clicked', async ({ browser }) => {
  test.setTimeout(180_000)
  await withNativeControl(browser, { mode: 'url', turnId: null, url: 'https://elicitation.example.test/confirm', elicitationId: 'public-url-id' }, async (page, pane, replies, requests) => {
    await page.context().route('https://elicitation.example.test/**', (route) => route.fulfill({ body: 'Controlled fixture page' }))
    const banner = pane.getByRole('region', { name: 'Request from contract' })
    await expect(banner).toBeVisible()
    const popupPromise = page.waitForEvent('popup')
    await banner.getByRole('link', { name: 'Open contract page' }).click()
    const popup = await popupPromise
    expect(replies).toEqual([])
    await expect(banner).toBeVisible()
    await popup.close()
    await banner.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(banner).toHaveCount(0)
    expect(requests[0]?.providerRequest).toMatchObject({ id: 41, method: 'mcpServer/elicitation/request' })
    expect(replies).toEqual([{ type: 'freshAgent.elicitation.respond', sessionId: 'thread-new-1', sessionType: 'freshcodex', provider: 'codex', requestId: requests[0]?.requestId, action: 'accept', content: null }])
  })
})
