import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, createFreshE2ePage } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { createHash, randomUUID } from 'node:crypto'

const source = fileURLToPath(new URL('../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs', import.meta.url))

/** Match the qualified native contract: initial session metadata exists before
 * completion. Only the executable is replaced; every server and UI door is real. */
async function installNativeWrapper(file: string, processSetup = ''): Promise<void> {
  await fs.writeFile(file, `#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
const threadId=randomUUID()
let behavior=JSON.parse(process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR)
${processSetup}
process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR=JSON.stringify({
  ...behavior,threadStartThreadId:threadId,requestLogContext:{nativeThreadId:threadId},
  writeRolloutOnMethods:{'turn/start':{path:path.join(process.env.CODEX_HOME,'sessions','rollout-'+threadId+'.jsonl'),record:{type:'session_meta',payload:{id:threadId,cwd:process.cwd()}}}}
})
await import(${JSON.stringify(source)})
`)
  await fs.chmod(file, 0o755)
}

for (const terminalItemsView of ['summary', 'notLoaded']) test(`Freshcodex shows native text and command progress before ${terminalItemsView} completion, isolates hidden panes, then restores one saved answer`, async ({ browser }) => {
  test.setTimeout(180_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshcodex-live-'))
  const wrapper = path.join(root, 'codex.mjs')
  const release = path.join(root, 'release')
  const nativeLog = path.join(root, 'native.jsonl')
  const nativeRequests = path.join(root, 'native-requests.jsonl')
  const nativeFileReads = path.join(root, 'native-file-reads.jsonl')
  await installNativeWrapper(wrapper)
  const server = new RustServer({ env: {
    CODEX_CMD: wrapper,
    FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
    FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ recordTurns: true, echoRequestedModel: true, liveTranscript: true, liveTranscriptPrompts: ['Show native live progress'], terminalItemsView,
      waitForTurnReleasePath: release, appendNativeNotificationLogPath: nativeLog, appendRequestLogPath: nativeRequests,
      appendInputFileReadLogPath: nativeFileReads,
      serverRequestsByPrompt: { SECOND_PANE_WAIT: { id: 'second-pane-question', method: 'item/tool/requestUserInput', params: { isBlocking: true,
        questions: [{ id: 'second', header: 'Second', question: 'Second pane question?', options: [{ label: 'Second pane choice', description: 'Only this pane' }] }] } } } }),
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
    const pendingPane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pendingPane).toBeVisible()
    const paneId = await pendingPane.getAttribute('data-pane-id')
    expect(paneId).toBeTruthy()
    const pane = page.locator(`[data-context="fresh-agent"][data-pane-id="${paneId}"]`)
    const input = pane.getByRole('textbox', { name: 'Chat message input' })
    await expect(input).toBeEnabled({ timeout: 30_000 })
    const uploadedImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1UAAAAASUVORK5CYII=', 'base64')
    const uploadedNotes = Buffer.from('Uploaded fixture notes')
    await pane.locator('input[type="file"]').setInputFiles([
      { name: 'native-upload.png', mimeType: 'image/png', buffer: uploadedImage },
      { name: 'native-notes.txt', mimeType: 'text/plain', buffer: uploadedNotes },
    ])
    await expect(pane.getByRole('list', { name: 'Attachments' }).getByText('native-upload.png')).toBeVisible()
    await expect(pane.getByRole('list', { name: 'Attachments' }).getByText('native-notes.txt')).toBeVisible()
    await expect(pane.getByLabel('uploading')).toHaveCount(0)
    const attachments = pane.getByRole('list', { name: 'Attachments' })
    const imagePath = await attachments.getByRole('listitem').filter({ hasText: 'native-upload.png' }).getAttribute('title')
    const notesPath = await attachments.getByRole('listitem').filter({ hasText: 'native-notes.txt' }).getAttribute('title')
    expect(imagePath && path.isAbsolute(imagePath)).toBe(true)
    expect(notesPath && path.isAbsolute(notesPath)).toBe(true)
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
    const originalTab = await harness.getActiveTabId()
    const opened = await page.request.post(`${info.baseUrl}/api/tabs`, { headers: { 'x-auth-token': info.token },
      data: { agent: 'codex', cwd: root, model: 'other-pane-model', effort: 'low' } })
    expect(opened.ok(), await opened.text()).toBe(true)
    const body = await opened.json()
    const otherTab = body.data?.tabId ?? body.tabId
    const otherPaneId = body.data?.paneId ?? body.paneId
    expect(otherTab).not.toBe(originalTab)
    expect(otherPaneId).not.toBe(paneId)
    await expect.poll(() => harness.getActiveTabId()).toBe(originalTab)
    await page.locator(`[data-context="tab"][data-tab-id="${otherTab}"]`).click()
    const otherPane = page.locator(`[data-context="fresh-agent"][data-pane-id="${otherPaneId}"]`)
    const otherInput = otherPane.getByRole('textbox', { name: 'Chat message input' })
    await expect(otherInput).toBeEnabled({ timeout: 30_000 })
    await otherInput.fill('SECOND_PANE_WAIT')
    await otherInput.press('Enter')
    const otherChoice = otherPane.getByRole('button', { name: 'Second pane choice', exact: true })
    await expect(otherChoice).toBeVisible({ timeout: 30_000 })
    const starts = (await fs.readFile(nativeRequests, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.method === 'turn/start')
    expect(starts).toHaveLength(2)
    const firstNativeText = starts[0].params.input.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
    expect(firstNativeText).toContain(imagePath!)
    expect(firstNativeText).toContain(notesPath!)
    expect(new Set(starts.map(row => row.params.threadId)).size).toBe(2)
    expect(starts[1].params).toMatchObject({ model: 'other-pane-model', effort: 'low' })
    await expect(pane).toBeHidden()
    await expect(otherPane.getByText('Native streaming fragment', { exact: true })).toHaveCount(0)
    await otherChoice.focus()
    await fs.writeFile(release, 'release')
    await expect.poll(async () => (await fs.readFile(nativeLog, 'utf8')).includes('turn/completed')).toBe(true)
    await expect.poll(() => harness.getActiveTabId()).toBe(otherTab)
    await expect(otherChoice).toBeFocused()
    await page.locator(`[data-context="tab"][data-tab-id="${originalTab}"]`).click()
    await expect(pane.getByText('Second pane question?', { exact: true })).toHaveCount(0)
    await expect(pane.getByText('Native streaming fragment and final answer', { exact: true })).toHaveCount(1, { timeout: 30_000 })
    await page.locator(`[data-context="tab"][data-tab-id="${otherTab}"]`).click()
    await otherChoice.click()
    await expect(otherChoice).toHaveCount(0)
    await page.locator(`[data-context="tab"][data-tab-id="${originalTab}"]`).click()
    await expect(pane.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 30_000 })
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    await expect(page.getByText('Native streaming fragment and final answer', { exact: true })).toHaveCount(1, { timeout: 30_000 })
    await expect(page.getByLabel('You transcript turn').filter({ hasText: 'native-upload.png' })).toHaveCount(1)
    await expect(page.getByLabel('You transcript turn').filter({ hasText: 'native-notes.txt' })).toHaveCount(1)
    for (const [savedPath, bytes] of [[imagePath!, uploadedImage], [notesPath!, uploadedNotes]] as const) {
      const response = await page.request.get(`${info.baseUrl}/api/files/raw?path=${encodeURIComponent(savedPath)}`,
        { headers: { 'x-auth-token': info.token } })
      expect(response.status(), `Saved attachment resource ${savedPath}`).toBe(200)
      expect(await response.body()).toEqual(bytes)
      const reads = (await fs.readFile(nativeFileReads, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(reads.filter(read => read.path === savedPath)).toEqual([
        expect.objectContaining({ threadId: starts[0].params.threadId, pid: expect.any(Number), uid: expect.any(Number),
          bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }),
      ])
    }
  } finally {
    await fs.writeFile(release, 'release').catch(() => {})
    await context?.close().catch(() => {})
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('Freshcodex discovers the owning native catalog and converges exact settings and names across browsers and reload', async ({ browser }) => {
  test.setTimeout(240_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshcodex-catalog-live-'))
  const cwd = path.join(root, 'project')
  await fs.mkdir(cwd)
  const wrapper = path.join(root, 'codex.mjs')
  const release = path.join(root, 'create-release')
  const nativeLog = path.join(root, 'native.jsonl')
  const sourceCounter = path.join(root, 'catalog-runtime-counter')
  await installNativeWrapper(wrapper, `
const counter=${JSON.stringify(sourceCounter)}
const ordinal=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1
fs.writeFileSync(counter,String(ordinal))
if(ordinal>1)behavior={...behavior,modelCatalogPagesByCwd:{[process.cwd()]:[{data:[{id:'second-runtime-record',model:'second-runtime-model',displayName:'Second runtime model',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}],defaultReasoningEffort:'xhigh',inputModalities:['text']}],nextCursor:null}]}}
`)
  const server = new RustServer({ env: {
    CODEX_CMD: wrapper, FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
    FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ recordTurns: true, echoRequestedModel: true,
      waitForThreadStartReleasePath: release, appendRequestLogPath: nativeLog,
      modelCatalogPagesByCwd: { [cwd]: [{ data: [{ id: 'owning-runtime-record', model: 'catalog-only-model',
        displayName: 'Owning runtime model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }],
        defaultReasoningEffort: 'ultra', inputModalities: ['text', 'image'] }], nextCursor: null }] } }),
  }, setupHome: async home => {
    await fs.mkdir(path.join(home, '.freshell'), { recursive: true })
    await fs.writeFile(path.join(home, '.freshell/config.json'), JSON.stringify({ version: 1, settings: {
      freshAgent: { enabled: true }, codingCli: { enabledProviders: ['codex'] },
    } }))
  } })
  const contexts: Array<Awaited<ReturnType<typeof createFreshE2ePage>>['context']> = []
  const readNative = async (): Promise<any[]> => {
    try { return (await fs.readFile(nativeLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw error }
  }
  try {
    const info = await server.start()
    const a = await createFreshE2ePage(browser, info)
    contexts.push(a.context)
    const page = a.page
    const catalogRequests: URL[] = []
    page.on('request', request => { if (request.url().includes('/api/fresh-agent/model-capabilities/freshcodex')) catalogRequests.push(new URL(request.url())) })
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'connection/setAvailableClis', payload: { claude: false, codex: true } }))
    const picker = await openPanePicker(page)
    await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
    const directory = page.getByRole('combobox', { name: 'Starting directory for Freshcodex' })
    await directory.fill(cwd)
    await directory.press('Enter')
    const pendingPane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pendingPane).toBeVisible()
    const paneId = await pendingPane.getAttribute('data-pane-id')
    expect(paneId).toBeTruthy()
    const pane = page.locator(`[data-context="fresh-agent"][data-pane-id="${paneId}"]`)
    await expect.poll(async () => (await readNative()).filter(row => row.method === 'thread/start').length).toBe(1)
    await pane.getByRole('button', { name: /^Model:.*change model$/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
    await expect(dialog.getByRole('status')).toContainText(/waiting.*runtime/i)
    await dialog.getByRole('textbox', { name: 'Exact model ID' }).fill('custom-omitted-model')
    await dialog.getByRole('textbox', { name: 'Reasoning effort' }).fill('ultra')
    expect(catalogRequests).toHaveLength(0)
    expect((await readNative()).filter(row => row.method === 'model/list')).toHaveLength(0)
    await fs.writeFile(release, 'release')
    await expect(dialog.getByRole('option', { name: 'Owning runtime model', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByRole('button', { name: 'Use custom-omitted-model · ultra' })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Use custom-omitted-model · ultra' }).click()
    const composer = pane.getByRole('textbox', { name: 'Chat message input' })
    const send = async (prompt: string) => {
      await composer.fill(prompt)
      await composer.press('Enter')
      await expect.poll(async () => (await readNative()).filter(row => row.method === 'turn/start'
        && row.params.input.some((item: any) => item.text === prompt)).length).toBe(1)
      await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 })
    }
    await send('Validate the custom model omitted from the native list')
    const first = (await readNative()).find(row => row.method === 'turn/start')
    const nativeId = first.params.threadId
    expect(first.params).toMatchObject({ model: 'custom-omitted-model', effort: 'ultra' })
    expect(catalogRequests.length).toBeGreaterThan(0)
    for (const request of catalogRequests) {
      expect(request.searchParams.get('sessionId')).toBe(nativeId)
      expect(request.searchParams.get('cwd')).toBe(cwd)
    }
    expect((await readNative()).filter(row => row.method === 'model/list').every(row => row.cwd === cwd)).toBe(true)
    expect((await readNative()).filter(row => row.method === 'thread/start')).toHaveLength(1)
    const originalTab = await harness.getActiveTabId()
    expect(originalTab).toBeTruthy()

    const b = await createFreshE2ePage(browser, info)
    contexts.push(b.context)
    await b.page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const otherHarness = new TestHarness(b.page)
    await otherHarness.waitForHarness()
    await otherHarness.waitForConnection()
    // A new browser has its own layout. Explicitly open the same canonical
    // conversation through the public headless-create/resume path, then select it.
    const opened = await b.page.request.post(`${info.baseUrl}/api/tabs`, { headers: { 'x-auth-token': info.token },
      data: { agent: 'codex', cwd, sessionRef: { provider: 'codex', sessionId: nativeId } } })
    expect(opened.ok(), await opened.text()).toBe(true)
    const openedBody = await opened.json()
    const openedTab = openedBody.data?.tabId ?? openedBody.tabId
    await expect.poll(() => harness.getActiveTabId()).toBe(originalTab)
    await b.page.locator(`[data-context="tab"][data-tab-id="${openedTab}"]`).click()
    await expect(b.page.getByText('Fixture turn', { exact: true })).toBeVisible({ timeout: 30_000 })
    console.info(JSON.stringify({ event: 'task010.catalog.second_browser_open', originalTab, activeTab: await harness.getActiveTabId(), paneId,
      panes: await page.locator('[data-context="fresh-agent"]').evaluateAll(roots => roots.map(root => ({
        paneId: root.getAttribute('data-pane-id'), visibility: getComputedStyle(root).visibility,
        modelButtons: [...root.querySelectorAll('button')].map(button => button.getAttribute('aria-label')).filter(label => label?.includes('Model:')),
      }))) }))
    // Continue the first browser's interaction on its explicitly selected tab.
    await page.bringToFront()
    await page.locator(`[data-context="tab"][data-tab-id="${originalTab}"]`).click()
    await expect(pane).toBeVisible()
    // Exact custom IDs without a display name intentionally have no chip.
    await expect(pane.getByRole('button', { name: /^Model:.*change model$/ })).toHaveCount(0)
    await composer.fill('/model')
    await composer.press('Enter')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('option', { name: 'Owning runtime model', exact: true }).click()
    await dialog.getByRole('listbox', { name: 'Thinking levels for Owning runtime model', exact: true }).getByRole('option', { name: /^ultra(?:\s|$)/ }).click()
    await dialog.getByRole('button', { name: 'Use Owning runtime model · ultra' }).click()
    await pane.getByRole('button', { name: 'Agent settings', exact: true }).click()
    await page.getByRole('combobox', { name: 'File access' }).selectOption('read-only')
    await page.getByRole('combobox', { name: 'Work mode' }).selectOption('plan')
    await page.getByRole('combobox', { name: 'Permission mode' }).selectOption('never')
    await page.keyboard.press('Escape')
    const otherComposer = b.page.getByRole('textbox', { name: 'Chat message input' })
    await otherComposer.fill('/model')
    await otherComposer.press('Enter')
    const otherDialog = b.page.getByRole('dialog', { name: 'Model and thinking level' })
    await expect(otherDialog.getByRole('textbox', { name: 'Exact model ID' })).toHaveValue('catalog-only-model')
    await expect(otherDialog.getByRole('textbox', { name: 'Reasoning effort' })).toHaveValue('ultra')
    await expect(otherDialog.getByRole('option', { name: 'Owning runtime model', exact: true })).toBeVisible({ timeout: 30_000 })
    await otherDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    const otherModel = b.page.getByRole('button', { name: 'Model: Owning runtime model — change model', exact: true })
    await expect(otherModel).toBeVisible({ timeout: 30_000 })
    await expect(otherModel).toHaveAttribute('title', 'catalog-only-model · effort ultra')
    await send('Use the catalog-only model in Plan')
    const configured = (await readNative()).filter(row => row.method === 'turn/start').at(-1)
    expect(configured.params).toMatchObject({ model: 'catalog-only-model', effort: 'ultra', approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly' }, collaborationMode: { mode: 'plan', settings: { model: 'catalog-only-model', reasoning_effort: 'ultra' } } })
    const name = `Catalog journey ${randomUUID().slice(0, 8)}`
    const headers = { 'x-auth-token': info.token }
    const renamed = await page.request.patch(`${info.baseUrl}/api/session-names`, { headers,
      data: { target: { kind: 'session', provider: 'codex', sessionId: nativeId }, name, nameIntent: 'user' } })
    expect(renamed.ok(), await renamed.text()).toBe(true)
    await expect(b.page.locator('[data-context="pane-header"]').filter({ hasText: name })).toBeVisible({ timeout: 30_000 })
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    const restoredModel = pane.getByRole('button', { name: 'Model: Owning runtime model — change model', exact: true })
    await expect(restoredModel).toBeVisible({ timeout: 30_000 })
    await expect(restoredModel).toHaveAttribute('title', 'catalog-only-model · effort ultra')
    await send('Keep the exact pair after a document reload')
    const last = (await readNative()).filter(row => row.method === 'turn/start').at(-1)
    expect(last.params).toMatchObject({ threadId: nativeId, model: 'catalog-only-model', effort: 'ultra',
      collaborationMode: { mode: 'plan', settings: { model: 'catalog-only-model', reasoning_effort: 'ultra' } } })
    const snapshot = await page.request.get(`${info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${nativeId}`, { headers })
    expect((await snapshot.json()).settings).toMatchObject({ model: 'catalog-only-model', effort: 'ultra', collaborationMode: 'plan', sandbox: 'read-only', permissionMode: 'never', cwd })
    expect((await readNative()).filter(row => row.method === 'thread/start')).toHaveLength(1)
    expect((await readNative()).filter(row => row.method === 'turn/start')).toHaveLength(3)
    // A second native source in the SAME cwd offers a different catalog.
    // Every request still traverses browser HTTP, owning Rust runtime and native.
    const secondRequests: URL[] = []
    const secondCatalogs: Array<{ url: string; models: string[] }> = []
    const secondCatalogErrors: string[] = []
    b.page.on('response', response => { if (response.ok() && response.url().includes('/api/fresh-agent/model-capabilities/freshcodex')) void response.json().then(body => secondCatalogs.push({ url: response.url(), models: body.models.map((model: any) => model.id) })).catch(error => secondCatalogErrors.push(String(error))) })
    b.page.on('request', request => { if (request.url().includes('/api/fresh-agent/model-capabilities/freshcodex')) secondRequests.push(new URL(request.url())) })
    const second = await b.page.request.post(`${info.baseUrl}/api/tabs`, { headers, data: { agent: 'codex', cwd } })
    expect(second.ok(), await second.text()).toBe(true)
    const secondBody = await second.json()
    const secondTab = secondBody.data?.tabId ?? secondBody.tabId
    const secondPaneId = secondBody.data?.paneId ?? secondBody.paneId
    await b.page.locator(`[data-context="tab"][data-tab-id="${secondTab}"]`).click()
    const secondPane = b.page.locator(`[data-context="fresh-agent"][data-pane-id="${secondPaneId}"]`)
    const secondComposer = secondPane.getByRole('textbox', { name: 'Chat message input' })
    await expect(secondComposer).toBeEnabled({ timeout: 30_000 })
    await secondComposer.fill('/model')
    await secondComposer.press('Enter')
    const secondDialog = b.page.getByRole('dialog', { name: 'Model and thinking level' })
    await expect(secondDialog.getByRole('option', { name: 'Second runtime model', exact: true })).toBeVisible({ timeout: 30_000 })
    // Recent custom choices remain eligible; the owning runtime's actual
    // catalog response, rather than the recent-choice list, is source-specific.
    await expect.poll(() => secondCatalogs.length).toBeGreaterThan(0)
    expect(secondCatalogErrors).toEqual([])
    expect(secondCatalogs.every(reply => reply.models.length === 1 && reply.models[0] === 'second-runtime-model')).toBe(true)
    expect(secondRequests.length).toBeGreaterThan(0)
    const secondId = secondRequests.at(-1)!.searchParams.get('sessionId')
    expect(secondId).toBeTruthy()
    expect(secondId).not.toBe(nativeId)
    expect(secondRequests.every(request => request.searchParams.get('sessionId') === secondId && request.searchParams.get('cwd') === cwd)).toBe(true)
    expect((await readNative()).some(row => row.method === 'model/list' && row.context.nativeThreadId === secondId)).toBe(true)
    await b.page.keyboard.press('Escape')
    await composer.fill('/model')
    await composer.press('Enter')
    await expect(dialog.getByRole('option', { name: 'Owning runtime model', exact: true })).toBeVisible()
    await expect(dialog.getByRole('option', { name: 'Second runtime model', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    expect((await readNative()).filter(row => row.method === 'thread/start')).toHaveLength(2)
    expect((await readNative()).filter(row => row.method === 'turn/start')).toHaveLength(3)
  } finally {
    await fs.writeFile(release, 'release').catch(() => {})
    await Promise.allSettled(contexts.map(context => context.close()))
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('Freshcodex runs !command in its selected directory, keeps file effects through conversation undo, and restores its code checkpoint', async ({ browser }) => {
  test.setTimeout(180_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshcodex-checkpoint-command-'))
  const cwd = path.join(root, 'selected-project')
  await fs.mkdir(cwd)
  const stateFile = path.join(cwd, 'state.txt')
  await fs.writeFile(stateFile, 'before command\n')
  const wrapper = path.join(root, 'codex.mjs')
  const nativeLog = path.join(root, 'native.jsonl')
  await installNativeWrapper(wrapper)
  const server = new RustServer({ env: { CODEX_CMD: wrapper, FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
    FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ recordTurns: true, appendRequestLogPath: nativeLog }) },
    setupHome: async home => {
      await fs.mkdir(path.join(home, '.freshell'), { recursive: true })
      await fs.writeFile(path.join(home, '.freshell/config.json'), JSON.stringify({ version: 1, settings: {
        freshAgent: { enabled: true }, codingCli: { enabledProviders: ['codex'] },
      } }))
    } })
  let context: Awaited<ReturnType<typeof createFreshE2ePage>>['context'] | undefined
  const native = async (): Promise<any[]> => (await fs.readFile(nativeLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
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
    await directory.fill(cwd)
    await directory.press('Enter')
    const pane = page.locator('[data-context="fresh-agent"]').last()
    const composer = pane.getByRole('textbox', { name: 'Chat message input' })
    await expect(composer).toBeEnabled({ timeout: 30_000 })
    const prompt = 'Create a checkpoint in this selected project'
    await composer.fill(prompt)
    await composer.press('Enter')
    const firstTurn = pane.locator('[data-turn-role="user"]', { hasText: prompt })
    await expect(firstTurn.getByRole('status', { name: 'Code rewind available for this message' })).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByText('Fixture turn', { exact: true })).toHaveCount(1, { timeout: 30_000 })
    const command = "pwd; printf 'after command\\n' > state.txt; printf command-output-canary"
    const executed = page.waitForResponse(response => response.url().includes('/api/fresh-agent/exec') && response.request().method() === 'POST')
    await composer.fill(`!${command}`)
    await composer.press('Enter')
    const response = await executed
    expect(response.ok(), await response.text()).toBe(true)
    expect(response.request().postDataJSON()).toEqual({ command, cwd })
    expect(await response.json()).toEqual({ output: `${cwd}\ncommand-output-canary`, exitCode: 0, truncated: false })
    await expect(pane.getByText('Fixture turn', { exact: true })).toHaveCount(2, { timeout: 30_000 })
    expect(await fs.readFile(stateFile, 'utf8')).toBe('after command\n')
    const starts = (await native()).filter(row => row.method === 'turn/start')
    expect(starts).toHaveLength(2)
    expect(starts[1].params.cwd).toBe(cwd)
    const forwarded = starts[1].params.input.find((item: any) => item.type === 'text').text
    expect(forwarded).toContain(`in ${cwd}. Output:`)
    expect(forwarded).toContain(`${cwd}\ncommand-output-canary`)
    await composer.fill('/undo')
    await composer.press('Enter')
    await expect(composer).toHaveValue(forwarded, { timeout: 30_000 })
    expect(await fs.readFile(stateFile, 'utf8')).toBe('after command\n')
    expect((await native()).filter(row => row.method === 'thread/revert')).toHaveLength(1)
    await composer.fill('/redo')
    await composer.press('Enter')
    await expect(pane.getByText(/Redo is not available for Codex sessions/)).toBeVisible()
    expect((await native()).filter(row => row.method === 'turn/start')).toHaveLength(2)
    await firstTurn.hover()
    const accepted = page.waitForEvent('dialog').then(dialog => dialog.accept())
    await firstTurn.getByRole('button', { name: 'Rewind code to here' }).click()
    await accepted
    await expect.poll(() => fs.readFile(stateFile, 'utf8'), { timeout: 30_000 }).toBe('before command\n')
    expect((await native()).filter(row => row.method === 'thread/start')).toHaveLength(1)
    expect((await native()).filter(row => row.method === 'turn/start')).toHaveLength(2)
  } finally {
    await context?.close().catch(() => {})
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
