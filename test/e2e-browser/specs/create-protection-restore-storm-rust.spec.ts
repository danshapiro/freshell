/**
 * LANE E (create protection): reload-storm contract.
 * 15 shell terminal tabs -> SIGKILL restart (RustServer.restartAbrupt()) ->
 * the reload storm re-creates every pane with NON-restore (recoveryIntent)
 * creates (validated frozen-client behavior post-PR #531), so the 15-burst
 * TRIPS the 10/10s limiter (server log MUST contain
 * terminal_create_rate_limited — non-vacuous) and the frozen client's
 * RATE_LIMITED ladder recovers ALL panes, with the spawn gate (default
 * concurrency 4) active throughout. Owns its RustServer (ephemeral port,
 * never the user's 3001/3002). Helpers copied per per-spec-ownership.
 * Seeds panes.defaultNewPane:'shell' so tab-add mounts terminals directly
 * (default 'ask' would create picker panes and fire ZERO creates).
 *
 * SETUP adaptation (validated against the frozen client): the BOOT tab's
 * layout is locked in by PaneLayout's initLayout at first mount
 * (PaneLayout.tsx:30-35), which races AHEAD of the server-settings
 * hydration, so the first tab is a picker pane even with the 'shell' seed.
 * We dismiss it with the suite's established donor helper
 * (selectShellIfPickerShowing, copied from restore-contract-wall-rust.spec.ts
 * per per-spec-ownership) and gate the storm setup on Redux showing the
 * hydrated 'shell' value so tabs 2..15 mount terminals directly. Assertions
 * are unchanged.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { Page } from '@playwright/test'

const TAB_COUNT = 15

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
 *  (Copied donor helper: restore-contract-wall-rust.spec.ts.) */
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

async function readServerLogs(logsDir: string): Promise<string> {
  const files = await fs.readdir(logsDir).catch(() => [] as string[])
  let combined = ''
  for (const f of files) {
    combined += await fs.readFile(path.join(logsDir, f), 'utf8').catch(() => '')
  }
  return combined
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

test.describe('Create protection: restore storm (Rust only)', () => {
  test.setTimeout(300_000)

  test('15-pane reload storm survives abrupt restart: limiter fires, ladder recovers all panes', async ({ page }) => {
    const server = new RustServer({
      // An inherited RUST_LOG=error would suppress the WARN events this spec
      // greps for (the fixture spreads process.env) — pin it.
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
    const info: E2eServerInfo = await server.start()
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
      await waitForWsReady(page) // also past /api/bootstrap settings hydration

      // Gate the storm setup on the hydrated setting: tabs created via
      // tab-add must mount shell terminals directly (PaneLayout reads Redux
      // settings at initLayout time).
      await expect.poll(async () => {
        const settings = await harness.getSettings()
        return settings?.panes?.defaultNewPane ?? null
      }, { timeout: 30_000 }).toBe('shell')

      // The BOOT tab's layout was locked in before hydration (see file doc
      // comment), so it is a picker pane: dismiss it into a shell terminal.
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Storm SETUP under the 10/10s limit: one tab per ~1.2s, waiting for
      // each new tab's terminal before the next (a fresh tab is active on
      // creation, so its terminal mounts immediately).
      const addButton = page.locator('[data-context="tab-add"]')
      for (let i = 1; i < TAB_COUNT; i++) {
        await addButton.click()
        await harness.waitForTabCount(i + 1)
        await expect.poll(async () => {
          const ids = await allLeafTerminalIds(harness)
          return ids.length >= i + 1 && ids.every((id) => id !== null)
        }, { timeout: 30_000 }).toBe(true)
        await page.waitForTimeout(1_200)
      }
      const idsBefore = (await allLeafTerminalIds(harness)) as string[]
      expect(idsBefore).toHaveLength(TAB_COUNT)

      await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })

      // --- SIGKILL + reboot on same home/port/token; reload so the client
      // mounts every persisted tab at once (the RCA thundering herd). ---
      await server.restartAbrupt()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()
      await waitForWsReady(page)

      // ALL panes recover: same tab count, every leaf re-anchors to a NEW
      // live terminal, no pane in error status. Shell panes re-create with
      // NON-restore recoveryIntent creates; the 15-burst exceeds 10/10s, so
      // ~5 get RATE_LIMITED and the frozen ladder retries them (2s/4s/8s
      // cumulative — by ~14s the window has drained). 120s is generous.
      await expect.poll(() => harness.getTabCount(), { timeout: 60_000 }).toBe(TAB_COUNT)
      await expect.poll(async () => {
        const ids = await allLeafTerminalIds(harness)
        return ids.length === TAB_COUNT
          && ids.every((id) => id !== null && !idsBefore.includes(id as string))
      }, { timeout: 120_000 }).toBe(true)
      const state = await harness.getState()
      for (const tab of state.tabs.tabs) {
        for (const leaf of collectLeaves(state.panes.layouts[tab.id])) {
          expect(leaf?.content?.status, `pane in tab ${tab.id}`).not.toBe('error')
        }
      }

      // Non-vacuous proof the limiter actually fired on the reload storm
      // (validated: post-restart shell-pane creates are non-restore, so a
      // 15-burst MUST trip the 10/10s limit) — and the panes above still all
      // recovered, which is the ladder working end-to-end.
      const logs = await readServerLogs(info.logsDir)
      expect(logs).toContain('terminal_create_rate_limited')
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
