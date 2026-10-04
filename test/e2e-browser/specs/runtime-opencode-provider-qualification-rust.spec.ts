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
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, type Page } from '@playwright/test'

import { test } from '../helpers/fixtures.js'
import {
  ManagedRuntimeBrowserRig,
  P2_OPENCODE_MODEL,
  P2_OPENCODE_VERSION,
  type ManagedRuntimeView,
} from '../helpers/managed-runtime.js'
import { requireOpenCodeOnecliBootstrap } from '../helpers/opencode-auth-file.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { TestHarness } from '../helpers/test-harness.js'
import {
  hasOpenCodePromptModelText,
  nativeTurnProof,
  openCodeCredentialFailureMessage,
  openCodeTerminalReady,
  OPENCODE_NATIVE_HISTORY_SCRIPT,
  selectNativeAssistantTurn,
  type NativeAssistantTurn,
} from '../helpers/opencode-native-history.js'
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
  abortProbe?: () => Error | null | undefined | Promise<Error | null | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    const abortError = await abortProbe?.()
    if (abortError) throw abortError
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
  const failOnProviderCrash = async (): Promise<Error | null> => {
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
      const buffer = await page.evaluate((id) => (
        window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer?.(id)
      ), terminalId)
      if (typeof buffer === 'string' && /Bun has crashed|Segmentation fault at address/i.test(buffer)) {
        return new Error(`OpenCode provider process crashed during startup in terminal ${terminalId}`)
      }
    }
    return null
  }

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
  }, timeoutMs, failOnProviderCrash)
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

