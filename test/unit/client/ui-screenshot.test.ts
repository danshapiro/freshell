import { beforeEach, describe, expect, it, vi } from 'vitest'
import html2canvas from 'html2canvas'
import { captureUiScreenshot } from '../../../src/lib/ui-screenshot'

vi.mock('html2canvas', () => ({
  default: vi.fn(),
}))

vi.mock('../../../src/lib/screenshot-capture-env', () => ({
  suspendTerminalRenderersForScreenshot: vi.fn(async () => async () => {}),
}))

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

describe('captureUiScreenshot iframe handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
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
})
