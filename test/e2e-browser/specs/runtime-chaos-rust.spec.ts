/**
 * Phase 5 browser/controller restart chaos receipt.
 *
 * One real anonymous OpenCode soul remains alive while a pending approval,
 * long-running tool, 100 web replacements, and 20 supervisor replacements
 * exercise reconnect, output cursors, notices, and one-writer invariants.
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../helpers/fixtures.js'
import {
  createManagedRuntimeBrowserRig,
  P2_OPENCODE_MODEL,
  P2_OPENCODE_VERSION,
  type ExactRuntimeHandle,
  type ManagedRuntimeView,
  type ManagedFixtureRig,
} from '../helpers/managed-runtime.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import {
  captureChaosRuntimeObservation,
  nativeFollowUpMessageIds,
  nativeToolEvidence,
  structuredChaosLog,
  type ChaosRuntimeObservation,
  type StructuredChaosLog,
} from '../helpers/runtime-chaos-evidence.js'
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
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const suffix = lastError instanceof Error ? `; last error: ${lastError.message}` : ''
  throw new Error(`timed out waiting for ${description}${suffix}`)
}

async function ensureShell(page: Page, terminal: TerminalHelper): Promise<void> {
  if (await page.locator('.xterm').first().isVisible().catch(() => false)) return
  const shell = page.getByRole('button', { name: /^(Shell|Bash|WSL|CMD|PowerShell)$/i }).first()
  await shell.click()
  await terminal.waitForTerminal(0, 30_000)
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

async function pressInPane(page: Page, paneId: string, key: string): Promise<void> {
  const terminal = page.locator(`[data-pane-id="${paneId}"] .xterm:visible`).last()
  await terminal.waitFor({ state: 'visible', timeout: 90_000 })
  await terminal.click()
  await page.keyboard.press(key)
}

async function currentPaneTerminalId(
  harness: TestHarness,
  tabId: string,
  paneId: string,
): Promise<string | null> {
  const leaf = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
    .find((candidate) => candidate.id === paneId)
  return typeof leaf?.content?.terminalId === 'string' ? leaf.content.terminalId : null
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
    const terminalId = await currentPaneTerminalId(harness, tabId, paneId)
    if (!terminalId) return null
    const contains = await page.evaluate(({ id, searchText }) => {
      const buffer = (window as any).__FRESHELL_TEST_HARNESS__?.getTerminalBuffer?.(id)
      return typeof buffer === 'string' && buffer.includes(searchText)
    }, { id: terminalId, searchText: text })
    return contains ? terminalId : null
  }, timeoutMs)
}

async function runningView(rig: ManagedFixtureRig, terminalId: string): Promise<ManagedRuntimeView> {
  return waitForValue(`running managed view ${terminalId}`, async () => {
    const view = await rig.runningViewForTerminal(terminalId)
    return view?.containerId ? view : null
  }, 90_000)
}

function monotonicMs(): number {
  return Math.floor(performance.now())
}

async function exactFalseLossNoticeIds(
  page: Page,
  rig: ManagedFixtureRig,
  token: string,
  handle: ExactRuntimeHandle,
): Promise<string[]> {
  const notices = await page.evaluate(async ({ authToken }) => {
    const response = await fetch('/api/runtime/notices?profileId=profile%3Aphase5-chaos&limit=100', {
      headers: { authorization: `Bearer ${authToken}` },
    })
    if (!response.ok) throw new Error(`notice query failed with HTTP ${response.status}`)
    return (await response.json()).notices
  }, { authToken: token })
  const matching: string[] = []
  for (const notice of notices) {
    for (const incidentId of notice.incidentIds ?? notice.incident_ids ?? []) {
      if (await rig.incidentMatchesSoul(handle, incidentId)) matching.push(notice.noticeId ?? notice.notice_id)
    }
  }
  return [...new Set(matching)]
}

test.describe.serial('Phase 5 runtime chaos', () => {
  test('P5-G09: pending approval and long tool survive 100 web and 20 supervisor replacements', async ({ page }) => {
    test.skip(process.env.FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE !== '1', 'set FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE=1 for the chaos receipt')
    test.setTimeout(2_400_000)

    const rig = createManagedRuntimeBrowserRig(
      process.cwd(),
      5,
      {
        FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION: 'ask',
      },
      {
        FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '1000',
      },
    )
    await rig.captureCandidateIntegrity()
    const webCycles: Record<string, unknown>[] = []
    const supervisorCycles: Record<string, unknown>[] = []
    const browserLogs: Array<StructuredChaosLog & { source: 'browser' }> = []
    const serverLogs: Array<StructuredChaosLog & { source: 'server' }> = []
    let receiptReady = false
    try {
      const info = await rig.start()
      const migration = await rig.applyManagedOptIn(await rig.controlEpoch())
      expect(migration.currentMode).toBe('managed-opt-in')

      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 90_000 })
      const tabId = await harness.getActiveTabId()
      if (!tabId) throw new Error('P5-G09 has no active tab')
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
      const initial = await runningView(rig, terminalId)
      if (!initial.containerId || !initial.hostBootId) throw new Error('managed OpenCode lacks runtime identity')
      expect((await rig.openCodeVersionFacts(rig.runtimeEnclosureHandle(initial))).version).toBe(P2_OPENCODE_VERSION)

      await executeInPane(page, paneId, 'Reply with exactly P5_CHAOS_READY and use no tools.')
      await waitForPaneOutput(page, harness, tabId, paneId, 'P5_CHAOS_READY', 180_000)
      const providerSessionId = await waitForValue('native OpenCode session id', async () => {
        const content = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
          .find((candidate) => candidate.id === paneId)?.content
        return typeof content?.sessionRef?.sessionId === 'string' ? content.sessionRef.sessionId : null
      }, 120_000)
      const expectedRuntimeIdentity = { ...initial, nativeSessionId: providerSessionId }
      const nativeHandle = rig.exactRuntimeHandle(expectedRuntimeIdentity)
      const approvalChallenge = await rig.registerNativeChallenge(nativeHandle, 'chaos-approval')
      const longToolChallenge = await rig.registerNativeChallenge(nativeHandle, 'chaos-long-tool')
      const followUpChallenge = await rig.registerNativeChallenge(nativeHandle, 'chaos-follow-up')
      const initialRuntime = await captureChaosRuntimeObservation(rig, expectedRuntimeIdentity)

      // Permission remains provider-native and pending across web replacement.
      await rig.resetNativeChallengeEffect(nativeHandle, approvalChallenge.challengeId)
      await executeInPane(
        page,
        paneId,
        'Use the bash tool exactly once to run: printf "P5_CHAOS_APPROVED\\n" >> "$HOME/p5-chaos-approval-count". Do not continue until permission is granted.',
      )
      await waitForValue('OpenCode permission prompt', async () => {
        const currentId = await currentPaneTerminalId(harness, tabId, paneId)
        const text = await terminal.getVisibleText(currentId ?? terminalId)
        return text.includes('Permission required') && text.includes('Allow once') ? true : null
      }, 180_000)
      expect(await rig.nativeChallengeEffectCount(nativeHandle, approvalChallenge.challengeId)).toBe(0)
      const approvalBefore = await waitForValue('one pending provider-native approval tool request', async () => {
        const evidence = (await nativeToolEvidence(rig, nativeHandle, approvalChallenge.challengeId))
        return evidence.requestIds.length === 1 && evidence.resultIds.length === 0 && evidence.replayCount === 0
          ? evidence
          : null
      }, 60_000)
      const webBefore = await rig.webProcessFacts()
      const webBootBefore = await harness.getBootId()
      const webStarted = monotonicMs()
      const readyAt = await harness.getLastReadyAt()
      await rig.crashAndRestartWeb()
      await harness.waitForConnectionAfter(readyAt, 90_000)
      await waitForValue('permission prompt after web replacement', async () => {
        const currentId = await currentPaneTerminalId(harness, tabId, paneId)
        const text = await terminal.getVisibleText(currentId ?? terminalId)
        return text.includes('Permission required') && text.includes('Allow once') ? true : null
      }, 90_000)
      const webAfter = await rig.webProcessFacts()
      const webBootAfter = await harness.getBootId()
      const webEnded = monotonicMs()
      const firstRuntime = await captureChaosRuntimeObservation(rig, expectedRuntimeIdentity)
      webCycles.push({
        cycle: 1,
        mode: 'abrupt',
        attemptCount: webAfter.bootAttemptCount,
        startedMonotonicMs: webStarted,
        endedMonotonicMs: webEnded,
        beforePid: webBefore.pid,
        afterPid: webAfter.pid,
        beforeBootId: webBootBefore,
        afterBootId: webBootAfter,
        runtime: firstRuntime,
      })
      browserLogs.push(structuredChaosLog(
        'browser', 1, webEnded, 'info', 'web.replaced',
        JSON.stringify({
          cycle: 1, mode: 'abrupt', beforePid: webBefore.pid, afterPid: webAfter.pid,
          beforeBootId: webBootBefore, afterBootId: webBootAfter,
        }),
      ))
      await pressInPane(page, paneId, 'Enter')
      await waitForValue('approval tool exactly once', async () => (
        (await rig.nativeChallengeEffectCount(nativeHandle, approvalChallenge.challengeId)) === 1 ? true : null
      ), 180_000)
      const approvalAfter = await waitForValue('one completed provider-native approval tool result', async () => {
        const evidence = (await nativeToolEvidence(rig, nativeHandle, approvalChallenge.challengeId))
        return evidence.requestIds.length === 1 && evidence.resultIds.length === 1 && evidence.replayCount === 0
          ? evidence
          : null
      }, 60_000)
      expect(approvalAfter.requestIds).toEqual(approvalBefore.requestIds)

      // Start a long-running side effect and replace the web process repeatedly.
      await rig.resetNativeChallengeEffect(nativeHandle, longToolChallenge.challengeId)
      await executeInPane(
        page,
        paneId,
        'Use the bash tool exactly once to run: sleep 180; printf "P5_LONG_TOOL_DONE\\n" >> "$HOME/p5-chaos-long-tool-count". Do not finish until the command completes.',
      )
      await waitForValue('long tool process', async () => (
        await rig.chaosLongToolRunning(nativeHandle, longToolChallenge.challengeId) ? true : null
      ), 60_000)

      for (let cycle = 2; cycle <= 100; cycle += 1) {
        const beforeProcess = await rig.webProcessFacts()
        const beforeBootId = await harness.getBootId()
        const startedMonotonicMs = monotonicMs()
        const previousReady = await harness.getLastReadyAt()
        const mode = cycle % 2 === 1 ? 'abrupt' : 'graceful'
        if (mode === 'graceful') await rig.restartWebGracefully()
        else await rig.crashAndRestartWeb()
        await harness.waitForConnectionAfter(previousReady, 90_000)
        const currentLeaf = await waitForModeLeaf(
          harness,
          tabId,
          'opencode',
          (candidate) => candidate.id === paneId,
          30_000,
        )
        expect(currentLeaf.content.terminalId).toBe(terminalId)
        expect(currentLeaf.content.sessionRef?.sessionId).toBe(providerSessionId)
        const afterProcess = await rig.webProcessFacts()
        const afterBootId = await harness.getBootId()
        const endedMonotonicMs = monotonicMs()
        const runtime = await captureChaosRuntimeObservation(rig, expectedRuntimeIdentity)
        webCycles.push({
          cycle,
          mode,
          attemptCount: afterProcess.bootAttemptCount,
          startedMonotonicMs,
          endedMonotonicMs,
          beforePid: beforeProcess.pid,
          afterPid: afterProcess.pid,
          beforeBootId,
          afterBootId,
          runtime,
        })
        browserLogs.push(structuredChaosLog(
          'browser', cycle, endedMonotonicMs, 'info', 'web.replaced',
          JSON.stringify({
            cycle, mode, beforePid: beforeProcess.pid, afterPid: afterProcess.pid,
            beforeBootId, afterBootId,
          }),
        ))
      }

      for (let cycle = 1; cycle <= 20; cycle += 1) {
        const beforeSupervisor = await rig.supervisorProcessFacts()
        const beforeContainerId = beforeSupervisor.containerId
        const beforePid = beforeSupervisor.pid
        const beforeControlEpoch = await rig.controlEpoch()
        const mode = cycle % 2 === 1 ? 'abrupt' : 'graceful'
        const startedMonotonicMs = monotonicMs()
        if (mode === 'abrupt') await rig.restartSupervisorAbrupt()
        else await rig.restartSupervisor()
        await waitForValue(`supervisor restart ${cycle}`, async () => {
          const snapshot = await rig.inventorySnapshot()
          const row = snapshot.souls.filter((candidate: any) => candidate.soulId === initial.soulId).at(-1)
          return row?.launchState === 'running' ? row : null
        }, 60_000)
        const afterSupervisor = await rig.supervisorProcessFacts()
        const afterContainerId = afterSupervisor.containerId
        const afterPid = afterSupervisor.pid
        const afterControlEpoch = await rig.controlEpoch()
        const endedMonotonicMs = monotonicMs()
        const runtime = await captureChaosRuntimeObservation(rig, expectedRuntimeIdentity)
        supervisorCycles.push({
          cycle,
          mode,
          attemptCount: 1,
          startedMonotonicMs,
          endedMonotonicMs,
          beforeContainerId,
          afterContainerId,
          beforePid,
          afterPid,
          beforeControlEpoch,
          afterControlEpoch,
          runtime,
        })
        serverLogs.push(structuredChaosLog(
          'server', cycle, endedMonotonicMs, 'info', 'supervisor.replaced',
          JSON.stringify({ cycle, mode, beforeContainerId, afterContainerId, beforePid, afterPid }),
        ))
      }

      await waitForValue('long tool one side effect', async () => (
        (await rig.nativeChallengeEffectCount(nativeHandle, longToolChallenge.challengeId)) === 1 ? true : null
      ), 240_000)
      expect(await rig.nativeChallengeEffectCount(nativeHandle, longToolChallenge.challengeId)).toBe(1)
      await executeInPane(page, paneId, 'Reply with exactly P5_CHAOS_FOLLOWUP and use no tools.')
      await waitForPaneOutput(page, harness, tabId, paneId, 'P5_CHAOS_FOLLOWUP', 180_000)
      const longToolEvidence = await waitForValue('one completed native long-tool request/result', async () => {
        const evidence = (await nativeToolEvidence(rig, nativeHandle, longToolChallenge.challengeId))
        return evidence.requestIds.length === 1 && evidence.resultIds.length === 1 && evidence.replayCount === 0
          ? evidence
          : null
      }, 60_000)
      const followUpMessageIds = await waitForValue('one provider-native follow-up message', async () => {
        const ids = (await nativeFollowUpMessageIds(rig, nativeHandle, followUpChallenge.challengeId))
        return ids.length === 1 ? ids : null
      }, 60_000)

      const finalSnapshot = await rig.inventorySnapshot()
      const finalView = finalSnapshot.souls.filter((row: any) => row.soulId === initial.soulId).at(-1)
      if (!finalView) throw new Error('final chaos inventory has no exact soul')
      expect(finalView.incarnationId).toBe(initial.incarnationId)
      expect(finalView.containerId).toBe(initial.containerId)
      expect(finalView.hostBootId).toBe(initial.hostBootId)
      expect(finalView.nativeSessionId).toBe(providerSessionId)
      expect(finalView.evidenceRevision).toBeGreaterThan(0)
      const matchingNoticeIds = await exactFalseLossNoticeIds(page, rig, info.token, nativeHandle)
      expect(matchingNoticeIds).toEqual([])
      const finalRuntime: ChaosRuntimeObservation = await captureChaosRuntimeObservation(rig, expectedRuntimeIdentity)
      expect(finalRuntime).toEqual(initialRuntime)

      const capturedServer = await rig.chaosWebOutputFacts(nativeHandle, followUpChallenge.challengeId)
      expect(capturedServer.containsFollowUpMarker).toBe(false)
      expect(capturedServer.containsAuthToken).toBe(false)
      serverLogs.push({
        source: 'server', sequence: serverLogs.length + 1, monotonicMs: monotonicMs(), level: 'info',
        event: 'server.output.captured', contentSha256: capturedServer.contentSha256,
        contentBytes: capturedServer.contentBytes, redacted: true,
      })
      await rig.publishChaosLogs(nativeHandle, { server: serverLogs, browser: browserLogs })
      await rig.publishChaosEvidence(nativeHandle, { providerEvents: {
        schemaVersion: 1,
        provider: 'opencode',
        nativeSessionId: providerSessionId,
        approval: {
          requestIds: approvalAfter.requestIds,
          resultIds: approvalAfter.resultIds,
          providerDecisionCount: approvalAfter.resultIds.length - approvalBefore.resultIds.length,
          replayCount: approvalAfter.replayCount,
        },
        longTool: longToolEvidence,
        followUp: { messageIds: followUpMessageIds, completedCount: followUpMessageIds.length },
      }, assertions: {
        schemaVersion: 1,
        caseId: 'P5-G09',
        test: { total: 1, passed: 1, failed: 0, skipped: 0 },
        identity: {
          provider: 'opencode',
          providerVersion: P2_OPENCODE_VERSION,
          model: P2_OPENCODE_MODEL,
          paneId,
          terminalId,
          ...initialRuntime,
        },
        webCycles,
        supervisorCycles,
        approval: {
          toolRequestId: approvalAfter.requestIds[0],
          decisionsBeforeClick: approvalBefore.resultIds.length,
          decisionsAfterClick: approvalAfter.resultIds.length,
          markerCount: await rig.nativeChallengeEffectCount(nativeHandle, approvalChallenge.challengeId),
        },
        longTool: {
          toolRequestId: longToolEvidence.requestIds[0],
          markerCount: await rig.nativeChallengeEffectCount(nativeHandle, longToolChallenge.challengeId),
          sleepSeconds: 180,
        },
        falseLossQuery: {
          profileId: 'profile:phase5-chaos',
          soulId: initial.soulId,
          evidenceRevision: finalView.evidenceRevision,
          matchingNoticeIds,
        },
        followUp: { nativeMessageId: followUpMessageIds[0], completed: true },
      } })
      receiptReady = true
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    expect(receiptReady).toBe(true)
    const receipt = await rig.finalizeChaosReceipt()
    expect(receipt.artifactRef).toMatch(/^phase5-chaos:[a-f0-9]{64}$/)
    console.log(`[P5-G09] evidence-derived chaos receipt: ${receipt.artifactRef}`)
  })
})
