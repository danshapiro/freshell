import { describe, it, expect, vi } from 'vitest'
import { spawn } from 'child_process'
import path from 'path'
import { createRequire } from 'module'
import fs from 'node:fs/promises'
import express from 'express'
import http from 'http'
import { createAgentApiRouter } from '../../server/agent-api/router'
import { LayoutStore } from '../../server/agent-api/layout-store'

function startTestServer(
  layoutStoreOverrides: Partial<Record<string, any>> = {},
  options: { wsHandler?: any } = {},
) {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      listTabs: () => ([{ id: 'tab_1', title: 'Alpha', activePaneId: 'pane_1' }]),
      listPanes: () => ([{ id: 'pane_1', index: 0, kind: 'terminal', terminalId: 'term_1' }]),
      getActiveTabId: () => 'tab_1',
      ...layoutStoreOverrides,
    },
    registry: { create: () => ({ terminalId: 'term_1' }) },
    wsHandler: options.wsHandler,
  }))

  const server = http.createServer(app)
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function resolveCliPaths() {
  const require = createRequire(import.meta.url)
  const tsxRoot = path.dirname(require.resolve('tsx/package.json'))
  return {
    tsxPath: path.join(tsxRoot, 'dist', 'cli.mjs'),
    cliPath: path.resolve(__dirname, '../../server/cli/index.ts'),
  }
}

async function runCli(url: string, args: string[]) {
  const result = await runCliResult(url, args)
  if (result.code !== 0) throw new Error(`cli exited ${result.code}: ${result.stderr}`)
  return { stdout: result.stdout, stderr: result.stderr }
}

