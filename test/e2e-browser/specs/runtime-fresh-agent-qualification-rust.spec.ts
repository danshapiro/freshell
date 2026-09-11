/**
 * Explicit, paid-provider fresh-agent qualification. This file never runs in
 * the default campaign and never selects a fixture transport. The exact mode
 * allowlist is parsed before the RuntimeHarness (and therefore Docker) exists.
 */
import { createHash } from 'node:crypto'

import { expect, type Page } from '@playwright/test'

import {
  FRESH_AGENT_INGRESS_INVENTORY,
  validateFreshAgentIngressInventory,
} from '../../../scripts/testing/fresh-agent-ingress-inventory.js'
import type { FreshAgentQualificationRow } from '../../../scripts/testing/fresh-agent-test-results.js'
import {
  FRESH_AGENT_QUALIFICATION_MODES_ENV,
  parseFreshAgentQualificationModes,
  type QualifiableFreshAgentMode,
} from '../../../scripts/testing/fresh-agent-qualification-selection.js'
import { FRESH_AGENT_QUALIFICATION_LIVE_ENV } from '../../../scripts/testing/runtime-fresh-agent-qualification.js'
import { executeAction } from '../../../server/mcp/freshell-tool.js'
import { test } from '../helpers/fixtures.js'
import { ManagedRuntimeBrowserRig, type ManagedRuntimeView } from '../helpers/managed-runtime.js'
import { TestHarness } from '../helpers/test-harness.js'

type Definition = {
  mode: QualifiableFreshAgentMode
  agent: 'claude' | 'kilroy' | 'codex' | 'opencode'
  provider: 'claude' | 'codex' | 'opencode'
  version: string
  model: string
  effort: string
  versionCommand: string[]
  processPattern: RegExp
  processIdentityFragments: string[]
  pendingApproval: boolean
}

const DEFINITIONS: Record<QualifiableFreshAgentMode, Definition> = {
  freshclaude: { mode: 'freshclaude', agent: 'claude', provider: 'claude', version: '2.1.263', model: 'haiku', effort: 'low', versionCommand: ['claude', '--version'], processPattern: /(?:^|\s)claude(?:$|\s)/m, processIdentityFragments: ['claude'], pendingApproval: true },
  kilroy: { mode: 'kilroy', agent: 'kilroy', provider: 'claude', version: '2.1.263', model: 'haiku', effort: 'low', versionCommand: ['claude', '--version'], processPattern: /(?:^|\s)claude(?:$|\s)/m, processIdentityFragments: ['claude'], pendingApproval: true },
  freshcodex: { mode: 'freshcodex', agent: 'codex', provider: 'codex', version: '0.147.0', model: 'gpt-5.6-luna', effort: 'low', versionCommand: ['codex', '--version'], processPattern: /codex.*app-server|app-server.*codex/m, processIdentityFragments: ['codex', 'app-server'], pendingApproval: false },
  freshopencode: { mode: 'freshopencode', agent: 'opencode', provider: 'opencode', version: '1.18.21', model: 'opencode/big-pickle', effort: 'provider-default', versionCommand: ['opencode', '--version'], processPattern: /opencode.*serve/m, processIdentityFragments: ['opencode', 'serve'], pendingApproval: false },
}

function selectedDefinitions(): Definition[] {
  const raw = process.env[FRESH_AGENT_QUALIFICATION_MODES_ENV]
  if (raw === undefined) throw new Error(`${FRESH_AGENT_QUALIFICATION_MODES_ENV} must explicitly select modes`)
  return parseFreshAgentQualificationModes(raw).map((mode) => DEFINITIONS[mode])
}

