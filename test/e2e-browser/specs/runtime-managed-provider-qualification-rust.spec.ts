/**
 * Opt-in live qualification for every managed terminal provider.
 *
 * The checked-in capability flags intentionally remain unchanged. Until a
 * provider is enabled on main, this spec is a dormant release surface: it is
 * listed by Playwright but runs only when the explicit live environment flag
 * is set. Once enabled, every row must traverse the real picker, real pinned
 * provider binary, and both destructive recovery paths. There are no fakes,
 * conditional assertions, or provider-specific skips below.
 */
import fs from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'

import { expect, type Page, type Browser } from '@playwright/test'

import type { ProviderQualificationRow } from '../../../scripts/testing/provider-qualification-receipt.js'
import { requireAmplifierOnecliBootstrap } from '../../../scripts/testing/runtime-amplifier-onecli.js'
import {
  QUALIFICATION_PROVIDER_SELECTION_ENV,
  parseQualificationProviderSelection,
} from '../../../scripts/testing/provider-qualification-selection.js'
import { test, createFreshE2ePage } from '../helpers/fixtures.js'
import { ExternalServer } from '../helpers/external-target.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { installRecoveryOfferAutoDeclineOnContext } from '../helpers/recovery-offer.js'
import { RuntimeHarness, type AdminReply, type ManagedTerminalStartupFacts } from '../../../scripts/testing/runtime-sandbox.js'
import {
  runTask2RetainedFixture,
  type Task2RetainedBrowserContext,
  type Task2RetainedBrowserPhase,
} from '../../../scripts/testing/task002-config-legacy-fixtures.js'
import { ExternalManagedRuntimeRig, resolveManagedExternalDescriptor } from '../../../scripts/testing/runtime-external-browser.js'
import { task2RetainedPublicContext, type Task2RetainedPublicContext } from '../../../scripts/testing/task002-retained-fixture.js'
import { managedRecoveryBlockedMessage } from '../../../src/lib/managed-runtime-recovery-message.js'
import {
  ManagedRuntimeBrowserRig, stopManagedRuntimeSoul,
  P2_OPENCODE_MODEL,
  P2_OPENCODE_VERSION,
  type ManagedRuntimeView,
} from '../helpers/managed-runtime.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { nativeTurnProof } from '../helpers/provider-native-history/proof.js'
import type { NativeAssistantTurn, NativeHistory } from '../helpers/provider-native-history/types.js'
import { TestHarness } from '../helpers/test-harness.js'

const LIVE_ENV = 'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE'
const AMPLIFIER_MODEL = 'glm-5.3'
const AMPLIFIER_EFFORT = 'provider-default'

type ProviderDefinition = {
  provider: 'claude' | 'codex' | 'opencode' | 'amplifier'
  pickerName: RegExp
  directoryName: RegExp
  providerVersion: string
  model: string
  reasoningEffort: string
  versionCommand: string[]
  versionPattern: RegExp
  processBinary: string
  processIdentityNeedles: string[]
  nativeIdPattern: RegExp
}

