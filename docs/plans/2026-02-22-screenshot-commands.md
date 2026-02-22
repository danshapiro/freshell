# Screenshot Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tmux-style screenshot automation commands that can capture a pane, tab, or current view, with mandatory screenshot name and optional output path (directory or full file path), defaulting to OS temp.

**Architecture:** Keep screenshot capture UI-native so it works for all current and future pane kinds (terminal, editor, browser, freshclaude, picker, etc.) without pane-specific server logic. CLI resolves targets and calls a new API endpoint. Server requests a screenshot from the active UI WebSocket client, receives PNG bytes, writes them atomically to disk, and returns structured JSON metadata.

**Tech Stack:** TypeScript, Express router (`server/agent-api`), WebSocket protocol (`shared/ws-protocol.ts`, `server/ws-handler.ts`), React/Redux client (`src/App.tsx` + new screenshot helper), CLI (`server/cli/index.ts`), Vitest + supertest + ws integration tests.

---

### Task 1: Add Screenshot File Path Resolver (TDD)

**Files:**
- Create: `server/agent-api/screenshot-path.ts`
- Test: `test/unit/server/agent-screenshot-path.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { resolveScreenshotOutputPath } from '../../../server/agent-api/screenshot-path'

describe('resolveScreenshotOutputPath', () => {
  const cleanup = new Set<string>()

  afterEach(async () => {
    await Promise.all([...cleanup].map((p) => fs.rm(p, { recursive: true, force: true })))
    cleanup.clear()
  })

  it('defaults to os tmpdir and appends .png', async () => {
    const out = await resolveScreenshotOutputPath({ name: 'split-check' })
    expect(out).toBe(path.join(os.tmpdir(), 'split-check.png'))
  })

  it('treats existing directory path as directory target', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-shot-'))
    cleanup.add(dir)
    const out = await resolveScreenshotOutputPath({ name: 'pane-a', pathInput: dir })
    expect(out).toBe(path.join(dir, 'pane-a.png'))
  })

  it('treats file-looking path as full output path', async () => {
    const out = await resolveScreenshotOutputPath({
      name: 'ignored-name',
      pathInput: path.join(os.tmpdir(), 'custom.png'),
    })
    expect(out).toBe(path.join(os.tmpdir(), 'custom.png'))
  })

  it('creates missing directory when pathInput is directory intent', async () => {
    const dir = path.join(os.tmpdir(), 'freshell-new-dir', `${Date.now()}`)
    cleanup.add(dir)
    const out = await resolveScreenshotOutputPath({ name: 'view', pathInput: `${dir}/` })
    expect(out).toBe(path.join(dir, 'view.png'))
  })

  it('rejects names containing path separators (defense in depth)', async () => {
    await expect(
      resolveScreenshotOutputPath({ name: '../escape', pathInput: os.tmpdir() }),
    ).rejects.toThrow(/path separators/i)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:server -- test/unit/server/agent-screenshot-path.test.ts`
Expected: FAIL because module/function does not exist.

**Step 3: Write minimal implementation**

```ts
// server/agent-api/screenshot-path.ts
import os from 'os'
import path from 'path'
import fs from 'fs/promises'

function ensurePngExtension(name: string): string {
  return name.toLowerCase().endsWith('.png') ? name : `${name}.png`
}

function isExplicitDirectoryInput(input: string): boolean {
  return input.endsWith(path.sep) || input.endsWith('/')
}

function normalizeScreenshotBaseName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('name required')
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('name must not contain path separators')
  }
  if (trimmed === '.' || trimmed === '..') throw new Error('invalid screenshot name')
  return ensurePngExtension(trimmed)
}

export async function resolveScreenshotOutputPath(opts: { name: string; pathInput?: string }): Promise<string> {
  const baseName = normalizeScreenshotBaseName(opts.name)
  if (!opts.pathInput) return path.resolve(path.join(os.tmpdir(), baseName))

  const candidate = path.resolve(opts.pathInput)
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null
  try {
    stat = await fs.stat(candidate)
  } catch {
    stat = null
  }

  if (stat?.isDirectory() || (!stat && isExplicitDirectoryInput(opts.pathInput))) {
    await fs.mkdir(candidate, { recursive: true })
    return path.join(candidate, baseName)
  }

  await fs.mkdir(path.dirname(candidate), { recursive: true })
  return candidate.toLowerCase().endsWith('.png') ? candidate : `${candidate}.png`
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:server -- test/unit/server/agent-screenshot-path.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/server/agent-screenshot-path.test.ts server/agent-api/screenshot-path.ts
git commit -m "test+feat(agent-api): add screenshot output path resolver with dir/file semantics"
```

---

### Task 2: Add WebSocket Screenshot Request/Response Plumbing (TDD)

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts` (including its local `ClientMessageSchema`)
- Modify: `server/agent-api/layout-store.ts`
- Test: `test/server/ws-protocol.test.ts`
- Test: `test/unit/server/agent-layout-store.test.ts`

**Step 1: Write the failing tests**

```ts
// test/unit/server/agent-layout-store.test.ts
it('tracks and exposes layout source connection id', () => {
  const store = new LayoutStore()
  store.updateFromUi(snapshot as any, 'conn-abc')
  expect(store.getSourceConnectionId()).toBe('conn-abc')
})
```

```ts
// test/server/ws-protocol.test.ts
it('dispatches screenshot request and resolves when ui.screenshot.result arrives', async () => {
  const handler = new WsHandler(server!, registry as any)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
  await waitForMessage(ws, (m) => m.type === 'ready')

  const pending = handler.requestUiScreenshot({ scope: 'view', timeoutMs: 2000 })
  const req = await waitForMessage(ws, (m) => m.type === 'ui.command' && m.command === 'screenshot.capture')

  ws.send(JSON.stringify({
    type: 'ui.screenshot.result',
    requestId: req.payload.requestId,
    ok: true,
    mimeType: 'image/png',
    imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2M7nQAAAAASUVORK5CYII=',
    width: 1,
    height: 1,
  }))

  await expect(pending).resolves.toMatchObject({ ok: true, mimeType: 'image/png', width: 1, height: 1 })
})

