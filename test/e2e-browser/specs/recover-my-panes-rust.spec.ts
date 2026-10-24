/**
 * Rust browser-loss recovery for server-managed machines.
 *
 * Scenarios 1–4 cover the user-facing contract: a registered machine
 * bootstraps its own workspace after a browser loss (recreating dead sessions
 * or reattaching live terminals), a separately registered machine starts with
 * only its own default picker leaf, and the retired generic cross-machine
 * recovery offer never mounts. Scenario 2 also proves that the new machine
 * receives none of machine A's session, browser URL, pane IDs, or content.
 *
 * Later scenarios retain route-level `GET /api/recovery/inventory` probes for
 * ledger admission, close, and reattach behavior. They do not reinstate the
 * removed generic recovery UI.
 *
 * Fixture shapes (fake CLI, config seeding, shell-picker choreography) are
 * copied from pane-ledger-restart-rust.spec.ts. This spec owns a RustServer on
 * an ephemeral loopback port and never contacts port 3001.
 */
import {
  createE2eBrowserContext,
  createFreshE2eBrowserContext,
  test,
  expect,
} from '../helpers/fixtures.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { request, type BrowserContext, type Page } from '@playwright/test'
import { RustServer, ensureRustServerBuilt } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { claudeSimulatorServerEnv } from '../helpers/claude-sim-lane.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Donor: pane-ledger-restart-rust.spec.ts:29 */
async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

/** Donor: pane-ledger-restart-rust.spec.ts:37 */
function seedConfig() {
  return async (homeDir: string): Promise<void> => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: {
            codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
            // freshAgent.enabled gates the WS freshAgent.create dispatch
            // (scenario 5's freshclaude pane). Inert for scenarios 1-4 —
            // nothing in them issues a fresh-agent create.
            freshAgent: { enabled: true },
          },
        },
        null,
        2,
      ),
    )
  }
}

/**
 * Donor: pane-ledger-restart-rust.spec.ts:65 (load-bearing comment there):
 * a live shell terminal's cwd pre-fills the Starting-directory combobox the
 * CLI-pane creates below depend on.
 */
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

/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/**
 * Claude-adapted adjacent-pair matcher (per the task brief's Interfaces): the
 * fake claude CLI receives the `--resume <id>` FLAG (fake-claude-cli.mjs:26-30)
 * — NOT codex's bare `resume` subcommand token, so a codex-style
 * `resume <id>` adjacent-pair matcher would never match here.
 */
const hasClaudeResumePair = (argv: string[], sessionId: string) => {
  const i = argv.indexOf('--resume')
  return i !== -1 && argv[i + 1] === sessionId
}

/** `--session-id <id>` values, in order, from a slice of argv-log entries. */
function sessionIdsOf(entries: Array<{ argv: string[] }>): string[] {
  return entries.flatMap((e) => {
    const i = e.argv.indexOf('--session-id')
    return i >= 0 ? [e.argv[i + 1]] : []
  })
}

/** Boot a page against the server (donor: the retired snapshot-restore-rust spec). */
async function connect(page: Page, info: { baseUrl: string; token: string }): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

/** Triage aid: log inventory request failures/non-200s (kept quiet on success). */
function traceInventoryFailures(page: Page, label: string): void {
  page.on('response', (r) => {
    if (!r.url().includes('/api/recovery/inventory') || r.status() === 200) return
    console.log(`[${label}] inventory response ${r.status()} ${r.url()}`)
  })
  page.on('requestfailed', (req) => {
    if (!req.url().includes('/api/recovery/inventory')) return
    console.log(`[${label}] inventory request FAILED: ${req.failure()?.errorText}`)
  })
}

/** Create the browser pane the way a user would (browser-pane.spec.ts:8). */
async function createBrowserPane(page: Page, url: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Browser$/i }).click({ force: true })
  const urlInput = page.getByPlaceholder('Enter URL...')
  await expect(urlInput).toBeVisible({ timeout: 10_000 })
  await urlInput.fill(url)
  await urlInput.press('Enter')
  const iframe = page.locator('iframe[title="Browser content"]')
  await iframe.waitFor({ state: 'attached', timeout: 10_000 })
}

/** Donor: hidden-pane-rebind-rust.spec.ts:118 — layout tree walker. */
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

/** Every leaf of a pane layout tree (flat list; the scenarios' inline walkers). */
function leavesOfLayout(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  return (node.children ?? []).flatMap(leavesOfLayout)
}

/**
 * Delta-round-7 evidence shaping (scenarios 6+7, donor: the kill-window
 * scenario's step-7 idiom generalized to a NEEDLE SET): delete every retained
 * snapshot generation referencing ANY needle (the lost pane's session id,
 * createRequestId, terminalId, AND paneId — any one of them would otherwise
 * let a retained generation reference the pane's row, so the row would reach
 * the offer through the union path instead of the ledgerOnly pipeline under
 * test; none may survive). Then require (a) at least one surviving generation
 * containing EVERY keep needle (the anti-vacuity premise — the lost pane's
 * TAB must survive in the evidence, bearing the sibling shell push), and
 * (b) every surviving client's newest generation within the judgment's grace
 * window of the row's attribution time, or the time-drop clause alone would
 * answer the exclusion and every ledgerOnly assertion is vacuous.
 */
async function shapeEvidenceExcluding(opts: {
  snapshotsRoot: string
  needles: string[]
  keepNeedles: string[]
  latestAllowedMs: number
  premiseLabel: string
}): Promise<void> {
  const { snapshotsRoot, needles, keepNeedles, latestAllowedMs, premiseLabel } = opts
  const newestByClient = new Map<string, { revision: number; capturedAt: number }>()
  let keptKeepsakeGeneration = false
  for (const deviceDirName of await fs.readdir(snapshotsRoot).catch(() => [] as string[])) {
    const deviceDir = path.join(snapshotsRoot, deviceDirName)
    for (const name of (await fs.readdir(deviceDir)).filter((n) => n.endsWith('.json'))) {
      const filePath = path.join(deviceDir, name)
      const raw = await fs.readFile(filePath, 'utf8')
      if (needles.some((n) => raw.includes(n))) {
        await fs.rm(filePath)
        continue
      }
      if (keepNeedles.every((n) => raw.includes(n))) keptKeepsakeGeneration = true
      let doc: any = null
      try {
        doc = JSON.parse(raw)
      } catch {
        continue
      }
      const client = doc?.clientInstanceId
      if (typeof client !== 'string' || !client) continue
      const revision = Number(doc?.snapshotRevision ?? 0)
      const capturedAt = Number(doc?.capturedAt ?? 0)
      const cur = newestByClient.get(client)
      if (!cur || revision > cur.revision || (revision === cur.revision && capturedAt > cur.capturedAt)) {
        newestByClient.set(client, { revision, capturedAt })
      }
    }
  }
  expect(
    keptKeepsakeGeneration,
    `evidence shaping must leave a keepsake generation behind (${premiseLabel}: the surviving tab's push)`,
  ).toBe(true)
  expect(newestByClient.size, 'the lost context pushed at least one retained generation').toBeGreaterThan(0)
  for (const [client, newest] of newestByClient) {
    expect(
      newest.capturedAt,
      `client ${client}'s newest retained generation must sit INSIDE the grace window ` +
        `(${premiseLabel}: capturedAt=${newest.capturedAt}, latest allowed=${latestAllowedMs}, ` +
        'grace=7000ms) — otherwise the time-drop clause alone answers the judgment ' +
        'and this scenario is vacuous',
    ).toBeLessThanOrEqual(latestAllowedMs)
  }
}

/**
 * Donor: hidden-pane-rebind-rust.spec.ts:153 (production Claude sidecar over
 * the committed CLI simulator).
 */
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
  // option" may not exist — TYPE the cwd and press Enter instead (donor:
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
  // banner. Assert pane state via the harness (Redux), tolerate the banner —
  // never assert error-free UI chrome for freshclaude.
}

