import { expect, test, type Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TestServer } from '../helpers/test-server.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fakeOpencodeSource = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

type FakeAuditEvent = {
  event?: string
  pid?: number
  hostname?: string
  port?: number
  sessionId?: string
  routeDirectory?: string
  expectedDirectory?: string
  bodyDirectory?: string
  directory?: string
  prompt?: string
  status?: string
  reason?: string
  count?: number
  messageId?: string
}

type FreshOpencodePaneState = {
  sessionId?: string
  resumeSessionId?: string
  status?: string
  initialCwd?: string
  sessionRef?: { provider?: string; sessionId?: string }
}

async function installFakeOpencode(binDir: string): Promise<void> {
  await fsp.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  await fsp.copyFile(fakeOpencodeSource, target)
  await fsp.chmod(target, 0o755)
}

function createSetupHome(sharedOpencodeDataDir: string) {
  return async (homeDir: string): Promise<void> => {
    const xdgShare = path.join(homeDir, '.local', 'share')
    const opencodeLink = path.join(xdgShare, 'opencode')
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(xdgShare, { recursive: true })
    await fsp.mkdir(freshellDir, { recursive: true })
    await fsp.mkdir(sharedOpencodeDataDir, { recursive: true })
    await fsp.rm(opencodeLink, { recursive: true, force: true }).catch(() => {})
    await fsp.symlink(sharedOpencodeDataDir, opencodeLink, 'dir')
    await fsp.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
      version: 1,
      settings: {
        codingCli: {
          enabledProviders: ['opencode'],
          providers: { opencode: {} },
        },
        freshAgent: { enabled: true },
      },
    }, null, 2))
  }
}

