import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFreshE2ePage, test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * LANE C / GAP F10: across an abrupt server restart, a recovered CLI pane's
 * next completed turn must ring EXACTLY once — not zero (baseline swallow)
 * and not twice (replay double-chime). Counted via the turnCompletion.seq
 * alert-edge counter (the bell/shade pipeline), the assertion model of
 * truly-idle-alerting.spec.ts. Rust-only: restartAbrupt + the rust
 * terminal.idle activity engine.
 *
 * Scope note: the stable-dedupe-key swallow regression (fresh-agent
 * `provider:sessionId` keys surviving a restart) is pinned at unit level in
 * Task 2 — a terminal pane's PTY id changes across restart, so this e2e
 * proves the USER-VISIBLE contract instead: after an abrupt restart and pane
 * recovery, a completed turn produces exactly ONE new alert edge (no
 * swallow, no double-chime).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_BEL_CLI = path.resolve(__dirname, '../fixtures/fake-bel-cli.mjs')

async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

async function selectShellIfPickerShowing(page: import('@playwright/test').Page): Promise<void> {
  const terminal = page.locator('.xterm').first()
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  await expect.poll(async () => await terminal.isVisible() || await picker.isVisible()).toBe(true)
  if (await terminal.isVisible()) return
  await picker.getByRole('button', { name: /^(Shell|WSL|CMD|PowerShell|Bash)$/i })
    .first().press('Enter')
  await expect(terminal).toBeVisible({ timeout: 15_000 })
}

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

async function openCodexPaneAndGetTerminalId(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  tabId: string,
  cwd: string,
): Promise<string> {
  const before = collectLeaves(await harness.getPaneLayout(tabId))
    .filter((leaf) => leaf?.content?.mode === 'codex')
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Codex CLI$/i }).press('Enter')
  const directory = page.getByRole('combobox', { name: /Starting directory/i })
  // The default directory arrives asynchronously from the shell projection.
  // Enter on an empty input is an invalid request, not a slow create.
  await directory.fill(cwd)
  await directory.press('Enter')
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  let terminalId: string | null = null
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    const leaf = collectLeaves(layout)
      .find((l) => l?.content?.mode === 'codex' && !beforeIds.has(l.id) && l?.content?.terminalId)
    terminalId = leaf?.content?.terminalId ?? null
    return terminalId
  }, { timeout: 15_000 }).not.toBeNull()
  return terminalId!
}

async function typePromptIntoLastPane(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('.xterm').last().click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test.describe('Turn-complete alert across abrupt restart (Rust only)', () => {
  test.setTimeout(180_000)

  test('a recovered CLI pane rings exactly once for its first post-restart turn', async ({ browser }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-lane-c-chime-'))
    // Dual-role: the Rust codex terminal lane boots a `codex app-server`
    // sidecar first from the same CODEX_CMD; a terminal-only fake exits 0 on
    // that spawn and every codex create fails PTY_SPAWN_FAILED.
    const fakeCodex = await installDualRoleCodexCli(path.join(sharedRoot, 'bin'), FAKE_BEL_CLI)
    const server = new RustServer({
      env: { CODEX_CMD: fakeCodex },
      setupHome: async (homeDir) => {
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: { codingCli: { enabledProviders: ['codex'] } },
        }, null, 2))
      },
    })
    let context: import('@playwright/test').BrowserContext | undefined
    try {
      const info = await server.start()
      const owned = await createFreshE2ePage(browser, info, { serviceWorkers: 'block' })
      context = owned.context
      const { page } = owned
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const tabId = await harness.getActiveTabId()

      const terminalId1 = await openCodexPaneAndGetTerminalId(page, harness, tabId!, sharedRoot)
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId1)
        return typeof buffer === 'string' && buffer.includes('fake-cli>')
      }, { timeout: 15_000 }).toBe(true)

      // Turn 1 (pre-restart): exactly one alert edge.
      await typePromptIntoLastPane(page, 'first prompt')
      await expect.poll(async () => {
        const state = await harness.getState()
        return state?.turnCompletion?.lastIdleAtByTerminalId?.[terminalId1] ?? null
      }, { timeout: 30_000 }).not.toBeNull()
      const seqAfterTurn1 = (await harness.getState()).turnCompletion.seq
      expect(seqAfterTurn1).toBeGreaterThanOrEqual(1)

      // Abrupt death + revival; the pane must recover to a NEW terminal.
      await server.restartAbrupt()
      await expect(async () => {
        const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 60_000 })

      let terminalId2: string | null = null
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        const leaf = collectLeaves(layout)
          .find((l) => l?.content?.mode === 'codex' && l?.content?.terminalId && l.content.terminalId !== terminalId1)
        terminalId2 = leaf?.content?.terminalId ?? null
        return terminalId2
      }, { timeout: 90_000 }).not.toBeNull()
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId2!)
        return typeof buffer === 'string' && buffer.includes('fake-cli>')
      }, { timeout: 30_000 }).toBe(true)
      const seqBeforeTurn2 = (await harness.getState()).turnCompletion.seq

      // Turn 2 (post-restart): exactly ONE new alert edge — never zero
      // (swallowed by a stale baseline), never two (replay double-chime).
      await typePromptIntoLastPane(page, 'second prompt after restart')
      await expect.poll(async () => {
        const state = await harness.getState()
        return state?.turnCompletion?.lastIdleAtByTerminalId?.[terminalId2!] ?? null
      }, { timeout: 30_000 }).not.toBeNull()
      await expect.poll(async () => {
        return (await harness.getState()).turnCompletion.seq
      }, { timeout: 10_000 }).toBe(seqBeforeTurn2 + 1)

      // Settle window: no late duplicate edge.
      await page.waitForTimeout(3_000)
      expect((await harness.getState()).turnCompletion.seq).toBe(seqBeforeTurn2 + 1)
    } finally {
      await context?.close().catch(() => {})
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