it('accepts screenshot results above 1MB payload without ws protocol rejection', async () => {
  const handler = new WsHandler(server!, registry as any)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
  await waitForMessage(ws, (m) => m.type === 'ready')

  const bigImage = 'A'.repeat(1_100_000)
  const pending = handler.requestUiScreenshot({ scope: 'view', timeoutMs: 2000 })
  const req = await waitForMessage(ws, (m) => m.type === 'ui.command' && m.command === 'screenshot.capture')

  ws.send(JSON.stringify({
    type: 'ui.screenshot.result',
    requestId: req.payload.requestId,
    ok: true,
    mimeType: 'image/png',
    imageBase64: bigImage,
    width: 1200,
    height: 800,
  }))

  await expect(pending).resolves.toMatchObject({ ok: true, width: 1200, height: 800 })
})

it('rejects screenshot payload above MAX_SCREENSHOT_BASE64_BYTES', async () => {
  const handler = new WsHandler(server!, registry as any)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
  await waitForMessage(ws, (m) => m.type === 'ready')

  const tooLargeImage = 'B'.repeat(12 * 1024 * 1024 + 1)
  const pending = handler.requestUiScreenshot({ scope: 'view', timeoutMs: 2000 })
  const req = await waitForMessage(ws, (m) => m.type === 'ui.command' && m.command === 'screenshot.capture')

  ws.send(JSON.stringify({
    type: 'ui.screenshot.result',
    requestId: req.payload.requestId,
    ok: true,
    mimeType: 'image/png',
    imageBase64: tooLargeImage,
    width: 1200,
    height: 800,
  }))

  await expect(pending).rejects.toThrow('Screenshot payload too large')
})
```

**Step 2: Run tests to verify failure**

Run: `npm run test:server -- test/unit/server/agent-layout-store.test.ts test/server/ws-protocol.test.ts`
Expected: FAIL because `getSourceConnectionId` and `requestUiScreenshot` do not exist; message schema rejects `ui.screenshot.result`.

**Step 3: Write minimal implementation**

```ts
// shared/ws-protocol.ts
export const UiScreenshotResultSchema = z.object({
  type: z.literal('ui.screenshot.result'),
  requestId: z.string().min(1),
  ok: z.boolean(),
  mimeType: z.literal('image/png').optional(),
  imageBase64: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  changedFocus: z.boolean().optional(),
  restoredFocus: z.boolean().optional(),
  error: z.string().optional(),
})

export const ClientMessageSchema = z.discriminatedUnion('type', [
  // existing schemas...
  UiScreenshotResultSchema,
])
```

```ts
// server/ws-handler.ts (top-level schema copy used by ws handler)
import { UiScreenshotResultSchema } from '../shared/ws-protocol.js'

const ClientMessageSchema = z.discriminatedUnion('type', [
  // existing schemas...
  UiScreenshotResultSchema,
])
```

```ts
// server/agent-api/layout-store.ts
getSourceConnectionId() {
  return this.sourceConnectionId
}
```

```ts
// server/ws-handler.ts (shape)
type PendingScreenshot = {
  resolve: (result: any) => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
  connectionId?: string
}

const WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
const MAX_SCREENSHOT_BASE64_BYTES = 12 * 1024 * 1024
const DEFAULT_WS_MESSAGE_BYTES = 1 * 1024 * 1024

private screenshotRequests = new Map<string, PendingScreenshot>()

private findTargetUiSocket(preferredConnectionId?: string): LiveWebSocket | undefined {
  const authenticated = [...this.connections].filter((conn) => this.clientStates.get(conn)?.authenticated)
  if (!authenticated.length) return undefined
  if (preferredConnectionId) {
    const preferred = authenticated.find((conn) => conn.connectionId === preferredConnectionId)
    if (preferred) return preferred
  }
  return authenticated[0]
}

public requestUiScreenshot(opts: { scope: 'pane' | 'tab' | 'view'; tabId?: string; paneId?: string; timeoutMs?: number }) {
  const timeoutMs = opts.timeoutMs ?? 10000
  const preferredConnectionId = this.layoutStore?.getSourceConnectionId?.() || undefined
  const targetWs = this.findTargetUiSocket(preferredConnectionId)
  if (!targetWs) return Promise.reject(new Error('No UI client connected for screenshot'))

  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.screenshotRequests.delete(requestId)
      reject(new Error('Timed out waiting for UI screenshot response'))
    }, timeoutMs)

    this.screenshotRequests.set(requestId, {
      resolve,
      reject,
      timeout,
      connectionId: targetWs.connectionId,
    })

    this.send(targetWs, {
      type: 'ui.command',
      command: 'screenshot.capture',
      payload: { requestId, scope: opts.scope, tabId: opts.tabId, paneId: opts.paneId },
    })
  })
}

// constructor
this.wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: WS_MAX_PAYLOAD_BYTES,
})

// inside onMessage switch:
if (rawBytes > DEFAULT_WS_MESSAGE_BYTES && m.type !== 'ui.screenshot.result') {
  ws.close(1009, 'Message too large')
  return
}

case 'ui.screenshot.result': {
  const pending = this.screenshotRequests.get(m.requestId)
  if (!pending) return
  if (pending.connectionId && pending.connectionId !== ws.connectionId) return
  if (typeof m.imageBase64 === 'string' && m.imageBase64.length > MAX_SCREENSHOT_BASE64_BYTES) {
    clearTimeout(pending.timeout)
    this.screenshotRequests.delete(m.requestId)
    pending.reject(new Error('Screenshot payload too large'))
    return
  }
  clearTimeout(pending.timeout)
  this.screenshotRequests.delete(m.requestId)
  pending.resolve(m)
  return
}
```

**Step 4: Run tests to verify pass**

Run: `npm run test:server -- test/unit/server/agent-layout-store.test.ts test/server/ws-protocol.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts server/agent-api/layout-store.ts test/server/ws-protocol.test.ts test/unit/server/agent-layout-store.test.ts
git commit -m "feat(ws): add screenshot request/response flow between server and UI client"
```

---

### Task 3: Add Screenshot API Endpoint (TDD)

**Files:**
- Modify: `server/agent-api/router.ts`
- Test: `test/server/agent-screenshot-api.test.ts`

**Step 1: Write the failing test**

```ts
import { it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createAgentApiRouter } from '../../server/agent-api/router'

