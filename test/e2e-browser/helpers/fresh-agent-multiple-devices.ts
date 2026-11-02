import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page, WebSocketRoute } from '@playwright/test'
import { expect } from '@playwright/test'
import { openPanePicker } from './pane-picker.js'
import { installRecoveryOfferAutoDeclineOnContext } from './recovery-offer.js'
import { RustServer } from './rust-server.js'
import type { E2eServerInfo } from './server-fixture-support.js'
import { TestHarness } from './test-harness.js'
import { claudeSimulatorServerEnv } from './claude-sim-lane.js'

export type FreshAgentMultipleDeviceMode = 'freshclaude' | 'kilroy' | 'freshcodex' | 'freshopencode'
export const FORK_PARENT_CONTINUATION_PROMPT = 'stage1 parent continues after desktop fork'
type Provider = 'claude' | 'codex' | 'opencode'

type JsonRow = Record<string, unknown>
type Device = {
  context: BrowserContext
  page: Page
  harness: TestHarness
  tabId: string
  paneId: string
  frames: JsonRow[]
  createdReplies: CreatedReplyGate
}

type DevicePage = Pick<Device, 'context' | 'page' | 'harness' | 'frames' | 'createdReplies'>

type CreatedReplyGate = {
  holdNext: () => void
  waitForHeld: (timeoutMs?: number) => Promise<JsonRow>
  release: () => void
}

type NativeFixture = {
  info: E2eServerInfo
  rows: () => JsonRow[]
  bootCount: (sessionId?: string) => number
  stopCount: (sessionId?: string) => number
  holdNextTurn: (sessionId?: string) => Promise<void>
  releaseTurn: () => Promise<void>
  waitForHeldTurn: (prompt: string, sessionId?: string) => Promise<string>
}

export type FreshAgentMultipleDeviceSession = {
  desktop: Device
  mobile: Device
  native: NativeFixture
  session: { provider: Provider; sessionType: FreshAgentMultipleDeviceMode; sessionId: string }
  frames: { desktop: JsonRow[]; mobile: JsonRow[] }
  openView: (device: 'desktop' | 'mobile', sessionId: string) => Promise<Device>
  close: () => Promise<void>
}

type TestFixtures = { browser: Browser }

const PROVIDER_BY_MODE: Record<FreshAgentMultipleDeviceMode, Provider> = {
  freshclaude: 'claude',
  kilroy: 'claude',
  freshcodex: 'codex',
  freshopencode: 'opencode',
}
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PANE_LABEL_BY_MODE: Record<FreshAgentMultipleDeviceMode, string> = {
  freshclaude: 'Freshclaude',
  kilroy: 'Kilroy',
  freshcodex: 'Freshcodex',
  freshopencode: 'Freshopencode',
}

const FRESH_AGENT_MODE = /^(freshclaude|kilroy|freshcodex|freshopencode)$/

function readJsonl(filePath: string): JsonRow[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const row: unknown = JSON.parse(line)
      return row && typeof row === 'object' && !Array.isArray(row) ? [row as JsonRow] : []
    } catch {
      return []
    }
  })
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function findFreshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findFreshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

async function waitForPaneStatus(device: Device, status: string | RegExp, timeoutMs = 45_000): Promise<void> {
  await expect.poll(async () => {
    const leaf = findFreshAgentLeaf(await device.harness.getPaneLayout(device.tabId))
    return leaf?.content?.status ?? null
  }, { timeout: timeoutMs, message: `waiting for ${device.tabId} fresh-agent status ${String(status)}` })
    .toMatch(typeof status === 'string' ? new RegExp(`^${status}$`) : status)
}

async function waitForFreshAgentSessionId(device: Device, timeoutMs = 45_000): Promise<string> {
  let sessionId = ''
  await expect.poll(async () => {
    const leaf = findFreshAgentLeaf(await device.harness.getPaneLayout(device.tabId))
    sessionId = leaf?.content?.sessionRef?.sessionId ?? ''
    return sessionId
  }, { timeout: timeoutMs, message: 'waiting for the canonical durable Fresh Agent locator' }).not.toBe('')
  return sessionId
}