function providerDefinitions(): ProviderDefinition[] {
  const rawSelection = process.env[QUALIFICATION_PROVIDER_SELECTION_ENV]?.trim()
  if (!rawSelection) {
    throw new Error(
      `${QUALIFICATION_PROVIDER_SELECTION_ENV} must explicitly select each live provider to qualify`,
    )
  }
  const selected = parseQualificationProviderSelection(rawSelection)
  const definitions: ProviderDefinition[] = [
    {
      provider: 'claude',
      pickerName: /^Claude CLI$/i,
      directoryName: /Starting directory for Claude/i,
      providerVersion: '2.1.263',
      model: 'haiku',
      reasoningEffort: 'low',
      versionCommand: ['claude', '--version'],
      versionPattern: /2\.1\.263/,
      processBinary: 'claude',
      processIdentityNeedles: ['haiku', 'low'],
      nativeIdPattern: /^[0-9a-f]{8}-[0-9a-f-]{27}$/i,
    },
    {
      provider: 'codex',
      pickerName: /^Codex CLI$/i,
      directoryName: /Starting directory for Codex CLI/i,
      providerVersion: '0.147.0',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      versionCommand: ['codex', '--version'],
      versionPattern: /0\.147\.0/,
      processBinary: 'codex',
      processIdentityNeedles: ['gpt-5.6-luna', 'low'],
      nativeIdPattern: /^[0-9a-f]{8}-[0-9a-f-]{27}$/i,
    },
    {
      provider: 'opencode',
      pickerName: /^OpenCode$/i,
      directoryName: /Starting directory for OpenCode/i,
      providerVersion: P2_OPENCODE_VERSION,
      model: P2_OPENCODE_MODEL,
      reasoningEffort: 'provider-default',
      versionCommand: ['opencode', '--version'],
      versionPattern: new RegExp(`^${P2_OPENCODE_VERSION.replaceAll('.', '\\.')}\\s*$`),
      processBinary: 'opencode',
      processIdentityNeedles: [P2_OPENCODE_MODEL],
      nativeIdPattern: /^ses_/,
    },
  ]
  if (selected.includes('amplifier')) {
    requireAmplifierOnecliBootstrap()
    definitions.push({
      provider: 'amplifier',
      pickerName: /^Amplifier$/i,
      directoryName: /Starting directory for Amplifier/i,
      providerVersion: '0.1.1',
      model: AMPLIFIER_MODEL,
      reasoningEffort: AMPLIFIER_EFFORT,
      versionCommand: [
        '/opt/amplifier-src/.venv/bin/python',
        '-c',
        'import importlib.metadata as m; print(m.version("amplifier-app-cli"))',
      ],
      versionPattern: /^0\.1\.1\s*$/,
      processBinary: 'amplifier',
      // Amplifier's resume command has no model/effort flags. Native
      // session:config evidence below is the provider-effective authority.
      processIdentityNeedles: [],
      nativeIdPattern: /^[A-Za-z0-9][A-Za-z0-9._-]+$/,
    })
  }
  const byProvider = new Map(definitions.map((definition) => [definition.provider, definition]))
  return selected.map((provider) => {
    const definition = byProvider.get(provider)
    if (!definition) throw new Error(`no qualification definition for ${provider}`)
    return definition
  })
}

function leavesByMode(node: any, mode: string): any[] {
  if (!node) return []
  if (node.type === 'leaf') return node.content?.mode === mode ? [node] : []
  return node.type === 'split'
    ? (node.children ?? []).flatMap((child: any) => leavesByMode(child, mode))
    : []
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

async function terminalBuffer(page: Page, terminalId: string): Promise<string> {
  return page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer?.(id) ?? '', terminalId)
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function executeAndAwaitNonceOutput(
  page: Page,
  paneId: string,
  terminalId: string,
  command: string,
  nonce: string,
  timeoutMs = 240_000,
): Promise<void> {
  const before = occurrences(await terminalBuffer(page, terminalId), nonce)
  const expectedIncrease = command.includes(nonce) ? 2 : 1
  const terminal = page.locator(`[data-pane-id="${paneId}"] .xterm:visible`).last()
  await terminal.waitFor({ state: 'visible', timeout: 90_000 })
  await terminal.click()
  await page.keyboard.insertText(command)
  await page.keyboard.press('Enter')
  // This is only a sequencing signal. The stopped provider-native transcript,
  // not terminal output or occurrence count, is the qualification authority.
  await waitForValue('provider response sequencing signal', async () => (
    occurrences(await terminalBuffer(page, terminalId), nonce) >= before + expectedIncrease ? true : null
  ), timeoutMs)
}

function nativeHistorySource(provider: ProviderDefinition['provider']): string {
  if (provider === 'claude') return '/home/freshell/provider/.claude/projects'
  if (provider === 'codex') return '/home/freshell/provider/.codex/sessions'
  if (provider === 'opencode') return '/home/freshell/provider/.local/share/opencode/opencode.db'
  return '/home/freshell/provider/.amplifier/projects'
}

function stoppedNativeHistory(
  rig: ManagedRuntimeBrowserRig,
  providerVolumeName: string,
  definition: ProviderDefinition,
  nativeSessionId: string,
): NativeHistory {
  if (!/^freshell-provider-[A-Za-z0-9_.-]+$/.test(providerVolumeName)) {
    throw new Error('provider history probe requires an exact managed provider volume')
  }
  const probe = path.join(rig.repoRoot, 'test/e2e-browser/helpers/provider-native-history/probe-cli.ts')
  const tsxLoader = path.join(rig.repoRoot, 'node_modules/tsx/dist/loader.mjs')
  const raw = rig.runtime.runCommand('docker', [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', '65534:0',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '-v', `${providerVolumeName}:/home/freshell/provider:ro`,
    '-v', `${rig.repoRoot}:${rig.repoRoot}:ro`,
    '--workdir', rig.repoRoot,
    rig.runtime.imageRef,
    'node', '--no-warnings', '--import', tsxLoader, probe,
    definition.provider, nativeHistorySource(definition.provider), nativeSessionId,
  ])
  const history = JSON.parse(raw) as NativeHistory
  expect(history.schemaVersion).toBe(1)
  expect(history.provider).toBe(definition.provider)
  expect(history.nativeSessionId).toBe(nativeSessionId)
  return history
}

function nonceTurns(history: NativeHistory, nonce: string): NativeAssistantTurn[] {
  const turns = history.turns.filter((turn) => turn.text.includes(nonce))
  if (turns.length !== 3) {
    throw new Error(`native exact-session history must contain exactly three nonce-bearing completed assistant responses; found ${turns.length}`)
  }
  return turns
}

async function paneNativeId(
  harness: TestHarness,
  tabId: string,
  paneId: string,
  provider: string,
): Promise<string | null> {
  const content = leavesByMode(await harness.getPaneLayout(tabId), provider)
    .find((leaf) => leaf.id === paneId)?.content
  return typeof content?.sessionRef?.sessionId === 'string' ? content.sessionRef.sessionId : null
}

async function createProviderPane(
  page: Page,
  harness: TestHarness,
  rig: ManagedRuntimeBrowserRig,
  tabId: string,
  definition: ProviderDefinition,
): Promise<{ paneId: string; terminalId: string; view: ManagedRuntimeView }> {
  const priorPaneIds = new Set(
    leavesByMode(await harness.getPaneLayout(tabId), definition.provider).map((leaf) => leaf.id),
  )
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: definition.pickerName }).click({ force: true })
  const directory = page.getByRole('combobox', { name: definition.directoryName })
  await expect(directory).toBeVisible({ timeout: 15_000 })
  await directory.fill(rig.repoRoot)
  await directory.press('Enter')

  const leaf = await waitForValue(`${definition.provider} picker-created pane`, async () => (
    leavesByMode(await harness.getPaneLayout(tabId), definition.provider)
      .find((candidate) => !priorPaneIds.has(candidate.id) && candidate.content?.terminalId)
  ), 120_000)
  await page.locator(`[data-pane-id="${leaf.id}"] .xterm:visible`)
    .waitFor({ state: 'visible', timeout: 120_000 })
  const view = await waitForValue(`${definition.provider} managed runtime view`, async () => {
    const candidate = await rig.runningViewForTerminal(leaf.content.terminalId)
    return candidate?.containerId ? candidate : null
  }, 120_000)
  return { paneId: leaf.id, terminalId: leaf.content.terminalId, view }
}

