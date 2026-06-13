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
  sessionId?: string
  prompt?: string
  omitRunSessionId?: boolean
}

type FreshOpencodePaneState = {
  sessionId?: string
  resumeSessionId?: string
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
          providers: {
            opencode: {},
          },
        },
        freshAgent: { enabled: true },
        agentChat: { enabled: true },
      },
    }, null, 2))
  }
}

function createServerOptions(input: {
  binDir: string
  auditLogPath: string
  logsDir: string
  sharedOpencodeDataDir: string
  env?: Record<string, string>
}) {
  return {
    setupHome: createSetupHome(input.sharedOpencodeDataDir),
    env: {
      PATH: `${input.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_OPENCODE_AUDIT_LOG: input.auditLogPath,
      FRESHELL_LOG_DIR: input.logsDir,
      ...(input.env ?? {}),
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
        agentChat: { enabled: true },
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

test.describe('Freshopencode DB history restore', () => {
  test.setTimeout(180_000)

  test('restores Freshopencode turns from DB history when export is truncated', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-db-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const prompt = 'Persist this Freshopencode DB turn'
    const response = 'Freshopencode DB response survived reload'
    await fsp.mkdir(cwd, { recursive: true })
    await installFakeOpencode(binDir)

    const server = new TestServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      env: {
        FAKE_OPENCODE_TRUNCATE_EXPORT: '1',
        FAKE_OPENCODE_RESPONSE_TEXT: response,
      },
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

      await sendFreshAgentPrompt(page, prompt)

      await expect(page.getByText(response)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(prompt)).toBeVisible({ timeout: 30_000 })

      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^ses_/),
        resumeSessionId: expect.stringMatching(/^ses_/),
        sessionRef: {
          provider: 'opencode',
          sessionId: expect.stringMatching(/^ses_/),
        },
      })
      const beforeReload = await getFreshOpencodePaneState(page)
      expect(beforeReload.sessionRef?.sessionId).toBe(beforeReload.sessionId)

      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()

      await expect(page.getByText(prompt)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(response)).toBeVisible({ timeout: 30_000 })
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId: beforeReload.sessionId,
        resumeSessionId: beforeReload.sessionId,
        sessionRef: {
          provider: 'opencode',
          sessionId: beforeReload.sessionId,
        },
      })

      const auditEvents = await readAuditEvents(auditLogPath)
      expect(auditEvents.some((event) => event.event === 'run' && event.prompt === prompt)).toBe(true)
      expect(auditEvents.some((event) => event.event === 'export')).toBe(false)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('does not materialize Freshopencode from DB rows without top-level run sessionID', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-no-session-id-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const prompt = 'Do not infer my session id'
    await fsp.mkdir(cwd, { recursive: true })
    await installFakeOpencode(binDir)

    const server = new TestServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      env: {
        FAKE_OPENCODE_RUN_NO_SESSION_ID: '1',
      },
    }))

    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)
      await createFreshopencodePane(page, cwd)

      await sendFreshAgentPrompt(page, prompt)

      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        return events.find((event) => event.event === 'run' && event.prompt === prompt) ?? null
      }, { timeout: 30_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^ses_/),
        omitRunSessionId: true,
      })

      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
        resumeSessionId: expect.stringMatching(/^freshopencode-/),
        sessionRef: {
          provider: 'opencode',
          sessionId: expect.stringMatching(/^freshopencode-/),
        },
        status: 'idle',
      })
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