it('writes screenshot to temp dir by default and returns metadata JSON', async () => {
  const app = express()
  app.use(express.json())
  const wsHandler = {
    requestUiScreenshot: vi.fn().mockResolvedValue({
      ok: true,
      mimeType: 'image/png',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2M7nQAAAAASUVORK5CYII=',
      width: 1,
      height: 1,
      changedFocus: false,
      restoredFocus: true,
    }),
  }

  app.use('/api', createAgentApiRouter({ layoutStore: {} as any, registry: {} as any, wsHandler: wsHandler as any }))

  const res = await request(app)
    .post('/api/screenshots')
    .send({ scope: 'view', name: 'api-view-smoke' })

  expect(res.body.status).toBe('ok')
  expect(res.body.data.path).toBe(path.join(os.tmpdir(), 'api-view-smoke.png'))
  await expect(fs.stat(res.body.data.path)).resolves.toBeTruthy()
})
```

Also add failing cases for:
- existing file + no `overwrite` => status 409 error
- missing `name` => status 400
- `scope: "pane"` without `paneId` => status 400

**Step 2: Run test to verify failure**

Run: `npm run test:server -- test/server/agent-screenshot-api.test.ts`
Expected: FAIL because `/api/screenshots` does not exist.

**Step 3: Write minimal implementation**

```ts
// server/agent-api/router.ts (new route sketch)
import fs from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { resolveScreenshotOutputPath } from './screenshot-path.js'

async function writeFileAtomic(filePath: string, content: Buffer) {
  const tempPath = `${filePath}.tmp-${randomUUID()}`
  await fs.writeFile(tempPath, content)
  await fs.rename(tempPath, filePath)
}

router.post('/screenshots', async (req, res) => {
  const scope = req.body?.scope
  const nameRaw = req.body?.name
  const pathInput = req.body?.path
  const overwrite = truthy(req.body?.overwrite)
  const paneId = req.body?.paneId
  const tabId = req.body?.tabId

  if (scope !== 'pane' && scope !== 'tab' && scope !== 'view') {
    return res.status(400).json(fail('scope must be pane, tab, or view'))
  }
  if (scope === 'pane' && !paneId) return res.status(400).json(fail('paneId required for pane scope'))
  if (scope === 'tab' && !tabId) return res.status(400).json(fail('tabId required for tab scope'))
  if (!wsHandler?.requestUiScreenshot) return res.status(503).json(fail('ui screenshot channel unavailable'))

  let outputPath: string
  try {
    // Single authoritative validation lives in resolveScreenshotOutputPath().
    outputPath = await resolveScreenshotOutputPath({ name: String(nameRaw || ''), pathInput })
  } catch (err: any) {
    return res.status(400).json(fail(err.message))
  }

  try {
    if (!overwrite) {
      try {
        await fs.access(outputPath)
        return res.status(409).json(fail('output file already exists (use --overwrite)'))
      } catch {}
    }

    const ui = await wsHandler.requestUiScreenshot({ scope, tabId, paneId })
    if (!ui?.ok || !ui?.imageBase64) return res.status(422).json(fail(ui?.error || 'ui screenshot failed'))

    await writeFileAtomic(outputPath, Buffer.from(ui.imageBase64, 'base64'))

    return res.json(ok({
      path: outputPath,
      scope,
      tabId,
      paneId,
      width: ui.width,
      height: ui.height,
      changedFocus: !!ui.changedFocus,
      restoredFocus: !!ui.restoredFocus,
      timestamp: Date.now(),
    }, 'screenshot saved'))
  } catch (err: any) {
    return res.status(500).json(fail(err.message || 'failed to capture screenshot'))
  }
})
```

**Step 4: Run test to verify pass**

Run: `npm run test:server -- test/server/agent-screenshot-api.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/agent-api/router.ts test/server/agent-screenshot-api.test.ts
git commit -m "feat(agent-api): add /api/screenshots endpoint with path/name validation and overwrite guard"
```

---

### Task 4: Add Client Screenshot Capture Helper (TDD)

**Files:**
- Create: `src/lib/ui-screenshot.ts`
- Test: `test/unit/client/ui-screenshot.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Add dependency**

Run: `npm install html2canvas`
Expected: `package.json` + `package-lock.json` updated.

Reason: with WebGL suspended in Task 5, terminals render via 2D canvas and `html2canvas` can capture mixed DOM + canvas content reliably.

**Step 2: Write failing unit tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { handleScreenshotCaptureCommand, overlayTerminalCanvases } from '../../../src/lib/ui-screenshot'

it('captures visible pane without focus changes', async () => {
  document.body.innerHTML = '<div data-pane-id="pane-1" data-screenshot-pane="true"></div>'
  const dispatch = vi.fn()
  const send = vi.fn()
  const captureElement = vi.fn().mockResolvedValue({ imageBase64: 'abc', width: 100, height: 80 })

  await handleScreenshotCaptureCommand({
    payload: { requestId: 'r1', scope: 'pane', paneId: 'pane-1' },
    dispatch,
    getState: () => ({ tabs: { activeTabId: 'tab-1' }, panes: { activePane: { 'tab-1': 'pane-1' }, layouts: {}, zoomedPane: {} } }) as any,
    send,
    captureElement,
  })

  expect(dispatch).not.toHaveBeenCalled()
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ ok: true, changedFocus: false, restoredFocus: false }))
})

