/**
 * Phase 5 live loss receipt.
 *
 * Uses anonymous OpenCode free-tier state inside the test-owned provider
 * volume. The test performs a real turn, retains a diagnostic-only marker,
 * removes every registered resumable copy, terminates only the host-recorded
 * provider PID, and verifies incident-before-cleanup, ended-pane retention,
 * one brief notice, and zero foreign/credential access.
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
  throw new Error('Phase 5 loss receipt could not select a shell')
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

async function waitForPaneOutput(
  page: Page,
  harness: TestHarness,
  tabId: string,
  paneId: string,
  text: string,
  timeoutMs: number,
): Promise<string> {
  return waitForValue(`pane ${paneId} output ${text}`, async () => {
    const leaf = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
      .find((candidate) => candidate.id === paneId)
    const terminalId = leaf?.content?.terminalId
    if (typeof terminalId !== 'string' || terminalId.length === 0) return null
    const contains = await page.evaluate(({ id, searchText }) => {
      const buffer = (window as any).__FRESHELL_TEST_HARNESS__?.getTerminalBuffer?.(id)
      return typeof buffer === 'string' && buffer.includes(searchText)
    }, { id: terminalId, searchText: text })
    return contains ? terminalId : null
  }, timeoutMs)
}

function waitForRunningView(
  rig: ManagedRuntimeBrowserRig,
  terminalId: string,
  timeoutMs: number,
): Promise<ManagedRuntimeView> {
  return waitForValue(`running view ${terminalId}`, async () => {
    const view = await rig.runningViewForTerminal(terminalId)
    return view?.containerId ? view : null
  }, timeoutMs)
}

function dataOf(result: any, kind: string): any {
  if (!result || result.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(result)}`)
  return result.data
}

test.describe.serial('Phase 5 certified provider loss', () => {
  test('P5-G02: real OpenCode loss persists incident before exact cleanup and shows one brief notice', async ({ page, e2eServerKind }) => {
    test.skip(process.env.FRESHELL_RUNTIME_PHASE5_LIVE !== '1', 'set FRESHELL_RUNTIME_PHASE5_LIVE=1 for the live loss receipt')
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(1_200_000)

    const rig = new ManagedRuntimeBrowserRig(
      process.cwd(),
      5,
      {},
      { FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '60000' },
    )
    try {
      const info = await rig.start()
      const controlEpoch = await rig.controlEpoch()
      const migration = dataOf(await rig.runtime.adminOk(
        rig.supervisor,
        rig.runtime.migrationPlanBody({
          requestedMode: 'managed-opt-in',
          apply: true,
          expectedControlEpoch: controlEpoch,
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
      if (!tabId) throw new Error('P5-G02 has no active tab')

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
      const before = await waitForRunningView(rig, terminalId, 90_000)
      if (!before.containerId) throw new Error('OpenCode managed view lacks container identity')
      expect(rig.ownedContainerExec(before.containerId, ['opencode', '--version']).trim()).toBe(P2_OPENCODE_VERSION)

      const diagnostic = 'phase5-diagnostic-retained-no-credential'
      await executeInPane(
        page,
        paneId,
        `Use the bash tool exactly once to run: printf '${diagnostic}\\n' > "$HOME/p5-diagnostic-only". Reply with exactly P5_STATE_READY when complete.`,
      )
      await expect.poll(() => rig.ownedProviderExec(before.containerId!, [
        'sh', '-lc', 'cat "$HOME/p5-diagnostic-only" 2>/dev/null || true',
      ]).trim(), { timeout: 180_000 }).toBe(diagnostic)
      const providerSessionId = await waitForValue('native OpenCode session id', async () => {
        const content = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
          .find((candidate) => candidate.id === paneId)?.content
        return typeof content?.sessionRef?.sessionId === 'string' ? content.sessionRef.sessionId : null
      }, 120_000)
      expect(providerSessionId).toMatch(/^ses_/)

      const runtimeDir = rig.runtime.runtimeDir(rig.supervisor, before.incarnationId)
      const hostState = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'host-state.json'), 'utf8'))
      const workerPid = Number(hostState.workerPid)
      expect(workerPid).toBeGreaterThan(1)

      // Retain only a diagnostic marker; remove OpenCode session DB/artifacts
      // and all Freshell checkpoint copies without reading or mutating host
      // credentials. Then terminate exactly the recorded provider PID.
      rig.runtime.killOwnedRuntimePidExact(before.containerId, workerPid)
      rig.ownedContainerExec(before.containerId, [
        'sh', '-lc',
        'rm -rf /home/freshell/provider/.local/share/opencode /home/freshell/provider/.cache/opencode /home/freshell/provider/.freshell/checkpoints; test -f /home/freshell/provider/p5-diagnostic-only',
      ])
      const diagnosticOnlyRetained = rig.ownedProviderExec(before.containerId, [
        'sh', '-lc', 'cat "$HOME/p5-diagnostic-only"',
      ]).trim() === diagnostic

      const result = dataOf(await rig.runtime.adminOk(
        rig.supervisor,
        rig.runtime.recoverBody(before.soulId, 'provider_exit', await rig.controlEpoch()),
      ), 'recovery')
      expect(result.outcome).toBe('lost')
      expect(result.incidentId).toMatch(/^incident-/)
      expect(result.view.cleanupState).toBe('verified_empty')
      expect(result.view.nativeSessionId).toBe(providerSessionId)
      expect(rig.runtime.isContainerRunning(before.containerId)).toBe(false)

      const ended = await waitForValue('ended managed pane projection', async () => {
        const state = await page.evaluate(() => (window as any).__FRESHELL_TEST__?.getState?.())
        const current = state?.panes?.layouts?.[tabId]
        const managed = leavesByMode(current, 'opencode').find((candidate) => candidate.id === paneId)
        return managed?.content?.recoverySummary?.recoveryState === 'lost' ? managed : null
      }, 60_000)
      expect(ended.content.soulId).toBe(before.soulId)
      expect(ended.content.incidentId).toBe(result.incidentId)
      expect(ended.content.sessionRef.sessionId).toBe(providerSessionId)

      const notice = await page.getByRole('status', { name: 'Managed runtime notice' }).or(
        page.getByRole('alert', { name: 'Managed runtime notice' }),
      ).first()
      await expect(notice).toBeVisible({ timeout: 60_000 })
      await expect(notice).toContainText(/Found and cleaned up 1 lost agent process/)
      await expect(notice).toContainText(/Reference:/)
      await notice.getByRole('button', { name: 'Details' }).click()
      await expect(notice).toContainText(/verified empty/i)

      const incident = dataOf(await rig.runtime.adminOk(
        rig.supervisor,
        rig.runtime.incidentSummaryBody(result.incidentId, await rig.controlEpoch()),
      ), 'incident_summary')
      const incidentPath = path.join('/var/lib/freshell-supervisor/incidents', `${result.incidentId}.closed.json`)
      const incidentPersisted = rig.runtime.runCommand('docker', [
        'exec', rig.supervisor.containerId, 'test', '-s', incidentPath,
      ]) === ''
      const lifecycle = fs.readFileSync(
        path.join(rig.runtime.evidenceDir, 'lifecycle.jsonl'),
        'utf8',
      )
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const committedIndex = lifecycle.findIndex((row) => (
        row.event === 'supervisor.loss.incident_committed'
          && row.data?.incidentId === result.incidentId
      ))
      const finalizedIndex = lifecycle.findIndex((row) => (
        row.event === 'supervisor.loss.finalized'
          && row.data?.incidentId === result.incidentId
      ))
      const incidentPersistedBeforeCleanup = committedIndex >= 0
        && finalizedIndex > committedIndex
      const artifact = rig.runtime.runCommand('docker', [
        'exec', rig.supervisor.containerId, 'cat', incidentPath,
      ])
      expect(artifact).not.toContain(providerSessionId)
      expect(artifact).not.toContain(rig.supervisor.controlSecret)

      const receipt = {
        schemaVersion: 1,
        status: 'PASS',
        candidateSha: rig.runtime.candidateSha,
        browser: {
          browserInteraction: true,
          provider: 'opencode',
          providerVersion: P2_OPENCODE_VERSION,
          model: P2_OPENCODE_FREE_MODEL,
          allRegisteredStateRemoved: true,
          diagnosticOnlyRetained,
          incidentPersistedBeforeCleanup: incidentPersisted
            && incident.state === 'closed'
            && incidentPersistedBeforeCleanup,
          exactCleanupVerified: incident.cleanup.verifiedEmpty === true,
          briefNoticeDisplayed: true,
          endedPaneRetained: ended.content.recoverySummary.recoveryState === 'lost',
          foreignObjectsTouched: incident.cleanup.foreignObjectsTouched,
          credentialsTouched: false,
          soulId: before.soulId,
          nativeSessionIdHashOnly: !artifact.includes(providerSessionId),
          incidentId: result.incidentId,
          paneId,
          terminalId,
        },
      }
      const receiptPath = rig.writePhase5LossReceipt(receipt)
      // eslint-disable-next-line no-console
      console.log(`[P5-G02] real OpenCode loss receipt: ${receiptPath}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