async function enableCli(page: Page, provider: Provider): Promise<void> {
  await page.evaluate((currentProvider) => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { [currentProvider]: true },
    })
  }, provider)
}

async function createFreshAgentPane(page: Page, mode: FreshAgentMultipleDeviceMode, cwd: string): Promise<void> {
  const label = PANE_LABEL_BY_MODE[mode]
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).click({ force: true })
  const directoryInput = page.getByLabel(new RegExp(`^Starting directory for ${label}$`, 'i'))
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })
}

async function sendComposerText(page: Page, text: string): Promise<void> {
  const pane = page.locator('[data-context="fresh-agent"]').last()
  await pane.getByRole('textbox', { name: 'Chat message input' }).fill(text)
  await pane.getByRole('button', { name: 'Send', exact: true }).click()
}

async function newDeviceContext(browser: Browser, mobile: boolean): Promise<BrowserContext> {
  const context = await browser.newContext(mobile
    ? {
        viewport: { width: 393, height: 851 },
        screen: { width: 393, height: 851 },
        deviceScaleFactor: 2.75,
        isMobile: true,
        hasTouch: true,
      }
    : {
        viewport: { width: 1440, height: 900 },
        isMobile: false,
        hasTouch: false,
      })
  installRecoveryOfferAutoDeclineOnContext(context)
  return context
}

function appendFrame(frames: JsonRow[], direction: 'sent' | 'received', payload: unknown): void {
  if (typeof payload !== 'string') return
  try {
    const frame: unknown = JSON.parse(payload)
    if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
      frames.push({ direction, ...(frame as JsonRow) })
    }
  } catch {
    // Ignore non-JSON WebSocket frames.
  }
}

async function openDevicePage(
  context: BrowserContext,
  info: E2eServerInfo,
  frames: JsonRow[],
  createdReplies: CreatedReplyGate,
): Promise<DevicePage> {
  const page = await context.newPage()
  const ownedWsOrigin = info.baseUrl.replace(/^http/, 'ws')
  page.on('websocket', (socket) => {
    if (!socket.url().startsWith(ownedWsOrigin)) return
    socket.on('framesent', ({ payload }) => appendFrame(frames, 'sent', payload))
    socket.on('framereceived', ({ payload }) => appendFrame(frames, 'received', payload))
  })
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const machineChooser = page.getByRole('dialog', { name: 'Choose a machine' })
  await page.waitForFunction(() => Boolean(
    document.querySelector('[data-testid="sidebar-session-list"]')
      || (document.querySelector('section[role="dialog"]')?.textContent ?? '').includes('Choose a machine'),
  ), undefined, { timeout: 15_000 }).catch(() => {})
  if (await machineChooser.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Add this machine' }).click()
    await machineChooser.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
  }
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { context, page, harness, frames, createdReplies }
}

