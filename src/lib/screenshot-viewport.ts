const TRANSCRIPT = '[data-context="fresh-agent-transcript"]'
const OVERSCAN = 100

export type PreparedScreenshotViewport = {
  ignoreElements: (element: Element) => boolean
  onclone: (doc: Document, clonedTarget: HTMLElement) => void
}

type Box = { top: number; bottom: number; left: number; right: number }
type TranscriptPlan = {
  paneId: string | null
  rowCount: number
  first: number
  end: number
  top: number
  left: number
  height: number
  anchorTop: number
  code: RowCodePlan[]
}

function intersection(a: Box, b: Box): Box {
  return { top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom),
    left: Math.max(a.left, b.left), right: Math.min(a.right, b.right) }
}

function viewport(node: HTMLElement, r: Box): Box {
  const top = r.top + node.clientTop, left = r.left + node.clientLeft
  return { top, left, bottom: top + node.clientHeight, right: left + node.clientWidth }
}

type CodePlan = {
  index: number
  width: number
  height: number
  top: number
  left: number
  text: string
  typography: Record<string, string>
}

type RowCodePlan = { preCount: number; blocks: CodePlan[] }

function clipFor(pre: HTMLElement, target: HTMLElement): Box {
  const clip = intersection(viewport(pre, pre.getBoundingClientRect()), target.getBoundingClientRect())
  const view = pre.ownerDocument.defaultView!
  for (let parent = pre.parentElement; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent)
    const box = viewport(parent, parent.getBoundingClientRect())
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      clip.top = Math.max(clip.top, box.top); clip.bottom = Math.min(clip.bottom, box.bottom)
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      clip.left = Math.max(clip.left, box.left); clip.right = Math.min(clip.right, box.right)
    }
    if (parent === target) break
  }
  return clip
}

function prepareCode(row: HTMLElement, target: HTMLElement, omitted: Set<Element>): RowCodePlan {
  const pres = Array.from(row.querySelectorAll<HTMLElement>('pre'))
  const blocks: CodePlan[] = []
  pres.forEach((pre, index) => {
    if (!pre.firstElementChild) return
    const view = pre.ownerDocument.defaultView!
    const style = view.getComputedStyle(pre)
    if (style.whiteSpace !== 'pre') return
    const code = pre.querySelector<HTMLElement>('code') ?? pre
    const codeStyle = view.getComputedStyle(code)
    const lineHeight = parseFloat(codeStyle.lineHeight)
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return
    const text = pre.textContent ?? ''
    const lines = text.split('\n')
    if (lines.length < 200 && text.length < 12000) return
    const box = pre.getBoundingClientRect()
    const clip = clipFor(pre, target)
    const paddingTop = parseFloat(style.paddingTop) || 0
    const paddingLeft = parseFloat(style.paddingLeft) || 0
    const origin = box.top + pre.clientTop + paddingTop - pre.scrollTop
    const visible = clip.bottom > clip.top && clip.right > clip.left
    const start = visible ? Math.max(0, Math.floor((clip.top - origin) / lineHeight) - 2) : 0
    const end = visible ? Math.min(lines.length, Math.ceil((clip.bottom - origin) / lineHeight) + 2) : 0
    // Stop descent at direct element children, normally the single code root.
    for (const child of pre.children) omitted.add(child)
    blocks.push({ index, width: box.width, height: box.height,
      top: paddingTop + start * lineHeight - pre.scrollTop,
      left: paddingLeft - pre.scrollLeft,
      text: lines.slice(start, end).join('\n'),
      typography: Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
        'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize', 'color', 'textTransform'].map((key) =>
        [key, codeStyle[key as keyof CSSStyleDeclaration] as string])),
    })
  })
  return { preCount: pres.length, blocks }
}

function applyCode(row: HTMLElement, plan: RowCodePlan): void {
  const pres = Array.from(row.querySelectorAll<HTMLElement>('pre'))
  if (pres.length !== plan.preCount) throw new Error('screenshot code structure changed during capture')
  for (const block of plan.blocks) {
    const pre = pres[block.index]
    const text = pre.ownerDocument.createElement('span')
    Object.assign(text.style, block.typography, {
      position: 'absolute', top: `${block.top}px`, left: `${block.left}px`,
      whiteSpace: 'pre', margin: '0', padding: '0', border: '0',
    })
    text.textContent = block.text
    pre.replaceChildren(text)
    Object.assign(pre.style, { position: 'relative', boxSizing: 'border-box',
      width: `${block.width}px`, height: `${block.height}px`, minHeight: `${block.height}px`,
      overflow: 'hidden', flexShrink: '0' })
    // The text translation already accounts for source scroll. Do not
    // restore it again and subtract the offsets twice.
    pre.scrollTop = 0
    pre.scrollLeft = 0
  }
}

function lowerBound(rows: HTMLElement[], predicate: (row: HTMLElement) => boolean): number {
  let low = 0, high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (predicate(rows[middle])) high = middle
    else low = middle + 1
  }
  return low
}

function paneId(node: Element): string | null {
  return node.closest('[data-pane-shell="true"][data-pane-id]')?.getAttribute('data-pane-id') ?? null
}

function spacer(doc: Document): HTMLDivElement {
  const node = doc.createElement('div')
  node.style.cssText = 'height:0;min-height:0;flex:0 0 auto;box-sizing:content-box;margin:0;padding:0;border:0;pointer-events:none'
  return node
}

