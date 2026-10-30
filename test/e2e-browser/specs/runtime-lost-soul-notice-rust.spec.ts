/**
 * Phase 5 live loss receipt.
 *
 * Uses authenticated OpenCode state inside the test-owned provider
 * volume. The test performs a real turn, retains a diagnostic-only marker,
 * removes every registered resumable copy, terminates only the host-recorded
 * provider PID, and verifies incident-before-cleanup, ended-pane retention,
 * a pane-local recovery decision for the lost conversation, and zero
 * foreign/credential access.
 */
import { expect, type Page } from '@playwright/test'

import { test } from '../helpers/fixtures.js'
import {
  createManagedRuntimeBrowserRig,
  type ManagedFixtureRig,
  P2_OPENCODE_MODEL,
  P2_OPENCODE_VERSION,
  type ManagedRuntimeView,
} from '../helpers/managed-runtime.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { TestHarness } from '../helpers/test-harness.js'
function leavesByMode(node: any, mode: string): any[] {
  if (!node) return []
  if (node.type === 'leaf') return node.content?.mode === mode ? [node] : []
  if (node.type === 'split') return (node.children ?? []).flatMap((child: any) => leavesByMode(child, mode))
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
  throw new Error('Phase 5 loss receipt could not select a shell')
}

function waitForModeLeaf(
  harness: TestHarness,
  tabId: string,
  mode: string,
  predicate: (leaf: any) => boolean,
  timeoutMs: number,
): Promise<any> {
  return waitForValue(`${mode} pane`, async () => {
    const leaf = leavesByMode(await harness.getPaneLayout(tabId), mode).find(predicate)
    return leaf?.content?.terminalId ? leaf : null
  }, timeoutMs)
}

async function waitForPaneTerminal(page: Page, paneId: string, timeoutMs = 90_000): Promise<void> {
  await page
    .locator(`[data-pane-id="${paneId}"] .xterm:visible`)
    .last()
    .waitFor({ state: 'visible', timeout: timeoutMs })
}

async function executeInPane(page: Page, paneId: string, command: string): Promise<void> {
  const terminal = page.locator(`[data-pane-id="${paneId}"] .xterm:visible`).last()
  await terminal.waitFor({ state: 'visible', timeout: 90_000 })
  await terminal.click()
  await page.keyboard.insertText(command)
  await page.keyboard.press('Enter')
}

async function waitForPaneOutput(
  page: Page,
  harness: TestHarness,
  tabId: string,
  paneId: string,
  text: string,
  timeoutMs: number,
): Promise<string> {
  return waitForValue(`pane ${paneId} output ${text}`, async () => {
    const leaf = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
      .find((candidate) => candidate.id === paneId)
    const terminalId = leaf?.content?.terminalId
    if (typeof terminalId !== 'string' || terminalId.length === 0) return null
    const contains = await page.evaluate(({ id, searchText }) => {
      const buffer = (window as any).__FRESHELL_TEST_HARNESS__?.getTerminalBuffer?.(id)
      return typeof buffer === 'string' && buffer.includes(searchText)
    }, { id: terminalId, searchText: text })
    return contains ? terminalId : null
  }, timeoutMs)
}

function waitForRunningView(
  rig: ManagedFixtureRig,
  terminalId: string,
  timeoutMs: number,
): Promise<ManagedRuntimeView> {
  return waitForValue(`running view ${terminalId}`, async () => {
    const view = await rig.runningViewForTerminal(terminalId)
    return view?.containerId ? view : null
  }, timeoutMs)
}

