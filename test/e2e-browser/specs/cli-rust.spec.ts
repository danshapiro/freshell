import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { ensureMcpServerBuilt, REPO_ROOT } from '../helpers/mcp-stdio-client.js'
import { RustServer } from '../helpers/rust-server.js'

type CliRun = { code: number | null; stdout: string; stderr: string }
type ActionResult<T> = { status: string; data: T }

const CLI_BIN = path.join(REPO_ROOT, 'dist', 'tools', 'freshell-cli', 'index.js')
const SESSION_MARKER = 'cli-rust-paged-session'

function buildClaudeSession(sessionId: string, title: string): string {
  const cwd = `/tmp/${SESSION_MARKER}`
  const messages = [
    { type: 'system', subtype: 'init', session_id: sessionId, uuid: `${sessionId}-system`, cwd, timestamp: '2026-08-27T10:00:00.000Z' },
    { sessionId, type: 'user', message: { role: 'user', content: `${title} request one` }, uuid: `${sessionId}-u1`, cwd, timestamp: '2026-08-27T10:00:01.000Z' },
    { sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${title} response one` }] }, uuid: `${sessionId}-a1`, cwd, timestamp: '2026-08-27T10:00:02.000Z' },
    { sessionId, type: 'user', message: { role: 'user', content: `${title} request two` }, uuid: `${sessionId}-u2`, cwd, timestamp: '2026-08-27T10:00:03.000Z' },
    { sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${title} response two` }] }, uuid: `${sessionId}-a2`, cwd, timestamp: '2026-08-27T10:00:04.000Z' },
  ]
  return `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`
}

async function seedPagedSessions(homeDir: string): Promise<string[]> {
  const sessionsDir = path.join(homeDir, '.claude', 'projects', 'cli-rust-paged')
  await fs.mkdir(sessionsDir, { recursive: true })
  const sessionIds = Array.from({ length: 51 }, (_, index) => `cli-rust-page-${String(index + 1).padStart(2, '0')}`)
  await Promise.all(sessionIds.map(async (sessionId, index) => {
    const title = `${SESSION_MARKER} ${String(index + 1).padStart(2, '0')}`
    await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), buildClaudeSession(sessionId, title), 'utf8')
  }))
  return sessionIds
}

async function runCli(baseUrl: string, token: string, args: string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [CLI_BIN, ...args], {
    env: { ...process.env, FRESHELL_URL: baseUrl, FRESHELL_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return await new Promise<CliRun>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`CLI timed out: ${args.join(' ')}`))
    }, 30_000)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
  })
}