it('switches focus only when needed, restores, and reports accurate metadata', async () => {
  document.body.innerHTML = `
    <div data-screenshot-pane data-pane-id="pane-z" style="display:none"></div>
  `
  const state = {
    tabs: { activeTabId: 'tab-1' },
    panes: { activePane: { 'tab-1': 'pane-a', 'tab-2': 'pane-z' }, zoomedPane: {} },
  } as any
  const dispatch = vi.fn((action: any) => {
    if (action.type.endsWith('/setActiveTab') && action.payload === 'tab-2') {
      state.tabs.activeTabId = 'tab-2'
      ;(document.querySelector('[data-pane-id=\"pane-z\"]') as HTMLElement).style.display = 'block'
    }
    if (action.type.endsWith('/setActiveTab') && action.payload === 'tab-1') {
      state.tabs.activeTabId = 'tab-1'
    }
  })
  const send = vi.fn()

  await handleScreenshotCaptureCommand({
    payload: { requestId: 'r2', scope: 'pane', paneId: 'pane-z', tabId: 'tab-2' },
    dispatch,
    getState: () => state,
    send,
    captureElement: vi.fn().mockResolvedValue({ imageBase64: 'abc', width: 100, height: 80 }),
  })

  expect(dispatch.mock.calls.some(([a]) => a.type.endsWith('/setActiveTab') && a.payload === 'tab-2')).toBe(true)
  expect(dispatch.mock.calls.some(([a]) => a.type.endsWith('/setActiveTab') && a.payload === 'tab-1')).toBe(true)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ changedFocus: true, restoredFocus: true }))
})

it('runs capture environment prepare/cleanup around screenshot attempt', async () => {
  const prepare = vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined))
  document.body.innerHTML = '<div data-screenshot-view style="width:100px;height:50px"></div>'
  const send = vi.fn()
  await handleScreenshotCaptureCommand({
    payload: { requestId: 'r3', scope: 'view' },
    dispatch: vi.fn(),
    getState: () => ({ tabs: {}, panes: {} }) as any,
    send,
    captureElement: vi.fn().mockResolvedValue({ imageBase64: 'abc', width: 100, height: 50 }),
    prepareForCapture: prepare,
  })
  const cleanup = await prepare.mock.results[0].value
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(cleanup).toHaveBeenCalledTimes(1)
})

it('overlays live terminal canvases onto captured image for tab/view scope', async () => {
  const root = document.createElement('div')
  const wrapper = document.createElement('div')
  wrapper.className = 'xterm'
  const terminalCanvas = document.createElement('canvas')
  wrapper.appendChild(terminalCanvas)
  root.appendChild(wrapper)

  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200))
  vi.spyOn(terminalCanvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 120, 60))

  const baseCanvas = document.createElement('canvas')
  const drawImage = vi.fn()
  vi.spyOn(baseCanvas, 'getContext').mockReturnValue({ drawImage } as any)

  overlayTerminalCanvases(root, baseCanvas, 1)
  expect(drawImage).toHaveBeenCalledTimes(1)
  expect(drawImage.mock.calls[0][0]).toBe(terminalCanvas)
})
```

**Step 3: Run tests to verify failure**

Run: `npm run test:client -- test/unit/client/ui-screenshot.test.ts`
Expected: FAIL because helper does not exist.

**Step 4: Write minimal implementation**

```ts
// src/lib/ui-screenshot.ts
import html2canvas from 'html2canvas'
import { setActiveTab } from '@/store/tabsSlice'
import { setActivePane, toggleZoom } from '@/store/panesSlice'

type CaptureResult = { imageBase64: string; width: number; height: number }
type FocusSnapshot = {
  activeTabId?: string
  activePaneByTab: Record<string, string | undefined>
  zoomedPaneByTab: Record<string, string | undefined>
}
type PreparedTarget = {
  element: HTMLElement
  changedFocus: boolean
  snapshot: FocusSnapshot
}
type ScreenshotPrep = () => Promise<() => Promise<void>>

const pngPrefix = /^data:image\/png;base64,/
const waitForDomSettled = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await Promise.resolve()
}

async function waitForVisibleTarget(selector: string, timeoutMs = 1200): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const el = document.querySelector(selector) as HTMLElement | null
    if (el && isVisible(el)) return el
    await waitForDomSettled()
  }
  return null
}

function selectorForPayload(payload: { scope: 'pane' | 'tab' | 'view'; paneId?: string; tabId?: string }) {
  if (payload.scope === 'pane') return `[data-screenshot-pane][data-pane-id="${payload.paneId}"]`
  if (payload.scope === 'tab') return `[data-screenshot-tab][data-tab-id="${payload.tabId}"]`
  return '[data-screenshot-view]'
}

function isVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none' && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0
}

function snapshotFocus(state: any): FocusSnapshot {
  return {
    activeTabId: state.tabs?.activeTabId || undefined,
    activePaneByTab: { ...(state.panes?.activePane || {}) },
    zoomedPaneByTab: { ...(state.panes?.zoomedPane || {}) },
  }
}

async function restoreFocus(dispatch: (action: any) => void, getState: () => any, snapshot: FocusSnapshot): Promise<boolean> {
  let restored = false
  const now = getState()

  if (snapshot.activeTabId && now.tabs?.activeTabId !== snapshot.activeTabId) {
    dispatch(setActiveTab(snapshot.activeTabId))
    restored = true
  }

  for (const [tabId, paneId] of Object.entries(snapshot.activePaneByTab)) {
    if (!paneId) continue
    const activePane = getState().panes?.activePane?.[tabId]
    if (activePane !== paneId) {
      dispatch(setActivePane({ tabId, paneId }))
      restored = true
    }
  }

  const currentZoomByTab = getState().panes?.zoomedPane || {}
  for (const [tabId, paneId] of Object.entries(snapshot.zoomedPaneByTab)) {
    if (!paneId) continue
    if (currentZoomByTab[tabId] !== paneId) {
      dispatch(toggleZoom({ tabId, paneId }))
      restored = true
    }
  }

  if (restored) await waitForDomSettled()
  return restored
}

