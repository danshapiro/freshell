/**
 * Phase 4 browser gate: controller-first managed-runtime reconciliation and
 * authoritative view-intent rehydration.
 *
 * This uses real Chromium, a real feature-enabled Rust web server, the real
 * supervisor/session-host/Docker path, and three actual managed shell souls.
 * Shell souls avoid provider billing while still exercising the Phase 4
 * ownership, startup, view projection, merge, action, and compatibility
 * contracts end to end.
 */
import { expect, type Page } from '@playwright/test'
import WebSocket from 'ws'

import { test } from '../helpers/fixtures.js'
import { ManagedRuntimeBrowserRig } from '../helpers/managed-runtime.js'
import { TestHarness } from '../helpers/test-harness.js'
import { runtimeBrowserPost as apiPost, pruneRuntimeBrowserLayout } from '../helpers/runtime-browser-api.js'
import { LAYOUT_STORAGE_KEY } from '../../../src/store/storage-keys.js'
import { WS_PROTOCOL_VERSION } from '@shared/ws-version'

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

async function browserState(page: Page): Promise<any> {
  return new TestHarness(page).getState()
}

function visibleManagedTabs(state: any): any[] {
  return (state.tabs?.tabs ?? []).filter((tab: any) => typeof tab.viewIntentId === 'string')
}

function latestSoul(snapshot: any, soulId: string): any | undefined {
  return (snapshot.souls ?? []).filter((soul: any) => soul.soulId === soulId).at(-1)
}

async function prunePersistedLayoutToTab(page: Page, keepTabId: string): Promise<string> {
  const persisted = await waitForValue('canonical persisted browser layout', async () => {
    const raw = await page.evaluate((key) => localStorage.getItem(key), LAYOUT_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw)
    return value?.tabs?.tabs?.some((tab: any) => tab.id === keepTabId) && value?.panes?.layouts?.[keepTabId]
      ? value : null
  }, 15_000)
  const pruned = pruneRuntimeBrowserLayout(persisted, keepTabId)
  const marker = `freshell-runtime-pruned-layout-${keepTabId}`
  // The outgoing page's pagehide handler deliberately flushes live Redux state.
  // Install the isolated fixture mutation in the next top-level document before
  // application modules read storage, rather than racing that safety flush.
  await page.addInitScript(({ key, raw, marker }) => {
    if (window.top !== window || sessionStorage.getItem(marker) === 'installed') return
    localStorage.setItem(key, raw)
    sessionStorage.setItem(marker, 'installed')
  }, { key: LAYOUT_STORAGE_KEY, raw: JSON.stringify(pruned), marker })
  return LAYOUT_STORAGE_KEY
}

class RawWsClient {
  readonly socket: WebSocket
  private readonly messages: any[] = []
  private readonly waiters = new Set<() => void>()

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (raw) => {
      try {
        this.messages.push(JSON.parse(raw.toString()))
      } catch {
        // Non-JSON frames are not part of the control protocol.
      }
      for (const wake of this.waiters) wake()
      this.waiters.clear()
    })
  }

  static async connect(baseUrl: string, token: string): Promise<RawWsClient> {
    const origin = baseUrl
    const url = `${baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`
    const socket = new WebSocket(url, { headers: { Origin: origin } })
    const client = new RawWsClient(socket)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('raw compatibility socket open timed out')), 15_000)
      socket.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    socket.send(JSON.stringify({
      type: 'hello',
      protocolVersion: WS_PROTOCOL_VERSION,
      clientId: `phase4-old-client-${Date.now()}`,
      capabilities: {
        terminalOutputBatchV1: true,
        paneReconcileV1: true,
        paneReconcileFreshAgentV1: true,
        // Deliberately no managedRuntimeV1: this is the mixed-version client.
      },
    }))
    await client.waitFor((message) => message.type === 'ready', 20_000, 'ready')
    return client
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value))
  }

  async waitFor(
    predicate: (message: any) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<any> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate)
      if (index >= 0) return this.messages.splice(index, 1)[0]
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(wake)
          resolve()
        }, Math.min(250, Math.max(1, deadline - Date.now())))
        const wake = () => {
          clearTimeout(timer)
          resolve()
        }
        this.waiters.add(wake)
      })
    }
    throw new Error(`timed out waiting for raw WS ${description}; messages=${JSON.stringify(this.messages)}`)
  }

  close(): void {
    this.socket.close()
  }
}

