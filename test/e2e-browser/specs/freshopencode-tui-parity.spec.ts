import { expect, test, type Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPanePicker } from '../helpers/pane-picker.js'
import { userTurnText } from '../helpers/fresh-agent-transcript.js'
import { TestHarness } from '../helpers/test-harness.js'
import { RustServer } from '../helpers/rust-server.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fakeOpencodeSource = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

// ── fixture payloads (named constants — shared with the fake's env-gated flow) ──

const PROMPT = 'Delegate the flaky-harness fix to a subagent'
const THOUGHT_TITLE = 'Planning the fix'
const FOREGROUND_CHILD_SESSION_ID = 'ses_c'
const FOREGROUND_DESCRIPTION = 'Fix the flaky harness'
const BACKGROUND_DESCRIPTION = 'Index the repository'
// Server-composed delegation headers (titlecased subagent type; the background
// part's ` (background)` marker applies per the request's header spec).
const FOREGROUND_TITLE = `General Task — ${FOREGROUND_DESCRIPTION}`
const BACKGROUND_TITLE = `General Task (background) — ${BACKGROUND_DESCRIPTION}`
const RETRY_ATTEMPT = 2
const RETRY_ERROR = 'stream disconnected'
const THOUGHT_LABEL = `Thought: ${THOUGHT_TITLE} · 3.4s`
const FOREGROUND_DURATION_LABEL = '7.5s'
const CHILD_SED_COMMAND = 'sed -n 92,112p src/store/paneTypes.ts'
const CHILD_GREP_PATTERN = 'reasoningEffort'
const LIVE_JOIN_COMMAND = 'echo live-join-refresh'
const CHILD_PROMPT_TEXT = 'Fix the flaky harness — locate the intermittently failing test and stabilize it'
const DELEGATED_CAPTION = `Delegated — General · ${FOREGROUND_DESCRIPTION}`
const TASK_RESULT_LAST_LINE = 'sample task output line 40 of 40'
// The max-h-24 clamp (~96px) plus block padding must keep the rendered result
// box under this bound even though the served <task_result> is 40 lines tall.
const RESULT_CLAMP_MAX_HEIGHT = 160

type FreshOpencodePaneState = {
  sessionId?: string
  resumeSessionId?: string
  status?: string
  sessionRef?: { provider?: string; sessionId?: string }
}

async function installFakeOpencode(binDir: string): Promise<void> {
  await fsp.mkdir(binDir, { recursive: true })
  // The executable has no extension. Pin its module type even when an
  // ancestor of this temporary directory declares "type": "module".
  await fsp.writeFile(path.join(binDir, 'package.json'), '{"type":"commonjs"}\n')
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
      },
    }, null, 2))
  }
}

