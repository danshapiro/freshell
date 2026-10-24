// FRESHCLAUDE FIRST SEND -- create-time identity reaches the real browser and
// the production sidecar. The first prompt and a follow-up must both run under
// the same durable session identity.
//
// Helpers are copied, not imported, per this suite's per-spec-ownership
// convention (donor: freshclaude-restart-parity-rust.spec.ts, itself copied
// from restore-contract-wall-rust.spec.ts).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { claudeSimulatorServerEnv, readClaudeSimLedger } from '../helpers/claude-sim-lane.js'

// ESM project ("type": "module" in package.json): derive __dirname.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ---------------------------------------------------------------------------
// Copied helpers (donor: freshclaude-restart-parity-rust.spec.ts)
// ---------------------------------------------------------------------------

/** Dismiss the initial pane-type picker by choosing the first visible shell. */
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

/** Idempotent .freshell/config.json seed (setupHome re-runs on every boot). */
function seedWallConfig(input: {
  providers: string[]
  freshAgent?: boolean
}): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })
    await fsp.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: {
            codingCli: { enabledProviders: input.providers },
            ...(input.freshAgent ? { freshAgent: { enabled: true } } : {}),
          },
        },
        null,
        2,
      ),
    )
  }
}

/** Boot an owned RustServer, navigate, and wait for harness + WS. */
async function bootWall(
  page: Page,
  options: {
    env?: Record<string, string>
    setupHome?: (homeDir: string) => Promise<void>
  } = {},
): Promise<{ server: RustServer; info: E2eServerInfo; harness: TestHarness }> {
  const server = new RustServer({ env: options.env, setupHome: options.setupHome })
  const info = await server.start()
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { server, info, harness }
}

function findFreshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findFreshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

// Durable identity for a live claude pane: the sdk.session.init merge writes
// the durable UUID to sessionRef.sessionId + resumeSessionId; content.sessionId
// stays the sidecar's create-time placeholder.
const liveDurableIdentity = (leaf: any): string =>
  leaf?.content?.sessionRef?.sessionId ?? leaf?.content?.resumeSessionId ?? ''

/** Send one chat turn through the composer of the last fresh-agent pane. */
async function sendFreshAgentTurn(
  page: Page,
  harness: TestHarness,
  tabId: string,
  text: string,
): Promise<void> {
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  await expect
    .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
      timeout: 20_000,
    })
    .toBe('idle')
  const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
  await composer.fill(text)
  await paneRoot.getByRole('button', { name: 'Send' }).click()
}

async function createFreshclaudePane(page: Page, harness: TestHarness, cwd: string): Promise<void> {
  // setAvailableClis is client-only and gets overwritten by the app bootstrap,
  // so it must land after harness.waitForConnection() (bootWall does that).
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: false },
    })
  })
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
  // A clean isolated HOME offers no candidate directories: type the cwd.
  const directoryInput = page.getByLabel(/^Starting directory for Freshclaude$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
}

/** The simulated CLI's started prompts, in order. */
function simulatedPrompts(ledger: string): string[] {
  return readClaudeSimLedger(ledger)
    .filter((entry) => entry.kind === 'prompt')
    .map((entry) => String(entry.text ?? ''))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('freshclaude first send (rust)', () => {
  test("a new pane accepts its first message after create-time identity is available", async ({ page }) => {
    test.setTimeout(120_000)
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshclaude-first-send-'))
    const simLedger = path.join(sharedRoot, 'claude-sim-ledger.jsonl')
    const projectDir = path.join(sharedRoot, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    const { server, harness } = await bootWall(page, {
      env: claudeSimulatorServerEnv({
        ledgerPath: simLedger,
        // The production sidecar reports the durable session only when the
        // simulated CLI starts its first prompt, matching the real CLI order.
        program: {
          rules: [{ on: 'msg:prompt', emit: [{ kind: 'text', data: { text: 'Fixture claude turn' } }] }],
        },
      }),
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      expect(tabId).toBeTruthy()
      // The boot pane must be a real terminal before the pane picker opens, or
      // the Freshclaude click races the boot picker's fade-out.
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshclaudePane(page, harness, projectDir)
      const pane = page.locator('[data-context="fresh-agent"]').last()

      // Create allocates and returns a durable identity before the user types.
      await expect
        .poll(async () => liveDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId))), {
          timeout: 20_000,
        })
        .toMatch(CANONICAL_UUID_RE)
      const durableBeforeSend = liveDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId)))

      const suffix = Math.random().toString(36).slice(2, 10)
      const first = `first message ${suffix}`
      await sendFreshAgentTurn(page, harness, tabId, first)
      await expect
        .poll(() => simulatedPrompts(simLedger), { timeout: 30_000 })
        .toEqual([first])
      await expect
        .poll(async () => liveDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId))), {
          timeout: 15_000,
        })
        .toBe(durableBeforeSend)
      await expect(pane).toContainText('Fixture claude turn', { timeout: 30_000 })

      const second = `second message ${suffix}`
      await sendFreshAgentTurn(page, harness, tabId, second)
      await expect
        .poll(() => simulatedPrompts(simLedger), { timeout: 30_000 })
        .toEqual([first, second])

      // Each message was sent once and none was refused.
      const sendRequestIds = (await harness.getSentWsMessages())
        .filter((m: any) => m?.type === 'freshAgent.send')
        .map((m: any) => m.requestId)
      expect(sendRequestIds).toHaveLength(2)
      const refusals = (await harness.getReceivedWsMessages()).filter(
        (m: any) => m?.type === 'error' && sendRequestIds.includes(m.requestId),
      )
      expect(refusals).toEqual([])
      await expect(pane).toContainText(first)
      await expect(pane).toContainText(second)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
