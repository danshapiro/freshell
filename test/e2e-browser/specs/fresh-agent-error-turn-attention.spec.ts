// Unified needs-attention e2e — the fresh-agent error-turn contract
// (needs-attention-signal Tasks 1-7).
//
// One binary signal: ANY turn end the user did not witness — finished,
// errored, hit max-turns, crashed, wedged/stuck, or waiting — produces the
// identical tab highlight, sidebar row highlight, and a single bell. A turn
// end the user WAS watching produces the tab-strip-only watched mark, no
// sound, cleared on the next away-and-back. A user-initiated interrupt is
// silent, full stop, and shows no error banner. The first test drives the
// deterministic fake claude-SDK sidecar
// (`fixtures/providers/fake-claude-sdk-sidecar.mjs`) end to end — composer →
// Rust server → sidecar → unified `freshAgent.turn.complete` → client fold →
// marks — through these lanes of that contract:
//
//   1. an ERRORED turn (error_max_turns) ending in a BACKGROUND tab rings
//      exactly one bell-pipeline event (turnCompletion.seq 1) and marks
//      everything: emerald tab, sidebar row, pane header;
//   2. visiting the tab dismisses the attention (click mode);
//   3. a COMPLETED turn the user watched sets the tab-strip-only watched
//      mark: no bell, no sidebar row, no pane-header mark — and the mark
//      clears on away-and-back;
//   4. an errored turn while the WINDOW is unfocused (user in another app)
//      still folds the edge and sets the attention flag — the bell rings for
//      any tab when the window is unfocused (the sound suppression split is
//      unit-pinned; e2e asserts the fold partition);
//   5. a mid-turn end of the SDK stream (the finally-minted edge, then
//      sdk.stream.ended and the sidecar's exit) rings exactly one edge,
//      resolves the pane to idle, reports the exit (SIDECAR_EXITED), and the
//      sidecar process is gone: a stream end is a session end (G02), and the
//      server does not ring a second time for the reported end.
//
// The user-Stop lane runs on the PRODUCTION sidecar
// (crates/freshell-claude-sidecar/index.mjs) over the CLI simulator
// (test/fixtures/claude-cli-sim), for freshclaude and kilroy: a Stop the
// pinned CLI reports the way it really does (error_during_execution with an
// `[ede_diagnostic]` error, T11) rings nothing, marks nothing and shows no
// "Agent error" banner, and the next turn still rings.
//
// CLOUD-LEGALITY: everything is driven through the fake's deterministic
// program lanes (`FRESHELL_FAKE_PROGRAM` text-matched rules with bounded
// `delayMs` emissions) — there are NO idle-grace-period or shade-transition
// timing dependencies here (the patterns that put truly-idle-alerting.spec.ts
// itself in CLOUD_SKIP_SPECS). The delayed emissions hand the spec a bounded
// window to move the user's attention (background the tab, blur the window,
// click Stop) BEFORE the scripted turn ends; every wait is a poll on
// observed state, never a fixed sleep on a pipeline. The user-Stop lane needs
// no window at all: it reads the simulator's ledger to know the turn has
// started before it clicks Stop. This spec must NOT be added to
// CLOUD_SKIP_SPECS.

import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
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
// The production sidecar and the CLI simulator it loads through its
// FRESHELL_CLAUDE_SDK_QUERY_MODULE seam (both are in the cloud image's source
// tree; the simulator needs no CLI binary and no network).
const CLAUDE_SIDECAR = path.resolve(__dirname, '../../../crates/freshell-claude-sidecar/index.mjs')
const CLAUDE_CLI_SIMULATOR = path.resolve(__dirname, '../../fixtures/claude-cli-sim/query.mjs')

/**
 * Deterministic fake-sidecar program. The 3s emission delays are the ONLY
 * timing in this spec, and they are lane-controlled (the fake consumes the
 * delay BEFORE the emission fires): each send opens a bounded window in
 * which the spec moves the user's attention, then the scripted turn ends.
 */