function limitEvidence(view: ManagedRuntimeView, actual: ManagedTerminalStartupFacts['limits']): ProviderQualificationRow['limitEvidence'] {
  if (!view.containerId) throw new Error('managed runtime has no container for limit evidence')
  const expected = view.effectiveLimits
  if (!expected) throw new Error('managed runtime has no effective limits')
  expect(actual.cpuMax).toBe(`${expected.cpuMilli * 100} 100000`)
  expect(actual.memoryMax).toBe(String(expected.memoryBytes))
  expect(actual.swapMax).toBe(String(expected.swapBytes))
  expect(actual.pidsMax).toBe(String(expected.pidsMax))
  return actual
}

async function waitForReplacement(
  rig: ManagedRuntimeBrowserRig,
  terminalId: string,
  priorIncarnationId: string,
): Promise<ManagedRuntimeView> {
  return waitForValue('replacement managed runtime', async () => {
    const view = await rig.runningViewForTerminal(terminalId)
    return view?.containerId && view.incarnationId !== priorIncarnationId ? view : null
  }, 300_000)
}

async function qualifyProvider(
  page: Page,
  harness: TestHarness,
  rig: ManagedRuntimeBrowserRig,
  tabId: string,
  definition: ProviderDefinition,
): Promise<ProviderQualificationRow> {
  const created = await createProviderPane(page, harness, rig, tabId, definition)
  if (!created.view.containerId) throw new Error(`${definition.provider} view has no owned container`)

  const startup = await rig.managedTerminalStartupFacts(rig.runtimeEnclosureHandle(created.view))
  expect(startup.provider).toBe(definition.processBinary)
  expect(startup.version).toMatch(definition.versionPattern)
  expect(startup.providerProcessPresent).toBe(true)
  for (const identity of definition.processIdentityNeedles) {
    expect(startup.processIdentities).toContain(identity)
  }
  if (definition.reasoningEffort === 'provider-default') {
    expect(startup.reasoningFlagsAbsent).toBe(true)
  }
  const exactLimits = limitEvidence(created.view, startup.limits)
  expect(exactLimits.swapMax).toBe('0')

  const nonce = `codename-${randomBytes(16).toString('hex')}`
  await executeAndAwaitNonceOutput(
    page,
    created.paneId,
    created.terminalId,
    `The private project codename for this conversation is ${nonce}. Without using tools or files, what codename did I just give you?`,
    nonce,
  )
  const nativeSessionId = await waitForValue('exact native session id', async () => (
    await paneNativeId(harness, tabId, created.paneId, definition.provider)
  ), 180_000)
  expect(nativeSessionId).toMatch(definition.nativeIdPattern)
  const inventoryNativeId = await waitForValue('inventory native session id', async () => (
    (await rig.runningViewForTerminal(created.terminalId))?.nativeSessionId
  ), 120_000)
  expect(inventoryNativeId).toBe(nativeSessionId)
  const initialEnclosure = rig.runtimeEnclosureHandle(created.view)
  await rig.crashRuntimeHost(rig.exactRuntimeHandle(created.view))
  const afterHostLoss = await waitForReplacement(rig, created.terminalId, created.view.incarnationId)
  expect(afterHostLoss.soulId).toBe(created.view.soulId)
  expect(afterHostLoss.nativeSessionId).toBe(nativeSessionId)
  expect((await rig.ownedContainerState(initialEnclosure)).running).toBe(false)

  await executeAndAwaitNonceOutput(
    page,
    created.paneId,
    created.terminalId,
    'Without using tools or files, what private project codename did I give you earlier?',
    nonce,
  )

  if (!afterHostLoss.containerId) throw new Error('host-loss replacement has no owned container')
  const workerHandle = rig.exactRuntimeHandle(afterHostLoss)
  const hostLossEnclosure = rig.runtimeEnclosureHandle(afterHostLoss)
  const pid = (await rig.chaosHostFacts(workerHandle)).workerPid
  expect(pid).toBeGreaterThan(1)
  await rig.crashProviderWorker(workerHandle)
  const afterProviderLoss = await waitForReplacement(rig, created.terminalId, afterHostLoss.incarnationId)
  expect(afterProviderLoss.soulId).toBe(created.view.soulId)
  expect(afterProviderLoss.nativeSessionId).toBe(nativeSessionId)
  expect(afterProviderLoss.profile).toBe(created.view.profile)
  expect((await rig.ownedContainerState(hostLossEnclosure)).running).toBe(false)

  await executeAndAwaitNonceOutput(
    page,
    created.paneId,
    created.terminalId,
    'Please remind me of the private project codename from the start of this same conversation. Do not use tools or files.',
    nonce,
  )

  const snapshot = await rig.inventorySnapshot()
  const runningWriters = snapshot.souls.filter((row: any) => (
    row.soulId === created.view.soulId && row.launchState === 'running'
  ))
  expect(runningWriters).toHaveLength(1)
  const writerHandle = rig.exactRuntimeHandle(afterProviderLoss)
  const writerClaim = await rig.writerClaimFacts(writerHandle)
  expect(writerClaim.provider).toBe(definition.provider)
  expect(writerClaim.activeClaimCount).toBe(1)
  expect(writerClaim.globalConflictingClaimCount).toBe(0)
  const lostNoticeCount = await rig.managedProviderPendingNoticeCount(writerHandle)
  expect(lostNoticeCount).toBe(0)
  const stopped = await stopManagedRuntimeSoul(rig, created.view.soulId)
  expect(stopped.outcome).toBe('verified_empty')
  if (stopped.outcome !== 'verified_empty') throw new Error('provider qualification Stop did not verify empty')
  const claimAfterStop = await rig.writerClaimFacts(writerHandle)
  expect(claimAfterStop.activeClaimCount).toBe(0)
  expect(claimAfterStop.globalConflictingClaimCount).toBe(0)
  const oldContainerRunningAfterStop = (await rig.ownedContainerState(rig.runtimeEnclosureHandle(afterProviderLoss))).running
  expect(oldContainerRunningAfterStop).toBe(false)
  expect((await rig.ownershipFacts()).unsafeBrokerAttempts).toBe(0)
  const providerReceipt = rig.runtime.broker.receipts()
    .find((candidate) => candidate.containerId === afterProviderLoss.containerId)
  if (!providerReceipt?.providerVolumeName) throw new Error('stopped soul has no exact provider-volume receipt')
  const nativeHistory = stoppedNativeHistory(
    rig,
    providerReceipt.providerVolumeName,
    definition,
    nativeSessionId,
  )
  const [initialTurn, hostCrashTurn, providerCrashTurn] = nonceTurns(nativeHistory, nonce)
  const nativeTurnProofs = [
    nativeTurnProof('initial', nativeSessionId, initialTurn, nonce),
    nativeTurnProof('after_session_host_crash', nativeSessionId, hostCrashTurn, nonce),
    nativeTurnProof('after_provider_process_crash', nativeSessionId, providerCrashTurn, nonce),
  ]
  if (definition.provider === 'amplifier') {
    const evidence = nativeTurnProofs.map((proof) => proof.nativeEvidence)
    expect(evidence.every((value) => value.kind === 'append_only_record')).toBe(true)
    expect(new Set(evidence.map((value) => value.kind === 'append_only_record' ? value.recordSha256 : '')).size).toBe(3)
  } else {
    const evidence = nativeTurnProofs.map((proof) => proof.nativeEvidence)
    expect(evidence.every((value) => value.kind === 'identified_message')).toBe(true)
    expect(new Set(evidence.map((value) => value.kind === 'identified_message' ? value.messageId : '')).size).toBe(3)
    expect(new Set(evidence.map((value) => value.kind === 'identified_message' ? value.turnId : '')).size).toBe(3)
  }
  expect(nativeTurnProofs.every((proof) => proof.toolCallCount === 0)).toBe(true)

  return {
    provider: definition.provider,
    modes: [definition.provider],
    providerVersion: definition.providerVersion,
    model: definition.model,
    reasoningEffort: definition.reasoningEffort,
    nativeSessionId,
    nonceSha256: createHash('sha256').update(nonce).digest('hex'),
    nativeTurnProofs,
    actualProviderBinary: true,
    completedTurn: true,
    nativeStateCaptured: true,
    runtimeOwned: true,
    limitsVerified: true,
    swapMaxVerified: exactLimits.swapMax === '0',
    limitEvidence: exactLimits,
    automaticResume: true,
    profileVerified: nativeTurnProofs.every((proof) => (
      proof.resolvedReasoningEffort === definition.reasoningEffort
      && (definition.provider !== 'codex' || proof.resolvedModel === definition.model)
      && (definition.provider !== 'amplifier' || (
        proof.resolvedProvider === 'lunaroute'
        && proof.resolvedModel === definition.model
      ))
      && (definition.provider !== 'claude' || proof.resolvedModel.toLowerCase().includes('haiku'))
      && (definition.provider !== 'opencode'
        || `${proof.resolvedProvider}/${proof.resolvedModel}` === definition.model)
    )),
    releaseBinary: (await rig.ownershipFacts()).supervisorBinaryKind === 'release',
    nativeRecovery: true,
    exactNativeRecovery: afterHostLoss.nativeSessionId === nativeSessionId
      && afterProviderLoss.nativeSessionId === nativeSessionId,
    sameNativeSession: afterProviderLoss.nativeSessionId === nativeSessionId,
    followUpCompleted: true,
    onlyOneWriter: runningWriters.length === 1,
    writerClaim,
    oldEnclosureVerifiedEmpty: !(await rig.ownedContainerState(initialEnclosure)).running
      && !(await rig.ownedContainerState(hostLossEnclosure)).running,
    verifiedEmptyOrdering: {
      stopOutcome: stopped.outcome,
      activeClaimCountAfterStop: claimAfterStop.activeClaimCount,
      globalConflictingClaimCountAfterStop: claimAfterStop.globalConflictingClaimCount,
      oldContainerRunningAfterStop,
    },
    lostNoticeCount,
    crashKinds: ['session_host', 'provider_process'],
    nonceRecovery: {
      sameSoul: afterHostLoss.soulId === created.view.soulId,
      sameNativeSession: afterHostLoss.nativeSessionId === nativeSessionId,
      newIncarnation: afterHostLoss.incarnationId !== created.view.incarnationId,
      oldEnclosureVerifiedEmpty: !(await rig.ownedContainerState(initialEnclosure)).running,
      recalledNonce: true,
      followUpCompleted: true,
      workspaceOrToolReadUsed: nativeTurnProofs.some((proof) => proof.toolCallCount > 0),
    },
    repairedSameSoul: afterProviderLoss.soulId === created.view.soulId,
    repairedSameNativeSession: afterProviderLoss.nativeSessionId === nativeSessionId,
  }
}

