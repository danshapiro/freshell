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
 * The pane is a real Freshclaude pane on the real Rust server (fake
 * Claude-SDK sidecar). G17 is a client rendering change, so the attention
 * EDGES are delivered as the exact server wire frames
 * (`freshAgent.event{event:{type:'freshAgent.turn.complete'|'freshAgent.turn.waiting', at}}`)
 * through the harness's WS receive path, which runs the production fold
 * (fresh-agent-ws → applyFreshAgentCompletion/applyFreshAgentWaiting →
 * receipt-time watched classification). Injecting keeps this spec independent
 * of the fake sidecar's turn lanes, so it does NOT cover the server emitting
 * those edges. That is fresh-agent-error-turn-attention.spec.ts's job, but
 * that spec (like every fake-sidecar spec that drives a composer send) was
 * red on origin/main when this one was written: the send never reached the
 * fake sidecar. Until that send lane is fixed, nothing green covers
 * "server edge → mobile mark" end to end; once it is, switch this spec to a
 * real delayed turn as the plan (C6) describes.
 *
 * CLOUD-LEGALITY: no timing dependencies; every wait is a poll on observed
 * state. This spec must NOT be added to CLOUD_SKIP_SPECS.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CLAUDE_SIDECAR_FIXTURE = path.resolve(__dirname, '../fixtures/providers/fake-claude-sdk-sidecar.mjs')

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

test.describe('mobile tab surfaces show needs-attention marks (G17)', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test.setTimeout(180_000)

  test('background turn endings and approvals mark the mobile strip and switcher; a tap dismisses', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-mobile-attention-'))
    let server: RustServer | undefined
    try {
      const projectDir = path.join(sharedRoot, 'project')
      await fs.mkdir(projectDir, { recursive: true })
      server = new RustServer({
        env: {
          FRESHELL_CLAUDE_SIDECAR: CLAUDE_SIDECAR_FIXTURE,
          FRESHELL_CLAUDE_NODE: process.execPath,
          FRESHELL_FAKE_PROVIDER: 'freshclaude',
          FRESHELL_FAKE_STDIN: path.join(sharedRoot, 'sidecar-stdin.jsonl'),
          FRESHELL_FAKE_EVENTS: path.join(sharedRoot, 'sidecar-events.jsonl'),
        },
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

      const tabA = (await harness.getActiveTabId())!
      expect(tabA).toBeTruthy()
      const paneStatus = () => expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout)?.content?.status ?? null
      }, { timeout: 30_000 })
      // The pane's turn-completion key is its durable session id.
      let durableId = ''
      await expect
        .poll(async () => {
          durableId = findFreshAgentLeaf(await harness.getPaneLayout(tabA))?.content?.sessionRef?.sessionId ?? ''
          return durableId
        }, { timeout: 30_000 })
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      await paneStatus().toBe('idle')

      const turnCompletionState = () => harness.getState().then((s: any) => s?.turnCompletion ?? {})
      expect((await turnCompletionState()).seq ?? 0).toBe(0)

      let lastAt = Date.now()
      const deliverEdge = async (type: 'freshAgent.turn.complete' | 'freshAgent.turn.waiting') => {
        lastAt += 1_000
        await harness.receiveWsMessage({
          type: 'freshAgent.event',
          sessionId: durableId,
          sessionType: 'freshclaude',
          provider: 'claude',
          event: { type, sessionId: durableId, at: lastAt },
        })
      }

      // The strip's "other tabs" count is a polite live region that stays
      // mounted (empty while nothing else is marked); its label is its text.
      const otherTabsStatus = page.getByRole('status').filter({ hasText: '1 other tab needs attention' })
      const anyOtherTabsStatus = page.getByRole('status').filter({ hasText: /other tabs? needs? attention/ })
      const previousTab = page.getByRole('button', { name: 'Previous tab' })

      // ── 1. A turn ends in a BACKGROUND tab ─────────────────────────────────
      // Tab A is the last tab, so the strip's right action is "New tab".
      await page.getByRole('button', { name: 'New tab' }).click()
      await harness.waitForTabCount(2)
      const tabB = (await harness.getActiveTabId())!
      expect(tabB).not.toBe(tabA)
      await expect(otherTabsStatus).toHaveCount(0)

      await deliverEdge('freshAgent.turn.complete')
      await expect
        .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null, {
          timeout: 15_000,
          message: 'the background turn ending marks tab A',
        })
        .toBe(true)
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
      // Tab A is first of two now: the strip's right action is "Next tab".
      await page.getByRole('button', { name: 'Next tab' }).click()
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabB)

      await deliverEdge('freshAgent.turn.waiting')
      await expect
        .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null, {
          timeout: 15_000,
          message: 'the approval waiting edge marks the background tab',
        })
        .toBe(true)
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
