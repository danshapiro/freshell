/**
 * LANE E (create protection): the frozen client's RATE_LIMITED retry ladder
 * against the Rust limiter. Rapid tab storm fires 15 non-restore
 * terminal.creates in a burst; the server rejects overflow with the pinned
 * RATE_LIMITED frame; the client ladder (2/4/8/12/12s, same requestId)
 * recovers every pane WITHOUT any client change. Non-vacuous: the server
 * log must contain terminal_create_rate_limited.
 * Seeds panes.defaultNewPane:'shell' (validated: the default 'ask' makes
 * tab-add create PICKER panes — zero terminal.creates, vacuous test).
 *
 * SETUP adaptation (copied from Task 5's create-protection-restore-storm
 * spec, validated against the frozen client): the BOOT tab's layout is
 * locked in by PaneLayout's initLayout at first mount (PaneLayout.tsx:30-35),
 * which races AHEAD of the server-settings hydration, so the first tab is a
 * picker pane even with the 'shell' seed. We dismiss it with the suite's
 * established donor helper (selectShellIfPickerShowing) and gate the burst
 * on Redux showing the hydrated 'shell' value so tabs 2..15 mount terminals
 * directly. Assertions are unchanged from the brief.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { Page } from '@playwright/test'

const TAB_COUNT = 15 // 15 burst creates: 10 accepted, 5 rate-limited

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

test.describe('Create rate limit: client ladder recovery (Rust only)', () => {
  test.setTimeout(240_000)

  test('a non-restore create flood is rate limited and the ladder recovers all panes', async ({ page }) => {
    const server = new RustServer({
      env: { RUST_LOG: 'info' }, // an inherited RUST_LOG=error would suppress the WARN grep
      // Tab-add must mount shell terminals directly; the default
      // panes.defaultNewPane:'ask' creates PICKER panes (zero creates).
      // Value must be EXACT lowercase 'shell' (an invalid value silently
      // discards the whole settings tree).
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
      // Seed took (guards the silent settings-tree fallback).
      const settingsRes = await fetch(`${info.baseUrl}/api/settings`, {
        headers: { 'x-auth-token': info.token },
      })
      expect(((await settingsRes.json()) as any)?.panes?.defaultNewPane).toBe('shell')

      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await waitForWsReady(page) // settings hydrated before the flood (bootstrap race)

      // Gate the burst on the hydrated setting: tabs created via tab-add
      // must mount shell terminals directly (PaneLayout reads Redux settings
      // at initLayout time).
      await expect.poll(async () => {
        const settings = await harness.getSettings()
        return settings?.panes?.defaultNewPane ?? null
      }, { timeout: 30_000 }).toBe('shell')

      // The BOOT tab's layout was locked in before hydration (see file doc
      // comment), so it is a picker pane: dismiss it into a shell terminal.
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // BURST: rapid clicks, no waiting — every new tab mounts a fresh
      // (non-restore) terminal.create.
      const addButton = page.locator('[data-context="tab-add"]')
      for (let i = 1; i < TAB_COUNT; i++) {
        await addButton.click()
      }
      await harness.waitForTabCount(TAB_COUNT)

      // The limit actually fired (otherwise this test is vacuous).
      await expect.poll(async () => readServerLogs(info.logsDir), { timeout: 30_000 })
        .toContain('terminal_create_rate_limited')

      // Ladder recovery: rejected creates retry at 2s/6s/14s cumulative;
      // by ~14s the 10s window has drained and every pane comes up.
      await expect.poll(async () => {
        const ids = await allLeafTerminalIds(harness)
        return ids.length === TAB_COUNT && ids.every((id) => id !== null)
      }, { timeout: 120_000 }).toBe(true)
      const state = await harness.getState()
      for (const tab of state.tabs.tabs) {
        for (const leaf of collectLeaves(state.panes.layouts[tab.id])) {
          expect(leaf?.content?.status, `pane in tab ${tab.id}`).not.toBe('error')
        }
      }
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
