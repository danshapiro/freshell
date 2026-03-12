import fs from 'fs/promises'
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
import { deriveVisibleFirstMetrics } from './derive-visible-first-metrics.js'
import {
  createNetworkRecorder,
  summarizeNetworkCapture,
  type NetworkCapture,
} from './network-recorder.js'
import { parseVisibleFirstServerLogs } from './parse-server-logs.js'
import { AUDIT_SCENARIOS } from './scenarios.js'
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

const SAMPLE_TIMEOUT_MS = 30_000
const TERMINAL_RECONNECT_CREATE_REQUEST_ID = 'visible-first-reconnect-create'

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
      parserDiagnostics: [],
    },
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
    const cdpSession = await context.newCDPSession(page)
    await applyProfileNetworkConditions(cdpSession, input.profileId)

    const recorder = createNetworkRecorder()
    cdpSession.on('Network.requestWillBeSent', (event) => recorder.onRequestWillBeSent(event))
    cdpSession.on('Network.responseReceived', (event) => recorder.onResponseReceived(event))
    cdpSession.on('Network.loadingFinished', (event) => recorder.onLoadingFinished(event))
    cdpSession.on('Network.webSocketFrameSent', (event) => recorder.onWebSocketFrameSent(event))
    cdpSession.on('Network.webSocketFrameReceived', (event) => recorder.onWebSocketFrameReceived(event))

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

    const browserSnapshot = await harness.getPerfAuditSnapshot()
    if (!browserSnapshot) {
      throw new Error('Perf audit snapshot was not available from the test harness')
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
    })
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
