// FRESHCLAUDE LIVE TRANSCRIPT -- transcript-live plan Phase E (audit G10,
// G12, G13): what a freshclaude or kilroy pane shows WHILE a turn runs, end
// to end through the real Rust server, the PRODUCTION Claude sidecar and the
// Claude CLI simulator (helpers/claude-sim-lane.ts). The simulator writes the
// session's transcript the way the pinned CLI does (each line about 100 ms
// after its message), so every case below also exercises the landing of
// live content into the durable transcript the server projects.
//
//   1. streamed text shows while the turn runs (Stop shown), then lands:
//      on screen exactly once in every frame, with no gap;
//   2. a tool's row shows as soon as the model starts the call (before its
//      input is complete and before the transcript has it), and a running
//      tool's row shows before its turn ends;
//   3. an API retry shows "Retrying (attempt 1)" until the answer streams;
//   4. /compact shows the compaction card and the pane returns to idle; a
//      failed compaction shows the notice and the durable command error;
//   5. a subagent's delegation block gains its activity row while it runs,
//      then completes with its result (a replay of a real CLI turn);
//   6. the changed-files panel lists the turn's edits and expands to the
//      file's git diff;
//   7. /cost output renders as a System row;
//   8. after an approved ExitPlanMode, the gear shows Default and the next
//      send keeps it;
//   9. a reload mid-session shows the same rich transcript, and the
//      session goes on.
// Kilroy runs cases 1, 4 and 5 too.
//
// CLOUD-LEGALITY: no CLI binary and no network (the simulator stands in for
// the CLI); every wait polls observed state, and the only scripted timing is
// the simulator's own (stream pacing, holds inside a replayed turn), which
// opens windows of several seconds for the mid-turn checks. This spec must
// NOT be added to CLOUD_SKIP_SPECS.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import {
  ClaudeSimLane,
  onPrompt,
  startPaneTextCensus,
  stopPaneTextCensus,
  type ClaudeSimLaneOptions,
  type ClaudeSimPane,
} from '../helpers/claude-sim-lane.js'

/** The recorded real-CLI turn the replay cases play: thinking, text, Write,
 * two Edits (one failing), a Read and a synchronous subagent that reads a file. */
const RECORDING = 'tools-sync'
/** Recorded uuids inside that turn (the replay holds before them). */
const SUBAGENT_TOOL_CALL = 'e3244f50-22f6-445e-91c3-ac965616f59c'
const SUBAGENT_TOOL_RESULT = '1ee90712-3476-4188-b310-22a881bf6e20'
const REPLAY_PROMPT = 'replay the recorded tools turn'

/** Twelve streamed chunks, 400 ms apart: "chunk0 chunk1 ... chunk11 ". */
const STREAM_PROMPT = 'stream a slow answer'
const STREAM_CHUNKS = 12

async function withLane(
  browser: Parameters<typeof ClaudeSimLane.start>[0],
  options: ClaudeSimLaneOptions,
  body: (lane: ClaudeSimLane, pane: ClaudeSimPane) => Promise<void>,
) {
  const lane = await ClaudeSimLane.start(browser, options)
  try {
    const pane = await lane.openPane()
    await body(lane, pane)
  } finally {
    await lane.attachLogsOnFailure(test.info())
    await lane.stop()
  }
}

/** Let every activity strip start expanded (Settings → Expand tools). */
async function expandToolsByDefault(lane: ClaudeSimLane) {
  await lane.page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'settings/updateSettingsLocal',
      payload: { freshAgent: { expandTools: true } },
    })
  })
}

const liveResponse = (pane: ClaudeSimPane) => pane.paneRoot.getByRole('article', { name: /live response$/ })
const transcriptTurns = (pane: ClaudeSimPane, role: RegExp = /transcript turn$/) => pane.paneRoot.getByRole('article', { name: role })
/** The turns the agent (not the user) wrote, durable ones only. */
const agentTurns = (pane: ClaudeSimPane) => transcriptTurns(pane, /^(?!You ).*transcript turn$/)
const stopButton = (pane: ClaudeSimPane) => pane.paneRoot.getByRole('button', { name: 'Stop' })

