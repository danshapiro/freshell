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
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'

import { expect, type Page } from '@playwright/test'

import type { ProviderQualificationRow } from '../../../scripts/testing/provider-test-results.js'
import {
  QUALIFICATION_PROVIDER_SELECTION_ENV,
  parseQualificationProviderSelection,
} from '../../../scripts/testing/provider-qualification-selection.js'
import { test } from '../helpers/fixtures.js'
import {
  ManagedRuntimeBrowserRig,
  P2_OPENCODE_FREE_MODEL,
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

function requireAmplifierOnecliBootstrap(): void {
  const keys = process.env.FRESHELL_MANAGED_AMPLIFIER_ONECLI_KEYS_FILE?.trim()
    || path.join(process.env.HOME ?? '', '.amplifier', 'keys.env')
  let regular = false
  try {
    const stat = fs.lstatSync(keys)
    regular = stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
  } catch {}
  if (!path.isAbsolute(keys) || !regular) {
    throw new Error(`Amplifier OneCLI keys reference is missing, linked, or not private: ${keys}`)
  }
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
      model: P2_OPENCODE_FREE_MODEL,
      reasoningEffort: 'provider-default',
      versionCommand: ['opencode', '--version'],
      versionPattern: new RegExp(`^${P2_OPENCODE_VERSION.replaceAll('.', '\\.')}\\s*$`),
      processBinary: 'opencode',
      processIdentityNeedles: [P2_OPENCODE_FREE_MODEL],
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

function expectExactProcessIdentity(processTable: string, identity: string): void {
  expect(processTable).toMatch(new RegExp(`(?:^|[\\s=:'"])${regexEscape(identity)}(?:$|[\\s'"])`, 'm'))
}

function expectActualProviderProcess(processTable: string, binary: string): void {
  expect(processTable).toMatch(new RegExp(`(?:^|\\s)(?:/[^\\s]*/)?${regexEscape(binary)}(?:$|\\s)`, 'm'))
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

function limitEvidence(rig: ManagedRuntimeBrowserRig, view: ManagedRuntimeView): ProviderQualificationRow['limitEvidence'] {
  if (!view.containerId) throw new Error('managed runtime has no container for limit evidence')
  const expected = (view as any).effectiveLimits
  if (!expected) throw new Error('managed runtime has no effective limits')
  const actual = JSON.parse(rig.ownedContainerExec(view.containerId, [
    'sh', '-lc',
    `printf '{"cpuMax":"%s","memoryMax":"%s","swapMax":"%s","pidsMax":"%s"}' "$(cat /sys/fs/cgroup/cpu.max)" "$(cat /sys/fs/cgroup/memory.max)" "$(cat /sys/fs/cgroup/memory.swap.max)" "$(cat /sys/fs/cgroup/pids.max)"`,
  ]))
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

function workerPid(rig: ManagedRuntimeBrowserRig, view: ManagedRuntimeView): number {
  const statePath = path.join(
    rig.runtime.runtimeDir(rig.supervisor, view.incarnationId),
    'host-state.json',
  )
  return Number(JSON.parse(fs.readFileSync(statePath, 'utf8')).workerPid)
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

  const version = rig.ownedProviderExec(created.view.containerId, definition.versionCommand)
  expect(version).toMatch(definition.versionPattern)
  const processTable = rig.ownedContainerProcessTable(created.view.containerId)
  expectActualProviderProcess(processTable, definition.processBinary)
  for (const identity of definition.processIdentityNeedles) {
    expectExactProcessIdentity(processTable, identity)
  }
  if (definition.reasoningEffort === 'provider-default') {
    expect(processTable).not.toMatch(/(?:^|\s)--(?:reasoning-)?effort(?:=|\s)/m)
  }
  const exactLimits = limitEvidence(rig, created.view)
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
  rig.runtime.killOwnedRuntimeExact(created.view.containerId)
  const afterHostLoss = await waitForReplacement(rig, created.terminalId, created.view.incarnationId)
  expect(afterHostLoss.soulId).toBe(created.view.soulId)
  expect(afterHostLoss.nativeSessionId).toBe(nativeSessionId)
  expect(rig.runtime.isContainerRunning(created.view.containerId)).toBe(false)

  await executeAndAwaitNonceOutput(
    page,
    created.paneId,
    created.terminalId,
    'Without using tools or files, what private project codename did I give you earlier?',
    nonce,
  )

  if (!afterHostLoss.containerId) throw new Error('host-loss replacement has no owned container')
  const pid = workerPid(rig, afterHostLoss)
  expect(pid).toBeGreaterThan(1)
  rig.runtime.killOwnedRuntimePidExact(afterHostLoss.containerId, pid, [definition.processBinary])
  const afterProviderLoss = await waitForReplacement(rig, created.terminalId, afterHostLoss.incarnationId)
  expect(afterProviderLoss.soulId).toBe(created.view.soulId)
  expect(afterProviderLoss.nativeSessionId).toBe(nativeSessionId)
  expect(afterProviderLoss.profile).toBe(created.view.profile)
  expect(rig.runtime.isContainerRunning(afterHostLoss.containerId)).toBe(false)

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
  const writerClaim = await rig.qualificationWriterClaim({
    provider: definition.provider,
    nativeSessionId,
    soulId: created.view.soulId,
    incarnationId: afterProviderLoss.incarnationId,
  })
  expect(writerClaim.activeClaimCount).toBe(1)
  expect(writerClaim.globalConflictingClaimCount).toBe(0)
  const notices = await rig.runtime.adminOk(rig.supervisor, rig.runtime.pendingNoticesBody(
    `profile:managed-provider-qualification:${definition.provider}`,
    100,
    await rig.controlEpoch(),
  ))
  expect(notices.kind).toBe('pending_notices')
  expect(notices.data).toHaveLength(0)
  const stopped = await rig.stopSoul(created.view.soulId)
  expect(stopped.outcome).toBe('verified_empty')
  const claimAfterStop = await rig.qualificationWriterClaim({
    provider: definition.provider,
    nativeSessionId,
    soulId: created.view.soulId,
    incarnationId: afterProviderLoss.incarnationId,
  })
  expect(claimAfterStop.activeClaimCount).toBe(0)
  expect(claimAfterStop.globalConflictingClaimCount).toBe(0)
  const oldContainerRunningAfterStop = rig.runtime.isContainerRunning(afterProviderLoss.containerId!)
  expect(oldContainerRunningAfterStop).toBe(false)
  expect(rig.runtime.broker.unsafeAttempts()).toHaveLength(0)
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
    releaseBinary: rig.supervisor.binaryKind === 'release',
    nativeRecovery: true,
    exactNativeRecovery: afterHostLoss.nativeSessionId === nativeSessionId
      && afterProviderLoss.nativeSessionId === nativeSessionId,
    sameNativeSession: afterProviderLoss.nativeSessionId === nativeSessionId,
    followUpCompleted: true,
    onlyOneWriter: runningWriters.length === 1,
    writerClaim,
    oldEnclosureVerifiedEmpty: !rig.runtime.isContainerRunning(created.view.containerId)
      && !rig.runtime.isContainerRunning(afterHostLoss.containerId),
    verifiedEmptyOrdering: {
      stopOutcome: stopped.outcome,
      activeClaimCountAfterStop: claimAfterStop.activeClaimCount,
      globalConflictingClaimCountAfterStop: claimAfterStop.globalConflictingClaimCount,
      oldContainerRunningAfterStop,
    },
    lostNoticeCount: notices.data.length,
    crashKinds: ['session_host', 'provider_process'],
    nonceRecovery: {
      sameSoul: afterHostLoss.soulId === created.view.soulId,
      sameNativeSession: afterHostLoss.nativeSessionId === nativeSessionId,
      newIncarnation: afterHostLoss.incarnationId !== created.view.incarnationId,
      oldEnclosureVerifiedEmpty: !rig.runtime.isContainerRunning(created.view.containerId),
      recalledNonce: true,
      followUpCompleted: true,
      workspaceOrToolReadUsed: nativeTurnProofs.some((proof) => proof.toolCallCount > 0),
    },
    repairedSameSoul: afterProviderLoss.soulId === created.view.soulId,
    repairedSameNativeSession: afterProviderLoss.nativeSessionId === nativeSessionId,
  }
}

test.describe.serial('selectable managed-provider qualification', () => {
  test('each explicitly selected provider produces an independent evidence-bound live row', async ({ page, e2eServerKind }) => {
    test.skip(
      process.env[LIVE_ENV] !== '1',
      `set ${LIVE_ENV}=1 only for a live candidate-bound managed-provider campaign`,
    )
    expect(e2eServerKind).toBe('rust')
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
    const finalized = rig.writeProviderResults(providers)
    expect(finalized.report.schemaVersion).toBe(2)
    expect(finalized.report.providers).toHaveLength(definitions.length)
    // eslint-disable-next-line no-console
    console.log(`[provider-qualification] selected-provider receipts: ${finalized.paths.join(', ')}`)
  })
})
