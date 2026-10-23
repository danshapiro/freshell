// A browser lane for freshclaude and kilroy panes on the PRODUCTION Claude
// sidecar (crates/freshell-claude-sidecar/index.mjs) over the Claude CLI
// simulator (test/fixtures/claude-cli-sim), loaded through the sidecar's
// FRESHELL_CLAUDE_SDK_QUERY_MODULE seam (transcript-live plan E1).
//
// The simulator stands in for the pinned Claude CLI 2.1.237 and is kept
// conformant by test/integration/providers/claude-cli-conformance.ts. A lane
// scripts the model's side of its turns with a simulator program (the rule
// language of test/fixtures/claude-cli-sim/program.mjs) or the shared prompt
// markers, so a spec drives real sidecar frames, real transcript files and
// the real Rust server with no CLI binary and no network: cloud-legal.
//
// Each lane owns its server, browser context and temp root; `stop()` releases
// all three (call it in `finally`).

import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Locator, Page, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'
import { createFreshE2ePage } from './fixtures.js'
import { openPanePicker } from './pane-picker.js'
import { installRecoveryOfferAutoDeclineOnContext } from './recovery-offer.js'
import { RustServer } from './rust-server.js'
import type { E2eServerInfo } from './server-fixture-support.js'
import { TestHarness } from './test-harness.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** The production sidecar the Rust server launches for claude panes. */
export const CLAUDE_SIDECAR = path.resolve(__dirname, '../../../crates/freshell-claude-sidecar/index.mjs')
/** The CLI simulator's `query()` module. */
export const CLAUDE_CLI_SIMULATOR = path.resolve(__dirname, '../../fixtures/claude-cli-sim/query.mjs')

export type ClaudeSimFlavour = 'freshclaude' | 'kilroy'

/** One program emission (see test/fixtures/claude-cli-sim/program.mjs for the kinds). */
export type ClaudeSimEmission = { kind: string, delayMs?: number, data?: Record<string, unknown> }
export type ClaudeSimRule = { on: string, match?: Record<string, unknown>, once?: boolean, emit: ClaudeSimEmission[] }
export type ClaudeSimProgram = { rules: ClaudeSimRule[] }

/** A rule that answers the prompt `text` (exactly) with `emit`. */
export function onPrompt(text: string, emit: ClaudeSimEmission[]): ClaudeSimRule {
  return { on: 'msg:prompt', match: { text }, emit }
}

export interface ClaudeSimLaneOptions {
  flavour: ClaudeSimFlavour
  /** The model's side of matching prompts; other prompts follow the prompt markers. */
  program?: ClaudeSimProgram
  /** Saved provider defaults for this flavour (`settings.freshAgent.providers.<flavour>`). */
  providerDefaults?: Record<string, unknown>
  /** Prepare the pane's workspace (for example a git repository) before the server starts. */
  setupWorkspace?: (workspace: string) => Promise<void>
  /** Extra server environment (it reaches the sidecar and the simulator). */
  env?: Record<string, string>
}

/** A row of the simulator's ledger (FRESHELL_CLAUDE_SIM_LEDGER). */
export type ClaudeSimLedgerRow = { kind: string, [key: string]: unknown }

export interface ClaudeSimPane {
  paneRoot: Locator
  tabId: string
  paneId: string
}

export class ClaudeSimLane {
  private constructor(
    readonly flavour: ClaudeSimFlavour,
    readonly server: RustServer,
    readonly info: E2eServerInfo,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly harness: TestHarness,
    /** The pane's working directory. */
    readonly workspace: string,
    private readonly root: string,
    private readonly ledgerPath: string,
  ) {}

