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

import { ManagedRuntimeBrowserRig, P2_OPENCODE_FREE_MODEL, P2_OPENCODE_VERSION, type ManagedRuntimeView } from '../helpers/managed-runtime.js'
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

/** Force a real revisioned inventory refresh AFTER attachment has established its epoch. */
async function assertInventoryPreservesAttachedEpoch(
  harness: TestHarness,
  rig: ManagedRuntimeBrowserRig,
  pane: TerminalIdentity,
  view: ManagedRuntimeView,
): Promise<void> {
  const result = await rig.runtime.adminOk(rig.supervisor, rig.runtime.terminalReadOutputBody(
    view.soulId, 0, 64 * 1024, await rig.controlEpoch(),
  ))
  expect(result.kind).toBe('terminal_output')
  const source = result.data
  expect(source.incarnationId).toBe(view.incarnationId)
  expect(source.terminalId).toBe(pane.terminalId)
  expect(source.streamEpoch).not.toBe(view.terminalStreamId)
  const content = async () => findTerminalLeaves(await harness.getPaneLayout(pane.tabId))
    .find((leaf) => leaf.content.terminalId === pane.terminalId)?.content
  await expect.poll(async () => (await content())?.streamId, { timeout: 30_000 }).toBe(source.streamEpoch)

  const inventory = await rig.inventorySnapshot()
  const intent = inventory.viewIntents.find((row: any) => row.soulId === view.soulId)
  if (!intent) throw new Error('attached managed shell lacks a durable view intent')
  // Reasserting visible with a new request advances the real view revision;
  // the normal WS invalidation / HTTP inventory path must fold that revision.
  const updated = await rig.runtime.adminOk(rig.supervisor, rig.runtime.updateViewVisibilityBody({
    viewId: intent.viewId, visibility: 'visible', expectedRevision: intent.revision,
    expectedSoulIntentRevision: view.intentRevision, expectedControlEpoch: await rig.controlEpoch(),
  }))
  expect(updated.data.revision).toBeGreaterThan(intent.revision)
  await expect.poll(async () => (await content())?.viewIntentRevision, { timeout: 30_000 })
    .toBe(updated.data.revision)
  expect((await content())?.streamId).toBe(source.streamEpoch)
  expect((await content())?.incarnationId).toBe(view.incarnationId)
}

test.describe.serial('Phase 2 managed runtime continuity', () => {
  test('P2-G01: real browser shell survives ten graceful/abrupt web replacements', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(1_800_000)

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

      await assertInventoryPreservesAttachedEpoch(harness, rig, initialPane, initialView)

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

        const heartbeat = await waitForValue(`heartbeat advance after web cycle ${cycle}`, async () => {
          const text = await terminal.getVisibleText(pane.terminalId)
          const value = Number(text.match(/P2_HEARTBEAT:(\d+)/g)?.at(-1)?.split(':')[1] ?? -1)
          return value > lastHeartbeat ? value : null
        }, 60_000)
        outputAdvanced = true
        lastHeartbeat = heartbeat

        await assertInventoryPreservesAttachedEpoch(harness, rig, pane, view)

        const marker = `P2_WEB_CYCLE_${cycle}_${Date.now()}`
        const markerPath = `/home/freshell/provider/p2-web-cycle-${cycle}`
        await terminal.executeCommandInserted(
          `printf '%s\n' ${JSON.stringify(marker)} > "$HOME/p2-web-cycle-${cycle}"`,
        )
        await waitForOwnedFileValue(rig, originalIdentity.containerId, markerPath, marker, 30_000)

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
      const receiptPath = rig.writeBrowserResult(receipt)
      // eslint-disable-next-line no-console
      console.log(`[P2-G01] browser continuity receipt: ${receiptPath}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

  test('P2-G04: real free-tier OpenCode tool turn survives web replacement in one native session', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(900_000)

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
      const processArgs = rig.ownedContainerExec(view.containerId, ['sh', '-lc', "pgrep -af '[o]pencode' || true"])
      expect(processArgs).toContain(`--model ${P2_OPENCODE_FREE_MODEL}`)
      expect(processArgs).toContain('--hostname 127.0.0.1')
      expect(processArgs).toContain('--port 4096')

      const opencodeIndex = Math.max(0, (await page.locator('.xterm').count()) - 1)
      await terminal.waitForOutput('Ask anything...', { timeout: 90_000, terminalId })
      await terminal.executeCommandInserted(
        'Use the bash tool to run exactly: echo P2_OPENCODE_FIRST_TURN_DONE > "$HOME/p2-opencode-first-turn". Reply with exactly READY when the command completes.',
        opencodeIndex,
      )
      await expect.poll(() => {
        return rig.ownedProviderExec(view.containerId!, ['sh', '-lc', 'cat /home/freshell/provider/p2-opencode-first-turn 2>/dev/null || true']).trim()
      }, { timeout: 90_000 }).toBe('P2_OPENCODE_FIRST_TURN_DONE')

      const sessionId = await waitForSessionId(content, 90_000)
      expect(sessionId).toMatch(/^ses_/)

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
        opencodeVersion: P2_OPENCODE_VERSION,
        model: P2_OPENCODE_FREE_MODEL,
        freeTier: true,
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
      const receiptPath = rig.writeOpenCodeResult(receipt)
      // eslint-disable-next-line no-console
      console.log(`[P2-G04] real OpenCode continuity receipt: ${receiptPath}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

})
