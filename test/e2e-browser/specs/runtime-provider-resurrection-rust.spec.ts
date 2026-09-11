/**
 * Phase 3 live browser receipt for exact provider resurrection.
 *
 * This test is deliberately opt-in: it performs a real anonymous OpenCode
 * turn, drives the provider's native permission prompt, kills the owned
 * runtime, and writes a candidate-bound receipt only after every assertion.
 */
import { expect, type Page } from '@playwright/test'

import { test } from '../helpers/fixtures.js'
import {
  ManagedRuntimeBrowserRig,
  P2_OPENCODE_FREE_MODEL,
  P2_OPENCODE_VERSION,
  type ManagedRuntimeView,
} from '../helpers/managed-runtime.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { TestHarness } from '../helpers/test-harness.js'

function leavesByMode(node: any, mode: string): any[] {
  if (!node) return []
  if (node.type === 'leaf') return node.content?.mode === mode ? [node] : []
  if (node.type === 'split') {
    return (node.children ?? []).flatMap((child: any) => leavesByMode(child, mode))
  }
  return []
}

async function waitForValue<T>(
  description: string,
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== null && value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const suffix = lastError instanceof Error ? `; last error: ${lastError.message}` : ''
  throw new Error(`timed out waiting for ${description}${suffix}`)
}

async function ensureShell(page: Page, terminal: TerminalHelper): Promise<void> {
  if (await page.locator('.xterm').first().isVisible().catch(() => false)) return
  for (const name of ['Shell', 'Bash', 'WSL', 'CMD', 'PowerShell']) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first()
    if (await button.isVisible().catch(() => false)) {
      await button.click()
      await terminal.waitForTerminal(0, 30_000)
      return
    }
  }
  throw new Error('Phase 3 browser gate could not select a shell')
}

function waitForModeLeaf(
  harness: TestHarness,
  tabId: string,
  mode: string,
  predicate: (leaf: any) => boolean,
  timeoutMs: number,
): Promise<any> {
  return waitForValue(`${mode} pane identity`, async () => {
    const leaf = leavesByMode(await harness.getPaneLayout(tabId), mode).find(predicate)
    return leaf?.content?.terminalId ? leaf : null
  }, timeoutMs)
}

function waitForRunningView(
  rig: ManagedRuntimeBrowserRig,
  terminalId: string,
  predicate: (view: ManagedRuntimeView) => boolean,
  timeoutMs: number,
): Promise<ManagedRuntimeView> {
  return waitForValue(`running managed view for ${terminalId}`, async () => {
    const view = await rig.runningViewForTerminal(terminalId)
    return view && predicate(view) ? view : null
  }, timeoutMs)
}

function markerLineCount(rig: ManagedRuntimeBrowserRig, containerId: string): number {
  const raw = rig.ownedProviderExec(containerId, [
    'sh',
    '-lc',
    'if test -f "$HOME/p3-tool-effect-count"; then wc -l < "$HOME/p3-tool-effect-count"; else printf 0; fi',
  ]).trim()
  return /^\d+$/.test(raw) ? Number(raw) : -1
}