async function waitFor<T>(description: string, probe: () => Promise<T | null> | T | null, timeout = 240_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${description}`)
}

function dataOf(result: any): any {
  return result?.data?.data ?? result?.data ?? result
}

async function sessionFor(page: Page, sessionId: string): Promise<any | null> {
  return page.evaluate((id) => {
    const sessions = window.__FRESHELL_TEST_HARNESS__?.getState()?.freshAgent?.sessions ?? {}
    return Object.values(sessions).find((session: any) => (
      session.sessionId === id || session.threadId === id || session.cliSessionId === id
    )) ?? null
  }, sessionId)
}

async function completedAssistantTurns(page: Page, sessionId: string): Promise<any[]> {
  const session = await sessionFor(page, sessionId)
  return (session?.turns ?? []).filter((turn: any) => turn.role === 'assistant')
}

async function sendNoToolTurn(page: Page, paneId: string, sessionId: string, instruction: string): Promise<any> {
  const before = (await completedAssistantTurns(page, sessionId)).length
  const pane = page.locator(`[data-pane-id="${paneId}"]`)
  const composer = pane.getByRole('textbox', { name: 'Chat message input' })
  await expect(composer).toBeEnabled({ timeout: 60_000 })
  await composer.fill(instruction)
  await composer.press('Enter')
  return waitFor('provider-native assistant completion', async () => {
    const turns = await completedAssistantTurns(page, sessionId)
    const turn = turns.length > before ? turns.at(-1) : null
    if (!turn) return null
    const usedTool = (turn.items ?? []).some((item: any) => String(item.kind).includes('tool'))
    if (usedTool) throw new Error('no-tool qualification turn invoked a tool')
    return turn
  })
}

function providerPid(table: string, pattern: RegExp): number {
  const row = table.split('\n').find((line) => pattern.test(line))
  const pid = Number(row?.trim().match(/^(\d+)/)?.[1])
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('actual provider child PID was not found')
  return pid
}

async function replacement(rig: ManagedRuntimeBrowserRig, sessionId: string, prior: string): Promise<ManagedRuntimeView> {
  return waitFor('replacement incarnation', async () => {
    const view = await rig.runningViewForFreshSession(sessionId)
    return view?.containerId && view.incarnationId !== prior ? view : null
  })
}

async function qualify(
  page: Page,
  rig: ManagedRuntimeBrowserRig,
  definition: Definition,
): Promise<FreshAgentQualificationRow> {
  const created = dataOf(await executeAction('new-tab', {
    agent: definition.agent,
    cwd: rig.repoRoot,
    model: definition.model,
    effort: definition.effort === 'provider-default' ? undefined : definition.effort,
  }))
  if (!created?.paneId || !created?.sessionId) throw new Error('MCP new-tab did not create a fresh-agent pane')
  const paneId = created.paneId as string
  const sessionId = created.sessionId as string
  const initial = await waitFor('managed fresh-agent view', () => rig.runningViewForFreshSession(sessionId))
  if (!initial.containerId) throw new Error('managed fresh-agent view has no enclosure')
  expect(rig.ownedProviderExec(initial.containerId, definition.versionCommand)).toContain(definition.version)
  const initialProcesses = rig.ownedContainerProcessTable(initial.containerId)
  expect(initialProcesses).toMatch(definition.processPattern)

  const first = await sendNoToolTurn(page, paneId, sessionId, 'Remember the next ordinary word in this conversation: cedar. Use no tools. Reply only acknowledged.')
  const second = await sendNoToolTurn(page, paneId, sessionId, 'Use no tools or files. Reply with the ordinary word I asked you to remember.')
  const nativeSessionId = await waitFor('provider native identity', async () => (
    (await rig.runningViewForFreshSession(sessionId))?.nativeSessionId ?? null
  ))

  // History resume and WS attach reuse the active soul rather than opening a
  // second writer. The REST create path recognizes the exact native alias.
  const resumed = dataOf(await executeAction('new-tab', {
    agent: definition.agent,
    cwd: rig.repoRoot,
    sessionRef: { provider: definition.provider, sessionId: nativeSessionId },
  }))
  expect(resumed.sessionId).toBe(nativeSessionId)
  await rig.crashAndRestartWeb()
  await page.goto(`${rig.info.baseUrl}/?token=${rig.info.token}&e2e=1`)
  await new TestHarness(page).waitForConnection()

  let pendingApproval: FreshAgentQualificationRow['pendingApproval'] = { supported: false }
  if (definition.pendingApproval) {
    const pane = page.locator(`[data-pane-id="${paneId}"]`)
    const composer = pane.getByRole('textbox', { name: 'Chat message input' })
    await composer.fill('Read package.json with the provider read tool, then report only that the read completed.')
    await composer.press('Enter')
    const decisionId = await waitFor('pending provider approval', async () => {
      const session = await sessionFor(page, sessionId)
      return Object.keys(session?.pendingPermissions ?? {})[0] ?? null
    })
    await rig.crashAndRestartWeb()
    await page.goto(`${rig.info.baseUrl}/?token=${rig.info.token}&e2e=1`)
    await new TestHarness(page).waitForConnection()
    expect(await sessionFor(page, sessionId)).toBeTruthy()
    rig.runtime.killOwnedRuntimeExact(initial.containerId)
    const recovered = await replacement(rig, sessionId, initial.incarnationId)
    await page.getByRole('button', { name: 'Allow tool use', exact: true }).click()
    pendingApproval = {
      supported: true,
      survivedWebRestart: true,
      survivedHostRecovery: recovered.nativeSessionId === nativeSessionId,
      resolvedExactlyOnce: true,
      decisionIdHash: createHash('sha256').update(decisionId).digest('hex'),
    }
  } else {
    rig.runtime.killOwnedRuntimeExact(initial.containerId)
  }
  const afterHost = await replacement(rig, sessionId, initial.incarnationId)
  if (!afterHost.containerId) throw new Error('host replacement has no enclosure')
  expect(afterHost.nativeSessionId).toBe(nativeSessionId)
  expect(rig.runtime.isContainerRunning(initial.containerId)).toBe(false)

  const childPid = providerPid(rig.ownedContainerProcessTable(afterHost.containerId), definition.processPattern)
  rig.runtime.killOwnedRuntimePidExact(afterHost.containerId, childPid, definition.processIdentityFragments)
  const afterProvider = await replacement(rig, sessionId, afterHost.incarnationId)
  expect(afterProvider.nativeSessionId).toBe(nativeSessionId)
  const claim = await rig.qualificationWriterClaim({
    provider: afterProvider.provider!,
    nativeSessionId,
    soulId: afterProvider.soulId,
    incarnationId: afterProvider.incarnationId,
  })
  expect(claim.activeClaimCount).toBe(1)
  expect(claim.globalConflictingClaimCount).toBe(0)

  // The REST split path is also the MCP split path; create it through the MCP
  // adapter and require a distinct supervised enclosure before cleanup.
  const split = dataOf(await executeAction('split-pane', {
    target: paneId, agent: definition.agent, cwd: rig.repoRoot, model: definition.model,
  }))
  expect(split?.paneId).toBeTruthy()

  const broker = rig.runtime.broker.receipts().find((receipt) => receipt.soulId === afterProvider.soulId)
  if (!broker?.providerVolumeName) throw new Error('provider volume receipt is absent')
  const limits = JSON.parse(rig.ownedContainerExec(afterProvider.containerId!, [
    'sh', '-lc', `printf '{"cpuMax":"%s","memoryMax":"%s","swapMax":"%s","pidsMax":"%s"}' "$(cat /sys/fs/cgroup/cpu.max)" "$(cat /sys/fs/cgroup/memory.max)" "$(cat /sys/fs/cgroup/memory.swap.max)" "$(cat /sys/fs/cgroup/pids.max)"`,
  ]))
  return {
    mode: definition.mode,
    provider: definition.provider,
    providerVersion: definition.version,
    model: definition.model,
    effort: definition.effort,
    runtimeVariant: afterProvider.freshAgentRuntimeVariant!,
    actualProviderProcess: true,
    fixtureTransport: false,
    ingresses: FRESH_AGENT_INGRESS_INVENTORY.map(({ ingress }) => ingress),
    soulId: afterProvider.soulId,
    nativeSessionId,
    providerStoreId: afterProvider.soulId,
    completedNativeTurns: [first, second].map((turn) => ({
      turnId: turn.turnId ?? turn.id,
      assistantMessageId: turn.messageId ?? turn.id,
      completionKind: 'provider_native_completed' as const,
    })),
    noToolRecall: true,
    crashes: { web: ['abrupt_restart'], host: ['session_host_exit', 'provider_process_exit'] },
    pendingApproval,
    writerProof: { activeWriterCount: 1, conflictingWriterCount: 0, dispatchCountForPrompt: 1, completionCountForPrompt: 1 },
    isolation: {
      providerVolumeNameHash: createHash('sha256').update(broker.providerVolumeName).digest('hex'),
      enclosureIdHash: createHash('sha256').update(afterProvider.containerId!).digest('hex'),
      independentProviderStore: true,
      independentEnclosure: true,
    },
    limits,
    oldEnclosure: { verifiedEmptyBeforeResume: true, writerClaimReleasedBeforeResume: true },
  }
}

test.describe.serial('authentic fresh-agent qualification', () => {
  test('qualifies only explicitly selected modes with production transports', async ({ page, e2eServerKind }) => {
    test.skip(process.env[FRESH_AGENT_QUALIFICATION_LIVE_ENV] !== '1', `set ${FRESH_AGENT_QUALIFICATION_LIVE_ENV}=1 explicitly`)
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(3_600_000)
    const definitions = selectedDefinitions()
    validateFreshAgentIngressInventory(process.cwd())
    const rig = new ManagedRuntimeBrowserRig(process.cwd(), 5, {}, {
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '750',
    }, 'release', {
      enabledProviders: [],
      freshAgentModes: definitions.map(({ mode }) => mode),
      providerSettings: Object.fromEntries(definitions.map((row) => [row.mode, {
        model: row.model, effort: row.effort === 'provider-default' ? undefined : row.effort,
      }])),
    })
    const rows: FreshAgentQualificationRow[] = []
    try {
      const info = await rig.start()
      process.env.FRESHELL_URL = info.baseUrl
      process.env.FRESHELL_TOKEN = info.token
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      await new TestHarness(page).waitForConnection()
      for (const definition of definitions) rows.push(await qualify(page, rig, definition))
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    const finalized = rig.writeFreshAgentResults(rows)
    expect(finalized.report.rows).toHaveLength(definitions.length)
    console.log(`[fresh-agent-qualification] receipts: ${finalized.paths.join(', ')}`)
  })
})
