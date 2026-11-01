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
  await expect(scroller.locator('article')).toHaveCount(content.length, { timeout: 60_000 })
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

function giantCode(): FreshAgentTurn[] {
  const lines = Array.from({ length: 8000 }, (_, i) => i % 5 === 0 ? ''
    : `${i % 3 === 0 ? '\t\t' : '\t'}const line_${String(i).padStart(5, '0')} = "${i}: visible code sentinel";`)
  return [{ id: 'giant', turnId: 'giant', role: 'assistant', summary: 'Synthetic giant code',
    items: [{ id: 'giant-text', kind: 'text', text: '```ts\n' + lines.join('\n') + '\n```' }] }]
}

function wrappedTool(): FreshAgentTurn[] {
  const long = Array.from({ length: 2000 }, (_, i) => `token_${String(i).padStart(5, '0')}`).join(' ')
  return [{ id: 'wrapped', turnId: 'wrapped', role: 'assistant', summary: 'Synthetic wrapped tool', items: [
    { id: 'use', kind: 'tool_use', toolUseId: 'wrap-use', name: 'Bash', input: { command: 'synthetic output' } },
    { id: 'result', kind: 'tool_result', toolUseId: 'wrap-use', isError: false,
      content: `first line\n\n\t${long}\n${'UNBROKEN'.repeat(100)}\nlast line` },
  ] }]
}

for (const width of [1000, 520]) {
  test(`wrapped tool output matches html2canvas at nested scroll (${width})`, async ({ freshellPage: _p, page, serverInfo, terminal }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await terminal.waitForTerminal()
    const fixture = await mountTranscript(page, wrappedTool())
    if (width === 520) {
      await page.evaluate(({ tabId, paneId }) => {
        const h = window.__FRESHELL_TEST_HARNESS__!
        const content = (h.getState().panes.layouts[tabId] as any).content
        h.setFreshAgentNetworkEffectsSuppressed('wrapped-narrow-split', true)
        h.dispatch({ type: 'panes/splitPane', payload: { tabId, paneId, direction: 'horizontal',
          newPaneId: 'wrapped-narrow-split', newContent: content } })
      }, { tabId: fixture.tabId, paneId: fixture.paneId })
      await expect(page.locator('[data-pane-id="wrapped-narrow-split"] article').first()).toBeAttached()
    }
    // Open the real activity strip in the hidden fixture. Its single tool
    // starts expanded; clicking the tool button would close the output.
    const activity = fixture.pane.getByRole('button', { name: 'Toggle activity details', includeHidden: true })
    if (await activity.getAttribute('aria-expanded') === 'false') await activity.evaluate((button: HTMLElement) => button.click())
    const output = fixture.pane.locator('pre[data-tool-output]')
    await expect(output).toBeAttached()
    await output.evaluate((pre: HTMLElement) => { pre.scrollTop = (pre.scrollHeight - pre.clientHeight) * 0.53 })
    await fixture.scroller.evaluate((scroll) => {
      const pre = scroll.querySelector<HTMLElement>('pre[data-tool-output]')!
      // Add test-owned below-content space if required so the outer clip can
      // cut through this actual nested tool viewport rather than clamping.
      const tail = document.createElement('div'); tail.style.cssText = 'height:1200px;flex:none'; scroll.appendChild(tail)
      scroll.scrollTop += pre.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 35
    })
    await settle(page)
    const before = await output.evaluate((pre) => ({ top: pre.scrollTop, text: pre.textContent, whiteSpace: getComputedStyle(pre).whiteSpace }))
    expect(before.top).toBeGreaterThan(0)
    expect(before.whiteSpace).toBe('pre-wrap')
    const expected = await reference(page, fixture.paneId)
    const shot = await png(page, serverInfo, 'pane', fixture.paneId)
    expect(await compare(page, shot.base64, expected)).toEqual({ different: 0, width: expected.width, height: expected.height })
    expect(await output.evaluate((pre) => ({ top: pre.scrollTop, text: pre.textContent, whiteSpace: getComputedStyle(pre).whiteSpace }))).toEqual(before)
    await testInfo.attach(`wrapped-${width}-actual`, { body: Buffer.from(shot.base64, 'base64'), contentType: 'image/png' })
    await testInfo.attach(`wrapped-${width}-reference`, { body: Buffer.from(expected.base64, 'base64'), contentType: 'image/png' })
  })
}

