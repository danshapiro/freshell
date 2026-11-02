import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { FreshAgentSnapshotSchema } from '../../../shared/fresh-agent-contract.js'
import { openPanePicker } from '../helpers/pane-picker.js'

async function enableFreshClientsAndOpencode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: true, opencode: true },
    })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: {
        codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
        freshAgent: { enabled: true },
      },
    })
  })
}

function freshAgentSnapshot(sessionType: string, provider: string, threadId: string) {
  return {
    sessionType,
    provider,
    threadId,
    sessionId: threadId,
    revision: 1,
    latestTurnId: null,
    status: 'idle',
    capabilities: {
      send: true,
      interrupt: true,
      approvals: true,
      questions: true,
      fork: true,
    },
    settings: {
      model: 'opencode-go/glm-5.2',
      permissionMode: undefined,
      plugins: [],
    },
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    pendingApprovals: [],
    pendingQuestions: [],
    turns: [],
  }
}

/** Serve schema-validated snapshots and expose request hits as a setup gate. */
async function routeThreads(page: Page, overrides?: Record<string, unknown> | (() => Record<string, unknown>)): Promise<() => number> {
  let hits = 0
  await page.route('**/api/fresh-agent/threads/**', async (route) => {
    const url = new URL(route.request().url())
    const [, sessionType = 'freshopencode', provider = 'opencode', threadId = 'ses_e2e'] =
      url.pathname.match(/\/api\/fresh-agent\/threads\/([^/]+)\/([^/]+)\/([^/?]+)/) ?? []
    hits += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FreshAgentSnapshotSchema.parse({
        ...freshAgentSnapshot(sessionType, provider, decodeURIComponent(threadId)),
        ...(typeof overrides === 'function' ? overrides() : overrides ?? {}),
      })),
    })
  })
  return () => hits
}

async function routeFileApis(page: Page, cwd: string): Promise<void> {
  await page.route('**/api/files/candidate-dirs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ directories: ['/tmp'] }),
    })
  })
  await page.route('**/api/files/validate-dir', async (route) => {
    const body = route.request().postDataJSON() as { path?: string }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, resolvedPath: body?.path ?? cwd }),
    })
  })
}

/** Create the neutral pane through the production picker, with every
 * provider effect suppressed before selection. The target identity is handed
 * off once, below, after the picker replaces its leaf. */
async function createFreshopencodePane(page: Page, cwd: string): Promise<void> {
  // Suppress ALL fresh-agent network effects BEFORE the pane exists: creation
  // fires its session-create effect immediately, and a per-pane flag set after
  // the fact races it — livelocked as "Fresh clients are disabled" (server
  // rejection of the unsuppressed request) followed by a stuck `ended` state.
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.setSuppressAllFreshAgentNetworkEffects(true)
  })
  const picker = await openPanePicker(page)
  await expect(picker.getByRole('button', { name: /^Freshopencode$/i })).toBeVisible({ timeout: 10_000 })
  await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })
  const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })

  // The scenario assigns its target session in seedCompactPane. Keeping the
  // neutral picker result unassigned prevents a competing neutral snapshot.
}

type Variant = { sessionType: string; provider: string; style: 'sans' | 'serif' | 'mono'; theme: 'light' | 'dark'; populated?: boolean; scale?: number; snapshot?: Record<string, unknown> }
const patch = 'diff --git a/file-0.ts b/file-0.ts\n--- a/file-0.ts\n+++ b/file-0.ts\n@@ -1 +1 @@\n-old\n+new'
function latestUserTurn() {
  return { id: 'user-1', turnId: 'user-1', role: 'user', summary: '', items: [{ id: 'message-1', kind: 'text', text: 'Latest prompt must remain readable' }] }
}

async function seedCompactPane(page: Page, variant: Variant): Promise<{ update: (changes: Record<string, unknown>) => Promise<void> }> {
  await enableFreshClientsAndOpencode(page)
  await routeFileApis(page, '/tmp')
  await page.route('**/api/fresh-agent/model-capabilities/**', route => {
    const sessionType = new URL(route.request().url()).pathname.split('/').at(-1)!
    const runtimeProvider = sessionType === 'freshcodex' ? 'codex' : sessionType === 'freshopencode' ? 'opencode' : 'claude'
    return route.fulfill({ json: { ok: true, sessionType, runtimeProvider, status: 'fresh', fetchedAt: Date.now(), models: [] } })
  })
  const diffs = variant.provider === 'opencode' ? [] : Array.from({ length: 30 }, (_, i) => ({ id: `change-${i}`, path: `/tmp/file-${i}.ts`, status: 'modified', title: `file-${i}.ts` }))
  let current: Record<string, unknown> = {
    extensions: { [variant.provider]: { statusFromLiveState: true, ownerKind: 'fresh-agent' } },
    diffs: variant.provider === 'codex' ? [...diffs, { id: 'codex-turn:latest', title: 'Turn changes', diff: patch }] : diffs,
    worktrees: variant.populated ? Array.from({ length: 12 }, (_, i) => ({ id: `wt-${i}`, path: `/tmp/branch-${i}`, branch: `feature/${i}` })) : [],
    pendingApprovals: [{ requestId: 'long-command', toolName: 'Bash', input: { command: 'printf long-argument '.repeat(1000) } }],
    pendingQuestions: [{ requestId: 'question-1', questions: [{ question: 'Continue?', header: 'Confirm', options: [{ label: 'Yes', description: 'Continue' }, { label: 'No', description: 'Stop' }], multiSelect: false }] }],
    pendingElicitations: [{ requestId: 'elicitation-1', mode: 'form', serverName: 'Fixture', message: 'Enter a name', fields: [{ id: 'name', title: 'Name', type: 'string', required: true }] }],
    turns: [latestUserTurn()],
    ...variant.snapshot,
  }
  const hits = await routeThreads(page, () => current)
  await page.route('**/api/fresh-agent/diff**', route => route.fulfill({ json: { diff: patch } }))
  await createFreshopencodePane(page, '/tmp')
  await page.evaluate(v => {
    const h = window.__FRESHELL_TEST_HARNESS__!
    const s = h.getState(); const tabId = s.tabs.activeTabId!
    type Node = { id: string; type: string; content?: Record<string, unknown>; children?: Node[] }
    const find = (n: Node): Node | undefined => n.content?.kind === 'fresh-agent' ? n : n.children?.map(find).find(Boolean)
    const leaf = find(s.panes.layouts[tabId] as Node)!
    h.dispatch({ type: 'panes/resetLayout', payload: { tabId, content: leaf.content } })
    const freshId = h.getState().panes.activePane[tabId]
    // Claude runtime handles may be synthetic, but the production history
    // reader requires a canonical durable UUID in the saved session ref.
    const durableId = v.provider === 'claude' ? '55555555-5555-4555-8555-555555555555' : `compact-${v.sessionType}`
    h.dispatch({ type: 'settings/updateSettingsLocal', payload: { theme: v.theme, uiScale: v.scale ?? 1 } })
    h.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId: freshId, content: { ...leaf.content, createRequestId: `compact-create-${v.sessionType}`, status: 'idle', sessionType: v.sessionType, provider: v.provider, sessionId: `compact-${v.sessionType}`, sessionRef: { provider: v.provider, sessionId: durableId }, resumeSessionId: durableId, style: v.style, settingsDismissed: true, reconcileNotice: 'Session restored', createError: { message: 'Detailed create diagnostic '.repeat(200), retryable: true } } } })
  }, variant)
  await expect(page.locator('.fresh-agent-pane:not(.fresh-agent-diff-drawer-overlay)')).toHaveAttribute('data-session-id', `compact-${variant.sessionType}`)
  await expect(page.locator('.fresh-agent-pane:not(.fresh-agent-diff-drawer-overlay)')).toHaveAttribute('data-style', variant.style)
  if (variant.theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
  await expect.poll(() => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')))).toBe(variant.scale ?? 1)
  await expect(page.getByText('Latest prompt must remain readable', { exact: true })).toBeVisible()
  await expect.poll(hits).toBeGreaterThan(0)
  // Codex retains its Usage metadata even when the worktree list is empty.
  await expect(page.locator('.fresh-agent-sidebar')).toHaveCount(variant.populated || variant.provider === 'codex' ? 1 : 0)
  await expect(page.locator('[data-agent-error="session"]')).toHaveCount(0)
  if (!variant.snapshot) {
    if (variant.provider === 'opencode') await expect(page.getByRole('button', { name: /^Diffs:/ })).toHaveCount(0)
    else await expect(page.getByRole('button', { name: 'Diffs: 30 changed files' })).toBeVisible()
  }
  return { update: async changes => {
    const previousHits = hits()
    current = { ...current, ...changes, revision: Number(current.revision ?? 1) + 1 }
    await page.evaluate(v => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({ type: 'freshAgent.event', sessionId: `compact-${v.sessionType}`, sessionType: v.sessionType, provider: v.provider, event: { type: 'freshAgent.session.snapshot', status: 'idle', revision: v.revision } }), { ...variant, revision: Number(current.revision) })
    await expect.poll(hits).toBeGreaterThan(previousHits)
  } }
}

async function measureUsefulSpace(page: Page) {
  const root = page.locator('.fresh-agent-pane:not(.fresh-agent-diff-drawer-overlay)').last()
  const geometry = await root.evaluate(node => {
    const box = (selector: string) => node.querySelector(selector)!.getBoundingClientRect()
    const bounds = (rect: DOMRect) => ({ x: rect.x, y: rect.y, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })
    const hitDetails = (control: Element) => {
      const rect = control.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return {
        name: (control as HTMLElement).getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName,
        bounds: bounds(rect),
        centerHit: hit === control || Boolean(hit && control.contains(hit)),
        hitTarget: hit?.outerHTML.slice(0, 160) ?? null,
      }
    }
    const r = node.getBoundingClientRect(); const scroller = node.querySelector('.fresh-agent-transcript-scroll')!; const t = scroller.getBoundingClientRect(); const padding = getComputedStyle(scroller)
    const stack = box('.fresh-agent-top-stack'); const sidebar = node.querySelector('.fresh-agent-sidebar')?.getBoundingClientRect()
    const composer = box('form.fresh-agent-composer'); const prompt = Array.from(node.querySelectorAll('p')).find(p => p.textContent === 'Latest prompt must remain readable')!.getBoundingClientRect()
    let visibleTop = Math.max(t.top + parseFloat(padding.paddingTop), r.top); let visibleBottom = Math.min(t.bottom - parseFloat(padding.paddingBottom), composer.top, r.bottom)
    for (let ancestor = scroller.parentElement; ancestor && ancestor !== node; ancestor = ancestor.parentElement) {
      if (/(auto|hidden|scroll|clip)/.test(getComputedStyle(ancestor).overflowY)) { const clip = ancestor.getBoundingClientRect(); visibleTop = Math.max(visibleTop, clip.top); visibleBottom = Math.min(visibleBottom, clip.bottom) }
    }
    const countNode = node.querySelector('.fresh-agent-request-count')
    const count = countNode?.getBoundingClientRect()
    const countHit = count && document.elementFromPoint(count.x + count.width / 2, count.y + count.height / 2)
    const controls = Array.from(node.querySelectorAll('.fresh-agent-composer button')).map(el => el.getBoundingClientRect())
    const composerControls = Array.from(node.querySelectorAll('.fresh-agent-composer textarea,.fresh-agent-composer input,.fresh-agent-composer button,.fresh-agent-composer [role="button"]')).map(hitDetails)
    const requestViewportNode = node.querySelector('.fresh-agent-top-stack-scroll')
    const requestControls = requestViewportNode
      ? Array.from(requestViewportNode.querySelectorAll('textarea,input,button,[role="button"]')).map(hitDetails)
      : []
    const requestViewport = requestViewportNode?.getBoundingClientRect()
    return {
      countVisible: !count || (count.top >= stack.top && count.bottom <= stack.bottom + 1 && count.top >= r.top && count.bottom <= r.bottom && (countHit === countNode || Boolean(countNode?.contains(countHit ?? null)))),
      controlsInside: controls.every(b => b.top >= r.top && b.bottom <= r.bottom + 1 && b.left >= r.left && b.right <= r.right + 1),
      height: r.height,
      transcript: visibleBottom - visibleTop,
      transcriptBounds: bounds(t),
      visibleTop,
      visibleBottom,
      promptTop: prompt.top,
      promptBottom: prompt.bottom,
      composerTop: composer.top,
      composerBottom: composer.bottom,
      composerBounds: bounds(composer),
      composerControls,
      requestViewportBounds: requestViewport ? bounds(requestViewport) : null,
      requestControls,
      rootTop: r.top,
      rootBottom: r.bottom,
      occupied: stack.height + (sidebar && sidebar.width >= r.width * .7 ? sidebar.height : 0),
      overflow: node.scrollWidth - node.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
  return { root, geometry }
}

async function logUsefulSpace(page: Page) {
  const { geometry } = await measureUsefulSpace(page)
  console.log(JSON.stringify({ event: 'compact_panel_geometry', severity: 'INFO', ...geometry }))
  return geometry
}

async function captureUsefulSpace(page: Page) {
  const { root, geometry } = await measureUsefulSpace(page)
  console.log(JSON.stringify({ event: 'compact_panel_geometry', severity: 'INFO', ...geometry }))
  if (geometry.transcript < (geometry.height >= 480 ? geometry.height * .4 : 64) || geometry.promptBottom > geometry.visibleBottom + 1 || geometry.occupied > (geometry.height >= 480 ? geometry.height * .35 + 1 : Math.max(0, geometry.height - 240) + 1)) await saveScreenshot(page, `test-results/compact-geometry-failure-${test.info().title.replace(/[^a-z0-9]+/gi, '-')}.png`)
  const colors = await root.locator('.fresh-agent-composer-action[type="submit"]').evaluate(el => { const s = getComputedStyle(el); return { foreground: s.color, background: s.backgroundColor } })
  return { geometry, colors }
}

function assertUsefulSpaceSnapshot(snapshot: Awaited<ReturnType<typeof captureUsefulSpace>>): void {
  const { geometry, colors } = snapshot
  expect(geometry.countVisible).toBe(true)
  expect(geometry.controlsInside).toBe(true)
  expect(geometry.transcript).toBeGreaterThanOrEqual(64)
  if (geometry.height >= 480) {
    expect(geometry.occupied).toBeLessThanOrEqual(geometry.height * .35 + 1)
    expect(geometry.transcript).toBeGreaterThanOrEqual(geometry.height * .4)
  } else expect(geometry.occupied).toBeLessThanOrEqual(Math.max(0, geometry.height - 240) + 1)
  expect(geometry.promptTop).toBeGreaterThanOrEqual(geometry.visibleTop - 1)
  expect(geometry.promptBottom).toBeLessThanOrEqual(geometry.visibleBottom + 1)
  expect(geometry.composerTop).toBeGreaterThanOrEqual(geometry.rootTop)
  expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.rootBottom + 1)
  expect(geometry.overflow).toBeLessThanOrEqual(1)
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1)
  expect(colors.foreground).not.toBe(colors.background)
  expect(colors.background).not.toBe('rgba(0, 0, 0, 0)')
  const luminance = (color: string) => {
    const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4 })
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
  }
  const foreground = luminance(colors.foreground); const background = luminance(colors.background)
  expect((Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)).toBeGreaterThanOrEqual(4.5)
}

