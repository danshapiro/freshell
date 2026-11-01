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
  createManagedRuntimeBrowserRig,
  P2_OPENCODE_MODEL,
  P2_OPENCODE_VERSION,
  type ManagedRuntimeView,
  type SyntheticOpenCodeSourceFacts,
  type ManagedFixtureRig,
  type Phase3BrowserObservation,
  type SyntheticStoppedRepairBatchFacts,
  type SyntheticStoppedRepairBatchObservation,
  type SyntheticStoppedRepairFault,
} from '../helpers/managed-runtime.js'
import {
  ManagedRuntimeInventorySnapshotSchema,
  ManagedRuntimeRepairBatchScopeSchema,
  ManagedRuntimeRestoreLostSoulsResultSchema,
  type ManagedRuntimeInventorySnapshot,
} from '../../../shared/managed-runtime.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { TestHarness } from '../helpers/test-harness.js'
import { resumeStoppedRepairBrowserView } from '../helpers/stopped-repair-browser-phase.js'

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
  rig: ManagedFixtureRig,
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

function assertStoppedRepairGraphs(
  facts: SyntheticStoppedRepairBatchFacts,
  observation: SyntheticStoppedRepairBatchObservation,
): void {
  expect(observation.roots).toHaveLength(7)
  expect(observation.installedStores).toHaveLength(7)
  for (const family of facts.families) {
    const root = observation.roots.find(root => root.rootSessionId === family.rootId)
    const installed = observation.installedStores.find(store => store.rootSessionId === family.rootId)
    if (!root || !installed) throw new Error('registered root has no independently read installed graph')
    expect(installed.providerStoreId).toBe(root.destinationStoreId)
    expect([root.providerUid, root.providerGid]).toEqual([65534, 0])
    expect([installed.providerUid, installed.providerGid]).toEqual([65534, 0])
    expect(installed.readable).toMatchObject({ transferId: root.transferId,
      sourceGeneration: root.sourceGeneration, rootSessionId: root.rootSessionId, destinationStoreId: root.destinationStoreId,
      providerUid: root.providerUid, providerGid: root.providerGid, rowCount: root.rowCount, assetCount: root.assetCount,
      structuralSha256: root.structuralSha256 })
    expect(installed.rowCount).toBe(root.rowCount)
    expect(installed.parents).toEqual({ [family.rootId]: null,
      [family.childId]: family.rootId, [family.grandchildId]: family.childId })
    expect(installed.history.sessions).toEqual([family.rootId, family.childId, family.grandchildId].sort())
    expect(installed.history.messages).toEqual(family.baselineMessages)
    expect(installed.history.parts).toEqual(family.baselineParts)
    expect(installed.excludedSourceSentinels).toEqual([])
    expect(root.readerEnvironmentSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(root.adoptionBaselineSha256).toMatch(/^[a-f0-9]{64}$/)
  }
}

function assertUnrelatedRepairEvidence(facts: SyntheticStoppedRepairBatchFacts,
  observation: SyntheticStoppedRepairBatchObservation): void {
  expect(observation.souls.map(soul => soul.soulId).sort())
    .toEqual(facts.targets.map(target => target.soulId).sort())
  expect(observation.souls).toHaveLength(9)
  expect(observation.unrelated).toEqual({ incidentPresent: true, viewPresent: true,
    noticeIds: facts.unrelated.noticeIds, outboxEventIds: facts.unrelated.outboxEventIds,
    exportSha256: facts.unrelated.exportSha256 })
}

function assertRepairBaselineUnchanged(before: SyntheticStoppedRepairBatchObservation,
  after: SyntheticStoppedRepairBatchObservation): void {
  const authority = (observation: SyntheticStoppedRepairBatchObservation) => observation.roots.map(root => ({
    rootSessionId: root.rootSessionId, canonicalSoulId: root.canonicalSoulId,
    destinationStoreId: root.destinationStoreId, sourceGeneration: root.sourceGeneration,
    transferId: root.transferId, adoptionBaselineSha256: root.adoptionBaselineSha256,
  })).sort((left, right) => left.rootSessionId.localeCompare(right.rootSessionId))
  expect(authority(after)).toEqual(authority(before))
}

function assertStoppedRepairActivity(activity: SyntheticStoppedRepairBatchFacts['activity']): void {
  expect(activity.setupHelpersCompleted).toBe(9)
  expect(activity.providerContainerStartRequests).toBe(0)
  expect(activity.providerLaunchRunningEvents).toBe(0)
}

function assertStoppedRepairCrash(observation: SyntheticStoppedRepairBatchObservation,
  operationId: string, preset: SyntheticStoppedRepairFault,
  point: NonNullable<SyntheticStoppedRepairBatchObservation['faultMarkers']['crash']>['point']): void {
  expect(observation.operationId).toBe(operationId)
  expect(observation.faultMarkers.preset).toBe(preset)
  expect(observation.faultMarkers.supervisorContainerId).toMatch(/^[a-f0-9]{64}$/)
  expect(observation.faultMarkers.crash).toEqual({ point, running: false, exitCode: 134 })
  assertStoppedRepairActivity(observation.activity)
  expect(observation.souls.every(soul => soul.desiredState === 'stopped' && soul.activeWriters === 0)).toBe(true)
}

test('stopped nine-soul restoration runbook', async ({ page }) => {
  test.skip(process.env.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1',
    'set FRESHELL_RUNTIME_SYNTHETIC_RESUME=1 for the fictional stopped repair runbook')
  test.setTimeout(1_800_000)
  const rig = createManagedRuntimeBrowserRig(process.cwd(), 3, {}, {}, 'test',
    { enabledProviders: [], freshAgentModes: [] })
  try {
    const facts = await rig.prepareSyntheticStoppedRepairBatch()
    assertStoppedRepairActivity(facts.activity)
    expect(facts.activity.helperStartRequests).toBe(0)
    const info = await rig.start()
    const headers = { 'x-auth-token': info.token }
    const inventory = async () => {
      const response = await page.request.get(`${info.baseUrl}/api/runtime/souls`, { headers })
      expect(response.ok()).toBe(true)
      return ManagedRuntimeInventorySnapshotSchema.parse(await response.json())
    }
    const initial = await inventory()
    const initialTargets = initial.souls.filter(soul => facts.targets.some(target => target.soulId === soul.soulId))
    expect(initialTargets).toHaveLength(9)
    expect(initialTargets.every(soul => soul.desiredState === 'stopped' && soul.recoveryState === 'lost'
      && soul.nativeIdentityObservation === undefined)).toBe(true)
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await restoreHistoricalRepairViews(page, initial, facts)

    const source = { sourceStoreId: facts.sourceStoreId,
      rootSessionIds: facts.families.map(family => family.rootId) }
    const unauthorized = await page.request.post(`${info.baseUrl}/api/runtime/soul-loss-repairs/preflight`,
      { data: source })
    expect(unauthorized.status()).toBe(401)
    const preflight = await page.request.post(`${info.baseUrl}/api/runtime/soul-loss-repairs/preflight`,
      { headers, data: source })
    expect(preflight.ok()).toBe(true)
    const scope = ManagedRuntimeRepairBatchScopeSchema.parse(await preflight.json())
    expect(scope.sourceStoreId).toBe(facts.sourceStoreId)
    expect(scope.targets).toHaveLength(9)
    expect(scope.roots).toHaveLength(7)
    expect(scope.roots.filter(root => root.canonicalSoulId === null)).toHaveLength(2)
    expect(scope.targets.map(target => target.target.soulId).sort())
      .toEqual(facts.targets.map(target => target.soulId).sort())
    expect(facts.canonicalChoices).toHaveLength(2)
    for (const choice of facts.canonicalChoices) {
      const root = scope.roots.find(root => root.rootSessionId === choice.rootSessionId)
      expect(root?.canonicalSoulId).toBeNull()
      expect(root?.eligibleOwners).toContain(choice.soulId)
    }
    const request = { idempotencyKey: `${facts.fixtureId}-repair`, scopeId: scope.scopeId, source,
      targets: scope.targets.map(target => target.target),
      canonicalOwners: facts.canonicalChoices.map(choice => ({ ...choice,
        expectedIntentRevision: scope.targets.find(target => target.target.soulId === choice.soulId)!
          .target.expectedIntentRevision })) }
    const repair = () => page.request.post(`${info.baseUrl}/api/runtime/soul-loss-repairs`,
      { headers, data: request, timeout: 180_000 })
    const rejected = await page.request.post(`${info.baseUrl}/api/runtime/soul-loss-repairs`,
      { headers: { 'x-auth-token': 'wrong-fixture-token' }, data: request })
    expect(rejected.status()).toBe(401)
    const stale = await page.request.post(`${info.baseUrl}/api/runtime/soul-loss-repairs`,
      { headers, data: { ...request, idempotencyKey: `${facts.fixtureId}-stale`,
        targets: request.targets.map((target, index) => index === 0
          ? { ...target, expectedIntentRevision: target.expectedIntentRevision + 1 } : target) } })
    expect(stale.ok()).toBe(false)
    expect((await inventory()).souls.filter(soul => facts.targets.some(target => target.soulId === soul.soulId)))
      .toEqual(initial.souls.filter(soul => facts.targets.some(target => target.soulId === soul.soulId)))

    await rig.setSyntheticStoppedRepairFault(facts.fixtureId, 'after_import_publication')
    const interruptedImport = await repair()
    expect(interruptedImport.status()).toBeGreaterThanOrEqual(500)
    const partial = await rig.syntheticStoppedRepairBatchObservation(facts.fixtureId, request.idempotencyKey)
    assertStoppedRepairCrash(partial, request.idempotencyKey, 'after_import_publication',
      'stopped_repair_after_import_publication')
    expect(partial.status).toBe('importing')
    expect(partial.roots.length).toBeLessThan(7)
    expect(partial.activity.helperStartRequests).toBeGreaterThan(0)
    expect(partial.souls.every(soul => soul.desiredState === 'stopped'
      && soul.activeWriters === 0 && soul.incidentPresent)).toBe(true)
    assertUnrelatedRepairEvidence(facts, partial)

    await rig.setSyntheticStoppedRepairFault(facts.fixtureId, 'source_generation_change')
    const changedPreflight = await page.request.post(`${info.baseUrl}/api/runtime/soul-loss-repairs/preflight`,
      { headers, data: source })
    expect(changedPreflight.ok()).toBe(true)
    const changedScope = ManagedRuntimeRepairBatchScopeSchema.parse(await changedPreflight.json())
    expect(changedScope.sourceFingerprint).not.toBe(scope.sourceFingerprint)
    expect(changedScope.roots.find(root => root.rootSessionId === facts.families[0].rootId)?.graphDigest)
      .not.toBe(scope.roots.find(root => root.rootSessionId === facts.families[0].rootId)?.graphDigest)
    const changedRepair = await repair()
    expect(changedRepair.ok()).toBe(true)
    expect(ManagedRuntimeRestoreLostSoulsResultSchema.parse(await changedRepair.json()))
      .toMatchObject({ operationId: request.idempotencyKey, status: 'pending', repairedTargetCount: 0,
        totalTargetCount: 9 })
    const changed = await rig.syntheticStoppedRepairBatchObservation(facts.fixtureId, request.idempotencyKey)
    expect(changed.status).toBe('importing')
    expect(changed.roots).toEqual(partial.roots)
    expect(changed.souls.every(soul => soul.desiredState === 'stopped' && soul.activeWriters === 0
      && soul.incidentPresent)).toBe(true)
    assertStoppedRepairActivity(changed.activity)
    assertUnrelatedRepairEvidence(facts, changed)
    await rig.setSyntheticStoppedRepairFault(facts.fixtureId, 'none')
    const restoredPreflight = await page.request.post(`${info.baseUrl}/api/runtime/soul-loss-repairs/preflight`,
      { headers, data: source })
    expect(restoredPreflight.ok()).toBe(true)
    const restoredScope = ManagedRuntimeRepairBatchScopeSchema.parse(await restoredPreflight.json())
    expect(restoredScope.sourceFingerprint).toBe(scope.sourceFingerprint)
    expect(restoredScope.roots).toEqual(scope.roots)

    await rig.setSyntheticStoppedRepairFault(facts.fixtureId, 'after_repair_cas_before_withdrawal')
    const interruptedCas = await repair()
    expect(interruptedCas.status()).toBeGreaterThanOrEqual(500)
    const cas = await rig.syntheticStoppedRepairBatchObservation(facts.fixtureId, request.idempotencyKey)
    assertStoppedRepairCrash(cas, request.idempotencyKey, 'after_repair_cas_before_withdrawal',
      'stopped_repair_after_repair_cas_before_withdrawal')
    expect(cas.status).toBe('withdraw_pending')
    assertStoppedRepairGraphs(facts, cas)
    assertUnrelatedRepairEvidence(facts, cas)
    let withdrawalStartupError: unknown
    try {
      await rig.setSyntheticStoppedRepairFault(facts.fixtureId, 'during_withdrawal_before_ack')
    } catch (error) {
      withdrawalStartupError = error
    }
    if (!withdrawalStartupError) {
      const interruptedWithdrawal = await repair()
      expect(interruptedWithdrawal.status()).toBeGreaterThanOrEqual(500)
    }
    // Startup itself drains a pending withdrawal. Its expected failed health
    // wait qualifies only with this actual owned crash and same operation.
    const withdrawing = await (async () => {
      try {
        const observation = await rig.syntheticStoppedRepairBatchObservation(facts.fixtureId, request.idempotencyKey)
        assertStoppedRepairCrash(observation, request.idempotencyKey, 'during_withdrawal_before_ack',
          'stopped_repair_during_withdrawal_before_ack')
        return observation
      } catch (error) {
        if (withdrawalStartupError) throw new AggregateError([withdrawalStartupError, error],
          'withdrawal startup failure has no qualifying current owned crash')
        throw error
      }
    })()
    assertRepairBaselineUnchanged(cas, withdrawing)
    assertStoppedRepairGraphs(facts, withdrawing)
    assertUnrelatedRepairEvidence(facts, withdrawing)
    await rig.setSyntheticStoppedRepairFault(facts.fixtureId, 'pending_withdrawal')
    const pendingResponse = await repair()
    expect(pendingResponse.ok()).toBe(true)
    expect(ManagedRuntimeRestoreLostSoulsResultSchema.parse(await pendingResponse.json()))
      .toMatchObject({ operationId: request.idempotencyKey, status: 'pending', totalTargetCount: 9 })
    const pending = await rig.syntheticStoppedRepairBatchObservation(facts.fixtureId, request.idempotencyKey)
    expect(pending).toMatchObject({ status: 'withdraw_pending', withdrawalStatus: 'files_pending' })
    expect(pending.faultMarkers.preset).toBe('pending_withdrawal')
    assertStoppedRepairActivity(pending.activity)
    assertRepairBaselineUnchanged(cas, pending)
    assertStoppedRepairGraphs(facts, pending)
    assertUnrelatedRepairEvidence(facts, pending)
    await rig.setSyntheticStoppedRepairFault(facts.fixtureId, 'none')
    const completeResponse = await repair()
    expect(completeResponse.ok()).toBe(true)
    const result = ManagedRuntimeRestoreLostSoulsResultSchema.parse(await completeResponse.json())
    expect(result).toMatchObject({ operationId: request.idempotencyKey, status: 'complete',
      repairedTargetCount: 9, totalTargetCount: 9 })
    expect(result.roots).toHaveLength(7)
    const repeated = await repair()
    expect(repeated.ok()).toBe(true)
    expect(ManagedRuntimeRestoreLostSoulsResultSchema.parse(await repeated.json())).toEqual(result)
    const complete = await rig.syntheticStoppedRepairBatchObservation(facts.fixtureId, result.operationId)
    expect(complete.status).toBe('complete')
    expect(complete.withdrawalStatus).toBe('files_complete')
    assertStoppedRepairActivity(complete.activity)
    expect(complete.activity.helperStartRequests).toBeGreaterThanOrEqual(14)
    expect(complete.souls.every(soul => soul.desiredState === 'stopped' && soul.activeWriters === 0
      && !soul.incidentPresent && soul.exportPresent.every(present => !present))).toBe(true)
    expect(complete.roots.every(root => complete.souls.some(soul => soul.soulId === root.canonicalSoulId
      && soul.recoveryState === 'data_repair_complete' && soul.nativeSessionId === root.rootSessionId))).toBe(true)
    assertStoppedRepairGraphs(facts, complete)
    assertUnrelatedRepairEvidence(facts, complete)

    const repairedInventory = await inventory()
    const explicitViews = initial.viewIntents.filter(view => facts.targets.some(target => target.viewIds.includes(view.viewId)))
    for (const before of explicitViews) {
      const after = repairedInventory.viewIntents.find(view => view.viewId === before.viewId)
      const oldTarget = facts.targets.find(target => target.soulId === before.soulId)!
      const canonical = complete.roots.find(root => root.rootSessionId === oldTarget.rootSessionId)!
      expect(after).toMatchObject({ soulId: canonical.canonicalSoulId, ownerId: before.ownerId,
        preferredTabId: before.preferredTabId, preferredPaneId: before.preferredPaneId,
        placementGroup: before.placementGroup, visibility: before.visibility })
      expect(after!.revision).toBeGreaterThanOrEqual(before.revision)
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(before.preferredTabId)
        const leaf = leavesByMode(layout, 'opencode').find(leaf => leaf.id === before.preferredPaneId)
        return leaf?.content
      }, { timeout: 60_000 }).toMatchObject({ kind: 'terminal',
        soulId: canonical.canonicalSoulId, viewIntentId: before.viewId,
        placementGroup: before.placementGroup, recoverySummary: { desiredState: 'stopped' } })
    }

    const resumedRoot = complete.roots.find(root => root.rootSessionId === facts.canonicalChoices[0].rootSessionId)!
    const resumedView = repairedInventory.viewIntents.find(view => view.soulId === resumedRoot.canonicalSoulId
      && explicitViews.some(before => before.viewId === view.viewId))!
    if (!resumedView) throw new Error('canonical restored soul has no retained explicit browser view')
    await test.step('stopped repair: first Resume fault', () =>
      rig.setSyntheticStoppedRepairFault(facts.fixtureId, 'first_resume_observation'), { timeout: 240_000 })
    const sentBeforeReload = await test.step('stopped repair: pre-reload input evidence', () =>
      harness.getSentWsMessages(), { timeout: 60_000 })
    const card = await resumeStoppedRepairBrowserView(page, harness,
      resumedView.preferredTabId, resumedView.preferredPaneId)
    await expect(card.getByRole('button', { name: 'Retry recovery', exact: true }))
      .toBeVisible({ timeout: 180_000 })
    const blocked = await rig.syntheticStoppedRepairBatchObservation(facts.fixtureId, result.operationId)
    expect(blocked.souls.find(soul => soul.soulId === resumedRoot.canonicalSoulId))
      .toMatchObject({ desiredState: 'running', recoveryState: 'blocked',
        providerStoreId: resumedRoot.destinationStoreId, nativeSessionId: resumedRoot.rootSessionId })
    assertRepairBaselineUnchanged(complete, blocked)
    assertStoppedRepairGraphs(facts, blocked)
    assertUnrelatedRepairEvidence(facts, blocked)
    const failedNative = blocked.nativeObservations.find(native => native.canonicalSoulId === resumedRoot.canonicalSoulId)
    // The supervisor cleans its failed replacement before reporting Blocked.
    // Historical hydration is not a current running observation afterward.
    expect(failedNative).toMatchObject({ state: 'unavailable', reason: 'host_unavailable' })
    const failedSoul = (await inventory()).souls.find(soul => soul.soulId === resumedRoot.canonicalSoulId)!
    expect(failedSoul.recoveryReason).toBe('PROVIDER_UNAVAILABLE')
    expect(failedSoul.nativeIdentityObservation).toBeUndefined()
    expect(blocked.faultMarkers.preset).toBe('first_resume_observation')
    expect(blocked.faultMarkers.firstResumeObservationFailures).toEqual([{
      soulId: resumedRoot.canonicalSoulId, incarnationId: failedSoul.incarnationId,
      executionGeneration: failedSoul.executionGeneration,
    }])
    expect(blocked.activity.providerContainerStartRequests).toBeGreaterThan(complete.activity.providerContainerStartRequests)
    expect(blocked.activity.providerLaunchRunningEvents).toBe(0)

    await rig.setSyntheticStoppedRepairFault(facts.fixtureId, 'none')
    const beforeRetry = await rig.syntheticStoppedRepairBatchObservation(facts.fixtureId, result.operationId)
    expect(beforeRetry.souls.find(soul => soul.soulId === resumedRoot.canonicalSoulId))
      .toMatchObject({ desiredState: 'running', recoveryState: 'blocked', activeWriters: 0 })
    expect(beforeRetry.activity.providerContainerStartRequests).toBe(blocked.activity.providerContainerStartRequests)
    expect(beforeRetry.activity.providerLaunchRunningEvents).toBe(0)
    assertRepairBaselineUnchanged(complete, beforeRetry)
    assertStoppedRepairGraphs(facts, beforeRetry)
    assertUnrelatedRepairEvidence(facts, beforeRetry)
    await harness.waitForConnection()
    await card.getByRole('button', { name: 'Retry recovery', exact: true }).click()
    const live = await waitForValue('same-soul current native Retry observation', async () => {
      const observation = await rig.syntheticStoppedRepairBatchObservation(facts.fixtureId, result.operationId)
      const native = observation.nativeObservations.find(native => native.canonicalSoulId === resumedRoot.canonicalSoulId)
      return native?.state === 'current' && native.launchState === 'running' && native.recoveryState === 'live'
        && native.hostStatus.state === 'observed' && native.hostStatus.hydrated
        && native.hostStatus.messagesRead === 'success' && native.registryNativeObservation ? observation : null
    }, 180_000)
    assertRepairBaselineUnchanged(complete, live)
    assertStoppedRepairGraphs(facts, live)
    assertUnrelatedRepairEvidence(facts, live)
    const current = live.nativeObservations.find(native => native.canonicalSoulId === resumedRoot.canonicalSoulId)!
    if (current.state !== 'current' || current.hostStatus.state !== 'observed' || !current.registryNativeObservation)
      throw new Error('LIVE requires matching current host and registry native observations')
    expect(current.incarnationId).not.toBe(failedSoul.incarnationId)
    // Execution generations belong to an incarnation. A new incarnation may
    // begin at one; the exact owner observation checks its current grant.
    expect(current.executionGeneration).toBeGreaterThan(0)
    expect(current.hostStatus.launchNonceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(current.registryNativeObservation).toMatchObject({ incarnationId: current.incarnationId,
      nativeSessionId: resumedRoot.rootSessionId })
    expect(current.hostStatus).toMatchObject({ incarnationId: current.incarnationId,
      rootSessionId: resumedRoot.rootSessionId, terminalId: current.terminalId })
    const liveSoul = live.souls.find(soul => soul.soulId === resumedRoot.canonicalSoulId)!
    expect(current.intentRevision).toBe(liveSoul.intentRevision)
    expect(current.nativeImportRevision).toBe(liveSoul.nativeImportRevision)
    expect(liveSoul.activeWriters).toBe(1)
    expect(live.activity.providerContainerStartRequests).toBeGreaterThan(beforeRetry.activity.providerContainerStartRequests)
    expect(live.activity.providerLaunchRunningEvents).toBe(1)
    expect(live.souls.filter(soul => soul.soulId !== resumedRoot.canonicalSoulId)
      .every(soul => soul.desiredState === 'stopped' && soul.activeWriters === 0)).toBe(true)
    expect([...sentBeforeReload, ...await harness.getSentWsMessages()].filter(message => typeof message === 'object'
      && message !== null && 'type' in message && message.type === 'terminal.input')).toEqual([])
  } finally {
    const cleanup = await rig.stop()
    expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
  }
})

