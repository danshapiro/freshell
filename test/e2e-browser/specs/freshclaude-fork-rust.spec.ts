/**
 * FRESHCLAUDE / KILROY FORK — PW-RUST e2e (core design §4.5 `handle_fork`, C14;
 * audit G09).
 *
 * Drives the REAL Rust server + real browser UI against the PRODUCTION claude
 * sidecar over the CLI simulator (FRESHELL_CLAUDE_SDK_QUERY_MODULE), which boots
 * like the pinned CLI: a lazy fork (`resume`, `resumeSessionAt`, `forkSession`,
 * `sessionId`) boots with no prompt and writes nothing until its first prompt,
 * which writes the child's transcript with the parent's prefix (line uuids
 * kept) and leaves the parent's untouched (T6).
 *
 *   freshclaude, per-turn fork: "Fork conversation from here" on the first turn
 *     forks the conversation through that turn. The pane switches to the child
 *     the server minted AT ONCE (decision 5: before anything is sent there) and
 *     closes the parent; the simulated CLI booted exactly one fork of the parent
 *     under the child's id; the child shows the parent's first turn only; the
 *     parent's conversation on disk is untouched. A server restart before the
 *     child's first send keeps the child (it boots again from its genesis), and
 *     the child's first send runs under the same id (no re-key).
 *   kilroy, typed /fork: forks the whole conversation (its tip); the child holds
 *     every turn and takes the next prompt under its own id.
 *
 * Every test owns its RustServer. Per-test wall budget: 120s (the cloud e2e
 * budget): the sidecar and the simulator are in-repo, so the spec is
 * cloud-runnable and appears in neither CLOUD_SKIP_SPECS nor CLOUD_SKIP_TITLES.
 *
 * Donors (helpers copied, not imported, per this suite's per-spec-ownership
 * convention): fresh-agent-rollback-rust.spec.ts (the claude lane boot, pane
 * bootstrap, snapshot and simulator-ledger readers, the turn-action hover
 * idiom).
 */
import fs from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import {
  RustServer,
  GEMINI_STRIP_ENV_PREFIXES,
} from '../helpers/rust-server.js'
import type { E2eServerInfo as TestServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// The production claude sidecar and the CLI simulator it loads through its
// FRESHELL_CLAUDE_SDK_QUERY_MODULE seam (both in the cloud image's source tree;
// the simulator needs no CLI binary and no network).
const CLAUDE_SIDECAR = path.resolve(__dirname, '../../../crates/freshell-claude-sidecar/index.mjs')
const CLAUDE_CLI_SIMULATOR = path.resolve(__dirname, '../../fixtures/claude-cli-sim/query.mjs')

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ── Copied helpers (donor: fresh-agent-rollback-rust.spec.ts) ───────────────

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

function seedWallConfig(): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: {
            codingCli: { enabledProviders: ['claude'] },
            freshAgent: { enabled: true },
          },
        },
        null,
        2,
      ),
    )
  }
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

function readJsonl(filePath: string): any[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((row) => row !== null)
}

/** Direct REST snapshot read — the route every card renders from. */
async function fetchSnapshot(
  info: TestServerInfo,
  sessionType: string,
  threadId: string,
): Promise<any | null> {
  const res = await fetch(
    `${info.baseUrl}/api/fresh-agent/threads/${sessionType}/claude/${encodeURIComponent(threadId)}`,
    { headers: { 'x-auth-token': info.token } },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function enableClaude(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true },
    })
  })
}

async function createFreshAgentPane(page: Page, name: RegExp, label: string, cwd: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name }).click({ force: true })
  const directoryInput = page.getByLabel(new RegExp(`^Starting directory for ${label}$`, 'i'))
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
}

async function paneLeaf(harness: TestHarness, tabId: string): Promise<any> {
  return findFreshAgentLeaf(await harness.getPaneLayout(tabId))
}

async function waitForPaneStatus(
  harness: TestHarness,
  tabId: string,
  wanted: string | string[],
  timeoutMs = 30_000,
): Promise<void> {
  const wantedSet = Array.isArray(wanted) ? wanted : [wanted]
  await expect
    .poll(
      async () => {
        const status = (await paneLeaf(harness, tabId))?.content?.status ?? null
        return typeof status === 'string' && wantedSet.includes(status)
      },
      { timeout: timeoutMs },
    )
    .toBe(true)
}

