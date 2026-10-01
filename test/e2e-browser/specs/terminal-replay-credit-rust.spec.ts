import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { test, expect, createFreshE2ePage } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness, selectShellFromPicker } from '../helpers/test-harness.js'
import { installRecoveryOfferAutoDecline } from '../helpers/recovery-offer.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'

type WireMessage = {
  type?: string; terminalId?: string; attachRequestId?: string; streamId?: string
  consumedSeq?: number; seqStart?: number; seqEnd?: number; data?: string
  source?: string; sinceSeq?: number; intent?: string; replayPageBytes?: number
  replayToSeq?: number; headSeq?: number; surfaceReset?: boolean
}
type WireEvent = { direction: 'client' | 'server'; message: WireMessage }
const SGR = '\x1b[38;5;2;48;2;33;58'
const DONE = 'REPLAY-CREDIT-DONE'
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

function collectReplayWire(context: BrowserContext) {
  const events: WireEvent[] = []
  let target = ''
  let restoring = false
  let holdFirstBoundary = false
  let holdContinuation = false
  let releaseBoundary: (() => void) | undefined
  let heldContinuation = false
  return {
    events,
    setTarget: (terminalId: string) => { target = terminalId },
    begin: (hold: boolean) => { restoring = true; holdFirstBoundary = hold; releaseBoundary = undefined },
    release: () => { releaseBoundary?.(); releaseBoundary = undefined },
    hasHeldBoundary: () => releaseBoundary !== undefined,
    holdNextContinuation: () => { holdContinuation = true; heldContinuation = false },
    hasHeldContinuation: () => heldContinuation,
    resumeContinuation: () => { holdContinuation = false },
    install: async () => {
      await context.routeWebSocket((url) => url.pathname === '/ws', (client) => {
        const server = client.connectToServer()
        client.onMessage((raw) => {
          const parsed = JSON.parse(String(raw)) as WireMessage
          events.push({ direction: 'client', message: parsed })
          if (restoring && parsed.type === 'terminal.attach' && parsed.terminalId === target) {
            server.send(JSON.stringify({ ...parsed, replayPageBytes: 1 }))
          } else server.send(raw)
        })
        server.onMessage((raw) => {
          const parsed = JSON.parse(String(raw)) as WireMessage
          events.push({ direction: 'server', message: parsed })
          if (restoring && parsed.terminalId === target && parsed.source === 'replay') {
            if (holdFirstBoundary && parsed.data?.endsWith(SGR)) {
              holdFirstBoundary = false
              releaseBoundary = () => client.send(raw)
              return
            }
            if (holdContinuation && parsed.data?.includes(DONE)) {
              heldContinuation = true
              return
            }
          }
          client.send(raw)
        })
        client.onClose((code, reason) => void server.close({ code, reason }).catch(() => {}))
        server.onClose((code, reason) => void client.close({ code, reason }).catch(() => {}))
      })
    },
  }
}