async function assertUsefulSpace(page: Page): Promise<void> {
  assertUsefulSpaceSnapshot(await captureUsefulSpace(page))
}

const emittedScreenshotPaths = new Set<string>()

async function saveScreenshot(page: Page, path: string): Promise<void> {
  const bytes = await page.screenshot({ path })
  // Cloud Run has no persistent filesystem artifact export. Retain the four
  // existing review images plus a representative image from each new geometry
  // class; avoid streaming every failed matrix cell into the logs.
  const reviewImages = [
    'compact-freshclaude-desktop',
    'compact-serif-light-split',
    'compact-mono-light-narrow',
    'compact-phone-dark',
    'compact-geometry-failure-painted-freshclaude-metadata-diagnostics-and-request-decisions-share-560x320',
    'compact-geometry-failure-painted-ambiguous-Codex-delivery-keeps-the-original-prompt-and-instruction-at-390x700',
    'compact-geometry-failure-painted-WebFetch-compact-approval-JSON-wraps-fully-at-390px',
    'compact-geometry-failure-composer-270px-empty-compact-pane-keeps-the-complete-composer-visible-without-scrolling',
  ]
  if (emittedScreenshotPaths.has(path) || !reviewImages.some(name => path.includes(name))) return
  emittedScreenshotPaths.add(path)
  const base64 = bytes.toString('base64')
  for (let offset = 0; offset < base64.length; offset += 12000) console.log(JSON.stringify({ event: 'compact_panel_screenshot', severity: 'INFO', path, offset, data: base64.slice(offset, offset + 12000) }))
}

async function setScale(page: Page, uiScale: number): Promise<void> {
  await page.evaluate(uiScale => window.__FRESHELL_TEST_HARNESS__!.dispatch({ type: 'settings/updateSettingsLocal', payload: { uiScale } }), uiScale)
  await expect.poll(() => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')))).toBe(uiScale)
}

async function splitFreshPane(page: Page, direction: 'horizontal' | 'vertical'): Promise<void> {
  await page.evaluate(direction => {
    const h = window.__FRESHELL_TEST_HARNESS__!; const s = h.getState(); const tabId = s.tabs.activeTabId!
    type Node = { content?: Record<string, unknown>; children?: Node[] }
    const find = (n: Node): Node | undefined => n.content?.kind === 'fresh-agent' ? n : n.children?.map(find).find(Boolean)
    const content = find(s.panes.layouts[tabId] as Node)!.content
    h.dispatch({ type: 'panes/resetLayout', payload: { tabId, content } })
    const paneId = h.getState().panes.activePane[tabId]
    h.dispatch({ type: 'panes/splitPane', payload: { tabId, paneId, direction, newPaneId: 'compact-empty', newContent: { kind: 'picker' }, activate: false } })
  }, direction)
  await expect(page.getByText('Latest prompt must remain readable', { exact: true })).toBeVisible()
}

async function fitRoot(page: Page, target: { height?: number; width?: number }, divisor = 1, heightDivisor = divisor): Promise<void> {
  const root = page.locator('.fresh-agent-pane:not(.fresh-agent-diff-drawer-overlay)').last()
  // Responsive chrome can change height after a resize (for example mobile
  // landscape). Remeasure that change instead of assuming a fixed budget.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = (await root.boundingBox())!; const viewport = page.viewportSize()!
    const next = { width: Math.round(viewport.width + ((target.width ?? before.width) - before.width) * divisor), height: Math.round(viewport.height + ((target.height ?? before.height) - before.height) * heightDivisor) }
    if (next.width === viewport.width && next.height === viewport.height) break
    await page.setViewportSize(next)
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
  }
  if (target.height) await expect.poll(async () => (await root.boundingBox())!.height).toBeCloseTo(target.height, 0)
  if (target.width) await expect.poll(async () => (await root.boundingBox())!.width).toBeCloseTo(target.width, 0)
}

async function hitAndClick(control: Locator): Promise<void> {
  await control.scrollIntoViewIfNeeded()
  const probe = await control.evaluate(el => {
    const bounds = el.getBoundingClientRect()
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    return { hit: hit === el || el.contains(hit), control: el.outerHTML.slice(0, 200), target: hit?.outerHTML.slice(0, 200), bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }
  })
  if (!probe.hit) await saveScreenshot(control.page(), `test-results/compact-geometry-failure-hit-${test.info().title.replace(/[^a-z0-9]+/gi, '-')}.png`)
  expect(probe.hit, JSON.stringify(probe)).toBe(true)
  await control.click()
}