function createCreatedReplyGate(): {
  gate: CreatedReplyGate
  intercept: (client: WebSocketRoute, raw: unknown) => boolean
} {
  let shouldHoldNext = false
  let held: { raw: string; frame: JsonRow } | undefined
  let resolveHeld: ((frame: JsonRow) => void) | undefined
  let heldPromise: Promise<JsonRow> | undefined
  let sendHeld: ((raw: string) => void) | undefined

  const gate: CreatedReplyGate = {
    holdNext: () => {
      if (shouldHoldNext || held) throw new Error('a freshAgent.created reply is already held or armed')
      shouldHoldNext = true
      heldPromise = new Promise<JsonRow>((resolve) => { resolveHeld = resolve })
    },
    waitForHeld: (timeoutMs = 45_000) => {
      if (held) return Promise.resolve(held.frame)
      if (!heldPromise) throw new Error('holdNext must be called before waiting for a freshAgent.created reply')
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Timed out after ${timeoutMs}ms waiting for a freshAgent.created reply`,
        )), timeoutMs)
      })
      return Promise.race([heldPromise, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
      })
    },
    release: () => {
      if (!held || !sendHeld) throw new Error('no freshAgent.created reply is currently held')
      const pending = held
      held = undefined
      sendHeld(pending.raw)
      sendHeld = undefined
      resolveHeld = undefined
      heldPromise = undefined
    },
  }

  return {
    gate,
    intercept: (client, raw) => {
      if (!shouldHoldNext || typeof raw !== 'string') return false
      let frame: unknown
      try { frame = JSON.parse(raw) } catch { return false }
      if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== 'freshAgent.created') return false
      held = { raw, frame: frame as JsonRow }
      shouldHoldNext = false
      sendHeld = (message) => client.send(message)
      resolveHeld?.(held.frame)
      return true
    },
  }
}

async function installCreatedReplyGate(
  context: BrowserContext,
  info: E2eServerInfo,
  gate: ReturnType<typeof createCreatedReplyGate>,
): Promise<void> {
  const wsOrigin = new URL(info.baseUrl.replace(/^http/, 'ws')).origin
  await context.routeWebSocket((url) => url.origin === wsOrigin && url.pathname === '/ws', (client) => {
    const server = client.connectToServer()
    client.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      if (gate.intercept(client, message)) return
      client.send(message)
    })
    client.onClose((code, reason) => void server.close({ code, reason }).catch(() => {}))
    server.onClose((code, reason) => void client.close({ code, reason }).catch(() => {}))
  })
}

async function seedHome(homeDir: string, provider: Provider): Promise<void> {
  const freshellDir = path.join(homeDir, '.freshell')
  await fs.mkdir(freshellDir, { recursive: true })
  await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
    version: 1,
    settings: {
      codingCli: { enabledProviders: [provider] },
      freshAgent: { enabled: true },
    },
  }, null, 2))
  if (provider === 'claude') await fs.mkdir(path.join(homeDir, '.claude', 'projects'), { recursive: true })
  if (provider === 'codex') await fs.mkdir(path.join(homeDir, '.codex', 'sessions'), { recursive: true })
}

async function openFreshAgentView(
  device: DevicePage,
  sessionId: string,
  provider: Provider,
  sessionType: string,
  cwd: string,
): Promise<{ tabId: string; paneId: string }> {
  // Create an independent browser-owned pane at the known durable locator.
  // The actual FreshAgentView mounts and performs the normal WS attach; this
  // avoids coupling a view-lifecycle test to session-directory discovery.
  const before = await device.harness.getTabCount()
  const tabId = `multiple-device-tab-${sessionType}-${Date.now()}`
  const paneId = `multiple-device-pane-${sessionType}-${Date.now()}`
  const viewId = `multiple-device-view-${sessionType}-${Date.now()}`
  const createRequestId = `multiple-device-${sessionType}-${Date.now()}`
  await device.page.evaluate(({ currentTabId, currentPaneId, currentProvider, currentSessionId, currentSessionType, currentCreateRequestId, currentViewId, currentCwd }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({ type: 'tabs/addTab', payload: { id: currentTabId, title: 'Shared Fresh Agent', mode: 'shell' } })
    harness?.dispatch({
      type: 'panes/initLayout',
      payload: {
        tabId: currentTabId,
        paneId: currentPaneId,
        content: {
          kind: 'fresh-agent',
          provider: currentProvider,
          sessionType: currentSessionType,
          initialCwd: currentCwd,
          createRequestId: currentCreateRequestId,
          viewId: currentViewId,
          sessionId: currentSessionId,
          sessionRef: { provider: currentProvider, sessionId: currentSessionId },
          resumeSessionId: currentSessionId,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
  }, {
    currentTabId: tabId,
    currentPaneId: paneId,
    currentProvider: provider,
    currentSessionId: sessionId,
    currentSessionType: sessionType,
    currentCreateRequestId: createRequestId,
    currentViewId: viewId,
    currentCwd: cwd,
  })
  await expect.poll(() => device.harness.getTabCount(), { timeout: 15_000 }).toBe(before + 1)
  const activeTabId = await device.harness.getActiveTabId()
  expect(activeTabId).toBe(tabId)
  await expect.poll(async () => {
    const leaf = findFreshAgentLeaf(await device.harness.getPaneLayout(tabId))
    return leaf?.id ?? ''
  }, { timeout: 15_000, message: 'the mobile test pane contains the canonical Fresh Agent locator' }).toBe(paneId)
  await expect(device.page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => device.frames.some((frame) => frame.direction === 'sent'
    && frame.type === 'freshAgent.attach'
    && frame.sessionId === sessionId
    && frame.viewId === viewId), {
    timeout: 15_000,
    message: 'the mobile FreshAgentView attached to the canonical locator with its own view id',
  }).toBe(true)
  // The tracked, live Codex attach path intentionally has no response frame
  // (it is a parity no-op). Callers prove the view remains usable through the
  // later status or shared-stream assertions in their scenario.
  return { tabId, paneId }
}

async function fetchSnapshot(info: E2eServerInfo, session: { sessionType: string; provider: Provider; sessionId: string }): Promise<any> {
  const response = await fetch(
    `${info.baseUrl}/api/fresh-agent/threads/${session.sessionType}/${session.provider}/${encodeURIComponent(session.sessionId)}`,
    { headers: { 'x-auth-token': info.token } },
  )
  if (!response.ok) throw new Error(`fresh-agent snapshot request failed (${response.status}): ${await response.text()}`)
  return response.json()
}

function countText(value: unknown, text: string): number {
  if (typeof value === 'string') return value === text ? 1 : 0
  if (Array.isArray(value)) return value.reduce((count, item) => count + countText(item, text), 0)
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((count, item) => count + countText(item, text), 0)
  }
  return 0
}

function nativeFixture(input: {
  mode: FreshAgentMultipleDeviceMode
  rowsPath: string
  notificationPath?: string
  additionalAuditPaths?: string[]
  gatePath: string
  info: E2eServerInfo
  sessionId: string
}): NativeFixture {
  const rows = () => [
    ...readJsonl(input.rowsPath),
    ...(input.notificationPath ? readJsonl(input.notificationPath) : []),
    ...(input.additionalAuditPaths ?? []).flatMap(readJsonl),
  ]
  const promptText = (row: JsonRow) => typeof row.prompt === 'string' ? row.prompt : undefined
  const heldPromptCount = (sessionId = input.sessionId) => {
    switch (input.mode) {
      case 'freshclaude':
      case 'kilroy':
        return rows().filter((row) => row.kind === 'native_gate_wait' && row.sessionId === sessionId).length
      case 'freshcodex':
        return rows().filter((row) => row.method === 'item/agentMessage/delta' && row.threadId === sessionId).length
      case 'freshopencode':
        return rows().filter((row) => row.event === 'prompt_async'
          && row.sessionId === sessionId && promptText(row)).length
    }
  }
  let heldPromptCountBefore = 0
  let heldPromptSessionId = input.sessionId
  let heldRowsCountBefore = 0
  return {
    info: input.info,
    rows,
    bootCount: (sessionId) => {
      if (sessionId) {
        if (input.mode === 'freshclaude' || input.mode === 'kilroy') {
          return rows().filter((row) => row.kind === 'boot' && row.sessionId === sessionId).length
        }
        if (input.mode === 'freshcodex') {
          return rows().filter((row) => row.method === 'thread/start' && row.threadId === sessionId).length
        }
        return rows().filter((row) => row.event === 'launch' && row.rootSessionId === sessionId).length
      }
      return rows().filter((row) => input.mode === 'freshopencode'
        ? row.event === 'launch'
        : input.mode === 'freshclaude' || input.mode === 'kilroy'
          ? row.kind === 'boot'
          : row.event === 'native_boot').length
    },
    stopCount: (sessionId) => {
      if (input.mode === 'freshcodex') {
        // Codex termination deliberately uses SIGKILL after the server takes
        // ownership of the process tree, so the fake app-server cannot write
        // a SIGTERM-handler row. Observe the PID it actually reported at boot.
        return rows().filter((row) => row.event === 'native_boot'
          && typeof row.pid === 'number'
          && !isProcessRunning(row.pid)).length
      }
      return rows().filter((row) => input.mode === 'freshopencode'
        ? row.event === 'native_stop' && row.sessionId === (sessionId ?? input.sessionId)
        : row.kind === 'native_stop' && row.sessionId === (sessionId ?? input.sessionId)).length
    },
    holdNextTurn: async (sessionId = input.sessionId) => {
      heldPromptSessionId = sessionId
      heldPromptCountBefore = heldPromptCount(sessionId)
      heldRowsCountBefore = rows().length
      await fs.rm(input.gatePath, { force: true })
    },
    releaseTurn: async () => fs.writeFile(input.gatePath, 'released\n'),
    waitForHeldTurn: async (prompt, sessionId = heldPromptSessionId) => {
      let observedSessionId = sessionId
      await expect.poll(() => {
        if (input.mode === 'freshopencode') {
          const promptedRows = rows().slice(heldRowsCountBefore).filter((row) => row.event === 'prompt_async'
            && promptText(row) === prompt)
          if (promptedRows.length === 0) return false
          observedSessionId = String(promptedRows[promptedRows.length - 1].sessionId)
        } else if (heldPromptCount(sessionId) <= heldPromptCountBefore) {
          return false
        }
        if (input.mode !== 'freshopencode') return true
        const sessionRows = rows().filter((row) => row.sessionId === observedSessionId)
        const busyCount = sessionRows.filter((row) => row.event === 'session_status_emitted' && row.status === 'busy').length
        const idleCount = sessionRows.filter((row) => row.event === 'session_idle_emitted').length
        return busyCount > idleCount
      }, {
        timeout: 30_000,
        message: `${input.mode} native fixture reached its held prompt gate`,
      }).toBe(true)
      return observedSessionId
    },
  }
}

async function startTwoDeviceSession(
  browser: Browser,
  mode: FreshAgentMultipleDeviceMode,
): Promise<FreshAgentMultipleDeviceSession> {
  if (!FRESH_AGENT_MODE.test(mode)) throw new Error(`unsupported Fresh Agent provider mode: ${mode}`)
  const provider = PROVIDER_BY_MODE[mode]
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `freshell-multiple-devices-${mode}-`))
  const projectDir = path.join(root, 'project')
  const gatePath = path.join(root, 'release-turn')
  const desktopFrames: JsonRow[] = []
  const mobileFrames: JsonRow[] = []
  const desktopContext = await newDeviceContext(browser, false)
  let mobileContext: BrowserContext | undefined
  let server: RustServer | undefined
  await fs.mkdir(projectDir, { recursive: true })
  // The first warm turn is allowed through. Removing this file holds the next
  // native operation, and restoring it is the explicit release action.
  await fs.writeFile(gatePath, 'warm-turn-ready\n')

  const rowsPath = mode === 'freshclaude' || mode === 'kilroy'
    ? path.join(root, 'claude-sim-ledger.jsonl')
    : mode === 'freshcodex'
      ? path.join(root, 'codex-native-lifecycle.jsonl')
      : path.join(root, 'opencode-audit.jsonl')
  const notificationsPath = path.join(root, 'codex-notifications.jsonl')
  const fakeOpencodePath = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')
  let env: Record<string, string> = {}
  let additionalAuditPaths: string[] | undefined
  if (mode === 'freshclaude' || mode === 'kilroy') {
    env = claudeSimulatorServerEnv({
      ledgerPath: rowsPath,
      flavour: mode,
      program: {
        rules: [
          { on: 'msg:prompt', match: { text: 'stage1 shared held prompt' }, emit: [{ kind: 'text', data: { text: 'Stage1 shared response' } }] },
          { on: 'msg:prompt', match: { text: FORK_PARENT_CONTINUATION_PROMPT }, emit: [{ kind: 'text', data: { text: 'Stage1 shared response' } }] },
          { on: 'msg:prompt', match: { text: 'stage1 terminate held prompt' }, emit: [{ kind: 'text', data: { text: 'Stage1 terminate response' } }] },
        ],
      },
      extra: {
        FRESHELL_CLAUDE_SIM_HOLD_PROMPT_GATE_PATH: gatePath,
        FRESHELL_CLAUDE_SIM_RECORD_NATIVE_STOP: '1',
      },
    })
  } else if (mode === 'freshcodex') {
    const operationsPath = path.join(root, 'codex-operations.jsonl')
    const requestsPath = path.join(root, 'codex-requests.jsonl')
    additionalAuditPaths = [operationsPath, requestsPath]
    env = {
      CODEX_CMD: `${process.execPath} ${path.resolve(__dirname, '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs')}`,
      FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
        // Each FreshCodex session launches its own fake app-server process.
        // IDs sequenced in config restart at index 0 per process, so use the
        // fixture's pid-scoped IDs to keep a new conversation distinct from
        // the shared parent thread.
        uniqueThreadIds: true,
        appendThreadOperationLogPath: operationsPath,
        appendRequestLogPath: requestsPath,
        appendNativeNotificationLogPath: notificationsPath,
        appendNativeLifecycleLogPath: rowsPath,
        waitForTurnReleasePath: gatePath,
        liveTranscript: true,
        liveTranscriptPrompts: [
          'stage1 warm session for multiple devices',
          'stage1 shared held prompt',
          FORK_PARENT_CONTINUATION_PROMPT,
          'stage1 terminate held prompt',
        ],
        recordTurns: true,
      }),
    }
  } else {
    const binDir = path.join(root, 'bin')
    await fs.mkdir(binDir, { recursive: true })
    const fakeOpencode = path.join(binDir, 'opencode')
    await fs.copyFile(fakeOpencodePath, fakeOpencode)
    await fs.chmod(fakeOpencode, 0o755)
    env = {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      OPENCODE_CMD: fakeOpencode,
      FAKE_OPENCODE_AUDIT_LOG: rowsPath,
      FAKE_OPENCODE_HOLD_PROMPT_GATE_PATH: gatePath,
      FAKE_OPENCODE_DEFER_PROMPT_ROWS_TO_GATE: '1',
      FAKE_OPENCODE_RECORD_NATIVE_STOP: '1',
    }
  }

  let info: E2eServerInfo
  let desktopOpen: { page: Page; harness: TestHarness }
  let mobileOpen: { page: Page; harness: TestHarness }
  let desktop: Device
  let mobile: Device
  let session: FreshAgentMultipleDeviceSession['session']
  let desktopCreatedReplyGate: ReturnType<typeof createCreatedReplyGate> | undefined
  let mobileCreatedReplyGate: ReturnType<typeof createCreatedReplyGate> | undefined
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await mobileContext?.close().catch(() => {})
    await desktopContext.close().catch(() => {})
    await server?.stop().catch(() => {})
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }

  try {
    server = new RustServer({
      env,
      setupHome: async (homeDir) => seedHome(homeDir, provider),
      verbose: process.env.FRESHELL_E2E_SERVER_VERBOSE === '1',
    })
    info = await server.start()
    mobileContext = await newDeviceContext(browser, true)
    desktopCreatedReplyGate = createCreatedReplyGate()
    mobileCreatedReplyGate = createCreatedReplyGate()
    await installCreatedReplyGate(desktopContext, info, desktopCreatedReplyGate)
    await installCreatedReplyGate(mobileContext, info, mobileCreatedReplyGate)
    desktopOpen = await openDevicePage(desktopContext, info, desktopFrames, desktopCreatedReplyGate.gate)
    mobileOpen = await openDevicePage(mobileContext, info, mobileFrames, mobileCreatedReplyGate.gate)

    const desktopDeviceId = await desktopOpen.page.evaluate(() => localStorage.getItem('freshell.device-id.v2'))
    const mobileDeviceId = await mobileOpen.page.evaluate(() => localStorage.getItem('freshell.device-id.v2'))
    expect(desktopDeviceId).toBeTruthy()
    expect(mobileDeviceId).toBeTruthy()
    expect(desktopDeviceId).not.toBe(mobileDeviceId)
    await desktopOpen.page.evaluate(() => localStorage.setItem('freshagent.multiple-devices-isolation-probe', 'desktop'))
    expect(await mobileOpen.page.evaluate(() => localStorage.getItem('freshagent.multiple-devices-isolation-probe'))).toBeNull()

    await enableCli(desktopOpen.page, provider)
    await createFreshAgentPane(desktopOpen.page, mode, projectDir)
    const desktopTabId = await desktopOpen.harness.getActiveTabId()
    expect(desktopTabId).toBeTruthy()
    desktop = {
      ...desktopOpen,
      tabId: desktopTabId!,
      paneId: '',
    }
    await waitForPaneStatus(desktop, /^(connected|idle)$/)
    await sendComposerText(desktop.page, 'stage1 warm session for multiple devices')
    await waitForPaneStatus(desktop, 'idle')
    const sessionId = await waitForFreshAgentSessionId(desktop)
    const desktopLeaf = findFreshAgentLeaf(await desktop.harness.getPaneLayout(desktop.tabId))
    desktop.paneId = desktopLeaf.id
    session = { provider, sessionType: mode, sessionId }

    const mobileSession = await openFreshAgentView(mobileOpen, sessionId, provider, mode, projectDir)
    mobile = { ...mobileOpen, ...mobileSession }
    await waitForPaneStatus(mobile, 'idle')

    const native = nativeFixture({
      mode,
      rowsPath,
      notificationPath: mode === 'freshcodex' ? notificationsPath : undefined,
      additionalAuditPaths,
      gatePath,
      info,
      sessionId,
    })
    await expect.poll(native.bootCount, { timeout: 30_000, message: 'the provider runtime has one native boot' }).toBe(1)

    return {
      desktop,
      mobile,
      native,
      session,
      frames: { desktop: desktopFrames, mobile: mobileFrames },
      openView: async (deviceName, viewSessionId) => {
        const target = deviceName === 'desktop' ? desktopOpen : mobileOpen
        const view = await openFreshAgentView(target, viewSessionId, provider, mode, projectDir)
        return { ...target, ...view }
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

/**
 * Build a real two-device Rust session and run the caller's assertions while
 * both independent browser contexts and the native provider fixture are alive.
 */
export function withTwoDeviceSession(
  mode: FreshAgentMultipleDeviceMode,
  body: (session: FreshAgentMultipleDeviceSession) => Promise<void>,
): (fixtures: TestFixtures) => Promise<void> {
  return async ({ browser }) => {
    const session = await startTwoDeviceSession(browser, mode)
    try {
      await body(session)
    } finally {
      await session.close()
    }
  }
}

export async function fetchFreshAgentSnapshot(
  info: E2eServerInfo,
  session: FreshAgentMultipleDeviceSession['session'],
): Promise<any> {
  return fetchSnapshot(info, session)
}
