import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import html2canvas from 'html2canvas'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { captureUiScreenshot } from '../../../src/lib/ui-screenshot'

vi.mock('html2canvas', () => ({
  default: vi.fn(),
}))

vi.mock('../../../src/lib/screenshot-capture-env', () => ({
  suspendTerminalRenderersForScreenshot: vi.fn(async () => async () => {}),
}))

const CONTEXT_MENU_PROOF_BASENAME = 'freshell-terminal-context-menu-proof.png'
const PNG_SIGNATURE_BYTES = [137, 80, 78, 71, 13, 10, 26, 10] as const
let contextMenuProofPath = ''
let contextMenuProofDir = ''

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      const carry = crc & 1
      crc >>>= 1
      if (carry) crc ^= 0xedb88320
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32BE(data.length, 0)

  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer])
}

function createSolidPngBase64(rgba: readonly [number, number, number, number]): string {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = deflateSync(Buffer.from([0, ...rgba]))
  const signature = Buffer.from(PNG_SIGNATURE_BYTES)
  const png = Buffer.concat([
    signature,
    createPngChunk('IHDR', ihdr),
    createPngChunk('IDAT', idat),
    createPngChunk('IEND', Buffer.alloc(0)),
  ])

  return png.toString('base64')
}

function setRect(node: Element, width: number, height: number) {
  Object.defineProperty(node, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }),
  })
}

function createRuntime() {
  return {
    dispatch: vi.fn(),
    getState: () => ({
      tabs: { activeTabId: 'tab-1' },
      panes: { activePane: {}, layouts: {} },
    }) as any,
  }
}

function createMenuStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Shell',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
            terminalId: 'term-1',
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              status: 'running',
              terminalId: 'term-1',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      connection: {
        status: 'ready',
        platform: 'linux',
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: null,
      },
    },
  })
}

function createMenuRuntime(store: ReturnType<typeof createMenuStore>) {
  return {
    dispatch: store.dispatch,
    getState: store.getState,
  }
}