async function createShellTabViaRest(info: E2eServerInfo, cwd: string): Promise<string> {
  const response = await fetch(`${info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
    body: JSON.stringify({ mode: 'shell', cwd }),
  })
  const payload = await response.json() as { data?: { tabId?: string } } | null
  expect(response.ok, `POST /api/tabs: ${JSON.stringify(payload)}`).toBe(true)
  expect(payload?.data?.tabId, 'POST /api/tabs envelope data.tabId').toBeTruthy()
  return payload!.data!.tabId!
}

async function sendTerminalInput(page: Page, terminalId: string, data: string): Promise<void> {
  await page.evaluate(({ tid, payload }) => {
    window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({ type: 'terminal.input', terminalId: tid, data: payload })
  }, { tid: terminalId, payload: data })
}

async function flushPersistence(page: Page): Promise<void> {
  await page.evaluate(() => { window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' }) })
}

async function selectTab(page: Page, harness: TestHarness, tabId: string): Promise<void> {
  await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
  await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabId)
}

function terminalIdOfTabFromState(state: Record<string, any>, tabId: string): string | null {
  const layout = state?.panes?.layouts?.[tabId]
  if (!layout) return null
  const queue = [layout]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node?.type === 'leaf' && typeof node.content?.terminalId === 'string') return node.content.terminalId
    if (Array.isArray(node?.children)) queue.push(...node.children)
  }
  return null
}

const isOutput = (message: WireMessage) => message.type === 'terminal.output' || message.type === 'terminal.output.batch'

for (const pathName of ['refresh', 'tab-switch', 'reconnect', 'final-live'] as const) {
  test(pathName === 'final-live' ? 'retains the final replay SGR until its actual live continuation' : `credits an incomplete replay page through ${pathName}`, async ({ browser }, testInfo) => {
    test.setTimeout(120_000)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-replay-credit-'))
    const server = new RustServer()
    let owned: Awaited<ReturnType<typeof createFreshE2ePage>> | undefined
    let wire: ReturnType<typeof collectReplayWire> | undefined
    let terminalId = '', boundarySeq = 0
    try {
      const info = await server.start()
      owned = await createFreshE2ePage(browser, info)
      const { page } = owned
      wire = collectReplayWire(owned.context)
      await wire.install()
      installRecoveryOfferAutoDecline(page)
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      let harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellFromPicker(page)
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()
      await expect.poll(async () => {
        terminalId = terminalIdOfTabFromState(await harness.getState(), tabId!) ?? ''
        return terminalId
      }, { timeout: 30_000 }).not.toBe('')
      await expect(page.locator('.xterm:visible')).toBeVisible()
      wire.setTarget(terminalId)
      const secondTabId = pathName === 'tab-switch' ? await createShellTabViaRest(info, root) : null
      if (secondTabId) await selectTab(page, harness, tabId!)

      const releaseFile = path.join(root, 'continue')
      const writerFile = path.join(root, 'writer.sh')
      await fs.writeFile(writerFile, [
        '#!/bin/sh',
        "awk 'BEGIN { for (i=0;i<180;i++) printf \"REPLAY-ROW-%03d\\n\", i }'",
        "printf 'REPLAY-PREFIX\\033[38;5;2;48;2;33;58'",
        `while [ ! -f ${quote(releaseFile)} ]; do sleep 0.02; done`,
        "printf ';255m\\nREPLAY-CREDIT-DONE\\n\\033[0m'", '',
      ].join('\n'))
      await sendTerminalInput(page, terminalId, `sh ${quote(writerFile)}\n`)
      await expect.poll(() => wire!.events.some(e => e.direction === 'server' && e.message.terminalId === terminalId && isOutput(e.message) && e.message.data?.endsWith(SGR)), { timeout: 30_000 }).toBe(true)
      const boundary = wire.events.find(e => e.direction === 'server' && e.message.terminalId === terminalId && isOutput(e.message) && e.message.data?.endsWith(SGR))!.message
      expect(Number.isFinite(boundary.seqEnd)).toBe(true)
      boundarySeq = boundary.seqEnd!
      if (pathName !== 'final-live') {
        await fs.writeFile(releaseFile, '')
        await expect.poll(() => wire!.events.some(e => e.direction === 'server' && e.message.terminalId === terminalId && isOutput(e.message) && e.message.seqStart! > boundarySeq && e.message.data?.includes(DONE)), { timeout: 30_000 }).toBe(true)
        await expect.poll(() => harness.getTerminalBuffer(terminalId)).toContain(DONE)
      } else {
        expect(wire.events.some(e => e.direction === 'server' && e.message.terminalId === terminalId && e.message.data?.includes(DONE))).toBe(false)
      }
      await flushPersistence(page)
      wire.events.length = 0
      wire.begin(true)
      if (pathName === 'reconnect') wire.holdNextContinuation()
      await page.reload()
      harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await expect.poll(() => wire!.hasHeldBoundary(), { timeout: 30_000 }).toBe(true)
      const replayBoundary = wire.events.find(e => e.direction === 'server' && e.message.terminalId === terminalId && e.message.source === 'replay' && e.message.data?.endsWith(SGR))!.message
      expect(replayBoundary.seqEnd).toBe(boundarySeq)
      expect(replayBoundary.seqStart).toBeGreaterThan(0)
      expect(replayBoundary.seqEnd!).toBeGreaterThanOrEqual(replayBoundary.seqStart!)
      await expect(page.getByText('Recovering terminal output...', { exact: true })).toBeVisible()
      if (secondTabId) await selectTab(page, harness, secondTabId)
      wire.release()
      if (secondTabId) await selectTab(page, harness, tabId!)
      const currentCredit = () => wire!.events.find(e => e.direction === 'client' && e.message.type === 'terminal.replay.credit' && e.message.terminalId === terminalId && e.message.consumedSeq === boundarySeq)?.message
      await expect.poll(currentCredit, { timeout: 15_000 }).toBeTruthy()
      const firstCredit = currentCredit()!
      if (pathName === 'final-live') {
        const ready = wire.events.find(e => e.direction === 'server' && e.message.type === 'terminal.attach.ready' && e.message.terminalId === terminalId && e.message.attachRequestId === firstCredit.attachRequestId)!.message
        expect(ready.replayToSeq).toBe(boundarySeq)
        expect(ready.headSeq).toBe(boundarySeq)
        await expect(page.getByText('Recovering terminal output...', { exact: true })).toHaveCount(0)
        await fs.writeFile(releaseFile, '')
        await expect.poll(() => wire!.events.some(e => e.direction === 'server' && e.message.terminalId === terminalId && e.message.source === 'live' && e.message.attachRequestId === firstCredit.attachRequestId && e.message.streamId === ready.streamId && e.message.seqStart! > boundarySeq && e.message.data?.includes(';255m') && e.message.data?.includes(DONE)), { timeout: 30_000 }).toBe(true)
      } else {
        await expect.poll(() => wire!.events.some(e => e.direction === 'server' && e.message.terminalId === terminalId && e.message.attachRequestId === firstCredit.attachRequestId && e.message.seqStart! > boundarySeq && (e.message.data?.includes(';255m') || e.message.data?.includes(DONE))), { timeout: 15_000 }).toBe(true)
        if (pathName === 'reconnect') {
          await expect.poll(() => wire!.hasHeldContinuation()).toBe(true)
          // Initial page bootstrap can supersede an earlier mount attach.
          // Only an attach emitted after this actual disconnect proves the
          // mounted transport recovery path.
          const disconnectedEventIndex = wire.events.length
          await harness.forceDisconnect()
          wire.resumeContinuation()
          await harness.waitForConnection()
          const newAttach = () => wire!.events.slice(disconnectedEventIndex).find(e => e.direction === 'client' && e.message.type === 'terminal.attach' && e.message.terminalId === terminalId && e.message.attachRequestId !== firstCredit.attachRequestId)?.message
          await expect.poll(newAttach, { timeout: 30_000 }).toBeTruthy()
          expect(newAttach()).toMatchObject({ sinceSeq: 0, surfaceReset: true })
          const newId = newAttach()!.attachRequestId
          await expect.poll(() => wire!.events.some(e => e.direction === 'client' && e.message.type === 'terminal.replay.credit' && e.message.terminalId === terminalId && e.message.attachRequestId === newId && e.message.consumedSeq === boundarySeq), { timeout: 30_000 }).toBe(true)
          await expect.poll(() => wire!.events.some(e => e.direction === 'server' && e.message.terminalId === terminalId && e.message.attachRequestId === newId && e.message.seqStart! > boundarySeq && e.message.data?.includes(DONE)), { timeout: 30_000 }).toBe(true)
        }
      }
      await expect(page.getByText('Recovering terminal output...', { exact: true })).toHaveCount(0)
      await expect.poll(() => harness.getTerminalBuffer(terminalId), { timeout: 30_000 }).toContain(DONE)
      const buffer = (await harness.getTerminalBuffer(terminalId))!
      for (const marker of ['REPLAY-PREFIX', DONE, 'REPLAY-ROW-000', 'REPLAY-ROW-090', 'REPLAY-ROW-179']) expect(buffer.split(marker).length - 1, marker).toBe(1)
      expect(buffer).not.toContain('[38;5;2;48;2;33;58')
      expect(buffer).not.toContain(';255m')
      // xterm 6 renders its viewport through a custom scrollable element;
      // the legacy .xterm-viewport has no DOM scroll range. Observe the real
      // scrollbar moving when the user wheels the terminal screen.
      const slider = page.locator('.xterm:visible .xterm-scrollable-element > .scrollbar.vertical > .slider')
      const sliderTop = () => slider.evaluate(e => Number.parseFloat((e as HTMLElement).style.top))
      await expect.poll(sliderTop).toBeGreaterThan(0)
      const scrollTop = await sliderTop()
      await page.locator('.xterm:visible .xterm-screen').hover()
      await page.mouse.wheel(0, -700)
      await expect.poll(sliderTop).toBeLessThan(scrollTop)
      await page.locator('.xterm:visible').click()
      await page.keyboard.type('echo "REPLAY-INPUT-""WORKS"')
      await page.keyboard.press('Enter')
      await expect.poll(() => harness.getTerminalBuffer(terminalId)).toContain('REPLAY-INPUT-WORKS')
      expect(terminalIdOfTabFromState(await harness.getState(), tabId!)).toBe(terminalId)
    } finally {
      // Keep public protocol diagnostics in the cloud receipt; Cloud Run does
      // not retain Playwright's local attachment files after the task exits.
      console.log(JSON.stringify({ event: 'replay_credit_wire', pathName, terminalId, boundarySeq,
        frames: wire?.events.filter(event => event.message.terminalId === terminalId).map(({ direction, message }) => ({
          direction, type: message.type, attachRequestId: message.attachRequestId,
          streamId: message.streamId, source: message.source, sinceSeq: message.sinceSeq,
          consumedSeq: message.consumedSeq, seqStart: message.seqStart, seqEnd: message.seqEnd,
          headSeq: message.headSeq, replayToSeq: message.replayToSeq, surfaceReset: message.surfaceReset,
          incompleteSgr: message.data?.endsWith(SGR), completed: message.data?.includes(DONE),
        })),
      }))
      await testInfo.attach('replay-credit-wire', { body: Buffer.from(JSON.stringify({ pathName, terminalId, boundarySeq, events: wire?.events ?? [] })), contentType: 'application/json' })
      await owned?.context.close()
      await server.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}