function createServerOptions(input: {
  binDir: string
  auditLogPath: string
  logsDir: string
  sharedOpencodeDataDir: string
  port?: number
  token?: string
}) {
  return {
    ...(input.port ? { port: input.port } : {}),
    ...(input.token ? { token: input.token } : {}),
    setupHome: createSetupHome(input.sharedOpencodeDataDir),
    env: {
      PATH: `${input.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_OPENCODE_AUDIT_LOG: input.auditLogPath,
      FAKE_OPENCODE_REQUIRE_DIRECTORY_ROUTE: '1',
      FRESHELL_LOG_DIR: input.logsDir,
    },
  }
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

async function enableFreshOpencode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { opencode: true },
    })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: {
        codingCli: { enabledProviders: ['opencode'] },
        freshAgent: { enabled: true },
      },
    })
  })
}

async function createFreshopencodePane(page: Page, cwd: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })
  const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })
}

async function getFreshOpencodePaneState(page: Page): Promise<FreshOpencodePaneState> {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const activeTabId = state?.tabs?.activeTabId
    const findFreshOpencode = (node: any): any => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'fresh-agent' && node.content.provider === 'opencode') {
        return node.content
      }
      if (node.type === 'split') return findFreshOpencode(node.children?.[0]) ?? findFreshOpencode(node.children?.[1])
      return undefined
    }
    return findFreshOpencode(state?.panes?.layouts?.[activeTabId]) ?? {}
  })
}

async function sendFreshAgentPrompt(page: Page, prompt: string): Promise<void> {
  const textbox = page.getByRole('textbox', { name: 'Chat message input' })
  await expect(textbox).toBeVisible({ timeout: 15_000 })
  await expect(textbox).not.toBeDisabled({ timeout: 15_000 })
  await textbox.fill(prompt)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function waitForMaterializedSession(page: Page): Promise<FreshOpencodePaneState> {
  await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
    sessionId: expect.stringMatching(/^ses_/),
    resumeSessionId: expect.stringMatching(/^ses_/),
    initialCwd: expect.any(String),
    sessionRef: {
      provider: 'opencode',
      sessionId: expect.stringMatching(/^ses_/),
    },
  })
  const state = await getFreshOpencodePaneState(page)
  expect(state.sessionId).toBe(state.sessionRef?.sessionId)
  return state
}

async function waitForSettledPane(page: Page, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const state = await getFreshOpencodePaneState(page)
    return {
      sessionId: state.sessionId,
      status: state.status,
    }
  }, { timeout: 30_000 }).toEqual({
    sessionId,
    status: 'idle',
  })
}

async function waitForPromptRoute(input: {
  auditLogPath: string
  sessionId: string
  routeDirectory: string
  prompt: string
  afterEventCount?: number
}): Promise<FakeAuditEvent> {
  let events: FakeAuditEvent[] = []
  await expect.poll(async () => {
    events = await readAuditEvents(input.auditLogPath)
    const search = events.slice(input.afterEventCount ?? 0)
    return search.some((event) =>
      event.event === 'prompt_async'
      && event.sessionId === input.sessionId
      && event.routeDirectory === input.routeDirectory
      && event.prompt === input.prompt
    )
  }, { timeout: 30_000 }).toBe(true)
  const event = events.slice(input.afterEventCount ?? 0).find((candidate) =>
    candidate.event === 'prompt_async'
    && candidate.sessionId === input.sessionId
    && candidate.routeDirectory === input.routeDirectory
    && candidate.prompt === input.prompt
  )
  if (!event) throw new Error(`Missing prompt audit for ${input.prompt}`)
  return event
}

async function expectAuditedRouteUse(input: {
  auditLogPath: string
  sessionId: string
  routeDirectory: string
  afterEventCount?: number
}): Promise<void> {
  await expect.poll(async () => {
    const events = await readAuditEvents(input.auditLogPath)
    const search = events.slice(input.afterEventCount ?? 0)
    const matching = (eventName: string) => search.some((event) =>
      event.event === eventName
      && event.sessionId === input.sessionId
      && event.routeDirectory === input.routeDirectory
    )
    return {
      sessionGet: matching('session_get'),
      promptAsync: matching('prompt_async'),
      messageList: matching('message_list'),
      status: search.some((event) =>
        event.event === 'status'
        && event.routeDirectory === input.routeDirectory
      ),
      busy: search.some((event) =>
        event.event === 'session_status_emitted'
        && event.sessionId === input.sessionId
        && event.status === 'busy'
        && event.routeDirectory === input.routeDirectory
      ),
      idle: search.some((event) =>
        event.event === 'session_idle_emitted'
        && event.sessionId === input.sessionId
        && event.routeDirectory === input.routeDirectory
      ),
      rejected: search.some((event) => event.event === 'route_rejected'),
    }
  }, { timeout: 30_000 }).toEqual({
    sessionGet: true,
    promptAsync: true,
    messageList: true,
    status: true,
    busy: true,
    idle: true,
    rejected: false,
  })
}

async function expectNoSessionCreateAfter(input: {
  auditLogPath: string
  afterEventCount: number
}): Promise<void> {
  const events = (await readAuditEvents(input.auditLogPath)).slice(input.afterEventCount)
  expect(events.filter((event) =>
    event.event === 'session_create_requested'
    || event.event === 'session_created'
  )).toEqual([])
}

async function latestServeLaunchForPid(auditLogPath: string, pid: number): Promise<FakeAuditEvent> {
  const events = await readAuditEvents(auditLogPath)
  const launch = events.findLast((event) =>
    event.event === 'launch'
    && event.pid === pid
    && typeof event.hostname === 'string'
    && typeof event.port === 'number'
  )
  if (!launch) throw new Error(`Missing fake OpenCode launch for pid ${pid}: ${JSON.stringify(events, null, 2)}`)
  return launch
}

async function assertBadRouteMutationIsRejected(input: {
  auditLogPath: string
  baseUrl: string
  sessionId: string
  goodCwd: string
  badCwd: string
}): Promise<void> {
  const badPrompt = `bad route mutation ${Date.now()}`
  const badResponse = await fetch(
    `${input.baseUrl}/session/${encodeURIComponent(input.sessionId)}/prompt_async?directory=${encodeURIComponent(input.badCwd)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: badPrompt }] }),
    },
  )
  expect(badResponse.status).toBe(409)

  await expect.poll(async () => {
    const events = await readAuditEvents(input.auditLogPath)
    return events.some((event) =>
      event.event === 'route_rejected'
      && event.sessionId === input.sessionId
      && event.routeDirectory === input.badCwd
      && event.expectedDirectory === input.goodCwd
      && event.reason === 'mismatched_directory_route'
    )
  }, { timeout: 5_000 }).toBe(true)

  const messagesResponse = await fetch(
    `${input.baseUrl}/session/${encodeURIComponent(input.sessionId)}/message?directory=${encodeURIComponent(input.goodCwd)}`,
  )
  expect(messagesResponse.ok).toBe(true)
  const messages = await messagesResponse.json() as Array<{ info?: { id?: string }; parts?: Array<{ text?: string }> }>
  expect(JSON.stringify(messages)).not.toContain(badPrompt)

  const firstMessageId = messages.find((message) => typeof message.info?.id === 'string')?.info?.id
  expect(firstMessageId).toBeTruthy()
  const messageResponse = await fetch(
    `${input.baseUrl}/session/${encodeURIComponent(input.sessionId)}/message/${encodeURIComponent(firstMessageId!)}?directory=${encodeURIComponent(input.goodCwd)}`,
  )
  expect(messageResponse.ok).toBe(true)
  await expect.poll(async () => {
    const events = await readAuditEvents(input.auditLogPath)
    return events.some((event) =>
      event.event === 'message_get'
      && event.sessionId === input.sessionId
      && event.messageId === firstMessageId
      && event.routeDirectory === input.goodCwd
    )
  }, { timeout: 5_000 }).toBe(true)
}