test.describe.serial('selectable managed-provider qualification', () => {
  test('each explicitly selected provider produces an independent evidence-bound live row', async ({ page }) => {
    test.skip(
      process.env[LIVE_ENV] !== '1',
      `set ${LIVE_ENV}=1 only for a live candidate-bound managed-provider campaign`,
    )
    test.setTimeout(3_600_000)
    const definitions = providerDefinitions()
    const rig = new ManagedRuntimeBrowserRig(
      process.cwd(),
      5,
      {},
      { FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '750' },
      'release',
      {
        enabledProviders: definitions.map((definition) => definition.provider),
        providerSettings: Object.fromEntries(definitions.map((definition) => [
          definition.provider,
          { model: definition.model, effort: definition.reasoningEffort },
        ])),
      },
    )
    const providers: ProviderQualificationRow[] = []
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      const tabId = await harness.getActiveTabId()
      if (!tabId) throw new Error('managed-provider qualification has no active tab')
      for (const definition of definitions) {
        providers.push(await qualifyProvider(page, harness, rig, tabId, definition))
      }
      expect(providers.map((row) => row.provider)).toEqual(
        definitions.map((definition) => definition.provider),
      )
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    const finalized = rig.finalizeProviderQualificationReceipt(providers)
    expect(finalized.receipt.schemaVersion).toBe(2)
    expect(finalized.receipt.providers).toHaveLength(definitions.length)
    // eslint-disable-next-line no-console
    console.log(`[provider-qualification] selected-provider receipts: ${finalized.paths.join(', ')}`)
  })
})

