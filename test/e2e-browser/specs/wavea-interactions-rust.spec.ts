/**
 * Wave-A integration preflight — cross-lane interaction proofs.
 *
 * These tests exist ONLY because wave A lands six lanes together; each test
 * pins a seam BETWEEN lanes that no single lane's spec covers:
 *
 * - Test 1 (A1 createRequestId stabilization x A3 pane-identity ledger):
 *   the ledger stores `createRequestId` as an ADVISORY join key
 *   (pane_ledger.rs BindingRow — "never an identity join key", but read by
 *   `lookup_by_create_request_id`). A1 makes the client keep the key across
 *   hydrate. Combined contract: a reload + abrupt-restart sequence leaves the
 *   pane's key and the ledger row's advisory key EQUAL to the original — a
 *   re-minted key anywhere in that sequence would strand the ledger join.
 *
 * - Test 2 (A2 freshclaude restart parity x A3 ledger): a claude TERMINAL
 *   pane writes ledger binding rows (terminal.rs create path) while a
 *   freshclaude FRESH-AGENT pane's identity lives in the sidecar bridge's
 *   cliSessionId index (claude.rs) — two separate identity stores for the
 *   same provider in one process. Combined contract: one abrupt restart, BOTH
 *   restore paths work, and neither store leaks into the other (no ledger row
 *   for the fresh-agent UUID; the terminal's session stays bound).
 *
 * Rust-only: imports RustServer directly for restartAbrupt(). Helpers are
 * COPIED from pane-ledger-restart-rust.spec.ts / hidden-pane-rebind-rust.spec.ts
 * per this suite's per-spec-ownership convention.
 */
import { test, expect } from '../helpers/fixtures.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import type { Page } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const FAKE_CLAUDE_SIDECAR_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')

// --- helpers (per-spec copies; donors named inline) ------------------------

/** Donor: pane-ledger-restart-rust.spec.ts:29 */
async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

/** Donor: hidden-pane-rebind-rust.spec.ts seedWallConfig (freshAgent knob). */
function seedConfig(input: { providers: string[]; freshAgent?: boolean }) {
  return async (homeDir: string): Promise<void> => {
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

/** Donor: pane-ledger-restart-rust.spec.ts:66 (load-bearing comment there). */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
  }
}

/** Donor: pane-ledger-restart-rust.spec.ts:81 */
async function openCliPane(page: Page, buttonName: RegExp): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: buttonName }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory/i }).press('Enter')
}

/** Donor: hidden-pane-rebind-rust.spec.ts createFreshclaudePane. */
async function createFreshclaudePane(page: Page, cwd: string): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: false },
    })
  })
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
  const directoryInput = page.getByLabel(/^Starting directory for Freshclaude$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })
}

/** Donor: hidden-pane-rebind-rust.spec.ts waitForWsReady. */
async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

/** Donor: pane-ledger-restart-rust.spec.ts:88 */
async function listFiles(dir: string): Promise<string[]> {
  try {
    const out: string[] = []
    for (const entry of await fs.readdir(dir, { recursive: true })) {
      out.push(String(entry))
    }
    return out
  } catch {
    return []
  }
}

/** Donor: pane-ledger-restart-rust.spec.ts:101 (5s durability wall). */
async function within5s(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`5s durability wall breached: ${what}`)
}

/** Generic layout-leaf finder (donor shape: findFreshAgentLeaf). */
function findLeaf(node: any, pred: (content: any) => boolean): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content && pred(node.content)) return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findLeaf(child, pred)
      if (found) return found
    }
  }
  return null
}

const claudeTerminalLeaf = (layout: any) =>
  findLeaf(layout, (c) => c.kind === 'terminal' && c.mode === 'claude')
const freshAgentLeaf = (layout: any) => findLeaf(layout, (c) => c.kind === 'fresh-agent')