async function restoreHistoricalRepairViews(page: Page, snapshot: ManagedRuntimeInventorySnapshot,
  facts: SyntheticStoppedRepairBatchFacts): Promise<void> {
  const ids = facts.targets.flatMap(target => target.viewIds)
  expect(ids).toHaveLength(4)
  const views = snapshot.viewIntents.filter(view => ids.includes(view.viewId))
  expect(views).toHaveLength(4)
  // Restore only the historical browser layout. All runtime state comes from
  // the authenticated current snapshot; this does not create a provider.
  await page.evaluate(({ snapshot, views }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) throw new Error('historical browser layout requires the real test harness')
    for (const view of views) {
      const soul = snapshot.souls.find(soul => soul.soulId === view.soulId)
      if (!soul) throw new Error('historical view has no current soul')
      const projection = { soulId: soul.soulId, incarnationId: soul.incarnationId,
        runtimeState: soul.launchState, viewIntentId: view.viewId, viewIntentRevision: view.revision,
        soulIntentRevision: soul.intentRevision, incidentId: soul.incidentId, placementGroup: view.placementGroup,
        recoverySummary: { desiredState: soul.desiredState, recoveryState: soul.recoveryState,
          reason: soul.recoveryReason, attemptId: soul.recoveryAttemptId, incidentId: soul.incidentId,
          durabilityState: soul.durabilityState, allocationState: soul.allocationState } }
      harness.dispatch({ type: 'tabs/addTab', payload: { id: view.preferredTabId,
        title: view.title, mode: 'opencode', status: 'exited', activate: false, ...projection } })
      harness.dispatch({ type: 'panes/initLayout', payload: { tabId: view.preferredTabId,
        paneId: view.preferredPaneId, content: { kind: 'terminal', mode: 'opencode',
          createRequestId: view.viewId, status: 'exited', initialCwd: soul.terminalCwd, ...projection } } })
    }
  }, { snapshot, views })
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

    const rig = createManagedRuntimeBrowserRig(process.cwd(), 3, {
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