// Append outside the live-provider describe. These cases exercise real owned
// publication/enclosure/store transactions with synthetic history and no prompts.
// They do not emit ProviderQualificationRow or certify provider-observed LIVE.
const SYNTHETIC_TASK2_ENV = 'FRESHELL_RUNTIME_SYNTHETIC_RESUME'
const TASK2_ARTIFACT_MANIFEST_ENV = 'FRESHELL_TASK002_FIXTURE_ARTIFACT_MANIFEST'

async function task2FixtureHarness(): Promise<RuntimeHarness> {
  if (process.env[SYNTHETIC_TASK2_ENV] !== '1') throw new Error('exact synthetic gate required')
  const file = process.env[TASK2_ARTIFACT_MANIFEST_ENV]
  if (!file || !path.isAbsolute(file) || fs.realpathSync(file) !== file) {
    throw new Error('exact Task2 artifact manifest required')
  }
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error('Task2 artifact manifest must be private and owned')
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!/^[a-f0-9]{40}$/.test(manifest.candidateSha)
    || !/^[a-f0-9-]{36}$/.test(manifest.runId)
    || manifest.repoRoot !== fs.realpathSync(process.cwd())) {
    throw new Error('exact Task2 candidate/run/worktree identity required')
  }
  // Each browser case owns a new run. Admission still hashes the same five
  // immutable binaries and checks the exact current/legacy image provenance.
  const h = new RuntimeHarness(manifest.repoRoot, randomUUID(), 3)
  await h.prepareTask2FixtureArtifacts(manifest)
  return h
}