async function codeReference(page: Page, paneId: string) {
  await page.addScriptTag({ path: require.resolve('html2canvas/dist/html2canvas.min.js') })
  return page.evaluate(async (paneId) => {
    const pane = document.querySelector<HTMLElement>(`[data-pane-shell="true"][data-pane-id="${paneId}"]`)!
    const pre = pane.querySelector<HTMLElement>('pre')!, code = pre.querySelector<HTMLElement>('code')!
    const scroll = pane.querySelector<HTMLElement>('[data-context="fresh-agent-transcript"]')!
    const r = pre.getBoundingClientRect(), s = scroll.getBoundingClientRect(), p = pane.getBoundingClientRect()
    const clip = { left: Math.max(r.left + pre.clientLeft, s.left + scroll.clientLeft, p.left),
      top: Math.max(r.top + pre.clientTop, s.top + scroll.clientTop, p.top),
      right: Math.min(r.left + pre.clientLeft + pre.clientWidth, s.left + scroll.clientLeft + scroll.clientWidth, p.right),
      bottom: Math.min(r.top + pre.clientTop + pre.clientHeight, s.top + scroll.clientTop + scroll.clientHeight, p.bottom) }
    const cs = getComputedStyle(code), ps = getComputedStyle(pre)
    const parent = pre.parentElement!, parentBox = parent.getBoundingClientRect(), parentStyle = getComputedStyle(parent)
    const corner = parseFloat(parentStyle.borderBottomLeftRadius) || 0
    // This plain reference has no enclosing rounded border. Compare its
    // rectangular interior exactly, retaining the entire vertical clip for
    // partial first/last lines, and separately verify the source clip bounds.
    const inset = parentStyle.overflow === 'hidden'
      && clip.bottom >= parentBox.bottom - (parseFloat(parentStyle.borderBottomWidth) || 0) ? Math.ceil(corner) : 0
    const lines = pre.textContent!.split('\n')
    const nodes: { node: Text; start: number; end: number }[] = []
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
    let total = 0, node: Node | null
    while ((node = walker.nextNode())) {
      nodes.push({ node: node as Text, start: total, end: total + node.textContent!.length })
      total += node.textContent!.length
    }
    const glyphs: { line: number; char: number; top: number; bottom: number; left: number }[] = []
    let offset = 0, cursor = 0
    lines.forEach((line, index) => {
      const char = line.search(/\S/)
      if (char >= 0) {
        const at = offset + char
        while (nodes[cursor].end <= at) cursor++
        const range = document.createRange(), part = nodes[cursor]
        range.setStart(part.node, at - part.start); range.setEnd(part.node, at - part.start + 1)
        const box = range.getBoundingClientRect()
        glyphs.push({ line: index, char, top: box.top, bottom: box.bottom, left: box.left })
      }
      offset += line.length + 1
    })
    const visible = glyphs.filter((glyph) => glyph.bottom > clip.top && glyph.top < clip.bottom)
    if (!visible.length) throw new Error('code oracle has no live visible glyphs')
    const first = Math.max(0, visible[0].line - 2), last = Math.min(lines.length, visible.at(-1)!.line + 3)
    const visibleText = lines.slice(first, last).join('\n')
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;left:-20000px;top:0;border:0;width:2000px;height:2000px'
    document.body.appendChild(frame)
    try {
      const d = frame.contentDocument!
      const ready: Promise<void>[] = []
      for (const source of document.head.querySelectorAll('style,link[rel="stylesheet"]')) {
        const node = d.importNode(source, true)
        if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'LINK') {
          const link = node as HTMLLinkElement
          link.href = (source as HTMLLinkElement).href
          ready.push(new Promise<void>((resolve, reject) => { link.onload = () => resolve(); link.onerror = () => reject(new Error('oracle stylesheet failed')) }))
        }
        d.head.appendChild(node)
      }
      await Promise.all(ready)
      d.body.style.margin = '0'
      const root = d.createElement('div'), clipped = d.createElement('div'), copy = d.createElement('pre'), text = d.createElement('span')
      const width = clip.right - clip.left, height = clip.bottom - clip.top
      const viewport = { x: clip.left - p.left, y: clip.top - p.top, width, height }
      const crop = { ...viewport, x: viewport.x + inset, width: width - inset }
      // Keep the source pane's pixel origin. Cropping a fractional clip into
      // a new (0,0) canvas changes html2canvas's glyph rasterization phase.
      root.style.cssText = `position:relative;overflow:hidden;width:${p.width}px;height:${p.height}px`
      for (let ancestor: HTMLElement | null = pre.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const color = getComputedStyle(ancestor).backgroundColor
        if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { root.style.backgroundColor = color; break }
      }
      clipped.style.cssText = `position:absolute;overflow:hidden;left:${viewport.x}px;top:${viewport.y}px;width:${width}px;height:${height}px`
      root.appendChild(clipped)
      const apply = (dest: HTMLElement, style: CSSStyleDeclaration) => {
        for (const property of style) dest.style.setProperty(property, style.getPropertyValue(property))
      }
      apply(copy, ps); apply(text, cs)
      Object.assign(copy.style, { visibility: 'visible', position: 'absolute', boxSizing: 'border-box', margin: '0',
        left: `${r.left - clip.left}px`, top: `${r.top - clip.top}px`, width: `${r.width}px`, height: `${r.height}px`, overflow: 'hidden' })
      Object.assign(text.style, { visibility: 'visible', position: 'absolute', margin: '0', padding: '0', border: '0', whiteSpace: 'pre',
        top: '0', left: '0' })
      text.textContent = visibleText; copy.appendChild(text)
      clipped.appendChild(copy)
      d.body.appendChild(root)
      await d.fonts.ready
      const glyphRect = (glyph: typeof visible[number]) => {
        const at = lines.slice(first, glyph.line).reduce((n, line) => n + line.length + 1, 0) + glyph.char
        const range = d.createRange()
        range.setStart(text.firstChild!, at); range.setEnd(text.firstChild!, at + 1)
        return range.getBoundingClientRect()
      }
      const anchor = visible[0], initial = glyphRect(anchor), rootBox = root.getBoundingClientRect()
      text.style.top = `${anchor.top - p.top - (initial.top - rootBox.top)}px`
      text.style.left = `${anchor.left - p.left - (initial.left - rootBox.left)}px`
      const sentinels = [visible[0], visible[Math.floor(visible.length / 2)], visible.at(-1)!].map((glyph) => {
        const actual = glyphRect(glyph), bounds = root.getBoundingClientRect()
        return { line: glyph.line, sourceTop: glyph.top - clip.top, referenceTop: actual.top - bounds.top - viewport.y,
          sourceLeft: glyph.left - clip.left, referenceLeft: actual.left - bounds.left - viewport.x }
      })
      const canvas = await (window as any).html2canvas(root, { backgroundColor: null, scale: Math.max(1, devicePixelRatio || 1), logging: false })
      return { base64: canvas.toDataURL('image/png').split(',')[1], crop, crops: [crop], width: canvas.width, height: canvas.height,
        actualCrop: crop, viewport, clipping: { inset, radius: corner, overflow: parentStyle.overflow }, first, last, sentinels,
        blankLines: lines.slice(visible[0].line, visible.at(-1)!.line + 1).filter((line) => !line.length).length,
        hasTabs: lines.slice(first, last).some((line) => line.startsWith('\t')),
        offsets: [scroll.scrollTop, pre.scrollTop, pre.scrollLeft] }
    } finally { frame.remove() }
  }, paneId)
}