async function waitForReplacementPrompt(
  page: Page,
  harness: TestHarness,
  rig: ManagedRuntimeBrowserRig,
  tabId: string,
  paneId: string,
  view: ManagedRuntimeView,
  observedStreamChanges: Array<{ terminalId: string; streamId: string; reason: string; attachRequestId: string | null }>,
  observedWebSocketFrameTypes: Set<string>,
  observedWebSocketCount: { value: number },
): Promise<void> {
  const terminalId = view.terminalId
  if (!terminalId) throw new Error('replacement provider has no terminal identity')
  if (!view.terminalStreamId) throw new Error('replacement provider has no stable launch stream identity')
  const modelTexts = ['GPT-5.6 Luna', P2_OPENCODE_MODEL]
  let diagnostic: Record<string, unknown> = {
    soulId: view.soulId,
    incarnationId: view.incarnationId,
    terminalId,
    stableLaunchStreamId: view.terminalStreamId,
  }
  try {
    // Wait on the real browser attachment first. Polling the supervisor's
    // output endpoint every 200 ms races the server's own output reader and
    // can starve the stream-change notification this check needs to observe.
    const browserReady = await waitForValue('replacement provider input readiness in its current browser stream', async () => {
      const leaf = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
        .find((row) => row.id === paneId)
      const paneStreamId = leaf?.content?.streamId
      diagnostic = {
        ...diagnostic,
        paneStreamId,
        paneIncarnationId: leaf?.content?.incarnationId,
      }
      if (
        leaf?.content?.incarnationId !== view.incarnationId
        || typeof paneStreamId !== 'string'
        || paneStreamId.length === 0
        || paneStreamId === view.terminalStreamId
      ) return null

      const rendered = await page.evaluate((id) => {
        const h = window.__FRESHELL_TEST_HARNESS__
        return { text: h?.getTerminalBuffer(id), modes: h?.getTerminalModes?.(id) }
      }, terminalId)
      const browserModelBanner = hasOpenCodePromptModelText(rendered.text ?? '', modelTexts)
      diagnostic = {
        ...diagnostic,
        browserInputReady: rendered.modes?.bracketedPasteMode,
        browserModelBanner,
      }
      if (!browserModelBanner || !rendered.modes?.bracketedPasteMode) return null
      return { streamId: paneStreamId }
    }, 120_000)

    // The host epoch is distinct from the supervisor's stable launch ID. Read
    // it once after the browser reports the changed stream, so the QA probe
    // does not compete with the server's live output poll.
    const output = dataOf(await rig.runtime.adminOk(
      rig.supervisor,
      rig.runtime.terminalReadOutputBody(view.soulId, 0, 256 * 1024, await rig.controlEpoch()),
    ), 'terminal_output')
    const sourceText = (output.frames ?? []).map((frame) => {
      if (frame.streamEpoch !== output.streamEpoch || frame.terminalId !== terminalId) {
        throw new Error('replacement prompt frame has mismatched ownership')
      }
      return frame.data
    }).join('').slice(-512 * 1024)
    const sourceReady = openCodeTerminalReady(sourceText, modelTexts)
    diagnostic = {
      ...diagnostic,
      sourceIncarnationId: output.incarnationId,
      sourceStreamEpoch: output.streamEpoch,
      sourceTerminalId: output.terminalId,
      sourceExited: output.exited,
      sourceReady,
      sourceCursor: output.headSeq,
    }
    if (
      output.incarnationId !== view.incarnationId
      || output.terminalId !== terminalId
      || output.streamEpoch !== browserReady.streamId
      || output.exited
      || !sourceReady
    ) {
      throw new Error('replacement provider source and browser stream identities did not agree')
    }
    rig.runtime.assert('PC-OPENCODE', true, 'replacement TUI prompt is source-observed and rendered before input', {
      soulId: view.soulId,
      incarnationId: view.incarnationId,
      terminalId,
      streamEpoch: output.streamEpoch,
      cursor: output.headSeq,
    })
  } catch (error) {
    // Keep identity/readiness facts, never conversation text, in failure receipts.
    rig.runtime.writeBrowserArtifact('opencode-replacement-readiness', {
      ...diagnostic,
      observedStreamChanges: observedStreamChanges.slice(-10),
      observedWebSocketFrameTypes: [...observedWebSocketFrameTypes].sort(),
      observedWebSocketCount: observedWebSocketCount.value,
    })
    throw error
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

function nativeAssistantTurns(rig: ManagedRuntimeBrowserRig, view: ManagedRuntimeView, sessionId: string): NativeAssistantTurn[] {
  if (!view.containerId) throw new Error('native evidence probe has no exact owned container')
  const raw = rig.ownedProviderExec(view.containerId, [
    'node', '--no-warnings', '-e', OPENCODE_NATIVE_HISTORY_SCRIPT,
    '/home/freshell/provider/.local/share/opencode/opencode.db', sessionId,
  ])
  const evidence = JSON.parse(raw)
  expect(evidence.schemaVersion).toBe(1)
  expect(evidence.nativeSessionId).toBe(sessionId)
  return evidence.turns
}

async function nextNativeAssistantTurn(
  page: Page,
  terminalId: string,
  rig: ManagedRuntimeBrowserRig, view: ManagedRuntimeView, sessionId: string,
  priorMessageIds: ReadonlySet<string>, expectedText: string,
): Promise<NativeAssistantTurn> {
  return waitForValue('the correlated completed native assistant response, not a rendered echo', () => (
    selectNativeAssistantTurn(nativeAssistantTurns(rig, view, sessionId), priorMessageIds, expectedText)
  ), 180_000, async () => {
    const terminalOutput = await page.evaluate((id) => (
      window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer?.(id) ?? ''
    ), terminalId)
    const failure = openCodeCredentialFailureMessage(terminalOutput)
    return failure ? new Error(failure) : undefined
  })
}

function verifyMemoryAnswer(turn: NativeAssistantTurn, projectName: string): void {
  expect(turn.toolCalls, 'conversation recall must not consult workspace files or tools').toEqual([])
  expect(`${turn.resolvedProvider}/${turn.resolvedModel}`).toBe(P2_OPENCODE_MODEL)
  expect(turn.text).toContain(projectName)
}

function cgroupLimitEvidence(rig: ManagedRuntimeBrowserRig, view: ManagedRuntimeView): ProviderQualificationRow['limitEvidence'] {
  if (!view.containerId) throw new Error('OpenCode view has no container for limit evidence')
  const expected = (view as any).effectiveLimits
  if (!expected) throw new Error('OpenCode view has no effective limits')
  const raw = rig.ownedContainerExec(view.containerId, [
    'sh', '-lc',
    `printf '{"cpuMax":"%s","memoryMax":"%s","swapMax":"%s","pidsMax":"%s"}' "$(cat /sys/fs/cgroup/cpu.max)" "$(cat /sys/fs/cgroup/memory.max)" "$(cat /sys/fs/cgroup/memory.swap.max)" "$(cat /sys/fs/cgroup/pids.max)"`,
  ])
  const actual = JSON.parse(raw)
  const [quotaRaw, periodRaw] = String(actual.cpuMax).trim().split(/\s+/)
  const cpuMilli = quotaRaw === 'max'
    ? Number.POSITIVE_INFINITY
    : Math.round((Number(quotaRaw) / Number(periodRaw)) * 1_000)
  expect(cpuMilli).toBe(expected.cpuMilli)
  expect(Number(actual.memoryMax)).toBe(expected.memoryBytes)
  expect(Number(actual.swapMax)).toBe(expected.swapBytes)
  expect(Number(actual.pidsMax)).toBe(expected.pidsMax)
  return actual
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
  test('release-enabled OpenCode proves exact native recovery, isolation, and cleanup', async ({ page }) => {
    test.skip(
      process.env.FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE !== '1',
      'set FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE=1 for the candidate-bound provider receipt',
    )
    test.setTimeout(1_800_000)

    const onecli = requireOpenCodeOnecliBootstrap(process.env, 'OpenCode provider qualification')
    const blockerEvidence = runBlockerMatrixTests(process.cwd())
    const rig = new ManagedRuntimeBrowserRig(
      process.cwd(),
      5,
      {
        FRESHELL_BIND_HOST: '0.0.0.0',
        FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: onecli.authFile,
        FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: onecli.environmentFile,
        FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: onecli.caFile,
      },
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

      let qualifiedTerminalId: string | undefined
      const observedStreamChanges: Array<{
        terminalId: string
        streamId: string
        reason: string
        attachRequestId: string | null
      }> = []
      const observedWebSocketFrameTypes = new Set<string>()
      const observedWebSocketCount = { value: 0 }
      page.on('websocket', (socket) => {
        if (new URL(socket.url()).pathname !== '/ws') return
        observedWebSocketCount.value += 1
        socket.on('framereceived', (payload) => {
          try {
            const message = JSON.parse(String(payload)) as Record<string, unknown>
            if (typeof message.type === 'string') observedWebSocketFrameTypes.add(message.type)
            if (
              message.type === 'terminal.stream.changed'
              && message.terminalId === qualifiedTerminalId
              && typeof message.streamId === 'string'
              && typeof message.reason === 'string'
            ) {
              observedStreamChanges.push({
                terminalId: message.terminalId,
                streamId: message.streamId,
                reason: message.reason,
                attachRequestId: typeof message.attachRequestId === 'string' ? message.attachRequestId : null,
              })
            }
          } catch {
            // Ignore unrelated or non-JSON WebSocket frames.
          }
        })
      })
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
      qualifiedTerminalId = first.terminalId
      if (!first.view.containerId || !first.view.hostBootId) {
        throw new Error('first OpenCode view lacks exact runtime identity')
      }
      expect(rig.ownedContainerExec(first.view.containerId, ['opencode', '--version']).trim())
        .toBe(P2_OPENCODE_VERSION)
      const processArgs = rig.ownedContainerProcessTable(first.view.containerId)
      expect(processArgs).toContain(P2_OPENCODE_MODEL)
      const authProbe = rig.ownedProviderExec(first.view.containerId, [
        'node', '--no-warnings', '-e',
        "const fs=require('node:fs');const auth=JSON.parse(fs.readFileSync('/home/freshell/provider/.local/share/opencode/auth.json','utf8'));const openai=auth.openai;if(!openai||openai.type!=='oauth'||openai.access!=='onecli-managed'||openai.refresh!=='onecli-managed'||openai.expires<Date.now()+3600000)process.exit(2);fs.accessSync('/home/freshell/provider/.config/onecli/gateway-ca.pem',fs.constants.R_OK);process.stdout.write('OneCLI OpenAI stub and CA present')",
      ])
      expect(authProbe.trim()).toBe('OneCLI OpenAI stub and CA present')
      const availableModels = rig.ownedProviderExec(first.view.containerId, ['opencode', 'models', 'openai'])
      expect(availableModels).toContain(P2_OPENCODE_MODEL.split('/')[1])
      const exactLimits = cgroupLimitEvidence(rig, first.view)
      expect(exactLimits.swapMax).toBe('0')

      // A plain conversation task avoids synthetic marker-assembly prompts.
      // Proof comes from NEW provider-native assistant rows, never echoed input
      // or a redraw of old terminal history. The project name has 128 bits.
      const nonce = `p-${randomBytes(16).toString('base64url')}`
      // Keep this unambiguously conversational: asking for a project name can
      // make a coding model search the workspace instead of answering from its
      // current turn, leaving native history open until the qualification times out.
      await executeInPane(
        page, first.paneId,
        `Remember this exact string for our conversation: ${nonce}. Reply with only the string. Do not search files or call tools.`,
      )
      const nativeSessionId = await waitForValue('first exact OpenCode session id', async () => (
        await paneSessionId(harness, tabId, first.paneId)
      ), 120_000)
      expect(nativeSessionId).toMatch(/^ses_/)
      const firstAnswer = await nextNativeAssistantTurn(page, first.terminalId, rig, first.view, nativeSessionId, new Set(), nonce)
      verifyMemoryAnswer(firstAnswer, nonce)
      const nativeTurnProofs = [nativeTurnProof('initial', nativeSessionId, firstAnswer, nonce)]

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
      await waitForReplacementPrompt(
        page, harness, rig, tabId, first.paneId, afterHostCrash,
        observedStreamChanges, observedWebSocketFrameTypes, observedWebSocketCount,
      )
      const beforeRecall = new Set(nativeAssistantTurns(rig, afterHostCrash, nativeSessionId).map((turn) => turn.messageId))
      await executeInPane(page, first.paneId,
        'What exact string did I ask you to remember? Reply with only the string. Do not search files or call tools.')
      const recalledAnswer = await nextNativeAssistantTurn(page, first.terminalId, rig, afterHostCrash, nativeSessionId, beforeRecall, nonce)
      verifyMemoryAnswer(recalledAnswer, nonce)
      expect(recalledAnswer.messageId).not.toBe(firstAnswer.messageId)
      nativeTurnProofs.push(nativeTurnProof('after_session_host_crash', nativeSessionId, recalledAnswer, nonce))
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
      await waitForReplacementPrompt(
        page, harness, rig, tabId, first.paneId, afterProviderCrash,
        observedStreamChanges, observedWebSocketFrameTypes, observedWebSocketCount,
      )
      const beforeProviderFollowup = new Set(nativeAssistantTurns(rig, afterProviderCrash, nativeSessionId).map((turn) => turn.messageId))
      await executeInPane(page, first.paneId,
        'What exact string did I ask you to remember? Reply with only the string. Do not search files or call tools.')
      const providerAnswer = await nextNativeAssistantTurn(page, first.terminalId, rig, afterProviderCrash, nativeSessionId, beforeProviderFollowup, nonce)
      verifyMemoryAnswer(providerAnswer, nonce)
      expect(providerAnswer.messageId).not.toBe(recalledAnswer.messageId)
      nativeTurnProofs.push(nativeTurnProof('after_provider_process_crash', nativeSessionId, providerAnswer, nonce))
      const providerFollowUpCompleted = true

      // A second OpenCode soul is independently owned, while an explicit
      // second view of the first soul does not mint another writer.
      const prior = new Set(leavesByMode(await harness.getPaneLayout(tabId), 'opencode').map((leaf) => leaf.id))
      const second = await createOpencodePane(page, harness, terminal, rig, tabId, prior)
      if (!second.view.containerId) throw new Error('second OpenCode view lacks container')
      const secondNonce = `p-${randomBytes(16).toString('base64url')}`
      await executeInPane(page, second.paneId,
        `Remember this exact string for our conversation: ${secondNonce}. Reply with only the string. Do not search files or call tools.`)
      const secondSessionId = await waitForValue('second exact OpenCode session id', async () => (
        await paneSessionId(harness, tabId, second.paneId)
      ), 120_000)
      const secondAnswer = await nextNativeAssistantTurn(page, second.terminalId, rig, second.view, secondSessionId, new Set(), secondNonce)
      verifyMemoryAnswer(secondAnswer, secondNonce)
      expect(secondAnswer.text).not.toContain(nonce)
      expect(second.view.soulId).not.toBe(first.view.soulId)
      expect(second.view.containerId).not.toBe(afterProviderCrash.containerId)
      expect(secondSessionId).not.toBe(nativeSessionId)
      expect(cgroupLimitEvidence(rig, second.view).swapMax).toBe('0')

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
      const writerClaim = await rig.qualificationWriterClaim({
        provider: 'opencode',
        nativeSessionId,
        soulId: first.view.soulId,
        incarnationId: afterProviderCrash.incarnationId,
      })
      expect(writerClaim.activeClaimCount).toBe(1)
      expect(writerClaim.globalConflictingClaimCount).toBe(0)

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
      const claimAfterStop = await rig.qualificationWriterClaim({
        provider: 'opencode',
        nativeSessionId,
        soulId: first.view.soulId,
        incarnationId: afterProviderCrash.incarnationId,
      })
      expect(claimAfterStop.activeClaimCount).toBe(0)
      expect(claimAfterStop.globalConflictingClaimCount).toBe(0)
      const oldContainerRunningAfterStop = rig.runtime.isContainerRunning(afterProviderCrash.containerId!)
      expect(oldContainerRunningAfterStop).toBe(false)
      expect(rig.runtime.broker.unsafeAttempts()).toHaveLength(0)

      providerRow = {
        provider: 'opencode',
        modes: ['opencode'],
        actualProviderBinary: true,
        providerVersion: P2_OPENCODE_VERSION,
        model: P2_OPENCODE_MODEL,
        reasoningEffort: 'provider-default',
        completedTurn: true,
        nonceSha256: createHash('sha256').update(nonce).digest('hex'),
        nativeTurnProofs,
        nativeStateCaptured: true,
        nativeSessionId,
        runtimeOwned: true,
        limitsVerified: true,
        swapMaxVerified: exactLimits.swapMax === '0',
        limitEvidence: exactLimits,
        nonceRecovery: {
          sameSoul: afterHostCrash.soulId === first.view.soulId,
          sameNativeSession: afterHostCrash.nativeSessionId === nativeSessionId,
          newIncarnation: afterHostCrash.incarnationId !== first.view.incarnationId,
          oldEnclosureVerifiedEmpty: !rig.runtime.isContainerRunning(first.view.containerId),
          recalledNonce,
          followUpCompleted: providerFollowUpCompleted,
          workspaceOrToolReadUsed: nativeTurnProofs.some((proof) => proof.toolCallCount > 0),
        },
        crashKinds: ['session_host', 'provider_process'],
        automaticResume: true,
        onlyOneWriter: firstRunning.length === 1,
        writerClaim,
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
        verifiedEmptyOrdering: {
          stopOutcome: firstStop.outcome,
          activeClaimCountAfterStop: claimAfterStop.activeClaimCount,
          globalConflictingClaimCountAfterStop: claimAfterStop.globalConflictingClaimCount,
          oldContainerRunningAfterStop,
        },
        followUpCompleted: providerFollowUpCompleted,
        releaseBinary: rig.supervisor.binaryKind === 'release',
      }
      expect((providerRow.nonceRecovery as { recalledNonce: boolean }).recalledNonce).toBe(true)
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
