import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test'
import type { PerfAuditSnapshot } from '@/lib/perf-audit-bridge'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { TestServer, type TestServerInfo } from '../helpers/test-server.js'
import {
  VisibleFirstAuditSampleSchema,
  type VisibleFirstAuditSample,
  type VisibleFirstProfileId,
  type VisibleFirstScenarioId,
} from './audit-contract.js'
import { buildAuditContextOptions, applyProfileNetworkConditions } from './create-audit-context.js'
import { deriveVisibleFirstMetrics } from './derive-visible-first-metrics.js'
import {
  createNetworkRecorder,
  summarizeNetworkCapture,
  type NetworkCapture,
  type NetworkCaptureSummary,
} from './network-recorder.js'
import { parseVisibleFirstServerLogs } from './parse-server-logs.js'
import { AUDIT_SCENARIOS } from './scenarios.js'
import {
  buildAgentChatBrowserStorageSeed,
  buildOffscreenTabBrowserStorageSeed,
} from './seed-browser-storage.js'
import { seedVisibleFirstAuditServerHome } from './seed-server-home.js'

type SampleExecutionArtifacts = {
  browser: PerfAuditSnapshot
  transport: NetworkCapture & {
    summary: NetworkCaptureSummary
  }
  server: Awaited<ReturnType<typeof parseVisibleFirstServerLogs>>
}

type RunVisibleFirstAuditSampleInput = {
  scenarioId: VisibleFirstScenarioId
  profileId: VisibleFirstProfileId
  deps?: {
    executeSample?: (input: {
      scenarioId: VisibleFirstScenarioId
      profileId: VisibleFirstProfileId
    }) => Promise<SampleExecutionArtifacts>
  }
}

function getScenarioDefinition(scenarioId: VisibleFirstScenarioId) {
  const scenario = AUDIT_SCENARIOS.find((candidate) => candidate.id === scenarioId)
  if (!scenario) {
    throw new Error(`Unknown visible-first audit scenario: ${scenarioId}`)
  }
  return scenario
}

async function applyBrowserStorageSeed(page: Page, seed: Record<string, string> | undefined): Promise<void> {
  if (!seed || Object.keys(seed).length === 0) return

  await page.addInitScript((entries: Array<[string, string]>) => {
    for (const [key, value] of entries) {
      window.localStorage.setItem(key, value)
    }
  }, Object.entries(seed))
}

async function waitForPerfAuditMilestone(
  page: Page,
  milestone: string,
  timeoutMs = 30_000,
): Promise<void> {
  await page.waitForFunction(
    (targetMilestone) => {
      const snapshot = window.__FRESHELL_TEST_HARNESS__?.getPerfAuditSnapshot()
      return typeof snapshot?.milestones?.[targetMilestone] === 'number'
    },
    milestone,
    { timeout: timeoutMs },
  )
}

async function readPerfAuditSnapshot(page: Page): Promise<PerfAuditSnapshot> {
  const snapshot = await page.evaluate(() => {
    return window.__FRESHELL_TEST_HARNESS__?.getPerfAuditSnapshot() ?? null
  })

  if (!snapshot) {
    throw new Error('Perf audit snapshot unavailable from test harness')
  }

  return snapshot as PerfAuditSnapshot
}

async function maybeDriveScenarioInteraction(input: {
  scenarioId: VisibleFirstScenarioId
  page: Page
  harness: TestHarness
  terminal: TerminalHelper
  serverInfo: TestServerInfo
}): Promise<void> {
  switch (input.scenarioId) {
    case 'sidebar-search-large-corpus':
      await input.harness.waitForConnection()
      await input.page.getByPlaceholder('Search...').fill('alpha')
      return
    case 'offscreen-tab-selection':
      await input.harness.waitForConnection()
      await input.page.getByRole('button', { name: /background agent chat/i }).click()
      return
    case 'terminal-reconnect-backlog':
      await input.harness.waitForConnection()
      await input.terminal.waitForTerminal()
      await input.terminal.waitForPrompt()
      return
    case 'agent-chat-cold-boot':
    case 'terminal-cold-boot':
      await input.harness.waitForConnection()
      return
    case 'auth-required-cold-boot':
      return
    default:
      return
  }
}

