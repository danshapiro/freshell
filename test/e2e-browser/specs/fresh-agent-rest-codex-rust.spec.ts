import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect, createFreshE2ePage } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { ensureMcpServerBuilt, McpStdioClient, REPO_ROOT } from '../helpers/mcp-stdio-client.js'

const source = fileURLToPath(new URL('../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs', import.meta.url))
const runFile = promisify(execFile)

function findLeaf(node: any, id: string): any {
  if (node?.type === 'leaf') return node.id === id ? node : undefined
  return (node?.children ?? []).map((child: any) => findLeaf(child, id)).find(Boolean)
}

test('REST creates and splits Freshcodex through the browser owning native runtime without moving focus', async ({ browser }) => {
  test.setTimeout(180_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshcodex-rest-'))
  const wrapper = path.join(root, 'codex.mjs')
  const requests = path.join(root, 'requests.jsonl')
  await fs.writeFile(wrapper, `#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
  ...JSON.parse(process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR || '{}'),
  threadStartThreadId: randomUUID(),
})
await import(${JSON.stringify(source)})
`)
  await fs.chmod(wrapper, 0o755)
  const server = new RustServer({ env: {
    CODEX_CMD: wrapper,
    FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
    FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ recordTurns: true, echoRequestedModel: true, appendRequestLogPath: requests }),
  }, setupHome: async (home) => {
    await fs.mkdir(path.join(home, '.freshell'), { recursive: true })
    await fs.writeFile(path.join(home, '.freshell/config.json'), JSON.stringify({ version: 1, settings: {
      freshAgent: { enabled: true }, codingCli: { enabledProviders: ['codex'] },
    } }))
  } })
  let context: Awaited<ReturnType<typeof createFreshE2ePage>>['context'] | undefined
  let mcp: McpStdioClient | undefined
  try {
    const mcpPath = ensureMcpServerBuilt(REPO_ROOT).path
    const info = await server.start()
    const owned = await createFreshE2ePage(browser, info)
    context = owned.context
    const page = owned.page
    const headers = { 'x-auth-token': info.token }
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
    const controlPrompt = 'Task009 browser native readiness'
    await input.fill(controlPrompt)
    await pane.getByRole('button', { name: 'Send' }).click()
    await expect(pane.getByText('Fixture turn', { exact: true })).toBeVisible({ timeout: 30_000 })
    const nativeRequests = () => fs.readFile(requests, 'utf8').then((text) => text.trim().split('\n').map((line) => JSON.parse(line)))
    await expect.poll(async () => (await nativeRequests()).filter((row) => row.method === 'turn/start').length).toBe(1)
    const nativeTurn = (await nativeRequests()).find((row) => row.method === 'turn/start')
    const sessionId = nativeTurn.params.threadId
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    await expect.poll(async () => {
      const response = await page.request.get(`${info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${sessionId}`, { headers })
      const snapshot = await response.json()
      return { status: snapshot.status, rows: snapshot.turns?.length }
    }, { timeout: 30_000 }).toEqual({ status: 'idle', rows: 2 })
    console.log('TASK009_BROWSER_NATIVE_READY', sessionId)
    const originalTab = await harness.getActiveTabId()
    const originalPane = await pane.getAttribute('data-pane-id')
    await expect.poll(async () => {
      const response = await page.request.get(`${info.baseUrl}/api/panes`, { headers })
      return JSON.stringify(await response.json()).includes(originalPane!)
    }).toBe(true)
    await input.focus()
    const createBody = { agent: 'codex', cwd: root, model: 'provider-current', effort: 'xhigh', collaborationMode: 'plan', sandbox: 'workspace-write', permissionMode: 'on-request' }
    const created = await page.request.post(`${info.baseUrl}/api/tabs`, { headers, data: createBody })
    const split = await page.request.post(`${info.baseUrl}/api/panes/${originalPane}/split`, { headers, data: { ...createBody, direction: 'vertical' } })
    const createdBody = await created.json()
    const splitBody = await split.json()
    expect({ create: created.status(), split: split.status() }, JSON.stringify({ create: createdBody, split: splitBody })).toEqual({ create: 200, split: 200 })
    const createdPane = createdBody.data.paneId as string
    const createdTab = createdBody.data.tabId as string
    const createdRef = createdBody.data.sessionRef
    const splitPane = splitBody.data.paneId as string
    await expect.poll(async () => findLeaf(await harness.getPaneLayout(createdTab), createdPane)?.content?.sessionRef).toEqual(createdRef)
    const splitView = page.locator(`[data-context="fresh-agent"][data-pane-id="${splitPane}"]`)
    await expect(splitView.getByRole('textbox', { name: 'Chat message input' })).toBeEnabled({ timeout: 30_000 })
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect.poll(() => harness.getActiveTabId()).toBe(originalTab)
    await expect(page.locator(`[data-context="fresh-agent"][data-pane-id="${originalPane}"]`).getByRole('textbox', { name: 'Chat message input' })).toBeFocused()
    expect(await page.evaluate(() => document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id'))).toBe(originalPane)

    const sent = await page.request.post(`${info.baseUrl}/api/panes/${createdPane}/send-keys`, { headers, data: { data: 'REST native Task009\r', requestId: 'browser-rest-send' } })
    const sentBody = await sent.json()
    expect(sent.ok(), JSON.stringify(sentBody)).toBe(true)
    expect(sentBody.data.status).toBe('idle')
    expect(sentBody.data.submittedTurnId).toBe('turn-1')
    const capture = await page.request.get(`${info.baseUrl}/api/panes/${createdPane}/capture`, { headers })
    expect(capture.ok()).toBe(true)
    expect(await capture.text()).toContain('user: REST native Task009')
    expect(await capture.text()).toContain('assistant: Fixture turn')
    const bounded = await page.request.get(`${info.baseUrl}/api/panes/${createdPane}/capture?maxBytes=10`, { headers })
    expect(Buffer.byteLength(await bounded.text())).toBeLessThanOrEqual(10)
    const waiting = await page.request.get(`${info.baseUrl}/api/panes/${createdPane}/wait-for?pattern=Fixture%20turn&T=0`, { headers })
    expect((await waiting.json()).data.matched).toBe(true)
    const absent = await page.request.get(`${info.baseUrl}/api/panes/${createdPane}/wait-for?pattern=not-present-Task009&T=0`, { headers })
    expect(await absent.json()).toMatchObject({ status: 'approx', data: { matched: false } })

    mcp = new McpStdioClient({ command: process.execPath, args: [mcpPath], env: { ...process.env, FRESHELL_URL: info.baseUrl, FRESHELL_TOKEN: info.token }, requestTimeoutMs: 60_000 })
    await mcp.initialize()
    const mcpCreated = await mcp.callFreshellAction('new-tab', { agent: 'codex', cwd: root, model: 'provider-current', effort: 'xhigh', prompt: 'MCP native Task009' })
    expect(mcpCreated.status, JSON.stringify(mcpCreated)).toBe('ok')
    expect(mcpCreated.data.sessionRef.provider).toBe('codex')
    expect(await mcp.callFreshellAction('capture-pane', { target: mcpCreated.data.paneId })).toContain('user: MCP native Task009')
    const startsBeforeCli = (await nativeRequests()).filter((row) => row.method === 'thread/start').length
    const cli = await runFile(process.execPath, [path.join(REPO_ROOT, 'dist/tools/freshell-cli/index.js'), 'new-tab', '--agent', 'codex', '--resume', mcpCreated.data.sessionRef.sessionId, '--prompt', 'CLI native Task009'], {
      env: { ...process.env, FRESHELL_URL: info.baseUrl, FRESHELL_TOKEN: info.token }, encoding: 'utf8', timeout: 60_000,
    })
    const cliCreated = JSON.parse(cli.stdout)
    expect(cliCreated.status, cli.stdout).toBe('ok')
    expect(cliCreated.data.sessionRef).toEqual(mcpCreated.data.sessionRef)
    expect((await nativeRequests()).filter((row) => row.method === 'thread/start')).toHaveLength(startsBeforeCli)
    expect((await nativeRequests()).filter((row) => row.method === 'thread/resume')).toHaveLength(0)
    expect(await mcp.callFreshellAction('capture-pane', { target: cliCreated.data.paneId })).toContain('user: CLI native Task009')
    expect(await mcp.callFreshellAction('wait-for', { target: cliCreated.data.paneId, pattern: 'CLI native Task009', timeout: 0 })).toMatchObject({ status: 'ok', data: { matched: true } })
    const turnsBeforeNoop = (await nativeRequests()).filter((row) => row.method === 'turn/start').length
    expect(await mcp.callFreshellAction('send-keys', { target: splitPane, keys: '\r', literal: true })).toMatchObject({ status: 'ok', data: { status: 'noop' } })
    expect((await nativeRequests()).filter((row) => row.method === 'turn/start')).toHaveLength(turnsBeforeNoop)

    const savedName = 'Task009 saved Codex'
    const renamed = await mcp.callFreshellAction('rename-pane', { target: createdPane, name: savedName, nameIntent: 'user' })
    expect(renamed.status, JSON.stringify(renamed)).toBe('ok')
    const readName = async () => {
      const response = await page.request.post(`${info.baseUrl}/api/session-names/read`, { headers, data: { refs: [{ kind: 'session', provider: 'codex', sessionId: createdRef.sessionId }] } })
      return (await response.json()).names[0]?.record
    }
    const observedName = await readName()
    console.log('TASK009_NAME_EVIDENCE', JSON.stringify({
      sessionId: createdRef.sessionId, renameStatus: renamed.status,
      renameNameRef: renamed.data?.nameRef,
      readNameRef: observedName?.nameRef, name: observedName?.name, source: observedName?.source,
    }))
    await expect.poll(readName, { timeout: 30_000 }).toMatchObject({ name: savedName, source: 'manual' })
    await expect.poll(async () => findLeaf(await harness.getPaneLayout(createdTab), createdPane)?.content?.sessionRef).toEqual(createdRef)
    const startsBeforeReload = (await nativeRequests()).filter((row) => row.method === 'thread/start').length
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    await expect.poll(async () => findLeaf(await harness.getPaneLayout(createdTab), createdPane)?.content?.sessionRef).toEqual(createdRef)
    await mcp.callFreshellAction('select-tab', { target: createdTab })
    const restored = page.locator(`[data-context="fresh-agent"][data-pane-id="${createdPane}"]`)
    await expect(restored.getByRole('textbox', { name: 'Chat message input' })).toBeEnabled({ timeout: 30_000 })
    await expect(restored).toContainText('REST native Task009')
    await expect(restored).toContainText('Fixture turn')
    await expect(page.locator(`[data-context="tab"][data-tab-id="${createdTab}"]`)).toContainText(savedName)
    expect(await readName()).toMatchObject({ name: savedName, source: 'manual' })
    expect(await mcp.callFreshellAction('capture-pane', { target: createdPane })).toContain('user: REST native Task009')
    expect((await nativeRequests()).filter((row) => row.method === 'thread/start')).toHaveLength(startsBeforeReload)
    const snapshot = await page.request.get(`${info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${createdRef.sessionId}`, { headers })
    expect((await snapshot.json()).settings).toMatchObject({ model: 'provider-current', effort: 'xhigh', collaborationMode: 'plan', sandbox: 'workspace-write', permissionMode: 'on-request', cwd: root })
    const prompts = (await nativeRequests()).filter((row) => row.method === 'turn/start').map((row) => row.params.input.map((part: any) => part.text ?? '').join(''))
    for (const prompt of [controlPrompt, 'REST native Task009', 'MCP native Task009', 'CLI native Task009']) expect(prompts.filter((value) => value === prompt)).toHaveLength(1)
  } finally {
    await mcp?.close().catch(() => {})
    await context?.close().catch(() => {})
    await server.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