  /** Start a server on the production sidecar over the simulator and open a page on it. */
  static async start(browser: Browser, options: ClaudeSimLaneOptions): Promise<ClaudeSimLane> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `freshell-claude-sim-${options.flavour}-`))
    const workspace = path.join(root, 'workspace')
    const ledgerPath = path.join(root, 'claude-sim-ledger.jsonl')
    let server: RustServer | undefined
    let context: BrowserContext | undefined
    try {
      await fs.mkdir(workspace, { recursive: true })
      await options.setupWorkspace?.(workspace)
      server = new RustServer({
        verbose: process.env.FRESHELL_E2E_SERVER_VERBOSE === '1',
        env: {
          FRESHELL_CLAUDE_SIDECAR: CLAUDE_SIDECAR,
          FRESHELL_CLAUDE_NODE: process.execPath,
          FRESHELL_CLAUDE_SDK_QUERY_MODULE: CLAUDE_CLI_SIMULATOR,
          FRESHELL_CLAUDE_SIM_LEDGER: ledgerPath,
          ...(options.program ? { FRESHELL_CLAUDE_SIM_PROGRAM: JSON.stringify(options.program) } : {}),
          // Kilroy is behind its feature flag.
          ...(options.flavour === 'kilroy' ? { KILROY_ENABLED: '1' } : {}),
          ...options.env,
        },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: {
              codingCli: { enabledProviders: ['claude'] },
              freshAgent: {
                enabled: true,
                ...(options.providerDefaults ? { providers: { [options.flavour]: options.providerDefaults } } : {}),
              },
            },
          }, null, 2))
        },
      })
      const info = await server.start()
      const owned = await createFreshE2ePage(browser, info)
      context = owned.context
      installRecoveryOfferAutoDeclineOnContext(context)
      const { page } = owned
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      return new ClaudeSimLane(options.flavour, server, info, context, page, harness, workspace, root, ledgerPath)
    } catch (error) {
      await context?.close().catch(() => {})
      await server?.stop().catch(() => {})
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  /** The pane's accessible name in the pane picker. */
  get label(): string {
    return this.flavour === 'kilroy' ? 'Kilroy' : 'Freshclaude'
  }

  /**
   * Open a pane of the lane's flavour on the boot tab, in the lane's
   * workspace, and wait until it can take a first message.
   */
  async openPane(): Promise<ClaudeSimPane> {
    const { page, harness } = this
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'connection/setAvailableClis',
        payload: { claude: true },
      })
    })
    const picker = await openPanePicker(page)
    await picker.getByRole('button', { name: new RegExp(`^${this.label}$`, 'i') }).click({ force: true })
    const directoryInput = page.getByLabel(new RegExp(`^Starting directory for ${this.label}$`, 'i'))
    await expect(directoryInput).toBeVisible({ timeout: 15_000 })
    await directoryInput.fill(this.workspace)
    await directoryInput.press('Enter')

    const paneRoot = page.locator('[data-context="fresh-agent"]').last()
    await expect(paneRoot).toBeVisible({ timeout: 15_000 })
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    let paneId = ''
    await expect.poll(async () => {
      paneId = freshAgentLeaf(await harness.getPaneLayout(tabId!))?.id ?? ''
      return paneId
    }, { timeout: 15_000, message: 'the fresh-agent pane is in the layout' }).not.toBe('')
    const pane = { paneRoot, tabId: tabId!, paneId }
    // The CLI reports no session until a prompt (T1): a new pane is
    // `connected` until its first turn.
    await expect.poll(() => this.paneStatus(pane), { timeout: 30_000, message: 'the new pane is ready to send' })
      .toMatch(/^(connected|idle)$/)
    return pane
  }

  /** The pane's status as its layout records it. */
  async paneStatus(pane: ClaudeSimPane): Promise<string | null> {
    return freshAgentLeaf(await this.harness.getPaneLayout(pane.tabId))?.content?.status ?? null
  }

  /**
   * Type `text` into the pane's composer, press Send, and wait until the
   * simulated CLI starts that prompt (a pane is not busy while it saves its
   * code checkpoint before the send, so "busy" alone cannot tell a turn that
   * has not started from one that has ended).
   */
  async send(pane: ClaudeSimPane, text: string): Promise<void> {
    const started = () => this.ledger().filter((row) => row.kind === 'prompt' && row.text === text).length
    const before = started()
    const composer = pane.paneRoot.getByRole('textbox', { name: 'Chat message input' })
    await composer.fill(text)
    await pane.paneRoot.getByRole('button', { name: 'Send' }).click()
    await expect.poll(started, { timeout: 30_000, message: `the CLI starts the prompt ${JSON.stringify(text)}` }).toBe(before + 1)
  }

  /** Wait until the pane's turn is over: Send is back and the pane is idle. */
  async waitForIdle(pane: ClaudeSimPane, timeout = 30_000): Promise<void> {
    await expect(pane.paneRoot.getByRole('button', { name: 'Stop' })).toBeHidden({ timeout })
    await expect.poll(() => this.paneStatus(pane), { timeout, message: 'the pane returns to idle' }).toBe('idle')
  }

  /** What the simulated CLI recorded so far (its ledger). */
  ledger(): ClaudeSimLedgerRow[] {
    if (!existsSync(this.ledgerPath)) return []
    return readFileSync(this.ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ClaudeSimLedgerRow]
        } catch {
          return []
        }
      })
  }

  /** Attach the server's output to a failed test's report. */
  async attachLogsOnFailure(testInfo: TestInfo): Promise<void> {
    if (testInfo.status === testInfo.expectedStatus) return
    const { stdout, stderr } = this.server.capturedOutput()
    await testInfo.attach('rust-server-stderr', { body: stderr, contentType: 'text/plain' }).catch(() => {})
    await testInfo.attach('rust-server-stdout', { body: stdout, contentType: 'text/plain' }).catch(() => {})
  }

  /** Close the page's context, stop the server and remove the lane's files. */
  async stop(): Promise<void> {
    await this.context.close().catch(() => {})
    await this.server.stop().catch(() => {})
    await fs.rm(this.root, { recursive: true, force: true }).catch(() => {})
  }
}