function setSpacerHeight(node: HTMLElement, height: number): void {
  const bounded = Math.max(0, height)
  const whole = Math.floor(bounded)
  // One large CSS length can round away 1/64px of transcript positioning.
  // Keep its fractional part small so flex layout adds it without that loss.
  node.style.height = `${whole}px`
  node.style.paddingTop = `${bounded - whole}px`
}

function restoreTranscriptGeometry(copy: HTMLElement, plan: TranscriptPlan): void {
  copy.scrollTop = 0
  copy.scrollLeft = 0
  const firstRow = copy.firstElementChild as HTMLElement
  // Never add a top spacer when the original first row remains: it
  // changes :first-child margins, borders, and padding in serif/mono.
  if (plan.first > 0) {
    const top = spacer(copy.ownerDocument)
    copy.insertBefore(top, firstRow)
    const current = firstRow.getBoundingClientRect().top - copy.getBoundingClientRect().top
    setSpacerHeight(top, plan.anchorTop - current)
  }
  if (plan.end < plan.rowCount) {
    const bottom = spacer(copy.ownerDocument)
    copy.appendChild(bottom)
    setSpacerHeight(bottom, plan.height - copy.scrollHeight)
  }
  copy.scrollTop = plan.top
  copy.scrollLeft = plan.left
}

/** html2canvas 1.4 cannot parse the computed color() values produced by
 * FreshAgent's color-mix gradient and composer shadow. Their srgb channels
 * have the same meaning in rgba(); only retained clone nodes are adapted. */
function prepareCloneColors(doc: Document, fallbackView: Window): void {
  const view = doc.defaultView ?? fallbackView
  for (const node of doc.querySelectorAll<HTMLElement>(
    '.fresh-agent-style-serif .fresh-agent-turn[data-turn-role="user"] .fresh-agent-transcript-copy, .fresh-agent-composer-input',
  )) {
    const property = node.matches('.fresh-agent-composer-input') ? 'box-shadow' : 'background-image'
    const value = view.getComputedStyle(node).getPropertyValue(property)
    if (!value.includes('color(srgb ')) continue
    node.style.setProperty(property, value.replace(/color\(srgb ([^)]+)\)/g, (_match, channels: string) => {
      const [rgb, alpha = '1'] = channels.split('/').map((part) => part.trim())
      const [r, g, b] = rgb.split(/\s+/).map(Number)
      return `rgba(${r * 255}, ${g * 255}, ${b * 255}, ${alpha})`
    }))
  }
}

export function prepareScreenshotViewport(target: HTMLElement): PreparedScreenshotViewport {
  const doc = target.ownerDocument
  const view = doc.defaultView!
  const hiddenFromPaint = (node: Element) => ['hidden', 'collapse'].includes(view.getComputedStyle(node).visibility)
  const targetBox = target.getBoundingClientRect()
  const targetHidden = hiddenFromPaint(target)
  const omitted = new Set<Element>()
  // html2canvas clones the whole document, including unrelated terminals and
  // editors. Keep Freshell's known outer layout boxes, omit their contents.
  for (const boundary of doc.querySelectorAll<HTMLElement>('[data-tab-content-id], [data-pane-shell="true"]')) {
    const relevant = target.contains(boundary) || boundary.contains(target)
    if (!relevant || (!targetHidden && hiddenFromPaint(boundary))) {
      for (const child of boundary.children) omitted.add(child)
    }
  }
  const sources = Array.from(doc.querySelectorAll<HTMLElement>(TRANSCRIPT)).filter((source) => {
    for (let node: Element | null = source; node; node = node.parentElement) if (omitted.has(node)) return false
    return true
  })
  const plans: TranscriptPlan[] = sources.map((source) => {
    const rows = Array.from(source.children) as HTMLElement[]
    const sourceBox = source.getBoundingClientRect()
    const clip = intersection(targetBox, viewport(source, sourceBox))
    const painted = targetHidden || !hiddenFromPaint(source)
    const included = target.contains(source) && painted && clip.bottom > clip.top && clip.right > clip.left
    const first = included ? lowerBound(rows, (row) => row.getBoundingClientRect().bottom >= clip.top - OVERSCAN) : 0
    const end = included ? lowerBound(rows, (row) => row.getBoundingClientRect().top > clip.bottom + OVERSCAN) : 0
    rows.forEach((row, index) => { if (index < first || index >= end) omitted.add(row) })
    return { paneId: paneId(source), rowCount: rows.length, first, end, top: source.scrollTop, left: source.scrollLeft,
      height: source.scrollHeight,
      anchorTop: first < end ? rows[first].getBoundingClientRect().top - sourceBox.top + source.scrollTop : 0,
      code: rows.slice(first, end).map((row) => prepareCode(row, target, omitted)) }
  })

  return {
    ignoreElements: (element) => omitted.has(element),
    onclone: (copyDoc) => {
      const copies = Array.from(copyDoc.querySelectorAll<HTMLElement>(TRANSCRIPT))
      if (copies.length !== plans.length) throw new Error('screenshot transcript tree changed during capture')
      copies.forEach((copy, index) => {
        const plan = plans[index]
        if (paneId(copy) !== plan.paneId || copy.children.length !== plan.end - plan.first) {
          throw new Error('screenshot transcript identity changed during capture')
        }
        if (plan.first === plan.end) return
        const retained = Array.from(copy.children) as HTMLElement[]
        retained.forEach((row, index) => applyCode(row, plan.code[index]))
        restoreTranscriptGeometry(copy, plan)
      })
      prepareCloneColors(copyDoc, view)
    },
  }
}
