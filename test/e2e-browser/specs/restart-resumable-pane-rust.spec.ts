import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import {
  applyIsolatedHomeEnvironment,
  findFreePort,
} from '../helpers/test-server.js'
import { TestHarness } from '../helpers/test-harness.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../..')
const LAUNCHER = path.join(PROJECT_ROOT, 'scripts', 'launch-rust.sh')
const FAKE_CLAUDE_CLI_SOURCE = path.resolve(
  __dirname,
  '../fixtures/fake-claude-cli.mjs',
)
const CLAUDE_PROJECT_SLUG = 'restart-resumable-pane-project'
const MISSING_SESSION_ID = '10000000-0000-4000-8000-000000000002'
const MISSING_SESSION_TITLE = 'restart smoke missing session'

type ArgvEntry = {
  pid: number
  t: number
  argv: string[]
}

type ScratchServer = {
  context: BrowserContext
  homeDir: string
  projectDir: string
  argvLogPath: string
  baseUrl: string
  token: string
  port: number
  launchEnvironment: NodeJS.ProcessEnv
}

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

async function findLeaf(
  harness: TestHarness,
  tabId: string,
  paneId: string,
): Promise<any | null> {
  return collectLeaves(await harness.getPaneLayout(tabId))
    .find((leaf) => leaf.id === paneId) ?? null
}

async function readArgvLog(argvLogPath: string): Promise<ArgvEntry[]> {
  const raw = await fsp.readFile(argvLogPath, 'utf8').catch(() => '')
  if (!raw.trim()) return []
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ArgvEntry)
}

function hasFlagPair(argv: string[], flag: string, value: string): boolean {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] === value
}

function claudeTranscriptPath(homeDir: string, sessionId: string): string {
  return path.join(
    homeDir,
    '.claude',
    'projects',
    CLAUDE_PROJECT_SLUG,
    `${sessionId}.jsonl`,
  )
}

