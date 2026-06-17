import { expect, test } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TestServer } from '../helpers/test-server.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fakeOpencodeSource = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')
const TAB_REGISTRY_SYNC_INTERVAL_MS = 5000

type RestartMode = 'graceful' | 'kill'

type PaneSnapshot = {
  tabId: string
  paneId?: string
  mode?: string
  status?: string
  terminalId?: string
  sessionRef?: { provider?: string; sessionId?: string }
}

type FakeAuditEvent = {
  event?: string
  pid?: number
  argv?: string[]
  rootSessionId?: string
  childSessionId?: string
  sessionArg?: string
  data?: string
}

async function installFakeOpencode(binDir: string): Promise<void> {
  await fsp.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  await fsp.copyFile(fakeOpencodeSource, target)
  await fsp.chmod(target, 0o755)
}

function createSetupHome(
  sharedOpencodeDataDir: string,
  options: { terminalScrollback?: number } = {},
) {
  return async (homeDir: string): Promise<void> => {
    const xdgShare = path.join(homeDir, '.local', 'share')
    const freshellDir = path.join(homeDir, '.freshell')
    const opencodeLink = path.join(xdgShare, 'opencode')
    await fsp.mkdir(xdgShare, { recursive: true })
    await fsp.mkdir(freshellDir, { recursive: true })
    await fsp.mkdir(sharedOpencodeDataDir, { recursive: true })
    await fsp.rm(opencodeLink, { recursive: true, force: true }).catch(() => {})
    await fsp.symlink(sharedOpencodeDataDir, opencodeLink, 'dir')
    if (typeof options.terminalScrollback === 'number') {
      await fsp.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
        version: 1,
        settings: {
          terminal: { scrollback: options.terminalScrollback },
        },
      }, null, 2))
    }
  }
}

