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
      const readyAt = await harness.getLastReadyAt()
      await rig.crashAndRestartWeb()
      await harness.waitForConnectionAfter(readyAt, 90_000)
      await waitForValue('permission prompt after web replacement', async () => {
        const currentId = await currentPaneTerminalId(harness, tabId, paneId)
        const text = await terminal.getVisibleText(currentId ?? terminalId)
        return text.includes('Permission required') && text.includes('Allow once') ? true : null
      }, 90_000)
      await pressInPane(page, paneId, 'Enter')
      await waitForValue('approval tool exactly once', () => (
        markerCount(rig, initial.containerId!, 'p5-chaos-approval-count') === 1 ? true : null
      ), 180_000)
      const pendingApprovalSurvived = true

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

      let webRestartCycles = 1
      let duplicateWriters = 0
      for (; webRestartCycles < 100; webRestartCycles += 1) {
        const previousReady = await harness.getLastReadyAt()
        if (webRestartCycles % 2 === 0) await rig.restartWebGracefully()
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
        const snapshot = await rig.inventorySnapshot()
        const running = snapshot.souls.filter((row: any) => row.soulId === initial.soulId && row.launchState === 'running')
        duplicateWriters += Math.max(0, running.length - 1)
      }

      let supervisorRestartCycles = 0
      for (; supervisorRestartCycles < 20; supervisorRestartCycles += 1) {
        await rig.restartSupervisor()
        await waitForValue(`supervisor restart ${supervisorRestartCycles + 1}`, async () => {
          const snapshot = await rig.inventorySnapshot()
          const row = snapshot.souls.filter((candidate: any) => candidate.soulId === initial.soulId).at(-1)
          return row?.launchState === 'running' ? row : null
        }, 60_000)
        const snapshot = await rig.inventorySnapshot()
        const running = snapshot.souls.filter((row: any) => row.soulId === initial.soulId && row.launchState === 'running')
        duplicateWriters += Math.max(0, running.length - 1)
      }

      await waitForValue('long tool one side effect', () => (
        markerCount(rig, initial.containerId!, 'p5-chaos-long-tool-count') === 1 ? true : null
      ), 240_000)
      expect(markerCount(rig, initial.containerId, 'p5-chaos-long-tool-count')).toBe(1)
      await executeInPane(page, paneId, 'Reply with exactly P5_CHAOS_FOLLOWUP and use no tools.')
      await waitForPaneOutput(page, harness, tabId, paneId, 'P5_CHAOS_FOLLOWUP', 180_000)

      const finalSnapshot = await rig.inventorySnapshot()
      const finalView = finalSnapshot.souls.filter((row: any) => row.soulId === initial.soulId).at(-1)
      expect(finalView.incarnationId).toBe(initial.incarnationId)
      expect(finalView.containerId).toBe(initial.containerId)
      expect(finalView.hostBootId).toBe(initial.hostBootId)
      expect(finalView.nativeSessionId).toBe(providerSessionId)
      const notices = await page.evaluate(async ({ token }) => {
        const response = await fetch('/api/runtime/notices?profileId=profile%3Aphase5-chaos&limit=100', {
          headers: { authorization: `Bearer ${token}` },
        })
        if (!response.ok) throw new Error(await response.text())
        return (await response.json()).notices
      }, { token: info.token })
      const falseLossNotices = notices.length

      const runtimeDir = rig.runtime.runtimeDir(rig.supervisor, initial.incarnationId)
      const hostState = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'host-state.json'), 'utf8'))
      const receipt = {
        schemaVersion: 1,
        status: 'PASS',
        candidateSha: rig.runtime.candidateSha,
        browser: {
          browserInteraction: true,
          provider: 'opencode',
          providerVersion: P2_OPENCODE_VERSION,
          model: P2_OPENCODE_FREE_MODEL,
          webRestartCycles,
          supervisorRestartCycles,
          pendingApprovalSurvived,
          longToolExactlyOnce: markerCount(rig, initial.containerId, 'p5-chaos-long-tool-count') === 1,
          falseLossNotices,
          duplicateWriters,
          sameSoulId: finalView.soulId === initial.soulId,
          sameIncarnation: finalView.incarnationId === initial.incarnationId,
          sameNativeSession: finalView.nativeSessionId === providerSessionId,
          providerLaunchCount: hostState.workerLaunchCount,
          followUpCompleted: true,
          paneId,
          terminalId,
        },
      }
      const receiptPath = rig.writePhase5ChaosReceipt(receipt)
      // eslint-disable-next-line no-console
      console.log(`[P5-G09] chaos receipt: ${receiptPath}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
