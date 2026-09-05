/**
 * HIDDEN-PANE REBIND (F8 / P1.11) -- e2e proof that HIDDEN panes rebind across
 * an abrupt server restart (RustServer.restartAbrupt(), SIGKILL + revive on
 * the same home/port/token) WITHOUT being revealed.
 *
 * What the wall's :2107 entry already proves on unfixed main: the dead-
 * terminal census re-CREATES a hidden pane (new terminalId). What THIS spec
 * adds are the discriminators only the hidden-pane-rebind lane can satisfy:
 *
 * - Test 1 (terminal): `content.streamId` non-null and CHANGED. streamId is
 *   written ONLY by the terminal.attach.ready handler and explicitly reset to
 *   undefined by terminal.created (TerminalView.tsx -- create paths set
 *   `streamId: undefined`, attach-ready paths set `streamId: msg.streamId`),
 *   so it proves the hidden BACKGROUND ATTACH completed, not just re-create.
 * - Test 2 (fresh-agent): `content.createRequestId` CHANGED. A fresh nanoid
 *   is minted ONLY by the `.lost` recovery re-create (FreshAgentView.tsx),
 *   which requires the server's freshAgent.error{INVALID_SESSION_ID} round
 *   trip to this pane's post-restart attach -- unreachable pre-fix, where a
 *   hidden pane sends nothing and keeps its stale pre-restart Redux state.
 *
 * Do not weaken any conjunct in either poll.
 *
 * restartAbrupt() exists only on RustServer.
 *
 * Helpers are COPIED from restore-contract-wall-rust.spec.ts, not imported,
 * per this suite's per-spec-ownership convention (see that file's header).
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import type { Page } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM project ("type": "module" in package.json): __dirname does not exist in
// ESM modules, so derive it -- same convention as every fixture-referencing
// donor spec (e.g. restore-contract-wall-rust.spec.ts:39-40).
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CLAUDE_SIDECAR_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')

// ---------------------------------------------------------------------------
// Shared helpers (per-spec copies -- donor: restore-contract-wall-rust.spec.ts)
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

/** Poll the in-page harness until the WS transport reports 'ready'. */
async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

/** Idempotent .freshell/config.json seed (setupHome re-runs on every boot). */
function seedWallConfig(input: {
  providers: string[]
  freshAgent?: boolean
}): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
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

// --- layout tree walker (donor: restore-contract-wall-rust.spec.ts:233) ---

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

// --- REST helpers (donor: restore-contract-wall-rust.spec.ts:255-271) ---

function restApiHeaders(info: E2eServerInfo): Record<string, string> {
  return { 'x-auth-token': info.token, 'content-type': 'application/json' }
}

