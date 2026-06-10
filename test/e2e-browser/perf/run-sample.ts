import { execFile } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { promisify } from 'util'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import WebSocket from 'ws'
import { TestHarness } from '../helpers/test-harness.js'
import { TestServer, type TestServerInfo } from '../helpers/test-server.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import type { PerfAuditSnapshot } from '@/lib/perf-audit-bridge'
import {
  type VisibleFirstAuditSample,
  type VisibleFirstProfileId,
  type VisibleFirstScenarioId,
} from './audit-contract.js'
import {
  applyProfileNetworkConditions,
  buildAuditContextOptions,
} from './create-audit-context.js'
import { classifyWsFrameType, deriveVisibleFirstMetrics } from './derive-visible-first-metrics.js'
import {
  createNetworkRecorder,
  summarizeNetworkCapture,
  type NetworkCapture,
} from './network-recorder.js'
import { parseVisibleFirstServerLogs } from './parse-server-logs.js'
import { AUDIT_SCENARIOS, type AuditScenarioDefinition } from './scenarios.js'
import {
  buildAgentChatBrowserStorageSeed,
  buildOffscreenTabBrowserStorageSeed,
  buildTerminalBrowserStorageSeed,
} from './seed-browser-storage.js'
import {
  seedVisibleFirstAuditServerHome,
  type VisibleFirstAuditHomeSeedResult,
} from './seed-server-home.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

type SampleCollectors = {
  browser: PerfAuditSnapshot
  transport: {
    http: NetworkCapture['http']
    ws: NetworkCapture['ws']
    summary: ReturnType<typeof summarizeNetworkCapture>
  }
  server: Awaited<ReturnType<typeof parseVisibleFirstServerLogs>>
}

type RunVisibleFirstAuditSampleInput = {
  scenarioId: VisibleFirstScenarioId
  profileId: VisibleFirstProfileId
  outputDir?: string
  deps?: {
    executeSample?: (
      input: RunVisibleFirstAuditSampleInput,
    ) => Promise<SampleCollectors>
  }
}

type ReconnectBootstrapResult = {
  browserStorageSeed: Record<string, string>
}

type ReceivedWsFrame = {
  observedAtMs: number
  type: string
  payloadLength: number
}

type ReconnectStopResumeEvidence = Record<string, unknown>

const execFileAsync = promisify(execFile)
const SAMPLE_TIMEOUT_MS = 30_000
const TERMINAL_RECONNECT_CREATE_REQUEST_ID = 'visible-first-reconnect-create'
const TERMINAL_RECONNECT_REPLAY_MESSAGE_BUDGET = 30
const TERMINAL_RECONNECT_STOPPED_PROBE_MS = 1_200
const TERMINAL_RECONNECT_STOPPED_OUTPUT_DELAY_MS = 300
const TERMINAL_RECONNECT_STOPPED_OUTPUT_LINE_COUNT = 60

function getScenarioDefinition(scenarioId: VisibleFirstScenarioId) {
  const scenario = AUDIT_SCENARIOS.find((entry) => entry.id === scenarioId)
  if (!scenario) {
    throw new Error(`Unknown audit scenario: ${scenarioId}`)
  }
  return scenario
}

function emptyCollectors(): SampleCollectors {
  return {
    browser: {
      milestones: {},
      metadata: {},
      perfEvents: [],
      terminalLatencySamplesMs: [],
    },
    transport: {
      http: { requests: [] },
      ws: { frames: [] },
      summary: { http: { byRoute: {} }, ws: { byType: {} } },
    },
    server: {
      httpRequests: [],
      perfEvents: [],
      perfSystemSamples: [],
      terminalReplayEvents: [],
      terminalOutputEvents: [],
      parserDiagnostics: [],
    },
  }
}

async function installRafGapSampler(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      maxGapMs: 0,
      lastRafAt: 0,
      sampleCount: 0,
    }
    ;(window as Window & {
      __FRESHELL_VISIBLE_FIRST_RAF_GAP__?: typeof state
    }).__FRESHELL_VISIBLE_FIRST_RAF_GAP__ = state

    const tick = (now: number) => {
      if (state.lastRafAt > 0) {
        state.maxGapMs = Math.max(state.maxGapMs, now - state.lastRafAt)
      }
      state.lastRafAt = now
      state.sampleCount += 1
      window.requestAnimationFrame(tick)
    }
    window.requestAnimationFrame(tick)
  })
}