const FAKE_PROGRAM = {
  rules: [
    {
      // Errored turn lane: error_max_turns is a turn end like any other.
      on: 'msg:send',
      match: { text: 'ERROR_TURN' },
      emit: [
        {
          kind: 'completion',
          data: { subtype: 'error_max_turns', text: 'Fixture turn hit the turn limit.' },
          delayMs: 3_000,
        },
      ],
    },
    {
      // Mid-turn end-of-stream lane: the finally-minted unified edge, then
      // sdk.stream.ended and exit code 3, like the real sidecar. The separate
      // `crash` lane (silent process death) belongs to the Rust-synthesis lanes.
      on: 'msg:send',
      match: { text: 'STREAM_ERROR' },
      emit: [{ kind: 'stream-error', delayMs: 3_000 }],
    },
  ],
}

/** Read a JSONL fixture log (the fake's event/wire audit). */
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

test.describe('fresh-agent error-turn attention (unified needs-attention signal)', () => {
  test.setTimeout(180_000)

  test('errored turns ring the unified signal; watched endings mark the tab strip only', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-error-turn-attention-'))
    let server: RustServer | undefined
    try {
      const projectDir = path.join(sharedRoot, 'project')
      await fs.mkdir(projectDir, { recursive: true })
      server = new RustServer({
        env: {
          FRESHELL_CLAUDE_SIDECAR: CLAUDE_SIDECAR_FIXTURE,
          FRESHELL_CLAUDE_NODE: process.execPath,
          FRESHELL_FAKE_PROVIDER: 'freshclaude',
          FRESHELL_FAKE_PROGRAM: JSON.stringify(FAKE_PROGRAM),
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

      // The boot tab shows the pane-type picker (no shell is selected first,
      // so the freshclaude pane REPLACES the picker — no split sibling): make
      // the fresh-agent options visible, then pick Freshclaude.
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

      const tabA = (await harness.getActiveTabId())!
      expect(tabA).toBeTruthy()

      // The pane materializes its bridge session + durable sessionRef.
      const paneId: string = await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout)?.id ?? null
      }, { timeout: 15_000 }).not.toBeNull().then(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout).id as string
      })
      const bridgeSessionId: string = await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout)?.content?.sessionId ?? null
      }, { timeout: 30_000 }).not.toBeNull().then(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout).content.sessionId as string
      })
      const durableCliSessionId: string = await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout)?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).not.toBeNull().then(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout).content.sessionRef.sessionId as string
      })

      const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
      const sendButton = paneRoot.getByRole('button', { name: 'Send' })
      const tabALocator = page.locator(`[data-context="tab"][data-tab-id="${tabA}"]`)
      const paneHeader = page.locator(`[data-context="pane-header"][data-pane-id="${paneId}"]`)
      const sidebarRow = page
        .getByTestId('sidebar-session-list')
        .locator(`[data-session-id="${durableCliSessionId}"][data-provider="claude"]`)

      const paneStatus = () => expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout)?.content?.status ?? null
      }, { timeout: 30_000 })
      const turnCompletionState = () => harness.getState().then((s: any) => s?.turnCompletion ?? {})

      // The pane opens idle before any turn is driven.
      await paneStatus().toBe('idle')
      expect((await turnCompletionState()).seq ?? 0).toBe(0)

      // ── Step 1: an ERRORED turn ending in a BACKGROUND tab ──────────────
      // Send, then move to a fresh shell tab inside the fake's 3s emission
      // window — the user is in another tab when the max-turns error lands.
      await composer.fill('ERROR_TURN')
      await sendButton.click()
      await page.getByRole('button', { name: 'New shell tab' }).click()
      await harness.waitForTabCount(2)
      const tabB = (await harness.getActiveTabId())!
      expect(tabB).not.toBe(tabA)

      // One bell: exactly one turnCompletion event enters the pipeline.
      await expect
        .poll(async () => (await turnCompletionState()).seq ?? 0,
          { timeout: 30_000, message: 'the errored background turn rings exactly one event (seq 1)' })
        .toBe(1)
      // Unwitnessed endings mark EVERYTHING: tab, pane header, sidebar row.
      const erroredState = await turnCompletionState()
      expect(erroredState.attentionByTab?.[tabA], 'the errored turn sets the tab attention flag').toBe(true)
      expect(erroredState.attentionByPane?.[paneId], 'the errored turn sets the pane-header mark').toBe(true)
      expect(erroredState.watchedCompletionByTab?.[tabA], 'an unwitnessed ending sets no watched mark').toBeUndefined()
      await expect(tabALocator, 'the background tab carries the emerald attention class').toHaveClass(/bg-emerald-100/)
      await expect(paneHeader, 'the pane header carries the emerald attention mark').toHaveClass(/bg-emerald-50/)
      await expect(sidebarRow, 'the pane session has a sidebar row to check').toBeVisible({ timeout: 30_000 })
      await expect(sidebarRow, 'the session row highlights in the sidebar').toHaveClass(/bg-emerald-50|border-l-emerald-500/)

      // One-shot: the errored turn rings exactly once — stable across a
      // settle window (no replay re-ring, no second bell).
      await page.waitForTimeout(1_500)
      expect((await turnCompletionState()).seq).toBe(1)

      // ── Step 2: visiting the tab dismisses the attention ────────────────
      await tabALocator.click()
      await expect
        .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null,
          { timeout: 10_000, message: 'visiting the tab clears the tab attention (click mode)' })
        .toBeNull()
      await expect
        .poll(async () => (await turnCompletionState()).attentionByPane?.[paneId] ?? null,
          { timeout: 10_000, message: 'visiting the tab clears the pane-header mark too' })
        .toBeNull()
      await expect(tabALocator).not.toHaveClass(/bg-emerald-100/)
      await paneStatus().toBe('idle')

      // ── Step 3: a COMPLETED turn the user watched = tab strip only ─────
      // (tab A is active and the window focused; the plain send completes
      // with the canned success turn.)
      await composer.fill('a watched happy turn')
      await sendButton.click()
      await expect
        .poll(async () => (await turnCompletionState()).seq ?? 0,
          { timeout: 30_000, message: 'the watched completion edge still folds (seq 2) — watching partitions the MARKS, not the edge' })
        .toBe(2)
      await paneStatus().toBe('idle')
      const watchedState = await turnCompletionState()
      expect(watchedState.attentionByTab?.[tabA], 'a watched ending creates no tab attention').toBeUndefined()
      expect(watchedState.attentionByPane?.[paneId], 'a watched ending creates no pane-header mark').toBeUndefined()
      expect(watchedState.watchedCompletionByTab?.[tabA], 'the watched ending sets the tab-strip-only mark').toBe(true)
      await expect(tabALocator, 'the ACTIVE tab renders the watched green top-line mark').toHaveClass(/border-t-success/)
      await expect(tabALocator, 'the watched mark never shades an active tab like a background alert').not.toHaveClass(/bg-emerald-100/)
      await expect(paneHeader, 'the pane header stays dark for a watched ending').not.toHaveClass(/bg-emerald-50/)
      await expect(sidebarRow, 'the sidebar row stays dark for a watched ending').not.toHaveClass(/bg-emerald-50|border-l-emerald-500/)

      // The watched mark clears on away-and-back: navigate to tab B and
      // return — only a REAL re-activation may clear it.
      await page.locator(`[data-context="tab"][data-tab-id="${tabB}"]`).click()
      await tabALocator.click()
      await expect
        .poll(async () => (await turnCompletionState()).watchedCompletionByTab?.[tabA] ?? null,
          { timeout: 10_000, message: 'the away-and-back clears the watched mark' })
        .toBeNull()
      await expect(tabALocator, 'the watched top-line mark is gone after away-and-back').not.toHaveClass(/border-t-success/)

      // ── Step 4: an errored turn while the WINDOW is unfocused ───────────
      // (the user is in another app; the bell rings for any tab.) Headless
      // Chromium cannot produce an OS-level window blur — probe-verified:
      // a sibling page's bringToFront() leaves BOTH pages reporting
      // document.hasFocus() === true — so the spec drives the ONE
      // browser-API signal the production partition reads (isWindowFocused()
      // → document.hasFocus()): patch it to false through the page, verify
      // the patch took, drive the turn, then restore the real function. The
      // fold, the partition, and the attention products below are all real
      // production behavior; only the focus READING is seeded.
      await page.evaluate(() => {
        (window as any).__FRESHELL_ORIGINAL_HAS_FOCUS__ = Document.prototype.hasFocus
        Document.prototype.hasFocus = () => false
      })
      await expect
        .poll(async () => page.evaluate(() => document.hasFocus()),
          { timeout: 10_000, message: 'the unfocused-window seam is verified, not assumed' })
        .toBe(false)

      await composer.fill('ERROR_TURN')
      await sendButton.click()

      // The edge folds (seq 3) and — with the window unfocused — the
      // unwitnessed partition sets the attention flag even though the pane's
      // tab is the ACTIVE tab. The audible ring itself is not directly
      // observable in e2e; the partition inputs (unfocused + active-tab) and
      // its attention products are, and the sound-suppression split is
      // unit-pinned (useTurnCompletionNotifications).
      await expect
        .poll(async () => (await turnCompletionState()).seq ?? 0,
          { timeout: 30_000, message: 'the unfocused-window errored turn still folds its edge (seq 3)' })
        .toBe(3)
      await expect
        .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null,
          { timeout: 15_000, message: 'the unfocused window keeps the ending unwitnessed — attention sets' })
        .toBe(true)
      await paneStatus().toBe('idle')

      // Restore the REAL focus signal before the away-and-back dismissal
      // (the click-mode dismiss requires the window to be focused), and
      // clear the step-4 attention so the stream-error lane below starts
      // from a clean slate.
      await page.evaluate(() => {
        const original = (window as any).__FRESHELL_ORIGINAL_HAS_FOCUS__
        if (typeof original === 'function') Document.prototype.hasFocus = original
      })
      await expect
        .poll(async () => page.evaluate(() => document.hasFocus()),
          { timeout: 10_000, message: 'the real hasFocus is restored' })
        .toBe(true)
      await page.locator(`[data-context="tab"][data-tab-id="${tabB}"]`).click()
      await tabALocator.click()
      await expect
        .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null,
          { timeout: 10_000, message: 'the step-4 attention clears on away-and-back' })
        .toBeNull()
      await paneStatus().toBe('idle')

      // ── Step 5: the SDK stream ends mid-turn — the sidecar exits ───────
      // The fake's stream-error lane models the real sidecar's end of stream:
      // the finally-minted unified edge, then sdk.stream.ended as its last
      // line and exit code 3. The server reports the exit and, because the end
      // was reported, does not ring again.
      await composer.fill('STREAM_ERROR')
      await sendButton.click()
      await page.locator(`[data-context="tab"][data-tab-id="${tabB}"]`).click()

      await expect
        .poll(async () => (await turnCompletionState()).seq ?? 0,
          { timeout: 30_000, message: 'the turn the stream ended in rings exactly one unified edge (seq 4)' })
        .toBe(4)
      await expect
        .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null,
          { timeout: 15_000, message: 'the unwitnessed end sets attention' })
        .toBe(true)
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabA)
          return findFreshAgentLeaf(layout)?.content?.status ?? null
        }, { timeout: 30_000, message: 'the pane resolves to idle after the stream ends' })
        .toBe('idle')
      // The server reported the sidecar's exit to the pane.
      await expect
        .poll(async () => {
          const state = await harness.getState()
          const sessions = Object.values(state?.freshAgent?.sessions ?? {}) as any[]
          return sessions.find((session) => session.sessionId === bridgeSessionId)?.lastErrorCode ?? null
        }, { timeout: 30_000, message: 'the pane learns the sidecar exited (SIDECAR_EXITED)' })
        .toBe('SIDECAR_EXITED')

      // The sidecar process is GONE: the wire rows carry its pid, the last
      // one it wrote is the end report, and signal 0 finds no process.
      const streamWires = readJsonl(path.join(sharedRoot, 'sidecar-events.jsonl'))
        .filter((r) => r.kind === 'wire' && r.frame?.sessionId === bridgeSessionId)
      expect(streamWires.length, 'the session produced wire rows to read the sidecar pid from').toBeGreaterThan(0)
      const sidecarPid = streamWires[0].pid as number
      expect(streamWires.at(-1)?.frame, 'the sidecar wrote sdk.stream.ended last').toMatchObject({ type: 'sdk.stream.ended', reason: 'stream_error' })
      await expect
        .poll(() => {
          try {
            process.kill(sidecarPid, 0)
            return 'alive'
          } catch {
            return 'gone'
          }
        }, { timeout: 30_000, message: 'the sidecar process exited after its stream ended' })
        .toBe('gone')
      // Each send opens with a running status: count the edges after the last one.
      const lastSendOpen = streamWires
        .map((r) => r.frame?.type === 'sdk.status' && r.frame?.status === 'running')
        .lastIndexOf(true)
      expect(lastSendOpen, 'the ended turn opened with a running status').toBeGreaterThanOrEqual(0)
      expect(
        streamWires.slice(lastSendOpen).filter((r) => r.frame?.type === 'sdk.turn.complete'),
        'exactly one unified edge for the ended turn (the session\'s earlier turns each rang their own edge)',
      ).toHaveLength(1)

      // One edge total for the lane — stable across a settle window (the
      // reported end gets no second, server-minted edge).
      await page.waitForTimeout(1_500)
      expect((await turnCompletionState()).seq).toBe(4)
    } finally {
      await server?.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test.describe('fresh-agent user Stop on the production claude sidecar', () => {
  test.setTimeout(180_000)

  for (const flavour of ['freshclaude', 'kilroy'] as const) {
    const label = flavour === 'kilroy' ? 'Kilroy' : 'Freshclaude'

    test(`${flavour}: a user Stop rings nothing, marks nothing and shows no error banner; the next turn still rings`, async ({ page }) => {
      const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), `freshell-user-stop-${flavour}-`))
      const simLedger = path.join(sharedRoot, 'claude-sim-ledger.jsonl')
      let server: RustServer | undefined
      try {
        const projectDir = path.join(sharedRoot, 'project')
        await fs.mkdir(projectDir, { recursive: true })
        server = new RustServer({
          env: {
            FRESHELL_CLAUDE_SIDECAR: CLAUDE_SIDECAR,
            FRESHELL_CLAUDE_NODE: process.execPath,
            FRESHELL_CLAUDE_SDK_QUERY_MODULE: CLAUDE_CLI_SIMULATOR,
            FRESHELL_CLAUDE_SIM_LEDGER: simLedger,
            // Kilroy is behind its feature flag.
            ...(flavour === 'kilroy' ? { KILROY_ENABLED: '1' } : {}),
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

        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({
            type: 'connection/setAvailableClis',
            payload: { claude: true },
          })
        })
        const picker = await openPanePicker(page)
        await picker.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).click({ force: true })
        const directoryInput = page.getByLabel(new RegExp(`^Starting directory for ${label}$`, 'i'))
        await expect(directoryInput).toBeVisible({ timeout: 15_000 })
        await directoryInput.fill(projectDir)
        await directoryInput.press('Enter')

        const paneRoot = page.locator('[data-context="fresh-agent"]').last()
        await expect(paneRoot).toBeVisible({ timeout: 15_000 })
        const tabA = (await harness.getActiveTabId())!
        expect(tabA).toBeTruthy()
        const paneId: string = await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabA)
          return findFreshAgentLeaf(layout)?.id ?? null
        }, { timeout: 15_000 }).not.toBeNull().then(async () => {
          const layout = await harness.getPaneLayout(tabA)
          return findFreshAgentLeaf(layout).id as string
        })

        const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
        const sendButton = paneRoot.getByRole('button', { name: 'Send' })
        const stopButton = paneRoot.getByRole('button', { name: 'Stop' })
        const errorBanner = paneRoot.getByText(/^Agent error:/)
        const tabALocator = page.locator(`[data-context="tab"][data-tab-id="${tabA}"]`)
        const paneStatus = () => expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabA)
          return findFreshAgentLeaf(layout)?.content?.status ?? null
        }, { timeout: 30_000 })
        const turnCompletionState = () => harness.getState().then((s: any) => s?.turnCompletion ?? {})
        /** Prompts the simulated CLI has started, in order (its ledger's `prompt` rows). */
        const startedPrompts = () => readJsonl(simLedger).filter((row) => row.kind === 'prompt').map((row) => String(row.text ?? ''))

        // The CLI reports no session until a prompt (T1), so a new pane is
        // `connected` until its first turn.
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabA)
          return findFreshAgentLeaf(layout)?.content?.status ?? null
        }, { timeout: 30_000, message: 'the new pane is ready to send' }).toMatch(/^(connected|idle)$/)
        expect((await turnCompletionState()).seq ?? 0).toBe(0)

        // A first turn, watched: the pipeline rings (seq 1, the tab-strip-only
        // watched mark), and the simulated CLI is booted and warm, so the Stop
        // below lands on a running turn rather than racing the CLI's start.
        await composer.fill('hello')
        await sendButton.click()
        await expect
          .poll(async () => (await turnCompletionState()).seq ?? 0,
            { timeout: 30_000, message: 'the first turn rings (seq 1)' })
          .toBe(1)
        await paneStatus().toBe('idle')
        // Clear the watched mark with an away-and-back, so the Stop below
        // starts from a tab with no mark of any kind.
        await page.getByRole('button', { name: 'New shell tab' }).click()
        await harness.waitForTabCount(2)
        const tabB = (await harness.getActiveTabId())!
        expect(tabB).not.toBe(tabA)
        await tabALocator.click()
        await expect
          .poll(async () => (await turnCompletionState()).watchedCompletionByTab?.[tabA] ?? null,
            { timeout: 10_000, message: 'the away-and-back clears the watched mark' })
          .toBeNull()

        // ── The user Stop, while watching ────────────────────────────────
        // HANG: the model request never answers, so only the Stop ends the
        // turn. Stop is clicked once the simulated CLI has started the prompt.
        await composer.fill('HANG')
        await sendButton.click()
        await expect
          .poll(() => startedPrompts().includes('HANG'),
            { timeout: 15_000, message: 'the simulated CLI started the HANG turn' })
          .toBe(true)
        await expect(stopButton, 'Stop is enabled while the turn runs').toBeEnabled({ timeout: 10_000 })
        await stopButton.click()

        // The turn ends and the pane is idle again.
        await paneStatus().toBe('idle')
        // Settle window: the stopped turn's result and anything after it
        // (an error frame would follow the result in the same burst) have
        // reached the page.
        await page.waitForTimeout(1_000)
        await expect(errorBanner, 'a user Stop shows no "Agent error" banner').toHaveCount(0)
        const received = JSON.stringify(await harness.getReceivedWsMessages())
        expect(received, 'the CLI\'s [ede_diagnostic] text never reaches the client').not.toContain('ede_diagnostic')
        const stopState = await turnCompletionState()
        expect(stopState.seq, 'a user Stop rings no new event').toBe(1)
        expect(stopState.attentionByTab?.[tabA], 'a user Stop creates no tab attention').toBeUndefined()
        expect(stopState.attentionByPane?.[paneId], 'a user Stop creates no pane-header mark').toBeUndefined()
        expect(stopState.watchedCompletionByTab?.[tabA], 'a user Stop creates no watched mark').toBeUndefined()
        await expect(tabALocator, 'the tab strip shows no mark after the Stop').not.toHaveClass(/bg-emerald-100|border-t-success/)

        // ── The next turn still rings (in the background) ────────────────
        // The Stop's silence is not a dead pipeline, and it did not carry
        // over to the next turn.
        await composer.fill('SLOW after the stop')
        await sendButton.click()
        await page.locator(`[data-context="tab"][data-tab-id="${tabB}"]`).click()
        await expect
          .poll(async () => (await turnCompletionState()).seq ?? 0,
            { timeout: 30_000, message: 'the turn after the Stop rings (seq 2)' })
          .toBe(2)
        await expect
          .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null,
            { timeout: 15_000, message: 'the background turn after the Stop sets attention' })
          .toBe(true)
        await expect(errorBanner, 'still no error banner after the next turn').toHaveCount(0)
      } finally {
        await server?.stop().catch(() => {})
        await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
      }
    })
  }
})
