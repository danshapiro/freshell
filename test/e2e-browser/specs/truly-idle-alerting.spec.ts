// TRULY-IDLE ALERTING (terminal.idle) -- end-to-end proof on the legacy Node
// server, matrix-style so the Rust leg flips on trivially once the Rust
// terminal.idle emitter lands (feat/rust-terminal-activity-idle).
//
// Drives a REAL claude-mode terminal pane whose CLI is a deterministic fake
// (`CLAUDE_CMD` override, same pattern as restore-matrix.spec.ts): the fake
// stays interactive, and on each submitted line "works" for a fixed window
// before emitting a tracker-eligible Stop-hook BEL. That exercises the entire
// production pipeline with zero Redux shortcuts:
//
//   PTY submit -> claude tracker busy -> BLUE
//   BEL -> tracker idle + turn.complete -> TrulyIdleEmitter grace (2s, quiet)
//       -> ws `terminal.idle` broadcast -> exactly ONE alert edge
//       -> persistent GREEN pane header + tab SHADING
//   activate tab -> shading clears; green persists
//
// The audible bell itself is unit-covered (useTurnCompletionNotifications);
// here "one bell" is proven as exactly one alert edge entering the pipeline
// (turnCompletion.seq === 1, stable across an extra settle window).

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle, type E2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

// How long the fake CLI "works" after each submit before emitting its BEL.
// Long enough for Playwright to observe BLUE deterministically, short enough
// to keep the spec fast (turn end + 2s truly-idle grace still fits timeouts).
const FAKE_TURN_MS = 4_000

/**
 * Deterministic fake `claude` CLI. Interactive (never exits on its own); on
 * every line of stdin (the pane's Enter submit -- cooked-mode line discipline
 * withholds bytes until then) it waits FAKE_CLAUDE_TURN_MS, prints a turn-end
 * marker, then writes a lone BEL chunk -- the same tracker-eligible shape the
 * real CLI's injected Stop hook produces (`countTrackerTurnCompleteSignals`:
 * a BEL with no visible output after it in its chunk).
 */
async function installFakeClaudeCli(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-claude-cli.mjs')
  const script = `#!/usr/bin/env node
const turnMs = Number(process.env.FAKE_CLAUDE_TURN_MS || '${FAKE_TURN_MS}')
process.stdout.write('fake-claude ready\\r\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {
  setTimeout(() => {
    process.stdout.write('fake-claude turn done\\r\\n')
    setTimeout(() => process.stdout.write('\\x07'), 50)
  }, turnMs)
})
process.stdin.resume()
`
  await fs.writeFile(dest, script, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

function findTerminalLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'terminal') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findTerminalLeaf(child)
      if (found) return found
    }
  }
  return null
}

test.describe('Truly-idle alerting (terminal.idle)', () => {
  test.setTimeout(180_000)

  test('claude terminal: blue while busy, then green + one alert edge + tab shade after quiet grace; activating the tab clears the shade', async ({ page, e2eServerKind }) => {
    test.fixme(
      e2eServerKind === 'rust',
      'pending rust terminal.idle emitter — feat/rust-terminal-activity-idle',
    )

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-truly-idle-'))
    let server: E2eServerHandle | undefined
    try {
      const fakeClaudePath = await installFakeClaudeCli(path.join(sharedRoot, 'bin'))

      server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            CLAUDE_CMD: fakeClaudePath,
            FAKE_CLAUDE_TURN_MS: String(FAKE_TURN_MS),
          },
          // PanePicker renders a CLI option only when availableClis[name]
          // (server `which` probe honors the CLAUDE_CMD override) AND
          // codingCli.enabledProviders includes it -- seed the latter.
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                codingCli: { enabledProviders: ['claude'] },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()

      // The boot tab shows the pane-type picker: pick Claude -> the picker
      // asks for a starting directory -> a real claude-mode PTY spawning the
      // fake CLI in that directory.
      await page.getByRole('button', { name: /^Claude CLI$/i }).click({ timeout: 15_000 })
      const cwdBox = page.getByRole('combobox', { name: /starting directory for claude cli/i })
      await expect(cwdBox).toBeVisible({ timeout: 10_000 })
      await cwdBox.fill(sharedRoot)
      await cwdBox.press('Enter')
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await harness.waitForTerminalText('fake-claude ready', 30_000)

      const claudeTabId = await harness.getActiveTabId()
      expect(claudeTabId).toBeTruthy()
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(claudeTabId!)
        return findTerminalLeaf(layout)?.content?.terminalId ?? null
      }, { timeout: 20_000 }).not.toBeNull()
      const layout = await harness.getPaneLayout(claudeTabId!)
      const terminalId = findTerminalLeaf(layout)!.content.terminalId as string

      const claudeTab = page.locator(`[data-context="tab"][data-tab-id="${claudeTabId}"]`)
      const claudeTabIcon = claudeTab.locator('svg').first()

      // Submit a prompt: PTY submit -> tracker busy -> BLUE.
      await page.locator('.xterm').first().click()
      await page.keyboard.type('hello fake claude')
      await page.keyboard.press('Enter')
      await expect(claudeTabIcon).toHaveClass(/text-blue-500/, { timeout: 10_000 })

      // Move away so the claude tab is a background tab when the turn ends.
      await page.getByRole('button', { name: 'New shell tab' }).click()
      await harness.waitForTabCount(2)
      const shellTabId = await harness.getActiveTabId()
      expect(shellTabId).not.toBe(claudeTabId)

      // Turn end (BEL) clears busy well before the truly-idle edge: blue off.
      await expect(claudeTabIcon).not.toHaveClass(/text-blue-500/, { timeout: FAKE_TURN_MS + 10_000 })

      // After the quiet 2s grace the server broadcasts terminal.idle: exactly
      // one alert edge lands (bell + shade pipeline), keyed to this terminal.
      await expect.poll(async () => {
        const state = await harness.getState()
        return state?.turnCompletion?.lastIdleAtByTerminalId?.[terminalId] ?? null
      }, { timeout: 20_000 }).not.toBeNull()

      const alerted = await harness.getState()
      expect(alerted.turnCompletion.attentionByTab[claudeTabId!]).toBe(true)
      expect(alerted.turnCompletion.seq).toBe(1)

      // SHADE: the background claude tab carries the attention highlight.
      await expect(claudeTab).toHaveClass(/bg-emerald-100/, { timeout: 10_000 })

      // One-shot: no further edges arrive during an extra settle window
      // (no re-ring from replay, no second bell without a new turn).
      await page.waitForTimeout(3_000)
      const settled = await harness.getState()
      expect(settled.turnCompletion.seq).toBe(1)

      // Activate the claude tab: the shade clears...
      await claudeTab.click()
      await expect.poll(async () => {
        const state = await harness.getState()
        return state?.turnCompletion?.attentionByTab?.[claudeTabId!] ?? null
      }, { timeout: 10_000 }).toBeNull()
      await expect(claudeTab).not.toHaveClass(/bg-emerald-100/)

      // ...while GREEN persists: the pane header shows the idle state (session
      // known + not busy), independent of the shade's click-clearing.
      await expect(page.getByRole('banner', { name: /^Pane:/ }).first())
        .toHaveClass(/bg-emerald-50/, { timeout: 10_000 })
    } finally {
      await server?.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
