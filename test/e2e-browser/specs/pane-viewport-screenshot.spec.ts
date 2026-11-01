import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import type { FreshAgentTurn } from '../../../shared/fresh-agent-contract.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'

const require = createRequire(import.meta.url)
const TRANSCRIPT = '[data-context="fresh-agent-transcript"]'
let nextFixture = 0

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

function turns(count: number): FreshAgentTurn[] {
  return Array.from({ length: count }, (_, i): FreshAgentTurn => ({
    id: `turn-${i}`, turnId: `turn-${i}`, role: i % 2 ? 'assistant' : 'user',
    summary: `Synthetic turn ${i}`, items: [{ id: `text-${i}`, kind: 'text', text:
      `Viewport row ${i}\n\n` + Array.from({ length: 12 }, (_, j) =>
        `- **row ${i} item ${j}**: [synthetic link](https://example.invalid/) and \`value_${i}_${j}\`.`).join('\n') +
      (i % 3 === 0 ? '\n\n```ts\nconst small = 1\n```' : ''),
    }],
  }))
}

async function mountTranscript(page: Page, content: FreshAgentTurn[], style: 'serif' | 'mono' = 'serif', rolledBackTurns: FreshAgentTurn[] = []) {
  const n = ++nextFixture
  const sessionId = `83333000-0000-4333-8333-${String(n).padStart(12, '0')}`
  const paneId = `viewport-pane-${n}`
  const tabId = `viewport-tab-${n}`
  await page.route(`**/api/fresh-agent/threads/freshclaude/claude/${sessionId}*`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      sessionType: 'freshclaude', provider: 'claude', threadId: sessionId, sessionId,
      revision: 1, latestTurnId: content.at(-1)?.id ?? null, status: 'idle', summary: '',
      capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
      settings: { model: 'claude-opus-4-6', permissionMode: 'default', plugins: [] },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      pendingApprovals: [], pendingQuestions: [], turns: content,
      rolledBackTurns,
      extensions: { claude: { liveSessionId: sessionId, cliSessionId: sessionId } },
    }),
  }))
  await page.evaluate(({ sessionId, paneId, tabId, style }) => {
    const h = window.__FRESHELL_TEST_HARNESS__!
    h.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    h.dispatch({ type: 'panes/initLayout', payload: { tabId, paneId, content: {
      kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', style,
      createRequestId: paneId, sessionId, sessionRef: { provider: 'claude', sessionId },
      resumeSessionId: sessionId, status: 'idle', settingsDismissed: true,
    } } })
    h.dispatch({ type: 'tabs/addTab', payload: { id: tabId, title: 'Synthetic capture', activate: false } })
  }, { sessionId, paneId, tabId, style })
  const pane = page.locator(`[data-pane-shell="true"][data-pane-id="${paneId}"]`)
  const scroller = pane.locator(TRANSCRIPT)
  await expect(scroller).toBeAttached()
  await expect(scroller.locator('article')).toHaveCount(content.length)
  // Articles mount before the lazy Markdown chunk. Wait for its real elements.
  const listTurns = content.filter((turn) => turn.role === 'assistant'
    && turn.items.some((item) => item.kind === 'text' && item.text.includes('**row '))).length
  if (listTurns) await expect(scroller.locator('[data-markdown-body] ul')).toHaveCount(listTurns)
  await page.evaluate(async () => { await document.fonts.ready })
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important }' })
  await settle(page)
  return { paneId, tabId, pane, scroller }
}

async function png(page: Page, info: E2eServerInfo, scope: 'pane' | 'tab' | 'view', id: string) {
  // Node-side fetch permits concurrent browser interaction during capture.
  const response = await fetch(`${info.baseUrl}/api/screenshots`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
    body: JSON.stringify({ scope, ...(scope === 'pane' ? { paneId: id } : scope === 'tab' ? { tabId: id } : {}),
      name: `viewport-${id}-${Date.now()}`, overwrite: true }),
  })
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
  expect(body.status).toBe('ok')
  return { ...body.data, base64: (await readFile(body.data.path)).toString('base64') }
}

