import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import type { TestHarness } from '../helpers/test-harness.js'
import type { TerminalHelper } from '../helpers/terminal-helpers.js'

const execFileAsync = promisify(execFile)
const ACTIVE_PROBE_MS = 300
const STOPPED_PROBE_MS = 1_800
const RESUMED_PROBE_MS = 500
const STOPPED_OUTPUT_LINE_COUNT = 240

type StopProbeSnapshot = {
  timerTicks: number
  rafTicks: number
  wsMessageCount: number
  wsOpenCount: number
  wsCloseCount: number
  wsErrorCount: number
  lastWsReadyState: number | null
  maxTimerGapMs: number
  maxRafGapMs: number
  messageTypes: Record<string, number>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function selectShellFromPicker(page: Page): Promise<void> {
  if (await page.locator('.xterm').first().isVisible().catch(() => false)) return
  await page.waitForTimeout(500)
  if (await page.locator('.xterm').first().isVisible().catch(() => false)) return

  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await button.first().isVisible().catch(() => false)) {
      await button.first().click()
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
      return
    }
  }

  throw new Error('Could not create a terminal from the pane picker')
}

async function getActiveTerminalId(harness: TestHarness): Promise<string> {
  const state = await harness.getState()
  const activeTabId = state?.tabs?.activeTabId
  const layout = activeTabId ? state?.panes?.layouts?.[activeTabId] : null
  const queue = layout ? [layout] : []
  while (queue.length > 0) {
    const node = queue.shift()
    if (node?.type === 'leaf' && node.content?.kind === 'terminal' && typeof node.content.terminalId === 'string') {
      return node.content.terminalId
    }
    if (Array.isArray(node?.children)) {
      queue.push(...node.children)
    }
  }
  throw new Error('No active terminal id found')
}

async function waitForParserAppliedCheckpoint(page: Page): Promise<number> {
  await page.waitForFunction(
    () => {
      const events = window.__FRESHELL_TEST_HARNESS__?.getPerfAuditSnapshot()?.perfEvents ?? []
      return events.some((event) => event.event === 'terminal.parser_applied'
        && typeof event.parserAppliedSeq === 'number'
        && event.parserAppliedSeq > 0)
    },
    { timeout: 15_000 },
  )
  return page.evaluate(() => {
    const events = window.__FRESHELL_TEST_HARNESS__?.getPerfAuditSnapshot()?.perfEvents ?? []
    return events
      .filter((event) => event.event === 'terminal.parser_applied' && typeof event.parserAppliedSeq === 'number')
      .reduce((max, event) => Math.max(max, Number(event.parserAppliedSeq)), 0)
  })
}

async function installStopProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      timerTicks: 0,
      rafTicks: 0,
      wsMessageCount: 0,
      wsOpenCount: 0,
      wsCloseCount: 0,
      wsErrorCount: 0,
      lastWsReadyState: null as number | null,
      lastTimerAt: performance.now(),
      lastRafAt: 0,
      maxTimerGapMs: 0,
      maxRafGapMs: 0,
      messageTypes: {} as Record<string, number>,
    }

    window.setInterval(() => {
      const now = performance.now()
      state.maxTimerGapMs = Math.max(state.maxTimerGapMs, now - state.lastTimerAt)
      state.lastTimerAt = now
      state.timerTicks += 1
    }, 50)

    const rafTick = (now: number) => {
      if (state.lastRafAt > 0) {
        state.maxRafGapMs = Math.max(state.maxRafGapMs, now - state.lastRafAt)
      }
      state.lastRafAt = now
      state.rafTicks += 1
      window.requestAnimationFrame(rafTick)
    }
    window.requestAnimationFrame(rafTick)

    const NativeWebSocket = window.WebSocket
    window.WebSocket = class InstrumentedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        state.lastWsReadyState = this.readyState
        this.addEventListener('open', () => {
          state.wsOpenCount += 1
          state.lastWsReadyState = this.readyState
        })
        this.addEventListener('close', () => {
          state.wsCloseCount += 1
          state.lastWsReadyState = this.readyState
        })
        this.addEventListener('error', () => {
          state.wsErrorCount += 1
          state.lastWsReadyState = this.readyState
        })
        this.addEventListener('message', (event) => {
          state.wsMessageCount += 1
          state.lastWsReadyState = this.readyState
          if (typeof event.data === 'string') {
            try {
              const parsed = JSON.parse(event.data) as { type?: unknown }
              if (typeof parsed.type === 'string') {
                state.messageTypes[parsed.type] = (state.messageTypes[parsed.type] ?? 0) + 1
              }
            } catch {
              state.messageTypes.unknown = (state.messageTypes.unknown ?? 0) + 1
            }
          }
        })
      }
    }

    ;(window as Window & {
      __FRESHELL_STOP_RESUME_PROBE__?: { snapshot: () => StopProbeSnapshot }
    }).__FRESHELL_STOP_RESUME_PROBE__ = {
      snapshot: () => ({
        timerTicks: state.timerTicks,
        rafTicks: state.rafTicks,
        wsMessageCount: state.wsMessageCount,
        wsOpenCount: state.wsOpenCount,
        wsCloseCount: state.wsCloseCount,
        wsErrorCount: state.wsErrorCount,
        lastWsReadyState: state.lastWsReadyState,
        maxTimerGapMs: state.maxTimerGapMs,
        maxRafGapMs: state.maxRafGapMs,
        messageTypes: { ...state.messageTypes },
      }),
    }
  })
}