test.describe.serial('Phase 4 managed-runtime tab rehydration', () => {
  test('P4-G08: controller inventory reconstructs views without duplicating souls', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(900_000)

    const rig = new ManagedRuntimeBrowserRig(process.cwd(), 4)
    let oldClient: RawWsClient | undefined
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      const emptyStartup = await browserState(page)
      const startupTabCount = emptyStartup.tabs.tabs.length
      expect(visibleManagedTabs(emptyStartup)).toHaveLength(0)
      expect((await rig.inventorySnapshot()).souls).toHaveLength(0)

      const browser = await apiPost<any>(page, info.token, '/api/tabs', {
        browser: 'about:blank',
        name: 'Existing saved layout',
      })
      expect(browser.tabId).toEqual(expect.any(String))
      expect(browser.paneId).toEqual(expect.any(String))
      const browserTabId: string = browser.tabId
      await expect.poll(() => harness.getTabCount(), { timeout: 30_000 }).toBe(startupTabCount + 1)

      const created: any[] = []
      for (let index = 1; index <= 3; index += 1) {
        const response = await apiPost<any>(page, info.token, '/api/tabs', {
          mode: 'shell',
          name: `Managed shell ${index}`,
          cwd: rig.repoRoot,
        })
        expect(response.tabId).toEqual(expect.any(String))
        expect(response.paneId).toEqual(expect.any(String))
        created.push(response)
      }
      await expect.poll(() => harness.getTabCount(), { timeout: 60_000 }).toBe(startupTabCount + 4)

      const initialSnapshot = await waitForValue('three managed souls and views', async () => {
        const snapshot = await rig.inventorySnapshot()
        const running = snapshot.souls.filter((soul: any) => soul.launchState === 'running')
        const visible = snapshot.viewIntents.filter((view: any) => view.visibility === 'visible')
        return running.length === 3 && visible.length === 3 ? snapshot : null
      }, 90_000)
      expect(initialSnapshot.readiness.initialScanState).toBe('complete')
      const initialSoulIds = initialSnapshot.souls
        .filter((soul: any) => soul.launchState === 'running')
        .map((soul: any) => soul.soulId)
        .sort()
      const initialRuntimeIdentity = new Map(
        initialSnapshot.souls
          .filter((soul: any) => soul.launchState === 'running')
          .map((soul: any) => [soul.soulId, {
            terminalId: soul.terminalId,
            incarnationId: soul.incarnationId,
            containerId: soul.containerId,
          }]),
      )
      const expectedTabIds = initialSnapshot.viewIntents
        .map((view: any) => view.preferredTabId)
        .sort()
      const expectedPaneIds = initialSnapshot.viewIntents
        .map((view: any) => view.preferredPaneId)
        .sort()

      // Set the saved-layout focus as fixture state. All subsequent restoration,
      // close-view and stop-agent checks still run through the live browser.
      await page.evaluate((tabId) => {
        const testHarness = window.__FRESHELL_TEST_HARNESS__
        if (!testHarness) throw new Error('Freshell test harness is unavailable')
        testHarness.dispatch({ type: 'tabs/setActiveTab', payload: tabId })
      }, browserTabId)
      await expect.poll(() => harness.getActiveTabId()).toBe(browserTabId)
      const activePaneBefore = (await browserState(page)).panes.activePane[browserTabId]
      const layoutStorageKey = await prunePersistedLayoutToTab(page, browserTabId)
      expect(layoutStorageKey.length).toBeGreaterThan(0)

      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const rehydrated = await waitForValue('authoritative managed view rehydration', async () => {
        const state = await browserState(page)
        const tabs = visibleManagedTabs(state)
        return tabs.length === 3 && state.managedRuntime?.status === 'ready' ? state : null
      }, 90_000)
      expect(rehydrated.tabs.tabs.map((tab: any) => tab.id).sort()).toEqual(
        [browserTabId, ...expectedTabIds].sort(),
      )
      expect(rehydrated.tabs.activeTabId).toBe(browserTabId)
      expect(rehydrated.panes.activePane[browserTabId]).toBe(activePaneBefore)
      expect(visibleManagedTabs(rehydrated).map((tab: any) => tab.viewIntentId).sort()).toEqual(
        initialSnapshot.viewIntents.map((view: any) => view.viewId).sort(),
      )
      expect(visibleManagedTabs(rehydrated).map((tab: any) => tab.soulId).sort()).toEqual(initialSoulIds)
      const recoveredPaneIds = expectedTabIds.map((tabId: string) => {
        const node = rehydrated.panes.layouts[tabId]
        return node?.type === 'leaf' ? node.id : undefined
      }).sort()
      expect(recoveredPaneIds).toEqual(expectedPaneIds)

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const priorReadyAt = await harness.getLastReadyAt()
        if (cycle % 2 === 1) await rig.crashAndRestartWeb()
        else await rig.restartWebGracefully()
        await harness.waitForConnectionAfter(priorReadyAt, 90_000)
        const state = await waitForValue(`stable tabs after web restart ${cycle}`, async () => {
          const current = await browserState(page)
          return visibleManagedTabs(current).length === 3
            && current.managedRuntime?.status === 'ready'
            ? current
            : null
        }, 90_000)
        expect(state.tabs.tabs.map((tab: any) => tab.id).sort()).toEqual(
          [browserTabId, ...expectedTabIds].sort(),
        )
        expect(state.tabs.activeTabId).toBe(browserTabId)
        expect(new Set(visibleManagedTabs(state).map((tab: any) => tab.viewIntentId)).size).toBe(3)
        expect(visibleManagedTabs(state).map((tab: any) => tab.soulId).sort()).toEqual(initialSoulIds)
      }

      const afterRestarts = await rig.inventorySnapshot()
      for (const soulId of initialSoulIds) {
        const before = initialRuntimeIdentity.get(soulId) as any
        const after = latestSoul(afterRestarts, soulId)
        expect(after?.incarnationId).toBe(before.incarnationId)
        expect(after?.containerId).toBe(before.containerId)
        expect(after?.terminalId).toBe(before.terminalId)
      }

      const statusPanel = page.getByRole('complementary', { name: 'Managed agent recovery' })
      await expect(statusPanel).toBeVisible({ timeout: 30_000 })
      const summary = statusPanel.locator('summary')
      if (!(await statusPanel.locator('details').evaluate((details) => details.open))) {
        await summary.click()
      }

      const closeSoulId = initialSoulIds[0]
      const closeSection = statusPanel.getByRole('region').filter({ hasText: closeSoulId })
      await closeSection.getByRole('button', { name: 'Close view' }).click()
      const closeOutcome = await waitForValue('detached view with live soul', async () => {
        const snapshot = await rig.inventorySnapshot()
        const view = snapshot.viewIntents.find((candidate: any) => candidate.soulId === closeSoulId)
        const soul = latestSoul(snapshot, closeSoulId)
        return view?.visibility === 'detached' && soul?.launchState === 'running'
          ? { snapshot, view, soul }
          : null
      }, 60_000)
      expect(closeOutcome.soul.desiredState).toBe('running')
      await expect.poll(async () => visibleManagedTabs(await browserState(page)).length, {
        timeout: 30_000,
      }).toBe(2)

      const stopSoulId = initialSoulIds[1]
      const stopSection = statusPanel.getByRole('region').filter({ hasText: stopSoulId })
      page.once('dialog', (dialog) => void dialog.accept())
      await stopSection.getByRole('button', { name: 'Stop agent' }).click()
      const stopOutcome = await waitForValue('explicitly stopped soul', async () => {
        const snapshot = await rig.inventorySnapshot()
        const soul = latestSoul(snapshot, stopSoulId)
        return soul?.desiredState === 'stopped' && soul?.launchState === 'stopped'
          ? { snapshot, soul }
          : null
      }, 90_000)
      expect(stopOutcome.soul.cleanupState).toBe('verified_empty')

      const compatibilitySoulId = initialSoulIds[2]
      const compatibilitySoul = latestSoul(await rig.inventorySnapshot(), compatibilitySoulId)
      if (!compatibilitySoul?.terminalCreateRequestId || !compatibilitySoul?.terminalId) {
        throw new Error('compatibility soul lacks durable terminal/create identity')
      }
      const receiptCountBefore = rig.runtime.broker.receipts().length
      oldClient = await RawWsClient.connect(info.baseUrl, info.token)
      oldClient.send({
        type: 'terminal.create',
        requestId: compatibilitySoul.terminalCreateRequestId,
        shell: 'system',
        mode: compatibilitySoul.terminalMode || 'shell',
        cwd: compatibilitySoul.terminalCwd || rig.repoRoot,
        tabId: 'old-client-tab',
        paneId: 'old-client-pane',
        restore: true,
      })
      const createdReply = await oldClient.waitFor(
        (message) => message.type === 'terminal.created'
          && message.requestId === compatibilitySoul.terminalCreateRequestId,
        30_000,
        'compatibility terminal.created',
      )
      expect(createdReply.terminalId).toBe(compatibilitySoul.terminalId)
      expect(rig.runtime.broker.receipts()).toHaveLength(receiptCountBefore)
      expect(latestSoul(await rig.inventorySnapshot(), compatibilitySoulId)?.launchState).toBe('running')

      const finalState = await browserState(page)
      const receipt = {
        schemaVersion: 1,
        status: 'PASS',
        candidateSha: rig.runtime.candidateSha,
        browser: {
          browserInteraction: true,
          coldStartAgents: 3,
          restartCycles: 3,
          deterministicPlacement: recoveredPaneIds.join('|') === expectedPaneIds.join('|'),
          singleViewPerIntent: new Set(
            finalState.tabs.tabs
              .map((tab: any) => tab.viewIntentId)
              .filter(Boolean),
          ).size === finalState.tabs.tabs.filter((tab: any) => tab.viewIntentId).length,
          existingLayoutPreserved: Boolean(finalState.tabs.tabs.find((tab: any) => tab.id === browserTabId)),
          focusStable: finalState.tabs.activeTabId === browserTabId,
          sameSoulIds: initialSoulIds.every((soulId: string) => (
            afterRestarts.souls.some((soul: any) => soul.soulId === soulId)
          )),
          noBlankSubstitution: initialSoulIds.every((soulId: string) => {
            const before = initialRuntimeIdentity.get(soulId) as any
            const after = latestSoul(afterRestarts, soulId)
            return after?.terminalId === before.terminalId
          }),
          closeViewKeepsAgent: closeOutcome.soul.launchState === 'running',
          stopAgentStopsRuntime: stopOutcome.soul.launchState === 'stopped',
          oldClientNoDuplicate: createdReply.terminalId === compatibilitySoul.terminalId
            && rig.runtime.broker.receipts().length === receiptCountBefore,
          initialSoulIds,
          expectedTabIds,
          expectedPaneIds,
          browserTabId,
          createdTabIds: created.map((response) => response.tabId),
        },
      }
      const receiptPath = rig.writePhase4BrowserReceipt(receipt)
      // eslint-disable-next-line no-console
      console.log(`[P4-G08] runtime tab rehydration receipt: ${receiptPath}`)
    } finally {
      oldClient?.close()
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