export function overlayTerminalCanvases(element: HTMLElement, canvas: HTMLCanvasElement, scale: number) {
  const rootRect = element.getBoundingClientRect()
  const overlays = Array.from(element.querySelectorAll<HTMLCanvasElement>('.xterm canvas')).map((terminalCanvas) => {
    const rect = terminalCanvas.getBoundingClientRect()
    return {
      terminalCanvas,
      x: rect.left - rootRect.left,
      y: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height,
    }
  })
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  for (const overlay of overlays) {
    ctx.drawImage(
      overlay.terminalCanvas,
      overlay.x * scale,
      overlay.y * scale,
      overlay.width * scale,
      overlay.height * scale,
    )
  }
}

async function capturePngBase64(element: HTMLElement): Promise<CaptureResult> {
  const scale = window.devicePixelRatio || 1
  const canvas = await html2canvas(element, {
    backgroundColor: null,
    useCORS: true,
    logging: false,
    scale,
  })
  overlayTerminalCanvases(element, canvas, scale)
  const dataUrl = canvas.toDataURL('image/png')
  return {
    imageBase64: dataUrl.replace(pngPrefix, ''),
    width: canvas.width,
    height: canvas.height,
  }
}

async function ensureTargetElementVisible(ctx: {
  payload: { scope: 'pane' | 'tab' | 'view'; paneId?: string; tabId?: string }
  dispatch: (action: any) => void
  getState: () => any
}): Promise<PreparedTarget> {
  const snapshot = snapshotFocus(ctx.getState())
  const selector = selectorForPayload(ctx.payload)
  const immediate = document.querySelector(selector) as HTMLElement | null
  if (immediate && isVisible(immediate)) return { element: immediate, changedFocus: false, snapshot }

  let changedFocus = false
  const activeTabId = ctx.getState().tabs?.activeTabId as string | undefined
  const zoomedPaneId = activeTabId ? ctx.getState().panes?.zoomedPane?.[activeTabId] : undefined
  if (zoomedPaneId && activeTabId) {
    ctx.dispatch(toggleZoom({ tabId: activeTabId, paneId: zoomedPaneId }))
    changedFocus = true
  }

  if (ctx.payload.tabId && ctx.payload.tabId !== activeTabId) {
    ctx.dispatch(setActiveTab(ctx.payload.tabId))
    changedFocus = true
  }
  if (ctx.payload.scope === 'pane' && ctx.payload.paneId) {
    const tabId = ctx.payload.tabId || (ctx.getState().tabs?.activeTabId as string | undefined)
    if (tabId && ctx.getState().panes?.activePane?.[tabId] !== ctx.payload.paneId) {
      ctx.dispatch(setActivePane({ tabId, paneId: ctx.payload.paneId }))
      changedFocus = true
    }
  }

  const target = changedFocus
    ? await waitForVisibleTarget(selector)
    : (document.querySelector(selector) as HTMLElement | null)
  if (!target || !isVisible(target)) throw new Error('target not available for screenshot')
  return { element: target, changedFocus, snapshot }
}

export async function handleScreenshotCaptureCommand(ctx: {
  payload: { requestId: string; scope: 'pane' | 'tab' | 'view'; paneId?: string; tabId?: string }
  dispatch: (action: any) => void
  getState: () => any
  send: (msg: unknown) => void
  captureElement?: (element: HTMLElement) => Promise<CaptureResult>
  prepareForCapture?: ScreenshotPrep
}) {
  const capture = ctx.captureElement ?? capturePngBase64
  const prepare = ctx.prepareForCapture ?? (async () => async () => {})

  let changedFocus = false
  let restoredFocus = false
  let snapshot: FocusSnapshot | null = null
  let response:
    | { ok: true; mimeType: 'image/png'; imageBase64: string; width: number; height: number }
    | { ok: false; error: string } = { ok: false, error: 'capture failed' }

  const cleanupCapture = await prepare()
  try {
    const prepared = await ensureTargetElementVisible(ctx)
    changedFocus = prepared.changedFocus
    snapshot = prepared.snapshot
    const image = await capture(prepared.element)
    response = { ok: true, mimeType: 'image/png', imageBase64: image.imageBase64, width: image.width, height: image.height }
  } catch (err: any) {
    response = { ok: false, error: err?.message || 'capture failed' }
  } finally {
    try {
      await cleanupCapture()
    } catch (err: any) {
      if (response.ok) {
        response = { ok: false, error: err?.message || 'capture cleanup failed' }
      }
    }
    if (changedFocus && snapshot) {
      restoredFocus = await restoreFocus(ctx.dispatch, ctx.getState, snapshot)
    }
  }

  ctx.send({
    type: 'ui.screenshot.result',
    requestId: ctx.payload.requestId,
    changedFocus,
    restoredFocus,
    ...response,
  })
}
```

Implementation details required in this task:
- Prefer no focus changes: first attempt direct selector capture.
- If target is not visible/mounted, switch only what is necessary (`setActiveTab`, `setActivePane`, unzoom via `toggleZoom`), capture, then restore.
- Restore happens before send so metadata is accurate.
- Wait/poll for visible target after focus/layout changes (bounded timeout) to avoid React timing races.
- Capture runs after Task 5's renderer prepare hook, so terminal panes are in canvas mode before `html2canvas`.
- For tab/view captures, explicitly draw live `.xterm canvas` overlays onto the final image canvas.
- Use wrapper selectors not pane-kind internals (`[data-screenshot-pane][data-pane-id=...]`, `[data-screenshot-tab][data-tab-id=...]`, `[data-screenshot-view]`).

**Step 5: Run tests to verify pass**

Run: `npm run test:client -- test/unit/client/ui-screenshot.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/ui-screenshot.ts test/unit/client/ui-screenshot.test.ts
git commit -m "feat(client): add screenshot capture helper with focus-safe behavior and lifecycle hooks"
```

---

### Task 5: Wire Screenshot Command Handling, Selectors, and WebGL Capture Lifecycle (TDD)

**Files:**
- Create: `src/lib/screenshot-capture-env.ts`
- Modify: `src/App.tsx`
- Modify: `src/lib/ui-commands.ts`
- Modify: `src/components/TabContent.tsx`
- Modify: `src/components/panes/Pane.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal/terminal-runtime.ts`
- Test: `test/unit/client/ui-commands.test.ts`
- Test: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Test: `test/unit/client/components/TerminalView.screenshot-capture.test.tsx`
- Test: `test/unit/client/terminal-runtime.test.ts`

**Step 1: Write failing tests**

```ts
// test/unit/client/ui-commands.test.ts
import { handleUiCommand } from '../../../src/lib/ui-commands'
import * as screenshotModule from '../../../src/lib/ui-screenshot'