async function loadReferenceRenderer(page: Page) {
  await page.addScriptTag({ path: require.resolve('html2canvas/dist/html2canvas.min.js') })
  await page.evaluate(() => {
    // The unmodified full reference renderer also needs compatible CSS spelling,
    // applied only to its own clone. It shares no viewport preparation code.
    ;(window as any).__prepareScreenshotReferenceColors = (doc: Document) => {
      for (const node of doc.querySelectorAll<HTMLElement>('.fresh-agent-transcript-copy, .fresh-agent-composer-input')) {
        const style = doc.defaultView!.getComputedStyle(node)
        for (const property of ['background-image', 'box-shadow']) {
          const value = style.getPropertyValue(property)
          if (!value.includes('color(srgb ')) continue
          node.style.setProperty(property, value.replace(/color\(srgb ([^)]+)\)/g, (_match, channels: string) => {
            const [rgb, alpha = '1'] = channels.split('/').map((part) => part.trim())
            return `rgba(${rgb.split(/\s+/).map((value) => Number(value) * 255).join(', ')}, ${alpha})`
          }))
        }
      }
    }
  })
}

async function reference(page: Page, paneId: string, scope: 'pane' | 'tab' | 'view' = 'pane') {
  await loadReferenceRenderer(page)
  return page.evaluate(async ({ id, scope }) => {
    const selector = scope === 'pane' ? `[data-pane-shell="true"][data-pane-id="${id}"]`
      : scope === 'tab' ? `[data-tab-content-id="${id}"]` : '[data-context="global"]'
    const target = document.querySelector<HTMLElement>(selector)!
    const canvas = await (window as any).html2canvas(target, {
      backgroundColor: null, allowTaint: true, useCORS: true, logging: false,
      scale: Math.max(1, devicePixelRatio || 1),
      onclone: (doc: Document, copy: HTMLElement) => {
        ;(window as any).__prepareScreenshotReferenceColors(doc)
        for (let node: HTMLElement | null = copy; node && node !== copy.ownerDocument.documentElement; node = node.parentElement) node.style.visibility = 'visible'
      },
    })
    const bounds = target.getBoundingClientRect()
    const crops = Array.from(target.querySelectorAll<HTMLElement>('[data-context="fresh-agent-transcript"]'))
      .filter((el) => scope !== 'view' || getComputedStyle(el).visibility !== 'hidden')
      .map((el) => {
        const scroll = el.getBoundingClientRect()
        return { x: scroll.left - bounds.left, y: scroll.top - bounds.top, width: scroll.width, height: scroll.height }
      })
    return { base64: canvas.toDataURL('image/png').split(',')[1],
      crop: crops[0], crops,
      width: canvas.width, height: canvas.height }
  }, { id: paneId, scope })
}

// Stress oracle: measure the ACTUAL large source, then position just its
// visible rows absolutely in the html2canvas copy. This deliberately uses
// neither the production range search nor its spacers/scroll restoration.
async function viewportReference(page: Page, paneId: string) {
  await loadReferenceRenderer(page)
  return page.evaluate(async (paneId) => {
    const pane = document.querySelector<HTMLElement>(`[data-pane-shell="true"][data-pane-id="${paneId}"]`)!
    const scroll = pane.querySelector<HTMLElement>('[data-context="fresh-agent-transcript"]')!
    const p = pane.getBoundingClientRect(), s = scroll.getBoundingClientRect()
    const rows = Array.from(scroll.children) as HTMLElement[]
    const measured = rows.map((row) => ({ row, box: row.getBoundingClientRect() }))
      .filter(({ box }) => box.bottom > s.top + scroll.clientTop && box.top < s.top + scroll.clientTop + scroll.clientHeight)
      .map(({ row, box }) => {
        const style = getComputedStyle(row)
        return { row, box, css: Array.from(style, (key) => [key, style.getPropertyValue(key)]) }
      })
    if (!measured.length) throw new Error('stress oracle has no live visible rows')
    const kept = new Set(measured.map(({ row }) => row)), omitted = new Set<Element>()
    for (const row of rows) if (!kept.has(row)) omitted.add(row)
    for (const other of document.querySelectorAll('[data-pane-shell="true"]')) {
      if (other !== pane) for (const child of other.children) omitted.add(child)
    }
    const canvas = await (window as any).html2canvas(pane, {
      backgroundColor: null, allowTaint: true, useCORS: true, logging: false, scale: Math.max(1, devicePixelRatio || 1),
      ignoreElements: (el: Element) => omitted.has(el),
      onclone: (doc: Document, copy: HTMLElement) => {
        ;(window as any).__prepareScreenshotReferenceColors(doc)
        for (let node: HTMLElement | null = copy; node && node !== copy.ownerDocument.documentElement; node = node.parentElement) node.style.visibility = 'visible'
        const dest = copy.querySelector<HTMLElement>('[data-context="fresh-agent-transcript"]')!
        Object.assign(dest.style, { position: 'relative', display: 'block', boxSizing: 'border-box',
          width: `${s.width}px`, height: `${s.height}px`, flex: 'none', overflow: 'hidden' })
        Array.from(dest.children).forEach((row, i) => {
          const { box, css } = measured[i], el = row as HTMLElement
          for (const [key, value] of css) el.style.setProperty(key, value)
          Object.assign(el.style, { position: 'absolute', margin: '0', visibility: 'visible', boxSizing: 'border-box',
            left: `${box.left - s.left - scroll.clientLeft}px`, top: `${box.top - s.top - scroll.clientTop}px`,
            width: `${box.width}px`, height: `${box.height}px` })
        })
        dest.scrollTop = 0; dest.scrollLeft = 0
      },
    })
    const crop = { x: s.left - p.left, y: s.top - p.top, width: s.width, height: s.height }
    return { base64: canvas.toDataURL('image/png').split(',')[1], width: canvas.width, height: canvas.height,
      crop, crops: [crop],
      rows: measured.map(({ row, box }) => ({ text: row.textContent, top: box.top - s.top, height: box.height })) }
  }, paneId)
}