async function readRafGapSummary(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const state = (window as Window & {
      __FRESHELL_VISIBLE_FIRST_RAF_GAP__?: {
        maxGapMs: number
        lastRafAt: number
        sampleCount: number
      }
    }).__FRESHELL_VISIBLE_FIRST_RAF_GAP__
    if (!state) return null
    return {
      event: 'visible_first.audit.max_raf_gap',
      timestamp: performance.now(),
      maxGapMs: state.maxGapMs,
      sampleCount: state.sampleCount,
    }
  })
}

async function waitForRafSampler(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const auditWindow = window as Window & {
      __FRESHELL_VISIBLE_FIRST_RAF_GAP__?: {
        maxGapMs: number
        lastRafAt: number
        sampleCount: number
      }
    }
    window.requestAnimationFrame((firstNow) => {
      const firstState = auditWindow.__FRESHELL_VISIBLE_FIRST_RAF_GAP__
      if (firstState) {
        if (firstState.lastRafAt > 0) {
          firstState.maxGapMs = Math.max(firstState.maxGapMs, firstNow - firstState.lastRafAt)
        }
        firstState.lastRafAt = firstNow
        firstState.sampleCount += 1
      }
      window.requestAnimationFrame((secondNow) => {
        const secondState = auditWindow.__FRESHELL_VISIBLE_FIRST_RAF_GAP__
        if (secondState) {
          if (secondState.lastRafAt > 0) {
            secondState.maxGapMs = Math.max(secondState.maxGapMs, secondNow - secondState.lastRafAt)
          }
          secondState.lastRafAt = secondNow
          secondState.sampleCount += 1
        }
        resolve()
      })
    })
  }))
}

function assertRequiredMetricsPresent(
  scenario: AuditScenarioDefinition,
  derived: Record<string, unknown>,
): void {
  const missing = (scenario.requiredMetricIds ?? []).filter((metricId) => {
    const value = derived[metricId]
    return typeof value !== 'number' || !Number.isFinite(value)
  })
  if (missing.length > 0) {
    throw new Error(`Missing required audit metrics for ${scenario.id}: ${missing.join(', ')}`)
  }
}

