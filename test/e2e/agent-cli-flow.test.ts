import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import path from 'path'
import { createRequire } from 'module'
import fs from 'node:fs/promises'
import express from 'express'
import http from 'http'
import { createAgentApiRouter } from '../../server/agent-api/router'

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
  const { tsxPath, cliPath } = resolveCliPaths()
  const proc = spawn(process.execPath, [tsxPath, cliPath, ...args], {
    env: { ...process.env, FRESHELL_URL: url, FRESHELL_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`cli exited ${code}: ${stderr}`))
      resolve({ stdout, stderr })
    })
  })
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
})
