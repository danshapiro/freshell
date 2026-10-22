import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, createFreshE2ePage } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_CODEX_APP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

async function installFakeCodexAppServer(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-codex-app-server-wrapper.mjs')
  const wrapper = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const target = ${JSON.stringify(FAKE_CODEX_APP_SERVER_SOURCE)}
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`
  await fs.writeFile(dest, wrapper, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

function findFreshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findFreshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

test.describe('fresh-agent checkpoint availability', () => {
  test('a selected non-Git workspace keeps its successful checkpoint through reload and restores it', async ({ browser }) => {
    test.setTimeout(180_000)
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-checkpoint-restore-'))
    const projectDir = path.join(sharedRoot, 'selected-workspace')
    const sourceFile = path.join(projectDir, 'state.txt')
    let server: RustServer | undefined
    let context: Awaited<ReturnType<typeof createFreshE2ePage>>['context'] | undefined

    try {
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(sourceFile, 'before checkpoint\n', 'utf8')
      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))
      server = new RustServer({
        env: {
          CODEX_CMD: fakeCodexPath,
          FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ recordTurns: true }),
          FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
        },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: {
              freshAgent: { enabled: true },
              codingCli: {
                enabledProviders: ['codex'],
                providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
              },
            },
          }, null, 2))
        },
      })
      const info = await server.start()
      const ownedPage = await createFreshE2ePage(browser, info)
      context = ownedPage.context
      const { page } = ownedPage
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'connection/setAvailableClis',
          payload: { claude: false, codex: true },
        })
      })

      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
      const directoryInput = page.getByRole('combobox', { name: 'Starting directory for Freshcodex' })
      await expect(directoryInput).toBeVisible({ timeout: 10_000 })
      await directoryInput.fill(projectDir)
      await directoryInput.press('Enter')

      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await expect(paneRoot).toBeVisible({ timeout: 15_000 })
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        return findFreshAgentLeaf(layout)?.content?.initialCwd
      }, { timeout: 10_000 }).toBe(projectDir)
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        return findFreshAgentLeaf(layout)?.content?.status
      }, { timeout: 30_000 }).toBe('idle')

      const marker = `checkpoint-restore-${Math.random().toString(36).slice(2, 10)}`
      const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
      await composer.fill(marker)
      await paneRoot.getByRole('button', { name: 'Send' }).click()

      const userTurn = paneRoot.locator('[data-turn-role="user"]', { hasText: marker })
      await expect(userTurn).toBeVisible({ timeout: 20_000 })
      await expect(userTurn.getByRole('status', { name: 'Code rewind available for this message' }))
        .toContainText('Code rewind is available for this message.')
      await expect(paneRoot.getByText('Fixture turn')).toBeVisible({ timeout: 30_000 })

      let content: any
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        content = findFreshAgentLeaf(layout)?.content
        return content?.status
      }, { timeout: 20_000 }).toBe('idle')
      const outcome = content.checkpointOutcomes?.find((entry: any) => entry.status === 'available')
      expect(outcome?.checkpointId).toMatch(/^[a-f0-9]{40}$/)
      expect(outcome?.workspace).toEqual({ path: projectDir, provenance: 'directory-picker' })
      expect(JSON.stringify(content.checkpointOutcomes)).not.toContain(marker)

      await fs.writeFile(sourceFile, 'after checkpoint\n', 'utf8')
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload()
      const reloadedHarness = new TestHarness(page)
      await reloadedHarness.waitForHarness()
      await reloadedHarness.waitForConnection()
      const reloadedPane = page.locator('[data-context="fresh-agent"]').last()
      await expect(reloadedPane).toBeVisible({ timeout: 20_000 })
      const reloadedTurn = reloadedPane.locator('[data-turn-role="user"]', { hasText: marker })
      await expect(reloadedTurn).toBeVisible({ timeout: 30_000 })
      await expect(reloadedTurn.getByRole('status', { name: 'Code rewind available for this message' }))
        .toContainText('Code rewind is available for this message.')
      await reloadedTurn.hover()
      const rewind = reloadedTurn.getByRole('button', { name: 'Rewind code to here' })
      await expect(rewind).toBeEnabled()
      const dialogAccepted = page.waitForEvent('dialog').then((dialog) => dialog.accept())
      await rewind.click()
      await dialogAccepted

      await expect.poll(() => fs.readFile(sourceFile, 'utf8'), { timeout: 20_000 })
        .toBe('before checkpoint\n')
      await expect(reloadedPane.getByText(`Code rewound to before: "${marker}"`))
        .toBeVisible({ timeout: 10_000 })
    } finally {
      await context?.close().catch(() => {})
      await server?.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('an unreadable selected project file marks rewind unavailable and still completes the provider turn', async ({ browser }) => {
    test.setTimeout(180_000)
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-checkpoint-unavailable-'))
    const projectDir = path.join(sharedRoot, 'project')
    const trackedFile = path.join(projectDir, 'private-fixture.txt')
    let server: RustServer | undefined
    let context: Awaited<ReturnType<typeof createFreshE2ePage>>['context'] | undefined

    try {
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(trackedFile, 'tracked but unreadable fixture\n', 'utf8')
      execFileSync('git', ['init', projectDir], { stdio: 'ignore' })
      execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'fixture@example.invalid'], { stdio: 'ignore' })
      execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Freshell fixture'], { stdio: 'ignore' })
      execFileSync('git', ['-C', projectDir, 'add', '--', 'private-fixture.txt'], { stdio: 'ignore' })
      execFileSync('git', ['-C', projectDir, 'commit', '-m', 'fixture'], { stdio: 'ignore' })
      await fs.chmod(trackedFile, 0o000)
      await expect(fs.readFile(trackedFile, 'utf8')).rejects.toMatchObject({ code: 'EACCES' })

      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))
      server = new RustServer({
        env: {
          CODEX_CMD: fakeCodexPath,
          FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ recordTurns: true }),
          FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
        },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: {
              freshAgent: { enabled: true },
              codingCli: {
                enabledProviders: ['codex'],
                providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
              },
            },
          }, null, 2))
        },
      })
      const info = await server.start()
      const ownedPage = await createFreshE2ePage(browser, info)
      context = ownedPage.context
      const { page } = ownedPage
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'connection/setAvailableClis',
          payload: { claude: false, codex: true },
        })
      })

      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
      const directoryInput = page.getByRole('combobox', { name: 'Starting directory for Freshcodex' })
      await expect(directoryInput).toBeVisible({ timeout: 10_000 })
      await directoryInput.fill(projectDir)
      await directoryInput.press('Enter')

      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await expect(paneRoot).toBeVisible({ timeout: 15_000 })
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        return findFreshAgentLeaf(layout)?.content?.initialCwd
      }, { timeout: 10_000 }).toBe(projectDir)
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        return findFreshAgentLeaf(layout)?.content?.status
      }, { timeout: 30_000 }).toBe('idle')

      const marker = `checkpoint-unavailable-${Math.random().toString(36).slice(2, 10)}`
      const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
      await composer.fill(marker)
      await paneRoot.getByRole('button', { name: 'Send' }).click()

      const userTurn = paneRoot.locator('[data-turn-role="user"]', { hasText: marker })
      await expect(userTurn).toBeVisible({ timeout: 20_000 })
      const unavailable = userTurn.getByRole('note', { name: 'Code rewind unavailable for this message' })
      await expect(unavailable).toContainText('A selected project file could not be read')
      await userTurn.hover()
      await expect(userTurn.getByRole('button', { name: 'Rewind unavailable for this message' })).toBeDisabled()
      await expect(paneRoot.getByText('Fixture turn')).toBeVisible({ timeout: 30_000 })

      let content: any
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        content = findFreshAgentLeaf(layout)?.content
        return content?.status
      }, { timeout: 20_000 }).toBe('idle')
      expect(content.checkpointOutcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: 'unavailable',
          code: 'checkpoint_path_unreadable',
          reason: expect.stringContaining('A selected project file could not be read'),
        }),
      ]))
      expect(JSON.stringify(content.checkpointOutcomes)).not.toContain(marker)

      // The exact provider turn identity binds to the outcome only after the
      // accepted turn retires: the codex identity probe waits for the turn to
      // complete, then reads the thread and broadcasts the identity. That can
      // land just after the pane goes idle, so wait for it rather than reading
      // the idle snapshot once.
      let unavailableOutcome: any
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        unavailableOutcome = findFreshAgentLeaf(layout)?.content?.checkpointOutcomes
          ?.find((entry: any) => entry.status === 'unavailable' && entry.code === 'checkpoint_path_unreadable')
        return unavailableOutcome?.nativeTurnId
      }, { timeout: 30_000 }).toEqual(expect.any(String))

      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
        .filter((key) => key.startsWith('freshell.layout.v3.'))
        .some((key) => localStorage.getItem(key)?.includes('checkpointOutcomes') ?? false)))
        .toBe(true)

      await page.reload()
      const reloadedHarness = new TestHarness(page)
      await reloadedHarness.waitForHarness()
      await reloadedHarness.waitForConnection()
      const reloadedPane = page.locator('[data-context="fresh-agent"]').last()
      await expect(reloadedPane).toBeVisible({ timeout: 20_000 })
      const reloadedUserTurn = reloadedPane.locator('[data-turn-role="user"]', { hasText: marker })
      await expect(reloadedUserTurn).toBeVisible({ timeout: 30_000 })
      await expect(reloadedUserTurn.getByRole('note', { name: 'Code rewind unavailable for this message' }))
        .toContainText('A selected project file could not be read')
      await reloadedUserTurn.hover()
      await expect(reloadedUserTurn.getByRole('button', { name: 'Rewind unavailable for this message' }))
        .toBeDisabled()

      // Provider ground truth: the send behind the unavailable checkpoint
      // really reached the provider as that checkpoint's turn. The fake
      // app-server records each turn/start (with its user text) under the
      // spawned server's isolated CODEX_HOME (RustServer pins it to
      // <homeDir>/.codex), so read it there. The record is written at
      // turn/start and never updated, so it proves delivery, not completion;
      // completion is proven above by the 'Fixture turn' reply and the pane
      // settling back to idle.
      const threadId = content.sessionRef?.sessionId ?? content.sessionId
      expect(threadId).toBeTruthy()
      const recordedTurnsPath = path.join(info.homeDir, '.codex', 'fake-turns', `${threadId}.json`)
      await expect.poll(async () => {
        const raw = await fs.readFile(recordedTurnsPath, 'utf8').catch(() => '[]')
        const turns = JSON.parse(raw) as Array<{
          id?: string
          items?: Array<{ type?: string; content?: Array<{ text?: string }> }>
        }>
        const turn = turns.find((candidate) => candidate.id === unavailableOutcome.nativeTurnId)
        return turn?.items?.some((item) => item.type === 'userMessage'
          && item.content?.some((part) => part.text === marker)) ?? false
      }, { timeout: 20_000 }).toBe(true)
    } finally {
      await context?.close().catch(() => {})
      await server?.stop().catch(() => {})
      await fs.chmod(trackedFile, 0o600).catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