function assertTerminalReconnectTargets(derived: Record<string, unknown>): void {
  const replayMessageCount = typeof derived.terminalReplayMessageCount === 'number'
    ? derived.terminalReplayMessageCount
    : Number.NaN
  if (!Number.isFinite(replayMessageCount) || replayMessageCount <= 0) {
    throw new Error('terminal-reconnect-backlog did not record replay message evidence')
  }
  if (replayMessageCount > TERMINAL_RECONNECT_REPLAY_MESSAGE_BUDGET) {
    throw new Error(
      `terminal-reconnect-backlog replay message count ${replayMessageCount} exceeded budget ${TERMINAL_RECONNECT_REPLAY_MESSAGE_BUDGET}`,
    )
  }

  const zeroMetrics = [
    'terminalReplayGapCount',
    'terminalFullHydrateFallbackCount',
    'terminalSurfaceQuarantineCount',
    'terminalStaleGenerationRejectionCount',
    'terminalStopResumeGapCount',
  ]
  for (const metric of zeroMetrics) {
    const value = derived[metric]
    if (typeof value !== 'number' || value !== 0) {
      throw new Error(`terminal-reconnect-backlog expected ${metric}=0, got ${String(value)}`)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForFile(filePath: string, timeoutMs = SAMPLE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fs.stat(filePath)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await sleep(25)
  }
  throw new Error(`Timed out waiting for audit proof file ${filePath}`)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function collectProcessForestPids(rootPids: number[]): Promise<number[]> {
  if (process.platform === 'win32') {
    throw new Error('POSIX SIGSTOP/SIGCONT process suspend proof is not available on native Windows')
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

async function collectBrowserExecutionPids(browser: Browser): Promise<number[]> {
  const browserWithProcess = browser as unknown as { process?: () => { pid?: number } | null }
  const childProcess = browserWithProcess.process?.()
  if (!childProcess?.pid) {
    const browserWithCdp = browser as unknown as {
      newBrowserCDPSession?: () => Promise<{
        send: (method: string) => Promise<unknown>
        detach: () => Promise<void>
      }>
    }
    if (typeof browserWithCdp.newBrowserCDPSession !== 'function') {
      throw new Error('Playwright did not expose a browser process or CDP session for the reconnect suspend proof')
    }
    const cdpSession = await browserWithCdp.newBrowserCDPSession()
    try {
      const processInfo = await cdpSession.send('SystemInfo.getProcessInfo') as {
        processInfo?: Array<{ id?: number }>
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
    throw new Error('Could not resolve Chromium process IDs for the reconnect suspend proof')
  }
  return collectProcessForestPids([childProcess.pid])
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

function isTerminalOutputFrame(frame: ReceivedWsFrame): boolean {
  return frame.type === 'terminal.output' || frame.type === 'terminal.output.batch'
}

async function runReconnectStopResumeProof(input: {
  browser: Browser
  page: Page
  serverInfo: TestServerInfo
  harness: TestHarness
  terminal: TerminalHelper
  receivedWsFrames: ReceivedWsFrame[]
}): Promise<ReconnectStopResumeEvidence> {
  const terminalId = getActiveTerminalId(await input.harness.getState())
  if (!terminalId) {
    throw new Error('terminal-reconnect-backlog stop/resume proof did not find an active terminal')
  }

  const stoppedPids = await collectBrowserExecutionPids(input.browser)
  const markerId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const outputScriptPath = path.join(input.serverInfo.homeDir, `visible-first-stop-resume-${markerId}.cjs`)
  const scheduledMarkerPath = path.join(input.serverInfo.homeDir, `visible-first-stop-resume-scheduled-${markerId}.json`)
  const startedMarkerPath = path.join(input.serverInfo.homeDir, `visible-first-stop-resume-started-${markerId}.json`)
  const finalLine = `visible-first-stop-resume-${TERMINAL_RECONNECT_STOPPED_OUTPUT_LINE_COUNT}`
  const outputScript = [
    'const { writeFileSync } = require("fs");',
    `const scheduledMarkerPath = ${JSON.stringify(scheduledMarkerPath)};`,
    `const startedMarkerPath = ${JSON.stringify(startedMarkerPath)};`,
    `const prefix = ${JSON.stringify('visible-first-stop-resume-')};`,
    'writeFileSync(scheduledMarkerPath, JSON.stringify({ scheduledAt: Date.now() }));',
    `setTimeout(() => {`,
    '  writeFileSync(startedMarkerPath, JSON.stringify({ startedAt: Date.now() }));',
    `  for (let i = 1; i <= ${TERMINAL_RECONNECT_STOPPED_OUTPUT_LINE_COUNT}; i += 1) console.log(prefix + i);`,
    `}, ${TERMINAL_RECONNECT_STOPPED_OUTPUT_DELAY_MS});`,
    `setTimeout(() => process.exit(0), ${TERMINAL_RECONNECT_STOPPED_OUTPUT_DELAY_MS + 500});`,
  ].join('\n')

  await fs.writeFile(outputScriptPath, `${outputScript}\n`, 'utf8')
  await input.terminal.executeCommand(`node ${shellQuote(outputScriptPath)}`)
  await waitForFile(scheduledMarkerPath)

  const wsFrameBaseline = input.receivedWsFrames.length
  const stopStartedAt = Date.now()
  try {
    signalPids([...stoppedPids].sort((a, b) => b - a), 'SIGSTOP')
    await sleep(TERMINAL_RECONNECT_STOPPED_PROBE_MS)
  } finally {
    signalPids([...stoppedPids].sort((a, b) => a - b), 'SIGCONT')
  }
  const stopEndedAt = Date.now()

  await waitForFile(startedMarkerPath)
  const outputStartedAt = JSON.parse(await fs.readFile(startedMarkerPath, 'utf8')).startedAt as number
  if (outputStartedAt < stopStartedAt || outputStartedAt > stopEndedAt) {
    throw new Error(
      `terminal-reconnect-backlog stop/resume proof output started outside stopped window: ${outputStartedAt}`,
    )
  }

  await input.terminal.waitForOutput(finalLine, { terminalId, timeout: SAMPLE_TIMEOUT_MS })
  await input.page.waitForTimeout(150)

  const catchupFrames = input.receivedWsFrames.slice(wsFrameBaseline)
  const outputMessageCount = catchupFrames.filter(isTerminalOutputFrame).length
  if (outputMessageCount <= 0) {
    throw new Error('terminal-reconnect-backlog stop/resume proof did not observe post-resume terminal output frames')
  }

  const gapCount = catchupFrames.filter((frame) => frame.type === 'terminal.output.gap').length
  const timestamp = await input.page.evaluate(() => performance.now())
  const stoppedDurationMs = Math.max(0, stopEndedAt - stopStartedAt)
  const retentionCoveredMs = Math.max(0, stopEndedAt - outputStartedAt)

  return {
    event: 'terminal.catchup.stop_resume',
    source: 'visible_first_audit_process_suspend',
    scenarioId: 'terminal-reconnect-backlog',
    timestamp,
    terminalId,
    browserExecutionStopped: true,
    stoppedDurationMs,
    stoppedOutputDelayMs: TERMINAL_RECONNECT_STOPPED_OUTPUT_DELAY_MS,
    outputStartedAfterStopMs: outputStartedAt - stopStartedAt,
    outputStartedBeforeResumeMs: stopEndedAt - outputStartedAt,
    retentionCoveredMs,
    gapCount,
    cdpCatchupOutputMessageCount: outputMessageCount,
    cdpCatchupMessageCount: catchupFrames.length,
  }
}

function normalizeTransportCapture(
  capture: NetworkCapture,
  browserTimeOriginMs: number,
): NetworkCapture {
  return {
    http: {
      requests: capture.http.requests.map((request) => ({
        ...request,
        timestamp: Math.max(0, request.timestamp - browserTimeOriginMs),
      })),
    },
    ws: {
      frames: capture.ws.frames.map((frame) => ({
        ...frame,
        timestamp: Math.max(0, frame.timestamp - browserTimeOriginMs),
      })),
    },
  }
}

async function applyBrowserStorageSeed(page: Page, seed: Record<string, string>): Promise<void> {
  await page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      window.localStorage.setItem(key, value)
    }
  }, seed)
}

async function waitForAuditMilestone(
  page: Page,
  harness: TestHarness,
  milestone: string,
  timeoutMs = SAMPLE_TIMEOUT_MS,
): Promise<void> {
  await harness.waitForHarness(timeoutMs)
  await page.waitForFunction(
    (targetMilestone) => {
      const snapshot = window.__FRESHELL_TEST_HARNESS__?.getPerfAuditSnapshot()
      return typeof snapshot?.milestones?.[targetMilestone] === 'number'
    },
    milestone,
    { timeout: timeoutMs },
  )
}

async function withWsConnection<T>(
  serverInfo: TestServerInfo,
  callback: (ws: WebSocket) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(serverInfo.wsUrl)

  const openPromise = new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  await openPromise
  ws.send(JSON.stringify({
    type: 'hello',
    token: serverInfo.token,
    protocolVersion: WS_PROTOCOL_VERSION,
  }))

  await waitForWsMessage(ws, (message) => message.type === 'ready')

  try {
    return await callback(ws)
  } finally {
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve()
        return
      }
      ws.once('close', () => resolve())
      ws.close()
    })
  }
}

function waitForWsMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for audit bootstrap WebSocket message'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('error', onError)
      ws.off('close', onClose)
    }

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>
        if (!predicate(parsed)) return
        cleanup()
        resolve(parsed)
      } catch {
        // Ignore malformed frames from unrelated traffic.
      }
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onClose = () => {
      cleanup()
      reject(new Error('Audit bootstrap WebSocket closed unexpectedly'))
    }

    ws.on('message', onMessage)
    ws.once('error', onError)
    ws.once('close', onClose)
  })
}