describe('captureUiScreenshot iframe handling', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    contextMenuProofDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-terminal-context-menu-proof-'))
    contextMenuProofPath = path.join(contextMenuProofDir, CONTEXT_MENU_PROOF_BASENAME)
  })

  afterEach(async () => {
    await fs.rm(contextMenuProofDir, { recursive: true, force: true })
    contextMenuProofDir = ''
    contextMenuProofPath = ''
  })

  it('captures same-origin iframe content into screenshot clone', async () => {
    document.body.innerHTML = `
      <div data-context="global">
        <iframe id="frame-a" src="/local-file?path=/tmp/canary.txt"></iframe>
      </div>
    `
    const target = document.querySelector('[data-context="global"]') as HTMLElement
    const iframe = document.getElementById('frame-a') as HTMLIFrameElement
    setRect(target, 800, 500)
    setRect(iframe, 500, 300)

    const iframeDoc = iframe.contentDocument
    expect(iframeDoc).toBeTruthy()
    iframeDoc?.open()
    iframeDoc?.write('<!doctype html><html><body><h1>CANARY</h1></body></html>')
    iframeDoc?.close()

    let clonedHtml = ''
    vi.mocked(html2canvas).mockImplementation(async (_el: any, opts: any = {}) => {
      if (typeof opts.onclone === 'function') {
        const cloneDoc = document.implementation.createHTMLDocument('clone')
        const cloneTarget = target.cloneNode(true) as HTMLElement
        cloneDoc.body.appendChild(cloneTarget)
        opts.onclone(cloneDoc)
        clonedHtml = cloneTarget.innerHTML
        return {
          width: 800,
          height: 500,
          toDataURL: () => 'data:image/png;base64,ROOTPNG',
        } as any
      }

      return {
        width: 500,
        height: 300,
        toDataURL: () => 'data:image/png;base64,IFRAMEPNG',
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'view' }, createRuntime() as any)

    expect(result.ok).toBe(true)
    expect(result.imageBase64).toBe('ROOTPNG')
    expect(vi.mocked(html2canvas)).toHaveBeenCalledTimes(2)
    expect(clonedHtml).toContain('data-screenshot-iframe-image="true"')
    expect(clonedHtml).not.toContain('<iframe')
    expect(iframe.hasAttribute('data-screenshot-iframe-marker')).toBe(false)
  })

  it('uses an explicit placeholder when iframe content cannot be captured', async () => {
    document.body.innerHTML = `
      <div data-context="global">
        <iframe id="frame-b" src="https://blocked.example.com/path?q=1"></iframe>
      </div>
    `
    const target = document.querySelector('[data-context="global"]') as HTMLElement
    const iframe = document.getElementById('frame-b') as HTMLIFrameElement
    setRect(target, 800, 500)
    setRect(iframe, 500, 300)

    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      get: () => null,
    })

    let clonedHtml = ''
    vi.mocked(html2canvas).mockImplementation(async (_el: any, opts: any = {}) => {
      if (typeof opts.onclone !== 'function') {
        throw new Error('did not expect iframe html2canvas call for inaccessible content')
      }
      const cloneDoc = document.implementation.createHTMLDocument('clone')
      const cloneTarget = target.cloneNode(true) as HTMLElement
      cloneDoc.body.appendChild(cloneTarget)
      opts.onclone(cloneDoc)
      clonedHtml = cloneTarget.innerHTML
      return {
        width: 800,
        height: 500,
        toDataURL: () => 'data:image/png;base64,ROOTPNG',
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'view' }, createRuntime() as any)

    expect(result.ok).toBe(true)
    expect(result.imageBase64).toBe('ROOTPNG')
    expect(clonedHtml).toContain('data-screenshot-iframe-placeholder="true"')
    expect(clonedHtml).toContain('blocked.example.com')
    expect(iframe.hasAttribute('data-screenshot-iframe-marker')).toBe(false)
  })

  it('writes a portable PNG artifact for the terminal context menu capture and verifies the captured DOM', async () => {
    const user = userEvent.setup()
    const store = createMenuStore()

    render(
      createElement(
        Provider,
        { store },
        createElement(
          ContextMenuProvider,
          {
            view: 'terminal',
            onViewChange: () => {},
            onToggleSidebar: () => {},
            sidebarCollapsed: false,
          },
          createElement(
            'div',
            {
              'data-context': ContextIds.Terminal,
              'data-tab-id': 'tab-1',
              'data-pane-id': 'pane-1',
            },
            'Terminal Content',
          ),
        ),
      ),
    )

    await user.pointer({ target: screen.getByText('Terminal Content'), keys: '[MouseRight]' })
    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })
    setRect(document.body, 1200, 800)

    let cloneDoc: Document | null = null
    let expectedImageBase64 = ''
    vi.mocked(html2canvas).mockImplementation(async (el: any, opts: any = {}) => {
      if (typeof opts.onclone === 'function') {
        const doc = document.implementation.createHTMLDocument('clone')
        const cloneRoot = (el as HTMLElement).cloneNode(true) as HTMLElement
        doc.body.appendChild(cloneRoot)
        opts.onclone(doc)
        cloneDoc = doc
      }

      const topMenuItems = Array.from(cloneDoc?.querySelectorAll('[role="menuitem"]') ?? []).slice(0, 3)
      const topLabels = topMenuItems.map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
      const allHaveIcons = topMenuItems.every((node) => node.querySelector('svg'))
      const matchesTerminalClipboardSection =
        topLabels.join('|') === 'Copy|Paste|Select all' && allHaveIcons

      expectedImageBase64 = createSolidPngBase64(
        matchesTerminalClipboardSection ? [12, 129, 54, 255] : [188, 28, 28, 255],
      )

      return {
        width: 1200,
        height: 800,
        toDataURL: () => `data:image/png;base64,${expectedImageBase64}`,
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'view' }, createMenuRuntime(store) as any)
    expect(result.ok).toBe(true)
    await fs.writeFile(contextMenuProofPath, Buffer.from(result.imageBase64!, 'base64'))

    expect(vi.mocked(html2canvas)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(html2canvas).mock.calls[0]?.[0]).toBe(document.body)
    expect(result.imageBase64).toBe(expectedImageBase64)

    const clonedMenuItems = Array.from(cloneDoc!.querySelectorAll('[role="menuitem"]')).map(
      (node) => node.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(clonedMenuItems.slice(0, 3)).toEqual(['Copy', 'Paste', 'Select all'])

    const topMenuItems = Array.from(cloneDoc!.querySelectorAll('[role="menuitem"]')).slice(0, 3)
    for (const node of topMenuItems) {
      expect(node.querySelector('svg')).not.toBeNull()
    }

    expect(path.basename(contextMenuProofPath)).toBe(CONTEXT_MENU_PROOF_BASENAME)

    const artifact = await fs.readFile(contextMenuProofPath)
    expect(artifact.length).toBeGreaterThan(8)
    expect(Array.from(artifact.subarray(0, 8))).toEqual([...PNG_SIGNATURE_BYTES])
  })
})
