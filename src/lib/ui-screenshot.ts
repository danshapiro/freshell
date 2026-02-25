import html2canvas from 'html2canvas'
import { setActivePane } from '@/store/panesSlice'
import { setActiveTab } from '@/store/tabsSlice'
import { suspendTerminalRenderersForScreenshot } from '@/lib/screenshot-capture-env'
import type { PaneNode } from '@/store/paneTypes'
import type { AppDispatch, RootState } from '@/store/store'

const VISIBLE_WAIT_TIMEOUT_MS = 1500
const VISIBLE_WAIT_INTERVAL_MS = 50
const IFRAME_MARKER_ATTR = 'data-screenshot-iframe-marker'
const IFRAME_IMAGE_ATTR = 'data-screenshot-iframe-image'
const IFRAME_PLACEHOLDER_ATTR = 'data-screenshot-iframe-placeholder'

export type ScreenshotScope = 'pane' | 'tab' | 'view'

export type ScreenshotRequest = {
  scope: ScreenshotScope
  paneId?: string
  tabId?: string
}

export type ScreenshotResult = {
  ok: boolean
  mimeType?: 'image/png'
  imageBase64?: string
  width?: number
  height?: number
  changedFocus: boolean
  restoredFocus: boolean
  error?: string
}

type RuntimeContext = {
  dispatch: AppDispatch
  getState: () => RootState
}

type FocusSnapshot = {
  activeTabId: string | null
  activePaneByTab: Record<string, string>
}

type IframeReplacement =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'placeholder'; message: string; src: string }

type PreparedIframeCapture = {
  onclone: (doc: Document) => void
  cleanup: () => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function snapshotFocus(state: RootState): FocusSnapshot {
  return {
    activeTabId: state.tabs.activeTabId,
    activePaneByTab: { ...state.panes.activePane },
  }
}

function isElementVisible(element: HTMLElement): boolean {
  if (!element.isConnected) return false
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const rect = element.getBoundingClientRect()
  return rect.width >= 2 && rect.height >= 2
}

async function waitForVisibleElement(getElement: () => HTMLElement | null, timeoutMs = VISIBLE_WAIT_TIMEOUT_MS): Promise<HTMLElement | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const candidate = getElement()
    if (candidate && isElementVisible(candidate)) return candidate
    await sleep(VISIBLE_WAIT_INTERVAL_MS)
  }
  return null
}

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function safeIframeSrc(iframe: HTMLIFrameElement): string {
  const direct = iframe.getAttribute('src')
  if (direct && direct.trim()) return direct.trim()
  try {
    return iframe.src || 'about:blank'
  } catch {
    return 'about:blank'
  }
}