async function bootstrapReconnectScenario(
  serverInfo: TestServerInfo,
  seedResult: VisibleFirstAuditHomeSeedResult,
): Promise<ReconnectBootstrapResult> {
  const terminalId = await withWsConnection(serverInfo, async (ws) => {
    const requestId = 'visible-first-terminal-reconnect-bootstrap'
    ws.send(JSON.stringify({
      type: 'terminal.create',
      requestId,
      mode: 'shell',
      shell: 'system',
    }))

    const created = await waitForWsMessage(
      ws,
      (message) => message.type === 'terminal.created' && message.requestId === requestId,
    )
    const createdTerminalId = created.terminalId
    if (typeof createdTerminalId !== 'string' || createdTerminalId.length === 0) {
      throw new Error('Reconnect bootstrap did not return a terminalId')
    }

    ws.send(JSON.stringify({
      type: 'terminal.input',
      terminalId: createdTerminalId,
      data: `node ${seedResult.backlogScriptPath}\n`,
    }))

    await new Promise((resolve) => setTimeout(resolve, 500))
    return createdTerminalId
  })

  return {
    browserStorageSeed: {
      freshell_version: '3',
      'freshell.tabs.v2': JSON.stringify({
        version: 2,
        tabs: {
          activeTabId: 'tab-terminal-reconnect',
          tabs: [
            {
              id: 'tab-terminal-reconnect',
              title: 'Reconnect Audit',
              createdAt: 1,
              createRequestId: TERMINAL_RECONNECT_CREATE_REQUEST_ID,
              status: 'running',
              mode: 'shell',
              shell: 'system',
              terminalId,
            },
          ],
        },
      }),
      'freshell.panes.v2': JSON.stringify({
        version: 3,
        layouts: {
          'tab-terminal-reconnect': {
            type: 'leaf',
            id: 'pane-terminal-reconnect',
            content: {
              kind: 'terminal',
              createRequestId: TERMINAL_RECONNECT_CREATE_REQUEST_ID,
              status: 'running',
              mode: 'shell',
              shell: 'system',
              terminalId,
            },
          },
        },
        activePane: {
          'tab-terminal-reconnect': 'pane-terminal-reconnect',
        },
        paneTitles: {
          'tab-terminal-reconnect': {
            'pane-terminal-reconnect': 'Reconnect Audit',
          },
        },
        paneTitleSetByUser: {},
      }),
    },
  }
}

