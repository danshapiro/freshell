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
  createManagedRuntimeBrowserRig,
  P2_OPENCODE_MODEL,
  P2_OPENCODE_VERSION,
  type ManagedRuntimeView,
  type SyntheticOpenCodeSourceFacts,
  type ManagedFixtureRig,
  type Phase3BrowserObservation,
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

type NativeDigests = {
  sessions: string[]
  messages: Record<string, string>
  parts: Record<string, string>
}

async function providerHistoryDigests(rig: ManagedFixtureRig, view: ManagedRuntimeView): Promise<NativeDigests> {
  return rig.syntheticOpenCodeHistoryFacts(rig.exactRuntimeHandle(view))
}

async function assertExcludedSentinelsAbsent(rig: ManagedFixtureRig, view: ManagedRuntimeView): Promise<void> {
  const matches = await rig.syntheticOpenCodeExcludedSentinels(rig.exactRuntimeHandle(view))
  expect(matches).toEqual([])
}

function assertBaselinePreserved(source: SyntheticOpenCodeSourceFacts, installed: NativeDigests): void {
  expect(installed.sessions).toEqual([source.childId, source.grandchildId, source.rootId].sort())
  for (const [id, digest] of Object.entries(source.baselineMessages)) expect(installed.messages[id], id).toBe(digest)
  for (const [id, digest] of Object.entries(source.baselineParts)) expect(installed.parts[id], id).toBe(digest)
}

