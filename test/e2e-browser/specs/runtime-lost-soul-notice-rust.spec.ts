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
import {
  sha256,
} from '../../../scripts/testing/runtime-phase5-evidence-common.js'
import {
  assertPhase5LossRun,
  PHASE5_CAPABILITY_INVENTORY_FILE,
  PHASE5_LOSS_ASSERTIONS_FILE,
  PHASE5_LOSS_INCIDENT_FILE,
} from '../../../scripts/testing/runtime-phase5-loss-evidence.js'

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

function providerFileEvidence(rig: ManagedRuntimeBrowserRig, containerId: string, filePath: string): {
  path: string
  exists: boolean
  sha256: string
} {
  const script = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const target = process.argv[1];
let exists = false;
let digest = crypto.createHash('sha256').update('absent').digest('hex');
try {
  const stat = fs.lstatSync(target);
  exists = stat.isFile();
  if (exists) digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
process.stdout.write(JSON.stringify({ path: target, exists, sha256: digest }));
`
  return JSON.parse(rig.ownedProviderExec(containerId, ['node', '-e', script, filePath]))
}

function exactAbsenceCheck(rig: ManagedRuntimeBrowserRig, containerId: string, target: string) {
  const script = String.raw`
const fs = require('node:fs');
const target = process.argv[1];
let state = 'absent';
try { fs.lstatSync(target); state = 'present'; } catch (error) { if (error.code !== 'ENOENT') state = 'unknown'; }
process.stdout.write(JSON.stringify({ path: target, state, probe: 'lstat' }));
`
  return JSON.parse(rig.ownedProviderExec(containerId, ['node', '-e', script, target]))
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
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
    let receiptReady = false
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

      const credentialPath = '/home/freshell/provider/.local/share/opencode/auth.json'
      const credentialBefore = providerFileEvidence(rig, before.containerId, credentialPath)

      // Retain only a diagnostic marker; remove OpenCode session DB/artifacts
      // and all Freshell checkpoint copies without reading or mutating host
      // credentials. Then terminate exactly the recorded provider PID.
      rig.runtime.killOwnedRuntimePidExact(before.containerId, workerPid)
      rig.ownedContainerExec(before.containerId, [
        'node', '-e', String.raw`
const fs = require('node:fs');
for (const target of [
  '/home/freshell/provider/.local/share/opencode/opencode.db',
  '/home/freshell/provider/.local/share/opencode/opencode.db-wal',
  '/home/freshell/provider/.local/share/opencode/opencode.db-shm',
]) {
  try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const checkpoints = '/home/freshell/provider/.freshell/checkpoints';
try { fs.rmSync(checkpoints, { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!fs.statSync('/home/freshell/provider/p5-diagnostic-only').isFile()) process.exit(2);
`,
      ])
      const diagnosticOnlyRetained = rig.ownedProviderExec(before.containerId, [
        'sh', '-lc', 'cat "$HOME/p5-diagnostic-only"',
      ]).trim() === diagnostic
      expect(diagnosticOnlyRetained).toBe(true)
      const credentialAfter = providerFileEvidence(rig, before.containerId, credentialPath)
      expect(credentialAfter).toEqual(credentialBefore)
      const exactAbsenceChecks = [
        '/home/freshell/provider/.local/share/opencode/opencode.db',
        '/home/freshell/provider/.local/share/opencode/opencode.db-wal',
        '/home/freshell/provider/.local/share/opencode/opencode.db-shm',
        '/home/freshell/provider/.freshell/checkpoints',
      ].map((target) => exactAbsenceCheck(rig, before.containerId!, target))
      expect(exactAbsenceChecks.every((row) => row.state === 'absent')).toBe(true)

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
      expect(incidentPersisted).toBe(true)
      const artifact = rig.runtime.runCommand('docker', [
        'exec', rig.supervisor.containerId, 'cat', incidentPath,
      ])
      expect(artifact).not.toContain(providerSessionId)
      expect(artifact).not.toContain(rig.supervisor.controlSecret)

      const incidentArtifact = JSON.parse(artifact)
      expect(incidentArtifact.certificateSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(incidentArtifact.certificate.intentRevision).toBe(before.intentRevision)
      expect(result.view.intentRevision).toBe(before.intentRevision + 1)
      writePrivateJson(path.join(rig.runtime.evidenceDir, PHASE5_LOSS_INCIDENT_FILE), incidentArtifact)
      writePrivateJson(path.join(rig.runtime.evidenceDir, PHASE5_LOSS_ASSERTIONS_FILE), {
        schemaVersion: 1,
        candidateSha: rig.runtime.candidateSha,
        receiptRunId: rig.runtime.runId,
        caseId: 'P5-G02',
        test: { total: 1, passed: 1, failed: 0, skipped: 0 },
        identity: {
          provider: 'opencode',
          providerVersion: P2_OPENCODE_VERSION,
          model: P2_OPENCODE_FREE_MODEL,
          soulId: before.soulId,
          incarnationId: before.incarnationId,
          containerId: before.containerId,
          hostBootId: before.hostBootId,
          nativeSessionIdHash: incidentArtifact.certificate.nativeSessionRefHash,
          incidentId: result.incidentId,
          paneId,
          terminalId,
        },
        intent: {
          checkedRevision: before.intentRevision,
          lossRevision: incidentArtifact.certificate.intentRevision,
          endedRevision: result.view.intentRevision,
        },
        providerState: {
          exactAbsenceChecks,
          credentialIntegrity: [{
            path: credentialPath,
            beforeExists: credentialBefore.exists,
            afterExists: credentialAfter.exists,
            beforeSha256: credentialBefore.sha256,
            afterSha256: credentialAfter.sha256,
          }],
        },
        browser: {
          displayedNoticeIds: [incidentArtifact.noticeId],
          endedPane: {
            soulId: ended.content.soulId,
            incarnationId: before.incarnationId,
            incidentId: ended.content.incidentId,
            nativeSessionIdHash: incidentArtifact.certificate.nativeSessionRefHash,
            recoveryState: ended.content.recoverySummary.recoveryState,
          },
        },
      })
      receiptReady = true
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    expect(receiptReady).toBe(true)
    fs.copyFileSync(
      path.join(rig.repoRoot, 'docs/development/runtime-provider-capabilities.json'),
      path.join(rig.runtime.evidenceDir, PHASE5_CAPABILITY_INVENTORY_FILE),
    )
    fs.chmodSync(path.join(rig.runtime.evidenceDir, PHASE5_CAPABILITY_INVENTORY_FILE), 0o600)
    const result = assertPhase5LossRun(rig.runtime.evidenceDir)
    const receipt = { status: 'PASS', summary: result.summary,
      buildCommit: rig.runtime.candidateSha, runtimeImage: rig.runtime.imageRef }
    const receiptPath = rig.writeLossResult(receipt)
    // eslint-disable-next-line no-console
    console.log(`[P5-G02] real OpenCode loss receipt: ${receiptPath}`)
  })
})
