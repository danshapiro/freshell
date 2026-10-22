// FRESHCLAUDE DURABLE TRANSCRIPT -- transcript-live plan Phase A (audit G12/G13).
// Seeds transcripts the pinned Claude CLI 2.1.237 itself wrote
// (test/fixtures/fresh-agent/claude/real-cli-2.1.237, captured against a local
// fake endpoint) into the Rust server's claude store, opens a freshclaude or
// kilroy pane on that saved session, and checks that the snapshot the REAL
// server projects renders through the existing client: subagent delegations
// with their activity rows and result, the changed-files panel, compaction
// cards, slash commands, command output, error modules and image placeholders.
// No sidecar runs: the pane's fresh-agent WS effects are suppressed, so the
// transcript comes only from GET /api/fresh-agent/threads/... (the reload path).
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import type { TestHarness } from '../helpers/test-harness.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REAL_CLI = path.resolve(__dirname, '../../fixtures/fresh-agent/claude/real-cli-2.1.237')

/** Copy a captured scenario into the server's claude store, in the CLI's own
 * layout (`<id>.jsonl` plus `<id>/subagents/`). Returns the session id. */
async function seedSavedSession(serverInfo: E2eServerInfo, scenario: string): Promise<string> {
  const source = path.join(REAL_CLI, scenario)
  const transcript = await fsp.readFile(path.join(source, 'session.jsonl'), 'utf8')
  const sessionId = transcript
    .split('\n')
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .find((line) => typeof line?.sessionId === 'string')?.sessionId as string
  expect(sessionId).toBeTruthy()
  const project = path.join(serverInfo.homeDir, '.claude', 'projects', '-fixture-ws')
  await fsp.mkdir(project, { recursive: true })
  await fsp.writeFile(path.join(project, `${sessionId}.jsonl`), transcript)
  const subagents = path.join(source, 'session', 'subagents')
  const entries = await fsp.readdir(subagents).catch(() => [] as string[])
  if (entries.length > 0) {
    const target = path.join(project, sessionId, 'subagents')
    await fsp.mkdir(target, { recursive: true })
    for (const entry of entries) await fsp.copyFile(path.join(subagents, entry), path.join(target, entry))
  }
  return sessionId
}

/** Suppress EVERY fresh-agent WS frame on this page and on reloads: no
 * create/attach ever reaches the server, so no Claude sidecar or CLI runs and
 * nothing can contact a model provider. */
async function suppressFreshAgentNetwork(page: Page) {
  await page.addInitScript(() => {
    ;(window as { __FRESHELL_SUPPRESS_ALL_FRESH_AGENT_NETWORK_EFFECTS__?: boolean })
      .__FRESHELL_SUPPRESS_ALL_FRESH_AGENT_NETWORK_EFFECTS__ = true
  })
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.setSuppressAllFreshAgentNetworkEffects(true)
  })
}

/** Turn the fixture's terminal pane into a fresh-agent pane on a saved
 * session (fresh-agent WS effects are suppressed page-wide). */
async function openSavedSession(
  page: Page,
  harness: TestHarness,
  sessionType: 'freshclaude' | 'kilroy',
  sessionId: string,
) {
  const tabId = await harness.getActiveTabId()
  expect(tabId).toBeTruthy()
  const layout = await harness.getPaneLayout(tabId!)
  expect(layout?.type).toBe('leaf')
  const paneId = layout.id as string
  await page.evaluate(({ currentTabId, currentPaneId, currentSessionId, currentSessionType }) => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId: currentTabId,
        paneId: currentPaneId,
        content: {
          kind: 'fresh-agent',
          sessionType: currentSessionType,
          provider: 'claude',
          createRequestId: `req-durable-${currentSessionId}`,
          sessionId: currentSessionId,
          sessionRef: { provider: 'claude', sessionId: currentSessionId },
          resumeSessionId: currentSessionId,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
  }, { currentTabId: tabId!, currentPaneId: paneId, currentSessionId: sessionId, currentSessionType: sessionType })
  const paneRoot = page.locator('[data-context="fresh-agent"]')
  await expect(paneRoot).toBeVisible({ timeout: 15_000 })
  return paneRoot
}

async function expandActivity(paneRoot: ReturnType<Page['locator']>) {
  const toggles = paneRoot.getByRole('button', { name: 'Toggle activity details' })
  const count = await toggles.count()
  for (let i = 0; i < count; i += 1) await toggles.first().click()
}

