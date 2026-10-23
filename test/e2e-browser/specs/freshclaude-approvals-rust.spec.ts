// FRESHCLAUDE APPROVALS -- client-alerts plan G20 (PR-C, D12): how a
// freshclaude or kilroy pane answers Claude's permission requests, end to end
// through the real Rust server, the PRODUCTION Claude sidecar and the Claude
// CLI simulator (helpers/claude-sim-lane.ts). The simulator's canUseTool
// carries the suggestions a program gives it, records every answer it gets in
// its ledger, and applies an accepted setMode the way the pinned CLI does
// (pinned by test/integration/providers/claude-permission-contract.test.ts).
//
//   1. "Allow and don't ask again" sends the CLI's own suggestions as
//      updatedPermissions; a later request is never answered by the client:
//      its card waits for a click (this replaces the old client-only
//      "Always allow Bash this session" case of fresh-agent-control-rust);
//   2. ExitPlanMode shows the plan card: the plan renders as markdown, and
//      "Approve and auto-accept edits" sends a session setMode, so the CLI
//      leaves plan mode for acceptEdits, the gear shows Accept edits, and the
//      next send runs in it;
//   3. kilroy gets the same "Allow and don't ask again".
//
// CLOUD-LEGALITY: no CLI binary and no network; every wait polls observed
// state, except one bounded window in case 1 that checks nothing answers a
// visible card (a client auto-answer would go out as the card renders). This
// spec must NOT be added to CLOUD_SKIP_SPECS.

import { test, expect } from '../helpers/fixtures.js'
import {
  ClaudeSimLane,
  onPrompt,
  type ClaudeSimFlavour,
  type ClaudeSimLaneOptions,
  type ClaudeSimPane,
} from '../helpers/claude-sim-lane.js'

const NPM_RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow', destination: 'localSettings' }
const TEST_PROMPT = 'run the tests'
const BUILD_PROMPT = 'build the project'
const PLAN_PROMPT = 'make a plan'
const PLAN = '# Ship the parser\n\n1. Edit `parser.ts`\n2. Run the tests'

const program = {
  rules: [
    onPrompt(TEST_PROMPT, [
      { kind: 'approval', data: { tool: 'Bash', input: { command: 'npm test' }, suggestions: [NPM_RULE] } },
      { kind: 'text', data: { text: 'The tests ran.' } },
    ]),
    // A different command: the CLI asks again (its rule covers `npm test *` only).
    onPrompt(BUILD_PROMPT, [
      { kind: 'approval', data: { tool: 'Bash', input: { command: 'npm run build' } } },
      { kind: 'text', data: { text: 'The build ran.' } },
    ]),
    onPrompt(PLAN_PROMPT, [
      { kind: 'exit_plan', data: { plan: PLAN } },
      { kind: 'text', data: { text: 'Leaving plan mode.' } },
    ]),
  ],
}

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

/** Every answer the simulated CLI's canUseTool received, in order. */
function cliDecisions(lane: ClaudeSimLane): unknown[] {
  return lane.ledger().filter((row) => row.kind === 'can_use_tool').map((row) => row.decision)
}

/** The prompts the simulated CLI started, with the permission mode each ran under. */
function startedPrompts(lane: ClaudeSimLane) {
  return lane.ledger()
    .filter((row) => row.kind === 'prompt')
    .map((row) => ({ text: String(row.text ?? ''), permissionMode: row.permissionMode }))
}

async function rememberSendsTheSuggestions(lane: ClaudeSimLane, pane: ClaudeSimPane) {
  await lane.send(pane, TEST_PROMPT)
  const card = pane.paneRoot.getByRole('alert', { name: 'Permission request for Bash' })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.getByRole('list', { name: 'What "Allow and don\'t ask again" saves' })).toContainText('Bash(npm test *)')
  await expect(card.getByRole('button', { name: /always allow/i })).toHaveCount(0)
  expect(cliDecisions(lane), 'nothing is answered before the click').toEqual([])

  await card.getByRole('button', { name: 'Allow and don\'t ask again' }).click()
  await expect.poll(() => cliDecisions(lane), { timeout: 15_000, message: 'the CLI gets its own suggestions back' })
    .toEqual([{ behavior: 'allow', updatedPermissions: [NPM_RULE] }])
  await expect(card).toBeHidden({ timeout: 15_000 })
  await lane.waitForIdle(pane)
}

