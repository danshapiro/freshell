/**
 * RECONCILE COMPLETION (Lane C2, Task 15) -- e2e proof that the fresh-agent
 * reconcile handshake completes end-to-end with the REAL SPA against the REAL
 * Rust server:
 *
 *   1. fresh-agent restart recovers via reconcile VERDICTS (the boot
 *      reconcile round-trip names the fresh-agent pane; the pane converges on
 *      the SAME durable identity; the happy path never marks the session lost
 *      and never lands a restoreError);
 *   2. two clients resuming one fresh-agent sessionRef spawn exactly ONE
 *      sidecar (the D8 fresh-agent lease + create dedup, proven via the fake
 *      sidecar's request log);
 *   3. a page.reload storm never spawns an identity-less resume (the
 *      pre-verdict create hold: every post-watermark spawn carries the resume
 *      identity; live panes across reloads take attach verdicts -- zero
 *      spawns).
 *
 * Rust-only: registered in RUST_ONLY_SPECS + Rust browser lane testMatch, because
 * this spec imports RustServer directly (restartAbrupt()).
 *
 * Helpers are copied, not imported, per the e2e suite's per-spec-ownership
 * convention (donors: restore-contract-wall-rust.spec.ts,
 * reconcile-client-adoption-rust.spec.ts).
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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CLAUDE_SIDECAR_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')
const FAKE_CLAUDE_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs')

// ---------------------------------------------------------------------------
// Shared helpers (per-spec copies -- see file doc comment)
// ---------------------------------------------------------------------------

/** Copy a fixture into <binDir>/<binName> and make it executable. */
async function installFakeCli(source: string, binName: string, binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, binName)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

/** Read a fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/** True when argv contains the adjacent pair `<flag> <value>` (claude --resume). */
function hasFlagPair(argv: string[], flag: string, value: string): boolean {
  const idx = argv.indexOf(flag)
  return idx >= 0 && argv[idx + 1] === value
}

/**
 * Read the fake claude SIDECAR request log (FAKE_CLAUDE_SIDECAR_LOG,
 * fake-claude-sidecar.mjs: JSONL rows `{pid, t, msg}` -- one per inbound
 * stdio request; `msg.type === 'create'` rows carry `resumeSessionId`).
 */
async function readSidecarLog(
  logPath: string,
): Promise<Array<{ pid: number; t: number; msg: { type?: string; resumeSessionId?: string } }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; t: number; msg: { type?: string; resumeSessionId?: string } })
}

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

/** Force the persistence middleware to write localStorage NOW. */
async function flushPersistence(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
}

/** Idempotent .freshell/config.json seed (setupHome re-runs on every boot). */
function seedSpecConfig(input: {
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
    // Claude provider ROOT so the existence probe can warm (a missing root is
    // an immediate error{provider_unavailable}, not warming) -- donor:
    // reconcile-client-adoption-rust.spec.ts's seedClaudeHome.
    await fs.mkdir(path.join(homeDir, '.claude', 'projects', 'reconcile-completion-proj'), {
      recursive: true,
    })
  }
}

/** Boot an owned RustServer, navigate, and wait for harness + WS. */
async function bootSpec(
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

// --- layout tree walkers (donor: restore-contract-wall-rust.spec.ts) ---

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

function findLeavesByMode(layout: any, mode: string): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === mode)
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

/**
 * The fresh-agent pane's DURABLE identity: sessionRef.sessionId (the
 * provider-durable UUID), NOT content.sessionId -- claude's live handle is a
 * sidecar-minted placeholder that changes on every spawn (the P0.2 wall pin's
 * recorded observation), while the durable ref is what verdict folds and
 * created acks preserve.
 */
async function freshAgentDurableRef(harness: TestHarness, tabId: string): Promise<string | null> {
  const leaf = findFreshAgentLeaf(await harness.getPaneLayout(tabId))
  return leaf?.content?.sessionRef?.sessionId ?? null
}

// --- fresh-agent pane helpers (donor: restore-contract-wall-rust.spec.ts) ---