it('delegates screenshot.capture through handleUiCommand runtime context', async () => {
  const dispatch = vi.fn()
  const runtime = {
    getState: vi.fn(() => ({ tabs: {}, panes: {} })),
    send: vi.fn(),
    prepareForCapture: vi.fn(async () => async () => {}),
  }
  const screenshotSpy = vi
    .spyOn(screenshotModule, 'handleScreenshotCaptureCommand')
    .mockResolvedValue(undefined as never)

  await handleUiCommand(
    { type: 'ui.command', command: 'screenshot.capture', payload: { requestId: 'r1', scope: 'view' } },
    dispatch,
    runtime,
  )

  expect(screenshotSpy).toHaveBeenCalledWith(expect.objectContaining({
    dispatch,
    getState: runtime.getState,
    send: runtime.send,
  }))
})
```

```ts
// test/unit/client/components/App.ws-bootstrap.test.tsx
import { screenshotCaptureEvents } from '../../../src/lib/screenshot-capture-env'

it('responds to screenshot.capture by preparing capture env and sending ui.screenshot.result', async () => {
  const wsSend = vi.fn()
  const onMessage = setupAppWithMockWs({ send: wsSend }) // existing App ws test harness helper
  const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')

  await onMessage({
    type: 'ui.command',
    command: 'screenshot.capture',
    payload: { requestId: 'r1', scope: 'view' },
  })

  expect(dispatchEventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: screenshotCaptureEvents.PREPARE_EVENT }))
  expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'ui.screenshot.result', requestId: 'r1' }))
})
```

```ts
// test/unit/client/components/TerminalView.screenshot-capture.test.tsx
it('suspends webgl only for matching pane/tab scope and resumes on cleanup event', async () => {
  const suspend = vi.fn(() => true)
  const resume = vi.fn()
  renderTerminalViewWithRuntimeMock({ tabId: 'tab-a', paneId: 'pane-a', suspend, resume })

  window.dispatchEvent(new CustomEvent(screenshotCaptureEvents.PREPARE_EVENT, { detail: { scope: 'pane', paneId: 'pane-b' } }))
  expect(suspend).not.toHaveBeenCalled()

  window.dispatchEvent(new CustomEvent(screenshotCaptureEvents.PREPARE_EVENT, { detail: { scope: 'pane', paneId: 'pane-a' } }))
  expect(suspend).toHaveBeenCalledTimes(1)

  window.dispatchEvent(new CustomEvent(screenshotCaptureEvents.CLEANUP_EVENT, { detail: { scope: 'pane', paneId: 'pane-a' } }))
  expect(resume).toHaveBeenCalledTimes(1)
})
```

```ts
// test/unit/client/terminal-runtime.test.ts
import { createTerminalRuntime } from '../../../src/components/terminal/terminal-runtime'

it('re-attaches webgl addon after suspend/resume cycle when webgl is enabled', async () => {
  const loadAddon = vi.fn()
  const terminal = { loadAddon } as any
  const runtime = createTerminalRuntime({ terminal, enableWebgl: true })
  runtime.attachAddons()
  await flushPromises()

  expect(runtime.suspendWebglForScreenshot()).toBe(true)
  runtime.resumeWebglAfterScreenshot()
  await flushPromises()

  expect(loadAddon.mock.calls.length).toBeGreaterThan(1)
})
```

**Step 2: Run tests to verify failure**

Run: `npm run test:client -- test/unit/client/ui-commands.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/TerminalView.screenshot-capture.test.tsx test/unit/client/terminal-runtime.test.ts`
Expected: FAIL.

**Step 3: Implement wiring, selectors, and renderer lifecycle**

```ts
// src/lib/screenshot-capture-env.ts
const PREPARE_EVENT = 'freshell:screenshot:prepare'
const CLEANUP_EVENT = 'freshell:screenshot:cleanup'
type ScreenshotScope = { scope: 'pane' | 'tab' | 'view'; paneId?: string; tabId?: string }

const waitForDomSettled = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

export async function prepareScreenshotCaptureEnvironment(target: ScreenshotScope): Promise<() => Promise<void>> {
  window.dispatchEvent(new CustomEvent(PREPARE_EVENT, { detail: target }))
  await waitForDomSettled()
  return async () => {
    window.dispatchEvent(new CustomEvent(CLEANUP_EVENT, { detail: target }))
    await waitForDomSettled()
  }
}

export const screenshotCaptureEvents = { PREPARE_EVENT, CLEANUP_EVENT }
```

```tsx
// src/App.tsx (inside ws.onMessage)
if (msg.type === 'ui.command') {
  void handleUiCommand(msg, dispatch, {
    getState: store.getState,
    send: (out) => ws.send(out),
    prepareForCapture: (payload) => prepareScreenshotCaptureEnvironment(payload),
  })
  return
}
```

```ts
// src/lib/ui-commands.ts
type UiRuntimeContext = {
  getState: () => any
  send: (message: unknown) => void
  prepareForCapture: (payload: { scope: 'pane' | 'tab' | 'view'; paneId?: string; tabId?: string }) => Promise<() => Promise<void>>
}

export async function handleUiCommand(msg: any, dispatch: (action: any) => void, runtime?: UiRuntimeContext) {
  if (msg?.type !== 'ui.command') return
  if (msg.command === 'screenshot.capture') {
    if (!runtime) return
    await handleScreenshotCaptureCommand({
      payload: msg.payload,
      dispatch,
      getState: runtime.getState,
      send: runtime.send,
      prepareForCapture: () => runtime.prepareForCapture(msg.payload),
    })
    return
  }
  // existing reducer-only switch branches remain unchanged
}
```

```ts
// src/components/terminal/terminal-runtime.ts
export type TerminalRuntime = {
  // existing ...
  suspendWebglForScreenshot: () => boolean
  resumeWebglAfterScreenshot: () => void
}

