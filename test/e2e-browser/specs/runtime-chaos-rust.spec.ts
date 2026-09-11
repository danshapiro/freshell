/**
 * Phase 5 browser/controller restart chaos receipt.
 *
 * One real anonymous OpenCode soul remains alive while a pending approval,
 * long-running tool, 100 web replacements, and 20 supervisor replacements
 * exercise reconnect, output cursors, notices, and one-writer invariants.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'

import { sha256 } from '../../../scripts/testing/runtime-phase5-evidence-common.js'
import {
  assertPhase5ChaosRun,
  PHASE5_CHAOS_ASSERTIONS_FILE,
  PHASE5_CHAOS_PROVIDER_EVENTS_FILE,
} from '../../../scripts/testing/runtime-phase5-chaos-evidence.js'
import { test } from '../helpers/fixtures.js'
import {
  ManagedRuntimeBrowserRig,
  P2_OPENCODE_FREE_MODEL,
  P2_OPENCODE_VERSION,
  type ManagedRuntimeView,
} from '../helpers/managed-runtime.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import {
  captureChaosRuntimeObservation,
  nativeFollowUpMessageIds,
  nativeToolEvidence,
  structuredChaosLog,
  writePrivateJson,
  writePrivateJsonl,
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

function dataOf(result: any, kind: string): any {
  if (!result || result.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(result)}`)
  return result.data
}

async function runningView(rig: ManagedRuntimeBrowserRig, terminalId: string): Promise<ManagedRuntimeView> {
  return waitForValue(`running managed view ${terminalId}`, async () => {
    const view = await rig.runningViewForTerminal(terminalId)
    return view?.containerId ? view : null
  }, 90_000)
}

function markerCount(rig: ManagedRuntimeBrowserRig, containerId: string, name: string): number {
  const raw = rig.ownedProviderExec(containerId, [
    'sh', '-lc', `test -f "$HOME/${name}" && wc -l < "$HOME/${name}" || printf 0`,
  ]).trim()
  return /^\d+$/.test(raw) ? Number(raw) : -1
}

function monotonicMs(): number {
  return Math.floor(performance.now())
}

async function exactFalseLossNoticeIds(
  page: Page,
  rig: ManagedRuntimeBrowserRig,
  token: string,
  soulId: string,
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
      const incident = dataOf(await rig.runtime.adminOk(
        rig.supervisor,
        rig.runtime.incidentSummaryBody(incidentId, await rig.controlEpoch()),
      ), 'incident_summary')
      if (incident.soulId === soulId || incident.soul_id === soulId) matching.push(notice.noticeId ?? notice.notice_id)
    }
  }
  return [...new Set(matching)]
}

test.describe.serial('Phase 5 runtime chaos', () => {
  test('P5-G09: pending approval and long tool survive 100 web and 20 supervisor replacements', async ({ page, e2eServerKind }) => {
    test.skip(process.env.FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE !== '1', 'set FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE=1 for the chaos receipt')
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(2_400_000)

    const rig = new ManagedRuntimeBrowserRig(
      process.cwd(),
      5,
      {
        FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION: 'ask',
      },
      {
        FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '1000',
      },
    )
    const webCycles: Record<string, unknown>[] = []
    const supervisorCycles: Record<string, unknown>[] = []
    const browserLogs: StructuredChaosLog[] = []
    const serverLogs: StructuredChaosLog[] = []
    let receiptReady = false
    try {
      const info = await rig.start()
      const migration = dataOf(await rig.runtime.adminOk(
        rig.supervisor,
        rig.runtime.migrationPlanBody({
          requestedMode: 'managed-opt-in',
          apply: true,
          expectedControlEpoch: await rig.controlEpoch(),
        }),
      ), 'migration_plan')
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
      expect(rig.ownedContainerExec(initial.containerId, ['opencode', '--version']).trim()).toBe(P2_OPENCODE_VERSION)

      await executeInPane(page, paneId, 'Reply with exactly P5_CHAOS_READY and use no tools.')
      await waitForPaneOutput(page, harness, tabId, paneId, 'P5_CHAOS_READY', 180_000)
      const providerSessionId = await waitForValue('native OpenCode session id', async () => {
        const content = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
          .find((candidate) => candidate.id === paneId)?.content
        return typeof content?.sessionRef?.sessionId === 'string' ? content.sessionRef.sessionId : null
      }, 120_000)
      const expectedRuntimeIdentity = { ...initial, nativeSessionId: providerSessionId }
      const initialRuntime = await captureChaosRuntimeObservation(rig, expectedRuntimeIdentity)

      // Permission remains provider-native and pending across web replacement.
      rig.ownedProviderExec(initial.containerId, ['rm', '-f', '/home/freshell/provider/p5-chaos-approval-count'])
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
      expect(markerCount(rig, initial.containerId, 'p5-chaos-approval-count')).toBe(0)
      const approvalBefore = await waitForValue('one pending provider-native approval tool request', () => {
        const evidence = nativeToolEvidence(rig, initial.containerId!, providerSessionId, 'p5-chaos-approval-count')
        return evidence.requestIds.length === 1 && evidence.resultIds.length === 0 && evidence.replayCount === 0
          ? evidence
          : null
      }, 60_000)
      const webBefore = rig.web.processEvidence()
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
      const webAfter = rig.web.processEvidence()
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
      await waitForValue('approval tool exactly once', () => (
        markerCount(rig, initial.containerId!, 'p5-chaos-approval-count') === 1 ? true : null
      ), 180_000)
      const approvalAfter = await waitForValue('one completed provider-native approval tool result', () => {
        const evidence = nativeToolEvidence(rig, initial.containerId!, providerSessionId, 'p5-chaos-approval-count')
        return evidence.requestIds.length === 1 && evidence.resultIds.length === 1 && evidence.replayCount === 0
          ? evidence
          : null
      }, 60_000)
      expect(approvalAfter.requestIds).toEqual(approvalBefore.requestIds)

      // Start a long-running side effect and replace the web process repeatedly.
      rig.ownedProviderExec(initial.containerId, ['rm', '-f', '/home/freshell/provider/p5-chaos-long-tool-count'])
      await executeInPane(
        page,
        paneId,
        'Use the bash tool exactly once to run: sleep 180; printf "P5_LONG_TOOL_DONE\\n" >> "$HOME/p5-chaos-long-tool-count". Do not finish until the command completes.',
      )
      await waitForValue('long tool process', async () => {
        const table = rig.ownedContainerProcessTable(initial.containerId!)
        return table.includes('sleep 180') ? true : null
      }, 60_000)

      for (let cycle = 2; cycle <= 100; cycle += 1) {
        const beforeProcess = rig.web.processEvidence()
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
        const afterProcess = rig.web.processEvidence()
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
        const beforeContainerId = rig.supervisor.containerId
        const beforePid = rig.runtime.ownedContainerHostPidExact(beforeContainerId)
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
        const afterContainerId = rig.supervisor.containerId
        const afterPid = rig.runtime.ownedContainerHostPidExact(afterContainerId)
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

      await waitForValue('long tool one side effect', () => (
        markerCount(rig, initial.containerId!, 'p5-chaos-long-tool-count') === 1 ? true : null
      ), 240_000)
      expect(markerCount(rig, initial.containerId, 'p5-chaos-long-tool-count')).toBe(1)
      await executeInPane(page, paneId, 'Reply with exactly P5_CHAOS_FOLLOWUP and use no tools.')
      await waitForPaneOutput(page, harness, tabId, paneId, 'P5_CHAOS_FOLLOWUP', 180_000)
      const longToolEvidence = await waitForValue('one completed native long-tool request/result', () => {
        const evidence = nativeToolEvidence(rig, initial.containerId!, providerSessionId, 'p5-chaos-long-tool-count')
        return evidence.requestIds.length === 1 && evidence.resultIds.length === 1 && evidence.replayCount === 0
          ? evidence
          : null
      }, 60_000)
      const followUpMessageIds = await waitForValue('one provider-native follow-up message', () => {
        const ids = nativeFollowUpMessageIds(rig, initial.containerId!, providerSessionId, 'P5_CHAOS_FOLLOWUP')
        return ids.length === 1 ? ids : null
      }, 60_000)

      const finalSnapshot = await rig.inventorySnapshot()
      const finalView = finalSnapshot.souls.filter((row: any) => row.soulId === initial.soulId).at(-1)
      expect(finalView.incarnationId).toBe(initial.incarnationId)
      expect(finalView.containerId).toBe(initial.containerId)
      expect(finalView.hostBootId).toBe(initial.hostBootId)
      expect(finalView.nativeSessionId).toBe(providerSessionId)
      expect(finalView.evidenceRevision).toBeGreaterThan(0)
      const matchingNoticeIds = await exactFalseLossNoticeIds(page, rig, info.token, initial.soulId)
      expect(matchingNoticeIds).toEqual([])
      const finalRuntime: ChaosRuntimeObservation = await captureChaosRuntimeObservation(rig, expectedRuntimeIdentity)
      expect(finalRuntime).toEqual(initialRuntime)

      const capturedServer = rig.web.capturedOutput()
      const capturedServerBytes = `${capturedServer.stdout}${capturedServer.stderr}`
      expect(capturedServerBytes).not.toContain('P5_CHAOS_FOLLOWUP')
      expect(capturedServerBytes).not.toContain(info.token)
      serverLogs.push(structuredChaosLog(
        'server', serverLogs.length + 1, monotonicMs(), 'info', 'server.output.captured', capturedServerBytes,
      ))
      writePrivateJsonl(path.join(rig.runtime.evidenceDir, 'phase5-chaos-server-log.jsonl'), serverLogs)
      writePrivateJsonl(path.join(rig.runtime.evidenceDir, 'phase5-chaos-browser-log.jsonl'), browserLogs)
      writePrivateJson(path.join(rig.runtime.evidenceDir, PHASE5_CHAOS_PROVIDER_EVENTS_FILE), {
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
      })
      writePrivateJson(path.join(rig.runtime.evidenceDir, PHASE5_CHAOS_ASSERTIONS_FILE), {
        schemaVersion: 1,
        candidateSha: rig.runtime.candidateSha,
        receiptRunId: rig.runtime.runId,
        caseId: 'P5-G09',
        test: { total: 1, passed: 1, failed: 0, skipped: 0 },
        identity: {
          provider: 'opencode',
          providerVersion: P2_OPENCODE_VERSION,
          model: P2_OPENCODE_FREE_MODEL,
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
          markerCount: markerCount(rig, initial.containerId, 'p5-chaos-approval-count'),
        },
        longTool: {
          toolRequestId: longToolEvidence.requestIds[0],
          markerCount: markerCount(rig, initial.containerId, 'p5-chaos-long-tool-count'),
          sleepSeconds: 180,
        },
        falseLossQuery: {
          profileId: 'profile:phase5-chaos',
          soulId: initial.soulId,
          evidenceRevision: finalView.evidenceRevision,
          matchingNoticeIds,
        },
        followUp: { nativeMessageId: followUpMessageIds[0], completed: true },
      })
      receiptReady = true
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    expect(receiptReady).toBe(true)
    fs.copyFileSync(
      path.join(rig.repoRoot, 'docs/development/runtime-provider-capabilities.json'),
      path.join(rig.runtime.evidenceDir, 'phase5-capability-inventory.json'),
    )
    fs.chmodSync(path.join(rig.runtime.evidenceDir, 'phase5-capability-inventory.json'), 0o600)
    const result = assertPhase5ChaosRun(rig.runtime.evidenceDir)
    const receipt = { status: 'PASS', summary: result.summary,
      buildCommit: rig.runtime.candidateSha, runtimeImage: rig.runtime.imageRef }
    const receiptPath = rig.writeChaosResult(receipt)
    // eslint-disable-next-line no-console
    console.log(`[P5-G09] evidence-derived chaos receipt: ${receiptPath}`)
  })
})