test.describe.serial('Phase 5 certified provider loss', () => {
  test('P5-G02: real OpenCode loss persists incident before exact cleanup and shows the actionable pane path', async ({ page }) => {
    test.skip(process.env.FRESHELL_RUNTIME_PHASE5_LIVE !== '1', 'set FRESHELL_RUNTIME_PHASE5_LIVE=1 for the live loss receipt')
    test.setTimeout(1_200_000)

    const rig = createManagedRuntimeBrowserRig(
      process.cwd(),
      5,
      {},
      { FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '60000' },
    )
    await rig.captureCandidateIntegrity()
    let receiptReady = false
    try {
      const info = await rig.start()
      const controlEpoch = await rig.controlEpoch()
      const migration = await rig.applyManagedOptIn(controlEpoch)
      expect(migration.currentMode).toBe('managed-opt-in')

      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 90_000 })
      const tabId = await harness.getActiveTabId()
      if (!tabId) throw new Error('P5-G02 has no active tab')

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
      await waitForPaneTerminal(page, paneId, 90_000)
      const terminalId = await waitForPaneOutput(
        page,
        harness,
        tabId,
        paneId,
        'Ask anything',
        120_000,
      )
      const before = await waitForRunningView(rig, terminalId, 90_000)
      if (!before.containerId) throw new Error('OpenCode managed view lacks container identity')
      expect((await rig.openCodeVersionFacts(rig.runtimeEnclosureHandle(before))).version).toBe(P2_OPENCODE_VERSION)

      const diagnostic = 'phase5-diagnostic-retained-no-credential'
      await executeInPane(
        page,
        paneId,
        `Use the bash tool exactly once to run: printf '${diagnostic}\\n' > "$HOME/p5-diagnostic-only". Reply with exactly P5_STATE_READY when complete.`,
      )
      await expect.poll(() => rig.lossDiagnosticRetained(rig.runtimeEnclosureHandle(before)), { timeout: 180_000 }).toBe(true)
      const providerSessionId = await waitForValue('native OpenCode session id', async () => {
        const content = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
          .find((candidate) => candidate.id === paneId)?.content
        return typeof content?.sessionRef?.sessionId === 'string' ? content.sessionRef.sessionId : null
      }, 120_000)
      expect(providerSessionId).toMatch(/^ses_/)

      const workerHandle = rig.exactRuntimeHandle({ ...before, nativeSessionId: providerSessionId })
      const workerPid = (await rig.chaosHostFacts(workerHandle)).workerPid
      expect(workerPid).toBeGreaterThan(1)

      const credentialPath = '/home/freshell/provider/.local/share/opencode/auth.json'
      const credentialBefore = await rig.lossCredentialEvidence(rig.runtimeEnclosureHandle(before))

      // Retain only a diagnostic marker; remove OpenCode session DB/artifacts
      // and all Freshell checkpoint copies without reading or mutating host
      // credentials. Then terminate exactly the recorded provider PID.
      // Observe the entire transition so a popup that flashes and disappears
      // cannot be certified as invisible from its final DOM state alone.
      await page.evaluate(() => {
        const selector = '[aria-label="Managed runtime notice"]'
        const observation = {
          maximumCount: document.querySelectorAll(selector).length,
          observer: new MutationObserver((records) => {
            const addedNotice = records.some((record) => Array.from(record.addedNodes)
              .some((node) => node instanceof Element
                && (node.matches(selector) || node.querySelector(selector) !== null)))
            observation.maximumCount = Math.max(
              observation.maximumCount,
              document.querySelectorAll(selector).length,
              addedNotice ? 1 : 0,
            )
          }),
        }
        observation.observer.observe(document.body, { childList: true, subtree: true })
        ;(window as any).__FRESHELL_PHASE5_NOTICE_OBSERVATION__ = observation
      })
      await rig.crashProviderWorker(workerHandle)
      await rig.removeLossStorage(workerHandle)
      const diagnosticOnlyRetained = await rig.lossDiagnosticRetained(rig.runtimeEnclosureHandle(before))
      expect(diagnosticOnlyRetained).toBe(true)
      const credentialAfter = await rig.lossCredentialEvidence(rig.runtimeEnclosureHandle(before))
      expect(credentialAfter).toEqual(credentialBefore)
      const exactAbsenceChecks = await rig.lossAbsenceEvidence(rig.runtimeEnclosureHandle(before))
      expect(exactAbsenceChecks.every((row) => row.state === 'absent')).toBe(true)

      const result = await rig.recoverLoss(workerHandle)
      expect(result.outcome).toBe('lost')
      expect(result.incidentId).toMatch(/^incident-/)
      expect(result.view.cleanupState).toBe('verified_empty')
      expect(result.view.nativeSessionId).toBe(providerSessionId)
      expect(await rig.lossContainerRunning(result.incidentId)).toBe(false)

      const ended = await waitForValue('ended managed pane projection', async () => {
        const state = await page.evaluate(() => (window as any).__FRESHELL_TEST__?.getState?.())
        const current = state?.panes?.layouts?.[tabId]
        const managed = leavesByMode(current, 'opencode').find((candidate) => candidate.id === paneId)
        return managed?.content?.recoverySummary?.recoveryState === 'lost' ? managed : null
      }, 60_000)
      expect(ended.content.soulId).toBe(before.soulId)
      expect(ended.content.incidentId).toBe(result.incidentId)
      expect(ended.content.sessionRef.sessionId).toBe(providerSessionId)

      // Verified cleanup is routine and is acknowledged without a popup. The
      // lost conversation itself remains in place and owns the actionable
      // amber card, including the explicitly labeled start-new action.
      await expect.poll(() => page.locator('[aria-label="Managed runtime notice"]').count(), {
        timeout: 30_000,
      }).toBe(0)
      const paneRecoveryCard = page.locator(`[data-pane-id="${paneId}"] [data-testid="managed-runtime-recovery-card"]`)
      await expect(paneRecoveryCard).toBeVisible({ timeout: 60_000 })
      await expect(paneRecoveryCard).toContainText(/could not be recovered/i)
      const startNewConversation = paneRecoveryCard.getByRole('button', { name: 'Start new conversation' })
      await expect(startNewConversation).toBeVisible()
      await expect(startNewConversation).toBeEnabled()
      const visibleRecoveryCards = page.locator('[data-testid="managed-runtime-recovery-card"]:visible')
      await expect(visibleRecoveryCards).toHaveCount(1)
      const recoveryCards = await visibleRecoveryCards.evaluateAll((cards) => cards.map((card) => {
        const button = Array.from(card.querySelectorAll('button'))
          .find((candidate) => candidate.textContent?.trim() === 'Start new conversation')
        return {
          paneId: card.closest('[data-pane-id]')?.getAttribute('data-pane-id'),
          lossMessageVisible: /could not be recovered/i.test(card.textContent ?? ''),
          startNewConversationEnabled: !!button && !button.disabled
            && button.getClientRects().length > 0,
        }
      }))
      const routineNoticeCount = await page.evaluate(() => {
        const observation = (window as any).__FRESHELL_PHASE5_NOTICE_OBSERVATION__
        if (!observation) throw new Error('loss notice observation is missing')
        observation.observer.disconnect()
        const maximumCount = Math.max(
          observation.maximumCount,
          document.querySelectorAll('[aria-label="Managed runtime notice"]').length,
        )
        delete (window as any).__FRESHELL_PHASE5_NOTICE_OBSERVATION__
        return maximumCount
      })
      expect(routineNoticeCount).toBe(0)

      const incidentArtifact = await rig.lossIncidentEvidence(result.incidentId)
      expect(incidentArtifact.persisted).toBe(true)
      expect(incidentArtifact.containsNativeSessionId).toBe(false)
      expect(incidentArtifact.containsControlSecret).toBe(false)
      expect(incidentArtifact.certificateSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(incidentArtifact.certificate.intentRevision).toBe(before.intentRevision)
      expect(result.view.intentRevision).toBe(before.intentRevision + 1)
      await rig.publishLossAssertions(result.incidentId, {
        schemaVersion: 2,
        caseId: 'P5-G02',
        test: { total: 1, passed: 1, failed: 0, skipped: 0 },
        identity: {
          provider: 'opencode',
          providerVersion: P2_OPENCODE_VERSION,
          model: P2_OPENCODE_MODEL,
          soulId: before.soulId,
          incarnationId: before.incarnationId,
          containerId: before.containerId,
          hostBootId: workerHandle.hostBootId,
          nativeSessionIdHash: incidentArtifact.certificate.nativeSessionRefHash,
          incidentId: result.incidentId,
          paneId,
          terminalId,
        },
        intent: {
          checkedRevision: before.intentRevision,
          lossRevision: incidentArtifact.certificate.intentRevision,
          endedRevision: result.view.intentRevision,
        },
        providerState: {
          exactAbsenceChecks,
          credentialIntegrity: [{
            path: credentialPath,
            beforeExists: credentialBefore.exists,
            afterExists: credentialAfter.exists,
            beforeSha256: credentialBefore.sha256,
            afterSha256: credentialAfter.sha256,
          }],
        },
        browser: {
          routineNoticeCount,
          recoveryCards,
          endedPane: {
            soulId: ended.content.soulId,
            incarnationId: before.incarnationId,
            incidentId: ended.content.incidentId,
            nativeSessionIdHash: incidentArtifact.certificate.nativeSessionRefHash,
            recoveryState: ended.content.recoverySummary.recoveryState,
          },
        },
      })
      receiptReady = true
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    expect(receiptReady).toBe(true)
    const receipt = await rig.finalizeLossReceipt()
    expect(receipt.artifactRef).toMatch(/^phase5-loss:[0-9a-f]{64}$/)
    console.log(`[P5-G02] real OpenCode loss receipt: ${receipt.artifactRef}`)
  })
})