async function measurePainted(control: Locator) {
  const result = await control.evaluate(el => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0)
    const describe = (node: Element) => {
      const classes = typeof node.className === 'string' && node.className.trim()
        ? `.${node.className.trim().split(/\s+/).join('.')}`
        : ''
      return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes}`
    }
    const clipAncestors: Array<{ ancestor: string; bounds: { left: number; top: number; right: number; bottom: number; width: number; height: number } }> = []
    for (let parent: Element | null = el; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (parent.matches('.fresh-agent-pane') || /(hidden|auto|scroll|clip)/.test(style.overflowX + style.overflowY)) {
        const bounds = parent.getBoundingClientRect()
        clipAncestors.push({ ancestor: describe(parent), bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height } })
      }
    }
    const observations = rects.map(rect => {
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      const centerHit = hit === el || Boolean(hit && el.contains(hit))
      return {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        insideClips: clipAncestors.every(({ bounds }) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1),
        centerHit,
        hitTarget: hit ? describe(hit) : null,
      }
    })
    const bounds = el.getBoundingClientRect()
    return {
      text: el.textContent?.trim() ?? '',
      element: describe(el),
      elementBounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height },
      count: rects.length,
      readable: observations.length > 0 && observations.every(item => item.insideClips && item.centerHit),
      clipAncestors,
      observations,
    }
  })
  return result
}

async function assertPainted(control: Locator, diagnosticContext?: unknown): Promise<void> {
  const result = await measurePainted(control)
  console.log(JSON.stringify({ event: 'compact_painted_geometry', severity: 'INFO', title: test.info().title, ...result }))
  if (!result.readable) await saveScreenshot(control.page(), `test-results/compact-geometry-failure-painted-${test.info().title.replace(/[^a-z0-9]+/gi, '-')}.png`)
  expect(result.count).toBeGreaterThan(0)
  expect(result.readable, JSON.stringify(diagnosticContext === undefined ? result : { result, diagnosticContext })).toBe(true)
}

async function measureVisibleBox(control: Locator) {
  return control.evaluate(el => {
    const rect = el.getBoundingClientRect()
    const clips: DOMRect[] = []
    for (let parent: Element | null = el; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (parent.matches('.fresh-agent-pane') || /(hidden|auto|scroll|clip)/.test(style.overflowX + style.overflowY)) clips.push(parent.getBoundingClientRect())
    }
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return {
      bounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      insideClips: clips.every(clip => rect.left >= clip.left - 1 && rect.right <= clip.right + 1 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1),
      centerHit: hit === el || Boolean(hit && el.contains(hit)),
    }
  })
}

async function measurePaintedTogether(controls: Locator[], diagnosticContext?: unknown) {
  const results = await Promise.all(controls.map(measurePainted))
  const diagnostics = JSON.stringify(diagnosticContext === undefined ? results : { results, diagnosticContext })
  console.log(JSON.stringify({ event: 'compact_painted_geometry_group', severity: 'INFO', title: test.info().title, results }))
  if (results.some(result => !result.readable)) {
    await saveScreenshot(controls[0].page(), `test-results/compact-geometry-failure-painted-${test.info().title.replace(/[^a-z0-9]+/gi, '-')}.png`)
  }
  return { results, diagnostics }
}

function assertPaintedTogetherResults(measurement: Awaited<ReturnType<typeof measurePaintedTogether>>): void {
  const { results, diagnostics } = measurement
  for (const result of results) {
    expect(result.count).toBeGreaterThan(0)
    expect(result.readable, diagnostics).toBe(true)
  }
}

async function assertPaintedTogether(controls: Locator[], diagnosticContext?: unknown): Promise<void> {
  assertPaintedTogetherResults(await measurePaintedTogether(controls, diagnosticContext))
}

async function clearSeededDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = window.__FRESHELL_TEST_HARNESS__!; const s = h.getState(); const tabId = s.tabs.activeTabId!
    h.dispatch({ type: 'panes/mergePaneContent', payload: { tabId, paneId: s.panes.activePane[tabId], updates: { createError: undefined, reconcileNotice: undefined, closeError: undefined } } })
  })
}

async function measureComposerGeometry(page: Page) {
  const composer = page.locator('.fresh-agent-pane:not(.fresh-agent-diff-drawer-overlay)').last().locator('form.fresh-agent-composer')
  const result = await composer.evaluate(el => {
    const pane = el.closest('.fresh-agent-pane')!.getBoundingClientRect()
    const bounds = el.getBoundingClientRect()
    const isVisiblyPainted = (element: Element) => {
      for (let parent: Element | null = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (style.display === 'none' || style.visibility !== 'visible' || style.contentVisibility === 'hidden' || Number(style.opacity) <= 0) return false
      }
      return true
    }
    const textRects: DOMRect[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text
      if (!textNode.data.trim() || !textNode.parentElement || !isVisiblyPainted(textNode.parentElement)) continue
      const range = document.createRange()
      range.selectNodeContents(textNode)
      textRects.push(...[...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0))
    }
    const text = textRects.map(rect => {
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return {
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        centerHit: Boolean(hit && el.contains(hit)),
        hitTarget: hit?.outerHTML.slice(0, 160) ?? null,
      }
    })
    const controls = [...el.querySelectorAll('textarea,input,button,[role="button"]')].flatMap(control => {
      const rect = control.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0 || control.getClientRects().length === 0 || !isVisiblyPainted(control)) return []
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      const clips: DOMRect[] = []
      for (let parent: Element | null = control; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (parent.matches('.fresh-agent-pane') || /(hidden|auto|scroll|clip)/.test(style.overflowX + style.overflowY)) clips.push(parent.getBoundingClientRect())
      }
      return {
        name: (control as HTMLElement).getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        insidePane: rect.left >= pane.left - 1 && rect.right <= pane.right + 1 && rect.top >= pane.top - 1 && rect.bottom <= pane.bottom + 1 && clips.every(clip => rect.left >= clip.left - 1 && rect.right <= clip.right + 1 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1),
        hit: hit === control || Boolean(hit && control.contains(hit)),
        hitTarget: hit?.outerHTML.slice(0, 160) ?? null,
      }
    })
    const clippingRects: DOMRect[] = []
    for (let parent: Element | null = el; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (parent.matches('.fresh-agent-pane') || /(hidden|auto|scroll|clip)/.test(style.overflowX + style.overflowY)) clippingRects.push(parent.getBoundingClientRect())
    }
    const clippingAncestors = clippingRects.map(clip => ({ left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom, width: clip.width, height: clip.height }))
    const paintedText = text.length === textRects.length && text.every((rect, index) => {
      const source = textRects[index]
      return clippingRects.every(clip => source.left >= clip.left - 1 && source.right <= clip.right + 1 && source.top >= clip.top - 1 && source.bottom <= clip.bottom + 1) && rect.centerHit
    })
    return {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      pane: { top: pane.top, bottom: pane.bottom },
      text,
      paintedText,
      controls,
      clippingAncestors,
      formBoundsInsidePane: bounds.top >= pane.top - 1 && bounds.bottom <= pane.bottom + 1,
    }
  })
  return { composer, result }
}

async function assertComposerPainted(page: Page, diagnosticContext?: unknown): Promise<void> {
  const { result } = await measureComposerGeometry(page)
  console.log(JSON.stringify({ event: 'compact_composer_geometry', severity: 'INFO', title: test.info().title, ...result }))
  if (!result.paintedText || result.controls.length === 0 || result.controls.some(control => !control.insidePane || !control.hit)) {
    await saveScreenshot(page, `test-results/compact-geometry-failure-composer-${test.info().title.replace(/[^a-z0-9]+/gi, '-')}.png`)
  }
  const details = JSON.stringify(diagnosticContext === undefined ? result : { result, diagnosticContext })
  expect(result.paintedText, details).toBe(true)
  expect(result.controls.length, details).toBeGreaterThan(0)
  expect(result.controls.some(control => control.name === 'Chat message input'), details).toBe(true)
  expect(result.controls.every(control => control.insidePane && control.hit), details).toBe(true)
}

async function scrollLayoutToComposer(page: Page, requireScroll = true): Promise<void> {
  const layout = page.locator('.fresh-agent-pane:not(.fresh-agent-diff-drawer-overlay)').last().locator('.fresh-agent-layout')
  await layout.evaluate(el => { el.scrollTop = el.scrollHeight })
  if (requireScroll) await expect.poll(() => layout.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  await assertComposerPainted(page)
}

async function logComposerAfterLayoutScroll(page: Page) {
  const layout = page.locator('.fresh-agent-pane:not(.fresh-agent-diff-drawer-overlay)').last().locator('.fresh-agent-layout')
  const previousScrollTop = await layout.evaluate(el => el.scrollTop)
  await layout.evaluate(el => { el.scrollTop = el.scrollHeight })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const { result } = await measureComposerGeometry(page)
  console.log(JSON.stringify({ event: 'compact_composer_after_scroll_geometry', severity: 'INFO', title: test.info().title, ...result }))
  await layout.evaluate((el, scrollTop) => { el.scrollTop = scrollTop }, previousScrollTop)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  return result
}

async function assertNoRequestStackFloor(page: Page): Promise<void> {
  const spaceGeometry = await logUsefulSpace(page)
  const composerAfterScroll = await logComposerAfterLayoutScroll(page)
  const stack = page.locator('.fresh-agent-pane:not(.fresh-agent-diff-drawer-overlay)').last().locator('.fresh-agent-top-stack')
  const geometry = await stack.evaluate(el => {
    const style = getComputedStyle(el)
    const surfaces = [...el.querySelectorAll('.fresh-agent-notices,.fresh-agent-errors,.fresh-agent-diff-panel')]
      .map(surface => surface.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0)
    const expected = surfaces.reduce((total, rect) => total + rect.height, 0)
      + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      + Math.max(0, surfaces.length - 1) * parseFloat(style.rowGap)
    return { stack: el.getBoundingClientRect().height, expected, surfaces: surfaces.map(rect => ({ top: rect.top, bottom: rect.bottom, height: rect.height })), paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, rowGap: style.rowGap }
  })
  console.log(JSON.stringify({ event: 'compact_no_request_stack_geometry', severity: 'INFO', ...geometry }))
  expect(geometry.stack, JSON.stringify({ geometry, spaceGeometry, composerAfterScroll })).toBeLessThanOrEqual(geometry.expected + 1)
}

for (const [sessionType, provider] of [['freshclaude', 'claude'], ['kilroy', 'claude'], ['freshcodex', 'codex'], ['freshopencode', 'opencode']]) {
  test(`${sessionType} preserves space with simultaneous panels`, async ({ freshellPage, page, terminal }) => {
    void freshellPage
    await terminal.waitForTerminal()
    await seedCompactPane(page, { sessionType, provider, style: 'sans', theme: 'light' })
    await fitRoot(page, { height: 700 })
    await assertUsefulSpace(page)
    if (sessionType === 'freshclaude') await saveScreenshot(page, 'test-results/compact-freshclaude-desktop-default.png')
    await fitRoot(page, { height: 1000 })
    await assertUsefulSpace(page)
    await setScale(page, 1.25)
    await fitRoot(page, { height: 700 })
    await assertUsefulSpace(page)
    await fitRoot(page, { height: 1000 })
    await assertUsefulSpace(page)
    if (provider === 'opencode') return
    const trigger = page.getByRole('button', { name: 'Diffs: 30 changed files' })
    await hitAndClick(trigger)
    const dialog = page.getByRole('dialog', { name: 'Changes' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^Diff:/ })).toHaveCount(provider === 'codex' ? 31 : 30)
    await saveScreenshot(page, `test-results/compact-${sessionType}-desktop.png`)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await assertUsefulSpace(page)
  })
}

for (const style of ['sans', 'serif', 'mono'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`${style} ${theme} preserves short and narrow split pane space`, async ({ freshellPage, page, terminal }) => {
    void freshellPage
    await page.setViewportSize({ width: 1200, height: 844 })
    await terminal.waitForTerminal()
    const state = await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style, theme, populated: true, scale: 1.25 })
    await fitRoot(page, { height: 700 })
    await assertUsefulSpace(page)
    await setScale(page, 1)
    await fitRoot(page, { height: 1000 })
    await assertUsefulSpace(page)
    await setScale(page, 1.25)
    await splitFreshPane(page, 'vertical')
    await fitRoot(page, { height: 320 }, 2)
    await assertUsefulSpace(page)
    await saveScreenshot(page, `test-results/compact-${style}-${theme}-split.png`)
    await hitAndClick(page.getByRole('button', { name: 'Yes', exact: true }))
    await hitAndClick(page.getByRole('button', { name: 'Allow tool use', exact: true }))
    await assertUsefulSpace(page)
    await setScale(page, 1)
    await fitRoot(page, { height: 380 }, 2)
    await assertUsefulSpace(page)
    await splitFreshPane(page, 'horizontal')
    await fitRoot(page, { height: 700, width: 390 }, 2, 1)
    await assertUsefulSpace(page)
    await saveScreenshot(page, `test-results/compact-${style}-${theme}-narrow.png`)
    await setScale(page, 1.25)
    await fitRoot(page, { height: 700, width: 390 }, 2, 1)
    await assertUsefulSpace(page)
    await state.update({ worktrees: [] })
    await expect(page.locator('.fresh-agent-sidebar')).toHaveCount(0)
    await assertUsefulSpace(page)
    await setScale(page, 1)
    await fitRoot(page, { height: 700, width: 390 }, 2, 1)
    await assertUsefulSpace(page)
  })
}
for (const theme of ['light', 'dark'] as const) test(`phone ${theme} keeps requests usable`, async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await page.setViewportSize({ width: 390, height: 844 })
  await terminal.waitForTerminal()
  await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme, populated: true })
  await assertUsefulSpace(page)
  const command = page.locator('summary').filter({ hasText: 'Command' }).first()
  await command.focus(); await page.keyboard.press('Space')
  await expect(command.locator('..')).toHaveAttribute('open', '')
  await page.keyboard.press('Enter')
  await expect(command.locator('..')).not.toHaveAttribute('open', '')
  await hitAndClick(page.getByRole('button', { name: 'Yes', exact: true }))
  await hitAndClick(page.getByRole('button', { name: 'Allow tool use', exact: true }))
  const name = page.getByRole('textbox', { name: 'Name' })
  await hitAndClick(name); await name.fill('Dan')
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
  await hitAndClick(continueButton)
  for (const control of [page.getByRole('button', { name: 'Yes', exact: true }), page.getByRole('button', { name: 'Allow tool use', exact: true }), name, continueButton]) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await assertUsefulSpace(page)
  await saveScreenshot(page, `test-results/compact-phone-${theme}.png`)
})

for (const [name, diffs, label] of [
  ['native patch', [{ id: 'native', title: 'Turn changes', diff: patch }], '1 changed file'],
  ['opaque patch', [{ id: 'opaque', title: 'Turn changes', diff: 'opaque provider output' }], 'file count unavailable'],
] as const) test(`${name} supports keyboard drawer and comments`, async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  const state = await seedCompactPane(page, { sessionType: 'freshcodex', provider: 'codex', style: 'serif', theme: 'dark', snapshot: { diffs } })
  const trigger = page.getByRole('button', { name: `Diffs: ${label}` })
  await trigger.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Changes' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Diff: Turn changes' }).press('Space')
  const controls = dialog.locator('button:visible')
  await controls.last().focus()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(controls.last()).toBeFocused()
  for (const shift of [false, true]) {
    await dialog.locator('h2').click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab')
    await expect(shift ? controls.last() : dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  }
  if (name === 'native patch') {
    const comment = dialog.getByRole('button', { name: 'Comment on this line for the agent' }).last()
    await hitAndClick(comment)
    const composer = page.getByRole('textbox', { name: 'Chat message input' })
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue(/On Turn changes at/)
    await composer.fill('Draft remains focused')
    await state.update({ pendingQuestions: [] })
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue('Draft remains focused')
    await page.evaluate(() => {
      const h = window.__FRESHELL_TEST_HARNESS__!; const s = h.getState(); const tabId = s.tabs.activeTabId!
      h.dispatch({ type: 'panes/mergePaneContent', payload: { tabId, paneId: s.panes.activePane[tabId], updates: { reconcileNotice: 'Background refresh complete' } } })
    })
    await expect(composer).toBeFocused()
    await page.keyboard.type(' while typing')
    await expect(composer).toHaveValue('Draft remains focused while typing')
    await trigger.click()
    await dialog.getByRole('button', { name: 'Diff: Turn changes' }).click()
    await state.update({ diffs: [{ id: 'native', title: 'Turn changes', diff: patch.replace('+new', '+replacement') }] })
    await expect(dialog.getByText('+replacement', { exact: true })).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  const composer = page.getByRole('textbox', { name: 'Chat message input' })
  await composer.fill('Draft')
  await trigger.focus()
  await page.keyboard.type('x')
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue('Draftx')
  await trigger.click()
  await page.evaluate(() => {
    const h = window.__FRESHELL_TEST_HARNESS__!; const s = h.getState(); const tabId = s.tabs.activeTabId!; const paneId = s.panes.activePane[tabId]
    const layout = s.panes.layouts[tabId] as { content: Record<string, unknown> }
    h.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId, content: { ...layout.content, sessionId: 'other-conversation', sessionRef: { provider: 'codex', sessionId: 'other-conversation' }, resumeSessionId: 'other-conversation' } } })
  })
  await expect(dialog).toHaveCount(0)
})

for (const height of [200, 120]) test(`nested ${height}px panes retain requests and recovery through scrolling`, async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await page.setViewportSize({ width: 1200, height: 1000 })
  await terminal.waitForTerminal()
  const state = await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light' })
  await splitFreshPane(page, 'vertical')
  await page.evaluate(() => {
    const h = window.__FRESHELL_TEST_HARNESS__!; const s = h.getState(); const tabId = s.tabs.activeTabId!
    const paneId = s.panes.activePane[tabId]
    h.dispatch({ type: 'panes/splitPane', payload: { tabId, paneId, direction: 'vertical', newPaneId: 'compact-nested-empty', newContent: { kind: 'picker' }, activate: false } })
  })
  await fitRoot(page, { height }, 4)
  const root = page.locator('.fresh-agent-pane:not(.fresh-agent-diff-drawer-overlay)')
  const stack = root.getByRole('group', { name: 'Agent requests and status' })
  const count = stack.getByText('3 pending requests', { exact: true })
  const initial = await count.evaluate(el => {
    const r = el.closest('.fresh-agent-pane')!.getBoundingClientRect(); const b = el.getBoundingClientRect()
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
    return { visible: b.top >= r.top && b.bottom <= r.bottom && (hit === el || el.contains(hit)), stackHeight: el.closest('.fresh-agent-top-stack')!.getBoundingClientRect().height }
  })
  console.log(JSON.stringify({event:'tiny_compact_geometry',severity:'INFO',height,...initial}))
  expect(initial.visible).toBe(true)
  expect(initial.stackHeight).toBeGreaterThanOrEqual(64)
  await saveScreenshot(page, `test-results/compact-tiny-${height}px.png`)
  await hitAndClick(stack.getByRole('button', { name: 'Yes', exact: true }))
  await hitAndClick(stack.getByRole('button', { name: 'Allow tool use', exact: true }))
  const name = stack.getByRole('textbox', {name:'Name'})
  await hitAndClick(name); await name.fill('Dan')
  await hitAndClick(stack.getByRole('button', {name:'Continue',exact:true}))
  await hitAndClick(stack.locator('[data-agent-error="create"] summary'))
  await hitAndClick(stack.getByRole('button', {name:'Dismiss',exact:true}))
  await hitAndClick(stack.getByRole('button', {name:'Diffs: 30 changed files'}))
  await expect(page.getByRole('dialog', {name:'Changes'})).toBeVisible()
  await page.keyboard.press('Escape')
  const prompt = root.getByText('Latest prompt must remain readable', {exact:true})
  await prompt.scrollIntoViewIfNeeded()
  const promptVisible = await prompt.evaluate(el => {
    const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
    return hit === el || el.contains(hit)
  })
  expect(promptVisible).toBe(true)
  const composer = root.getByRole('textbox', {name:'Chat message input'})
  await hitAndClick(composer); await composer.fill('Draft in a tiny split')
  await state.update({ status: 'exited' })
  await expect(composer).toBeDisabled()
  await hitAndClick(stack.locator('[data-agent-error="ended"] summary'))
  for (const label of ['Resume session', 'Start new session']) {
    const button = stack.getByRole('button', {name:label,exact:true})
    await button.scrollIntoViewIfNeeded()
    expect(await button.evaluate(el => {const b=el.getBoundingClientRect(); const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2); return hit===el || el.contains(hit)})).toBe(true)
    await expect(button).toBeEnabled()
  }
})

for (const [sessionType, provider, populated] of [['freshclaude', 'claude', false], ['freshcodex', 'codex', true]] as const) test(`compact header advertises multiple diagnostics and expands long prominent status${populated ? ' with Codex metadata' : ''}`, async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  await seedCompactPane(page, { sessionType, provider, populated, style:'sans',theme:'light' })
  const text = 'Session identity corrected by server — this pane now points at its live session.'
  await page.evaluate(() => {
    const h=window.__FRESHELL_TEST_HARNESS__!;const s=h.getState();const tabId=s.tabs.activeTabId!
    h.dispatch({type:'settings/updateSettingsLocal',payload:{sidebar:{collapsed:true}}})
    h.dispatch({type:'panes/mergePaneContent',payload:{tabId,paneId:s.panes.activePane[tabId],updates:{reconcileNotice:undefined,closeError:'Second actionable diagnostic'}}})
  })
  await expect(page.getByRole('button', { name:'Show sidebar',exact:true })).toBeVisible()
  const sizes = [{width:1100,height:700},{width:560,height:320},{width:390,height:700}]
  const measurements: Array<{
    count: Locator
    countHit: boolean
    painted: Awaited<ReturnType<typeof measurePaintedTogether>>
    usefulSpace: Awaited<ReturnType<typeof captureUsefulSpace>>
  }> = []
  for (const size of sizes) {
    await fitRoot(page,{width:size.width})
    await fitRoot(page,{height:size.height})
    const spaceGeometry = await logUsefulSpace(page)
    const errors=page.getByRole('region',{name:'Agent errors'})
    const count=errors.getByRole('img',{name:'2 errors'})
    const countHit=await count.evaluate(el=>{const b=el.getBoundingClientRect();const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return b.width>0&&b.height>0&&(hit===el||el.contains(hit))})
    const painted=await measurePaintedTogether([
      errors.locator('[data-agent-error="create"] span[role="alert"]'),
      errors.locator('[data-agent-error="close"] span[role="alert"]'),
    ], spaceGeometry)
    measurements.push({count,countHit,painted,usefulSpace:await captureUsefulSpace(page)})
  }
  const geometryFailures: unknown[] = []
  for (const measurement of measurements) {
    try { await expect(measurement.count).toHaveText('2') } catch (error) { geometryFailures.push(error) }
    try { expect(measurement.countHit).toBe(true) } catch (error) { geometryFailures.push(error) }
    try { assertPaintedTogetherResults(measurement.painted) } catch (error) { geometryFailures.push(error) }
    try { assertUsefulSpaceSnapshot(measurement.usefulSpace) } catch (error) { geometryFailures.push(error) }
  }
  if (geometryFailures.length) throw geometryFailures[0]

  for (const size of sizes) {
    await fitRoot(page,{width:size.width})
    await fitRoot(page,{height:size.height})
    const errors=page.getByRole('region',{name:'Agent errors'})
    await page.evaluate(text => {
      const h=window.__FRESHELL_TEST_HARNESS__!;const s=h.getState();const tabId=s.tabs.activeTabId!
      h.dispatch({type:'panes/mergePaneContent',payload:{tabId,paneId:s.panes.activePane[tabId],updates:{reconcileNotice:text}}})
    },text)
    const notices=page.getByRole('status',{name:'Agent notices'})
    const summary=notices.locator('summary')
    await hitAndClick(summary)
    const body=notices.locator('.fresh-agent-diagnostic-body')
    await expect(body).toHaveText(text)
    await body.scrollIntoViewIfNeeded()
    expect(await body.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
    await hitAndClick(summary)
    await assertUsefulSpace(page)
    await page.evaluate(() => {
      const h=window.__FRESHELL_TEST_HARNESS__!;const s=h.getState();const tabId=s.tabs.activeTabId!
      h.dispatch({type:'panes/mergePaneContent',payload:{tabId,paneId:s.panes.activePane[tabId],updates:{reconcileNotice:undefined}}})
    })
    await expect(notices).toHaveCount(0)
    if (size.height === 320) {
      await hitAndClick(page.getByRole('button', { name: 'Yes', exact: true }))
      await hitAndClick(page.getByRole('button', { name: 'Allow tool use', exact: true }))
      await assertUsefulSpace(page)
    }
  }
  const errors = page.getByRole('region', { name: 'Agent errors' })
  const closeError = errors.locator('[data-agent-error="close"]')
  await hitAndClick(closeError.locator('summary'))
  await expect(closeError).toHaveAttribute('open', '')
  await hitAndClick(closeError.getByRole('button', { name: 'Dismiss', exact: true }))
  await expect(errors.getByRole('img', { name: '1 error' })).toHaveText('1')
  await expect(closeError).toHaveCount(0)

  await page.evaluate(({sessionType,provider}) => {
    const h=window.__FRESHELL_TEST_HARNESS__!;const s=h.getState();const tabId=s.tabs.activeTabId!
    h.receiveWsMessage?.({type:'freshAgent.event',sessionId:`compact-${sessionType}`,sessionType,provider,event:{type:'freshAgent.notice',level:'warning',code:'mixed-severity',message:'Provider warning'}})
  },{sessionType,provider})
  const mixedCount=errors.getByRole('img',{name:'1 error, 1 warning'})
  await expect(mixedCount).toHaveText('2')
  expect(await mixedCount.ariaSnapshot()).toContain('img "1 error, 1 warning"')
  await page.evaluate(() => {
    const h=window.__FRESHELL_TEST_HARNESS__!;const s=h.getState();const tabId=s.tabs.activeTabId!
    h.dispatch({type:'panes/mergePaneContent',payload:{tabId,paneId:s.panes.activePane[tabId],updates:{createError:undefined}}})
  })
  await expect(errors.getByRole('img',{name:'1 warning'})).toHaveText('1')
  await expect(mixedCount).toHaveCount(0)
})

test('routine feedback stays in the closed summary beside prominent reconciliation', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light' })
  await page.evaluate(() => {
    const h=window.__FRESHELL_TEST_HARNESS__!;const s=h.getState();const tabId=s.tabs.activeTabId!
    h.dispatch({type:'panes/mergePaneContent',payload:{tabId,paneId:s.panes.activePane[tabId],updates:{reconcileNotice:undefined}}})
    h.receiveWsMessage?.({type:'freshAgent.event',sessionId:'compact-freshclaude',sessionType:'freshclaude',provider:'claude',event:{type:'freshAgent.notice',level:'info',code:'SETTINGS_UPDATED',message:'Provider settings updated'}})
  })
  const notices=page.getByRole('status',{name:'Agent notices'})
  const summary=notices.locator('summary')
  const body=notices.locator('.fresh-agent-diagnostic-body')
  await expect(summary).toContainText('Provider settings updated')
  await expect(summary.locator('..')).not.toHaveAttribute('open','')
  await hitAndClick(summary)
  await expect(body).toContainText('Provider settings updated')
  await page.evaluate(() => {
    const h=window.__FRESHELL_TEST_HARNESS__!;const s=h.getState();const tabId=s.tabs.activeTabId!
    h.dispatch({type:'panes/mergePaneContent',payload:{tabId,paneId:s.panes.activePane[tabId],updates:{reconcileNotice:'Session restored'}}})
  })
  await hitAndClick(summary)
  await expect(summary.locator('..')).not.toHaveAttribute('open','')
  await expect(summary).toContainText('Provider settings updated')
  await expect(summary).toContainText('Session restored')
  await hitAndClick(summary)
  await expect(body).toContainText('Provider settings updated')
  await expect(body).toContainText('Session restored')
})

for (const size of [{ width: 800, height: 900 }, { width: 390, height: 700 }]) {
  test(`one short request stays fully reachable with routine feedback at ${size.width}x${size.height}`, async ({ freshellPage, page, terminal }) => {
    void freshellPage
    if (size.width === 390) await page.setViewportSize({ width: 390, height: 844 })
    await terminal.waitForTerminal()
    const state = await seedCompactPane(page, {
      sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light',
      snapshot: {
        diffs: [],
        pendingApprovals: [{ requestId: 'short-request', toolName: 'Bash', input: { command: 'echo ok' } }],
        pendingQuestions: [],
        pendingElicitations: [],
      },
    })
    await fitRoot(page, { width: size.width })
    await fitRoot(page, { height: size.height })
    await clearSeededDiagnostics(page)
    await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({
      type: 'freshAgent.event', sessionId: 'compact-freshclaude', sessionType: 'freshclaude', provider: 'claude',
      event: { type: 'freshAgent.notice', level: 'info', code: 'SETTINGS_UPDATED', message: 'Settings saved' },
    }))
    await expect(page.getByRole('status', { name: 'Agent notices' })).toContainText('Settings saved')
    const usefulSpaceSnapshots = [await captureUsefulSpace(page)]
    const requests = page.getByRole('region', { name: 'Pending requests' })
    const allow = requests.getByRole('button', { name: 'Allow tool use', exact: true })
    const initial = await allow.evaluate(el => {
      const bounds = el.getBoundingClientRect()
      const viewport = el.closest('[aria-label="Pending requests"]')!.getBoundingClientRect()
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      return {
        bounds: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right },
        viewport: { top: viewport.top, bottom: viewport.bottom, left: viewport.left, right: viewport.right },
        inside: bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1 && bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1,
        hit: hit === el || Boolean(hit && el.contains(hit)),
      }
    })
    console.log(JSON.stringify({ event: 'compact_request_action_geometry', severity: 'INFO', title: test.info().title, action: 'Allow tool use', ...initial }))
    const assertionFailures: unknown[] = []
    try { expect(initial.inside, JSON.stringify(initial)).toBe(true) } catch (error) { assertionFailures.push(error) }
    try { expect(initial.hit, JSON.stringify(initial)).toBe(true) } catch (error) { assertionFailures.push(error) }
    await hitAndClick(allow)
    await state.update({ pendingApprovals: [] })
    await clearSeededDiagnostics(page)
    await page.waitForTimeout(7000)
    usefulSpaceSnapshots.push(await captureUsefulSpace(page))
    try { await expect(page.getByRole('status', { name: 'Agent notices' })).toHaveCount(0) } catch (error) { assertionFailures.push(error) }
    try { await expect(page.getByRole('region', { name: 'Pending requests' })).toHaveCount(0) } catch (error) { assertionFailures.push(error) }
    for (const snapshot of usefulSpaceSnapshots) {
      try { assertUsefulSpaceSnapshot(snapshot) } catch (error) { assertionFailures.push(error) }
    }
    if (assertionFailures.length) throw assertionFailures[0]
  })
}

for (const [sessionType, provider] of [['freshclaude', 'claude'], ['freshcodex', 'codex']] as const) {
  for (const size of [{ width: 560, height: 320 }, { width: 390, height: 400 }, { width: 560, height: 400 }]) {
    test(`${sessionType} metadata, diagnostics and request decisions share ${size.width}x${size.height}`, async ({ freshellPage, page, terminal }) => {
      void freshellPage
      if (size.width === 390) await page.setViewportSize({ width: 390, height: 844 })
      await terminal.waitForTerminal()
      await seedCompactPane(page, { sessionType, provider, populated: true, style: 'sans', theme: 'light' })
      await fitRoot(page, { width: size.width })
      await fitRoot(page, { height: size.height })
      await page.evaluate(() => {
        const h = window.__FRESHELL_TEST_HARNESS__!; const s = h.getState(); const tabId = s.tabs.activeTabId!
        h.dispatch({ type: 'panes/mergePaneContent', payload: { tabId, paneId: s.panes.activePane[tabId], updates: { closeError: 'Second actionable diagnostic' } } })
      })
      const metadata = page.locator('.fresh-agent-sidebar')
      const metadataValue = metadata.locator('li').first()
      const errors = page.getByRole('region', { name: 'Agent errors' })
      const spaceGeometry = await logUsefulSpace(page)
      await expect(metadataValue).toBeAttached()
      await assertPaintedTogether([
        metadataValue,
        errors.locator('[data-agent-error="create"] span[role="alert"]'),
        errors.locator('[data-agent-error="close"] span[role="alert"]'),
      ], spaceGeometry)
      await assertUsefulSpace(page)

      const requests = page.getByRole('region', { name: 'Pending requests' })
      await hitAndClick(requests.getByRole('button', { name: 'Yes', exact: true }))
      await hitAndClick(requests.getByRole('button', { name: 'Allow tool use', exact: true }))
      const name = requests.getByRole('textbox', { name: 'Name' })
      await hitAndClick(name)
      await name.fill('Dan')
      await hitAndClick(requests.getByRole('button', { name: 'Continue', exact: true }))
      await assertUsefulSpace(page)
      const closeError = errors.locator('[data-agent-error="close"]')
      await hitAndClick(closeError.locator('summary'))
      await hitAndClick(closeError.getByRole('button', { name: 'Dismiss', exact: true }))
      await expect(closeError).toHaveCount(0)
    })
  }
}

test('390x320 metadata-absent compact state keeps both diagnostics, requests and composer reachable', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await page.setViewportSize({ width: 390, height: 844 })
  await terminal.waitForTerminal()
  await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light' })
  await fitRoot(page, { width: 390 })
  await fitRoot(page, { height: 320 })
  await page.evaluate(() => {
    const h = window.__FRESHELL_TEST_HARNESS__!; const s = h.getState(); const tabId = s.tabs.activeTabId!
    h.dispatch({ type: 'panes/mergePaneContent', payload: { tabId, paneId: s.panes.activePane[tabId], updates: { closeError: 'Second actionable diagnostic' } } })
  })
  await expect(page.locator('.fresh-agent-sidebar')).toHaveCount(0)
  const errors = page.getByRole('region', { name: 'Agent errors' })
  const spaceGeometry = await logUsefulSpace(page)
  await assertPaintedTogether([
    errors.locator('[data-agent-error="create"] span[role="alert"]'),
    errors.locator('[data-agent-error="close"] span[role="alert"]'),
  ], spaceGeometry)
  await assertUsefulSpace(page)
  await hitAndClick(page.getByRole('region', { name: 'Pending requests' }).getByRole('button', { name: 'Yes', exact: true }))
  await hitAndClick(page.getByRole('region', { name: 'Pending requests' }).getByRole('button', { name: 'Allow tool use', exact: true }))
  const name = page.getByRole('region', { name: 'Pending requests' }).getByRole('textbox', { name: 'Name' })
  await hitAndClick(name)
  await name.fill('Dan')
  await hitAndClick(page.getByRole('region', { name: 'Pending requests' }).getByRole('button', { name: 'Continue', exact: true }))
  await assertUsefulSpace(page)
})

test('390x320 metadata-only state preserves values and a child link through sidebar scrolling', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await page.setViewportSize({ width: 390, height: 844 })
  await terminal.waitForTerminal()
  const childThreadId = 'compact-child-thread'
  await seedCompactPane(page, {
    sessionType: 'freshcodex', provider: 'codex', style: 'sans', theme: 'light', populated: true,
    snapshot: {
      diffs: [], pendingApprovals: [], pendingQuestions: [], pendingElicitations: [],
      childThreads: [{ id: 'child-row', threadId: childThreadId, origin: 'agent', title: 'Metadata child', status: 'completed', model: 'fixture' }],
    },
  })
  await fitRoot(page, { width: 390 })
  await fitRoot(page, { height: 320 })
  await clearSeededDiagnostics(page)
  const sidebar = page.locator('.fresh-agent-sidebar')
  await expect(sidebar).toBeVisible()
  await expect(page.getByRole('region', { name: 'Pending requests' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Agent errors' })).toHaveCount(0)
  await assertUsefulSpace(page)
  const spaceGeometry = await logUsefulSpace(page)

  await sidebar.evaluate(el => { el.scrollTop = 0 })
  const worktreeValue = sidebar.locator('li').filter({ hasText: 'feature/0' }).first()
  await worktreeValue.scrollIntoViewIfNeeded()
  const worktreeGeometry = await measurePainted(worktreeValue)
  await sidebar.evaluate(el => { el.scrollTop = el.scrollHeight })
  const childLink = sidebar.getByRole('button', { name: `Observe child ${childThreadId}` })
  await expect(childLink).toBeVisible()
  const childLinkGeometry = await measurePainted(childLink)
  await sidebar.evaluate(el => { el.scrollTop = 0 })
  await worktreeValue.scrollIntoViewIfNeeded()
  await assertPainted(worktreeValue, { worktreeGeometry, childLinkGeometry, spaceGeometry })
  await sidebar.evaluate(el => { el.scrollTop = el.scrollHeight })
  await assertPainted(childLink, { worktreeGeometry, childLinkGeometry, spaceGeometry })
})

test('270px empty compact pane keeps the complete composer visible without scrolling', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await page.setViewportSize({ width: 390, height: 844 })
  await terminal.waitForTerminal()
  await seedCompactPane(page, {
    sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light',
    snapshot: { diffs: [], pendingApprovals: [], pendingQuestions: [], pendingElicitations: [] },
  })
  await fitRoot(page, { width: 390 })
  await fitRoot(page, { height: 270 })
  await clearSeededDiagnostics(page)
  await expect(page.locator('.fresh-agent-sidebar')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Pending requests' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Agent errors' })).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Agent notices' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Diffs:/ })).toHaveCount(0)
  await logUsefulSpace(page)
  await expect(page.locator('.fresh-agent-layout')).toHaveJSProperty('scrollTop', 0)
  await assertComposerPainted(page)
})

for (const height of [200, 120]) {
  test(`${height}px empty and answered panes keep the composer reachable without a request scroller`, async ({ freshellPage, page, terminal }) => {
    void freshellPage
    await page.setViewportSize({ width: 390, height: 844 })
    await terminal.waitForTerminal()
    const state = await seedCompactPane(page, {
      sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light',
      snapshot: { diffs: [], pendingApprovals: [], pendingQuestions: [], pendingElicitations: [] },
    })
    await fitRoot(page, { width: 390 })
    await fitRoot(page, { height })
    await clearSeededDiagnostics(page)
    await expect(page.getByRole('region', { name: 'Pending requests' })).toHaveCount(0)
    await logUsefulSpace(page)
    await scrollLayoutToComposer(page)

    await state.update({ pendingApprovals: [{ requestId: `tiny-answer-${height}`, toolName: 'Bash', input: { command: 'echo ok' } }] })
    const requests = page.getByRole('region', { name: 'Pending requests' })
    await hitAndClick(requests.getByRole('button', { name: 'Allow tool use', exact: true }))
    await state.update({ pendingApprovals: [] })
    await expect(page.getByRole('region', { name: 'Pending requests' })).toHaveCount(0)
    await logUsefulSpace(page)
    await scrollLayoutToComposer(page)
  })
}

for (const height of [200, 270]) for (const panel of ['diff', 'notice'] as const) {
  test(`${height}px lone ${panel} content has no empty request floor and leaves composer reachable`, async ({ freshellPage, page, terminal }) => {
    void freshellPage
    await page.setViewportSize({ width: 390, height: 844 })
    await terminal.waitForTerminal()
    const state = await seedCompactPane(page, {
      sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light',
      snapshot: { diffs: [], pendingApprovals: [], pendingQuestions: [], pendingElicitations: [] },
    })
    await fitRoot(page, { width: 390 })
    await fitRoot(page, { height })
    await clearSeededDiagnostics(page)
    if (panel === 'diff') {
      await state.update({ diffs: [{ id: 'lone-change', path: '/tmp/one.ts', status: 'modified', title: 'one.ts' }] })
      await expect(page.getByRole('button', { name: 'Diffs: 1 changed file' })).toBeVisible()
    } else {
      const longNotice = 'A saved provider setting changed and is ready to use. '.repeat(12)
      await page.evaluate(message => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({
        type: 'freshAgent.event', sessionId: 'compact-freshclaude', sessionType: 'freshclaude', provider: 'claude',
        event: { type: 'freshAgent.notice', level: 'info', code: 'SETTINGS_UPDATED', message },
      }), longNotice)
      const notice = page.getByRole('status', { name: 'Agent notices' })
      const summary = notice.locator('summary')
      const spaceGeometry = await logUsefulSpace(page)
      const summaryGeometry = await measureVisibleBox(summary)
      await expect(summary.locator('..')).not.toHaveAttribute('open', '')
      const overflow = await notice.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      console.log(JSON.stringify({ event: 'compact_long_notice_geometry', severity: 'INFO', title: test.info().title, overflow, summaryGeometry, spaceGeometry }))
      expect(overflow.scrollWidth, JSON.stringify({ overflow, summaryGeometry, spaceGeometry })).toBeLessThanOrEqual(overflow.clientWidth + 1)
      expect(summaryGeometry.bounds.width, JSON.stringify({ summaryGeometry, spaceGeometry, overflow })).toBeGreaterThan(0)
      expect(summaryGeometry.bounds.height, JSON.stringify({ summaryGeometry, spaceGeometry, overflow })).toBeGreaterThan(0)
      expect(summaryGeometry.insideClips, JSON.stringify({ summaryGeometry, spaceGeometry, overflow })).toBe(true)
      expect(summaryGeometry.centerHit, JSON.stringify({ summaryGeometry, spaceGeometry, overflow })).toBe(true)
      const summaryOverflow = await summary.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, textOverflow: getComputedStyle(el).textOverflow }))
      expect(summaryOverflow.textOverflow).toBe('ellipsis')
      expect(summaryOverflow.scrollWidth).toBeGreaterThan(summaryOverflow.clientWidth)
      await hitAndClick(summary)
      await expect(notice.locator('.fresh-agent-diagnostic-body')).toHaveText(longNotice)
    }
    await expect(page.getByRole('region', { name: 'Pending requests' })).toHaveCount(0)
    await assertNoRequestStackFloor(page)
    await scrollLayoutToComposer(page, height < 239)
  })
}

test('requests remain clickable and native disclosures use keyboard defaults', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light' })
  await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({
    type: 'freshAgent.event', sessionId: 'compact-freshclaude', sessionType: 'freshclaude', provider: 'claude',
    event: { type: 'freshAgent.notice', level: 'info', code: 'SETTINGS_UPDATED', message: 'Provider settings updated' },
  }))
  for (const label of ['Notice details', 'Command details']) {
    const summary = page.locator('summary').filter({ hasText: label }).first()
    await summary.scrollIntoViewIfNeeded(); await summary.focus()
    await page.keyboard.press('Space')
    await expect(summary.locator('..')).toHaveAttribute('open', '')
    await page.keyboard.press('Enter')
    await expect(summary.locator('..')).not.toHaveAttribute('open', '')
  }
  const error = page.locator('[data-agent-error="create"] summary')
  await error.focus(); await page.keyboard.press('Enter')
  await expect(error.locator('..')).toHaveAttribute('open', '')
  await page.keyboard.press('Space')
  await expect(error.locator('..')).not.toHaveAttribute('open', '')
  await page.keyboard.press('Enter')
  await expect(error.locator('..')).toHaveAttribute('open', '')
  await page.locator('summary').filter({ hasText: 'Command details' }).first().press('Space')
  await assertUsefulSpace(page)
  await hitAndClick(page.getByRole('button', { name: 'Yes', exact: true }))
  await expect(page.getByRole('button', { name: 'Submit all answers', exact: true })).toHaveCount(0)
  const name = page.getByRole('textbox', { name: 'Name' })
  await hitAndClick(name); await name.fill('Dan')
  await hitAndClick(page.getByRole('button', { name: 'Continue', exact: true }))
  await hitAndClick(page.getByRole('button', { name: 'Allow tool use', exact: true }))
})

test('native decisions remain outside long command previews', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  await seedCompactPane(page, { sessionType: 'freshcodex', provider: 'codex', style: 'mono', theme: 'light', snapshot: {
    pendingApprovals: [{ requestId: 'native', toolName: 'Bash', native: { command: 'printf native '.repeat(1000), availableDecisions: ['accept', 'cancel'] } }],
  } })
  const request = page.getByRole('alert', { name: 'Permission request for Bash' })
  await expect(request.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await hitAndClick(request.getByRole('button', { name: 'Allow', exact: true }))
  await expect(request.getByRole('button', { name: 'Allow for this session', exact: true })).toHaveCount(0)
})

test('native permission scopes stay compact above reachable answers', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  const permissions = { fileSystem: { entries: [
    { path: { type: 'path', path: '/srv/reports' }, access: 'read' },
    { path: { type: 'path', path: '/srv/output' }, access: 'write' },
  ] }, network: { enabled: true } }
  await seedCompactPane(page, { sessionType: 'freshcodex', provider: 'codex', style: 'mono', theme: 'light', snapshot: {
    pendingApprovals: [{ requestId: 'native-scope', toolName: 'Additional permissions', native: { permissions, availableDecisions: ['accept', 'decline'] } }],
    pendingQuestions: [], pendingElicitations: [],
  } })
  await fitRoot(page, { width: 1100, height: 700 })
  const request = page.getByRole('alert', { name: 'Permission request for Additional permissions' })
  await expect(request.locator('pre')).toBeVisible()
  await expect(request.locator('pre')).toHaveText(JSON.stringify({ permissions }))
  const allow = request.getByRole('button', { name: 'Allow', exact: true })
  const bounds = await allow.evaluate(el => {
    const button = el.getBoundingClientRect(); const viewport = el.closest('.fresh-agent-top-stack-scroll')!.getBoundingClientRect()
    return { top: button.top, bottom: button.bottom, visibleTop: viewport.top, visibleBottom: viewport.bottom }
  })
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.visibleTop)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.visibleBottom)
  await hitAndClick(allow)
  await assertUsefulSpace(page)
})

for (const [toolName, input, requestId] of [
  ['WebFetch', { url: `https://example.com/${'a'.repeat(120)}` }, 'wrapped-web-fetch'],
  ['Write', { file_path: '/tmp/x', content: 'b'.repeat(120) }, 'wrapped-write'],
  ['mcp__fixture__lookup', { key: 'c'.repeat(120) }, 'wrapped-mcp-lookup'],
] as const) for (const width of [390, 560]) {
  test(`${toolName} compact approval JSON wraps fully at ${width}px`, async ({ freshellPage, page, terminal }) => {
    void freshellPage
    if (width === 390) await page.setViewportSize({ width: 390, height: 844 })
    await terminal.waitForTerminal()
    await seedCompactPane(page, {
      sessionType: 'freshclaude',
      provider: 'claude',
      style: 'sans',
      theme: 'light',
      snapshot: {
        diffs: [],
        pendingApprovals: [{ requestId: `${requestId}-${width}`, toolName, input }],
        pendingQuestions: [],
        pendingElicitations: [],
      },
    })
    await fitRoot(page, { width })
    const request = page.getByRole('alert', { name: `Permission request for ${toolName}` })
    const preview = request.locator('pre.fresh-agent-approval-preview')
    await expect(preview).toBeVisible()
    const spaceGeometry = await logUsefulSpace(page)
    const paintedGeometry = await measurePainted(preview)
    const geometry = await preview.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el)
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
      const bounds = el.getBoundingClientRect()
      return {
        lines: rects.length,
        lineBounds: rects.map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })),
        bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }
    })
    console.log(JSON.stringify({ event: 'compact_json_geometry', severity: 'INFO', title: test.info().title, geometry, paintedGeometry, spaceGeometry }))
    await expect.poll(
      () => preview.evaluate(el => el.scrollWidth - el.clientWidth),
      { message: JSON.stringify({ geometry, paintedGeometry, spaceGeometry }) },
    ).toBeLessThanOrEqual(1)
    expect(geometry.lines, JSON.stringify(geometry)).toBeGreaterThan(1)
    expect(geometry.lineBounds.every(rect => rect.left >= geometry.bounds.left - 1 && rect.right <= geometry.bounds.right + 1 && rect.top >= geometry.bounds.top - 1 && rect.bottom <= geometry.bounds.bottom + 1), JSON.stringify(geometry)).toBe(true)
    expect(JSON.parse(await preview.textContent() ?? '')).toEqual(input)
    await assertPainted(preview, { geometry, paintedGeometry, spaceGeometry })
    const allow = request.getByRole('button', { name: 'Allow tool use', exact: true })
    await hitAndClick(allow)
    const responses = await page.evaluate(requestId => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.().filter(frame =>
      typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'freshAgent.approval.respond' && 'requestId' in frame && frame.requestId === requestId,
    ) ?? [], `${requestId}-${width}`)
    expect(responses).toEqual([{
      type: 'freshAgent.approval.respond',
      sessionId: 'compact-freshclaude',
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: `${requestId}-${width}`,
      decision: { behavior: 'allow' },
    }])
  })
}