async function stopProbeSnapshot(page: Page): Promise<StopProbeSnapshot> {
  return page.evaluate(() => {
    const probe = (window as Window & {
      __FRESHELL_STOP_RESUME_PROBE__?: { snapshot: () => StopProbeSnapshot }
    }).__FRESHELL_STOP_RESUME_PROBE__
    if (!probe) {
      throw new Error('Stop/resume probe was not installed')
    }
    return probe.snapshot()
  })
}

function deltaSnapshots(before: StopProbeSnapshot, after: StopProbeSnapshot): StopProbeSnapshot {
  const messageTypes: Record<string, number> = {}
  for (const [type, count] of Object.entries(after.messageTypes)) {
    messageTypes[type] = count - (before.messageTypes[type] ?? 0)
  }
  return {
    timerTicks: after.timerTicks - before.timerTicks,
    rafTicks: after.rafTicks - before.rafTicks,
    wsMessageCount: after.wsMessageCount - before.wsMessageCount,
    wsOpenCount: after.wsOpenCount - before.wsOpenCount,
    wsCloseCount: after.wsCloseCount - before.wsCloseCount,
    wsErrorCount: after.wsErrorCount - before.wsErrorCount,
    lastWsReadyState: after.lastWsReadyState,
    maxTimerGapMs: after.maxTimerGapMs,
    maxRafGapMs: after.maxRafGapMs,
    messageTypes,
  }
}

async function collectProcessForestPids(rootPids: number[]): Promise<number[]> {
  if (process.platform === 'win32') {
    throw new Error('POSIX SIGSTOP/SIGCONT process suspend probe is not available on native Windows')
  }

  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='])
  const childrenByParent = new Map<number, number[]>()
  for (const line of stdout.split(/\r?\n/)) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/)
    const pid = Number(pidRaw)
    const ppid = Number(ppidRaw)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    const children = childrenByParent.get(ppid) ?? []
    children.push(pid)
    childrenByParent.set(ppid, children)
  }

  const pids = new Set<number>()
  const queue = [...rootPids]
  while (queue.length > 0) {
    const pid = queue.shift()
    if (!pid || pids.has(pid)) continue
    pids.add(pid)
    queue.push(...(childrenByParent.get(pid) ?? []))
  }
  return [...pids]
}

async function collectBrowserExecutionPids(page: Page): Promise<number[]> {
  const browser = page.context().browser() as unknown as {
    process?: unknown
    newBrowserCDPSession?: unknown
  } | null
  if (browser && typeof browser.process === 'function') {
    const childProcess = browser.process() as { pid?: number } | null
    if (childProcess?.pid) {
      return collectProcessForestPids([childProcess.pid])
    }
  }

  if (!browser || typeof browser.newBrowserCDPSession !== 'function') {
    throw new Error('Playwright did not expose browser process or browser-level CDP session for the suspend probe')
  }

  const cdpSession = await browser.newBrowserCDPSession() as {
    send: (method: string) => Promise<unknown>
    detach: () => Promise<void>
  }
  try {
    const processInfo = await cdpSession.send('SystemInfo.getProcessInfo') as {
      processInfo?: Array<{ id?: number; type?: string }>
    }
    const pids = (processInfo.processInfo ?? [])
      .map((entry) => Number(entry.id))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    if (pids.length > 0) {
      return collectProcessForestPids(pids)
    }
  } finally {
    await cdpSession.detach().catch(() => {})
  }

  throw new Error('Could not resolve Chromium process IDs for the suspend probe')
}

function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }
  }
}

function resolveWsBehavior(input: {
  before: StopProbeSnapshot
  afterResumeImmediate: StopProbeSnapshot
  afterCatchup: StopProbeSnapshot
}): 'still_open_stalled' | 'closed_reconnected' | 'buffered_resumed' {
  const stoppedDelta = deltaSnapshots(input.before, input.afterResumeImmediate)
  const catchupDelta = deltaSnapshots(input.afterResumeImmediate, input.afterCatchup)
  if (stoppedDelta.wsCloseCount > 0 || stoppedDelta.wsOpenCount > 0 || catchupDelta.wsOpenCount > 0) {
    return 'closed_reconnected'
  }
  if (stoppedDelta.wsMessageCount > 0 || catchupDelta.wsMessageCount > 0) {
    return 'buffered_resumed'
  }
  return 'still_open_stalled'
}

function countPerfEvents(events: Array<Record<string, unknown>>, eventName: string): number {
  return events.filter((event) => event.event === eventName).length
}