async function task2Soul(page: Page, token: string, soulId: string): Promise<any> {
  return page.evaluate(async ({ token, soulId }) => {
    const response = await fetch(`/api/runtime/souls/${encodeURIComponent(soulId)}`, {
      headers: { 'x-auth-token': token },
    })
    if (!response.ok) throw new Error(`Task2 soul API HTTP ${response.status}`)
    return response.json()
  }, { token, soulId })
}

async function task2Pane(page: Page, context: Task2RetainedPublicContext): Promise<any> {
  const state = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState())
  return leavesByMode(state?.panes?.layouts?.[context.preferredTabId], 'opencode')
    .find(leaf => leaf.id === context.preferredPaneId)
}

async function task2SelectProjectedPane(page: Page, context: Task2RetainedPublicContext): Promise<void> {
  const tab = page.getByRole('tab', { name: new RegExp(regexEscape(context.title)) })
  await expect(tab).toBeVisible({ timeout: 60_000 })
  await tab.click()
  await expect.poll(async () => (await task2Pane(page, context))?.content?.soulId, {
    timeout: 60_000,
  }).toBe(context.soulId)
}

async function task2ClickRetry(
  page: Page, context: Task2RetainedPublicContext,
): Promise<AdminReply> {
  const detail = await task2Soul(page, context.info.token, context.soulId)
  await expect.poll(async () => (await task2Pane(page, context))?.content?.soulIntentRevision, {
    timeout: 60_000,
  }).toBe(detail.soul.intentRevision)
  const route = `/api/runtime/souls/${encodeURIComponent(context.soulId)}/retry`
  const responsePromise = page.waitForResponse(response => (
    new URL(response.url()).pathname === route && response.request().method() === 'POST'
  ), { timeout: 300_000 })
  const retry = page.getByRole('alert').filter({ hasText: 'This session needs attention' })
    .getByRole('button', { name: 'Retry recovery', exact: true })
  await expect(retry).toBeEnabled({ timeout: 60_000 })
  await retry.click()
  const response = await responsePromise
  const sent = response.request().postDataJSON()
  expect(sent.expectedIntentRevision).toBe(detail.soul.intentRevision)
  expect(sent.requestId).toMatch(/^request-runtime-ui-/)
  if (!response.ok()) {
    // A transport/auth/revision refusal is a failure, never config coverage.
    throw new Error(`owned synthetic retry API HTTP ${response.status()}`)
  }
  const result = await response.json()
  expect(result.view.soulId).toBe(context.soulId)
  return { requestId: sent.requestId, result: { Ok: { kind: 'recovery', data: result } } }
}