// Inside createTerminalRuntime(): track per-terminal screenshot suspension.
let suspendedForScreenshot = false

const attachWebglAddon = () => {
  if (!enableWebgl || disposed || webglAddon) return
  void loadWebglAddonModule()
    .then(({ WebglAddon }) => {
      if (disposed || webglAddon) return
      const addon = new WebglAddon()
      terminal.loadAddon(addon)
      if (disposed) {
        addon.dispose()
        return
      }
      webglAddon = addon
      isWebglActive = true
      webglLossDisposable = webglAddon.onContextLoss(() => disableWebgl())
    })
    .catch(() => disableWebgl())
}

const suspendWebglForScreenshot = () => {
  if (!isWebglActive) return false
  suspendedForScreenshot = true
  disableWebgl()
  return true
}

const resumeWebglAfterScreenshot = () => {
  if (!suspendedForScreenshot || disposed) return
  suspendedForScreenshot = false
  attachWebglAddon()
}

// Reuse attachWebglAddon in attachAddons() for initial startup path.
```

```tsx
// src/components/TerminalView.tsx
useEffect(() => {
  const matchesScope = (detail?: { scope: 'pane' | 'tab' | 'view'; paneId?: string; tabId?: string }) => {
    if (!detail || detail.scope === 'view') return true
    if (detail.scope === 'tab') return detail.tabId === tabId
    return detail.paneId === paneId
  }

  const onPrepare = (event: Event) => {
    const detail = (event as CustomEvent).detail
    if (!matchesScope(detail)) return
    runtimeRef.current?.suspendWebglForScreenshot?.()
  }
  const onCleanup = (event: Event) => {
    const detail = (event as CustomEvent).detail
    if (!matchesScope(detail)) return
    runtimeRef.current?.resumeWebglAfterScreenshot?.()
  }
  window.addEventListener(screenshotCaptureEvents.PREPARE_EVENT, onPrepare)
  window.addEventListener(screenshotCaptureEvents.CLEANUP_EVENT, onCleanup)
  return () => {
    window.removeEventListener(screenshotCaptureEvents.PREPARE_EVENT, onPrepare)
    window.removeEventListener(screenshotCaptureEvents.CLEANUP_EVENT, onCleanup)
  }
}, [tabId, paneId])
```

```tsx
// selectors
// src/App.tsx root pane column container
<div data-screenshot-view data-testid="app-pane-column" className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">

// src/components/TabContent.tsx
<div data-screenshot-tab data-tab-id={tabId} data-tab-visible={hidden ? 'false' : 'true'}>

