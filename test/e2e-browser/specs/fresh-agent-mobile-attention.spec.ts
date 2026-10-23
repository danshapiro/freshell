/**
 * MOBILE NEEDS-ATTENTION MARKS (G17) — PW-RUST e2e at phone width (390×844).
 *
 * On a phone TabBar renders only the MobileTabStrip and the TabSwitcher.
 * Both must show the same needs-attention mark as the desktop tab strip when
 * a fresh-agent turn ends (or starts waiting on an approval) in a tab the
 * user is not looking at:
 *   1. a turn ending in a BACKGROUND tab → the strip's status reads
 *      "1 other tab needs attention" and the Previous-tab chevron is
 *      described as pointing at it;
 *   2. the tab switcher's card for that tab is named "…, needs attention";
 *      tapping it activates the tab and (click dismiss mode, the default)
 *      clears the attention;
 *   3. an approval wait raised while the user is in another tab (the
 *      `waiting` edge) produces the same mark.
 *
 * The pane is a real Freshclaude pane on the real Rust server, driven by the
 * production Claude sidecar over the CLI simulator. Every mark comes from a
 * real simulated CLI turn: the composer sends the prompt, the Rust server
 * forwards it to the sidecar, the simulator ends the turn (or asks for an
 * approval through canUseTool), the
 * server emits the `freshAgent.turn.complete` / `freshAgent.turn.waiting`
 * edge, and the client's production fold puts the mark on the mobile strip
 * and switcher. So this spec covers "server edge → mobile mark" end to end;
 * nothing here injects a WS frame. Each step also checks the edge on the
 * simulator ledger and on the client's received WS frames, so a failure says
 * which hop broke.
 *
 * CLOUD-LEGALITY: the only timing is the simulator's lane-controlled `delayMs`
 * before the scripted emission (the same pattern as
 * fresh-agent-error-turn-attention.spec.ts): it gives the spec a bounded
 * window to move to the other tab BEFORE the turn ends. If that move were
 * ever late, the ending would be WATCHED and the spec fails loudly on the
 * "no watched mark" check instead of passing by accident. Every other wait
 * is a poll on observed state. This spec must NOT be added to
 * CLOUD_SKIP_SPECS.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { claudeSimulatorServerEnv, readClaudeSimLedger } from '../helpers/claude-sim-lane.js'

const BACKGROUND_TURN = 'BACKGROUND_TURN'
const BACKGROUND_APPROVAL = 'BACKGROUND_APPROVAL'
/**
 * Deterministic CLI simulator program. Each scripted emission waits 3 s after
 * the CLI receives the prompt, so the user is in the other tab when the
 * turn ends or the approval is raised.
 */
