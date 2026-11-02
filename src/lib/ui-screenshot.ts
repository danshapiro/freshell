import html2canvas from 'html2canvas'
import { prepareScreenshotViewport } from '@/lib/screenshot-viewport'
import { suspendTerminalRenderersForScreenshot } from '@/lib/screenshot-capture-env'
import { beginScreenshotProgress, waitForScreenshotProgressPaint } from '@/lib/screenshot-progress'

const ELEMENT_WAIT_TIMEOUT_MS = 1500
const ELEMENT_WAIT_INTERVAL_MS = 50
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
  /** Always false: captures render through an off-DOM clone and never move
   *  the user's selection or focus. The fields stay for wire/REST envelope
   *  compatibility (POST /api/screenshots echoes both). */
  changedFocus: boolean
  restoredFocus: boolean
  error?: string
}

type IframeReplacement =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'placeholder'; message: string; src: string }

type PreparedIframeCapture = {
  onclone: (doc: Document, clonedTarget: HTMLElement, ignoreElements: (element: Element) => boolean) => void
  diagnostics: { count: number; placeholders: number; skipped: number; correlationMismatch: boolean }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

/** Background tabs stay fully LAID OUT while hidden — `.tab-hidden` is
 *  `visibility: hidden` (not `display: none`) precisely so xterm can keep
 *  measuring — which is what lets a capture render them without activating
 *  the tab: html2canvas parses the target's bounds and paints from its CLONE
 *  of the document, and skips visibility-hidden subtrees while painting. */
function hasLayout(element: HTMLElement): boolean {
  if (!element.isConnected) return false
  const rect = element.getBoundingClientRect()
  return rect.width >= 1 && rect.height >= 1
}

async function waitForLaidOutElement(
  getElement: () => HTMLElement | null,
  timeoutMs = ELEMENT_WAIT_TIMEOUT_MS,
): Promise<HTMLElement | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const candidate = getElement()
    if (candidate && hasLayout(candidate)) return candidate
    await sleep(ELEMENT_WAIT_INTERVAL_MS)
  }
  return null
}

function isHiddenFromPaint(el: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView
  if (!view) return false
  const visibility = view.getComputedStyle(el).visibility
  return visibility === 'hidden' || visibility === 'collapse'
}

/** Whether any ancestor of the LIVE target (target included, up to body) is
 *  hidden from paint — i.e. the target sits in a background tab and the clone
 *  reveal must be armed for it. Computed on the live DOM where the window's
 *  real stylesheet resolution is available. */
function chainHiddenFromPaint(target: HTMLElement): boolean {
  for (let el = target as HTMLElement | null; el && el !== el.ownerDocument.documentElement; el = el.parentElement) {
    if (isHiddenFromPaint(el)) return true
  }
  return false
}

/** Clone-side reveal: an inline `visibility: visible` on every ancestor of
 *  the cloned target (up to body) beats the `.tab-hidden` class rule, making
 *  the background tab paintable inside html2canvas's clone. Only the clone
 *  changes — the live DOM, the user's selection, and DOM focus never move,
 *  which is the whole point: a screenshot must never steal the user's tab. */
function revealClonedTargetChain(clonedTarget: HTMLElement): void {
  for (
    let el = clonedTarget as HTMLElement | null;
    el && el !== el.ownerDocument.documentElement;
    el = el.parentElement
  ) {
    el.style.visibility = 'visible'
  }
}

/** html2canvas cannot paint (or reliably clone) iframe content inside the
 *  main render, so each iframe's document is pre-rendered separately and the
 *  clone swaps the iframe for the resulting image (or an explicit
 *  placeholder when the document is inaccessible, e.g. cross-origin).
 *
 *  Clone-side correlation: the replacement list is built from the LIVE
 *  target's iframes in document order, and applied to the CLONED target's
 *  iframes in document order. The two lists are verified to still describe
 *  the same tree at clone time — same count AND same per-index fingerprint
 *  (owning pane id + src) — because the pane tree can change between
 *  preparation and clone (a concurrent split), and a mismatch applies NO
 *  replacements rather than risk an image landing on the wrong iframe. The
 *  pane id disambiguates same-URL iframes (each browser/extension pane hosts
 *  exactly one). No marker attributes are stamped on the live DOM at all. */
async function prepareIframeCapture(
  target: HTMLElement, scale: number, ignoreElements: (element: Element) => boolean,
): Promise<PreparedIframeCapture> {
  const retained = (iframe: HTMLIFrameElement, omitted: (element: Element) => boolean) => {
    if (!target.contains(iframe)) return false
    for (let node: Element | null = iframe; node; node = node.parentElement) {
      if (omitted(node)) return false
      if (node === target) break
    }
    return true
  }
  const iframes = Array.from(target.querySelectorAll('iframe')).filter((iframe) => retained(iframe, ignoreElements))
  const originalFingerprints = iframes.map(iframeFingerprint)
  const replacements: (IframeReplacement | null)[] = []
  for (const iframe of iframes) {
    replacements.push(hasLayout(iframe) ? await captureIframeReplacement(iframe, scale) : null)
  }
  const diagnostics = {
    count: iframes.length,
    placeholders: replacements.filter((replacement) => replacement?.kind === 'placeholder').length,
    skipped: replacements.filter((replacement) => replacement === null).length,
    correlationMismatch: false,
  }
  return {
    diagnostics,
    onclone: (doc, clonedTarget, currentOmissions) => {
      const indexes = iframes.map((_, i) => i).filter((i) => retained(iframes[i], currentOmissions))
      const copies = Array.from(clonedTarget.querySelectorAll('iframe'))
      if (copies.length !== indexes.length) { diagnostics.correlationMismatch = true; return }
      for (let i = 0; i < copies.length; i++) {
        if (iframeFingerprint(copies[i]) !== originalFingerprints[indexes[i]]) { diagnostics.correlationMismatch = true; return }
      }
      for (let i = 0; i < copies.length; i++) {
        const replacement = replacements[indexes[i]]
        if (replacement) copies[i].replaceWith(buildIframeReplacementElement(doc, copies[i], replacement))
      }
    },
  }
}