async function runCliJson<T>(baseUrl: string, token: string, args: string[]): Promise<T> {
  const result = await runCli(baseUrl, token, args)
  if (result.code !== 0) {
    throw new Error(
      `CLI exited ${result.code} for ${args.join(' ')}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    )
  }
  return JSON.parse(result.stdout) as T
}

/**
 * Rust-only standalone CLI acceptance coverage. It intentionally drives the
 * compiled `dist/tools/freshell-cli/index.js` entrypoint against the owned
 */
test.describe('standalone CLI -- Rust server replacement', () => {
  test.setTimeout(120_000)

  test('drives current Rust tab, pane, browser, screenshot, session, and unsupported-action contracts', async ({ page }) => {
    let sessionIds: string[] = []
    const server = new RustServer({
      verbose: false,
      setupHome: async (homeDir) => {
        sessionIds = await seedPagedSessions(homeDir)
      },
    })
    const serverInfo = await server.start()
    expect(serverInfo.port).not.toBe(3001)
    expect(serverInfo.port).not.toBe(3002)

    ensureMcpServerBuilt(REPO_ROOT)
    await expect(fs.access(CLI_BIN)).resolves.toBeUndefined()

    const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-cli-rust-'))
    const screenshotDir = path.join(scratchDir, 'screenshots')

    try {
      await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
      await page.getByRole('button', { name: /^Shell$/i }).click({ timeout: 15_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })

      const health = await runCliJson<{ ok: boolean }>(serverInfo.baseUrl, serverInfo.token, ['health'])
      expect(health.ok).toBe(true)

      const initialTabs = await runCliJson<ActionResult<{ tabs: Array<{ id: string }> }>>(
        serverInfo.baseUrl, serverInfo.token, ['list-tabs', '--json'],
      )
      expect(initialTabs.status).toBe('ok')
      expect(Array.isArray(initialTabs.data.tabs)).toBe(true)

      const created = await runCliJson<ActionResult<{ tabId: string; paneId: string }>>(
        serverInfo.baseUrl,
        serverInfo.token,
        ['new-tab', '--mode', 'shell', '--cwd', scratchDir, '--name', 'CLI Rust shell'],
      )
      expect(created.status).toBe('ok')
      const { tabId, paneId } = created.data

      const renamedTab = await runCliJson<ActionResult<{ tabId: string }>>(
        serverInfo.baseUrl, serverInfo.token, ['rename-tab', '--target', tabId, 'CLI Rust renamed tab'],
      )
      expect(renamedTab.status).toBe('ok')
      const renamedPane = await runCliJson<ActionResult<{ paneId: string }>>(
        serverInfo.baseUrl, serverInfo.token, ['rename-pane', '--target', paneId, 'CLI Rust renamed pane'],
      )
      expect(renamedPane.status).toBe('ok')

      const split = await runCliJson<ActionResult<{ paneId: string }>>(
        serverInfo.baseUrl, serverInfo.token, ['split-pane', '--target', paneId, '--mode', 'shell', '--cwd', scratchDir],
      )
      expect(split.status).toBe('ok')
      const panes = await runCliJson<ActionResult<{ panes: Array<{ id: string }> }>>(
        serverInfo.baseUrl, serverInfo.token, ['list-panes', '--target', tabId, '--json'],
      )
      expect(panes.status).toBe('ok')
      expect(panes.data.panes.map((pane) => pane.id)).toEqual(expect.arrayContaining([paneId, split.data.paneId]))

      const resized = await runCliJson<ActionResult<{ tabId: string }>>(
        serverInfo.baseUrl, serverInfo.token, ['resize-pane', '--target', paneId, '--sizes', '[65,35]'],
      )
      expect(resized.status).toBe('ok')
      await expect.poll(async () => {
        const response = await page.request.get(`${serverInfo.baseUrl}/api/layout/snapshot?tabId=${encodeURIComponent(tabId)}`, {
          headers: { 'x-auth-token': serverInfo.token },
        })
        expect(response.ok()).toBe(true)
        const snapshot = await response.json() as ActionResult<{ layouts: Record<string, { sizes: number[] }> }>
        return snapshot.data.layouts[tabId]?.sizes
      }).toEqual([65, 35])
      const swapped = await runCliJson<ActionResult<unknown>>(
        serverInfo.baseUrl, serverInfo.token, ['swap-pane', '--target', paneId, '--with', split.data.paneId],
      )
      expect(swapped.status).toBe('ok')

      const marker = `CLI-RUST-MARKER-${randomUUID()}`
      const sent = await runCliJson<ActionResult<{ terminalId: string }>>(
        serverInfo.baseUrl, serverInfo.token, ['send-keys', '--target', paneId, '-l', '--keys', `echo ${marker}\r`],
      )
      expect(sent.status).toBe('ok')
      const waited = await runCliJson<ActionResult<{ matched: boolean }>>(
        serverInfo.baseUrl, serverInfo.token, ['wait-for', '--target', paneId, '--pattern', marker, '--timeout', '20'],
      )
      expect(waited.data.matched).toBe(true)
      const captured = await runCli(serverInfo.baseUrl, serverInfo.token, ['capture-pane', '--target', paneId, '--S', '-200', '--J', '--e'])
      expect(captured.code).toBe(0)
      expect(captured.stdout).toContain(marker)

      const browser = await runCliJson<ActionResult<{ tabId: string; paneId: string }>>(
        serverInfo.baseUrl, serverInfo.token, ['open-browser', '--name', 'CLI Rust browser', 'https://example.com/cli-rust-initial'],
      )
      expect(browser.status).toBe('ok')
      const browserUrl = 'https://example.com/cli-rust-navigated'
      const navigated = await runCliJson<ActionResult<{ paneId: string }>>(
        serverInfo.baseUrl, serverInfo.token, ['navigate', browserUrl, '--target', browser.data.paneId],
      )
      expect(navigated.status).toBe('ok')
      await expect(page.getByText('CLI Rust browser', { exact: true })).toBeVisible()

      const screenshot = await runCliJson<ActionResult<{ path: string; width: number; height: number }>>(
        serverInfo.baseUrl,
        serverInfo.token,
        ['screenshot-pane', '--target', browser.data.paneId, '--name', 'cli-rust-browser', '--path', screenshotDir, '--overwrite'],
      )
      expect(screenshot.status).toBe('ok')
      expect(screenshot.data.width).toBeGreaterThan(0)
      expect(screenshot.data.height).toBeGreaterThan(0)
      await expect(fs.access(screenshot.data.path)).resolves.toBeUndefined()

      await expect.poll(async () => {
        const listed = await runCliJson<Array<{ sessions: Array<{ sessionId: string }> }>>(
          serverInfo.baseUrl, serverInfo.token, ['list-sessions'],
        )
        return listed.flatMap((project) => project.sessions).map((session) => session.sessionId)
      }, { timeout: 30_000 }).toEqual(expect.arrayContaining(sessionIds))
      const searched = await runCliJson<{ results: Array<{ sessionId: string }> }>(
        serverInfo.baseUrl, serverInfo.token, ['search-sessions', SESSION_MARKER],
      )
      expect(searched.results.map((result) => result.sessionId)).toEqual(expect.arrayContaining(sessionIds))

      const unsupported = await runCli(serverInfo.baseUrl, serverInfo.token, ['run', 'echo', 'must-not-hit-http'])
      expect(unsupported.code).toBe(2)
      expect(unsupported.stderr).toContain("Action 'run' is unavailable with the Rust Freshell server.")
    } finally {
      await fs.rm(scratchDir, { recursive: true, force: true })
      await server.stop()
    }
  })
})
