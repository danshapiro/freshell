/**
 * Phase 2 Durable Souls browser gate.
 *
 * Uses a real Chromium page, a feature-enabled real Rust web server, the real
 * supervisor over its authenticated UDS, Docker, and the real session-host PTY.
 * Web restart methods own only the web PID; the managed runtime is a separate
 * Docker enclosure and is verified by supervisor inventory + exact broker receipt.
 */
import { expect } from '@playwright/test'

import { test } from '../helpers/fixtures.js'
import fs from 'node:fs'
import path from 'node:path'

import { ManagedRuntimeBrowserRig, P2_OPENCODE_MODEL, P2_OPENCODE_VERSION, type ManagedRuntimeView } from '../helpers/managed-runtime.js'
import { requireOpenCodeOnecliBootstrap } from '../helpers/opencode-auth-file.js'
import { OPENCODE_NATIVE_HISTORY_SCRIPT, type NativeHistory, waitForOpenCodeTerminalCondition } from '../helpers/opencode-native-history.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { openPanePicker } from '../helpers/pane-picker.js'

function findTerminalLeaves(node: any, out: any[] = []): any[] {
  if (!node) return out
  if (node.type === 'leaf' && node.content?.kind === 'terminal') out.push(node)
  if (node.type === 'split') for (const child of node.children ?? []) findTerminalLeaves(child, out)
  return out
}

async function ensureShell(page: import('@playwright/test').Page, terminal: TerminalHelper): Promise<void> {
  if (await page.locator('.xterm').first().isVisible().catch(() => false)) return
  for (const name of ['Shell', 'Bash', 'WSL', 'CMD', 'PowerShell']) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first()
    if (await button.isVisible().catch(() => false)) {
      await button.click()
      await terminal.waitForTerminal(0, 30_000)
      return
    }
  }
  throw new Error('managed runtime browser gate could not select a shell from the real pane picker')
}

type TerminalIdentity = {
  tabId: string
  terminalId: string
  createRequestId: string
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

async function readTerminalIdentity(harness: TestHarness): Promise<TerminalIdentity | null> {
  const tabId = await harness.getActiveTabId()
  if (!tabId) return null
  const leaves = findTerminalLeaves(await harness.getPaneLayout(tabId))
  if (leaves.length !== 1) return null
  const { terminalId, createRequestId } = leaves[0].content
  if (typeof terminalId !== 'string' || typeof createRequestId !== 'string') return null
  return { tabId, terminalId, createRequestId }
}

function waitForTerminalIdentity(harness: TestHarness, timeoutMs: number): Promise<TerminalIdentity> {
  return waitForValue('one anchored terminal identity', () => readTerminalIdentity(harness), timeoutMs)
}

function waitForRunningView(
  rig: ManagedRuntimeBrowserRig,
  terminalId: string,
  timeoutMs: number,
): Promise<ManagedRuntimeView> {
  return waitForValue(`running managed view for terminal ${terminalId}`, () => rig.runningViewForTerminal(terminalId), timeoutMs)
}

function leavesByMode(node: any, mode: string): any[] {
  if (!node) return []
  if (node.type === 'leaf') return node.content?.mode === mode ? [node] : []
  if (node.type === 'split') return (node.children ?? []).flatMap((child: any) => leavesByMode(child, mode))
  return []
}

async function waitForOwnedProcess(
  rig: ManagedRuntimeBrowserRig,
  containerId: string,
  pattern: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = rig.ownedContainerProcessTable(containerId)
    if (last.split(/\r?\n/).some((line) => line.includes(pattern))) return last
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`timed out waiting for owned process ${pattern}; last=${last}`)
}

function waitForOwnedPidFile(
  rig: ManagedRuntimeBrowserRig,
  containerId: string,
  filePath: string,
  timeoutMs: number,
): Promise<number> {
  return waitForValue(`numeric PID in ${filePath}`, () => {
    const raw = rig.ownedProviderExec(containerId, ['sh', '-lc', `cat ${JSON.stringify(filePath)} 2>/dev/null || true`]).trim()
    if (!/^\d+$/.test(raw)) return null
    const pid = Number(raw)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  }, timeoutMs)
}