test('Claude plan feedback stays outside the long plan preview', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style: 'mono', theme: 'light', snapshot: {
    pendingApprovals: [{ requestId: 'plan', toolName: 'ExitPlanMode', input: { plan: 'Long plan content. '.repeat(200), planFilePath: '/tmp/plan.md' } }],
  } })
  const plan = page.getByRole('alert', { name: 'Plan approval request' })
  const details = plan.locator('summary').filter({ hasText: 'Plan details' })
  await details.scrollIntoViewIfNeeded(); await details.press('Space')
  await expect(details.locator('..')).toHaveAttribute('open', '')
  await details.press('Enter')
  await expect(details.locator('..')).not.toHaveAttribute('open', '')
  await plan.getByRole('textbox', { name: 'What should change? (optional)' }).fill('Keep the existing API')
  await expect(plan.getByRole('button', { name: 'Approve plan', exact: true })).toBeDisabled()
  await hitAndClick(plan.getByRole('button', { name: 'Keep planning', exact: true }))
})

test('Codex multi-turn projection keeps all session files across native patch changes', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  const fileTurn = (id: string, paths: string[]) => ({ id, turnId: id, role: 'assistant', summary: '', items: [{ id: `${id}-files`, kind: 'file_change', status: 'completed', changes: paths.map(path => ({ path: `/tmp/${path}`, kind: 'update' })) }] })
  const rows = (paths: string[]) => paths.map(path => ({ id: path, path: `/tmp/${path}` }))
  const first = fileTurn('turn-1', ['A', 'B', 'C'])
  const user = latestUserTurn()
  const state = await seedCompactPane(page, { sessionType: 'freshcodex', provider: 'codex', style: 'sans', theme: 'light', snapshot: { turns: [first, user], diffs: rows(['A', 'B', 'C']) } })
  await expect(page.getByRole('button', { name: 'Diffs: 3 changed files' })).toBeVisible()
  const latest = { id: 'codex-turn:turn-2', title: 'Turn changes', diff: patch.replaceAll('file-0.ts', 'D') }
  await state.update({ turns: [first, user, fileTurn('turn-2', ['D'])], diffs: [...rows(['A', 'B', 'C', 'D']), latest] })
  const trigger = page.getByRole('button', { name: 'Diffs: 4 changed files' })
  await trigger.click()
  const changes = page.getByRole('dialog', { name: 'Changes' })
  const assertSessionRows = async () => {
    await expect(trigger).toHaveText(/4 changed files/)
    for (const path of ['A', 'B', 'C', 'D']) await expect(changes.getByRole('button', { name: `Diff: /tmp/${path}`, exact: true })).toBeVisible()
  }
  await assertSessionRows()
  await changes.getByRole('button', { name: 'Diff: Turn changes' }).click()
  await expect(changes.getByText('+new', { exact: true })).toBeVisible()
  const replacement = latest.diff.replace('+new', '+updated')
  await page.evaluate(diff => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({ type: 'freshAgent.event', sessionId: 'compact-freshcodex', sessionType: 'freshcodex', provider: 'codex', event: { type: 'freshAgent.session.metadata', codex: { diff: { id: 'codex-turn:turn-2', diff } } } }), replacement)
  await state.update({ diffs: [...rows(['A', 'B', 'C', 'D']), { ...latest, diff: replacement }] })
  await expect(changes.getByText('+updated', { exact: true })).toBeVisible()
  await assertSessionRows()
  await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({ type: 'freshAgent.event', sessionId: 'compact-freshcodex', sessionType: 'freshcodex', provider: 'codex', event: { type: 'freshAgent.session.metadata', codex: { diff: null } } }))
  await state.update({ diffs: rows(['A', 'B', 'C', 'D']) })
  await expect(changes.getByRole('button', { name: 'Diff: Turn changes' })).toHaveCount(0)
  await assertSessionRows()
})