function paneRoot(page: Page) {
  return page.locator('[data-context="fresh-agent"]').last()
}

function composerLocator(page: Page) {
  return paneRoot(page).getByRole('textbox', { name: 'Chat message input' })
}

/** Fill the visible fresh-agent composer and click Send. */
async function sendComposerText(page: Page, text: string): Promise<void> {
  await composerLocator(page).fill(text)
  await paneRoot(page).getByRole('button', { name: 'Send' }).click()
}

/** Type a slash command into the composer and commit it with Enter. */
async function typeSlash(page: Page, text: string): Promise<void> {
  const composer = composerLocator(page)
  await composer.fill(text)
  await composer.press('Enter')
}

/** Capture the pane's durable sessionRef id once it exists. */
async function captureDurableId(harness: TestHarness, tabId: string): Promise<string> {
  let captured = ''
  await expect
    .poll(
      async () => {
        captured = (await paneLeaf(harness, tabId))?.content?.sessionRef?.sessionId ?? ''
        return captured
      },
      { timeout: 15_000 },
    )
    .toMatch(CANONICAL_UUID_RE)
  return captured
}

/** Count of USER-role rows in a fresh-agent snapshot (null snapshot ⇒ 0). */
function userRows(snapshot: any | null): number {
  return ((snapshot?.turns ?? []) as any[]).filter((turn) => turn?.role === 'user').length
}

/**
 * The `query()` options of every conversation the simulated CLI booted, in
 * order (its ledger's `query` rows); a fork carries `resume`,
 * `resumeSessionAt`, `forkSession` and the minted `sessionId`.
 */
function simForks(simLedger: string): any[] {
  return readJsonl(simLedger)
    .filter((row) => row.kind === 'query')
    .map((row) => row.options ?? {})
    .filter((options) => options.forkSession === true)
}

/** The prompts the simulated CLI received, in order. */
function simPrompts(simLedger: string): any[] {
  return readJsonl(simLedger).filter((row) => row.kind === 'prompt')
}

// ── Lane-specific helpers ────────────────────────────────────────────────────