/** The first fresh-agent leaf of a pane layout. */
export function freshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = freshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

/** Per pattern: what a text census saw over the frames it watched. */
export type TextCensusEntry = {
  /** The most matches any one frame showed. */
  max: number
  /** Frames in which the pattern matched. */
  framesSeen: number
  /** Frames with no match after a frame that had one. */
  framesMissingAfterSeen: number
  /** Every distinct matched text, in the order first seen. */
  matches: string[]
}
export type TextCensus = { frames: number, entries: Record<string, TextCensusEntry> }

/**
 * Watch what the last fresh-agent pane shows, every animation frame, until
 * `stopPaneTextCensus`: per named pattern (a regular expression source,
 * matched globally against the pane's rendered text), how many matches each
 * frame had. Frame-level evidence for "on screen exactly once, with no gap"
 * and for rows that show only briefly.
 */
export async function startPaneTextCensus(page: Page, patterns: Record<string, string>): Promise<void> {
  await page.evaluate((sources) => {
    type Entry = { max: number, framesSeen: number, framesMissingAfterSeen: number, matches: string[] }
    const census = { frames: 0, entries: {} as Record<string, Entry>, running: true }
    for (const name of Object.keys(sources)) census.entries[name] = { max: 0, framesSeen: 0, framesMissingAfterSeen: 0, matches: [] }
    ;(window as any).__freshellPaneTextCensus = census
    const tick = () => {
      if (!census.running) return
      const panes = document.querySelectorAll<HTMLElement>('[data-context="fresh-agent"]')
      const text = panes[panes.length - 1]?.innerText ?? ''
      census.frames += 1
      for (const [name, source] of Object.entries(sources)) {
        const entry = census.entries[name]
        const found = text.match(new RegExp(source, 'g')) ?? []
        entry.max = Math.max(entry.max, found.length)
        if (found.length > 0) entry.framesSeen += 1
        else if (entry.framesSeen > 0) entry.framesMissingAfterSeen += 1
        for (const match of found) if (!entry.matches.includes(match)) entry.matches.push(match)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, patterns)
}

export async function stopPaneTextCensus(page: Page): Promise<TextCensus> {
  return page.evaluate(() => {
    const census = (window as any).__freshellPaneTextCensus
    census.running = false
    return { frames: census.frames, entries: census.entries }
  })
}