test('routed OpenCode daemon loss exposes diagnostic and keeps the conversation recoverable', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  const state = await seedCompactPane(page, { sessionType: 'freshopencode', provider: 'opencode', style: 'sans', theme: 'light' })
  const composer = page.getByRole('textbox', { name: 'Chat message input' })
  await composer.fill('Retain this draft during daemon recovery')
  await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({
    type: 'freshAgent.event', sessionType: 'freshopencode', provider: 'opencode', sessionId: 'compact-freshopencode',
    event: { type: 'freshAgent.error', code: 'OPENCODE_DAEMON_LOST', message: 'The opencode serve daemon was lost unexpectedly' },
  }))
  const error = page.locator('[data-agent-error="session"]')
  await expect(error.getByRole('alert')).toHaveText('Agent error')
  await expect(error.getByText('Agent error: The opencode serve daemon was lost unexpectedly', { exact: true })).toBeHidden()
  await hitAndClick(error.locator('summary'))
  await expect(error).toContainText('The opencode serve daemon was lost unexpectedly')
  await state.update({ status: 'idle' })
  await expect(composer).toBeEnabled()
  await expect(composer).toHaveValue('Retain this draft during daemon recovery')
  await expect(page.getByText('Latest prompt must remain readable', { exact: true })).toBeVisible()
  await hitAndClick(error.getByRole('button', { name: 'Dismiss', exact: true }))
  await expect(error).toHaveCount(0)
})

