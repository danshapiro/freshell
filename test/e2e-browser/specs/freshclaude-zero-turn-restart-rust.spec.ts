/**
 * FRESHCLAUDE ZERO-TURN RESTART (kata 09v1 regression) -- a VISIBLE
 * freshclaude pane with ZERO turns sent must survive an abrupt server
 * restart (RustServer.restartAbrupt(): SIGKILL + revive on the same
 * home/port/token) and resume in place -- never be adjudicated dead.
 *
 * Why this spec exists: the fake sidecar creates the transcript file AT
 * SESSION CREATE, before any turn -- a 0-byte .jsonl. (Validated: the REAL
 * CLI materializes the transcript only at first turn; the fixture's shape
 * stands in for any on-disk-but-R10b-excluded transcript, e.g. crash-window
 * partial writes.) That file fails the session index's R10b cwd gate, so pre-fix the
 * reconcile existence probe answered Absent while the attach arm's raw-file
 * check would happily resume it => DeadSession{session_not_on_disk} and the
 * 'Dead sessions' dialog. Every OTHER freshclaude-restart spec sends a turn
 * before restarting (which writes a cwd-bearing line and masks the bug);
 * hidden-pane-rebind-rust.spec.ts covers the HIDDEN zero-turn pane; this
 * spec covers the VISIBLE one. DO NOT add a turn before the restart --
 * zero-turn is the entire point.
 *
 * Rust-only: registered in RUST_ONLY_SPECS + Rust browser lane testMatch,
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

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

test.describe('freshclaude zero-turn restart (kata 09v1)', () => {
  test.setTimeout(180_000)

  test('visible zero-turn freshclaude pane resumes after abrupt restart', async ({ page }) => {
    // Sidecar REQUEST log: the post-restart resume proof reads it.
    const requestLog = path.join(os.tmpdir(), `freshell-e2e-claude-sidecar-${Date.now()}.jsonl`)
    const { server, harness } = await bootWall(page, {
      env: { FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE, FAKE_CLAUDE_SIDECAR_LOG: requestLog },
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
      // Wait for the DURABLE identity (sdk.session.init merge writes the
      // canonical UUID to sessionRef.sessionId + resumeSessionId). The fake
      // sidecar mints a RANDOM canonical UUID per process, so gate on the
      // canonical-UUID SHAPE and capture what this run minted.
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          return c?.sessionRef?.sessionId ?? c?.resumeSessionId ?? ''
        }, { timeout: 30_000 })
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      const contentBefore = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))!.content!
      const originalDurable = (contentBefore.sessionRef?.sessionId ?? contentBefore.resumeSessionId) as string
      const createRequestIdBefore = contentBefore.createRequestId as string

      // ZERO TURNS, pane stays VISIBLE (no extra tab, no hide): the
      // transcript on disk is the sidecar's create-time 0-byte file --
      // exactly the R10b-excluded shape this regression pins.

      await server.restartAbrupt()
      await waitForWsReady(page)

      // Positive proof (same discriminator as the hidden-pane spec): the
      // sidecar request log must contain a `create` carrying
      // resumeSessionId === originalDurable -- only the restart-parity
      // resume arm emits that, and the initial create carries NO
      // resumeSessionId, so a match is unambiguous post-restart evidence.
      // The parity arm resumes by durable UUID or by the transcript's
      // .jsonl PATH; both carry the durable UUID -- accept either shape.
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          const status = c?.status ?? ''
          const usable = c?.sessionId && ['connected', 'idle', 'running'].includes(status)
          const log = await fs.readFile(requestLog, 'utf-8').catch(() => '')
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

      // Negative proof (the pre-fix failure shape must be gone): the
      // zero-turn session must NOT be adjudicated dead.
      await expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
      const state = await harness.getState()
      const deadEntries = state?.panes?.deadSessionAdjudication ?? []
      expect(
        deadEntries.some((e: any) => e?.sessionRef?.sessionId === originalDurable),
        'zero-turn session must not appear in dead-session adjudication',
      ).toBe(false)
      const contentAfter = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))!.content!
      expect(contentAfter.restoreError?.reason ?? null).not.toBe('durable_artifact_missing')
      // In-place resume: the client's .lost re-create fallback must NOT have
      // fired -- createRequestId stays stable (no duplicate-create storm).
      expect(contentAfter.createRequestId).toBe(createRequestIdBefore)
    } finally {
      await server.stop()
    }
  })
})
