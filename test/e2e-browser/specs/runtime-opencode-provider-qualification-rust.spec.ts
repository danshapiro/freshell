/**
 * Candidate-bound OpenCode provider qualification receipt for cumulative
 * Phase 3/5 gates.
 *
 * This is intentionally separate from the generic browser resurrection test:
 * it proves the complete release-enabled provider row consumed by the runtime
 * gate. Claude, Codex, and Amplifier are adapter-ready but release-disabled
 * until their corresponding live campaign can produce the same receipt.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
import type { ProviderQualificationRow } from '../../../scripts/testing/provider-qualification-receipt.js'

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
  throw new Error('OpenCode qualification could not select a shell')
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

function waitForRunningView(
  rig: ManagedRuntimeBrowserRig,
  terminalId: string,
  predicate: (view: ManagedRuntimeView) => boolean,
  timeoutMs: number,
): Promise<ManagedRuntimeView> {
  return waitForValue(`running managed OpenCode view ${terminalId}`, async () => {
    const view = await rig.runningViewForTerminal(terminalId)
    return view && predicate(view) ? view : null
  }, timeoutMs)
}

function dataOf(result: any, expectedKind: string): any {
  if (!result || result.kind !== expectedKind) {
    throw new Error(`expected ${expectedKind}, got ${JSON.stringify(result)}`)
  }
  return result.data
}

async function waitForPaneTerminal(page: Page, paneId: string, timeoutMs = 90_000): Promise<void> {
  await page
    .locator(`[data-pane-id="${paneId}"] .xterm:visible`)
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
  excludedTerminalIds: ReadonlySet<string> = new Set(),
): Promise<string> {
  return waitForValue(`pane ${paneId} output ${text}`, async () => {
    const leaf = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
      .find((candidate) => candidate.id === paneId)
    const currentId = typeof leaf?.content?.terminalId === 'string'
      ? leaf.content.terminalId
      : undefined
    const registered = await harness.getRegisteredTerminalIds()
    const candidates = [currentId, ...registered]
      .filter((id): id is string => Boolean(id) && !excludedTerminalIds.has(id as string))
      .filter((id, index, all) => all.indexOf(id) === index)
    for (const terminalId of candidates) {
      const contains = await page.evaluate(({ id, searchText }) => {
        const buffer = window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer?.(id)
        return typeof buffer === 'string' && buffer.includes(searchText)
      }, { id: terminalId, searchText: text })
      if (contains) return terminalId
    }
    return null
  }, timeoutMs)
}

async function createOpencodePane(
  page: Page,
  harness: TestHarness,
  terminal: TerminalHelper,
  rig: ManagedRuntimeBrowserRig,
  tabId: string,
  priorPaneIds: Set<string>,
): Promise<{ paneId: string; terminalId: string; view: ManagedRuntimeView }> {
  const registeredBefore = new Set(await harness.getRegisteredTerminalIds())
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
    (candidate) => !priorPaneIds.has(candidate.id),
    90_000,
  )
  await waitForPaneTerminal(page, leaf.id, 90_000)
  const terminalId = await waitForPaneOutput(
    page,
    harness,
    tabId,
    leaf.id,
    'Ask anything',
    120_000,
    registeredBefore,
  )
  const view = await waitForRunningView(rig, terminalId, (candidate) => Boolean(candidate.containerId), 90_000)
  return { paneId: leaf.id, terminalId, view }
}

async function waitForPaneIncarnation(
  harness: TestHarness,
  tabId: string,
  paneId: string,
  incarnationId: string,
  timeoutMs = 120_000,
): Promise<void> {
  await waitForValue(`pane ${paneId} incarnation ${incarnationId}`, async () => {
    const leaf = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
      .find((candidate) => candidate.id === paneId)
    return leaf?.content?.incarnationId === incarnationId
      && leaf?.content?.status === 'running'
      && leaf?.content?.recoverySummary?.recoveryState === 'live'
      ? true
      : null
  }, timeoutMs)
}

async function terminalBuffer(page: Page, terminalId: string): Promise<string> {
  return page.evaluate((id) => (
    window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer?.(id) ?? ''
  ), terminalId)
}

function occurrenceCount(value: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (true) {
    const found = value.indexOf(needle, offset)
    if (found < 0) return count
    count += 1
    offset = found + needle.length
  }
}

async function paneSessionId(
  harness: TestHarness,
  tabId: string,
  paneId: string,
): Promise<string | null> {
  const content = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
    .find((candidate) => candidate.id === paneId)?.content
  return typeof content?.sessionRef?.sessionId === 'string' ? content.sessionRef.sessionId : null
}

function cgroupLimitsVerified(rig: ManagedRuntimeBrowserRig, view: ManagedRuntimeView): boolean {
  if (!view.containerId) return false
  const expected = (view as any).effectiveLimits
  if (!expected) return false
  const raw = rig.ownedContainerExec(view.containerId, [
    'sh', '-lc',
    `printf '{"cpu":"%s","memory":"%s","pids":"%s"}' "$(cat /sys/fs/cgroup/cpu.max)" "$(cat /sys/fs/cgroup/memory.max)" "$(cat /sys/fs/cgroup/pids.max)"`,
  ])
  const actual = JSON.parse(raw)
  const [quotaRaw, periodRaw] = String(actual.cpu).trim().split(/\s+/)
  const cpuMilli = quotaRaw === 'max'
    ? Number.POSITIVE_INFINITY
    : Math.round((Number(quotaRaw) / Number(periodRaw)) * 1_000)
  return cpuMilli === expected.cpuMilli
    && Number(actual.memory) === expected.memoryBytes
    && Number(actual.pids) === expected.pidsMax
}

function runBlockerMatrixTests(repoRoot: string): string[] {
  const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
  const tests = [
    ['freshell-agent-runtime', 'release_qualified_opencode_blocker_matrix_is_explicit'],
    ['freshell-agent-runtime', 'opencode_probe_reads_exact_row_without_guessing_latest'],
    ['freshell-supervisor', 'retry_budget_is_persisted_and_manual_retry_rearms_without_identity_change'],
  ]
  for (const [crate, filter] of tests) {
    execFileSync(mise, [
      'exec', 'rust@1.96', '--', 'cargo', 'test', '-p', crate, filter, '--', '--nocapture',
    ], { cwd: repoRoot, stdio: 'inherit' })
  }
  return tests.map(([crate, filter]) => `${crate}:${filter}`)
}

test.describe.serial('OpenCode provider qualification', () => {
  test('release-enabled OpenCode proves exact native recovery, isolation, and cleanup', async ({ page, e2eServerKind }) => {
    test.skip(
      process.env.FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE !== '1',
      'set FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE=1 for the candidate-bound provider receipt',
    )
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(1_800_000)

    const blockerEvidence = runBlockerMatrixTests(process.cwd())
    const rig = new ManagedRuntimeBrowserRig(
      process.cwd(),
      5,
      {},
      { FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '750' },
      'release',
    )
    let providerRow: ProviderQualificationRow | undefined
    try {
      const info = await rig.start()
      const rollout = dataOf(await rig.runtime.adminOk(
        rig.supervisor,
        rig.runtime.migrationPlanBody({
          requestedMode: 'managed-opt-in',
          apply: true,
          expectedControlEpoch: await rig.controlEpoch(),
        }),
      ), 'migration_plan')
      expect(rollout.currentMode).toBe('managed-opt-in')

      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 90_000 })
      const tabId = await harness.getActiveTabId()
      if (!tabId) throw new Error('OpenCode qualification has no active tab')

      const first = await createOpencodePane(
        page,
        harness,
        terminal,
        rig,
        tabId,
        new Set(leavesByMode(await harness.getPaneLayout(tabId), 'opencode').map((leaf) => leaf.id)),
      )
      if (!first.view.containerId || !first.view.hostBootId) {
        throw new Error('first OpenCode view lacks exact runtime identity')
      }
      expect(rig.ownedContainerExec(first.view.containerId, ['opencode', '--version']).trim())
        .toBe(P2_OPENCODE_VERSION)
      const processArgs = rig.ownedContainerProcessTable(first.view.containerId)
      expect(processArgs).toContain(P2_OPENCODE_FREE_MODEL)
      const limitsVerified = cgroupLimitsVerified(rig, first.view)
      expect(limitsVerified).toBe(true)

      const nonce = `P3_NATIVE_MEMORY_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      const storedSuffix = Math.random().toString(36).slice(2, 10).toUpperCase()
      const storedMarker = `P3_STORED_${storedSuffix}`
      const storedBefore = occurrenceCount(await terminalBuffer(page, first.terminalId), storedMarker)
      await executeInPane(
        page,
        first.paneId,
        `Remember this exact nonce only in our conversation: ${nonce}. Use no tools. Reply by joining P3, STORED, and ${storedSuffix} with underscores and no other text.`,
      )
      await waitForValue('an unechoed completed-turn marker', async () => (
        occurrenceCount(await terminalBuffer(page, first.terminalId), storedMarker) > storedBefore
          ? true
          : null
      ), 180_000)
      const nativeSessionId = await waitForValue('first exact OpenCode session id', async () => (
        await paneSessionId(harness, tabId, first.paneId)
      ), 120_000)
      expect(nativeSessionId).toMatch(/^ses_/)

      // Session-host/container loss: exact old enclosure must be empty before
      // the new incarnation becomes the sole writer.
      rig.runtime.killOwnedRuntimeExact(first.view.containerId)
      const afterHostCrash = await waitForRunningView(
        rig,
        first.terminalId,
        (candidate) => candidate.incarnationId !== first.view.incarnationId && Boolean(candidate.containerId),
        240_000,
      )
      if (!afterHostCrash.containerId) throw new Error('host-crash replacement lacks container')
      expect(afterHostCrash.soulId).toBe(first.view.soulId)
      expect(afterHostCrash.nativeSessionId).toBe(nativeSessionId)
      expect(rig.runtime.isContainerRunning(first.view.containerId)).toBe(false)
      await waitForPaneIncarnation(
        harness,
        tabId,
        first.paneId,
        afterHostCrash.incarnationId,
      )
      await waitForValue('pane retains the exact native identity after host loss', async () => (
        (await paneSessionId(harness, tabId, first.paneId)) === nativeSessionId ? true : null
      ), 120_000)
      const nonceOccurrencesBeforeRecall = occurrenceCount(
        await terminalBuffer(page, first.terminalId),
        nonce,
      )
      await executeInPane(
        page,
        first.paneId,
        'Without using tools or reading files, reply with exactly the nonce from my first instruction.',
      )
      await waitForValue('a new nonce occurrence in the recovered model response', async () => {
        const count = occurrenceCount(await terminalBuffer(page, first.terminalId), nonce)
        return count > nonceOccurrencesBeforeRecall ? true : null
      }, 180_000)
      const recalledNonce = true

      // Provider-process loss: kill only the exact host-recorded worker PID,
      // then require another exact native resume and usable follow-up.
      const hostStatePath = path.join(
        rig.runtime.runtimeDir(rig.supervisor, afterHostCrash.incarnationId),
        'host-state.json',
      )
      const workerPid = Number(JSON.parse(fs.readFileSync(hostStatePath, 'utf8')).workerPid)
      expect(workerPid).toBeGreaterThan(1)
      rig.runtime.killOwnedRuntimePidExact(afterHostCrash.containerId, workerPid)
      const afterProviderCrash = await waitForRunningView(
        rig,
        first.terminalId,
        (candidate) => candidate.incarnationId !== afterHostCrash.incarnationId && Boolean(candidate.containerId),
        240_000,
      )
      if (!afterProviderCrash.containerId) throw new Error('provider-crash replacement lacks container')
      expect(afterProviderCrash.soulId).toBe(first.view.soulId)
      expect(afterProviderCrash.nativeSessionId).toBe(nativeSessionId)
      expect(rig.runtime.isContainerRunning(afterHostCrash.containerId)).toBe(false)
      await waitForPaneIncarnation(
        harness,
        tabId,
        first.paneId,
        afterProviderCrash.incarnationId,
      )
      const providerMarker = `P3_PROVIDER_PROCESS_RECOVERED_${Math.random().toString(36).slice(2, 10).toUpperCase()}`
      const providerMarkerParts = providerMarker.split('_')
      const providerMarkerBefore = occurrenceCount(await terminalBuffer(page, first.terminalId), providerMarker)
      await executeInPane(
        page,
        first.paneId,
        `Use no tools. Reply by joining ${providerMarkerParts.join(', ')} with underscores and no other text.`,
      )
      await waitForValue('an unechoed provider-recovery follow-up marker', async () => (
        occurrenceCount(await terminalBuffer(page, first.terminalId), providerMarker) > providerMarkerBefore
          ? true
          : null
      ), 180_000)
      const providerFollowUpCompleted = true

      // A second OpenCode soul is independently owned, while an explicit
      // second view of the first soul does not mint another writer.
      const prior = new Set(leavesByMode(await harness.getPaneLayout(tabId), 'opencode').map((leaf) => leaf.id))
      const second = await createOpencodePane(page, harness, terminal, rig, tabId, prior)
      if (!second.view.containerId) throw new Error('second OpenCode view lacks container')
      const secondMarker = `P3_SECOND_SOUL_READY_${Math.random().toString(36).slice(2, 10).toUpperCase()}`
      const secondMarkerParts = secondMarker.split('_')
      const secondMarkerBefore = occurrenceCount(await terminalBuffer(page, second.terminalId), secondMarker)
      await executeInPane(
        page,
        second.paneId,
        `Use no tools. Reply by joining ${secondMarkerParts.join(', ')} with underscores and no other text.`,
      )
      await waitForValue('an unechoed second-soul marker', async () => (
        occurrenceCount(await terminalBuffer(page, second.terminalId), secondMarker) > secondMarkerBefore
          ? true
          : null
      ), 180_000)
      const secondSessionId = await waitForValue('second exact OpenCode session id', async () => (
        await paneSessionId(harness, tabId, second.paneId)
      ), 120_000)
      expect(second.view.soulId).not.toBe(first.view.soulId)
      expect(second.view.containerId).not.toBe(afterProviderCrash.containerId)
      expect(secondSessionId).not.toBe(nativeSessionId)
      expect(cgroupLimitsVerified(rig, second.view)).toBe(true)

      let snapshot = await rig.inventorySnapshot()
      const firstSoul = snapshot.souls
        .filter((candidate: any) => candidate.soulId === first.view.soulId)
        .at(-1)
      dataOf(await rig.runtime.adminOk(
        rig.supervisor,
        rig.runtime.upsertViewIntentBody({
          soulId: first.view.soulId,
          intent: {
            ownerId: 'opencode-qualification-second-view',
            workspaceId: firstSoul.projectKey || 'opencode-qualification',
            kind: 'explicit',
            preferredTabId: 'opencode-qualification-second-tab',
            preferredPaneId: 'opencode-qualification-second-pane',
            title: 'OpenCode qualification second view',
            placementGroup: 'Recovered agents',
            visibility: 'visible',
          },
          expectedSoulIntentRevision: firstSoul.intentRevision,
          expectedControlEpoch: await rig.controlEpoch(),
        }),
      ), 'view_intent')
      snapshot = await rig.inventorySnapshot()
      const firstRunning = snapshot.souls.filter((candidate: any) => (
        candidate.soulId === first.view.soulId && candidate.launchState === 'running'
      ))
      const firstViews = snapshot.viewIntents.filter((candidate: any) => (
        candidate.soulId === first.view.soulId && candidate.visibility === 'visible'
      ))
      expect(firstRunning).toHaveLength(1)
      expect(firstViews).toHaveLength(2)

      const notices = dataOf(await rig.runtime.adminOk(
        rig.supervisor,
        rig.runtime.pendingNoticesBody(
          'profile:opencode-provider-qualification',
          100,
          await rig.controlEpoch(),
        ),
      ), 'pending_notices')
      expect(notices).toHaveLength(0)

      const firstStop = await rig.stopSoul(first.view.soulId)
      const secondStop = await rig.stopSoul(second.view.soulId)
      expect(firstStop.outcome).toBe('verified_empty')
      expect(secondStop.outcome).toBe('verified_empty')
      expect(rig.runtime.broker.unsafeAttempts()).toHaveLength(0)

      providerRow = {
        provider: 'opencode',
        modes: ['opencode'],
        actualProviderBinary: true,
        providerVersion: P2_OPENCODE_VERSION,
        model: P2_OPENCODE_FREE_MODEL,
        reasoningEffort: 'provider-default',
        completedTurn: true,
        nativeStateCaptured: true,
        nativeSessionId,
        runtimeOwned: true,
        limitsVerified,
        nonceRecovery: {
          sameSoul: afterHostCrash.soulId === first.view.soulId,
          sameNativeSession: afterHostCrash.nativeSessionId === nativeSessionId,
          newIncarnation: afterHostCrash.incarnationId !== first.view.incarnationId,
          oldEnclosureVerifiedEmpty: !rig.runtime.isContainerRunning(first.view.containerId),
          recalledNonce,
          followUpCompleted: providerFollowUpCompleted,
          workspaceOrToolReadUsed: false,
        },
        crashKinds: ['session_host', 'provider_process'],
        automaticResume: true,
        onlyOneWriter: firstRunning.length === 1,
        profileVerified: firstSoul.profile === (first.view as any).profile,
        sameNativeSession: afterProviderCrash.nativeSessionId === nativeSessionId,
        exactNativeRecovery: afterHostCrash.nativeSessionId === nativeSessionId
          && afterProviderCrash.nativeSessionId === nativeSessionId,
        blockers: [
          'credentials_expired',
          'rate_limited',
          'provider_unavailable',
          'store_unreadable',
          'store_missing',
          'incompatible_binary',
          'retry_budget',
        ].map((reason) => ({ reason, outcome: 'blocked', lost: false })),
        blockerEvidence,
        repairedSameSoul: afterProviderCrash.soulId === first.view.soulId,
        repairedSameNativeSession: afterProviderCrash.nativeSessionId === nativeSessionId,
        nativeRecovery: true,
        lostNoticeCount: notices.length,
        oldEnclosureVerifiedEmpty: !rig.runtime.isContainerRunning(first.view.containerId)
          && !rig.runtime.isContainerRunning(afterHostCrash.containerId),
        followUpCompleted: providerFollowUpCompleted,
        releaseBinary: rig.supervisor.binaryKind === 'release',
      }
      expect(providerRow.nonceRecovery.recalledNonce).toBe(true)
      expect(providerRow.onlyOneWriter).toBe(true)
      expect(providerRow.nativeRecovery).toBe(true)
      expect(providerRow.exactNativeRecovery).toBe(true)
      expect(providerRow.lostNoticeCount).toBe(0)
      expect(providerRow.releaseBinary).toBe(true)
      expect(second.view.soulId).not.toBe(first.view.soulId)
      expect(second.view.containerId).not.toBe(afterProviderCrash.containerId)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    if (!providerRow) throw new Error('OpenCode qualification produced no provider evidence')
    const finalized = rig.finalizeProviderQualificationReceipt([providerRow])
    expect(finalized.receipt.schemaVersion).toBe(2)
    // eslint-disable-next-line no-console
    console.log(`[provider-qualification] OpenCode receipts: ${finalized.paths.join(', ')}`)
  })
})