/** The prompts the simulated CLI started, with the permission mode each ran under. */
function startedPrompts(lane: ClaudeSimLane) {
  return lane.ledger()
    .filter((row) => row.kind === 'prompt')
    .map((row) => ({ text: String(row.text ?? ''), permissionMode: row.permissionMode }))
}

test.describe('freshclaude live transcript (production sidecar over the CLI simulator, Rust server)', () => {
  test.setTimeout(180_000)

  for (const flavour of ['freshclaude', 'kilroy'] as const) {
    test(`${flavour}: streamed text shows while the turn runs, then lands exactly once with no gap`, async ({ browser }) => {
      const program = { rules: [onPrompt(STREAM_PROMPT, [{ kind: 'text', data: { chunks: STREAM_CHUNKS, delayMs: 400 } }])] }
      await withLane(browser, { flavour, program }, async (lane, pane) => {
        const { page } = lane
        // One copy of the answer, counted by its first chunk, every frame.
        await startPaneTextCensus(page, { answer: '\\bchunk0\\b' })
        await lane.send(pane, STREAM_PROMPT)

        // Partial text, in the live response, while the turn still runs.
        await expect(liveResponse(pane)).toContainText('chunk1', { timeout: 30_000 })
        await expect(stopButton(pane)).toBeVisible()
        expect(await liveResponse(pane).innerText()).not.toMatch(/\bchunk11\b/)

        await lane.waitForIdle(pane)
        const answer = new RegExp(`chunk0 chunk1 .*\\bchunk${STREAM_CHUNKS - 1}\\b`)
        await expect(agentTurns(pane).filter({ hasText: answer })).toHaveCount(1)
        await expect(liveResponse(pane)).toHaveCount(0)
        await expect(pane.paneRoot.getByText(answer)).toHaveCount(1)

        const census = await stopPaneTextCensus(page)
        expect(census.entries.answer.framesSeen, 'the answer was on screen').toBeGreaterThan(0)
        expect(census.entries.answer.max, 'no frame showed the answer twice').toBe(1)
        expect(census.entries.answer.framesMissingAfterSeen, 'no frame lost the answer once it showed').toBe(0)
      })
    })
  }

  test('freshclaude: a tool row shows as soon as the model starts the call, and before its turn ends', async ({ browser }) => {
    // The model takes 4 s to stream a long Write's input, then runs a 4 s Bash call.
    const program = (workspace: string) => ({ rules: [onPrompt('write the notes, then build', [
      { kind: 'tool', data: { name: 'Write', input: { file_path: path.join(workspace, 'notes.md'), content: 'a long line of notes\n'.repeat(200) }, inputStreamMs: 4_000, output: 'File created successfully' } },
      { kind: 'tool', data: { name: 'Bash', input: { command: 'sleep 4', description: 'Wait for the build' }, seconds: 4 } },
      { kind: 'text', data: { text: 'The build finished.' } },
    ])] })
    await withLane(browser, { flavour: 'freshclaude', program }, async (lane, pane) => {
      await lane.send(pane, 'write the notes, then build')

      // While the model still streams the Write's input, nothing of the
      // response is in the transcript yet: the live response shows the call.
      await expect(liveResponse(pane).getByRole('region', { name: 'Activity strip' })).toContainText('Write', { timeout: 30_000 })
      await expect(agentTurns(pane), 'the call is not in the transcript yet').toHaveCount(0)
      await expect(stopButton(pane)).toBeVisible()

      // The running Bash call shows while its turn still runs.
      const strip = pane.paneRoot.getByRole('region', { name: 'Activity strip' }).filter({ hasText: 'Wait for the build' })
      await expect(strip).toBeVisible({ timeout: 30_000 })
      await expect(strip).toContainText('Bash')
      await expect(stopButton(pane), 'the tool shows while its turn still runs').toBeVisible()
      await expect(pane.paneRoot.getByText('The build finished.')).toHaveCount(0)

      await lane.waitForIdle(pane)
      await expect(pane.paneRoot.getByText('The build finished.')).toHaveCount(1)
      await expect(liveResponse(pane)).toHaveCount(0)
      // The settled strip sums the turn up; its details show both calls, done.
      const settled = pane.paneRoot.getByRole('region', { name: 'Activity strip' })
      await expect(settled).toHaveCount(1)
      await expect(settled).toContainText('2 tools used')
      await settled.getByRole('button', { name: 'Toggle activity details', expanded: false }).click()
      for (const name of ['Write tool call', 'Bash tool call']) {
        const toolCall = pane.paneRoot.getByRole('button', { name })
        await expect(toolCall).toHaveCount(1)
        await expect(toolCall.getByLabel('complete')).toBeVisible()
      }
    })
  })

  test('freshclaude: an API retry shows "Retrying (attempt 1)" until the answer streams', async ({ browser }) => {
    const program = { rules: [onPrompt('answer after overloaded attempts', [
      { kind: 'api_retry', data: { status: 529, attempts: 3 } },
      { kind: 'text', data: { text: 'Recovered after the retries.' } },
    ])] }
    await withLane(browser, { flavour: 'freshclaude', program }, async (lane, pane) => {
      const { page } = lane
      await expandToolsByDefault(lane)
      await startPaneTextCensus(page, { retry: 'Retrying \\(attempt \\d+\\)[^\\n]*' })
      await lane.send(pane, 'answer after overloaded attempts')

      const retryRow = pane.paneRoot.getByText(/^Retrying \(attempt \d+\) — overloaded \(529\)/)
      await expect(retryRow).toBeVisible({ timeout: 30_000 })
      await expect(stopButton(pane)).toBeVisible()

      await expect(pane.paneRoot.getByText('Recovered after the retries.')).toHaveCount(1, { timeout: 30_000 })
      await expect(retryRow, 'the retry row clears once the answer streams').toHaveCount(0)
      await lane.waitForIdle(pane)
      await expect(retryRow).toHaveCount(0)

      const census = await stopPaneTextCensus(page)
      const shown = census.entries.retry.matches
      expect(shown.some((text) => text.startsWith('Retrying (attempt 1) — overloaded (529)')), `retry rows shown: ${JSON.stringify(shown)}`).toBe(true)
      expect(shown.some((text) => text.startsWith('Retrying (attempt 3)')), `retry rows shown: ${JSON.stringify(shown)}`).toBe(true)
    })
  })

  for (const flavour of ['freshclaude', 'kilroy'] as const) {
    test(`${flavour}: /compact shows the compaction card and returns to idle; a failed compaction shows the notice and the command error`, async ({ browser }) => {
      await withLane(browser, { flavour }, async (lane, pane) => {
        // Something to compact (the marker-free prompt answers "ok").
        await lane.send(pane, 'hello')
        await expect(agentTurns(pane).getByText('ok', { exact: true })).toHaveCount(1, { timeout: 30_000 })
        await lane.waitForIdle(pane)

        await lane.send(pane, '/compact')
        await expect(pane.paneRoot.getByText('Context compaction', { exact: true })).toHaveCount(1, { timeout: 30_000 })
        await lane.waitForIdle(pane)

        // The summary request fails (APIERR in the compaction's instructions).
        const failure = 'Error during compaction: API Error: 400 local provider error'
        await lane.send(pane, '/compact APIERR:400')
        await expect(pane.paneRoot.getByRole('alert').filter({ hasText: failure }), 'the notice banner').toBeVisible({ timeout: 30_000 })
        await expect(pane.paneRoot.getByRole('note', { name: 'Agent error' }).filter({ hasText: failure }), 'the durable command error').toHaveCount(1, { timeout: 30_000 })
        await lane.waitForIdle(pane)
        await expect(pane.paneRoot.getByText('Context compaction', { exact: true })).toHaveCount(1)
      })
    })
  }

  for (const flavour of ['freshclaude', 'kilroy'] as const) {
    test(`${flavour}: a running subagent's delegation gains its activity row, then completes with its result`, async ({ browser }) => {
      const program = { rules: [onPrompt(REPLAY_PROMPT, [{ kind: 'replay', data: {
        recording: RECORDING,
        holdBeforeMs: { [SUBAGENT_TOOL_CALL]: 5_000, [SUBAGENT_TOOL_RESULT]: 5_000 },
      } }])] }
      await withLane(browser, { flavour, program }, async (lane, pane) => {
        await expandToolsByDefault(lane)
        await lane.send(pane, REPLAY_PROMPT)

        const delegation = pane.paneRoot.getByTestId('fresh-agent-delegation-block')
        const rows = delegation.getByTestId('fresh-agent-delegation-row')
        // The subagent has started and called nothing yet.
        await expect(delegation).toHaveAttribute('data-status', 'running', { timeout: 30_000 })
        await expect(delegation.getByText('General-purpose Task — check file')).toBeVisible()
        await expect(rows).toHaveCount(0)
        await expect(stopButton(pane)).toBeVisible()

        // Its Read call shows, running, while the subagent still runs.
        await expect(rows).toHaveCount(1, { timeout: 30_000 })
        await expect(rows.first()).toContainText('Read')
        await expect(rows.first()).toContainText(path.join(lane.workspace, 'a.txt'))
        await expect(rows.first().getByLabel('Read running')).toBeVisible()
        await expect(delegation).toHaveAttribute('data-status', 'running')
        await expect(stopButton(pane)).toBeVisible()

        // Then the subagent completes with its result.
        await expect(delegation).toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
        await expect(delegation.getByTestId('fresh-agent-delegation-result')).toContainText('SUBAGENT-DONE: file has two')
        await expect(rows).toHaveCount(1)
        await expect(rows.first().getByLabel('Read running')).toHaveCount(0)
        await lane.waitForIdle(pane)
        await expect(pane.paneRoot.getByText('All done.')).toHaveCount(1)
        await expect(delegation).toHaveCount(1)
        // The delegation absorbed its tool result: no stray "Result" row.
        await expect(pane.paneRoot.getByLabel('Result tool call')).toHaveCount(0)
      })
    })
  }

  test('freshclaude: the changed-files panel lists the turn\'s edits and expands to the git diff', async ({ browser }) => {
    const program = { rules: [onPrompt(REPLAY_PROMPT, [{ kind: 'replay', data: { recording: RECORDING, workspace: true } }])] }
    // The recorded turn read b.txt as "alpha\nbeta\n" and added "gamma".
    const setupWorkspace = async (workspace: string) => {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Freshell E2E', '-c', 'user.email=e2e@freshell.invalid', ...args], { cwd: workspace })
      git('init', '-q', '-b', 'main')
      await fs.writeFile(path.join(workspace, 'b.txt'), 'alpha\nbeta\n')
      git('add', 'b.txt')
      git('commit', '-q', '-m', 'the workspace the turn was recorded in')
    }
    await withLane(browser, { flavour: 'freshclaude', program, setupWorkspace }, async (lane, pane) => {
      await lane.send(pane, REPLAY_PROMPT)
      await lane.waitForIdle(pane, 60_000)

      const created = pane.paneRoot.getByRole('button', { name: `Diff: ${path.join(lane.workspace, 'a.txt')}` })
      await expect(created).toBeVisible({ timeout: 30_000 })
      await expect(created).toContainText('created')
      const edited = pane.paneRoot.getByRole('button', { name: `Diff: ${path.join(lane.workspace, 'b.txt')}` })
      await expect(edited).toContainText('+1 −0')

      const diffResponse = lane.page.waitForResponse((response) => response.url().includes('/api/fresh-agent/diff'))
      await edited.click()
      expect((await diffResponse).status()).toBe(200)
      await expect(edited).toHaveAttribute('aria-expanded', 'true')
      // The git diff of b.txt: a hunk that adds the edited line.
      await expect(pane.paneRoot.getByText(/^@@ /)).toBeVisible()
      await expect(pane.paneRoot.getByText('+gamma', { exact: true })).toBeVisible()
    })
  })

  test('freshclaude: /cost output renders as a System row', async ({ browser }) => {
    await withLane(browser, { flavour: 'freshclaude' }, async (lane, pane) => {
      await lane.send(pane, '/cost')
      const systemRow = transcriptTurns(pane, /^System transcript turn$/).filter({ hasText: 'Total cost:' })
      await expect(systemRow).toHaveCount(1, { timeout: 30_000 })
      await expect(systemRow).toContainText('Total duration (API):')
      await lane.waitForIdle(pane)
      await expect(pane.paneRoot.getByText(/Total cost:/)).toHaveCount(1)
      await expect(pane.paneRoot.getByText(/local-command/)).toHaveCount(0)
    })
  })

  test('freshclaude: after an approved plan exit the gear shows Default, and the next send keeps it', async ({ browser }) => {
    await withLane(browser, { flavour: 'freshclaude', providerDefaults: { defaultPermissionMode: 'plan' } }, async (lane, pane) => {
      const { page } = lane
      const permissionMode = async (): Promise<string> => {
        await page.getByRole('button', { name: 'Agent settings' }).click()
        const dialog = page.getByRole('dialog', { name: 'Agent settings' })
        await expect(dialog).toBeVisible()
        const value = await dialog.getByRole('combobox', { name: 'Permission mode' }).inputValue()
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        return value
      }
      expect(await permissionMode(), 'the pane starts in plan mode').toBe('plan')

      // The model asks to leave plan mode (ExitPlanMode); the user approves
      // the plan on the plan card.
      await lane.send(pane, 'PLAN:exit')
      const approvePlan = page.getByRole('alert', { name: 'Plan approval request' }).getByRole('button', { name: 'Approve plan' })
      await expect(approvePlan).toBeVisible({ timeout: 30_000 })
      expect(startedPrompts(lane)).toEqual([{ text: 'PLAN:exit', permissionMode: 'plan' }])
      await approvePlan.click()
      await lane.waitForIdle(pane)

      await expect.poll(permissionMode, { timeout: 30_000, message: 'the gear follows the mode the CLI left plan mode for' }).toBe('default')

      await lane.send(pane, 'carry on after the plan')
      await lane.waitForIdle(pane)
      expect(startedPrompts(lane)).toEqual([
        { text: 'PLAN:exit', permissionMode: 'plan' },
        { text: 'carry on after the plan', permissionMode: 'default' },
      ])
      // Nothing put the CLI back into plan mode.
      const modeCalls = lane.ledger().filter((row) => row.kind === 'control' && row.name === 'setPermissionMode')
      expect(modeCalls.map((row) => (row.args as unknown[])[0])).not.toContain('plan')
      expect(await permissionMode()).toBe('default')
    })
  })

  test('freshclaude: a reload mid-session shows the same rich transcript, and the session goes on', async ({ browser }) => {
    const program = { rules: [onPrompt(REPLAY_PROMPT, [{ kind: 'replay', data: { recording: RECORDING } }])] }
    await withLane(browser, { flavour: 'freshclaude', program }, async (lane, pane) => {
      const { page, harness } = lane
      await expandToolsByDefault(lane)
      await lane.send(pane, REPLAY_PROMPT)
      await lane.waitForIdle(pane, 60_000)
      await expect(pane.paneRoot.getByText('All done.')).toHaveCount(1, { timeout: 30_000 })
      await expect(pane.paneRoot.getByTestId('fresh-agent-delegation-block')).toHaveAttribute('data-status', 'completed')

      /** Each transcript turn's name and text, in order. */
      const transcriptShape = async (root: Locator) => {
        const turns = root.getByRole('article', { name: /transcript turn$/ })
        return turns.evaluateAll((articles) => articles.map((article) => ({
          name: article.getAttribute('aria-label'),
          text: (article as HTMLElement).innerText,
        })))
      }
      const before = await transcriptShape(pane.paneRoot)
      expect(before.length).toBeGreaterThan(1)

      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const reloaded: ClaudeSimPane = { ...pane, paneRoot: page.locator('[data-context="fresh-agent"]').last() }
      await expect(reloaded.paneRoot.getByText('All done.')).toHaveCount(1, { timeout: 30_000 })
      await expect.poll(() => transcriptShape(reloaded.paneRoot), { timeout: 30_000, message: 'the reloaded transcript matches the one before' })
        .toEqual(before)
      await expect(reloaded.paneRoot.getByRole('button', { name: `Diff: ${path.join(lane.workspace, 'b.txt')}` })).toContainText('+1 −0')

      // The session is still live: the next turn runs on it.
      await lane.send(reloaded, 'hello again')
      await expect(agentTurns(reloaded).getByText('ok', { exact: true })).toHaveCount(1, { timeout: 30_000 })
      await lane.waitForIdle(reloaded)
      expect(startedPrompts(lane).map((row) => row.text)).toEqual([REPLAY_PROMPT, 'hello again'])
    })
  })
})
