/**
 * Restore-create stagger invariant (kata rf0v): a client reload restoring
 * multiple persisted terminal panes must space `terminal.create` wire sends
 * >=400ms apart so no two agent processes spawn within the same ~100ms
 * window (the known OpenCode/Bun concurrent-launch crash,
 * upstream anomalyco/opencode#38366).
 *
 * Owns its RustServer (ephemeral port, never the user's 3001/3002). Helpers
 * copied per per-spec-ownership convention (do NOT import across spec
 * boundaries). Seeds `panes.defaultNewPane:'shell'` so tab-add mounts shell
 * terminals directly (the default 'ask' creates picker panes with zero
 * `terminal.create` sends).
 *
 * SETUP adaptation (same as create-protection-restore-storm-rust.spec.ts):
 * the BOOT tab's layout is locked in by PaneLayout's initLayout at first
 * mount, which races AHEAD of the server-settings hydration, so the first
 * tab is a picker pane even with the 'shell' seed. We dismiss it with
 * selectShellIfPickerShowing and gate the setup on Redux showing the
 * hydrated 'shell' value so tabs 2..N mount terminals directly.
 *
 * The TerminalCreateStagger (src/lib/terminal-create-stagger.ts, wired in
 * WsClient per Task 2) paces terminal.create wire sends at 450ms minimum
 * intervals. This spec proves that pacing end-to-end by reading the
 * `__sentAt` timestamps from the test harness's sentWsMessages recording.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { Page } from '@playwright/test'

const PANE_COUNT = 6

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

/** Dismiss the initial pane-type picker by choosing the first visible shell.
 *  (Copied donor helper: create-protection-restore-storm-rust.spec.ts.) */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (!(await picker.isVisible().catch(() => false))) return
  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const option = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true })
      return
    }
  }
}

/** terminalId of every leaf across every tab (poll-friendly). */
async function allLeafTerminalIds(harness: TestHarness): Promise<(string | null)[]> {
  const state = await harness.getState()
  const ids: (string | null)[] = []
  for (const tab of state.tabs.tabs) {
    for (const leaf of collectLeaves(state.panes.layouts[tab.id])) {
      ids.push(leaf?.content?.terminalId ?? null)
    }
  }
  return ids
}

test.describe('restore create stagger', () => {
  test.setTimeout(300_000)

  test('multiple persisted terminal panes space terminal.create sends >=400ms on reload', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const server = new RustServer({
      env: { RUST_LOG: 'info' },
      // Tab-add must mount shell terminals directly; the default
      // panes.defaultNewPane:'ask' creates PICKER panes (zero creates).
      // setupHome runs before the wizard-bypass write, which spread-preserves
      // this seed (rust-server.ts:184-195); it re-runs on every boot, so the
      // full-file write is idempotent. Value must be EXACT lowercase 'shell'
      // (an invalid value silently discards the whole settings tree).
      setupHome: async (homeDir) => {
        const dir = path.join(homeDir, '.freshell')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({
          version: 1,
          settings: { panes: { defaultNewPane: 'shell' } },
        }, null, 2))
      },
    })
    const info: TestServerInfo = await server.start()
    try {
      // Belt-and-suspenders: the seed actually took (converts a silent
      // settings-tree fallback into a crisp failure here).
      const settingsRes = await fetch(`${info.baseUrl}/api/settings`, {
        headers: { 'x-auth-token': info.token },
      })
      expect(((await settingsRes.json()) as any)?.panes?.defaultNewPane).toBe('shell')

      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await waitForWsReady(page)

      // Gate the setup on the hydrated setting: tabs created via tab-add
      // must mount shell terminals directly (PaneLayout reads Redux
      // settings at initLayout time).
      await expect.poll(async () => {
        const settings = await harness.getSettings()
        return settings?.panes?.defaultNewPane ?? null
      }, { timeout: 30_000 }).toBe('shell')

      // The BOOT tab's layout was locked before hydration (see file doc
      // comment), so it is a picker pane: dismiss it into a shell terminal.
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Create additional terminal panes via tab-add. The stagger paces
      // each terminal.create at 450ms, so we wait for each terminal to
      // anchor before the next tab-add.
      const addButton = page.locator('[data-context="tab-add"]')
      for (let i = 1; i < PANE_COUNT; i++) {
        await addButton.click()
        await harness.waitForTabCount(i + 1)
        await expect.poll(async () => {
          const ids = await allLeafTerminalIds(harness)
          return ids.length >= i + 1 && ids.every((id) => id !== null)
        }, { timeout: 30_000 }).toBe(true)
      }

      // Persist state (flush localStorage so the reload restores all panes).
      await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })

      // Capture terminal IDs before restart — after reload, every pane
      // must anchor with a NEW terminal ID (proves fresh creates, not
      // stale pre-restart IDs).
      const idsBefore = (await allLeafTerminalIds(harness)) as string[]
      expect(idsBefore).toHaveLength(PANE_COUNT)

      // --- SIGKILL + reboot on same home/port/token; reload so the client
      // mounts every persisted tab at once (the restore thundering herd). ---
      await server.restartAbrupt()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()
      await waitForWsReady(page)

      // ALL panes recover: same tab count, every leaf re-anchors to a NEW
      // live terminal. The stagger paces the restore creates at 450ms, so
      // PANE_COUNT panes take ~PANE_COUNT*450ms to fully restore.
      await expect.poll(() => harness.getTabCount(), { timeout: 60_000 }).toBe(PANE_COUNT)
      await expect.poll(async () => {
        const ids = await allLeafTerminalIds(harness)
        return ids.length === PANE_COUNT
          && ids.every((id) => id !== null && !idsBefore.includes(id as string))
      }, { timeout: 120_000 }).toBe(true)

      // Read sent WS messages with timestamps (only post-reload sends are
      // captured — the harness is reinstalled fresh on page reload).
      const sentMessages = await harness.getSentWsMessagesWithTimestamps()
      const creates = sentMessages.filter(
        (m: any) => m?.type === 'terminal.create',
      ) as Array<{ __sentAt?: number; type?: string; requestId?: string }>

      // Cardinality check — prevents vacuous pass (zero creates captured
      // would make the spacing assertion trivially true).
      expect(creates.length).toBeGreaterThanOrEqual(2)

      // Assert >=400ms spacing between consecutive terminal.create wire
      // sends. The stagger interval is 450ms; we assert >=400ms to allow
      // for minor timer jitter while still proving the ~100ms crash window
      // is never entered.
      const timestamps = creates.map((m) => m.__sentAt as number)
      for (let i = 1; i < timestamps.length; i++) {
        const gap = timestamps[i] - timestamps[i - 1]
        expect(
          gap,
          `terminal.create #${i} should be >=400ms after #${i - 1} (got ${gap}ms)`,
        ).toBeGreaterThanOrEqual(400)
      }

      // All panes eventually anchored (no wedge) — verified by the poll
      // above: every pane has a non-null terminal ID not in idsBefore.
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
