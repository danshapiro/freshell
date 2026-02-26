import { describe, it, expect, vi } from 'vitest'
import { spawn } from 'child_process'
import path from 'path'
import os from 'os'
import fs from 'node:fs/promises'
import express from 'express'
import http from 'http'
import { createRequire } from 'module'
import { LayoutStore } from '../../server/agent-api/layout-store'
import { createAgentApiRouter } from '../../server/agent-api/router'

type CliRun = {
  code: number | null
  stdout: string
  stderr: string
}

type TerminalRecord = {
  terminalId: string
  status: 'running' | 'exited'
  exitCode?: number
  buffer: { snapshot: () => string }
  _bufferText: string
  _pendingInput: string
}

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6r7gkAAAAASUVORK5CYII='

function createFakeRegistry() {
  let seq = 0
  const records = new Map<string, TerminalRecord>()

  const create = vi.fn((_opts?: unknown) => {
    const terminalId = `term_${++seq}`
    const record: TerminalRecord = {
      terminalId,
      status: 'running',
      buffer: { snapshot: () => `${record._bufferText}${record._pendingInput}` },
      _bufferText: '$ ',
      _pendingInput: '',
    }
    records.set(terminalId, record)
    return { terminalId }
  })

  const input = vi.fn((terminalId: string, data: unknown) => {
    const record = records.get(terminalId)
    if (!record || record.status !== 'running') return false

    const text = String(data ?? '')
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        const line = record._pendingInput
        record._bufferText += line + '\n'
        if (line.startsWith('echo ')) {
          record._bufferText += line.slice(5) + '\n'
        }
        record._pendingInput = ''
        record._bufferText += '$ '
        continue
      }
      record._pendingInput += ch
    }
    return true
  })

  const get = (terminalId: string) => records.get(terminalId)
  const list = () => [...records.values()]

  return { create, input, get, list }
}

function findPaneContent(node: any, paneId: string): any | undefined {
  if (!node) return undefined
  if (node.type === 'leaf') {
    return node.id === paneId ? node.content : undefined
  }
  return findPaneContent(node.children?.[0], paneId) ?? findPaneContent(node.children?.[1], paneId)
}

function parseJsonOutput<T>(text: string): T {
  return JSON.parse(text.trim()) as T
}

function resolveCliPaths() {
  const require = createRequire(import.meta.url)
  const tsxRoot = path.dirname(require.resolve('tsx/package.json'))
  const tsxPath = path.join(tsxRoot, 'dist', 'cli.mjs')
  const cliPath = path.resolve(__dirname, '../../server/cli/index.ts')
  return { tsxPath, cliPath }
}