test.describe.serial('Phase 3 provider resurrection', () => {
  test('P3-G10: pending native approval survives exact provider resurrection', async ({ page }) => {
    test.skip(process.env.FRESHELL_RUNTIME_PHASE3_LIVE !== '1', 'set FRESHELL_RUNTIME_PHASE3_LIVE=1 for the live provider receipt')
    // Live-provider wall clock: this case drives a real model turn, a web
    // restart, a provider kill with exact native resurrection, an approval
    // round trip and a follow-up turn. The per-step budgets below are what
    // actually guard correctness; this envelope only has to be larger than
    // their sum. The 20-minute envelope was observed for the earlier Big Pickle
    // lane; the step budgets below remain the correctness guards for this model.
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
      expect((await rig.openCodeVersionFacts(rig.runtimeEnclosureHandle(before))).version).toBe(P2_OPENCODE_VERSION)
      await rig.resetPhase3ApprovalEffect(rig.runtimeEnclosureHandle(before))

      // Phrase this as the ordinary file-edit task it is. The earlier
      // anonymous model refused the prior wording outright, producing no tool
      // call or permission prompt and therefore not exercising Freshell's
      // approval plumbing. The prompt remains ordinary and provider-neutral.
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
      expect(await rig.phase3ApprovalEffectCount(rig.runtimeEnclosureHandle(before))).toBe(0)

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
      expect(await rig.phase3ApprovalEffectCount(rig.runtimeEnclosureHandle(before))).toBe(0)

      const currentBeforeCrash = await waitForRunningView(rig, terminalId,
        view => view.incarnationId === before.incarnationId && view.nativeSessionId === providerSessionIdBefore, 120_000)
      await rig.crashRuntimeHost(rig.exactRuntimeHandle(currentBeforeCrash))
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
      const accidentalApproval = await rig.phase3ApprovalEffectCount(rig.runtimeEnclosureHandle(after)) !== 0
      expect(promptAfterRecovery).toContain('Permission required')
      expect(accidentalApproval).toBe(false)

      // "Allow once" is the provider-native default selected action.
      await terminal.pressKey('Enter', 1)
      const toolEffectCount = await waitForValue('exactly one provider tool side effect', async () => {
        const count = await rig.phase3ApprovalEffectCount(rig.runtimeEnclosureHandle(after))
        return count === 1 ? count : null
      }, 180_000)
      expect(toolEffectCount).toBe(1)

      await terminal.executeCommandInserted('Reply with exactly P3_FOLLOWUP_OK and use no tools.', 1)
      await terminal.waitForOutput('P3_FOLLOWUP_OK', {
        terminalId,
        timeout: 180_000,
      })
      const followUpText = await terminal.getVisibleText(terminalId)
      expect(await rig.phase3ApprovalEffectCount(rig.runtimeEnclosureHandle(after))).toBe(1)

      const browserObservation: Phase3BrowserObservation = {
        browserInteraction: true,
        provider: 'opencode',
        providerVersion: P2_OPENCODE_VERSION,
        model: P2_OPENCODE_MODEL,
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
        followUpCompleted: followUpText.includes('P3_FOLLOWUP_OK'),
        followUpResponse: 'P3_FOLLOWUP_OK',
      }
      const currentForReceipt = await waitForRunningView(rig, terminalId,
        view => view.incarnationId === after.incarnationId && view.nativeSessionId === providerSessionIdAfter, 120_000)
      const { artifactRef } = await rig.publishPhase3BrowserReceipt(rig.exactRuntimeHandle(currentForReceipt), browserObservation)
      // eslint-disable-next-line no-console
      console.log(`[P3-G10] provider resurrection receipt: ${artifactRef}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})

test.describe('managed OpenCode source-to-soul resume', () => {
  test('imports only the selected synthetic conversation and reopens under its native ID', async ({ page }) => {
    // The local Docker rig launches the pinned real TUI. Keep this explicit
    // opt-in so a broad local run cannot access Docker by accident. The
    // recovery proof below does not submit a prompt. Set the separate
    // FOLLOWUP opt-in only when a synthetic provider turn is specifically
    // needed.
    test.skip(process.env.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1', 'requires owned synthetic-resume opt-in')
    test.setTimeout(900_000)

    const rig = createManagedRuntimeBrowserRig(process.cwd(), 3)
    try {
      const source = await rig.prepareSyntheticOpenCodeSource()
      const nonce = source.nonce
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)

      const row = page.locator(`[data-session-id="${source.rootId}"][data-provider="opencode"]`)
      await expect(row, 'the isolated source is discoverable as an OpenCode session').toBeVisible({ timeout: 30_000 })
      const priorTabId = await harness.getActiveTabId()
      await row.click()
      const tabId = await waitForValue('selected session tab', async () => {
        const current = await harness.getActiveTabId()
        return current && current !== priorTabId ? current : null
      }, 30_000)
      const leaf = await waitForModeLeaf(harness, tabId, 'opencode',
        (candidate) => candidate.content?.sessionRef?.sessionId === source.rootId, 60_000)
      const terminalId: string = leaf.content.terminalId
      const paneId: string = leaf.id
      const before = await waitForValue('imported managed runtime view', async () => {
        const view = await rig.runningViewForTerminal(terminalId)
        return view?.nativeSessionId === source.rootId && view.containerId && view.hostBootId ? view : null
      }, 180_000)
      expect(before.soulId).toBeTruthy()
      expect(before.containerId).toBeTruthy()

      // The stage is removed once import receipts are durable. Verify the
      // actual provider database after the managed launch instead of requiring
      // transient staging bytes to outlive their documented cleanup point.
      const imported = (await providerHistoryDigests(rig, before))
      assertBaselinePreserved(source, imported)
      expect(Object.keys(imported.messages)).toHaveLength(Object.keys(source.baselineMessages).length)
      expect(Object.keys(imported.parts)).toHaveLength(Object.keys(source.baselineParts).length)
      await assertExcludedSentinelsAbsent(rig, before)

      // Wait for the session host to accept the TUI's exact-session/current-tail
      // observation. A live runtime alone can still reject input at this gate.
      const adoption = await waitForValue('provider-observed managed pane', async () => {
        const status = (await rig.syntheticOpenCodeAdoptionStatus(rig.exactRuntimeHandle(before)))
        return status.state === 'observed' ? status.data.observation : null
      }, 180_000)
      expect(adoption).toMatchObject({
        terminalId,
        incarnationId: before.incarnationId,
        rootSessionId: source.rootId,
        tailMessageId: source.lastMessageId,
        hydrated: true,
        messagesRead: 'success',
      })
      expect(adoption.evidenceGeneration).toMatch(/^[0-9a-f]{64}$/)
      expect(adoption.launchNonce).toBeTruthy()
      await expect(page.getByText('Offline: input will queue until reconnected.')).toHaveCount(0)
      expect(await terminal.getVisibleText(terminalId)).not.toContain('Workspace Unavailable')
      let expectedTailMessageId = source.lastMessageId
      let appended: NativeDigests | null = null
      if (process.env.FRESHELL_RUNTIME_SYNTHETIC_RESUME_FOLLOWUP === '1') {
        await page.locator(`[data-pane-id="${paneId}"] .xterm:visible`).last().waitFor({ state: 'visible' })
        await page.locator(`[data-pane-id="${paneId}"] .xterm:visible`).last().click()
        await page.keyboard.insertText(`Reply with exactly SYNTHETIC_FOLLOWUP_${nonce} and use no tools.`)
        await page.keyboard.press('Enter')
        const nativeFollowup = await waitForValue('completed synthetic follow-up in native history', async () => {
          return rig.syntheticOpenCodeFollowUpMessageId(rig.exactRuntimeHandle(before))
        }, 180_000)
        expect(nativeFollowup).toBeTruthy()
        expectedTailMessageId = nativeFollowup
        appended = await waitForValue('native follow-up append', async () => {
          const snapshot = (await providerHistoryDigests(rig, before))
          return snapshot.messages[nativeFollowup] ? snapshot : null
        }, 180_000)
        assertBaselinePreserved(source, appended)
      }

      await rig.crashRuntimeHost(rig.exactRuntimeHandle(before))
      const reopened = await waitForValue('same soul reopened after provider loss', async () => {
        const view = await rig.runningViewForTerminal(terminalId)
        return view?.containerId && view.hostBootId && view.incarnationId !== before.incarnationId ? view : null
      }, 180_000)
      expect(reopened.soulId).toBe(before.soulId)
      expect(reopened.nativeSessionId).toBe(source.rootId)
      expect(reopened.hostBootId).not.toBe(before.hostBootId)
      const reopenedAdoption = await waitForValue('replacement provider-observed managed pane', async () => {
        // The probe authenticates this exact host boot against the reopened
        // inventory row before reading its input gate.
        const status = (await rig.syntheticOpenCodeAdoptionStatus(rig.exactRuntimeHandle(reopened)))
        return status.state === 'observed' ? status.data.observation : null
      }, 180_000)
      expect(reopenedAdoption).toMatchObject({
        terminalId,
        incarnationId: reopened.incarnationId,
        rootSessionId: source.rootId,
        tailMessageId: expectedTailMessageId,
        hydrated: true,
        messagesRead: 'success',
      })
      expect(reopenedAdoption.evidenceGeneration).toMatch(/^[0-9a-f]{64}$/)
      expect(reopenedAdoption.launchNonce).toBeTruthy()
      expect(reopenedAdoption.launchNonce).not.toBe(adoption.launchNonce)
      const reopenedHistory = (await providerHistoryDigests(rig, reopened))
      assertBaselinePreserved(source, reopenedHistory)
      if (appended) {
        for (const [id, digest] of Object.entries(appended.messages)) expect(reopenedHistory.messages[id], id).toBe(digest)
      } else {
        expect(Object.keys(reopenedHistory.messages)).toHaveLength(Object.keys(source.baselineMessages).length)
        expect(Object.keys(reopenedHistory.parts)).toHaveLength(Object.keys(source.baselineParts).length)
      }

      // The host copy remains the original source; managed turns are never
      // written back into that store.
      expect((await rig.syntheticOpenCodeSourceFacts()).rootMessageCount).toBe(106)
      expect((await rig.chaosHostFacts(rig.exactRuntimeHandle(reopened))).unsafeBrokerAttempts).toBe(0)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