for (const internal of [false, true]) {
  test(internal ? 'giant internally scrolled code preserves partial lines and horizontal offset'
    : 'giant natural-height code captures middle and bottom visible lines', async ({ freshellPage: _p, page, serverInfo, terminal }, testInfo) => {
    test.setTimeout(120_000)
    await terminal.waitForTerminal()
    const fixture = await mountTranscript(page, giantCode())
    const pre = fixture.pane.locator('pre')
    await expect(pre).toBeAttached({ timeout: 60_000 })
    expect(await pre.locator('*').count()).toBeGreaterThanOrEqual(30000)
    for (const fraction of [0.53, 0.97]) {
      await pre.evaluate((pre: HTMLElement, { internal, fraction }) => {
        const scroll = pre.closest<HTMLElement>('[data-context="fresh-agent-transcript"]')!
        if (internal) {
          pre.style.height = '192px'; pre.style.overflow = 'auto'
          pre.scrollTop = (pre.scrollHeight - pre.clientHeight) * fraction + 13
          scroll.scrollTop = 0
        } else {
          // Also cross the browser's large-position precision boundary
          // in this same real highlighted block, without extra source content.
          if (fraction > 0.9) {
            pre.style.lineHeight = '40px'
            pre.querySelector<HTMLElement>('code')!.style.lineHeight = '40px'
          }
          scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * fraction + 3
        }
        // Ensure real horizontal overflow without changing highlighted text.
        pre.style.width = '220px'; pre.style.overflowX = 'auto'; pre.scrollLeft = 37
      }, { internal, fraction })
      await settle(page)
      const expected = await codeReference(page, fixture.paneId)
      expect(expected.first).toBeGreaterThan(100)
      expect(expected.blankLines).toBeGreaterThan(0)
      expect(expected.hasTabs).toBe(true)
      expect(expected.offsets[2]).toBe(37)
      expect(expected.viewport.width).toBe(220)
      expect(expected.clipping).toEqual({ inset: internal ? 6 : 0, radius: 6, overflow: 'hidden' })
      if (internal) expect(expected.viewport.height).toBe(192)
      else expect(expected.viewport.height).toBeGreaterThan(192)
      for (const glyph of expected.sentinels) {
        expect(glyph.referenceTop).toBeCloseTo(glyph.sourceTop, 2)
        expect(glyph.referenceLeft).toBeCloseTo(glyph.sourceLeft, 2)
      }
      expect(expected.offsets[1] === 0).toBe(!internal)
      const before = await pre.evaluate((pre: HTMLElement) => ({ height: pre.getBoundingClientRect().height, top: pre.scrollTop, left: pre.scrollLeft }))
      const started = Date.now(), shot = await png(page, serverInfo, 'pane', fixture.paneId)
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(10000)
      const difference = await compare(page, shot.base64, expected)
      console.log(JSON.stringify({ severity: 'info', event: 'code_screenshot_metrics', internal, fraction, elapsed, first: expected.first, last: expected.last, offsets: expected.offsets, sentinels: expected.sentinels, crop: expected.actualCrop, height: before.height, clipping: expected.clipping, different: difference.different }))
      await testInfo.attach(`code-${internal}-${fraction}-actual`, { body: Buffer.from(shot.base64, 'base64'), contentType: 'image/png' })
      await testInfo.attach(`code-${internal}-${fraction}-reference`, { body: Buffer.from(expected.base64, 'base64'), contentType: 'image/png' })
      expect(difference.different).toBe(0)
      expect(await pre.evaluate((pre: HTMLElement) => ({ height: pre.getBoundingClientRect().height, top: pre.scrollTop, left: pre.scrollLeft }))).toEqual(before)
      expect(await pre.evaluate((pre: HTMLElement) => [pre.closest<HTMLElement>('[data-context="fresh-agent-transcript"]')!.scrollTop, pre.scrollTop, pre.scrollLeft])).toEqual(expected.offsets)
    }
  })
}