async function runCli(url: string, args: string[]): Promise<CliRun> {
  const { tsxPath, cliPath } = resolveCliPaths()
  const proc = spawn(process.execPath, [tsxPath, cliPath, ...args], {
    env: { ...process.env, FRESHELL_URL: url, FRESHELL_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return await new Promise<CliRun>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function runCliJson<T>(url: string, args: string[]): Promise<T> {
  const run = await runCli(url, args)
  if (run.code !== 0) {
    throw new Error(`cli ${args.join(' ')} exited ${run.code}: ${run.stderr}`)
  }
  return parseJsonOutput<T>(run.stdout)
}

async function startTestServer() {
  const app = express()
  app.use(express.json())

  const layoutStore = new LayoutStore()
  const registry = createFakeRegistry()
  const requestUiScreenshot = vi.fn(async (_payload: unknown) => ({
    ok: true,
    mimeType: 'image/png',
    imageBase64: tinyPngBase64,
    width: 1,
    height: 1,
    changedFocus: false,
    restoredFocus: false,
  }))
  const wsHandler = {
    broadcastUiCommand: vi.fn(),
    requestUiScreenshot,
  }

  app.use('/api', createAgentApiRouter({ layoutStore, registry, wsHandler }))

  const server = http.createServer(app)
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve())
  })
  const { port } = server.address() as { port: number }

  return {
    url: `http://localhost:${port}`,
    layoutStore,
    wsHandler,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('agent cli screenshot smoke', () => {
  it('covers terminal/editor/browser panes with pane+tab+view screenshots in one flow', async () => {
    const server = await startTestServer()
    const smokeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agent-cli-smoke-'))
    const editorPath = path.join(smokeDir, 'editor-canary.txt')
    const editorCanary = `EDITOR_CANARY_${Date.now()}`
    const termCanary = `TERM_CANARY_${Date.now()}`
    const browserCanary = `bsmk${Date.now()}`
    const browserUrl = `https://${browserCanary}.example.com/`
    const createdPaths = new Set<string>()

    try {
      await fs.writeFile(editorPath, `${editorCanary}\nline 2\n`)
      createdPaths.add(editorPath)

      const createdTab = await runCliJson<{ status: string; data: { tabId: string; paneId: string } }>(server.url, [
        'new-tab',
        '-n',
        'Smoke Pane Types',
      ])
      expect(createdTab.status).toBe('ok')

      const tabId = createdTab.data.tabId
      const terminalPaneId = createdTab.data.paneId

      const editorSplit = await runCliJson<{ status: string; data: { paneId: string } }>(server.url, [
        'split-pane',
        '-t',
        terminalPaneId,
        '--editor',
        editorPath,
      ])
      expect(editorSplit.status).toBe('ok')
      const editorPaneId = editorSplit.data.paneId
      server.layoutStore.attachPaneContent(tabId, editorPaneId, {
        kind: 'editor',
        filePath: editorPath,
        language: 'plaintext',
        readOnly: false,
        content: `${editorCanary}\nline 2\n`,
        viewMode: 'source',
      })

      const browserSplit = await runCliJson<{ status: string; data: { paneId: string } }>(server.url, [
        'split-pane',
        '-t',
        terminalPaneId,
        '--browser',
        browserUrl,
      ])
      expect(browserSplit.status).toBe('ok')
      const browserPaneId = browserSplit.data.paneId

      const panes = await runCliJson<{ status: string; data: { panes: Array<{ kind: string }> } }>(server.url, [
        'list-panes',
        '-t',
        tabId,
        '--json',
      ])
      expect(panes.data.panes.map((pane) => pane.kind).sort()).toEqual(['browser', 'editor', 'terminal'])

      const literalSend = await runCliJson<{ status: string }>(server.url, [
        'send-keys',
        '-t',
        terminalPaneId,
        '-l',
        `echo ${termCanary}`,
      ])
      expect(literalSend.status).toBe('ok')

      const enterSend = await runCliJson<{ status: string }>(server.url, [
        'send-keys',
        terminalPaneId,
        'ENTER',
      ])
      expect(enterSend.status).toBe('ok')
      const captured = await runCli(server.url, ['capture-pane', '-t', terminalPaneId, '-S', '-20'])
      expect(captured.code).toBe(0)
      expect(captured.stdout).toContain(termCanary)
      const capturedEditor = await runCli(server.url, ['capture-pane', '-t', editorPaneId, '-S', '-20'])
      expect(capturedEditor.code).toBe(0)
      expect(capturedEditor.stdout).toContain(editorCanary)

      const layoutSnapshot = (server.layoutStore as any).snapshot
      const root = layoutSnapshot.layouts[tabId]
      const editorContent = findPaneContent(root, editorPaneId)
      const browserContent = findPaneContent(root, browserPaneId)
      expect(editorContent?.kind).toBe('editor')
      expect(editorContent?.filePath).toBe(editorPath)
      expect(browserContent?.kind).toBe('browser')
      expect(browserContent?.url).toBe(browserUrl)

      const shotArgs = ['--path', smokeDir, '--overwrite'] as const
      const paneTerminal = await runCliJson<{ status: string; data: { path: string; scope: string } }>(server.url, [
        'screenshot-pane',
        '-t',
        terminalPaneId,
        '--name',
        'smoke-pane-terminal',
        ...shotArgs,
      ])
      const paneEditor = await runCliJson<{ status: string; data: { path: string; scope: string } }>(server.url, [
        'screenshot-pane',
        '-t',
        editorPaneId,
        '--name',
        'smoke-pane-editor',
        ...shotArgs,
      ])
      const paneBrowser = await runCliJson<{ status: string; data: { path: string; scope: string } }>(server.url, [
        'screenshot-pane',
        '-t',
        browserPaneId,
        '--name',
        'smoke-pane-browser',
        ...shotArgs,
      ])
      const tabShot = await runCliJson<{ status: string; data: { path: string; scope: string } }>(server.url, [
        'screenshot-tab',
        '-t',
        tabId,
        '--name',
        'smoke-tab-all',
        ...shotArgs,
      ])
      const viewShot = await runCliJson<{ status: string; data: { path: string; scope: string } }>(server.url, [
        'screenshot-view',
        '--name',
        'smoke-view-all',
        ...shotArgs,
      ])

      const allShots = [paneTerminal, paneEditor, paneBrowser, tabShot, viewShot]
      for (const shot of allShots) {
        createdPaths.add(shot.data.path)
        await expect(fs.stat(shot.data.path)).resolves.toMatchObject({ isFile: expect.any(Function) })
        const stat = await fs.stat(shot.data.path)
        expect(stat.size).toBeGreaterThan(0)
      }
      expect(paneTerminal.data.scope).toBe('pane')
      expect(paneEditor.data.scope).toBe('pane')
      expect(paneBrowser.data.scope).toBe('pane')
      expect(tabShot.data.scope).toBe('tab')
      expect(viewShot.data.scope).toBe('view')

      const screenshotPayloads = server.wsHandler.requestUiScreenshot.mock.calls.map(([payload]: [any]) => payload)
      expect(screenshotPayloads).toHaveLength(5)
      expect(screenshotPayloads[0]).toMatchObject({ scope: 'pane', tabId, paneId: terminalPaneId })
      expect(screenshotPayloads[1]).toMatchObject({ scope: 'pane', tabId, paneId: editorPaneId })
      expect(screenshotPayloads[2]).toMatchObject({ scope: 'pane', tabId, paneId: browserPaneId })
      expect(screenshotPayloads[3]).toMatchObject({ scope: 'tab', tabId })
      expect(screenshotPayloads[4]).toMatchObject({ scope: 'view' })
    } finally {
      for (const filePath of createdPaths) {
        await fs.rm(filePath, { force: true }).catch(() => undefined)
      }
      await fs.rm(smokeDir, { recursive: true, force: true }).catch(() => undefined)
      await server.close()
    }
  }, 120_000)
})