/** POST /api/tabs; returns the created tabId (envelope is {status,data}). */
async function createTabViaRest(info: E2eServerInfo, body: object): Promise<string> {
  const res = await fetch(`${info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: restApiHeaders(info),
    body: JSON.stringify(body),
  })
  const payload = await res.json()
  expect(res.ok, `POST /api/tabs: ${JSON.stringify(payload)}`).toBe(true)
  const tabId = payload?.data?.tabId
  expect(tabId, 'POST /api/tabs envelope data.tabId').toBeTruthy()
  return tabId as string
}

// --- freshclaude fresh-agent helper (fixture: fake-claude-sidecar.mjs via the
// production env seam FRESHELL_CLAUDE_SIDECAR) ---

async function createFreshclaudePane(page: Page, harness: TestHarness, cwd: string): Promise<void> {
  // setAvailableClis is client-only AND gets overwritten by the app
  // bootstrap + /api/platform fetch (App.tsx:572,609). Callers reach this
  // helper only after harness.waitForConnection(), which is what makes the
  // dispatch land AFTER those overwrites (donor ordering:
  // freshopencode-restart-recovery.spec.ts:100-115). Keep it that way.
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: false },
    })
  })
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
  // /api/files/candidate-dirs returns [] on a clean isolated HOME (no $HOME
  // fallback, crates/freshell-server/src/files.rs:15-26), so a "first
  // option" may not exist -- TYPE the cwd and press Enter instead (donor:
  // freshopencode-restart-recovery.spec.ts:117-124).
  const directoryInput = page.getByLabel(/^Starting directory for Freshclaude$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
  // NOTE: the thread-snapshot fetch can 503 on a healthy fresh pane (no
  // claude adapter in the Rust snapshot router) and surface a history-load
  // banner. Assert pane state via the harness (Redux), tolerate the banner --
  // never assert error-free UI chrome for freshclaude.
}

/** Reveal a hidden tab by clicking its tab strip button; falls back to a
 *  harness dispatch if the locator misses. DOM hook verified: TabItem.tsx:138
 *  renders `data-context="tab" data-tab-id={tab.id}` on the tab-strip button
 *  (the data-context conjunct matters -- pane containers ALSO carry
 *  data-tab-id, e.g. Pane.tsx:76 / TerminalView.tsx:4546). Action name
 *  verified: tabs/setActiveTab (src/store/tabsSlice.ts:325). */
async function revealTab(page: Page, harness: TestHarness, tabId: string): Promise<void> {
  const tabButton = page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)
  if (await tabButton.count()) {
    await tabButton.first().click()
  } else {
    await page.evaluate((id) => {
      ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: id })
    }, tabId)
  }
  await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabId)
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

test.describe('hidden-pane rebind (F8 / P1.11)', () => {
  test.setTimeout(180_000)

  test('hidden BUSY terminal pane un-wedges after abrupt restart without reveal', async ({ page }) => {
    const { server, harness, info } = await bootWall(page)
    try {
      await selectShellIfPickerShowing(page)
      const hiddenTabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => (await harness.getPaneLayout(hiddenTabId))?.content?.terminalId ?? null, { timeout: 20_000 })
        .not.toBeNull()
      const contentBefore = (await harness.getPaneLayout(hiddenTabId))?.content
      const terminalIdBefore = contentBefore?.terminalId as string
      const streamIdBefore = contentBefore?.streamId ?? null

      // Make the pane BUSY: run a long-lived foreground command. With >1 tab
      // mounted, `.xterm` matches HIDDEN tabs' still-mounted terminals too --
      // always use `.xterm:visible` (donor gotcha, wall spec :1390-1396).
      await page.locator('.xterm:visible').first().click()
      await page.keyboard.type('sleep 500')
      await page.keyboard.press('Enter')

      // Hide it: a second tab becomes active.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(hiddenTabId)

      // SIGKILL + revive. Do NOT touch the hidden tab.
      await server.restartAbrupt()
      await waitForWsReady(page)

      // Session rebind WITHOUT reveal. DISCRIMINATING evidence -- this poll
      // FAILS on the unfixed base: a new terminalId + 'running' alone only
      // proves the census re-create path, which ALREADY works while hidden on
      // main. What this lane adds is the hidden background terminal.attach,
      // and its only Redux-visible footprint is content.streamId: the
      // terminal.created handler explicitly resets streamId to undefined
      // and ONLY the terminal.attach.ready handler writes it back
      // (TerminalView.tsx), with a fresh server-minted stream id per PTY
      // (crates/freshell-terminal/src/registry.rs:877-892). So require new
      // terminalId AND a non-null streamId differing from the pre-restart one
      // AND status 'running' -- unreachable without a completed hidden
      // background attach. Do not weaken any conjunct.
      await expect
        .poll(async () => {
          const content = (await harness.getPaneLayout(hiddenTabId))?.content
          const tid = content?.terminalId ?? null
          const sid = content?.streamId ?? null
          const rebound = tid && tid !== terminalIdBefore && content?.status === 'running'
          const attached = sid && sid !== streamIdBefore
          return rebound && attached ? `${tid}:${sid}` : null
        }, { timeout: 30_000 })
        .not.toBeNull()

      // Reveal and verify live content promptly (attach already happened in
      // the background -- reveal is surface work only).
      await revealTab(page, harness, hiddenTabId)
      await expect(page.locator('.xterm:visible').first()).toBeVisible()
      // A live shell prompt renders within the reveal budget; the pane must
      // NOT show the blocking creating spinner.
      await expect
        .poll(async () => (await harness.getPaneLayout(hiddenTabId))?.content?.status, { timeout: 10_000 })
        .toBe('running')
    } finally {
      await server.stop()
    }
  })

  test('hidden fresh-agent pane recovers after abrupt restart without reveal', async ({ page }) => {
    // Sidecar REQUEST log (FAKE_CLAUDE_SIDECAR_LOG, fake-claude-sidecar.mjs
    // Task 7 knob): the post-restart resume proof below reads it. NOT the
    // terminal-CLI argv log -- the fresh-agent path never spawns the CLI.
    const requestLog = path.join(os.tmpdir(), `freshell-e2e-claude-sidecar-${Date.now()}.jsonl`)
    const { server, harness, info } = await bootWall(page, {
      env: { FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE, FAKE_CLAUDE_SIDECAR_LOG: requestLog },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker -- otherwise openPanePicker early-returns the still-
      // fading boot picker and the Freshclaude click is swallowed when that
      // pane turns into the shell (donor guard, wall spec :641-647).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      // Create a freshclaude pane in the current tab (helper copied from the wall).
      const freshTabId = (await harness.getActiveTabId())!
      // Helper signature is (page, harness, cwd) -- the wall spec's call sites
      // pass a project dir; any existing directory works for the fake sidecar.
      await createFreshclaudePane(page, harness, os.tmpdir())
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          return c?.sessionId && c?.createRequestId ? true : null
        }, { timeout: 30_000 })
        .not.toBeNull()
      // Wait for the DURABLE identity (sdk.session.init merge writes the
      // canonical UUID to sessionRef.sessionId + resumeSessionId,
      // FreshAgentView.tsx mergePaneContent) -- the post-restart attach must
      // deterministically carry it so the server's restart-parity resume arm
      // (claude.rs handle_attach decision table) can engage.
      // The fake sidecar mints a RANDOM canonical UUID per process (council
      // follow-up: the old static default was collision-blind), so gate on
      // the canonical-UUID SHAPE and capture what this run minted below.
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          return c?.sessionRef?.sessionId ?? c?.resumeSessionId ?? ''
        }, { timeout: 30_000 })
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      const contentBefore = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))!.content!
      const originalDurable = (contentBefore.sessionRef?.sessionId ?? contentBefore.resumeSessionId) as string
      // COMBINED-TREE CONTRACT (F8 rebind x freshclaude restart parity): with
      // the restart-parity attach arm merged, a post-restart attach carrying
      // the durable UUID is resumed IN PLACE (sidecar respawn with
      // resumeSessionId) -- the server no longer round-trips
      // freshAgent.error{INVALID_SESSION_ID}, so the client's .lost re-create
      // must NOT fire and createRequestId must stay STABLE. (On the A4 lane
      // alone -- pre-parity fallback #529 -- recovery was proven by a CHANGED
      // createRequestId; that discriminator is obsolete in the merged tree.)
      const createRequestIdBefore = contentBefore.createRequestId as string

      // Hide it behind a new shell tab.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(freshTabId)

      await server.restartAbrupt()
      await waitForWsReady(page)

      // TARGET CONTRACT (F8): WITHOUT reveal, the hidden fresh-agent pane's
      // session recovers to a usable state. DISCRIMINATING evidence -- stale
      // pre-restart Redux state also shows `sessionId` + 'idle', so client
      // state alone proves nothing. The discriminator is SERVER-SIDE: the
      // sidecar request log must contain a `create` carrying
      // `resumeSessionId === originalDurable`, which only the restart-parity
      // resume arm emits, and it only runs when THIS hidden pane's
      // post-restart freshAgent.attach actually went out (the rebind queue
      // under test driving the attach arm). The initial pane create carries
      // NO resumeSessionId, so a matching entry is unambiguous post-restart
      // evidence. Do not weaken either conjunct.
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          const status = c?.status ?? ''
          const usable = c?.sessionId && ['connected', 'idle', 'running'].includes(status)
          const log = await fs.readFile(requestLog, 'utf-8').catch(() => '')
          // The parity arm resumes by durable UUID when the session's original
          // cwd survives, or by the transcript's `.jsonl` PATH when it does
          // not (claude.rs decision table, ledger A15). Both carry the durable
          // UUID; accept either shape.
          const resumed = log
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
            .some(
              (e) =>
                e.msg?.type === 'create' &&
                typeof e.msg?.resumeSessionId === 'string' &&
                (e.msg.resumeSessionId === originalDurable ||
                  e.msg.resumeSessionId.endsWith(`/${originalDurable}.jsonl`)),
            )
          return usable && resumed ? `resumed:${status}` : null
        }, { timeout: 30_000 })
        .not.toBeNull()

      // In-place resume means the client's .lost re-create fallback must NOT
      // have fired: createRequestId stays stable (no duplicate-create storm).
      const contentAfter = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))!.content!
      expect(contentAfter.createRequestId).toBe(createRequestIdBefore)

      // Reveal: transcript surface hydrates and the composer is usable.
      await revealTab(page, harness, freshTabId)
      await expect
        .poll(async () => {
          const leaf = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))
          return ['connected', 'idle', 'running'].includes(leaf?.content?.status ?? '')
        }, { timeout: 15_000 })
        .toBe(true)
    } finally {
      await server.stop()
    }
  })

})
