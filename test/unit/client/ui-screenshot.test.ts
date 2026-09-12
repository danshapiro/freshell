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
import { suspendTerminalRenderersForScreenshot } from '../../../src/lib/screenshot-capture-env'

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

/** The inline `visibility: hidden` chain state (target → body) inside a
 *  html2canvas clone document, as the real cloner would produce: '' means no
 *  inline override at all, 'visible' an explicit reveal, 'hidden' untouched
 *  hidden styling. */
function cloneChainVisibilities(cloneRoot: HTMLElement): string[] {
  const doc = cloneRoot.ownerDocument
  const states: string[] = []
  for (let el = cloneRoot as HTMLElement | null; el && el !== doc.documentElement; el = el.parentElement) {
    states.push(el.style.visibility)
  }
  return states
}

/** Standard html2canvas mock: clones the live target into a fresh document,
 *  hands BOTH to onclone (the real cloner passes the cloned reference element
 *  as the second argument), and records the clone for assertions. */
function mockCloneRender(resultBase64 = 'ROOTPNG') {
  let clonedTarget: HTMLElement | null = null
  vi.mocked(html2canvas).mockImplementation(async (el: any, opts: any = {}) => {
    if (typeof opts.onclone !== 'function') {
      throw new Error('expected the main render to carry onclone')
    }
    const cloneDoc = document.implementation.createHTMLDocument('clone')
    clonedTarget = (el as HTMLElement).cloneNode(true) as HTMLElement
    cloneDoc.body.appendChild(clonedTarget)
    opts.onclone(cloneDoc, clonedTarget)
    return {
      width: 800,
      height: 500,
      toDataURL: () => `data:image/png;base64,${resultBase64}`,
    } as any
  })
  return {
    get clonedTarget() {
      return clonedTarget!
    },
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
        opts.onclone(cloneDoc, cloneTarget)
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

    const result = await captureUiScreenshot({ scope: 'view' })

    expect(result.ok).toBe(true)
    expect(result.imageBase64).toBe('ROOTPNG')
    expect(vi.mocked(html2canvas)).toHaveBeenCalledTimes(2)
    expect(clonedHtml).toContain('data-screenshot-iframe-image="true"')
    expect(clonedHtml).not.toContain('<iframe')
  })

  it('captures proxy-URL iframe as image content when document is accessible', async () => {
    document.body.innerHTML = `
      <div data-context="global">
        <iframe id="proxy-frame" src="/api/proxy/http/3000/"></iframe>
      </div>
    `
    const target = document.querySelector('[data-context="global"]') as HTMLElement
    const iframe = document.getElementById('proxy-frame') as HTMLIFrameElement
    setRect(target, 800, 500)
    setRect(iframe, 500, 300)

    const iframeDoc = iframe.contentDocument
    expect(iframeDoc).toBeTruthy()
    iframeDoc?.open()
    iframeDoc?.write('<!doctype html><html><body><p>Proxied localhost content</p></body></html>')
    iframeDoc?.close()

    let clonedHtml = ''
    vi.mocked(html2canvas).mockImplementation(async (_el: any, opts: any = {}) => {
      if (typeof opts.onclone === 'function') {
        const cloneDoc = document.implementation.createHTMLDocument('clone')
        const cloneTarget = target.cloneNode(true) as HTMLElement
        cloneDoc.body.appendChild(cloneTarget)
        opts.onclone(cloneDoc, cloneTarget)
        clonedHtml = cloneTarget.innerHTML
        return {
          width: 800,
          height: 500,
          toDataURL: () => 'data:image/png;base64,PROXYPNG',
        } as any
      }

      return {
        width: 500,
        height: 300,
        toDataURL: () => 'data:image/png;base64,IFRAMEPROXYPNG',
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'view' })

    expect(result.ok).toBe(true)
    expect(result.imageBase64).toBe('PROXYPNG')
    // The iframe should be replaced with an image, not a placeholder
    expect(clonedHtml).toContain('data-screenshot-iframe-image="true"')
    expect(clonedHtml).not.toContain('data-screenshot-iframe-placeholder')
    expect(clonedHtml).not.toContain('<iframe')
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
      opts.onclone(cloneDoc, cloneTarget)
      clonedHtml = cloneTarget.innerHTML
      return {
        width: 800,
        height: 500,
        toDataURL: () => 'data:image/png;base64,ROOTPNG',
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'view' })

    expect(result.ok).toBe(true)
    expect(result.imageBase64).toBe('ROOTPNG')
    expect(clonedHtml).toContain('data-screenshot-iframe-placeholder="true"')
    expect(clonedHtml).toContain('blocked.example.com')
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
        opts.onclone(doc, cloneRoot)
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

    const result = await captureUiScreenshot({ scope: 'view' })
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

describe('captureUiScreenshot off-DOM capture of background tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('renders a visibility-hidden background tab through the clone reveal without touching the live DOM', async () => {
    // .tab-hidden keeps background tabs fully LAID OUT (visibility, not
    // display) so xterm can measure — which is exactly what lets the capture
    // render them from a clone without activating the tab. The inline style
    // stands in for the class rule (same computed visibility).
    document.body.innerHTML = `
      <div>
        <div data-tab-content-id="tab-1" class="tab-visible h-full w-full">Foreground</div>
        <div data-tab-content-id="tab-2" class="tab-hidden" style="visibility: hidden">
          <div data-pane-shell="true" data-pane-id="pane-2">Background content</div>
        </div>
      </div>
    `
    const wrapper = document.querySelector('[data-tab-content-id="tab-2"]') as HTMLElement
    setRect(wrapper, 800, 500)
    const liveHtmlBefore = wrapper.outerHTML

    const render = mockCloneRender('BGPNG')

    const result = await captureUiScreenshot({ scope: 'tab', tabId: 'tab-2' })

    expect(result.ok).toBe(true)
    expect(result.imageBase64).toBe('BGPNG')
    // Protocol envelope fields stay present (REST /api/screenshots echoes
    // them) and are honestly false: nothing moved.
    expect(result.changedFocus).toBe(false)
    expect(result.restoredFocus).toBe(false)
    // The render targeted the LIVE hidden wrapper...
    expect(vi.mocked(html2canvas).mock.calls[0]?.[0]).toBe(wrapper)
    // ...and revealed the CLONE chain only: every clone ancestor up to body
    // carries the explicit visibility override.
    expect(cloneChainVisibilities(render.clonedTarget)).toEqual(['visible', 'visible'])
    // The live DOM is byte-identical: no selection, focus, style, or
    // attribute mutation anywhere.
    expect(wrapper.outerHTML).toBe(liveHtmlBefore)
  })

  it('reveals every hidden ancestor for a pane in a background tab (pane scope)', async () => {
    document.body.innerHTML = `
      <div>
        <div data-tab-content-id="tab-3" style="visibility: hidden">
          <div class="terminal-root" style="visibility: hidden">
            <div data-pane-shell="true" data-pane-id="pane-3">Background pane</div>
          </div>
        </div>
      </div>
    `
    const wrapper = document.querySelector('[data-tab-content-id="tab-3"]') as HTMLElement
    const pane = document.querySelector('[data-pane-id="pane-3"]') as HTMLElement
    setRect(wrapper, 800, 500)
    setRect(pane, 800, 500)
    const liveHtmlBefore = wrapper.outerHTML

    // html2canvas clones the WHOLE document and hands onclone the cloned
    // reference element with its ancestors intact — mirror that by cloning
    // the wrapper and locating the cloned pane inside it.
    let clonedPane: HTMLElement | null = null
    vi.mocked(html2canvas).mockImplementation(async (el: any, opts: any = {}) => {
      if (typeof opts.onclone !== 'function') {
        throw new Error('expected the main render to carry onclone')
      }
      const cloneDoc = document.implementation.createHTMLDocument('clone')
      const cloneWrapper = wrapper.cloneNode(true) as HTMLElement
      cloneDoc.body.appendChild(cloneWrapper)
      clonedPane = cloneWrapper.querySelector('[data-pane-id="pane-3"]') as HTMLElement
      opts.onclone(cloneDoc, clonedPane)
      return {
        width: 800,
        height: 500,
        toDataURL: () => 'data:image/png;base64,PANE3PNG',
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'pane', paneId: 'pane-3' })

    expect(result.ok).toBe(true)
    expect(result.imageBase64).toBe('PANE3PNG')
    // Pane shell → terminal root → tab wrapper (→ body): the whole chain that
    // hides the pane gets the clone-side reveal.
    expect(cloneChainVisibilities(clonedPane!)).toEqual(['visible', 'visible', 'visible', 'visible'])
    expect(wrapper.outerHTML).toBe(liveHtmlBefore)
  })

  it('adds no reveal to an already-visible target (the walk is armed only for hidden chains)', async () => {
    document.body.innerHTML = `
      <div>
        <div data-pane-shell="true" data-pane-id="pane-1">Foreground pane</div>
      </div>
    `
    const pane = document.querySelector('[data-pane-id="pane-1"]') as HTMLElement
    setRect(pane, 800, 500)

    const render = mockCloneRender('FGPNG')

    const result = await captureUiScreenshot({ scope: 'pane', paneId: 'pane-1' })

    expect(result.ok).toBe(true)
    // No inline visibility anywhere on the clone chain: a visible target's
    // onclone is a no-op beyond iframe replacement.
    expect(cloneChainVisibilities(render.clonedTarget).every((state) => state === '')).toBe(true)
  })

  it('prepares iframe replacements for panes inside hidden tabs (layout gates, not paint)', async () => {
    document.body.innerHTML = `
      <div>
        <div data-tab-content-id="tab-4" style="visibility: hidden">
          <div data-pane-shell="true" data-pane-id="pane-4">
            <iframe id="hidden-frame" src="/api/proxy/http/3000/"></iframe>
          </div>
        </div>
      </div>
    `
    const pane = document.querySelector('[data-pane-id="pane-4"]') as HTMLElement
    const iframe = document.getElementById('hidden-frame') as HTMLIFrameElement
    setRect(pane, 800, 500)
    setRect(iframe, 500, 300)

    const iframeDoc = iframe.contentDocument
    expect(iframeDoc).toBeTruthy()
    iframeDoc?.open()
    iframeDoc?.write('<!doctype html><html><body><p>Hidden-tab proxied content</p></body></html>')
    iframeDoc?.close()

    // Order pin: the suspension must bracket ONLY the main render — terminal
    // renderers stay active through target resolution and iframe pre-render.
    const order: string[] = []
    vi.mocked(suspendTerminalRenderersForScreenshot).mockImplementation(async () => {
      order.push('suspend')
      return async () => {
        order.push('resume')
      }
    })
    let clonedHtml = ''
    vi.mocked(html2canvas).mockImplementation(async (el: any, opts: any = {}) => {
      if (typeof opts.onclone === 'function') {
        order.push('main-render')
        const cloneDoc = document.implementation.createHTMLDocument('clone')
        const cloneTarget = (el as HTMLElement).cloneNode(true) as HTMLElement
        cloneDoc.body.appendChild(cloneTarget)
        opts.onclone(cloneDoc, cloneTarget)
        clonedHtml = cloneTarget.innerHTML
        return {
          width: 800,
          height: 500,
          toDataURL: () => 'data:image/png;base64,HIDDENPNG',
        } as any
      }
      order.push('iframe-render')
      return {
        width: 500,
        height: 300,
        toDataURL: () => 'data:image/png;base64,IFRAMEHIDDENPNG',
      } as any
    })

    const result = await captureUiScreenshot({ scope: 'pane', paneId: 'pane-4' })

    expect(result.ok).toBe(true)
    // The visibility-hidden iframe still got its content pre-rendered (the
    // iframe render ran) and swapped in on the clone.
    expect(vi.mocked(html2canvas)).toHaveBeenCalledTimes(2)
    expect(clonedHtml).toContain('data-screenshot-iframe-image="true"')
    expect(clonedHtml).not.toContain('<iframe')
    // Renderers stay active through pre-render; frozen only for the main render.
    expect(order).toEqual(['iframe-render', 'suspend', 'main-render', 'resume'])
  })

  it('applies no iframe replacements when the pane tree changed between preparation and clone', async () => {
    document.body.innerHTML = `
      <div data-context="global">
        <iframe id="stable-frame" src="/api/proxy/http/3000/"></iframe>
      </div>
    `
    const target = document.querySelector('[data-context="global"]') as HTMLElement
    const iframe = document.getElementById('stable-frame') as HTMLIFrameElement
    setRect(target, 800, 500)
    setRect(iframe, 500, 300)

    const iframeDoc = iframe.contentDocument
    expect(iframeDoc).toBeTruthy()
    iframeDoc?.open()
    iframeDoc?.write('<!doctype html><html><body><p>Content</p></body></html>')
    iframeDoc?.close()

    let clonedHtml = ''
    vi.mocked(html2canvas).mockImplementation(async (el: any, opts: any = {}) => {
      if (typeof opts.onclone === 'function') {
        const cloneDoc = document.implementation.createHTMLDocument('clone')
        const cloneTarget = (el as HTMLElement).cloneNode(true) as HTMLElement
        // A concurrent split landed between preparation and clone: the tree
        // now hosts a second iframe, so index correlation is untrustworthy.
        cloneTarget.appendChild(cloneTarget.ownerDocument.createElement('iframe'))
        cloneDoc.body.appendChild(cloneTarget)
        opts.onclone(cloneDoc, cloneTarget)
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

    const result = await captureUiScreenshot({ scope: 'view' })

    expect(result.ok).toBe(true)
    // Replacement skipped entirely: the clone keeps its iframes rather than
    // risking an image landing on the wrong one.
    expect(clonedHtml).toContain('<iframe')
    expect(clonedHtml).not.toContain('data-screenshot-iframe-image')
  })

  it('applies no iframe replacements when the iframe srcs no longer match the prepared list', async () => {
    document.body.innerHTML = `
      <div data-context="global">
        <iframe id="orig-frame" src="/api/proxy/http/3000/"></iframe>
      </div>
    `
    const target = document.querySelector('[data-context="global"]') as HTMLElement
    const iframe = document.getElementById('orig-frame') as HTMLIFrameElement
    setRect(target, 800, 500)
    setRect(iframe, 500, 300)

    const iframeDoc = iframe.contentDocument
    expect(iframeDoc).toBeTruthy()
    iframeDoc?.open()
    iframeDoc?.write('<!doctype html><html><body><p>Content</p></body></html>')
    iframeDoc?.close()

    let clonedHtml = ''
    vi.mocked(html2canvas).mockImplementation(async (el: any, opts: any = {}) => {
      if (typeof opts.onclone === 'function') {
        const cloneDoc = document.implementation.createHTMLDocument('clone')
        const cloneTarget = (el as HTMLElement).cloneNode(true) as HTMLElement
        // Same iframe count, different page: the prepared replacement belongs
        // to a different element now.
        cloneTarget.querySelector('iframe')?.setAttribute('src', '/api/proxy/http/9999/')
        cloneDoc.body.appendChild(cloneTarget)
        opts.onclone(cloneDoc, cloneTarget)
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

    const result = await captureUiScreenshot({ scope: 'view' })

    expect(result.ok).toBe(true)
    expect(clonedHtml).toContain('<iframe')
    expect(clonedHtml).not.toContain('data-screenshot-iframe-image')
  })

  it('applies no iframe replacements when a same-src iframe now lives in a different pane (pane-id fingerprint)', async () => {
    document.body.innerHTML = `
      <div data-context="global">
        <div data-pane-id="pane-x">
          <iframe id="same-src-frame" src="/api/proxy/http/3000/"></iframe>
        </div>
      </div>
    `
    const target = document.querySelector('[data-context="global"]') as HTMLElement
    const iframe = document.getElementById('same-src-frame') as HTMLIFrameElement
    setRect(target, 800, 500)
    setRect(iframe, 500, 300)

    const iframeDoc = iframe.contentDocument
    expect(iframeDoc).toBeTruthy()
    iframeDoc?.open()
    iframeDoc?.write('<!doctype html><html><body><p>Content</p></body></html>')
    iframeDoc?.close()

    let clonedHtml = ''
    vi.mocked(html2canvas).mockImplementation(async (el: any, opts: any = {}) => {
      if (typeof opts.onclone === 'function') {
        const cloneDoc = document.implementation.createHTMLDocument('clone')
        const cloneTarget = (el as HTMLElement).cloneNode(true) as HTMLElement
        // Same count, same src — but the tree changed between preparation and
        // clone and the iframe now belongs to a different pane: index+src
        // alone could not tell, the owning-pane fingerprint can.
        cloneTarget
          .querySelector('[data-pane-id]')
          ?.setAttribute('data-pane-id', 'pane-swapped-in')
        cloneDoc.body.appendChild(cloneTarget)
        opts.onclone(cloneDoc, cloneTarget)
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

    const result = await captureUiScreenshot({ scope: 'view' })

    expect(result.ok).toBe(true)
    expect(clonedHtml).toContain('<iframe')
    expect(clonedHtml).not.toContain('data-screenshot-iframe-image')
  })

  it('fails honestly when the capture target never appears', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    try {
      const suspends: number[] = []
      const resumes: number[] = []
      vi.mocked(suspendTerminalRenderersForScreenshot).mockImplementation(async () => {
        suspends.push(Date.now())
        return async () => {
          resumes.push(Date.now())
        }
      })

      const pending = captureUiScreenshot({ scope: 'tab', tabId: 'tab-missing' })
      await vi.advanceTimersByTimeAsync(1700)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(result.error).toBe('capture target not found')
      expect(result.changedFocus).toBe(false)
      // A never-found target suspends nothing at all — the renderer
      // suspension starts only around the main render, after resolution.
      expect(suspends).toHaveLength(0)
      expect(resumes).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes terminal renderers when the render fails', async () => {
    document.body.innerHTML = `
      <div data-pane-shell="true" data-pane-id="pane-err">Err</div>
    `
    const pane = document.querySelector('[data-pane-id="pane-err"]') as HTMLElement
    setRect(pane, 800, 500)

    const resumes: number[] = []
    vi.mocked(suspendTerminalRenderersForScreenshot).mockImplementation(async () => async () => {
      resumes.push(Date.now())
    })
    vi.mocked(html2canvas).mockImplementation(async () => {
      throw new Error('renderer exploded')
    })

    const result = await captureUiScreenshot({ scope: 'pane', paneId: 'pane-err' })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('renderer exploded')
    expect(resumes).toHaveLength(1)
  })
})
