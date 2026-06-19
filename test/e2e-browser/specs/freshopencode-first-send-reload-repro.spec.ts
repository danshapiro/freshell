import { expect, test, type Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TestServer } from '../helpers/test-server.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fakeOpencodeSource = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

type FakeAuditEvent = {
  event?: string
  prompt?: string
}

type FreshOpencodePaneState = {
  sessionId?: string
  status?: string
  sessionRef?: { provider?: string; sessionId?: string }
}

async function installFakeOpencode(binDir: string): Promise<void> {
  await fsp.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  await fsp.copyFile(fakeOpencodeSource, target)
  await fsp.chmod(target, 0o755)
}

function createSetupHome(sharedOpencodeDataDir: string) {
  return async (homeDir: string): Promise<void> => {
    const xdgShare = path.join(homeDir, '.local', 'share')
    const opencodeLink = path.join(xdgShare, 'opencode')
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(xdgShare, { recursive: true })
    await fsp.mkdir(freshellDir, { recursive: true })
    await fsp.mkdir(sharedOpencodeDataDir, { recursive: true })
    await fsp.rm(opencodeLink, { recursive: true, force: true }).catch(() => {})
    await fsp.symlink(sharedOpencodeDataDir, opencodeLink, 'dir')
    await fsp.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
      version: 1,
      settings: {
        codingCli: {
          enabledProviders: ['opencode'],
          providers: { opencode: {} },
        },
        freshAgent: { enabled: true },
      },
    }, null, 2))
  }
}

function createServerOptions(input: {
  binDir: string
  auditLogPath: string
  logsDir: string
  sharedOpencodeDataDir: string
}) {
  return {
    setupHome: createSetupHome(input.sharedOpencodeDataDir),
    env: {
      PATH: `${input.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_OPENCODE_AUDIT_LOG: input.auditLogPath,
      FAKE_OPENCODE_HANG_SESSION_CREATE: '1',
      FRESHELL_LOG_DIR: input.logsDir,
    },
  }
}

async function readAuditEvents(auditLogPath: string): Promise<FakeAuditEvent[]> {
  try {
    const text = await fsp.readFile(auditLogPath, 'utf8')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeAuditEvent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function enableFreshOpencode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { opencode: true },
    })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: {
        codingCli: { enabledProviders: ['opencode'] },
        freshAgent: { enabled: true },
      },
    })
  })
}

async function createFreshopencodePane(page: Page, cwd: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })
  const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })
}

async function getFreshOpencodePaneState(page: Page): Promise<FreshOpencodePaneState> {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const activeTabId = state?.tabs?.activeTabId
    const findFreshOpencode = (node: any): any => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'fresh-agent' && node.content.provider === 'opencode') {
        return node.content
      }
      if (node.type === 'split') return findFreshOpencode(node.children?.[0]) ?? findFreshOpencode(node.children?.[1])
      return undefined
    }
    return findFreshOpencode(state?.panes?.layouts?.[activeTabId]) ?? {}
  })
}

async function sendFreshAgentPrompt(page: Page, prompt: string): Promise<void> {
  const textbox = page.getByRole('textbox', { name: 'Chat message input' })
  await expect(textbox).toBeVisible({ timeout: 15_000 })
  await expect(textbox).not.toBeDisabled({ timeout: 15_000 })
  await textbox.fill(prompt)
  await page.getByRole('button', { name: 'Send' }).click()
}

test.describe('Freshopencode first-send reload regression', () => {
  test.setTimeout(90_000)

  test('keeps a submitted first prompt visible across reload while session materialization is pending', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-repro-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const prompt = `playwright repro prompt ${Date.now()}`
    await fsp.mkdir(cwd, { recursive: true })
    await installFakeOpencode(binDir)

    const server = new TestServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
    }))

    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)
      await createFreshopencodePane(page, cwd)

      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 15_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
      })
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })

      await sendFreshAgentPrompt(page, prompt)
      const transcript = page.locator('[data-context="fresh-agent-transcript"]')
      await expect(transcript.getByText(prompt, { exact: true })).toBeVisible({ timeout: 5_000 })
      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        return events.some((event) => event.event === 'session_create_requested')
      }, { timeout: 15_000 }).toBe(true)

      const duringSend = await getFreshOpencodePaneState(page)
      expect(duringSend.sessionId).toMatch(/^freshopencode-/)
      expect(duringSend.status).toBe('running')
      expect(duringSend.sessionRef?.sessionId).toMatch(/^freshopencode-/)

      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const afterReloadTranscript = page.locator('[data-context="fresh-agent-transcript"]')

      await expect(afterReloadTranscript.getByText(prompt, { exact: true })).toBeVisible({ timeout: 5_000 })
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