async function createFreshclaudePane(page: Page, harness: TestHarness, cwd: string): Promise<void> {
  // setAvailableClis is client-only AND gets overwritten by the app bootstrap
  // + /api/platform fetch; callers reach this helper only after
  // harness.waitForConnection(), which is what makes the dispatch land AFTER
  // those overwrites (donor ordering).
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
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
  // NOTE (donor): the Rust router has NO claude snapshot adapter (503), which
  // can surface a history-load-error banner on a healthy fresh pane. Assert
  // pane state via the harness (Redux), never error-free UI chrome.
}

/** Send one chat turn in the last fresh-agent pane and wait for idle. */
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

// --- claude TERMINAL pane helper (donor: reconcile-client-adoption-rust.spec.ts) ---

/**
 * Open a NEW claude terminal pane via the picker and return its leaf plus the
 * pre-allocated session id (the fresh `--session-id` value in the fake CLI's
 * argv log).
 */
async function openClaudePaneAndGetSessionId(
  page: Page,
  harness: TestHarness,
  tabId: string,
  projectDir: string,
  argLogPath: string,
): Promise<string> {
  const beforeIds = new Set(
    findLeavesByMode(await harness.getPaneLayout(tabId), 'claude').map((l) => l.id),
  )
  const sessionIdsBefore = new Set(
    (await readArgvLog(argLogPath))
      .filter((e) => e.argv.includes('--session-id'))
      .map((e) => e.argv[e.argv.indexOf('--session-id') + 1]),
  )
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
  const dirInput = page.getByRole('combobox', { name: /Starting directory for Claude/i })
  await expect(dirInput).toBeVisible({ timeout: 15_000 })
  await dirInput.fill(projectDir)
  await dirInput.press('Enter')

  await expect
    .poll(async () => {
      const layout = await harness.getPaneLayout(tabId)
      const newLeaf = findLeavesByMode(layout, 'claude').find((l) => !beforeIds.has(l.id))
      return newLeaf?.content?.terminalId ? newLeaf.id : null
    }, { timeout: 20_000 })
    .not.toBeNull()

  const sessionId: string = await expect
    .poll(async () => {
      const entries = await readArgvLog(argLogPath)
      const fresh = entries
        .filter((e) => e.argv.includes('--session-id'))
        .map((e) => e.argv[e.argv.indexOf('--session-id') + 1]!)
        .find((id) => id && !sessionIdsBefore.has(id))
      return fresh ?? null
    }, { timeout: 20_000 })
    .not.toBeNull()
    .then(async () => {
      const entries = await readArgvLog(argLogPath)
      return entries
        .filter((e) => e.argv.includes('--session-id'))
        .map((e) => e.argv[e.argv.indexOf('--session-id') + 1]!)
        .find((id) => id && !sessionIdsBefore.has(id))!
    })
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
  return sessionId
}

// --- reconcile-request inspection ---