function waitForOwnedFileValue(
  rig: ManagedRuntimeBrowserRig,
  containerId: string,
  filePath: string,
  expected: string,
  timeoutMs: number,
): Promise<string> {
  return waitForValue(`${expected} in ${filePath}`, () => {
    const actual = rig.ownedProviderExec(containerId, [
      'sh',
      '-lc',
      `cat ${JSON.stringify(filePath)} 2>/dev/null || true`,
    ]).trim()
    return actual === expected ? actual : null
  }, timeoutMs)
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

function waitForSessionId(content: () => Promise<any>, timeoutMs: number): Promise<string> {
  return waitForValue('native provider session id', async () => {
    const sessionId = (await content())?.sessionRef?.sessionId
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
  }, timeoutMs)
}

test.describe.serial('Phase 2 managed runtime continuity', () => {
  test('P2-G01: real browser shell survives ten graceful/abrupt web replacements', async ({ page }) => {
    test.setTimeout(1_800_000)

    const wsEvents: Array<Record<string, unknown>> = []
    const recordWsEvent = (event: Record<string, unknown>) => {
      wsEvents.push({ at: Date.now(), ...event })
      if (wsEvents.length > 200) wsEvents.shift()
    }
    page.on('websocket', (socket) => {
      recordWsEvent({ event: 'open', url: socket.url() })
      socket.on('close', () => recordWsEvent({ event: 'close' }))
      for (const event of ['framesent', 'framereceived'] as const) {
        socket.on(event, (frame) => {
          try {
            const message = JSON.parse(String(frame.payload))
            recordWsEvent({ event, type: message.type, terminalId: message.terminalId, code: message.code })
          } catch {
            recordWsEvent({ event, type: 'non-json' })
          }
        })
      }
    })

    const rig = new ManagedRuntimeBrowserRig()
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 90_000 })

      const initialPane = await waitForTerminalIdentity(harness, 90_000)
      const initialView = await waitForRunningView(rig, initialPane.terminalId, 90_000)
      if (!initialView?.containerId || !initialView.hostBootId) throw new Error('managed runtime view missing container/host identity')

      // Two long-lived descendants: one heartbeat producer proves output is
      // continuously drained while web disappears; one plain sleep gives a
      // stable child PID to assert across every replacement.
      await terminal.executeCommandInserted(
        `(i=0; while true; do echo P2_HEARTBEAT:$i; i=$((i+1)); sleep 1; done) & echo P2_HEARTBEAT_PID=$!; sleep 3600 & child=$!; echo "$child" > "$HOME/p2-child-pid"; echo P2_CHILD_READY`,
      )
      await terminal.waitForOutput('P2_CHILD_READY', { timeout: 20_000, terminalId: initialPane.terminalId })
      const childPid = await waitForOwnedPidFile(
        rig,
        initialView.containerId,
        '/home/freshell/provider/p2-child-pid',
        20_000,
      )
      expect(rig.ownedContainerHasPid(initialView.containerId, childPid)).toBe(true)
      const seeded = await terminal.getVisibleText(initialPane.terminalId)
      const originalIdentity = {
        soulId: initialView.soulId,
        incarnationId: initialView.incarnationId,
        containerId: initialView.containerId,
        hostBootId: initialView.hostBootId,
        childPid,
      }
      const receiptCount = rig.runtime.broker.receipts().length
      let outputAdvanced = false
      let lastHeartbeat = Number(seeded.match(/P2_HEARTBEAT:(\d+)/g)?.at(-1)?.split(':')[1] ?? -1)

      for (let cycle = 1; cycle <= 10; cycle += 1) {
        const previousLastReadyAt = await harness.getLastReadyAt()
        if (cycle % 2 === 1) await rig.restartWebGracefully()
        else await rig.crashAndRestartWeb()

        await harness.waitForConnectionAfter(previousLastReadyAt, 90_000)
        const pane = await waitForTerminalIdentity(harness, 60_000)
        expect(pane.createRequestId).toBe(initialPane.createRequestId)
        // Managed IDs are deterministic from createRequestId; this also proves
        // the restarted web server did not mint a conflicting runtime payload.
        expect(pane.terminalId).toBe(initialPane.terminalId)

        const view = await waitForRunningView(rig, pane.terminalId, 60_000)
        expect(view?.soulId).toBe(originalIdentity.soulId)
        expect(view?.incarnationId).toBe(originalIdentity.incarnationId)
        expect(view?.containerId).toBe(originalIdentity.containerId)
        expect(view?.hostBootId).toBe(originalIdentity.hostBootId)
        expect(rig.runtime.broker.receipts()).toHaveLength(receiptCount)
        expect(rig.ownedContainerHasPid(originalIdentity.containerId, childPid)).toBe(true)

        const failWithDiagnostics = async (error: unknown): Promise<never> => {
          const connection = await page.evaluate(() => ({
            ws: window.__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
            redux: window.__FRESHELL_TEST_HARNESS__?.getState()?.connection,
            managedRuntime: window.__FRESHELL_TEST_HARNESS__?.getState()?.managedRuntime,
          })).catch(() => null)
          const webProcess = (() => {
            try { return rig.web.processEvidence() } catch { return null }
          })()
          const output = rig.web.capturedOutput()
          const terminalText = await terminal.getVisibleText(pane.terminalId).catch(() => '')
          throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify({
            cycle, lastHeartbeat, connection, webProcess,
            paneContent: findTerminalLeaves(await harness.getPaneLayout(pane.tabId))[0]?.content,
            wsEvents: wsEvents.slice(-100),
            terminalTail: terminalText.slice(-800),
            ownedProcesses: rig.ownedContainerProcessTable(originalIdentity.containerId).slice(-1200),
            hostLogsTail: rig.runtime.containerLogs(originalIdentity.containerId).slice(-1200),
            webStdoutTail: output.stdout.slice(-1500),
            webStderrTail: output.stderr.slice(-1500),
          })}`)
        }

        let heartbeat: number
        try {
          heartbeat = await waitForValue(`heartbeat advance after web cycle ${cycle}`, async () => {
            const text = await terminal.getVisibleText(pane.terminalId)
            const value = Number(text.match(/P2_HEARTBEAT:(\d+)/g)?.at(-1)?.split(':')[1] ?? -1)
            return value > lastHeartbeat ? value : null
          }, 60_000)
        } catch (error) {
          await failWithDiagnostics(error)
        }
        outputAdvanced = true
        lastHeartbeat = heartbeat

        const marker = `P2_WEB_CYCLE_${cycle}_${Date.now()}`
        const markerPath = `/home/freshell/provider/p2-web-cycle-${cycle}`
        await terminal.executeCommandInserted(
          `printf '%s\n' ${JSON.stringify(marker)} > "$HOME/p2-web-cycle-${cycle}"`,
        )
        try {
          await waitForOwnedFileValue(rig, originalIdentity.containerId, markerPath, marker, 30_000)
        } catch (error) {
          await failWithDiagnostics(error)
        }

        expect(await harness.getTabCount()).toBe(1)
        expect(findTerminalLeaves(await harness.getPaneLayout(pane.tabId))).toHaveLength(1)
      }

      expect(outputAdvanced).toBe(true)
      const receipt = {
        caseId: 'P2-G01',
        status: 'PASS',
        restartCycles: 10,
        ...originalIdentity,
        outputAdvanced: true,
        inputUsable: true,
        viewAssociations: 1,
        createRequestId: initialPane.createRequestId,
        terminalId: initialPane.terminalId,
        candidateSha: rig.runtime.candidateSha,
        runtimeImage: rig.runtime.imageRef,
      }
      const receiptPath = rig.writeBrowserReceipt(receipt)
      // eslint-disable-next-line no-console
      console.log(`[P2-G01] browser continuity receipt: ${receiptPath}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

  test('P2-G04: OpenAI-authenticated OpenCode tool turn survives web replacement in one native session', async ({ page }) => {
    test.setTimeout(900_000)

    // The rig runs the web server with an isolated HOME. Pass the native
    // OpenCode OAuth stub, OneCLI proxy settings, and gateway CA as typed
    // grants so the provider uses the dedicated OneCLI gateway.
    const onecli = requireOpenCodeOnecliBootstrap()
    const rig = new ManagedRuntimeBrowserRig(process.cwd(), 2, {
      FRESHELL_BIND_HOST: '0.0.0.0',
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: onecli.authFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: onecli.environmentFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: onecli.caFile,
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
      if (!tabId) throw new Error('P2-G04 has no active tab')

      const before = new Set(leavesByMode(await harness.getPaneLayout(tabId), 'opencode').map((leaf) => leaf.id))
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
      const dirInput = page.getByRole('combobox', { name: /Starting directory for OpenCode/i })
      await expect(dirInput).toBeVisible({ timeout: 15_000 })
      await dirInput.fill(rig.repoRoot)
      await dirInput.press('Enter')

      const opencodeLeaf = await waitForModeLeaf(
        harness,
        tabId,
        'opencode',
        (candidate) => !before.has(candidate.id),
        90_000,
      )
      const paneId: string = opencodeLeaf.id
      const terminalId: string = opencodeLeaf.content.terminalId
      const content = async () => {
        const leaves = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
        return leaves.find((leaf) => leaf.id === paneId)?.content
      }
      const view = await waitForRunningView(rig, terminalId, 90_000)
      if (!view?.containerId || !view.hostBootId) throw new Error('real OpenCode managed view missing ownership identity')
      expect(rig.ownedContainerExec(view.containerId, ['opencode', '--version']).trim()).toBe(P2_OPENCODE_VERSION)
      const authProbe = rig.ownedProviderExec(view.containerId, [
        'node', '--no-warnings', '-e',
        "const fs=require('node:fs');const auth=JSON.parse(fs.readFileSync('/home/freshell/provider/.local/share/opencode/auth.json','utf8'));const openai=auth.openai;if(!openai||openai.type!=='oauth'||openai.access!=='onecli-managed'||openai.refresh!=='onecli-managed'||openai.expires<Date.now()+3600000)process.exit(2);fs.accessSync('/home/freshell/provider/.config/onecli/gateway-ca.pem',fs.constants.R_OK);process.stdout.write('onecli managed OpenAI stub and CA present')",
      ])
      expect(authProbe.trim()).toBe('onecli managed OpenAI stub and CA present')
      const availableModels = rig.ownedProviderExec(view.containerId, ['opencode', 'models', 'openai'])
      expect(availableModels).toContain(P2_OPENCODE_MODEL.split('/')[1])
      const processArgs = rig.ownedContainerExec(view.containerId, ['sh', '-lc', "pgrep -af '[o]pencode' || true"])
      expect(processArgs).toContain(`--model ${P2_OPENCODE_MODEL}`)
      expect(processArgs).toContain('--hostname 127.0.0.1')
      expect(processArgs).toContain('--port 4096')

      const opencodeIndex = Math.max(0, (await page.locator('.xterm').count()) - 1)
      await waitForOpenCodeTerminalCondition({
        readTerminalText: () => terminal.getVisibleText(terminalId),
        wait: (milliseconds) => page.waitForTimeout(milliseconds),
        description: 'the OpenCode prompt',
        succeeds: (text) => text.includes('Ask anything...'),
        timeoutMs: 90_000,
      })
      const firstTurnMarker = 'P2_OPENCODE_FIRST_TURN_DONE'
      await terminal.executeCommandInserted(
        'Use the bash tool to run exactly: echo P2_OPENCODE_FIRST_TURN_DONE > "$HOME/p2-opencode-first-turn". Reply with exactly READY when the command completes.',
        opencodeIndex,
      )
      await waitForOpenCodeTerminalCondition({
        readTerminalText: () => terminal.getVisibleText(terminalId),
        wait: (milliseconds) => page.waitForTimeout(milliseconds),
        description: `OpenCode tool marker ${firstTurnMarker}`,
        succeeds: () => rig.ownedProviderExec(view.containerId!, [
            'sh', '-lc', 'cat /home/freshell/provider/p2-opencode-first-turn 2>/dev/null || true',
          ]).trim() === firstTurnMarker,
        timeoutMs: 90_000,
      })

      const sessionId = await waitForSessionId(content, 90_000)
      expect(sessionId).toMatch(/^ses_/)
      const firstTurn = await waitForValue('native OpenCode first reply', () => {
        const nativeHistory = JSON.parse(rig.ownedProviderExec(view.containerId!, [
          'node', '--no-warnings', '-e', OPENCODE_NATIVE_HISTORY_SCRIPT,
          '/home/freshell/provider/.local/share/opencode/opencode.db', sessionId,
        ])) as NativeHistory
        if (nativeHistory.nativeSessionId !== sessionId) return null
        return nativeHistory.turns.find((turn) => turn.text.includes('READY')) ?? null
      }, 30_000)
      expect(`${firstTurn.resolvedProvider}/${firstTurn.resolvedModel}`).toBe(P2_OPENCODE_MODEL)

      await new Promise((resolve) => setTimeout(resolve, 1_000))
      await terminal.executeCommandInserted(
        'Use the bash tool to run exactly: sleep 12; echo P2_OPENCODE_TOOL_DONE >> "$HOME/p2-opencode-tool-count". Do not finish your response until that command completes.',
        opencodeIndex,
      )
      await waitForOwnedProcess(rig, view.containerId, 'sleep 12', 60_000)

      const previousLastReadyAt = await harness.getLastReadyAt()
      await rig.crashAndRestartWeb()
      await harness.waitForConnectionAfter(previousLastReadyAt, 90_000)
      const afterLeaf = await waitForModeLeaf(
        harness,
        tabId,
        'opencode',
        (leaf) => leaf.id === paneId,
        60_000,
      )
      expect(afterLeaf.content.terminalId).toBe(terminalId)
      await expect.poll(async () => (await content())?.sessionRef?.sessionId ?? null, { timeout: 60_000 }).toBe(sessionId)
      const afterView = await waitForRunningView(rig, terminalId, 60_000)
      expect(afterView?.soulId).toBe(view.soulId)
      expect(afterView?.incarnationId).toBe(view.incarnationId)
      expect(afterView?.containerId).toBe(view.containerId)
      expect(afterView?.hostBootId).toBe(view.hostBootId)

      await expect.poll(() => {
        const count = rig.ownedProviderExec(view.containerId!, ['sh', '-lc', 'test -f /home/freshell/provider/p2-opencode-tool-count && wc -l < /home/freshell/provider/p2-opencode-tool-count || echo 0'])
        return Number(count.trim())
      }, { timeout: 60_000 }).toBe(1)

      const afterIndex = Math.max(0, (await page.locator('.xterm').count()) - 1)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      await terminal.executeCommandInserted(
        'Use the bash tool to run exactly: echo P2_OPENCODE_FOLLOWUP_DONE > "$HOME/p2-opencode-followup". Reply with exactly FOLLOWUP when the command completes.',
        afterIndex,
      )
      await expect.poll(() => {
        return rig.ownedProviderExec(view.containerId!, ['sh', '-lc', 'cat /home/freshell/provider/p2-opencode-followup 2>/dev/null || true']).trim()
      }, { timeout: 90_000 }).toBe('P2_OPENCODE_FOLLOWUP_DONE')
      const runtimeDir = rig.runtime.runtimeDir(rig.supervisor, view.incarnationId)
      const hostState = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'host-state.json'), 'utf8'))
      expect(hostState.workerLaunchCount).toBe(1)
      expect((await content())?.sessionRef?.sessionId).toBe(sessionId)

      const receipt = {
        caseId: 'P2-G04',
        status: 'PASS',
        provider: 'opencode',
        modelProvider: firstTurn.resolvedProvider,
        opencodeVersion: P2_OPENCODE_VERSION,
        model: `${firstTurn.resolvedProvider}/${firstTurn.resolvedModel}`,
        resolvedModel: firstTurn.resolvedModel,
        freeTier: false,
        nativeSessionId: sessionId,
        sameNativeSession: true,
        sameIncarnation: true,
        soulId: view.soulId,
        incarnationId: view.incarnationId,
        containerId: view.containerId,
        hostBootId: view.hostBootId,
        toolCompletionCount: 1,
        followupSucceeded: true,
        providerLaunchCount: hostState.workerLaunchCount,
        candidateSha: rig.runtime.candidateSha,
        runtimeImage: rig.runtime.imageRef,
      }
      const receiptPath = rig.writeOpencodeReceipt(receipt)
      // eslint-disable-next-line no-console
      console.log(`[P2-G04] real OpenCode continuity receipt: ${receiptPath}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

  test('synthetic interrupted ordinary Stop preserves history', async ({ page }) => {
    test.skip(process.env.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1', 'requires the explicit synthetic runtime lane')
    test.setTimeout(900_000)
    const supervisorEnv = {
      FRESHELL_RUNTIME_HOST_COMMAND_TIMEOUT_MS: '5000',
      FRESHELL_RUNTIME_FRESH_AGENT_COMMAND_TIMEOUT_MS: '10000',
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '60000',
    }
    const rig = new ManagedRuntimeBrowserRig(process.cwd(), 3, {}, supervisorEnv, 'test', {
      enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'],
      providerSettings: { freshcodex: {} },
    })
    const sent: any[] = []
    const received: any[] = []
    page.on('websocket', (socket) => {
      socket.on('framesent', (frame) => { sent.push(JSON.parse(String(frame.payload))) })
      socket.on('framereceived', (frame) => { received.push(JSON.parse(String(frame.payload))) })
    })
    try {
      const info = await rig.start()
      const settings = await fetch(`${info.baseUrl}/api/settings`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
        body: JSON.stringify({ codingCli: { enabledProviders: ['codex'] } }),
      })
      expect(settings.ok).toBe(true)
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await page.getByRole('button', { name: 'Freshcodex', exact: true }).click()
      await page.getByRole('option', { name: rig.repoRoot, exact: true }).click()
      const created = await waitForValue('registered synthetic pane', async () => {
        const state = await harness.getState()
        const tabId = state.tabs.activeTabId!
        const leaf = state.panes.layouts[tabId]
        return leaf?.type === 'leaf' && leaf.content.kind === 'fresh-agent' && leaf.content.sessionId
          ? { tabId, paneId: leaf.id, sessionId: leaf.content.sessionId } : null
      }, 60_000)
      const view = await waitForValue('synthetic managed native root', async () => {
        const current = await rig.runningViewForFreshSession(created.sessionId)
        return current?.containerId && current.nativeSessionId ? current : null
      }, 90_000)
      const nativeId = view.nativeSessionId!
      const transcript = [
        { type: 'session_meta', payload: { id: nativeId, cwd: '/workspace', model_provider: 'openai' } },
        ...[0, 1, 2].flatMap((index) => [
          { type: 'event_msg', payload: { type: 'task_started', turn_id: `stop-retained-${index}` } },
          { type: 'event_msg', payload: { type: 'user_message', message: `Synthetic saved prompt ${index}` } },
          { type: 'event_msg', payload: { type: 'task_complete', turn_id: `stop-retained-${index}`,
            last_agent_message: `Synthetic saved answer ${index}` } },
        ]),
      ].map((row) => JSON.stringify(row)).join('\n') + '\n'
      await rig.ownedProviderExec(view.containerId!, ['node', '--input-type=module', '-e',
        'import fs from "node:fs"; import path from "node:path"; fs.mkdirSync(path.dirname(process.argv[1]), {recursive:true}); fs.writeFileSync(process.argv[1],process.argv[2]);',
        `/home/freshell/provider/.codex/sessions/2026/03/01/rollout-${nativeId}.jsonl`, transcript])
      const history = async () => {
        const response = await fetch(`${info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${nativeId}`, {
          headers: { 'x-auth-token': info.token },
        })
        expect(response.ok).toBe(true)
        return response.json()
      }
      const retained = await history()
      expect(retained.threadId).toBe(nativeId)
      expect(retained.turns).toHaveLength(6)
      expect(retained.turns.flatMap((turn: any) => turn.items).map((item: any) => item.text))
        .toEqual([0, 1, 2].flatMap((index) => [`Synthetic saved prompt ${index}`, `Synthetic saved answer ${index}`]))

      // Arm only the test supervisor. Its durable registry, secret, native
      // store and existing provider remain the exact registered originals.
      const previous = rig.supervisor
      await rig.runtime.stopSupervisorExact(previous)
      await rig.runtime.removeContainerExact(previous.containerId)
      rig.supervisor = await rig.runtime.startSupervisor({
        scenarioId: previous.scenarioId, volumeName: previous.volumeName, binaryKind: 'test',
        reuseSecret: true, env: supervisorEnv, crashPoint: 'ordinary_stop_after_intent',
      })
      let ready = await harness.getLastReadyAt()
      await rig.restartWebGracefully()
      await harness.waitForConnectionAfter(ready, 90_000)
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const pane = page.locator(`[data-pane-id="${created.paneId}"]`)
      await expect(pane.getByText('Synthetic saved answer 2', { exact: true })).toBeVisible({ timeout: 60_000 })
      const original = (await harness.getPaneLayout(created.tabId)).content
      expect(original.soulId).toBe(view.soulId)
      expect(original.sessionRef.sessionId).toBe(nativeId)
      const canonical = { soulId: original.soulId, sessionRef: original.sessionRef,
        resumeSessionId: original.resumeSessionId, createRequestId: original.createRequestId }
      const readDurable = async (installCounters = false) => JSON.parse(await rig.runtime.execOwnedContainerExact(
        rig.supervisor.containerId, ['python3', '-c', `
import json,sqlite3,sys
c=sqlite3.connect('/var/lib/freshell-supervisor/runtime.sqlite3')
c.row_factory=sqlite3.Row
if sys.argv[2]=='install':
 c.executescript("""CREATE TABLE stop_browser_effects(kind TEXT NOT NULL);
 CREATE TRIGGER stop_browser_incarnation AFTER INSERT ON incarnations BEGIN INSERT INTO stop_browser_effects VALUES('replacement'); END;
 CREATE TRIGGER stop_browser_writer AFTER INSERT ON writer_claims BEGIN INSERT INTO stop_browser_effects VALUES('writer'); END;
 CREATE TRIGGER stop_browser_grant AFTER UPDATE OF execution_generation,grant_id ON incarnations WHEN NEW.execution_generation!=OLD.execution_generation OR NEW.grant_id IS NOT OLD.grant_id BEGIN INSERT INTO stop_browser_effects VALUES('grant'); END;
 CREATE TRIGGER stop_browser_recovery AFTER INSERT ON recovery_attempts BEGIN INSERT INTO stop_browser_effects VALUES('recovery'); END;""")
soul=dict(c.execute('SELECT soul_id,provider_store_id,provider_volume_name,native_session_id,intent_revision,desired_state FROM souls WHERE soul_id=?',(sys.argv[1],)).fetchone())
incarnations=[dict(r) for r in c.execute('SELECT incarnation_id,container_id,execution_generation,grant_id,launch_state,cleanup_state FROM incarnations WHERE soul_id=? ORDER BY created_at,rowid',(sys.argv[1],))]
stops=[dict(r) for r in c.execute('SELECT intent_revision,outcome,revoke_pending,settled FROM ordinary_stops WHERE soul_id=?',(sys.argv[1],))]
print(json.dumps(dict(soul=soul,incarnations=incarnations,stops=stops,writers=c.execute('SELECT count(*) FROM writer_claims WHERE soul_id=?',(sys.argv[1],)).fetchone()[0],effects=[r[0] for r in c.execute('SELECT kind FROM stop_browser_effects')],tombstones=c.execute('SELECT count(*) FROM stop_tombstones WHERE soul_id=?',(sys.argv[1],)).fetchone()[0])))
`, view.soulId, installCounters ? 'install' : 'read'],
      ))
      const before = await readDurable(true)
      expect(before.incarnations).toHaveLength(1)
      expect(before.writers).toBe(1)
      const receiptCount = (await rig.runtime.broker.receipts()).length
      const runtimeDir = await rig.runtime.runtimeDir(rig.supervisor, view.incarnationId)
      const hostState = async () => JSON.parse(await rig.runtime.execOwnedContainerExact(
        rig.supervisor.containerId, ['cat', path.join(runtimeDir, 'host-state.json')],
      ))
      const workerLaunchCount = (await hostState()).workerLaunchCount
      const sentAtStop = sent.length
      const receivedAtStop = received.length
      const crashed = rig.supervisor

      // Close pane sends the fenced, acknowledged ordinary Stop. Composer
      // Stop interrupts a turn and does not commit durable stopped intent.
      await pane.getByRole('button', { name: 'Close pane', exact: true }).click()
      await expect.poll(async () => rig.runtime.isContainerRunning(crashed.containerId), { timeout: 30_000 }).toBe(false)
      const crashLogs = await rig.runtime.containerLogs(crashed.containerId)
      expect(crashLogs.split('\n').some((line) => {
        try { const row = JSON.parse(line); return row.event === 'supervisor.test_crash' && row.point === 'ordinary_stop_after_intent' }
        catch { return false }
      })).toBe(true)
      expect((await rig.runtime.inspectContainer(crashed.containerId)).State.ExitCode).toBe(134)
      await expect.poll(() => received.slice(receivedAtStop).some((message) => {
        const event = message.type === 'freshAgent.event' ? message.event : message
        return message.sessionId === original.sessionId && event.type === 'freshAgent.killed' && event.success === false
      }), { timeout: 30_000 }).toBe(true)
      expect(sent.slice(sentAtStop).filter((frame) => frame.type === 'freshAgent.kill')).toHaveLength(1)
      await expect(pane).toBeVisible()
      expect((await harness.getPaneLayout(created.tabId)).content).toMatchObject(canonical)
      await expect(pane.getByText('Synthetic saved answer 2', { exact: true })).toBeVisible()

      await rig.runtime.removeContainerExact(crashed.containerId)
      rig.supervisor = await rig.runtime.startSupervisor({
        scenarioId: crashed.scenarioId, volumeName: crashed.volumeName, binaryKind: 'test',
        reuseSecret: true, env: supervisorEnv,
      })
      const stopped = await waitForValue('restarted supervisor finishes the original Stop', async () => {
        const current = (await rig.inventory()).find((row) => row.soulId === view.soulId)
        return current?.launchState === 'stopped' && current.cleanupState === 'verified_empty' ? current : null
      }, 60_000)
      expect(stopped).toMatchObject({ soulId: view.soulId, incarnationId: view.incarnationId,
        containerId: view.containerId, nativeSessionId: nativeId, desiredState: 'stopped',
        intentRevision: before.soul.intent_revision + 1 })
      expect(await rig.runtime.isContainerRunning(view.containerId!)).toBe(false)
      ready = await harness.getLastReadyAt()
      await rig.restartWebGracefully()
      await harness.waitForConnectionAfter(ready, 90_000)
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      await expect(pane).toBeVisible()
      expect((await harness.getPaneLayout(created.tabId)).content).toMatchObject(canonical)
      await expect(pane.getByText('Synthetic saved answer 2', { exact: true })).toBeVisible({ timeout: 60_000 })
      await expect(pane.getByRole('textbox', { name: 'Chat message input' })).toBeDisabled()
      const afterHistory = await history()
      expect(afterHistory.threadId).toBe(nativeId)
      expect(afterHistory.turns).toEqual(retained.turns)
      expect(afterHistory.capabilities.send).toBe(false)
      const after = await readDurable()
      expect(after.soul).toEqual({ ...before.soul, desired_state: 'stopped', intent_revision: stopped.intentRevision })
      expect(after.incarnations).toEqual(before.incarnations.map((incarnation: any) => ({
        ...incarnation, launch_state: 'stopped', cleanup_state: 'verified_empty',
      })))
      expect(after.stops).toEqual([{ intent_revision: stopped.intentRevision,
        outcome: 'verified_empty', revoke_pending: 0, settled: 1 }])
      expect(after.tombstones).toBe(before.tombstones + 1)
      expect(after.writers).toBe(0)
      expect(after.effects).toEqual([])
      expect((await hostState()).workerLaunchCount).toBe(workerLaunchCount)
      expect((await rig.runtime.broker.receipts()).length).toBe(receiptCount)
      expect(sent.slice(sentAtStop).filter((frame) => ['freshAgent.create', 'terminal.create'].includes(frame.type))).toEqual([])
      const lifecycle = (await rig.runtime.execOwnedContainerExact(rig.supervisor.containerId,
        ['cat', path.join(path.dirname(rig.supervisor.runtimeRoot), 'evidence', 'lifecycle.jsonl')]))
        .split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .filter((event) => event.data?.soulId === view.soulId)
      expect(lifecycle.filter((event) => event.event === 'supervisor.stop_committed').map((event) => event.data.intentRevision))
        .toEqual([stopped.intentRevision])
      expect(lifecycle.some((event) => event.event === 'supervisor.stop_continuation'
        && event.data.intentRevision === stopped.intentRevision)).toBe(true)
      await rig.runtime.writeArtifact('task006-interrupted-stop.json', {
        caseName: 'synthetic interrupted ordinary Stop preserves history', status: 'PASS',
        soulId: view.soulId, incarnationId: view.incarnationId, nativeSessionId: nativeId,
        intentRevision: stopped.intentRevision, crashPoint: 'ordinary_stop_after_intent', crashExitCode: 134,
        retainedTurns: afterHistory.turns.length, workerLaunchCount, effects: after.effects,
      })
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

})