async function resolveBrowserStorageSeed(input: {
  scenarioId: VisibleFirstScenarioId
  serverInfo: TestServerInfo
  seedResult: VisibleFirstAuditHomeSeedResult
}): Promise<Record<string, string> | null> {
  switch (input.scenarioId) {
    case 'terminal-cold-boot':
    case 'sidebar-search-large-corpus':
      return buildTerminalBrowserStorageSeed()
    case 'agent-chat-cold-boot':
      return buildAgentChatBrowserStorageSeed()
    case 'offscreen-tab-selection':
      return buildOffscreenTabBrowserStorageSeed()
    case 'terminal-reconnect-backlog':
      return (await bootstrapReconnectScenario(input.serverInfo, input.seedResult)).browserStorageSeed
    default:
      return null
  }
}

function getActiveTerminalId(state: unknown): string | null {
  const record = state as {
    tabs?: { activeTabId?: string | null }
    panes?: { layouts?: Record<string, unknown> }
  }
  const activeTabId = record.tabs?.activeTabId
  if (!activeTabId) return null
  const layout = record.panes?.layouts?.[activeTabId] as {
    type?: string
    content?: { kind?: string; terminalId?: string }
    children?: unknown[]
  } | undefined
  if (!layout) return null

  const queue: Array<typeof layout> = [layout]
  while (queue.length > 0) {
    const node = queue.shift()
    if (!node) continue
    if (node.type === 'leaf' && node.content?.kind === 'terminal' && typeof node.content.terminalId === 'string') {
      return node.content.terminalId
    }
    if (Array.isArray(node.children)) {
      queue.push(...(node.children as Array<typeof layout>))
    }
  }

  return null
}

