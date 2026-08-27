// FRESHCLAUDE RESTART PARITY -- restart-resilience plan §2.8 items 2-4 (Lane A2).
// Proves the server-side resume path end to end against the extended fake sidecar:
//   1. restartAbrupt -> WS auto-reconnect -> client re-attaches -> server resumes
//      IN PLACE: no INVALID_SESSION_ID lost frame, no client-driven re-create.
//   2. History rehydrates via GET /api/fresh-agent/threads/... (transcript adapter).
//   3. The next send continues the SAME conversation (fixture request log shows
//      create carried resumeSessionId === the original durable UUID).
//   4. A pane BUSY at restart un-wedges (idle status snapshot from the attach arm).
// Rust-only: registered in RUST_ONLY_SPECS + Rust browser lane testMatch (restartAbrupt
// exists only on RustServer). NOTE: no page.reload() in test 1/2 -- the reload leg
// is the contract wall's freshclaude test; this spec owns the reconnect leg.
//
// Helpers are copied, not imported, from restore-contract-wall-rust.spec.ts per
// that suite's per-spec-ownership convention (donor line refs on each helper).
// The only mechanical adaptation: the donor imports 'node:fs/promises' as `fs`;
// this spec needs sync fs for the fixture request log, so promises live on `fsp`
// and the copied helper bodies use `fsp.` where the donor wrote `fs.`.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import type { Page } from '@playwright/test'

// ESM project ("type": "module" in package.json): __dirname does not exist in
// ESM modules -- derive it, same shim as the donor spec
// (restore-contract-wall-rust.spec.ts:36-40).
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FIXTURE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')

// ---------------------------------------------------------------------------
// Copied helpers (donor: restore-contract-wall-rust.spec.ts)
// ---------------------------------------------------------------------------

/** Dismiss the initial pane-type picker by choosing the first visible shell.
 * (donor :95-105) */
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

/** Poll the in-page harness until the WS transport reports 'ready'.
 * (donor :108-115) */
async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

/** Force the persistence middleware to write localStorage NOW (pre-reload).
 * (donor :118-122) */
async function flushPersistence(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
}

/** Idempotent .freshell/config.json seed (setupHome re-runs on every boot).
 * (donor :131-153) */
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

/** Boot an owned RustServer, navigate, and wait for harness + WS.
 * (donor :156-170) */
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

// --- layout tree walkers (donor :222-243) ---

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
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

// Durable identity for a LIVE (no-reload) claude pane. The sdk.session.init
// merge writes the durable UUID to sessionRef.sessionId + resumeSessionId
// (FreshAgentView.tsx mergePaneContent, ~:1497-1503); content.sessionId stays
// the create-time nanoid. sessionRef.sessionId also survives persistence
// (persistMiddleware strips sessionId AND resumeSessionId), so this expression
// is reload-symmetric too. Deliberately NOT the donor's leafDurableIdentity
// (:245-251): its first fallback arm is content.sessionId, which for a live
// claude pane is the create-time fc-e2e-* nanoid forever.
const liveDurableIdentity = (leaf: any): string =>
  leaf?.content?.sessionRef?.sessionId ?? leaf?.content?.resumeSessionId ?? ''

/** Send one chat turn in the last fresh-agent pane and wait for idle.
 * (donor :371-391) */
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
  await expect
    .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
      timeout: 30_000,
    })
    .toBe('idle')
}

