/**
 * FRESHCLAUDE ZERO-TURN RESTART (kata 09v1 regression) -- a VISIBLE
 * freshclaude pane with ZERO turns sent must survive an abrupt server
 * restart (RustServer.restartAbrupt(): SIGKILL + revive on the same
 * home/port/token) and resume in place -- never be adjudicated dead.
 *
 * Why this spec exists: the real CLI does not materialize a transcript until
 * the first turn. A create-time durable identity with no transcript must
 * still survive restart without a false dead-session adjudication. Every
 * OTHER freshclaude-restart spec sends a turn before restarting (which writes
 * a cwd-bearing line and masks the no-transcript case);
 * hidden-pane-rebind-rust.spec.ts covers the HIDDEN zero-turn pane; this
 * spec covers the VISIBLE one. DO NOT add a turn before the restart --
 * zero-turn is the entire point.
 *
 * because restartAbrupt() exists only on RustServer.
 *
 * Helpers are COPIED from hidden-pane-rebind-rust.spec.ts, not imported,
 * per this suite's per-spec-ownership convention.
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
import { claudeSimulatorServerEnv, onPrompt, readClaudeSimLedger } from '../helpers/claude-sim-lane.js'

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

// --- freshclaude fresh-agent helper (production sidecar + CLI simulator) ---

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

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

test.describe('freshclaude zero-turn restart (kata 09v1)', () => {
  test.setTimeout(180_000)

  test('visible zero-turn freshclaude pane resumes after abrupt restart', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-zero-turn-'))
    const simLedger = path.join(sharedRoot, 'claude-sim-ledger.jsonl')
    const { server, harness } = await bootWall(page, {
      env: claudeSimulatorServerEnv({
        ledgerPath: simLedger,
        program: {
          rules: [onPrompt('zero-turn post-restart send', [{ kind: 'text', data: { text: 'ZERO_TURN_REPLY' } }])],
        },
      }),
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker (donor guard, hidden-pane-rebind spec).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const freshTabId = (await harness.getActiveTabId())!
      await createFreshclaudePane(page, harness, os.tmpdir())
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          return c?.sessionId && c?.createRequestId ? true : null
        }, { timeout: 30_000 })
        .not.toBeNull()
      // Rust assigns the durable UUID as part of create, before any turn.
      // Capture that acknowledgement identity rather than depending on an
      // SDK init event that only arrives after a prompt.
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          return c?.sessionRef?.sessionId ?? c?.resumeSessionId ?? ''
        }, { timeout: 30_000 })
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      const contentBefore = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))!.content!
      const originalDurable = (contentBefore.sessionRef?.sessionId ?? contentBefore.resumeSessionId) as string
      const createRequestIdBefore = contentBefore.createRequestId as string
      const createdFrame = (await harness.getReceivedWsMessages() as any[]).find(
        (message) => message?.type === 'freshAgent.created' && message.requestId === createRequestIdBefore,
      )
      expect(createdFrame?.sessionRef, 'the create acknowledgement assigns the durable identity before any turn')
        .toEqual({ provider: 'claude', sessionId: originalDurable })
      await expect.poll(async () => {
        const owners = Object.values((await harness.getState())?.freshAgent?.runtimeOwners ?? {}) as any[]
        return owners.find((owner) => owner.provider === 'claude' && owner.sessionId === originalDurable)?.ownerKind ?? null
      }, { message: 'the create-time durable identity has a live fresh-agent owner' }).toBe('fresh-agent')

      // ZERO TURNS, pane stays VISIBLE (no extra tab, no hide): the
      // transcript on disk is the sidecar's create-time 0-byte file --
      // exactly the R10b-excluded shape this regression pins.

      await harness.clearSentWsMessages()
      await server.restartAbrupt()
      await waitForWsReady(page)

      // A new query is not required when the original live writer survives
      // the server restart. Prove the post-restart attach carries the
      // create-time durable reference and the ready handshake reports its
      // live owner; both are server-originated lifecycle evidence.
      await expect
        .poll(async () => {
          const sent = await harness.getSentWsMessages() as any[]
          return sent.find((message) => message?.type === 'freshAgent.attach'
            && message?.sessionRef?.provider === 'claude'
            && message?.sessionRef?.sessionId === originalDurable) ?? null
        }, { timeout: 30_000 })
        .toMatchObject({ type: 'freshAgent.attach', sessionRef: { provider: 'claude', sessionId: originalDurable } })
      await expect.poll(async () => {
        const owners = Object.values((await harness.getState())?.freshAgent?.runtimeOwners ?? {}) as any[]
        return owners.find((owner) => owner.provider === 'claude' && owner.sessionId === originalDurable)?.ownerKind ?? null
      }, { timeout: 30_000, message: 'the restarted connection observes the fresh-agent owner' }).toBe('fresh-agent')

      // Negative proof (the pre-fix failure shape must be gone): the
      // zero-turn session must NOT be adjudicated dead.
      await expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
      const state = await harness.getState()
      const deadEntries = state?.panes?.deadSessionAdjudication ?? []
      expect(
        deadEntries.some((e: any) => e?.sessionRef?.sessionId === originalDurable),
        'zero-turn session must not appear in dead-session adjudication',
      ).toBe(false)
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
      await composer.fill('zero-turn post-restart send')
      await paneRoot.getByRole('button', { name: 'Send' }).click()
      await expect(paneRoot.getByText('ZERO_TURN_REPLY', { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => readClaudeSimLedger(simLedger).some(
        (row) => row.kind === 'prompt' && row.text === 'zero-turn post-restart send' && row.sessionId === originalDurable,
      ), { timeout: 15_000, message: 'the resumed zero-turn conversation receives the next send under its original UUID' })
        .toBe(true)
      const contentAfter = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))!.content!
      expect(contentAfter.restoreError?.reason ?? null).not.toBe('durable_artifact_missing')
      // In-place resume: the client's .lost re-create fallback must NOT have
      // fired -- createRequestId stays stable (no duplicate-create storm).
      expect(contentAfter.createRequestId).toBe(createRequestIdBefore)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
