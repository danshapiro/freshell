import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, createFreshE2ePage } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const source = fileURLToPath(new URL('../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs', import.meta.url))
const parentId = '11111111-1111-4111-8111-111111111111'
const childId = '22222222-2222-4222-8222-222222222222'

test('Freshcodex observes the exact child read-only and restores the selection after reload', async ({ browser }) => {
  test.setTimeout(180_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshcodex-child-'))
  const wrapper = path.join(root, 'codex.mjs')
  const operations = path.join(root, 'operations.jsonl')
  const outputImage = path.join(root, 'generated-output.png')
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1UAAAAASUVORK5CYII=', 'base64')
  await fs.writeFile(outputImage, imageBytes)
  await fs.writeFile(wrapper, `#!/usr/bin/env node\nimport ${JSON.stringify(source)}\n`)
  await fs.chmod(wrapper, 0o755)
  const parent = { id: parentId, ephemeral: false, status: { type: 'idle' }, turns: [{ id: 'parent-turn', status: 'completed', items: [
    { id: 'parent-answer', type: 'agentMessage', text: 'Parent conversation remains available' },
    { id: 'denied', type: 'commandExecution', command: 'touch blocked', status: 'declined', aggregatedOutput: 'User declined', exitCode: null },
    { id: 'image-output', type: 'imageGeneration', status: 'completed', result: outputImage, savedPath: outputImage },
    { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: parentId, receiverThreadIds: [childId], agentsStates: { [childId]: { status: 'completed', message: 'Child finished', model: 'child-model' } } },
  ] }] }
  const child = { id: childId, parentThreadId: parentId, ephemeral: false, status: { type: 'idle' }, turns: [
    { id: 'child-turn', status: 'completed', itemsView: 'full', items: [{ id: 'child-answer', type: 'agentMessage', text: 'Exact observed child answer' }] },
    { id: 'preview-turn', status: 'interrupted', itemsView: 'summary', items: [{ id: 'child-preview', type: 'agentMessage', summary: 'Partial child preview' }] },
  ] }
  const server = new RustServer({ env: {
    CODEX_CMD: wrapper,
    FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
    FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ threadStartThreadId: parentId, appendThreadOperationLogPath: operations, threadReadResults: { [parentId]: parent, [childId]: child }, overrides: { 'thread/read': { result: { thread: parent } } } }),
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
    await expect(pane.getByText('Parent conversation remains available', { exact: true })).toBeVisible({ timeout: 30_000 })
    const before = await fs.readFile(operations, 'utf8')
    const open = pane.getByRole('button', { name: `Observe child ${childId}`, exact: true }).first()
    await open.click({ timeout: 15_000 })
    const observer = page.getByRole('dialog', { name: 'Child conversation' })
    await expect(observer.getByText('Exact observed child answer', { exact: true })).toBeVisible()
    await expect(observer.getByText('Partial child preview', { exact: true })).toBeVisible()
    await expect(observer.getByRole('note', { name: 'Output persistence' })).toHaveText('Native preview. Interrupted.')
    await expect(observer.getByRole('textbox')).toHaveCount(0)
    await expect(observer.getByRole('button', { name: /send|stop|configure|resume/i })).toHaveCount(0)
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    await expect(observer.getByText('Exact observed child answer', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(observer.getByRole('note', { name: 'Output persistence' })).toHaveText('Native preview. Interrupted.')
    await expect(pane.getByText('Parent conversation remains available', { exact: true })).toHaveCount(1)
    await observer.getByRole('button', { name: 'Close child conversation' }).click()
    await expect(observer).toHaveCount(0)
    await pane.getByRole('button', { name: 'Toggle activity details' }).first().click()
    await expect(pane.getByLabel('declined')).toBeVisible()
    await pane.getByRole('button', { name: 'ImageGeneration tool call' }).click()
    const output = pane.getByRole('link', { name: outputImage, exact: true })
    await expect(output).toBeVisible()
    const image = await page.request.get(new URL((await output.getAttribute('href'))!, info.baseUrl).href)
    expect(image.status()).toBe(200)
    expect(await image.body()).toEqual(imageBytes)
    const rows = (await fs.readFile(operations, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const prior = before.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(rows.filter((row) => row.method === 'thread/start')).toHaveLength(prior.filter((row) => row.method === 'thread/start').length)
    expect(rows.filter((row) => row.params?.threadId === childId && row.method !== 'thread/read')).toEqual([])
  } finally {
    await context?.close().catch(() => {})
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