/** `<id>.jsonl` under the server home's `.claude/projects` tree, once written. */
function findTranscript(homeDir: string, sessionId: string): string | null {
  const projects = path.join(homeDir, '.claude', 'projects')
  if (!existsSync(projects)) return null
  for (const project of readdirSync(projects)) {
    const candidate = path.join(projects, project, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** The conversation lines (those with a uuid) of a transcript, as JSON text. */
function chainLines(file: string): string[] {
  return readJsonl(file)
    .filter((line) => typeof line.uuid === 'string')
    .map((line) => JSON.stringify(line))
}

/**
 * Wait until the CLIENT's snapshot carries the fork capability: the per-turn
 * "Fork conversation from here" action renders exactly when
 * `capabilities.fork === true`, the same truth the /fork menu entry consults.
 */
async function waitForForkCapability(page: Page): Promise<void> {
  const article = paneRoot(page).locator('article[data-turn-role="user"]').first()
  await article.hover()
  await expect(
    article.getByRole('button', { name: 'Fork conversation from here' }),
    'the client-side fork capability stamp landed (fork action renders)',
  ).toBeVisible({ timeout: 15_000 })
  await page.mouse.move(0, 0)
}

/** Boot the claude lane: create a freshclaude/kilroy pane on an owned server. */
async function bootClaudeLane(
  page: Page,
  flavour: 'freshclaude' | 'kilroy',
  extraEnv: Record<string, string> = {},
): Promise<{
  server: RustServer
  info: TestServerInfo
  harness: TestHarness
  sharedRoot: string
  simLedger: string
  tabId: string
}> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), `freshell-fork-${flavour}-`))
  try {
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const simLedger = path.join(sharedRoot, 'claude-sim-ledger.jsonl')
    const server = new RustServer({
      env: {
        FRESHELL_CLAUDE_SIDECAR: CLAUDE_SIDECAR,
        FRESHELL_CLAUDE_NODE: process.execPath,
        FRESHELL_CLAUDE_SDK_QUERY_MODULE: CLAUDE_CLI_SIMULATOR,
        FRESHELL_CLAUDE_SIM_LEDGER: simLedger,
        ...extraEnv,
      },
      // Kilroy parity includes independence from Gemini-summary availability.
      stripEnvPrefixes: flavour === 'kilroy' ? [...GEMINI_STRIP_ENV_PREFIXES] : undefined,
      setupHome: seedWallConfig(),
    })
    const info = await server.start()
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await selectShellIfPickerShowing(page)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await enableClaude(page)
    const tabId = (await harness.getActiveTabId())!
    expect(tabId).toBeTruthy()
    await createFreshAgentPane(
      page,
      flavour === 'kilroy' ? /^Kilroy$/ : /^Freshclaude$/,
      flavour === 'kilroy' ? 'Kilroy' : 'Freshclaude',
      projectDir,
    )
    return { server, info, harness, sharedRoot, simLedger, tabId }
  } catch (error) {
    await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Two finished turns on the lane's pane: the parent's durable id. */
async function twoTurns(
  page: Page,
  lane: Awaited<ReturnType<typeof bootClaudeLane>>,
  sessionType: 'freshclaude' | 'kilroy',
): Promise<string> {
  // A booted pane is `connected` until its first turn settles it `idle`.
  await waitForPaneStatus(lane.harness, lane.tabId, ['idle', 'connected'])
  await sendComposerText(page, 'prompt one')
  const parent = await captureDurableId(lane.harness, lane.tabId)
  await expect
    .poll(async () => userRows(await fetchSnapshot(lane.info, sessionType, parent)), { timeout: 15_000 })
    .toBe(1)
  await sendComposerText(page, 'prompt two')
  await expect
    .poll(async () => userRows(await fetchSnapshot(lane.info, sessionType, parent)), { timeout: 15_000 })
    .toBe(2)
  await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
  // The CLI writes each transcript line a moment after its SDK frame: wait for
  // the second answer on disk, so the parent's conversation is complete.
  await expect
    .poll(() => {
      const file = findTranscript(lane.info.homeDir, parent)
      if (!file) return false
      const lines = readJsonl(file).filter((line) => typeof line.uuid === 'string')
      const prompt = lines.findIndex((line) => line.type === 'user'
        && JSON.stringify(line.message ?? '').includes('prompt two'))
      return prompt >= 0 && lines.slice(prompt).some((line) => line.type === 'assistant')
    }, { timeout: 15_000, message: 'the second turn reached the parent transcript' })
    .toBe(true)
  await waitForForkCapability(page)
  return parent
}

test.describe('freshclaude/kilroy fork (core design §4.5, C14)', () => {
  test('freshclaude: fork from a turn opens the child at once, survives a restart, and its first send keeps its id', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'freshclaude')
    try {
      const parent = await twoTurns(page, lane, 'freshclaude')
      const parentPaneId = (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionId as string
      const parentFile = findTranscript(lane.info.homeDir, parent)
      expect(parentFile, 'the parent transcript is on disk').toBeTruthy()
      const parentBefore = chainLines(parentFile!)
      await lane.harness.clearSentWsMessages()

      // The first turn's real hover affordance.
      const firstTurn = paneRoot(page).locator('article[data-turn-role="user"]').first()
      await firstTurn.hover()
      await firstTurn.getByRole('button', { name: 'Fork conversation from here' }).click()

      // Decision 5: the pane switches to the child the server minted as soon as
      // the fork answers, before anything is sent there.
      await expect
        .poll(async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId ?? '', { timeout: 30_000 })
        .not.toBe(parent)
      const child = (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId as string
      expect(child).toMatch(CANONICAL_UUID_RE)
      expect((await paneLeaf(lane.harness, lane.tabId))?.content?.sessionId).toBe(child)
      expect(simPrompts(lane.simLedger), 'nothing was sent to the child yet').toHaveLength(2)

      // Exactly one fork boot: the parent through its first turn, under the
      // child's id, with no drops-turn guard (a fork discards nothing).
      const forks = simForks(lane.simLedger)
      expect(forks).toHaveLength(1)
      expect(forks[0].resume).toBe(parent)
      expect(typeof forks[0].resumeSessionAt).toBe('string')
      expect(forks[0].sessionId).toBe(child)
      expect(forks[0].resumeDropsTurn).toBeUndefined()

      // The child shows the parent's first turn only, in the pane and over REST.
      await expect(paneRoot(page).locator('article[data-turn-role="user"]')).toHaveCount(1, { timeout: 15_000 })
      expect(userRows(await fetchSnapshot(lane.info, 'freshclaude', child))).toBe(1)

      // The pane closed the parent itself; the fork wrote nothing to it.
      await expect
        .poll(async () => ((await lane.harness.getSentWsMessages()) as any[])
          .filter((m) => m?.type === 'freshAgent.kill' && m?.sessionId === parentPaneId).length,
        { timeout: 15_000, message: 'the client closed the parent after switching to the child' })
        .toBe(1)
      expect(chainLines(parentFile!)).toEqual(parentBefore)

      // A restart before the child's first send keeps the child: it boots again
      // from its genesis (a second fork boot under the child's id).
      await lane.server.restart()
      await lane.harness.waitForConnection()
      await expect(paneRoot(page).locator('article[data-turn-role="user"]')).toHaveCount(1, { timeout: 30_000 })
      await expect
        .poll(() => simForks(lane.simLedger).filter((f) => f.sessionId === child).length, { timeout: 30_000 })
        .toBe(2)
      expect(simForks(lane.simLedger).filter((f) => f.sessionId === child)[1].resume).toBe(parent)
      await waitForPaneStatus(lane.harness, lane.tabId, ['idle', 'connected'])

      // The child's first send runs under the same id: no re-key.
      await sendComposerText(page, 'prompt after the fork')
      await expect
        .poll(async () => userRows(await fetchSnapshot(lane.info, 'freshclaude', child)), { timeout: 15_000 })
        .toBe(2)
      expect((await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId).toBe(child)
      const childPrompt = simPrompts(lane.simLedger).find((row) => row.text === 'prompt after the fork')
      expect(childPrompt?.sessionId).toBe(child)
      await expect.poll(() => findTranscript(lane.info.homeDir, child), { timeout: 15_000 }).toBeTruthy()
      const childLines = chainLines(findTranscript(lane.info.homeDir, child)!)
      expect(JSON.parse(childLines[0]).uuid, 'the child keeps the parent line uuids').toBe(JSON.parse(parentBefore[0]).uuid)
      expect(chainLines(parentFile!), 'the child turn wrote nothing to the parent').toEqual(parentBefore)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('kilroy: typed /fork forks the whole conversation and the child takes the next prompt under its own id', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'kilroy', { KILROY_ENABLED: '1' })
    try {
      const parent = await twoTurns(page, lane, 'kilroy')
      const parentFile = findTranscript(lane.info.homeDir, parent)
      expect(parentFile, 'the parent transcript is on disk').toBeTruthy()
      const parentBefore = chainLines(parentFile!)
      const parentUuids = parentBefore.map((line) => JSON.parse(line).uuid)

      await typeSlash(page, '/fork')

      await expect
        .poll(async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId ?? '', { timeout: 30_000 })
        .not.toBe(parent)
      const child = (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId as string
      expect(child).toMatch(CANONICAL_UUID_RE)
      const forks = simForks(lane.simLedger)
      expect(forks).toHaveLength(1)
      expect(forks[0].resume).toBe(parent)
      expect(parentUuids, 'the fork point is a line of the parent').toContain(forks[0].resumeSessionAt)
      expect(forks[0].sessionId).toBe(child)
      expect(userRows(await fetchSnapshot(lane.info, 'kilroy', child)), 'a tip fork keeps the whole conversation').toBe(2)
      await expect(paneRoot(page).locator('article[data-turn-role="user"]')).toHaveCount(2, { timeout: 15_000 })

      await waitForPaneStatus(lane.harness, lane.tabId, ['idle', 'connected'])
      await sendComposerText(page, 'kilroy after the fork')
      await expect
        .poll(async () => userRows(await fetchSnapshot(lane.info, 'kilroy', child)), { timeout: 15_000 })
        .toBe(3)
      expect((await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId).toBe(child)
      expect(chainLines(parentFile!), 'the parent conversation is untouched').toEqual(parentBefore)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
