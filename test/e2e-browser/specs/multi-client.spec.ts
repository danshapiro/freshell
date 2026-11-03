import fs from 'fs/promises'
import path from 'path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { createE2eBrowserContext, test, expect } from '../helpers/fixtures.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { installRecoveryOfferAutoDeclineOnContext } from '../helpers/recovery-offer.js'

// This spec uses same-device pages, so its manual context selects the test's
// fixture-owned machine before the first navigation.
async function newClientContext(
  browser: Browser,
  serverInfo: E2eServerInfo,
  e2eMachineId: string,
): Promise<BrowserContext> {
  const context = await createE2eBrowserContext(browser, serverInfo, e2eMachineId)
  installRecoveryOfferAutoDeclineOnContext(context)
  return context
}

// Helper: wait for a page to be connected and ready
async function waitForReady(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 15_000 })
  await page.waitForFunction(() =>
    window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready',
    { timeout: 15_000 }
  )
}

async function ensureTerminalReady(page: Page): Promise<void> {
  // Share the existing render window across the tab, picker, and xterm.
  const deadline = Date.now() + 30_000
  const remaining = () => Math.max(1, deadline - Date.now())
  let tabId = ''
  await expect.poll(async () => {
    tabId = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState().tabs.activeTabId ?? '')
    return tabId
  }, { timeout: remaining() }).not.toBe('')
  const content = page.locator(`[data-tab-content-id="${tabId}"]`)
  const terminal = content.locator('.xterm').first()
  const picker = content.getByRole('toolbar', { name: /pane type picker/i })
  await expect.poll(async () => await terminal.isVisible() || await picker.isVisible(), {
    timeout: remaining(),
  }).toBe(true)
  if (!(await terminal.isVisible())) {
    await picker.getByRole('button', { name: /^(Shell|WSL|CMD|PowerShell|Bash)$/i })
      .first().press('Enter', { timeout: Math.min(5_000, remaining()) })
  }
  await terminal.waitFor({ state: 'visible', timeout: remaining() })
  await page.waitForFunction((id) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const readTerminalId = (node: any): string | undefined => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'terminal') return node.content.terminalId
      for (const child of node.children ?? []) {
        const found = readTerminalId(child)
        if (found) return found
      }
      return undefined
    }
    const terminalId = readTerminalId(harness?.getState().panes.layouts[id])
    return Boolean(terminalId && harness?.getTerminalBuffer(terminalId)?.length)
  }, tabId, { timeout: 20_000 })
}

async function executeCommand(page: Page, command: string): Promise<void> {
  await page.locator('.xterm').first().click()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

async function waitForTerminalText(page: Page, text: string, terminalId?: string, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    ({ searchText, id }) => window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(id)?.includes(searchText) ?? false,
    { searchText: text, id: terminalId },
    { timeout },
  )
}

async function getActiveTerminalId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const activeTabId = state?.tabs?.activeTabId
    const layout = activeTabId ? state?.panes?.layouts?.[activeTabId] : null

    const readTerminalId = (node: any): string | null => {
      if (!node) return null
      if (node.type === 'leaf' && node.content?.kind === 'terminal') {
        return typeof node.content.terminalId === 'string' ? node.content.terminalId : null
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) {
          const terminalId = readTerminalId(child)
          if (terminalId) return terminalId
        }
      }
      return null
    }

    return readTerminalId(layout)
  })
}

async function waitForActiveTerminalId(page: Page, timeout = 20_000): Promise<string> {
  let latest: string | null = null
  await expect(async () => {
    latest = await getActiveTerminalId(page)
    expect(latest).toBeTruthy()
  }).toPass({ timeout })
  if (!latest) throw new Error('Expected the active tab to expose a terminalId')
  return latest
}

async function waitForTabWithTerminalId(page: Page, expectedTerminalId: string, timeout = 20_000): Promise<string> {
  await page.waitForFunction((terminalId) => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()

    const readTerminalId = (node: any): string | null => {
      if (!node) return null
      if (node.type === 'leaf' && node.content?.kind === 'terminal') {
        return typeof node.content.terminalId === 'string' ? node.content.terminalId : null
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) {
          const childTerminalId = readTerminalId(child)
          if (childTerminalId) return childTerminalId
        }
      }
      return null
    }

    const layouts = state?.panes?.layouts ?? {}
    return Object.entries(layouts).some(([, layout]) => readTerminalId(layout) === terminalId)
  }, expectedTerminalId, { timeout })

  const tabId = await page.evaluate((terminalId) => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const layouts = state?.panes?.layouts ?? {}

    const readTerminalId = (node: any): string | null => {
      if (!node) return null
      if (node.type === 'leaf' && node.content?.kind === 'terminal') {
        return typeof node.content.terminalId === 'string' ? node.content.terminalId : null
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) {
          const childTerminalId = readTerminalId(child)
          if (childTerminalId) return childTerminalId
        }
      }
      return null
    }

    for (const [tabId, layout] of Object.entries(layouts)) {
      if (readTerminalId(layout) === terminalId) return tabId
    }
    return null
  }, expectedTerminalId)

  if (!tabId) {
    throw new Error(`Expected to find a tab containing terminal ${expectedTerminalId}`)
  }

  return tabId
}

async function readMarkedPtySize(page: Page, marker: string, terminalId?: string): Promise<string | null> {
  return page.evaluate(({ id, label }) => {
    const buffer = window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(id) ?? ''
    const regex = new RegExp(`${label}:(\\d+\\s+\\d+)`, 'g')
    let match: RegExpExecArray | null = null
    let last: string | null = null
    while ((match = regex.exec(buffer)) !== null) {
      last = match[1] ?? null
    }
    return last
  }, { id: terminalId, label: marker })
}