test('managed live recovery suppresses stale ended and stuck entries while current truth is held', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  await seedCompactPane(page, { sessionType: 'freshcodex', provider: 'codex', style: 'sans', theme: 'light' })
  const composer = page.getByRole('textbox', { name: 'Chat message input' })
  await composer.fill('Draft retained while reattaching')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  await page.route('**/api/fresh-agent/threads/**', async route => {
    reads += 1
    await held
    await route.fulfill({ json: FreshAgentSnapshotSchema.parse({
      ...freshAgentSnapshot('freshcodex', 'codex', 'compact-freshcodex'),
      revision: 2,
      extensions: { codex: { statusFromLiveState: true, ownerKind: 'fresh-agent' } },
      turns: [latestUserTurn()],
    }) })
  })
  await page.evaluate(() => {
    const h = window.__FRESHELL_TEST_HARNESS__!; const s = h.getState(); const tabId = s.tabs.activeTabId!; const paneId = s.panes.activePane[tabId]
    const content = (s.panes.layouts[tabId] as { content: Record<string, unknown> }).content
    const locator = { sessionType: 'freshcodex', provider: 'codex', sessionId: 'compact-freshcodex' }
    h.dispatch({ type: 'freshAgent/sessionInit', payload: locator })
    h.dispatch({ type: 'freshAgent/sessionError', payload: { ...locator, code: 'INVALID_SESSION_ID', message: 'Stale session missing' } })
    h.dispatch({ type: 'freshAgent/markSessionLost', payload: locator })
    h.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId, content: { ...content, soulId: 'compact-managed-soul', soulIntentRevision: 1, recoverySummary: { desiredState: 'running', recoveryState: 'live', reason: 'provider_unavailable', durabilityState: 'resume_captured', allocationState: 'verified_durable' } } } })
    h.clearSentWsMessages?.()
  })
  const forbidden = page.locator('[data-agent-error="ended"], [data-agent-error="stuck"]')
  await expect.poll(() => reads).toBeGreaterThan(0)
  await expect(forbidden).toHaveCount(0)
  await expect(composer).toBeDisabled()
  await expect(composer).toHaveValue('Draft retained while reattaching')
  await expect(page.getByText('Latest prompt must remain readable', { exact: true })).toBeVisible()
  release()
  await expect(composer).toBeEnabled()
  await expect(forbidden).toHaveCount(0)
  await expect(composer).toHaveValue('Draft retained while reattaching')
  const replacements = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.().filter(frame => typeof frame === 'object' && frame !== null && 'type' in frame && ['freshAgent.create', 'pane.reconcile.request'].includes(String(frame.type))))
  expect(replacements ?? []).toEqual([])
})

