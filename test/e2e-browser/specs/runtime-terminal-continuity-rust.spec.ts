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

import { ManagedRuntimeBrowserRig } from '../helpers/managed-runtime.js'
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

async function currentTerminalIdentity(harness: TestHarness): Promise<{
  tabId: string
  terminalId: string
  createRequestId: string
}> {
  const tabId = await harness.getActiveTabId()
  if (!tabId) throw new Error('no active tab')
  const leaves = findTerminalLeaves(await harness.getPaneLayout(tabId))
  if (leaves.length !== 1) throw new Error(`expected one terminal leaf, saw ${leaves.length}`)
  const { terminalId, createRequestId } = leaves[0].content
  if (typeof terminalId !== 'string' || typeof createRequestId !== 'string') {
    throw new Error(`terminal identity not anchored: ${JSON.stringify(leaves[0].content)}`)
  }
  return { tabId, terminalId, createRequestId }
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
    last = rig.ownedContainerExec(containerId, ['sh', '-lc', `pgrep -af ${JSON.stringify(pattern)} || true`])
    if (last.includes(pattern)) return last
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`timed out waiting for owned process ${pattern}; last=${last}`)
}

test.describe.serial('Phase 2 managed runtime continuity', () => {
  test('P2-G01: real browser shell survives ten graceful/abrupt web replacements', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(360_000)

    const rig = new ManagedRuntimeBrowserRig()
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 30_000 })

      const initialPane = await currentTerminalIdentity(harness)
      const initialView = await expect
        .poll(() => rig.runningViewForTerminal(initialPane.terminalId), { timeout: 30_000 })
        .not.toBeNull()
        .then(async () => rig.runningViewForTerminal(initialPane.terminalId))
      if (!initialView?.containerId || !initialView.hostBootId) throw new Error('managed runtime view missing container/host identity')

      // Two long-lived descendants: one heartbeat producer proves output is
      // continuously drained while web disappears; one plain sleep gives a
      // stable child PID to assert across every replacement.
      await terminal.executeCommand(
        `(i=0; while true; do echo P2_HEARTBEAT:$i; i=$((i+1)); sleep 1; done) & echo P2_HEARTBEAT_PID=$!; sleep 300 & echo P2_CHILD_PID=$!`,
      )
      await terminal.waitForOutput('P2_CHILD_PID=', { timeout: 20_000, terminalId: initialPane.terminalId })
      const seeded = await terminal.getVisibleText(initialPane.terminalId)
      const childPid = Number(seeded.match(/P2_CHILD_PID=(\d+)/)?.[1])
      expect(childPid).toBeGreaterThan(0)
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
        if (cycle % 2 === 1) await rig.restartWebGracefully()
        else await rig.crashAndRestartWeb()

        await harness.waitForConnection()
        const pane = await expect
          .poll(() => currentTerminalIdentity(harness).catch(() => null), { timeout: 30_000 })
          .not.toBeNull()
          .then(() => currentTerminalIdentity(harness))
        expect(pane.createRequestId).toBe(initialPane.createRequestId)
        // Managed IDs are deterministic from createRequestId; this also proves
        // the restarted web server did not mint a conflicting runtime payload.
        expect(pane.terminalId).toBe(initialPane.terminalId)

        const view = await expect
          .poll(() => rig.runningViewForTerminal(pane.terminalId), { timeout: 30_000 })
          .not.toBeNull()
          .then(() => rig.runningViewForTerminal(pane.terminalId))
        expect(view?.soulId).toBe(originalIdentity.soulId)
        expect(view?.incarnationId).toBe(originalIdentity.incarnationId)
        expect(view?.containerId).toBe(originalIdentity.containerId)
        expect(view?.hostBootId).toBe(originalIdentity.hostBootId)
        expect(rig.runtime.broker.receipts()).toHaveLength(receiptCount)
        expect(rig.ownedContainerExec(originalIdentity.containerId, ['sh', '-lc', `kill -0 ${childPid} && echo ALIVE`]).trim()).toBe('ALIVE')

        const marker = `P2_WEB_CYCLE_${cycle}_${Date.now()}`
        await terminal.executeCommand(`echo ${marker}`)
        await terminal.waitForOutput(marker, { timeout: 30_000, terminalId: pane.terminalId })
        await terminal.waitForOutput('P2_HEARTBEAT:', { timeout: 30_000, terminalId: pane.terminalId })
        const text = await terminal.getVisibleText(pane.terminalId)
        const heartbeat = Number(text.match(/P2_HEARTBEAT:(\d+)/g)?.at(-1)?.split(':')[1] ?? -1)
        if (heartbeat > lastHeartbeat) outputAdvanced = true
        lastHeartbeat = Math.max(lastHeartbeat, heartbeat)

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

  const realProviderEnabled = process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
  const realClaudeTest = realProviderEnabled ? test : test.skip
  realClaudeTest('P2-G04: real Claude tool turn survives web replacement and follow-up stays in one native session', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(300_000)
    const credentialFile = process.env.FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE?.trim()
    if (!credentialFile || !fs.statSync(credentialFile, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('P2-G04 requires FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE pointing at an exact Claude .credentials.json file')
    }

    const rig = new ManagedRuntimeBrowserRig()
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 30_000 })
      const tabId = await harness.getActiveTabId()
      if (!tabId) throw new Error('P2-G04 has no active tab')
      const before = new Set(leavesByMode(await harness.getPaneLayout(tabId), 'claude').map((leaf) => leaf.id))
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
      const dirInput = page.getByRole('combobox', { name: /Starting directory for Claude/i })
      await expect(dirInput).toBeVisible({ timeout: 15_000 })
      await dirInput.fill(rig.repoRoot)
      await dirInput.press('Enter')

      const claudeLeaf = await expect
        .poll(async () => {
          const leaf = leavesByMode(await harness.getPaneLayout(tabId), 'claude').find((candidate) => !before.has(candidate.id))
          return leaf?.content?.terminalId ? leaf : null
        }, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () => leavesByMode(await harness.getPaneLayout(tabId), 'claude').find((candidate) => !before.has(candidate.id))!)
      const paneId: string = claudeLeaf.id
      const terminalId: string = claudeLeaf.content.terminalId
      const content = async () => {
        const leaves = leavesByMode(await harness.getPaneLayout(tabId), 'claude')
        return leaves.find((leaf) => leaf.id === paneId)?.content
      }
      const sessionId = await expect
        .poll(async () => (await content())?.sessionRef?.sessionId ?? null, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () => (await content())!.sessionRef.sessionId as string)
      const view = await expect
        .poll(() => rig.runningViewForTerminal(terminalId), { timeout: 30_000 })
        .not.toBeNull()
        .then(() => rig.runningViewForTerminal(terminalId))
      if (!view?.containerId || !view.hostBootId) throw new Error('real Claude managed view missing ownership identity')
      expect(rig.ownedContainerExec(view.containerId, ['claude', '--version'])).toContain('2.1.263')

      const claudeIndex = Math.max(0, (await page.locator('.xterm').count()) - 1)
      await terminal.waitForPrompt({ timeout: 45_000, terminalId })
      await terminal.executeCommand(
        'Use the Bash tool to run exactly: sleep 12; echo P2_CLAUDE_TOOL_DONE >> "$HOME/p2-claude-tool-count". Do not finish your response until that command completes.',
        claudeIndex,
      )
      await waitForOwnedProcess(rig, view.containerId, 'sleep 12', 45_000)

      await rig.crashAndRestartWeb()
      await harness.waitForConnection()
      const afterLeaf = await expect
        .poll(async () => leavesByMode(await harness.getPaneLayout(tabId), 'claude').find((leaf) => leaf.id === paneId) ?? null, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () => leavesByMode(await harness.getPaneLayout(tabId), 'claude').find((leaf) => leaf.id === paneId)!)
      expect(afterLeaf.content.terminalId).toBe(terminalId)
      await expect.poll(async () => (await content())?.sessionRef?.sessionId ?? null, { timeout: 30_000 }).toBe(sessionId)
      const afterView = await rig.runningViewForTerminal(terminalId)
      expect(afterView?.soulId).toBe(view.soulId)
      expect(afterView?.incarnationId).toBe(view.incarnationId)
      expect(afterView?.containerId).toBe(view.containerId)
      expect(afterView?.hostBootId).toBe(view.hostBootId)

      await expect.poll(() => {
        const count = rig.ownedContainerExec(view.containerId!, ['sh', '-lc', 'test -f "$HOME/p2-claude-tool-count" && wc -l < "$HOME/p2-claude-tool-count" || echo 0'])
        return Number(count.trim())
      }, { timeout: 45_000 }).toBe(1)

      const afterIndex = Math.max(0, (await page.locator('.xterm').count()) - 1)
      await terminal.waitForPrompt({ timeout: 45_000, terminalId })
      await terminal.executeCommand('Reply with exactly P2_CLAUDE_FOLLOWUP', afterIndex)
      await terminal.waitForOutput('P2_CLAUDE_FOLLOWUP', { timeout: 90_000, terminalId })
      const runtimeDir = rig.runtime.runtimeDir(rig.supervisor, view.incarnationId)
      const hostState = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'host-state.json'), 'utf8'))
      expect(hostState.workerLaunchCount).toBe(1)
      expect((await content())?.sessionRef?.sessionId).toBe(sessionId)

      const receipt = {
        caseId: 'P2-G04',
        status: 'PASS',
        claudeVersion: '2.1.263',
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
      }
      const receiptPath = rig.writeClaudeReceipt(receipt)
      // eslint-disable-next-line no-console
      console.log(`[P2-G04] real Claude continuity receipt: ${receiptPath}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

})