async function waitForMarkedPtySize(page: Page, marker: string, terminalId?: string, timeout = 15_000): Promise<string> {
  await page.waitForFunction(({ id, label }) => {
    const buffer = window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(id) ?? ''
    return new RegExp(`${label}:(\\d+\\s+\\d+)`).test(buffer)
  }, { id: terminalId, label: marker }, { timeout })

  const size = await readMarkedPtySize(page, marker, terminalId)
  if (!size) {
    throw new Error(`Expected to parse PTY size marker ${marker}`)
  }
  return size
}

async function flushPersistedLayout(page: Page, terminalId: string): Promise<void> {
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
  await page.waitForFunction((id) => {
    const raw = window.localStorage.getItem(`freshell.layout.v3.${sessionStorage.getItem('freshell.layout-window-id.v1')}`)
    return typeof raw === 'string' && raw.includes(id)
  }, terminalId, { timeout: 10_000 })
}

async function activateTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: id })
  }, tabId)
  await page.waitForFunction((id) => window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId === id, tabId, { timeout: 10_000 })
}

type ReceivedWsFrame = Record<string, unknown> & { type?: string }

function captureReceivedWsFrames(page: Page) {
  type Waiter = {
    predicate: (frame: ReceivedWsFrame) => boolean
    resolve: (frame: ReceivedWsFrame) => void
  }

  const frames: ReceivedWsFrame[] = []
  const waiters = new Set<Waiter>()
  page.on('websocket', (ws) => {
    ws.on('framereceived', (ev) => {
      const payload = typeof ev.payload === 'string' ? ev.payload : ev.payload.toString('utf8')
      let frame: ReceivedWsFrame
      try {
        const parsed = JSON.parse(payload)
        if (!parsed || typeof parsed !== 'object') return
        frame = parsed as ReceivedWsFrame
      } catch {
        return
      }
      frames.push(frame)
      for (const waiter of [...waiters]) {
        if (waiter.predicate(frame)) waiter.resolve(frame)
      }
    })
  })

  return {
    frames,
    clear() {
      frames.length = 0
    },
    waitForFrame(
      predicate: (frame: ReceivedWsFrame) => boolean,
      description: string,
      timeoutMs: number,
    ): Promise<ReceivedWsFrame> {
      const existing = frames.find(predicate)
      if (existing) return Promise.resolve(existing)

      return new Promise((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>
        const waiter: Waiter = {
          predicate,
          resolve: (frame) => {
            clearTimeout(timeout)
            waiters.delete(waiter)
            resolve(frame)
          },
        }
        timeout = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`Timed out waiting for ${description}; received frames: ${JSON.stringify(frames)}`))
        }, timeoutMs)
        waiters.add(waiter)
      })
    },
  }
}