async function driveScenarioInteraction(input: {
  scenarioId: VisibleFirstScenarioId
  profileId: VisibleFirstProfileId
  page: Page
  harness: TestHarness
  terminal: TerminalHelper
}): Promise<void> {
  switch (input.scenarioId) {
    case 'sidebar-search-large-corpus': {
      if (input.profileId === 'mobile_restricted') {
        await input.page.evaluate(() => {
          (document.querySelector('button[aria-label="Show sidebar"]') as HTMLButtonElement | null)?.click()
        })
      } else {
        const showSidebarButton = input.page.locator('button[aria-label="Show sidebar"]:visible').first()
        if (await showSidebarButton.isVisible().catch(() => false)) {
          await showSidebarButton.click()
        }
      }
      const searchInput = input.page.getByPlaceholder('Search...').first()
      await searchInput.waitFor({ state: 'visible', timeout: SAMPLE_TIMEOUT_MS })
      await searchInput.fill('alpha')
      return
    }
    case 'offscreen-tab-selection': {
      if (input.profileId === 'mobile_restricted') {
        await input.page.evaluate(() => {
          (document.querySelector('button[aria-label="Next tab"]') as HTMLButtonElement | null)?.click()
        })
        return
      }
      await input.page.locator('[data-context="tab"][data-tab-id="tab-heavy-agent-chat"]').click()
      return
    }
    case 'terminal-reconnect-backlog': {
      const terminalId = getActiveTerminalId(await input.harness.getState())
      if (terminalId) {
        await input.terminal.waitForOutput('backlog line 1200', {
          timeout: SAMPLE_TIMEOUT_MS,
          terminalId,
        })
      }
      return
    }
    default:
      return
  }
}