function createServerOptions(input: {
  binDir: string
  auditLogPath: string
  logsDir: string
  sharedOpencodeDataDir: string
  fakeOpencodeSessionEventGatePath?: string
  port?: number
  token?: string
  terminalScrollback?: number
  env?: Record<string, string>
}) {
  return {
    ...(input.port ? { port: input.port } : {}),
    ...(input.token ? { token: input.token } : {}),
    setupHome: createSetupHome(input.sharedOpencodeDataDir, {
      terminalScrollback: input.terminalScrollback,
    }),
    env: {
      PATH: `${input.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_OPENCODE_AUDIT_LOG: input.auditLogPath,
      ...(input.fakeOpencodeSessionEventGatePath ? { FAKE_OPENCODE_SESSION_EVENT_GATE_PATH: input.fakeOpencodeSessionEventGatePath } : {}),
      FRESHELL_LOG_DIR: input.logsDir,
      ...(input.env ?? {}),
    },
  }
}

async function addTerminalTab(page: any, input: {
  tabId: string
  paneId: string
  requestId: string
  mode: 'opencode' | 'shell'
  title: string
  cwd?: string
}): Promise<void> {
  await page.evaluate((payload) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) throw new Error('Freshell test harness is not installed')
    harness.dispatch({
      type: 'tabs/addTab',
      payload: {
        id: payload.tabId,
        title: payload.title,
        mode: payload.mode,
        status: 'creating',
        createRequestId: payload.requestId,
      },
    })
    harness.dispatch({
      type: 'panes/initLayout',
      payload: {
        tabId: payload.tabId,
        paneId: payload.paneId,
        content: {
          kind: 'terminal',
          mode: payload.mode,
          shell: 'system',
          createRequestId: payload.requestId,
          status: 'creating',
          ...(payload.cwd ? { initialCwd: payload.cwd } : {}),
        },
      },
    })
  }, input)
}

async function addOpenCodeTabThroughUi(page: any, cwd: string): Promise<string> {
  await page.locator('[data-context="tab-add"]').click()
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  await expect(picker).toBeVisible({ timeout: 15_000 })
  await picker.getByRole('button', { name: /^OpenCode$/i }).click()

  const directoryInput = page.getByLabel(/^Starting directory for OpenCode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')

  return page.evaluate(() => {
    const tabId = window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId
    if (typeof tabId !== 'string' || !tabId) {
      throw new Error('No active tab after creating OpenCode tab through UI')
    }
    return tabId
  })
}

async function getPaneSnapshots(page: any, tabIds: string[]): Promise<PaneSnapshot[]> {
  return page.evaluate((ids) => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const snapshots: PaneSnapshot[] = []
    const findTerminal = (node: any): any => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'terminal') {
        return { paneId: node.id, content: node.content }
      }
      if (node.type === 'split') {
        return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
      }
      return undefined
    }
    for (const tabId of ids) {
      const found = findTerminal(state?.panes?.layouts?.[tabId])
      snapshots.push({
        tabId,
        paneId: found?.paneId,
        mode: found?.content?.mode,
        status: found?.content?.status,
        terminalId: found?.content?.terminalId,
        sessionRef: found?.content?.sessionRef,
      })
    }
    return snapshots
  }, tabIds)
}

async function waitForOpenCodeSessions(page: any, tabIds: string[]): Promise<PaneSnapshot[]> {
  await page.waitForFunction((ids) => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const findTerminal = (node: any): any => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'terminal') return node.content
      if (node.type === 'split') return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
      return undefined
    }
    return ids.every((tabId) => {
      const content = findTerminal(state?.panes?.layouts?.[tabId])
      return content?.mode === 'opencode'
        && content.status === 'running'
        && typeof content.terminalId === 'string'
        && content.sessionRef?.provider === 'opencode'
        && typeof content.sessionRef.sessionId === 'string'
    })
  }, tabIds, { timeout: 30_000 })
  return getPaneSnapshots(page, tabIds)
}

async function waitForRunningTerminals(
  page: any,
  tabIds: string[],
  previousTerminalIdsByTab: Record<string, string | undefined> = {},
): Promise<PaneSnapshot[]> {
  try {
    await page.waitForFunction(({ ids, previousTerminalIds }) => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      const findTerminal = (node: any): any => {
        if (!node) return undefined
        if (node.type === 'leaf' && node.content?.kind === 'terminal') return node.content
        if (node.type === 'split') return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
        return undefined
      }
      return ids.every((tabId) => {
        const content = findTerminal(state?.panes?.layouts?.[tabId])
        return content?.status === 'running'
          && typeof content.terminalId === 'string'
          && content.terminalId !== previousTerminalIds[tabId]
      })
    }, { ids: tabIds, previousTerminalIds: previousTerminalIdsByTab }, { timeout: 45_000 })
  } catch (error) {
    const diagnostics = await page.evaluate(({ ids, previousTerminalIds }) => ({
      wsReadyState: window.__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
      connection: window.__FRESHELL_TEST_HARNESS__?.getState()?.connection,
      previousTerminalIds,
      snapshots: ids.map((tabId) => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState()
        const findTerminal = (node: any): any => {
          if (!node) return undefined
          if (node.type === 'leaf' && node.content?.kind === 'terminal') return { paneId: node.id, content: node.content }
          if (node.type === 'split') return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
          return undefined
        }
        const found = findTerminal(state?.panes?.layouts?.[tabId])
        return { tabId, paneId: found?.paneId, content: found?.content }
      }),
      terminalMessages: window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.()
        .filter((message: any) => typeof message?.type === 'string' && message.type.startsWith('terminal.')),
      errors: window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.()
        .filter((message: any) => message?.type === 'client.diagnostic' || message?.type === 'error'),
    }), { ids: tabIds, previousTerminalIds: previousTerminalIdsByTab })
    throw new Error(`Timed out waiting for running terminals: ${JSON.stringify(diagnostics, null, 2)}`, { cause: error })
  }
  return getPaneSnapshots(page, tabIds)
}

async function sendInputToTerminals(page: any, snapshots: PaneSnapshot[], label = 'hello'): Promise<void> {
  await page.evaluate(({ items, inputLabel }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) throw new Error('Freshell test harness is not installed')
    for (const item of items) {
      if (!item.terminalId) continue
      harness.sendWsMessage({
        type: 'terminal.input',
        terminalId: item.terminalId,
        data: `${inputLabel} ${item.tabId}\n`,
      })
    }
  }, { items: snapshots, inputLabel: label })
}

async function sendTerminalInputOverWs(input: {
  wsUrl: string
  token: string
  terminalId: string
  data: string
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(input.wsUrl)
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      ws.terminate()
      reject(new Error(`Timed out sending terminal input over websocket for ${input.terminalId}`))
    }, 10_000)

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      ws.removeAllListeners()
      try {
        ws.close()
      } catch {
        // ignore close failures in test cleanup
      }
      if (error) {
        reject(error)
        return
      }
      resolve()
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        token: input.token,
        protocolVersion: WS_PROTOCOL_VERSION,
      }))
    })

    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message?.type === 'ready') {
        ws.send(JSON.stringify({
          type: 'terminal.input',
          terminalId: input.terminalId,
          data: input.data,
        }), (error) => {
          if (error) {
            finish(error)
            return
          }
          setTimeout(() => finish(), 250)
        })
        return
      }
      if (message?.type === 'terminal.input.blocked') {
        finish(new Error(`Terminal input blocked for ${input.terminalId}: ${JSON.stringify(message)}`))
        return
      }
      if (message?.type === 'error') {
        finish(new Error(`Websocket input error for ${input.terminalId}: ${JSON.stringify(message)}`))
      }
    })

    ws.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))
    ws.on('close', () => {
      if (!settled) {
        finish(new Error(`Websocket closed before terminal input completed for ${input.terminalId}`))
      }
    })
  })
}

async function closeTab(page: any, tabId: string): Promise<void> {
  await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
  await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).getByRole('button', { name: /close/i }).click()
  await page.waitForFunction((closedTabId) => {
    const tabs = window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs ?? []
    return !tabs.some((tab: any) => tab.id === closedTabId)
  }, tabId, { timeout: 10_000 })
}

async function readAuditEvents(auditLogPath: string): Promise<FakeAuditEvent[]> {
  try {
    const text = await fsp.readFile(auditLogPath, 'utf8')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeAuditEvent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function waitForRestoreLaunches(
  auditLogPath: string,
  expectedSessionIds: string[],
): Promise<{ auditEvents: FakeAuditEvent[]; restoreLaunches: FakeAuditEvent[] }> {
  const expectedSet = new Set(expectedSessionIds)
  let latestAuditEvents: FakeAuditEvent[] = []
  await expect.poll(async () => {
    latestAuditEvents = await readAuditEvents(auditLogPath)
    return latestAuditEvents
      .filter((event) => event.event === 'launch' && event.sessionArg)
      .map((event) => event.sessionArg)
      .sort()
  }, { timeout: 15_000 }).toEqual([...expectedSet].sort())

  const restoreLaunches = latestAuditEvents.filter((event) => event.event === 'launch' && event.sessionArg)
  return { auditEvents: latestAuditEvents, restoreLaunches }
}

async function waitForInitialOpenCodeLaunch(auditLogPath: string): Promise<FakeAuditEvent> {
  let latestAuditEvents: FakeAuditEvent[] = []
  await expect.poll(async () => {
    latestAuditEvents = await readAuditEvents(auditLogPath)
    const launch = latestAuditEvents.find((event) =>
      event.event === 'launch'
      && !event.sessionArg
      && typeof event.rootSessionId === 'string'
    )
    return launch?.rootSessionId
  }, { timeout: 15_000 }).toMatch(/^ses_root_/)

  const launch = latestAuditEvents.find((event) =>
    event.event === 'launch'
    && !event.sessionArg
    && typeof event.rootSessionId === 'string'
  )
  if (!launch?.rootSessionId) {
    throw new Error(`Missing initial OpenCode launch audit: ${JSON.stringify(latestAuditEvents, null, 2)}`)
  }
  return launch
}

async function waitForSessionEventsEmitted(auditLogPath: string, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const events = await readAuditEvents(auditLogPath)
    return events.some((event) =>
      event.event === 'session_events_emitted'
      && event.rootSessionId === sessionId
    )
  }, { timeout: 15_000 }).toBe(true)
}

async function waitForStdinAudit(
  auditLogPath: string,
  expectedByTab: Array<{ tabId: string; sessionId: string }>,
  label: string,
): Promise<FakeAuditEvent[]> {
  let latestAuditEvents: FakeAuditEvent[] = []
  await expect.poll(async () => {
    latestAuditEvents = await readAuditEvents(auditLogPath)
    return expectedByTab.every(({ tabId, sessionId }) =>
      latestAuditEvents.some((event) =>
        event.event === 'stdin'
        && event.rootSessionId === sessionId
        && typeof event.data === 'string'
        && event.data.includes(`${label} ${tabId}`)
      )
    )
  }, { timeout: 15_000 }).toBe(true)
  return latestAuditEvents
}

async function readLogs(logsDir: string): Promise<string> {
  try {
    const entries = await fsp.readdir(logsDir)
    const chunks = await Promise.all(entries.map(async (entry) => {
      try {
        return await fsp.readFile(path.join(logsDir, entry), 'utf8')
      } catch {
        return ''
      }
    }))
    return chunks.join('\n')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function runRestartScenario(input: {
  page: any
  restartMode: RestartMode
  closeOneOpenCodePane: boolean
  includeShellPane: boolean
}) {
  const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `freshell-opencode-${input.restartMode}-`))
  const binDir = path.join(sharedRoot, 'bin')
  const logsDir = path.join(sharedRoot, 'logs')
  const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
  const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
  const sharedCwd = path.join(sharedRoot, 'project')
  await installFakeOpencode(binDir)
  await fsp.mkdir(sharedCwd, { recursive: true })

  const server1 = new TestServer(createServerOptions({
    binDir,
    auditLogPath,
    logsDir,
    sharedOpencodeDataDir,
  }))

  let server2: TestServer | undefined
  try {
    const info1 = await server1.start()
    await input.page.goto(`${info1.baseUrl}/?token=${info1.token}&e2e=1`)

    const harness = new TestHarness(input.page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    const opencodeTabs = [
      { tabId: 'tab-opencode-1', paneId: 'pane-opencode-1', requestId: 'req-opencode-1', mode: 'opencode' as const, title: 'OpenCode 1' },
      { tabId: 'tab-opencode-2', paneId: 'pane-opencode-2', requestId: 'req-opencode-2', mode: 'opencode' as const, title: 'OpenCode 2' },
      { tabId: 'tab-opencode-3', paneId: 'pane-opencode-3', requestId: 'req-opencode-3', mode: 'opencode' as const, title: 'OpenCode 3' },
    ]

    for (const tab of opencodeTabs) {
      await addTerminalTab(input.page, { ...tab, cwd: sharedCwd })
      await waitForOpenCodeSessions(input.page, [tab.tabId])
    }

    const shellTab = { tabId: 'tab-shell-mixed', paneId: 'pane-shell-mixed', requestId: 'req-shell-mixed', mode: 'shell' as const, title: 'Shell Mixed' }
    if (input.includeShellPane) {
      await addTerminalTab(input.page, { ...shellTab, cwd: sharedCwd })
      await waitForRunningTerminals(input.page, [shellTab.tabId])
    }

    const initialOpenCode = await waitForOpenCodeSessions(input.page, opencodeTabs.map((tab) => tab.tabId))
    await sendInputToTerminals(input.page, initialOpenCode)

    const closedTabId = input.closeOneOpenCodePane ? opencodeTabs[2].tabId : undefined
    const closedSessionId = closedTabId
      ? initialOpenCode.find((snapshot) => snapshot.tabId === closedTabId)?.sessionRef?.sessionId
      : undefined
    if (closedTabId) {
      await closeTab(input.page, closedTabId)
    }

    const survivingOpenCodeTabIds = opencodeTabs
      .map((tab) => tab.tabId)
      .filter((tabId) => tabId !== closedTabId)
    const survivingTabIds = [
      ...survivingOpenCodeTabIds,
      ...(input.includeShellPane ? [shellTab.tabId] : []),
    ]
    const beforeRestart = await getPaneSnapshots(input.page, survivingTabIds)
    const beforeByTab = new Map(beforeRestart.map((snapshot) => [snapshot.tabId, snapshot]))
    const expectedSessionIds = survivingOpenCodeTabIds.map((tabId) => beforeByTab.get(tabId)?.sessionRef?.sessionId)
    expect(expectedSessionIds.every(Boolean)).toBe(true)

    await harness.clearSentWsMessages()

    if (input.restartMode === 'graceful') {
      await server1.stop()
    } else {
      await server1.kill('SIGKILL')
    }

    server2 = new TestServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      port: info1.port,
      token: info1.token,
    }))
    await server2.start()

    await harness.waitForConnection(30_000)
    const previousTerminalIdsByTab = Object.fromEntries(
      beforeRestart.map((snapshot) => [snapshot.tabId, snapshot.terminalId]),
    )
    const afterRestart = await waitForRunningTerminals(input.page, survivingTabIds, previousTerminalIdsByTab)
    const afterByTab = new Map(afterRestart.map((snapshot) => [snapshot.tabId, snapshot]))

    for (const tabId of survivingOpenCodeTabIds) {
      const before = beforeByTab.get(tabId)
      const after = afterByTab.get(tabId)
      expect(after?.sessionRef).toEqual(before?.sessionRef)
      if (!after?.terminalId) {
        const auditEvents = await readAuditEvents(auditLogPath)
        const logs = await readLogs(logsDir)
        const terminalMessages = (await harness.getSentWsMessages()).filter((message: any) =>
          typeof message?.type === 'string' && message.type.startsWith('terminal.')
        )
        throw new Error(`OpenCode pane lost terminalId after restart: ${JSON.stringify({
          tabId,
          before,
          after,
          afterRestart,
          terminalMessages,
          auditEvents,
          logs,
        }, null, 2)}`)
      }
      expect(after?.terminalId).not.toBe(before?.terminalId)
      expect(after?.sessionRef?.sessionId).toMatch(/^ses_root_/)
    }

    if (input.includeShellPane) {
      const before = beforeByTab.get(shellTab.tabId)
      const after = afterByTab.get(shellTab.tabId)
      expect(after?.terminalId).toBeTruthy()
      expect(after?.terminalId).not.toBe(before?.terminalId)
      expect(after?.sessionRef).toBeUndefined()
    }

    if (closedTabId) {
      const state = await harness.getState()
      expect(state.tabs.tabs.some((tab: any) => tab.id === closedTabId)).toBe(false)
    }

    const postRestartOpenCode = afterRestart.filter((snapshot) => snapshot.mode === 'opencode')
    await sendInputToTerminals(input.page, postRestartOpenCode, 'after-restart')

    const sentMessages = await harness.getSentWsMessages()
    const restoreCreates = sentMessages.filter((message: any) =>
      message?.type === 'terminal.create'
      && message.mode === 'opencode'
      && message.restore === true
    ) as any[]
    expect(new Set(restoreCreates.map((message) => message.sessionRef?.sessionId))).toEqual(new Set(expectedSessionIds))
    expect(restoreCreates.every((message) => message.recoveryIntent === undefined)).toBe(true)

    if (input.includeShellPane) {
      expect(sentMessages.some((message: any) =>
        message?.type === 'terminal.create'
        && message.mode === 'shell'
        && message.recoveryIntent === 'fresh_after_restore_unavailable'
      )).toBe(true)
    }

    const { auditEvents, restoreLaunches } = await waitForRestoreLaunches(auditLogPath, expectedSessionIds)
    expect(restoreLaunches.every((event) => event.sessionArg === event.rootSessionId)).toBe(true)
    if (closedSessionId) {
      expect(restoreLaunches.some((event) => event.sessionArg === closedSessionId)).toBe(false)
    }
    await waitForStdinAudit(
      auditLogPath,
      postRestartOpenCode.map((snapshot) => ({
        tabId: snapshot.tabId,
        sessionId: snapshot.sessionRef!.sessionId,
      })),
      'after-restart',
    )

    const logs = await readLogs(logsDir)
    expect(logs).not.toContain('OpenCode endpoint reported ambiguous session ownership')
    expect(logs).not.toContain('OpenCode reported multiple active root sessions')
  } finally {
    await server2?.stop().catch(() => {})
    await server1.stop().catch(() => {})
    await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
  }
}

test.describe('OpenCode restart recovery', () => {
  test.setTimeout(240_000)

  test('reattaches a UI-created OpenCode pane across browser refresh', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-ui-refresh-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    await installFakeOpencode(binDir)

    const server = new TestServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
    }))

    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)

      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()

      for (let index = 1; index <= 13; index += 1) {
        const shellTab = {
          tabId: `tab-ui-refresh-shell-${index}`,
          paneId: `pane-ui-refresh-shell-${index}`,
          requestId: `req-ui-refresh-shell-${index}`,
          mode: 'shell' as const,
          title: `UI Refresh Shell ${index}`,
        }
        await addTerminalTab(page, shellTab)
        await waitForRunningTerminals(page, [shellTab.tabId])
      }

      const tabId = await addOpenCodeTabThroughUi(page, info.homeDir)
      const [beforeRefresh] = await waitForOpenCodeSessions(page, [tabId])
      expect(beforeRefresh.sessionRef?.provider).toBe('opencode')
      expect(beforeRefresh.sessionRef?.sessionId).toBeTruthy()
      expect(beforeRefresh.terminalId).toBeTruthy()
      await sendInputToTerminals(page, [beforeRefresh], 'ui-before-refresh')
      await waitForStdinAudit(auditLogPath, [{
        tabId,
        sessionId: beforeRefresh.sessionRef!.sessionId,
      }], 'ui-before-refresh')

      await harness.clearSentWsMessages()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()

      await page.waitForFunction(({ expectedTabId, expectedTerminalId, expectedSessionId }) => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState()
        const tabExists = state?.tabs?.tabs?.some((candidate: any) => candidate.id === expectedTabId)
        const findTerminal = (node: any): any => {
          if (!node) return undefined
          if (node.type === 'leaf' && node.content?.kind === 'terminal') return node.content
          if (node.type === 'split') return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
          return undefined
        }
        const content = findTerminal(state?.panes?.layouts?.[expectedTabId])
        return tabExists
          && content?.mode === 'opencode'
          && content.status === 'running'
          && content.terminalId === expectedTerminalId
          && content.sessionRef?.provider === 'opencode'
          && content.sessionRef.sessionId === expectedSessionId
      }, {
        expectedTabId: tabId,
        expectedTerminalId: beforeRefresh.terminalId,
        expectedSessionId: beforeRefresh.sessionRef!.sessionId,
      }, { timeout: 30_000 })

      const [afterRefresh] = await getPaneSnapshots(page, [tabId])
      await sendInputToTerminals(page, [afterRefresh], 'ui-after-refresh')
      await waitForStdinAudit(auditLogPath, [{
        tabId,
        sessionId: beforeRefresh.sessionRef!.sessionId,
      }], 'ui-after-refresh')
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('recovers a hidden OpenCode sessionRef when association lands while the browser is closed', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-hidden-refresh-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const sessionEventGatePath = path.join(sharedRoot, 'release-opencode-session-events')
    await installFakeOpencode(binDir)

    const server = new TestServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      fakeOpencodeSessionEventGatePath: sessionEventGatePath,
      terminalScrollback: 200,
      env: {
        CODING_CLI_MIN_REPLAY_RING_MAX_BYTES: String(64 * 1024),
      },
    }))

    let restorePage: typeof page | undefined
    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)

      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()

      const opencodeTab = {
        tabId: 'tab-hidden-opencode-refresh',
        paneId: 'pane-hidden-opencode-refresh',
        requestId: 'req-hidden-opencode-refresh',
        mode: 'opencode' as const,
        title: 'Hidden OpenCode Refresh',
      }
      await addTerminalTab(page, opencodeTab)
      const [beforeAssociation] = await waitForRunningTerminals(page, [opencodeTab.tabId])
      expect(beforeAssociation.mode).toBe('opencode')
      expect(beforeAssociation.terminalId).toBeTruthy()
      expect(beforeAssociation.sessionRef).toBeUndefined()
      const launch = await waitForInitialOpenCodeLaunch(auditLogPath)
      const expectedSessionId = launch.rootSessionId!

      await sendInputToTerminals(page, [beforeAssociation], `hidden-overflow-${'x'.repeat(96 * 1024)}`)
      await sendInputToTerminals(page, [beforeAssociation], 'hidden-before-refresh')
      await waitForStdinAudit(auditLogPath, [{
        tabId: opencodeTab.tabId,
        sessionId: expectedSessionId,
      }], 'hidden-before-refresh')

      const shellTab = {
        tabId: 'tab-hidden-refresh-shell',
        paneId: 'pane-hidden-refresh-shell',
        requestId: 'req-hidden-refresh-shell',
        mode: 'shell' as const,
        title: 'Hidden Refresh Shell',
      }
      await addTerminalTab(page, shellTab)
      await waitForRunningTerminals(page, [shellTab.tabId])

      const persistedRaw = await page.evaluate(({ layoutKey }) => {
        const harness = window.__FRESHELL_TEST_HARNESS__
        if (!harness) throw new Error('Freshell test harness is not installed')
        harness.dispatch({ type: 'persist/flushNow' })
        const raw = window.localStorage.getItem(layoutKey)
        if (!raw) throw new Error(`Missing persisted layout ${layoutKey}`)
        return raw
      }, { layoutKey: 'freshell.layout.v3' })
      const persistedBeforeClose = JSON.parse(persistedRaw)
      expect(persistedBeforeClose.tabs?.activeTabId).toBe(shellTab.tabId)
      expect(persistedBeforeClose.tabs?.tabs?.find((tab: any) => tab.id === opencodeTab.tabId)?.sessionRef).toBeUndefined()
      expect(persistedBeforeClose.panes?.layouts?.[opencodeTab.tabId]?.content?.sessionRef).toBeUndefined()

      const context = page.context()
      await page.close()
      for (let index = 0; index < 3; index += 1) {
        const hiddenOverflowAfterCloseLabel = `hidden-overflow-after-close-${index}-${'x'.repeat(40 * 1024)}`
        await sendTerminalInputOverWs({
          wsUrl: info.wsUrl,
          token: info.token,
          terminalId: beforeAssociation.terminalId!,
          data: `${hiddenOverflowAfterCloseLabel} ${opencodeTab.tabId}\n`,
        })
      }
      const hiddenAfterCloseMarker = 'hidden-after-close-marker'
      await sendTerminalInputOverWs({
        wsUrl: info.wsUrl,
        token: info.token,
        terminalId: beforeAssociation.terminalId!,
        data: `${hiddenAfterCloseMarker} ${opencodeTab.tabId}\n`,
      })
      await waitForStdinAudit(auditLogPath, [{
        tabId: opencodeTab.tabId,
        sessionId: expectedSessionId,
      }], hiddenAfterCloseMarker)
      await fsp.writeFile(sessionEventGatePath, 'release\n', 'utf8')
      await waitForSessionEventsEmitted(auditLogPath, expectedSessionId)
      await expect.poll(async () => {
        const response = await fetch(`${info.baseUrl}/api/terminals`, {
          headers: { 'x-auth-token': info.token },
        })
        if (!response.ok) return undefined
        const terminals = await response.json() as any[]
        return terminals.find((terminal) =>
          terminal.terminalId === beforeAssociation.terminalId
        )?.sessionRef
      }, { timeout: 15_000 }).toEqual({
        provider: 'opencode',
        sessionId: expectedSessionId,
      })

      restorePage = await context.newPage()
      await restorePage.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)

      const restoreHarness = new TestHarness(restorePage)
      await restoreHarness.waitForHarness()
      await restoreHarness.waitForConnection()

      await restorePage.waitForFunction(({ tabId, shellTabId, expectedSessionId }) => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState()
        const findTerminal = (node: any): any => {
          if (!node) return undefined
          if (node.type === 'leaf' && node.content?.kind === 'terminal') return node.content
          if (node.type === 'split') return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
          return undefined
        }
        const tab = state?.tabs?.tabs?.find((candidate: any) => candidate.id === tabId)
        const content = findTerminal(state?.panes?.layouts?.[tabId])
        return state?.tabs?.activeTabId === shellTabId
          && tab?.sessionRef?.provider === 'opencode'
          && tab.sessionRef.sessionId === expectedSessionId
          && content?.mode === 'opencode'
          && content.sessionRef?.provider === 'opencode'
          && content.sessionRef.sessionId === expectedSessionId
      }, {
        tabId: opencodeTab.tabId,
        shellTabId: shellTab.tabId,
        expectedSessionId,
      }, { timeout: 30_000 })

      await expect.poll(async () => {
        const messages = await restoreHarness.getSentWsMessages()
        return messages.some((message: any) =>
          message?.type === 'tabs.sync.push'
          && Array.isArray(message.records)
          && message.records.some((record: any) =>
            record.tabId === opencodeTab.tabId
            && record.status === 'open'
            && record.panes?.some((pane: any) =>
              pane.payload?.sessionRef?.provider === 'opencode'
              && pane.payload.sessionRef.sessionId === expectedSessionId
            )
          )
        )
      }, { timeout: TAB_REGISTRY_SYNC_INTERVAL_MS + 10_000 }).toBe(true)

      await restorePage.locator(`[data-context="tab"][data-tab-id="${opencodeTab.tabId}"]`).click()
      const [afterRefresh] = await waitForRunningTerminals(restorePage, [opencodeTab.tabId], {
        [opencodeTab.tabId]: beforeAssociation.terminalId,
      })
      expect(afterRefresh.sessionRef).toEqual({
        provider: 'opencode',
        sessionId: expectedSessionId,
      })
      expect(afterRefresh.terminalId).toBeTruthy()
      expect(afterRefresh.terminalId).not.toBe(beforeAssociation.terminalId)
      await waitForRestoreLaunches(auditLogPath, [expectedSessionId])
      await expect.poll(async () => {
        const buffer = await restoreHarness.getTerminalBuffer(afterRefresh.terminalId!)
        return buffer ?? ''
      }, {
        timeout: 30_000,
        message: 'expected restored hidden OpenCode pane to render terminal content after replay-window repair',
      }).toContain(`fake opencode ready root=${expectedSessionId}`)
      await sendInputToTerminals(restorePage, [afterRefresh], 'hidden-after-refresh')
      await waitForStdinAudit(auditLogPath, [{
        tabId: opencodeTab.tabId,
        sessionId: expectedSessionId,
      }], 'hidden-after-refresh')
    } finally {
      await restorePage?.close().catch(() => {})
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('preserves an associated OpenCode pane across browser refresh', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-refresh-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    await installFakeOpencode(binDir)

    const server = new TestServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
    }))

    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)

      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()

      for (let index = 1; index <= 13; index += 1) {
        const shellTab = {
          tabId: `tab-refresh-shell-${index}`,
          paneId: `pane-refresh-shell-${index}`,
          requestId: `req-refresh-shell-${index}`,
          mode: 'shell' as const,
          title: `Refresh Shell ${index}`,
        }
        await addTerminalTab(page, shellTab)
        await waitForRunningTerminals(page, [shellTab.tabId])
      }

      const tab = {
        tabId: 'tab-opencode-refresh',
        paneId: 'pane-opencode-refresh',
        requestId: 'req-opencode-refresh',
        mode: 'opencode' as const,
        title: 'OpenCode Refresh',
      }
      await addTerminalTab(page, tab)

      const [beforeRefresh] = await waitForOpenCodeSessions(page, [tab.tabId])
      expect(beforeRefresh.sessionRef?.provider).toBe('opencode')
      expect(beforeRefresh.sessionRef?.sessionId).toBeTruthy()
      await sendInputToTerminals(page, [beforeRefresh], 'before-refresh')
      await waitForStdinAudit(auditLogPath, [{
        tabId: tab.tabId,
        sessionId: beforeRefresh.sessionRef!.sessionId,
      }], 'before-refresh')

      await harness.clearSentWsMessages()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()

      await page.waitForFunction(({ tabId, expectedSessionId }) => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState()
        const tabExists = state?.tabs?.tabs?.some((candidate: any) => candidate.id === tabId)
        const findTerminal = (node: any): any => {
          if (!node) return undefined
          if (node.type === 'leaf' && node.content?.kind === 'terminal') return node.content
          if (node.type === 'split') return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
          return undefined
        }
        const content = findTerminal(state?.panes?.layouts?.[tabId])
        return tabExists
          && content?.mode === 'opencode'
          && content.sessionRef?.provider === 'opencode'
          && content.sessionRef.sessionId === expectedSessionId
          && typeof content.terminalId === 'string'
      }, {
        tabId: tab.tabId,
        expectedSessionId: beforeRefresh.sessionRef!.sessionId,
      }, { timeout: 30_000 })

      const deadline = Date.now() + TAB_REGISTRY_SYNC_INTERVAL_MS + 10_000
      let observedPushCount = 0
      while (Date.now() < deadline) {
        const snapshot = await page.evaluate(({ tabId, expectedSessionId }) => {
          const harness = window.__FRESHELL_TEST_HARNESS__
          const state = harness?.getState()
          const findTerminal = (node: any): any => {
            if (!node) return undefined
            if (node.type === 'leaf' && node.content?.kind === 'terminal') return node.content
            if (node.type === 'split') return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
            return undefined
          }
          const content = findTerminal(state?.panes?.layouts?.[tabId])
          const pushes = (harness?.getSentWsMessages?.() ?? [])
            .filter((message: any) => message?.type === 'tabs.sync.push')
          const badPush = pushes.find((message: any) =>
            !Array.isArray(message.records)
            || !message.records.some((record: any) =>
              record.tabId === tabId
              && record.status === 'open'
              && record.panes?.some((pane: any) =>
                pane.payload?.sessionRef?.provider === 'opencode'
                && pane.payload.sessionRef.sessionId === expectedSessionId
              )
            )
          )
          return {
            tabIds: state?.tabs?.tabs?.map((candidate: any) => candidate.id) ?? [],
            hasLayout: !!state?.panes?.layouts?.[tabId],
            mode: content?.mode,
            terminalId: content?.terminalId,
            sessionRef: content?.sessionRef,
            pushCount: pushes.length,
            badPush,
          }
        }, {
          tabId: tab.tabId,
          expectedSessionId: beforeRefresh.sessionRef!.sessionId,
        })

        observedPushCount = snapshot.pushCount
        if (
          !snapshot.tabIds.includes(tab.tabId)
          || !snapshot.hasLayout
          || snapshot.mode !== 'opencode'
          || snapshot.sessionRef?.provider !== 'opencode'
          || snapshot.sessionRef.sessionId !== beforeRefresh.sessionRef!.sessionId
          || typeof snapshot.terminalId !== 'string'
          || snapshot.badPush
        ) {
          throw new Error(`OpenCode refresh tab/session was not stable: ${JSON.stringify(snapshot, null, 2)}`)
        }

        await page.waitForTimeout(250)
      }

      expect(observedPushCount).toBeGreaterThan(0)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('restores surviving OpenCode panes after graceful server restart and leaves a closed pane closed', async ({ page }) => {
    await runRestartScenario({
      page,
      restartMode: 'graceful',
      closeOneOpenCodePane: true,
      includeShellPane: true,
    })
  })

  test('restores multiple OpenCode panes after hard server kill', async ({ page }) => {
    await runRestartScenario({
      page,
      restartMode: 'kill',
      closeOneOpenCodePane: false,
      includeShellPane: false,
    })
  })
})