async function exerciseTask2Browser(browser: Browser, legacy: boolean): Promise<void> {
  const descriptor = resolveManagedExternalDescriptor(process.env)
  const h = descriptor ? undefined : await task2FixtureHarness()
  const external = descriptor ? new ExternalManagedRuntimeRig(descriptor) : undefined
  let ownedPage: Awaited<ReturnType<typeof createFreshE2ePage>> | undefined
  let localInfo: E2eServerInfo | undefined
  const observed: Task2RetainedBrowserPhase[] = []
  try {
    const observe = async (context: Task2RetainedPublicContext, phase: Task2RetainedBrowserPhase): Promise<void> => {
      if (!ownedPage) {
        const info = descriptor ? await new ExternalServer(process.env).start() : localInfo
        if (!info) throw new Error('owned retained browser connection is missing')
        ownedPage = await createFreshE2ePage(browser, info)
        installRecoveryOfferAutoDeclineOnContext(ownedPage.context)
        await ownedPage.page.goto(`${context.info.baseUrl}/?token=${context.info.token}&e2e=1`, {
          timeout: 60_000,
        })
        const harness = new TestHarness(ownedPage.page)
        await harness.waitForHarness(60_000)
        await harness.waitForConnection()
      }
      const { page } = ownedPage
      await task2SelectProjectedPane(page, context)
      const detail = await task2Soul(page, context.info.token, context.soulId)
      expect(detail.soul.soulId).toBe(context.soulId)
      expect(detail.soul.nativeSessionId).toBe(context.rootSessionId)
      expect(detail.soul.incidentId).toBeUndefined()
      const intent = detail.viewIntents.find((view: any) => view.preferredPaneId === context.preferredPaneId)
      expect(intent).toMatchObject({ kind: 'automatic_primary', visibility: 'visible',
        preferredTabId: context.preferredTabId, soulId: context.soulId })
      const alert = page.getByRole('alert').filter({ hasText: 'This session needs attention' })
      if (phase === 'store_blocked') {
        expect(detail.soul.recoveryState).toBe('blocked')
        expect(detail.soul.recoveryReason).toBe('STORE_UNREADABLE')
        expect(detail.soul.containerId).toBe(context.oldContainerId)
        await expect(alert).toBeVisible()
        await expect(alert).toContainText('saved conversation store is readable')
        await expect(alert.getByRole('button', { name: 'Retry recovery', exact: true })).toBeEnabled()
        await expect(page.getByRole('button', { name: 'Start new conversation', exact: true })).toHaveCount(0)
      } else if (phase === 'config_blocked') {
        expect(context.configMode).toBe(0)
        expect(context.result?.result.Ok?.data.outcome).toBe('blocked')
        expect(context.result?.result.Ok?.data.probe).toMatchObject({ kind: 'blocked',
          data: { reason: 'CAPABILITY_PENDING' } })
        expect(context.result?.result.Ok?.data.probe.data.retry_hint?.repair)
          .toContain('provider configuration publication')
        expect(detail.soul.recoveryState).toBe('blocked')
        expect(detail.soul.recoveryReason).toBe('CAPABILITY_PENDING')
        await expect(alert).toBeVisible()
        // Assert the real persisted reason rendered by the production card.
        await expect(alert).toContainText(managedRecoveryBlockedMessage(detail.soul.recoveryReason))
        await expect(alert.getByRole('button', { name: 'Retry recovery', exact: true })).toBeEnabled()
      } else {
        expect(context.result?.result.Ok?.data.outcome).toBe('replaced')
        expect(detail.soul.containerId).not.toBe(context.oldContainerId)
        expect(detail.soul.incarnationId).not.toBe(context.oldIncarnationId)
        expect(detail.soul.launchState).toBe('running')
        await expect.poll(async () => (await task2Pane(page, context))?.content?.incarnationId, {
          timeout: 60_000,
        }).toBe(detail.soul.incarnationId)
        const pane = await task2Pane(page, context)
        expect(pane.content.soulId).toBe(context.soulId)
        expect(pane.content.sessionRef?.sessionId).toBe(context.rootSessionId)
        await expect(alert).toHaveCount(0)
        await page.screenshot({ path: h ? path.join(h.browserDir, legacy ? 'legacy-replaced.png' : 'config-replaced.png') : test.info().outputPath(legacy ? 'legacy-replaced.png' : 'config-replaced.png') })
      }
      observed.push(phase)
    }
    const retry = async (context: Task2RetainedPublicContext, phase: 'config_fault' | 'repaired'): Promise<AdminReply> => {
      if (!ownedPage) throw new Error('browser must observe the actual blocker before retry')
      await task2SelectProjectedPane(ownedPage.page, context)
      if (phase === 'repaired' && !legacy) expect(context.configMode).toBe(0o644)
      return task2ClickRetry(ownedPage.page, context)
    }
    if (external) {
      await external.start()
      await external.startRetainedFixture(legacy ? 'legacy' : 'config')
      let sequence = 0
      for (;;) {
        await expect.poll(async () => {
          const stage = await external.retainedFixtureStage()
          return stage.kind !== 'preparing' && stage.sequence > sequence
        }, { timeout: 300_000 }).toBe(true)
        const stage = await external.retainedFixtureStage()
        if (stage.kind === 'finished') {
          expect(stage.facts?.candidateSha).toBe(descriptor?.candidateSha)
          expect(stage.facts?.unsafeBrokerAttempts).toBe(0)
          expect(stage.facts?.fixtureRunId).toMatch(/^[a-f0-9-]{36}$/)
          expect(stage.facts?.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
          break
        }
        if (stage.kind === 'failed') throw new Error('actual owner retained fixture failed; inspect its private evidence')
        if (stage.kind === 'preparing') throw new Error('owned retained stage changed unexpectedly')
        sequence = stage.sequence
        if (stage.kind === 'observe') {
          if (stage.phase !== 'store_blocked' && stage.phase !== 'config_blocked' && stage.phase !== 'replaced') throw new Error('invalid retained observation phase')
          await observe(stage.context, stage.phase)
          await external.observeRetainedFixture(sequence)
        } else if (stage.kind === 'retry') {
          if (stage.phase !== 'config_fault' && stage.phase !== 'repaired') throw new Error('invalid retained retry phase')
          await retry(stage.context, stage.phase)
        }
      }
    } else {
      if (!h) throw new Error('local retained owner missing')
      const publicContext = (context: Task2RetainedBrowserContext): Task2RetainedPublicContext => {
        localInfo = context.web.info
        return task2RetainedPublicContext(context)
      }
      await runTask2RetainedFixture(h, legacy, {
        observe: (context, phase) => observe(publicContext(context), phase),
        retry: (context, phase) => retry(publicContext(context), phase),
      })
    }
    expect(observed).toEqual(legacy ? ['store_blocked', 'replaced'] : ['store_blocked', 'config_blocked', 'replaced'])
    if (h) expect(h.broker.unsafeAttempts()).toHaveLength(0)
  } finally {
    await ownedPage?.context.close()
    if (external) {
      const cleanup = await external.finishRetainedFixture()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    if (h) {
      const receipts = h.broker.receipts(), ids = h.transferOwnedIds()
      const cleanup = await h.cleanup()
      h.verifyTransferCleanup({ containers: [...new Set([...ids.containers, ...receipts.map(row => row.containerId)])],
        volumes: [...new Set([...ids.volumes, ...receipts.flatMap(row => row.providerVolumeName ? [row.providerVolumeName] : [])])] })
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  }
  // These labels describe the fixture type; physical/DOM/API assertions above
  // carry the evidence. This artifact cannot qualify native identity/readiness.
  h?.writeArtifact(legacy ? 'task002-legacy-browser.json' : 'task002-config-browser.json', {
    kind: 'synthetic-task2-browser', nativeQualified: false,
    candidateSha: h.candidateSha, imageDigest: h.imageRef, observed,
  })
}

test.describe.serial('Task2 synthetic provider configuration and legacy retry', () => {
  test('synthetic config-blocked exact retry', async ({ browser }) => {
    test.skip(process.env[SYNTHETIC_TASK2_ENV] !== '1', `requires ${SYNTHETIC_TASK2_ENV}=1`)
    test.setTimeout(900_000)
    await exerciseTask2Browser(browser, false)
  })
  test('synthetic legacy retained-runtime exact retry', async ({ browser }) => {
    test.skip(process.env[SYNTHETIC_TASK2_ENV] !== '1', `requires ${SYNTHETIC_TASK2_ENV}=1`)
    test.setTimeout(900_000)
    await exerciseTask2Browser(browser, true)
  })
})