async function executeSampleDefault(
  input: RunVisibleFirstAuditSampleInput,
): Promise<SampleCollectors> {
  let seedResult: VisibleFirstAuditHomeSeedResult | null = null
  const scenario = getScenarioDefinition(input.scenarioId)
  const server = new TestServer({
    preserveHomeOnStop: true,
    setupHome: async (homeDir) => {
      seedResult = await seedVisibleFirstAuditServerHome(homeDir)
    },
  })

  let browser: Browser | null = null
  let context: BrowserContext | null = null
  let retainedHomeDir: string | null = null
  let debugLogPath: string | null = null

  try {
    const serverInfo = await server.start()
    retainedHomeDir = serverInfo.homeDir
    debugLogPath = serverInfo.debugLogPath
    if (!seedResult) {
      throw new Error('Visible-first server seed did not run before sample start')
    }

    browser = await chromium.launch({
      headless: true,
    })

    context = await browser.newContext(buildAuditContextOptions({
      profileId: input.profileId,
    }))
    const page = await context.newPage()
    await installRafGapSampler(page)
    const cdpSession = await context.newCDPSession(page)
    await applyProfileNetworkConditions(cdpSession, input.profileId)

    const recorder = createNetworkRecorder()
    const receivedWsFrames: ReceivedWsFrame[] = []
    cdpSession.on('Network.requestWillBeSent', (event) => recorder.onRequestWillBeSent(event))
    cdpSession.on('Network.responseReceived', (event) => recorder.onResponseReceived(event))
    cdpSession.on('Network.loadingFinished', (event) => recorder.onLoadingFinished(event))
    cdpSession.on('Network.webSocketFrameSent', (event) => recorder.onWebSocketFrameSent(event))
    cdpSession.on('Network.webSocketFrameReceived', (event) => {
      recorder.onWebSocketFrameReceived(event)
      const payload = event.response?.payloadData ?? ''
      receivedWsFrames.push({
        observedAtMs: Date.now(),
        type: classifyWsFrameType(payload),
        payloadLength: Buffer.byteLength(payload),
      })
    })

    const browserStorageSeed = await resolveBrowserStorageSeed({
      scenarioId: input.scenarioId,
      serverInfo,
      seedResult,
    })
    if (browserStorageSeed) {
      await applyBrowserStorageSeed(page, browserStorageSeed)
    }

    const url = new URL(scenario.buildUrl({
      token: serverInfo.token,
      profileId: input.profileId,
    }), serverInfo.baseUrl).toString()

    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const harness = new TestHarness(page)
    const terminal = new TerminalHelper(page)
    await harness.waitForHarness()

    if (input.scenarioId !== 'auth-required-cold-boot') {
      await harness.waitForConnection()
    }

    await driveScenarioInteraction({
      scenarioId: input.scenarioId,
      profileId: input.profileId,
      page,
      harness,
      terminal,
    })

    await waitForAuditMilestone(page, harness, scenario.focusedReadyMilestone)

    await waitForRafSampler(page)
    const browserSnapshot = await harness.getPerfAuditSnapshot()
    if (!browserSnapshot) {
      throw new Error('Perf audit snapshot was not available from the test harness')
    }
    const rafGapSummary = await readRafGapSummary(page)
    if (rafGapSummary) {
      browserSnapshot.perfEvents.push(rafGapSummary)
    }

    if (input.scenarioId === 'terminal-reconnect-backlog') {
      browserSnapshot.perfEvents.push(await runReconnectStopResumeProof({
        browser,
        page,
        serverInfo,
        harness,
        terminal,
        receivedWsFrames,
      }))
    }

    const browserTimeOriginMs = await page.evaluate(() => performance.timeOrigin)
    const rawCapture = recorder.snapshot()
    const normalizedCapture = normalizeTransportCapture(rawCapture, browserTimeOriginMs)

    await context.close()
    context = null
    await browser.close()
    browser = null

    await server.stop()

    if (!debugLogPath) {
      throw new Error('Visible-first sample did not expose a debug log path')
    }
    const serverLogs = await parseVisibleFirstServerLogs(debugLogPath)
    return {
      browser: browserSnapshot,
      transport: {
        http: normalizedCapture.http,
        ws: normalizedCapture.ws,
        summary: summarizeNetworkCapture(normalizedCapture),
      },
      server: serverLogs,
    }
  } finally {
    if (context) {
      await context.close().catch(() => {})
    }
    if (browser) {
      await browser.close().catch(() => {})
    }
    await server.stop().catch(() => {})
    if (retainedHomeDir) {
      await fs.rm(retainedHomeDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export async function runVisibleFirstAuditSample(
  input: RunVisibleFirstAuditSampleInput,
): Promise<VisibleFirstAuditSample> {
  const scenario = getScenarioDefinition(input.scenarioId)
  const startedAtDate = new Date()
  const startTimeMs = Date.now()
  const collectors = emptyCollectors()
  const errors: string[] = []
  let status: VisibleFirstAuditSample['status'] = 'ok'
  let derived: Record<string, unknown> = {}

  try {
    const executeSample = input.deps?.executeSample ?? executeSampleDefault
    const result = await executeSample(input)
    collectors.browser = result.browser
    collectors.transport = result.transport
    collectors.server = result.server

    if (typeof collectors.browser.milestones[scenario.focusedReadyMilestone] !== 'number') {
      throw new Error(`Missing focused-ready milestone: ${scenario.focusedReadyMilestone}`)
    }

    if (
      !Array.isArray(collectors.transport.http.requests)
      || !Array.isArray(collectors.transport.ws.frames)
    ) {
      throw new Error('Missing CDP transport capture for audit sample')
    }

    derived = deriveVisibleFirstMetrics({
      focusedReadyMilestone: scenario.focusedReadyMilestone,
      allowedApiRouteIdsBeforeReady: scenario.allowedApiRouteIdsBeforeReady,
      allowedWsTypesBeforeReady: scenario.allowedWsTypesBeforeReady,
      browser: collectors.browser,
      transport: collectors.transport,
      server: {
        terminalReplayEvents: collectors.server.terminalReplayEvents,
      },
    })
    assertRequiredMetricsPresent(scenario, derived)
    if (scenario.id === 'terminal-reconnect-backlog') {
      assertTerminalReconnectTargets(derived)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(message)
    status = /timed out|timeout/i.test(message) ? 'timeout' : 'error'
  }

  const finishedAtDate = new Date()

  return {
    profileId: input.profileId,
    status,
    startedAt: startedAtDate.toISOString(),
    finishedAt: finishedAtDate.toISOString(),
    durationMs: Math.max(0, Date.now() - startTimeMs),
    browser: collectors.browser,
    transport: collectors.transport,
    server: collectors.server,
    derived,
    errors,
  }
}