test.describe('freshclaude durable transcript (real CLI transcripts, Rust server)', () => {
  for (const sessionType of ['freshclaude', 'kilroy'] as const) {
    test(`${sessionType}: a saved session shows its subagent delegation and changed files`, async ({ freshellPage: page, harness, terminal, serverInfo }) => {
      await terminal.waitForTerminal()
      await suppressFreshAgentNetwork(page)
      const sessionId = await seedSavedSession(serverInfo, 'tools-sync')
      const paneRoot = await openSavedSession(page, harness, sessionType, sessionId)

      await expect(paneRoot.getByText('All done.')).toBeVisible({ timeout: 15_000 })

      // The changed-files panel lists both edited files with their status.
      const created = paneRoot.getByRole('button', { name: 'Diff: /fixture/ws/a.txt' })
      await expect(created).toBeVisible()
      await expect(created).toContainText('created')
      await expect(paneRoot.getByRole('button', { name: 'Diff: /fixture/ws/b.txt' })).toContainText('+1 −0')

      await expandActivity(paneRoot)
      const delegation = paneRoot.getByTestId('fresh-agent-delegation-block')
      await expect(delegation).toHaveCount(1)
      await expect(delegation).toHaveAttribute('data-status', 'completed')
      await expect(delegation.getByText('General-purpose Task — check file')).toBeVisible()
      const rows = delegation.getByTestId('fresh-agent-delegation-row')
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toContainText('Read')
      await expect(rows.first()).toContainText('/fixture/ws/a.txt')
      await expect(delegation.getByTestId('fresh-agent-delegation-result')).toContainText('SUBAGENT-DONE: file has two')
      // The delegation absorbed its tool result: no stray "Result" row.
      await expect(paneRoot.getByLabel('Result tool call')).toHaveCount(0)
    })
  }

  test('freshclaude: compaction, slash commands and command output render after a reload', async ({ freshellPage: page, harness, terminal, serverInfo }) => {
    await terminal.waitForTerminal()
    await suppressFreshAgentNetwork(page)
    const sessionId = await seedSavedSession(serverInfo, 'compact-ok')
    let paneRoot = await openSavedSession(page, harness, 'freshclaude', sessionId)

    const assertRendered = async () => {
      await expect(paneRoot.getByText('Context compaction', { exact: true })).toHaveCount(1, { timeout: 15_000 })
      await expect(paneRoot.getByText('/compact keep it short', { exact: true })).toBeVisible()
      await expect(paneRoot.getByText('/usage', { exact: true })).toBeVisible()
      await expect(paneRoot.getByText(/Total cost:/)).toBeVisible()
      await expect(paneRoot.getByRole('table').filter({ hasText: 'Category' })).toBeVisible()
      await expect(paneRoot.getByText(/local-command/)).toHaveCount(0)
    }
    await assertRendered()

    // Reload: the same durable transcript comes back from the server.
    await page.evaluate(() => {
      ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
    })
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    expect(await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.isAllFreshAgentNetworkEffectsSuppressed())).toBe(true)
    paneRoot = page.locator('[data-context="fresh-agent"]')
    await assertRendered()
  })

  test('freshclaude: a failed compaction, an API error and an image show durably', async ({ freshellPage: page, harness, terminal, serverInfo }) => {
    await terminal.waitForTerminal()
    await suppressFreshAgentNetwork(page)
    const failed = await seedSavedSession(serverInfo, 'compact-fail')
    let paneRoot = await openSavedSession(page, harness, 'freshclaude', failed)
    const commandError = paneRoot.getByTestId('fresh-agent-turn-error')
    await expect(commandError).toContainText('Error during compaction: API Error: 400 compaction refused by fake', { timeout: 15_000 })
    await expect(paneRoot.getByText(/compaction refused by fake/)).toHaveCount(1)

    const apiError = await seedSavedSession(serverInfo, 'api-error')
    paneRoot = await openSavedSession(page, harness, 'freshclaude', apiError)
    await expect(paneRoot.getByTestId('fresh-agent-turn-error')).toContainText('API Error: 400 fixture bad request', { timeout: 15_000 })

    const image = await seedSavedSession(serverInfo, 'image')
    paneRoot = await openSavedSession(page, harness, 'freshclaude', image)
    await expect(paneRoot.getByText('[image]', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(paneRoot.getByText('a red pixel')).toBeVisible()
  })
})