test.describe('recover-my-panes browser-loss recovery (rust only)', () => {
  // Scenarios share ONE owned server and build on each other's durable state
  // (snapshots, ledger rows, a still-running PTY) — strict ordering required.
  test.describe.configure({ mode: 'serial' })

  let sharedRoot = ''
  let capturedHome = ''
  let argLog = ''
  let server: RustServer
  let info: E2eServerInfo

  /**
   * Wait until SOME persisted snapshot generation contains every needle.
   * Stronger than the brief's minimum (a device dir with >=1 .json): pushes
   * fire on ready + every 5s, so an early generation may predate the panes
   * under test — matching CONTENT guarantees the recoverable state actually
   * includes them before we kill the context.
   */
  async function waitForSnapshotContaining(needles: string[], timeoutMs = 30_000): Promise<void> {
    const snapshotsDir = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
      for (const device of devices) {
        const deviceDir = path.join(snapshotsDir, device)
        const files = await fs.readdir(deviceDir).catch(() => [] as string[])
        for (const f of files.filter((f) => f.endsWith('.json'))) {
          const body = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
          if (needles.every((n) => body.includes(n))) return
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`No tabs-snapshot generation contained [${needles.join(', ')}] within ${timeoutMs}ms`)
  }

  /**
   * Wait until the NEWEST persisted tabs-snapshot generation FOR THE GIVEN
   * CLIENT carries >= minRecords records — the scenario-4 size pin. Same
   * fs-poll idiom as waitForSnapshotContaining (snapshot pushes fire on ready
   * + every 5s, so the registry's JSON generation files lag the UI by
   * seconds): read every generation file, keep only the given
   * clientInstanceId's, rank newest by (snapshotRevision, capturedAt) — the
   * server's own per-client monotonic ordering (tabs_persist.rs
   * `generation_rank`) — and insist the newest generation has the full tab
   * set on disk.
   */
  async function waitForNewestGenerationRecordCount(
    clientInstanceId: string,
    minRecords: number,
    timeoutMs = 30_000,
  ): Promise<void> {
    const snapshotsDir = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    const deadline = Date.now() + timeoutMs
    let lastObserved = 0
    while (Date.now() < deadline) {
      const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
      for (const device of devices) {
        const deviceDir = path.join(snapshotsDir, device)
        const files = (await fs.readdir(deviceDir).catch(() => [] as string[]))
          .filter((f) => f.endsWith('.json'))
        let newest: { revision: number; capturedAt: number; count: number } | null = null
        for (const f of files) {
          const raw = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
          let doc: any = null
          try {
            doc = JSON.parse(raw)
          } catch {
            continue
          }
          if (doc?.clientInstanceId !== clientInstanceId) continue
          const revision = Number(doc?.snapshotRevision ?? 0)
          const capturedAt = Number(doc?.capturedAt ?? 0)
          const count = Array.isArray(doc?.records) ? doc.records.length : 0
          if (!newest || revision > newest.revision || (revision === newest.revision && capturedAt > newest.capturedAt)) {
            newest = { revision, capturedAt, count }
          }
        }
        if (newest) {
          lastObserved = Math.max(lastObserved, newest.count)
          if (newest.count >= minRecords) return
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(
      `No persisted generation for client ${clientInstanceId} reached ${minRecords} records `
      + `within ${timeoutMs}ms (last observed: ${lastObserved})`,
    )
  }

  test.beforeAll(async () => {
    test.setTimeout(600_000) // first release build of freshell-server can take minutes
    ensureRustServerBuilt()
    sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'recover-my-panes-e2e-'))
    argLog = path.join(sharedRoot, 'claude-argv.jsonl')
    const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', 'fake-claude-cli.mjs')
    const seed = seedConfig()
    server = new RustServer({
      env: {
        CLAUDE_CMD: fakeClaude,
        FAKE_CLAUDE_ARGV_LOG: argLog,
        // Scenario 5's freshclaude lane: the production sidecar and CLI
        // simulator (read only at fresh-agent spawn — inert for scenarios 1-4).
        // restart() re-merges this env on every boot.
        ...claudeSimulatorServerEnv({ ledgerPath: path.join(sharedRoot, 'claude-sim-ledger.jsonl') }),
      },
      setupHome: async (homeDir: string) => {
        capturedHome = homeDir
        await seed(homeDir)
      },
    })
    info = await server.start()
  })

  test.afterAll(async () => {
    await server?.stop().catch(() => {})
    if (sharedRoot) await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
  })

  /**
   * Service workers are blocked in every fresh context. The production client
   * reloads on `controllerchange`; blocking it removes that unrelated boot
   * race so these scenarios observe only server-managed machine bootstrap.
   */
  const FRESH_CONTEXT_OPTIONS = { serviceWorkers: 'block' as const }

  async function createFreshContext(
    browser: import('@playwright/test').Browser,
    options = FRESH_CONTEXT_OPTIONS,
  ): Promise<BrowserContext> {
    return (await createFreshE2eBrowserContext(browser, info, options)).context
  }

  /**
   * Open empty browser storage for an already registered machine. Rust owns
   * that machine's workspace, so bootstrap restores it directly and the
   * retired generic cross-machine offer must never mount.
   */
  async function openSameMachineContext(
    browser: import('@playwright/test').Browser,
    machineId: string,
    label: string,
    options = FRESH_CONTEXT_OPTIONS,
  ): Promise<{ ctx: BrowserContext; page: Page; harness: TestHarness }> {
    const ctx = await createE2eBrowserContext(browser, info, machineId, options)
    const page = await ctx.newPage()
    traceInventoryFailures(page, label)
    const harness = await connect(page, info)
    await expect(page.getByTestId('recovery-offer-panel')).toHaveCount(0)
    return { ctx, page, harness }
  }

  // Scenario 1 creates these identities; scenario 2 must prove it inherited none.
  let sessionIdA = ''
  let paneIdsA: string[] = []

  test('scenario 1: lose the browser, restart the server, same-machine bootstrap recreates panes and reload never offers recovery', async ({ browser }) => {
    test.setTimeout(240_000)

    // ---- Context A: populate a tab with a claude CLI pane + a browser pane ----
    const ownedA = await createFreshE2eBrowserContext(browser, info, FRESH_CONTEXT_OPTIONS)
    const ctxA: BrowserContext = ownedA.context
    const machineA = ownedA.machine
    const pageA = await ctxA.newPage()
    const harnessA = await connect(pageA, info)
    await selectShellIfPickerShowing(pageA)
    await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    // Claude pane (button label is the extension manifest's "Claude CLI").
    await openCliPane(pageA, /^Claude CLI$/i)

    // Record the pre-allocated sessionId from the argv log's --session-id pair
    // (pane-ledger-restart-rust.spec.ts:162-168 extraction).
    await expect(async () => {
      const sid = sessionIdsOf(await readArgvLog(argLog))[0]
      expect(sid, 'fake claude received a pre-allocated --session-id').toBeTruthy()
      sessionIdA = sid!
    }).toPass({ timeout: 30_000 })

    // Let it BIND: the ledger binding row for that sessionId hits disk (the
    // donor spec's readiness wait) — the inventory's D4 resolve needs it.
    await expect(async () => {
      const dir = path.join(capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude')
      const rows = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[])
      expect(rows.map(String).some((f) => f.includes(sessionIdA))).toBe(true)
    }).toPass({ timeout: 15_000 })

    // Mixed-kind coverage (A12): a browser pane at https://example.com in the
    // SAME tab, created the way a user would (split + picker "Browser").
    await createBrowserPane(pageA, 'https://example.com')

    // A snapshot generation containing BOTH panes exists on disk (pushes fire
    // on ready + every 5s).
    await waitForSnapshotContaining([sessionIdA, 'example.com'])
    await expect(async () => {
      const layoutA = await harnessA.getPaneLayout(await harnessA.getActiveTabId())
      const leavesA = leavesOfLayout(layoutA)
      expect(leavesA).toHaveLength(3)
      expect(leavesA.some((leaf) => leaf.content?.sessionRef?.sessionId === sessionIdA)).toBe(true)
      expect(leavesA.some((leaf) => leaf.content?.kind === 'browser' && leaf.content?.url === 'https://example.com')).toBe(true)
      paneIdsA = leavesA.map((leaf) => leaf.id)
      expect(paneIdsA.every(Boolean)).toBe(true)
    }).toPass({ timeout: 30_000 })

    // ---- The "lost browser" + server restart ----
    await ctxA.close()
    await server.restart()

    // ---- Context B: empty browser storage, but still machine A. ----
    // The selected machine is server-owned, so its workspace restores during
    // bootstrap rather than through the legacy cross-machine recovery offer.
    const argvCountBeforeRestore = (await readArgvLog(argLog)).length
    const ctxB = await createE2eBrowserContext(browser, info, machineA.id, FRESH_CONTEXT_OPTIONS)
    const pageB = await ctxB.newPage()
    const inventoryResponse = pageB.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/recovery/inventory'
        && url.searchParams.get('machineId') === machineA.id
    })
    await connect(pageB, info)
    expect((await inventoryResponse).ok()).toBe(true)
    await expect(pageB.getByTestId('recovery-offer-panel')).toHaveCount(0)

    // A recreated terminal pane renders.
    await expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    // PRIMARY resume proof: same-machine bootstrap re-spawned claude with the
    // adjacent pair `--resume <sessionIdA>` (delta past the pre-bootstrap log).
    await expect(async () => {
      const entries = await readArgvLog(argLog)
      expect(
        entries.slice(argvCountBeforeRestore).some((e) => hasClaudeResumePair(e.argv, sessionIdA)),
        'same-machine bootstrap must exec `claude --resume <sessionId>`',
      ).toBe(true)
    }).toPass({ timeout: 30_000 })

    // SECONDARY resume proof: the recreated pane's xterm text shows the fake
    // CLI's startup marker (fake-claude-cli.mjs:26-30; scrollback replay
    // delivers it to the late-attaching context). Buffers are read via the
    // renderer-agnostic harness API across ALL registered terminals. The
    // recovered claude pane is NARROW (third pane in a horizontal chain), so
    // the ~60-char marker line WRAPS across buffer rows — compare with all
    // whitespace stripped so wrapping (and trimmed wrap points) cannot hide it.
    await pageB.waitForFunction(
      (marker) => {
        const harness = (window as any).__FRESHELL_TEST_HARNESS__
        if (!harness) return false
        const state = harness.getState()
        const ids: string[] = []
        for (const tab of state?.tabs?.tabs ?? []) {
          const walk = (node: any) => {
            if (!node) return
            if (node.type === 'leaf') {
              if (node.content?.kind === 'terminal' && node.content?.terminalId) ids.push(node.content.terminalId)
              return
            }
            for (const child of node.children ?? []) walk(child)
          }
          walk(state?.panes?.layouts?.[tab.id])
        }
        const squash = (s: string) => s.replace(/\s+/g, '')
        return ids.some((id) => squash(harness.getTerminalBuffer(id) ?? '').includes(squash(marker)))
      },
      `claude: resumed session ${sessionIdA}`,
      { timeout: 30_000 },
    )

    // The browser pane was recreated too (mixed-kind restore, A12).
    const iframeB = pageB.locator('iframe[title="Browser content"]')
    await iframeB.waitFor({ state: 'attached', timeout: 15_000 })
    expect(await iframeB.getAttribute('src')).toContain('example.com')

    // ---- Same-browser reload guard: localStorage now has a layout ----
    await pageB.reload()
    const harnessB2 = new TestHarness(pageB)
    await harnessB2.waitForHarness()
    await harnessB2.waitForConnection()
    // Eligibility is boot-captured and synchronous (hadPersistedLayoutAtBoot
    // short-circuits BEFORE any fetch); the settle covers the async fetch path
    // that would have to complete for a wrongful offer to appear.
    await pageB.waitForTimeout(2_000)
    await expect(pageB.getByTestId('recovery-offer-panel')).toHaveCount(0)

    await ctxB.close()
  })

  test('scenario 2: a separately registered machine remains isolated and never mounts a generic recovery offer', async ({ browser }) => {
    test.setTimeout(120_000)

    // Context C receives a brand-new server-managed machine identity before
    // boot. It must not inherit scenario 1's machine workspace, and it must
    // not resurrect the retired generic cross-machine recovery UI.
    const ctxC = await createFreshContext(browser)
    const pageC = await ctxC.newPage()
    const harnessC = await connect(pageC, info)
    await expect(pageC.getByTestId('recovery-offer-panel')).toHaveCount(0)
    await expect(async () => {
      expect(await harnessC.getTabCount()).toBe(1)
      const layoutC = await harnessC.getPaneLayout(await harnessC.getActiveTabId())
      const leavesC = leavesOfLayout(layoutC)

      // A newly registered machine starts from the ordinary one-tab, one-picker
      // default. It must never receive A's split terminal/browser workspace.
      expect(layoutC?.type).toBe('leaf')
      expect(leavesC).toHaveLength(1)
      expect(leavesC[0]?.content).toMatchObject({ kind: 'picker' })

      const layoutCJson = JSON.stringify(layoutC)
      expect(layoutCJson).not.toContain(sessionIdA)
      expect(layoutCJson).not.toContain('example.com')
      expect(leavesC.some((leaf) => paneIdsA.includes(leaf.id))).toBe(false)
      expect(leavesC.some((leaf) => leaf.content?.sessionRef?.sessionId === sessionIdA)).toBe(false)
    }).toPass({ timeout: 10_000 })
    await expect(pageC.locator('iframe[src*="example.com"]')).toHaveCount(0)

    await ctxC.close()
  })

  test('scenario 3: no-restart browser loss — live panes restore by REATTACH to the still-running terminals (focused-episode-6 round 5)', async ({ browser }) => {
    test.setTimeout(240_000)

    // ---- Context D against the SAME still-running server (no restart) ----
    // D receives a server-managed machine identity. The app starts directly
    // in that machine's workspace; generic cross-machine recovery is not a
    // supported UI path.
    const ownedD = await createFreshE2eBrowserContext(browser, info, FRESH_CONTEXT_OPTIONS)
    const ctxD = ownedD.context
    const machineD = ownedD.machine
    const pageD = await ctxD.newPage()
    await connect(pageD, info)
    await expect(pageD.getByTestId('recovery-offer-panel')).toHaveCount(0)

    await selectShellIfPickerShowing(pageD)
    await expect(pageD.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    const argvCountBeforeCreate = (await readArgvLog(argLog)).length
    await openCliPane(pageD, /^Claude CLI$/i)

    // The NEW pane's sessionId = the --session-id pair past the pre-create count.
    let sessionIdD = ''
    await expect(async () => {
      const entries = await readArgvLog(argLog)
      const sid = sessionIdsOf(entries.slice(argvCountBeforeCreate))[0]
      expect(sid, 'context D fake claude received a pre-allocated --session-id').toBeTruthy()
      sessionIdD = sid!
    }).toPass({ timeout: 30_000 })

    // Ledger binding for D's session (inventory needs the bound row to
    // resolve + join liveness), then a snapshot generation that includes it.
    await expect(async () => {
      const dir = path.join(capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude')
      const rows = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[])
      expect(rows.map(String).some((f) => f.includes(sessionIdD))).toBe(true)
    }).toPass({ timeout: 15_000 })
    await waitForSnapshotContaining([sessionIdD])

    // Capture D's still-running terminal ids — the REATTACH proof below: the
    // recovered panes must own THESE ids (the live PTYs), never recreated
    // ones. Both panes sit in D's one tab (shell first, claude split second).
    const dPanes = await pageD.evaluate(() => {
      const harness = (window as any).__FRESHELL_TEST_HARNESS__
      const state = harness?.getState()
      const out: Array<{ mode: string | null; terminalId?: string }> = []
      for (const tab of state?.tabs?.tabs ?? []) {
        const walk = (node: any): void => {
          if (!node) return
          if (node.type === 'leaf') {
            if (node.content?.kind === 'terminal') {
              out.push({ mode: node.content?.mode ?? null, terminalId: node.content?.terminalId })
            }
            return
          }
          for (const child of node.children ?? []) walk(child)
        }
        walk(state?.panes?.layouts?.[tab.id])
      }
      return out
    })
    const shellTerminalIdD = dPanes.find((p) => p.mode === 'shell')?.terminalId
    const claudeTerminalIdD = dPanes.find((p) => p.mode === 'claude')?.terminalId
    expect(shellTerminalIdD, "D's shell pane owns a live terminal id").toBeTruthy()
    expect(claudeTerminalIdD, "D's claude pane owns a live terminal id").toBeTruthy()

    // The argv-log watermark for the never-respawn assertions below.
    const argvCountAtD = (await readArgvLog(argLog)).length

    // ---- Lose the browser WITHOUT restarting the server: BOTH D's shell
    // PTY and D's claude CLI keep running (registry-owned, not
    // connection-owned), so BOTH panes verdict LIVE. ----
    await ctxD.close()

    // ---- Context E: empty browser storage for D's registered machine.
    // Machine-scoped bootstrap restores both live panes and reattaches them;
    // it never asks the user through the legacy generic offer. ----
    const { ctx: ctxE, page: pageE } = await openSameMachineContext(browser, machineD.id, 'contextE')

    // Same-machine bootstrap completed: the tab is restored with both panes visible.
    await expect(pageE.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    // PRIMARY reattach proof: the recovered panes own D's ORIGINAL terminal
    // ids — the still-running PTYs themselves (the reviewer's "the old PTY
    // survives" observation, now asserted as the reattach acceptance).
    await expect(async () => {
      const ePanes = await pageE.evaluate(() => {
        const harness = (window as any).__FRESHELL_TEST_HARNESS__
        const state = harness?.getState()
        const ids: string[] = []
        for (const tab of state?.tabs?.tabs ?? []) {
          const walk = (node: any): void => {
            if (!node) return
            if (node.type === 'leaf') {
              if (node.content?.kind === 'terminal' && node.content?.terminalId) {
                ids.push(node.content.terminalId)
              }
              return
            }
            for (const child of node.children ?? []) walk(child)
          }
          walk(state?.panes?.layouts?.[tab.id])
        }
        return ids
      })
      expect(
        ePanes,
        "the recovered shell pane reattached to D's still-running shell PTY",
      ).toContain(shellTerminalIdD!)
      expect(
        ePanes,
        "the recovered claude pane reattached to D's still-running claude PTY",
      ).toContain(claudeTerminalIdD!)
    }).toPass({ timeout: 30_000 })

    // ANTI-RESPAWN: the still-running sessions were NEVER recreated — no fresh
    // claude spawn past the watermark and no resume onto a second process. The
    // positive window: the reattached panes already rendered above, so any
    // wrong spawn would be in flight now.
    const entriesAfterAccept = (await readArgvLog(argLog)).slice(argvCountAtD)
    expect(
      entriesAfterAccept,
      'the live panes reattached — nothing spawned past the watermark',
    ).toHaveLength(0)
    expect(
      entriesAfterAccept.some((e) => hasClaudeResumePair(e.argv, sessionIdD)),
      'the live session is never resumed onto a recreated pane',
    ).toBe(false)

    // Deliberately UNGUARDED close (R2a): scenario 4 bootstraps its registered
    // machine's workspace directly, so no generic offer is involved and the
    // next scenario remains correct whether or not E's teardown has settled.
    await ctxE.close()
  })

  test('scenario 4: small-viewport same-machine bootstrap restores a dense workspace without a generic offer', async ({ browser }) => {
    test.setTimeout(240_000)

    // ---- Populating context: record a 40-shell-tab layout ----
    // Registered machines bootstrap their own workspace directly. The dense
    // layout is still useful coverage on a phone viewport; the old generic
    // dialog containment contract is intentionally retired.
    const ownedP = await createFreshE2eBrowserContext(browser, info, FRESH_CONTEXT_OPTIONS)
    const ctxP = ownedP.context
    const machineP = ownedP.machine
    const pageP = await ctxP.newPage()
    traceInventoryFailures(pageP, 'scenario4-populating')
    const harnessP = await connect(pageP, info)
    await expect(pageP.getByTestId('recovery-offer-panel')).toHaveCount(0)

    // 40 shell tabs via the tab strip (idiom donor: automation-layout-rust.spec.ts:143
    // — TabBar.tsx:535 `addTab({mode:'shell'})`; multirow-tabs.spec.ts's
    // click-loop + waitForTabCount same shape).
    const newShellTab = pageP.getByRole('button', { name: 'New shell tab' })
    for (let i = 0; i < 40; i++) {
      await newShellTab.click()
    }
    await harnessP.waitForTabCount(41, 30_000) // 1 boot tab + 40 shell tabs

    // The populating client's claimed tabs-registry clientInstanceId (the
    // TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY value,
    // src/store/storage-keys.ts:17) selects its generations out of every
    // device dir in the poll below.
    const populatingClientId = await pageP.evaluate(() =>
      window.sessionStorage.getItem('freshell.tabs.client-instance-id.v1'),
    )
    expect(populatingClientId, 'populating context claimed a tabs-registry clientInstanceId').toBeTruthy()

    // The 40-tab layout must be IN DISK before the context dies: newest
    // generation for this client carries >= 40 records (the boot picker tab
    // may contribute a 41st).
    await waitForNewestGenerationRecordCount(populatingClientId!, 40)

    // ---- Lose the populating browser WITHOUT a server restart ----
    await ctxP.close()

    // ---- Phone-viewport context: the same registered machine restores its
    // own workspace automatically and must not mount a generic offer. ----
    const { ctx: ctxPhone, page: pagePhone, harness: harnessPhone } = await openSameMachineContext(browser, machineP.id, 'scenario4-phone', {
      serviceWorkers: 'block',
      viewport: { width: 390, height: 844 },
    })
    await expect(async () => {
      expect(await harnessPhone.getTabCount()).toBe(41)
    }).toPass({ timeout: 30_000 })
    await expect(pagePhone.getByTestId('recovery-offer-panel')).toHaveCount(0)

    await ctxPhone.close()
  })

  /**
   * Delta-round-7 Finding F1 (the scenario-3 early-loss variant): a live,
   * meaningfully-attributed, placement-valid, not-close-covered ledger row
   * whose pane never landed in ANY surviving snapshot is OFFERED as a reattach
   * candidate (pre-fix the ledgerOnly pipeline categorically excluded live
   * rows, so the genuinely-open session was lost from recovery). The row is
   * deliberately NOT waited into a snapshot: the browser is lost right after
   * the binding row lands, and post-loss shaping deletes every retained
   * generation referencing the pane (session id / createRequestId /
   * terminalId / paneId), so ONLY the ledgerOnly pipeline can carry it. The
   * offer lists it under the live (reattach) note, and accepting reattaches
   * to the ORIGINAL still-running terminal — never a second spawn.
   *
   * Placement: after scenario 4 — it wipes the evidence base (safe at this
   * serial boundary: no client is connected) and never restarts the server,
   * so later scenarios' own wipe discipline is unaffected.
   */
  test('scenario 6: early loss before any snapshot survives — the LIVE unsnapshotted ledger row is offered and reattached, never respawned (delta-round-7 F1)', async ({ browser }) => {
    test.setTimeout(240_000)

    // 1. Re-base the evidence base (the kill-window/stale-row idiom: safe
    //    while no client is connected).
    const snapshotsRoot = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    await fs.rm(snapshotsRoot, { recursive: true, force: true })

    // 2. Context L boots against the wiped store on a fresh server-managed
    //    machine, then gains a shell pane and a claude CLI pane in one tab.
    const ownedL = await createFreshE2eBrowserContext(browser, info, FRESH_CONTEXT_OPTIONS)
    const ctxL = ownedL.context
    const machineL = ownedL.machine
    const pageL = await ctxL.newPage()
    traceInventoryFailures(pageL, 'early-loss-L')
    const harnessL = await connect(pageL, info)
    await selectShellIfPickerShowing(pageL)
    await expect(pageL.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    const tabLId = (await harnessL.getActiveTabId())!

    const argvCountBeforeCreate = (await readArgvLog(argLog)).length
    await openCliPane(pageL, /^Claude CLI$/i)
    let sessionIdL = ''
    await expect(async () => {
      const sid = sessionIdsOf((await readArgvLog(argLog)).slice(argvCountBeforeCreate))[0]
      expect(sid, 'context L fake claude received a pre-allocated --session-id').toBeTruthy()
      sessionIdL = sid!
    }).toPass({ timeout: 30_000 })

    // 3. The binding row is durable BEFORE the loss, WITH its attribution
    //    (the judgment's row_time = lastAttributedAt — the creation receipt).
    const rowPathL = path.join(
      capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude', `${sessionIdL}.json`,
    )
    let attributedAt = 0
    await expect(async () => {
      const raw = await fs.readFile(rowPathL, 'utf8').catch(() => '')
      expect(raw, "L's claude binding row must land on disk").not.toBe('')
      const row = JSON.parse(raw) as { lastAttributedAt?: unknown; state?: unknown }
      expect(row.state).toBe('bound')
      expect(typeof row.lastAttributedAt, 'row JSON lastAttributedAt (the judgment row_time)').toBe('number')
      attributedAt = row.lastAttributedAt as number
    }).toPass({ timeout: 15_000 })

    // 4. Capture L's pane identities — the reattach proofs (the ORIGINAL
    //    terminal ids) and the shaping needles (so NO retained generation can
    //    reference this pane or its row). POLLED: the terminal handle folds
    //    into the pane content when terminal.created lands.
    let claudeLeafL: any
    let shellTerminalIdL: string | undefined
    let claudeTerminalIdL: string | undefined
    let claudeCrIdL: string | undefined
    await expect(async () => {
      const leaves = leavesOfLayout(await harnessL.getPaneLayout(tabLId))
      claudeLeafL = leaves.find((l) => l.content?.kind === 'terminal' && l.content?.mode === 'claude')
      const shellLeafL = leaves.find((l) => l.content?.kind === 'terminal' && (l.content?.mode ?? 'shell') === 'shell')
      shellTerminalIdL = shellLeafL?.content?.terminalId
      claudeTerminalIdL = claudeLeafL?.content?.terminalId
      claudeCrIdL = claudeLeafL?.content?.createRequestId
      expect(claudeTerminalIdL, "L's claude pane owns a live terminal id").toBeTruthy()
      expect(shellTerminalIdL, "L's shell pane owns a live terminal id").toBeTruthy()
      expect(claudeCrIdL, "L's claude pane owns its createRequestId").toBeTruthy()
    }).toPass({ timeout: 15_000 })

    // The argv-log watermark for the anti-respawn assertions below.
    const argvCountAtL = (await readArgvLog(argLog)).length

    // 5. THE EARLY LOSS: the browser dies WITHOUT any snapshot containing the
    //    new pane surviving (we deliberately never wait for one — the F1
    //    shape). The server (and both PTYs) keep running.
    await ctxL.close()

    // 6. Deterministic shaping: remove every retained generation referencing
    //    the pane (within-cadence loss made exact); the surviving keepsake
    //    generation holds the TAB (placement) with only the shell pane.
    await shapeEvidenceExcluding({
      snapshotsRoot,
      needles: [sessionIdL, claudeCrIdL as string, claudeTerminalIdL as string, claudeLeafL.id as string],
      keepNeedles: [tabLId],
      latestAllowedMs: attributedAt + 7_000,
      premiseLabel: `lastAttributedAt=${attributedAt}`,
    })

    // 7. Probe the inventory BEFORE any page is opened (the standalone-probe
    //    idiom). THE F1 PIN: the row must now be OFFERED — `live:true` with
    //    the still-running terminal id for the client-side reattach arm —
    //    while NO union pane references it (it arrives ONLY via ledgerOnly).
    const probe = await request.newContext({
      baseURL: info.baseUrl,
      extraHTTPHeaders: { 'x-auth-token': info.token },
    })
    try {
      const res = await probe.get('/api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0')
      expect(res.ok(), `inventory probe must succeed (status ${res.status()})`).toBe(true)
      const body = (await res.json()) as {
        recoverable?: unknown
        device?: unknown
        ledgerOnly?: Array<{ sessionId?: unknown; live?: unknown; liveTerminalId?: unknown; tabKey?: unknown }>
      }
      expect(body.recoverable).toBe(true)
      const deviceJson = JSON.stringify(body.device ?? null)
      expect(deviceJson.includes(sessionIdL), 'no union pane may reference the lost pane (session id)').toBe(false)
      expect(
        deviceJson.includes(claudeCrIdL as string),
        'no union pane may reference the lost pane (createRequestId)',
      ).toBe(false)
      expect(Array.isArray(body.ledgerOnly), 'probe response must carry a ledgerOnly array').toBe(true)
      const entry = (body.ledgerOnly ?? []).find((e) => e.sessionId === sessionIdL)
      expect(
        entry,
        `the LIVE unsnapshotted row ${sessionIdL} must be offered as a reattach candidate ` +
          `(got ledgerOnly=${JSON.stringify(body.ledgerOnly)})`,
      ).toBeTruthy()
      expect(entry!.live, 'the entry carries the live verdict (reattach routing)').toBe(true)
      expect(
        entry!.liveTerminalId,
        "the entry forwards the row's still-running terminal id for the reattach arm",
      ).toBe(claudeTerminalIdL)
      expect(String(entry!.tabKey), 'the entry joins the ORIGINAL tab').toContain(tabLId)
    } finally {
      await probe.dispose()
    }

    // 8. Empty browser storage for L's same registered machine automatically
    //    restores the shell plus ledger-only live claude row and reattaches
    //    both to their original terminals — never a respawn.
    const { ctx: ctxE, page: pageE } = await openSameMachineContext(browser, machineL.id, 'early-loss-E')
    await expect(pageE.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    await expect(async () => {
      const ePanes = await pageE.evaluate(() => {
        const harness = (window as any).__FRESHELL_TEST_HARNESS__
        const state = harness?.getState()
        const ids: string[] = []
        for (const tab of state?.tabs?.tabs ?? []) {
          const walk = (node: any): void => {
            if (!node) return
            if (node.type === 'leaf') {
              if (node.content?.kind === 'terminal' && node.content?.terminalId) {
                ids.push(node.content.terminalId)
              }
              return
            }
            for (const child of node.children ?? []) walk(child)
          }
          walk(state?.panes?.layouts?.[tab.id])
        }
        return ids
      })
      expect(ePanes, "the recovered shell pane reattached to L's still-running shell PTY").toContain(shellTerminalIdL!)
      expect(
        ePanes,
        "the ledgerOnly claude pane reattached to L's still-running claude PTY (the F1 arm)",
      ).toContain(claudeTerminalIdL!)
    }).toPass({ timeout: 30_000 })

    // ANTI-RESPAWN: nothing spawned past the watermark and the live session
    // was never resumed onto a recreated pane.
    const entriesAfterAccept = (await readArgvLog(argLog)).slice(argvCountAtL)
    expect(entriesAfterAccept, 'the live panes reattached — nothing spawned past the watermark').toHaveLength(0)
    expect(
      entriesAfterAccept.some((e) => hasClaudeResumePair(e.argv, sessionIdL)),
      'the live session is never resumed onto a recreated pane',
    ).toBe(false)

    await ctxE.close()
  })

  /**
   * Delta-round-7 Finding F2 (the terminal-detach twin of the kill-window
   * scenario): a claude CLI terminal pane created and closed PROMPTLY via the
   * PLAIN pane-X (inside the grace window) DETACHES — the session survives,
   * the row must stay Bound (the sidebar-reattach FEATURE) — and the durable
   * pane-close record keyed by the pane's createRequestId lands
   * BEFORE/ALONGSIDE the detach without fencing/retiring anything (kills
   * empty). After the compound loss (browser dies, server SIGKILL makes the
   * row non-live) and evidence shaping, the close-covered row is NEVER
   * offered and NEVER restored. Pre-fix nothing durable recorded the pane
   * close, so the judgment admitted the row and the offer recreated a pane
   * the user had explicitly removed — the finding's verbatim failure shape.
   *
   * Placement: alongside the kill-window scenario — it wipes the evidence
   * base (safe at this serial boundary) and restarts the server exactly once.
   */
  test('scenario 7: close inside the grace window via terminal DETACH — a just-closed CLI pane is never offered or restored (delta-round-7 F2)', async ({ browser }) => {
    test.setTimeout(240_000)

    // 1. Re-base the evidence base.
    const snapshotsRoot = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    await fs.rm(snapshotsRoot, { recursive: true, force: true })

    // 2. Context A: boot shell pane, then SPLIT a claude CLI pane beside it
    //    (the shell sibling keeps the tab alive, so closePane — not closeTab
    //    — fires, and no closed-tab record is written).
    const ownedA = await createFreshE2eBrowserContext(browser, info, FRESH_CONTEXT_OPTIONS)
    const ctxA = ownedA.context
    const machineA = ownedA.machine
    const pageA = await ctxA.newPage()
    const harnessA = await connect(pageA, info)
    await selectShellIfPickerShowing(pageA)
    await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    const tabAId = (await harnessA.getActiveTabId())!

    // The marker cwd is the offer-list discriminator (the panel renders
    // ledgerOnly lines as "{tabName}: {mode} — {cwd}"): create the CLI pane
    // with a unique real marker dir as its starting directory.
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detach-close-cli-'))
    const argvCountBeforeCreate = (await readArgvLog(argLog)).length
    const picker = await openPanePicker(pageA)
    await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
    const directoryInput = pageA.getByRole('combobox', { name: /Starting directory/i })
    await expect(directoryInput).toBeVisible({ timeout: 15_000 })
    await directoryInput.fill(markerDir)
    await directoryInput.press('Enter')

    // 3. Durable id + binding row on disk WITH attribution (mirrors the
    //    kill-window scenario's read of the judgment's row_time).
    let closedSessionId = ''
    await expect(async () => {
      const sid = sessionIdsOf((await readArgvLog(argLog)).slice(argvCountBeforeCreate))[0]
      expect(sid, 'context A fake claude received a pre-allocated --session-id').toBeTruthy()
      closedSessionId = sid!
    }).toPass({ timeout: 30_000 })
    const rowPath = path.join(
      capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude', `${closedSessionId}.json`,
    )
    let attributedAt = 0
    await expect(async () => {
      const raw = await fs.readFile(rowPath, 'utf8').catch(() => '')
      expect(raw, 'the claude binding row must land on disk').not.toBe('')
      const row = JSON.parse(raw) as { lastAttributedAt?: unknown; state?: unknown }
      expect(row.state).toBe('bound')
      expect(typeof row.lastAttributedAt, 'row JSON lastAttributedAt (the judgment row_time)').toBe('number')
      attributedAt = row.lastAttributedAt as number
    }).toPass({ timeout: 15_000 })

    // 4. The pane's identities (the shaping needles + the close-record join
    //    keys), fetched BEFORE the close. POLLED: the terminal handle folds
    //    into the pane content when terminal.created lands.
    let claudeLeafA: any
    let claudeTerminalIdA: string | undefined
    let claudeCrIdA = ''
    await expect(async () => {
      const leaves = leavesOfLayout(await harnessA.getPaneLayout(tabAId))
      claudeLeafA = leaves.find((l) => l.content?.kind === 'terminal' && l.content?.mode === 'claude')
      claudeTerminalIdA = claudeLeafA?.content?.terminalId
      claudeCrIdA = claudeLeafA?.content?.createRequestId ?? ''
      expect(claudeTerminalIdA, "A's claude pane owns a live terminal id").toBeTruthy()
      expect(claudeCrIdA, "A's claude pane owns its createRequestId").toBeTruthy()
    }).toPass({ timeout: 15_000 })

    // 5. Close VIA THE PLAIN pane-X immediately — inside the grace window —
    //    never shift+close and never the BackgroundSessions Stop button (the
    //    terminal.kill shape is the OTHER close family; this is the DETACH
    //    lane: the session survives by design).
    await pageA
      .locator(`[data-pane-id="${claudeLeafA.id}"][data-context='pane'] button[title='Close pane']`)
      .click()

    // 6. Premise 1 (NON-RETIRING): the row stays Bound — the detach answers
    //    "was this PANE closed", never "is the session dead" (the sidebar
    //    reattach feature is untouched).
    const readRowState = async () => {
      const raw = await fs.readFile(rowPath, 'utf8').catch(() => '')
      if (!raw) return ''
      return String((JSON.parse(raw) as { state?: unknown }).state ?? '')
    }
    await expect(async () => {
      expect(await readRowState()).toBe('bound')
    }).toPass({ timeout: 5_000 })

    // 7. Premise 2 (THE DURABLE CLOSE RECORD): a close-envelope record keyed
    //    by the pane's createRequestId (the record family the kill envelope
    //    writes) lands, carrying the pane linkage with NO identity fences
    //    (kills empty — nothing is fenced or retired).
    await expect(async () => {
      const dir = path.join(capturedHome, '.freshell', 'pane-ledger', 'close-envelopes')
      const files = await fs.readdir(dir).catch(() => [] as string[])
      let found: any = null
      for (const name of files.filter((f) => f.endsWith('.json'))) {
        const body = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')
        try {
          found = JSON.parse(body)
        } catch {
          continue
        }
        if (found?.createRequestId === claudeCrIdA) break
        found = null
      }
      expect(
        found,
        'a durable pane-close record keyed by the closed pane\'s createRequestId must land ' +
          `(looked in ${dir} for createRequestId=${claudeCrIdA})`,
      ).toBeTruthy()
      expect(found.terminalId, 'the record carries the pane (terminal) linkage').toBe(claudeTerminalIdA)
      expect(found.kills ?? [], 'the detach close fences NOTHING (non-retiring)').toHaveLength(0)
    }).toPass({ timeout: 15_000 })

    // 8. The COMPOUND loss: the browser dies FIRST (about:blank — a surviving
    //    page would reconnect and re-push), then the server is SIGKILLed and
    //    revived. The detached claude PTY dies with the server: the row now
    //    reads non-live — exactly the finding's admission shape.
    await pageA.goto('about:blank')
    info = await server.restartAbrupt()

    // 9. Post-kill evidence shaping + the IN-WINDOW premise read (the
    //    kill-window idiom): delete every retained generation referencing the
    //    closed pane, require a keepsake session-free generation (the tab's
    //    surviving push), and hold every surviving client's newest inside the
    //    grace window — otherwise the time-drop clause alone answers the
    //    exclusion and this scenario is vacuous. The row's file must STILL
    //    record Bound across the restart (the record, not a retirement,
    //    carries the close) — the anti-vacuity precondition of the probe
    //    below.
    await shapeEvidenceExcluding({
      snapshotsRoot,
      needles: [closedSessionId, claudeCrIdA, claudeTerminalIdA as string, claudeLeafA.id as string],
      keepNeedles: [tabAId],
      latestAllowedMs: attributedAt + 7_000,
      premiseLabel: `lastAttributedAt=${attributedAt}`,
    })
    expect(
      await readRowState(),
      'across the restart the row stays Bound — the close coverage (not a retirement) owns the exclusion',
    ).toBe('bound')

    // 10. Inventory assertion via a STANDALONE probe BEFORE any page is
    //     opened: the close-covered row is absent from ledgerOnly (bucket-
    //     shape anti-vacuity check included).
    const probe = await request.newContext({
      baseURL: info.baseUrl,
      extraHTTPHeaders: { 'x-auth-token': info.token },
    })
    try {
      const res = await probe.get('/api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0')
      expect(res.ok(), `inventory probe must succeed (status ${res.status()})`).toBe(true)
      const body = (await res.json()) as { ledgerOnly?: Array<{ sessionId?: unknown }> }
      expect(Array.isArray(body.ledgerOnly), 'probe response must carry a ledgerOnly array').toBe(true)
      expect(
        (body.ledgerOnly ?? []).every((e) => e.sessionId !== closedSessionId),
        `the detach-close-covered row ${closedSessionId} must NOT be in the inventory's ` +
          `ledgerOnly bucket (got ${JSON.stringify(body.ledgerOnly)})`,
      ).toBe(true)
    } finally {
      await probe.dispose()
    }

    // 11. Same-machine bootstrap restores the surviving shell directly while
    //     the close-covered pane remains absent; no generic offer is mounted.
    const { ctx: ctxB, page: pageB, harness: harnessB } = await openSameMachineContext(browser, machineA.id, 'detach-window-exclusion')

    // 12. The surviving shell restores (anti-vacuity), and NO leaf
    //     anywhere carries the closed session — the pane the user closed
    //     stays closed. The shell respawn is expected (it verdicts dead after
    //     the SIGKILL); the claude session must never reappear in ANY form.
    const argvCountAtAccept = (await readArgvLog(argLog)).length
    await expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await expect(async () => {
      const layout = await harnessB.getPaneLayout(await harnessB.getActiveTabId())
      const leaves = leavesOfLayout(layout)
      const hit = leaves.some(
        (leaf) =>
          leaf?.content?.sessionRef?.sessionId === closedSessionId
          || leaf?.content?.resumeSessionId === closedSessionId
          || leaf?.content?.sessionId === closedSessionId,
      )
      expect(hit, `no restored pane may carry the detach-closed session ${closedSessionId}`).toBe(false)
      const shellCount = leaves.filter(
        (leaf) => leaf?.content?.kind === 'terminal' && (leaf?.content?.mode ?? 'shell') === 'shell',
      ).length
      expect(shellCount, 'accept must restore the surviving shell (anti-vacuity)').toBeGreaterThan(0)
    }).toPass({ timeout: 30_000 })
    expect(
      (await readArgvLog(argLog)).slice(argvCountAtAccept).some((e) => hasClaudeResumePair(e.argv, closedSessionId)),
      'the closed session is never resumed onto a recreated pane',
    ).toBe(false)
    expect(
      (await readArgvLog(argLog))
        .slice(argvCountAtAccept)
        .some((e) => e.argv.includes(closedSessionId)),
      'the closed session never respawns at all (no argv names it)',
    ).toBe(false)

    await ctxB.close()
    await fs.rm(markerDir, { recursive: true, force: true })
  })

  /**
   * Delta-r7-round-2 (Finding F3) — the close → SIDEBAR-REATTACH → early-loss
   * lapse. A claude CLI pane is created beside the shell and closed via the
   * PLAIN pane-X (the durable NON-retiring close record stands, keyed by the
   * OLD pane's createRequestId — scenario 7's shape), then REOPENED through
   * the sidebar session list in split mode: the new pane mints a NEW
   * createRequestId and attaches to the SAME still-running terminal (whichever
   * arm drives it — the live-handle direct mount or the sessionRef
   * BoundElsewhere claim — both converge on `terminal.attach`, which carries
   * the new pane's createRequestId+tabId). The attach re-stamps the Bound row
   * onto the NEW pane's identity (the F3 restamp). The browser is then lost
   * WITHOUT a server restart and BEFORE any snapshot containing the reopened
   * pane survives (deterministic shaping): the row reaches the offer ONLY
   * through the ledgerOnly pipeline and MUST be offered — the old pane's
   * close covers only the old pane (the CRID arm re-keyed away; the
   * live-terminal arm keys only CRID-less rows). Pre-fix the row kept the old
   * close-covered createRequestId AND the record's terminal id, so both arms
   * suppressed a genuinely re-opened session.
   *
   * Placement: after scenario 7 — it wipes the evidence base (safe at this
   * serial boundary) and needs no later state.
   */
  test('scenario 8: close → sidebar reattach on the SAME terminal → early loss — the reopened pane is offered and reattached, never suppressed (delta-r7-r2 F3)', async ({ browser }) => {
    test.setTimeout(240_000)

    // 1. Re-base the evidence base (the scenario 6/7 idiom: safe while no
    //    client is connected at this serial boundary).
    const snapshotsRoot = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    await fs.rm(snapshotsRoot, { recursive: true, force: true })

    // 2. Context A: boot shell pane, then SPLIT a claude CLI pane beside it
    //    (same producer shape as scenario 7).
    const ownedA = await createFreshE2eBrowserContext(browser, info, FRESH_CONTEXT_OPTIONS)
    const ctxA = ownedA.context
    const machineA = ownedA.machine
    const pageA = await ctxA.newPage()
    traceInventoryFailures(pageA, 'reattach-lapse-A')
    const harnessA = await connect(pageA, info)
    await selectShellIfPickerShowing(pageA)
    await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    const tabAId = (await harnessA.getActiveTabId())!
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reattach-lapse-cli-'))
    const argvCountBeforeCreate = (await readArgvLog(argLog)).length
    const picker = await openPanePicker(pageA)
    await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
    const directoryInput = pageA.getByRole('combobox', { name: /Starting directory/i })
    await expect(directoryInput).toBeVisible({ timeout: 15_000 })
    await directoryInput.fill(markerDir)
    await directoryInput.press('Enter')

    // 3. The binding row is durable + attributed (scenario 7's premise read).
    let sessionId = ''
    await expect(async () => {
      const sid = sessionIdsOf((await readArgvLog(argLog)).slice(argvCountBeforeCreate))[0]
      expect(sid, 'context A fake claude received a pre-allocated --session-id').toBeTruthy()
      sessionId = sid!
    }).toPass({ timeout: 30_000 })
    const rowPath = path.join(
      capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude', `${sessionId}.json`,
    )
    await expect(async () => {
      const raw = await fs.readFile(rowPath, 'utf8').catch(() => '')
      const row = raw ? (JSON.parse(raw) as { state?: unknown; lastAttributedAt?: unknown }) : {}
      expect(row.state).toBe('bound')
      expect(typeof row.lastAttributedAt).toBe('number')
    }).toPass({ timeout: 15_000 })

    // 4. The pane's identities (close-record key + shaping needles).
    let claudeLeafA: any
    let claudeTerminalIdA: string | undefined
    let claudeCrIdA = ''
    await expect(async () => {
      const leaves = leavesOfLayout(await harnessA.getPaneLayout(tabAId))
      claudeLeafA = leaves.find((l) => l.content?.kind === 'terminal' && l.content?.mode === 'claude')
      claudeTerminalIdA = claudeLeafA?.content?.terminalId
      claudeCrIdA = claudeLeafA?.content?.createRequestId ?? ''
      expect(claudeTerminalIdA, "A's claude pane owns a live terminal id").toBeTruthy()
      expect(claudeCrIdA, "A's claude pane owns its createRequestId").toBeTruthy()
    }).toPass({ timeout: 15_000 })

    // 5. Seed the claude session history for the sidebar entry the reattach
    //    clicks (two user turns — a single-user-message session is flagged
    //    isNonInteractive and hidden by the directory; the auto-title-rust
    //    seed's shape). Written AFTER the session id is minted; the server's
    //    live watcher indexes it without a restart.
    const markerTitle = 'F3 reattach sidebar marker session'
    const sessionDir = path.join(capturedHome, '.claude', 'projects', 'f3-reattach-project')
    await fs.mkdir(sessionDir, { recursive: true })
    const seededLines: string[] = [
      JSON.stringify({
        type: 'system', subtype: 'init', session_id: sessionId,
        uuid: `${sessionId}-system`, timestamp: '2026-09-04T08:00:00.000Z',
        cwd: markerDir, git: { branch: 'main', dirty: false },
      }),
    ]
    let previousUuid = `${sessionId}-system`
    for (const [turnIndex, userMessage] of [markerTitle, 'Any progress on that request?'].entries()) {
      const userUuid = `${sessionId}-user-${turnIndex + 1}`
      const assistantUuid = `${sessionId}-assistant-${turnIndex + 1}`
      seededLines.push(JSON.stringify({
        parentUuid: previousUuid, cwd: markerDir, sessionId,
        version: '2.1.23', gitBranch: 'main', type: 'user',
        message: { role: 'user', content: userMessage },
        uuid: userUuid, timestamp: `2026-09-04T08:0${turnIndex}:01.000Z`,
      }))
      seededLines.push(JSON.stringify({
        parentUuid: userUuid, cwd: markerDir, sessionId,
        version: '2.1.23', gitBranch: 'main', type: 'assistant',
        message: {
          role: 'assistant', model: 'claude-opus-4-6-20260301',
          content: [{ type: 'text', text: `Working on it (${turnIndex + 1}).` }],
        },
        uuid: assistantUuid, timestamp: `2026-09-04T08:0${turnIndex}:02.000Z`,
      }))
      previousUuid = assistantUuid
    }
    await fs.writeFile(path.join(sessionDir, `${sessionId}.jsonl`), `${seededLines.join('\n')}\n`)

    // 6. Split-open mode for the sidebar click (the reattach must land IN
    //    tabA — the surviving tab — so the re-stamped row's tabKey names a
    //    tab the retained union knows; a brand-new tab would leave the
    //    judgment nothing placeable — the placement clause, not the finding,
    //    would then own the exclusion).
    await pageA.evaluate(() => {
      ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { sessionOpenMode: 'split' } },
      })
    })

    // 7. Close via the PLAIN pane-X (the shell sibling keeps tabA alive):
    //    the durable NON-retiring close record keyed by the OLD CRID lands.
    await pageA
      .locator(`[data-pane-id="${claudeLeafA.id}"][data-context='pane'] button[title='Close pane']`)
      .click()
    await expect(async () => {
      const dir = path.join(capturedHome, '.freshell', 'pane-ledger', 'close-envelopes')
      const files = await fs.readdir(dir).catch(() => [] as string[])
      let found: any = null
      for (const name of files.filter((f) => f.endsWith('.json'))) {
        const body = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')
        try {
          found = JSON.parse(body)
        } catch {
          continue
        }
        if (found?.createRequestId === claudeCrIdA) break
        found = null
      }
      expect(found, `the old pane's close record (createRequestId=${claudeCrIdA})`).toBeTruthy()
    }).toPass({ timeout: 15_000 })

    // 8. THE REATTACH: click the session in the sidebar. The directory
    //    labels the row by its cwd basename (the marker dir is unique per
    //    run); split mode puts the new pane IN tabA, attached to the SAME
    //    terminal (the live-handle direct mount when the session reads
    //    running, else the sessionRef claim's BoundElsewhere arm — both
    //    converge on `terminal.attach`).
    const markerDirBasename = path.basename(markerDir)
    const sessionItem = pageA.getByRole('button', { name: new RegExp(markerDirBasename) }).first()
    await expect(sessionItem).toBeVisible({ timeout: 30_000 })
    await sessionItem.click()
    let claudeCrIdReattached = ''
    let claudePaneIdReattached = ''
    await expect(async () => {
      const leaves = leavesOfLayout(await harnessA.getPaneLayout(tabAId))
      const reattached = leaves.find(
        (l) => l.content?.kind === 'terminal'
          && l.content?.mode === 'claude'
          && l.content?.terminalId === claudeTerminalIdA,
      )
      expect(
        reattached,
        'the reopened pane lands IN tabA attached to the SAME still-running terminal',
      ).toBeTruthy()
      expect(
        reattached?.content?.createRequestId,
        'the reopen minted a NEW pane identity',
      ).not.toBe(claudeCrIdA)
      claudeCrIdReattached = reattached?.content?.createRequestId ?? ''
      claudePaneIdReattached = reattached?.id ?? ''
    }).toPass({ timeout: 30_000 })

    // 9. THE F3 RESTAMP PIN: the Bound row re-keys onto the NEW pane's
    //    createRequestId, and its attribution clock advanced to the attach's
    //    receipt (never backwards). Pre-fix the attach carried no pane
    //    identity and performed no ledger write, so this poll timed out with
    //    the row still keyed by the old close-covered CRID.
    let reattachedAttributedAt = 0
    await expect(async () => {
      const raw = await fs.readFile(rowPath, 'utf8')
      const row = JSON.parse(raw) as {
        state?: unknown
        createRequestId?: unknown
        lastAttributedAt?: unknown
      }
      expect(row.state).toBe('bound')
      expect(
        row.createRequestId,
        'the row re-keys onto the reattaching pane (the old pane stays closed)',
      ).toBe(claudeCrIdReattached)
      expect(typeof row.lastAttributedAt).toBe('number')
      reattachedAttributedAt = row.lastAttributedAt as number
    }).toPass({ timeout: 15_000 })

    // The argv-log watermark for the anti-respawn assertions below: NOTHING
    // spawned since the original create (the sidebar reattach attached — it
    // never spawned a second process).
    const argvCountAtReattach = (await readArgvLog(argLog)).length
    expect(
      (await readArgvLog(argLog)).slice(argvCountBeforeCreate).length,
      'exactly one claude process exists (the original; the reattach attached, never spawned)',
    ).toBe(1)

    // 10. THE EARLY LOSS: the browser dies WITHOUT a server restart (the PTYs
    //     keep running) and BEFORE any snapshot containing the reopened pane
    //     survives.
    await ctxA.close()

    // 11. Deterministic shaping: remove every retained generation referencing
    //     ANY of the pane's identities across BOTH its epochs (old AND new
    //     CRIDs/paneIds); the surviving keepsake generation holds tabA with
    //     only the shell pane. The row's attribution is the attach's receipt
    //     now, so newest-per-client must sit inside grace of THAT.
    await shapeEvidenceExcluding({
      snapshotsRoot,
      needles: [
        sessionId,
        claudeCrIdA,
        claudeCrIdReattached,
        claudeTerminalIdA as string,
        claudeLeafA.id as string,
        claudePaneIdReattached,
      ],
      keepNeedles: [tabAId],
      latestAllowedMs: reattachedAttributedAt + 7_000,
      premiseLabel: `reattached lastAttributedAt=${reattachedAttributedAt}`,
    })

    // 12. Probe the inventory BEFORE any page is opened. THE F3 PIN: the row
    //     must be OFFERED — live, with the still-running terminal for the
    //     client-side reattach arm — while NO union pane references it.
    const probe = await request.newContext({
      baseURL: info.baseUrl,
      extraHTTPHeaders: { 'x-auth-token': info.token },
    })
    try {
      const res = await probe.get('/api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0')
      expect(res.ok(), `inventory probe must succeed (status ${res.status()})`).toBe(true)
      const body = (await res.json()) as {
        recoverable?: unknown
        device?: unknown
        ledgerOnly?: Array<{ sessionId?: unknown; live?: unknown; liveTerminalId?: unknown; tabKey?: unknown }>
      }
      expect(body.recoverable).toBe(true)
      const deviceJson = JSON.stringify(body.device ?? null)
      expect(deviceJson.includes(sessionId), 'no union pane may reference the reopened pane (session id)').toBe(false)
      expect(
        deviceJson.includes(claudeCrIdReattached),
        'no union pane may reference the reopened pane (new createRequestId)',
      ).toBe(false)
      const entry = (body.ledgerOnly ?? []).find((e) => e.sessionId === sessionId)
      expect(
        entry,
        `the REOPENED row ${sessionId} must be offered — the old pane's close covers only the old pane ` +
          `(got ledgerOnly=${JSON.stringify(body.ledgerOnly)})`,
      ).toBeTruthy()
      expect(entry!.live, 'the entry carries the live verdict (reattach routing)').toBe(true)
      expect(entry!.liveTerminalId, 'the entry forwards the still-running terminal').toBe(claudeTerminalIdA)
      expect(String(entry!.tabKey), 'the entry joins the ORIGINAL (surviving) tab').toContain(tabAId)
    } finally {
      await probe.dispose()
    }

    // 13. Same-machine bootstrap reattaches the row to the ORIGINAL terminal
    //     without routing through a generic offer.
    const { ctx: ctxE, page: pageE } = await openSameMachineContext(browser, machineA.id, 'reattach-lapse-E')
    await expect(pageE.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await expect(async () => {
      const ePanes = await pageE.evaluate(() => {
        const harness = (window as any).__FRESHELL_TEST_HARNESS__
        const state = harness?.getState()
        const ids: string[] = []
        for (const tab of state?.tabs?.tabs ?? []) {
          const walk = (node: any): void => {
            if (!node) return
            if (node.type === 'leaf') {
              if (node.content?.kind === 'terminal' && node.content?.terminalId) {
                ids.push(node.content.terminalId)
              }
              return
            }
            for (const child of node.children ?? []) walk(child)
          }
          walk(state?.panes?.layouts?.[tab.id])
        }
        return ids
      })
      expect(
        ePanes,
        'the recovered claude pane reattached to the ORIGINAL still-running terminal',
      ).toContain(claudeTerminalIdA!)
    }).toPass({ timeout: 30_000 })
    expect(
      (await readArgvLog(argLog)).slice(argvCountAtReattach),
      'same-machine bootstrap reattached — nothing spawned past the watermark',
    ).toHaveLength(0)

    await ctxE.close()
    await fs.rm(markerDir, { recursive: true, force: true })
  })

  /**
   * Retire-on-kill contract pin (delta-review round 5): a fresh-agent pane
   * closed INSIDE the 7-second creation-race grace window must never be
   * offered after a browser loss + server SIGKILL. The window cannot tell
   * "created, not yet snapshotted" (keep, per the SIGKILL-within-5s
   * contract) from "created and just closed" — the boundary is exactly the
   * explicit freshAgent.kill, which now retires the row Closed (the
   * inventory's ledgerOnly pipeline pre-filters to Bound rows). Pre-repair
   * the kill left the row Bound with an in-window `lastAttributedAt`, so the
   * judgment kept it and the accept path rebuilt a pane the user had just
   * closed — the finding's verbatim failure shape.
   *
   * Producer: freshclaude pane split beside the boot shell pane (same donor
   * shape as the stale-row scenario), closed via the PLAIN pane-X as soon as
   * its binding row is on disk (well inside the window), then the COMPOUND
   * loss: browser to about:blank, server SIGKILL+revive. Post-kill evidence
   * shaping (donor: restore-contract-wall-rust.spec.ts's SIGKILL-within-5s
   * leg) deletes every retained generation referencing the session — the
   * within-cadence loss shape, made deterministic — so the row is
   * unreferenced by construction and reaches the offer pipeline only through
   * ledgerOnly. Assertions: the row's file records Retired/Closed (soft
   * precondition — pre-repair this times out and the later offer-side
   * assertions carry the RED), the probe inventory's ledgerOnly lacks the
   * session, the offer panel lists no line for its marker cwd, and accepting
   * restores the surviving shell while NEVER recreating the killed pane.
   * Placement: second-to-last — the LAST test wipes the evidence base, and
   * this scenario's own wipe depends on no later state.
   */
  test('kill inside the grace window: a just-closed fresh-agent pane is never offered or restored', async ({ browser }) => {
    test.setTimeout(240_000) // create + push poll + abrupt restart + two boots

    // 1. Re-base the evidence base (same justification as the stale-row
    //    scenario: no client is connected at this serial boundary, so wiping
    //    the generation store is safe; this scenario's own context rebuilds
    //    the evidence and keeps the offer recoverable via the surviving
    //    shell tab).
    await fs.rm(path.join(capturedHome, '.freshell', 'tabs-snapshots'), { recursive: true, force: true })

    // 2. Context A: boot shell pane, then SPLIT a freshclaude pane beside it.
    const ownedA = await createFreshE2eBrowserContext(browser, info, FRESH_CONTEXT_OPTIONS)
    const ctxA = ownedA.context
    const machineA = ownedA.machine
    const pageA = await ctxA.newPage()
    const harnessA = await connect(pageA, info)
    await selectShellIfPickerShowing(pageA)
    await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    const tabAId = (await harnessA.getActiveTabId())!
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kill-window-freshclaude-'))
    await createFreshclaudePane(pageA, harnessA, markerDir)

    // 3. Durable id + binding row on disk (same idioms as the stale-row
    //    scenario); `attributedAt` is the row's browser-asserted attribution
    //    time — the judgment's row_time — for the in-window premise read
    //    below.
    let killedSessionId = ''
    await expect
      .poll(
        async () => {
          const c = findFreshAgentLeaf(await harnessA.getPaneLayout(tabAId))?.content
          killedSessionId = c?.sessionRef?.sessionId ?? c?.resumeSessionId ?? ''
          return killedSessionId
        },
        { timeout: 30_000 },
      )
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    const rowPath = path.join(
      capturedHome,
      '.freshell',
      'pane-ledger',
      'bindings',
      'claude',
      `${killedSessionId}.json`,
    )
    let attributedAt = 0
    await expect(async () => {
      const raw = await fs.readFile(rowPath, 'utf8').catch(() => '')
      expect(raw, 'the freshclaude binding row must land on disk').not.toBe('')
      const row = JSON.parse(raw) as { lastAttributedAt?: unknown }
      expect(typeof row.lastAttributedAt, 'row JSON lastAttributedAt (the judgment row_time)').toBe('number')
      attributedAt = row.lastAttributedAt as number
    }).toPass({ timeout: 15_000 })

    // 4. Close VIA THE PLAIN pane-X immediately — inside the grace window —
    //    never shift+close, never the BackgroundSessions Stop button (the
    //    terminal.kill shape is the other provider family). The shell sibling
    //    keeps the tab alive, so closePane (not closeTab) fires.
    await pageA
      .locator("[data-pane-id][data-context='pane']:has([data-context='fresh-agent']) button[title='Close pane']")
      .click()

    // 5. SOFT retire-on-kill precondition: the row's file records
    //    Retired/Closed once the kill is processed. Short-budgeted and
    //    tolerated on timeout so a pre-repair run still proceeds to the
    //    offer-side assertions (THE red of the finding); on the repaired
    //    build this polls true in well under a second.
    const readRowState = async () => {
      const raw = await fs.readFile(rowPath, 'utf8').catch(() => '')
      if (!raw) return ''
      const row = JSON.parse(raw) as { state?: unknown; retiredReason?: unknown }
      return row.state === 'retired' && row.retiredReason === 'closed' ? 'closed' : String(row.state ?? '')
    }
    await expect(async () => {
      expect(await readRowState()).toBe('closed')
    })
      .toPass({ timeout: 5_000, intervals: [150, 250, 500] })
      .catch(() => {})

    // 6. The COMPOUND loss: the browser dies FIRST (about:blank — the wall
    //    spec's determinism note: a surviving page would reconnect and
    //    force-push its registry after the shaping below), then SIGKILL.
    await pageA.goto('about:blank')
    info = await server.restartAbrupt()

    // 7. Post-kill evidence shaping + the IN-WINDOW premise read, in one
    //    pass (donor: restore-contract-wall-rust.spec.ts SIGKILL-within-5s):
    //    delete every retained generation referencing the closed session (a
    //    within-cadence loss; retention prunes them the same way in
    //    production), require a session-free newest generation per surviving
    //    client, and require its capturedAt to sit INSIDE the grace window of
    //    the row's attribution time — otherwise the time-drop clause alone
    //    would answer the exclusion and every assertion below is vacuous.
    const snapshotsRoot = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    const newestByClient = new Map<string, { revision: number; capturedAt: number }>()
    let keptSessionFreeGeneration = false
    for (const deviceDirName of await fs.readdir(snapshotsRoot).catch(() => [] as string[])) {
      const deviceDir = path.join(snapshotsRoot, deviceDirName)
      for (const name of (await fs.readdir(deviceDir)).filter((n) => n.endsWith('.json'))) {
        const filePath = path.join(deviceDir, name)
        const raw = await fs.readFile(filePath, 'utf8')
        if (raw.includes(killedSessionId)) {
          await fs.rm(filePath)
          continue
        }
        keptSessionFreeGeneration = true
        let doc: any = null
        try {
          doc = JSON.parse(raw)
        } catch {
          continue
        }
        const client = doc?.clientInstanceId
        if (typeof client !== 'string' || !client) continue
        const revision = Number(doc?.snapshotRevision ?? 0)
        const capturedAt = Number(doc?.capturedAt ?? 0)
        const cur = newestByClient.get(client)
        if (!cur || revision > cur.revision || (revision === cur.revision && capturedAt > cur.capturedAt)) {
          newestByClient.set(client, { revision, capturedAt })
        }
      }
    }
    expect(
      keptSessionFreeGeneration,
      'evidence shaping must leave a session-free generation behind (the shell-pane push)',
    ).toBe(true)
    expect(newestByClient.size, 'context A pushed at least one retained generation').toBeGreaterThan(0)
    for (const [client, newest] of newestByClient) {
      expect(
        newest.capturedAt,
        `client ${client}'s newest retained generation must sit INSIDE the grace window ` +
          `of the row's attribution (capturedAt=${newest.capturedAt}, lastAttributedAt=${attributedAt}, ` +
          'grace=7000ms) — otherwise the time-drop clause alone answers the exclusion ' +
          'and this scenario is vacuous',
      ).toBeLessThanOrEqual(attributedAt + 7_000)
    }

    // 8. Inventory assertion via a STANDALONE probe BEFORE any page is opened
    //    (scenario-5 idiom): membership-absence in ledgerOnly, with the
    //    bucket-shape anti-vacuity check.
    const req = await request.newContext({
      baseURL: info.baseUrl,
      extraHTTPHeaders: { 'x-auth-token': info.token },
    })
    try {
      const res = await req.get('/api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0')
      expect(res.ok(), `inventory probe must succeed (status ${res.status()})`).toBe(true)
      const body = (await res.json()) as { ledgerOnly?: Array<{ sessionId?: unknown }> }
      expect(Array.isArray(body.ledgerOnly), 'probe response must carry a ledgerOnly array').toBe(true)
      expect(
        (body.ledgerOnly ?? []).every((e) => e.sessionId !== killedSessionId),
        `killed-in-window ledger row ${killedSessionId} must NOT be present in the inventory's ` +
          `ledgerOnly bucket (got ${JSON.stringify(body.ledgerOnly)})`,
      ).toBe(true)
    } finally {
      await req.dispose()
    }

    // 9. The same registered machine restores its surviving shell directly;
    //    the killed pane remains absent and no generic offer is mounted.
    const { ctx: ctxB, page: pageB, harness: harnessB } = await openSameMachineContext(browser, machineA.id, 'kill-window-exclusion')

    // 10. The surviving shell restores (anti-vacuity), and NO leaf
    //     anywhere carries the killed session — the pane the user closed
    //     stays closed. (Layout scan has a soft budget: the restore runs
    //     through the plan rebuild, not instantly.)
    await expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await expect(async () => {
      const layout = await harnessB.getPaneLayout(await harnessB.getActiveTabId())
      const walk = (node: any): any[] =>
        !node ? [] : node.type === 'leaf' ? [node] : (node.children ?? []).flatMap(walk)
      const hit = walk(layout).some(
        (leaf) =>
          leaf?.content?.sessionRef?.sessionId === killedSessionId
          || leaf?.content?.resumeSessionId === killedSessionId
          || leaf?.content?.sessionId === killedSessionId,
      )
      expect(hit, `no restored pane may carry the killed session ${killedSessionId}`).toBe(false)
      const shellCount = walk(layout).filter(
        (leaf) => leaf?.content?.kind === 'terminal' && (leaf?.content?.mode ?? 'shell') === 'shell',
      ).length
      expect(shellCount, 'accept must restore the surviving shell (anti-vacuity)').toBeGreaterThan(0)
    }).toPass({ timeout: 30_000 })

    await ctxB.close()
    await fs.rm(markerDir, { recursive: true, force: true })
  })

  /**
   * D8 contract pin: a session that was closed before its client's newest
   * retained snapshot evidence (a stale NEVER-OPEN-at-the-evidence-horizon
   * row) is never offered via the inventory's ledgerOnly bucket. Pinned RED
   * against the pre-D8 blanket bucket (Bound + unreferenced + not live),
   * which kept the row and offered it; the server-side parent-relative
   * judgment
   * (docs/plans/2026-09-02-restore-open-sessions-only.md, Task 3) turned it
   * GREEN.
   *
   * Producer recipe (validator load-bearing-validator-v1-recipe.md): a
   * freshclaude pane split beside the boot shell pane, closed via the PLAIN
   * pane-X, sends freshAgent.kill (never terminal.kill). The 15s timing gate
   * below holds the close OUTSIDE the judgment's grace window, so the row is
   * excluded no matter how the close is recorded; since the retire-on-kill
   * repair (the prior scenario's subject) the close additionally retires the
   * row Closed. MUST remain LAST in this serial describe: it wipes the
   * generation store to re-base the evidence, which no earlier scenario may
   * observe.
   */
  test('stale never-open ledger rows are never offered', async ({ browser }) => {
    test.setTimeout(240_000) // 15s timing gate + <=120s generation poll + restart + two boots

    // 1. Re-base the evidence base: earlier scenarios' clients hold frozen
    //    generations whose clocks would co-survive selection with this
    //    scenario's junk row's parent. No client is connected at this point
    //    in the serial suite, so wiping the generation store is safe; this
    //    scenario's own context rebuilds the evidence (and keeps the offer
    //    recoverable via the surviving shell tab).
    await fs.rm(path.join(capturedHome, '.freshell', 'tabs-snapshots'), { recursive: true, force: true })

    // 2. Context A: boot shell pane, then SPLIT a freshclaude pane beside it
    //    (NEVER close a tab's only pane — that collapses to closeTab, whose
    //    closed-tab record would re-reference the row forever).
    const ownedA = await createFreshE2eBrowserContext(browser, info, FRESH_CONTEXT_OPTIONS)
    const ctxA = ownedA.context
    const machineA = ownedA.machine
    const pageA = await ctxA.newPage()
    const harnessA = await connect(pageA, info)
    await selectShellIfPickerShowing(pageA)
    await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    const tabAId = (await harnessA.getActiveTabId())!

    // 3. The marker cwd is the offer-list discriminator (the panel renders
    //    ledgerOnly rows under their tab as "{tabName}: {mode} — {cwd}",
    //    never the sessionId): create the freshclaude pane with a unique
    //    real marker dir as cwd.
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'junk-freshclaude-'))
    await createFreshclaudePane(pageA, harnessA, markerDir)

    // 4. Acquire the DURABLE session id via the harness poll
    //    (sessionRef.sessionId ?? resumeSessionId, canonical-UUID shape —
    //    the argv-log idiom does not serve fresh-agent panes: the sidecar
    //    path never spawns the CLI).
    let junkSessionId = ''
    await expect
      .poll(
        async () => {
          const c = findFreshAgentLeaf(await harnessA.getPaneLayout(tabAId))?.content
          junkSessionId = c?.sessionRef?.sessionId ?? c?.resumeSessionId ?? ''
          return junkSessionId
        },
        { timeout: 30_000 },
      )
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

    // 5. Disk-wait the binding row and read bindMs (the row JSON's createdAt,
    //    serde camelCase).
    let bindMs = 0
    await expect(async () => {
      const raw = await fs
        .readFile(
          path.join(capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude', `${junkSessionId}.json`),
          'utf8',
        )
        .catch(() => '')
      expect(raw, 'the freshclaude binding row must land on disk').not.toBe('')
      const row = JSON.parse(raw) as { createdAt?: unknown }
      expect(typeof row.createdAt, 'row JSON createdAt (serde camelCase)').toBe('number')
      bindMs = row.createdAt as number
    }).toPass({ timeout: 15_000 })

    // 6. Prove it WAS snapshot-open before it becomes the stale row (pushes
    //    fire on ready + every 5s).
    await waitForSnapshotContaining([junkSessionId])

    // 7. Timing gate: close no earlier than bindMs + 15_000. The final
    //    post-close push lands within one 5s tick, so the parent's newest
    //    retained generation is server-stamped strictly after bindMs + 14_000
    //    — well past the judgment grace, so with the D8 filter the row is
    //    dropped; pre-fix the blanket bucket keeps it (the pinned red).
    const gateWaitMs = bindMs + 15_000 - Date.now()
    if (gateWaitMs > 0) await pageA.waitForTimeout(gateWaitMs)

    // 8. Close via the PLAIN pane-X — NEVER shift+close and NEVER the
    //    BackgroundSessions Stop button (terminal.kill would retire the row
    //    and vacate the pin). The shell sibling keeps the tab alive, so
    //    closePane (not closeTab) fires and no closed-tab record is written.
    await pageA
      .locator("[data-pane-id][data-context='pane']:has([data-context='fresh-agent']) button[title='Close pane']")
      .click()

    // 9. Evidence-advance: the newest generation of EVERY client must
    //    postdate bindMs + 14_000 AND no longer contain the session id — the
    //    post-close push's on-disk proof, and the post-fix "parent's newest"
    //    judgment input. (After step 1's wipe only context A's client exists;
    //    the every-client form protects the assertion if the wipe is ever
    //    skipped.)
    const snapshotsDir = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    await expect(async () => {
      const newestByClient = new Map<string, { revision: number; capturedAt: number; raw: string }>()
      const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
      for (const device of devices) {
        const deviceDir = path.join(snapshotsDir, device)
        const files = (await fs.readdir(deviceDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
        for (const f of files) {
          const raw = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
          let doc: any = null
          try {
            doc = JSON.parse(raw)
          } catch {
            continue
          }
          const client = doc?.clientInstanceId
          if (typeof client !== 'string' || !client) continue
          const revision = Number(doc?.snapshotRevision ?? 0)
          const capturedAt = Number(doc?.capturedAt ?? 0)
          const cur = newestByClient.get(client)
          if (!cur || revision > cur.revision || (revision === cur.revision && capturedAt > cur.capturedAt)) {
            newestByClient.set(client, { revision, capturedAt, raw })
          }
        }
      }
      expect(newestByClient.size, 'at least one client generation must exist after context A booted').toBeGreaterThan(0)
      for (const [client, newest] of newestByClient) {
        expect(
          newest.capturedAt,
          `client ${client}'s newest generation must postdate the close gate (bindMs + 14s)`,
        ).toBeGreaterThan(bindMs + 14_000)
        expect(
          newest.raw.includes(junkSessionId),
          `client ${client}'s newest generation must no longer contain the closed session`,
        ).toBe(false)
      }
    }).toPass({ timeout: 120_000 })

    // 10. Close context A, then restart before same-machine bootstrap.
    await ctxA.close()
    info = await server.restart()

    // 11. RED/GREEN inventory assertion via a STANDALONE probe BEFORE any
    //     page is opened — never page.request (its handle dies with the
    //     context) and never a navigated page (a booted page would register
    //     as a tabs.sync client and could push inside the grace window).
    //     Membership-absence, NOT emptiness: other legit rows may exist.
    const req = await request.newContext({
      baseURL: info.baseUrl,
      extraHTTPHeaders: { 'x-auth-token': info.token },
    })
    try {
      const res = await req.get('/api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0')
      expect(res.ok(), `inventory probe must succeed (status ${res.status()})`).toBe(true)
      const body = (await res.json()) as { ledgerOnly?: Array<{ sessionId?: unknown }> }
      // Anti-vacuity: prove the bucket shape before asserting absence — a probe
      // whose response dropped `ledgerOnly` must fail, not pass vacuously.
      expect(Array.isArray(body.ledgerOnly), 'probe response must carry a ledgerOnly array').toBe(true)
      expect(
        (body.ledgerOnly ?? []).every((e) => e.sessionId !== junkSessionId),
        `stale never-open ledger row ${junkSessionId} must NOT be present in the inventory's `
          + `ledgerOnly bucket (got ${JSON.stringify(body.ledgerOnly)})`,
      ).toBe(true)
    } finally {
      await req.dispose()
    }

    // 12. Same-machine bootstrap restores the surviving layout without a
    //     generic offer; the stale row remains excluded by the probe above.
    const { ctx: ctxB, page: pageB } = await openSameMachineContext(browser, machineA.id, 'junk-exclusion')

    // Do NOT click accept on the junk account alone: with the bucket empty of
    // this row there is no junk tab to form (Task 4 separately pins that
    // surviving rows join their original tab; rows whose tab vanished are
    // excluded server-side, so the trailing tab never forms at all).
    await ctxB.close()
    await fs.rm(markerDir, { recursive: true, force: true })
  })

  /**
   * Focused-episode-7 round 5, Finding F1 (the ready-sweep close race): the
   * pane's close is QUEUED while the socket is down; on the reconnect the
   * client flushes the queued `pane.closed` FIRST and the ready-time open
   * sweep MUST NOT re-assert that pane behind it (the still-displayed pane
   * is awaiting the close's acknowledgement — an open-assert would consume
   * the committed close record before the ack arrives, and the post-ack
   * removal would leave a ghost row with no close evidence: silently
   * re-offered later, exactly the mechanism this campaign exists to kill).
   * The pin ends at the finding's demanded shape: the close flushes, the
   * sweep skips the pending pane, the success ack lands, the pane is
   * removed — and the close evidence STANDS durable. (What a standing record
   * MEANS for the offer is scenario 7's lane.)
   *
   * Disconnection is a `routeWebSocket` gate (Playwright's ws interception —
   * `context.route` provably does NOT see ws handshakes): the handler
   * passthroughs normally, and while "blocked" it accepts the page's socket
   * but never connects it to the server (no `ready` ever arrives; the
   * client's sends queue — the exact queued-close interleave without any
   * server cooperation). Blocking starts by closing the live socket so the
   * client's reconnect lands IN the black hole; unblocking closes the
   * black-holed socket so the next reconnect passthroughs.
   *
   * Placement: last — it re-bases the evidence base and depends on nothing
   * from prior scenarios (the scenario 7/8 idiom: safe at this serial
   * boundary, no client connected).
   */
  test('scenario 9: a close queued across a reconnect is never re-asserted open behind its own flush — the committed evidence stands (focused-episode-7 round 5 F1)', async ({ browser }) => {
    test.setTimeout(240_000)

    // 1. Re-base the evidence base (no client connected at this serial boundary).
    await fs.rm(path.join(capturedHome, '.freshell', 'tabs-snapshots'), { recursive: true, force: true })

    // 2. Context A: shell pane, then SPLIT a claude CLI pane beside it (the
    //    shell sibling keeps the tab alive so closePane — the single-pane
    //    gate — owns the close; scenario 7's construction). The ws gate is
    //    installed BEFORE the page boots, passthrough until flipped.
    const ctxA: BrowserContext = await createFreshContext(browser)
    let blockWs = false
    const liveSockets: Array<{ client: import('@playwright/test').WebSocketRoute; server: import('@playwright/test').WebSocketRoute }> = []
    const blockedSockets: Array<import('@playwright/test').WebSocketRoute> = []
    await ctxA.routeWebSocket((url) => url.pathname === '/ws', (ws) => {
      if (blockWs) {
        // The black hole: accepted but never connected — no hello answer, no
        // ready; the client's sends queue and its ready timeout cycles.
        blockedSockets.push(ws)
        return
      }
      const server = ws.connectToServer()
      liveSockets.push({ client: ws, server })
      ws.onMessage((message) => server.send(message))
      server.onMessage((message) => ws.send(message))
      // Keep the real server's view honest when either side closes.
      ws.onClose((code, reason) => void server.close({ code, reason }).catch(() => {}))
      server.onClose((code, reason) => void ws.close({ code, reason }).catch(() => {}))
    })
    const pageA = await ctxA.newPage()
    const harnessA = await connect(pageA, info)
    await selectShellIfPickerShowing(pageA)
    await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    const tabAId = (await harnessA.getActiveTabId())!
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'close-race-cli-'))
    const picker = await openPanePicker(pageA)
    await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
    const directoryInput = pageA.getByRole('combobox', { name: /Starting directory/i })
    await expect(directoryInput).toBeVisible({ timeout: 15_000 })
    await directoryInput.fill(markerDir)
    await directoryInput.press('Enter')

    // 3. The panes' identities once the terminal handle has folded in.
    let claudeLeafA: any
    let shellLeafA: any
    let claudeCrIdA = ''
    let shellCrIdA = ''
    await expect(async () => {
      const leaves = leavesOfLayout(await harnessA.getPaneLayout(tabAId))
      claudeLeafA = leaves.find((l) => l.content?.kind === 'terminal' && l.content?.mode === 'claude')
      shellLeafA = leaves.find((l) => l.content?.kind === 'terminal' && l.content?.mode !== 'claude')
      expect(claudeLeafA?.content?.terminalId, "A's claude pane owns a live terminal id").toBeTruthy()
      expect(shellLeafA?.content?.terminalId, "A's shell pane owns a live terminal id").toBeTruthy()
      claudeCrIdA = claudeLeafA?.content?.createRequestId ?? ''
      shellCrIdA = shellLeafA?.content?.createRequestId ?? ''
      expect(claudeCrIdA, "A's claude pane owns its createRequestId").toBeTruthy()
      expect(shellCrIdA, "A's shell pane owns its createRequestId").toBeTruthy()
    }).toPass({ timeout: 15_000 })

    // 4. The socket "dies": flip the gate and close the live socket — the
    //    client's reconnect attempt lands in the black hole, so its sends
    //    QUEUE until the next ready (the finding's disconnected window,
    //    deterministic).
    blockWs = true
    for (const pair of liveSockets.splice(0)) pair.client.close()
    await pageA.waitForFunction(
      () => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() !== 'ready',
      undefined,
      { timeout: 30_000 },
    )

    // 5. THE FINDING'S INTERLEAVE — the close begins while disconnected. The
    //    sent-when-ready observer starts empty: the queued close must reach
    //    the wire ONLY via the reconnect flush, never before (anti-vacuity).
    await harnessA.clearSentWsMessages()
    await pageA
      .locator(`[data-pane-id="${claudeLeafA.id}"][data-context='pane'] button[title='Close pane']`)
      .click()
    // The gate is mid-wait: the pane is STILL DISPLAYED (nothing drops a pane
    // whose close evidence is unconfirmed) and NOTHING of the close has hit
    // the wire.
    await expect(async () => {
      const leaves = leavesOfLayout(await harnessA.getPaneLayout(tabAId))
      expect(leaves.some((l) => l.id === claudeLeafA.id)).toBe(true)
      const queuedOut = (await harnessA.getSentWsMessages()) as Array<Record<string, unknown>>
      expect(
        queuedOut.some((m) => m?.type === 'pane.closed' && m?.createRequestId === claudeCrIdA),
        'the close queues while the socket is down — it must not have reached the wire yet',
      ).toBe(false)
    }).toPass({ timeout: 10_000 })

    // 6. The socket returns: release the black hole so the next reconnect
    //    passthroughs; the queue flushes the close FIRST, then the ready
    //    sweep runs. The ack lands and the pane is removed.
    blockWs = false
    for (const ws of blockedSockets.splice(0)) ws.close()
    await expect(async () => {
      const leaves = leavesOfLayout(await harnessA.getPaneLayout(tabAId))
      expect(
        leaves.some((l) => l.id === claudeLeafA.id),
        'the success ack removed the closed pane (the shell sibling keeps the tab)',
      ).toBe(false)
      expect(leaves.some((l) => l.id === shellLeafA.id)).toBe(true)
    }).toPass({ timeout: 30_000 })

    // 7. THE WIRE PIN (F1): the close flushed; NO pane.opened for the closing
    //    pane ever followed it — the sweep skipped the still-acked-pending
    //    pane. The shell sibling's re-assertion proves the sweep RAN (its
    //    absence would make the pin vacuous).
    const sentOnReconnect = (await harnessA.getSentWsMessages()) as Array<Record<string, unknown>>
    const closeIdx = sentOnReconnect.findIndex(
      (m) => m?.type === 'pane.closed' && m?.createRequestId === claudeCrIdA,
    )
    expect(closeIdx, 'the queued close flushed onto the wire at the reconnect').toBeGreaterThanOrEqual(0)
    const afterClose = sentOnReconnect.slice(closeIdx + 1)
    expect(
      afterClose.some((m) => m?.type === 'pane.opened' && m?.createRequestId === shellCrIdA),
      'anti-vacuity: the ready sweep DID run (the un-pending shell sibling was re-asserted)',
    ).toBe(true)
    expect(
      afterClose.filter((m) => m?.type === 'pane.opened' && m?.createRequestId === claudeCrIdA),
      'no open re-assertion lands behind the flushed close while its ack is outstanding',
    ).toEqual([])

    // 8. AND THE EVIDENCE STANDS (the finding's terminal condition): the
    //    close record the flush committed is never consumed by the sweep —
    //    durable, keyed by the closed pane's createRequestId, kills empty.
    await expect(async () => {
      const dir = path.join(capturedHome, '.freshell', 'pane-ledger', 'close-envelopes')
      const files = await fs.readdir(dir).catch(() => [] as string[])
      let found: any = null
      for (const name of files.filter((f) => f.endsWith('.json'))) {
        const body = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')
        try {
          found = JSON.parse(body)
        } catch {
          continue
        }
        if (found?.createRequestId === claudeCrIdA) break
        found = null
      }
      expect(
        found,
        'the committed close evidence must STAND after the reconnect (never consumed by the ready sweep) '
          + `(looked in ${dir} for createRequestId=${claudeCrIdA})`,
      ).toBeTruthy()
      expect(found.kills ?? [], 'the detach close fences nothing (non-retiring)').toHaveLength(0)
    }).toPass({ timeout: 15_000 })

    await ctxA.close()
    await fs.rm(markerDir, { recursive: true, force: true })
  })
})