function isFreshAgentReconcileRequest(m: any): boolean {
  return (
    m?.type === 'pane.reconcile.request'
    && Array.isArray(m?.panes)
    && m.panes.some((p: any) => p?.kind === 'fresh-agent')
  )
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

test.describe('reconcile completion (rust server, real SPA)', () => {
  test.setTimeout(240_000)

  test('fresh-agent restart recovers via reconcile verdicts (no lost-frame on the happy path)', async ({
    page,
  }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-recompl-verdicts-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const sidecarLogPath = path.join(sharedRoot, 'sidecar-requests.jsonl')

    const { server, harness } = await bootSpec(page, {
      env: {
        FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE,
        FAKE_CLAUDE_SIDECAR_LOG: sidecarLogPath,
      },
      setupHome: seedSpecConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshclaudePane(page, harness, projectDir)
      await sendFreshAgentTurn(page, harness, tabId, 'reconcile completion turn')

      // Establish the durable identity (the sessionRef lands with the
      // canonical-UUID cliSessionId from sdk.session.init).
      const identityBefore: string = await expect
        .poll(async () => freshAgentDurableRef(harness, tabId), { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => (await freshAgentDurableRef(harness, tabId))!)

      const sentBefore = (await harness.getSentWsMessages()).filter(isFreshAgentReconcileRequest).length
      await flushPersistence(page)

      await server.restartAbrupt()
      await waitForWsReady(page)

      // (a) the reconcile round-trip happened and named the fresh-agent pane.
      await expect
        .poll(async () => {
          const reqs = (await harness.getSentWsMessages()).filter(isFreshAgentReconcileRequest)
          return reqs.length > sentBefore
        }, { timeout: 30_000 })
        .toBe(true)

      // (b) the pane converged on the SAME durable identity.
      await expect
        .poll(async () => freshAgentDurableRef(harness, tabId), { timeout: 60_000 })
        .toBe(identityBefore)

      // (c) happy path: never marked lost, no restoreError, not wedged.
      const state = await harness.getState()
      expect(
        Object.values(state?.freshAgent?.sessions ?? {}).some((s: any) => s?.lost === true),
        'no fresh-agent session may be marked lost on the verdict happy path',
      ).toBe(false)
      const finalLeaf = findFreshAgentLeaf(await harness.getPaneLayout(tabId))
      expect(finalLeaf?.content?.restoreError).toBeUndefined()
      await expect
        .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
          timeout: 30_000,
        })
        .not.toBe('creating')
      expect(finalLeaf?.content?.status).not.toBe('create-failed')
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('two clients resuming one fresh-agent sessionRef spawn exactly one sidecar', async ({
    page,
  }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-recompl-onesidecar-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const sidecarLogPath = path.join(sharedRoot, 'sidecar-requests.jsonl')

    const { server, info, harness } = await bootSpec(page, {
      env: {
        FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE,
        FAKE_CLAUDE_SIDECAR_LOG: sidecarLogPath,
      },
      setupHome: seedSpecConfig({ providers: ['claude'], freshAgent: true }),
    })
    let pageB: Page | null = null
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshclaudePane(page, harness, projectDir)
      await sendFreshAgentTurn(page, harness, tabId, 'one sidecar turn')
      const identity: string = await expect
        .poll(async () => freshAgentDurableRef(harness, tabId), { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => (await freshAgentDurableRef(harness, tabId))!)
      await flushPersistence(page)

      // Second client in the SAME context (shared localStorage): both pages
      // hydrate the SAME pane, so both fold a verdict for the same sessionRef.
      pageB = await page.context().newPage()
      await pageB.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harnessB = new TestHarness(pageB)
      await harnessB.waitForHarness()
      await harnessB.waitForConnection()

      const watermark = (await readSidecarLog(sidecarLogPath)).length

      await server.restartAbrupt()
      await waitForWsReady(page)
      await waitForWsReady(pageB)

      // Both recovery rounds settle; exactly ONE resume reaches a sidecar.
      const countResumes = async () =>
        (await readSidecarLog(sidecarLogPath))
          .slice(watermark)
          .filter((r) => r.msg?.type === 'create' && r.msg?.resumeSessionId === identity).length
      await expect.poll(countResumes, { timeout: 45_000 }).toBeGreaterThan(0)
      // STABLE-COUNT settle (donor: restore-contract-wall-rust.spec.ts):
      // accept only when two samples >=5s apart agree, so a tail-latency
      // straggler cannot make the count read 1 spuriously.
      await expect
        .poll(
          async () => {
            const first = await countResumes()
            await page.waitForTimeout(5_000)
            const second = await countResumes()
            return second === first ? second : null
          },
          { timeout: 60_000 },
        )
        .not.toBeNull()
      expect(await countResumes()).toBe(1)

      // And both pages' panes settle attached to that identity (no wedge, no
      // duplicate): the durable ref is intact and the pane is not stuck creating.
      for (const [h, label] of [
        [harness, 'page A'],
        [harnessB, 'page B'],
      ] as const) {
        await expect
          .poll(async () => freshAgentDurableRef(h, tabId), { timeout: 60_000 })
          .toBe(identity)
        await expect
          .poll(async () => findFreshAgentLeaf(await h.getPaneLayout(tabId))?.content?.status, {
            timeout: 30_000,
          })
          .not.toBe('creating')
        const leaf = findFreshAgentLeaf(await h.getPaneLayout(tabId))
        expect(leaf?.content?.status, `${label} must not be create-failed`).not.toBe('create-failed')
      }
    } finally {
      await pageB?.close().catch(() => {})
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('page.reload storm never spawns an identity-less resume', async ({
    page,
  }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-recompl-storm-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argvLogPath = path.join(sharedRoot, 'claude-argv.jsonl')
    const sidecarLogPath = path.join(sharedRoot, 'sidecar-requests.jsonl')
    const fakeClaudePath = await installFakeCli(
      FAKE_CLAUDE_CLI_SOURCE,
      'claude',
      path.join(sharedRoot, 'bin'),
    )

    const { server, harness } = await bootSpec(page, {
      env: {
        CLAUDE_CMD: fakeClaudePath,
        FAKE_CLAUDE_ARGV_LOG: argvLogPath,
        FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE,
        FAKE_CLAUDE_SIDECAR_LOG: sidecarLogPath,
      },
      setupHome: seedSpecConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // One claude TERMINAL pane (preallocated --session-id identity) ...
      const terminalSessionId = await openClaudePaneAndGetSessionId(
        page,
        harness,
        tabId,
        projectDir,
        argvLogPath,
      )
      // ... and one freshclaude pane with a durable ref.
      await createFreshclaudePane(page, harness, projectDir)
      await sendFreshAgentTurn(page, harness, tabId, 'storm turn')
      const freshclaudeIdentity: string = await expect
        .poll(async () => freshAgentDurableRef(harness, tabId), { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => (await freshAgentDurableRef(harness, tabId))!)
      await flushPersistence(page)

      const watermarkArgv = (await readArgvLog(argvLogPath)).length
      const watermarkSidecar = (await readSidecarLog(sidecarLogPath)).length

      for (let i = 0; i < 3; i += 1) {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()
        await waitForWsReady(page)
        // Settle: the fresh-agent pane has folded (durable ref intact, not
        // creating) and the terminal pane has a live terminalId again.
        await expect
          .poll(async () => {
            const layout = await harness.getPaneLayout(tabId)
            const fresh = findFreshAgentLeaf(layout)
            const terms = findLeavesByMode(layout, 'claude')
            const freshSettled = Boolean(
              fresh?.content?.sessionRef?.sessionId
              && fresh?.content?.status !== 'creating'
              && fresh?.content?.status !== 'starting',
            )
            const termSettled = terms.length > 0 && terms.every((l) => Boolean(l?.content?.terminalId))
            return freshSettled && termSettled
          }, { timeout: 30_000 })
          .toBe(true)
      }

      // Terminal: every post-watermark spawn row carries `--resume
      // <sessionId>` -- an identity-less row is the non-negotiable failure.
      const spawns = (await readArgvLog(argvLogPath)).slice(watermarkArgv)
      expect(
        spawns.every((e) => hasFlagPair(e.argv, '--resume', terminalSessionId)),
        `identity-less terminal spawn detected: ${JSON.stringify(spawns.map((e) => e.argv))}`,
      ).toBe(true)
      // Attach-verdict happy path: the terminal was LIVE across every reload
      // -- the verdict says attach, not create, so no spawn should exist at
      // all. (If the first run proves one identity-carrying spawn is legal,
      // relax ONLY this count per the plan -- the identity-less check above
      // is the non-negotiable assertion.)
      expect(spawns.length).toBe(0)

      // Fresh-agent: every post-watermark sidecar create carries the resume
      // identity (and on the attach path there should be none at all).
      const creates = (await readSidecarLog(sidecarLogPath))
        .slice(watermarkSidecar)
        .filter((r) => r.msg?.type === 'create')
      expect(
        creates.every((r) => r.msg?.resumeSessionId === freshclaudeIdentity),
        `identity-less fresh-agent create detected: ${JSON.stringify(creates)}`,
      ).toBe(true)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