function truncateText(value: string, maxChars = 120): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 3)}...`
}

function normalizeDataUrl(dataUrl: string): string | null {
  return dataUrl.startsWith('data:image/png;base64,') ? dataUrl : null
}

async function captureIframeReplacement(iframe: HTMLIFrameElement, scale: number): Promise<IframeReplacement> {
  const src = safeIframeSrc(iframe)
  const crossOriginMessage = 'Iframe content is not directly capturable in browser screenshots'

  try {
    const iframeDoc = iframe.contentDocument
    const iframeWin = iframe.contentWindow
    if (!iframeDoc || !iframeDoc.documentElement || !iframeWin) {
      throw new Error('iframe document unavailable')
    }

    const rect = iframe.getBoundingClientRect()
    const captureWidth = Math.max(1, Math.floor(rect.width || iframe.clientWidth || 1))
    const captureHeight = Math.max(1, Math.floor(rect.height || iframe.clientHeight || 1))

    const canvas = await html2canvas(iframeDoc.documentElement as HTMLElement, {
      backgroundColor: null,
      allowTaint: true,
      useCORS: true,
      logging: false,
      scale,
      width: captureWidth,
      height: captureHeight,
      x: iframeWin.scrollX,
      y: iframeWin.scrollY,
      scrollX: -iframeWin.scrollX,
      scrollY: -iframeWin.scrollY,
      windowWidth: captureWidth,
      windowHeight: captureHeight,
    })

    const encoded = normalizeDataUrl(canvas.toDataURL('image/png'))
    if (encoded) {
      return { kind: 'image', dataUrl: encoded }
    }
  } catch {
    // Browser iframe access is best-effort only; fall through to placeholder.
  }

  return {
    kind: 'placeholder',
    message: crossOriginMessage,
    src: truncateText(src),
  }
}

function buildIframeReplacementElement(
  doc: Document,
  iframe: HTMLIFrameElement,
  replacement: IframeReplacement,
): HTMLElement {
  const container = doc.createElement('div')
  container.className = iframe.className
  const inlineStyle = iframe.getAttribute('style')
  if (inlineStyle) {
    container.setAttribute('style', inlineStyle)
  }
  container.style.width = container.style.width || '100%'
  container.style.height = container.style.height || '100%'
  container.style.minHeight = container.style.minHeight || '1px'

  if (replacement.kind === 'image') {
    const image = doc.createElement('img')
    image.setAttribute(IFRAME_IMAGE_ATTR, 'true')
    image.src = replacement.dataUrl
    image.alt = 'Iframe screenshot content'
    image.style.width = '100%'
    image.style.height = '100%'
    image.style.display = 'block'
    image.style.objectFit = 'fill'
    container.appendChild(image)
    return container
  }

  container.setAttribute(IFRAME_PLACEHOLDER_ATTR, 'true')
  container.style.display = 'flex'
  container.style.flexDirection = 'column'
  container.style.justifyContent = 'center'
  container.style.alignItems = 'center'
  container.style.textAlign = 'center'
  container.style.background = '#f5f5f5'
  container.style.color = '#1f2937'
  container.style.padding = '12px'
  container.style.fontSize = '12px'

  const title = doc.createElement('div')
  title.textContent = replacement.message
  title.style.fontWeight = '600'
  title.style.marginBottom = '6px'
  container.appendChild(title)

  const src = doc.createElement('code')
  src.textContent = replacement.src
  src.style.fontSize = '11px'
  src.style.maxWidth = '100%'
  src.style.whiteSpace = 'normal'
  src.style.wordBreak = 'break-all'
  container.appendChild(src)

  return container
}

async function prepareIframeCapture(target: HTMLElement, scale: number): Promise<PreparedIframeCapture> {
  const iframes = Array.from(target.querySelectorAll('iframe'))
  if (iframes.length === 0) {
    return {
      onclone: () => {},
      cleanup: () => {},
    }
  }

  const markedIframes = new Map<string, HTMLIFrameElement>()
  const previousMarkers = new Map<HTMLIFrameElement, string | null>()
  const replacements = new Map<string, IframeReplacement>()
  const markerPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  for (let i = 0; i < iframes.length; i += 1) {
    const iframe = iframes[i]
    const marker = `shot-iframe-${markerPrefix}-${i}`
    previousMarkers.set(iframe, iframe.getAttribute(IFRAME_MARKER_ATTR))
    iframe.setAttribute(IFRAME_MARKER_ATTR, marker)
    markedIframes.set(marker, iframe)
  }

  for (const [marker, iframe] of markedIframes) {
    if (!isElementVisible(iframe)) continue
    replacements.set(marker, await captureIframeReplacement(iframe, scale))
  }

  return {
    onclone: (doc: Document) => {
      const cloneIframes = Array.from(doc.querySelectorAll(`iframe[${IFRAME_MARKER_ATTR}]`))
      for (const candidate of cloneIframes) {
        const cloneIframe = candidate as HTMLIFrameElement
        const marker = cloneIframe.getAttribute(IFRAME_MARKER_ATTR)
        if (!marker) continue
        const replacement = replacements.get(marker)
        if (!replacement) continue
        cloneIframe.replaceWith(buildIframeReplacementElement(doc, cloneIframe, replacement))
      }
    },
    cleanup: () => {
      for (const [iframe, previous] of previousMarkers) {
        if (previous === null) {
          iframe.removeAttribute(IFRAME_MARKER_ATTR)
        } else {
          iframe.setAttribute(IFRAME_MARKER_ATTR, previous)
        }
      }
    },
  }
}

function findPaneElement(paneId: string): HTMLElement | null {
  const escaped = escapeSelectorValue(paneId)
  return document.querySelector(`[data-pane-shell="true"][data-pane-id="${escaped}"]`) as HTMLElement | null
}

function findTabElement(tabId: string): HTMLElement | null {
  const escaped = escapeSelectorValue(tabId)
  return document.querySelector(`[data-tab-content-id="${escaped}"]`) as HTMLElement | null
}

function findViewElement(): HTMLElement | null {
  return (document.querySelector('[data-context="global"]') as HTMLElement | null) || document.body
}

function nodeContainsPane(node: PaneNode | undefined, paneId: string): boolean {
  if (!node) return false
  if (node.type === 'leaf') return node.id === paneId
  return nodeContainsPane(node.children[0], paneId) || nodeContainsPane(node.children[1], paneId)
}

function findTabIdForPane(state: RootState, paneId: string): string | undefined {
  for (const [tabId, root] of Object.entries(state.panes.layouts)) {
    if (nodeContainsPane(root, paneId)) return tabId
  }
  return undefined
}

async function restoreFocus(ctx: RuntimeContext, before: FocusSnapshot, paneTabsToRestore: Set<string>): Promise<boolean> {
  try {
    for (const tabId of paneTabsToRestore) {
      const originalPaneId = before.activePaneByTab[tabId]
      if (!originalPaneId) continue
      if (ctx.getState().panes.activePane[tabId] !== originalPaneId) {
        ctx.dispatch(setActivePane({ tabId, paneId: originalPaneId }))
      }
    }

    if (before.activeTabId && ctx.getState().tabs.activeTabId !== before.activeTabId) {
      ctx.dispatch(setActiveTab(before.activeTabId))
    }

    await afterPaint()

    const after = ctx.getState()
    if (before.activeTabId && after.tabs.activeTabId !== before.activeTabId) return false
    for (const tabId of paneTabsToRestore) {
      const originalPaneId = before.activePaneByTab[tabId]
      if (!originalPaneId) continue
      if (after.panes.activePane[tabId] !== originalPaneId) return false
    }
    return true
  } catch {
    return false
  }
}

export async function captureUiScreenshot(request: ScreenshotRequest, ctx: RuntimeContext): Promise<ScreenshotResult> {
  const focusBefore = snapshotFocus(ctx.getState())
  const paneTabsToRestore = new Set<string>()
  let changedFocus = false
  let restoredFocus = false

  const setActiveTabIfNeeded = async (tabId: string) => {
    if (ctx.getState().tabs.activeTabId === tabId) return
    ctx.dispatch(setActiveTab(tabId))
    changedFocus = true
    await afterPaint()
  }

  const setActivePaneIfNeeded = async (tabId: string, paneId: string) => {
    if (ctx.getState().panes.activePane[tabId] === paneId) return
    ctx.dispatch(setActivePane({ tabId, paneId }))
    paneTabsToRestore.add(tabId)
    changedFocus = true
    await afterPaint()
  }

  let result: Omit<ScreenshotResult, 'changedFocus' | 'restoredFocus'>
  const restoreRenderers = await suspendTerminalRenderersForScreenshot()
  try {
    let target: HTMLElement | null = null

    if (request.scope === 'view') {
      target = findViewElement()
    } else if (request.scope === 'tab') {
      const tabId = request.tabId
      if (!tabId) throw new Error('tabId required for tab scope')

      target = findTabElement(tabId)
      if (!target || !isElementVisible(target)) {
        await setActiveTabIfNeeded(tabId)
        target = await waitForVisibleElement(() => findTabElement(tabId))
      }
    } else {
      const paneId = request.paneId
      if (!paneId) throw new Error('paneId required for pane scope')

      target = findPaneElement(paneId)
      if (!target || !isElementVisible(target)) {
        const targetTabId = request.tabId || findTabIdForPane(ctx.getState(), paneId)
        if (!targetTabId) throw new Error('pane tab not found')

        await setActiveTabIfNeeded(targetTabId)
        target = findPaneElement(paneId)

        if (!target || !isElementVisible(target)) {
          await setActivePaneIfNeeded(targetTabId, paneId)
          target = await waitForVisibleElement(() => findPaneElement(paneId))
        }
      }
    }

    if (!target) throw new Error('capture target not found')
    if (!isElementVisible(target)) {
      const visibleTarget = await waitForVisibleElement(() => target)
      if (!visibleTarget) throw new Error('capture target is not visible')
      target = visibleTarget
    }

    const scale = Math.max(1, window.devicePixelRatio || 1)
    const preparedIframes = await prepareIframeCapture(target, scale)
    let canvas: HTMLCanvasElement
    try {
      canvas = await html2canvas(target, {
        backgroundColor: null,
        allowTaint: true,
        useCORS: true,
        logging: false,
        scale,
        onclone: (doc) => {
          preparedIframes.onclone(doc)
        },
      })
    } finally {
      preparedIframes.cleanup()
    }

    const dataUrl = canvas.toDataURL('image/png')
    const prefix = 'data:image/png;base64,'
    if (!dataUrl.startsWith(prefix)) throw new Error('failed to encode png screenshot')

    result = {
      ok: true,
      mimeType: 'image/png',
      imageBase64: dataUrl.slice(prefix.length),
      width: canvas.width,
      height: canvas.height,
    }
  } catch (err: any) {
    result = {
      ok: false,
      error: err?.message || 'failed to capture screenshot',
    }
  }

  await restoreRenderers()

  if (changedFocus) {
    restoredFocus = await restoreFocus(ctx, focusBefore, paneTabsToRestore)
  }

  return {
    ...result,
    changedFocus,
    restoredFocus,
  }
}