function resolveBrowserStorageSeed(
  scenarioId: VisibleFirstScenarioId,
): Record<string, string> | undefined {
  switch (scenarioId) {
    case 'agent-chat-cold-boot':
      return buildAgentChatBrowserStorageSeed()
    case 'offscreen-tab-selection':
      return buildOffscreenTabBrowserStorageSeed()
    default:
      return undefined
  }
}

async function executeVisibleFirstAuditSample(input: {
  scenarioId: VisibleFirstScenarioId
  profileId: VisibleFirstProfileId
}): Promise<SampleExecutionArtifacts> {
  const scenario = getScenarioDefinition(input.scenarioId)
  const server = new TestServer({
    preserveHomeOnStop: true,
    setupHome: seedVisibleFirstAuditServerHome,
  })

  let browser: Browser | null = null
  let context: BrowserContext | null = null

  try {
    const serverInfo = await server.start()
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext(buildAuditContextOptions({ profileId: input.profileId }))
    const page = await context.newPage()
    const harness = new TestHarness(page)
    const terminal = new TerminalHelper(page)
    const cdpSession = await context.newCDPSession(page)
    const recorder = createNetworkRecorder()

    cdpSession.on('Network.requestWillBeSent', (event) => recorder.onRequestWillBeSent(event as never))
    cdpSession.on('Network.responseReceived', (event) => recorder.onResponseReceived(event as never))
    cdpSession.on('Network.loadingFinished', (event) => recorder.onLoadingFinished(event as never))
    cdpSession.on('Network.webSocketFrameSent', (event) => recorder.onWebSocketFrameSent(event as never))
    cdpSession.on('Network.webSocketFrameReceived', (event) => recorder.onWebSocketFrameReceived(event as never))
    await applyProfileNetworkConditions(cdpSession as Pick<CDPSession, 'send'>, input.profileId)
    await applyBrowserStorageSeed(page, resolveBrowserStorageSeed(input.scenarioId))

    const pathWithQuery = scenario.buildUrl({
      profileId: input.profileId,
      token: serverInfo.token,
    })
    await page.goto(new URL(pathWithQuery, serverInfo.baseUrl).toString(), {
      waitUntil: 'domcontentloaded',
    })
    await harness.waitForHarness()
    await maybeDriveScenarioInteraction({
      scenarioId: input.scenarioId,
      page,
      harness,
      terminal,
      serverInfo,
    })
    await waitForPerfAuditMilestone(page, scenario.focusedReadyMilestone)

    const browserSnapshot = await readPerfAuditSnapshot(page)
    const transport = recorder.snapshot()
    return {
      browser: browserSnapshot,
      transport: {
        ...transport,
        summary: summarizeNetworkCapture(transport),
      },
      server: await parseVisibleFirstServerLogs(serverInfo.debugLogPath),
    }
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await server.stop().catch(() => {})
  }
}

export async function runVisibleFirstAuditSample(
  input: RunVisibleFirstAuditSampleInput,
): Promise<VisibleFirstAuditSample> {
  const scenario = getScenarioDefinition(input.scenarioId)
  const startedAt = new Date().toISOString()
  const startedAtMs = Date.now()

  try {
    const execution = input.deps?.executeSample
      ? await input.deps.executeSample({
        scenarioId: input.scenarioId,
        profileId: input.profileId,
      })
      : await executeVisibleFirstAuditSample({
        scenarioId: input.scenarioId,
        profileId: input.profileId,
      })

    const sample = VisibleFirstAuditSampleSchema.parse({
      profileId: input.profileId,
      status: 'ok',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      browser: execution.browser,
      transport: execution.transport,
      server: execution.server,
      derived: deriveVisibleFirstMetrics({
        focusedReadyMilestone: scenario.focusedReadyMilestone,
        allowedApiRouteIdsBeforeReady: scenario.allowedApiRouteIdsBeforeReady,
        allowedWsTypesBeforeReady: scenario.allowedWsTypesBeforeReady,
        browser: execution.browser,
        transport: execution.transport,
      }),
      errors: [],
    })

    return sample
  } catch (error) {
    return VisibleFirstAuditSampleSchema.parse({
      profileId: input.profileId,
      status: error instanceof Error && /timeout/i.test(error.message) ? 'timeout' : 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      browser: {},
      transport: {},
      server: {},
      derived: {},
      errors: [error instanceof Error ? error.message : String(error)],
    })
  }
}
