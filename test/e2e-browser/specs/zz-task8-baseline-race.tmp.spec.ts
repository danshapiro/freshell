import { test, expect } from '../helpers/fixtures.js'
import type { TestHarness } from '../helpers/test-harness.js'

// TEMPORARY experiment (Task 8 review follow-up; never merged). Simulates a
// shell whose start-up output sets an OSC window title just before its
// prompt, and compares the old baseline order (record as soon as the pane has
// a terminal id) with the new one (wait for the prompt, then for the stored
// tab to hold still). Nothing managed runs here: any change is the legacy
// OSC title write, so a "nothing changed" comparison must hold.

test.setTimeout(120_000)

type StoredTab = { title?: string; titleSetByUser?: boolean; updatedAt?: number }

async function storedTab(harness: TestHarness, tabId: string): Promise<StoredTab> {
  const state = await harness.getState() as { tabs: { tabs: Array<StoredTab & { id: string }> } }
  const tab = state.tabs.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) throw new Error(`no tab ${tabId}`)
  return { title: tab.title, titleSetByUser: tab.titleSetByUser, updatedAt: tab.updatedAt }
}

async function settledStoredTab(harness: TestHarness, tabId: string, quietMs = 1_000): Promise<StoredTab> {
  let previous: string | null = null
  let settled: StoredTab | null = null
  await expect.poll(async () => {
    const current = await storedTab(harness, tabId)
    const serialized = JSON.stringify(current)
    const stable = serialized === previous
    previous = serialized
    if (stable) settled = current
    return stable
  }, { timeout: 30_000, intervals: [quietMs] }).toBe(true)
  return settled!
}

async function terminalIdOf(harness: TestHarness, tabId: string): Promise<string> {
  let id: string | null = null
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    if (layout?.type !== 'leaf' || layout.content?.kind !== 'terminal') return null
    id = typeof layout.content.terminalId === 'string' ? layout.content.terminalId : null
    return id
  }, { timeout: 45_000 }).not.toBeNull()
  return id!
}

const SLOW_STARTUP = "sleep 2.5; printf '\\033]0;Startup title\\007'"

test.describe('task 8 baseline race (temporary)', () => {
  test('OLD order: baseline before the prompt', async ({ freshellPage: page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const tabId = (await harness.getActiveTabId())!
    const terminalId = await terminalIdOf(harness, tabId)
    await terminal.waitForPrompt({ timeout: 30_000, terminalId })
    await terminal.executeCommand(SLOW_STARTUP)
    await terminal.waitForOutput('sleep 2.5; printf', { terminalId, timeout: 15_000 })
    const before = await storedTab(harness, tabId)
    await page.waitForTimeout(5_000)
    expect(await storedTab(harness, tabId)).toEqual(before)
  })

  test('NEW order: baseline after the prompt and a quiet second', async ({ freshellPage: page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const tabId = (await harness.getActiveTabId())!
    const terminalId = await terminalIdOf(harness, tabId)
    await terminal.waitForPrompt({ timeout: 30_000, terminalId })
    await terminal.executeCommand(SLOW_STARTUP)
    await terminal.waitForOutput('sleep 2.5; printf', { terminalId, timeout: 15_000 })
    await terminal.waitForPrompt({ timeout: 30_000, terminalId })
    const before = await settledStoredTab(harness, tabId)
    // Non-vacuity: the simulated start-up title landed before the baseline.
    expect(before.title).toBe('Startup title')
    await page.waitForTimeout(5_000)
    expect(await storedTab(harness, tabId)).toEqual(before)
  })
})