async function compare(page: Page, actual: string, expected: Awaited<ReturnType<typeof reference>> & {
  actualCrop?: { x: number; y: number; width: number; height: number }
}) {
  return page.evaluate(async ({ actual, expected }) => {
    const decode = async (base64: string, c: { x: number; y: number; width: number; height: number }) => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0)
      const s = Math.max(1, devicePixelRatio || 1)
      return { bytes: ctx.getImageData(Math.ceil(c.x * s), Math.ceil(c.y * s), Math.floor(c.width * s) - 1, Math.floor(c.height * s) - 1).data,
        width: image.width, height: image.height }
    }
    const a = await decode(actual, expected.actualCrop ?? expected.crop), b = await decode(expected.base64, expected.crop)
    let different = 0
    for (let i = 0; i < a.bytes.length; i++) if (a.bytes[i] !== b.bytes[i]) different++
    return { different, width: a.width, height: a.height }
  }, { actual, expected })
}

for (const style of ['serif', 'mono'] as const) {
  test(`ordinary viewport matches html2canvas at top middle bottom (${style})`, async ({ freshellPage: _p, page, serverInfo, terminal }, testInfo) => {
    await terminal.waitForTerminal()
    const content = turns(18)
    // Exercise continuation margins and the original first-child styling.
    for (const index of [2, 4, 8, 10, 14, 16]) content[index].role = 'assistant'
    content[17] = { ...content[17], summary: 'Synthetic tail caption', summaryKind: 'echo',
      items: [{ id: 'tail-tool', kind: 'dynamic_tool', tool: 'synthetic_tool', status: 'completed', arguments: {} }] }
    const fixture = await mountTranscript(page, content, style, [{
      ...turns(1)[0], summary: 'Synthetic rolled-back turn', items: [], rolledBack: true, restorable: true,
    }])
    await expect(fixture.scroller.locator('[data-turn-continuation="true"]')).not.toHaveCount(0)
    await expect(fixture.scroller.locator('[data-testid="fresh-agent-tail-caption"]')).toHaveText('Synthetic tail caption')
    await expect(fixture.scroller.getByRole('region', { name: 'Rolled back turns', includeHidden: true })).toBeAttached()
    const visibility = await fixture.pane.evaluate((el) => {
      const chain: string[] = []
      for (let node: HTMLElement | null = el; node; node = node.parentElement) chain.push(node.getAttribute('style') ?? '')
      return chain
    })
    for (const fraction of [0, 0.47, 1]) {
      await fixture.scroller.evaluate((el, fraction) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction }, fraction)
      await settle(page)
      const offsets = await fixture.scroller.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }))
      const shot = await png(page, serverInfo, 'pane', fixture.paneId)
      const expected = await reference(page, fixture.paneId)
      await testInfo.attach(`${style}-${fraction}-actual`, { body: Buffer.from(shot.base64, 'base64'), contentType: 'image/png' })
      await testInfo.attach(`${style}-${fraction}-reference`, { body: Buffer.from(expected.base64, 'base64'), contentType: 'image/png' })
      expect(await compare(page, shot.base64, expected)).toEqual({ different: 0, width: expected.width, height: expected.height })
      expect(await fixture.scroller.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }))).toEqual(offsets)
      expect(await fixture.pane.evaluate((el) => {
        const chain: string[] = []
        for (let node: HTMLElement | null = el; node; node = node.parentElement) chain.push(node.getAttribute('style') ?? '')
        return chain
      })).toEqual(visibility)
    }
  })
}