for (const size of [{ width: 560, height: 320 }, { width: 390, height: 700 }]) {
  test(`expanded diagnostics keep recovery, requests and diffs reachable at ${size.width}x${size.height}`, async ({ freshellPage, page, terminal }) => {
    void freshellPage
    // Start the phone at its real viewport so sidebar collapse finishes before
    // fitting pane geometry; a desktop-to-phone resize changes both widths.
    if (size.width === 390) await page.setViewportSize({ width: 390, height: 844 })
    await terminal.waitForTerminal()
    await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light' })
    // Set width first: phone chrome wraps and changes the available height.
    await fitRoot(page, { width: size.width })
    await fitRoot(page, { height: size.height })
    await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({
      type: 'freshAgent.event', sessionId: 'compact-freshclaude', sessionType: 'freshclaude', provider: 'claude',
      event: { type: 'freshAgent.notice', level: 'info', code: 'diagnostic-test', message: 'Routine context '.repeat(100) },
    }))
    const stack = page.getByRole('group', { name: 'Agent requests and status' })
    await stack.getByText('Notice details', {exact: true}).click()
    await stack.getByText('Agent could not start', {exact: true}).click()
    const body = stack.locator('[data-agent-error="create"] .fresh-agent-diagnostic-body')
    await body.scrollIntoViewIfNeeded()
    const geometry = await body.evaluate(el => {
      const rect = el.getBoundingClientRect(); const stack = el.closest('.fresh-agent-top-stack')!.getBoundingClientRect()
      return { width: rect.width, stackWidth: stack.width, visibleHeight: Math.min(rect.bottom, stack.bottom) - Math.max(rect.top, stack.top) }
    })
    console.log(JSON.stringify({ event: 'expanded_diagnostic_geometry', severity: 'INFO', size, ...geometry }))
    if (geometry.width < geometry.stackWidth * .7 || geometry.visibleHeight < 44) await saveScreenshot(page, `test-results/compact-geometry-failure-expanded-${size.width}.png`)
    expect(geometry.width).toBeGreaterThanOrEqual(geometry.stackWidth * .7)
    expect(geometry.visibleHeight).toBeGreaterThanOrEqual(44)
    await hitAndClick(stack.getByRole('button', { name: 'Dismiss', exact: true }))
    await hitAndClick(stack.getByRole('button', { name: 'Yes', exact: true }))
    await hitAndClick(stack.getByRole('button', { name: 'Allow tool use', exact: true }))
    await hitAndClick(stack.getByRole('button', { name: 'Diffs: 30 changed files' }))
    await expect(page.getByRole('dialog', {name: 'Changes'})).toBeVisible()
    await page.keyboard.press('Escape')
    await stack.getByText('Notice details', {exact: true}).click()
    await assertUsefulSpace(page)
  })
}