async function writeClaudeTranscript(args: {
  homeDir: string
  projectDir: string
  sessionId: string
  title: string
  timestamp: string
}): Promise<void> {
  const sessionRoot = `${args.sessionId}-system`
  const lines = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: args.sessionId,
      uuid: sessionRoot,
      cwd: args.projectDir,
      timestamp: args.timestamp,
    }),
  ]
  let parentUuid = sessionRoot
  for (let turn = 1; turn <= 2; turn += 1) {
    const userUuid = `${args.sessionId}-user-${turn}`
    const assistantUuid = `${args.sessionId}-assistant-${turn}`
    lines.push(
      JSON.stringify({
        type: 'user',
        parentUuid,
        sessionId: args.sessionId,
        message: { role: 'user', content: `${args.title} request ${turn}` },
        uuid: userUuid,
        cwd: args.projectDir,
        timestamp: args.timestamp,
      }),
      JSON.stringify({
        type: 'assistant',
        parentUuid: userUuid,
        sessionId: args.sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${args.title} reply ${turn}` }],
        },
        uuid: assistantUuid,
        cwd: args.projectDir,
        timestamp: args.timestamp,
      }),
    )
    parentUuid = assistantUuid
  }
  await fsp.mkdir(path.dirname(claudeTranscriptPath(args.homeDir, args.sessionId)), {
    recursive: true,
  })
  await fsp.writeFile(
    claudeTranscriptPath(args.homeDir, args.sessionId),
    `${lines.join('\n')}\n`,
    'utf8',
  )
}

async function installFakeClaudeCli(binDir: string): Promise<string> {
  await fsp.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'claude')
  await fsp.copyFile(FAKE_CLAUDE_CLI_SOURCE, target)
  await fsp.chmod(target, 0o755)
  return target
}

function runLauncher(
  server: Pick<ScratchServer, 'port' | 'launchEnvironment'>,
  args: string[],
): void {
  const result = spawnSync(
    LAUNCHER,
    ['--port', String(server.port), ...args],
    {
      cwd: PROJECT_ROOT,
      env: server.launchEnvironment,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  )
  if (result.status === 0) return

  throw new Error([
    `launch-rust.sh ${args.join(' ')} failed with exit ${result.status ?? result.signal}`,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n'))
}

async function startScratchServer(browser: import('@playwright/test').Browser): Promise<ScratchServer> {
  const sharedRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'freshell-restart-resumable-pane-'),
  )
  const homeDir = path.join(sharedRoot, 'home')
  const projectDir = path.join(sharedRoot, 'project')
  const argvLogPath = path.join(sharedRoot, 'claude-argv.jsonl')
  await Promise.all([
    fsp.mkdir(homeDir, { recursive: true }),
    fsp.mkdir(projectDir, { recursive: true }),
  ])

  const fakeClaudePath = await installFakeClaudeCli(path.join(sharedRoot, 'bin'))
  await fsp.mkdir(path.join(homeDir, '.freshell'), { recursive: true })
  await fsp.writeFile(
    path.join(homeDir, '.freshell', 'config.json'),
    JSON.stringify({
      version: 1,
      settings: {
        network: { configured: true },
        codingCli: { enabledProviders: ['claude'] },
      },
    }, null, 2),
  )
  await writeClaudeTranscript({
    homeDir,
    projectDir,
    sessionId: MISSING_SESSION_ID,
    title: MISSING_SESSION_TITLE,
    timestamp: '2026-07-29T09:00:00.000Z',
  })

  const port = await findFreePort()
  expect(port).not.toBe(3002)
  const token = randomUUID()
  const launchEnvironment = applyIsolatedHomeEnvironment(
    {
      ...(process.env as Record<string, string>),
      AUTH_TOKEN: token,
      CLAUDE_CMD: fakeClaudePath,
      FAKE_CLAUDE_ARGV_LOG: argvLogPath,
      FRESHELL_BIND_HOST: '127.0.0.1',
      FRESHELL_CLIENT_DIR: path.join(PROJECT_ROOT, 'dist', 'client'),
      HIDE_STARTUP_TOKEN: 'true',
      NODE_ENV: 'production',
      // HOME is deliberately isolated below, but the canonical launcher
      // still needs the host's installed Rust toolchain to perform its
      // normal release build.
      CARGO_HOME: process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'),
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(os.homedir(), '.rustup'),
    },
    homeDir,
  )
  delete launchEnvironment.VITE_PORT

  const context = await browser.newContext()
  const server: ScratchServer = {
    context,
    homeDir,
    projectDir,
    argvLogPath,
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    port,
    launchEnvironment,
  }
  try {
    // This intentionally exercises the repo's canonical launcher rather than
    // bypassing it with the lower-level RustServer Playwright helper.
    runLauncher(server, [])
    return server
  } catch (error) {
    await context.close()
    await fsp.rm(sharedRoot, { recursive: true, force: true })
    throw error
  }
}

async function stopScratchServer(server: ScratchServer): Promise<void> {
  // Playwright closes the context itself when the enclosing test times out.
  // Cleanup must still reach the exact-PID launcher stop in that case.
  await server.context.close().catch(() => {})
  const pidFile = path.join(
    server.homeDir,
    `rust-server-${server.port}.pid`,
  )
  if (!fs.existsSync(pidFile)) {
    await fsp.rm(path.dirname(server.homeDir), { recursive: true, force: true })
    return
  }
  const pid = Number((await fsp.readFile(pidFile, 'utf8')).trim())
  expect(Number.isInteger(pid) && pid > 0).toBe(true)
  if (fs.existsSync(`/proc/${pid}`)) {
    expect(fs.readlinkSync(`/proc/${pid}/cwd`)).toBe(PROJECT_ROOT)
    expect(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))
      .toContain('target/release/freshell-server')

    try {
      runLauncher(server, ['--stop'])
    } catch (error) {
      // An interrupted Playwright worker can deliver SIGINT to its child
      // tree between the ownership check above and the launcher stop. The
      // launcher removes that now-stale PID file and returns 1; this is
      // already a complete cleanup, not a reason to mask the real failure.
      if (fs.existsSync(pidFile) || fs.existsSync(`/proc/${pid}`)) throw error
    }
    expect(fs.existsSync(pidFile)).toBe(false)
  } else {
    await fsp.unlink(pidFile)
  }
  await fsp.rm(path.dirname(server.homeDir), { recursive: true, force: true })
}

async function bootPage(page: Page, server: ScratchServer): Promise<TestHarness> {
  await page.goto(`${server.baseUrl}/?token=${server.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness(30_000)
  await harness.waitForConnection(30_000)
  return harness
}

async function selectShellIfPickerShowing(page: Page): Promise<void> {
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (!(await picker.isVisible().catch(() => false))) return
  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const option = picker.getByRole('button', {
      name: new RegExp(`^${name}$`, 'i'),
    })
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true })
      return
    }
  }
  throw new Error('No built-in shell option was visible in the pane picker')
}