test.describe('terminal background freeze catch-up', () => {
  test('process suspend catches up terminal output without silent gaps or quarantine', async ({
    page,
    serverInfo,
    harness,
    terminal,
  }, testInfo) => {
    test.slow()
    testInfo.annotations.push({
      type: 'terminal-catchup-proof',
      description: 'Local POSIX process-suspend positive control; this does not replace the real Windows Chrome background gate.',
    })

    let stoppedPids: number[] = []
    try {
      await installStopProbe(page)
      await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1&perfAudit=1`)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellFromPicker(page)
      await terminal.waitForTerminal()
      await terminal.waitForPrompt({ timeout: 30_000 })
      const terminalId = await getActiveTerminalId(harness)

      await terminal.executeCommand('echo active-freeze-checkpoint')
      await terminal.waitForOutput('active-freeze-checkpoint', { terminalId, timeout: 15_000 })
      const parserAppliedCheckpoint = await waitForParserAppliedCheckpoint(page)
      expect(parserAppliedCheckpoint).toBeGreaterThan(0)

      const activeBefore = await stopProbeSnapshot(page)
      await page.waitForTimeout(ACTIVE_PROBE_MS)
      const activeAfter = await stopProbeSnapshot(page)
      const activeDelta = deltaSnapshots(activeBefore, activeAfter)
      expect(activeDelta.timerTicks).toBeGreaterThan(0)
      expect(activeDelta.rafTicks).toBeGreaterThan(0)

      const finalLine = `freeze-catchup-${STOPPED_OUTPUT_LINE_COUNT}`
      await terminal.executeCommand(
        `node -e "setTimeout(() => { for (let i = 1; i <= ${STOPPED_OUTPUT_LINE_COUNT}; i++) console.log('freeze-catchup-' + i) }, 250)"`,
      )

      stoppedPids = await collectBrowserExecutionPids(page)
      const beforeStop = await stopProbeSnapshot(page)
      const stopStartedAt = Date.now()
      signalPids([...stoppedPids].sort((a, b) => b - a), 'SIGSTOP')
      await sleep(STOPPED_PROBE_MS)
      signalPids([...stoppedPids].sort((a, b) => a - b), 'SIGCONT')
      const stopEndedAt = Date.now()
      const afterResumeImmediate = await stopProbeSnapshot(page)
      const stoppedDelta = deltaSnapshots(beforeStop, afterResumeImmediate)

      expect(stoppedDelta.timerTicks).toBeLessThan(5)
      expect(stoppedDelta.rafTicks).toBeLessThan(5)

      await terminal.waitForOutput(finalLine, { terminalId, timeout: 30_000 })
      await page.waitForTimeout(RESUMED_PROBE_MS)
      const afterCatchup = await stopProbeSnapshot(page)
      const resumedDelta = deltaSnapshots(afterResumeImmediate, afterCatchup)
      expect(resumedDelta.timerTicks).toBeGreaterThan(0)
      expect(resumedDelta.rafTicks).toBeGreaterThan(0)

      const buffer = await terminal.getVisibleText(terminalId)
      expect(buffer).toContain('freeze-catchup-1')
      expect(buffer).toContain(finalLine)

      const perfEvents = (await harness.getPerfAuditSnapshot())?.perfEvents ?? []
      const outputGapCount = afterCatchup.messageTypes['terminal.output.gap'] ?? 0
      const quarantineCount = countPerfEvents(perfEvents, 'terminal.catchup.surface_quarantined')
      const hydrateFallbackCount = countPerfEvents(perfEvents, 'terminal.catchup.full_hydrate_fallback')
      const staleGenerationRejectionCount = countPerfEvents(perfEvents, 'terminal.attach_generation_stale_rejected')
      const wsBehavior = resolveWsBehavior({
        before: beforeStop,
        afterResumeImmediate,
        afterCatchup,
      })

      expect(['still_open_stalled', 'closed_reconnected', 'buffered_resumed']).toContain(wsBehavior)
      expect(outputGapCount).toBe(0)
      expect(quarantineCount).toBe(0)
      expect(hydrateFallbackCount).toBe(0)
      expect(staleGenerationRejectionCount).toBe(0)

      await testInfo.attach('terminal-background-freeze-catchup', {
        contentType: 'application/json',
        body: JSON.stringify({
          note: 'Local POSIX process-suspend positive control; not a substitute for the real Windows Chrome gate.',
          stoppedPids,
          stoppedDurationMs: stopEndedAt - stopStartedAt,
          parserAppliedCheckpoint,
          wsBehavior,
          activeDelta,
          stoppedDelta,
          resumedDelta,
          beforeStop,
          afterResumeImmediate,
          afterCatchup,
          outputGapCount,
          quarantineCount,
          hydrateFallbackCount,
          staleGenerationRejectionCount,
        }, null, 2),
      })
    } finally {
      if (stoppedPids.length > 0) {
        signalPids([...stoppedPids].sort((a, b) => a - b), 'SIGCONT')
      }
      await harness.killAllTerminals(serverInfo).catch(() => {})
    }
  })
})
