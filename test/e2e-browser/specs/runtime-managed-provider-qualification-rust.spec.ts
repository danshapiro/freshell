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
import path from 'node:path'

import { expect, type Page } from '@playwright/test'

import type { ProviderQualificationRow } from '../../../scripts/testing/provider-qualification-receipt.js'
import { test } from '../helpers/fixtures.js'
import {
  ManagedRuntimeBrowserRig,
  P2_OPENCODE_FREE_MODEL,
  P2_OPENCODE_VERSION,
  type ManagedRuntimeView,
} from '../helpers/managed-runtime.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TestHarness } from '../helpers/test-harness.js'

const LIVE_ENV = 'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE'

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

function requiredAmplifierSetting(name: 'MODEL' | 'REASONING_EFFORT'): string {
  const key = `FRESHELL_RUNTIME_AMPLIFIER_${name}`
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} must name the exact non-secret live Amplifier identity`)
  return value
}

function providerDefinitions(): ProviderDefinition[] {
  const amplifierModel = requiredAmplifierSetting('MODEL')
  const amplifierEffort = requiredAmplifierSetting('REASONING_EFFORT')
  return [
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
    {
      provider: 'amplifier',
      pickerName: /^Amplifier$/i,
      directoryName: /Starting directory for Amplifier/i,
      providerVersion: '0.1.1',
      model: amplifierModel,
      reasoningEffort: amplifierEffort,
      versionCommand: [
        '/opt/amplifier-src/.venv/bin/python',
        '-c',
        'import importlib.metadata as m; print(m.version("amplifier-app-cli"))',
      ],
      versionPattern: /^0\.1\.1\s*$/,
      processBinary: 'amplifier',
      processIdentityNeedles: [amplifierModel, amplifierEffort],
      nativeIdPattern: /^[A-Za-z0-9][A-Za-z0-9._-]+$/,
    },
  ]
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

async function executeAndRequireUnechoedOutput(
  page: Page,
  paneId: string,
  terminalId: string,
  command: string,
  responseMarker: string,
  timeoutMs = 240_000,
): Promise<void> {
  if (command.includes(responseMarker)) {
    throw new Error('qualification response marker must not appear in the echoed input')
  }
  const before = occurrences(await terminalBuffer(page, terminalId), responseMarker)
  const terminal = page.locator(`[data-pane-id="${paneId}"] .xterm:visible`).last()
  await terminal.waitFor({ state: 'visible', timeout: 90_000 })
  await terminal.click()
  await page.keyboard.insertText(command)
  await page.keyboard.press('Enter')
  // The marker is deliberately absent from the instruction, so one new exact
  // occurrence proves provider output rather than terminal input echo/redraw.
  await waitForValue(`provider response ${responseMarker}`, async () => (
    occurrences(await terminalBuffer(page, terminalId), responseMarker) > before ? true : null
  ), timeoutMs)
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

function limitsVerified(rig: ManagedRuntimeBrowserRig, view: ManagedRuntimeView): boolean {
  if (!view.containerId) return false
  const expected = (view as any).effectiveLimits
  if (!expected) return false
  const actual = JSON.parse(rig.ownedContainerExec(view.containerId, [
    'sh', '-lc',
    `printf '{"cpu":"%s","memory":"%s","pids":"%s"}' "$(cat /sys/fs/cgroup/cpu.max)" "$(cat /sys/fs/cgroup/memory.max)" "$(cat /sys/fs/cgroup/pids.max)"`,
  ]))
  return actual.cpu === `${expected.cpuMilli * 100} 100000`
    && actual.memory === String(expected.memoryBytes)
    && actual.pids === String(expected.pidsMax)
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
  const exactLimits = limitsVerified(rig, created.view)
  expect(exactLimits).toBe(true)

  const nonce = `QUALIFY_${definition.provider.toUpperCase()}_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const storedMarker = `STORED_${definition.provider.toUpperCase()}`
  await executeAndRequireUnechoedOutput(
    page,
    created.paneId,
    created.terminalId,
    `Remember ${nonce} only in this conversation. Use no tools. Reply with STORED, then one underscore, then ${definition.provider.toUpperCase()}.`,
    storedMarker,
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

  const nonceBeforeRecall = occurrences(await terminalBuffer(page, created.terminalId), nonce)
  const terminal = page.locator(`[data-pane-id="${created.paneId}"] .xterm:visible`).last()
  await terminal.click()
  await page.keyboard.insertText('Without tools or files, reply with exactly the nonce from my first instruction.')
  await page.keyboard.press('Enter')
  await waitForValue('same-conversation nonce recall', async () => (
    occurrences(await terminalBuffer(page, created.terminalId), nonce) > nonceBeforeRecall
      ? true
      : null
  ), 240_000)

  if (!afterHostLoss.containerId) throw new Error('host-loss replacement has no owned container')
  const pid = workerPid(rig, afterHostLoss)
  expect(pid).toBeGreaterThan(1)
  rig.runtime.killOwnedRuntimePidExact(afterHostLoss.containerId, pid)
  const afterProviderLoss = await waitForReplacement(rig, created.terminalId, afterHostLoss.incarnationId)
  expect(afterProviderLoss.soulId).toBe(created.view.soulId)
  expect(afterProviderLoss.nativeSessionId).toBe(nativeSessionId)
  expect(afterProviderLoss.profile).toBe(created.view.profile)
  expect(rig.runtime.isContainerRunning(afterHostLoss.containerId)).toBe(false)

  const followUpMarker = `FOLLOWUP_${definition.provider.toUpperCase()}_${Date.now()}`
  const [followPrefix, followProvider, followTimestamp] = followUpMarker.split('_')
  await executeAndRequireUnechoedOutput(
    page,
    created.paneId,
    created.terminalId,
    `Continue this same conversation without tools. Reply by joining ${followPrefix}, ${followProvider}, and ${followTimestamp} with underscores and no other text.`,
    followUpMarker,
  )

  const snapshot = await rig.inventorySnapshot()
  const runningWriters = snapshot.souls.filter((row: any) => (
    row.soulId === created.view.soulId && row.launchState === 'running'
  ))
  expect(runningWriters).toHaveLength(1)
  const notices = await rig.runtime.adminOk(rig.supervisor, rig.runtime.pendingNoticesBody(
    `profile:managed-provider-qualification:${definition.provider}`,
    100,
    await rig.controlEpoch(),
  ))
  expect(notices.kind).toBe('pending_notices')
  expect(notices.data).toHaveLength(0)
  const stopped = await rig.stopSoul(created.view.soulId)
  expect(stopped.outcome).toBe('verified_empty')
  expect(rig.runtime.broker.unsafeAttempts()).toHaveLength(0)

  return {
    provider: definition.provider,
    modes: [definition.provider],
    providerVersion: definition.providerVersion,
    model: definition.model,
    reasoningEffort: definition.reasoningEffort,
    nativeSessionId,
    actualProviderBinary: true,
    completedTurn: true,
    nativeStateCaptured: true,
    runtimeOwned: true,
    limitsVerified: exactLimits,
    automaticResume: true,
    profileVerified: afterProviderLoss.profile === created.view.profile,
    releaseBinary: rig.supervisor.binaryKind === 'release',
    nativeRecovery: true,
    exactNativeRecovery: afterHostLoss.nativeSessionId === nativeSessionId
      && afterProviderLoss.nativeSessionId === nativeSessionId,
    sameNativeSession: afterProviderLoss.nativeSessionId === nativeSessionId,
    followUpCompleted: true,
    onlyOneWriter: runningWriters.length === 1,
    oldEnclosureVerifiedEmpty: !rig.runtime.isContainerRunning(created.view.containerId)
      && !rig.runtime.isContainerRunning(afterHostLoss.containerId),
    lostNoticeCount: notices.data.length,
    crashKinds: ['session_host', 'provider_process'],
    nonceRecovery: {
      sameSoul: afterHostLoss.soulId === created.view.soulId,
      sameNativeSession: afterHostLoss.nativeSessionId === nativeSessionId,
      newIncarnation: afterHostLoss.incarnationId !== created.view.incarnationId,
      oldEnclosureVerifiedEmpty: !rig.runtime.isContainerRunning(created.view.containerId),
      recalledNonce: true,
      followUpCompleted: true,
      workspaceOrToolReadUsed: false,
    },
    repairedSameSoul: afterProviderLoss.soulId === created.view.soulId,
    repairedSameNativeSession: afterProviderLoss.nativeSessionId === nativeSessionId,
  }
}

test.describe.serial('combined managed-provider qualification', () => {
  test('Claude, Codex, OpenCode, and Amplifier produce evidence-bound live rows', async ({ page, e2eServerKind }) => {
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
      expect(providers.map((row) => row.provider)).toEqual(['claude', 'codex', 'opencode', 'amplifier'])
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    const finalized = rig.finalizeProviderQualificationReceipt(providers)
    expect(finalized.receipt.schemaVersion).toBe(2)
    expect(finalized.receipt.providers).toHaveLength(4)
    // eslint-disable-next-line no-console
    console.log(`[provider-qualification] combined receipts: ${finalized.paths.join(', ')}`)
  })
})