async function openClaudePane(args: {
  page: Page
  harness: TestHarness
  tabId: string
  projectDir: string
  argvLogPath: string
}): Promise<{ leaf: any; sessionId: string }> {
  const existingPaneIds = new Set(
    collectLeaves(await args.harness.getPaneLayout(args.tabId))
      .map((leaf) => leaf.id),
  )
  const picker = await openPanePicker(args.page)
  await picker.getByRole('button', { name: /^Claude CLI$/i }).click()
  const cwdInput = args.page.getByRole('combobox', {
    name: /Starting directory for Claude/i,
  })
  await cwdInput.fill(args.projectDir)
  await cwdInput.press('Enter')

  const leaf = await expect.poll(async () => {
    return collectLeaves(await args.harness.getPaneLayout(args.tabId))
      .find((candidate) => (
        !existingPaneIds.has(candidate.id)
        && candidate.content?.mode === 'claude'
        && candidate.content?.terminalId
        && candidate.content?.runtimeId
        && Number.isInteger(candidate.content?.runtimeGeneration)
      )) ?? null
  }, { timeout: 30_000 }).not.toBeNull().then(async () => (
    collectLeaves(await args.harness.getPaneLayout(args.tabId))
      .find((candidate) => (
        !existingPaneIds.has(candidate.id)
        && candidate.content?.mode === 'claude'
      ))
  ))

  const sessionId = await expect.poll(async () => {
    const entry = (await readArgvLog(args.argvLogPath))
      .find((candidate) => candidate.argv.includes('--session-id'))
    const index = entry?.argv.indexOf('--session-id') ?? -1
    return index >= 0 ? entry!.argv[index + 1] : null
  }, { timeout: 20_000 }).not.toBeNull().then(async () => {
    const entry = (await readArgvLog(args.argvLogPath))
      .find((candidate) => candidate.argv.includes('--session-id'))!
    return entry.argv[entry.argv.indexOf('--session-id') + 1]!
  })

  return { leaf, sessionId }
}

async function flushPersistence(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
}

async function activateTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'tabs/setActiveTab',
      payload: id,
    })
  }, tabId)
  await page.waitForFunction((id) => (
    window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId === id
  ), tabId)
}