/** Stable iframe identity across the live DOM and its html2canvas clone: the
 *  owning pane's id (unique; empty when the iframe sits outside pane shells,
 *  e.g. app-level chrome in view scope) plus the raw src attribute. */
function iframeFingerprint(iframe: HTMLIFrameElement): string {
  const paneId = iframe.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? ''
  return `${paneId}\u0000${iframe.getAttribute('src') ?? ''}`
}

async function resolveCaptureTarget(request: ScreenshotRequest): Promise<HTMLElement> {
  if (request.scope === 'view') {
    const target = findViewElement()
    if (!target) throw new Error('capture target not found')
    return target
  }
  if (request.scope === 'tab') {
    if (!request.tabId) throw new Error('tabId required for tab scope')
    const target = await waitForLaidOutElement(() => findTabElement(request.tabId!))
    if (!target) throw new Error('capture target not found')
    return target
  }
  if (!request.paneId) throw new Error('paneId required for pane scope')
  const target = await waitForLaidOutElement(() => findPaneElement(request.paneId!))
  if (!target) throw new Error('capture target not found')
  return target
}

export async function captureUiScreenshot(request: ScreenshotRequest, requestId: string = crypto.randomUUID()): Promise<ScreenshotResult> {
  const startedAt = performance.now()
  const finishProgress = beginScreenshotProgress()
  const context = { requestId, scope: request.scope, paneId: request.paneId, tabId: request.tabId }
  const timings: Record<string, number> = {}
  let failureStage = 'target'
  let iframes: PreparedIframeCapture['diagnostics'] | undefined
  // Deliberately bypass the component logger's production WARN threshold:
  // healthy captures must reach existing console-to-server collection too.
  console.info({ event: 'screenshot.capture.started', ...context })
  async function phase<T>(name: string, run: () => T | Promise<T>): Promise<T> {
    const start = performance.now()
    try {
      return await run()
    } catch (error) {
      failureStage = name
      throw error
    } finally {
      timings[name] = Math.round(performance.now() - start)
    }
  }
  let result: Omit<ScreenshotResult, 'changedFocus' | 'restoredFocus'>
  try {
    const target = await phase('target', () => resolveCaptureTarget(request))
    await phase('paint', waitForScreenshotProgressPaint)
    const scale = Math.max(1, window.devicePixelRatio || 1)
    // Armed live-side: only a target with a hidden ancestor chain (a
    // background tab) needs the clone reveal; visible targets skip it.
    const needsReveal = chainHiddenFromPaint(target)
    // Iframe pre-render needs no frozen renderers (it renders nested documents,
    // not terminal canvases), so the suspension starts as late as possible —
    // exactly around the main render, the only step that reads the WebGL
    // canvases — and a never-found target suspends nothing at all.
    const preparedIframes = await phase('iframes', () => {
      const iframeViewport = prepareScreenshotViewport(target)
      return prepareIframeCapture(target, scale, iframeViewport.ignoreElements)
    })
    iframes = preparedIframes.diagnostics
    // Web canvases (xterm's WebGL renderer) are only reliably readable around
    // a fresh synchronous render — the refcounted suspension forces one and
    // freezes the renderers while html2canvas copies each canvas into its
    // clone. Balanced in `finally`, including every failure path.
    const restoreRenderers = await phase('suspend', suspendTerminalRenderersForScreenshot)
    try {
      const canvas = await phase('render', () => {
        // No await between fresh geometry and html2canvas's synchronous clone.
        const preparedViewport = prepareScreenshotViewport(target)
        return html2canvas(target, {
          backgroundColor: null,
          allowTaint: true,
          useCORS: true,
          logging: false,
          scale,
          ignoreElements: preparedViewport.ignoreElements,
          onclone: (doc, clonedTarget) => {
            if (needsReveal) revealClonedTargetChain(clonedTarget)
            preparedViewport.onclone(doc, clonedTarget)
            preparedIframes.onclone(doc, clonedTarget, preparedViewport.ignoreElements)
          },
        })
      })

      const imageBase64 = await phase('encode', () => {
        const dataUrl = canvas.toDataURL('image/png')
        const prefix = 'data:image/png;base64,'
        if (!dataUrl.startsWith(prefix)) throw new Error('failed to encode png screenshot')
        return dataUrl.slice(prefix.length)
      })

      result = {
        ok: true,
        mimeType: 'image/png',
        imageBase64,
        width: canvas.width,
        height: canvas.height,
      }
    } finally {
      await phase('restore', restoreRenderers)
    }
  } catch (err: any) {
    result = {
      ok: false,
      error: err?.message || 'failed to capture screenshot',
    }
  } finally {
    finishProgress()
  }

  const diagnostics = { ...context, durationMs: Math.round(performance.now() - startedAt), timings, iframes }
  if (result.ok) {
    console.info({ event: 'screenshot.capture.completed', ...diagnostics, width: result.width, height: result.height })
  } else {
    console.error({ event: 'screenshot.capture.failed', ...diagnostics, stage: failureStage, error: result.error })
  }

  return {
    ...result,
    changedFocus: false,
    restoredFocus: false,
  }
}