// --- freshclaude fresh-agent helper (fixture: fake-claude-sidecar.mjs via the
// production env seam FRESHELL_CLAUDE_SIDECAR) (donor :436-467) ---

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
  // NOTE: the pane may surface a transient history banner while snapshots
  // settle. Assert pane state via the harness (Redux), tolerate the banner --
  // never assert error-free UI chrome for freshclaude (donor convention).
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('freshclaude restart parity (rust)', () => {
  test('SIGKILL restart: attach resumes in place, history rehydrates, send continues the same conversation', async ({ page }) => {
    test.setTimeout(120_000) // restart + resume + snapshot legs are slow
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshclaude-parity-'))
    const requestLog = path.join(sharedRoot, 'sidecar-requests.jsonl')
    const { server, harness } = await bootWall(page, {
      env: {
        FRESHELL_CLAUDE_SIDECAR: FIXTURE,
        FAKE_CLAUDE_SIDECAR_LOG: requestLog,
      },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      // Donor convention (:1149): tabId from the harness AFTER the picker settles.
      // No page.reload() anywhere in this test, so one read suffices.
      const tabId = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker, else openPanePicker races the boot picker's fade-out and
      // the Freshclaude click is swallowed (donor test body :1150-1155).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const projectDir = path.join(sharedRoot, 'proj')
      await fsp.mkdir(projectDir, { recursive: true })
      await createFreshclaudePane(page, harness, projectDir)
      const prompt = `parity first turn ${Math.random().toString(36).slice(2, 10)}`
      await sendFreshAgentTurn(page, harness, tabId, prompt)
      await expect(page.locator('[data-context="fresh-agent"]').last()).toContainText('Fixture claude turn')

      // Durable identity = the fixture's canonical UUID (via liveDurableIdentity;
      // content.sessionId stays the create-time nanoid on a live claude pane).
      // The fake sidecar mints a RANDOM canonical UUID per process (council
      // follow-up: the old static default was collision-blind), so gate on
      // the canonical-UUID SHAPE (which the fc-e2e-* nanoid never matches)
      // and CAPTURE what this run minted.
      let originalDurable = ''
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabId)
          originalDurable = liveDurableIdentity(findFreshAgentLeaf(layout))
          return originalDurable
        })
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

      await flushPersistence(page)
      await harness.clearSentWsMessages()

      // ── SIGKILL + reboot on same home/port/token; NO page reload -- the client's
      // in-memory session (nanoid + resumeSessionId) drives ws.onReconnect attach.
      await server.restartAbrupt()
      await waitForWsReady(page)

      // Rebind proof: an attach carrying the durable UUID went out...
      await expect
        .poll(async () => {
          const sent = await harness.getSentWsMessages()
          return sent.some(
            (m: any) =>
              m.type === 'freshAgent.attach' &&
              m.provider === 'claude' &&
              (m.resumeSessionId === originalDurable || m.sessionRef?.sessionId === originalDurable),
          )
        })
        .toBe(true)

      // ...and the pane settled WITHOUT the lost path: status back to idle...
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabId)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 30_000 })
        .toBe('idle')

      // ...with NO identity-LOSING client re-create. HISTORY (2026-07-26,
      // reconcile-completion): this originally asserted ZERO freshAgent.create
      // frames, pinning the attach-only mechanism. With fresh-agent reconcile
      // verdicts live (paneReconcileFreshAgentV1), a SIGKILL'd session folds a
      // RESPAWN verdict, which re-drives ONE create carrying the durable
      // resumeSessionId + sessionRef (the D8 lease serializes it against the
      // reconnect attach -- one sidecar either way). The invariant this
      // assertion guards is unchanged: never the lost->triggerRecovery
      // fallback's identity-less re-mint.
      const sentAfterRestart = await harness.getSentWsMessages()
      const createsAfterRestart = sentAfterRestart.filter((m: any) => m.type === 'freshAgent.create')
      for (const create of createsAfterRestart as any[]) {
        expect(
          create.resumeSessionId ?? create.sessionRef?.sessionId,
          `post-restart create must carry the durable identity: ${JSON.stringify(create)}`,
        ).toBe(originalDurable)
      }

      // Server-side resume proof: the post-restart sidecar create carried
      // options.resume = the original durable UUID (spec item 2 verification).
      const resumedCreates = fs
        .readFileSync(requestLog, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.msg?.type === 'create' && e.msg?.resumeSessionId === originalDurable)
      expect(resumedCreates.length).toBeGreaterThanOrEqual(1)

      // History rehydrated (snapshot adapter): the PRE-restart prompt is back in
      // the pane after the snapshot fetch folds durable turns in.
      await expect(page.locator('[data-context="fresh-agent"]').last()).toContainText(prompt, {
        timeout: 30_000,
      })

      // Same conversation continues: next send round-trips on the resumed session.
      const secondPrompt = `parity second turn ${Math.random().toString(36).slice(2, 10)}`
      await sendFreshAgentTurn(page, harness, tabId, secondPrompt)
      await expect(page.locator('[data-context="fresh-agent"]').last()).toContainText('Fixture claude turn')
      const layout = await harness.getPaneLayout(tabId)
      expect(liveDurableIdentity(findFreshAgentLeaf(layout))).toBe(originalDurable)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('a pane BUSY at restart un-wedges and the next send works', async ({ page }) => {
    test.setTimeout(120_000) // restart + resume legs are slow
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshclaude-busy-'))
    const requestLog = path.join(sharedRoot, 'sidecar-requests.jsonl')
    const holdMarker = path.join(sharedRoot, 'hold-once.marker')
    const { server, harness } = await bootWall(page, {
      env: {
        FRESHELL_CLAUDE_SIDECAR: FIXTURE,
        FAKE_CLAUDE_SIDECAR_LOG: requestLog,
        FAKE_CLAUDE_SIDECAR_HOLD_TURN_ONCE_MARKER: holdMarker,
      },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Same boot-pane guard as test 1 (donor test body :1150-1155).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const projectDir = path.join(sharedRoot, 'proj')
      await fsp.mkdir(projectDir, { recursive: true })
      await createFreshclaudePane(page, harness, projectDir)

      // Capture the run's durable id (fixture id is random per process now;
      // the sdk.session.init fold lands at create, before any send).
      let busyDurable = ''
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabId)
          busyDurable = liveDurableIdentity(findFreshAgentLeaf(layout))
          return busyDurable
        })
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

      // First send wedges (fixture holds the first turn forever): status stuck busy.
      // Wait for idle BEFORE filling (donor sendFreshAgentTurn's pre-send poll,
      // :371-391) -- but do NOT wait for idle after: this turn never completes.
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabId)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 20_000 })
        .toBe('idle')
      await page.getByRole('textbox', { name: 'Chat message input' }).fill('wedge me')
      await page.getByRole('button', { name: 'Send' }).click()
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabId)
          return findFreshAgentLeaf(layout)?.content?.status
        })
        .toBe('running')

      await server.restartAbrupt()
      await waitForWsReady(page)

      // Un-wedge proof: the attach arm's idle snapshot clears the stuck state.
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabId)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 30_000 })
        .toBe('idle')

      // And the conversation is live again on the SAME durable session.
      await sendFreshAgentTurn(page, harness, tabId, `post-wedge turn ${Date.now()}`)
      await expect(page.locator('[data-context="fresh-agent"]').last()).toContainText('Fixture claude turn')
      const resumed = fs
        .readFileSync(requestLog, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .some((e) => e.msg?.type === 'create' && e.msg?.resumeSessionId === busyDurable)
      expect(resumed).toBe(true)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