test.describe('freshclaude approvals (production sidecar over the CLI simulator, Rust server)', () => {
  test.setTimeout(180_000)

  test('freshclaude: "Allow and don\'t ask again" sends the CLI\'s suggestions, and the client never answers a later request by itself', async ({ browser }) => {
    await withLane(browser, { flavour: 'freshclaude', program, providerDefaults: { defaultPermissionMode: 'default' } }, async (lane, pane) => {
      await rememberSendsTheSuggestions(lane, pane)

      await lane.send(pane, BUILD_PROMPT)
      const card = pane.paneRoot.getByRole('alert', { name: 'Permission request for Bash' })
      await expect(card).toContainText('npm run build', { timeout: 30_000 })
      // The card stays up with nothing answered until the user clicks (a
      // client auto-answer would go out as the card renders: give it a window).
      await lane.page.waitForTimeout(1_500)
      await expect(card).toBeVisible()
      expect(cliDecisions(lane)).toHaveLength(1)

      await card.getByRole('button', { name: 'Allow tool use' }).click()
      await expect.poll(() => cliDecisions(lane), { timeout: 15_000 }).toHaveLength(2)
      expect(cliDecisions(lane)[1]).toEqual({ behavior: 'allow' })
      await lane.waitForIdle(pane)
    })
  })

  test('freshclaude: the plan card renders the plan, "Approve and auto-accept edits" leaves plan mode for Accept edits, and the next send keeps it', async ({ browser }) => {
    await withLane(browser, { flavour: 'freshclaude', program, providerDefaults: { defaultPermissionMode: 'plan' } }, async (lane, pane) => {
      const { page } = lane
      const gear = async () => {
        await page.getByRole('button', { name: 'Agent settings' }).click()
        const dialog = page.getByRole('dialog', { name: 'Agent settings' })
        await expect(dialog).toBeVisible()
        const mode = dialog.getByRole('combobox', { name: 'Permission mode' })
        const value = await mode.inputValue()
        const shown = value ? await mode.getByRole('option', { selected: true }).textContent() : null
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        return { value, shown }
      }
      expect((await gear()).value, 'the pane starts in plan mode').toBe('plan')

      await lane.send(pane, PLAN_PROMPT)
      const card = pane.paneRoot.getByRole('alert', { name: 'Plan approval request' })
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card.getByRole('heading', { name: 'Ship the parser' })).toBeVisible()
      await expect(pane.paneRoot.getByRole('alert', { name: /permission request/i })).toHaveCount(0)

      await card.getByRole('button', { name: 'Approve and auto-accept edits' }).click()
      await expect.poll(() => cliDecisions(lane), { timeout: 15_000 }).toEqual([
        { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
      ])
      await lane.waitForIdle(pane)
      await expect.poll(gear, { timeout: 30_000, message: 'the gear follows the mode the CLI moved to' })
        .toEqual({ value: 'acceptEdits', shown: 'Accept edits' })

      await lane.send(pane, 'carry on with the plan')
      await lane.waitForIdle(pane)
      expect(startedPrompts(lane)).toEqual([
        { text: PLAN_PROMPT, permissionMode: 'plan' },
        { text: 'carry on with the plan', permissionMode: 'acceptEdits' },
      ])
    })
  })

  test('kilroy: "Allow and don\'t ask again" sends the CLI\'s suggestions', async ({ browser }) => {
    const flavour: ClaudeSimFlavour = 'kilroy'
    await withLane(browser, { flavour, program, providerDefaults: { defaultPermissionMode: 'default' } }, async (lane, pane) => {
      await rememberSendsTheSuggestions(lane, pane)
    })
  })
})