test('30k background transcript excludes unrelated history and preserves live interaction', async ({ freshellPage: _p, page, serverInfo, terminal }, testInfo) => {
  test.setTimeout(120_000)
  await terminal.waitForTerminal()
  const all = turns(600)
  const large = await mountTranscript(page, all)
  const unrelated = await mountTranscript(page, turns(600))
  await unrelated.pane.evaluate((pane) => {
    const editor = document.createElement('section')
    editor.dataset.testid = 'unrelated-large-editor'
    const fragment = document.createDocumentFragment()
    for (let i = 0; i < 30000; i++) { const span = document.createElement('span'); span.textContent = `editor_${i}`; fragment.appendChild(span) }
    editor.appendChild(fragment); pane.appendChild(editor)
  })
  expect(await large.pane.locator('*').count()).toBeGreaterThanOrEqual(30000)
  await expect(large.pane.getByRole('group', { name: 'Transcript minimap', includeHidden: true })).toBeAttached()
  expect(await unrelated.pane.locator('*').count()).toBeGreaterThanOrEqual(30000)
  await large.scroller.evaluate((scroll) => {
    const row = scroll.querySelector<HTMLElement>('[data-turn-index="300"]')!
    scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 23
  })
  await page.evaluate(() => {
    const input = document.createElement('textarea')
    input.id = 'viewport-foreground-input'; input.value = 'keep selection'
    input.style.cssText = 'position:fixed;top:1px;left:1px;z-index:99999;width:120px;height:30px'
    document.body.appendChild(input); input.focus(); input.setSelectionRange(2, 6)
  })
  for (const position of ['middle', 'bottom'] as const) {
    if (position === 'bottom') await large.scroller.evaluate((scroll) => { scroll.scrollTop = scroll.scrollHeight })
    await settle(page)
    const expected = await viewportReference(page, large.paneId)
    expect(expected.rows.some((row) => row.text?.includes(`Viewport row ${position === 'middle' ? 300 : 599}`))).toBe(true)
    if (position === 'middle') expect(expected.rows[0].top).toBeLessThan(0)
    await page.evaluate(() => {
      const w = window as any, input = document.activeElement as HTMLTextAreaElement
      const h = window.__FRESHELL_TEST_HARNESS__!
      const sources = Array.from(document.querySelectorAll<HTMLElement>('[data-context="fresh-agent-transcript"]'))
      const original = sources.map((el) => [el.scrollTop, el.scrollLeft])
      const state = () => { const s = h.getState(); return JSON.stringify([s.tabs.activeTabId, s.panes.activePane]) }
      const selected = state(), selection = [input.selectionStart, input.selectionEnd, input.selectionDirection]
      const errors: string[] = [], windowScroll = [window.scrollX, window.scrollY]
      let stopped = false, last = performance.now(), maxGap = 0, raf = 0
      const check = () => {
        if (document.activeElement !== input) errors.push('focus')
        if (state() !== selected) errors.push('tab/pane')
        if (JSON.stringify([input.selectionStart, input.selectionEnd, input.selectionDirection]) !== JSON.stringify(selection)) errors.push('selection')
        if (sources.some((el, i) => el.scrollTop !== original[i][0] || el.scrollLeft !== original[i][1])) errors.push('transcript-scroll')
        if (window.scrollX !== windowScroll[0] || window.scrollY !== windowScroll[1]) errors.push('window-scroll')
      }
      const onFocus = () => check(), onScroll = () => check()
      document.addEventListener('focusin', onFocus, true); document.addEventListener('scroll', onScroll, true)
      const statePoll = setInterval(check, 10)
      const tick = () => { if (stopped) return; const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; check(); raf = requestAnimationFrame(tick) }
      raf = requestAnimationFrame(tick)
      w.__viewportCaptureObservation = { stop: () => {
        stopped = true; cancelAnimationFrame(raf); clearInterval(statePoll); check()
        document.removeEventListener('focusin', onFocus, true); document.removeEventListener('scroll', onScroll, true)
        delete w.__viewportCaptureObservation
        return { errors, maxGap, original, windowScroll }
      } }
    })
    let observations: any
    const started = Date.now()
    let shot: Awaited<ReturnType<typeof png>>
    try { shot = await png(page, serverInfo, 'pane', large.paneId) }
    finally { observations = await page.evaluate(() => (window as any).__viewportCaptureObservation.stop()) }
    const elapsed = Date.now() - started
    const metrics = { elapsed, ...observations,
      backend: process.env.CLOUD_RUN_JOB ? 'cloud' : 'local', test: testInfo.title, position,
      visibleRows: expected.rows.map(({ top, height }) => ({ top, height })),
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })),
      targetElements: await large.pane.locator('*').count(), unrelatedElements: await unrelated.pane.locator('*').count() }
    console.log(JSON.stringify({ severity: 'info', event: 'viewport_screenshot_metrics', ...metrics }))
    await testInfo.attach(`30k-${position}-metrics`, { body: JSON.stringify(metrics), contentType: 'application/json' })
    await testInfo.attach(`30k-${position}-actual`, { body: Buffer.from(shot.base64, 'base64'), contentType: 'image/png' })
    await testInfo.attach(`30k-${position}-reference`, { body: Buffer.from(expected.base64, 'base64'), contentType: 'image/png' })
    expect(observations.errors).toEqual([])
    expect(elapsed).toBeLessThan(10000)
    expect(await compare(page, shot.base64, expected)).toEqual({ different: 0, width: expected.width, height: expected.height })
  }
  const duringCapture = png(page, serverInfo, 'pane', large.paneId)
  await page.keyboard.insertText('Z')
  await duringCapture
  await expect(page.locator('#viewport-foreground-input')).toHaveValue('keZelection')
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('viewport-foreground-input')
})