function createServerOptions(input: {
  binDir: string
  logsDir: string
  sharedOpencodeDataDir: string
  childEventGatePath: string
  env?: Record<string, string>
}) {
  return {
    setupHome: createSetupHome(input.sharedOpencodeDataDir),
    env: {
      PATH: `${input.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FRESHELL_LOG_DIR: input.logsDir,
      FAKE_OPENCODE_TUI_PARITY: '1',
      FAKE_OPENCODE_TUI_PARITY_CHILD_EVENT_GATE: input.childEventGatePath,
      ...(input.env ?? {}),
    },
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

test.describe('Freshopencode TUI inline parity', () => {
  test.setTimeout(180_000)

  test('renders delegations, thought durations, retries, child captions, and the live join inline', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-tui-parity-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const childEventGatePath = path.join(sharedRoot, 'child-event.gate')
    const cwd = path.join(sharedRoot, 'project')
    await fsp.mkdir(cwd, { recursive: true })
    await installFakeOpencode(binDir)

    const server = new RustServer(createServerOptions({
      binDir,
      logsDir,
      sharedOpencodeDataDir,
      childEventGatePath,
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

      await sendFreshAgentPrompt(page, PROMPT)

      // The pane materializes a real `ses_*` session with the first send.
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^ses_/),
      })

      // ── Group 1: the parent transcript folds into ONE collapsed activity line ──
      const paneRoot = page.locator('[data-context="fresh-agent"]')
      const strip = paneRoot.getByRole('region', { name: 'Activity strip' })
      await expect(strip).toHaveCount(1, { timeout: 30_000 })
      await expect(strip).toBeVisible()
      const stripToggle = strip.getByRole('button', { name: 'Toggle activity details' })
      await expect(stripToggle).toHaveAttribute('aria-expanded', 'false')
      // While collapsed, the delegation block lives only inside the strip's
      // collapsed summary — no standalone delegation article renders.
      await expect(paneRoot.getByTestId('fresh-agent-delegation-block')).toHaveCount(0)

      // ── Group 2: expanded strip shows the delegation, nested rows, retry, clamped result ──
      await stripToggle.click()
      await expect(stripToggle).toHaveAttribute('aria-expanded', 'true')

      const foregroundBlock = page
        .locator('[data-testid="fresh-agent-delegation-block"][data-status="completed"]')
      await expect(foregroundBlock).toHaveCount(1, { timeout: 30_000 })
      await expect(foregroundBlock).toContainText(FOREGROUND_TITLE)
      await expect(foregroundBlock).toContainText(FOREGROUND_DURATION_LABEL)

      const nestedRows = foregroundBlock.getByTestId('fresh-agent-delegation-row')
      await expect(nestedRows).toHaveCount(2)
      const sedRow = nestedRows.filter({ hasText: CHILD_SED_COMMAND })
      await expect(sedRow).toHaveCount(1)
      await expect(sedRow).toContainText('↳')
      await expect(sedRow).toContainText('Bash')
      const failedRow = nestedRows.filter({ hasText: CHILD_GREP_PATTERN })
      await expect(failedRow).toHaveCount(1)
      await expect(failedRow).toContainText('Grep')
      await expect(failedRow).toContainText('(failed)')

      const retryRow = paneRoot.getByTestId('fresh-agent-retry-row')
      await expect(retryRow).toHaveCount(1)
      await expect(retryRow).toHaveText(`Retrying (attempt ${RETRY_ATTEMPT}) — ${RETRY_ERROR}`)

      const resultElement = foregroundBlock.getByTestId('fresh-agent-delegation-result')
      await expect(resultElement).toBeVisible()
      await expect(resultElement).toContainText(TASK_RESULT_LAST_LINE)
      const resultBox = await resultElement.boundingBox()
      expect(resultBox).not.toBeNull()
      expect(resultBox!.height).toBeLessThanOrEqual(RESULT_CLAMP_MAX_HEIGHT)

      // ── Group 3: the settled thinking row carries title + duration ──
      await expect(
        paneRoot.getByRole('button', { name: THOUGHT_LABEL, exact: true }),
      ).toBeVisible()

      // ── Group 4: the live background delegation drives the strip ──
      // Collapse first: the COLLAPDED strip line must name the running
      // background task (round-3 load-bearing assertion).
      await stripToggle.click()
      await expect(stripToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(strip).toContainText('Task', { timeout: 10_000 })
      await expect(strip).toContainText(BACKGROUND_TITLE)
      const statusSlot = strip.getByTestId('fresh-agent-activity-status-slot')
      await expect(statusSlot.locator('[aria-label="running"]')).toBeVisible()

      // Then expand: its block shows the child-derived running state and NO duration.
      await stripToggle.click()
      await expect(stripToggle).toHaveAttribute('aria-expanded', 'true')
      const backgroundBlock = page
        .locator('[data-testid="fresh-agent-delegation-block"][data-status="running"]')
      await expect(backgroundBlock).toHaveCount(1)
      await expect(backgroundBlock).toContainText(BACKGROUND_TITLE)
      await expect(backgroundBlock.locator('[aria-label="running"]')).toBeVisible()
      await expect(backgroundBlock.getByText(/^\d+(\.\d+)?s$/)).toHaveCount(0)

      // ── Group 5: a child-session event live-refreshes the visible parent's joined rows ──
      const liveJoinRow = foregroundBlock
        .getByTestId('fresh-agent-delegation-row')
        .filter({ hasText: LIVE_JOIN_COMMAND })
      await expect(liveJoinRow).toHaveCount(0)
      await fsp.writeFile(childEventGatePath, 'go\n')
      await expect(liveJoinRow).toHaveCount(1, { timeout: 30_000 })

      // ── Group 6: Open session opens the child session with its delegated-task caption ──
      await foregroundBlock.getByRole('button', { name: `Open session ${FOREGROUND_DESCRIPTION}` }).click()
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionRef: {
          provider: 'opencode',
          sessionId: FOREGROUND_CHILD_SESSION_ID,
        },
      })
      const delegatedCaption = page.getByTestId('fresh-agent-delegated-task')
      await expect(delegatedCaption).toHaveCount(1)
      await expect(delegatedCaption).toHaveText(DELEGATED_CAPTION)
      await expect(userTurnText(page, CHILD_PROMPT_TEXT)).toBeVisible({ timeout: 30_000 })
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