async function runCliResult(url: string, args: string[]) {
  const { tsxPath, cliPath } = resolveCliPaths()
  const proc = spawn(process.execPath, [tsxPath, cliPath, ...args], {
    env: { ...process.env, FRESHELL_URL: url, FRESHELL_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}

async function startTestServerWithRealLayoutStore() {
  const layoutStore = new LayoutStore()
  const app = express()
  app.use(express.json())

  let terminalCount = 0
  app.use('/api', createAgentApiRouter({
    layoutStore,
    registry: {
      create: () => ({ terminalId: `term_${++terminalCount}` }),
      get: () => undefined,
      input: () => {},
    },
  }))

  const server = http.createServer(app)
  return await new Promise<{ url: string; layoutStore: LayoutStore; close: () => Promise<void> }>((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://localhost:${port}`,
        layoutStore,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

async function runCliJson<T>(url: string, args: string[]) {
  const output = await runCli(url, args)
  return JSON.parse(output.stdout) as T
}

async function waitForExpect(assertions: () => void, timeoutMs = 2000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      assertions()
      return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw lastError ?? new Error('Timed out waiting for expectations to pass')
}

describe('cli e2e flow', () => {
  it('runs list-tabs end-to-end', async () => {
    const { url, close } = await startTestServer()
    try {
      const output = await runCli(url, ['list-tabs', '--json'])

      expect(output.stdout).toContain('tabs')
    } finally {
      await close()
    }
  })

  it('uses active tab id when display has no target', async () => {
    const { url, close } = await startTestServer({
      listTabs: () => ([
        { id: 'tab_1', title: 'Alpha', activePaneId: 'pane_1' },
        { id: 'tab_2', title: 'Beta', activePaneId: 'pane_2' },
      ]),
      listPanes: (tabId?: string) => {
        if (tabId === 'tab_2') return [{ id: 'pane_2', index: 0, kind: 'terminal', terminalId: 'term_2' }]
        return [{ id: 'pane_1', index: 0, kind: 'terminal', terminalId: 'term_1' }]
      },
      getActiveTabId: () => 'tab_2',
    })
    try {
      const output = await runCli(url, ['display', '-p', '#I'])

      expect(output.stdout.trim()).toBe('tab_2')
    } finally {
      await close()
    }
  })

  it('uses the first pane in the active tab when pane commands omit a target and tabs omit activePaneId', async () => {
    const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
    const { url, close } = await startTestServer({
      listTabs: () => ([
        { id: 'tab_1', title: 'Alpha' },
      ]),
      listPanes: () => ([
        { id: 'pane_1', index: 0, kind: 'terminal', terminalId: 'term_1', title: 'Shell' },
      ]),
      renamePane,
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'shell', terminalId: 'term_1' },
      }),
    })
    try {
      const output = await runCli(url, ['rename-pane', 'Renamed shell'])
      const parsed = JSON.parse(output.stdout) as { status: string }

      expect(parsed.status).toBe('ok')
      expect(renamePane).toHaveBeenCalledWith('pane_1', 'Renamed shell')
    } finally {
      await close()
    }
  })

  it('rejects ambiguous pane title targets', async () => {
    const { url, close } = await startTestServer({
      listTabs: () => ([
        { id: 'tab_1', title: 'Alpha', activePaneId: 'pane_1' },
        { id: 'tab_2', title: 'Beta', activePaneId: 'pane_2' },
      ]),
      listPanes: (tabId?: string) => {
        if (tabId === 'tab_2') {
          return [{ id: 'pane_2', index: 0, kind: 'terminal', terminalId: 'term_2', title: 'Shell' }]
        }
        return [{ id: 'pane_1', index: 0, kind: 'terminal', terminalId: 'term_1', title: 'Shell' }]
      },
    })
    try {
      const output = await runCliResult(url, ['select-pane', '-t', 'Shell'])

      expect(output.code).toBe(1)
      expect(output.stderr).toContain('pane target is ambiguous')
    } finally {
      await close()
    }
  })

  it('prints tab-vs-pane guidance for new-window alias', async () => {
    const { url, close } = await startTestServer({
      createTab: () => ({ tabId: 'tab_new', paneId: 'pane_new' }),
      attachPaneContent: () => {},
    })
    try {
      const output = await runCli(url, ['new-window', '--name', 'Alias Test'])

      expect(output.stderr).toContain('new-window maps to new-tab')
      expect(output.stderr).toContain('Use split-pane')
      expect(output.stdout).toContain('"tabId": "tab_new"')
    } finally {
      await close()
    }
  })

  it('normalizes resize-pane single-axis values to complementary split percentages', async () => {
    const resizePaneCalls: Array<{ tabId?: string; splitId: string; sizes: [number, number] }> = []
    const { url, close } = await startTestServer({
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
      findSplitForPane: () => ({ tabId: 'tab_1', splitId: 'split_1' }),
      getSplitSizes: (_tabId: string | undefined, splitId: string) => (
        splitId === 'split_1' ? [72, 28] as [number, number] : undefined
      ),
      resizePane: (tabId: string | undefined, splitId: string, sizes: [number, number]) => {
        resizePaneCalls.push({ tabId, splitId, sizes })
        return { tabId: tabId || 'tab_1' }
      },
    })
    try {
      const output = await runCli(url, ['resize-pane', '-t', 'pane_1', '--y', '33'])
      const parsed = JSON.parse(output.stdout) as { status: string }
      expect(parsed.status).toBe('ok')
      expect(resizePaneCalls).toHaveLength(1)
      expect(resizePaneCalls[0]).toEqual({
        tabId: 'tab_1',
        splitId: 'split_1',
        sizes: [67, 33],
      })
    } finally {
      await close()
    }
  })

  it('runs screenshot-view end-to-end with required name', async () => {
    const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6r7gkAAAAASUVORK5CYII='
    const { url, close } = await startTestServer({}, {
      wsHandler: {
        requestUiScreenshot: async () => ({
          ok: true,
          mimeType: 'image/png',
          imageBase64: tinyPngBase64,
          width: 1,
          height: 1,
          changedFocus: false,
          restoredFocus: false,
        }),
      },
    })

    let screenshotPath: string | undefined
    try {
      const output = await runCli(url, ['screenshot-view', '--name', 'cli-e2e-shot', '--overwrite'])
      const parsed = JSON.parse(output.stdout) as { status: string; data: { path: string; scope: string } }
      expect(parsed.status).toBe('ok')
      expect(parsed.data.scope).toBe('view')
      expect(parsed.data.path.endsWith('cli-e2e-shot.png')).toBe(true)
      screenshotPath = parsed.data.path

      const stat = await fs.stat(screenshotPath)
      expect(stat.isFile()).toBe(true)
      expect(stat.size).toBeGreaterThan(0)
    } finally {
      if (screenshotPath) {
        await fs.unlink(screenshotPath).catch(() => undefined)
      }
      await close()
    }
  })

  it('renames the active tab when only a new name is provided', async () => {
    const server = await startTestServerWithRealLayoutStore()
    try {
      const first = await runCliJson<{ data: { tabId: string } }>(server.url, ['new-tab', '-n', 'Backlog'])
      const second = await runCliJson<{ data: { tabId: string } }>(server.url, ['new-tab', '-n', 'Active'])

      const renamed = await runCli(server.url, ['rename-tab', 'Release prep'])

      expect(renamed.stderr).toContain('active tab used')
      await waitForExpect(() => {
        const snapshot = (server.layoutStore as any).snapshot
        expect(snapshot.activeTabId).toBe(second.data.tabId)
        expect(snapshot.tabs.find((tab: any) => tab.id === second.data.tabId)?.title).toBe('Release prep')
        expect(snapshot.tabs.find((tab: any) => tab.id === first.data.tabId)?.title).toBe('Backlog')
      })
    } finally {
      await server.close()
    }
  })

  it('renames a non-active tab when a target id is provided', async () => {
    const server = await startTestServerWithRealLayoutStore()
    try {
      const first = await runCliJson<{ data: { tabId: string } }>(server.url, ['new-tab', '-n', 'Backlog'])
      const second = await runCliJson<{ data: { tabId: string } }>(server.url, ['new-tab', '-n', 'Active'])

      await runCli(server.url, ['rename-tab', first.data.tabId, 'Release', 'board'])

      await waitForExpect(() => {
        const snapshot = (server.layoutStore as any).snapshot
        expect(snapshot.activeTabId).toBe(second.data.tabId)
        expect(snapshot.tabs.find((tab: any) => tab.id === first.data.tabId)?.title).toBe('Release board')
        expect(snapshot.tabs.find((tab: any) => tab.id === second.data.tabId)?.title).toBe('Active')
      })
    } finally {
      await server.close()
    }
  })

  it('renames the tab and panes in a create split rename flow', async () => {
    const server = await startTestServerWithRealLayoutStore()
    try {
      const created = await runCliJson<{ data: { tabId: string; paneId: string } }>(server.url, [
        'new-tab',
        '-n',
        'Workspace',
        '--codex',
        '--cwd',
        process.cwd(),
      ])
      const tabId = created.data.tabId
      const firstPaneId = created.data.paneId

      const split = await runCliJson<{ data: { paneId: string } }>(server.url, [
        'split-pane',
        '-t',
        firstPaneId,
        '--editor',
        '/tmp/example.txt',
      ])
      const secondPaneId = split.data.paneId

      await runCli(server.url, ['rename-tab', '-t', tabId, '-n', 'Issue 166 work'])
      await runCli(server.url, ['rename-pane', '-t', firstPaneId, '-n', 'Codex'])
      await runCli(server.url, ['rename-pane', secondPaneId, 'Editor'])

      await waitForExpect(() => {
        const snapshot = (server.layoutStore as any).snapshot
        expect(snapshot.tabs.find((tab: any) => tab.id === tabId)?.title).toBe('Issue 166 work')
        expect(snapshot.paneTitles[tabId][firstPaneId]).toBe('Codex')
        expect(snapshot.paneTitles[tabId][secondPaneId]).toBe('Editor')
      })
    } finally {
      await server.close()
    }
  })

  it('renames the active pane when only a new name is provided', async () => {
    const server = await startTestServerWithRealLayoutStore()
    try {
      const created = await runCliJson<{ data: { tabId: string; paneId: string } }>(server.url, [
        'new-tab',
        '-n',
        'Workspace',
        '--shell',
        'system',
      ])

      const renamed = await runCli(server.url, ['rename-pane', 'Main shell'])

      expect(renamed.stderr).toContain('active tab used')
      await waitForExpect(() => {
        const snapshot = (server.layoutStore as any).snapshot
        expect(snapshot.paneTitles[created.data.tabId][created.data.paneId]).toBe('Main shell')
        expect(snapshot.tabs.find((tab: any) => tab.id === created.data.tabId)?.title).toBe('Main shell')
      })
    } finally {
      await server.close()
    }
  })

  it('lists and resolves derived pane titles without an explicit rename', async () => {
    const server = await startTestServerWithRealLayoutStore()
    try {
      const created = await runCliJson<{ data: { tabId: string; paneId: string } }>(server.url, [
        'new-tab',
        '-n',
        'Workspace',
        '--codex',
        '--cwd',
        process.cwd(),
      ])
      const tabId = created.data.tabId
      const firstPaneId = created.data.paneId

      const split = await runCliJson<{ data: { paneId: string } }>(server.url, [
        'split-pane',
        '-t',
        firstPaneId,
        '--editor',
        '/tmp/example.txt',
      ])

      const listed = await runCliJson<{ data: { panes: Array<{ id: string; title?: string }> } }>(server.url, [
        'list-panes',
        '--json',
      ])
      expect(listed.data.panes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstPaneId, title: 'Codex CLI' }),
        expect.objectContaining({ id: split.data.paneId, title: 'example.txt' }),
      ]))

      const listedText = await runCli(server.url, ['list-panes'])
      const listedRows = listedText.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'))
      expect(listedRows).toEqual(expect.arrayContaining([
        [firstPaneId, '0', 'terminal', 'term_1'],
        [split.data.paneId, '1', 'editor', ''],
      ]))
      expect(listedRows.every((row) => row.length === 4)).toBe(true)

      const listedWithTitles = await runCli(server.url, ['list-panes', '--titles'])
      expect(listedWithTitles.stdout).toContain('Codex CLI')
      expect(listedWithTitles.stdout).toContain('example.txt')

      await runCli(server.url, ['select-pane', '-t', 'example.txt'])

      await waitForExpect(() => {
        const snapshot = (server.layoutStore as any).snapshot
        expect(snapshot.activePane[tabId]).toBe(split.data.paneId)
      })
    } finally {
      await server.close()
    }
  })

  it('keeps title-based pane targeting aligned after swap-pane', async () => {
    const server = await startTestServerWithRealLayoutStore()
    try {
      const created = await runCliJson<{ data: { tabId: string; paneId: string } }>(server.url, [
        'new-tab',
        '-n',
        'Workspace',
        '--codex',
        '--cwd',
        process.cwd(),
      ])
      const tabId = created.data.tabId
      const firstPaneId = created.data.paneId

      const split = await runCliJson<{ data: { paneId: string } }>(server.url, [
        'split-pane',
        '-t',
        firstPaneId,
        '--editor',
        '/tmp/example.txt',
      ])
      const secondPaneId = split.data.paneId

      await runCli(server.url, ['rename-pane', '-t', firstPaneId, '-n', 'Codex'])
      await runCli(server.url, ['rename-pane', '-t', secondPaneId, '-n', 'Editor'])
      await runCli(server.url, ['swap-pane', '-t', firstPaneId, '-s', secondPaneId])

      const listed = await runCliJson<{ data: { panes: Array<{ id: string; title?: string }> } }>(server.url, [
        'list-panes',
        '--json',
      ])
      expect(listed.data.panes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstPaneId, title: 'Editor' }),
        expect.objectContaining({ id: secondPaneId, title: 'Codex' }),
      ]))

      await runCli(server.url, ['select-pane', '-t', 'Editor'])

      await waitForExpect(() => {
        const snapshot = (server.layoutStore as any).snapshot
        expect(snapshot.activePane[tabId]).toBe(firstPaneId)
      })
    } finally {
      await server.close()
    }
  })

  it('lists pane titles publicly and resolves pane targets by title', async () => {
    const server = await startTestServerWithRealLayoutStore()
    try {
      const created = await runCliJson<{ data: { tabId: string; paneId: string } }>(server.url, [
        'new-tab',
        '-n',
        'Workspace',
        '--codex',
        '--cwd',
        process.cwd(),
      ])
      const tabId = created.data.tabId
      const firstPaneId = created.data.paneId

      const split = await runCliJson<{ data: { paneId: string } }>(server.url, [
        'split-pane',
        '-t',
        firstPaneId,
        '--editor',
        '/tmp/example.txt',
      ])
      const secondPaneId = split.data.paneId

      await runCli(server.url, ['rename-pane', '-t', secondPaneId, '-n', 'Editor notes'])

      const listed = await runCliJson<{ data: { panes: Array<{ id: string; title?: string }> } }>(server.url, [
        'list-panes',
        '--json',
      ])
      expect(listed.data.panes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: secondPaneId, title: 'Editor notes' }),
      ]))

      const listedText = await runCli(server.url, ['list-panes'])
      const listedRows = listedText.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'))
      expect(listedRows).toEqual(expect.arrayContaining([
        [firstPaneId, '0', 'terminal', 'term_1'],
        [secondPaneId, '1', 'editor', ''],
      ]))
      expect(listedRows.every((row) => row.length === 4)).toBe(true)

      const listedWithTitles = await runCli(server.url, ['list-panes', '--titles'])
      expect(listedWithTitles.stdout).toContain('Editor notes')

      await runCli(server.url, ['select-pane', '-t', 'Editor notes'])

      await waitForExpect(() => {
        const snapshot = (server.layoutStore as any).snapshot
        expect(snapshot.activePane[tabId]).toBe(secondPaneId)
      })
    } finally {
      await server.close()
    }
  })
})