test.describe('Multi-Client', () => {
  test('two browser tabs share the same server', async ({ browser, serverInfo, e2eMachineId }) => {
    // Open two pages to the same server
    const context = await newClientContext(browser, serverInfo, e2eMachineId)
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    // Both should connect successfully
    await waitForReady(page1)
    await waitForReady(page2)

    await context.close()
  })

  test('terminal output appears in both clients', async ({ browser, serverInfo, e2eMachineId }) => {
    const context = await newClientContext(browser, serverInfo, e2eMachineId)
    const page1 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page1)
    await ensureTerminalReady(page1)

    const terminalId = await getActiveTerminalId(page1)
    expect(terminalId).toBeTruthy()
    await flushPersistedLayout(page1, terminalId!)

    const page2 = await context.newPage()
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page2)
    const sharedTabId = await waitForTabWithTerminalId(page2, terminalId!)
    await activateTab(page2, sharedTabId)

    await executeCommand(page1, 'echo "multi-client-marker"')

    await waitForTerminalText(page1, 'multi-client-marker', terminalId!)
    await waitForTerminalText(page2, 'multi-client-marker', terminalId!)

    await context.close()
  })

  test('reconnecting second viewer keeps page 1 PTY size stable and both pages keep shared output', async ({ browser, serverInfo, e2eMachineId }) => {
    const context = await newClientContext(browser, serverInfo, e2eMachineId)
    const page1 = await context.newPage()
    await page1.setViewportSize({ width: 1500, height: 980 })

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page1)
    await ensureTerminalReady(page1)

    const terminalId = await getActiveTerminalId(page1)
    expect(terminalId).toBeTruthy()
    await flushPersistedLayout(page1, terminalId!)

    const page2 = await context.newPage()
    await page2.setViewportSize({ width: 920, height: 640 })
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page2)
    const sharedTabId = await waitForTabWithTerminalId(page2, terminalId!)
    await activateTab(page2, sharedTabId)
    const receivedFrames = captureReceivedWsFrames(page2)

    await executeCommand(page1, 'echo "__MULTI_CLIENT_READY__"')
    await waitForTerminalText(page1, '__MULTI_CLIENT_READY__', terminalId!)
    await waitForTerminalText(page2, '__MULTI_CLIENT_READY__', terminalId!)

    await executeCommand(page1, 'printf "__PTY_SIZE_BEFORE__:%s\\n" "$(stty size)"')
    const beforeSize = await waitForMarkedPtySize(page1, '__PTY_SIZE_BEFORE__', terminalId!)

    receivedFrames.clear()
    await page2.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.clearSentWsMessages?.()
      window.__FRESHELL_TEST_HARNESS__?.forceDisconnect()
    })

    await waitForReady(page2)
    await waitForTerminalText(page2, '__MULTI_CLIENT_READY__', terminalId!)

    await page2.waitForFunction(() => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((msg: any) => msg?.type === 'pane.reconcile.request' && typeof msg?.reconcileId === 'string')
    }, {}, { timeout: 20_000 })
    const reconnectReconcileId = await page2.evaluate(() => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      const request = [...sent].reverse().find((msg: any) =>
        msg?.type === 'pane.reconcile.request' && typeof msg?.reconcileId === 'string') as { reconcileId: string } | undefined
      return request?.reconcileId ?? null
    })
    expect(reconnectReconcileId).toBeTruthy()
    await receivedFrames.waitForFrame(
      (frame) => frame.type === 'pane.reconcile.result' && frame.reconcileId === reconnectReconcileId,
      `pane.reconcile.result for reconnect ${reconnectReconcileId}`,
      20_000,
    )

    // Wait for page2 to have re-attached to the terminal after the forced
    // disconnect, then assert on what actually got sent.
    //
    // This used to require EXACTLY ONE terminal.attach with
    // intent === 'transport_reconnect'. That is the fast, no-op-geometry path
    // TerminalView takes when it reconnects while its own pane is already
    // considered foreground/live (terminal-attach-policy.ts). But whether the
    // client takes that path or the slower "hidden pane reveal" path
    // (background-hydration attach) depends on the client's internal
    // foreground/hidden bookkeeping at the exact instant the reconnect
    // fires -- timing-sensitive, client-side, and NOT something a
    // wait/serialize change in this spec can pin. Under real host load this
    // repo's build+test contention reliably tips it into the
    // background-hydration path (reproduced deterministically here, not
    // occasionally); on a quiet host it can land on transport_reconnect
    // instead -- hence the historical flake, not a too-short wait budget.
    //
    // WIRE-INTENT POLICY (attach-geometry-resume-panes): hidden/background
    // attaches are keepalive_delta BY POLICY -- they never claim geometry;
    // visible foreground attaches remain viewport_hydrate/transport_reconnect.
    // Page2's pane is VISIBLE here, and the foreground reconnect legitimately
    // lands on viewport_hydrate when TerminalView's re-promotion fires
    // (in-flight writes or no usable delta checkpoint -> full replay);
    // verified by wire capture on this test: page2's frames arrive as
    // { intent: 'viewport_hydrate', priority: 'foreground', sinceSeq: 0 }.
    // If the client's hidden bookkeeping instead routes the reconnect through
    // the background-hydration queue, the hidden clamp makes the wire token
    // keepalive_delta with priority background -- replay-identical but
    // geometry-neutral. The accepted reconnect-shaped set is therefore
    // { transport_reconnect, viewport_hydrate, keepalive_delta }; the policy
    // regression (a HIDDEN pane's attach claiming geometry) is pinned exactly
    // by the sibling reload-restore test further down this file, not by this
    // visible-pane scenario.
    //
    // Verified by direct experiment: relaxing this assertion to accept EITHER
    // reconnect-shaped intent and letting the rest of the test run confirms
    // the PTY-size and shared-output checks below (the test's actual
    // documented contract) pass on either path. So the specific intent value
    // within that set is an internal implementation choice, not the behavior
    // this test is meant to guard. What DOES matter, and is still asserted:
    // page2 issued a BOUNDED 1..3 re-attaches for this terminal (not zero --
    // a silently dropped reconnect -- and not a runaway retry storm). The
    // three deliberate sources are TerminalView's reconnect handler, the
    // reconcile-pending lifecycle re-run, and the reconcile attach verdict's
    // reconcileEpoch re-fire. Each is a distinct attach generation using a
    // reconnect-shaped intent from the accepted set above.
    await page2.waitForFunction((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((msg: any) =>
        msg?.type === 'terminal.attach'
        && msg?.terminalId === id
        && (msg?.intent === 'transport_reconnect' || msg?.intent === 'viewport_hydrate' || msg?.intent === 'keepalive_delta')
      )
    }, terminalId!, { timeout: 20_000 })

    const collectReconnectAttachMessages = () => page2.evaluate((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.filter((msg: any) =>
        msg?.type === 'terminal.attach'
        && msg?.terminalId === id
        && (msg?.intent === 'transport_reconnect' || msg?.intent === 'viewport_hydrate' || msg?.intent === 'keepalive_delta')
      )
    }, terminalId!)
    const waitForAttachReadies = (attachRequestIds: string[]) => Promise.all(attachRequestIds.map((attachRequestId) => receivedFrames.waitForFrame(
      (frame) => (
        frame.type === 'terminal.attach.ready'
        && frame.terminalId === terminalId
        && frame.attachRequestId === attachRequestId
      ),
      `terminal.attach.ready for reconnect attach ${attachRequestId}`,
      20_000,
    )))

    let reconnectAttachMessages = await collectReconnectAttachMessages()
    let reconnectAttachRequestIds = reconnectAttachMessages.map((message: any) => message.attachRequestId)
    expect(reconnectAttachRequestIds.every((requestId) => typeof requestId === 'string' && requestId.length > 0)).toBe(true)
    expect(new Set(reconnectAttachRequestIds).size).toBe(reconnectAttachRequestIds.length)
    await waitForAttachReadies(reconnectAttachRequestIds)

    // A lifecycle re-run can be scheduled while an earlier attach is
    // settling, so close the observation window only after the resulting
    // generation(s) have their own ready receipts too. This remains bounded:
    // the contract below rejects a fourth attach.
    reconnectAttachMessages = await collectReconnectAttachMessages()
    reconnectAttachRequestIds = reconnectAttachMessages.map((message: any) => message.attachRequestId)
    expect(reconnectAttachRequestIds.every((requestId) => typeof requestId === 'string' && requestId.length > 0)).toBe(true)
    expect(new Set(reconnectAttachRequestIds).size).toBe(reconnectAttachRequestIds.length)
    await waitForAttachReadies(reconnectAttachRequestIds)
    expect(reconnectAttachMessages.length).toBeGreaterThanOrEqual(1)
    expect(reconnectAttachMessages.length).toBeLessThanOrEqual(3)

    await executeCommand(page1, 'printf "__PTY_SIZE_AFTER__:%s\\n" "$(stty size)"')
    const afterSize = await waitForMarkedPtySize(page1, '__PTY_SIZE_AFTER__', terminalId!)
    expect(afterSize).toBe(beforeSize)

    await executeCommand(page1, 'echo "__AFTER_PAGE2_RECONNECT__"')
    await waitForTerminalText(page1, '__AFTER_PAGE2_RECONNECT__', terminalId!)
    await waitForTerminalText(page2, '__AFTER_PAGE2_RECONNECT__', terminalId!)

    await context.close()
  })

  // ------------------------------------------------------------------
  // Geometry authority regression (attach-geometry-resume-panes): a
  // reload-restored tab that boots HIDDEN must never claim viewport geometry
  // on the wire. Negotiated lifetime claims keep the hidden terminal alive
  // without attaching or resizing it. Reveal attaches, replays the retained
  // scrollback, and applies viewport geometry, which stty confirms.
  // ------------------------------------------------------------------
  test('reload-restored background tab claims its terminal until reveal restores scrollback and geometry', async ({ browser, serverInfo, e2eMachineId }) => {
    test.setTimeout(120_000)
    const context = await newClientContext(browser, serverInfo, e2eMachineId)
    const page = await context.newPage()

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await ensureTerminalReady(page)

    // T-A stays the active tab across the reload.
    const tabAId = await page.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId ?? null
    )
    expect(tabAId).toBeTruthy()
    const terminalAId = await waitForActiveTerminalId(page)

    // T-B is created and driven once, then hidden behind T-A -- after the
    // reload it is the pane that mounts hidden at boot.
    await page.locator('[data-context="tab-add"]').click()
    await page.waitForFunction((prevTabId) => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return state?.tabs?.tabs?.length === 2 && state?.tabs?.activeTabId !== prevTabId
    }, tabAId, { timeout: 10_000 })
    const tabBId = await page.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId ?? null
    )
    expect(tabBId).toBeTruthy()

    // A fresh tab may show a PanePicker; select a shell for it. The picker
    // and terminal are scoped to T-B -- T-A's terminal stays mounted (just
    // hidden), so an unscoped `.xterm` could resolve to the wrong pane.
    const tabBTerminal = page.locator(`[data-context="terminal"][data-tab-id="${tabBId}"]`)
    const tabBPicker = page.locator(`[data-context="pane-picker"][data-tab-id="${tabBId}"]`)
    await page.waitForTimeout(500)
    const tabBXtermVisible = await tabBTerminal.locator('.xterm').first().isVisible().catch(() => false)
    if (!tabBXtermVisible) {
      for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
        try {
          const button = tabBPicker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
          if (await button.isVisible().catch(() => false)) {
            await button.click({ timeout: 5000 })
            break
          }
        } catch {
          continue
        }
      }
    }
    await tabBTerminal.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
    const terminalBId = await waitForActiveTerminalId(page)
    expect(terminalBId).not.toBe(terminalAId)

    // Leave a marker in T-B's scrollback. The hidden tab does not hydrate on
    // reload; the marker must reappear when reveal attaches and replays it.
    await tabBTerminal.locator('.xterm').first().click()
    await page.keyboard.type('echo __PRE_RELOAD_MARKER__')
    await page.keyboard.press('Enter')
    await waitForTerminalText(page, '__PRE_RELOAD_MARKER__', terminalBId)

    await activateTab(page, tabAId!)
    await flushPersistedLayout(page, terminalBId)

    // Reload in the SAME context: both tabs restore from persistence; T-A is
    // active/visible and T-B's pane mounts hidden.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForReady(page)
    await waitForTabWithTerminalId(page, terminalBId)
    const restored = await page.evaluate(() => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return {
        activeTabId: state?.tabs?.activeTabId ?? null,
        tabCount: state?.tabs?.tabs?.length ?? 0,
      }
    })
    expect(restored.tabCount).toBe(2)
    expect(restored.activeTabId).toBe(tabAId)

    // The reload installed a fresh harness, so getSentWsMessages records
    // everything since boot. The negotiated interest snapshot must claim T-B
    // while classifying it as hidden. No attach or resize may target T-B yet.
    await page.waitForFunction((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((msg: any) =>
        msg?.type === 'terminal.interest'
        && Array.isArray(msg?.claimedTerminalIds)
        && msg.claimedTerminalIds.includes(id)
        && !msg.visibleTerminalIds?.includes(id)
        && msg.focusedTerminalId !== id)
    }, terminalBId, { timeout: 45_000 })
    await page.waitForTimeout(500)

    const hiddenGeometryMessages: any[] = await page.evaluate((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.filter((msg: any) =>
        (msg?.type === 'terminal.attach' || msg?.type === 'terminal.resize')
        && msg?.terminalId === id)
    }, terminalBId)
    expect(
      hiddenGeometryMessages,
      `a hidden pane must claim lifetime without attaching or resizing; got: ${JSON.stringify(hiddenGeometryMessages)}`,
    ).toHaveLength(0)

    // Reveal T-B. This first attach hydrates the fresh xterm surface, and
    // the retained marker proves the replay reached that surface.
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.clearSentWsMessages?.()
    })
    await activateTab(page, tabBId!)
    await page.waitForFunction((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((msg: any) => msg?.type === 'terminal.attach' && msg?.terminalId === id)
    }, terminalBId, { timeout: 15_000 })
    await waitForTerminalText(page, '__PRE_RELOAD_MARKER__', terminalBId, 45_000)
    const afterReveal: any[] = await page.evaluate((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.filter((msg: any) =>
        (msg?.type === 'terminal.attach' || msg?.type === 'terminal.resize')
        && msg?.terminalId === id)
    }, terminalBId)
    const revealAttaches = afterReveal.filter((msg: any) => msg.type === 'terminal.attach')
    expect(
      revealAttaches.some((msg: any) => msg.surfaceReset === true && msg.sinceSeq === 0),
      `reveal must hydrate the new surface from retained history; got: ${JSON.stringify(revealAttaches)}`,
    ).toBe(true)
    const lastGeometry = afterReveal[afterReveal.length - 1]
    expect(lastGeometry.cols).toBeGreaterThan(0)
    expect(lastGeometry.rows).toBeGreaterThan(0)

    // Kernel cross-check: the PTY's actual winsize must equal the dims the
    // reveal's latest attach or resize claimed. Poll until the server applies
    // that frame; each attempt asks stty again and reads the latest marker.
    let geometryAttempt = 0
    await expect(async () => {
      const marker = `__AXIS_${geometryAttempt++}__`
      await tabBTerminal.locator('.xterm').first().click()
      await page.keyboard.type(`echo ${marker}:$(stty size)`)
      await page.keyboard.press('Enter')
      const kernelSize = await waitForMarkedPtySize(page, marker, terminalBId)
      expect(kernelSize).toBe(`${lastGeometry.rows} ${lastGeometry.cols}`)
    }).toPass({ timeout: 15_000, intervals: [250, 500, 1_000] })

    await context.close()
  })

  test('settings change broadcasts to other clients', async ({ browser, serverInfo, e2eMachineId }) => {
    const context = await newClientContext(browser, serverInfo, e2eMachineId)
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    await waitForReady(page1)
    await waitForReady(page2)

    const sharedDefaultCwd = path.join(serverInfo.homeDir, 'multi-client-default-cwd')
    await fs.mkdir(sharedDefaultCwd, { recursive: true })

    // Get initial default cwd from page2 before changing it server-side.
    const settingsBefore = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.defaultCwd
    )

    // Change a server-backed field from page1 via the API.
    const patchResponse = await page1.evaluate(async (info) => {
      const res = await fetch(`${info.baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': info.token,
        },
        body: JSON.stringify({
          defaultCwd: info.defaultCwd,
        }),
      })
      return { ok: res.ok, status: res.status }
    }, { baseUrl: serverInfo.baseUrl, token: serverInfo.token, defaultCwd: sharedDefaultCwd })

    expect(patchResponse.ok).toBe(true)

    // Wait for page2 to receive the broadcast and update its settings
    await page2.waitForFunction(
      (expectedDefaultCwd) => {
        const current = window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.defaultCwd
        return current === expectedDefaultCwd
      },
      sharedDefaultCwd,
      { timeout: 15_000 }
    )

    const settingsAfter = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.defaultCwd
    )
    expect(settingsAfter).toBe(sharedDefaultCwd)
    expect(settingsAfter).not.toBe(settingsBefore)

    await context.close()
  })

  test('server handles many concurrent connections', async ({ browser, serverInfo, e2eMachineId }) => {
    const context = await newClientContext(browser, serverInfo, e2eMachineId)
    const pages = []

    // Open 5 pages
    for (let i = 0; i < 5; i++) {
      const page = await context.newPage()
      await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
      pages.push(page)
    }

    // All should connect
    for (const page of pages) {
      await page.waitForFunction(() =>
        window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready',
        { timeout: 20_000 }
      )
    }

    await context.close()
  })

  test('mode replay-sync: fresh surface restores mouse tracking + alt buffer after reload, and claims surfaceReset', async ({ browser, serverInfo, e2eMachineId }) => {
    // Regression coverage: an app arms DEC private modes ONCE at startup;
    // the retained replay window does not carry those bytes back, so a
    // freshly-constructed surface (page reload) used to rehydrate contents
    // but lose e.g. mouse-scroll forwarding. The server tracks a per-terminal
    // mode projection and answers surfaceReset attaches with ONE
    // terminal.modes.sync preamble (ready < sync < replay).
    test.setTimeout(120_000)
    const context = await newClientContext(browser, serverInfo, e2eMachineId)
    const page = await context.newPage()
    await page.setViewportSize({ width: 1400, height: 900 })
    const receivedFrames = captureReceivedWsFrames(page)
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await ensureTerminalReady(page)

    const terminalId = await getActiveTerminalId(page)
    expect(terminalId).toBeTruthy()
    await flushPersistedLayout(page, terminalId!)

    // Arm the modes like an app would (once, at startup): any-motion mouse +
    // SGR encoding + alt buffer + XTMODIFYKEYS (tracked per fixture f08 but
    // never replayed; harmless to send). Then heartbeat a marker so we can
    // discriminate hydration completion after the reload wedge.
    await executeCommand(page, `printf '\\x1b[?1003h\\x1b[?1006h\\x1b[?1049h\\x1b[>4;1m'; echo __MODE_SYNC_MARK__`)
    await page.waitForFunction((id) => {
      const modes = window.__FRESHELL_TEST_HARNESS__?.getTerminalModes?.(id)
      return modes?.mouseTrackingMode === 'any' && modes?.bufferType === 'alternate'
    }, terminalId, { timeout: 15_000 })
    await waitForTerminalText(page, '__MODE_SYNC_MARK__', terminalId!)

    // Reload: fresh xterm surface, full rehydrate via surfaceReset attach.
    receivedFrames.clear()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForReady(page)
    await page.waitForFunction(() => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((m: any) => m?.type === 'terminal.attach')
    }, {}, { timeout: 15_000 })

    // The post-reload attach of the fresh surface must CLAIM the marker AND
    // force a full wipe+hydrate (no delta continuation on a blank surface).
    await page.waitForFunction((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((m: any) =>
        m?.type === 'terminal.attach'
        && m?.terminalId === id
        && m?.surfaceReset === true
        && m?.sinceSeq === 0)
    }, terminalId, { timeout: 45_000 })
    const reloadAttaches: any[] = await page.evaluate((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.filter((m: any) => m?.type === 'terminal.attach' && m?.terminalId === id)
    }, terminalId)
    // The fresh window may legitimately claim on MORE than one attach: a boot
    // attach can be superseded by a second (viewport settling) before any
    // replay content of the first applies — the claim only clears on
    // marker-generation content/completion (coupled trap-door semantics).
    // What is guaranteed: ≥1 claim, and every claim is a full wipe+hydrate.
    const claimed = reloadAttaches.filter((m) => m.surfaceReset === true)
    expect(
      claimed.length,
      `fresh surface must claim surfaceReset at least once; got: ${JSON.stringify(reloadAttaches)}`,
    ).toBeGreaterThanOrEqual(1)
    expect(claimed.every((m) => m.sinceSeq === 0),
      `every fresh claim must force a full hydrate (sinceSeq 0); got: ${JSON.stringify(reloadAttaches)}`).toBe(true)
    const claimedAttachRequestIds = new Set(claimed
      .map((attach) => attach.attachRequestId)
      .filter((attachRequestId): attachRequestId is string => typeof attachRequestId === 'string'))
    expect(claimedAttachRequestIds.size).toBeGreaterThanOrEqual(1)

    // The sync preamble must have RE-ARMED the modes on the fresh surface —
    // and the mechanism is asserted at the wire level, not only by outcome:
    // exactly the claimed attaches received compound preambles containing
    // the armed modes' bytes.
    await page.waitForFunction((id) => {
      const modes = window.__FRESHELL_TEST_HARNESS__?.getTerminalModes?.(id)
      return modes?.mouseTrackingMode === 'any' && modes?.bufferType === 'alternate'
    }, terminalId, { timeout: 45_000 })
    await receivedFrames.waitForFrame(
      (frame) => (
        frame.type === 'terminal.modes.sync'
        && frame.terminalId === terminalId
        && typeof frame.attachRequestId === 'string'
        && claimedAttachRequestIds.has(frame.attachRequestId)
        && typeof frame.data === 'string'
      ),
      'terminal.modes.sync for a claimed post-reload surface-reset attach',
      45_000,
    )
    const syncFrames = receivedFrames.frames.filter((frame): frame is ReceivedWsFrame & {
      terminalId: string
      attachRequestId: string
      data: string
    } => (
      frame.type === 'terminal.modes.sync'
      && frame.terminalId === terminalId
      && typeof frame.attachRequestId === 'string'
      && claimedAttachRequestIds.has(frame.attachRequestId)
      && typeof frame.data === 'string'
    ))
    expect(
      syncFrames.length,
      'a fresh-reload attach must receive at least one terminal.modes.sync frame',
    ).toBeGreaterThanOrEqual(1)
    expect(syncFrames.every((frame) => (
      frame.data.includes('\u001b[?1003h')
      && frame.data.includes('\u001b[?1006h')
      && frame.data.includes('\u001b[?1049h')
    ))).toBe(true)

    // Consumption: once hydration of the marker attach completed, a later
    // transport-level reconnect must NOT re-claim (stuck markers would force
    // sinceSeq=0 replays that duplicate scrollback).
    await waitForTerminalText(page, '__MODE_SYNC_MARK__', terminalId!, 45_000)
    // A same-server reconnect must supply its own ready and attach receipts;
    // neither a cached ready state nor an earlier attach proves consumption.
    const reconnectDeadline = Date.now() + 45_000
    const reconnectRemaining = () => Math.max(1, reconnectDeadline - Date.now())
    receivedFrames.clear()
    await page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.clearSentWsMessages?.()
      harness?.forceDisconnect()
    })
    await receivedFrames.waitForFrame(
      (frame) => frame.type === 'ready',
      'ready from the same-surface reconnect',
      reconnectRemaining(),
    )
    let reconnectAttachRequestId: string | undefined
    await expect.poll(async () => {
      reconnectAttachRequestId = await page.evaluate((id) => {
        const harness = window.__FRESHELL_TEST_HARNESS__
        if (harness?.getWsReadyState() !== 'ready' || harness.getState().connection.status !== 'ready') return undefined
        const sent = harness.getSentWsMessages?.() ?? []
        const attach = [...sent].reverse().find((msg: any) =>
          msg?.type === 'terminal.attach'
          && msg?.terminalId === id
          && msg?.surfaceReset !== true
          && typeof msg?.attachRequestId === 'string'
          && msg.attachRequestId.length > 0) as { attachRequestId: string } | undefined
        return attach?.attachRequestId
      }, terminalId)
      return reconnectAttachRequestId
    }, { timeout: reconnectRemaining() }).toBeTruthy()
    await receivedFrames.waitForFrame(
      (frame) => frame.type === 'terminal.attach.ready'
        && frame.terminalId === terminalId
        && frame.attachRequestId === reconnectAttachRequestId,
      `attach.ready for same-surface reconnect ${reconnectAttachRequestId}`,
      reconnectRemaining(),
    )

    // Wheel over the pane must now forward SGR mouse reports on the wire.
    await page.evaluate(() => { window.__FRESHELL_TEST_HARNESS__?.clearSentWsMessages?.() })
    const xterm = page.locator('.xterm').first()
    const box = await xterm.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, -120)
    await page.waitForFunction((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((m: any) =>
        m?.type === 'terminal.input'
        && m?.terminalId === id
        && typeof m?.data === 'string'
        && m.data.includes('\u001b[<64;'))
    }, terminalId, { timeout: 15_000 })

    await context.close()
  })

  test('mode replay-sync: sync preamble is ordered before replay and excludes ?1004 (junk-focus hazard)', async ({ browser, serverInfo, e2eMachineId }) => {
    // xterm 6.0.0 fires onRequestSendFocus on EVERY ?1004 arm, and
    // _reportFocus immediately emits ESC[I/ESC[O on a focused surface — so a
    // sync preamble replaying ?1004h would deterministically inject junk
    // into the app's stdin. The preamble therefore tracks but NEVER emits
    // ?1004. (Replaying the ORIGINAL arming byte from the retained window no
    // longer leaks either: kata 9gy8 silences the phantom report at onData;
    // pinned by "mode replay-sync: replay no longer injects phantom xterm
    // focus reports (kata 9gy8)" later in this spec.)
    //
    // This pins the wire behavior DIRECTLY: arm both a representative mode
    // (?2004, included) and ?1004, reload (fresh surface → surfaceReset
    // attach), then observe the live ws frames: exactly one modes.sync frame,
    // it precedes every replay frame, its data contains ?2004h, never 1004.
    test.setTimeout(120_000)
    const context = await newClientContext(browser, serverInfo, e2eMachineId)
    const page = await context.newPage()

    const syncFrames: Array<{ data: string; attachRequestId: string }> = []
    const frameOrder: Array<'sync' | 'replay' | 'other'> = []
    page.on('websocket', (ws) => {
      ws.on('framereceived', (ev) => {
        const payload = typeof ev.payload === 'string' ? ev.payload : ev.payload.toString('utf8')
        let msg: any
        try { msg = JSON.parse(payload) } catch { return }
        if (msg?.type === 'terminal.modes.sync' && typeof msg?.data === 'string') {
          syncFrames.push(msg)
          frameOrder.push('sync')
        } else if (msg?.type === 'terminal.output' || msg?.type === 'terminal.output.batch') {
          frameOrder.push(msg?.source === 'replay' ? 'replay' : 'other')
        }
      })
    })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await ensureTerminalReady(page)
    const terminalId = await getActiveTerminalId(page)
    expect(terminalId).toBeTruthy()
    await flushPersistedLayout(page, terminalId!)

    // Arm ?2004h (must be replayed by the preamble) and ?1004h (must NOT).
    await executeCommand(page, `printf '\\x1b[?2004h\\x1b[?1004h'; echo __HAZARD_ARMED__`)
    await waitForTerminalText(page, '__HAZARD_ARMED__', terminalId!)
    await page.waitForFunction((id) => {
      const modes = window.__FRESHELL_TEST_HARNESS__?.getTerminalModes?.(id)
      return modes?.sendFocusMode === true && modes?.bracketedPasteMode === true
    }, terminalId, { timeout: 15_000 })

    syncFrames.length = 0
    frameOrder.length = 0
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForReady(page)

    // Wait for the sync frame for our terminal (its attach claims
    // surfaceReset; the marker text proves hydration of that attach began).
    await page.waitForFunction(() => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((m: any) => m?.type === 'terminal.attach' && m?.surfaceReset === true)
    }, {}, { timeout: 45_000 })
    await waitForTerminalText(page, '__HAZARD_ARMED__', terminalId!, 45_000)
    await page.waitForTimeout(400)

    // The fresh window may legitimately produce >1 claimed attach (boot
    // viewport settling supersedes the first attach before its content
    // applies — the claim only clears on marker-completion). Every claimed
    // attach gets its own sync; ALL of them must carry the same projection.
    const mine = syncFrames
    expect(
      mine.length,
      `expected at least one terminal.modes.sync frame post-reload; got ${JSON.stringify(syncFrames)}`,
    ).toBeGreaterThanOrEqual(1)
    expect(mine.every((f) => f.data === mine[0].data),
      `every claimed attach must receive the identical preamble; got ${JSON.stringify(syncFrames)}`).toBe(true)
    const sync = mine[0]
    expect(sync.data).toContain('\u001b[?2004h')
    expect(
      sync.data.includes('1004'),
      `sync preamble must never re-arm ?1004 (xterm junk-focus hazard); got: ${JSON.stringify(sync.data)}`,
    ).toBe(false)
    const firstReplay = frameOrder.indexOf('replay')
    const firstSync = frameOrder.indexOf('sync')
    expect(firstSync).toBeGreaterThanOrEqual(0)
    expect(
      firstReplay === -1 || firstSync < firstReplay,
      `sync must precede replay on the wire; got order: ${frameOrder.join(',')}`,
    ).toBe(true)

    // The fresh surface must carry bracketed-paste (from the preamble) and
    // must NOT have focus reporting armed.
    await page.waitForFunction((id) => {
      const modes = window.__FRESHELL_TEST_HARNESS__?.getTerminalModes?.(id)
      return modes?.bracketedPasteMode === true
    }, terminalId, { timeout: 20_000 })

    await context.close()
  })

  test('mode replay-sync: replay no longer injects phantom xterm focus reports (kata 9gy8)', async ({ browser, serverInfo, e2eMachineId }) => {
    // Kata 9gy8 wire proof. xterm 6.0.0 re-fires the app's ?1004 focus-report
    // switch on EVERY ?1004h parse — including when the arming byte is inside
    // a replayed history chunk (page reload here) — and _reportFocus
    // immediately emits ESC[I (focused surface) / ESC[O (unfocused) as
    // synthetic input. The client gate (TerminalView onData +
    // isReplayPhantomFocusReport) must swallow that invented keypress while
    // the replay write scope is open, so the shell/app never sees an
    // un-requested focus keystroke. The arm itself must survive: the replayed
    // arm byte still sets sendFocusMode on the fresh surface (asserted via
    // the harness modes accessor) — the mode is re-armed, the report is not.
    test.setTimeout(120_000)
    const context = await newClientContext(browser, serverInfo, e2eMachineId)
    const page = await context.newPage()
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page)
    await ensureTerminalReady(page)

    const terminalId = await getActiveTerminalId(page)
    expect(terminalId).toBeTruthy()
    await flushPersistedLayout(page, terminalId!)

    // Arm focus reporting exactly like a terminal app would (keyboard-typed
    // printf, matching the sibling mode-sync specs). The arm byte is now
    // inside the retained replay window, so the reload below re-feeds it to
    // a fresh xterm surface.
    await executeCommand(page, `printf '\\x1b[?1004h'; echo __FOCUS_ARMED__`)
    await waitForTerminalText(page, '__FOCUS_ARMED__', terminalId!)
    await page.waitForFunction((id) => {
      const modes = window.__FRESHELL_TEST_HARNESS__?.getTerminalModes?.(id)
      return modes?.sendFocusMode === true
    }, terminalId, { timeout: 15_000 })

    // Reload: fresh xterm surface, rehydrated via surfaceReset attach + sync
    // preamble + retained-window replay. The reload installs a fresh harness,
    // so getSentWsMessages is a clean, window-scoped record of every
    // client→server message since boot — that IS the assertion window: it
    // starts at reload-ready by construction and ends just after the arm is
    // re-observed; a genuine live focus report cannot flake it here because
    // no focus change occurs post-arm in this flow.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForReady(page)

    // The fresh surface must claim a full wipe+hydrate and re-present the
    // marker — proof the retained window (containing the ?1004h byte) replayed.
    await page.waitForFunction((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((m: any) =>
        m?.type === 'terminal.attach'
        && m?.terminalId === id
        && m?.surfaceReset === true
        && m?.sinceSeq === 0)
    }, terminalId, { timeout: 45_000 })
    await waitForTerminalText(page, '__FOCUS_ARMED__', terminalId!, 45_000)

    // Arm restored by the replay: xterm parsed ?1004h out of the replayed
    // chunk. This is the meaning-proving half — without it, "no phantom
    // input" would pass vacuously on a surface that never saw the arm byte.
    // xterm sets decPrivateModes.sendFocus and fires _reportFocus in the SAME
    // parse step, so by the time this wait resolves the phantom (pre-fix)
    // has already been emitted and recorded.
    await page.waitForFunction((id) => {
      const modes = window.__FRESHELL_TEST_HARNESS__?.getTerminalModes?.(id)
      return modes?.sendFocusMode === true
    }, terminalId, { timeout: 45_000 })

    // Short settle for any same-tick send-path drift, then close the window:
    // no terminal.input this client sent since reload may contain ESC[I or
    // ESC[O (checked against both directions — the fresh surface has no
    // 'focus' class headlessly — which variant the phantom takes depends on
    // xterm's focus class at arm-parse time; the gate is byte-exact either
    // way, so assert against both).
    await page.waitForTimeout(500)
    const phantomInputs: any[] = await page.evaluate((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.filter((m: any) =>
        m?.type === 'terminal.input'
        && m?.terminalId === id
        && typeof m?.data === 'string'
        && (m.data.includes('\u001b[I') || m.data.includes('\u001b[O')))
    }, terminalId)
    expect(
      phantomInputs,
      `replay of the ?1004h arm byte must not inject a focus report into the app; got: ${JSON.stringify(phantomInputs)}`,
    ).toHaveLength(0)

    await context.close()
  })

  test('client disconnect is handled gracefully', async ({ browser, serverInfo, e2eMachineId }) => {
    const context = await newClientContext(browser, serverInfo, e2eMachineId)
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    // Close one page
    await page1.close()

    // Other page should still work
    await page2.waitForFunction(() =>
      window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready'
    )

    await context.close()
  })
})