const SIMULATOR_PROGRAM = {
  rules: [
    {
      on: 'msg:prompt',
      match: { text: BACKGROUND_TURN },
      emit: [
        {
          kind: 'completion',
          data: { subtype: 'success', text: 'The simulated turn finished while the user was away.' },
          delayMs: 3_000,
        },
      ],
    },
    {
      // The approval parks the turn (no completion follows) and the server
      // mints the waiting edge on the 0→1 pending transition.
      on: 'msg:prompt',
      match: { text: BACKGROUND_APPROVAL },
      emit: [
        {
          kind: 'approval',
          data: { id: 'toolu-mobile-background', tool: 'Bash', input: { command: 'echo mobile-background' } },
          delayMs: 3_000,
        },
      ],
    },
  ],
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

async function receivedFreshAgentEvents(harness: TestHarness, eventType: string): Promise<any[]> {
  const received = (await harness.getReceivedWsMessages()) as any[]
  return received.filter((msg) => msg?.type === 'freshAgent.event' && msg?.event?.type === eventType)
}

test.describe('mobile tab surfaces show needs-attention marks (G17)', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test.setTimeout(180_000)

  test('background turn endings and approvals mark the mobile strip and switcher; a tap dismisses', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-mobile-attention-'))
    const simLedger = path.join(sharedRoot, 'claude-sim-ledger.jsonl')
    let server: RustServer | undefined
    try {
      const projectDir = path.join(sharedRoot, 'project')
      await fs.mkdir(projectDir, { recursive: true })
      server = new RustServer({
        env: claudeSimulatorServerEnv({ ledgerPath: simLedger, program: SIMULATOR_PROGRAM }),
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: {
              codingCli: { enabledProviders: ['claude'] },
              freshAgent: { enabled: true },
            },
          }, null, 2))
        },
      })
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()

      // The mobile layout: the strip replaces the desktop tab bar.
      const switcherButton = page.getByRole('button', { name: 'Open tab switcher' })
      await expect(switcherButton).toBeVisible({ timeout: 15_000 })

      // Tab A: a Freshclaude pane replaces the boot tab's pane picker.
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'connection/setAvailableClis',
          payload: { claude: true },
        })
      })
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
      const directoryInput = page.getByLabel(/^Starting directory for Freshclaude$/i)
      await expect(directoryInput).toBeVisible({ timeout: 15_000 })
      await directoryInput.fill(projectDir)
      await directoryInput.press('Enter')

      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await expect(paneRoot).toBeVisible({ timeout: 15_000 })
      const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
      const sendButton = paneRoot.getByRole('button', { name: 'Send' })

      const tabA = (await harness.getActiveTabId())!
      expect(tabA).toBeTruthy()
      const paneStatus = () => expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout)?.content?.status ?? null
      }, { timeout: 30_000 })
      // The pane is ready to take a turn once it has its durable session id.
      await expect
        .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabA))?.content?.sessionRef?.sessionId ?? '', {
          timeout: 30_000,
        })
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      await paneStatus().toMatch(/^(connected|idle)$/)

      const turnCompletionState = () => harness.getState().then((s: any) => s?.turnCompletion ?? {})
      expect((await turnCompletionState()).seq ?? 0).toBe(0)

      // The strip's "other tabs" count is a polite live region that stays
      // mounted (empty while nothing else is marked); its label is its text.
      const otherTabsStatus = page.getByRole('status').filter({ hasText: '1 other tab needs attention' })
      const anyOtherTabsStatus = page.getByRole('status').filter({ hasText: /other tabs? needs? attention/ })
      const previousTab = page.getByRole('button', { name: 'Previous tab' })

      // ── 1. A turn ends in a BACKGROUND tab ─────────────────────────────────
      // Send, then (inside the simulator's 3 s window) open a new tab with the
      // strip's right action — tab A is the last tab, so it reads "New tab".
      await composer.fill(BACKGROUND_TURN)
      await sendButton.click()
      await page.getByRole('button', { name: 'New tab' }).click()
      await harness.waitForTabCount(2)
      const tabB = (await harness.getActiveTabId())!
      expect(tabB).not.toBe(tabA)

      await expect
        .poll(async () => (await turnCompletionState()).seq ?? 0, {
          timeout: 30_000,
          message: 'the background turn ending rings exactly one event (seq 1)',
        })
        .toBe(1)
      const endedState = await turnCompletionState()
      expect(endedState.attentionByTab?.[tabA], 'the background turn ending marks tab A').toBe(true)
      expect(
        endedState.watchedCompletionByTab?.[tabA],
        'the turn ended while the user was in tab B (a watched mark means the tab move was late)',
      ).toBeUndefined()
      expect(
        readClaudeSimLedger(simLedger).filter((row) => row.kind === 'completion' && row.data?.subtype === 'success'),
        'the simulated CLI completed the first turn successfully',
      ).toHaveLength(1)
      expect(
        await receivedFreshAgentEvents(harness, 'freshAgent.turn.complete'),
        'the server sent exactly one turn-complete edge to the client',
      ).toHaveLength(1)
      await paneStatus().toBe('idle')

      await expect(otherTabsStatus, 'the strip counts the other tab that needs attention').toBeVisible()
      await expect(previousTab, 'the Previous chevron points at the marked tab').toHaveAccessibleDescription(
        'An earlier tab needs attention',
      )

      // ── 2. The switcher card is marked; tapping it activates and dismisses ─
      await switcherButton.click()
      const markedCard = page.getByRole('button', { name: /^Switch to .*, needs attention$/ })
      await expect(markedCard).toHaveCount(1)
      await expect(markedCard).toBeVisible()
      await expect(markedCard).toContainText('Needs attention')
      await markedCard.click()

      await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabA)
      await expect
        .poll(async () => Object.keys((await turnCompletionState()).attentionByTab ?? {}), {
          timeout: 10_000,
          message: 'tapping the card clears the tab attention (click mode)',
        })
        .toEqual([])
      await expect(anyOtherTabsStatus).toHaveCount(0)
      await expect(previousTab).toHaveAccessibleDescription('')

      // ── 3. An approval wait raised while the user is in another tab ───────
      // Send from tab A, then move to tab B inside the 3 s window. Tab A is
      // first of two now: the strip's right action is "Next tab".
      await composer.fill(BACKGROUND_APPROVAL)
      await sendButton.click()
      await page.getByRole('button', { name: 'Next tab' }).click()
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabB)

      await expect
        .poll(async () => (await turnCompletionState()).seq ?? 0, {
          timeout: 30_000,
          message: 'the approval waiting edge rings exactly one more event (seq 2)',
        })
        .toBe(2)
      const waitingState = await turnCompletionState()
      expect(waitingState.attentionByTab?.[tabA], 'the approval waiting edge marks the background tab').toBe(true)
      expect(
        waitingState.watchedCompletionByTab?.[tabA],
        'the approval was raised while the user was in tab B',
      ).toBeUndefined()
      expect(
        readClaudeSimLedger(simLedger).filter((row) => row.kind === 'approval'),
        'the simulated CLI made one real approval request',
      ).toHaveLength(1)
      expect(
        await receivedFreshAgentEvents(harness, 'freshAgent.permission.request'),
        'the production sidecar forwarded the approval request to the client',
      ).toHaveLength(1)
      expect(
        await receivedFreshAgentEvents(harness, 'freshAgent.turn.waiting'),
        'the server sent exactly one waiting edge to the client',
      ).toHaveLength(1)
      // The approval parks the turn: no second result or turn-complete edge.
      expect(await receivedFreshAgentEvents(harness, 'freshAgent.result')).toHaveLength(1)
      expect(await receivedFreshAgentEvents(harness, 'freshAgent.turn.complete')).toHaveLength(1)

      await expect(otherTabsStatus, 'the waiting tab is counted like a finished one').toBeVisible()
      await expect(previousTab).toHaveAccessibleDescription('An earlier tab needs attention')

      await switcherButton.click()
      await expect(page.getByRole('button', { name: /^Switch to .*, needs attention$/ })).toHaveCount(1)
    } finally {
      await server?.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