test('tab and view capture preserve two independently scrolled transcripts', async ({ freshellPage: _p, page, serverInfo, terminal }) => {
  await terminal.waitForTerminal()
  const first = await mountTranscript(page, turns(18))
  const second = await mountTranscript(page, turns(18), 'mono')
  await page.evaluate(({ first, second }) => {
    const h = window.__FRESHELL_TEST_HARNESS__!
    const content = (h.getState().panes.layouts[second] as any).content
    h.setFreshAgentNetworkEffectsSuppressed('viewport-split', true)
    h.dispatch({ type: 'panes/splitPane', payload: { tabId: first.tabId, paneId: first.paneId,
      direction: 'horizontal', newPaneId: 'viewport-split', newContent: content } })
  }, { first: { tabId: first.tabId, paneId: first.paneId }, second: second.tabId })
  await expect(page.locator('[data-pane-shell="true"][data-pane-id="viewport-split"] article')).toHaveCount(18)
  const tab = page.locator(`[data-tab-content-id="${first.tabId}"]`)
  await tab.locator(TRANSCRIPT).nth(0).evaluate((el) => { el.scrollTop = el.scrollHeight * 0.31 })
  await tab.locator(TRANSCRIPT).nth(1).evaluate((el) => { el.scrollTop = el.scrollHeight * 0.67 })
  await settle(page)
  const expectedTab = await reference(page, first.tabId, 'tab')
  const shotTab = await png(page, serverInfo, 'tab', first.tabId)
  expect(expectedTab.crops).toHaveLength(2)
  for (const crop of expectedTab.crops) expect((await compare(page, shotTab.base64, { ...expectedTab, crop })).different).toBe(0)
  await page.evaluate((tabId) => window.__FRESHELL_TEST_HARNESS__!.dispatch({ type: 'tabs/setActiveTab', payload: tabId }), first.tabId)
  await settle(page)
  const expectedView = await reference(page, '', 'view')
  const shotView = await png(page, serverInfo, 'view', '')
  expect(expectedView.crops).toHaveLength(2)
  for (const crop of expectedView.crops) expect((await compare(page, shotView.base64, { ...expectedView, crop })).different).toBe(0)
})