async function assertConflictingCreateDirectoryIsRejected(input: {
  auditLogPath: string
  baseUrl: string
  goodCwd: string
  badCwd: string
}): Promise<void> {
  const response = await fetch(
    `${input.baseUrl}/session?directory=${encodeURIComponent(input.goodCwd)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: input.badCwd, title: 'bad create route' }),
    },
  )
  expect(response.status).toBe(409)

  await expect.poll(async () => {
    const events = await readAuditEvents(input.auditLogPath)
    return events.some((event) =>
      event.event === 'route_rejected'
      && event.routeDirectory === input.goodCwd
      && event.expectedDirectory === input.goodCwd
      && event.bodyDirectory === input.badCwd
      && event.reason === 'mismatched_body_directory'
    )
  }, { timeout: 5_000 }).toBe(true)
}

test.describe('Freshopencode restart recovery', () => {
  test.setTimeout(180_000)

  test('resumes a route-bound serve session after TestServer restart', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-restart-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const badCwd = path.join(sharedRoot, 'other-project')
    const firstPrompt = `freshopencode restart first ${Date.now()}`
    const followUpPrompt = `freshopencode restart follow-up ${Date.now()}`
    await fsp.mkdir(cwd, { recursive: true })
    await fsp.mkdir(badCwd, { recursive: true })
    await installFakeOpencode(binDir)

    const server1 = new TestServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
    }))
    let server2: TestServer | undefined

    try {
      const info1 = await server1.start()
      await page.goto(`${info1.baseUrl}/?token=${info1.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)
      await createFreshopencodePane(page, cwd)

      await sendFreshAgentPrompt(page, firstPrompt)
      await expect(page.getByText(`Fake OpenCode response: ${firstPrompt}`)).toBeVisible({ timeout: 30_000 })
      const beforeRestart = await waitForMaterializedSession(page)
      expect(beforeRestart.initialCwd).toBe(cwd)
      const sessionId = beforeRestart.sessionId!
      await waitForSettledPane(page, sessionId)
      await waitForPromptRoute({
        auditLogPath,
        sessionId,
        routeDirectory: cwd,
        prompt: firstPrompt,
      })
      await expectAuditedRouteUse({ auditLogPath, sessionId, routeDirectory: cwd })

      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      const eventCountBeforeRestart = (await readAuditEvents(auditLogPath)).length

      await server1.stop()
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

      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId,
        resumeSessionId: sessionId,
        initialCwd: cwd,
        sessionRef: {
          provider: 'opencode',
          sessionId,
        },
      })

      await sendFreshAgentPrompt(page, followUpPrompt)
      await expect(page.getByText(`Fake OpenCode response: ${followUpPrompt}`)).toBeVisible({ timeout: 30_000 })
      const followUpAudit = await waitForPromptRoute({
        auditLogPath,
        sessionId,
        routeDirectory: cwd,
        prompt: followUpPrompt,
        afterEventCount: eventCountBeforeRestart,
      })
      await waitForSettledPane(page, sessionId)
      await expectAuditedRouteUse({
        auditLogPath,
        sessionId,
        routeDirectory: cwd,
        afterEventCount: eventCountBeforeRestart,
      })
      await expectNoSessionCreateAfter({
        auditLogPath,
        afterEventCount: eventCountBeforeRestart,
      })

      const launch = await latestServeLaunchForPid(auditLogPath, followUpAudit.pid!)
      const sidecarBaseUrl = `http://${launch.hostname}:${launch.port}`
      await assertBadRouteMutationIsRejected({
        auditLogPath,
        baseUrl: sidecarBaseUrl,
        sessionId,
        goodCwd: cwd,
        badCwd,
      })
      await assertConflictingCreateDirectoryIsRejected({
        auditLogPath,
        baseUrl: sidecarBaseUrl,
        goodCwd: cwd,
        badCwd,
      })
    } finally {
      await server2?.stop().catch(() => {})
      await server1.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