for (const size of [{ width: 560, height: 320 }, { width: 390, height: 700 }]) {
  test(`ambiguous Codex delivery keeps the original prompt and instruction at ${size.width}x${size.height}`, async ({ freshellPage, page, terminal }) => {
    void freshellPage
    if (size.width === 390) await page.setViewportSize({ width: 390, height: 844 })
    await terminal.waitForTerminal()
    await seedCompactPane(page, {
      sessionType: 'freshcodex',
      provider: 'codex',
      style: 'sans',
      theme: 'light',
      snapshot: { pendingApprovals: [], pendingQuestions: [], pendingElicitations: [] },
    })
    await fitRoot(page, { width: size.width })
    await fitRoot(page, { height: size.height })
    await page.evaluate(() => {
      const h=window.__FRESHELL_TEST_HARNESS__!;const s=h.getState();const tabId=s.tabs.activeTabId!
      h.dispatch({type:'panes/mergePaneContent',payload:{tabId,paneId:s.panes.activePane[tabId],updates:{createError:undefined,reconcileNotice:undefined}}})
    })
    const pane=page.locator('.fresh-agent-pane:not(.fresh-agent-diff-drawer-overlay)').last()
    const composer=pane.getByRole('textbox',{name:'Chat message input'})
    const sendButton=pane.getByRole('button',{name:'Send',exact:true})
    const prompt='Keep this original Codex prompt'
    await composer.fill(prompt)
    await hitAndClick(sendButton)
    const matchingSends=async () => page.evaluate(prompt => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.().filter(frame =>
      typeof frame==='object'&&frame!==null&&'type' in frame&&frame.type==='freshAgent.send'&&'text' in frame&&frame.text===prompt,
    ) ?? [],prompt)
    await expect.poll(matchingSends).toHaveLength(1)
    const [sent]=await matchingSends() as Array<{ requestId?: string; text?: string }>
    const reason='Long explanation '.repeat(30).trim()
    await page.evaluate(({requestId,reason}) => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({
      type:'error',code:'INTERNAL_ERROR',requestId,message:`CODEX_DELIVERY_AMBIGUOUS: ${reason}`,
    }),{requestId:sent.requestId,reason})
    const summary=pane.locator('[data-agent-error="notice"] summary')
    await expect(summary).toHaveText(/^Check the conversation before sending again\. Delivery is uncertain\./)
    const spaceGeometry = await logUsefulSpace(page)
    await assertPainted(summary.getByRole('alert', { name: 'Agent warning' }), { spaceGeometry })
    await expect(composer).toHaveValue(prompt)
    await page.waitForTimeout(7_000)
    await expect(summary).toHaveText(/^Check the conversation before sending again\. Delivery is uncertain\./)
    await expect(composer).toHaveValue(prompt)
    const allSends=await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.().filter(frame =>
      typeof frame==='object'&&frame!==null&&'type' in frame&&frame.type==='freshAgent.send',
    ) ?? [])
    expect(allSends).toHaveLength(1)
    expect(await matchingSends()).toHaveLength(1)
    await hitAndClick(summary)
    const fullDiagnostic=`Delivery uncertain (${sent.requestId}): ${reason}. Check the conversation before sending again.`
    await expect(summary.locator('..').locator('.fresh-agent-diagnostic-body')).toHaveText(fullDiagnostic)
    expect(await matchingSends()).toHaveLength(1)
  })
}

test('Changes closes on programmatic and keyboard tab switches', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light' })
  const original = await page.evaluate(() => {
    const h = window.__FRESHELL_TEST_HARNESS__!
    const tabId = h.getState().tabs.activeTabId!
    h.dispatch({type: 'tabs/addTab', payload: {id: 'compact-other-tab', title: 'Other tab'}})
    h.dispatch({type: 'panes/initLayout', payload: {tabId: 'compact-other-tab', paneId: 'compact-other-pane', content: {kind: 'picker'}}})
    h.dispatch({type: 'tabs/setActiveTab', payload: tabId})
    return tabId
  })
  for (const keyboard of [false, true]) {
    await page.getByRole('button', {name: 'Diffs: 30 changed files'}).click()
    await expect(page.getByRole('dialog', {name: 'Changes'})).toBeVisible()
    if (keyboard) await page.keyboard.press('Control+Shift+]')
    else await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.dispatch({type:'tabs/setActiveTab',payload:'compact-other-tab'}))
    await expect.poll(() => page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getState().tabs.activeTabId)).toBe('compact-other-tab')
    await expect(page.getByRole('dialog', {name: 'Changes'})).toHaveCount(0)
    await page.evaluate(tabId => window.__FRESHELL_TEST_HARNESS__!.dispatch({type:'tabs/setActiveTab',payload:tabId}), original)
    await expect(page.getByRole('button', {name: 'Diffs: 30 changed files'})).toHaveAttribute('aria-expanded','false')
  }
})

test('short panes keep warning summary text readable', async ({ freshellPage, page, terminal }) => {
  void freshellPage
  await terminal.waitForTerminal()
  await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light' })
  await fitRoot(page, { width: 560 })
  await fitRoot(page, { height: 320 })
  await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({
    type: 'freshAgent.event', sessionId: 'compact-freshclaude', sessionType: 'freshclaude', provider: 'claude',
    event: { type: 'freshAgent.notice', level: 'warning', code: 'refusal', message: 'Send refused' },
  }))
  const warning = page.getByRole('alert', { name: 'Agent warning' })
  await expect(warning).toHaveText('Send refused')
  const geometry = await warning.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el)
    const rects = [...range.getClientRects()]
    const parent = el.closest('.fresh-agent-errors')!.getBoundingClientRect()
    return { textRects: rects.length, fullyVisible: rects.every(rect => rect.top >= parent.top && rect.bottom <= parent.bottom && rect.left >= parent.left && rect.right <= parent.right) }
  })
  expect(geometry.textRects).toBeGreaterThan(0)
  expect(geometry.fullyVisible).toBe(true)
  await assertUsefulSpace(page)
})

for (const size of [{ width: 560, height: 320 }, { width: 390, height: 700 }]) {
  test(`wrapped delivery instructions expand fully at ${size.width}x${size.height}`, async ({ freshellPage, page, terminal }) => {
    void freshellPage
    if (size.width === 390) await page.setViewportSize({ width: 390, height: 844 })
    await terminal.waitForTerminal()
    await seedCompactPane(page, { sessionType: 'freshclaude', provider: 'claude', style: 'sans', theme: 'light' })
    await fitRoot(page, { width: size.width })
    await fitRoot(page, { height: size.height })
    const message = 'Delivery uncertain (send-7): the native response was lost. Check the conversation before sending again.'
    await page.evaluate(message => window.__FRESHELL_TEST_HARNESS__!.receiveWsMessage?.({
      type: 'freshAgent.event', sessionId: 'compact-freshclaude', sessionType: 'freshclaude', provider: 'claude',
      event: { type: 'freshAgent.notice', level: 'warning', code: 'DELIVERY_UNCERTAIN', message },
    }), message)
    const summary = page.locator('[data-agent-error="notice"] summary')
    await expect(summary).toHaveAccessibleName(message)
    await expect(summary.getByRole('alert', { name: 'Agent warning' })).toHaveText(message)
    await hitAndClick(summary)
    await expect(summary.locator('..')).toHaveAttribute('open', '')
    await summary.scrollIntoViewIfNeeded()
    const readable = await summary.evaluate(el => {
      const viewport = el.closest('.fresh-agent-top-stack-content')!.getBoundingClientRect()
      const range = document.createRange(); range.selectNodeContents(el.querySelector('[role="alert"]')!)
      const rects = [...range.getClientRects()]
      return rects.length > 0 && rects.every(rect => rect.left >= viewport.left && rect.right <= viewport.right + 1 && rect.top >= viewport.top && rect.bottom <= viewport.bottom + 1)
    })
    expect(readable).toBe(true)
    await assertUsefulSpace(page)
  })
}