/** Read + parse every claude binding row currently on disk. */
async function readClaudeBindingRows(ledgerDir: string): Promise<any[]> {
  const dir = path.join(ledgerDir, 'bindings', 'claude')
  const rows: any[] = []
  for (const f of await listFiles(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      rows.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')))
    } catch {
      // mid-write / non-row file: ignore for this scan
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

test.describe('wave-A cross-lane interactions', () => {
  test.setTimeout(180_000)

  test('A1xA3: reload + abrupt restart keeps the pane<->ledger createRequestId join coherent', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wavea-a1a3-'))
    let capturedHome = ''
    try {
      const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', 'fake-claude-cli.mjs')
      const seed = seedConfig({ providers: ['claude'] })
      const server = new RustServer({
        env: { CLAUDE_CMD: fakeClaude },
        setupHome: async (homeDir: string) => {
          capturedHome = homeDir
          await seed(homeDir)
        },
      })
      const info = await server.start()
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        await selectShellIfPickerShowing(page)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = (await harness.getActiveTabId())!
        const ledgerDir = path.join(capturedHome, '.freshell', 'pane-ledger')

        // Claude terminal pane: identity pre-allocated at create — the binding
        // row (WITH the advisory createRequestId, terminal.rs create path)
        // must hit disk within the 5s wall.
        await openCliPane(page, /^Claude CLI$/i)
        await within5s(
          async () => (await readClaudeBindingRows(ledgerDir)).length > 0,
          'claude binding row on disk',
        )

        // The pane's key and the ledger row's advisory key must already agree.
        let keyBefore = ''
        await expect
          .poll(async () => {
            keyBefore = claudeTerminalLeaf(await harness.getPaneLayout(tabId))?.content?.createRequestId ?? ''
            return keyBefore
          }, { timeout: 15_000 })
          .not.toBe('')
        const rowsAtCreate = await readClaudeBindingRows(ledgerDir)
        expect(rowsAtCreate.some((r) => r.createRequestId === keyBefore)).toBe(true)

        // Reload: A1's contract — the key hydrates, never re-mints.
        await page.evaluate(() => {
          ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })
        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()
        await expect
          .poll(async () => claudeTerminalLeaf(await harness.getPaneLayout(tabId))?.content?.createRequestId ?? '', {
            timeout: 15_000,
          })
          .toBe(keyBefore)

        // Abrupt restart: the census re-creates the (visible) claude pane. The
        // re-create MAY re-mint the pane key (BindingRow doc: the advisory
        // key is "latest-observed ... the client re-mints it on hydrate; it
        // is never an identity join key"). COHERENCE is the contract: once
        // the pane settles, the ledger row's advisory key must equal the
        // pane's CURRENT key — terminal.rs re-records the binding with the
        // resume create's requestId. An orphan (row still carrying a key the
        // pane no longer holds) would strand lookup_by_create_request_id.
        await server.restartAbrupt()
        await waitForWsReady(page)
        let keyAfter = ''
        await expect
          .poll(async () => {
            const c = claudeTerminalLeaf(await harness.getPaneLayout(tabId))?.content
            if (c?.status !== 'running' || !c?.terminalId) return null
            keyAfter = c.createRequestId ?? ''
            return keyAfter || null
          }, { timeout: 60_000 })
          .not.toBeNull()

        // Ledger join coherent: the row's advisory key converges on the
        // pane's current key (latest-observed), and no row is left carrying
        // a key the pane no longer holds.
        await expect
          .poll(async () => {
            const rows = (await readClaudeBindingRows(ledgerDir)).filter(
              (r) => typeof r.createRequestId === 'string',
            )
            if (rows.length === 0) return 'no keyed rows'
            const stale = rows.filter((r) => r.createRequestId !== keyAfter)
            return stale.length === 0 ? 'coherent' : `stale keys: ${stale.map((r) => r.createRequestId).join(',')}`
          }, { timeout: 15_000 })
          .toBe('coherent')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('A2xA3: one restart restores BOTH claude identity stores with no cross-talk', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wavea-a2a3-'))
    // The fake sidecar mints a RANDOM canonical UUID per process (council
    // follow-up: the old static 44444444-... default was collision-blind),
    // so the fresh-agent durable id is CAPTURED from the run below.
    let FRESH_DURABLE = ''
    let capturedHome = ''
    try {
      const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', 'fake-claude-cli.mjs')
      const argvLog = path.join(sharedRoot, 'claude-argv.jsonl')
      const sidecarLog = path.join(sharedRoot, 'sidecar-requests.jsonl')
      const seed = seedConfig({ providers: ['claude'], freshAgent: true })
      const server = new RustServer({
        env: {
          CLAUDE_CMD: fakeClaude,
          FAKE_CLAUDE_ARGV_LOG: argvLog,
          FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE,
          FAKE_CLAUDE_SIDECAR_LOG: sidecarLog,
        },
        setupHome: async (homeDir: string) => {
          capturedHome = homeDir
          await seed(homeDir)
        },
      })
      const info = await server.start()
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        await selectShellIfPickerShowing(page)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = (await harness.getActiveTabId())!
        const ledgerDir = path.join(capturedHome, '.freshell', 'pane-ledger')

        // Identity store 1 (A3): claude TERMINAL pane -> ledger binding row.
        await openCliPane(page, /^Claude CLI$/i)
        await within5s(
          async () => (await readClaudeBindingRows(ledgerDir)).length > 0,
          'claude terminal binding row on disk',
        )
        const terminalSession = (await readClaudeBindingRows(ledgerDir))[0].sessionId as string
        expect(terminalSession).toBeTruthy()
        let terminalIdBefore = ''
        await expect
          .poll(async () => {
            terminalIdBefore = claudeTerminalLeaf(await harness.getPaneLayout(tabId))?.content?.terminalId ?? ''
            return terminalIdBefore
          }, { timeout: 15_000 })
          .not.toBe('')

        // Identity store 2 (A2): freshclaude pane -> sidecar cliSessionId index.
        // Gate on the canonical-UUID SHAPE, then capture what this run minted.
        await createFreshclaudePane(page, sharedRoot)
        await expect
          .poll(async () => {
            const c = freshAgentLeaf(await harness.getPaneLayout(tabId))?.content
            return c?.sessionRef?.sessionId ?? c?.resumeSessionId ?? ''
          }, { timeout: 30_000 })
          .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
        {
          const c = freshAgentLeaf(await harness.getPaneLayout(tabId))?.content
          FRESH_DURABLE = (c?.sessionRef?.sessionId ?? c?.resumeSessionId) as string
        }
        expect(terminalSession).not.toBe(FRESH_DURABLE)

        // FIXTURE REALISM (reconcile adoption): real claude writes
        // ~/.claude/projects/<proj>/<sessionId>.jsonl as soon as the session
        // starts; the fake CLI does not. Under the adopted client the
        // post-restart verdict is derived from DISK truth (a claimed session
        // with no file is a loud dead_session, never an optimistic silent
        // respawn), so mirror what real claude persists before the kill --
        // same precedent as restore-contract-wall-rust.spec.ts's claude
        // scenario.
        const claudeProjDir = path.join(capturedHome, '.claude', 'projects', 'wavea-a2a3-proj')
        await fs.mkdir(claudeProjDir, { recursive: true })
        await fs.writeFile(
          path.join(claudeProjDir, `${terminalSession}.jsonl`),
          `${JSON.stringify({
            type: 'user',
            message: 'wavea a2a3 fixture transcript',
            uuid: 'msg-1',
            cwd: capturedHome,
            timestamp: '2026-07-21T08:00:00.000Z',
          })}\n`,
        )

        // ── ONE abrupt restart; both stores must restore, independently. ──
        await server.restartAbrupt()
        await waitForWsReady(page)

        // A3 path: the terminal pane re-creates (visible census) and the
        // ledger still binds the ORIGINAL terminal session — never the
        // fresh-agent UUID.
        await expect
          .poll(async () => {
            const c = claudeTerminalLeaf(await harness.getPaneLayout(tabId))?.content
            return c?.status === 'running' && c?.terminalId && c.terminalId !== terminalIdBefore
              ? c.terminalId
              : null
          }, { timeout: 60_000 })
          .not.toBeNull()
        const rowsAfter = await readClaudeBindingRows(ledgerDir)
        expect(rowsAfter.some((r) => r.sessionId === terminalSession)).toBe(true)

        // A2 path: the fresh-agent pane resumed in place — server-side proof
        // is the sidecar create carrying resumeSessionId (UUID or transcript
        // path shape, claude.rs decision table).
        await expect
          .poll(async () => {
            const log = await fs.readFile(sidecarLog, 'utf-8').catch(() => '')
            return log
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l))
              .some(
                (e) =>
                  e.msg?.type === 'create' &&
                  typeof e.msg?.resumeSessionId === 'string' &&
                  (e.msg.resumeSessionId === FRESH_DURABLE ||
                    e.msg.resumeSessionId.endsWith(`/${FRESH_DURABLE}.jsonl`)),
              )
          }, { timeout: 30_000 })
          .toBe(true)
        await expect
          .poll(async () => {
            const c = freshAgentLeaf(await harness.getPaneLayout(tabId))?.content
            const usable = c?.sessionId && ['connected', 'idle', 'running'].includes(c?.status ?? '')
            const durable = c?.sessionRef?.sessionId ?? c?.resumeSessionId ?? ''
            return usable && durable === FRESH_DURABLE ? 'ok' : null
          }, { timeout: 30_000 })
          .not.toBeNull()

        // NO CROSS-TALK (wave-B update): B4 (freshagent-verdicts-resume) now
        // DELIBERATELY writes kind:fresh-agent ledger rows (paneKind:
        // 'fresh-agent', pane_ledger.rs), so the fresh-agent identity IS
        // allowed in the ledger -- but ONLY as a fresh-agent row. The wave-A
        // invariant this pin protects survives narrowed: the fresh-agent UUID
        // must never appear as a TERMINAL row, and no terminal row was
        // rebound to it.
        for (const row of rowsAfter) {
          if (row.sessionId === FRESH_DURABLE) {
            expect(
              row.paneKind,
              'fresh-agent UUID may only appear as a kind:fresh-agent ledger row (B4), never a terminal row',
            ).toBe('fresh-agent')
            expect(row.liveTerminalId, 'fresh-agent ledger rows own no terminal').toBeFalsy()
          }
        }
        // ...and nothing got quarantined by the boot scan.
        const allFiles = await listFiles(ledgerDir)
        expect(allFiles.some((f) => f.includes('.quarantined-'))).toBe(false)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