test.describe('restart resumable pane against canonical Rust launcher', () => {
  test.setTimeout(900_000)

  test('restarts one durable runtime for every viewer without duplicating sessions', async ({
    browser,
  }) => {
    const server = await startScratchServer(browser)
    try {
      const page1 = await server.context.newPage()
      page1.setDefaultTimeout(15_000)
      const harness1 = await bootPage(page1, server)
      await selectShellIfPickerShowing(page1)
      await expect(page1.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const originalTabId = (await harness1.getActiveTabId())!
      const shellLeaf = collectLeaves(await harness1.getPaneLayout(originalTabId))
        .find((leaf) => leaf.content?.mode === 'shell')
      expect(shellLeaf).toBeTruthy()
      const shellTerminalId = await expect.poll(async () => (
        (await findLeaf(harness1, originalTabId, shellLeaf.id))
          ?.content?.terminalId ?? null
      ), { timeout: 20_000 }).not.toBeNull().then(async () => (
        (await findLeaf(harness1, originalTabId, shellLeaf.id))
          .content.terminalId as string
      ))

      // Unsupported panes retain Refresh and never advertise Restart.
      await page1.locator(
        `[data-pane-shell="true"][data-pane-id="${shellLeaf.id}"]`,
      ).click({ button: 'right' })
      await expect(page1.getByRole('menuitem', { name: 'Refresh pane' })).toBeVisible()
      await expect(page1.getByRole('menuitem', { name: 'Restart pane' })).toHaveCount(0)
      await page1.keyboard.press('Escape')

      const { leaf: claudeLeaf, sessionId } = await openClaudePane({
        page: page1,
        harness: harness1,
        tabId: originalTabId,
        projectDir: server.projectDir,
        argvLogPath: server.argvLogPath,
      })
      await writeClaudeTranscript({
        homeDir: server.homeDir,
        projectDir: server.projectDir,
        sessionId,
        title: 'restart smoke live session',
        timestamp: '2026-07-29T09:01:00.000Z',
      })

      await expect.poll(async () => (
        (await findLeaf(harness1, originalTabId, claudeLeaf.id))
          ?.content?.sessionRef?.sessionId ?? null
      ), { timeout: 20_000 }).toBe(sessionId)

      const liveSidebarItem = page1.locator(
        `[data-context="sidebar-session"][data-provider="claude"][data-session-id="${sessionId}"]`,
      )
      await expect(liveSidebarItem).toBeVisible({ timeout: 30_000 })

      // An already-open durable session has no duplicate-producing menu items.
      await liveSidebarItem.click({ button: 'right' })
      await expect(page1.getByRole('menuitem', { name: 'Open in new tab' })).toHaveCount(0)
      await expect(page1.getByRole('menuitem', { name: 'Open in this tab' })).toHaveCount(0)
      await page1.keyboard.press('Escape')

      // Normal selection focuses the existing pane instead of creating a copy.
      const tabCountBeforeFocus = await harness1.getTabCount()
      const paneCountBeforeFocus = collectLeaves(
        await harness1.getPaneLayout(originalTabId),
      ).length
      await page1.locator(
        `[data-pane-shell="true"][data-pane-id="${shellLeaf.id}"]`,
      ).click()
      await liveSidebarItem.click()
      await expect.poll(async () => (
        (await harness1.getState()).panes.activePane[originalTabId]
      )).toBe(claudeLeaf.id)
      expect(await harness1.getTabCount()).toBe(tabCountBeforeFocus)
      expect(collectLeaves(await harness1.getPaneLayout(originalTabId))).toHaveLength(
        paneCountBeforeFocus,
      )

      // Project-level "Open all" opens only the one missing session.
      await page1.getByRole('button', { name: /^Projects\b/ }).click()
      const projectCard = page1.locator(
        `[data-context="history-project"][data-project-path="${server.projectDir}"]`,
      )
      await expect(projectCard).toBeVisible({ timeout: 30_000 })
      const tabCountBeforeOpenAll = await harness1.getTabCount()
      await projectCard.click({ button: 'right' })
      const openAll = page1.getByRole('menuitem', {
        name: 'Open all sessions in tabs',
      })
      await expect(openAll).toBeEnabled()
      await openAll.click()
      const openConfirmation = page1.getByRole('dialog', {
        name: 'Open unopened sessions?',
      })
      await expect(openConfirmation).toBeVisible()
      await openConfirmation.getByRole('button', { name: 'Open tabs' }).click()
      await expect.poll(() => harness1.getTabCount(), { timeout: 30_000 })
        .toBe(tabCountBeforeOpenAll + 1)
      const stateAfterOpenAll = await harness1.getState()
      const missingSessionPanes = Object.values(
        stateAfterOpenAll.panes.layouts,
      ).flatMap(collectLeaves).filter((leaf) => (
        leaf.content?.sessionRef?.provider === 'claude'
        && leaf.content?.sessionRef?.sessionId === MISSING_SESSION_ID
      ))
      expect(missingSessionPanes).toHaveLength(1)
      const liveSessionPanes = Object.values(
        stateAfterOpenAll.panes.layouts,
      ).flatMap(collectLeaves).filter((leaf) => (
        leaf.content?.sessionRef?.provider === 'claude'
        && leaf.content?.sessionRef?.sessionId === sessionId
      ))
      expect(liveSessionPanes).toHaveLength(1)

      await page1.getByRole('button', { name: /^Projects\b/ }).click()
      await projectCard.click({ button: 'right' })
      await expect(page1.getByRole('menuitem', {
        name: 'All sessions already open',
      })).toBeDisabled()
      await page1.keyboard.press('Escape')
      await page1.getByRole('button', { name: /^Coding Agents\b/ }).click()
      await liveSidebarItem.click()
      await expect.poll(() => harness1.getActiveTabId()).toBe(originalTabId)

      await flushPersistence(page1)
      const page2 = await server.context.newPage()
      page2.setDefaultTimeout(15_000)
      const harness2 = await bootPage(page2, server)
      await expect.poll(async () => (
        (await findLeaf(harness2, originalTabId, claudeLeaf.id))
          ?.content?.runtimeId ?? null
      ), { timeout: 30_000 }).toBe(claudeLeaf.content.runtimeId)
      await activateTab(page2, originalTabId)

      const before1 = (await findLeaf(
        harness1,
        originalTabId,
        claudeLeaf.id,
      )).content
      const before2 = (await findLeaf(
        harness2,
        originalTabId,
        claudeLeaf.id,
      )).content
      expect(before2.runtimeId).toBe(before1.runtimeId)
      expect(before2.runtimeGeneration).toBe(before1.runtimeGeneration)
      const resumeCountBefore = (await readArgvLog(server.argvLogPath))
        .filter((entry) => hasFlagPair(entry.argv, '--resume', sessionId))
        .length

      await page1.locator(
        `[data-pane-shell="true"][data-pane-id="${claudeLeaf.id}"]`,
      ).click({ button: 'right' })
      const restartPane = page1.getByRole('menuitem', { name: 'Restart pane' })
      await expect(restartPane).toBeVisible()
      await expect(page1.getByRole('menuitem', { name: 'Refresh pane' })).toHaveCount(0)
      await restartPane.click()

      const replacement = await expect.poll(async () => {
        const page1Leaf = await findLeaf(harness1, originalTabId, claudeLeaf.id)
        const page2Leaf = await findLeaf(harness2, originalTabId, claudeLeaf.id)
        if (
          page1Leaf?.content?.runtimeId === before1.runtimeId
          || page2Leaf?.content?.runtimeId !== page1Leaf?.content?.runtimeId
          || page2Leaf?.content?.runtimeGeneration
            !== page1Leaf?.content?.runtimeGeneration
        ) {
          return null
        }
        return {
          runtimeId: page1Leaf.content.runtimeId,
          generation: page1Leaf.content.runtimeGeneration,
        }
      }, { timeout: 45_000 }).not.toBeNull().then(async () => {
        const content = (await findLeaf(
          harness1,
          originalTabId,
          claudeLeaf.id,
        )).content
        return {
          runtimeId: content.runtimeId as string,
          generation: content.runtimeGeneration as number,
        }
      })

      expect(replacement.runtimeId).not.toBe(before1.runtimeId)
      expect(replacement.generation).toBe(before1.runtimeGeneration + 1)
      await expect.poll(async () => (
        (await readArgvLog(server.argvLogPath))
          .filter((entry) => hasFlagPair(entry.argv, '--resume', sessionId))
          .length
      ), { timeout: 30_000 }).toBe(resumeCountBefore + 1)

      // Both viewers are attached to the one replacement runtime.
      await expect.poll(async () => {
        const sent = await harness2.getSentWsMessages()
        return sent.filter((message: any) => (
          message?.type === 'terminal.attach'
          && message?.terminalId === replacement.runtimeId
        )).length
      }, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)

      // The unrelated shell leaf is byte-for-byte on the same live terminal.
      const shellAfter1 = await findLeaf(harness1, originalTabId, shellLeaf.id)
      const shellAfter2 = await findLeaf(harness2, originalTabId, shellLeaf.id)
      expect(shellAfter1.content.terminalId).toBe(shellTerminalId)
      expect(shellAfter2.content.terminalId).toBe(shellTerminalId)

      const terminalsResponse = await fetch(`${server.baseUrl}/api/terminals`, {
        headers: { 'x-auth-token': server.token },
      })
      expect(terminalsResponse.ok).toBe(true)
      const terminals = await terminalsResponse.json() as Array<{
        terminalId: string
        mode: string
        status: string
        sessionRef?: { provider: string; sessionId: string }
      }>
      expect(terminals.filter((terminal) => (
        terminal.mode === 'claude'
        && terminal.status === 'running'
        && terminal.sessionRef?.sessionId === sessionId
      ))).toEqual([
        expect.objectContaining({ terminalId: replacement.runtimeId }),
      ])
      expect(terminals.some((terminal) => (
        terminal.terminalId === shellTerminalId
        && terminal.status === 'running'
      ))).toBe(true)
    } finally {
      await stopScratchServer(server)
    }
  })
})