// src/components/panes/Pane.tsx
<div data-screenshot-pane data-pane-id={paneId} data-tab-id={tabId}>
```

**Step 4: Run tests to verify pass**

Run: `npm run test:client -- test/unit/client/ui-commands.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/TerminalView.screenshot-capture.test.tsx test/unit/client/terminal-runtime.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/screenshot-capture-env.ts src/App.tsx src/lib/ui-commands.ts src/components/TabContent.tsx src/components/panes/Pane.tsx src/components/TerminalView.tsx src/components/terminal/terminal-runtime.ts test/unit/client/ui-commands.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/TerminalView.screenshot-capture.test.tsx test/unit/client/terminal-runtime.test.ts
git commit -m "feat(client): wire screenshot command and suspend webgl renderer during captures"
```

---

### Task 6: Add CLI Screenshot Commands and Aliases (TDD)

**Files:**
- Modify: `server/cli/index.ts`
- Test: `test/e2e/agent-cli-flow.test.ts`
- Test: `test/unit/cli/args.test.ts`

**Step 1: Write failing tests**

```ts
// test/unit/cli/args.test.ts
it('parses screenshot with --target and --path forms', () => {
  const parsed = parseArgs(['screenshot', '--scope', 'pane', '--name', 'shot1', '--target=alpha.0', '--path=/tmp'])
  expect(parsed.command).toBe('screenshot')
  expect(parsed.flags.scope).toBe('pane')
  expect(parsed.flags.name).toBe('shot1')
  expect(parsed.flags.target).toBe('alpha.0')
  expect(parsed.flags.path).toBe('/tmp')
})
```

```ts
// test/e2e/agent-cli-flow.test.ts
it('runs screenshot-view and prints json metadata', async () => {
  // test server: expose /api/screenshots mock response
  // spawn CLI: freshell screenshot-view --name test-shot --json
  // assert stdout JSON contains path/scope/timestamp
})
```

**Step 2: Run tests to verify failure**

Run: `npm run test:server -- test/e2e/agent-cli-flow.test.ts test/unit/cli/args.test.ts`
Expected: FAIL.

**Step 3: Implement CLI commands**

```ts
// server/cli/index.ts aliases
const aliases = {
  // existing...
  'screenshot-pane': 'screenshot',
  'screenshot-tab': 'screenshot',
  'screenshot-view': 'screenshot',
}
```

```ts
// server/cli/index.ts command branch
case 'screenshot': {
  const invokedAs = parsed.command
  const defaultScope = invokedAs === 'screenshot-pane' ? 'pane'
    : invokedAs === 'screenshot-tab' ? 'tab'
      : invokedAs === 'screenshot-view' ? 'view'
        : undefined

  const scope = (getFlag(flags, 'scope') as string | undefined) || defaultScope
  const name = (getFlag(flags, 'n', 'name') as string | undefined)
  const pathInput = getFlag(flags, 'path') as string | undefined
  const overwrite = isTruthy(getFlag(flags, 'overwrite'))

  if (!scope || !['pane', 'tab', 'view'].includes(scope)) {
    writeError('scope must be pane, tab, or view')
    process.exitCode = 1
    return
  }
  if (!name) {
    writeError('name required')
    process.exitCode = 1
    return
  }

  let paneId: string | undefined
  let tabId: string | undefined
  if (scope === 'pane') {
    const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
    const resolved = await resolvePaneTarget(client, target)
    if (!resolved.pane?.id) {
      writeError(resolved.message || 'pane not found')
      process.exitCode = 1
      return
    }
    paneId = resolved.pane.id
    tabId = resolved.tab?.id
  } else if (scope === 'tab') {
    const target = (getFlag(flags, 't', 'target', 'tab') as string | undefined) || args[0]
    const resolved = await resolveTabTarget(client, target)
    if (!resolved.tab?.id) {
      writeError(resolved.message || 'tab not found')
      process.exitCode = 1
      return
    }
    tabId = resolved.tab.id
  }

  const res = await client.post('/api/screenshots', { scope, name, path: pathInput, overwrite, tabId, paneId })
  writeJson(res)
  return
}
```

**Step 4: Run tests to verify pass**

Run: `npm run test:server -- test/e2e/agent-cli-flow.test.ts test/unit/cli/args.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/cli/index.ts test/e2e/agent-cli-flow.test.ts test/unit/cli/args.test.ts
git commit -m "feat(cli): add screenshot command plus screenshot-pane/tab/view aliases"
```

---

### Task 7: End-to-End Regression Coverage for Focus Preservation + Restore (TDD)

**Files:**
- Create: `test/integration/server/pane-picker-cli-screenshot.test.ts`
- Modify: `test/integration/server/pane-picker-cli.test.ts`

**Step 1: Write failing integration tests**

Add scenario:
1. Build mock UI connection that reports screenshot metadata with `changedFocus: true, restoredFocus: true` for hidden-target captures.
2. Call `/api/screenshots` for non-active tab pane.
3. Assert returned JSON preserves `changedFocus/restoredFocus` and path exists.

Also add scenario where no UI WS is connected:
- API returns 503 with clear error.

**Step 2: Run tests to verify failure**

Run: `npm run test:server -- test/integration/server/pane-picker-cli-screenshot.test.ts`
Expected: FAIL.

**Step 3: Implement minimal fixes**

- Ensure `requestUiScreenshot()` chooses authenticated connection deterministically.
- Ensure missing client returns explicit error.
- Ensure response JSON always includes `changedFocus/restoredFocus` booleans.

**Step 4: Run tests to verify pass**

Run: `npm run test:server -- test/integration/server/pane-picker-cli-screenshot.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/integration/server/pane-picker-cli-screenshot.test.ts test/integration/server/pane-picker-cli.test.ts server/ws-handler.ts server/agent-api/router.ts
git commit -m "test+fix(screenshot): add integration coverage for focus-preserving capture and no-client errors"
```

---

### Task 8: Update User-Facing Docs (Skill + Mock UI)

**Files:**
- Modify: `docs/index.html`
- Rewrite: `.claude/skills/freshell-automation-tmux-style/SKILL.md` (or the canonical skill path used in this repo/session)

**Step 1: Write the failing doc check (manual checklist)**

Checklist must fail before doc rewrite:
- Screenshot command family not documented.
- Name/path/overwrite semantics not documented.
- Focus-preserve + restore behavior for screenshot capture not documented.
- `docs/index.html` does not mention screenshot command workflow.

**Step 2: Update docs in full**

Required sections:
- `docs/index.html`:
  - Add screenshot commands to the mock command reference.
  - Add one concise example flow (capture pane/tab/view with returned JSON metadata).
- Command reference includes:
  - `screenshot --scope pane|tab|view --name <name> [--path <dir|file>] [--target <...>] [--overwrite]`
  - `screenshot-pane`, `screenshot-tab`, `screenshot-view`
- Targeting rules for pane/tab/view.
- Path rules:
  - default OS temp dir
  - directory vs full file path behavior
  - existing-file failure unless `--overwrite`
- Focus semantics:
  - no focus change when possible
  - temporary focus change only when required; always restore
- Output contract JSON fields (`path`, `scope`, `tabId`, `paneId`, `timestamp`, `changedFocus`, `restoredFocus`, `width`, `height`).

**Step 3: Commit**

```bash
git add docs/index.html .claude/skills/freshell-automation-tmux-style/SKILL.md
git commit -m "docs: update screenshot command guidance in mock UI and tmux-style skill"
```

---

### Task 9: Full Verification + Bug Bash Log Updates

**Files:**
- Modify: `bug-bash/progress.txt`
- Modify: `bug-bash/issues.txt` (mark TODO #8 complete + add follow-on issues if discovered)

Note: `bug-bash/*.txt` are intentionally gitignored in this repo; keep them updated locally but do not stage them.

**Step 1: Run focused tests**

Run:
- `npm run test:client -- test/unit/client/ui-screenshot.test.ts test/unit/client/ui-commands.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/TerminalView.screenshot-capture.test.tsx test/unit/client/terminal-runtime.test.ts`
- `npm run test:server -- test/server/agent-screenshot-api.test.ts test/server/ws-protocol.test.ts test/e2e/agent-cli-flow.test.ts`

Expected: PASS.

**Step 2: Run full quality gate**

Run: `npm run check`
Expected: PASS (typecheck + all tests).

**Step 3: Manual smoke command sequence**

Run in freshell CLI session:

```bash
freshell screenshot-view --name view-smoke --json
freshell screenshot-tab --target "Bug Bash Files" --name tab-smoke --json
freshell screenshot-pane --target "pane-index:0" --name pane-smoke --json
```

Expected:
- each returns JSON with absolute file path
- files exist on disk
- no persistent focus drift after completion

**Step 4: Update bug-bash trackers**

- `bug-bash/progress.txt`: append implementation milestones + verification results.
- `bug-bash/issues.txt`: move TODO #8 to done section and log any regressions found during smoke.

**Step 5: Final status check**

Run: `git status --short`
Expected:
- no unexpected modified tracked files
- `bug-bash/*.txt` updates are present locally (ignored by git) as operational log artifacts