test.describe.serial('Phase 3 provider resurrection', () => {
  test('P3-G10: pending native approval survives exact provider resurrection', async ({ page, e2eServerKind }) => {
    test.skip(process.env.FRESHELL_RUNTIME_PHASE3_LIVE !== '1', 'set FRESHELL_RUNTIME_PHASE3_LIVE=1 for the live provider receipt')
    expect(e2eServerKind).toBe('rust')
    // Live-provider wall clock: this case drives a real model turn, a web
    // restart, a provider kill with exact native resurrection, an approval
    // round trip and a follow-up turn. The per-step budgets below are what
    // actually guard correctness; this envelope only has to be larger than
    // their sum. Observed ~20min against opencode/big-pickle, so 20min was
    // the envelope AND the observed runtime -- the case died of the envelope,
    // not of any step.
    test.setTimeout(2_400_000)

    const rig = new ManagedRuntimeBrowserRig(process.cwd(), 3, {
      FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION: 'ask',
      // Debug-only, bounded delay makes the input fence observable without
      // changing release timing or recovery semantics.
      FRESHELL_MANAGED_RECOVERY_TEST_DELAY_MS: '7000',
    })

    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 90_000 })

      const tabId = await harness.getActiveTabId()
      if (!tabId) throw new Error('P3-G10 has no active tab')
      const existing = new Set(leavesByMode(await harness.getPaneLayout(tabId), 'opencode').map((leaf) => leaf.id))
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
      const dirInput = page.getByRole('combobox', { name: /Starting directory for OpenCode/i })
      await expect(dirInput).toBeVisible({ timeout: 15_000 })
      await dirInput.fill(rig.repoRoot)
      await dirInput.press('Enter')

      const leaf = await waitForModeLeaf(
        harness,
        tabId,
        'opencode',
        (candidate) => !existing.has(candidate.id),
        90_000,
      )
      const paneId: string = leaf.id
      const terminalId: string = leaf.content.terminalId
      const content = async () => {
        const current = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
          .find((candidate) => candidate.id === paneId)
        return current?.content
      }

      await terminal.waitForTerminal(1, 90_000)
      await terminal.waitForOutput('Ask anything', { terminalId, timeout: 120_000 })
      const before = await waitForRunningView(
        rig,
        terminalId,
        (view) => Boolean(view.containerId && view.hostBootId),
        90_000,
      )
      if (!before.containerId || !before.hostBootId) throw new Error('managed OpenCode view lacks container/host identity')
      expect(rig.ownedContainerExec(before.containerId, ['opencode', '--version']).trim()).toBe(P2_OPENCODE_VERSION)
      rig.ownedProviderExec(before.containerId, ['sh', '-lc', 'rm -f "$HOME/p3-tool-effect-count"'])

      // Phrase this as the ordinary file-edit task it is. An earlier wording
      // ("do not continue until permission is granted") read as manipulation
      // to the free-tier model, which refused outright -- no tool call, so no
      // permission prompt, so nothing about Freshell's approval plumbing was
      // exercised at all. The assertions below are unchanged; only the natural
      // language that has to survive provider safety behaviour is.
      await terminal.executeCommandInserted(
        `Append the exact line P3_APPROVAL_EFFECT to the file $HOME/p3-tool-effect-count. Use the bash tool exactly once and no other tool.`,
        1,
      )
      await waitForValue('native OpenCode permission prompt', async () => {
        const text = await terminal.getVisibleText(terminalId)
        return text.includes('Permission required') && text.includes('Allow once') && text.includes('P3_APPROVAL_EFFECT')
          ? text
          : null
      }, 180_000)
      expect(markerLineCount(rig, before.containerId)).toBe(0)

      // OpenCode writes its session row on the FIRST turn, never at TUI start
      // -- that IS the capability manifest's `session-row-must-materialize`
      // zero-turn policy, verified directly: a 25s TUI with no prompt leaves
      // `session` empty in opencode.db. So the exact native id is only
      // observable once a turn exists, which the approval prompt above
      // guarantees. Capturing it earlier can only ever time out.
      const providerSessionIdBefore = await waitForValue('native OpenCode session id', async () => {
        const value = (await content())?.sessionRef?.sessionId
        return typeof value === 'string' && value.length > 0 ? value : null
      }, 120_000)

      const readyBeforeWebRestart = await harness.getLastReadyAt()
      await rig.crashAndRestartWeb()
      await harness.waitForConnectionAfter(readyBeforeWebRestart, 90_000)
      const leafAfterWebRestart = await waitForModeLeaf(
        harness,
        tabId,
        'opencode',
        (candidate) => candidate.id === paneId && candidate.content?.terminalId === terminalId,
        90_000,
      )
      const afterWebRestart = await waitForRunningView(
        rig,
        terminalId,
        (view) => view.incarnationId === before.incarnationId,
        90_000,
      )
      const providerHostSurvivedWebRestart = afterWebRestart.containerId === before.containerId
        && afterWebRestart.hostBootId === before.hostBootId
      expect(providerHostSurvivedWebRestart).toBe(true)
      const approvalSurvivedWebRestart = await waitForValue('approval prompt after web restart', async () => {
        const text = await terminal.getVisibleText(terminalId)
        return text.includes('Permission required') && text.includes('Allow once') ? true : null
      }, 90_000)
      expect(leafAfterWebRestart.id).toBe(paneId)
      expect(approvalSurvivedWebRestart).toBe(true)
      expect(markerLineCount(rig, before.containerId)).toBe(0)

      rig.runtime.killOwnedRuntimeExact(before.containerId)
      await new Promise((resolve) => setTimeout(resolve, 1_500))

      const fenceNotice = await waitForValue('visible managed recovery input fence', async () => {
        await terminal.typeInTerminal(`P3_RECOVERY_FENCE_${Date.now()}\n`, 1)
        await new Promise((resolve) => setTimeout(resolve, 250))
        const text = await terminal.getVisibleText(terminalId)
        return text.includes('Input not sent: this managed session is recovering') ? text : null
      }, 4_500)
      const rejectedInputWhileRecovering = fenceNotice.includes('Input not sent: this managed session is recovering')
      expect(rejectedInputWhileRecovering).toBe(true)

      const after = await waitForRunningView(
        rig,
        terminalId,
        (view) => view.incarnationId !== before.incarnationId && Boolean(view.containerId),
        180_000,
      )
      if (!after.containerId) throw new Error('replacement managed OpenCode view lacks container identity')
      expect(after.soulId).toBe(before.soulId)
      expect(after.incarnationId).not.toBe(before.incarnationId)
      const providerSessionIdAfter = await waitForValue('same native session after recovery', async () => {
        const value = (await content())?.sessionRef?.sessionId
        return value === providerSessionIdBefore ? value : null
      }, 120_000)
      expect(providerSessionIdAfter).toBe(providerSessionIdBefore)

      const promptAfterRecovery = await waitForValue('pending approval after provider recovery', async () => {
        const text = await terminal.getVisibleText(terminalId)
        return text.includes('Permission required') && text.includes('Allow once') ? text : null
      }, 180_000)
      const visibleRecoveryState = rejectedInputWhileRecovering && after.incarnationId !== before.incarnationId
      const accidentalApproval = markerLineCount(rig, after.containerId) !== 0
      expect(promptAfterRecovery).toContain('Permission required')
      expect(accidentalApproval).toBe(false)

      // "Allow once" is the provider-native default selected action.
      await terminal.pressKey('Enter', 1)
      const toolEffectCount = await waitForValue('exactly one provider tool side effect', () => {
        const count = markerLineCount(rig, after.containerId!)
        return count === 1 ? count : null
      }, 180_000)
      expect(toolEffectCount).toBe(1)

      await terminal.executeCommandInserted('Reply with exactly P3_FOLLOWUP_OK and use no tools.', 1)
      await terminal.waitForOutput('P3_FOLLOWUP_OK', {
        terminalId,
        timeout: 180_000,
      })
      expect(markerLineCount(rig, after.containerId)).toBe(1)

      const receipt = {
        schemaVersion: 1,
        status: 'PASS',
        candidateSha: rig.runtime.candidateSha,
        browser: {
          browserInteraction: true,
          provider: 'opencode',
          providerVersion: P2_OPENCODE_VERSION,
          model: P2_OPENCODE_FREE_MODEL,
          paneId,
          terminalId,
          soulId: before.soulId,
          incarnationIdBefore: before.incarnationId,
          incarnationIdAfter: after.incarnationId,
          providerSessionIdBefore,
          providerSessionIdAfter,
          approvalPromptNativeId: providerSessionIdBefore,
          permissionPromptHandled: toolEffectCount === 1,
          approvalSurvived: approvalSurvivedWebRestart && promptAfterRecovery.includes('Permission required'),
          samePane: leafAfterWebRestart.id === paneId,
          visibleRecoveryState,
          rejectedInputWhileRecovering,
          accidentalApproval,
          toolCompletedExactlyOnce: toolEffectCount === 1,
          providerHostSurvivedWebRestart,
          followUpCompleted: true, // terminal.waitForOutput above rejects unless the marker appears
          followUpResponse: 'P3_FOLLOWUP_OK',
        },
      }
      const receiptPath = rig.writeResurrectionResult(receipt)
      // eslint-disable-next-line no-console
      console.log(`[P3-G10] provider resurrection receipt: ${receiptPath}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
