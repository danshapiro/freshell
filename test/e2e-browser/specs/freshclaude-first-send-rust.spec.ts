// FRESHCLAUDE FIRST SEND -- the real Claude CLI's session-report order.
//
// The real CLI emits system/init (relayed by the sidecar as sdk.session.init,
// which gives the pane its durable session id and the server's ownership
// coordinator its owner record) only once a prompt runs, and again at the
// start of every turn. So a new freshclaude pane's first message is sent
// before anything owns its session, and its later messages are sent after the
// coordinator owns the session under the durable id, while the pane still
// addresses it by the sidecar's placeholder id. Every message must run.
//
// The fake sidecar's FAKE_CLAUDE_SIDECAR_INIT_AT=turn reproduces that order.
// Every other freshclaude spec uses the fake's default, which reports the
// session right at create, so without this spec no browser test sends a
// message before the session is reported.
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

// ESM project ("type": "module" in package.json): derive __dirname.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FIXTURE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')

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

/** The text of every prompt the fake sidecar received, in order (its request
 * log is the ground truth for "the message ran"). */
function sidecarPrompts(requestLog: string): string[] {
  if (!fs.existsSync(requestLog)) return []
  return fs
    .readFileSync(requestLog, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.msg?.type === 'send')
    .map((entry) => entry.msg.text)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('freshclaude first send (rust)', () => {
  test("a new pane's messages run when the CLI reports the session only once a prompt runs", async ({ page }) => {
    test.setTimeout(120_000)
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshclaude-first-send-'))
    const requestLog = path.join(sharedRoot, 'sidecar-requests.jsonl')
    const projectDir = path.join(sharedRoot, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    const { server, harness } = await bootWall(page, {
      env: {
        FRESHELL_CLAUDE_SIDECAR: FIXTURE,
        FAKE_CLAUDE_SIDECAR_INIT_AT: 'turn',
        FAKE_CLAUDE_SIDECAR_LOG: requestLog,
      },
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

      // The order under test: the session exists but the CLI has not reported
      // it, so the pane has no durable id when the user types.
      await expect
        .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
          timeout: 20_000,
        })
        .toBe('idle')
      expect(liveDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId)))).toBe('')

      const suffix = Math.random().toString(36).slice(2, 10)
      const first = `first message ${suffix}`
      await sendFreshAgentTurn(page, harness, tabId, first)
      await expect
        .poll(() => sidecarPrompts(requestLog), { timeout: 30_000 })
        .toEqual([first])
      // Running the first prompt made the CLI report the session: the pane now
      // holds its durable id (and the server owns the session under it).
      await expect
        .poll(async () => liveDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId))), {
          timeout: 15_000,
        })
        .toMatch(CANONICAL_UUID_RE)
      await expect(pane).toContainText('Fixture claude turn', { timeout: 30_000 })

      const second = `second message ${suffix}`
      await sendFreshAgentTurn(page, harness, tabId, second)
      await expect
        .poll(() => sidecarPrompts(requestLog), { timeout: 30_000 })
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
